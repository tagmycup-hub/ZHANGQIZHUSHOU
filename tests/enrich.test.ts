import { describe, it, expect } from 'vitest';
import { enrichDraft, parseRefMonth } from '../src/lib/ocr/enrich';
import { draftFromModel, normalizeModelOutput, computeIssues } from '../src/lib/ocr/protocol';
import { bankDV, barcodeToLine } from '../src/lib/boleto';
import { crc16 } from '../src/lib/pix';
import { nthBusinessDay } from '../src/lib/holidays';

const T = '2026-10-09';
let k = 0;
const key = () => `k${++k}`;
const base = { dueDateText: '', reminderDays: '3', accountId: null, accountLabel: '', merchantId: null, merchantName: '' };

/** 造一张合法的银行 boleto：银行 237，因子 1601（16/10/2026），金额 3.148,22 */
function makeBoletoLine(cents: number, factor = 1601) {
  const body = '2379' + String(factor) + String(cents).padStart(10, '0') + '1234567890123456789012345';
  const code = body.slice(0, 4) + bankDV(body) + body.slice(4);
  return barcodeToLine(code)!;
}

const boletoModel = (over: any = {}) =>
  normalizeModelOutput({
    docType: 'boleto',
    merchant: { value: 'Imobiliária Exemplo', confidence: 0.95 },
    orderNumber: { value: '109/00045453-7', confidence: 0.9 },
    billDate: { raw: '21/09/2026', iso: '2026-09-21', confidence: 0.9 },
    dueDate: { raw: '16/10/2026', iso: '2026-10-16', confidence: 0.95 },
    amountDue: { raw: '3.148,22', cents: 314822, confidence: 0.95 },
    paymentLine: makeBoletoLine(314822),
    referenceMonth: 'SET/2026',
    categoryHint: 'rent',
    items: [
      { row: 1, quantity: 1, description: 'ALUGUEL', unitPriceRaw: '1.700,00', unitPriceCents: 170000, printedSubtotalRaw: '1.700,00', printedSubtotalCents: 170000, confidence: 0.95, needsReview: false },
      { row: 2, quantity: 1, description: 'CONDOMINIO', unitPriceRaw: '1.448,22', unitPriceCents: 144822, printedSubtotalRaw: '1.448,22', printedSubtotalCents: 144822, confidence: 0.95, needsReview: false },
    ],
    printedTotalRaw: '3.148,22',
    printedTotalCents: 314822,
    unparsedLines: [],
    warnings: [],
    ...over,
  });

