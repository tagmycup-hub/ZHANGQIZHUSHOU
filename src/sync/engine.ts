/**
 * Supabase 云同步（与「进货价格本」相同的使用方式：Project URL + publishable key，
 * 数据存本机并同步到云端；上传改动 / 下载合并 / 改动后自动同步 / 复制配置到别的设备）。
 *
 * 数据库端只开放 3 个 RPC（见 supabase/setup.sql），每个同步空间有自己的口令。
 * 冲突规则：同一条记录以 updatedAt 较新者为准；删除用墓碑（deletedAt）同步。
 * 票据图片不上传（只在拍摄的设备上）。
 */
import type { Repository } from '../db/repo';
import type { Bill, Merchant, PaymentAccount, Settings } from '../lib/types';
import { isSampleId } from '../sample';

export interface SyncConfig {
  url: string;
  key: string;
  space: string;
  secret: string;
  auto: boolean;
  /** 账号模式：数据存在登录用户自己的空间（不需要空间名和口令） */
  account?: boolean;
  /** 账号模式下本次请求用的登录令牌（不保存） */
  bearer?: string;
}

export interface SyncState {
  cursor: number;
  lastPushAt: string;
  lastSyncAt: string | null;
  settingsHash: string;
  settingsAt: string;
}

export const EMPTY_STATE: SyncState = { cursor: 0, lastPushAt: '1970-01-01T00:00:00.000Z', lastSyncAt: null, settingsHash: '', settingsAt: '1970-01-01T00:00:00.000Z' };

export type Kind = 'bill' | 'merchant' | 'account' | 'settings';

export interface RemoteRow {
  kind: Kind;
  id: string;
  data: any;
  updated_at: string;
  deleted: boolean;
  seq?: number;
}

/** 参与同步的设置项（口令、通知记录等本机设置不同步） */
export const SYNC_SETTING_KEYS = ['defaultReminderDays', 'dueSoonDays', 'defaultMerchantId', 'defaultAccountId', 'monthlyBudgetCents', 'recognizeFn'] as const;

export class SyncError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function normalizeUrl(u: string): string {
  let s = u.trim().replace(/\/+$/, '');
  if (s && !/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/\/rest\/v1$/, '');
}

export function configProblem(c: Partial<SyncConfig> | null | undefined): string | null {
  if (!c?.url || !/^https?:\/\/[^/]+/.test(normalizeUrl(c.url))) return '请填写 Project URL（形如 https://xxxx.supabase.co）';
  if (!c.key || c.key.trim().length < 20) return '请填写 publishable key（Settings → API Keys）';
  if (c.account) return null;
  if (!c.space || c.space.trim().length < 6) return '同步空间名至少 6 个字符';
  if (!c.secret || c.secret.length < 12) return '同步口令至少 12 个字符';
  return null;
}

function randomString(n: number, alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map((x) => alphabet[x % alphabet.length]).join('');
}

export const newSpace = () => `zq-${randomString(10, 'abcdefghijkmnopqrstuvwxyz23456789')}`;
export const newSecret = () => randomString(24);

const PREFIX = 'ZQSYNC1:';
export function encodeConfig(c: SyncConfig): string {
  const json = JSON.stringify({ u: normalizeUrl(c.url), k: c.key.trim(), s: c.space, p: c.secret });
  return PREFIX + btoa(String.fromCharCode(...new TextEncoder().encode(json)));
}
export function decodeConfig(text: string): SyncConfig {
  const t = text.trim();
  const i = t.indexOf(PREFIX);
  if (i < 0) throw new SyncError('bad_config', '不是账期助手的同步配置（应以 ZQSYNC1: 开头）');
  try {
    const raw = atob(t.slice(i + PREFIX.length).split(/\s/)[0]);
    const j = JSON.parse(new TextDecoder().decode(Uint8Array.from(raw, (ch) => ch.charCodeAt(0))));
    const c: SyncConfig = { url: j.u, key: j.k, space: j.s, secret: j.p, auto: true };
    const p = configProblem(c);
    if (p) throw new Error(p);
    return c;
  } catch (e: any) {
    throw new SyncError('bad_config', `同步配置无法识别：${e?.message ?? e}`);
  }
}

const ERR: [RegExp, string, string][] = [
  [/ZQ_LOGIN|JWT expired/i, 'login', '登录已过期，请重新登录（设置 → 账号）'],
  [/ZQ_BAD_SECRET/, 'bad_secret', '同步口令不正确（和别的设备上的不一致）'],
  [/ZQ_NO_SPACE/, 'no_space', '云端还没有这个同步空间'],
  [/ZQ_BAD_INPUT/, 'bad_input', '同步空间名或口令太短'],
  [/ZQ_BAD_ROWS/, 'bad_rows', '上传的数据格式不正确'],
  [/PGRST202|Could not find the function|function .* does not exist/i, 'no_setup', '数据库还没初始化：请先在 Supabase 的 SQL Editor 运行建表脚本'],
  [/Invalid API key|No API key|JWT|apikey/i, 'bad_key', 'publishable key 不正确'],
];

