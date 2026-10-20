import { useEffect, useMemo, useState } from 'react';
import { restorePageState, savePageState } from '../nav';
import { useStore } from '../store';
import { billStatus } from '../lib/status';
import { formatBRL } from '../lib/money';
import { addDays, formatBR, weekdayCN, monthLabel } from '../lib/dates';
import { useActions } from '../actions';
import { ICal, ISearch, IList, IPlus, ICheckSquare, ICheck, IX, IFilter } from '../ui/icons';
import { MonthGrid, MonthNav } from '../ui/Calendar';
import { dailyTotals, monthSummary } from '../lib/monthly';
import { billTitle, EXPENSE_CATEGORIES, categoryLabel } from '../lib/expense';
import { amountOf, flatGroup, groupByMerchant, groupByWeek, groupPaid, groupUnpaidCards } from '../lib/groups';
import { GroupedBills, useGroupMode } from '../ui/BillList';
import { Modal } from '../ui/feedback';
import type { Bill } from '../lib/types';

type Tab = 'unpaid' | 'overdue' | 'dueSoon' | 'estimated' | 'paid' | 'all';
type TimeFilter = 'all' | 'thisMonth' | 'nextMonth' | 'next30' | 'last30';
type Sort = 'dueAsc' | 'dueDesc' | 'amountDesc' | 'amountAsc';
type KindFilter = 'all' | 'supplier' | 'expense';
type View = 'list' | 'month';

const TIME_LABEL: Record<TimeFilter, string> = { all: '不限时间', thisMonth: '本月到期', nextMonth: '下月到期', next30: '未来 30 天', last30: '过去 30 天' };
const SORT_LABEL: Record<Sort, string> = { dueAsc: '按到期日分组', dueDesc: '到期日 远→近', amountDesc: '金额 高→低', amountAsc: '金额 低→高' };
const KIND_LABEL: Record<KindFilter, string> = { all: '全部类型', supplier: '商家货款', expense: '日常缴费' };
const TABS: [Tab, string][] = [
  ['unpaid', '未付'],
  ['overdue', '逾期'],
  ['dueSoon', '即将到期'],
  ['estimated', '待确认'],
  ['paid', '已付'],
  ['all', '全部'],
];

interface SavedState {
  q: string;
  tab: Tab;
  time: TimeFilter;
  sort: Sort;
  kind: KindFilter;
  cat: string;
  view: View;
  month: string;
}
const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

