import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { IndexedDbRepository } from '../src/db/repo';
import { syncOnce, testConnection, encodeConfig, decodeConfig, configProblem, EMPTY_STATE, newSecret, newSpace, SyncError, type SyncConfig, type SyncState, type FetchLike } from '../src/sync/engine';
import { recompute } from '../src/lib/bill';
import { makeBackup, previewImport } from '../src/lib/backup';
import type { Bill } from '../src/lib/types';

let pg: PGlite;
const KEY = 'sb_publishable_test_key_1234567890';
const calls: string[] = [];

/** 模拟 Supabase PostgREST 的 /rest/v1/rpc/<fn>，底层跑真实的 setup.sql */
const fakeFetch: FetchLike = async (url, init) => {
  const m = String(url).match(/\/rest\/v1\/rpc\/(\w+)$/);
  const headers = new Headers(init?.headers);
  if (!m) return new Response('{"message":"not found"}', { status: 404 });
  if (headers.get('apikey') !== KEY) return new Response(JSON.stringify({ message: 'Invalid API key' }), { status: 401 });
  const fn = m[1];
  calls.push(fn);
  const args = JSON.parse(String(init?.body ?? '{}'));
  const names = Object.keys(args);
  const params = names.map((n) => (typeof args[n] === 'object' ? JSON.stringify(args[n]) : args[n]));
  const call = `${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')})`;
  try {
    if (!['zq_status', 'zq_pull', 'zq_push'].includes(fn)) return new Response(JSON.stringify({ code: 'PGRST202', message: `Could not find the function public.${fn}` }), { status: 404 });
    await pg.query('set role anon');
    const res = fn === 'zq_pull' ? await pg.query(`select * from ${call}`, params) : await pg.query(`select ${call} as r`, params);
    await pg.query('reset role');
    const body = fn === 'zq_pull' ? res.rows.map((r: any) => ({ ...r, updated_at: new Date(r.updated_at).toISOString(), seq: Number(r.seq) })) : (res.rows[0] as any).r;
    return new Response(JSON.stringify(body), { status: 200 });
  } catch (e: any) {
    await pg.query('reset role').catch(() => {});
    return new Response(JSON.stringify({ code: 'P0001', message: e.message }), { status: 400 });
  }
};

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('tests/support/pg-auth.sql', 'utf8'));
  await pg.exec(readFileSync('supabase/setup.sql', 'utf8'));
});

const cfg: SyncConfig = { url: 'https://demo.supabase.co', key: KEY, space: 'zq-testspace', secret: 'correct-horse-battery', auto: true };

const bill = (id: string, extra: Partial<Bill> = {}): Bill =>
  recompute({
    id, merchantId: null, merchantNameSnapshot: 'Loja', orderNumber: '1', billDate: '2026-09-01', dueDate: '2026-10-01',
    accountId: null, accountLabelSnapshot: '', reminderDays: 3, paidAt: null, notes: '',
    items: [{ id: 'i', quantity: 1, description: 'X', unitPriceCents: 1000, subtotalCents: 0 }],
    totalCents: 0, ocrReview: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: new Date().toISOString(), schemaVersion: 1, ...extra,
  });

async function sync(repo: IndexedDbRepository, st: SyncState, opts: Parameters<typeof syncOnce>[3] = {}) {
  return syncOnce(repo, cfg, st, { fetchImpl: fakeFetch, ...opts });
}

