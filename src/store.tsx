import { isBackNav, onHashChange, onReplace } from './nav';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { IndexedDbRepository, StorageError, explainStorageError, type Repository } from './db/repo';
import type { Bill, Merchant, PaymentAccount, Settings } from './lib/types';
import { defaultSettings } from './lib/types';
import { todayISO } from './lib/dates';
import { makeSampleData, isSampleId } from './sample';
import { syncOnce, SyncError, EMPTY_STATE, META_CONFIG, META_STATE, configProblem, type SyncConfig, type SyncState, type SyncResult } from './sync/engine';
import { loadPublicConfig, type PublicConfig } from './cloud/config';
import { needsRefresh, refreshSession, signOutRemote, AuthError, type Session } from './cloud/auth';
import { getAccount, type AccountInfo } from './cloud/api';
import { entitlement, type Entitlement } from '../shared/plans.mjs';
import type { SupaTarget } from './lib/ocr/providers';

export const META_SESSION = 'auth.session';
export const META_ACCOUNT = 'auth.account';

export type Feature = 'edit' | 'push' | 'export';
export interface Gate {
  /** 账号版（公开部署或已登录）；本地版（自用、未配置）所有功能都开 */
  saas: boolean;
  canEdit: boolean;
  canPush: boolean;
  canExport: boolean;
  /** 试用结束且没有订阅 */
  readOnly: boolean;
}

export interface AuthInfo {
  session: Session | null;
  account: AccountInfo | null;
  /** 账号信息加载错误（例如函数还没升级） */
  error: string | null;
}

export interface SyncInfo {
  config: SyncConfig | null;
  status: 'off' | 'idle' | 'syncing' | 'ok' | 'error';
  lastAt: string | null;
  error: string | null;
  last: { pulled: number; applied: number; pushed: number } | null;
}

export type Route =
  | { name: 'home' }
  | { name: 'bills'; filter?: string }
  | { name: 'new'; kind?: 'expense' }
  | { name: 'edit'; id: string }
  | { name: 'copy'; id: string }
  | { name: 'capture' }
  | { name: 'review' }
  | { name: 'masters' }
  | { name: 'settings' }
  | { name: 'data' }
  | { name: 'account' }
  | { name: 'flow'; month?: string };

