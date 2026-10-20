import type { Bill, Item } from './types';
import { SCHEMA_VERSION } from './types';
import { isValidISO, diffDays } from './dates';
import { lineSubtotalCents, sumCents } from './money';

export const NOTES_MAX = 1000;

export function isValidItem(i: Partial<Item>): boolean {
  return (
    typeof i.quantity === 'number' && Number.isFinite(i.quantity) && i.quantity > 0 &&
    typeof i.unitPriceCents === 'number' && Number.isInteger(i.unitPriceCents) && i.unitPriceCents >= 0 &&
    typeof i.description === 'string' && i.description.trim().length > 0
  );
}

/** 重新计算小计与总额；总额只来自有效明细 */
export function recompute<T extends Pick<Bill, 'items'>>(bill: T): T & { totalCents: number } {
  const items = bill.items.map((i) => (isValidItem(i) ? { ...i, subtotalCents: lineSubtotalCents(i.quantity, i.unitPriceCents) } : i));
  const total = sumCents(items.filter(isValidItem).map((i) => i.subtotalCents));
  return { ...bill, items, totalCents: total };
}

export interface ValidationIssue {
  field: string;
  message: string;
  /** 可通过确认解除 */
  confirmable?: boolean;
}

export function validateBill(b: Partial<Bill>): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  if (!b.merchantNameSnapshot?.trim()) out.push({ field: 'merchant', message: '请选择或新增商家' });
  if (!isValidISO(b.billDate)) out.push({ field: 'billDate', message: '账单日期无效' });
  if (!isValidISO(b.dueDate)) out.push({ field: 'dueDate', message: '到期日期无效' });
  if (isValidISO(b.billDate) && isValidISO(b.dueDate) && diffDays(b.billDate!, b.dueDate!) < 0 && !b.dueBeforeBillConfirmed) {
    out.push({ field: 'dueDate', message: '到期日早于账单日，请确认是否正确', confirmable: true });
  }
  if (typeof b.reminderDays !== 'number' || !Number.isInteger(b.reminderDays) || b.reminderDays < 0 || b.reminderDays > 60) {
    out.push({ field: 'reminderDays', message: '提醒天数应为 0–60 的整数' });
  }
  const items = b.items ?? [];
  if (!items.some(isValidItem)) out.push({ field: 'items', message: '至少需要一行有效明细（数量、描述、单价）' });
  items.forEach((i, idx) => {
    const blank = !i.description?.trim() && !i.quantity && !i.unitPriceCents;
    if (!blank && !isValidItem(i)) out.push({ field: `items.${idx}`, message: `第 ${idx + 1} 行明细不完整` });
  });
  if ((b.notes ?? '').length > NOTES_MAX) out.push({ field: 'notes', message: `备注不能超过 ${NOTES_MAX} 字` });
  return out;
}

/** 去除空白明细行 */
export function cleanItems(items: Item[]): Item[] {
  return items.filter((i) => isValidItem(i));
}

/**
 * 数据迁移：把任意旧版本账单升级到当前 schemaVersion。
 * v0（早期原型）：金额为浮点 "total"、明细 "price"/"qty"，日期可能是 DD/MM/YYYY。
 */
export function migrateBill(raw: any): Bill {
  if (!raw || typeof raw !== 'object') throw new Error('账单数据不是对象');
  let b = { ...raw };
  const v = typeof b.schemaVersion === 'number' ? b.schemaVersion : 0;
  if (v > SCHEMA_VERSION) throw new Error(`数据版本 ${v} 比当前应用新，请先升级应用`);
  if (v < 1) {
    const toISO = (s: any) => {
      if (typeof s !== 'string') return s;
      const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      return m ? `${m[3]}-${m[2]}-${m[1]}` : s;
    };
    const items: Item[] = (b.items ?? []).map((i: any) => ({
      id: i.id ?? cryptoId(),
      quantity: Number(i.quantity ?? i.qty),
      description: String(i.description ?? i.model ?? ''),
      unitPriceCents: i.unitPriceCents ?? Math.round(Number(i.price) * 100),
      subtotalCents: 0,
      recognizedSubtotalRaw: i.recognizedSubtotalRaw ?? null,
    }));
    b = {
      id: b.id,
      merchantId: b.merchantId ?? null,
      merchantNameSnapshot: b.merchantNameSnapshot ?? b.merchant ?? '',
      orderNumber: b.orderNumber != null ? String(b.orderNumber) : '',
      billDate: toISO(b.billDate),
      dueDate: toISO(b.dueDate),
      accountId: b.accountId ?? null,
      accountLabelSnapshot: b.accountLabelSnapshot ?? b.account ?? '',
      reminderDays: Number.isInteger(b.reminderDays) ? b.reminderDays : 3,
      paidAt: b.paidAt ?? (b.paid ? new Date(0).toISOString() : null),
      notes: b.notes ?? '',
      items,
      totalCents: 0,
      ocrReview: b.ocrReview ?? null,
      createdAt: b.createdAt ?? new Date().toISOString(),
      updatedAt: b.updatedAt ?? b.createdAt ?? new Date().toISOString(),
      deletedAt: b.deletedAt ?? null,
      schemaVersion: 1,
    };
    b = recompute(b as Bill);
  }
  return b as Bill;
}

function cryptoId() {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}
