/**
 * 识别准确率评测：用「你复核后保存的账单」当标准答案，对比识别结果。
 *  - 历史评测：直接用保存时留下的识别原始结果（ocrReview.candidate），不花额度
 *  - 重新识别：用本机保存的单据图片再识别一次（评估新提示词/新模型），会用额度
 * 指标（需求第十五节）：金额字段 ≥ 95%、型号 ≥ 90%、明细行完整率、零编造。
 */
import type { Bill, Merchant } from '../types';
import { sumCents, lineSubtotalCents } from '../money';
import { normalizeModelOutput, type ModelOutput } from './protocol';
import { normCode, similarity, matchMerchantSmart } from './learn';

export interface Ratio {
  ok: number;
  n: number;
}
export interface EvalCaseResult {
  billId: string;
  label: string;
  provider: string;
  amount: boolean | null;
  merchant: boolean | null;
  dueDate: boolean | null;
  codes: Ratio;
  qtyPrice: Ratio;
  lines: Ratio;
  /** 识别出、但保存的账单里没有对应的行（疑似编造，或被你删掉） */
  extra: number;
  /** 各项问题的简短说明 */
  problems: string[];
}
export interface EvalReport {
  cases: EvalCaseResult[];
  amount: Ratio;
  merchant: Ratio;
  dueDate: Ratio;
  codes: Ratio;
  qtyPrice: Ratio;
  lines: Ratio;
  extra: Ratio;
  byProvider: Record<string, { n: number; amount: Ratio; codes: Ratio }>;
}

export const TARGETS = { amount: 0.95, codes: 0.9, lines: 0.95, extra: 0 };

const SKIP_PROVIDERS = /手工|PDF 文字/;

/** 有可评测识别记录的账单 */
export function evaluableBills(bills: Bill[]): Bill[] {
  return bills.filter((b) => !b.deletedAt && b.ocrReview && b.ocrReview.candidate && !SKIP_PROVIDERS.test(b.ocrReview.provider));
}

interface PredItem {
  code: string;
  qty: number | null;
  unit: number | null;
}

function predItems(m: ModelOutput): PredItem[] {
  return m.items.map((it) => ({ code: normCode(it.description ?? ''), qty: it.quantity, unit: it.unitPriceCents }));
}

/** 识别结果给出的总额：明细能算出来就用计算值，否则用图片总额 / 应付金额 */
function predTotal(m: ModelOutput): number | null {
  const full = m.items.length > 0 && m.items.every((i) => i.quantity !== null && i.unitPriceCents !== null);
  if (full) return sumCents(m.items.map((i) => lineSubtotalCents(i.quantity!, i.unitPriceCents!)));
  return m.amountDue?.cents ?? m.printedTotalCents ?? null;
}

