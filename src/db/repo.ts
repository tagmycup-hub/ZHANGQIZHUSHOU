/**
 * 数据访问层。界面只依赖 Repository 接口；第二阶段可实现 SyncRepository
 * （本地 IndexedDB + 云端），利用 updatedAt 与 deletedAt 墓碑做增量同步。
 */
import { openDB, type IDBPDatabase, type DBSchema } from 'idb';
import type { Bill, Merchant, PaymentAccount, Settings } from '../lib/types';
import { defaultSettings } from '../lib/types';
import { migrateBill } from '../lib/bill';
import type { DataSet } from '../lib/backup';
import { uuid, nowISO } from '../lib/ids';

export interface StoredImage {
  id: string;
  blob: Blob;
  createdAt: string;
}

export interface Draft {
  id: 'current';
  state: unknown;
  imageId: string | null;
  savedAt: string;
}

export interface Repository {
  listBills(): Promise<Bill[]>;
  getBill(id: string): Promise<Bill | undefined>;
  putBill(b: Bill): Promise<void>;
  deleteBill(id: string): Promise<void>;
  listMerchants(): Promise<Merchant[]>;
  putMerchant(m: Merchant): Promise<void>;
  deleteMerchant(id: string): Promise<void>;
  listAccounts(): Promise<PaymentAccount[]>;
  putAccount(a: PaymentAccount): Promise<void>;
  deleteAccount(id: string): Promise<void>;
  getSettings(): Promise<Settings>;
  putSettings(s: Settings): Promise<void>;
  putImage(blob: Blob): Promise<string>;
  getImage(id: string): Promise<Blob | undefined>;
  deleteImage(id: string): Promise<void>;
  getDraft(): Promise<Draft | undefined>;
  putDraft(d: Omit<Draft, 'id' | 'savedAt'>): Promise<void>;
  clearDraft(): Promise<void>;
  exportAll(): Promise<DataSet>;
  replaceAll(data: DataSet): Promise<void>;
  upsertMany(data: Partial<DataSet>): Promise<void>;
  clearAll(): Promise<void>;
  /** 全部记录（含删除墓碑），同步用 */
  exportRaw(): Promise<DataSet>;
  /** 把所有（或满足条件的）记录标记为已删除，用于在同步开启时"清空" */
  tombstone(filter?: (kind: 'bill' | 'merchant' | 'account', id: string) => boolean): Promise<number>;
  /** 标记记录已与云端一致（仅当 updatedAt 未变时） */
  markSynced(entries: { kind: 'bill' | 'merchant' | 'account'; id: string; updatedAt: string }[]): Promise<void>;
  /** 写入云端下载的记录（不触发 onWrite） */
  applyRemote(data: Partial<DataSet>): Promise<void>;
  getMeta<T = unknown>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
  /** 数据写入后回调（同步用），meta 写入不触发 */
  onWrite: (() => void) | null;
}

interface Schema extends DBSchema {
  bills: { key: string; value: Bill; indexes: { dueDate: string } };
  merchants: { key: string; value: Merchant };
  accounts: { key: string; value: PaymentAccount };
  settings: { key: string; value: Settings };
  images: { key: string; value: StoredImage };
  drafts: { key: string; value: Draft };
  meta: { key: string; value: { key: string; value: unknown } };
}

export const DB_NAME = 'zhangqi-zhushou';
export const DB_VERSION = 1;

export class StorageError extends Error {
  constructor(message: string, public hint: string) {
    super(message);
  }
}

export function explainStorageError(e: unknown): StorageError {
  if (e instanceof StorageError) return e;
  const name = (e as any)?.name ?? '';
  if (name === 'QuotaExceededError') return new StorageError('存储空间已满', '请导出备份后删除不需要的票据图片，或清理浏览器空间');
  if (name === 'InvalidStateError' || name === 'SecurityError') return new StorageError('浏览器禁止本地存储', '可能处于无痕模式或禁用了网站数据。请换用普通窗口，或允许本站保存数据');
  if (name === 'VersionError') return new StorageError('本地数据版本比应用新', '请刷新页面加载最新版本的应用；数据未被删除');
  return new StorageError(`本地存储出错：${(e as Error)?.message ?? e}`, '请刷新重试；若持续出现，先在「数据」页导出备份');
}

