import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { IndexedDbRepository } from '../src/db/repo';
import { recompute } from '../src/lib/bill';
import type { Bill } from '../src/lib/types';

const bill = (id: string): Bill => recompute({
  id, merchantId: 'm1', merchantNameSnapshot: 'Loja Antiga', orderNumber: '0001', billDate: '2026-09-01', dueDate: '2026-10-01',
  accountId: 'a1', accountLabelSnapshot: 'PIX Itaú', reminderDays: 3, paidAt: null, notes: '',
  items: [1, 2, 3, 4].map((n) => ({ id: `i${n}`, quantity: n, description: `M-${n}`, unitPriceCents: 1010, subtotalCents: 0 })),
  totalCents: 0, ocrReview: null, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', schemaVersion: 1,
});

describe('A01/A02 IndexedDB 持久化（刷新后仍存在）', () => {
  it('写入后用新连接读回', async () => {
    const r1 = new IndexedDbRepository();
    await r1.putBill(bill('b1'));
    const r2 = new IndexedDbRepository(); // 模拟刷新
    const got = await r2.getBill('b1');
    expect(got?.totalCents).toBe(10100);
    expect(got?.orderNumber).toBe('0001');
  });
  it('停用商家后账单仍显示快照', async () => {
    const r = new IndexedDbRepository();
    await r.putMerchant({ id: 'm1', name: 'Loja Nova', aliases: [], defaultAccountId: null, active: true, createdAt: '', updatedAt: '' });
    await r.deleteMerchant('m1');
    expect((await r.listMerchants()).length).toBe(0);
    expect((await r.getBill('b1'))?.merchantNameSnapshot).toBe('Loja Antiga');
  });
  it('删除账单留下墓碑并清理图片', async () => {
    const r = new IndexedDbRepository();
    const img = await r.putImage(new Blob(['x']));
    await r.putBill({ ...bill('b2'), ocrReview: { provider: 'claude', candidate: {}, warnings: [], acknowledged: [], edits: [], confirmedAt: '', confirmedBy: '', imageId: img } });
    await r.deleteBill('b2');
    expect(await r.getBill('b2')).toBeUndefined();
    expect((await r.listBills()).map((b) => b.id)).toEqual(['b1']);
    expect(await r.getImage(img)).toBeUndefined();
    const all = await r.exportAll();
    expect(all.bills.find((b) => b.id === 'b2')?.deletedAt).toBeTruthy();
  });
  it('设置有默认值；草稿可保存与清除', async () => {
    const r = new IndexedDbRepository();
    expect((await r.getSettings()).defaultReminderDays).toBe(3);
    await r.putDraft({ state: { a: 1 }, imageId: null });
    expect((await r.getDraft())?.state).toEqual({ a: 1 });
    await r.clearDraft();
    expect(await r.getDraft()).toBeUndefined();
  });
  it('整体替换', async () => {
    const r = new IndexedDbRepository();
    await r.replaceAll({ bills: [bill('z')], merchants: [], accounts: [] });
    expect((await r.listBills()).map((b) => b.id)).toEqual(['z']);
  });
});