export function parseHash(h: string): Route {
  const p = h.replace(/^#\/?/, '').split('/');
  switch (p[0]) {
    case 'bills':
      return { name: 'bills', filter: p[1] };
    case 'new':
      return p[1] === 'expense' ? { name: 'new', kind: 'expense' } : { name: 'new' };
    case 'edit':
      return p[1] ? { name: 'edit', id: decodeURIComponent(p[1]) } : { name: 'bills' };
    case 'copy':
      return p[1] ? { name: 'copy', id: decodeURIComponent(p[1]) } : { name: 'bills' };
    case 'capture':
      return { name: 'capture' };
    case 'review':
      return { name: 'review' };
    case 'masters':
      return { name: 'masters' };
    case 'settings':
      return { name: 'settings' };
    case 'data':
      return { name: 'data' };
    case 'account':
      return { name: 'account' };
    case 'flow':
      return { name: 'flow', month: /^\d{4}-\d{2}$/.test(p[1] ?? '') ? p[1] : undefined };
    default:
      return { name: 'home' };
  }
}

export function routeHash(r: Route): string {
  switch (r.name) {
    case 'bills':
      return `#/bills${r.filter ? '/' + r.filter : ''}`;
    case 'flow':
      return `#/flow${r.month ? '/' + r.month : ''}`;
    case 'edit':
      return `#/edit/${encodeURIComponent(r.id)}`;
    case 'copy':
      return `#/copy/${encodeURIComponent(r.id)}`;
    case 'new':
      return r.kind ? `#/new/${r.kind}` : '#/new';
    case 'home':
      return '#/';
    default:
      return `#/${r.name}`;
  }
}

interface Store {
  ready: boolean;
  fatal: StorageError | null;
  repo: Repository;
  bills: Bill[];
  merchants: Merchant[];
  accounts: PaymentAccount[];
  settings: Settings;
  today: string;
  route: Route;
  go(r: Route, replace?: boolean): void;
  back(): void;
  reload(): Promise<void>;
  saveSettings(patch: Partial<Settings>): Promise<void>;
  /** 捕获存储异常并给出可执行提示 */
  guard<T>(fn: () => Promise<T>): Promise<T | undefined>;
  storageError: StorageError | null;
  hasSample: boolean;
  clearSample(): Promise<void>;
  sync: SyncInfo;
  syncNow(opts?: { mode?: 'both' | 'pull' | 'push'; force?: boolean }): Promise<SyncResult | null>;
  saveSyncConfig(cfg: SyncConfig | null, opts?: { resetState?: boolean }): Promise<void>;
  /** 网站根目录 zq-config.json（公开部署时） */
  publicConfig: PublicConfig | null;
  /** AI 识别 / 账号使用的 Supabase 项目（登录项目 → 公开配置 → 同步配置） */
  cloud: SupaTarget | null;
  auth: AuthInfo;
  /** 当前登录令牌（自动续期）；未登录为 null */
  getToken(): Promise<string | null>;
  signIn(session: Session): Promise<void>;
  signOut(): Promise<void>;
  refreshAccount(): Promise<AccountInfo | null>;
  /** 当前权限（按日期实时计算，离线也有效） */
  ent: Entitlement | null;
  gate: Gate;
  /** 没有权限时弹出订阅说明并返回 false */
  requireFeature(f: Feature): boolean;
  paywall: Feature | null;
  closePaywall(): void;
}

const Ctx = createContext<Store>(null as any);
export const useStore = () => useContext(Ctx);

export function StoreProvider({ children }: { children: ReactNode }) {
  const repo = useMemo(() => new IndexedDbRepository(), []);
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<StorageError | null>(null);
  const [storageError, setStorageError] = useState<StorageError | null>(null);
  const [bills, setBills] = useState<Bill[]>([]);
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [accounts, setAccounts] = useState<PaymentAccount[]>([]);
  const [settings, setSettings] = useState<Settings>(defaultSettings());
  const [today, setToday] = useState(todayISO());
  const [route, setRoute] = useState<Route>(() => {
    if (typeof location === 'undefined') return { name: 'home' };
    // 从 Mercado Pago 付款页返回（?mp=1）：打开账号页刷新套餐
    if (new URLSearchParams(location.search).has('mp')) {
      history.replaceState(null, '', location.pathname + location.search + '#/account');
      return { name: 'account' };
    }
    return parseHash(location.hash);
  });
  const depth = useRef(0);
  const [sync, setSync] = useState<SyncInfo>({ config: null, status: 'off', lastAt: null, error: null, last: null });
  const syncCfg = useRef<SyncConfig | null>(null);
  const syncState = useRef<SyncState>(EMPTY_STATE);
  const syncBusy = useRef<Promise<SyncResult | null> | null>(null);
  const syncAgain = useRef(false);
  const syncAgainForce = useRef(false);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [publicConfig, setPublicConfig] = useState<PublicConfig | null>(null);
  const [auth, setAuth] = useState<AuthInfo>({ session: null, account: null, error: null });
  const sessionRef = useRef<Session | null>(null);
  const refreshing = useRef<Promise<Session | null> | null>(null);

  const reload = useCallback(async () => {
    const [b, m, a, s] = await Promise.all([repo.listBills(), repo.listMerchants(), repo.listAccounts(), repo.getSettings()]);
    setBills(b);
    setMerchants(m);
    setAccounts(a);
    setSettings(s);
    setToday(todayISO());
  }, [repo]);

  useEffect(() => {
    (async () => {
      try {
        let first = false;
        try {
          first = !localStorage.getItem('zq.seeded');
        } catch {
          first = false;
        }
        if (first) {
          const existing = await repo.listBills();
          if (!existing.length && !(await repo.listMerchants()).length) {
            const s = makeSampleData(todayISO());
            await repo.upsertMany(s);
            const st = await repo.getSettings();
            await repo.putSettings({ ...st, defaultAccountId: s.accounts[0].id });
          }
          try {
            localStorage.setItem('zq.seeded', '1');
          } catch {}
        }
        await reload();
        void loadPublicConfig().then(setPublicConfig);
        const sess = await repo.getMeta<Session>(META_SESSION);
        if (sess?.accessToken && sess.user?.id) {
          sessionRef.current = sess;
          const cached = await repo.getMeta<AccountInfo>(META_ACCOUNT);
          setAuth({ session: sess, account: cached && cached.email === sess.user.email ? cached : null, error: null });
        }
        const cfg = await repo.getMeta<SyncConfig>(META_CONFIG);
        if (cfg && !configProblem(cfg)) {
          syncCfg.current = cfg;
          syncState.current = { ...EMPTY_STATE, ...((await repo.getMeta<SyncState>(META_STATE)) ?? {}) };
          setSync({ config: cfg, status: 'idle', lastAt: syncState.current.lastSyncAt, error: null, last: null });
        }
      } catch (e) {
        setFatal(explainStorageError(e));
      } finally {
        setReady(true);
      }
    })();
  }, [repo, reload]);

  // 返回首页/账单列表时回到原来的滚动位置
  const scrollMem = useRef(new Map<string, number>());
  const lastHash = useRef(typeof location === 'undefined' ? '' : location.hash);
  useEffect(() => {
    const on = () => {
      scrollMem.current.set(lastHash.current, window.scrollY);
      lastHash.current = location.hash;
      onHashChange(location.hash);
      const r = parseHash(location.hash);
      setRoute(r);
      const y = isBackNav() && (r.name === 'home' || r.name === 'bills') ? scrollMem.current.get(location.hash) ?? 0 : 0;
      window.scrollTo({ top: 0 });
      if (y) requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo({ top: y })));
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  // 跨午夜刷新"今天"
  useEffect(() => {
    const t = setInterval(() => setToday(todayISO()), 30_000);
    return () => clearInterval(t);
  }, []);

  const go = useCallback((r: Route, replace = false) => {
    const h = routeHash(r);
    if (replace) {
      history.replaceState(null, '', h);
      onReplace(h);
      lastHash.current = h;
      setRoute(r);
      window.scrollTo({ top: 0 });
    } else {
      depth.current++;
      location.hash = h;
    }
  }, []);

  const back = useCallback(() => {
    if (depth.current > 0) {
      depth.current--;
      history.back();
    } else go({ name: 'home' }, true);
  }, [go]);

  const guard = useCallback(async <T,>(fn: () => Promise<T>) => {
    try {
      const r = await fn();
      setStorageError(null);
      return r;
    } catch (e) {
      setStorageError(explainStorageError(e));
      return undefined;
    }
  }, []);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const saveSettings = useCallback(
    async (patch: Partial<Settings>) => {
      const next = { ...settingsRef.current, ...patch };
      settingsRef.current = next;
      setSettings(next);
      // 以数据库里的最新值为底合并（提醒模块会直接写已通知签名，不能被旧值覆盖）
      await guard(async () => {
        const fresh = await repo.getSettings();
        const merged = { ...fresh, ...patch };
        if (!('notifiedSignatures' in patch)) merged.notifiedSignatures = fresh.notifiedSignatures;
        await repo.putSettings(merged);
      });
    },
    [repo, guard],
  );

  const hasSample = bills.some((b) => isSampleId(b.id)) || merchants.some((m) => isSampleId(m.id));

  const clearSample = useCallback(async () => {
    await guard(async () => {
      await repo.tombstone((_k, id) => isSampleId(id));
      const s = await repo.getSettings();
      await repo.putSettings({
        ...s,
        defaultAccountId: s.defaultAccountId && isSampleId(s.defaultAccountId) ? null : s.defaultAccountId,
        defaultMerchantId: s.defaultMerchantId && isSampleId(s.defaultMerchantId) ? null : s.defaultMerchantId,
      });
      await reload();
    });
  }, [repo, guard, reload]);

  const getToken = useCallback(async (): Promise<string | null> => {
    const s = sessionRef.current;
    if (!s) return null;
    if (!needsRefresh(s)) return s.accessToken;
    if (!refreshing.current) {
      refreshing.current = (async () => {
        try {
          const n = await refreshSession(s);
          sessionRef.current = n;
          await repo.setMeta(META_SESSION, n);
          setAuth((a) => ({ ...a, session: n }));
          return n;
        } catch (e) {
          // 网络问题：先用旧令牌；令牌失效：退出登录状态（本机数据保留）
          if (e instanceof AuthError && e.code === 'session_expired') {
            sessionRef.current = null;
            await repo.setMeta(META_SESSION, null);
            setAuth({ session: null, account: null, error: '登录已过期，请重新登录' });
            return null;
          }
          return s;
        } finally {
          refreshing.current = null;
        }
      })();
    }
    return (await refreshing.current)?.accessToken ?? null;
  }, [repo]);

  const syncNow = useCallback(
    async (opts: { mode?: 'both' | 'pull' | 'push'; force?: boolean } = {}): Promise<SyncResult | null> => {
      let cfg = syncCfg.current;
      if (!cfg) return null;
      if (cfg.account) {
        const token = await getToken();
        if (!token) {
          setSync((x) => ({ ...x, status: 'error', error: '登录已过期，请重新登录（设置 → 账号）' }));
          return null;
        }
        cfg = { ...cfg, bearer: token };
        // 只读（试用结束未订阅）：只下载，不上传
        if (gateRef.current.readOnly) opts = { ...opts, mode: 'pull' };
      }
      if (syncBusy.current) {
        // 正在同步：排队一次，保留「强制全量」等选项
        syncAgain.current = true;
        if (opts.force) syncAgainForce.current = true;
        return syncBusy.current;
      }
      const job = (async () => {
        setSync((x) => ({ ...x, status: 'syncing', error: null }));
        try {
          const r = await syncOnce(repo, cfg!, syncState.current, opts);
          syncState.current = r.state;
          await repo.setMeta(META_STATE, r.state);
          setSync((x) => ({ ...x, status: 'ok', lastAt: r.state.lastSyncAt, error: null, last: { pulled: r.pulled, applied: r.applied, pushed: r.pushed } }));
          if (r.applied > 0) await reload();
          return r;
        } catch (e) {
          const msg = e instanceof SyncError ? e.message : `同步失败：${(e as Error)?.message ?? e}`;
          setSync((x) => ({ ...x, status: 'error', error: msg }));
          return null;
        }
      })();
      syncBusy.current = job;
      try {
        return await job;
      } finally {
        syncBusy.current = null;
        if (syncAgain.current) {
          const force = syncAgainForce.current;
          syncAgain.current = false;
          syncAgainForce.current = false;
          setTimeout(() => void syncNow({ mode: 'both', force }), 300);
        }
      }
    },
    [repo, reload, getToken],
  );

  const saveSyncConfig = useCallback(
    async (cfg: SyncConfig | null, opts: { resetState?: boolean } = {}) => {
      if (cfg) {
        const { bearer: _b, ...plain } = cfg;
        cfg = plain;
      }
      syncCfg.current = cfg;
      await repo.setMeta(META_CONFIG, cfg);
      if (!cfg || opts.resetState) {
        syncState.current = EMPTY_STATE;
        await repo.setMeta(META_STATE, EMPTY_STATE);
      }
      setSync({ config: cfg, status: cfg ? 'idle' : 'off', lastAt: cfg && !opts.resetState ? syncState.current.lastSyncAt : null, error: null, last: null });
    },
    [repo],
  );

  // 改动后自动同步（防抖）
  useEffect(() => {
    repo.onWrite = () => {
      if (!syncCfg.current?.auto) return;
      if (syncTimer.current) clearTimeout(syncTimer.current);
      syncTimer.current = setTimeout(() => void syncNow(), 2000);
    };
    return () => {
      repo.onWrite = null;
    };
  }, [repo, syncNow]);

  // 打开、回到前台、恢复联网、每 3 分钟：下载合并
  useEffect(() => {
    if (!ready || !sync.config?.auto) return;
    void syncNow();
    const onVis = () => document.visibilityState === 'visible' && void syncNow();
    const onOnline = () => void syncNow();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', onOnline);
    const t = setInterval(() => document.visibilityState === 'visible' && void syncNow(), 180_000);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('online', onOnline);
      clearInterval(t);
    };
  }, [ready, sync.config, syncNow]);

  const cloud: SupaTarget | null = useMemo(() => {
    const fn = settings.recognizeFn || publicConfig?.fn || null;
    if (auth.session) return { url: auth.session.url, key: auth.session.key, fn };
    if (publicConfig) return { url: publicConfig.url, key: publicConfig.key, fn };
    if (sync.config) return { url: sync.config.url, key: sync.config.key, fn };
    return null;
  }, [auth.session, publicConfig, sync.config, settings.recognizeFn]);
  const cloudRef = useRef(cloud);
  cloudRef.current = cloud;

  const refreshAccount = useCallback(async () => {
    const s = sessionRef.current;
    const t = cloudRef.current;
    if (!s || !t) return null;
    try {
      const token = await getToken();
      if (!token) return null;
      const a = await getAccount(t, token);
      setAuth((x) => ({ ...x, account: a, error: null }));
      await repo.setMeta(META_ACCOUNT, a);
      return a;
    } catch (e) {
      setAuth((x) => ({ ...x, error: (e as Error).message }));
      return null;
    }
  }, [getToken, repo]);

  const signIn = useCallback(
    async (session: Session) => {
      sessionRef.current = session;
      await repo.setMeta(META_SESSION, session);
      setAuth({ session, account: null, error: null });
      // 同步改为账号模式：本机数据全部上传到账号，再下载账号里已有的数据
      await saveSyncConfig({ url: session.url, key: session.key, space: '', secret: '', auto: true, account: true }, { resetState: true });
      await syncNow({ mode: 'both', force: true });
    },
    [repo, saveSyncConfig, syncNow],
  );

  const signOut = useCallback(async () => {
    const s = sessionRef.current;
    sessionRef.current = null;
    await repo.setMeta(META_SESSION, null);
    await repo.setMeta(META_ACCOUNT, null);
    setAuth({ session: null, account: null, error: null });
    if (syncCfg.current?.account) await saveSyncConfig(null);
    if (s) void signOutRemote(s);
  }, [repo, saveSyncConfig]);

  // 登录后加载账号信息（套餐、用量）
  useEffect(() => {
    if (ready && auth.session && cloud) void refreshAccount();
  }, [ready, auth.session?.user.id, cloud?.url, cloud?.fn]); // eslint-disable-line react-hooks/exhaustive-deps

  const ent: Entitlement | null = useMemo(() => {
    const a = auth.account;
    if (!a) return null;
    const plan = a.plan === 't1' || a.plan === 't2' || a.plan === 'owner' ? a.plan : null;
    return entitlement({ plan, period: a.period, plan_until: a.planUntil, trial_until: a.trialUntil }, { now: new Date() });
  }, [auth.account, today]); // eslint-disable-line react-hooks/exhaustive-deps
  const saas = !!publicConfig || !!auth.session;
  const gate: Gate = useMemo(() => {
    if (!saas) return { saas: false, canEdit: true, canPush: true, canExport: true, readOnly: false };
    if (!auth.session) return { saas: true, canEdit: false, canPush: false, canExport: false, readOnly: false };
    if (!ent) return { saas: true, canEdit: true, canPush: false, canExport: false, readOnly: false };
    return { saas: true, canEdit: ent.features.edit, canPush: ent.features.push, canExport: ent.features.export, readOnly: !ent.features.edit };
  }, [saas, auth.session, ent]);
  const gateRef = useRef(gate);
  gateRef.current = gate;
  const [paywall, setPaywall] = useState<Feature | null>(null);
  const requireFeature = useCallback((f: Feature) => {
    const g = gateRef.current;
    const ok = f === 'edit' ? g.canEdit : f === 'push' ? g.canPush : g.canExport;
    if (!ok) setPaywall(f);
    return ok;
  }, []);
  const closePaywall = useCallback(() => setPaywall(null), []);

  const value: Store = { ready, fatal, repo, bills, merchants, accounts, settings, today, route, go, back, reload, saveSettings, guard, storageError, hasSample, clearSample, sync, syncNow, saveSyncConfig, publicConfig, cloud, auth, getToken, signIn, signOut, refreshAccount, ent, gate, requireFeature, paywall, closePaywall };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
