/** 每月流水：按实际付款日期（圣保罗时间）统计支出，支持一笔账单分几次付 */
import type { Bill } from './types';
import { addDays, formatBR, weekdayCN, shiftMonth } from './dates';
import { billTitle, categoryLabel, isExpense } from './expense';
import { centsToInput } from './money';
import { openCents, paymentEvents, paymentsOf, type PaymentEvent } from './payments';

export const paidDay = (b: Bill): string | null => paymentsOf(b).slice(-1)[0]?.date ?? null;
export const paidMonth = (b: Bill): string | null => paidDay(b)?.slice(0, 7) ?? null;

export interface MonthFlow {
  ym: string;
  /** 本月的每一次付款 */
  events: PaymentEvent[];
  paidCents: number;
  supplierCents: number;
  expenseCents: number;
  /** 本月开单（新增账期） */
  billedCents: number;
  billedCount: number;
  /** 本月到期 */
  dueCents: number;
  dueCount: number;
  dueOnTimeCount: number;
}

const sumB = (l: Bill[]) => l.reduce((a, b) => a + b.totalCents, 0);
const sumE = (l: PaymentEvent[]) => l.reduce((a, e) => a + e.cents, 0);

export function monthFlow(bills: Bill[], ym: string): MonthFlow {
  const events = paymentEvents(bills).filter((e) => e.date.slice(0, 7) === ym);
  const billed = bills.filter((b) => b.billDate.slice(0, 7) === ym);
  const due = bills.filter((b) => b.dueDate.slice(0, 7) === ym);
  return {
    ym,
    events,
    paidCents: sumE(events),
    supplierCents: sumE(events.filter((e) => !isExpense(e.bill))),
    expenseCents: sumE(events.filter((e) => isExpense(e.bill))),
    billedCents: sumB(billed),
    billedCount: billed.length,
    dueCents: sumB(due),
    dueCount: due.length,
    dueOnTimeCount: due.filter((b) => b.paidAt && (paidDay(b) ?? '') <= b.dueDate).length,
  };
}

export interface FlowPoint {
  ym: string;
  supplier: number;
  expense: number;
  total: number;
  count: number;
}

/** 截至 endYm 的最近 n 个月付款（按月） */
export function flowSeries(bills: Bill[], endYm: string, n = 12): FlowPoint[] {
  const months = Array.from({ length: n }, (_, i) => shiftMonth(endYm, i - n + 1));
  const map = new Map(months.map((ym) => [ym, { ym, supplier: 0, expense: 0, total: 0, count: 0 }]));
  for (const e of paymentEvents(bills)) {
    const p = map.get(e.date.slice(0, 7));
    if (!p) continue;
    if (isExpense(e.bill)) p.expense += e.cents;
    else p.supplier += e.cents;
    p.total += e.cents;
    p.count++;
  }
  return months.map((ym) => map.get(ym)!);
}

export interface Share {
  key: string;
  label: string;
  cents: number;
  count: number;
  merchantId?: string | null;
  sample?: Bill;
}

export function shareBy(events: PaymentEvent[], by: 'merchant' | 'account' | 'category'): Share[] {
  const map = new Map<string, Share>();
  for (const ev of events) {
    const b = ev.bill;
    let key: string;
    let label: string;
    if (by === 'merchant') {
      key = b.merchantId ?? `n-${billTitle(b)}`;
      label = billTitle(b);
    } else if (by === 'account') {
      key = b.accountId ?? `a-${b.accountLabelSnapshot || '未指定账号'}`;
      label = b.accountLabelSnapshot || '未指定账号';
    } else {
      key = isExpense(b) ? `c-${b.category ?? 'other'}` : 'supplier';
      label = isExpense(b) ? categoryLabel(b.category ?? 'other') : '商家货款';
    }
    const e = map.get(key) ?? { key, label, cents: 0, count: 0, merchantId: by === 'merchant' ? b.merchantId : null, sample: b };
    e.cents += ev.cents;
    e.count++;
    map.set(key, e);
  }
  return [...map.values()].sort((a, b) => b.cents - a.cents);
}

export interface DayLedger {
  date: string;
  label: string;
  total: number;
  events: PaymentEvent[];
}

/** 流水明细：按付款日倒序分组 */
export function ledgerByDay(events: PaymentEvent[]): DayLedger[] {
  const map = new Map<string, DayLedger>();
  for (const e of events) {
    const g = map.get(e.date) ?? { date: e.date, label: `${formatBR(e.date).slice(0, 5)} ${weekdayCN(e.date)}`, total: 0, events: [] };
    g.events.push(e);
    g.total += e.cents;
    map.set(e.date, g);
  }
  return [...map.values()].sort((a, b) => b.date.localeCompare(a.date));
}