export async function rpc<T>(cfg: Pick<SyncConfig, 'url' | 'key' | 'bearer'>, fn: string, args: Record<string, unknown>, fetchImpl: FetchLike = fetch): Promise<T> {
  let r: Response;
  try {
    r = await fetchImpl(`${normalizeUrl(cfg.url)}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: cfg.key.trim(), authorization: `Bearer ${(cfg as SyncConfig).bearer || cfg.key.trim()}` },
      body: JSON.stringify(args),
    });
  } catch {
    throw new SyncError('network', typeof navigator !== 'undefined' && navigator.onLine === false ? '当前离线，联网后会自动同步' : '连不上 Supabase（检查 Project URL 或网络）');
  }
  const text = await r.text();
  if (!r.ok) {
    let msg = text;
    try {
      const j = JSON.parse(text);
      msg = [j.message, j.code, j.hint, j.details].filter(Boolean).join(' ');
    } catch {}
    if ((cfg as SyncConfig).bearer && (r.status === 401 || r.status === 403) && !/ZQ_/.test(msg)) throw new SyncError('login', '登录已过期，请重新登录（设置 → 账号）');
    for (const [re, code, zh] of ERR) if (re.test(msg)) throw new SyncError(code, zh);
    if (r.status === 401 || r.status === 403) throw new SyncError('bad_key', 'publishable key 不正确或没有权限');
    if (r.status === 404) throw new SyncError('bad_url', 'Project URL 不正确');
    throw new SyncError('server', `Supabase 返回错误（${r.status}）：${msg.slice(0, 120)}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

export interface SpaceStatus {
  exists: boolean;
  count: number;
  cursor: number;
}

export function testConnection(cfg: SyncConfig, fetchImpl: FetchLike = fetch) {
  if (cfg.account) return rpc<SpaceStatus>(cfg, 'zq_me_status', {}, fetchImpl);
  return rpc<SpaceStatus>(cfg, 'zq_status', { p_space: cfg.space, p_secret: cfg.secret }, fetchImpl);
}

const ts = (s: string | null | undefined) => (s ? Date.parse(s) : 0);

function settingsSubset(s: Settings) {
  const o: Record<string, unknown> = {};
  for (const k of SYNC_SETTING_KEYS) o[k] = s[k] ?? null;
  return o;
}
function hashOf(o: unknown) {
  return JSON.stringify(o);
}

export interface SyncResult {
  pulled: number;
  applied: number;
  pushed: number;
  state: SyncState;
}

type Local = { bill: Map<string, Bill>; merchant: Map<string, Merchant>; account: Map<string, PaymentAccount> };

async function loadLocal(repo: Repository): Promise<Local> {
  const raw = await repo.exportRaw();
  return {
    bill: new Map(raw.bills.map((b) => [b.id, b])),
    merchant: new Map(raw.merchants.map((m) => [m.id, m])),
    account: new Map(raw.accounts.map((a) => [a.id, a])),
  };
}

export async function pull(repo: Repository, cfg: SyncConfig, state: SyncState, fetchImpl: FetchLike = fetch): Promise<{ pulled: number; applied: number; state: SyncState }> {
  const local = await loadLocal(repo);
  // 往回多取一点：并发上传时较小的 seq 可能晚提交，避免永远漏掉（重复的行会因时间不新而跳过）
  let cursor = Math.max(0, state.cursor - 100);
  let pulled = 0;
  let applied = 0;
  let st = { ...state };
  for (let page = 0; page < 200; page++) {
    let rows: RemoteRow[];
    try {
      rows = cfg.account
        ? await rpc<RemoteRow[]>(cfg, 'zq_me_pull', { p_since: cursor, p_limit: 500 }, fetchImpl)
        : await rpc<RemoteRow[]>(cfg, 'zq_pull', { p_space: cfg.space, p_secret: cfg.secret, p_since: cursor, p_limit: 500 }, fetchImpl);
    } catch (e) {
      if (e instanceof SyncError && e.code === 'no_space') break; // 云端还是空的
      throw e;
    }
    if (!rows?.length) break;
    pulled += rows.length;
    const bills: Bill[] = [];
    const merchants: Merchant[] = [];
    const accounts: PaymentAccount[] = [];
    for (const r of rows) {
      cursor = Math.max(cursor, Number(r.seq ?? 0));
      if (isSampleId(r.id) || !r.data || typeof r.data !== 'object') continue;
      const remoteAt = ts(r.updated_at);
      if (r.kind === 'settings') {
        if (remoteAt > ts(st.settingsAt)) {
          const cur = await repo.getSettings();
          // 逐项合并：本机自上次同步后改过的项保留本机值（稍后上传），其余采用云端
          let base: Record<string, unknown> = {};
          try {
            base = st.settingsHash ? JSON.parse(st.settingsHash) : {};
          } catch {}
          const localSub = settingsSubset(cur);
          const patch: Record<string, unknown> = {};
          const remoteSub: Record<string, unknown> = {};
          for (const k of SYNC_SETTING_KEYS) {
            if (!(k in r.data)) continue;
            remoteSub[k] = r.data[k] ?? null;
            const dirty = st.settingsHash ? JSON.stringify(localSub[k] ?? null) !== JSON.stringify(base[k] ?? null) : false;
            if (!dirty) patch[k] = r.data[k];
          }
          const next = { ...cur, ...patch } as Settings;
          const cb = repo.onWrite;
          repo.onWrite = null;
          try {
            await repo.putSettings(next);
          } finally {
            repo.onWrite = cb;
          }
          // 基准记为云端值：若本机有保留的改动，哈希不同就会在 push 时上传
          st = { ...st, settingsAt: r.updated_at, settingsHash: hashOf({ ...settingsSubset(next), ...remoteSub }) };
          applied++;
        }
        continue;
      }
      const map = local[r.kind as 'bill' | 'merchant' | 'account'];
      if (!map) continue;
      const cur = map.get(r.id);
      if (cur && ts(cur.updatedAt) >= remoteAt) continue;
      const updatedAt = r.data.updatedAt ?? r.updated_at;
      const rec = { ...r.data, id: r.id, updatedAt, _syncedAt: updatedAt };
      if (r.deleted && !rec.deletedAt) rec.deletedAt = r.updated_at;
      map.set(r.id, rec);
      if (r.kind === 'bill') bills.push(rec);
      else if (r.kind === 'merchant') merchants.push(rec);
      else accounts.push(rec);
      applied++;
    }
    if (bills.length || merchants.length || accounts.length) await repo.applyRemote({ bills, merchants, accounts });
    if (rows.length < 500) break;
  }
  st = { ...st, cursor };
  return { pulled, applied, state: st };
}

export async function push(repo: Repository, cfg: SyncConfig, state: SyncState, opts: { force?: boolean } = {}, fetchImpl: FetchLike = fetch): Promise<{ pushed: number; state: SyncState }> {
  const raw = await repo.exportRaw();
  const rows: RemoteRow[] = [];
  const marks: { kind: 'bill' | 'merchant' | 'account'; id: string; updatedAt: string }[] = [];
  const add = (kind: 'bill' | 'merchant' | 'account', r: { id: string; updatedAt: string; deletedAt?: string | null; _syncedAt?: string }) => {
    const at = ts(r.updatedAt);
    if (isSampleId(r.id) || !at) return;
    // 本机改动的记录 updatedAt 与上次同步值不同（跟设备时钟无关）
    if (!opts.force && r._syncedAt === r.updatedAt) return;
    const { _syncedAt: _s, ...data } = r;
    rows.push({ kind, id: r.id, data, updated_at: new Date(at).toISOString(), deleted: !!r.deletedAt });
    marks.push({ kind, id: r.id, updatedAt: r.updatedAt });
  };
  raw.bills.forEach((b) => add('bill', b));
  raw.merchants.forEach((m) => add('merchant', m));
  raw.accounts.forEach((a) => add('account', a));
  let st = { ...state };
  const settings = await repo.getSettings();
  const subset = settingsSubset(settings);
  const h = hashOf(subset);
  const sampleDefaults = Object.values(subset).some((v) => typeof v === 'string' && isSampleId(v));
  let settingsRow: RemoteRow | null = null;
  if ((opts.force || h !== state.settingsHash) && !sampleDefaults) {
    const at = new Date(Math.max(Date.now(), ts(state.settingsAt) + 1)).toISOString();
    settingsRow = { kind: 'settings', id: 'settings', data: { ...subset, updatedAt: at }, updated_at: at, deleted: false };
    rows.push(settingsRow);
  }
  for (let i = 0; i < rows.length; i += 300) {
    if (cfg.account) await rpc(cfg, 'zq_me_push', { p_rows: rows.slice(i, i + 300) }, fetchImpl);
    else await rpc(cfg, 'zq_push', { p_space: cfg.space, p_secret: cfg.secret, p_rows: rows.slice(i, i + 300) }, fetchImpl);
  }
  await repo.markSynced(marks);
  if (settingsRow) st = { ...st, settingsHash: h, settingsAt: settingsRow.updated_at };
  if (rows.length) st = { ...st, lastPushAt: new Date().toISOString() };
  return { pushed: rows.length, state: st };
}

/** 完整同步：先下载合并，再上传本机改动 */
export async function syncOnce(repo: Repository, cfg: SyncConfig, state: SyncState, opts: { mode?: 'both' | 'pull' | 'push'; force?: boolean; fetchImpl?: FetchLike } = {}): Promise<SyncResult> {
  const f = opts.fetchImpl ?? fetch;
  const mode = opts.mode ?? 'both';
  let st = state;
  let pulled = 0;
  let applied = 0;
  let pushed = 0;
  if (mode !== 'push') {
    const r = await pull(repo, cfg, st, f);
    st = r.state;
    pulled = r.pulled;
    applied = r.applied;
  }
  if (mode !== 'pull') {
    const r = await push(repo, cfg, st, { force: opts.force }, f);
    st = r.state;
    pushed = r.pushed;
  }
  return { pulled, applied, pushed, state: { ...st, lastSyncAt: new Date().toISOString() } };
}

export const META_CONFIG = 'sync.config';
export const META_STATE = 'sync.state';
