/**
 * 识别「会学习」：
 *  - 商家智能匹配（去重音、去公司后缀、相似度），识别名称自动记为别名
 *  - 按你在复核时的修改，记住「识别成 A → 实际是 B」，下次同一商家自动更正
 *  - 从历史账单整理每个商家的常用型号与上次单价：发给 AI 作参考，并用来交叉验证（减少要手动核对的提示）
 *  - 算术不符时，按手写常见误读（1/7、0/6、3/8…）找出「改一个数字就对上」的唯一可能，给一键改
 * 原则：不替用户猜。自动更正只用用户自己改过的映射；其余都是建议，需要点一下才生效。
 */
import type { Bill, Merchant } from '../types';
import { parseBRL, parseQuantityMilli, lineSubtotalCents, formatBRL } from '../money';
import type { EditorState, RowState } from './protocol';

/* ---------------- 规范化 ---------------- */

const stripAccents = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** 商家名规范化：小写、去重音、去公司后缀与标点 */
export function normName(s: string): string {
  let t = stripAccents(s.normalize('NFKC').toLowerCase());
  t = t.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  t = t.replace(/\b(ltda|ltd|me|epp|eireli|s\s?a|sa|cia|comercio|com|de|da|do|das|dos|e|importacao|importadora|distribuidora|loja|cnpj)\b/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

/** 型号/描述规范化：大写、去空白、统一连字符（FN A78 = FN-A78 = fn–a78） */
export function normCode(s: string): string {
  return stripAccents(s.normalize('NFKC').toUpperCase())
    .replace(/[‐-―−_.\s/]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function bigrams(s: string): string[] {
  const t = s.replace(/\s+/g, '');
  const out: string[] = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}

/** Dice 相似度（0–1），对手写漏字、错字较宽容 */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.length || !B.length) return 0;
  const counts = new Map<string, number>();
  A.forEach((g) => counts.set(g, (counts.get(g) ?? 0) + 1));
  let hit = 0;
  B.forEach((g) => {
    const n = counts.get(g) ?? 0;
    if (n > 0) {
      hit++;
      counts.set(g, n - 1);
    }
  });
  return (2 * hit) / (A.length + B.length);
}

/* ---------------- 商家智能匹配 ---------------- */

export type MatchHow = 'exact' | 'alias' | 'contains' | 'fuzzy';
export interface MerchantMatch<T> {
  merchant: T;
  score: number;
  how: MatchHow;
  /** 用哪段识别文字匹配上的 */
  via: string;
}

type M = Pick<Merchant, 'id' | 'name' | 'aliases' | 'active'>;

/**
 * 在识别名称与候选里找最可能的商家。只有唯一且明显领先时才返回（不猜）。
 * exact/alias = 规范化后完全相同；contains = 一方包含另一方（≥4 字）；fuzzy = 相似度 ≥ 0.8 且领先第二名 ≥ 0.1
 */
export function matchMerchantSmart<T extends M>(raw: string | null, candidates: string[], merchants: T[]): MerchantMatch<T> | null {
  const texts = [raw, ...candidates].filter((x): x is string => !!x && !!x.trim());
  if (!texts.length) return null;
  const active = merchants.filter((m) => m.active);
  const scored: MerchantMatch<T>[] = [];
  for (const m of active) {
    let best: MerchantMatch<T> | null = null;
    const names = [m.name, ...m.aliases];
    for (const t of texts) {
      const nt = normName(t);
      if (!nt) continue;
      names.forEach((n, ni) => {
        const nn = normName(n);
        if (!nn) return;
        let s = 0;
        let how: MatchHow = 'fuzzy';
        if (nn === nt) {
          s = 1;
          how = ni === 0 ? 'exact' : 'alias';
        } else if ((nn.length >= 4 && nt.includes(nn)) || (nt.length >= 4 && nn.includes(nt))) {
          s = 0.92;
          how = 'contains';
        } else s = similarity(nn, nt);
        // 识别名称（第一个）比候选更可信
        if (t !== texts[0]) s -= 0.03;
        if (!best || s > best.score) best = { merchant: m, score: s, how, via: t };
      });
    }
    if (best) scored.push(best);
  }
  scored.sort((a, b) => b.score - a.score);
  const [first, second] = scored;
  if (!first) return null;
  const margin = first.score - (second?.score ?? 0);
  if (first.how === 'exact' || first.how === 'alias') return margin > 0 || !second || second.score < first.score ? first : null;
  if (first.how === 'contains' && first.score >= 0.89 && margin >= 0.05) return first;
  if (first.score >= 0.8 && margin >= 0.1) return first;
  return null;
}

/* ---------------- 商家型号目录（来自历史账单） ---------------- */

export interface CatalogEntry {
  desc: string;
  code: string;
  lastUnitCents: number;
  lastDate: string;
  count: number;
}
export type Catalog = Map<string, Map<string, CatalogEntry>>;

export function buildCatalog(bills: Bill[]): Catalog {
  const cat: Catalog = new Map();
  const sorted = [...bills].filter((b) => !b.deletedAt && b.merchantId && b.amountMode !== 'total').sort((a, b) => a.billDate.localeCompare(b.billDate));
  for (const b of sorted) {
    let m = cat.get(b.merchantId!);
    if (!m) cat.set(b.merchantId!, (m = new Map()));
    for (const it of b.items) {
      const code = normCode(it.description);
      if (!code || code.length > 60) continue;
      const e = m.get(code);
      m.set(code, { desc: it.description, code, lastUnitCents: it.unitPriceCents, lastDate: b.billDate, count: (e?.count ?? 0) + 1 });
    }
  }
  return cat;
}

/**
 * 发给 AI 的参考资料（纯文本，≤ maxChars）：常用商家名 + 各商家常用型号与上次单价。
 * 只用于辨认模糊手写，提示词里明确要求不得凭参考资料写出图片上没有的内容。
 */
export function buildHints(merchants: Merchant[], bills: Bill[], maxChars = 4000): string {
  const active = merchants.filter((m) => m.active && !m.deletedAt);
  if (!active.length) return '';
  const lastUse = new Map<string, string>();
  bills.forEach((b) => {
    if (!b.deletedAt && b.merchantId && (lastUse.get(b.merchantId) ?? '') < b.billDate) lastUse.set(b.merchantId, b.billDate);
  });
  const ordered = [...active].sort((a, b) => (lastUse.get(b.id) ?? '').localeCompare(lastUse.get(a.id) ?? ''));
  const cat = buildCatalog(bills);
  const lines: string[] = [];
  const names = ordered.slice(0, 40).map((m) => (m.aliases.length ? `${m.name}（也写作 ${m.aliases.slice(0, 3).join(' / ')}）` : m.name));
  lines.push(`已有商家：${names.join('；')}`);
  for (const m of ordered.slice(0, 12)) {
    const codes = [...(cat.get(m.id)?.values() ?? [])].sort((a, b) => b.count - a.count || b.lastDate.localeCompare(a.lastDate)).slice(0, 25);
    if (!codes.length) continue;
    lines.push(`${m.name} 常用型号（上次单价）：${codes.map((c) => `${c.desc}（${formatBRL(c.lastUnitCents, false)}）`).join('、')}`);
  }
  let out = lines.join('\n');
  if (out.length > maxChars) out = out.slice(0, maxChars).replace(/[^\n]*$/, '').trim();
  return out;
}

/* ---------------- 手写数字误读：改一个数字就对上 ---------------- */

const CONFUSE: Record<string, string[]> = {
  '0': ['6', '8', '9'],
  '1': ['7', '4'],
  '2': ['7', '3'],
  '3': ['8', '5', '2'],
  '4': ['9', '1'],
  '5': ['6', '3', '8'],
  '6': ['0', '5', '8'],
  '7': ['1', '2'],
  '8': ['3', '6', '0', '9'],
  '9': ['4', '8', '0'],
};

function variants(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const alts = CONFUSE[text[i]];
    if (!alts) continue;
    for (const a of alts) out.push(text.slice(0, i) + a + text.slice(i + 1));
  }
  return out;
}

export interface DigitFix {
  field: 'qty' | 'unit';
  value: string;
  label: string;
}

/**
 * 数量 × 单价 ≠ 图片小计时：找「只改一个数字（常见手写误读）就正好对上」的读法。
 * 只有唯一解时才返回；若只需把图片小计读成另一个数就对上，返回 subtotalNote（说明图片小计可能读错）。
 */
export function arithmeticFix(qtyText: string, unitText: string, printedSubtotalRaw: string): { fix: DigitFix | null; subtotalNote: string | null } {
  const qm = parseQuantityMilli(qtyText);
  const up = parseBRL(unitText);
  const ps = parseBRL(printedSubtotalRaw, { groupingKnown: true });
  if (qm === null || up.cents === null || up.ambiguous || ps.cents === null) return { fix: null, subtotalNote: null };
  const target = ps.cents;
  const sols: DigitFix[] = [];
  for (const v of variants(qtyText.trim())) {
    const m = parseQuantityMilli(v);
    if (m !== null && m > 0 && lineSubtotalCents(m / 1000, up.cents) === target) sols.push({ field: 'qty', value: v, label: `数量改为 ${v}` });
  }
  for (const v of variants(unitText.trim())) {
    const p = parseBRL(v);
    if (p.cents !== null && !p.ambiguous && p.cents > 0 && lineSubtotalCents(qm / 1000, p.cents) === target) sols.push({ field: 'unit', value: v, label: `单价改为 ${v}` });
  }
  // 单价漏写小数点（1900 → 19,00）
  if (/^\d{3,}$/.test(unitText.trim()) && lineSubtotalCents(qm / 1000, Number(unitText.trim())) === target) {
    const v = formatBRL(Number(unitText.trim()), false);
    sols.push({ field: 'unit', value: v, label: `单价改为 ${v}` });
  }
  const uniq = sols.filter((s, i) => sols.findIndex((x) => x.field === s.field && x.value === s.value) === i);
  let subtotalNote: string | null = null;
  const computed = lineSubtotalCents(qm / 1000, up.cents);
  const subDigits = printedSubtotalRaw.trim();
  if (variants(subDigits).some((v) => parseBRL(v, { groupingKnown: true }).cents === computed)) subtotalNote = `图片小计可能是 ${formatBRL(computed, false)}（只差一个数字，和数量×单价一致）`;
  return { fix: uniq.length === 1 ? uniq[0] : null, subtotalNote };
}

/* ---------------- 识别后：自动更正、交叉验证、建议 ---------------- */

/** 商家上保存的「识别成 A → 实际是 B」（key 为规范化后的识别文字） */
export type OcrFixes = Record<string, string>;

export interface LearnResult {
  state: EditorState;
  /** 在复核页顶部显示的说明 */
  notes: string[];
}

/**
 * 对识别草稿应用学习结果：
 *  1. 用户以前改过的「识别成 A → B」自动更正（标记 learned，复核页显示）
 *  2. 型号是这个商家的常用型号、且小计/单价对得上 → 标记 corroborated（不再要求逐行核对）
 *  3. 型号不在常用型号里、但和某个常用型号只差一点 → 给出「可能是 X」建议（需点一下）
 *  4. 单价和上次差很多 → 提醒
 */
export function applyLearning(state: EditorState, merchant: Pick<Merchant, 'id' | 'name'> & { ocrFixes?: OcrFixes | null } | null, catalog: Catalog): LearnResult {
  const notes: string[] = [];
  if (!merchant) return { state, notes };
  const fixes = merchant.ocrFixes ?? {};
  const known = catalog.get(merchant.id) ?? new Map<string, CatalogEntry>();
  let learnedCount = 0;
  const rows: RowState[] = state.rows.map((r) => {
    const row: RowState = { ...r };
    const raw = row.desc.trim();
    if (!raw) return row;
    const fixed = fixes[normCode(raw)];
    if (fixed && fixed !== raw) {
      row.desc = fixed;
      row.learned = `「${raw}」按你之前的修改改为「${fixed}」`;
      learnedCount++;
    }
    const code = normCode(row.desc);
    const entry = known.get(code);
    const unit = parseBRL(row.unitText);
    const qm = parseQuantityMilli(row.qtyText);
    const sub = row.printedSubtotalRaw ? parseBRL(row.printedSubtotalRaw, { groupingKnown: true }).cents : null;
    const arithOk = qm !== null && unit.cents !== null && !unit.ambiguous && sub !== null && lineSubtotalCents(qm / 1000, unit.cents) === sub;
    if (entry) {
      const priceSame = unit.cents !== null && unit.cents === entry.lastUnitCents;
      if (arithOk || (priceSame && qm !== null)) row.corroborated = arithOk ? '型号是这个商家的常用型号，数量×单价与图片小计一致' : '型号与单价都和这个商家上次一致';
      if (unit.cents !== null && entry.lastUnitCents > 0) {
        const ratio = unit.cents / entry.lastUnitCents;
        if (ratio > 1.3 || ratio < 0.7) row.priceNote = `${entry.desc} 上次单价 ${formatBRL(entry.lastUnitCents)}（${entry.lastDate.split('-').reverse().join('/')}），这次差别较大`;
      }
    } else if (known.size && code.length >= 2) {
      let best: CatalogEntry | null = null;
      let bestScore = 0;
      let second = 0;
      known.forEach((e) => {
        const s = similarity(code, e.code);
        if (s > bestScore) {
          second = bestScore;
          bestScore = s;
          best = e;
        } else if (s > second) second = s;
      });
      const b = best as CatalogEntry | null;
      if (b && bestScore >= 0.6 && bestScore - second >= 0.1) row.suggestDesc = b.desc;
    }
    return row;
  });
  if (learnedCount) notes.push(`已按你之前的修改自动更正 ${learnedCount} 处型号`);
  const corr = rows.filter((r) => r.corroborated).length;
  if (corr) notes.push(`${corr} 行与「${merchant.name}」的历史记录一致，已免去逐行核对`);
  return { state: { ...state, rows }, notes };
}

/**
 * 保存复核结果时学习：
 *  - 识别出的商家名和最终商家不同 → 记为别名
 *  - 用户把型号 A 改成 B → 记住 A → B（同一商家，最多 300 条）
 * 返回需要更新的商家字段（没有变化时为 null）
 */
export function learnFromReview(state: EditorState, merchant: Merchant | null): Partial<Pick<Merchant, 'aliases' | 'ocrFixes'>> | null {
  if (!merchant || !state.ocr) return null;
  const patch: Partial<Pick<Merchant, 'aliases' | 'ocrFixes'>> = {};
  const raw = state.ocr.merchantRaw?.trim();
  if (raw && raw.length <= 80) {
    const all = [merchant.name, ...merchant.aliases].map(normName);
    if (!all.includes(normName(raw)) && normName(raw)) patch.aliases = [...merchant.aliases, raw].slice(-20);
  }
  const fixes: OcrFixes = { ...(merchant.ocrFixes ?? {}) };
  let changed = false;
  for (const r of state.rows) {
    const from = r.orig?.desc?.trim();
    const to = r.desc.trim();
    if (!from || !to || from === to || r.learned) continue;
    if (normCode(from) === normCode(to)) continue;
    fixes[normCode(from)] = to;
    changed = true;
  }
  if (changed) {
    const keys = Object.keys(fixes);
    if (keys.length > 300) keys.slice(0, keys.length - 300).forEach((k) => delete fixes[k]);
    patch.ocrFixes = fixes;
  }
  return Object.keys(patch).length ? patch : null;
}
