import { describe, it, expect } from 'vitest';
import { paymentsOf, paidCents, openCents, isPartial, withPayment, withoutPayment, withoutPayments, paymentEvents, paidPct } from '../src/lib/payments';
import { amountOf } from '../src/lib/groups';
import { summarize } from '../src/lib/status';
import { monthSummary } from '../src/lib/monthly';
import { billEvent } from '../src/lib/ics';
import type { Bill } from '../src/lib/types';

const b = (o: Partial<Bill> = {}): Bill =>
  ({ id: 'b1', merchantId: 'm', merchantNameSnapshot: 'Loja', orderNumber: '1', billDate: '2026-09-01', dueDate: '2026-09-20', accountId: null, accountLabelSnapshot: 'PIX', reminderDays: 3, paidAt: null, notes: '', items: [], totalCents: 100000, ocrReview: null, createdAt: '', updatedAt: '2026-09-01T00:00:00.000Z', schemaVersion: 1, ...o }) as Bill;

describe('分次付款', () => {
  it('旧数据（只有 paidAt）折算成一次全额付款', () => {
    const old = b({ paidAt: '2026-09-15T15:00:00Z' });
    expect(paymentsOf(old)).toEqual([{ id: 'b1-legacy', date: '2026-09-15', cents: 100000 }]);
    expect(openCents(old)).toBe(0);
  });
  it('记一笔部分付款：未付清，剩余可算', () => {
    const p1 = withPayment(b(), { id: 'x', date: '2026-09-10', cents: 30000 }, 'now');
    expect(p1.paidAt).toBeNull();
    expect(paidCents(p1)).toBe(30000);
    expect(openCents(p1)).toBe(70000);
    expect(isPartial(p1)).toBe(true);
    expect(paidPct(p1)).toBe(30);
    expect(amountOf(p1)).toBe(70000);
    const p2 = withPayment(p1, { id: 'y', date: '2026-09-18', cents: 70000 }, 'now', new Date('2026-09-18T12:00:00Z'));
    expect(p2.paidAt).toBeTruthy();
    expect(openCents(p2)).toBe(0);
    expect(amountOf(p2)).toBe(100000);
  });
  it('删除付款记录会恢复未付状态', () => {
    const paid = withPayment(b(), { id: 'x', date: '2026-09-10', cents: 100000 }, 'now');
    expect(paid.paidAt).toBeTruthy();
    const undone = withoutPayment(paid, 'x', 'now2');
    expect(undone.paidAt).toBeNull();
    expect(openCents(undone)).toBe(100000);
    expect(withoutPayments(paid, 'now3').payments).toEqual([]);
  });
  it('统计只算还差的钱，已付部分计入已付', () => {
    const part = withPayment(b(), { id: 'x', date: '2026-09-10', cents: 40000 }, 'now');
    const s = summarize([part], '2026-09-16', 7);
    expect(s.unpaidCents).toBe(60000);
    expect(s.paidCents).toBe(40000);
    const m = monthSummary([part], '2026-09', '2026-09-16');
    expect([m.totalCents, m.paidCents, m.unpaidCents]).toEqual([100000, 40000, 60000]);
  });
  it('日历事件写尾款金额', () => {
    const part = withPayment(b(), { id: 'x', date: '2026-09-10', cents: 40000 }, 'now');
    const ics = billEvent(part).join('\n').replace(/\\,/g, ',');
    expect(ics).toContain('R$ 600,00（尾款）');
    expect(ics).toContain('已付：R$ 400,00，还差 R$ 600,00');
  });
  it('付款事件按日期倒序，能标出哪次付清', () => {
    const p = withPayment(withPayment(b(), { id: 'x', date: '2026-09-10', cents: 40000 }, 'n'), { id: 'y', date: '2026-09-20', cents: 60000 }, 'n');
    const ev = paymentEvents([p]);
    expect(ev.map((e) => [e.date, e.cents, e.settles])).toEqual([['2026-09-20', 60000, true], ['2026-09-10', 40000, false]]);
  });
});

