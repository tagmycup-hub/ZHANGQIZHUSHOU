import { describe, it, expect } from 'vitest';
import { computeDueDates, describeTerm, parseInstallmentDays, validateTerm, splitCents, buildInstallmentBills } from '../src/lib/terms';
import { nextRecurring, needsNextRecurring, billTitle, describePaymentCode, categoryLabel } from '../src/lib/expense';
import { recompute, validateBill } from '../src/lib/bill';
import { sumCents } from '../src/lib/money';
import type { Bill } from '../src/lib/types';

describe('商家固定账期', () => {
  it('开单后 N 天', () => {
    expect(computeDueDates({ kind: 'days', days: 30 }, '2026-09-16')).toEqual(['2026-10-16']);
    expect(computeDueDates({ kind: 'days', days: 0 }, '2026-09-16')).toEqual(['2026-09-16']);
  });
  it('次月固定日，月末截断', () => {
    expect(computeDueDates({ kind: 'monthDay', day: 10, monthOffset: 1 }, '2026-09-16')).toEqual(['2026-10-10']);
    expect(computeDueDates({ kind: 'monthDay', day: 31, monthOffset: 1 }, '2026-01-20')).toEqual(['2026-02-28']);
    expect(computeDueDates({ kind: 'monthDay', day: 5, monthOffset: 1 }, '2026-12-03')).toEqual(['2027-01-05']);
  });
  it('当月固定日已过则顺延到下月', () => {
    expect(computeDueDates({ kind: 'monthDay', day: 20, monthOffset: 0 }, '2026-09-16')).toEqual(['2026-09-20']);
    expect(computeDueDates({ kind: 'monthDay', day: 10, monthOffset: 0 }, '2026-09-16')).toEqual(['2026-10-10']);
  });
  it('截单日：超过截单日再推一个月', () => {
    const r = { kind: 'monthDay' as const, day: 10, monthOffset: 1, cutoffDay: 25 };
    expect(computeDueDates(r, '2026-09-25')).toEqual(['2026-10-10']);
    expect(computeDueDates(r, '2026-09-26')).toEqual(['2026-11-10']);
  });
  it('分期 30/60/90', () => {
    expect(computeDueDates({ kind: 'installments', days: [30, 60, 90] }, '2026-09-16')).toEqual(['2026-10-16', '2026-11-15', '2026-12-15']);
  });
  it('无规则或无效日期返回空', () => {
    expect(computeDueDates(null, '2026-09-16')).toEqual([]);
    expect(computeDueDates({ kind: 'days', days: 30 }, '2026-02-31')).toEqual([]);
  });
  it('描述与校验', () => {
    expect(describeTerm({ kind: 'days', days: 28 })).toBe('开单后 28 天');
    expect(describeTerm({ kind: 'monthDay', day: 10, monthOffset: 1, cutoffDay: 25 })).toBe('次月 10 号（每月 25 号截单）');
    expect(describeTerm({ kind: 'installments', days: [30, 60] })).toBe('分 2 期：30/60 天');
    expect(parseInstallmentDays('30/60/90')).toEqual([30, 60, 90]);
    expect(parseInstallmentDays('30, 60')).toEqual([30, 60]);
    expect(parseInstallmentDays('60/30')).toBeNull();
    expect(parseInstallmentDays('30')).toBeNull();
    expect(validateTerm({ kind: 'monthDay', day: 32, monthOffset: 1 })).toMatch(/1–31/);
    expect(validateTerm({ kind: 'days', days: -1 })).toBeTruthy();
    expect(validateTerm({ kind: 'days', days: 30 })).toBeNull();
  });
});

const base = (): Bill =>
  recompute({
    id: 'b1', merchantId: 'm', merchantNameSnapshot: 'Loja', orderNumber: '77', billDate: '2026-09-16', dueDate: '2026-10-16',
    accountId: null, accountLabelSnapshot: '', reminderDays: 3, paidAt: null, notes: '',
    items: [{ id: 'i1', quantity: 3, description: 'FN-A78', unitPriceCents: 3334, subtotalCents: 0 }],
    totalCents: 0, ocrReview: { provider: 'x' } as any, createdAt: '', updatedAt: '', schemaVersion: 1,
  });

