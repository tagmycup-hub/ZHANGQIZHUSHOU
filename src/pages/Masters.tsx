import { MERCHANT_COLORS, colorSlot, nextSlot } from '../lib/colors';
import { BillRow, MerchantAvatar } from '../ui/BillList';
import { BillCard } from '../ui/BillCard';
import { merchantStats, unpaidStatement } from '../lib/merchantStats';
import { formatBRL } from '../lib/money';
import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { useFeedback, Modal } from '../ui/feedback';
import type { AccountType, Merchant, PaymentAccount, TermRule } from '../lib/types';
import { describeTerm, parseInstallmentDays, validateTerm, computeDueDates } from '../lib/terms';
import { EXPENSE_CATEGORIES, billTitle, categoryLabel } from '../lib/expense';
import { REPEAT_PRESETS, describeRepeat } from '../lib/recurrence';
import { formatBR, todayISO as todayLocal } from '../lib/dates';
import { ACCOUNT_TYPE_LABEL } from '../lib/types';
import { uuid, nowISO, maskHint } from '../lib/ids';
import { IPlus, IEdit, IEye, ICopy, IStore, IWallet } from '../ui/icons';
import { copyText } from '../lib/platform';

const norm = (s: string) => s.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();

export function Masters() {
  const [tab, setTab] = useState<'m' | 'p' | 'a'>('m');
  return (
    <>
      <div className="seg" role="tablist" aria-label="固定资料" style={{ alignSelf: 'flex-start' }}>
        <button role="tab" aria-selected={tab === 'm'} aria-pressed={tab === 'm'} onClick={() => setTab('m')}>
          商家
        </button>
        <button role="tab" aria-selected={tab === 'p'} aria-pressed={tab === 'p'} onClick={() => setTab('p')}>
          缴费单位
        </button>
        <button role="tab" aria-selected={tab === 'a'} aria-pressed={tab === 'a'} onClick={() => setTab('a')}>
          付款账号
        </button>
      </div>
      {tab === 'a' ? <AccountList /> : <MerchantList key={tab} type={tab === 'p' ? 'payee' : 'supplier'} />}
    </>
  );
}

