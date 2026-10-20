/** 从表格（CSV / 从 Excel 复制的内容）批量导入账单 */
import type { Bill, Merchant, PaymentAccount, Settings } from './types';
import { parseBRL } from './money';
import { parseBRDate, isValidISO } from './dates';
import { computeDueDates } from './terms';
import { recompute } from './bill';
import { TOTAL_ONLY_DESC } from './ocr/protocol';
import { EXPENSE_CATEGORIES } from './expense';

export type Field = 'merchant' | 'orderNumber' | 'billDate' | 'dueDate' | 'amount' | 'account' | 'category' | 'notes' | 'skip';

/** 表头别名（中文 / 葡文 / 英文） */
const HEAD: [Field, string[]][] = [
  ['merchant', ['商家', '供应商', '缴费单位', '名称', 'fornecedor', 'empresa', 'loja', 'merchant', 'supplier', 'cliente']],
  ['orderNumber', ['单号', '订单号', '订单', '发票', 'nf', 'pedido', 'nota', 'order', 'numero', 'número']],
  ['billDate', ['开单', '开单日期', '账单日期', '日期', 'emissao', 'emissão', 'data', 'billdate', 'date']],
  ['dueDate', ['到期', '到期日', '到期日期', '付款日', 'vencimento', 'venc', 'duedate', 'due']],
  ['amount', ['金额', '总额', '应付', '价格', 'valor', 'total', 'amount', 'preco', 'preço']],
  ['account', ['账号', '付款账号', '账户', 'conta', 'conta de pagamento', 'account']],
  ['category', ['分类', '类型', 'categoria', 'tipo', 'category']],
  ['notes', ['备注', '说明', 'obs', 'observacao', 'observação', 'nota interna', 'notes', 'memo']],
];

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\s_*·:：()（）]/g, '')
    .trim();

export function guessField(header: string): Field {
  const h = norm(header);
  if (!h) return 'skip';
  for (const [f, names] of HEAD) if (names.some((n) => h === norm(n))) return f;
  // 部分匹配取最长的别名（"Data de vencimento" 应是到期日，而不是匹配到 "data"）
  let best: Field = 'skip';
  let len = 0;
  let pos = -1;
  for (const [f, names] of HEAD)
    for (const n of names) {
      const k = norm(n);
      const at = k ? h.indexOf(k) : -1;
      // 先比长度；一样长时取靠后的词（"data venc" 里 venc 更具体）
      if (at >= 0 && (k.length > len || (k.length === len && at > pos))) {
        best = f;
        len = k.length;
        pos = at;
      }
    }
  return best;
}

