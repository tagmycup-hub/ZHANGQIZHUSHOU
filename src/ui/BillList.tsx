import { useState } from 'react';

export type GroupMode = 'date' | 'merchant';
const GM_KEY = 'zq.groupMode';
/** 记住用户选的归类方式（按日期 / 按商家） */
export function useGroupMode(): [GroupMode, (m: GroupMode) => void] {
  const [m, setM] = useState<GroupMode>(() => {
    try {
      return localStorage.getItem(GM_KEY) === 'merchant' ? 'merchant' : 'date';
    } catch {
      return 'date';
    }
  });
  return [
    m,
    (v) => {
      setM(v);
      try {
        localStorage.setItem(GM_KEY, v);
      } catch {}
    },
  ];
}

export function GroupModeSeg({ mode, onChange }: { mode: GroupMode; onChange: (m: GroupMode) => void }) {
  return (
    <div className="seg seg-sm" role="group" aria-label="归类方式">
      <button aria-pressed={mode === 'date'} onClick={() => onChange('date')}>
        按日期
      </button>
      <button aria-pressed={mode === 'merchant'} onClick={() => onChange('merchant')}>
        按商家
      </button>
    </div>
  );
}
import type { Bill } from '../lib/types';
import type { BillGroup } from '../lib/groups';
import { billStatus, STATUS_LABEL } from '../lib/status';
import { formatBR, relativeDue } from '../lib/dates';
import { formatBRL } from '../lib/money';
import { billTitle, categoryOf, isExpense } from '../lib/expense';
import { describeRepeat } from '../lib/recurrence';
import { useStore } from '../store';
import { useActions } from '../actions';
import { Modal } from './feedback';
import { BillCard } from './BillCard';
import { ICheck, IRepeat, IChevron } from './icons';
import { colorSlot } from '../lib/colors';
import { isPartial, openCents, paidPct } from '../lib/payments';
import { amountOf } from '../lib/groups';
import type { Merchant } from '../lib/types';

/** 商家名首个字母或汉字（跳过「示例 ·」和数字） */
export function initialOf(name: string): string {
  const m = name.replace(/^示例\s*·\s*/, '').match(/[A-Za-zÀ-ÿ\u4e00-\u9fff]/);
  return (m?.[0] ?? name.slice(0, 1) ?? '?').toUpperCase();
}

/** 商家头像：圆形 + 商家识别色（与行内的方形日期块区分） */
export function MerchantAvatar({ merchant, name, bill, size = 'md' }: { merchant?: Merchant | null; name: string; bill?: Bill; size?: 'sm' | 'md' | 'lg' }) {
  const slot = colorSlot(merchant, merchant?.id ?? bill?.merchantId ?? name);
  const text = bill && isExpense(bill) ? categoryOf(bill.category)?.mark ?? '缴' : initialOf(name);
  return (
    <span className={`mav mav-${size} mc-${slot}`} aria-hidden="true">
      {text}
    </span>
  );
}

function useMerchantOf() {
  const { merchants } = useStore();
  return (b: Bill) => (b.merchantId ? merchants.find((m) => m.id === b.merchantId) ?? null : null);
}