/** 导出 CSV（分号分隔、逗号小数，巴西版 Excel 可直接打开） */
export function flowCSV(events: PaymentEvent[]): string {
  const esc = (v: string) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const head = ['付款日期', '商家/缴费单位', '类型', '分类', '单号', '开单日期', '到期日期', '付款账号', '本次付款(R$)', '账单总额(R$)', '状态'];
  const rows = [...events]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((e) => {
      const b = e.bill;
      return [
        formatBR(e.date),
        billTitle(b),
        isExpense(b) ? '日常缴费' : '商家货款',
        isExpense(b) ? categoryLabel(b.category ?? 'other') : '',
        b.orderNumber || '',
        formatBR(b.billDate),
        formatBR(b.dueDate),
        b.accountLabelSnapshot || '',
        centsToInput(e.cents),
        centsToInput(b.totalCents),
        e.cents >= b.totalCents ? '一次付清' : e.settles ? '付清（分次）' : '部分付款',
      ];
    });
  const total = events.reduce((a, e) => a + e.cents, 0);
  rows.push(['合计', '', '', '', '', '', '', '', centsToInput(total), '', '']);
  return '\ufeff' + [head, ...rows].map((r) => r.map((c) => esc(String(c))).join(';')).join('\r\n') + '\r\n';
}

/** 与上月相比的变化（百分比，上月为 0 时返回 null） */
export function changePct(cur: number, prev: number): number | null {
  if (!prev) return null;
  return Math.round(((cur - prev) / prev) * 100);
}

export interface Forecast {
  overdueCents: number;
  overdueCount: number;
  weeks: { from: string; to: string; label: string; cents: number; count: number }[];
  next7: number;
  next30: number;
}

/** 未来现金流：逾期未付 + 未来 n 周按周要付的钱（用还差多少算） */
export function forecast(bills: Bill[], today: string, weeks = 6): Forecast {
  const unpaid = bills.filter((b) => !b.paidAt);
  const open = (b: Bill) => openCents(b);
  const overdue = unpaid.filter((b) => b.dueDate < today);
  const out: Forecast = {
    overdueCents: overdue.reduce((a, b) => a + open(b), 0),
    overdueCount: overdue.length,
    weeks: [],
    next7: 0,
    next30: 0,
  };
  for (let i = 0; i < weeks; i++) {
    const from = addDays(today, i * 7);
    const to = addDays(today, i * 7 + 6);
    const list = unpaid.filter((b) => b.dueDate >= from && b.dueDate <= to);
    out.weeks.push({ from, to, label: i === 0 ? '本周内' : `${formatBR(from).slice(0, 5)}起`, cents: list.reduce((a, b) => a + open(b), 0), count: list.length });
  }
  out.next7 = unpaid.filter((b) => b.dueDate >= today && b.dueDate <= addDays(today, 7)).reduce((a, b) => a + open(b), 0);
  out.next30 = unpaid.filter((b) => b.dueDate >= today && b.dueDate <= addDays(today, 30)).reduce((a, b) => a + open(b), 0);
  return out;
}

/** 账单记录导出（T2）：每笔账单一行，Excel 可直接打开（分号分隔、带 BOM） */
export function billsCSV(bills: Bill[], today: string): string {
  const esc = (v: string) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const head = ['商家/缴费单位', '类型', '分类', '单号', '开单日期', '到期日期', '账单总额(R$)', '已付(R$)', '还差(R$)', '状态', '付清日期', '付款账号', '明细', '备注'];
  const rows = bills
    .filter((b) => !b.deletedAt && !b.id.startsWith('sample'))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .map((b) => {
      const paid = paymentsOf(b).reduce((s, p) => s + p.cents, 0);
      const open = openCents(b);
      const status = b.paidAt ? '已付' : b.dueDate < today ? '逾期' : paid > 0 ? '部分付款' : '未付';
      return [
        billTitle(b),
        isExpense(b) ? '日常缴费' : '商家货款',
        isExpense(b) ? categoryLabel(b.category ?? 'other') : '',
        b.orderNumber || '',
        formatBR(b.billDate),
        formatBR(b.dueDate),
        centsToInput(b.totalCents),
        centsToInput(b.paidAt ? b.totalCents : paid),
        centsToInput(open),
        status,
        b.paidAt ? formatBR(b.paidAt.slice(0, 10)) : '',
        b.accountLabelSnapshot || '',
        b.amountMode === 'total' ? '' : b.items.map((i) => `${i.quantity}×${i.description}@${centsToInput(i.unitPriceCents)}`).join(' | '),
        b.notes || '',
      ];
    });
  return '﻿' + [head, ...rows].map((r) => r.map((c) => esc(String(c))).join(';')).join('\r\n') + '\r\n';
}
