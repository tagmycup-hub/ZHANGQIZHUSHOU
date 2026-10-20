import { describe, it, expect } from 'vitest';
import fixture from './fixtures/ticket-258.model.json';
import { normalizeModelOutput, draftFromModel, computeIssues, saveGate, computedTotal, parseRow, matchMerchant, ProtocolError, type EditorState } from '../src/lib/ocr/protocol';
import { groupLines, parseItemLine, wordsToModelOutput, type Word } from '../src/lib/ocr/rows';

let k = 0;
const key = () => `k${++k}`;
const base = { dueDateText: '12/10/2026', reminderDays: '3', accountId: 'a1', accountLabel: 'PIX', merchantId: 'm1', merchantName: 'Loja Exemplo' };
const now = new Date('2026-09-15T12:00:00Z');

describe('A03 样例票据 258（测试夹具）', () => {
  const out = normalizeModelOutput(fixture);
  const draft = draftFromModel(out, 'claude', base, key);
  it('复核页形成 4 行明细与总额 368', () => {
    const rows = draft.rows.map((r) => ({ ...parseRow(r), desc: r.desc }));
    expect(rows.map((r) => [r.quantity, r.desc, r.unitCents, r.subtotalCents])).toEqual([
      [30, 'FN-A78', 800, 24000],
      [5, 'FN-A76', 800, 4000],
      [5, 'CA31-3', 1500, 7500],
      [1, 'CA31-7', 1300, 1300],
    ]);
    expect(computedTotal(draft.rows)).toBe(36800);
  });
  it('订单号保留前导零', () => expect(draft.orderNumber).toBe('0258'));
  it('两位年份与低置信度必须处理，未确认不能保存', () => {
    const issues = computeIssues(draft, now);
    expect(issues.find((i) => i.id === 'billDate:yy')?.level).toBe('block');
    expect(issues.some((i) => i.level === 'warn' && i.field === 'merchant')).toBe(true);
    expect(issues.some((i) => i.level === 'warn' && i.field === 'row')).toBe(true);
    expect(saveGate(draft, issues, new Set(), false).canSave).toBe(false);
  });
  it('修正并确认全部警告后才能保存', () => {
    const fixed: EditorState = { ...draft, billDateText: '12/09/2026' };
    const issues = computeIssues(fixed, now);
    expect(issues.filter((i) => i.level === 'block')).toEqual([]);
    const acks = new Set(issues.map((i) => i.id));
    expect(saveGate(fixed, issues, acks, false).canSave).toBe(false);
    expect(saveGate(fixed, issues, acks, true).canSave).toBe(true);
  });
});

describe('A04 低清/歧义', () => {
  it('看不清的字段保留 null，产生未解析行警告', () => {
    const out = normalizeModelOutput({
      merchant: { value: null, confidence: 0 },
      orderNumber: { value: null, confidence: 0 },
      billDate: { raw: null, iso: null, confidence: 0 },
      items: [{ row: 1, quantity: null, description: 'FN-A7?', unitPriceRaw: null, unitPriceCents: null, printedSubtotalRaw: null, printedSubtotalCents: null, confidence: 0.3, needsReview: true }],
      printedTotalRaw: null, printedTotalCents: null,
      unparsedLines: ['3 xx 12 36'], warnings: ['第 2 行被阴影遮挡'],
    });
    expect(out.items[0].quantity).toBeNull();
    expect(out.items[0].unitPriceCents).toBeNull();
    expect(out.merchant.value).toBeNull();
    const d = draftFromModel(out, 'claude', { ...base, merchantName: '', merchantId: null }, key);
    const issues = computeIssues(d, now);
    expect(issues.some((i) => i.field === 'unparsed' && i.level === 'warn')).toBe(true);
    expect(issues.some((i) => i.field === 'model')).toBe(true);
    expect(issues.some((i) => i.id === 'merchant:empty')).toBe(true);
    expect(issues.some((i) => i.field === 'qty' && i.level === 'block')).toBe(true);
    const gate = saveGate(d, issues, new Set(issues.map((i) => i.id)), true);
    expect(gate.canSave).toBe(false);
  });
  it('原文与数值矛盾时两者都不采信', () => {
    const out = normalizeModelOutput({ ...fixture, items: [{ ...fixture.items[0], unitPriceRaw: '8', unitPriceCents: 900 }] });
    expect(out.items[0].unitPriceCents).toBeNull();
    expect(out.items[0].needsReview).toBe(true);
    expect(out.warnings.join()).toMatch(/不一致/);
  });
  it('非法结构抛出协议错误；非法日期与 bbox 被丢弃', () => {
    expect(() => normalizeModelOutput('not json')).toThrow(ProtocolError);
    expect(() => normalizeModelOutput({ items: 'x' })).toThrow(ProtocolError);
    const out = normalizeModelOutput({ ...fixture, billDate: { raw: '31/02/2026', iso: '2026-02-31', confidence: 0.9 }, items: [{ ...fixture.items[0], bbox: [0, 0, 2, 2] }] });
    expect(out.billDate.iso).toBeNull();
    expect(out.items[0].bbox).toBeNull();
  });
  it('歧义单价阻止保存', () => {
    const d = draftFromModel(normalizeModelOutput(fixture), 'claude', base, key);
    d.billDateText = '12/09/2026';
    d.rows[0].unitText = '1.234';
    const issues = computeIssues(d, now);
    expect(issues.some((i) => i.id.endsWith(':unitamb') && i.level === 'block')).toBe(true);
  });
});