describe('Supabase 同步（真实 SQL，PGlite）', () => {
  it('数据表不能被匿名直接读取', async () => {
    await pg.query('set role anon');
    await expect(pg.query('select * from zq_records')).rejects.toThrow();
    await expect(pg.query(`select zq_auth('zq-xxxxxx','aaaaaaaaaaaa', true)`)).rejects.toThrow();
    await pg.query('reset role');
  });

  it('测试连接：新空间不存在；key 错误给出中文提示', async () => {
    expect(await testConnection(cfg, fakeFetch)).toEqual({ exists: false, count: 0, cursor: 0 });
    await expect(testConnection({ ...cfg, key: 'wrong-key-wrong-key-wrong' }, fakeFetch)).rejects.toMatchObject({ code: 'bad_key' });
  });

  let A: IndexedDbRepository;
  let B: IndexedDbRepository;
  let sa: SyncState = EMPTY_STATE;
  let sb: SyncState = EMPTY_STATE;

  it('设备 A 上传，设备 B 下载合并', async () => {
    A = new IndexedDbRepository('dev-a');
    B = new IndexedDbRepository('dev-b');
    await A.putBill(bill('b1'));
    await A.putBill(bill('sample-bill-1')); // 示例数据不上传
    await A.putMerchant({ id: 'm1', name: 'Loja', aliases: [], defaultAccountId: null, active: true, createdAt: '', updatedAt: new Date().toISOString() });
    const a1 = await sync(A, sa);
    sa = a1.state;
    expect(a1.pushed).toBe(3); // bill + merchant + settings
    expect((await testConnection(cfg, fakeFetch)).count).toBe(2);
    // 第二次同步没有改动 → 不再上传
    const a2 = await sync(A, sa);
    sa = a2.state;
    expect(a2.pushed).toBe(0);

    const b1 = await sync(B, sb);
    sb = b1.state;
    expect(b1.applied).toBe(3);
    expect((await B.listBills()).map((b) => b.id)).toEqual(['b1']);
    expect((await B.listMerchants())[0].name).toBe('Loja');
    // 下载的数据不会被当成改动再上传
    expect(b1.pushed).toBe(0);
  });

  it('双向修改与删除：较新的改动胜出，删除会同步', async () => {
    const cur = (await B.getBill('b1'))!;
    await new Promise((r) => setTimeout(r, 5));
    await B.putBill({ ...cur, notes: 'B 改的', updatedAt: new Date().toISOString() });
    sb = (await sync(B, sb)).state;
    const a = await sync(A, sa);
    sa = a.state;
    expect((await A.getBill('b1'))!.notes).toBe('B 改的');
    expect(a.pushed).toBe(0);

    await A.deleteBill('b1');
    sa = (await sync(A, sa)).state;
    sb = (await sync(B, sb)).state;
    expect(await B.getBill('b1')).toBeUndefined();
  });

  it('旧改动不会覆盖云端较新的数据（离线冲突）', async () => {
    await A.putBill(bill('b2', { notes: 'v1', updatedAt: '2026-09-10T10:00:00.000Z' }));
    sa = (await sync(A, sa)).state;
    sb = (await sync(B, sb)).state;
    // A 在 12:00 修改，B 离线时在 11:00 修改（B 较旧）
    await A.putBill({ ...(await A.getBill('b2'))!, notes: 'A 新', updatedAt: '2026-09-10T12:00:00.000Z' });
    await B.putBill({ ...(await B.getBill('b2'))!, notes: 'B 旧', updatedAt: '2026-09-10T11:00:00.000Z' });
    sa = (await sync(A, sa)).state;
    sb = (await sync(B, sb)).state; // B 先下载 → A 的新值覆盖 B 的旧值
    expect((await B.getBill('b2'))!.notes).toBe('A 新');
    sa = (await sync(A, sa)).state;
    expect((await A.getBill('b2'))!.notes).toBe('A 新');
  });

  it('默认设置同步；口令错误被拒绝', async () => {
    const s = await A.getSettings();
    await A.putSettings({ ...s, defaultReminderDays: 9, recognizeToken: 'local-only' });
    sa = (await sync(A, sa)).state;
    sb = (await sync(B, sb)).state;
    const bs = await B.getSettings();
    expect(bs.defaultReminderDays).toBe(9);
    expect(bs.recognizeToken).toBe('');
    await expect(syncOnce(A, { ...cfg, secret: 'wrong-secret-123' }, EMPTY_STATE, { fetchImpl: fakeFetch })).rejects.toMatchObject({ code: 'bad_secret' });
  });

  it('强制全量上传；分页下载（>500 条）', async () => {
    const many = Array.from({ length: 620 }, (_, i) => bill(`bulk-${i}`));
    await A.upsertMany({ bills: many });
    const r = await sync(A, sa, { force: true });
    sa = r.state;
    expect(r.pushed).toBeGreaterThan(620);
    const C = new IndexedDbRepository('dev-c');
    const c = await sync(C, EMPTY_STATE);
    expect((await C.listBills()).length).toBe((await A.listBills()).filter((b) => !b.id.startsWith('sample-')).length);
    expect(c.pulled).toBeGreaterThan(620);
  });

  it('备份导出不含同步标记，导入对比忽略同步标记', async () => {
    const raw = await B.exportRaw();
    expect(raw.bills.some((b: any) => b._syncedAt)).toBe(true);
    const file = makeBackup(raw, null);
    expect(JSON.stringify(file)).not.toContain('_syncedAt');
    const p = previewImport(raw, { bills: file.bills, merchants: file.merchants, accounts: file.accounts });
    expect(p.bills.update.length + p.bills.conflict.length).toBe(0);
  });

  it('清空时写入删除墓碑，其他设备同步删除', async () => {
    const n = await A.tombstone();
    expect(n).toBeGreaterThan(0);
    sa = (await sync(A, sa)).state;
    sb = (await sync(B, sb)).state;
    expect(await B.listBills()).toEqual([]);
    expect((await testConnection(cfg, fakeFetch)).count).toBe(0);
  });
});

describe('同步配置', () => {
  it('复制配置到别的设备 / 粘贴导入', () => {
    const c = { ...cfg, url: 'demo.supabase.co/', space: newSpace(), secret: newSecret() };
    const text = encodeConfig(c);
    expect(text.startsWith('ZQSYNC1:')).toBe(true);
    const back = decodeConfig(`请粘贴：${text}  `);
    expect(back).toMatchObject({ url: 'https://demo.supabase.co', key: KEY, space: c.space, secret: c.secret });
    expect(() => decodeConfig('hello')).toThrow(SyncError);
  });
  it('配置校验', () => {
    expect(configProblem({})).toMatch(/Project URL/);
    expect(configProblem({ ...cfg, key: 'x' })).toMatch(/key/);
    expect(configProblem({ ...cfg, secret: 'short' })).toMatch(/口令/);
    expect(configProblem(cfg)).toBeNull();
    expect(newSecret()).toHaveLength(24);
    expect(newSpace()).toMatch(/^zq-[a-z0-9]{10}$/);
  });
});