/** 猜分隔符：分号 > 制表符 > 逗号（巴西 Excel 默认分号） */
export function detectDelimiter(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
  const counts: [string, number][] = [
    [';', (line.match(/;/g) ?? []).length],
    ['\t', (line.match(/\t/g) ?? []).length],
    [',', (line.match(/,/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ';';
}

/** 解析带引号的 CSV 行 */
export function parseRows(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(cell.trim());
      cell = '';
    } else if (c === '\n') {
      row.push(cell.trim());
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
      cell = '';
    } else if (c !== '\r') cell += c;
  }
  row.push(cell.trim());
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

export interface ImportRow {
  index: number;
  raw: string[];
  merchantName: string;
  merchantId: string | null;
  /** 需要新建的商家名（未匹配到时） */
  createMerchant: string | null;
  bill: Bill | null;
  issues: string[];
  /** 与现有账单重复（同商家 + 同单号，或同商家 + 同到期日 + 同金额） */
  duplicateOf: Bill | null;
}

export interface ImportPlan {
  fields: Field[];
  headers: string[];
  rows: ImportRow[];
  okCount: number;
  dupCount: number;
  badCount: number;
  newMerchants: string[];
}

const nameKey = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** 找一笔已存在的相同账单 */
export function findDuplicate(bills: Bill[], b: { merchantId: string | null; merchantNameSnapshot: string; orderNumber: string; dueDate: string; totalCents: number }, selfId?: string): Bill | null {
  const same = (x: Bill) => (b.merchantId ? x.merchantId === b.merchantId : nameKey(x.merchantNameSnapshot) === nameKey(b.merchantNameSnapshot));
  const order = b.orderNumber.trim();
  return (
    bills.find((x) => x.id !== selfId && same(x) && order && x.orderNumber.trim().toLowerCase() === order.toLowerCase()) ??
    bills.find((x) => x.id !== selfId && same(x) && x.dueDate === b.dueDate && x.totalCents === b.totalCents) ??
    null
  );
}

export interface PlanOptions {
  merchants: Merchant[];
  accounts: PaymentAccount[];
  bills: Bill[];
  settings: Pick<Settings, 'defaultReminderDays' | 'defaultAccountId'>;
  today: string;
  uuid: () => string;
  now: string;
}

/** 生成导入计划（不写库） */
export function planImport(text: string, o: PlanOptions, fieldsOverride?: Field[]): ImportPlan {
  const rows = parseRows(text);
  if (!rows.length) return { fields: [], headers: [], rows: [], okCount: 0, dupCount: 0, badCount: 0, newMerchants: [] };
  const headers = rows[0];
  const guessed = headers.map(guessField);
  const hasHeader = guessed.filter((f) => f !== 'skip').length >= 2;
  const fields = fieldsOverride ?? (hasHeader ? guessed : (['merchant', 'orderNumber', 'billDate', 'dueDate', 'amount'] as Field[]).slice(0, headers.length));
  const body = hasHeader ? rows.slice(1) : rows;
  const col = (r: string[], f: Field) => {
    const i = fields.indexOf(f);
    return i >= 0 ? (r[i] ?? '').trim() : '';
  };
  // 整列金额都是「点做小数点」（英文版 Excel / Google 表格导出，如 1234.56、1,234.56）时按这种格式读
  const amtCol = body.map((r) => col(r, 'amount').replace(/^R\$\s*/i, '').trim()).filter(Boolean);
  const usDecimal = amtCol.length > 0 && amtCol.some((v) => /\.\d{1,2}$/.test(v)) && amtCol.every((v) => /^\d{1,3}(,\d{3})*(\.\d{1,2})?$|^\d+(\.\d{1,2})?$/.test(v));
  const readAmount = (raw: string) => {
    if (usDecimal) {
      const v = raw.replace(/^R\$\s*/i, '').replace(/,/g, '').trim();
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? { cents: Math.round(n * 100), ambiguous: false, error: undefined as string | undefined } : { cents: null, ambiguous: false, error: '不是有效金额' };
    }
    return parseBRL(raw);
  };
  const out: ImportRow[] = [];
  const newMerchants: string[] = [];
  const pending: Bill[] = [];
  body.forEach((r, i) => {
    const issues: string[] = [];
    const merchantName = col(r, 'merchant');
    const m = merchantName ? o.merchants.find((x) => nameKey(x.name) === nameKey(merchantName) || x.aliases.some((a) => nameKey(a) === nameKey(merchantName))) ?? null : null;
    if (!merchantName) issues.push('缺商家名称');
    const amount = readAmount(col(r, 'amount'));
    if (!amount.cents) issues.push(amount.error ? `金额：${amount.error}` : '缺金额');
    else if (amount.ambiguous) issues.push(`金额有歧义：${col(r, 'amount')}`);
    // 两位年份：离今年不超过 1 年才直接采用，否则报错让人改
    const near = (iso: string | undefined) => (iso && Math.abs(Number(iso.slice(0, 4)) - Number(o.today.slice(0, 4))) <= 1 ? iso : null);
    const bd = parseBRDate(col(r, 'billDate'));
    const billISO = bd.iso ?? near(bd.candidate) ?? (col(r, 'billDate') ? null : o.today);
    if (!billISO) issues.push(`开单日期：${bd.candidate ? `两位年份「${col(r, 'billDate')}」请写成 4 位` : bd.error ?? '格式不正确'}`);
    const ddRaw = col(r, 'dueDate');
    const dd = parseBRDate(ddRaw);
    let dueISO = dd.iso ?? near(dd.candidate) ?? null;
    if (!dueISO && !ddRaw && m?.term && billISO) dueISO = computeDueDates(m.term, billISO)[0] ?? null;
    if (!dueISO) issues.push(ddRaw ? `到期日期：${dd.candidate ? `两位年份「${ddRaw}」请写成 4 位` : dd.error ?? '格式不正确'}` : '缺到期日期（商家没有固定账期）');
    if (billISO && dueISO && dueISO < billISO) issues.push('到期日早于开单日');
    const accountName = col(r, 'account');
    const acc = accountName ? o.accounts.find((a) => nameKey(a.label) === nameKey(accountName)) ?? null : o.accounts.find((a) => a.id === o.settings.defaultAccountId) ?? null;
    if (accountName && !acc) issues.push(`找不到付款账号「${accountName}」`);
    const catRaw = col(r, 'category');
    const cat = catRaw ? EXPENSE_CATEGORIES.find((c) => nameKey(c.label) === nameKey(catRaw) || c.id === catRaw.toLowerCase()) ?? null : null;
    if (catRaw && !cat) issues.push(`未知分类「${catRaw}」`);

    let bill: Bill | null = null;
    let dup: Bill | null = null;
    if (!issues.length && billISO && dueISO && amount.cents) {
      bill = recompute({
        id: o.uuid(),
        merchantId: m?.id ?? null,
        merchantNameSnapshot: m?.name ?? merchantName,
        orderNumber: col(r, 'orderNumber'),
        billDate: billISO,
        dueDate: dueISO,
        accountId: acc?.id ?? null,
        accountLabelSnapshot: acc?.label ?? '',
        reminderDays: o.settings.defaultReminderDays,
        paidAt: null,
        notes: col(r, 'notes'),
        items: [{ id: o.uuid(), quantity: 1, description: TOTAL_ONLY_DESC, unitPriceCents: amount.cents, subtotalCents: amount.cents }],
        totalCents: amount.cents,
        amountMode: 'total',
        kind: cat ? 'expense' : undefined,
        category: cat?.id ?? null,
        ocrReview: null,
        createdAt: o.now,
        updatedAt: o.now,
        schemaVersion: 1,
      } as Bill);
      dup = findDuplicate([...o.bills, ...pending], bill);
      if (!dup) pending.push(bill);
      if (!m && merchantName && !newMerchants.some((x) => nameKey(x) === nameKey(merchantName))) newMerchants.push(merchantName);
    }
    out.push({ index: i + 1, raw: r, merchantName, merchantId: m?.id ?? null, createMerchant: m ? null : merchantName || null, bill, issues, duplicateOf: dup });
  });
  return {
    fields,
    headers: hasHeader ? headers : fields.map((f) => f),
    rows: out,
    okCount: out.filter((r) => r.bill && !r.duplicateOf).length,
    dupCount: out.filter((r) => r.duplicateOf).length,
    badCount: out.filter((r) => r.issues.length).length,
    newMerchants,
  };
}

/** 模板（给用户下载后填写） */
export const IMPORT_TEMPLATE = '﻿商家;单号;开单日期;到期日期;金额;付款账号;备注\r\nLoja Exemplo;0042;01/09/2026;01/10/2026;1.234,56;PIX 公司主账户;示例行（可删除）\r\n';

export const FIELD_LABEL: Record<Field, string> = {
  merchant: '商家/缴费单位',
  orderNumber: '单号',
  billDate: '开单日期',
  dueDate: '到期日期',
  amount: '金额',
  account: '付款账号',
  category: '缴费分类',
  notes: '备注',
  skip: '忽略',
};
