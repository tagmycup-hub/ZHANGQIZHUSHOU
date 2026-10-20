import { describe, it, expect } from 'vitest';
import { groupByDay, groupByMerchant, groupByWeek, groupUnpaidCards, groupUnpaid, groupPaid, groupMixed } from '../src/lib/groups';
import type { Bill } from '../src/lib/types';

const b = (id: string, due: string, cents = 100, paidAt: string | null = null) => ({ id, dueDate: due, totalCents: cents, paidAt }) as Bill;

describe('账单分组', () => {
  const today = '2026-09-16';
  it('未付按紧急程度分组，组内按到期日排序，带小计', () => {
    const g = groupUnpaid([b('l', '2026-11-02'), b('t', '2026-09-16', 50), b('o2', '2026-09-10'), b('o1', '2026-09-01'), b('w', '2026-09-20'), b('m', '2026-09-28'), b('tm', '2026-09-17')], today);
    expect(g.map((x) => x.label)).toEqual(['已逾期', '今天到期', '明天到期', '7 天内', '本月稍后', '2026年11月']);
    expect(g[0].bills.map((x) => x.id)).toEqual(['o1', 'o2']);
    expect(g[0].total).toBe(200);
    expect(g[1].tone).toBe('today');
  });
  it('已付按付款月份倒序（圣保罗时区）', () => {
    const g = groupPaid([b('a', '2026-08-01', 1, '2026-08-05T12:00:00Z'), b('c', '2026-09-01', 1, '2026-09-01T02:00:00Z'), b('d', '2026-09-02', 1, '2026-09-03T12:00:00Z')]);
    expect(g.map((x) => x.label)).toEqual(['2026年9月 付款', '2026年8月 付款']);
    expect(g[0].bills.map((x) => x.id)).toEqual(['d']);
    expect(g[1].bills.map((x) => x.id)).toEqual(['c', 'a']); // 9/1 02:00 UTC = 8/31 圣保罗
  });
  it('混合：未付在前', () => {
    const g = groupMixed([b('p', '2026-09-01', 1, '2026-09-02T12:00:00Z'), b('u', '2026-09-30')], today);
    expect(g.map((x) => x.tone)).toEqual(['later', 'paid']);
  });
  it('按天分组：全部已付的日子标绿，未付排前面', () => {
    const g = groupByDay([b('x', '2026-09-20', 5, '2026-09-10T12:00:00Z'), b('y', '2026-09-20', 1), b('z', '2026-09-10', 3, '2026-09-10T12:00:00Z')], today, (d) => d);
    expect(g.map((x) => [x.label, x.tone])).toEqual([['2026-09-10', 'paid'], ['2026-09-20', 'soon']]);
    expect(g[1].bills.map((x) => x.id)).toEqual(['y', 'x']);
  });
  it('卡片式日期分组只有 4 类', () => {
    const g = groupUnpaidCards([b('o', '2026-09-01'), b('t', '2026-09-16'), b('w', '2026-09-22'), b('m', '2026-09-29'), b('n', '2026-10-05'), b('d', '2027-01-05')], today);
    expect(g.map((x) => x.key)).toEqual(['overdue', 'soon', 'month', 'later']);
    expect(g[1].sub).toBe('今天 1 笔');
    expect(g[3].bills.length).toBe(2);
  });
  it('按商家归类：有逾期的商家排最前，合计只算未付', () => {
    const mk = (id: string, m: string, due: string, cents: number, paid: string | null = null) => ({ ...b(id, due, cents, paid), merchantId: m, merchantNameSnapshot: m, items: [] }) as unknown as Bill;
    const g = groupByMerchant([mk('a1', 'A', '2026-09-30', 100), mk('b1', 'B', '2026-09-10', 50), mk('b2', 'B', '2026-09-20', 70), mk('b3', 'B', '2026-09-01', 999, '2026-09-02T12:00:00Z')], today);
    expect(g.map((x) => x.label)).toEqual(['B', 'A']);
    expect(g[0].tone).toBe('overdue');
    expect(g[0].total).toBe(120);
    expect(g[0].sameTitle).toBe(true);
  });
  it('月历按周分卡', () => {
    const g = groupByWeek([b('x', '2026-09-03'), b('y', '2026-09-30'), b('z', '2026-09-29')], today);
    expect(g.map((x) => x.label)).toEqual(['9月 1 日–7 日', '9月 29 日–月底']);
  });
});