describe('本地改动时间单调', () => {
  it('旧记录时间在未来时，删除/修改仍比它新，并能同步出去', async () => {
    const { laterThan } = await import('../src/db/repo');
    expect(laterThan('2099-01-01T00:00:00.000Z', '2026-09-16T00:00:00.000Z')).toBe('2099-01-01T00:00:00.001Z');
    expect(laterThan('2026-01-01T00:00:00.000Z', '2026-09-16T00:00:00.000Z')).toBe('2026-09-16T00:00:00.000Z');
    expect(laterThan(undefined, 'x')).toBe('x');

    const A = new IndexedDbRepository('mono-A');
    const B = new IndexedDbRepository('mono-B');
    const c2: SyncConfig = { ...cfg, space: 'zq-monotonic' };
    let sa: SyncState = { ...EMPTY_STATE };
    let sb: SyncState = { ...EMPTY_STATE };
    await A.putBill(bill('future-1', { updatedAt: '2099-01-01T00:00:00.000Z' }));
    sa = (await syncOnce(A, c2, sa, { fetchImpl: fakeFetch })).state;
    sb = (await syncOnce(B, c2, sb, { fetchImpl: fakeFetch })).state;
    expect((await B.listBills()).map((b) => b.id)).toEqual(['future-1']);
    await A.deleteBill('future-1');
    sa = (await syncOnce(A, c2, sa, { fetchImpl: fakeFetch })).state;
    sb = (await syncOnce(B, c2, sb, { fetchImpl: fakeFetch })).state;
    expect(await B.listBills()).toEqual([]);
    // 远端写入保持原样（不被改时间）
    const raw = (await B.exportRaw()).bills[0] as any;
    expect(raw.updatedAt).toBe('2099-01-01T00:00:00.001Z');
    void sa;
    void sb;
  });
});

describe('同步并发与设置合并', () => {
  it('下载期间本机刚保存的修改不会被旧的云端版本覆盖', async () => {
    const c3: SyncConfig = { ...cfg, space: 'zq-concurrent' };
    const A = new IndexedDbRepository('cc-A');
    const B = new IndexedDbRepository('cc-B');
    let sa: SyncState = { ...EMPTY_STATE };
    let sb: SyncState = { ...EMPTY_STATE };
    await A.putBill(bill('cx', { notes: 'orig', updatedAt: '2026-09-10T00:00:00.000Z' }));
    sa = (await syncOnce(A, c3, sa, { fetchImpl: fakeFetch })).state;
    sb = (await syncOnce(B, c3, sb, { fetchImpl: fakeFetch })).state;
    const bx = (await B.listBills())[0];
    await B.putBill({ ...bx, notes: 'B edit', updatedAt: new Date(Date.now() - 5000).toISOString() });
    sb = (await syncOnce(B, c3, sb, { fetchImpl: fakeFetch })).state;
    // A 在下载进行中保存了自己的修改
    const slowFetch: FetchLike = async (url, init) => {
      if (String(url).endsWith('/zq_pull')) {
        const ax = (await A.listBills())[0];
        await A.putBill({ ...ax, notes: 'A edit', updatedAt: new Date().toISOString() });
      }
      return fakeFetch(url, init);
    };
    sa = (await syncOnce(A, c3, sa, { fetchImpl: slowFetch })).state;
    expect((await A.listBills())[0].notes).toBe('A edit');
    sb = (await syncOnce(B, c3, sb, { fetchImpl: fakeFetch })).state;
    expect((await B.listBills())[0].notes).toBe('A edit');
  });
  it('设置逐项合并：两台设备改不同的项都保留', async () => {
    const c4: SyncConfig = { ...cfg, space: 'zq-settings-merge' };
    const C = new IndexedDbRepository('sm-C');
    const D = new IndexedDbRepository('sm-D');
    let sc: SyncState = { ...EMPTY_STATE };
    let sd: SyncState = { ...EMPTY_STATE };
    sc = (await syncOnce(C, c4, sc, { fetchImpl: fakeFetch })).state;
    sd = (await syncOnce(D, c4, sd, { fetchImpl: fakeFetch })).state;
    await D.putSettings({ ...(await D.getSettings()), dueSoonDays: 3 });
    sd = (await syncOnce(D, c4, sd, { fetchImpl: fakeFetch })).state;
    await C.putSettings({ ...(await C.getSettings()), defaultReminderDays: 11 });
    sc = (await syncOnce(C, c4, sc, { fetchImpl: fakeFetch })).state;
    const cs = await C.getSettings();
    expect([cs.dueSoonDays, cs.defaultReminderDays]).toEqual([3, 11]);
    sd = (await syncOnce(D, c4, sd, { fetchImpl: fakeFetch })).state;
    const ds = await D.getSettings();
    expect([ds.dueSoonDays, ds.defaultReminderDays]).toEqual([3, 11]);
  });
});
