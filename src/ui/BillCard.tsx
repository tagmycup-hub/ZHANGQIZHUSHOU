import { useRef, useState } from 'react';
import type { Bill } from '../lib/types';
import { billStatus, STATUS_ICON, STATUS_LABEL } from '../lib/status';
import { formatBR, relativeDue, addDays } from '../lib/dates';
import { formatBRL, formatQuantity } from '../lib/money';
import { useStore } from '../store';
import { useActions } from '../actions';
import { ICal, ICheck, IEdit, IUndo, IWallet, IReceipt, ICopy, IRepeat } from './icons';
import { googleCalendarUrl } from '../lib/platform';
import { billTitle, categoryOf, describePaymentCode, isExpense } from '../lib/expense';
import { TOTAL_ONLY_DESC } from '../lib/ocr/protocol';
import { describeRepeat } from '../lib/recurrence';
import { isPartial, openCents, paymentsOf } from '../lib/payments';
import { nonBusinessReason, nextBusinessDay } from '../lib/holidays';
import { PayModal } from './PayModal';
import { ITrash, IImage } from './icons';
import { ReceiptViewer } from './ReceiptViewer';

export function StatusPill({ bill, today, days }: { bill: Bill; today: string; days: number }) {
  const s = billStatus(bill, today, days);
  return (
    <span className={`pill ${s}`}>
      <i aria-hidden="true">{STATUS_ICON[s]}</i>
      {STATUS_LABEL[s]}
    </span>
  );
}

