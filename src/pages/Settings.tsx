import { useTheme, type ThemePref } from '../theme';
import { ISun, IStore } from '../ui/icons';
import { centsToInput, parseBRL } from '../lib/money';
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { useFeedback } from '../ui/feedback';
import { useActions } from '../actions';
import { notifyState, requestNotify, showNotification, type NotifyState } from '../lib/platform';
import { listProviders, normalizeFn, supaFnUrl, type ProviderInfo } from '../lib/ocr/providers';
import { copyText } from '../lib/platform';
import workerCode from '../../worker/dist/zhangqi-worker.js?raw';
import supabaseFnCode from '../../supabase/functions/recognize/index.ts?raw';
import { IBell, ICal, IDatabase, IShield, ICloud } from '../ui/icons';
import { PLAN_LABEL } from '../cloud/api';
import type { useReminders } from '../reminders';
import { SyncSettings } from './SyncSettings';

const NS_LABEL: Record<NotifyState, [string, string]> = {
  granted: ['已允许', 'paid'],
  denied: ['已拒绝', 'overdue'],
  default: ['尚未询问', 'dueSoon'],
  unsupported: ['此环境不支持', 'neutral'],
};

export function SettingsPage({ rem }: { rem: ReturnType<typeof useReminders> }) {
  const { settings, saveSettings, bills, go, today, sync, cloud, getToken, auth, gate, ent } = useStore();
  // 账号版：普通用户不显示部署相关的技术设置；管理员或本地自用版才显示
  const showAdmin = !gate.saas || ent?.plan === 'owner';
  const supa = cloud;
  const withBearer = async (t: typeof supa) => (t ? { ...t, bearer: await getToken() } : null);
  const { exportICS } = useActions();
  const fb = useFeedback();
  const [ns, setNs] = useState<NotifyState>(notifyState());
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [endpoint, setEndpoint] = useState(settings.recognizeEndpoint);
  const [token, setToken] = useState(settings.recognizeToken);
  const [testing, setTesting] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const unpaid = bills.filter((b) => !b.paidAt);

  useEffect(() => {
    setProviders(null);
    withBearer(supa).then((t) => listProviders(settings.recognizeEndpoint, settings.recognizeToken, t)).then(setProviders);
  }, [settings.recognizeEndpoint, settings.recognizeToken, supa?.url, supa?.key, supa?.fn, auth.session?.user.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const aiReady = !!providers?.some((p) => p.available && p.id !== 'local');
  const [fnText, setFnText] = useState(settings.recognizeFn ?? '');
  useEffect(() => setFnText(settings.recognizeFn ?? ''), [settings.recognizeFn]);
  const recheck = async () => {
    setTesting(true);
    const fn = normalizeFn(fnText, supa?.url);
    if (fn !== (settings.recognizeFn ?? '')) await saveSettings({ recognizeFn: fn || null });
    setFnText(fn);
    const ps = await listProviders(settings.recognizeEndpoint, settings.recognizeToken, await withBearer(supa ? { ...supa, fn } : null));
    setProviders(ps);
    setTesting(false);
    const sb = ps.find((p) => p.id === 'supabase')!;
    fb.toast(sb.available ? `${sb.label} 已开启` : `AI 识别未开启：${sb.reason ?? '未知原因'}`, { bad: !sb.available });
  };

  const normalizeEndpoint = (v: string) => {
    let e = v.trim();
    if (!e) return '/api/recognize';
    if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(e)) e = `https://${e}`;
    if (/^https?:\/\/[^/]+\/?$/i.test(e)) e = e.replace(/\/?$/, '/api/recognize');
    return e;
  };

  const saveAndTest = async () => {
    const ep = normalizeEndpoint(endpoint);
    setEndpoint(ep);
    setTesting(true);
    await saveSettings({ recognizeEndpoint: ep, recognizeToken: token.trim() });
    const ps = await listProviders(ep, token.trim(), await withBearer(supa));
    setProviders(ps);
    setTesting(false);
    const srv = ps.find((p) => p.id === 'server')!;
    fb.toast(srv.available ? '连接成功，云端识别已开启' : `未连通：${srv.reason ?? '未知原因'}`, { bad: !srv.available });
  };

  const test = async () => {
    const ok = await showNotification('账期助手 · 测试通知', '通知工作正常。到期提醒会在应用打开时这样出现。', 'test');
    fb.toast(ok ? '已发送测试通知' : '发送失败：浏览器没有显示通知', { bad: !ok });
  };

  const [label, tone] = NS_LABEL[ns];
  return (
    <>
      <button className="card row linkcard" onClick={() => go({ name: 'masters' })}>
        <IStore width={22} height={22} />
        <span className="grow stack" style={{ gap: 0 }}>
          <b>固定资料</b>
          <span className="small muted">商家、缴费单位、付款账号</span>
        </span>
        <span aria-hidden="true">›</span>
      </button>
      <button className="card row linkcard" onClick={() => go({ name: 'account' })}>
        <ICloud width={22} height={22} />
        <span className="grow stack" style={{ gap: 0 }}>
          <b>{auth.session ? auth.session.user.email : '账号'}</b>
          <span className="small muted">
            {auth.session ? `${auth.account ? PLAN_LABEL[auth.account.plan] : '已登录'} · 账号同步、AI 额度、关屏推送` : '邮箱验证码登录：多设备同步、AI 识别、关屏推送'}
          </span>
        </span>
        <span aria-hidden="true">›</span>
      </button>
      {(showAdmin || sync.config?.account) && <SyncSettings />}
      <ThemeSection />
      <section className="card stack" aria-labelledby="h-rem">
        <h2 id="h-rem" className="row">
          <IBell width={20} height={20} /> 提醒与日历
        </h2>
        <div className="row between">
          <span className="small">
            系统通知 <span className={`pill ${tone}`}>{label}</span>
          </span>
          <div className="row" style={{ gap: 6 }}>
            {ns === 'default' && (
              <button className="btn btn-sm btn-primary" onClick={async () => setNs(await requestNotify())}>
                允许通知
              </button>
            )}
            {ns === 'granted' && (
              <button className="btn btn-sm" onClick={test}>
                测试
              </button>
            )}
            <button className="btn btn-sm btn-ghost" onClick={rem.recheck}>
              立即检查
            </button>
          </div>
        </div>
        {ns === 'denied' && <p className="small err">通知被拒绝，请在浏览器的网站设置里改为「允许」。</p>}
        <label className="check">
          <input type="checkbox" checked={settings.notificationsEnabled} onChange={(e) => saveSettings({ notificationsEnabled: e.target.checked })} />
          <span>打开应用时发送到期通知（每笔每天最多一次）</span>
        </label>
        <div className="grid2">
          <div className="field">
            <label htmlFor="s-rd">默认提前提醒（天）</label>
            <input id="s-rd" className="input num" inputMode="numeric" value={settings.defaultReminderDays} onChange={(e) => { const n = Number(e.target.value.replace(/\D/g, '') || 0); saveSettings({ defaultReminderDays: Math.min(60, n) }); }} />
          </div>
          <div className="field">
            <label htmlFor="s-ds">「即将到期」范围（天）</label>
            <input id="s-ds" className="input num" inputMode="numeric" value={settings.dueSoonDays} onChange={(e) => { const n = Number(e.target.value.replace(/\D/g, '') || 0); saveSettings({ dueSoonDays: Math.min(60, Math.max(1, n)) }); }} />
          </div>
        </div>
        <div className="field" style={{ maxWidth: 260 }}>
          <label htmlFor="s-budget">每月支出预算 R$（可空）</label>
          <input
            id="s-budget"
            className="input num"
            inputMode="decimal"
            defaultValue={settings.monthlyBudgetCents ? centsToInput(settings.monthlyBudgetCents) : ''}
            placeholder="如 20.000,00"
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (!v) return saveSettings({ monthlyBudgetCents: null });
              const c = parseBRL(v).cents;
              if (c) {
                saveSettings({ monthlyBudgetCents: c });
                e.target.value = centsToInput(c);
              }
            }}
          />
          <span className="hint">在「流水」页显示本月实付进度，超出会提醒。</span>
        </div>
        <div className="divider" />
        <div className="row between">
          <span className="small">
            <ICal width={16} height={16} style={{ verticalAlign: -3 }} /> 关屏也要提醒：导出到手机日历（含提前闹钟）
          </span>
          <button className="btn btn-primary" disabled={!unpaid.length} onClick={() => exportICS(unpaid, `账期-全部未付-${today}.ics`)}>
            导出全部未付账单
          </button>
        </div>
      </section>

      <section className="card stack" aria-labelledby="h-ocr">
        <h2 id="h-ocr" className="row">
          <IShield width={20} height={20} /> AI 识别与隐私
        </h2>
        {!providers ? (
          <span className="row small muted">
            <span className="spin" /> 检查中…
          </span>
        ) : (
          <div className="list">
            {providers.filter((p) => p.id === 'supabase' || p.id === 'local' || p.available).map((p) => (
              <div key={p.id} className="li">
                <div className="grow stack" style={{ gap: 2 }}>
                  <span className="t">{p.label}</span>
                  <span className="xs muted">{p.cost}</span>
                  {p.reason && <span className="xs err">{p.reason}</span>}
                </div>
                <span className={`pill ${p.available ? 'paid' : 'neutral'}`}>{p.available ? '可用' : '未开启'}</span>
              </div>
            ))}
          </div>
        )}
        {showAdmin && (<>
        {supa && (
          <div className="field">
            <label htmlFor="s-fn">识别函数名</label>
            <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
              <input id="s-fn" className="input mono grow" value={fnText} onChange={(e) => setFnText(e.target.value)} placeholder="recognize" autoComplete="off" spellCheck={false} />
              <button className="btn" onClick={recheck} disabled={testing}>
                {testing ? <span className="spin" /> : null}
                保存并检查
              </button>
            </div>
            <span className="hint">
              Supabase 函数页面顶部网址 <span className="mono">/functions/v1/</span> 后面那一段；也可以直接粘贴整个网址。当前调用：<span className="mono">{supaFnUrl({ ...supa, fn: normalizeFn(fnText, supa.url) })}</span>
            </span>
          </div>
        )}
        {!supa && (
          <div className="row">
            <button className="btn btn-sm" onClick={recheck} disabled={testing}>
              {testing ? <span className="spin" /> : null}
              重新检查
            </button>
          </div>
        )}

        <details className="more guide" open={!!providers && !aiReady}>
          <summary>开启 AI 识别：Supabase + Gemini（约 5 分钟，只需做一次）</summary>
          {!supa && (
            <p className="small err">第 0 步：先在上面的「云同步」里连接 Supabase（识别函数部署在同一个项目里，App 会自动用同步配置调用它）。</p>
          )}
          <ol className="steps small">
            <li>
              打开 <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">aistudio.google.com/apikey</a>，用 Google 账号登录，点 <b>Create API key</b>，复制密钥。
            </li>
            <li>
              打开 <a href="https://supabase.com/dashboard" target="_blank" rel="noopener noreferrer">Supabase 控制台</a> → 你同步用的项目 → 左侧 <b>Edge Functions</b> → <b>Secrets</b> → 添加：名称 <span className="mono">GEMINI_API_KEY</span>，值粘贴第 1 步的密钥 → 保存。
            </li>
            <li>
              <b>Edge Functions</b> → <b>Deploy a new function</b> → <b>Via Editor</b>；左上角的函数名（决定网址）改成 <span className="mono">recognize</span>，删掉示例代码，粘贴下面复制的代码 → <b>Deploy function</b>。部署后若网址最后一段不是 recognize（例如 quick-api），把它填到上面的「识别函数名」即可。
              <div className="row" style={{ marginTop: 6 }}>
                <button
                  className="btn btn-sm btn-soft"
                  onClick={async () => fb.toast((await copyText(supabaseFnCode)) ? `已复制识别函数代码（${Math.round(supabaseFnCode.length / 1024)} KB）` : '复制失败，请从项目 supabase/functions/recognize 目录获取', { bad: false })}
                >
                  复制识别函数代码
                </button>
              </div>
            </li>
            <li>
              打开这个函数的 <b>Settings</b>，把 <b>Verify JWT</b>（或 Enforce JWT Verification）<b>关掉</b> → 保存。不关的话浏览器会报「连接不到识别函数」。函数自己会校验你的 publishable key，别人拿不到你的密钥。
            </li>
            <li>回到这里点「保存并检查」，显示「可用」就完成了。别的设备导入同步配置后自动可用。</li>
          </ol>
          <p className="xs muted">
            隐私提醒：Gemini 免费额度下提交的内容可能被 Google 用于改进产品并由人工审阅。工资单、银行单据含个人信息，建议在 AI Studio 为这个密钥开启结算（付费层不用于训练，识别一张单据约几分钱）。想用 Claude：Secret 名称改为 <span className="mono">ANTHROPIC_API_KEY</span>。
          </p>
        </details>

        <details className="more guide">
          <summary>其他方式：自建服务 / Cloudflare Worker / Claude App</summary>
          <div className="grid2 stack-sm">
            <div className="field">
              <label htmlFor="s-ep">自建识别服务地址</label>
              <input id="s-ep" className="input mono" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://xxx.workers.dev" autoComplete="off" spellCheck={false} />
            </div>
            <div className="field">
              <label htmlFor="s-tk">访问口令</label>
              <div className="datefield">
                <input id="s-tk" className="input mono" type={showToken ? 'text' : 'password'} value={token} onChange={(e) => setToken(e.target.value)} placeholder="部署时自己设定的口令" autoComplete="off" />
                <button type="button" className="btn datebtn" aria-label={showToken ? '隐藏口令' : '显示口令'} onClick={() => setShowToken((v) => !v)}>
                  {showToken ? '藏' : '看'}
                </button>
              </div>
            </div>
          </div>
          <div className="row">
            <button className="btn btn-sm btn-primary" onClick={saveAndTest} disabled={testing}>
              保存并测试连接
            </button>
            <button
              className="btn btn-sm btn-soft"
              onClick={async () => fb.toast((await copyText(workerCode)) ? `已复制 Worker 代码（${Math.round(workerCode.length / 1024)} KB）` : '复制失败，请从项目 worker/dist 目录获取', { bad: false })}
            >
              复制 Cloudflare Worker 代码
            </button>
          </div>
          <p className="xs muted">
            Cloudflare：Workers &amp; Pages → Create → Hello World → Edit code 粘贴 → Deploy；在 Settings → Variables and Secrets 添加 <span className="mono">GEMINI_API_KEY</span>（或 ANTHROPIC_API_KEY）、<span className="mono">ACCESS_TOKEN</span>（自定口令）、<span className="mono">ALLOWED_ORIGINS</span>＝<span className="mono">{typeof location !== 'undefined' ? location.origin : 'https://你的用户名.github.io'}</span>，再把 Worker 网址和口令填到上面。
          </p>
          <p className="xs muted">Claude App：把本应用发布为 Claude 页面后在 Claude App 里打开，会用你自己的 Claude 账号识别，不需要密钥。</p>
        </details>
        </>)}
        <label className="check">
          <input type="checkbox" checked={settings.cloudConsent} onChange={(e) => saveSettings({ cloudConsent: e.target.checked })} />
          <span>发送图片识别前不再逐次询问（取消勾选即可恢复每次询问）</span>
        </label>
        <p className="xs muted">默认不上传任何票据。只有你在识别页点「开始识别」并同意后，才会发送当前这 1 张图片。</p>
      </section>

      <details className="card more guide">
        <summary>电脑快捷键</summary>
        <ul className="steps small">
          <li><b>N</b> 新增账单</li>
          <li><b>/</b> 搜索账单</li>
          <li><b>G</b> 首页 · <b>L</b> 账单 · <b>F</b> 流水</li>
          <li><b>Esc</b> 关闭弹窗</li>
        </ul>
      </details>

      <button className="card row linkcard" onClick={() => go({ name: 'data' })}>
        <IDatabase width={22} height={22} />
        <span className="grow stack" style={{ gap: 0 }}>
          <b>数据管理</b>
          <span className="small muted">备份、恢复、存储空间、清空数据</span>
        </span>
        <span aria-hidden="true">›</span>
      </button>
    </>
  );
}

function ThemeSection() {
  const [pref, setPref] = useTheme();
  return (
    <section className="card row between" aria-label="外观">
      <h2 className="row">
        <ISun width={20} height={20} /> 外观
      </h2>
      <div className="seg seg-sm" role="group" aria-label="外观模式">
        {(
          [
            ['light', '光明'],
            ['dark', '深色'],
            ['system', '跟随系统'],
          ] as [ThemePref, string][]
        ).map(([k, l]) => (
          <button key={k} aria-pressed={pref === k} onClick={() => setPref(k)}>
            {l}
          </button>
        ))}
      </div>
    </section>
  );
}
