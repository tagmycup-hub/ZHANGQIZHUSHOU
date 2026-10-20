/** 月度账期统计 */
import type { Bill } from './types';
import { billStatus } from './status';
import { sumCents } from './money';
import { openCents, paidCents as paidOf } from './payments';

export interface MonthSummary {
  month: string; // YYYY-MM
  totalCents: number;
  count: number;
  paidCents: number;
  paidCount: number;
  unpaidCents: number;
  unpaidCount: number;
  overdueCents: number;
  overdueCount: number;
}

/** 以到期日所在月份统计（本月要付的钱） */
export function monthSummary(bills: Bill[], month: string, today: string): MonthSummary {
  const list = bills.filter((b) => b.dueDate.slice(0, 7) === month);
  const paid = list.filter((b) => b.paidAt);
  const unpaid = list.filter((b) => !b.paidAt);
  const overdue = unpaid.filter((b) => billStatus(b, today) === 'overdue');
  return {
    month,
    totalCents: sumCents(list.map((b) => b.totalCents)),
    count: list.length,
    paidCents: sumCents([...paid.map((b) => b.totalCents), ...unpaid.map(paidOf)]),
    paidCount: paid.length,
    unpaidCents: sumCents(unpaid.map(openCents)),
    unpaidCount: unpaid.length,
    overdueCents: sumCents(overdue.map(openCents)),
    overdueCount: overdue.length,
  };
}

export interface DayTotal {
  cents: number;
  unpaidCents: number;
  count: number;
  unpaidCount: number;
}

/** 按到期日汇总（用于月历与日期选择器上的提示） */
export function dailyTotals(bills: Bill[], opts: { excludeId?: string } = {}): Map<string, DayTotal> {
  const m = new Map<string, DayTotal>();
  for (const b of bills) {
    if (b.id === opts.excludeId) continue;
    const e = m.get(b.dueDate) ?? { cents: 0, unpaidCents: 0, count: 0, unpaidCount: 0 };
    e.cents += b.totalCents;
    e.count++;
    if (!b.paidAt) {
      e.unpaidCents += openCents(b);
      e.unpaidCount++;
    }
    m.set(b.dueDate, e);
  }
  return m;
}

/** 紧凑金额：R$ 1,2 mil / 850 */
export function compactBRL(cents: number): string {
  const v = cents / 100;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace('.', ',')}M`;
  if (v >= 10_000) return `${Math.round(v / 1000)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1).replace('.', ',')}k`;
  return String(Math.round(v));
}