function MerchantList({ type }: { type: 'supplier' | 'payee' }) {
  const word = type === 'payee' ? '缴费单位' : '商家';
  const { merchants, accounts, bills, settings, saveSettings, requireFeature } = useStore();
  const [edit, setEdit] = useState<Merchant | 'new' | null>(null);
  const [stats, setStats] = useState<Merchant | null>(null);
  const [q, setQ] = useState('');
  const [showOff, setShowOff] = useState(false);
  const mine = merchants.filter((m) => (m.type ?? 'supplier') === type);
  const list = useMemo(
    () =>
      mine
        .filter((m) => (showOff ? true : m.active))
        .filter((m) => !q || [m.name, ...m.aliases].some((n) => norm(n).includes(norm(q))))
        .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, 'zh')),
    [mine, q, showOff],
  );
  const count = (id: string) => bills.filter((b) => b.merchantId === id).length;
  const unpaid = (id: string) => bills.filter((b) => b.merchantId === id && !b.paidAt).reduce((s, b) => s + b.totalCents, 0);
  return (
    <section className="card stack">
      <div className="row between">
        <h2>
          {word} · {mine.filter((m) => m.active).length}
        </h2>
        <button className="btn btn-primary btn-sm" onClick={() => setEdit('new')}>
          <IPlus />
          新增{word}
        </button>
      </div>
      <div className="row">
        <input className="input grow" placeholder="搜索名称或别名" value={q} onChange={(e) => setQ(e.target.value)} aria-label={`搜索${word}`} type="search" />
        <label className="check" style={{ padding: 0 }}>
          <input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} />
          <span className="small">显示已停用</span>
        </label>
      </div>
      {list.length === 0 ? (
        <div className="empty">
          <div className="art">
            <IStore />
          </div>
          <p>{mine.length ? `没有匹配的${word}` : type === 'payee' ? '还没有缴费单位。例如 Sabesp（水费）、Enel（电费）、DAS（税费），可设置每月固定缴费日。' : '还没有商家。新增后，录账时即可直接选择，并可设置固定账期。'}</p>
        </div>
      ) : (
        <div className="list">
          {list.map((m) => (
            <div key={m.id} className={`li${m.active ? '' : ' off'}`}>
              <MerchantAvatar merchant={m} name={m.name} />
              <button className="grow stack li-open" style={{ gap: 2 }} onClick={() => setStats(m)} aria-label={`查看 ${m.name} 的对账`}>
                <span className="t">
                  {m.name} {settings.defaultMerchantId === m.id && <span className="pill brand">默认</span>} {!m.active && <span className="pill neutral">已停用</span>}
                </span>
                {m.term && <span className="pill brand" style={{ alignSelf: 'flex-start' }}>账期：{describeTerm(m.term)}</span>}
                <span className="xs muted">
                  {m.defaultCategory ? `${categoryLabel(m.defaultCategory)} · ` : ''}
                  {m.repeat ? `${describeRepeat(m.repeat)}重复 · ` : m.recurring ? '每月重复 · ' : ''}
                  {count(m.id)} 笔账单{unpaid(m.id) ? ` · 未付 R$ ${(unpaid(m.id) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : ''}
                  {m.defaultAccountId ? ` · 默认账号：${accounts.find((a) => a.id === m.defaultAccountId)?.label ?? '（已删除）'}` : ''}
                  {m.aliases.length ? ` · 别名：${m.aliases.join('、')}` : ''}
                </span>
              </button>
              {m.active && type === 'supplier' && settings.defaultMerchantId !== m.id && (
                <button className="btn btn-ghost btn-sm" onClick={() => saveSettings({ defaultMerchantId: m.id })}>
                  设默认
                </button>
              )}
              <button className="btn btn-sm iconbtn" aria-label={`编辑 ${m.name}`} onClick={() => setEdit(m)}>
                <IEdit />
              </button>
            </div>
          ))}
        </div>
      )}
      {edit && <MerchantForm type={type} initial={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
      {stats && <MerchantSheet merchant={stats} onClose={() => setStats(null)} onEdit={() => { setEdit(stats); setStats(null); }} />}
    </section>
  );
}

type TermKind = 'none' | 'days' | 'monthDay' | 'installments';

function MerchantForm({ type, initial, onClose }: { type: 'supplier' | 'payee'; initial: Merchant | null; onClose: () => void }) {
  const word = type === 'payee' ? '缴费单位' : '商家';
  const t0 = initial?.term ?? null;
  const [termKind, setTermKind] = useState<TermKind>(t0?.kind ?? 'none');
  const [days, setDays] = useState(t0?.kind === 'days' ? String(t0.days) : '30');
  const [mDay, setMDay] = useState(t0?.kind === 'monthDay' ? String(t0.day) : '10');
  const [mOff, setMOff] = useState(t0?.kind === 'monthDay' ? String(t0.monthOffset) : type === 'payee' ? '0' : '1');
  const [cutoff, setCutoff] = useState(t0?.kind === 'monthDay' && t0.cutoffDay ? String(t0.cutoffDay) : '');
  const [inst, setInst] = useState(t0?.kind === 'installments' ? t0.days.join('/') : '30/60/90');
  const [cat, setCat] = useState<string | null>(initial?.defaultCategory ?? null);
  const [repeatK, setRepeatK] = useState<string>(
    initial?.repeat ? REPEAT_PRESETS.find((p) => p.rule.unit === initial.repeat!.unit && p.rule.every === initial.repeat!.every)?.key ?? 'm1' : initial ? (initial.recurring ? 'm1' : 'none') : type === 'payee' ? 'm1' : 'none',
  );
  const buildTerm = (): TermRule | null | 'invalid' => {
    if (termKind === 'none') return null;
    if (termKind === 'days') return /^\d{1,3}$/.test(days.trim()) ? { kind: 'days', days: Number(days) } : 'invalid';
    if (termKind === 'installments') {
      const d = parseInstallmentDays(inst);
      return d ? { kind: 'installments', days: d } : 'invalid';
    }
    if (!/^\d{1,2}$/.test(mDay.trim()) || !/^\d{1,2}$/.test(mOff.trim()) || (cutoff.trim() && !/^\d{1,2}$/.test(cutoff.trim()))) return 'invalid';
    return { kind: 'monthDay', day: Number(mDay), monthOffset: Number(mOff), cutoffDay: cutoff.trim() ? Number(cutoff) : null };
  };
  const termNow = buildTerm();
  const termErr = termNow === 'invalid' ? '账期格式不正确' : validateTerm(termNow);
  const { merchants, accounts, bills, repo, guard, reload, settings, saveSettings, requireFeature } = useStore();
  const fb = useFeedback();
  const [name, setName] = useState(initial?.name ?? '');
  const [aliases, setAliases] = useState(initial?.aliases.join('，') ?? '');
  const [acc, setAcc] = useState(initial?.defaultAccountId ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [color, setColor] = useState<number>(initial ? colorSlot(initial) : nextSlot(merchants));
  const affected = initial ? bills.filter((b) => b.merchantId === initial.id).length : 0;

  const save = async () => {
    if (!requireFeature('edit')) return;
    const n = name.trim();
    if (!n) return setErr(`请填写${word}名称`);
    const term = buildTerm();
    if (term === 'invalid' || termErr) return setErr(termErr ?? '账期格式不正确');
    const al = aliases.split(/[,，;；\n]/).map((s) => s.trim()).filter(Boolean);
    const clash = merchants.find((m) => m.id !== initial?.id && (m.type ?? 'supplier') === type && [m.name, ...m.aliases].some((x) => norm(x) === norm(n) || al.some((a) => norm(a) === norm(x))));
    if (clash) return setErr(`名称或别名与「${clash.name}」${clash.active ? '' : '（已停用）'}重复，请修改或直接使用已有商家`);
    const m: Merchant = {
      id: initial?.id ?? uuid(),
      name: n,
      aliases: [...new Set(al)],
      defaultAccountId: acc || null,
      active: initial?.active ?? true,
      type,
      term,
      defaultCategory: type === 'payee' ? cat : null,
      recurring: repeatK !== 'none',
      repeat: REPEAT_PRESETS.find((p) => p.key === repeatK)?.rule ?? null,
      color,
      createdAt: initial?.createdAt ?? nowISO(),
      updatedAt: nowISO(),
    };
    await guard(() => repo.putMerchant(m));
    await reload();
    fb.toast(initial ? `${word}已更新（历史账单保留原名称快照）` : `已新增${word}`);
    onClose();
  };

  const toggleActive = async () => {
    if (!initial) return;
    await guard(() => repo.putMerchant({ ...initial, active: !initial.active, updatedAt: nowISO() }));
    if (initial.active && settings.defaultMerchantId === initial.id) await saveSettings({ defaultMerchantId: null });
    await reload();
    fb.toast(initial.active ? '已停用，历史账单不受影响' : '已重新启用');
    onClose();
  };

  const remove = async () => {
    if (!initial) return;
    const ok = await fb.confirm({
      title: `删除${word}「${initial.name}」？`,
      body: (
        <>
          <p>
            有 <b>{affected}</b> 笔账单关联到此{word}。删除后这些账单仍显示保存时的名称快照。
          </p>
          <p className="muted">推荐使用「停用」代替删除。</p>
        </>
      ),
      confirmLabel: '仍然删除',
      danger: true,
    });
    if (!ok) return;
    await guard(() => repo.deleteMerchant(initial.id));
    if (settings.defaultMerchantId === initial.id) await saveSettings({ defaultMerchantId: null });
    await reload();
    onClose();
  };

  return (
    <Modal title={initial ? `编辑${word}` : `新增${word}`} onClose={onClose}>
      <div className="field">
        <label htmlFor="m-name">名称</label>
        <input id="m-name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <div className="field">
        <label htmlFor="m-alias">别名（用逗号分隔）</label>
        <input id="m-alias" className="input" value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder={type === 'payee' ? '如：Enel SP，Eletropaulo' : '票据上的写法，如：AGOLD，黄筹'} />
        <span className="hint">识别时会用名称和别名自动匹配。</span>
      </div>
      {type === 'payee' && (
        <div className="field">
          <span className="label">默认缴费类型</span>
          <div className="qchips">
            {EXPENSE_CATEGORIES.map((c) => (
              <button key={c.id} type="button" aria-pressed={cat === c.id} style={cat === c.id ? { background: 'var(--brand)', color: 'var(--brand-ink)', borderColor: 'var(--brand)' } : undefined} onClick={() => setCat(cat === c.id ? null : c.id)}>
                {c.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="field">
        <span className="flabel">识别颜色</span>
        <div className="swatches" role="radiogroup" aria-label="识别颜色">
          {MERCHANT_COLORS.map((c, i) => (
            <button key={c} type="button" role="radio" aria-checked={color === i} aria-label={c} className={`swatch mc-${i}`} onClick={() => setColor(i)}>
              {color === i ? '✓' : ''}
            </button>
          ))}
        </div>
        <span className="hint">首页和账单里用这个颜色区分{word}。</span>
      </div>
      <div className="field">
        <label htmlFor="m-repeat">默认重复周期</label>
        <select id="m-repeat" className="input" value={repeatK} onChange={(e) => setRepeatK(e.target.value)}>
          <option value="none">不重复</option>
          {REPEAT_PRESETS.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </select>
        <span className="hint">选这个{word}记账时自动带出；付款后自动生成下一期。</span>
      </div>
      <div className="field">
        <label htmlFor="m-term">{type === 'payee' ? '固定缴费日' : '固定账期'}</label>
        <select id="m-term" className="input" value={termKind} onChange={(e) => setTermKind(e.target.value as TermKind)}>
          <option value="none">不固定（每次手动填写）</option>
          <option value="days">开单后 N 天</option>
          <option value="monthDay">每月固定日期</option>
          {type === 'supplier' && <option value="installments">分期付款（如 30/60/90 天）</option>}
        </select>
        {termKind === 'days' && (
          <div className="row">
            <span className="small">开单后</span>
            <input className="input num" style={{ width: 90 }} inputMode="numeric" aria-label="天数" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} />
            <span className="small">天付款</span>
            <div className="qchips">
              {[7, 15, 21, 28, 30, 45, 60].map((d) => (
                <button key={d} type="button" onClick={() => setDays(String(d))}>
                  {d}
                </button>
              ))}
            </div>
          </div>
        )}
        {termKind === 'monthDay' && (
          <div className="stack" style={{ gap: 8 }}>
            <div className="row">
              <select className="input" style={{ width: 'auto' }} aria-label="月份" value={mOff} onChange={(e) => setMOff(e.target.value)}>
                <option value="0">当月</option>
                <option value="1">次月</option>
                <option value="2">隔一个月</option>
              </select>
              <input className="input num" style={{ width: 80 }} inputMode="numeric" aria-label="几号" value={mDay} onChange={(e) => setMDay(e.target.value.replace(/\D/g, ''))} />
              <span className="small">号付款</span>
            </div>
            <div className="row">
              <span className="small">每月</span>
              <input className="input num" style={{ width: 80 }} inputMode="numeric" aria-label="截单日" placeholder="可空" value={cutoff} onChange={(e) => setCutoff(e.target.value.replace(/\D/g, ''))} />
              <span className="small">号截单（之后开的单再顺延一个月）</span>
            </div>
          </div>
        )}
        {termKind === 'installments' && (
          <div className="row">
            <input className="input mono" style={{ maxWidth: 200 }} aria-label="分期天数" value={inst} onChange={(e) => setInst(e.target.value)} placeholder="30/60/90" />
            <div className="qchips">
              {['30/60', '30/60/90', '28/56/84', '30/60/90/120'].map((v) => (
                <button key={v} type="button" onClick={() => setInst(v)}>
                  {v}
                </button>
              ))}
            </div>
          </div>
        )}
        {termErr ? (
          <span className="err">{termErr}</span>
        ) : termNow && termNow !== 'invalid' ? (
          <span className="hint ok-hint">
            {describeTerm(termNow)} · 例如今天开单 → 到期 {computeDueDates(termNow, todayLocal()).map(formatBR).join('、')}
          </span>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor="m-acc">默认付款账号</label>
        <select id="m-acc" className="input" value={acc} onChange={(e) => setAcc(e.target.value)}>
          <option value="">（不指定，用全局默认）</option>
          {accounts
            .filter((a) => a.active || a.id === acc)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
                {a.bank ? ` · ${a.bank}` : ''}
              </option>
            ))}
        </select>
      </div>
      {err && <p className="err">{err}</p>}
      <div className="row between">
        <div className="row" style={{ gap: 4 }}>
          {initial && (
            <>
              <button className="btn btn-sm" onClick={toggleActive}>
                {initial.active ? '停用' : '启用'}
              </button>
              <button className="btn btn-sm btn-danger-text" onClick={remove}>
                删除
              </button>
            </>
          )}
        </div>
        <div className="row">
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={save}>
            保存
          </button>
        </div>
      </div>
    </Modal>
  );
}

function AccountList() {
  const { accounts, bills, settings, saveSettings, requireFeature } = useStore();
  const fb = useFeedback();
  const [edit, setEdit] = useState<PaymentAccount | 'new' | null>(null);
  const [reveal, setReveal] = useState<string | null>(null);
  const [showOff, setShowOff] = useState(false);
  const list = accounts.filter((a) => showOff || a.active).sort((a, b) => Number(b.active) - Number(a.active) || a.label.localeCompare(b.label, 'zh'));
  return (
    <section className="card stack">
      <div className="row between">
        <h2>付款账号 · {accounts.filter((a) => a.active).length}</h2>
        <button className="btn btn-primary btn-sm" onClick={() => setEdit('new')}>
          <IPlus />
          新增账号
        </button>
      </div>
      <label className="check" style={{ padding: 0 }}>
        <input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} />
        <span className="small">显示已停用</span>
      </label>
      {list.length === 0 ? (
        <div className="empty">
          <div className="art">
            <IWallet />
          </div>
          <p>还没有付款账号。新增后，每笔账单都能记下用哪个账号付款。</p>
        </div>
      ) : (
        <div className="list">
          {list.map((a) => (
            <div key={a.id} className={`li${a.active ? '' : ' off'}`}>
              <div className="avatar" aria-hidden="true">
                {ACCOUNT_TYPE_LABEL[a.type].slice(0, 1)}
              </div>
              <div className="grow stack" style={{ gap: 2 }}>
                <span className="t">
                  {a.label} {settings.defaultAccountId === a.id && <span className="pill brand">默认</span>} {!a.active && <span className="pill neutral">已停用</span>}
                </span>
                <span className="xs muted">
                  {[ACCOUNT_TYPE_LABEL[a.type], a.bank, a.owner].filter(Boolean).join(' · ')} · {bills.filter((b) => b.accountId === a.id).length} 笔账单
                </span>
                {a.optionalPixHint && (
                  <span className="row" style={{ gap: 4 }}>
                    <span className="mono small">{reveal === a.id ? a.optionalPixHint : maskHint(a.optionalPixHint)}</span>
                    <button className="btn btn-ghost btn-sm iconbtn" aria-label={reveal === a.id ? '隐藏' : '显示完整'} onClick={() => setReveal(reveal === a.id ? null : a.id)}>
                      <IEye />
                    </button>
                    <button
                      className="btn btn-ghost btn-sm iconbtn"
                      aria-label="复制"
                      onClick={async () => fb.toast((await copyText(a.optionalPixHint)) ? '已复制，可以粘贴到银行 App' : '复制失败，请手动选择', { bad: false })}
                    >
                      <ICopy />
                    </button>
                  </span>
                )}
              </div>
              {a.active && settings.defaultAccountId !== a.id && (
                <button className="btn btn-ghost btn-sm" onClick={() => saveSettings({ defaultAccountId: a.id })}>
                  设默认
                </button>
              )}
              <button className="btn btn-sm iconbtn" aria-label={`编辑 ${a.label}`} onClick={() => setEdit(a)}>
                <IEdit />
              </button>
            </div>
          ))}
        </div>
      )}
      {edit && <AccountForm initial={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </section>
  );
}

function AccountForm({ initial, onClose }: { initial: PaymentAccount | null; onClose: () => void }) {
  const { accounts, merchants, bills, repo, guard, reload, settings, saveSettings, requireFeature } = useStore();
  const fb = useFeedback();
  const [f, setF] = useState({
    label: initial?.label ?? '',
    type: initial?.type ?? ('pix' as AccountType),
    owner: initial?.owner ?? '',
    bank: initial?.bank ?? '',
    optionalPixHint: initial?.optionalPixHint ?? '',
  });
  const [err, setErr] = useState<string | null>(null);
  const [color, setColor] = useState<number>(initial ? colorSlot(initial) : nextSlot(merchants));
  const affected = initial ? bills.filter((b) => b.accountId === initial.id).length : 0;
  const up = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));

  const save = async () => {
    if (!requireFeature('edit')) return;
    const label = f.label.trim();
    if (!label) return setErr('请填写账号名称');
    const clash = accounts.find((a) => a.id !== initial?.id && norm(a.label) === norm(label));
    if (clash) return setErr(`已有同名账号「${clash.label}」${clash.active ? '' : '（已停用）'}，请换个名字，例如加上银行名`);
    const a: PaymentAccount = {
      id: initial?.id ?? uuid(),
      label,
      type: f.type,
      owner: f.owner.trim(),
      bank: f.bank.trim(),
      optionalPixHint: f.optionalPixHint.trim(),
      active: initial?.active ?? true,
      createdAt: initial?.createdAt ?? nowISO(),
      updatedAt: nowISO(),
    };
    await guard(() => repo.putAccount(a));
    await reload();
    fb.toast(initial ? '账号已更新（历史账单保留原名称快照）' : '已新增账号');
    onClose();
  };

  const toggleActive = async () => {
    if (!initial) return;
    await guard(() => repo.putAccount({ ...initial, active: !initial.active, updatedAt: nowISO() }));
    if (initial.active && settings.defaultAccountId === initial.id) await saveSettings({ defaultAccountId: null });
    await reload();
    onClose();
  };

  const remove = async () => {
    if (!initial) return;
    const usedBy = merchants.filter((m) => m.defaultAccountId === initial.id).length;
    const ok = await fb.confirm({
      title: `删除账号「${initial.label}」？`,
      body: (
        <p>
          有 <b>{affected}</b> 笔账单使用此账号{usedBy ? `，${usedBy} 个商家把它设为默认` : ''}。账单仍保留名称快照，PIX 信息会被清除。推荐改用「停用」。
        </p>
      ),
      confirmLabel: '仍然删除',
      danger: true,
    });
    if (!ok) return;
    await guard(() => repo.deleteAccount(initial.id));
    if (settings.defaultAccountId === initial.id) await saveSettings({ defaultAccountId: null });
    await reload();
    onClose();
  };

  return (
    <Modal title={initial ? '编辑付款账号' : '新增付款账号'} onClose={onClose}>
      <div className="field">
        <label htmlFor="a-label">名称</label>
        <input id="a-label" className="input" value={f.label} onChange={(e) => up({ label: e.target.value })} placeholder="如：PIX 公司主账户" autoFocus />
      </div>
      <div className="grid2">
        <div className="field">
          <label htmlFor="a-type">类型</label>
          <select id="a-type" className="input" value={f.type} onChange={(e) => up({ type: e.target.value as AccountType })}>
            {(Object.keys(ACCOUNT_TYPE_LABEL) as AccountType[]).map((t) => (
              <option key={t} value={t}>
                {ACCOUNT_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="a-bank">银行</label>
          <input id="a-bank" className="input" value={f.bank} onChange={(e) => up({ bank: e.target.value })} placeholder="Itaú / Nubank…" />
        </div>
      </div>
      <div className="field">
        <label htmlFor="a-owner">户名</label>
        <input id="a-owner" className="input" value={f.owner} onChange={(e) => up({ owner: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="a-pix">PIX 键 / 账号（可空）</label>
        <input id="a-pix" className="input mono" value={f.optionalPixHint} onChange={(e) => up({ optionalPixHint: e.target.value })} autoComplete="off" />
        <span className="hint">仅在付款确实需要时填写。只保存在本机，列表中默认隐藏，导出备份时会包含。</span>
      </div>
      {err && <p className="err">{err}</p>}
      <div className="row between">
        <div className="row" style={{ gap: 4 }}>
          {initial && (
            <>
              <button className="btn btn-sm" onClick={toggleActive}>
                {initial.active ? '停用' : '启用'}
              </button>
              <button className="btn btn-sm btn-danger-text" onClick={remove}>
                删除
              </button>
            </>
          )}
        </div>
        <div className="row">
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={save}>
            保存
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** 商家对账：金额、账期表现、最近账单 */
function MerchantSheet({ merchant, onClose, onEdit }: { merchant: Merchant; onClose: () => void; onEdit: () => void }) {
  const { bills, today, go, requireFeature } = useStore();
  const fb = useFeedback();
  const s = merchantStats(bills, merchant.id, today);
  const [open, setOpen] = useState<string | null>(null);
  const current = open ? bills.find((b) => b.id === open) ?? null : null;
  const kv = (k: string, v: React.ReactNode, hint?: string) => (
    <div className="mstat">
      <span className="k">{k}</span>
      <span className="v num">{v}</span>
      {hint && <span className="h">{hint}</span>}
    </div>
  );
  if (current) {
    return (
      <Modal title={billTitle(current)} onClose={() => setOpen(null)}>
        <BillCard bill={current} inSheet onDone={() => setOpen(null)} />
      </Modal>
    );
  }
  return (
    <Modal title={merchant.name} onClose={onClose}>
      <div className="mstats">
        {kv('还要付', formatBRL(s.openCents), `${s.openCount} 笔${s.overdueCount ? ` · 逾期 ${s.overdueCount}` : ''}`)}
        {kv('累计已付', formatBRL(s.paidCents), `近 12 个月 ${formatBRL(s.last12Cents)}`)}
        {kv('账单数', String(s.count), s.lastBill ? `最近 ${formatBR(s.lastBill.billDate)}` : undefined)}
        {kv('平均账期', s.avgTermDays === null ? '—' : `${s.avgTermDays} 天`, merchant.term ? `设置：${describeTerm(merchant.term)}` : '未设置固定账期')}
        {kv('按时付清', s.onTimePct === null ? '—' : `${s.onTimePct}%`, s.avgPayDays === null ? undefined : `平均开单后 ${s.avgPayDays} 天付清`)}
        {kv('下一笔到期', s.nextDue ? formatBR(s.nextDue.dueDate) : '—', s.nextDue ? formatBRL(s.nextDue.totalCents) : '没有未付账单')}
      </div>
      {s.bills.length > 0 && (
        <div className="gcard" style={{ boxShadow: 'none', border: '1px solid var(--line)' }}>
          <div className="gc-body">
            {s.bills.slice(0, 5).map((b) => (
              <BillRow key={b.id} bill={b} sameTitle onOpen={(x) => setOpen(x.id)} />
            ))}
          </div>
        </div>
      )}
      <div className="row">
        <button className="btn btn-primary" onClick={() => go({ name: 'bills', filter: `q=${encodeURIComponent(merchant.name)}` })}>
          查看全部账单
        </button>
        <button
          className="btn"
          disabled={!s.openCount}
          onClick={async () => {
            const ok = await copyText(unpaidStatement(merchant.name, bills, merchant.id, today));
            fb.toast(ok ? '未付清单已复制，可直接发给对方' : '复制失败', { bad: !ok });
          }}
        >
          <ICopy />
          复制未付清单
        </button>
        <button className="btn" onClick={onEdit}>
          <IEdit />
          编辑资料
        </button>
      </div>
    </Modal>
  );
}
