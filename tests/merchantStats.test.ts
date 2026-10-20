import { describe, it, expect } from 'vitest';
import { merchantStats } from '../src/lib/merchantStats';
import type { Bill } from '../src/lib/types';

const b = (id: string, o: Partial<Bill>): Bill =>
  ({ id, merchantId: 'm1', merchantNameSnapshot: 'Loja', orderNumber: id, billDate: '2026-08-01', dueDate: '2026-08-31', accountId: null, accountLabelSnapshot: '', reminderDays: 3, paidAt: null, notes: '', items: [], totalCents: 10000, ocrReview: null, createdAt: '', updatedAt: '', schemaVersion: 1, ...o }) as Bill;

describe('商家对账统计', () => {
  const all = [
    b('1', { billDate: '2026-07-01', dueDate: '2026-07-31', paidAt: '2026-07-30T15:00:00Z', payments: [{ id: 'p', date: '2026-07-30', cents: 10000 }] }),
    b('2', { billDate: '2026-08-01', dueDate: '2026-08-31', paidAt: '2026-09-05T15:00:00Z', payments: [{ id: 'q', date: '2026-09-05', cents: 10000 }] }),
    b('3', { billDate: '2026-09-01', dueDate: '2026-10-01', totalCents: 20000, payments: [{ id: 'r', date: '2026-09-10', cents: 5000 }] }),
    b('4', { merchantId: 'other' }),
  ];
  const s = merchantStats(all, 'm1', '2026-09-16');
  it('只算这个商家，未付按还差多少', () => {
    expect(s.count).toBe(3);
    expect(s.openCents).toBe(15000);
    expect(s.openCount).toBe(1);
    expect(s.paidCents).toBe(25000);
    expect(s.totalCents).toBe(40000);
  });
  it('平均账期、准时率、平均付款天数', () => {
    expect(s.avgTermDays).toBe(30); // 30, 30, 30
    expect(s.onTimePct).toBe(50); // 2 笔付清，1 笔按时
    expect(s.avgPayDays).toBe(32); // 29 天、35 天
    expect(s.nextDue?.id).toBe('3');
    expect(s.lastBill?.id).toBe('3');
  });
});

import { unpaidStatement } from '../src/lib/merchantStats';
describe('未付清单文字', () => {
  const bills = [
    b('1', { dueDate: '2026-09-10', totalCents: 20000, orderNumber: 'A1' }),
    b('2', { dueDate: '2026-09-30', totalCents: 50000, payments: [{ id: 'p', date: '2026-09-01', cents: 20000 }] }),
    b('3', { dueDate: '2026-09-05', paidAt: '2026-09-04T12:00:00Z' }),
  ];
  it('只列未付，标出逾期、已付部分与合计', () => {
    const t = unpaidStatement('Loja A', bills, 'm1', '2026-09-16');
    expect(t).toContain('Loja A — 未付清单（16/09/2026）');
    expect(t).toContain('• 10/09/2026 ⚠ 逾期 — R$ 200,00 — NF/单号 A1');
    expect(t).toContain('• 30/09/2026 — R$ 300,00（已付 R$ 200,00）');
    expect(t).toContain('合计：R$ 500,00（2 笔）');
  });
});
