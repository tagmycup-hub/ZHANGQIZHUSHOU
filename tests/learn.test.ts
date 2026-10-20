import { describe, it, expect } from 'vitest';
import { matchMerchantSmart, normCode, normName, buildCatalog, buildHints, arithmeticFix, applyLearning, learnFromReview } from '../src/lib/ocr/learn';
import { computeIssues, type EditorState, type RowState } from '../src/lib/ocr/protocol';
import type { Bill, Merchant } from '../src/lib/types';

const M = (id: string, name: string, aliases: string[] = [], extra: Partial<Merchant> = {}): Merchant => ({ id, name, aliases, active: true, defaultAccountId: null, createdAt: '', updatedAt: '', ...extra });
const merchants = [M('m1', 'Loja Exemplo Comércio Ltda'), M('m2', 'Brás Embalagens', ['Bras Emb.']), M('m3', '义乌商行'), M('m4', 'Loja Exemplar')];
const bill = (id: string, merchantId: string, date: string, items: [string, number][]): Bill =>
  ({ id, merchantId, merchantNameSnapshot: '', orderNumber: '', billDate: date, dueDate: date, accountId: null, accountLabelSnapshot: '', reminderDays: 3, paidAt: null, notes: '', items: items.map(([d, u], i) => ({ id: `${id}-${i}`, quantity: 1, description: d, unitPriceCents: u, subtotalCents: u })), totalCents: 0, ocrReview: null, createdAt: '', updatedAt: '', schemaVersion: 1 }) as Bill;
const bills = [bill('b1', 'm1', '2026-08-01', [['FN-A78', 800], ['CA31-3', 1500]]), bill('b2', 'm1', '2026-09-01', [['FN-A78', 850], ['FN A76', 800]])];

describe('商家智能匹配', () => {
  it('去重音、去公司后缀后完全相同 → exact', () => {
    const r = matchMerchantSmart('LOJA EXEMPLO COMERCIO LTDA.', [], merchants);
    expect(r?.merchant.id).toBe('m1');
    expect(r?.how).toBe('exact');
    expect(normName('Brás Embalagens LTDA - ME')).toBe('bras embalagens');
  });
  it('别名、包含关系、中文名', () => {
    expect(matchMerchantSmart('bras emb', [], merchants)?.how).toBe('alias');
    expect(matchMerchantSmart('BRAS EMBALAGENS E PRESENTES', [], merchants)?.merchant.id).toBe('m2');
    expect(matchMerchantSmart('义乌商行', [], merchants)?.merchant.id).toBe('m3');
  });
  it('手写错一两个字母仍能匹配；两个商家都很像时不猜', () => {
    expect(matchMerchantSmart('Bras Embalajens', [], merchants)?.merchant.id).toBe('m2');
    // "Loja Exempl" 同时像 Loja Exemplo 和 Loja Exemplar → 不返回
    expect(matchMerchantSmart('Loja Exempl', [], merchants)).toBeNull();
    expect(matchMerchantSmart('Padaria Central', [], merchants)).toBeNull();
  });
  it('识别名称不认识时用候选名称', () => {
    expect(matchMerchantSmart('???', ['Brás Embalagens'], merchants)?.merchant.id).toBe('m2');
  });
});

describe('型号目录与参考资料', () => {
  it('同一型号不同写法归为一类，记录上次单价', () => {
    expect(normCode('fn a76')).toBe('FN-A76');
    const cat = buildCatalog(bills);
    expect(cat.get('m1')!.get('FN-A78')).toMatchObject({ lastUnitCents: 850, count: 2 });
  });
  it('参考资料包含商家名、别名和常用型号，长度受限', () => {
    const h = buildHints(merchants, bills);
    expect(h).toContain('已有商家');
    expect(h).toContain('Bras Emb.');
    expect(h).toContain('FN-A78（8,50）');
    expect(buildHints(merchants, bills, 60).length).toBeLessThanOrEqual(60);
    expect(buildHints([], [])).toBe('');
  });
});

describe('手写数字误读：改一个数字就对上', () => {
  it('数量 7 被读成 1', () => {
    const r = arithmeticFix('1', '19,00', '133,00');
    expect(r.fix).toEqual({ field: 'qty', value: '7', label: '数量改为 7' });
  });
  it('单价 8 被读成 3；数量和单价都能改对时（两种可能）不给一键修改', () => {
    expect(arithmeticFix('12', '3', '96,00').fix).toMatchObject({ field: 'unit', value: '8' });
    expect(arithmeticFix('30', '3', '240,00').fix).toBeNull();
  });
  it('单价漏小数点', () => {
    expect(arithmeticFix('2', '1900', '38,00').fix).toMatchObject({ field: 'unit', value: '19,00' });
  });
  it('图片小计读错一个数字时给说明；多种改法时不给一键修改', () => {
    expect(arithmeticFix('30', '8', '210,00').subtotalNote).toMatch(/图片小计可能是 240,00/);
    expect(arithmeticFix('10', '10', '999,00').fix).toBeNull();
  });
  it('算术不符的核对提示里带一键修改', () => {
    const s: EditorState = {
      merchantId: 'm1', merchantName: 'Loja', accountId: null, accountLabel: '', orderNumber: '', billDateText: '01/09/2026', dueDateText: '01/10/2026', reminderDays: '3', notes: '', dueBeforeConfirmed: false,
      rows: [{ key: 'r1', qtyText: '1', desc: 'FN-A78', unitText: '19,00', printedSubtotalRaw: '133,00', confidence: 0.9, needsReview: false }],
      ocr: { provider: 'x', merchantRaw: null, merchantConfidence: 1, merchantCandidates: [], orderConfidence: 1, orderRaw: null, billDateRaw: null, billDateConfidence: 1, printedTotalRaw: null, unparsedLines: [], modelWarnings: [], candidate: null },
    };
    const i = computeIssues(s, new Date('2026-09-10T12:00:00Z')).find((x) => x.id.includes(':arith:'))!;
    expect(i.message).toMatch(/数量改为 7就正好对上/);
    expect(i.fix).toMatchObject({ kind: 'setRow', rowField: 'qty', value: '7' });
  });
});

