/**
 * 视觉模型 / OCR 输出协议：规范化、校验与复核问题计算。
 * 识别结果只是"候选草稿"，所有字段都要经过类型、范围、日期、金额校验。
 */
import { parseBRL, parseQuantityMilli, lineSubtotalCents, formatBRL, sumCents } from '../money';
import { parseBRDate, isValidISO, diffDays } from '../dates';
import { REPEAT_PRESETS, validateRule, type RepeatRule, type RepeatUnit } from '../recurrence';
import { arithmeticFix } from './learn';

export type BBox = [number, number, number, number]; // 归一化 x, y, w, h（0–1）

export interface ModelField<T> {
  value: T | null;
  confidence: number;
  candidates?: T[];
}

export interface ModelItem {
  row: number;
  quantity: number | null;
  description: string | null;
  unitPriceRaw: string | null;
  unitPriceCents: number | null;
  printedSubtotalRaw: string | null;
  printedSubtotalCents: number | null;
  confidence: number;
  needsReview: boolean;
  bbox?: BBox | null;
  /** 「箱数 × 每箱件数 × 单价」写法 */
  boxes?: number | null;
  perBox?: number | null;
}

export type DocType = 'order' | 'boleto' | 'utility' | 'tax' | 'payslip' | 'statement' | 'receipt';
export const DOC_TYPES: DocType[] = ['order', 'boleto', 'utility', 'tax', 'payslip', 'statement', 'receipt'];
export const DOC_LABEL: Record<DocType, string> = { order: '订单', boleto: '银行付款单（Boleto）', utility: '水电网账单', tax: '税费/政府缴费', payslip: '工资单', statement: '对账单', receipt: '收据' };

export interface StatementEntry {
  date: string | null;
  dateRaw: string | null;
  orderNumber: string | null;
  cents: number | null;
  raw: string | null;
  paid: boolean | null;
}
export interface StatementInfo {
  entries: StatementEntry[];
  payments: { date: string | null; cents: number | null; note: string | null }[];
  balanceCents: number | null;
}

export interface ModelOutput {
  merchant: ModelField<string>;
  orderNumber: ModelField<string>;
  billDate: { raw: string | null; iso: string | null; confidence: number };
  items: ModelItem[];
  printedTotalRaw: string | null;
  printedTotalCents: number | null;
  unparsedLines: string[];
  warnings: string[];
  docType?: DocType;
  dueDate?: { raw: string | null; iso: string | null; confidence: number };
  amountDue?: { raw: string | null; cents: number | null; confidence: number };
  paymentLine?: string | null;
  pixCode?: string | null;
  referenceMonth?: string | null;
  categoryHint?: string | null;
  statement?: StatementInfo | null;
}