export function BillCard({
  bill,
  compact = false,
  selectable = false,
  selected = false,
  onToggle,
  inSheet = false,
  onDone,
}: {
  bill: Bill;
  compact?: boolean;
  selectable?: boolean;
  selected?: boolean;
  onToggle?: () => void;
  /** 在详情抽屉里显示：不重复标题，操作按钮平铺 */
  inSheet?: boolean;
  onDone?: () => void;
}) {
  const { today, settings, go, accounts } = useStore();
  const { markPaid, markUnpaid, exportICS, copySummary, copyCode, removeBill, generateNext, addPayment, removePayment, copyBillCode } = useActions();
  const [payOpen, setPayOpen] = useState(false);
  const [viewReceipt, setViewReceipt] = useState<string | null>(null);
  const pays = paymentsOf(bill);
  const left = openCents(bill);
  const partial = isPartial(bill);
  const [more, setMore] = useState(false);
  const menuRef = useRef<HTMLDetailsElement>(null);
  const st = billStatus(bill, today, settings.dueSoonDays);
  const expense = isExpense(bill);
  const cat = categoryOf(bill.category);
  const title = billTitle(bill);
  const totalOnly = bill.amountMode === 'total' && !bill.installment;
  const shownItems = bill.items.slice(0, 3);
  const pix = accounts.find((a) => a.id === bill.accountId)?.optionalPixHint;
  return (
    <article
      className={`bill${inSheet ? ' in-sheet' : ''}${st === 'paid' ? ' is-paid' : ''}${selectable ? ' selectable' : ''}${selected ? ' selected' : ''}`}
      aria-label={`${title} ${formatBRL(bill.totalCents)} ${STATUS_LABEL[st]}`}
      onClick={selectable ? onToggle : undefined}
    >
      {selectable && <input type="checkbox" className="selbox" checked={selected} onChange={onToggle} onClick={(e) => e.stopPropagation()} aria-label={`选择 ${title}`} />}
      <div className="top">
        {expense && (
          <span className="catmark" aria-hidden="true">
            {cat?.mark ?? '缴'}
          </span>
        )}
        <div className="grow">
          {!inSheet && <div className="merchant">{title}</div>}
          <div className="meta">
            {bill.orderNumber && <span className="mono">#{bill.orderNumber}</span>}
            {bill.installment && (
              <span className="pill brand">
                分期 {bill.installment.index}/{bill.installment.count}
              </span>
            )}
            {bill.recurrence && (
              <span title="重复账单">
                <IRepeat width={13} height={13} />
                {describeRepeat(bill.recurrence)}
              </span>
            )}
            {partial && <span className="pill dueSoon">已付 {Math.round(((bill.totalCents - left) / bill.totalCents) * 100)}%</span>}
            {bill.estimated && <span className="pill dueSoon">金额待确认</span>}
            {bill.ocrReview && (
              <span title="来自票据识别">
                <IReceipt width={14} height={14} />
                识别
              </span>
            )}
          </div>
        </div>
        <div className="amount num">{formatBRL(bill.totalCents)}</div>
      </div>
      <div className="row between">
        <StatusPill bill={bill} today={today} days={settings.dueSoonDays} />
        <span className={`small num ${st === 'overdue' ? 'err' : 'muted'}`} style={{ fontWeight: 700 }}>
          {st === 'paid' ? `到期 ${formatBR(bill.dueDate)}` : `${formatBR(bill.dueDate)} · ${relativeDue(bill.dueDate, today)}`}
        </span>
      </div>
      {!bill.paidAt && nonBusinessReason(bill.dueDate) && (
        <span className="xs muted">
          到期日是{nonBusinessReason(bill.dueDate)}，银行顺延到 {formatBR(nextBusinessDay(bill.dueDate)).slice(0, 5)}
        </span>
      )}
      <div className="meta">
        <span>
          <IWallet width={14} height={14} />
          {bill.accountLabelSnapshot || '未指定账号'}
        </span>
        <span className="num">开单 {formatBR(bill.billDate)}</span>
        {bill.paidAt ? <span className="num">付款 {new Date(bill.paidAt).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</span> : <span>提前 {bill.reminderDays} 天提醒</span>}
      </div>
      {!compact && !selectable && !bill.paidAt && (bill.paymentCode || pix) && (
        <div className="stack" style={{ gap: 4 }}>
          {bill.paymentCode && (
            <div className="codebox">
              <span className="mono" title={bill.paymentCode}>
                {describePaymentCode(bill.paymentCode)}：{bill.paymentCode}
              </span>
              <button className="btn btn-sm btn-soft" onClick={() => copyBillCode(bill)}>
                <ICopy />
                复制
              </button>
            </div>
          )}
          {!bill.paymentCode && pix && (
            <div className="codebox">
              <span className="mono">PIX：{bill.accountLabelSnapshot}</span>
              <button className="btn btn-sm btn-soft" onClick={() => copyCode(pix, 'PIX')}>
                <ICopy />
                复制 PIX
              </button>
            </div>
          )}
        </div>
      )}
      {!compact && !totalOnly && (bill.items.length > 1 || bill.items[0]?.description !== TOTAL_ONLY_DESC) && (
        <div className="items">
          {(more ? bill.items : shownItems).map((i) => (
            <div key={i.id} className="row between num" style={{ gap: 6, flexWrap: 'nowrap' }}>
              <span style={{ overflowWrap: 'anywhere' }}>
                {bill.installment ? i.description : (
                  <>
                    {formatQuantity(i.quantity)} × <b>{i.description}</b> × {formatBRL(i.unitPriceCents, false)}
                  </>
                )}
              </span>
              <span>{formatBRL(i.subtotalCents, false)}</span>
            </div>
          ))}
          {bill.items.length > 3 && (
            <button className="btn btn-ghost btn-sm" onClick={() => setMore((m) => !m)} style={{ paddingLeft: 0 }}>
              {more ? '收起' : `还有 ${bill.items.length - 3} 行`}
            </button>
          )}
        </div>
      )}
      {!compact && totalOnly && bill.items[0]?.description !== TOTAL_ONLY_DESC && <div className="items">{bill.items[0]?.description}</div>}
      {inSheet && pays.length > 0 && (
        <div className="paylist">
          <div className="row between">
            <span className="xs muted" style={{ fontWeight: 700 }}>付款记录</span>
            {partial && (
              <span className="xs" style={{ fontWeight: 800, color: 'var(--soon)' }}>
                已付 {formatBRL(bill.totalCents - left)} · 还差 {formatBRL(left)}
              </span>
            )}
          </div>
          {pays.map((p) => (
            <div key={p.id} className="payrow">
              <span className="num">{formatBR(p.date)}</span>
              <span className="grow small muted">{p.note || (p.cents >= bill.totalCents ? '一次付清' : '分次付款')}</span>
              {p.receiptImageId && (
                <button className="btn btn-sm btn-ghost iconbtn" aria-label={`查看 ${formatBR(p.date)} 的付款凭证`} onClick={() => setViewReceipt(p.receiptImageId!)}>
                  <IImage width={15} height={15} />
                </button>
              )}
              <span className="num" style={{ fontWeight: 800 }}>
                {formatBRL(p.cents)}
              </span>
              <button className="btn btn-sm btn-ghost iconbtn" aria-label={`删除 ${formatBR(p.date)} 的付款记录`} onClick={() => removePayment(bill, p.id)}>
                <ITrash width={15} height={15} />
              </button>
            </div>
          ))}
        </div>
      )}
      {inSheet && (
        <div className="sheet-actions">
          {bill.paidAt ? (
            <button className="btn" onClick={() => markUnpaid(bill)}>
              <IUndo />
              恢复未付
            </button>
          ) : (
            <>
              <button
                className="btn btn-primary"
                onClick={async () => {
                  await markPaid(bill);
                  onDone?.();
                }}
              >
                <ICheck />
                {partial ? `付清尾款 ${formatBRL(left)}` : '标记已付'}
              </button>
              <button className="btn" onClick={() => setPayOpen(true)}>
                <IWallet />
                记一笔付款
              </button>
            </>
          )}
          <button
            className="btn"
            onClick={() => {
              onDone?.();
              go({ name: 'edit', id: bill.id });
            }}
          >
            <IEdit />
            {bill.estimated ? '确认金额' : '编辑'}
          </button>
          <button
            className="btn"
            onClick={() => {
              onDone?.();
              go({ name: 'copy', id: bill.id });
            }}
          >
            <ICopy />
            复制为新账单
          </button>
          <button className="btn" onClick={() => copySummary(bill)}>
            复制账单文字
          </button>
          {bill.recurrence && (
            <button className="btn" onClick={() => generateNext(bill)}>
              <IRepeat />
              现在生成下一期
            </button>
          )}
          {!bill.paidAt && (
            <>
              <button className="btn" onClick={() => exportICS([bill], `账期-${title}-${bill.dueDate}.ics`)}>
                <ICal />
                导出到日历
              </button>
              <a
                className="btn"
                target="_blank"
                rel="noopener noreferrer"
                href={googleCalendarUrl(`${expense ? '缴费' : '付款'}：${title} ${formatBRL(bill.totalCents)}`, bill.dueDate, addDays(bill.dueDate, 1), `单号 ${bill.orderNumber || '—'}\n账号：${bill.accountLabelSnapshot || '未指定'}${bill.paymentCode ? `\n付款码：${bill.paymentCode}` : ''}`)}
              >
                Google 日历
              </a>
            </>
          )}
          <button
            className="btn btn-danger-text"
            onClick={async () => {
              if (await removeBill(bill)) onDone?.();
            }}
          >
            <ITrash />
            删除
          </button>
        </div>
      )}
      {payOpen && <PayModal bill={bill} onClose={() => setPayOpen(false)} onSave={async (cents, date, note, receipt) => { await addPayment(bill, cents, date, note, receipt); setPayOpen(false); if (cents >= left) onDone?.(); }} />}
      {viewReceipt && <ReceiptViewer id={viewReceipt} onClose={() => setViewReceipt(null)} />}
      {!selectable && !inSheet && (
        <div className="actions">
          {bill.paidAt ? (
            <button className="btn btn-sm" onClick={() => markUnpaid(bill)}>
              <IUndo />
              恢复未付
            </button>
          ) : (
            <button className="btn btn-sm btn-primary" onClick={() => markPaid(bill)}>
              <ICheck />
              标记已付
            </button>
          )}
          <button className="btn btn-sm btn-ghost" onClick={() => go({ name: 'edit', id: bill.id })}>
            <IEdit />
            {bill.estimated ? '确认金额' : '编辑'}
          </button>
          <details className="more" style={{ marginLeft: 'auto' }} ref={menuRef}>
            <summary className="btn btn-sm btn-ghost" aria-label="更多操作">
              ···
            </summary>
            <div className="stack menu" style={{ gap: 4, paddingTop: 6 }} onClick={() => setTimeout(() => menuRef.current?.removeAttribute('open'), 0)}>
              <button className="btn btn-sm" onClick={() => go({ name: 'copy', id: bill.id })}>
                <ICopy />
                复制为新账单
              </button>
              <button className="btn btn-sm" onClick={() => copySummary(bill)}>
                复制账单文字
              </button>
              {!bill.paidAt && (
                <>
                  <button className="btn btn-sm" onClick={() => exportICS([bill], `账期-${title}-${bill.dueDate}.ics`)}>
                    <ICal />
                    导出 .ics 日历
                  </button>
                  <a
                    className="btn btn-sm"
                    target="_blank"
                    rel="noopener noreferrer"
                    href={googleCalendarUrl(`${expense ? '缴费' : '付款'}：${title} ${formatBRL(bill.totalCents)}`, bill.dueDate, addDays(bill.dueDate, 1), `单号 ${bill.orderNumber || '—'}\n账号：${bill.accountLabelSnapshot || '未指定'}${bill.paymentCode ? `\n付款码：${bill.paymentCode}` : ''}`)}
                  >
                    添加到 Google 日历
                  </a>
                </>
              )}
            </div>
          </details>
        </div>
      )}
    </article>
  );
}
