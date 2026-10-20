import { describe, it, expect } from 'vitest';
import { monthFlow, flowSeries, shareBy, ledgerByDay, flowCSV, changePct, paidDay, forecast } from '../src/lib/flow';
import type { Bill } from '../src/lib/types';

const b = (id: string, o: Partial<Bill>): Bill =>
  ({ id, merchantId: 'm1', merchantNameSnapshot: 'Loja A', orderNumber: '', billDate: '2026-08-01', dueDate: '2026-09-01', accountId: null, accountLabelSnapshot: 'PIX', reminderDays: 3, paidAt: null, notes: '', items: [], totalCents: 1000, ocrReview: null, createdAt: '', updatedAt: '', schemaVersion: 1, ...o }) as Bill;

const data = [
  b('a', { paidAt: '2026-09-05T15:00:00Z', totalCents: 10000 }),
  b('b', { paidAt: '2026-09-01T02:00:00Z', totalCents: 5000 }), // 圣保罗 31/08
  b('c', { paidAt: '2026-09-20T15:00:00Z', totalCents: 2500, kind: 'expense', category: 'water', merchantId: 'p1', merchantNameSnapshot: 'Sabesp', accountLabelSnapshot: 'Boleto', billDate: '2026-09-02', dueDate: '2026-09-20', orderNumber: 'X;1' }),
  b('d', { totalCents: 7000, billDate: '2026-09-10', dueDate: '2026-09-30' }),
];

describe('每月流水', () => {
  it('按圣保罗付款日期归月', () => {
    expect(paidDay(data[1])).toBe('2026-08-31');
    const f = monthFlow(data, '2026-09');
    expect(f.events.map((x) => x.bill.id)).toEqual(['c', 'a']);
    expect(f.paidCents).toBe(12500);
    expect(f.supplierCents).toBe(10000);
    expect(f.expenseCents).toBe(2500);
    expect(f.billedCount).toBe(2);
    expect(f.billedCents).toBe(9500);
    expect(f.dueCount).toBe(4);
    expect(f.dueOnTimeCount).toBe(2);
  });
  it('12 个月序列（含空月）', () => {
    const s = flowSeries(data, '2026-09', 3);
    expect(s.map((p) => [p.ym, p.total])).toEqual([['2026-07', 0], ['2026-08', 5000], ['2026-09', 12500]]);
    expect(s[2].expense).toBe(2500);
  });
  it('按商家 / 账号 / 分类汇总', () => {
    const paid = monthFlow(data, '2026-09').events;
    expect(shareBy(paid, 'merchant').map((x) => [x.label, x.cents])).toEqual([['Loja A', 10000], ['水费 · Sabesp', 2500]]);
    expect(shareBy(paid, 'account').map((x) => x.label)).toEqual(['PIX', 'Boleto']);
    expect(shareBy(paid, 'category').map((x) => x.label)).toEqual(['商家货款', '水费']);
  });
  it('明细按付款日倒序', () => {
    const g = ledgerByDay(monthFlow(data, '2026-09').events);
    expect(g.map((x) => x.label)).toEqual(['20/09 周日', '05/09 周六']);
  });
  it('CSV：BOM、分号、逗号小数、转义、合计', () => {
    const csv = flowCSV(monthFlow(data, '2026-09').events);
    expect(csv.startsWith('﻿付款日期;')).toBe(true);
    expect(csv).toContain('05/09/2026;Loja A;商家货款;;');
    expect(csv).toContain('"X;1"');
    expect(csv).toContain('合计;;;;;;;;125,00;;');
  });
  it('环比', () => {
    expect(changePct(150, 100)).toBe(50);
    expect(changePct(5, 0)).toBeNull();
  });
  it('分次付款：流水按每次付款计，账单只算还差的部分', () => {
    const part = b('p', { totalCents: 30000, dueDate: '2026-09-25', payments: [{ id: 'p1', date: '2026-09-10', cents: 10000, note: '定金' }] });
    const f = monthFlow([part], '2026-09');
    expect(f.paidCents).toBe(10000);
    expect(f.events[0].settles).toBe(false);
    const fc = forecast([part], '2026-09-16', 2);
    expect(fc.next30).toBe(20000);
    expect(fc.weeks[1].cents).toBe(20000);
    expect(flowCSV(f.events)).toContain('部分付款');
  });
  it('未来现金流：逾期与每周', () => {
    const fc = forecast([b('x', { dueDate: '2026-09-10', totalCents: 500 }), b('y', { dueDate: '2026-09-18', totalCents: 700 })], '2026-09-16', 2);
    expect([fc.overdueCents, fc.overdueCount]).toEqual([500, 1]);
    expect(fc.weeks[0].cents).toBe(700);
    expect(fc.next7).toBe(700);
  });
});
