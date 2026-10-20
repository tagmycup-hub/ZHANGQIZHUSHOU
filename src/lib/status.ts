import type { Bill, BillStatus } from './types';
import { diffDays } from './dates';
import { openCents, paidCents as paidOf } from './payments';

export function billStatus(bill: Pick<Bill, 'paidAt' | 'dueDate'>, today: string, dueSoonDays = 7): BillStatus {
  if (bill.paidAt) return 'paid';
  const left = diffDays(today, bill.dueDate);
  if (left < 0) return 'overdue';
  if (left <= dueSoonDays) return 'dueSoon';
  return 'open';
}

export const STATUS_LABEL: Record<BillStatus, string> = {
  open: '未到期',
  dueSoon: '即将到期',
  overdue: '已逾期',
  paid: '已付款',
};

export const STATUS_ICON: Record<BillStatus, string> = {
  open: '○',
  dueSoon: '◔',
  overdue: '!',
  paid: '✓',
};

/** 是否处于提醒窗口（提前 reminderDays 天起，或已逾期） */
export function inReminderWindow(bill: Pick<Bill, 'paidAt' | 'dueDate' | 'reminderDays'>, today: string): boolean {
  if (bill.paidAt) return false;
  return diffDays(today, bill.dueDate) <= bill.reminderDays;
}

/** 通知去重签名：日期 + 账单 + 到期日 + 状态 */
export function notifySignature(bill: Pick<Bill, 'id' | 'dueDate' | 'paidAt'>, today: string, status: BillStatus): string {
  return `${today}|${bill.id}|${bill.dueDate}|${status}`;
}

export interface Summary {
  unpaidCents: number;
  unpaidCount: number;
  overdueCents: number;
  overdueCount: number;
  dueSoonCents: number;
  dueSoonCount: number;
  paidCents: number;
  paidCount: number;
  next: Bill | null;
}

export function summarize(bills: Bill[], today: string, dueSoonDays = 7): Summary {
  const s: Summary = { unpaidCents: 0, unpaidCount: 0, overdueCents: 0, overdueCount: 0, dueSoonCents: 0, dueSoonCount: 0, paidCents: 0, paidCount: 0, next: null };
  for (const b of bills) {
    const st = billStatus(b, today, dueSoonDays);
    if (st === 'paid') {
      s.paidCents += b.totalCents;
      s.paidCount++;
      continue;
    }
    const open = openCents(b);
    s.paidCents += paidOf(b); // 部分付款也算已付出去的钱
    s.unpaidCents += open;
    s.unpaidCount++;
    if (st === 'overdue') {
      s.overdueCents += open;
      s.overdueCount++;
    } else if (st === 'dueSoon') {
      s.dueSoonCents += open;
      s.dueSoonCount++;
    }
    if (!s.next || b.dueDate < s.next.dueDate || (b.dueDate === s.next.dueDate && b.totalCents > s.next.totalCents)) s.next = b;
  }
  return s;
}
