/** 账单列表分组：按"什么时候要付"组织，而不是平铺卡片 */
import type { Bill } from './types';
import { diffDays, formatBR, monthLabel, todayISO } from './dates';
import { billTitle } from './expense';
import { openCents } from './payments';

export type GroupTone = 'overdue' | 'today' | 'soon' | 'later' | 'paid' | 'plain';

export interface BillGroup {
  key: string;
  label: string;
  tone: GroupTone;
  bills: Bill[];
  total: number;
  /** 卡片副标题（如"最近 20/09 到期"） */
  sub?: string;
  /** 卡片内按商家分组时，行里不再重复商家名 */
  sameTitle?: boolean;
}

const byDue = (a: Bill, b: Bill) => a.dueDate.localeCompare(b.dueDate) || b.totalCents - a.totalCents;

/** 列表里的金额：未付看还差多少（分次付款时），已付看原金额 */
export const amountOf = (b: Bill) => (b.paidAt ? b.totalCents : openCents(b));

function push(map: Map<string, BillGroup>, key: string, label: string, tone: GroupTone, b: Bill) {
  const g = map.get(key) ?? { key, label, tone, bills: [], total: 0 };
  g.bills.push(b);
  g.total += amountOf(b);
  map.set(key, g);
}

/** 未付：已逾期 / 今天 / 明天 / 7 天内 / 本月稍后 / 之后按月 */
export function groupUnpaid(bills: Bill[], today: string): BillGroup[] {
  const map = new Map<string, BillGroup>();
  const month = today.slice(0, 7);
  for (const b of [...bills].sort(byDue)) {
    const d = diffDays(today, b.dueDate);
    if (d < 0) push(map, 'overdue', '已逾期', 'overdue', b);
    else if (d === 0) push(map, 'today', '今天到期', 'today', b);
    else if (d === 1) push(map, 'tomorrow', '明天到期', 'soon', b);
    else if (d <= 7) push(map, 'week', '7 天内', 'soon', b);
    else if (b.dueDate.slice(0, 7) === month) push(map, 'month', '本月稍后', 'later', b);
    else push(map, `m-${b.dueDate.slice(0, 7)}`, monthLabel(b.dueDate.slice(0, 7)), 'later', b);
  }
  return [...map.values()];
}

/** 已付：按付款月份倒序 */
export function groupPaid(bills: Bill[]): BillGroup[] {
  const map = new Map<string, BillGroup>();
  const sorted = [...bills].sort((a, b) => (b.paidAt ?? '').localeCompare(a.paidAt ?? '') || byDue(a, b));
  for (const b of sorted) {
    const m = b.paidAt ? todayISO(new Date(b.paidAt)).slice(0, 7) : b.dueDate.slice(0, 7);
    push(map, `p-${m}`, `${monthLabel(m)} 付款`, 'paid', b);
  }
  return [...map.values()];
}

/** 混合列表：未付分组在前，已付在后 */
export function groupMixed(bills: Bill[], today: string): BillGroup[] {
  return [...groupUnpaid(bills.filter((b) => !b.paidAt), today), ...groupPaid(bills.filter((b) => b.paidAt))];
}

/** 不分组（按金额排序等） */
export function flatGroup(bills: Bill[], label: string): BillGroup[] {
  return bills.length ? [{ key: 'flat', label, tone: 'plain', bills, total: bills.reduce((s, b) => s + amountOf(b), 0) }] : [];
}

/** 月历视图：按到期日分组，未付在前 */
export function groupByDay(bills: Bill[], today: string, labelOf: (iso: string) => string): BillGroup[] {
  const map = new Map<string, BillGroup>();
  for (const b of [...bills].sort(byDue)) {
    const d = diffDays(today, b.dueDate);
    push(map, `d-${b.dueDate}`, labelOf(b.dueDate), d < 0 ? 'overdue' : d === 0 ? 'today' : d <= 7 ? 'soon' : 'later', b);
  }
  const out = [...map.values()];
  for (const g of out) {
    if (g.bills.every((b) => b.paidAt)) g.tone = 'paid';
    g.bills.sort((a, b) => Number(!!a.paidAt) - Number(!!b.paidAt) || b.totalCents - a.totalCents);
  }
  return out;
}

