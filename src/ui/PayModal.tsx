import { useEffect, useRef, useState } from 'react';
import type { Bill } from '../lib/types';
import { Modal } from './feedback';
import { DateField } from './Calendar';
import { useStore } from '../store';
import { formatBRL, parseBRL, centsToInput } from '../lib/money';
import { openCents } from '../lib/payments';
import { parseBRDate, formatBR } from '../lib/dates';
import { billTitle } from '../lib/expense';
import { ICamera } from './icons';

/** 压缩照片：最长边 1600px，JPEG */
export async function shrinkImage(f: Blob, max = 1600): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(f);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    return (await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.82))) ?? f;
  } catch {
    return f;
  }
}

/** 记一笔付款：金额可以只付一部分 */
export function PayModal({ bill, onClose, onSave }: { bill: Bill; onClose: () => void; onSave: (cents: number, date: string, note?: string, receipt?: Blob | null) => void }) {
  const { today } = useStore();
  const left = openCents(bill);
  const [amount, setAmount] = useState(centsToInput(left));
  const [date, setDate] = useState(formatBR(today));
  const [note, setNote] = useState('');
  const [receipt, setReceipt] = useState<{ blob: Blob; url: string } | null>(null);
  const receiptUrl = useRef<string | null>(null);
  receiptUrl.current = receipt?.url ?? null;
  useEffect(() => () => { if (receiptUrl.current) URL.revokeObjectURL(receiptUrl.current); }, []);
  const [shrinking, setShrinking] = useState(false);
  const parsed = parseBRL(amount);
  const iso = parseBRDate(date).iso;
  const err = !parsed.cents || parsed.cents <= 0 ? '请填写付款金额' : parsed.cents > left ? `不能超过还差的 ${formatBRL(left)}` : !iso ? '付款日期不正确' : null;
  const quick = [
    { label: '全部', cents: left },
    { label: '一半', cents: Math.round(left / 2) },
    { label: '30%', cents: Math.round(left * 0.3) },
  ];
  return (
    <Modal title={`记一笔付款 · ${billTitle(bill)}`} onClose={onClose}>
      <p className="small muted" style={{ margin: 0 }}>
        账单 {formatBRL(bill.totalCents)}，还差 <b style={{ color: 'var(--ink)' }}>{formatBRL(left)}</b>
      </p>
      <div className="field">
        <label htmlFor="pay-amount">本次付款金额 R$</label>
        <input id="pay-amount" className="input num big-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
        <div className="row" style={{ gap: 6 }}>
          {quick.map((q) => (
            <button key={q.label} type="button" className="btn btn-sm btn-soft" onClick={() => setAmount(centsToInput(q.cents))}>
              {q.label}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label htmlFor="pay-date">付款日期</label>
        <DateField id="pay-date" title="选择付款日期" value={date} today={today} onChange={setDate} />
      </div>
      <div className="field">
        <label htmlFor="pay-note">备注（可空）</label>
        <input id="pay-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="如：定金、尾款、PIX" maxLength={60} />
      </div>
      <div className="field">
        <span className="flabel">付款凭证（可选）</span>
        {receipt ? (
          <div className="row">
            <img src={receipt.url} alt="付款凭证预览" className="receipt-thumb" />
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => { URL.revokeObjectURL(receipt.url); setReceipt(null); }}>
              移除
            </button>
          </div>
        ) : (
          <label className="btn btn-sm" style={{ alignSelf: 'flex-start' }}>
            {shrinking ? <span className="spin" /> : <ICamera />}
            拍照 / 选截图
            <input
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                setShrinking(true);
                try {
                  const blob = await shrinkImage(f);
                  setReceipt((old) => { if (old) URL.revokeObjectURL(old.url); return { blob, url: URL.createObjectURL(blob) }; });
                } finally {
                  setShrinking(false);
                }
              }}
            />
          </label>
        )}
        <span className="hint">PIX 回单、转账截图等，只保存在这台设备。</span>
      </div>
      {err && <p className="small err" style={{ margin: 0 }}>{err}</p>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" onClick={onClose}>
          取消
        </button>
        <button className="btn btn-primary" disabled={!!err} onClick={() => !err && onSave(parsed.cents!, iso!, note.trim() || undefined, receipt?.blob ?? null)}>
          保存付款
        </button>
      </div>
    </Modal>
  );
}
