/**
 * 识别结果「加固」：用可校验的信息（条码 / 数字线校验位、PIX CRC、PDF 文字）核对模型读到的金额、到期日和付款码。
 * 校验通过的信息优先采用；与模型读数不一致时保留警告让人核对，绝不悄悄改。
 */
import type { EditorState, ModelOutput, DocType } from './protocol';
import { findLines, parseLine, type LineInfo } from '../boleto';
import { findPix, parsePix, type PixInfo } from '../pix';
import { formatBRL, centsToInput, parseBRL } from '../money';
import { formatBR, parseBRDate, shiftMonth } from '../dates';
import { nthBusinessDay } from '../holidays';

export interface Evidence {
  /** 浏览器扫码识别到的原文（条码、二维码） */
  detected?: string[];
  /** PDF 的文字层 */
  pdfText?: string | null;
}

const HINT_TO_CATEGORY: Record<string, string> = {
  water: 'water',
  electricity: 'power',
  gas: 'gas',
  internet: 'internet',
  phone: 'internet',
  rent: 'rent',
  condo: 'condo',
  tax: 'tax',
  payroll: 'payroll',
  accounting: 'accounting',
  logistics: 'shipping',
  platform: 'platform',
  loan: 'loan',
  subscription: 'software',
  other: 'other',
};
const SEGMENT_TO_CATEGORY: Record<string, string> = { water: 'water', energy: 'power', telecom: 'internet', government: 'tax', city: 'tax', fine: 'tax' };

export const EXPENSE_DOCS: DocType[] = ['utility', 'tax', 'payslip'];

/** 葡文月份 → 月份数字（用于工资单的 competência） */
const PT_MONTH: Record<string, number> = { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 };
export function parseRefMonth(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const num = t.match(/\b(\d{1,2})\s*[/.\-]\s*(\d{4})\b/);
  if (num && Number(num[1]) >= 1 && Number(num[1]) <= 12) return `${num[2]}-${num[1].padStart(2, '0')}`;
  const name = t.match(/\b(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-z]*\s*[/.\- ]?\s*(\d{4})\b/);
  if (name) return `${name[2]}-${String(PT_MONTH[name[1]]).padStart(2, '0')}`;
  return null;
}

export interface Enriched {
  state: EditorState;
  line: LineInfo | null;
  pix: PixInfo | null;
}

