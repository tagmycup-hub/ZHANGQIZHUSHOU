import { describe, it, expect } from 'vitest';
import { parseBRDate, isValidISO, todayISO, addDays, diffDays, formatBR } from '../src/lib/dates';
import { billStatus, summarize, notifySignature, inReminderWindow } from '../src/lib/status';

describe('日期验证 A06', () => {
  it('31/02/2026 被拒绝', () => {
    const r = parseBRDate('31/02/2026');
    expect(r.iso).toBeNull();
    expect(r.error).toMatch(/不存在/);
  });
  it('29/02/2024 闰年合法，29/02/2026 非法', () => {
    expect(parseBRDate('29/02/2024').iso).toBe('2024-02-29');
    expect(parseBRDate('29/02/2026').iso).toBeNull();
  });
  it('两位年份不静默猜测', () => {
    const r = parseBRDate('12/09/26', new Date('2026-09-15T12:00:00Z'));
    expect(r.iso).toBeNull();
    expect(r.needsConfirm).toBe(true);
    expect(r.candidate).toBe('2026-09-12');
  });
  it('ISO 校验', () => {
    expect(isValidISO('2026-02-30')).toBe(false);
    expect(isValidISO('2026-12-31')).toBe(true);
    expect(isValidISO('2026-1-1')).toBe(false);
  });
  it('格式互转', () => {
    expect(formatBR('2026-09-05')).toBe('05/09/2026');
    expect(parseBRDate('5/9/2026').iso).toBe('2026-09-05');
  });
  it('跨月跨年加减', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(diffDays('2026-02-27', '2026-03-01')).toBe(2);
  });
});

describe('圣保罗午夜边界', () => {
  it('UTC 02:59 仍是圣保罗前一天', () => {
    expect(todayISO(new Date('2026-09-16T02:59:00Z'))).toBe('2026-09-15');
    expect(todayISO(new Date('2026-09-16T03:00:00Z'))).toBe('2026-09-16');
  });
  it('到期日当天 23:59（圣保罗）仍非逾期，00:00 起逾期', () => {
    const bill = { paidAt: null, dueDate: '2026-09-15' };
    expect(billStatus(bill, todayISO(new Date('2026-09-16T02:59:00Z')))).toBe('dueSoon');
    expect(billStatus(bill, todayISO(new Date('2026-09-16T03:00:00Z')))).toBe('overdue');
  });
});

describe('状态计算', () => {
  const t = '2026-09-15';
  it('四种状态', () => {
    expect(billStatus({ paidAt: '2026-09-01T00:00:00Z', dueDate: '2026-01-01' }, t)).toBe('paid');
    expect(billStatus({ paidAt: null, dueDate: '2026-09-14' }, t)).toBe('overdue');
    expect(billStatus({ paidAt: null, dueDate: '2026-09-22' }, t)).toBe('dueSoon');
    expect(billStatus({ paidAt: null, dueDate: '2026-09-23' }, t)).toBe('open');
  });
  it('提醒窗口', () => {
    expect(inReminderWindow({ paidAt: null, dueDate: '2026-09-18', reminderDays: 3 }, t)).toBe(true);
    expect(inReminderWindow({ paidAt: null, dueDate: '2026-09-19', reminderDays: 3 }, t)).toBe(false);
  });
  it('通知签名包含日期、账单、到期日、状态', () => {
    expect(notifySignature({ id: 'b1', dueDate: '2026-09-18', paidAt: null }, t, 'dueSoon')).toBe('2026-09-15|b1|2026-09-18|dueSoon');
  });
  it('汇总', () => {
    const mk = (id: string, due: string, cents: number, paid = false) => ({ id, dueDate: due, totalCents: cents, paidAt: paid ? 'x' : null } as any);
    const s = summarize([mk('a', '2026-09-10', 100), mk('b', '2026-09-16', 200), mk('c', '2026-12-01', 300), mk('d', '2026-09-01', 400, true)], t);
    expect(s.unpaidCents).toBe(600);
    expect(s.overdueCents).toBe(100);
    expect(s.dueSoonCents).toBe(200);
    expect(s.paidCents).toBe(400);
    expect(s.next?.id).toBe('a');
  });
});
