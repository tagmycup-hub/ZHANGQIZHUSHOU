import { useState } from 'react';
import { useStore } from '../store';
import { useFeedback } from '../ui/feedback';
import { copyText } from '../lib/platform';
import { configProblem, decodeConfig, encodeConfig, newSecret, newSpace, normalizeUrl, testConnection, SyncError, type SyncConfig } from '../sync/engine';
import setupSql from '../../supabase/setup.sql?raw';
import { ICloud, ICopy, IUpload, IDownload } from '../ui/icons';

export function syncLabel(s: ReturnType<typeof useStore>['sync']): string {
  if (!s.config) return '云同步未配置';
  if (s.status === 'syncing') return '同步中…';
  if (s.status === 'error') return `同步出错：${s.error}`;
  if (s.lastAt) return `已同步 ${new Date(s.lastAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`;
  return '已配置，等待同步';
}

export function SyncSettings() {
  const { sync, syncNow, saveSyncConfig, auth, publicConfig, go } = useStore();
  const fb = useFeedback();
  const c = sync.config;
  const [url, setUrl] = useState(c?.url ?? '');
  const [key, setKey] = useState(c?.key ?? '');
  const [space, setSpace] = useState(c?.space ?? newSpace());
  const [secret, setSecret] = useState(c?.secret ?? newSecret());
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [paste, setPaste] = useState('');
  const [editing, setEditing] = useState(!c);

  const draft = (): SyncConfig => ({ url: normalizeUrl(url), key: key.trim(), space: space.trim(), secret, auto: c?.auto ?? true });

  const saveAndTest = async () => {
    const cfg = draft();
    const p = configProblem(cfg);
    if (p) return fb.toast(p, { bad: true });
    setBusy('测试连接…');
    try {
      const st = await testConnection(cfg);
      const changedTarget = !c || c.url !== cfg.url || c.space !== cfg.space;
      await saveSyncConfig(cfg, { resetState: changedTarget });
      setEditing(false);
      fb.toast(st.exists ? `连接成功：云端已有 ${st.count} 条记录，正在下载合并…` : '连接成功：这是新的同步空间，正在上传本机数据…');
      setBusy('同步中…');
      const r = await syncNow();
      if (r) fb.toast(`同步完成：下载 ${r.applied} 条，上传 ${r.pushed} 条`);
    } catch (e) {
      fb.toast(e instanceof SyncError ? e.message : `连接失败：${(e as Error).message}`, { bad: true });
    } finally {
      setBusy(null);
    }
  };

  const importConfig = async () => {
    try {
      const cfg = decodeConfig(paste);
      setUrl(cfg.url);
      setKey(cfg.key);
      setSpace(cfg.space);
      setSecret(cfg.secret);
      setBusy('测试连接…');
      await testConnection(cfg);
      await saveSyncConfig(cfg, { resetState: true });
      setEditing(false);
      setPaste('');
      setBusy('下载合并…');
      const r = await syncNow();
      fb.toast(r ? `已连接，下载 ${r.applied} 条，上传 ${r.pushed} 条` : '已保存配置，但同步失败，请看上方提示');
    } catch (e) {
      fb.toast(e instanceof SyncError ? e.message : `导入失败：${(e as Error).message}`, { bad: true });
    } finally {
      setBusy(null);
    }
  };

  const run = async (label: string, opts: Parameters<typeof syncNow>[0]) => {
    setBusy(label);
    const r = await syncNow(opts);
    setBusy(null);
    if (r) fb.toast(`${label.replace('…', '')}完成：下载 ${r.applied} 条，上传 ${r.pushed} 条`);
  };

  const statusTone = !c ? 'neutral' : sync.status === 'error' ? 'overdue' : sync.status === 'syncing' ? 'dueSoon' : 'paid';

  // 账号模式：登录即同步，不需要空间名和口令
  if (c?.account) {
    return (
      <section className="card stack" aria-labelledby="h-sync">
        <h2 id="h-sync" className="row">
          <ICloud width={20} height={20} /> 云同步
        </h2>
        <div className="row between">
          <span className={`pill ${statusTone}`} style={{ whiteSpace: 'normal' }}>
            {syncLabel(sync)}
          </span>
          <span className="xs muted">账号 {auth.session?.user.email}</span>
        </div>
        <p className="xs muted">已用账号同步：在别的手机或电脑上用同一个邮箱登录，账单自动出现（照片不上传）。</p>
        <div className="row">
          <button className="btn btn-primary" disabled={!!busy} onClick={() => run('同步…', { mode: 'both' })}>
            {busy ? <span className="spin" /> : <ICloud />}
            {busy ?? '立即同步'}
          </button>
          <button className="btn btn-ghost" onClick={() => go({ name: 'account' })}>
            账号与套餐
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="card stack" aria-labelledby="h-sync">
      <h2 id="h-sync" className="row">
        <ICloud width={20} height={20} /> 云同步
      </h2>
      <div className="row between">
        <span className={`pill ${statusTone}`} style={{ whiteSpace: 'normal' }}>
          {syncLabel(sync)}
        </span>
        {c && <span className="xs muted mono">空间 {c.space}</span>}
      </div>
      {typeof window !== 'undefined' && !!window.claude?.use && (
        <div className="banner warn">
          <span className="grow small">Claude 页面版禁止连接外部网站，云同步多半无法使用。要在手机和电脑间同步，请用 GitHub Pages 版（数据可用「数据管理 → 导出备份」搬过去）。</span>
        </div>
      )}
      <p className="xs muted">手机和电脑用同一份配置即可共用账单（照片不上传）。</p>
      {(publicConfig || c) && !auth.session && (
        <div className="banner ok">
          <span className="grow small">更简单：<b>用邮箱登录账号</b>，所有设备自动同步，不用复制配置和口令。</span>
          <button className="btn btn-sm btn-primary" onClick={() => go({ name: 'account' })}>
            去登录
          </button>
        </div>
      )}

      {c && !editing && (
        <>
          <div className="row">
            <button className="btn btn-primary" disabled={!!busy} onClick={() => run('同步…', { mode: 'both' })}>
              {busy ? <span className="spin" /> : <ICloud />}
              {busy ?? '立即同步'}
            </button>
            <button className="btn" disabled={!!busy} onClick={() => run('上传改动…', { mode: 'push' })}>
              <IUpload />
              上传改动
            </button>
            <button className="btn" disabled={!!busy} onClick={() => run('下载合并…', { mode: 'pull' })}>
              <IDownload />
              下载合并
            </button>
          </div>
          <label className="check" style={{ padding: 0 }}>
            <input type="checkbox" checked={c.auto} onChange={(e) => saveSyncConfig({ ...c, auto: e.target.checked })} />
            <span>改动后自动同步（打开应用、回到前台、联网时也会自动下载合并）</span>
          </label>
          <div className="row">
            <button
              className="btn btn-sm btn-soft"
              onClick={async () => fb.toast((await copyText(encodeConfig(c))) ? '配置已复制。在另一台设备的「设置 → 云同步」里粘贴导入' : '复制失败', { bad: false })}
            >
              <ICopy />
              复制配置到别的设备
            </button>
            <button className="btn btn-sm" onClick={() => setEditing(true)}>
              修改连接
            </button>
            <button
              className="btn btn-sm"
              disabled={!!busy}
              onClick={async () => {
                const ok = await fb.confirm({ title: '强制全量上传？', body: '把本机所有账单、商家、账号重新上传一遍（云端较新的记录不会被覆盖）。一般只在换了 Supabase 项目或数据不一致时使用。', confirmLabel: '全量上传' });
                if (ok) run('全量上传…', { mode: 'both', force: true });
              }}
            >
              强制全量上传
            </button>
            <button
              className="btn btn-sm btn-danger-text"
              onClick={async () => {
                const ok = await fb.confirm({ title: '断开云同步？', body: '只是这台设备停止同步，本机和云端的数据都不会删除。', confirmLabel: '断开', danger: true });
                if (ok) {
                  await saveSyncConfig(null);
                  setEditing(true);
                }
              }}
            >
              断开
            </button>
          </div>
          <p className="xs muted">复制出的配置包含同步口令，只发给你自己的设备。</p>
        </>
      )}

      {editing && (
        <>
          <div className="field">
            <label htmlFor="sy-paste">已有配置？粘贴导入</label>
            <div className="datefield">
              <input id="sy-paste" className="input mono" value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="ZQSYNC1:…" autoComplete="off" spellCheck={false} />
              <button className="btn" disabled={!paste.trim() || !!busy} onClick={importConfig}>
                导入
              </button>
            </div>
          </div>
          <div className="divider" />
          <div className="grid2 stack-sm">
            <div className="field">
              <label htmlFor="sy-url">Project URL</label>
              <input id="sy-url" className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://xxxx.supabase.co" autoComplete="off" spellCheck={false} />
            </div>
            <div className="field">
              <label htmlFor="sy-key">publishable key</label>
              <input id="sy-key" className="input mono" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sb_publishable_… 或 anon key" autoComplete="off" spellCheck={false} />
            </div>
            <div className="field">
              <label htmlFor="sy-space">同步空间名</label>
              <input id="sy-space" className="input mono" value={space} onChange={(e) => setSpace(e.target.value)} autoComplete="off" spellCheck={false} />
              <span className="hint">同一个空间的设备共享数据。可以和「进货价格本」用同一个 Supabase 项目。</span>
            </div>
            <div className="field">
              <label htmlFor="sy-secret">同步口令</label>
              <div className="datefield">
                <input id="sy-secret" className="input mono" type={showSecret ? 'text' : 'password'} value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" />
                <button type="button" className="btn datebtn" aria-label={showSecret ? '隐藏口令' : '显示口令'} onClick={() => setShowSecret((v) => !v)}>
                  {showSecret ? '藏' : '看'}
                </button>
              </div>
              <span className="hint">第一台设备上传时设定，之后其他设备必须一致（至少 12 位，已为你随机生成）。</span>
            </div>
          </div>
          <div className="row">
            <button className="btn btn-primary" disabled={!!busy} onClick={saveAndTest}>
              {busy ? <span className="spin" /> : null}
              {busy ?? '测试连接并开始同步'}
            </button>
            {c && (
              <button className="btn btn-ghost" onClick={() => setEditing(false)}>
                取消
              </button>
            )}
          </div>
        </>
      )}

      <details className="more guide">
        <summary>第一次使用：在 Supabase 建表（只需一次）</summary>
        <ol className="steps small">
          <li>
            打开 <a href="https://supabase.com/dashboard" target="_blank" rel="noopener noreferrer">supabase.com/dashboard</a>，进入你的项目（可以就用价格本那个）。
          </li>
          <li>
            左侧 <b>SQL Editor</b> → <b>New query</b>，粘贴下面复制的脚本，点 <b>Run</b>。脚本可以重复运行。
            <div className="row" style={{ marginTop: 6 }}>
              <button className="btn btn-sm btn-soft" onClick={async () => fb.toast((await copyText(setupSql)) ? '建表脚本已复制' : '复制失败')}>
                <ICopy />
                复制建表脚本
              </button>
            </div>
          </li>
          <li>
            <b>Project Settings → API Keys</b>：复制 <b>Project URL</b> 和 <b>publishable key</b>（旧项目叫 anon public key）填到上面。
          </li>
          <li>点「测试连接并开始同步」。其他设备用「复制配置到别的设备」一键导入。</li>
        </ol>
        <p className="xs muted">安全说明：数据表对外关闭，只能通过脚本里的 3 个函数读写，并且必须带同步口令（云端只存口令的哈希）。仅凭 URL 和 publishable key 读不到你的账单。</p>
      </details>
    </section>
  );
}
