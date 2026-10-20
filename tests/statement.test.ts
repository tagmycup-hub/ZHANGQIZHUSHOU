import { describe, it, expect } from 'vitest';
import { planStatement, statementBills } from '../src/lib/statement';
import type { Merchant } from '../src/lib/types';

let n = 0;
const key = () => `s${++n}`;
const m: Merchant = { id: 'm1', name: 'Fornecedor A', aliases: ['KH-3913'], defaultAccountId: null, active: true, term: { kind: 'days', days: 15 }, createdAt: '', updatedAt: '' };
const st = {
  entries: [
    { date: '2026-09-02', dateRaw: '02/09/2026', orderNumber: '2609-0352', cents: 280800, raw: '2,808.00', paid: true },
    { date: '2026-09-28', dateRaw: '28/09/2026', orderNumber: '2609-4449', cents: 352800, raw: '3,528.00', paid: null },
    { date: null, dateRaw: null, orderNumber: null, cents: null, raw: null, paid: null },
  ],
  payments: [{ date: '2026-09-02', cents: 280800, note: 'LILI' }],
  balanceCents: 352800,
};

describe('对账单导入', () => {
  it('按付款记录标已付、按商家账期算到期日、无效行不导入', () => {
    const rows = planStatement(st, { merchant: m, merchantName: m.name, termDays: 30, bills: [], today: '2026-10-09', key });
    expect(rows.map((r) => [r.paid, r.paidDate, r.dueDate, r.include])).toEqual([
      [true, '2026-09-02', '2026-09-17', true],
      [false, null, '2026-10-13', true],
      [false, null, null, false],
    ]);
    const bills = statementBills(rows, { merchant: m, merchantName: m.name, account: null, reminderDays: 3, now: 'now', key });
    expect(bills).toHaveLength(2);
    expect(bills[0].paidAt).toBeTruthy();
    expect(bills[0].payments?.[0].cents).toBe(280800);
    expect(bills[1].paidAt).toBeNull();
    expect(bills[1].totalCents).toBe(352800);
  });
  it('已经录过的单号默认不勾选', () => {
    const existing = statementBills(planStatement(st, { merchant: m, merchantName: m.name, termDays: 30, bills: [], today: '2026-10-09', key }), { merchant: m, merchantName: m.name, account: null, reminderDays: 3, now: 'now', key });
    const rows = planStatement(st, { merchant: m, merchantName: m.name, termDays: 30, bills: existing, today: '2026-10-09', key });
    expect(rows.slice(0, 2).map((r) => [!!r.duplicateOf, r.include])).toEqual([[true, false], [true, false]]);
  });
});