async function open(name = DB_NAME): Promise<IDBPDatabase<Schema>> {
  if (typeof indexedDB === 'undefined') throw new StorageError('此浏览器不支持 IndexedDB', '请使用最新版 Chrome、Safari 或 Edge');
  try {
    return await openDB<Schema>(name, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, tx) {
        // 迁移按版本逐级执行；失败会中止事务，旧数据保持不变
        if (oldVersion < 1) {
          const bills = db.createObjectStore('bills', { keyPath: 'id' });
          bills.createIndex('dueDate', 'dueDate');
          db.createObjectStore('merchants', { keyPath: 'id' });
          db.createObjectStore('accounts', { keyPath: 'id' });
          db.createObjectStore('settings', { keyPath: 'id' });
          db.createObjectStore('images', { keyPath: 'id' });
          db.createObjectStore('drafts', { keyPath: 'id' });
          db.createObjectStore('meta', { keyPath: 'key' });
        }
        void tx;
      },
      blocked() {
        console.warn('数据库升级被其他标签页阻塞');
      },
    });
  } catch (e) {
    throw explainStorageError(e);
  }
}

const alive = <T extends { deletedAt?: string | null }>(r: T) => !r.deletedAt;

/**
 * 本地改动的 updatedAt 必须比旧版本新：旧记录时间在"未来"（别的设备时钟偏快、导入的备份）时，
 * 直接用当前时间会在同步里输给旧版本，导致改动/删除丢失。
 */
export function laterThan(prev: string | undefined | null, next: string): string {
  if (!prev || !next || next >= prev) return next;
  const t = Date.parse(prev);
  return Number.isFinite(t) ? new Date(t + 1).toISOString() : next;
}

type StoreName = 'bills' | 'merchants' | 'accounts';
/** 在事务内写入本地改动（保证 updatedAt 单调） */
async function putLocal(tx: any, store: StoreName, rec: any) {
  const os = tx.objectStore(store);
  const cur = await os.get(rec.id);
  const updatedAt = laterThan(cur?.updatedAt, rec.updatedAt);
  await os.put(updatedAt === rec.updatedAt ? rec : { ...rec, updatedAt });
}

