/** 对账单：把识别出的多笔欠款转成账单（查重、按商家账期算到期日、按付款记录标记已付） */
import type { Bill, Merchant, PaymentAccount } from './types';
import type { StatementInfo } from './ocr/protocol';
import { addDays, parseBRDate } from './dates';
import { computeDueDates } from './terms';
import { recompute } from './bill';
import { findDuplicate } from './importTable';
import { TOTAL_ONLY_DESC } from './ocr/protocol';

export interface StatementRow {
  key: string;
  date: string | null;
  orderNumber: string;
  cents: number | null;
  paid: boolean;
  paidDate: string | null;
  dueDate: string | null;
  duplicateOf: Bill | null;
  include: boolean;
  problem: string | null;
}

export function planStatement(st: StatementInfo, o: { merchant: Merchant | null; merchantName: string; termDays: number; bills: Bill[]; today: string; key: () => string }): StatementRow[] {
  const used = new Set<number>();
  return st.entries.map((e) => {
    const pd = e.dateRaw ? parseBRDate(e.dateRaw) : null;
    const cand = pd?.candidate && Math.abs(Number(pd.candidate.slice(0, 4)) - Number(o.today.slice(0, 4))) <= 1 ? pd.candidate : null;
    const date = e.date ?? pd?.iso ?? cand ?? null;
    let paid = e.paid === true;
    let paidDate: string | null = null;
    // 付款记录里金额相同的一笔视为付了这一单
    const pi = st.payments.findIndex((p, i) => !used.has(i) && p.cents !== null && p.cents === e.cents);
    if (pi >= 0 && e.paid !== false) {
      used.add(pi);
      paid = true;
      paidDate = st.payments[pi].date;
    }
    if (paid && !paidDate) paidDate = date;
    const due = date ? (o.merchant?.term ? computeDueDates(o.merchant.term, date)[0] ?? addDays(date, o.termDays) : addDays(date, o.termDays)) : null;
    const problem = !e.cents ? '金额没有识别出来' : !date ? '日期没有识别出来' : null;
    const probe = { merchantId: o.merchant?.id ?? null, merchantNameSnapshot: o.merchant?.name ?? o.merchantName, orderNumber: e.orderNumber ?? '', dueDate: due ?? '', totalCents: e.cents ?? 0 };
    const dup = e.cents && due ? findDuplicate(o.bills, probe) : null;
    return { key: o.key(), date, orderNumber: e.orderNumber ?? '', cents: e.cents, paid, paidDate, dueDate: due, duplicateOf: dup, include: !problem && !dup, problem };
  });
}

export function statementBills(rows: StatementRow[], o: { merchant: Merchant | null; merchantName: string; account: PaymentAccount | null; reminderDays: number; now: string; key: () => string }): Bill[] {
  return rows
    .filter((r) => r.include && r.cents && r.date && r.dueDate)
    .map((r) =>
      recompute({
        id: o.key(),
        merchantId: o.merchant?.id ?? null,
        merchantNameSnapshot: o.merchant?.name ?? o.merchantName,
        orderNumber: r.orderNumber,
        billDate: r.date!,
        dueDate: r.dueDate! < r.date! ? r.date! : r.dueDate!,
        accountId: o.account?.id ?? null,
        accountLabelSnapshot: o.account?.label ?? '',
        reminderDays: o.reminderDays,
        paidAt: r.paid ? new Date(`${r.paidDate ?? r.date}T15:00:00.000Z`).toISOString() : null,
        payments: r.paid ? [{ id: o.key(), date: r.paidDate ?? r.date!, cents: r.cents! }] : [],
        notes: '来自对账单识别',
        items: [{ id: o.key(), quantity: 1, description: TOTAL_ONLY_DESC, unitPriceCents: r.cents!, subtotalCents: r.cents! }],
        totalCents: r.cents!,
        amountMode: 'total',
        ocrReview: null,
        createdAt: o.now,
        updatedAt: o.now,
        schemaVersion: 1,
      } as Bill),
    );
}