export function Bills({ initialFilter }: { initialFilter?: string }) {
  const { bills, today, settings, go } = useStore();
  const { exportICS, markManyPaid, postponeMany } = useActions();
  const [postponeOpen, setPostponeOpen] = useState(false);
  const monthParam = initialFilter?.startsWith('month-') ? initialFilter.slice(6) : null;
  const qParam = initialFilter?.startsWith('q=') ? safeDecode(initialFilter.slice(2)) : '';
  // 从别处点商家进来（q=）时看这个商家的全部账单
  const initialTab = (TABS.find(([k]) => k === initialFilter)?.[0] ?? (qParam ? 'all' : 'unpaid')) as Tab;
  const stateKey = `bills:${initialFilter ?? ''}`;
  const saved = useState(() => restorePageState<SavedState>(stateKey))[0];
  const [q, setQ] = useState(saved?.q ?? qParam);
  const [tab, setTab] = useState<Tab>(saved?.tab ?? initialTab);
  const [time, setTime] = useState<TimeFilter>(saved?.time ?? 'all');
  const [sort, setSort] = useState<Sort>(saved?.sort ?? 'dueAsc');
  const [kind, setKind] = useState<KindFilter>(saved?.kind ?? 'all');
  const [cat, setCat] = useState<string>(saved?.cat ?? '');
  const [view, setView] = useState<View>(saved?.view ?? (monthParam ? 'month' : 'list'));
  const [month, setMonth] = useState(saved?.month ?? (monthParam && /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : today.slice(0, 7)));
  useEffect(() => savePageState<SavedState>(stateKey, { q, tab, time, sort, kind, cat, view, month }), [stateKey, q, tab, time, sort, kind, cat, view, month]);
  const [day, setDay] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  const [mode, setMode] = useGroupMode();

  // 搜索 + 类型筛选（不含状态）
  const base = useMemo(() => {
    const nq = norm(q.trim());
    return bills.filter((b) => {
      if (kind === 'supplier' && b.kind === 'expense') return false;
      if (kind === 'expense' && b.kind !== 'expense') return false;
      if (cat && b.category !== cat) return false;
      if (nq) {
        const hay = norm([billTitle(b), b.orderNumber, b.accountLabelSnapshot, b.notes, b.paymentCode ?? '', ...b.items.map((i) => i.description)].join(' '));
        if (!hay.includes(nq)) return false;
      }
      return true;
    });
  }, [bills, q, kind, cat]);

  // 时间筛选（列表 / 商家视图）或月份（月历视图）
  const scoped = useMemo(() => {
    const monthNow = today.slice(0, 7);
    const [y, m] = today.split('-').map(Number);
    const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    return base.filter((b) => {
      if (view === 'month') return day ? b.dueDate === day : b.dueDate.slice(0, 7) === month;
      if (time === 'thisMonth') return b.dueDate.slice(0, 7) === monthNow;
      if (time === 'nextMonth') return b.dueDate.slice(0, 7) === nextMonth;
      if (time === 'next30') return b.dueDate >= today && b.dueDate <= addDays(today, 30);
      if (time === 'last30') return b.dueDate <= today && b.dueDate >= addDays(today, -30);
      return true;
    });
  }, [base, time, today, view, month, day]);

  const counts = useMemo(() => {
    const c: Record<Tab, number> = { all: scoped.length, unpaid: 0, overdue: 0, dueSoon: 0, paid: 0, estimated: 0 };
    for (const b of scoped) {
      const s = billStatus(b, today, settings.dueSoonDays);
      if (s === 'paid') c.paid++;
      else {
        c.unpaid++;
        if (s === 'overdue') c.overdue++;
        if (s === 'dueSoon') c.dueSoon++;
        if (b.estimated) c.estimated++;
      }
    }
    return c;
  }, [scoped, today, settings.dueSoonDays]);

  const list = useMemo(() => {
    const out = scoped.filter((b) => {
      const s = billStatus(b, today, settings.dueSoonDays);
      if (tab === 'unpaid') return s !== 'paid';
      if (tab === 'estimated') return !!b.estimated && !b.paidAt;
      return tab === 'all' || s === tab;
    });
    const cmp: Record<Sort, (a: Bill, b: Bill) => number> = {
      dueAsc: (a, b) => a.dueDate.localeCompare(b.dueDate) || b.totalCents - a.totalCents,
      dueDesc: (a, b) => b.dueDate.localeCompare(a.dueDate) || b.totalCents - a.totalCents,
      amountDesc: (a, b) => b.totalCents - a.totalCents,
      amountAsc: (a, b) => a.totalCents - b.totalCents,
    };
    return out.sort(cmp[sort]);
  }, [scoped, tab, sort, today, settings.dueSoonDays]);

  const groups = useMemo(() => {
    const soon = settings.dueSoonDays;
    if (view === 'month') return day ? flatGroup(list, `${formatBR(day)} ${weekdayCN(day)}`) : groupByWeek(list, today);
    if (sort !== 'dueAsc') return flatGroup(list, SORT_LABEL[sort]);
    if (mode === 'merchant') return groupByMerchant(list, today, soon);
    if (tab === 'paid') return groupPaid(list);
    if (tab === 'all') return [...groupUnpaidCards(list.filter((b) => !b.paidAt), today, soon), ...groupPaid(list.filter((b) => b.paidAt))];
    return groupUnpaidCards(list, today, soon);
  }, [list, view, sort, tab, today, mode, day, settings.dueSoonDays]);
  const flat = groups.length === 1 && groups[0].key === 'flat';

  const total = list.reduce((s, b) => s + amountOf(b), 0);
  const totals = useMemo(() => dailyTotals(base), [base]);
  const ms = useMemo(() => monthSummary(base, month, today), [base, month, today]);

  const selected = list.filter((b) => sel.has(b.id));
  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const endSelect = () => {
    setSelecting(false);
    setSel(new Set());
  };

  const active: { label: string; clear: () => void }[] = [];
  if (kind !== 'all') active.push({ label: KIND_LABEL[kind], clear: () => { setKind('all'); setCat(''); } });
  if (cat) active.push({ label: categoryLabel(cat), clear: () => setCat('') });
  if (time !== 'all' && view !== 'month') active.push({ label: TIME_LABEL[time], clear: () => setTime('all') });
  if (sort !== 'dueAsc' && view === 'list') active.push({ label: SORT_LABEL[sort], clear: () => setSort('dueAsc') });
  const visibleTabs = TABS.filter(([k]) => (k === 'dueSoon' ? tab === k : k === 'estimated' ? counts[k] > 0 || tab === k : true));
  const unpaidInList = list.some((b) => !b.paidAt);

  return (
    <>
      <div className="bills-top">
        <div className="searchrow">
          <div className="sbox">
            <label htmlFor="q" className="sr-only">
              搜索
            </label>
            <ISearch width={18} height={18} />
            <input id="q" className="input" placeholder="搜索商家、单号、型号、付款码" value={q} onChange={(e) => setQ(e.target.value)} type="search" />
          </div>
          <button className="btn filterbtn" onClick={() => setFilterOpen(true)} aria-label={`筛选与排序${active.length ? `，已启用 ${active.length} 项` : ''}`}>
            <IFilter />
            <span className="only-wide">筛选</span>
            {active.length > 0 && <span className="n">{active.length}</span>}
          </button>
        </div>
        <div className="tabs" role="tablist" aria-label="账单状态">
          {visibleTabs.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={counts[k] ? `t-${k}` : ''} onClick={() => setTab(k)}>
              {label}
              <span className="n num">{counts[k]}</span>
            </button>
          ))}
        </div>
        {active.length > 0 && (
          <div className="activechips">
            {active.map((a) => (
              <button key={a.label} className="chip" aria-pressed="true" onClick={a.clear} aria-label={`取消筛选：${a.label}`}>
                {a.label} <IX width={14} height={14} />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="listbar">
        <div className="seg seg-sm" role="group" aria-label="视图">
          <button aria-pressed={view === 'list' && mode === 'date'} onClick={() => { setView('list'); setMode('date'); }}>
            按日期
          </button>
          <button aria-pressed={view === 'list' && mode === 'merchant'} onClick={() => { setView('list'); setMode('merchant'); }}>
            按商家
          </button>
          <button aria-pressed={view === 'month'} onClick={() => setView('month')}>
            月历
          </button>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {(
            <button className={`btn btn-sm iconbtn2${selecting ? ' btn-soft' : ''}`} onClick={() => (selecting ? endSelect() : setSelecting(true))} aria-pressed={selecting} title="多选" aria-label={selecting ? '取消多选' : '多选'}>
              <ICheckSquare />
              <span className="only-wide">{selecting ? '取消' : '多选'}</span>
            </button>
          )}
          {!selecting && (
            <button className="btn btn-sm iconbtn2" onClick={() => exportICS(list, `账期-未付-${today}.ics`)} disabled={!unpaidInList} title="把列表里的未付账单导出到手机日历" aria-label="导出日历">
              <ICal />
            </button>
          )}
        </div>
      </div>

      {view === 'month' && (
        <section className="card stack">
          <MonthNav
            month={month}
            onChange={(m) => {
              setMonth(m);
              setDay(null);
            }}
          />
          <div className="split2 num">
            <div>
              <span className="xs muted">{monthLabel(month)}到期 · {ms.count} 笔</span>
              <div style={{ fontWeight: 800, fontSize: '1.2rem' }}>{formatBRL(ms.totalCents)}</div>
            </div>
            <div>
              <span className="xs muted">
                未付 {ms.unpaidCount} 笔{ms.overdueCount ? ` · 逾期 ${ms.overdueCount}` : ''}
              </span>
              <div style={{ fontWeight: 800, fontSize: '1.2rem', color: ms.overdueCount ? 'var(--overdue)' : undefined }}>{formatBRL(ms.unpaidCents)}</div>
            </div>
          </div>
          <MonthGrid month={month} today={today} selected={day} totals={totals} size="lg" onPick={(d) => setDay(day === d ? null : d)} />
          <p className="xs muted">
            {day ? (
              <>
                只看 {formatBR(day)}。
                <button className="linkbtn" onClick={() => setDay(null)}>
                  看整月
                </button>
              </>
            ) : (
              '点日期只看那天'
            )}
          </p>
        </section>
      )}

      {selecting && (
        <div className="batchbar" role="toolbar" aria-label="批量操作">
          <span className="grow small">
            已选 <b>{selected.length}</b> 笔 · <span className="num">{formatBRL(selected.reduce((s, b) => s + amountOf(b), 0))}</span>
          </span>
          <button className="btn btn-sm cam-alt" onClick={() => setSel(sel.size === list.length ? new Set() : new Set(list.map((b) => b.id)))}>
            {sel.size === list.length && list.length ? '全不选' : '全选'}
          </button>
          <button
            className="btn btn-sm btn-primary"
            disabled={!selected.some((b) => !b.paidAt)}
            onClick={async () => {
              await markManyPaid(selected);
              endSelect();
            }}
          >
            <ICheck />
            标记已付
          </button>
          <button className="btn btn-sm cam-alt" disabled={!selected.some((b) => !b.paidAt)} onClick={() => setPostponeOpen(true)}>
            顺延
          </button>
          <button className="btn btn-sm cam-alt" disabled={!selected.some((b) => !b.paidAt)} onClick={() => exportICS(selected, `账期-选中-${today}.ics`)}>
            <ICal />
            日历
          </button>
          <button className="btn btn-sm cam-alt iconbtn" aria-label="退出多选" onClick={endSelect}>
            <IX />
          </button>
        </div>
      )}

      {list.length > 0 && (
        <p className="small muted listsum" style={{ margin: '-4px 4px' }}>
          合计 <b className="num" style={{ color: 'var(--ink)' }}>{formatBRL(total)}</b>
          {view === 'month' && day ? ` · ${formatBR(day)} ${weekdayCN(day)}` : ''}
        </p>
      )}

      {list.length === 0 ? (
        <div className="card empty">
          <div className="art">
            <IList />
          </div>
          <h3>{bills.length ? '没有符合条件的账单' : '还没有账单'}</h3>
          <p>{bills.length ? (active.length || q ? '换个筛选条件或清空搜索试试。' : tab === 'unpaid' ? '没有未付账单，全部结清了。' : '这里暂时是空的。') : '新增第一笔账单后会出现在这里。'}</p>
          <div className="row" style={{ justifyContent: 'center' }}>
            {(active.length > 0 || q) && (
              <button
                className="btn"
                onClick={() => {
                  setQ('');
                  setKind('all');
                  setCat('');
                  setTime('all');
                  setSort('dueAsc');
                }}
              >
                清除筛选
              </button>
            )}
            {!bills.length && (
              <>
                <button className="btn btn-primary" onClick={() => go({ name: 'new' })}>
                  <IPlus />
                  商家账单
                </button>
                <button className="btn" onClick={() => go({ name: 'new', kind: 'expense' })}>
                  <IPlus />
                  日常缴费
                </button>
              </>
            )}
          </div>
        </div>
      ) : (
        <GroupedBills groups={groups} rowLimit={flat ? 200 : 6} selectable={selecting} selected={sel} onToggle={toggle} onHead={(g) => g.sameTitle && setQ(g.label)} />
      )}

      {postponeOpen && (
        <Modal title={`顺延 ${selected.filter((b) => !b.paidAt).length} 笔的到期日`} onClose={() => setPostponeOpen(false)}>
          <p className="small muted" style={{ margin: 0 }}>
            和商家谈好延期时使用，只改未付的账单。
          </p>
          <div className="optgrid">
            {[3, 7, 15, 30].map((d) => (
              <button
                key={d}
                className="btn"
                onClick={async () => {
                  setPostponeOpen(false);
                  await postponeMany(selected, d);
                  endSelect();
                }}
              >
                +{d} 天
              </button>
            ))}
          </div>
        </Modal>
      )}
      {filterOpen && (
        <Modal title="筛选与排序" onClose={() => setFilterOpen(false)}>
          <div className="field">
            <span className="flabel">账单类型</span>
            <div className="seg" role="group" aria-label="账单类型">
              {(Object.keys(KIND_LABEL) as KindFilter[]).map((k) => (
                <button
                  key={k}
                  aria-pressed={kind === k}
                  onClick={() => {
                    setKind(k);
                    if (k !== 'expense') setCat('');
                  }}
                >
                  {k === 'all' ? '全部' : KIND_LABEL[k]}
                </button>
              ))}
            </div>
          </div>
          {kind === 'expense' && (
            <div className="field">
              <span className="flabel">缴费分类</span>
              <div className="optgrid">
                <button className="chip" aria-pressed={!cat} onClick={() => setCat('')}>
                  全部
                </button>
                {EXPENSE_CATEGORIES.map((c) => (
                  <button key={c.id} className="chip" aria-pressed={cat === c.id} onClick={() => setCat(cat === c.id ? '' : c.id)}>
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {view !== 'month' && (
            <div className="field">
              <span className="flabel">到期时间</span>
              <div className="optgrid">
                {(Object.keys(TIME_LABEL) as TimeFilter[]).map((k) => (
                  <button key={k} className="chip" aria-pressed={time === k} onClick={() => setTime(k)}>
                    {k === 'all' ? '不限' : TIME_LABEL[k]}
                  </button>
                ))}
              </div>
            </div>
          )}
          {view === 'list' && (
            <div className="field">
              <span className="flabel">排序</span>
              <div className="optgrid">
                {(Object.keys(SORT_LABEL) as Sort[]).map((k) => (
                  <button key={k} className="chip" aria-pressed={sort === k} onClick={() => setSort(k)}>
                    {SORT_LABEL[k]}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button
              className="btn btn-ghost"
              onClick={() => {
                setKind('all');
                setCat('');
                setTime('all');
                setSort('dueAsc');
              }}
            >
              重置
            </button>
            <button className="btn btn-primary" onClick={() => setFilterOpen(false)}>
              看 {list.length} 笔
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