describe('学习：自动更正、免核对、建议', () => {
  const baseState = (rows: Partial<RowState>[]): EditorState => ({
    merchantId: 'm1', merchantName: 'Loja Exemplo Comércio Ltda', accountId: null, accountLabel: '', orderNumber: '', billDateText: '01/10/2026', dueDateText: '31/10/2026', reminderDays: '3', notes: '', dueBeforeConfirmed: false,
    rows: rows.map((r, i) => ({ key: `r${i}`, qtyText: '10', desc: '', unitText: '8,50', confidence: 0.7, needsReview: true, ...r, orig: { qty: r.qtyText ?? '10', desc: r.desc ?? '', unit: r.unitText ?? '8,50' } })),
    ocr: { provider: 'AI', merchantRaw: 'Loja Exemplo', merchantConfidence: 0.6, merchantCandidates: [], orderConfidence: 1, orderRaw: null, billDateRaw: null, billDateConfidence: 1, printedTotalRaw: null, unparsedLines: [], modelWarnings: [], candidate: null, merchantMatch: { how: 'exact', score: 1, via: 'Loja Exemplo' } },
  });
  const merchant = { ...merchants[0], ocrFixes: { 'FN-A7B': 'FN-A78' } };
  it('按以前的修改自动更正；常用型号且小计对得上 → 免逐行核对；商家精确匹配 → 不再问商家', () => {
    const s = baseState([{ desc: 'FN-A7B', printedSubtotalRaw: '85,00' }, { desc: 'CA31-3', unitText: '15,00', printedSubtotalRaw: '150,00' }]);
    const r = applyLearning(s, merchant, buildCatalog(bills));
    expect(r.state.rows[0].desc).toBe('FN-A78');
    expect(r.state.rows[0].learned).toMatch(/按你之前的修改/);
    expect(r.state.rows.every((x) => x.corroborated)).toBe(true);
    expect(r.notes.join()).toMatch(/自动更正 1 处.*2 行/);
    const issues = computeIssues(r.state, new Date('2026-10-02T12:00:00Z'));
    expect(issues.filter((i) => i.level === 'warn')).toEqual([]);
  });
  it('不认识的型号给最接近的常用型号建议（需要点一下）；单价差太多提醒', () => {
    const s = baseState([{ desc: 'CA31-8', printedSubtotalRaw: '85,00' }, { desc: 'CA31-3', unitText: '30,00', qtyText: '1', printedSubtotalRaw: '30,00' }, { desc: 'FN-A87' }]);
    const r = applyLearning(s, { ...merchants[0] }, buildCatalog(bills));
    expect(r.state.rows[0].desc).toBe('CA31-8');
    expect(r.state.rows[0].suggestDesc).toBe('CA31-3');
    // FN-A87 和 FN-A78、FN-A76 一样像 → 不建议
    expect(r.state.rows[2].suggestDesc).toBeUndefined();
    expect(r.state.rows[1].priceNote).toMatch(/上次单价 R\$ 15,00/);
    const issues = computeIssues(r.state, new Date('2026-10-02T12:00:00Z'));
    expect(issues.find((i) => i.id.includes(':suggest:'))?.fix).toMatchObject({ kind: 'setRow', rowField: 'desc', value: 'CA31-3' });
    expect(issues.some((i) => i.id.includes(':price:'))).toBe(true);
  });
  it('相似匹配的商家要确认一次', () => {
    const s = baseState([{ desc: 'FN-A78', printedSubtotalRaw: '85,00' }]);
    s.ocr!.merchantMatch = { how: 'fuzzy', score: 0.84, via: 'Loja Exenplo' };
    expect(computeIssues(s, new Date('2026-10-02T12:00:00Z')).some((i) => i.id.startsWith('merchant:fuzzy'))).toBe(true);
  });
  it('保存时学习：识别名称记为别名，型号修改记为自动更正', () => {
    const s = baseState([{ desc: 'FN-A7B' }]);
    s.rows[0].desc = 'FN-A78';
    s.ocr!.merchantRaw = 'LOJA EXEMPL0 COM';
    const p = learnFromReview(s, merchants[0])!;
    expect(p.aliases).toEqual(['LOJA EXEMPL0 COM']);
    expect(p.ocrFixes).toEqual({ 'FN-A7B': 'FN-A78' });
    // 没有变化时不写
    const s2 = baseState([{ desc: 'FN-A78' }]);
    s2.ocr!.merchantRaw = 'Loja Exemplo Comercio';
    expect(learnFromReview(s2, merchants[0])).toBeNull();
  });
});
