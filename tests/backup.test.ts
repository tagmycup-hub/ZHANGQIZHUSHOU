import { describe, it, expect } from 'vitest';
import { makeBackup, validateBackup, previewImport, applyMerge, BACKUP_FORMAT } from '../src/lib/backup';
import { migrateBill, recompute, validateBill } from '../src/lib/bill';
import { defaultSettings, type Bill } from '../src/lib/types';

const mkBill = (id: string, updatedAt = '2026-09-01T00:00:00Z', extra: Partial<Bill> = {}): Bill => recompute({
  id, merchantId: 'm1', merchantNameSnapshot: 'Loja', orderNumber: '007', billDate: '2026-09-01', dueDate: '2026-10-01',
  accountId: null, accountLabelSnapshot: '', reminderDays: 3, paidAt: null, notes: '',
  items: [{ id: 'i', quantity: 2, description: 'A', unitPriceCents: 150, subtotalCents: 0 }],
  totalCents: 0, ocrReview: null, createdAt: updatedAt, updatedAt, schemaVersion: 1, ...extra,
});

describe('A01 手工四行账单金额', () => {
  it('小计和总额用整数分计算', () => {
    const b = recompute({ items: [
      { id: '1', quantity: 3, description: 'A', unitPriceCents: 10, subtotalCents: 0 },
      { id: '2', quantity: 1, description: 'B', unitPriceCents: 20, subtotalCents: 0 },
      { id: '3', quantity: 7, description: 'C', unitPriceCents: 1999, subtotalCents: 0 },
      { id: '4', quantity: 0.5, description: 'D', unitPriceCents: 333, subtotalCents: 0 },
    ] });
    expect(b.items.map((i) => i.subtotalCents)).toEqual([30, 20, 13993, 167]);
    expect(b.totalCents).toBe(14210);
  });
  it('至少一行有效明细', () => {
    expect(validateBill({ ...mkBill('x'), items: [] }).some((i) => i.field === 'items')).toBe(true);
  });
});

describe('A09 备份恢复', () => {
  it('导出后可完整校验', () => {
    const file = makeBackup({ bills: [mkBill('b1')], merchants: [{ id: 'm1', name: 'Loja', aliases: [], defaultAccountId: null, active: true, createdAt: '', updatedAt: '' }], accounts: [] }, defaultSettings());
    const text = JSON.stringify(file);
    const chk = validateBackup(text);
    expect(chk.ok).toBe(true);
    expect(chk.data!.bills[0]).toEqual(mkBill('b1'));
    expect(chk.data!.bills[0].orderNumber).toBe('007');
    expect((chk.settings as any).notifiedSignatures).toBeUndefined();
  });
  it('检测错误', () => {
    expect(validateBackup('{').ok).toBe(false);
    expect(validateBackup({ format: 'x' }).errors[0]).toMatch(/format/);
    expect(validateBackup({ format: BACKUP_FORMAT, schemaVersion: 99, bills: [], merchants: [], accounts: [] }).errors[0]).toMatch(/升级/);
    const bad = validateBackup({ format: BACKUP_FORMAT, schemaVersion: 1, merchants: [], accounts: [], bills: [
      { ...mkBill('a'), dueDate: '2026-02-31' },
      { ...mkBill('b'), items: [{ id: 'i', quantity: 1, description: 'A', unitPriceCents: 1.5, subtotalCents: 1 }] },
      mkBill('c'), mkBill('c'),
    ] });
    expect(bad.ok).toBe(false);
    expect(bad.errors.length).toBe(3);
  });
  it('总额不一致时给出警告并按明细重算', () => {
    const chk = validateBackup({ format: BACKUP_FORMAT, schemaVersion: 1, merchants: [], accounts: [], bills: [{ ...mkBill('a'), totalCents: 999 }] });
    expect(chk.ok).toBe(true);
    expect(chk.warnings.length).toBe(1);
    expect(chk.data!.bills[0].totalCents).toBe(300);
  });
  it('预览新增 / 更新 / 冲突 / 相同', () => {
    const local = { bills: [mkBill('same'), mkBill('upd'), mkBill('conf', '2026-09-10T00:00:00Z')], merchants: [], accounts: [] };
    const incoming = { bills: [mkBill('same'), mkBill('upd', '2026-09-05T00:00:00Z', { notes: 'new' }), mkBill('conf', '2026-09-02T00:00:00Z', { notes: 'old' }), mkBill('new')], merchants: [], accounts: [] };
    const p = previewImport(local, incoming);
    expect(p.bills.add.map((b) => b.id)).toEqual(['new']);
    expect(p.bills.update.map((b) => b.id)).toEqual(['upd']);
    expect(p.bills.conflict.map((c) => c.local.id)).toEqual(['conf']);
    expect(p.bills.same).toBe(1);
    expect(applyMerge(p.bills, 'keepLocal').map((b) => b.id)).toEqual(['new', 'upd']);
    expect(applyMerge(p.bills, 'useIncoming').map((b) => b.id)).toEqual(['new', 'upd', 'conf']);
  });
});