describe('识别结果加固', () => {
  it('boleto：数字线校验通过，金额/到期日/付款码/分类都自动填好，明细与总额一致', () => {
    const m = boletoModel();
    const { state } = enrichDraft(draftFromModel(m, 'test', base, key), m, {}, T);
    expect(state.kind).toBe('expense');
    expect(state.category).toBe('rent');
    expect(state.dueDateText).toBe('16/10/2026');
    expect(state.paymentCode).toBe(makeBoletoLine(314822));
    expect(state.amountMode).not.toBe('total');
    expect(state.ocr!.facts![0]).toContain('付款码校验通过');
    expect(state.notes).toContain('SET/2026');
    const issues = computeIssues(state, new Date(`${T}T12:00:00Z`)).filter((i) => i.level === 'block');
    expect(issues.map((i) => i.id)).toEqual([]);
  });
  it('数字线读错一位：不采用，并提示核对', () => {
    const bad = makeBoletoLine(314822).replace(/\d(?=\s\d{14}$)/, (d) => String((Number(d) + 1) % 10));
    const m = boletoModel({ paymentLine: bad });
    const { state, line } = enrichDraft(draftFromModel(m, 't', base, key), m, {}, T);
    expect(line).toBeNull();
    expect(state.paymentCode ?? '').toBe('');
    expect(state.ocr!.modelWarnings.join()).toContain('校验未通过');
    expect(state.dueDateText).toBe('16/10/2026'); // 退回模型读到的日期
  });
  it('票面金额与条码不一致：采用条码金额并警告', () => {
    const m = boletoModel({ amountDue: { raw: '3.148,32', cents: 314832, confidence: 0.6 }, items: [] });
    const { state } = enrichDraft(draftFromModel(m, 't', base, key), m, {}, T);
    expect(state.amountMode).toBe('total');
    expect(state.totalText).toBe('3.148,22');
    expect(state.ocr!.modelWarnings.join()).toContain('不一致');
  });
  it('扫码结果优先于图片读数', () => {
    const m = boletoModel({ paymentLine: null });
    const barcode = makeBoletoLine(314822).replace(/\D/g, '');
    const { line } = enrichDraft(draftFromModel(m, 't', base, key), m, { detected: ['xx'] }, T);
    expect(line).toBeNull();
    const r = enrichDraft(draftFromModel(m, 't', base, key), m, { pdfText: `Linha: ${makeBoletoLine(314822)}` }, T);
    expect(r.line?.amountCents).toBe(314822);
    expect(r.state.ocr!.facts![0]).toContain('PDF 文字');
    void barcode;
  });
  it('水电账单：只有总额与 PIX 码', () => {
    const body = '00020126330014br.gov.bcb.pix011112345678901520400005303986540592.445802BR5904Enel6009SAO PAULO62070503***6304';
    const pixCode = body + crc16(body);
    const m = normalizeModelOutput({ docType: 'utility', merchant: { value: 'Enel', confidence: 0.98 }, orderNumber: { value: null, confidence: 0 }, billDate: { raw: null, iso: null, confidence: 0 }, dueDate: { raw: '26/10/2026', iso: '2026-10-26', confidence: 0.95 }, amountDue: { raw: '92,44', cents: 9244, confidence: 0.95 }, categoryHint: 'electricity', referenceMonth: 'OUTUBRO 2026', items: [], printedTotalRaw: null, printedTotalCents: null, unparsedLines: [], warnings: [] });
    const { state } = enrichDraft(draftFromModel(m, 't', base, key), m, { detected: [pixCode] }, T);
    expect(state.category).toBe('power');
    expect(state.totalText).toBe('92,44');
    expect(state.paymentCode).toBe(pixCode);
    expect(state.billDateText).toBe('09/10/2026');
    expect(state.ocr!.facts!.join()).toContain('PIX');
  });
  it('工资单：按次月第 5 个工作日给到期日', () => {
    expect(parseRefMonth('Setembro/2026')).toBe('2026-09');
    expect(parseRefMonth('SET/2026')).toBe('2026-09');
    expect(parseRefMonth('09/2026')).toBe('2026-09');
    expect(nthBusinessDay('2026-10', 5)).toBe('2026-10-07');
    const m = normalizeModelOutput({ docType: 'payslip', merchant: { value: 'Funcionária Exemplo', confidence: 0.9 }, orderNumber: { value: null, confidence: 0 }, billDate: { raw: null, iso: null, confidence: 0 }, amountDue: { raw: '1.500,00', cents: 150000, confidence: 0.95 }, referenceMonth: 'Setembro/2026', items: [], printedTotalRaw: null, printedTotalCents: null, unparsedLines: [], warnings: [] });
    const { state } = enrichDraft(draftFromModel(m, 't', base, key), m, {}, T);
    expect(state.category).toBe('payroll');
    expect(state.dueDateText).toBe('07/10/2026');
    expect(state.ocr!.modelWarnings.join()).toContain('第 5 个工作日');
  });
  it('手写「箱数 × 每箱件数 × 单价」：数量取总件数', () => {
    const m = normalizeModelOutput({ docType: 'order', merchant: { value: null, confidence: 0 }, orderNumber: { value: null, confidence: 0 }, billDate: { raw: null, iso: null, confidence: 0 }, items: [{ row: 1, quantity: null, boxes: 2, perBox: 50, description: '600ml 白', unitPriceRaw: '19', unitPriceCents: 1900, printedSubtotalRaw: '1900', printedSubtotalCents: 190000, confidence: 0.8, needsReview: false }], printedTotalRaw: null, printedTotalCents: null, unparsedLines: [], warnings: [] });
    expect(m.items[0].quantity).toBe(100);
    const st = draftFromModel(m, 't', base, key);
    expect(st.rows[0].qtyText).toBe('100');
    const issues = computeIssues({ ...st, merchantName: 'X', billDateText: '01/10/2026', dueDateText: '31/10/2026' });
    expect(issues.some((i) => i.id.includes('arith'))).toBe(false);
  });
});

describe('Boleto 归类', () => {
  it('没有明确分类的 boleto 保持商家货款', () => {
    const m = boletoModel({ categoryHint: null });
    const { state } = enrichDraft(draftFromModel(m, 't', base, key), m, {}, T);
    expect(state.kind).not.toBe('expense');
    expect(state.paymentCode).toBe(makeBoletoLine(314822));
  });
});