export function evaluateOne(bill: Bill, pred: ModelOutput, merchants: Merchant[], provider = bill.ocrReview?.provider ?? ''): EvalCaseResult {
  const problems: string[] = [];
  const total = predTotal(pred);
  const amount = total === null ? false : total === bill.totalCents || (pred.amountDue?.cents ?? -1) === bill.totalCents || (pred.printedTotalCents ?? -1) === bill.totalCents;
  if (!amount) problems.push(total === null ? '没读出金额' : `金额读成 ${(total / 100).toFixed(2)}`);

  let merchant: boolean | null = null;
  if (bill.merchantId) {
    const mm = matchMerchantSmart(pred.merchant.value, pred.merchant.candidates ?? [], merchants);
    merchant = mm?.merchant.id === bill.merchantId;
    if (!merchant) problems.push(pred.merchant.value ? `商家读成「${pred.merchant.value}」` : '没读出商家');
  }

  let dueDate: boolean | null = null;
  if (pred.dueDate?.iso || (pred.docType && pred.docType !== 'order')) {
    dueDate = pred.dueDate?.iso === bill.dueDate;
    if (!dueDate) problems.push(pred.dueDate?.iso ? `到期日读成 ${pred.dueDate.iso.split('-').reverse().join('/')}` : '没读出到期日');
  }

  // 明细对齐：只评测逐行明细的账单
  const codes: Ratio = { ok: 0, n: 0 };
  const qtyPrice: Ratio = { ok: 0, n: 0 };
  const lines: Ratio = { ok: 0, n: 0 };
  let extra = 0;
  if (bill.amountMode !== 'total' && bill.items.length) {
    const preds = predItems(pred);
    const used = new Set<number>();
    for (const t of bill.items) {
      const tc = normCode(t.description);
      let best = -1;
      let bestScore = 0;
      preds.forEach((p, i) => {
        if (used.has(i)) return;
        let s = p.code === tc ? 3 : similarity(p.code, tc) * 2;
        if (p.qty === t.quantity) s += 1;
        if (p.unit === t.unitPriceCents) s += 1;
        if (s > bestScore) {
          bestScore = s;
          best = i;
        }
      });
      lines.n++;
      codes.n++;
      qtyPrice.n++;
      if (best >= 0 && bestScore >= 1.5) {
        used.add(best);
        lines.ok++;
        const p = preds[best];
        if (p.code === tc) codes.ok++;
        else problems.push(`型号「${t.description}」读成「${pred.items[best].description ?? ''}」`);
        if (p.qty === t.quantity && p.unit === t.unitPriceCents) qtyPrice.ok++;
        else problems.push(`「${t.description}」数量/单价读成 ${p.qty ?? '?'} × ${p.unit === null ? '?' : (p.unit / 100).toFixed(2)}`);
      } else problems.push(`漏读一行「${t.description}」`);
    }
    extra = preds.length - used.size;
    if (extra) problems.push(`多出 ${extra} 行`);
  }
  return { billId: bill.id, label: `${bill.merchantNameSnapshot || '（无商家）'} · ${bill.billDate.split('-').reverse().join('/')}`, provider, amount, merchant, dueDate, codes, qtyPrice, lines, extra, problems };
}

const add = (a: Ratio, b: Ratio): Ratio => ({ ok: a.ok + b.ok, n: a.n + b.n });
const flag = (r: Ratio, v: boolean | null): Ratio => (v === null ? r : { ok: r.ok + (v ? 1 : 0), n: r.n + 1 });

export function summarize(cases: EvalCaseResult[]): EvalReport {
  const z = (): Ratio => ({ ok: 0, n: 0 });
  const rep: EvalReport = { cases, amount: z(), merchant: z(), dueDate: z(), codes: z(), qtyPrice: z(), lines: z(), extra: z(), byProvider: {} };
  for (const c of cases) {
    rep.amount = flag(rep.amount, c.amount);
    rep.merchant = flag(rep.merchant, c.merchant);
    rep.dueDate = flag(rep.dueDate, c.dueDate);
    rep.codes = add(rep.codes, c.codes);
    rep.qtyPrice = add(rep.qtyPrice, c.qtyPrice);
    rep.lines = add(rep.lines, c.lines);
    rep.extra = { ok: rep.extra.ok + c.extra, n: rep.extra.n + (c.lines.n ? 1 : 0) };
    const p = (rep.byProvider[c.provider] ??= { n: 0, amount: z(), codes: z() });
    p.n++;
    p.amount = flag(p.amount, c.amount);
    p.codes = add(p.codes, c.codes);
  }
  return rep;
}

/** 历史评测：用保存时留下的识别结果 */
export function evaluateHistory(bills: Bill[], merchants: Merchant[]): EvalReport {
  const cases: EvalCaseResult[] = [];
  for (const b of evaluableBills(bills)) {
    let pred: ModelOutput;
    try {
      pred = normalizeModelOutput(b.ocrReview!.candidate);
    } catch {
      continue;
    }
    cases.push(evaluateOne(b, pred, merchants));
  }
  return summarize(cases);
}

export const pct = (r: Ratio) => (r.n ? Math.round((r.ok / r.n) * 1000) / 10 : null);

/** 导出测试集（标准答案 + 识别结果，不含图片）供开发者离线评测 */
export function exportTestSet(bills: Bill[]) {
  return evaluableBills(bills).map((b) => ({
    id: b.id,
    provider: b.ocrReview!.provider,
    truth: { merchant: b.merchantNameSnapshot, billDate: b.billDate, dueDate: b.dueDate, totalCents: b.totalCents, amountMode: b.amountMode ?? 'items', items: b.items.map((i) => ({ description: i.description, quantity: i.quantity, unitPriceCents: i.unitPriceCents })) },
    prediction: b.ocrReview!.candidate,
    edits: b.ocrReview!.edits,
  }));
}