/** 卡片里的一行账单：点开看详情，右侧一键标记已付 */
export function BillRow({ bill, onOpen, selectable, selected, onToggle, sameTitle, amount, sub: subOverride, readOnly }: { bill: Bill; onOpen: (b: Bill) => void; selectable?: boolean; selected?: boolean; onToggle?: () => void; sameTitle?: boolean; amount?: number; sub?: string; readOnly?: boolean }) {
  const { today, settings } = useStore();
  const { markPaid } = useActions();
  const merchantOf = useMerchantOf();
  const st = billStatus(bill, today, settings.dueSoonDays);
  const title = billTitle(bill);
  const [leaving, setLeaving] = useState(false);
  const pay = () => {
    try {
      navigator.vibrate?.(15);
    } catch {}
    setLeaving(true);
    setTimeout(() => {
      void markPaid(bill).finally(() => setLeaving(false));
    }, 160);
  };
  const shortDate = (iso: string) => (iso.slice(0, 4) === today.slice(0, 4) ? formatBR(iso).slice(0, 5) : formatBR(iso));
  const paidText = bill.paidAt ? `${new Date(bill.paidAt).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' })} 已付` : '';
  const when = bill.paidAt ? paidText : relativeDue(bill.dueDate, today);
  const order = bill.orderNumber ? `#${bill.orderNumber}` : null;
  // 商家卡片：左边日期块就是到期日；标题写距离到期多久，下面写开单日（不再重复商家名和到期日）
  const main = sameTitle ? when : title;
  const sub = (sameTitle ? [`开单 ${shortDate(bill.billDate)}`, order] : [bill.paidAt ? paidText : `${shortDate(bill.dueDate)} · ${when}`, order]).filter(Boolean);
  return (
    <div className={`brow st-${st}${selected ? ' selected' : ''}${leaving ? ' leaving' : ''}`}>
      {selectable && <input type="checkbox" className="brow-check" checked={!!selected} onChange={onToggle} aria-label={`选择 ${title}`} />}
      <button type="button" className="brow-main" onClick={() => (selectable ? onToggle?.() : onOpen(bill))} aria-label={`${title}，${formatBRL(amount ?? amountOf(bill))}${isPartial(bill) ? `（还差，账单共 ${formatBRL(bill.totalCents)}）` : ''}，${STATUS_LABEL[st]}，到期 ${formatBR(bill.dueDate)}`}>
        {sameTitle ? (
          <span className={`brow-day st-${st}`} aria-hidden="true">
            <b>{bill.dueDate.slice(8, 10)}</b>
            <i>{Number(bill.dueDate.slice(5, 7))}月</i>
          </span>
        ) : (
          <MerchantAvatar merchant={merchantOf(bill)} name={title} bill={bill} />
        )}
        <span className="brow-text">
          <span className={`brow-title${sameTitle ? ` when st-${st}` : ''}`}>
            {main}
            {bill.installment && <span className="tag">{bill.installment.index}/{bill.installment.count}期</span>}
            {bill.recurrence && (
              <span className="tag" title={describeRepeat(bill.recurrence)}>
                <IRepeat width={11} height={11} />
                {describeRepeat(bill.recurrence).split('，')[0]}
              </span>
            )}
            {bill.estimated && !bill.paidAt && <span className="tag warn">待确认</span>}
            {isPartial(bill) && <span className="tag warn">已付 {paidPct(bill)}%</span>}
          </span>
          <span className={`brow-sub${!sameTitle && st === 'overdue' ? ' err' : ''}`}>{subOverride ?? sub.join(' · ')}</span>
        </span>
        <span className="brow-amt num" title={isPartial(bill) ? `账单 ${formatBRL(bill.totalCents)}，还差 ${formatBRL(openCents(bill))}` : undefined}>
          {formatBRL(amount ?? amountOf(bill))}
        </span>
      </button>
      {!selectable && !readOnly &&
        (bill.paidAt ? (
          <span className="brow-done" aria-label="已付款">
            <ICheck />
          </span>
        ) : (
          <button type="button" className="brow-pay" aria-label={`标记已付：${title}`} title="标记已付" disabled={leaving} onClick={pay}>
            <ICheck />
          </button>
        ))}
    </div>
  );
}

