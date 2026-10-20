import { useEffect, useState } from 'react';
import { useStore, type Feature } from '../store';
import { useFeedback, Modal } from '../ui/feedback';
import { sendCode, verifyCode, isEmail, AuthError, signInPassword, signUpPassword } from '../cloud/auth';
import { startCheckout, cancelSubscription, pushKey, pushSubscribe, pushUnsubscribe, pushTest, PLAN_LABEL, ApiError } from '../cloud/api';
import { PLANS, TRIAL, type PlanId, type Period } from '../../shared/plans.mjs';
import { formatBRL } from '../lib/money';
import { IBell, ICloud, IShield, ICheck } from '../ui/icons';

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '');
const brl = (v: number) => formatBRL(Math.round(v * 100));

function b64uToBytes(s: string): Uint8Array {
  const p = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(p + '='.repeat((4 - (p.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = () => typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true);

function useRunner() {
  const fb = useFeedback();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async <T,>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(label);
    try {
      return await fn();
    } catch (e) {
      fb.toast(e instanceof AuthError || e instanceof ApiError ? e.message : `出错：${(e as Error).message}`, { bad: true });
      return undefined;
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

/* ---------------- 登录 / 注册 ---------------- */

export function LoginForm({ compact = false }: { compact?: boolean }) {
  const { cloud, auth, signIn, sync } = useStore();
  const fb = useFeedback();
  const { busy, run } = useRunner();
  const [email, setEmail] = useState(auth.session?.user.email ?? '');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [method, setMethod] = useState<'password' | 'code'>('password');
  const [mode, setMode] = useState<'signup' | 'login'>('signup');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  if (!cloud) return null;
  const doPassword = () =>
    run(mode === 'signup' ? '注册中…' : '登录中…', async () => {
      const s = mode === 'signup' ? await signUpPassword(cloud, email, password) : await signInPassword(cloud, email, password);
      await signIn(s);
      setPassword('');
      fb.toast(mode === 'signup' ? `注册成功，已登录 ${s.user.email}` : `已登录 ${s.user.email}，账单开始同步`);
    });

  return (
    <div className="stack">
      {auth.error && <div className="banner bad small">{auth.error}</div>}
      {!compact && sync.config && !sync.config.account && <p className="xs muted">登录后会改用账号同步，本机所有账单会上传到账号（示例数据不上传）。</p>}
      <div className="seg seg-sm" role="group" aria-label="登录方式">
        <button aria-pressed={method === 'password'} onClick={() => setMethod('password')}>
          邮箱 + 密码
        </button>
        <button aria-pressed={method === 'code'} onClick={() => setMethod('code')}>
          邮箱验证码
        </button>
      </div>
      <div className="field">
        <label htmlFor="acc-email">邮箱</label>
        <input id="acc-email" className="input" type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
      </div>
      {method === 'password' ? (
        <>
          <div className="field">
            <label htmlFor="acc-pw">密码</label>
            <div className="datefield">
              <input
                id="acc-pw"
                className="input"
                type={showPw ? 'text' : 'password'}
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && isEmail(email) && password && doPassword()}
                placeholder="至少 8 位"
              />
              <button type="button" className="btn datebtn" aria-label={showPw ? '隐藏密码' : '显示密码'} onClick={() => setShowPw((v) => !v)}>
                {showPw ? '藏' : '看'}
              </button>
            </div>
          </div>
          <button className="btn btn-primary" disabled={!!busy || !isEmail(email) || (mode === 'signup' ? password.length < 8 : !password)} onClick={doPassword}>
            {busy ? <span className="spin" /> : null}
            {mode === 'signup' ? `注册，免费试用 ${TRIAL.days} 天` : '登录'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'center' }} onClick={() => setMode(mode === 'signup' ? 'login' : 'signup')}>
            {mode === 'signup' ? '已经有账号？登录' : '还没有账号？注册'}
          </button>
        </>
      ) : (
        <>
          {sent && (
            <div className="field">
              <label htmlFor="acc-code">邮件里的验证码</label>
              <input id="acc-code" className="input mono num" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 10))} placeholder="6 位数字" />
              <span className="hint">没收到？看看垃圾邮件；{cooldown > 0 ? `${cooldown} 秒后可重发` : '可以重新发送'}。</span>
            </div>
          )}
          <div className="row">
            {!sent || cooldown <= 0 ? (
              <button
                className={`btn ${sent ? '' : 'btn-primary'}`}
                disabled={!!busy || !isEmail(email)}
                onClick={() =>
                  run('发送中…', async () => {
                    await sendCode(cloud, email);
                    setSent(true);
                    setCooldown(60);
                    fb.toast('验证码已发送到邮箱');
                  })
                }
              >
                {busy === '发送中…' ? <span className="spin" /> : null}
                {sent ? '重新发送' : '发送验证码'}
              </button>
            ) : null}
            {sent && (
              <button
                className="btn btn-primary"
                disabled={!!busy || code.length < 6}
                onClick={() =>
                  run('登录中…', async () => {
                    const s = await verifyCode(cloud, email, code);
                    await signIn(s);
                    fb.toast(`已登录 ${s.user.email}，账单开始同步`);
                  })
                }
              >
                {busy === '登录中…' ? <span className="spin" /> : null}
                登录
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------- 套餐 ---------------- */

const FEATURE_ROWS: { label: string; t1: boolean | string; t2: boolean | string }[] = [
  { label: '账期、缴费、对账、流水、提醒、多设备同步', t1: true, t2: true },
  { label: 'PDF 直读、本机 OCR、日历提醒', t1: true, t2: true },
  { label: '关屏推送提醒', t1: true, t2: true },
  { label: 'AI 识别（每月）', t1: `${PLANS.t1.ai} 次`, t2: `${PLANS.t2.ai} 次` },
  { label: '导出记录（CSV / Excel）', t1: false, t2: true },
];

export function Pricing() {
  const { cloud, getToken, ent, auth } = useStore();
  const { busy, run } = useRunner();
  const [period, setPeriod] = useState<Period>('year');
  const billingOn = !!auth.account?.billing;
  const save = (p: PlanId) => Math.round((1 - PLANS[p].year / (PLANS[p].month * 12)) * 100);

  const subscribe = (plan: PlanId) =>
    run(`跳转付款 ${plan}`, async () => {
      if (!cloud) throw new ApiError(0, '没有连接服务');
      const token = await getToken();
      if (!token) throw new ApiError(401, '请先登录');
      const { url } = await startCheckout(cloud, token, plan, period, `${location.origin}${location.pathname}?mp=1`);
      location.href = url;
    });

  return (
    <div className="stack">
      <div className="seg seg-sm" role="group" aria-label="付款周期" style={{ alignSelf: 'center' }}>
        <button aria-pressed={period === 'month'} onClick={() => setPeriod('month')}>
          月付
        </button>
        <button aria-pressed={period === 'year'} onClick={() => setPeriod('year')}>
          年付（省最多 {save('t2')}%）
        </button>
      </div>
      <div className="plans">
        {(['t1', 't2'] as PlanId[]).map((p) => {
          const current = ent?.plan === p;
          return (
            <div key={p} className={`plan${p === 't2' ? ' hot' : ''}${current ? ' current' : ''}`}>
              <div className="row between">
                <b className="plan-name">{PLANS[p].name}</b>
                {p === 't2' && <span className="pill brand">最划算</span>}
                {current && <span className="pill paid">当前</span>}
              </div>
              <div className="plan-price">
                <b className="num">{brl(PLANS[p][period])}</b>
                <span className="small muted">/{period === 'year' ? '年' : '月'}</span>
              </div>
              {period === 'year' && <span className="xs muted">相当于 {brl(PLANS[p].year / 12)}/月，省 {save(p)}%</span>}
              <ul className="plan-feats small">
                {FEATURE_ROWS.map((f) => {
                  const v = f[p];
                  return (
                    <li key={f.label} className={v ? '' : 'off'}>
                      {v ? <ICheck width={14} height={14} /> : <span aria-hidden="true">—</span>} {f.label}
                      {typeof v === 'string' ? <b> {v}</b> : null}
                    </li>
                  );
                })}
              </ul>
              <button className={`btn ${p === 't2' ? 'btn-primary' : ''}`} disabled={!!busy || !billingOn || (current && ent?.period === period && auth.account?.subscription?.status === 'authorized')} onClick={() => subscribe(p)}>
                {busy === `跳转付款 ${p}` ? <span className="spin" /> : null}
                {current ? (ent?.period === period ? '已订阅' : `改为${period === 'year' ? '年付' : '月付'}`) : ent?.plan === 't1' && p === 't2' ? '升级到 T2' : `订阅 ${PLANS[p].name}`}
              </button>
            </div>
          );
        })}
      </div>
      <span className="xs muted" style={{ textAlign: 'center' }}>
        {billingOn ? '通过 Mercado Pago 付款，自动续费，可以随时取消；取消后已付的期间照常可用。' : '订阅收款暂未开放，请联系管理员。'}
      </span>
    </div>
  );
}

const FEATURE_TEXT: Record<Feature, { title: string; body: string }> = {
  edit: { title: '试用已结束', body: '账单仍然可以查看、标记已付。新增、编辑、识别单据需要订阅 T1 或 T2。数据都还在，订阅后立即恢复。' },
  push: { title: '关屏推送是 T1 / T2 的功能', body: '订阅后，每天 09:00 把要付和已逾期的账单推送到手机，不用打开应用。' },
  export: { title: '导出记录是 T2 的功能', body: '订阅 T2 后可以把账单和流水导出为 CSV（Excel 可直接打开），方便记账和对账。' },
};

/** 没有权限时的订阅弹窗（由 App 根据 store.paywall 显示） */
export function PaywallModal() {
  const { paywall, closePaywall, go } = useStore();
  if (!paywall) return null;
  const t = FEATURE_TEXT[paywall];
  return (
    <Modal title={t.title} onClose={closePaywall}>
      <p className="small">{t.body}</p>
      <Pricing />
      <div className="row end">
        <button className="btn btn-ghost" onClick={closePaywall}>
          以后再说
        </button>
        <button
          className="btn btn-soft"
          onClick={() => {
            closePaywall();
            go({ name: 'account' });
          }}
        >
          账号与套餐
        </button>
      </div>
    </Modal>
  );
}

/** 只读时替代新增/编辑/识别页面 */
export function ReadOnlyPage() {
  const { go } = useStore();
  return (
    <section className="card stack">
      <h2 className="row">
        <IShield width={20} height={20} /> {FEATURE_TEXT.edit.title}
      </h2>
      <p className="small">{FEATURE_TEXT.edit.body}</p>
      <Pricing />
      <button className="btn btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={() => go({ name: 'bills' })}>
        查看账单
      </button>
    </section>
  );
}

/** 首页顶部：试用剩余 / 已到期 */
export function PlanBanner() {
  const { ent, gate, go, auth } = useStore();
  if (!gate.saas || !ent) return null;
  const u = auth.account?.usage;
  if (ent.plan === 'expired')
    return (
      <div className="banner bad">
        <span className="grow small">
          <b>试用已结束</b>，账单只读。订阅后立即恢复全部功能。
        </span>
        <button className="btn btn-sm btn-primary" onClick={() => go({ name: 'account' })}>
          订阅
        </button>
      </div>
    );
  if (ent.plan !== 'trial') return null;
  const left = ent.daysLeft ?? 0;
  return (
    <div className={`banner ${left <= 7 ? 'warn' : 'ok'}`}>
      <span className="grow small">
        免费试用还剩 <b>{left} 天</b>
        {u && u.limit > 0 ? ` · AI 识别剩 ${Math.max(0, u.limit - u.ai)} 次` : ''}
      </span>
      <button className="btn btn-sm" onClick={() => go({ name: 'account' })}>
        查看套餐
      </button>
    </div>
  );
}

/* ---------------- 账号页 ---------------- */

export function AccountPage() {
  const { cloud, auth, signOut, refreshAccount, getToken, go, ent } = useStore();
  const fb = useFeedback();
  const { busy, run } = useRunner();
  const acc = auth.account;

  // 从 Mercado Pago 付款页回来：刷新套餐
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (!q.has('mp')) return;
    history.replaceState(null, '', location.pathname + location.hash);
    void refreshAccount().then((a) => a && fb.toast(a.plan === 't1' || a.plan === 't2' ? `已开通 ${PLAN_LABEL[a.plan]}，感谢支持！` : '正在等待 Mercado Pago 确认付款，几分钟后点「刷新」'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!cloud) {
    return (
      <section className="card stack">
        <h2 className="row">
          <ICloud width={20} height={20} /> 账号
        </h2>
        <p className="small">这个网站还没有连接账号服务。管理员请按 README「一键部署」完成初始化。</p>
        <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={() => go({ name: 'settings' })}>
          去设置
        </button>
      </section>
    );
  }

  if (!auth.session) {
    return (
      <section className="card stack" aria-labelledby="h-login">
        <h2 id="h-login" className="row">
          <ICloud width={20} height={20} /> 登录账号
        </h2>
        <p className="small">登录后账单在你所有设备间自动同步。新账号免费试用 {TRIAL.days} 天，含 {TRIAL.ai} 次 AI 识别。</p>
        <LoginForm />
      </section>
    );
  }

  const plan = ent?.plan ?? acc?.plan ?? 'trial';
  const usage = acc?.usage;
  const pct = usage && usage.limit > 0 ? Math.min(100, Math.round((usage.ai / usage.limit) * 100)) : 0;
  const sub = acc?.subscription?.status ?? null;

  return (
    <>
      <section className="card stack" aria-labelledby="h-acc">
        <div className="row between">
          <h2 id="h-acc" className="row">
            <ICloud width={20} height={20} /> {auth.session.user.email}
          </h2>
          <span className={`pill ${plan === 'expired' ? 'overdue' : plan === 'trial' ? 'dueSoon' : 'paid'}`}>{PLAN_LABEL[plan]}</span>
        </div>
        {auth.error && <div className="banner bad small">{auth.error}</div>}
        <p className="small">
          {plan === 'trial' && <>免费试用到 <b>{fmtDate(ent?.trialUntil ?? null)}</b>（还剩 {ent?.daysLeft ?? '?'} 天）。</>}
          {plan === 'expired' && <>试用已结束，账单只读。订阅后立即恢复。</>}
          {(plan === 't1' || plan === 't2') && (
            <>
              {PLAN_LABEL[plan]}（{ent?.period === 'year' ? '年付' : '月付'}）有效期至 <b>{fmtDate(ent?.planUntil ?? null)}</b>
              {sub === 'authorized' ? '，到期自动续费。' : sub === 'cancelled' ? '，已取消自动续费。' : '。'}
            </>
          )}
          {plan === 'owner' && <>管理员：全部功能、不限次数。</>}
        </p>
        {usage && usage.limit !== 0 && (
          <div className="stack" style={{ gap: 4 }}>
            <div className="row between small">
              <span>{usage.period === 'trial' ? '试用期 AI 识别' : '本月 AI 识别'}</span>
              <b className="num">{usage.limit < 0 ? `${usage.ai} 次（不限）` : `${usage.ai} / ${usage.limit} 次`}</b>
            </div>
            {usage.limit > 0 && (
              <div className={`meter${pct >= 90 ? ' bad' : ''}`} role="progressbar" aria-valuenow={usage.ai} aria-valuemin={0} aria-valuemax={usage.limit}>
                <div style={{ width: `${pct}%` }} />
              </div>
            )}
            <span className="xs muted">{usage.period === 'trial' ? '试用期共 ' + TRIAL.ai + ' 次。' : '每月 1 日重置。'}识别失败不计次数；PDF 直接读文字、本机 OCR 都不占次数。</span>
          </div>
        )}
        <div className="row">
          <button className="btn btn-sm" disabled={!!busy} onClick={() => run('刷新…', refreshAccount)}>
            刷新
          </button>
          {sub === 'authorized' && (
            <button
              className="btn btn-sm btn-ghost"
              disabled={!!busy}
              onClick={async () => {
                const ok = await fb.confirm({ title: '取消自动续费？', body: `已付的期间照常可用，到 ${fmtDate(ent?.planUntil ?? null)} 后变为只读（数据保留）。`, confirmLabel: '取消续费', danger: true });
                if (!ok) return;
                const r = await run('取消中…', async () => {
                  const token = await getToken();
                  if (!token) throw new ApiError(401, '请重新登录');
                  return cancelSubscription(cloud, token);
                });
                if (r) {
                  fb.toast('已取消自动续费');
                  void refreshAccount();
                }
              }}
            >
              取消自动续费
            </button>
          )}
          <button
            className="btn btn-sm btn-ghost"
            onClick={async () => {
              const ok = await fb.confirm({ title: '退出登录？', body: '本机的账单会保留，只是不再同步。重新登录同一个账号即可继续。', confirmLabel: '退出' });
              if (ok) {
                await signOut();
                fb.toast('已退出登录');
              }
            }}
          >
            退出登录
          </button>
        </div>
      </section>

      {plan !== 'owner' && (
        <section className="card stack" aria-labelledby="h-plan">
          <h2 id="h-plan" className="row">
            <IShield width={20} height={20} /> 套餐
          </h2>
          {acc?.subscription?.plan && sub === 'authorized' && acc.subscription.plan !== plan && <p className="xs muted">正在切换到 {PLAN_LABEL[acc.subscription.plan as PlanId] ?? acc.subscription.plan}，付款确认后自动生效并取消原订阅。</p>}
          <Pricing />
        </section>
      )}

      <PushSection />
    </>
  );
}

function PushSection() {
  const { cloud, getToken, gate, requireFeature } = useStore();
  const fb = useFeedback();
  const [state, setState] = useState<'checking' | 'unsupported' | 'off' | 'on' | 'denied'>('checking');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!pushSupported()) return setState('unsupported');
    if (Notification.permission === 'denied') return setState('denied');
    navigator.serviceWorker
      .getRegistration()
      .then(async (reg) => setState((await reg?.pushManager.getSubscription()) ? 'on' : 'off'))
      .catch(() => setState('off'));
  }, []);

  const enable = async () => {
    if (!cloud || !requireFeature('push')) return;
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        setState(perm === 'denied' ? 'denied' : 'off');
        return;
      }
      const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.ready);
      const { publicKey } = await pushKey(cloud);
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(publicKey) as BufferSource }));
      const token = await getToken();
      if (!token) throw new ApiError(401, '请重新登录');
      await pushSubscribe(cloud, token, sub.toJSON());
      setState('on');
      fb.toast('已开启关屏推送');
    } catch (e) {
      fb.toast(e instanceof ApiError ? e.message : `开启失败：${(e as Error).message}`, { bad: true });
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (!cloud) return;
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      const token = await getToken();
      if (sub && token) await pushUnsubscribe(cloud, token, sub.endpoint).catch(() => {});
      await sub?.unsubscribe();
      setState('off');
      fb.toast('已关闭关屏推送');
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    if (!cloud) return;
    setBusy(true);
    try {
      const token = await getToken();
      if (!token) throw new ApiError(401, '请重新登录');
      const r = await pushTest(cloud, token);
      fb.toast(r.sent ? `已发送测试推送（${r.sent} 台设备）` : '没有发出去：请关闭后重新开启推送', { bad: !r.sent });
    } catch (e) {
      fb.toast((e as Error).message, { bad: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack" aria-labelledby="h-push">
      <h2 id="h-push" className="row">
        <IBell width={20} height={20} /> 关屏推送提醒 {!gate.canPush && <span className="pill neutral">T1 / T2</span>}
      </h2>
      <p className="small">每天圣保罗时间 09:00 左右，把要付和已逾期的账单推送到这台设备，不用打开应用。</p>
      {state === 'unsupported' && <p className="small err">{isIOS() && !standalone() ? 'iPhone 需要先把本应用「添加到主屏幕」，再从主屏幕打开，才能开启推送。' : '这个浏览器不支持网页推送，可以用日历提醒。'}</p>}
      {state === 'denied' && <p className="small err">通知权限被拒绝：请在浏览器的网站设置里改为「允许」后再开启。</p>}
      <div className="row">
        {state === 'off' && (
          <button className="btn btn-primary" disabled={busy} onClick={enable}>
            {busy ? <span className="spin" /> : <IBell />}
            开启推送
          </button>
        )}
        {state === 'on' && (
          <>
            <span className="pill paid">已开启</span>
            <button className="btn btn-sm" disabled={busy} onClick={test}>
              发一条测试
            </button>
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={disable}>
              关闭
            </button>
          </>
        )}
      </div>
    </section>
  );
}

/** 公开部署时，未登录先看到这里（介绍 + 注册登录） */
export function Welcome() {
  return (
    <div className="welcome">
      <div className="stack" style={{ gap: 6 }}>
        <h1>账期助手</h1>
        <p className="small muted">巴西小商家的账期与缴费管家：拍照识别单据，到期前提醒，手机电脑同步。</p>
      </div>
      <ul className="perks small">
        {['拍照或 PDF 识别订单、boleto、水电税费单', '按商家账期自动算到期日，逾期一目了然', '对账单批量导入、每月流水、多设备同步', `新账号免费试用 ${TRIAL.days} 天，含 ${TRIAL.ai} 次 AI 识别`].map((t) => (
          <li key={t}>
            <ICheck width={16} height={16} /> {t}
          </li>
        ))}
      </ul>
      <section className="card stack">
        <LoginForm compact />
      </section>
      <details className="more">
        <summary>套餐与价格</summary>
        <div className="stack" style={{ marginTop: 8 }}>
          {(['t1', 't2'] as PlanId[]).map((p) => (
            <div key={p} className="li small">
              <b>{PLANS[p].name}</b>
              <span className="grow">
                {' '}
                {brl(PLANS[p].month)}/月 · {brl(PLANS[p].year)}/年 — 关屏推送、AI 识别 {PLANS[p].ai} 次/月{PLANS[p].export ? '、导出记录' : ''}
              </span>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