describe('A05 算术冲突', () => {
  it('同时展示识别小计、计算小计和差额，不静默修正', () => {
    const f = structuredClone(fixture);
    f.items[0].printedSubtotalRaw = '250';
    f.items[0].printedSubtotalCents = 25000;
    f.printedTotalRaw = '378';
    f.printedTotalCents = 37800;
    const d = draftFromModel(normalizeModelOutput(f), 'claude', base, key);
    d.billDateText = '12/09/2026';
    const issues = computeIssues(d, now);
    const row = issues.find((i) => i.id.includes(':arith:'))!;
    expect(row.message).toContain('R$ 240,00');
    expect(row.message).toContain('R$ 250,00');
    expect(row.message).toContain('-R$ 10,00');
    const tot = issues.find((i) => i.id.startsWith('total:arith'))!;
    expect(tot.message).toContain('R$ 368,00');
    expect(tot.message).toContain('R$ 378,00');
    expect(parseRow(d.rows[0]).subtotalCents).toBe(24000);
    expect(computedTotal(d.rows)).toBe(36800);
  });
  it('修改数值后，旧的确认失效（id 变化）', () => {
    const f = structuredClone(fixture);
    f.items[0].printedSubtotalRaw = '250';
    f.items[0].printedSubtotalCents = 25000;
    const d = draftFromModel(normalizeModelOutput(f), 'claude', base, key);
    const id1 = computeIssues(d, now).find((i) => i.id.includes(':arith:'))!.id;
    d.rows[0].qtyText = '31';
    const id2 = computeIssues(d, now).find((i) => i.id.includes(':arith:'))!.id;
    expect(id1).not.toBe(id2);
  });
});

describe('手工录入（无识别）', () => {
  it('到期日早于账单日需确认', () => {
    const s: EditorState = { ...base, orderNumber: '', billDateText: '10/09/2026', dueDateText: '01/09/2026', notes: '', dueBeforeConfirmed: false, rows: [{ key: 'a', qtyText: '1', desc: 'X', unitText: '10' }] };
    expect(computeIssues(s, now).find((i) => i.id === 'dueDate:before')?.fix?.kind).toBe('confirmDueBefore');
    expect(computeIssues({ ...s, dueBeforeConfirmed: true }, now).filter((i) => i.level === 'block')).toEqual([]);
    expect(saveGate(s, [], new Set(), false).canSave).toBe(true);
  });
  it('空白行被忽略', () => {
    const s: EditorState = { ...base, orderNumber: '', billDateText: '10/09/2026', dueDateText: '11/09/2026', notes: '', dueBeforeConfirmed: false, rows: [{ key: 'a', qtyText: '1', desc: 'X', unitText: '10' }, { key: 'b', qtyText: '', desc: '', unitText: '' }] };
    expect(computeIssues(s, now)).toEqual([]);
  });
});

describe('商家别名匹配', () => {
  const ms = [
    { id: '1', name: 'A\'Gold Acessórios', aliases: ['AGOLD', '黄筹'], active: true },
    { id: '2', name: 'Kaidi', aliases: [], active: false },
  ];
  it('匹配名称与别名', () => {
    expect(matchMerchant('agold', ms)?.id).toBe('1');
    expect(matchMerchant('黄筹', ms)?.id).toBe('1');
    expect(matchMerchant('Kaidi', ms)).toBeNull();
    expect(matchMerchant(null, ms)).toBeNull();
  });
});

describe('本地 OCR 行重建', () => {
  const w = (text: string, x0: number, y0: number, conf = 90): Word => ({ text, confidence: conf, x0, y0, x1: x0 + 40, y1: y0 + 20 });
  it('按纵坐标聚行并从左到右解析', () => {
    const words = [
      w('240', 400, 102), w('30', 10, 100), w('FN-A78', 80, 98), w('8', 300, 101),
      w('5', 10, 140), w('CA31-3', 80, 141), w('15', 300, 139), w('75', 400, 140),
      w('TOTAL', 250, 200), w('315', 400, 201),
      w('3', 10, 240), w('12', 200, 240), w('abc', 250, 240), w('36', 400, 240),
    ];
    const lines = groupLines(words);
    expect(lines.length).toBe(4);
    const out = wordsToModelOutput(words, 500, 300);
    expect(out.items.map((i) => [i.quantity, i.description, i.unitPriceCents, i.printedSubtotalCents])).toEqual([
      [30, 'FN-A78', 800, 24000],
      [5, 'CA31-3', 1500, 7500],
    ]);
    expect(out.printedTotalRaw).toBe('315');
    expect(out.unparsedLines).toEqual(['3 12 abc 36']);
  });
  it('解析行规则', () => {
    expect(parseItemLine(['2', 'Garrafa', 'Inox', '1.234,50', '2.469,00'])).toMatchObject({ quantity: 2, description: 'Garrafa Inox', unitPriceCents: 123450, printedSubtotalCents: 246900 });
    expect(parseItemLine(['X', 'FN', '8'])).toBeNull();
    expect(parseItemLine(['2', '8'])).toBeNull();
  });
});

import { computeIssues as ci2 } from '../src/lib/ocr/protocol';
describe('两位年份离今年很远', () => {
  it('同时给出「按今年」', () => {
    const st: any = { merchantId: null, merchantName: 'X', accountId: null, accountLabel: '', orderNumber: '', billDateText: '22/9/22', dueDateText: '22/10/2026', reminderDays: '3', notes: '', rows: [{ key: 'a', qtyText: '1', desc: 'x', unitText: '10' }], dueBeforeConfirmed: false };
    const i = ci2(st, new Date('2026-10-09T12:00:00Z')).find((x) => x.id === 'billDate:yy')!;
    expect(i.fix?.value).toBe('2022-09-22');
    expect(i.fix2?.value).toBe('2026-09-22');
    expect(i.message).toContain('离现在较远');
  });
});
