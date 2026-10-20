import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { useFeedback } from '../ui/feedback';
import type { ModelOutput } from '../lib/ocr/protocol';
import { matchMerchantSmart } from '../lib/ocr/learn';
import { planStatement, statementBills, type StatementRow } from '../lib/statement';
import { formatBRL, parseBRL } from '../lib/money';
import { formatBR, parseBRDate } from '../lib/dates';
import { describeTerm } from '../lib/terms';
import { uuid, nowISO } from '../lib/ids';
import { nextSlot } from '../lib/colors';
import { ICheck } from '../ui/icons';
import type { Merchant } from '../lib/types';

/** 对账单识别结果：一次导入多笔账单 */
export function StatementReview({ model, imageUrl, onCancel }: { model: ModelOutput; imageUrl: string | null; onCancel: () => void }) {
  const { merchants, accounts, bills, settings, today, repo, guard, reload, go } = useStore();
  const fb = useFeedback();
  const st = model.statement!;
  const raw = model.merchant.value ?? '';
  const suppliers = merchants.filter((m) => m.active && (m.type ?? 'supplier') === 'supplier');
  const [merchantId, setMerchantId] = useState<string>(() => matchMerchantSmart(raw, [], merchants)?.merchant.id ?? (raw ? 'new' : ''));
  const [newName, setNewName] = useState(raw);
  const [termDays, setTermDays] = useState('30');
  const merchant = merchants.find((m) => m.id === merchantId) ?? null;
  const name = merchantId === 'new' ? newName.trim() : merchant?.name ?? '';
  // 识别漏掉的日期 / 金额可以在表里补上
  const [edits, setEdits] = useState<Record<number, { date?: string | null; cents?: number | null }>>({});
  const st2 = useMemo(() => ({ ...st, entries: st.entries.map((e, i) => ({ ...e, ...edits[i] })) }), [st, edits]);
  const planned = useMemo(
    () => planStatement(st2, { merchant, merchantName: name, termDays: Number(termDays) || 0, bills, today, key: uuid }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [st2, merchant?.id, name, termDays, bills, today],
  );
  // 用户的勾选和修改按行号保存，重新计算（改商家、后台同步）时不会丢
  const [overrides, setOverrides] = useState<Record<number, Partial<StatementRow>>>({});
  const rows: StatementRow[] = planned.map((r, i) => ({ ...r, ...overrides[i] }));
  const set = (i: number, patch: Partial<StatementRow>) => setOverrides((o) => ({ ...o, [i]: { ...o[i], ...patch } }));
  const chosen = rows.filter((r) => r.include && r.cents && r.date);
  const unpaidSum = rows.filter((r) => !r.paid && r.cents).reduce((a, r) => a + (r.cents ?? 0), 0);
  const balanceOk = st.balanceCents === null || st.balanceCents === unpaidSum;

  const save = async () => {
    if (!name) return fb.toast('请选择或填写商家', { bad: true });
    if (!chosen.length) return fb.toast('没有勾选要导入的账单', { bad: true });
    let m = merchant;
    const newMerchants: Merchant[] = [];
    if (!m) {
      m = { id: uuid(), name, aliases: raw && raw !== name ? [raw] : [], defaultAccountId: null, active: true, color: nextSlot(merchants), createdAt: nowISO(), updatedAt: nowISO() };
      newMerchants.push(m);
    } else if (raw && ![m.name, ...m.aliases].some((a) => a.toLowerCase() === raw.toLowerCase())) {
      // 记住对账单上的叫法（如客户编号），下次自动匹配
      newMerchants.push({ ...m, aliases: [...m.aliases, raw], updatedAt: nowISO() });
    }
    const account = accounts.find((a) => a.id === (m!.defaultAccountId ?? settings.defaultAccountId)) ?? null;
    const list = statementBills(rows, { merchant: m, merchantName: name, account, reminderDays: settings.defaultReminderDays, now: nowISO(), key: uuid });
    const ok = await guard(async () => {
      await repo.upsertMany({ bills: list, merchants: newMerchants });
      return true;
    });
    if (!ok) return;
    await reload();
    fb.toast(`已导入 ${list.length} 笔账单（其中已付 ${list.filter((b) => b.paidAt).length} 笔）`);
    go({ name: 'bills', filter: `q=${encodeURIComponent(name)}` }, true);
  };

  return (
    <div className="stack">
      <div className="banner info">
        <span className="grow small">
          识别为<b>对账单</b>：共 {st.entries.length} 笔欠款、{st.payments.length} 条付款记录。请核对后一次导入。
        </span>
      </div>
      {imageUrl && (
        <details className="card more">
          <summary>查看原图</summary>
          <img src={imageUrl} alt="对账单原图" style={{ width: '100%', borderRadius: 10, marginTop: 8 }} />
        </details>
      )}
      <section className="card stack">
        <div className="grid2">
          <div className="field">
            <label htmlFor="st-m">商家</label>
            <select id="st-m" className="input" value={merchantId} onChange={(e) => setMerchantId(e.target.value)}>
              <option value="">请选择</option>
              {suppliers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
              <option value="new">＋ 新建商家</option>
            </select>
            {raw && <span className="hint">对账单上写的是「{raw}」{merchant ? '，导入后会记为这个商家的别名' : ''}</span>}
          </div>
          {merchantId === 'new' && (
            <div className="field">
              <label htmlFor="st-new">新商家名称</label>
              <input id="st-new" className="input" value={newName} onChange={(e) => setNewName(e.target.value)} />
            </div>
          )}
          {merchant?.term ? (
            <div className="field">
              <span className="flabel">到期日</span>
              <span className="small">按商家账期：{describeTerm(merchant.term)}</span>
            </div>
          ) : (
            <div className="field">
              <label htmlFor="st-term">账期天数（单据日期 + N 天 = 到期日）</label>
              <input id="st-term" className="input num" inputMode="numeric" value={termDays} onChange={(e) => setTermDays(e.target.value.replace(/\D/g, ''))} />
            </div>
          )}
        </div>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>导入</th>
                <th>单据</th>
                <th className="r">金额 / 到期</th>
                <th>已付</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>
                    <input type="checkbox" checked={r.include} disabled={!!r.problem} onChange={(e) => set(i, { include: e.target.checked })} aria-label={`导入 ${r.orderNumber || formatBR(r.date ?? '')}`} />
                  </td>
                  <td>
                    {st.entries[i]?.date || (st.entries[i]?.dateRaw && !edits[i]) ? (
                      <div className="num">{r.date ? formatBR(r.date) : '—'}</div>
                    ) : (
                      <input
                        className="input num st-edit"
                        placeholder="DD/MM/AAAA"
                        aria-label="补填日期"
                        defaultValue={r.date ? formatBR(r.date) : ''}
                        onBlur={(e) => setEdits((x) => ({ ...x, [i]: { ...x[i], date: parseBRDate(e.target.value).iso } }))}
                      />
                    )}
                    <div className="xs muted mono">{r.orderNumber ? `#${r.orderNumber}` : ''}</div>
                    {r.problem && <div className="xs err">{r.problem}</div>}
                    {r.duplicateOf && <div className="xs" style={{ color: 'var(--soon)' }}>已录过，默认跳过</div>}
                  </td>
                  <td className="r">
                    {st.entries[i]?.cents ? (
                      <div className="num" style={{ fontWeight: 800 }}>{formatBRL(r.cents ?? 0)}</div>
                    ) : (
                      <input
                        className="input num st-edit"
                        placeholder="0,00"
                        inputMode="decimal"
                        aria-label="补填金额"
                        defaultValue={r.cents ? formatBRL(r.cents, false) : ''}
                        onBlur={(e) => setEdits((x) => ({ ...x, [i]: { ...x[i], cents: parseBRL(e.target.value).cents } }))}
                      />
                    )}
                    <div className="xs muted num">{r.dueDate ? `到期 ${formatBR(r.dueDate)}` : ''}</div>
                  </td>
                  <td>
                    <input type="checkbox" checked={r.paid} onChange={(e) => set(i, { paid: e.target.checked, paidDate: e.target.checked ? r.paidDate ?? r.date : null })} aria-label="已付" />
                    {r.paid && r.paidDate && <div className="xs muted num">{formatBR(r.paidDate).slice(0, 5)}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {st.balanceCents !== null && (
          <p className={`small ${balanceOk ? 'ok-hint' : 'err'}`} style={{ margin: 0 }}>
            {balanceOk ? `✓ 未付合计 ${formatBRL(unpaidSum)} 与对账单「结欠」一致` : `未付合计 ${formatBRL(unpaidSum)} 与对账单「结欠」${formatBRL(st.balanceCents)} 不一致，请核对已付勾选`}
          </p>
        )}
        <div className="row end">
          <button className="btn btn-ghost" onClick={onCancel}>
            返回
          </button>
          <button className="btn btn-primary" onClick={save} disabled={!chosen.length || !name}>
            <ICheck />
            导入 {chosen.length} 笔账单
          </button>
        </div>
      </section>
    </div>
  );
}
