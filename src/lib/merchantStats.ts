/** 单个商家/缴费单位的对账统计 */
import type { Bill } from './types';
import { diffDays, todayISO } from './dates';
import { openCents, paidCents, paymentsOf } from './payments';

export interface MerchantStats {
  bills: Bill[];
  count: number;
  /** 全部账单金额（含已付） */
  totalCents: number;
  /** 还要付多少 */
  openCents: number;
  openCount: number;
  /** 已付出去多少（含部分付款） */
  paidCents: number;
  /** 最近 12 个月付款 */
  last12Cents: number;
  overdueCount: number;
  /** 平均账期天数（开单 → 到期） */
  avgTermDays: number | null;
  /** 按时付清比例 0–100（已付清的账单里） */
  onTimePct: number | null;
  /** 平均实际付款天数（开单 → 付清） */
  avgPayDays: number | null;
  lastBill: Bill | null;
  nextDue: Bill | null;
}

export function merchantStats(all: Bill[], merchantId: string, today: string): MerchantStats {
  const bills = all.filter((b) => b.merchantId === merchantId).sort((a, b) => b.dueDate.localeCompare(a.dueDate));
  const open = bills.filter((b) => !b.paidAt);
  const settled = bills.filter((b) => b.paidAt);
  const terms = bills.map((b) => diffDays(b.billDate, b.dueDate)).filter((d) => d >= 0);
  const payDays = settled
    .map((b) => {
      const last = paymentsOf(b).slice(-1)[0];
      return last ? diffDays(b.billDate, last.date) : null;
    })
    .filter((d): d is number => d !== null && d >= 0);
  const onTime = settled.filter((b) => (paymentsOf(b).slice(-1)[0]?.date ?? '') <= b.dueDate).length;
  const cutoff = todayISO(new Date(Date.parse(`${today}T12:00:00Z`) - 365 * 86400000));
  const last12 = bills.reduce((a, b) => a + paymentsOf(b).filter((p) => p.date >= cutoff).reduce((x, p) => x + p.cents, 0), 0);
  const avg = (l: number[]) => (l.length ? Math.round(l.reduce((a, x) => a + x, 0) / l.length) : null);
  return {
    bills,
    count: bills.length,
    totalCents: bills.reduce((a, b) => a + b.totalCents, 0),
    openCents: open.reduce((a, b) => a + openCents(b), 0),
    openCount: open.length,
    paidCents: bills.reduce((a, b) => a + paidCents(b), 0),
    last12Cents: last12,
    overdueCount: open.filter((b) => b.dueDate < today).length,
    avgTermDays: avg(terms),
    onTimePct: settled.length ? Math.round((onTime / settled.length) * 100) : null,
    avgPayDays: avg(payDays),
    lastBill: bills[0] ?? null,
    nextDue: [...open].sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0] ?? null,
  };
}

/** 生成给商家的未付清单文字（可直接发 WhatsApp） */
export function unpaidStatement(name: string, bills: Bill[], merchantId: string, today: string): string {
  const open = bills.filter((b) => b.merchantId === merchantId && !b.paidAt).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const fmt = (c: number) => `R$ ${(c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const br = (iso: string) => iso.split('-').reverse().join('/');
  const lines = open.map((b) => {
    const left = openCents(b);
    const partial = left < b.totalCents ? `（已付 ${fmt(b.totalCents - left)}）` : '';
    const late = b.dueDate < today ? ' ⚠ 逾期' : '';
    return `• ${br(b.dueDate)}${late} — ${fmt(left)}${partial}${b.orderNumber ? ` — NF/单号 ${b.orderNumber}` : ''}`;
  });
  const total = open.reduce((a, b) => a + openCents(b), 0);
  return [`${name} — 未付清单（${br(today)}）`, ...lines, `合计：${fmt(total)}（${open.length} 笔）`].join('\n');
}