/** 卡片式：未付只分 4 张卡——已逾期 / 7 天内 / 本月稍后 / 以后 */
export function groupUnpaidCards(bills: Bill[], today: string, soonDays = 7): BillGroup[] {
  const map = new Map<string, BillGroup>();
  const month = today.slice(0, 7);
  for (const b of [...bills].sort(byDue)) {
    const d = diffDays(today, b.dueDate);
    if (d < 0) push(map, 'overdue', '已逾期', 'overdue', b);
    else if (d <= soonDays) push(map, 'soon', `${soonDays} 天内到期`, d === 0 ? 'today' : 'soon', b);
    else if (b.dueDate.slice(0, 7) === month) push(map, 'month', '本月稍后', 'later', b);
    else push(map, 'later', '以后', 'plain', b);
  }
  const order = ['overdue', 'soon', 'month', 'later'];
  const out = order.map((k) => map.get(k)).filter((g): g is BillGroup => !!g);
  for (const g of out) {
    if (g.key === 'soon' && g.bills.some((b) => b.dueDate === today)) g.sub = `今天 ${g.bills.filter((b) => b.dueDate === today).length} 笔`;
    if (g.key === 'later') {
      const last = g.bills[g.bills.length - 1].dueDate;
      g.sub = `至 ${monthLabel(last.slice(0, 7))}`;
    }
  }
  return out;
}

/** 卡片式：按商家/缴费单位归类，最急的商家排前面 */
export function groupByMerchant(bills: Bill[], today: string, soonDays = 7): BillGroup[] {
  const map = new Map<string, BillGroup>();
  for (const b of [...bills].sort(byDue)) {
    const key = b.merchantId ? `m-${b.merchantId}` : `n-${billTitle(b)}`;
    push(map, key, billTitle(b), 'later', b);
  }
  const rank: Record<GroupTone, number> = { overdue: 0, today: 1, soon: 2, later: 3, plain: 4, paid: 5 };
  const out = [...map.values()];
  for (const g of out) {
    g.sameTitle = true;
    const open = g.bills.filter((b) => !b.paidAt);
    if (!open.length) {
      g.tone = 'paid';
      g.sub = `${g.bills.length} 笔已付`;
      continue;
    }
    const first = open[0].dueDate;
    const d = diffDays(today, first);
    g.tone = d < 0 ? 'overdue' : d === 0 ? 'today' : d <= soonDays ? 'soon' : 'later';
    const overdueN = open.filter((b) => b.dueDate < today).length;
    g.sub = overdueN ? `${overdueN} 笔逾期` : `最近 ${formatBR(first).slice(0, 5)} 到期`;
    // 未付金额优先显示
    g.total = open.reduce((s, b) => s + amountOf(b), 0) || g.total;
  }
  const firstOpen = (g: BillGroup) => g.bills.find((b) => !b.paidAt)?.dueDate ?? '9999';
  return out.sort((a, b) => rank[a.tone] - rank[b.tone] || firstOpen(a).localeCompare(firstOpen(b)) || b.total - a.total);
}

/** 月历：按周分卡（1–7 日、8–14 日……），最多 5 张 */
export function groupByWeek(bills: Bill[], today: string): BillGroup[] {
  const map = new Map<string, BillGroup>();
  for (const b of [...bills].sort(byDue)) {
    const day = Number(b.dueDate.slice(8, 10));
    const w = Math.floor((day - 1) / 7);
    const from = w * 7 + 1;
    const to = w === 4 ? '月底' : `${from + 6} 日`;
    push(map, `w-${b.dueDate.slice(0, 7)}-${w}`, `${Number(b.dueDate.slice(5, 7))}月 ${from} 日–${to}`, 'later', b);
  }
  const out = [...map.values()];
  for (const g of out) {
    const open = g.bills.filter((b) => !b.paidAt);
    if (!open.length) g.tone = 'paid';
    else {
      const d = diffDays(today, open[0].dueDate);
      g.tone = d < 0 ? 'overdue' : d <= 7 ? 'soon' : 'later';
    }
    g.bills.sort((a, b) => Number(!!a.paidAt) - Number(!!b.paidAt) || byDue(a, b));
    if (open.length && open.length < g.bills.length) g.sub = `${g.bills.length - open.length} 笔已付`;
  }
  return out;
}
