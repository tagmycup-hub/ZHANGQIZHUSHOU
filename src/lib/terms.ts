/** 固定账期规则：计算到期日、分期拆分、文字描述 */
import type { TermRule } from './types';
import { addDays, daysInMonth, toISO, diffDays, isValidISO } from './dates';
import { formatBRL } from './money';

/** 返回到期日列表（分期时多个） */
export function computeDueDates(rule: TermRule | null | undefined, billISO: string): string[] {
  if (!rule || !isValidISO(billISO)) return [];
  if (rule.kind === 'days') return [addDays(billISO, rule.days)];
  if (rule.kind === 'installments') return rule.days.map((d) => addDays(billISO, d));
  // 每月固定日
  const [y, m, d] = billISO.split('-').map(Number);
  let offset = rule.monthOffset;
  if (rule.cutoffDay && d > rule.cutoffDay) offset += 1;
  const at = (off: number) => {
    const idx = y * 12 + (m - 1) + off;
    const ny = Math.floor(idx / 12);
    const nm = (idx % 12) + 1;
    return toISO(ny, nm, Math.min(rule.day, daysInMonth(ny, nm)));
  };
  let due = at(offset);
  if (diffDays(billISO, due) < 0) due = at(offset + 1);
  return [due];
}

export function describeTerm(rule: TermRule | null | undefined): string {
  if (!rule) return '';
  if (rule.kind === 'days') return rule.days === 0 ? '当天付款' : `开单后 ${rule.days} 天`;
  if (rule.kind === 'installments') return `分 ${rule.days.length} 期：${rule.days.join('/')} 天`;
  const when = rule.monthOffset === 0 ? '当月' : rule.monthOffset === 1 ? '次月' : `${rule.monthOffset} 个月后`;
  return `${when} ${rule.day} 号${rule.cutoffDay ? `（每月 ${rule.cutoffDay} 号截单）` : ''}`;
}

/** 解析 "30/60/90" 或 "30, 60, 90" */
export function parseInstallmentDays(text: string): number[] | null {
  const parts = text.split(/[\/,，\s]+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 24) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => Number.isNaN(n) || n > 720)) return null;
  for (let i = 1; i < nums.length; i++) if (nums[i] <= nums[i - 1]) return null;
  return nums;
}

export function validateTerm(rule: TermRule | null | undefined): string | null {
  if (!rule) return null;
  if (rule.kind === 'days') return Number.isInteger(rule.days) && rule.days >= 0 && rule.days <= 720 ? null : '天数应为 0–720 的整数';
  if (rule.kind === 'installments') return rule.days.length >= 2 ? null : '分期至少 2 期，天数递增，如 30/60/90';
  if (!Number.isInteger(rule.day) || rule.day < 1 || rule.day > 31) return '付款日应为 1–31';
  if (!Number.isInteger(rule.monthOffset) || rule.monthOffset < 0 || rule.monthOffset > 12) return '月份偏移应为 0–12';
  if (rule.cutoffDay != null && (!Number.isInteger(rule.cutoffDay) || rule.cutoffDay < 1 || rule.cutoffDay > 31)) return '截单日应为 1–31';
  return null;
}

/** 整数分均分，余数（几分钱）放在第一期 */
export function splitCents(total: number, n: number): number[] {
  if (!Number.isInteger(total) || total < 0 || !Number.isInteger(n) || n < 1) throw new Error('splitCents 参数无效');
  const base = Math.floor(total / n);
  const parts = Array(n).fill(base);
  parts[0] += total - base * n;
  return parts;
}

export function installmentLabel(index: number, count: number, groupTotalCents: number): string {
  return `第 ${index}/${count} 期（整单 ${formatBRL(groupTotalCents)}）`;
}

/** 把一笔账单按到期日列表拆成多期账单（总额整数分精确拆分） */
export function buildInstallmentBills<B extends { id: string; totalCents: number; items: any[]; dueDate: string; ocrReview: unknown; installment?: unknown; amountMode?: string }>(
  base: B,
  dues: string[],
  keyGen: () => string,
): B[] {
  const n = dues.length;
  if (n < 2) return [base];
  const groupId = keyGen();
  const parts = splitCents(base.totalCents, n);
  return dues.map((due, i) => {
    const id = i === 0 ? base.id : keyGen();
    return {
      ...base,
      id,
      dueDate: due,
      amountMode: 'total',
      items: [{ id: keyGen(), quantity: 1, description: installmentLabel(i + 1, n, base.totalCents), unitPriceCents: parts[i], subtotalCents: parts[i], recognizedSubtotalRaw: null }],
      totalCents: parts[i],
      ocrReview: i === 0 ? base.ocrReview : null,
      ...('payments' in base ? { payments: [] } : {}),
      // 分期本身就是多期，不再叠加重复规则
      ...('recurrence' in base ? { recurrence: null } : {}),
      installment: { groupId, index: i + 1, count: n, groupTotalCents: base.totalCents, sourceItems: base.amountMode === 'total' ? undefined : base.items },
    };
  });
}
