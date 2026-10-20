/** 重复账单：周期定义、下一期计算、描述 */
import type { Bill } from './types';
import { addDays, addMonths, daysInMonth, diffDays, isValidISO, toISO } from './dates';

export type RepeatUnit = 'day' | 'week' | 'month' | 'year';

export interface Recurrence {
  seriesId: string;
  unit?: RepeatUnit;
  every?: number;
  /** 最后一期到期日不晚于此日期（含），空 = 一直重复 */
  until?: string | null;
  /** 按月/年重复时固定的"几号"，避免 31 号 → 28 号后一直停在 28 号 */
  anchorDay?: number | null;
  /** 旧版字段：仅 'monthly' */
  freq?: 'monthly';
}

export interface RepeatRule {
  unit: RepeatUnit;
  every: number;
}

export const REPEAT_PRESETS: { key: string; label: string; rule: RepeatRule }[] = [
  { key: 'w1', label: '每周', rule: { unit: 'week', every: 1 } },
  { key: 'w2', label: '每 2 周', rule: { unit: 'week', every: 2 } },
  { key: 'm1', label: '每月', rule: { unit: 'month', every: 1 } },
  { key: 'm2', label: '每 2 个月', rule: { unit: 'month', every: 2 } },
  { key: 'm3', label: '每季度', rule: { unit: 'month', every: 3 } },
  { key: 'm6', label: '每半年', rule: { unit: 'month', every: 6 } },
  { key: 'y1', label: '每年', rule: { unit: 'year', every: 1 } },
];

export const UNIT_LABEL: Record<RepeatUnit, string> = { day: '天', week: '周', month: '个月', year: '年' };

export function ruleOf(r: Recurrence | null | undefined): RepeatRule | null {
  if (!r) return null;
  const unit = r.unit ?? 'month';
  const every = Number.isInteger(r.every) && (r.every as number) > 0 ? (r.every as number) : 1;
  return { unit, every };
}

export function presetKey(rule: RepeatRule | null): string {
  if (!rule) return 'none';
  return REPEAT_PRESETS.find((p) => p.rule.unit === rule.unit && p.rule.every === rule.every)?.key ?? 'custom';
}

export function describeRepeat(r: Recurrence | RepeatRule | null | undefined): string {
  const rule = r && 'seriesId' in r ? ruleOf(r) : (r as RepeatRule | null | undefined) ?? null;
  if (!rule) return '';
  const p = REPEAT_PRESETS.find((x) => x.rule.unit === rule.unit && x.rule.every === rule.every);
  const base = p ? p.label : `每 ${rule.every} ${UNIT_LABEL[rule.unit]}`;
  const until = r && 'seriesId' in r && r.until ? `，至 ${r.until.split('-').reverse().join('/')}` : '';
  return base + until;
}

export function validateRule(rule: RepeatRule | null): string | null {
  if (!rule) return null;
  if (!Number.isInteger(rule.every) || rule.every < 1) return '重复间隔应为正整数';
  const max = { day: 366, week: 104, month: 60, year: 10 }[rule.unit];
  if (rule.every > max) return `间隔太长（最多 ${max} ${UNIT_LABEL[rule.unit]}）`;
  return null;
}

/** 下一期到期日 */
export function nextDueDate(due: string, r: Recurrence | RepeatRule): string {
  const rule = 'seriesId' in r ? ruleOf(r)! : r;
  if (rule.unit === 'day') return addDays(due, rule.every);
  if (rule.unit === 'week') return addDays(due, rule.every * 7);
  const months = rule.unit === 'year' ? rule.every * 12 : rule.every;
  const anchor = 'seriesId' in r && r.anchorDay ? r.anchorDay : Number(due.slice(8));
  const moved = addMonths(due, months);
  const [y, m] = moved.split('-').map(Number);
  return toISO(y, m, Math.min(anchor, daysInMonth(y, m)));
}

/** 生成下一期（到期日超过结束日期时返回 null）。金额沿用并标记为预估 */
export function nextRecurring(b: Bill, id: string, nowISO: string): Bill | null {
  if (!b.recurrence) return null;
  const nextDue = nextDueDate(b.dueDate, b.recurrence);
  if (b.recurrence.until && isValidISO(b.recurrence.until) && nextDue > b.recurrence.until) return null;
  const term = diffDays(b.billDate, b.dueDate);
  return {
    ...b,
    id,
    billDate: addDays(nextDue, -term),
    dueDate: nextDue,
    paidAt: null,
    payments: [],
    orderNumber: '',
    paymentCode: '',
    estimated: true,
    ocrReview: null,
    installment: null,
    recurrence: { ...b.recurrence, anchorDay: b.recurrence.anchorDay ?? (ruleOf(b.recurrence)!.unit === 'month' || ruleOf(b.recurrence)!.unit === 'year' ? Number(b.dueDate.slice(8)) : null) },
    items: b.items.map((i, k) => ({ ...i, id: `${id}-${k}`, recognizedSubtotalRaw: null })),
    createdAt: nowISO,
    updatedAt: nowISO,
    deletedAt: null,
  };
}

/** 该重复账单之后是否还需要生成下一期（同系列里已经有更晚的一期就不再生成） */
export function needsNextRecurring(b: Bill, all: Bill[]): boolean {
  if (!b.recurrence) return false;
  const nextDue = nextDueDate(b.dueDate, b.recurrence);
  if (b.recurrence.until && nextDue > b.recurrence.until) return false;
  return !all.some((x) => x.id !== b.id && !x.deletedAt && x.recurrence?.seriesId === b.recurrence!.seriesId && x.dueDate > b.dueDate);
}

export function makeRecurrence(rule: RepeatRule | null, seriesId: string, until: string | null, dueISO: string | null, prev?: { recurrence?: Recurrence | null; dueDate?: string } | null): Recurrence | null {
  if (!rule) return null;
  const monthly = rule.unit === 'month' || rule.unit === 'year';
  let anchorDay = monthly && dueISO ? Number(dueISO.slice(8)) : null;
  // 31 号的账单到了 2 月变成 28 号：只要用户没改到期日，就保留原来的锚定日
  if (monthly && prev?.recurrence?.anchorDay && prev.dueDate && dueISO === prev.dueDate) anchorDay = prev.recurrence.anchorDay;
  return { seriesId, unit: rule.unit, every: rule.every, until: until || null, anchorDay };
}