const clamp01 = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const strOrNull = (v: unknown, max = 200): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};
const intOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1e11 ? v : null);
const bboxOrNull = (v: unknown): BBox | null => {
  if (!Array.isArray(v) || v.length !== 4 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const [x, y, w, h] = v as number[];
  if (w <= 0 || h <= 0 || x < -0.05 || y < -0.05 || x + w > 1.05 || y + h > 1.05) return null;
  return [x, y, w, h];
};

export class ProtocolError extends Error {}

/** 严格规范化模型返回；结构错误直接抛出，字段错误置 null 并记警告 */
export function normalizeModelOutput(input: unknown): ModelOutput {
  let o: any = input;
  if (typeof input === 'string') {
    try {
      o = JSON.parse(input);
    } catch {
      throw new ProtocolError('识别服务返回的不是 JSON');
    }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new ProtocolError('识别结果格式错误');
  if (!Array.isArray(o.items)) throw new ProtocolError('识别结果缺少 items 数组');
  const warnings: string[] = Array.isArray(o.warnings) ? o.warnings.map((w: unknown) => strOrNull(w, 300)).filter(Boolean) : [];

  const field = (f: any, max = 120): ModelField<string> => ({
    value: strOrNull(f?.value, max),
    confidence: clamp01(f?.confidence),
    candidates: Array.isArray(f?.candidates) ? f.candidates.map((c: unknown) => strOrNull(c, max)).filter(Boolean).slice(0, 5) : [],
  });

  const billRaw = strOrNull(o.billDate?.raw, 40);
  let billIso = strOrNull(o.billDate?.iso, 10);
  if (billIso && !isValidISO(billIso)) {
    warnings.push(`模型给出的账单日期 ${billIso} 不是有效日期，已忽略`);
    billIso = null;
  }

  const items: ModelItem[] = o.items.slice(0, 200).map((it: any, idx: number) => {
    let qty: number | null = typeof it?.quantity === 'number' && Number.isFinite(it.quantity) && it.quantity > 0 ? it.quantity : null;
    if (qty === null && typeof it?.quantity === 'string') {
      const m = parseQuantityMilli(it.quantity);
      qty = m === null ? null : m / 1000;
    }
    const unitRaw = strOrNull(it?.unitPriceRaw, 40);
    let unitCents = intOrNull(it?.unitPriceCents);
    const subRaw = strOrNull(it?.printedSubtotalRaw, 40);
    let subCents = intOrNull(it?.printedSubtotalCents);
    let needsReview = it?.needsReview !== false;
    // 原文与结构化值必须一致，否则两者都不采信
    if (unitRaw && unitCents !== null) {
      const p = parseBRL(unitRaw, { groupingKnown: true });
      if (p.cents !== null && p.cents !== unitCents) {
        warnings.push(`第 ${idx + 1} 行单价原文「${unitRaw}」与数值 ${formatBRL(unitCents)} 不一致`);
        unitCents = null;
        needsReview = true;
      }
    }
    if (subRaw && subCents !== null) {
      const p = parseBRL(subRaw, { groupingKnown: true });
      if (p.cents !== null && p.cents !== subCents) {
        warnings.push(`第 ${idx + 1} 行小计原文「${subRaw}」与数值 ${formatBRL(subCents)} 不一致`);
        subCents = null;
        needsReview = true;
      }
    }
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : typeof v === 'string' && /^\d+([.,]\d+)?$/.test(v.trim()) ? Number(v.trim().replace(',', '.')) : null);
    const boxes = num(it?.boxes);
    const perBox = num(it?.perBox);
    // 「箱数 × 每箱件数 × 单价」：数量取总件数
    if (boxes && perBox && (qty === null || qty === boxes)) qty = Math.round(boxes * perBox * 1000) / 1000;
    return {
      row: typeof it?.row === 'number' ? it.row : idx + 1,
      boxes,
      perBox,
      quantity: qty,
      description: strOrNull(it?.description, 120),
      unitPriceRaw: unitRaw,
      unitPriceCents: unitCents,
      printedSubtotalRaw: subRaw,
      printedSubtotalCents: subCents,
      confidence: clamp01(it?.confidence),
      needsReview,
      bbox: bboxOrNull(it?.bbox),
    };
  });

  const dateField = (f: any) => {
    const raw = strOrNull(f?.raw, 40);
    let iso = strOrNull(f?.iso, 10);
    if (iso && !isValidISO(iso)) iso = null;
    return { raw, iso, confidence: clamp01(f?.confidence) };
  };
  const docType: DocType | undefined = DOC_TYPES.includes(o.docType) ? o.docType : undefined;
  let statement: StatementInfo | null = null;
  if (docType === 'statement' && o.statement && Array.isArray(o.statement.entries)) {
    statement = {
      entries: o.statement.entries.slice(0, 200).map((e: any) => ({
        date: strOrNull(e?.date, 10) && isValidISO(String(e.date)) ? String(e.date) : null,
        dateRaw: strOrNull(e?.dateRaw, 40),
        orderNumber: strOrNull(e?.orderNumber, 60),
        cents: intOrNull(e?.cents),
        raw: strOrNull(e?.raw, 40),
        paid: typeof e?.paid === 'boolean' ? e.paid : null,
      })),
      payments: Array.isArray(o.statement.payments)
        ? o.statement.payments.slice(0, 200).map((p: any) => ({ date: strOrNull(p?.date, 10) && isValidISO(String(p.date)) ? String(p.date) : null, cents: intOrNull(p?.cents), note: strOrNull(p?.note, 80) }))
        : [],
      balanceCents: intOrNull(o.statement.balanceCents),
    };
  }
  return {
    docType,
    dueDate: dateField(o.dueDate),
    amountDue: { raw: strOrNull(o.amountDue?.raw, 40), cents: intOrNull(o.amountDue?.cents), confidence: clamp01(o.amountDue?.confidence) },
    paymentLine: strOrNull(o.paymentLine, 120),
    pixCode: strOrNull(o.pixCode, 600),
    referenceMonth: strOrNull(o.referenceMonth, 40),
    categoryHint: strOrNull(o.categoryHint, 30),
    statement,
    merchant: field(o.merchant),
    orderNumber: field(o.orderNumber, 60),
    billDate: { raw: billRaw, iso: billIso, confidence: clamp01(o.billDate?.confidence) },
    items,
    printedTotalRaw: strOrNull(o.printedTotalRaw, 40),
    printedTotalCents: intOrNull(o.printedTotalCents),
    unparsedLines: Array.isArray(o.unparsedLines) ? o.unparsedLines.map((l: unknown) => strOrNull(l, 300)).filter(Boolean) : [],
    warnings,
  };
}

/* ---------------- 编辑状态（手工录入与识别复核共用） ---------------- */

export interface RowState {
  key: string;
  qtyText: string;
  desc: string;
  unitText: string;
  printedSubtotalRaw?: string | null;
  confidence?: number;
  needsReview?: boolean;
  bbox?: BBox | null;
  /** 识别原值，用于记录人工修改 */
  orig?: { qty: string; desc: string; unit: string } | null;
  /** 学习：按用户以前的修改自动更正的说明 */
  learned?: string | null;
  /** 学习：与历史记录一致（免逐行核对）的理由 */
  corroborated?: string | null;
  /** 学习：型号不在常用型号里时，最接近的常用型号 */
  suggestDesc?: string | null;
  /** 学习：单价与上次差别较大 */
  priceNote?: string | null;
}

export interface EditorState {
  merchantId: string | null;
  merchantName: string;
  accountId: string | null;
  accountLabel: string;
  orderNumber: string;
  billDateText: string;
  dueDateText: string;
  reminderDays: string;
  notes: string;
  rows: RowState[];
  dueBeforeConfirmed: boolean;
  /** 金额模式：逐行明细 / 仅填总金额 */
  amountMode?: 'items' | 'total';
  totalText?: string;
  totalDesc?: string;
  /** 已付款时的付款日期（DD/MM/YYYY），为空表示未付 */
  paidDateText?: string;
  /** 复制来源 */
  copiedFrom?: { id: string; label: string } | null;
  /** 账单类型 */
  kind?: 'supplier' | 'expense';
  category?: string | null;
  paymentCode?: string;
  recurring?: boolean;
  /** 重复：'none' | 预设 key | 'custom' */
  repeatKey?: string;
  repeatEvery?: string;
  repeatUnit?: RepeatUnit;
  repeatUntil?: string;
  /** 到期日由商家账期规则自动计算 */
  dueAuto?: boolean;
  /** 按分期规则拆分保存 */
  splitInstallments?: boolean;
  /** 仅识别草稿 */
  ocr?: {
    provider: string;
    merchantRaw: string | null;
    merchantConfidence: number;
    merchantCandidates: string[];
    orderConfidence: number;
    orderRaw: string | null;
    billDateRaw: string | null;
    billDateConfidence: number;
    printedTotalRaw: string | null;
    unparsedLines: string[];
    modelWarnings: string[];
    rawText?: string | null;
    candidate: unknown;
    /** 单据类型 */
    docType?: DocType;
    /** 经过校验的事实（条码、PIX、PDF 文字），在核对页以绿色显示 */
    facts?: string[];
    /** 商家智能匹配结果 */
    merchantMatch?: { how: 'exact' | 'alias' | 'contains' | 'fuzzy'; score: number; via: string } | null;
    /** 学习说明（自动更正、免核对行数） */
    learnNotes?: string[];
  };
}

export type IssueLevel = 'block' | 'warn';

export interface Issue {
  id: string;
  level: IssueLevel;
  field: string;
  rowKey?: string;
  message: string;
  /** 可一键修复的动作 */
  fix?: { label: string; kind: 'confirmYear' | 'confirmDueBefore' | 'useCandidate' | 'setRow'; value?: string; target?: 'billDate' | 'dueDate'; rowField?: 'qty' | 'unit' | 'desc' };
  /** 第二个可选修复（例如两位年份：按今年） */
  fix2?: { label: string; kind: 'confirmYear'; value: string; target: 'billDate' | 'dueDate' };
}

export const LOW_CONF = 0.85;

const normDescKey = (s: string) => s.normalize('NFKC').toUpperCase().replace(/[\s\-_.]/g, '');

export interface ParsedRow {
  key: string;
  quantity: number | null;
  unitCents: number | null;
  subtotalCents: number | null;
  valid: boolean;
}

export function parseRow(r: RowState): ParsedRow {
  const milli = parseQuantityMilli(r.qtyText);
  const unit = parseBRL(r.unitText, { groupingKnown: false });
  const unitCents = unit.ambiguous ? null : unit.cents;
  const quantity = milli === null ? null : milli / 1000;
  const valid = quantity !== null && unitCents !== null && r.desc.trim().length > 0;
  return { key: r.key, quantity, unitCents, subtotalCents: valid ? lineSubtotalCents(quantity!, unitCents!) : null, valid };
}

export function isBlankRow(r: RowState): boolean {
  return !r.qtyText.trim() && !r.desc.trim() && !r.unitText.trim();
}

export function computedTotal(rows: RowState[]): number {
  return sumCents(rows.map(parseRow).filter((p) => p.valid).map((p) => p.subtotalCents!));
}

/** 编辑状态里的重复规则（无效或不重复时为 null） */
export function repeatRuleOf(s: Pick<EditorState, 'repeatKey' | 'repeatEvery' | 'repeatUnit' | 'recurring'>): RepeatRule | null {
  const key = s.repeatKey ?? (s.recurring ? 'm1' : 'none');
  if (key === 'none') return null;
  if (key === 'custom') {
    const every = Number(s.repeatEvery);
    const rule = { unit: s.repeatUnit ?? 'month', every };
    return validateRule(rule) ? null : rule;
  }
  return REPEAT_PRESETS.find((p) => p.key === key)?.rule ?? null;
}

export const isTotalMode = (s: Pick<EditorState, 'amountMode'>) => s.amountMode === 'total';

/** 仅填总金额模式下的金额（歧义或无效为 null） */
export function parseTotalOnly(s: Pick<EditorState, 'totalText'>): number | null {
  const p = parseBRL(s.totalText ?? '');
  return p.ambiguous ? null : p.cents;
}

/** 当前编辑状态的保存金额 */
export function stateTotal(s: EditorState): number {
  if (isTotalMode(s)) return parseTotalOnly(s) ?? 0;
  return computedTotal(s.rows);
}

export const TOTAL_ONLY_DESC = '整单金额（未列明细）';

/** 按模式生成要保存的明细 */
export function itemsForSave(s: EditorState, keyGen: () => string): { id: string; quantity: number; description: string; unitPriceCents: number; subtotalCents: number; recognizedSubtotalRaw: string | null }[] {
  if (isTotalMode(s)) {
    const cents = parseTotalOnly(s)!;
    return [{ id: s.rows[0]?.key ?? keyGen(), quantity: 1, description: (s.totalDesc ?? '').trim() || TOTAL_ONLY_DESC, unitPriceCents: cents, subtotalCents: cents, recognizedSubtotalRaw: null }];
  }
  return s.rows
    .filter((r) => !isBlankRow(r))
    .map((r) => {
      const p = parseRow(r);
      return { id: r.key, quantity: p.quantity!, description: r.desc.trim(), unitPriceCents: p.unitCents!, subtotalCents: p.subtotalCents!, recognizedSubtotalRaw: r.printedSubtotalRaw ?? null };
    });
}

export function computeIssues(s: EditorState, now: Date = new Date()): Issue[] {
  const out: Issue[] = [];
  const o = s.ocr;
  if (s.kind === 'expense') {
    if (!s.category) out.push({ id: 'category:empty', level: 'block', field: 'category', message: '请选择缴费类型（水费、电费、税费等）' });
  } else if (!s.merchantName.trim()) out.push({ id: 'merchant:empty', level: 'block', field: 'merchant', message: '请选择或新增商家' });
  if (s.paymentCode && s.paymentCode.length > 400) out.push({ id: 'paycode:long', level: 'block', field: 'paymentCode', message: '付款码过长' });
  const mm = o?.merchantMatch;
  const merchantSure = !!mm && s.merchantId && (mm.how !== 'fuzzy' || mm.score >= 0.9);
  if (o && mm && mm.how === 'fuzzy' && !merchantSure && s.merchantId) {
    out.push({ id: `merchant:fuzzy:${mm.via}:${s.merchantId}`, level: 'warn', field: 'merchant', message: `原图写的「${mm.via}」按相似名称匹配到「${s.merchantName}」，请确认是同一个商家` });
  } else if (o && o.merchantRaw && o.merchantConfidence < LOW_CONF && !merchantSure) {
    out.push({ id: `merchant:conf:${o.merchantRaw}`, level: 'warn', field: 'merchant', message: `商家识别置信度低（${Math.round(o.merchantConfidence * 100)}%）：原图写的是「${o.merchantRaw}」吗？` });
  }
  if (o && o.orderRaw && o.orderConfidence < LOW_CONF) {
    out.push({ id: `order:conf:${o.orderRaw}`, level: 'warn', field: 'orderNumber', message: `订单号置信度低（${Math.round(o.orderConfidence * 100)}%），请核对「${o.orderRaw}」` });
  }
  const dateCheck = (text: string, field: 'billDate' | 'dueDate', label: string) => {
    const p = parseBRDate(text, now);
    if (p.iso) return p.iso;
    if (p.needsConfirm && p.candidate) {
      const y = p.candidate.slice(0, 4);
      const thisYear = now.getUTCFullYear();
      const alt = `${thisYear}${p.candidate.slice(4)}`;
      // 年份离今年很远（如手写 "22/9/22" 其实是今年的单子）时，同时给出「按今年」
      const far = Math.abs(Number(y) - thisYear) > 1 && isValidISO(alt);
      out.push({
        id: `${field}:yy`,
        level: 'block',
        field,
        message: far ? `${label}只写了两位年份「${p.raw.split(/[/.\-]/).pop()}」，${y} 年离现在较远，请确认` : `${label}只写了两位年份，请确认`,
        fix: { label: `是 ${y} 年`, kind: 'confirmYear', value: p.candidate, target: field },
        ...(far ? { fix2: { label: `按今年 ${thisYear}`, kind: 'confirmYear' as const, value: alt, target: field } } : {}),
      });
    } else {
      out.push({ id: `${field}:invalid`, level: 'block', field, message: `${label}：${p.error ?? '无效'}` });
    }
    return null;
  };
  const bill = dateCheck(s.billDateText, 'billDate', '账单日期');
  const due = dateCheck(s.dueDateText, 'dueDate', '到期日期');
  if (o && o.billDateRaw && o.billDateConfidence < LOW_CONF) {
    out.push({ id: `billDate:conf:${o.billDateRaw}`, level: 'warn', field: 'billDate', message: `账单日期置信度低，原图为「${o.billDateRaw}」，请核对` });
  }
  if (bill && due && diffDays(bill, due) < 0 && !s.dueBeforeConfirmed) {
    out.push({ id: 'dueDate:before', level: 'block', field: 'dueDate', message: '到期日早于账单日', fix: { label: '确认无误', kind: 'confirmDueBefore' } });
  }
  const rd = Number(s.reminderDays);
  if (!/^\d+$/.test(s.reminderDays.trim()) || rd > 60) out.push({ id: 'reminder:invalid', level: 'block', field: 'reminderDays', message: '提醒天数应为 0–60 的整数' });

  let validCount = 0;
  const totalMode = isTotalMode(s);
  if (totalMode) {
    const raw = (s.totalText ?? '').trim();
    const p = parseBRL(raw);
    if (!raw) out.push({ id: 'total:empty', level: 'block', field: 'totalOnly', message: '请填写总金额' });
    else if (p.ambiguous) out.push({ id: 'total:amb', level: 'block', field: 'totalOnly', message: `总金额「${raw}」有歧义：${p.error}。请改写成 1.234,00 或 12,34 的形式` });
    else if (p.cents === null) out.push({ id: 'total:bad', level: 'block', field: 'totalOnly', message: `总金额：${p.error}` });
    else if (p.cents === 0) out.push({ id: 'total:zero', level: 'block', field: 'totalOnly', message: '总金额不能为 0' });
    else validCount = 1;
  }
  (totalMode ? [] : s.rows).forEach((r, idx) => {
    const n = idx + 1;
    if (isBlankRow(r)) return;
    const p = parseRow(r);
    if (p.valid) validCount++;
    if (parseQuantityMilli(r.qtyText) === null) out.push({ id: `row:${r.key}:qty`, level: 'block', field: 'qty', rowKey: r.key, message: `第 ${n} 行数量${r.qtyText.trim() ? '格式不正确' : '为空'}` });
    if (!r.desc.trim()) out.push({ id: `row:${r.key}:desc`, level: 'block', field: 'desc', rowKey: r.key, message: `第 ${n} 行型号/描述为空` });
    const up = parseBRL(r.unitText);
    if (!r.unitText.trim()) out.push({ id: `row:${r.key}:unit`, level: 'block', field: 'unit', rowKey: r.key, message: `第 ${n} 行单价为空` });
    else if (up.ambiguous) out.push({ id: `row:${r.key}:unitamb`, level: 'block', field: 'unit', rowKey: r.key, message: `第 ${n} 行单价「${r.unitText}」有歧义：${up.error}。请改写成 1.234,00 或 12,34 的形式` });
    else if (up.cents === null) out.push({ id: `row:${r.key}:unit`, level: 'block', field: 'unit', rowKey: r.key, message: `第 ${n} 行单价：${up.error}` });
    if (o && !r.corroborated && (r.needsReview || (r.confidence ?? 1) < LOW_CONF)) {
      out.push({ id: `row:${r.key}:conf:${r.qtyText}|${r.desc}|${r.unitText}`, level: 'warn', field: 'row', rowKey: r.key, message: `第 ${n} 行识别置信度${r.confidence !== undefined ? ` ${Math.round(r.confidence * 100)}%` : '低'}，请逐项对照原图` });
    }
    if (r.printedSubtotalRaw && p.valid) {
      const ps = parseBRL(r.printedSubtotalRaw, { groupingKnown: true });
      if (ps.cents === null) {
        out.push({ id: `row:${r.key}:subraw:${r.printedSubtotalRaw}`, level: 'warn', field: 'subtotal', rowKey: r.key, message: `第 ${n} 行图片小计「${r.printedSubtotalRaw}」无法解析` });
      } else if (ps.cents !== p.subtotalCents) {
        const d = p.subtotalCents! - ps.cents;
        const af = arithmeticFix(r.qtyText, r.unitText, r.printedSubtotalRaw);
        const hint = af.fix ? `；手写常见误读：${af.fix.label}就正好对上` : af.subtotalNote ? `；${af.subtotalNote}` : '';
        out.push({
          id: `row:${r.key}:arith:${p.subtotalCents}:${ps.cents}`,
          level: 'warn',
          field: 'subtotal',
          rowKey: r.key,
          message: `第 ${n} 行算术不符：计算 ${formatBRL(p.subtotalCents)}，图片小计 ${formatBRL(ps.cents)}，差额 ${d > 0 ? '+' : ''}${formatBRL(d)}${hint}`,
          ...(af.fix ? { fix: { label: af.fix.label, kind: 'setRow' as const, rowField: af.fix.field, value: af.fix.value } } : {}),
        });
      }
    }
    if (o && r.suggestDesc && normDescKey(r.suggestDesc) !== normDescKey(r.desc) && r.desc.trim()) {
      out.push({ id: `row:${r.key}:suggest:${r.desc}`, level: 'warn', field: 'desc', rowKey: r.key, message: `第 ${n} 行型号「${r.desc}」不是这个商家的常用型号，可能是「${r.suggestDesc}」`, fix: { label: `改为 ${r.suggestDesc}`, kind: 'setRow', rowField: 'desc', value: r.suggestDesc } });
    }
    if (o && r.priceNote) {
      out.push({ id: `row:${r.key}:price:${r.unitText}`, level: 'warn', field: 'unit', rowKey: r.key, message: `第 ${n} 行：${r.priceNote}` });
    }
  });
  if (validCount === 0 && !totalMode) out.push({ id: 'items:none', level: 'block', field: 'items', message: '至少需要一行完整明细，或切换为「仅填总金额」' });

  if (s.repeatKey === 'custom') {
    const err = validateRule({ unit: s.repeatUnit ?? 'month', every: Number(s.repeatEvery) });
    if (err || !/^\d+$/.test((s.repeatEvery ?? '').trim())) out.push({ id: 'repeat:bad', level: 'block', field: 'repeat', message: `重复周期：${err ?? '请填写正整数'}` });
  }
  if (s.repeatKey && s.repeatKey !== 'none' && s.repeatUntil?.trim()) {
    const u = parseBRDate(s.repeatUntil, now);
    if (!u.iso) out.push({ id: 'repeatUntil:bad', level: 'block', field: 'repeat', message: `重复结束日期：${u.error ?? '无效'}` });
    else if (due && u.iso < due) out.push({ id: 'repeatUntil:before', level: 'block', field: 'repeat', message: '重复结束日期早于这一期的到期日' });
  }

  if (s.paidDateText && s.paidDateText.trim()) {
    const pd = parseBRDate(s.paidDateText, now);
    if (!pd.iso) out.push({ id: 'paidDate:invalid', level: 'block', field: 'paidDate', message: `付款日期：${pd.error ?? '无效'}` });
  }

  if (o?.printedTotalRaw && (validCount > 0 || !totalMode)) {
    const pt = parseBRL(o.printedTotalRaw, { groupingKnown: true });
    const ct = stateTotal(s);
    if (pt.cents === null) out.push({ id: `total:raw:${o.printedTotalRaw}`, level: 'warn', field: 'total', message: `图片总额「${o.printedTotalRaw}」无法解析，将使用计算总额 ${formatBRL(ct)}` });
    else if (pt.cents !== ct)
      out.push({
        id: `total:arith:${ct}:${pt.cents}`,
        level: 'warn',
        field: totalMode ? 'totalOnly' : 'total',
        message: totalMode ? `填写的总金额 ${formatBRL(ct)} 与图片 TOTAL ${formatBRL(pt.cents)} 不同，差额 ${formatBRL(ct - pt.cents)}` : `总额冲突：计算 ${formatBRL(ct)}，图片 TOTAL ${formatBRL(pt.cents)}，差额 ${formatBRL(ct - pt.cents)}。保存时以计算总额为准`,
      });
  }
  o?.unparsedLines.forEach((l, i) => out.push({ id: `unparsed:${i}:${l}`, level: 'warn', field: 'unparsed', message: `未解析行：「${l}」— 是否漏了一行明细？` }));
  o?.modelWarnings.forEach((w, i) => out.push({ id: `model:${i}:${w}`, level: 'warn', field: 'model', message: w }));
  return out;
}

export interface GateResult {
  canSave: boolean;
  reasons: string[];
}

export function saveGate(s: EditorState, issues: Issue[], acknowledged: Set<string>, confirmedAgainstImage: boolean): GateResult {
  const reasons: string[] = [];
  const blocks = issues.filter((i) => i.level === 'block');
  if (blocks.length) reasons.push(`还有 ${blocks.length} 个必须修正的问题`);
  if (s.ocr) {
    const pending = issues.filter((i) => i.level === 'warn' && !acknowledged.has(i.id));
    if (pending.length) reasons.push(`还有 ${pending.length} 条识别警告未核对`);
    if (!confirmedAgainstImage) reasons.push('请勾选「我已对照原图确认」');
  }
  return { canSave: reasons.length === 0, reasons };
}

/** 把模型输出转成编辑状态（不做任何"修正"） */
export function draftFromModel(m: ModelOutput, provider: string, base: Pick<EditorState, 'dueDateText' | 'reminderDays' | 'accountId' | 'accountLabel' | 'merchantId' | 'merchantName'>, keyGen: () => string, rawText?: string | null): EditorState {
  const qtyStr = (q: number | null) => (q === null ? '' : String(q).replace('.', ','));
  const unitStr = (it: ModelItem) => it.unitPriceRaw ?? (it.unitPriceCents !== null ? formatBRL(it.unitPriceCents, false) : '');
  let billText = '';
  if (m.billDate.iso) {
    const [y, mo, d] = m.billDate.iso.split('-');
    billText = `${d}/${mo}/${y}`;
  } else if (m.billDate.raw) billText = m.billDate.raw;
  return {
    ...base,
    orderNumber: m.orderNumber.value ?? '',
    billDateText: billText,
    notes: '',
    dueBeforeConfirmed: false,
    rows: m.items.map((it) => {
      const r: RowState = {
        key: keyGen(),
        qtyText: qtyStr(it.quantity),
        desc: it.description ?? '',
        unitText: unitStr(it),
        printedSubtotalRaw: it.printedSubtotalRaw ?? (it.printedSubtotalCents !== null ? formatBRL(it.printedSubtotalCents, false) : null),
        confidence: it.confidence,
        needsReview: it.needsReview,
        bbox: it.bbox ?? null,
      };
      r.orig = { qty: r.qtyText, desc: r.desc, unit: r.unitText };
      return r;
    }),
    ocr: {
      provider,
      merchantRaw: m.merchant.value,
      merchantConfidence: m.merchant.confidence,
      merchantCandidates: m.merchant.candidates ?? [],
      orderConfidence: m.orderNumber.confidence,
      orderRaw: m.orderNumber.value,
      billDateRaw: m.billDate.raw,
      billDateConfidence: m.billDate.confidence,
      printedTotalRaw: m.printedTotalRaw ?? (m.printedTotalCents !== null ? formatBRL(m.printedTotalCents, false) : null),
      unparsedLines: m.unparsedLines,
      modelWarnings: m.warnings,
      rawText: rawText ?? null,
      candidate: m,
    },
  };
}

/** 商家名称匹配（名称或别名，忽略大小写与空白） */
export function matchMerchant<T extends { id: string; name: string; aliases: string[]; active: boolean }>(raw: string | null, merchants: T[]): T | null {
  if (!raw) return null;
  const norm = (s: string) => s.toLowerCase().normalize('NFKC').replace(/[\s.\-_'’]/g, '');
  const r = norm(raw);
  if (!r) return null;
  const hits = merchants.filter((m) => m.active && [m.name, ...m.aliases].some((n) => norm(n) === r));
  return hits.length === 1 ? hits[0] : null;
}