describe('数据迁移', () => {
  it('v0 浮点金额与 DD/MM/YYYY 日期升级为 v1', () => {
    const b = migrateBill({ id: 'old', merchant: 'Loja', orderNumber: 42, billDate: '01/09/2026', dueDate: '01/10/2026', paid: false, total: 3.3, items: [{ qty: 3, model: 'X', price: 1.1 }] });
    expect(b.schemaVersion).toBe(1);
    expect(b.billDate).toBe('2026-09-01');
    expect(b.items[0].unitPriceCents).toBe(110);
    expect(b.totalCents).toBe(330);
    expect(b.orderNumber).toBe('42');
    expect(b.paidAt).toBeNull();
  });
  it('拒绝更高版本', () => {
    expect(() => migrateBill({ id: 'x', schemaVersion: 5 })).toThrow(/升级/);
  });
});

import { validateBackup as vb2 } from '../src/lib/backup';
describe('备份里的付款记录', () => {
  it('无效的付款记录会被检出', () => {
    const bill = { id: 'p1', merchantId: null, merchantNameSnapshot: 'Loja', orderNumber: '', billDate: '2026-09-01', dueDate: '2026-10-01', accountId: null, accountLabelSnapshot: '', reminderDays: 3, paidAt: null, notes: '', items: [{ id: 'i', quantity: 1, description: 'x', unitPriceCents: 1000, subtotalCents: 1000 }], totalCents: 1000, ocrReview: null, createdAt: '', updatedAt: '', schemaVersion: 1 };
    const base = { format: 'zhangqi-zhushou-backup', schemaVersion: 1, bills: [], merchants: [], accounts: [] };
    expect(vb2({ ...base, bills: [{ ...bill, payments: [{ id: 'a', date: '2026-09-05', cents: 500 }] }] }).ok).toBe(true);
    const bad = vb2({ ...base, bills: [{ ...bill, payments: [{ id: 'a', date: '2026-02-31', cents: 500 }] }] });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join()).toContain('付款记录');
  });
});

import { makeBackup as mb3, validateBackup as vb3, previewImport as pi3 } from '../src/lib/backup';
describe('备份：墓碑与付款', () => {
  it('重新导入自己的备份时已删除账单不算冲突', () => {
    const bill = { id: 'd1', merchantId: null, merchantNameSnapshot: 'Loja', orderNumber: '', billDate: '2026-09-01', dueDate: '2026-10-01', accountId: null, accountLabelSnapshot: '', reminderDays: 3, paidAt: null, notes: '', items: [], totalCents: 5000, ocrReview: null, createdAt: '', updatedAt: '2026-09-02T00:00:00.000Z', deletedAt: '2026-09-02T00:00:00.000Z', schemaVersion: 1 } as any;
    const data = { bills: [bill], merchants: [], accounts: [] };
    const chk = vb3(JSON.parse(JSON.stringify(mb3(data, { id: 'settings' } as any))));
    expect(chk.warnings.join()).not.toContain('总额与明细不一致');
    const p = pi3(data, chk.data!);
    expect(p.bills.conflict).toHaveLength(0);
  });
});