function GroupCard({ g, rowLimit, onOpen, selectable, selected, onToggle, onHead }: { g: BillGroup; rowLimit: number; onOpen: (b: Bill) => void; selectable?: boolean; selected?: Set<string>; onToggle?: (id: string) => void; onHead?: (g: BillGroup) => void }) {
  const { today } = useStore();
  const merchantOf = useMerchantOf();
  const [all, setAll] = useState(false);
  const shown = all ? g.bills : g.bills.slice(0, rowLimit);
  const hidden = g.bills.length - shown.length;
  const allSel = selectable && g.bills.every((b) => selected?.has(b.id));
  const first = g.bills[0];
  const m = g.sameTitle ? merchantOf(first) : null;
  const slot = g.sameTitle ? colorSlot(m, m?.id ?? first.merchantId ?? g.label) : null;
  const overdueN = g.bills.filter((b) => !b.paidAt && b.dueDate < today).length;
  return (
    <section className={`gcard tone-${g.tone}${slot != null ? ` by-merchant mc-${slot}` : ''}`} aria-label={`${g.label}，${g.bills.length} 笔，${formatBRL(g.total)}`}>
      <header className={`gc-head${onHead && !selectable ? ' clickable' : ''}`} onClick={onHead && !selectable ? () => onHead(g) : undefined} role={onHead && !selectable ? 'button' : undefined} tabIndex={onHead && !selectable ? 0 : undefined} onKeyDown={onHead && !selectable ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onHead(g)) : undefined}>
        {g.sameTitle && <MerchantAvatar merchant={m} name={g.label} bill={first} size="lg" />}
        <div className="gc-title">
          <span className="glabel">
            {g.label}
            <span className="gc-count num" title={`${g.bills.length} 笔`}>
              {g.bills.length}
            </span>
          </span>
          {g.sameTitle ? overdueN > 0 && <span className="gc-flag">逾期 {overdueN}</span> : g.sub && <span className="gc-sub">{g.sub}</span>}
        </div>
        <span className="gc-total num">{formatBRL(g.total)}</span>
        {selectable && (
          <input
            type="checkbox"
            className="brow-check"
            aria-label={`全选 ${g.label}`}
            checked={!!allSel}
            onChange={() => g.bills.forEach((b) => (allSel ? selected?.has(b.id) : !selected?.has(b.id)) && onToggle?.(b.id))}
          />
        )}
      </header>
      <div className="gc-body">
        {shown.map((b) => (
          <BillRow key={b.id} bill={b} sameTitle={g.sameTitle} onOpen={onOpen} selectable={selectable} selected={selected?.has(b.id)} onToggle={() => onToggle?.(b.id)} />
        ))}
      </div>
      {g.bills.length > rowLimit && (
        <button type="button" className={`gc-more${all ? ' open' : ''}`} onClick={() => setAll((v) => !v)}>
          {all ? '收起' : `还有 ${hidden} 笔`}
          <IChevron width={14} height={14} />
        </button>
      )}
    </section>
  );
}

/** 卡片网格：每张卡片是一组（日期段或商家），卡片内是账单列表 */
export function GroupedBills({ groups, maxCards, rowLimit = 4, selectable, selected, onToggle, emptyNode, onHead }: { groups: BillGroup[]; maxCards?: number; rowLimit?: number; selectable?: boolean; selected?: Set<string>; onToggle?: (id: string) => void; emptyNode?: React.ReactNode; onHead?: (g: BillGroup) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const { bills } = useStore();
  const current = open ? bills.find((b) => b.id === open) ?? null : null;
  if (!groups.length) return <>{emptyNode ?? null}</>;
  const shown = maxCards ? groups.slice(0, maxCards) : groups;
  return (
    <>
      <div className="gcards">
        {shown.map((g) => (
          <GroupCard key={g.key} g={g} rowLimit={selectable ? Infinity : rowLimit} onOpen={(x) => setOpen(x.id)} selectable={selectable} selected={selected} onToggle={onToggle} onHead={onHead} />
        ))}
      </div>
      {current && (
        <Modal title={billTitle(current)} onClose={() => setOpen(null)}>
          <BillCard bill={current} inSheet onDone={() => setOpen(null)} />
        </Modal>
      )}
    </>
  );
}
