import { describe, it, expect } from 'vitest';
import { addMonths, endOfMonth, shiftMonth, monthGrid, monthLabel } from '../src/lib/dates';
import { monthSummary, dailyTotals, compactBRL } from '../src/lib/monthly';
import { computeIssues, saveGate, stateTotal, itemsForSave, draftFromModel, normalizeModelOutput, TOTAL_ONLY_DESC, type EditorState } from '../src/lib/ocr/protocol';
import { recompute, validateBill } from '../src/lib/bill';
import fixture from './fixtures/ticket-258.model.json';
import type { Bill } from '../src/lib/types';

const now = new Date('2026-09-16T12:00:00Z');

describe('月份工具', () => {
  it('addMonths 月末截断与跨年', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15');
  });
  it('月末、月份切换、标签', () => {
    expect(endOfMonth('2026-02-10')).toBe('2026-02-28');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(monthLabel('2026-09')).toBe('2026年9月');
  });
  it('月历网格从周日开始，含 42 天', () => {
    const g = monthGrid('2026-09'); // 2026-09-01 是周二
    expect(g).toHaveLength(42);
    expect(g[0]).toBe('2026-08-30');
    expect(g[2]).toBe('2026-09-01');
  });
});

const mk = (id: string, due: string, cents: number, paid = false): Bill => ({ id, dueDate: due, totalCents: cents, paidAt: paid ? '2026-09-01T00:00:00Z' : null } as Bill);

describe('本月账期总额', () => {
  const bills = [mk('a', '2026-09-05', 1000), mk('b', '2026-09-20', 2500), mk('c', '2026-09-10', 400, true), mk('d', '2026-10-01', 9999), mk('e', '2026-08-31', 7)];
  it('按到期月份统计已付/未付/逾期', () => {
    const s = monthSummary(bills, '2026-09', '2026-09-16');
    expect(s).toMatchObject({ totalCents: 3900, count: 3, paidCents: 400, unpaidCents: 3500, overdueCents: 1000, overdueCount: 1 });
    expect(monthSummary(bills, '2026-10', '2026-09-16').totalCents).toBe(9999);
  });
  it('每日汇总可排除当前编辑的账单', () => {
    const d = dailyTotals([...bills, mk('f', '2026-09-05', 1, true)], { excludeId: 'a' });
    expect(d.get('2026-09-05')).toEqual({ cents: 1, unpaidCents: 0, count: 1, unpaidCount: 0 });
  });
  it('紧凑金额', () => {
    expect(compactBRL(85000)).toBe('850');
    expect(compactBRL(123456)).toBe('1,2k');
    expect(compactBRL(4560000)).toBe('46k');
  });
});

const base: EditorState = { merchantId: 'm', merchantName: 'Loja', accountId: null, accountLabel: '', orderNumber: '', billDateText: '10/09/2026', dueDateText: '10/10/2026', reminderDays: '3', notes: '', rows: [{ key: 'r1', qtyText: '', desc: '', unitText: '' }], dueBeforeConfirmed: false };

describe('仅填总金额', () => {
  it('合法总额即可保存，生成一行整单明细', () => {
    const s: EditorState = { ...base, amountMode: 'total', totalText: '1.234,56' };
    expect(computeIssues(s, now)).toEqual([]);
    expect(stateTotal(s)).toBe(123456);
    const items = itemsForSave(s, () => 'x');
    expect(items).toEqual([{ id: 'r1', quantity: 1, description: TOTAL_ONLY_DESC, unitPriceCents: 123456, subtotalCents: 123456, recognizedSubtotalRaw: null }]);
    const b = recompute({ items });
    expect(b.totalCents).toBe(123456);
    expect(validateBill({ ...b, merchantNameSnapshot: 'L', billDate: '2026-09-10', dueDate: '2026-10-10', reminderDays: 3 })).toEqual([]);
  });
  it('空、零、歧义、错误格式都阻止保存', () => {
    for (const t of ['', '0', '1.234', 'abc']) {
      const issues = computeIssues({ ...base, amountMode: 'total', totalText: t }, now);
      expect(issues.some((i) => i.field === 'totalOnly' && i.level === 'block')).toBe(true);
    }
  });
  it('可自定义描述；明细行被忽略', () => {
    const s: EditorState = { ...base, amountMode: 'total', totalText: '50', totalDesc: '月结', rows: [{ key: 'r1', qtyText: 'x', desc: '', unitText: '??' }] };
    expect(computeIssues(s, now)).toEqual([]);
    expect(itemsForSave(s, () => 'x')[0].description).toBe('月结');
  });
  it('识别草稿切到总额模式：与图片 TOTAL 不同要核对', () => {
    const d = draftFromModel(normalizeModelOutput(fixture), 'claude', { dueDateText: '12/10/2026', reminderDays: '3', accountId: null, accountLabel: '', merchantId: 'm', merchantName: 'L' }, () => 'k' + Math.random());
    d.billDateText = '12/09/2026';
    const s: EditorState = { ...d, amountMode: 'total', totalText: '360' };
    const issues = computeIssues(s, now);
    const w = issues.find((i) => i.id.startsWith('total:arith'))!;
    expect(w.level).toBe('warn');
    expect(w.message).toContain('R$ 360,00');
    expect(w.message).toContain('R$ 368,00');
    expect(issues.some((i) => i.field === 'qty' || i.field === 'row')).toBe(false);
    const ok = computeIssues({ ...s, totalText: '368' }, now);
    expect(ok.some((i) => i.id.startsWith('total:arith'))).toBe(false);
    expect(saveGate(s, issues, new Set(issues.map((i) => i.id)), true).canSave).toBe(true);
  });
});

describe('付款日期', () => {
  it('无效付款日期阻止保存', () => {
    const s: EditorState = { ...base, rows: [{ key: 'r', qtyText: '1', desc: 'A', unitText: '1' }], paidDateText: '31/02/2026' };
    expect(computeIssues(s, now).some((i) => i.id === 'paidDate:invalid')).toBe(true);
    expect(computeIssues({ ...s, paidDateText: '15/09/2026' }, now)).toEqual([]);
  });
});
