import { holidayName } from '../lib/holidays';
import { useEffect, useMemo, useState } from 'react';
import { monthGrid, monthLabel, shiftMonth, formatBR, parseBRDate, addDays, addMonths, endOfMonth, isValidISO } from '../lib/dates';
import { compactBRL, type DayTotal } from '../lib/monthly';
import { formatBRL } from '../lib/money';
import { Modal } from './feedback';
import { ICal } from './icons';

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

/** 月历网格：可显示每日到期金额 */
export function MonthGrid({
  month,
  today,
  selected,
  totals,
  onPick,
  size = 'md',
}: {
  month: string;
  today: string;
  selected?: string | null;
  totals?: Map<string, DayTotal>;
  onPick: (iso: string) => void;
  size?: 'md' | 'lg';
}) {
  const days = useMemo(() => monthGrid(month), [month]);
  // 只显示需要的行数
  const firstIdx = days.findIndex((d) => d.slice(0, 7) === month);
  const dim = days.filter((d) => d.slice(0, 7) === month).length;
  const rows = Math.ceil((firstIdx + dim) / 7);
  const shown = days.slice(0, rows * 7);
  // 方向键在日期间移动；整个月只占一个 Tab 位置
  const focusDay = shown.includes(selected ?? '') ? selected! : shown.includes(today) ? today : `${month}-01`;
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (!step) return;
    const cur = (document.activeElement as HTMLElement | null)?.dataset.day;
    const i = cur ? shown.indexOf(cur) : -1;
    if (i < 0) return;
    const j = Math.min(shown.length - 1, Math.max(0, i + step));
    e.preventDefault();
    (e.currentTarget.querySelector(`[data-day="${shown[j]}"]`) as HTMLElement | null)?.focus();
  };
  return (
    <div className={`mgrid ${size}`} role="grid" aria-label={monthLabel(month)} onKeyDown={onKey}>
      {WEEK.map((w, i) => (
        <div key={w} className={`mg-h${i === 0 || i === 6 ? ' we' : ''}`} role="columnheader">
          {w}
        </div>
      ))}
      {shown.map((d) => {
        const t = totals?.get(d);
        const out = d.slice(0, 7) !== month;
        const hol = holidayName(d);
        const cls = ['mg-d', out ? 'out' : '', d === today ? 'today' : '', d === selected ? 'sel' : '', hol ? 'hol' : '', t?.unpaidCount ? (d < today ? 'has-over' : 'has-due') : t?.count ? 'has-paid' : ''].filter(Boolean).join(' ');
        return (
          <button
            key={d}
            type="button"
            role="gridcell"
            data-day={d}
            tabIndex={d === focusDay ? 0 : -1}
            className={cls}
            aria-selected={d === selected}
            title={hol ?? undefined}
            aria-label={`${formatBR(d)}${hol ? `（${hol}）` : ''}${t ? `，${t.count} 笔，${formatBRL(t.cents)}${t.unpaidCount ? `，未付 ${formatBRL(t.unpaidCents)}` : ''}` : ''}`}
            onClick={() => onPick(d)}
          >
            <span className="n">{Number(d.slice(8))}</span>
            {t && <span className="amt num">{compactBRL(t.unpaidCount ? t.unpaidCents : t.cents)}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function MonthNav({ month, onChange, right }: { month: string; onChange: (m: string) => void; right?: React.ReactNode }) {
  return (
    <div className="mnav">
      <button type="button" className="btn btn-ghost iconbtn" aria-label="上个月" onClick={() => onChange(shiftMonth(month, -1))}>
        ‹
      </button>
      <span className="mnav-t">{monthLabel(month)}</span>
      <button type="button" className="btn btn-ghost iconbtn" aria-label="下个月" onClick={() => onChange(shiftMonth(month, 1))}>
        ›
      </button>
      {right}
    </div>
  );
}

export interface QuickDate {
  label: string;
  iso: string;
}

/** 日期输入：可手输 DD/MM/YYYY，也可点日历图标选择 */
export function DateField({
  id,
  value,
  onChange,
  className = '',
  today,
  totals,
  quick = [],
  title,
  hintNode,
}: {
  id: string;
  value: string;
  onChange: (text: string) => void;
  className?: string;
  today: string;
  totals?: Map<string, DayTotal>;
  quick?: QuickDate[];
  title: string;
  hintNode?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const iso = parseBRDate(value).iso;
  const [month, setMonth] = useState((iso ?? today).slice(0, 7));
  useEffect(() => {
    if (open) setMonth((iso ?? today).slice(0, 7));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (d: string) => {
    onChange(formatBR(d));
    setOpen(false);
  };
  const dayInfo = iso ? totals?.get(iso) : undefined;
  return (
    <>
      <div className="datefield">
        <input id={id} className={`input num ${className}`} inputMode="numeric" placeholder="DD/MM/YYYY" autoComplete="off" value={value} onChange={(e) => onChange(autoSlash(e.target.value, value))} />
        <button type="button" className="btn datebtn" aria-label={`打开日历选择${title}`} onClick={() => setOpen(true)}>
          <ICal />
        </button>
      </div>
      {dayInfo && dayInfo.unpaidCount > 0 && (
        <span className="hint">
          这天已有 {dayInfo.unpaidCount} 笔未付，共 {formatBRL(dayInfo.unpaidCents)}
        </span>
      )}
      {hintNode}
      {open && (
        <Modal title={title} onClose={() => setOpen(false)}>
          <MonthNav month={month} onChange={setMonth} />
          <MonthGrid month={month} today={today} selected={iso} totals={totals} onPick={pick} />
          {totals && <p className="xs muted">格子里的数字是当天已有账单的未付金额（R$），方便把付款日错开。</p>}
          <div className="qchips">
            {[{ label: '今天', iso: today }, ...quick].map((q) => (
              <button key={q.label} type="button" onClick={() => pick(q.iso)}>
                {q.label}
              </button>
            ))}
          </div>
          <div className="row end">
            <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
              关闭
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

/** 输入 8 位数字时自动补斜杠：10092026 → 10/09/2026 */
export function autoSlash(next: string, prev: string): string {
  next = next.replace(/\/\/+/g, '/');
  if (next.length < prev.length) return next;
  const digits = next.replace(/\D/g, '');
  if (/^\d{8}$/.test(next)) return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
  if (/^\d{2}$/.test(next) || /^\d{2}\/\d{2}$/.test(next)) return next + '/';
  return next;
}

export function dueQuickDates(billISO: string | null, today: string): QuickDate[] {
  const b = billISO && isValidISO(billISO) ? billISO : today;
  return [
    ...[7, 15, 30, 45, 60].map((d) => ({ label: `开单 +${d} 天`, iso: addDays(b, d) })),
    { label: '本月底', iso: endOfMonth(today) },
    { label: '下月同日', iso: addMonths(b, 1) },
  ];
}