describe('分期拆分', () => {
  it('整数分精确拆分，余数放第一期', () => {
    expect(splitCents(10002, 3)).toEqual([3334, 3334, 3334]);
    expect(splitCents(10000, 3)).toEqual([3334, 3333, 3333]);
    expect(sumCents(splitCents(12345, 7))).toBe(12345);
  });
  it('生成多期账单，总额一致且各自有效', () => {
    let k = 0;
    const bills = buildInstallmentBills(base(), ['2026-10-16', '2026-11-15', '2026-12-15'], () => `k${++k}`);
    expect(bills).toHaveLength(3);
    expect(sumCents(bills.map((b) => b.totalCents))).toBe(10002);
    expect(bills[0].id).toBe('b1');
    expect(new Set(bills.map((b) => b.id)).size).toBe(3);
    expect(bills.map((b) => b.dueDate)).toEqual(['2026-10-16', '2026-11-15', '2026-12-15']);
    expect(bills[1].items[0].description).toBe('第 2/3 期（整单 R$ 100,02）');
    expect(bills[0].ocrReview).toBeTruthy();
    expect(bills[1].ocrReview).toBeNull();
    expect(bills[2].installment).toMatchObject({ index: 3, count: 3, groupTotalCents: 10002 });
    expect(bills[2].installment!.sourceItems![0].description).toBe('FN-A78');
    for (const b of bills) {
      expect(recompute(b).totalCents).toBe(b.totalCents);
      expect(validateBill(b)).toEqual([]);
    }
  });
});

describe('日常缴费', () => {
  const water: Bill = { ...base(), id: 'w1', kind: 'expense', category: 'water', merchantNameSnapshot: 'Sabesp', recurrence: { freq: 'monthly', seriesId: 's1' }, paymentCode: '8261 0000', dueDate: '2026-01-31', billDate: '2026-01-10' };
  it('标题包含分类', () => {
    expect(billTitle(water)).toBe('水费 · Sabesp');
    expect(billTitle({ ...water, merchantNameSnapshot: '水费' })).toBe('水费');
    expect(billTitle({ ...water, kind: 'supplier' })).toBe('Sabesp');
    expect(categoryLabel('tax')).toBe('税费');
    expect(categoryLabel('nope')).toBe('缴费');
  });
  it('每月重复生成下期：日期 +1 月、未付、预估金额、清空付款码', () => {
    const n = nextRecurring({ ...water, paidAt: '2026-01-30T12:00:00Z' }, 'w2', '2026-01-30T12:00:00Z')!;
    expect(n).toMatchObject({ id: 'w2', dueDate: '2026-02-28', billDate: '2026-02-07', paidAt: null, estimated: true, paymentCode: '', ocrReview: null });
    expect(n.recurrence?.seriesId).toBe('s1');
    expect(n.recurrence?.anchorDay).toBe(31);
    // 锚定 31 号：2 月 28 号之后回到 3 月 31 号
    expect(nextRecurring(n, 'w3', '2026-02-28T12:00:00Z')!.dueDate).toBe('2026-03-31');
    expect(n.totalCents).toBe(water.totalCents);
    expect(needsNextRecurring(water, [water])).toBe(true);
    expect(needsNextRecurring(water, [water, n])).toBe(false);
    expect(needsNextRecurring({ ...water, recurrence: null }, [water])).toBe(false);
  });
  it('付款码类型识别', () => {
    expect(describePaymentCode('00020126580014br.gov.bcb.pix')).toBe('PIX 复制码');
    expect(describePaymentCode('8'.repeat(48))).toMatch(/公共缴费/);
    expect(describePaymentCode('2'.repeat(47))).toMatch(/Boleto/);
    expect(describePaymentCode('')).toBe('');
  });
});