export class IndexedDbRepository implements Repository {
  private dbp: Promise<IDBPDatabase<Schema>>;
  onWrite: (() => void) | null = null;
  constructor(name = DB_NAME) {
    this.dbp = open(name);
  }
  private changed() {
    try {
      this.onWrite?.();
    } catch {}
  }
  private async run<T>(fn: (db: IDBPDatabase<Schema>) => Promise<T>): Promise<T> {
    const db = await this.dbp;
    try {
      return await fn(db);
    } catch (e) {
      throw explainStorageError(e);
    }
  }
  async listBills() {
    return this.run(async (db) => (await db.getAll('bills')).map(migrateBill).filter(alive));
  }
  async getBill(id: string) {
    return this.run(async (db) => {
      const b = await db.get('bills', id);
      return b && !b.deletedAt ? migrateBill(b) : undefined;
    });
  }
  async putBill(b: Bill) {
    await this.run(async (db) => {
      const tx = db.transaction('bills', 'readwrite');
      await putLocal(tx, 'bills', b);
      await tx.done;
    });
    this.changed();
  }
  async deleteBill(id: string) {
    await this.run(async (db) => {
      const tx = db.transaction(['bills', 'images'], 'readwrite');
      const b = await tx.objectStore('bills').get(id);
      if (b) {
        const imageId = b.ocrReview?.imageId;
        // 墓碑：保留 id 与时间，清除内容，便于未来同步删除
        await putLocal(tx, 'bills', { ...b, items: [], notes: '', ocrReview: null, paymentCode: '', deletedAt: nowISO(), updatedAt: nowISO() });
        if (imageId) await tx.objectStore('images').delete(imageId);
        if (b.ocrReview?.originalImageId) await tx.objectStore('images').delete(b.ocrReview.originalImageId);
        for (const p of b.payments ?? []) if (p.receiptImageId) await tx.objectStore('images').delete(p.receiptImageId);
      }
      await tx.done;
    });
    this.changed();
  }
  async listMerchants() {
    return this.run(async (db) => (await db.getAll('merchants')).filter(alive));
  }
  async putMerchant(m: Merchant) {
    await this.run(async (db) => {
      const tx = db.transaction('merchants', 'readwrite');
      await putLocal(tx, 'merchants', m);
      await tx.done;
    });
    this.changed();
  }
  async deleteMerchant(id: string) {
    await this.run(async (db) => {
      const tx = db.transaction('merchants', 'readwrite');
      const m = await tx.objectStore('merchants').get(id);
      if (m) await putLocal(tx, 'merchants', { ...m, active: false, deletedAt: nowISO(), updatedAt: nowISO() });
      await tx.done;
    });
    this.changed();
  }
  async listAccounts() {
    return this.run(async (db) => (await db.getAll('accounts')).filter(alive));
  }
  async putAccount(a: PaymentAccount) {
    await this.run(async (db) => {
      const tx = db.transaction('accounts', 'readwrite');
      await putLocal(tx, 'accounts', a);
      await tx.done;
    });
    this.changed();
  }
  async deleteAccount(id: string) {
    await this.run(async (db) => {
      const tx = db.transaction('accounts', 'readwrite');
      const a = await tx.objectStore('accounts').get(id);
      if (a) await putLocal(tx, 'accounts', { ...a, active: false, optionalPixHint: '', deletedAt: nowISO(), updatedAt: nowISO() });
      await tx.done;
    });
    this.changed();
  }
  async getSettings() {
    return this.run(async (db) => ({ ...defaultSettings(), ...((await db.get('settings', 'settings')) ?? {}) }));
  }
  async putSettings(s: Settings) {
    await this.run((db) => db.put('settings', { ...s, updatedAt: nowISO() }));
    this.changed();
  }
  async putImage(blob: Blob) {
    const id = uuid();
    await this.run((db) => db.put('images', { id, blob, createdAt: nowISO() }));
    return id;
  }
  async getImage(id: string) {
    return this.run(async (db) => (await db.get('images', id))?.blob);
  }
  async deleteImage(id: string) {
    await this.run((db) => db.delete('images', id));
  }
  async getDraft() {
    return this.run((db) => db.get('drafts', 'current'));
  }
  async putDraft(d: Omit<Draft, 'id' | 'savedAt'>) {
    await this.run((db) => db.put('drafts', { ...d, id: 'current', savedAt: nowISO() }));
  }
  async clearDraft() {
    await this.run((db) => db.delete('drafts', 'current'));
  }
  async exportAll(): Promise<DataSet> {
    return this.run(async (db) => ({
      bills: (await db.getAll('bills')).map(migrateBill),
      merchants: await db.getAll('merchants'),
      accounts: await db.getAll('accounts'),
    }));
  }
  async replaceAll(data: DataSet) {
    await this.run(async (db) => {
      const tx = db.transaction(['bills', 'merchants', 'accounts'], 'readwrite');
      await Promise.all([tx.objectStore('bills').clear(), tx.objectStore('merchants').clear(), tx.objectStore('accounts').clear()]);
      for (const b of data.bills) await tx.objectStore('bills').put(b);
      for (const m of data.merchants) await tx.objectStore('merchants').put(m);
      for (const a of data.accounts) await tx.objectStore('accounts').put(a);
      await tx.done;
    });
    this.changed();
  }
  async upsertMany(data: Partial<DataSet>) {
    await this.run(async (db) => {
      const tx = db.transaction(['bills', 'merchants', 'accounts'], 'readwrite');
      for (const b of data.bills ?? []) await putLocal(tx, 'bills', b);
      for (const m of data.merchants ?? []) await putLocal(tx, 'merchants', m);
      for (const a of data.accounts ?? []) await putLocal(tx, 'accounts', a);
      await tx.done;
    });
    this.changed();
  }
  /**
   * 同步下载写入：原样保存，不触发 onWrite（避免把刚下载的数据又当成本地改动）。
   * 写入前再读一次：下载期间本机刚保存的更新版本不能被覆盖。
   */
  async applyRemote(data: Partial<DataSet>) {
    await this.run(async (db) => {
      const tx = db.transaction(['bills', 'merchants', 'accounts'], 'readwrite');
      const put = async (store: 'bills' | 'merchants' | 'accounts', rec: any) => {
        const os = tx.objectStore(store);
        const cur: any = await os.get(rec.id);
        if (cur && cur.updatedAt && rec.updatedAt && cur.updatedAt >= rec.updatedAt) return;
        await os.put(rec);
      };
      for (const b of data.bills ?? []) await put('bills', b);
      for (const m of data.merchants ?? []) await put('merchants', m);
      for (const a of data.accounts ?? []) await put('accounts', a);
      await tx.done;
    });
  }
  async markSynced(entries: { kind: 'bill' | 'merchant' | 'account'; id: string; updatedAt: string }[]) {
    if (!entries.length) return;
    const store = { bill: 'bills', merchant: 'merchants', account: 'accounts' } as const;
    await this.run(async (db) => {
      const tx = db.transaction(['bills', 'merchants', 'accounts'], 'readwrite');
      for (const e of entries) {
        const os = tx.objectStore(store[e.kind]);
        const cur: any = await os.get(e.id);
        if (cur && cur.updatedAt === e.updatedAt && cur._syncedAt !== e.updatedAt) await os.put({ ...cur, _syncedAt: e.updatedAt });
      }
      await tx.done;
    });
  }
  async exportRaw(): Promise<DataSet> {
    return this.run(async (db) => ({
      bills: await db.getAll('bills'),
      merchants: await db.getAll('merchants'),
      accounts: await db.getAll('accounts'),
    }));
  }
  async tombstone(filter: (kind: 'bill' | 'merchant' | 'account', id: string) => boolean = () => true) {
    const t = nowISO();
    let n = 0;
    await this.run(async (db) => {
      const tx = db.transaction(['bills', 'merchants', 'accounts', 'images'], 'readwrite');
      for (const b of await tx.objectStore('bills').getAll()) {
        if (b.deletedAt || !filter('bill', b.id)) continue;
        if (b.ocrReview?.imageId) await tx.objectStore('images').delete(b.ocrReview.imageId);
        if (b.ocrReview?.originalImageId) await tx.objectStore('images').delete(b.ocrReview.originalImageId);
        for (const p of b.payments ?? []) if (p.receiptImageId) await tx.objectStore('images').delete(p.receiptImageId);
        await tx.objectStore('bills').put({ ...b, items: [], notes: '', ocrReview: null, paymentCode: '', deletedAt: t, updatedAt: laterThan(b.updatedAt, t) });
        n++;
      }
      for (const m of await tx.objectStore('merchants').getAll()) {
        if (m.deletedAt || !filter('merchant', m.id)) continue;
        await tx.objectStore('merchants').put({ ...m, active: false, deletedAt: t, updatedAt: laterThan(m.updatedAt, t) });
        n++;
      }
      for (const a of await tx.objectStore('accounts').getAll()) {
        if (a.deletedAt || !filter('account', a.id)) continue;
        await tx.objectStore('accounts').put({ ...a, active: false, optionalPixHint: '', deletedAt: t, updatedAt: laterThan(a.updatedAt, t) });
        n++;
      }
      await tx.done;
    });
    if (n) this.changed();
    return n;
  }
  async getMeta<T = unknown>(key: string): Promise<T | undefined> {
    return this.run(async (db) => (await db.get('meta', key))?.value as T | undefined);
  }
  async setMeta(key: string, value: unknown) {
    await this.run((db) => db.put('meta', { key, value }));
  }
  async clearAll() {
    await this.run(async (db) => {
      const names = ['bills', 'merchants', 'accounts', 'images', 'drafts'] as const;
      const tx = db.transaction([...names], 'readwrite');
      await Promise.all(names.map((n) => tx.objectStore(n).clear()));
      await tx.done;
    });
  }
}

export async function storageInfo(): Promise<{ usage: number; quota: number; persisted: boolean } | null> {
  try {
    if (!navigator.storage?.estimate) return null;
    const e = await navigator.storage.estimate();
    const persisted = (await navigator.storage.persisted?.()) ?? false;
    return { usage: e.usage ?? 0, quota: e.quota ?? 0, persisted };
  } catch {
    return null;
  }
}

export async function requestPersist(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