import { reconcileOnEdit } from '../src/lib/payments';
import { nextRecurring } from '../src/lib/recurrence';
describe('编辑与重复账单不丢付款记录', () => {
  let k = 0;
  const id = () => `n${++k}`;
  const part = withPayment(b(), { id: 'x', date: '2026-09-10', cents: 30000, note: '定金' }, 'now');
  it('编辑未付清的账单：保留部分付款', () => {
    const r = reconcileOnEdit(part, { ...part, notes: '改备注', payments: undefined }, null, id);
    expect(r.payments).toEqual(part.payments);
    expect(openCents(r)).toBe(70000);
  });
  it('把金额改小到已付以下：视为付清', () => {
    const r = reconcileOnEdit(part, { ...part, totalCents: 30000, payments: undefined }, null, id);
    expect(r.paidAt).toBeTruthy();
  });
  it('勾选已付款：剩余部分记为一笔付款', () => {
    const r = reconcileOnEdit(part, { ...part, payments: undefined }, '2026-09-20T15:00:00.000Z', id);
    expect(r.payments!.map((p) => [p.date, p.cents])).toEqual([['2026-09-10', 30000], ['2026-09-20', 70000]]);
  });
  it('取消已付款：清空付款记录', () => {
    const paid = withPayment(part, { id: 'y', date: '2026-09-20', cents: 70000 }, 'now');
    const r = reconcileOnEdit(paid, { ...paid, payments: undefined }, null, id);
    expect(r.payments).toEqual([]);
    expect(r.paidAt).toBeNull();
  });
  it('已付清的账单改付款日期：最后一笔跟着改', () => {
    const paid = withPayment(part, { id: 'y', date: '2026-09-20', cents: 70000 }, 'now');
    const r = reconcileOnEdit(paid, { ...paid, payments: undefined }, '2026-09-22T15:00:00.000Z', id);
    expect(r.payments!.map((p) => [p.date, p.cents])).toEqual([['2026-09-10', 30000], ['2026-09-22', 70000]]);
  });
  it('重复账单的下一期不继承付款记录', () => {
    const rec = withPayment({ ...b(), recurrence: { seriesId: 's', unit: 'month', every: 1 } }, { id: 'z', date: '2026-09-20', cents: 100000 }, 'now');
    const n = nextRecurring(rec, 'next', 'now')!;
    expect(n.payments).toEqual([]);
    expect(openCents(n)).toBe(100000);
  });
});

import { makeRecurrence, nextRecurring as nr2 } from '../src/lib/recurrence';
import { buildInstallmentBills } from '../src/lib/terms';
describe('检查修复', () => {
  it('0 元账单标已付不记 0 元付款', () => {
    const z = withPayment(b({ totalCents: 0 }), { id: 'z', date: '2026-09-10', cents: 0 }, 'n');
    expect(z.paidAt).toBeTruthy();
    expect(z.payments).toEqual([]);
  });
  it('保存已付账单保留付款凭证', () => {
    const paid = withPayment(b(), { id: 'x', date: '2026-09-10', cents: 100000, receiptImageId: 'img1' }, 'n');
    const r = reconcileOnEdit(paid, { ...paid, notes: 'x', payments: undefined }, paid.paidAt, () => 'k');
    expect(r.payments![0].receiptImageId).toBe('img1');
  });
  it('31 号的重复账单编辑 2 月那期后仍对齐 31 号', () => {
    const jan = { ...b({ dueDate: '2026-01-31', billDate: '2026-01-01' }), recurrence: makeRecurrence({ unit: 'month', every: 1 }, 's', null, '2026-01-31') };
    const feb = nr2(jan, 'feb', 'n')!;
    expect(feb.dueDate).toBe('2026-02-28');
    const rec = makeRecurrence({ unit: 'month', every: 1 }, 's', null, feb.dueDate, feb);
    const mar = nr2({ ...feb, recurrence: rec }, 'mar', 'n')!;
    expect(mar.dueDate).toBe('2026-03-31');
  });
  it('分期账单不带重复规则', () => {
    const base = { ...b(), recurrence: { seriesId: 's', unit: 'month' as const, every: 1 } };
    const parts = buildInstallmentBills(base as any, ['2026-10-01', '2026-11-01'], (() => { let i = 0; return () => `p${++i}`; })());
    expect(parts.every((p: any) => p.recurrence === null)).toBe(true);
  });
});