export function enrichDraft(state0: EditorState, m: ModelOutput, ev: Evidence, today: string): Enriched {
  const state: EditorState = { ...state0, ocr: state0.ocr ? { ...state0.ocr, facts: [...(state0.ocr.facts ?? [])], modelWarnings: [...state0.ocr.modelWarnings] } : state0.ocr };
  const facts = state.ocr?.facts ?? [];
  const warns = state.ocr?.modelWarnings ?? [];
  const docType = m.docType ?? 'order';
  if (state.ocr) state.ocr.docType = docType;

  // 1. 找可校验的付款码：扫码 > PDF 文字 > 模型读到的数字线
  const detected = ev.detected ?? [];
  const lines: { info: LineInfo; src: string }[] = [];
  const pixes: { info: PixInfo; src: string }[] = [];
  for (const raw of detected) {
    const l = parseLine(raw, today);
    if (l) lines.push({ info: l, src: '条码扫描' });
    const p = parsePix(raw);
    if (p?.valid) pixes.push({ info: p, src: '二维码扫描' });
  }
  if (ev.pdfText) {
    for (const l of findLines(ev.pdfText, today)) lines.push({ info: l, src: 'PDF 文字' });
    for (const p of findPix(ev.pdfText)) if (p.valid) pixes.push({ info: p, src: 'PDF 文字' });
  }
  if (m.paymentLine) {
    const l = parseLine(m.paymentLine, today);
    if (l) lines.push({ info: l, src: '图片上的数字线' });
    else if (!lines.length) warns.push(`图片上读到的数字线「${m.paymentLine}」校验未通过（可能有数字看错），没有采用，请对照原图核对付款码`);
  }
  if (m.pixCode) {
    const p = parsePix(m.pixCode);
    if (p?.valid) pixes.push({ info: p, src: '图片上的 PIX 复制码' });
    else if (!pixes.length) warns.push('图片上的 PIX 复制码校验未通过，没有采用');
  }
  const line = lines[0]?.info ?? null;
  const pix = pixes[0]?.info ?? null;

  // 2. 账单类型与分类
  // Boleto 可能是供应商货款，也可能是房租、会计等日常缴费：有明确分类才算缴费
  const hinted = !!(m.categoryHint && HINT_TO_CATEGORY[m.categoryHint] && m.categoryHint !== 'other');
  const isExpenseDoc = docType === 'boleto' ? hinted || line?.kind === 'utility' : EXPENSE_DOCS.includes(docType) || (docType === 'receipt' && !m.items.length);
  if (isExpenseDoc) {
    state.kind = 'expense';
    const cat = (m.categoryHint && HINT_TO_CATEGORY[m.categoryHint]) || (line?.segment && SEGMENT_TO_CATEGORY[line.segment]) || (docType === 'payslip' ? 'payroll' : docType === 'tax' ? 'tax' : null);
    if (cat) state.category = cat;
  }

  // 3. 金额：条码金额经过校验，优先采用
  const modelAmount = m.amountDue?.cents ?? m.printedTotalCents ?? null;
  const itemsSum = m.items.reduce((a, it) => a + (it.printedSubtotalCents ?? 0), 0);
  let amount: number | null = null;
  if (line?.amountCents) {
    amount = line.amountCents;
    facts.push(`付款码校验通过（来自${lines[0].src}）：金额 ${formatBRL(line.amountCents)}${line.dueDate ? `，到期 ${formatBR(line.dueDate)}` : ''}`);
    if (modelAmount !== null && modelAmount !== amount) warns.push(`票面上识别的金额 ${formatBRL(modelAmount)} 与付款码里的金额 ${formatBRL(amount)} 不一致，已采用付款码金额（付款码经过校验）`);
  } else if (pix?.amountCents) {
    amount = pix.amountCents;
    facts.push(`PIX 复制码校验通过（来自${pixes[0].src}）：金额 ${formatBRL(pix.amountCents)}${pix.merchantName ? `，收款方 ${pix.merchantName.trim()}` : ''}`);
    if (modelAmount !== null && modelAmount !== amount) warns.push(`票面金额 ${formatBRL(modelAmount)} 与 PIX 码里的金额 ${formatBRL(amount)} 不一致，已采用 PIX 金额`);
  } else {
    if (pix) facts.push(`PIX 复制码校验通过（来自${pixes[0].src}${pix.merchantName ? `，收款方 ${pix.merchantName.trim()}` : ''}）${pix.dynamic ? '；动态码不含金额' : ''}`);
    amount = modelAmount;
  }
  // 只有一个总额（没有明细，或明细加起来就是总额以外的东西）时用「仅填总金额」
  if (amount !== null && (!m.items.length || (isExpenseDoc && itemsSum !== amount))) {
    state.amountMode = 'total';
    state.totalText = centsToInput(amount);
    if (m.amountDue?.raw && !line?.amountCents && !pix?.amountCents) state.totalText = m.amountDue.raw;
    if (state.ocr && amount !== null) state.ocr.printedTotalRaw = centsToInput(amount);
    if (m.items.length && isExpenseDoc) {
      state.totalDesc = m.items.map((it) => `${it.description ?? ''} ${it.printedSubtotalRaw ?? ''}`.trim()).filter(Boolean).join('；').slice(0, 120);
    }
  } else if (amount !== null && state.ocr && !state.ocr.printedTotalRaw) state.ocr.printedTotalRaw = centsToInput(amount);

  // 4. 到期日
  const modelDue = m.dueDate?.iso ?? (m.dueDate?.raw ? parseBRDate(m.dueDate.raw).iso : null);
  if (line?.dueDate) {
    state.dueDateText = formatBR(line.dueDate);
    state.dueAuto = false;
    if (modelDue && modelDue !== line.dueDate) warns.push(`票面上识别的到期日 ${formatBR(modelDue)} 与付款码里的 ${formatBR(line.dueDate)} 不一致，已采用付款码日期`);
  } else if (modelDue) {
    state.dueDateText = formatBR(modelDue);
    state.dueAuto = false;
  } else if (m.dueDate?.raw) {
    state.dueDateText = m.dueDate.raw;
  } else if (docType === 'payslip') {
    const ref = parseRefMonth(m.referenceMonth) ?? today.slice(0, 7);
    const pay = nthBusinessDay(shiftMonth(ref, 1), 5);
    state.dueDateText = formatBR(pay);
    warns.push(`工资单没有到期日，已按次月第 5 个工作日（${formatBR(pay)}）填写，请按实际发薪日修改`);
  }

  // 5. 开单日期：缴费类单据常没有，用今天
  if (!state.billDateText && isExpenseDoc) state.billDateText = formatBR(today);
  if (state.billDateText && state.dueDateText) {
    const b = parseBRDate(state.billDateText).iso;
    const d = parseBRDate(state.dueDateText).iso;
    if (b && d && d < b) state.billDateText = state.dueDateText;
  }

  // 6. 付款码与备注
  if (line) state.paymentCode = line.line;
  else if (pix) state.paymentCode = pix.code;
  if (m.referenceMonth) state.notes = [state.notes, `参考月份：${m.referenceMonth}`].filter(Boolean).join('\n');

  // 7. 金额文本若有歧义（如 "2,808.00"），改用模型给出的分
  if (state.amountMode === 'total' && state.totalText && parseBRL(state.totalText).ambiguous && amount !== null) state.totalText = centsToInput(amount);

  if (state.ocr) {
    state.ocr.facts = facts;
    state.ocr.modelWarnings = warns;
  }
  return { state, line, pix };
}