import { computeIssues, type EditorState } from '../src/lib/ocr/protocol';
describe('缴费账单校验', () => {
  const s: EditorState = { merchantId: null, merchantName: '', accountId: null, accountLabel: '', orderNumber: '', billDateText: '10/09/2026', dueDateText: '20/09/2026', reminderDays: '3', notes: '', rows: [], dueBeforeConfirmed: false, kind: 'expense', amountMode: 'total', totalText: '189,90' };
  it('缴费单位可空，但必须选分类', () => {
    const now = new Date('2026-09-16T12:00:00Z');
    expect(computeIssues(s, now).map((i) => i.id)).toEqual(['category:empty']);
    expect(computeIssues({ ...s, category: 'power' }, now)).toEqual([]);
    expect(computeIssues({ ...s, kind: 'supplier', category: 'power' }, now).map((i) => i.id)).toEqual(['merchant:empty']);
  });
});

import { nextDueDate, describeRepeat, makeRecurrence, validateRule, presetKey } from '../src/lib/recurrence';
describe('重复周期', () => {
  const b = (rec: any, due = '2026-09-16', bill = '2026-09-10') => ({ ...base(), id: 'r1', dueDate: due, billDate: bill, recurrence: rec }) as Bill;
  it('每周 / 每 2 周 / 每天', () => {
    expect(nextDueDate('2026-09-16', { unit: 'week', every: 1 })).toBe('2026-09-23');
    expect(nextDueDate('2026-09-16', { unit: 'week', every: 2 })).toBe('2026-09-30');
    expect(nextDueDate('2026-09-16', { unit: 'day', every: 10 })).toBe('2026-09-26');
  });
  it('每季度 / 每半年 / 每年，含闰年', () => {
    expect(nextDueDate('2026-11-30', { unit: 'month', every: 3 })).toBe('2027-02-28');
    expect(nextDueDate('2026-09-16', { unit: 'month', every: 6 })).toBe('2027-03-16');
    expect(nextDueDate('2024-02-29', { unit: 'year', every: 1 })).toBe('2025-02-28');
    expect(nextDueDate('2027-02-28', { seriesId: 's', unit: 'year', every: 1, anchorDay: 29 })).toBe('2028-02-29');
  });
  it('旧数据 freq:monthly 兼容', () => {
    expect(nextDueDate('2026-09-16', { seriesId: 's', freq: 'monthly' })).toBe('2026-10-16');
    expect(describeRepeat({ seriesId: 's', freq: 'monthly' })).toBe('每月');
  });
  it('结束日期之后不再生成', () => {
    const rec = makeRecurrence({ unit: 'month', every: 1 }, 's9', '2026-10-15', '2026-09-16');
    expect(nextRecurring(b(rec), 'x', '')).toBeNull();
    expect(needsNextRecurring(b(rec), [])).toBe(false);
    const rec2 = makeRecurrence({ unit: 'month', every: 1 }, 's9', '2026-10-16', '2026-09-16');
    expect(nextRecurring(b(rec2), 'x', '')!.dueDate).toBe('2026-10-16');
    expect(describeRepeat(rec2)).toBe('每月，至 16/10/2026');
  });
  it('系列里已有更晚一期就不重复生成（即使日期被手动改过）', () => {
    const rec = makeRecurrence({ unit: 'week', every: 1 }, 's8', null, '2026-09-16');
    const later = { ...b(rec, '2026-09-25', '2026-09-19'), id: 'r2' };
    expect(needsNextRecurring(b(rec), [later])).toBe(false);
    expect(needsNextRecurring(b(rec), [{ ...later, deletedAt: 'x' }])).toBe(true);
  });
  it('描述、校验、预设识别', () => {
    expect(describeRepeat({ unit: 'week', every: 3 })).toBe('每 3 周');
    expect(describeRepeat({ unit: 'month', every: 3 })).toBe('每季度');
    expect(validateRule({ unit: 'month', every: 0 })).toBeTruthy();
    expect(validateRule({ unit: 'year', every: 11 })).toBeTruthy();
    expect(presetKey({ unit: 'month', every: 6 })).toBe('m6');
    expect(presetKey({ unit: 'day', every: 10 })).toBe('custom');
    expect(presetKey(null)).toBe('none');
  });
});
