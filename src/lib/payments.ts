/** 分次付款（部分付款）：一笔账单可以分几次付清 */
import type { Bill } from './types';
import { todayISO } from './dates';
import { sumCents } from './money';

export interface Payment {
  id: string;
  /** 付款日期 YYYY-MM-DD（圣保罗） */
  date: string;
  cents: number;
  note?: string;
  /** 付款凭证照片（只存在拍摄的设备上，不同步） */
  receiptImageId?: string | null;
}

/** 付款记录（旧数据只有 paidAt 时，折算成一笔全额付款） */
export function paymentsOf(b: Bill): Payment[] {
  if (b.payments?.length) return [...b.payments].sort((x, y) => x.date.localeCompare(y.date));
  if (b.paidAt) return [{ id: `${b.id}-legacy`, date: todayISO(new Date(b.paidAt)), cents: b.totalCents }];
  return [];
}

export const paidCents = (b: Bill) => sumCents(paymentsOf(b).map((p) => p.cents));
/** 还差多少（不会小于 0） */
export const openCents = (b: Bill) => (b.paidAt ? 0 : Math.max(0, b.totalCents - paidCents(b)));
export const isPartial = (b: Bill) => !b.paidAt && paidCents(b) > 0;
/** 已付比例 0–100 */
export const paidPct = (b: Bill) => (b.totalCents > 0 ? Math.min(100, Math.round((paidCents(b) / b.totalCents) * 100)) : 0);

/** 最后一次付款的时间戳（用于 paidAt） */
function stamp(date: string, now = new Date()): string {
  const t = todayISO(now) === date ? now : new Date(`${date}T15:00:00.000Z`);
  return t.toISOString();
}

/** 记一笔付款；付清时自动标记已付 */
export function withPayment(b: Bill, p: Payment, nowISO: string, now = new Date()): Bill {
  // 金额为 0 的账单：不记 0 元付款，直接标已付
  const payments = [...paymentsOf(b).filter((x) => !x.id.endsWith('-legacy')), ...(p.cents > 0 ? [p] : [])];
  const total = sumCents(payments.map((x) => x.cents));
  const full = total >= b.totalCents;
  return { ...b, payments, paidAt: full ? stamp(p.date, now) : null, updatedAt: nowISO };
}

/** 删除一笔付款记录 */
export function withoutPayment(b: Bill, paymentId: string, nowISO: string): Bill {
  const payments = paymentsOf(b).filter((x) => x.id !== paymentId);
  const total = sumCents(payments.map((x) => x.cents));
  return { ...b, payments, paidAt: total >= b.totalCents && payments.length ? b.paidAt : null, updatedAt: nowISO };
}

/** 清空付款记录（恢复未付） */
export function withoutPayments(b: Bill, nowISO: string): Bill {
  return { ...b, payments: [], paidAt: null, updatedAt: nowISO };
}

export interface PaymentEvent {
  id: string;
  bill: Bill;
  date: string;
  cents: number;
  note?: string;
  /** 这笔账单是否被这次付款付清 */
  settles: boolean;
}

/** 所有付款事件（流水用）：一笔账单分几次付就有几条 */
export function paymentEvents(bills: Bill[]): PaymentEvent[] {
  const out: PaymentEvent[] = [];
  for (const b of bills) {
    const ps = paymentsOf(b);
    ps.forEach((p, i) => out.push({ id: p.id, bill: b, date: p.date, cents: p.cents, note: p.note, settles: i === ps.length - 1 && !!b.paidAt }));
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || b.cents - a.cents);
}

/**
 * 编辑保存时整理付款记录：
 * - 取消「已付款」：清空付款记录；
 * - 新勾选「已付款」：保留已有的部分付款，并把剩余部分记为一笔付款；
 * - 已付清的账单改了付款日期或金额：调整最后一笔付款，保证合计 = 账单金额；
 * - 未付清的账单：保留部分付款（若改小了金额导致已付 ≥ 金额，视为付清）。
 */
export function reconcileOnEdit(prev: Bill | null | undefined, next: Bill, paidAt: string | null, newId: () => string): Bill {
  const old = prev ? paymentsOf(prev).filter((p) => !p.id.endsWith('-legacy')) : [];
  if (!paidAt) {
    if (prev?.paidAt) return { ...next, payments: [], paidAt: null };
    const sum = sumCents(old.map((p) => p.cents));
    if (old.length && sum >= next.totalCents && next.totalCents > 0) return { ...next, payments: old, paidAt: stamp(old[old.length - 1].date) };
    return { ...next, payments: old, paidAt: null };
  }
  const day = todayISO(new Date(paidAt));
  if (prev?.paidAt) {
    // 已付清的账单：只有一笔（或旧数据）时整笔对齐；多笔时调整最后一笔
    if (old.length <= 1) return { ...next, paidAt, payments: next.totalCents > 0 ? [{ ...(old[0] ?? {}), id: old[0]?.id ?? newId(), date: day, cents: next.totalCents }] : [] };
    const head = old.slice(0, -1);
    const rest = next.totalCents - sumCents(head.map((p) => p.cents));
    if (rest <= 0) return { ...next, paidAt, payments: head };
    return { ...next, paidAt, payments: [...head, { ...old[old.length - 1], date: day, cents: rest }] };
  }
  const rest = next.totalCents - sumCents(old.map((p) => p.cents));
  return { ...next, paidAt, payments: rest > 0 ? [...old, { id: newId(), date: day, cents: rest }] : old };
}
