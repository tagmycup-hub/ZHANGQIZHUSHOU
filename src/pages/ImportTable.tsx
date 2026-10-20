import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { useFeedback } from '../ui/feedback';
import { FIELD_LABEL, IMPORT_TEMPLATE, planImport, type Field, type ImportPlan } from '../lib/importTable';
import { formatBRL } from '../lib/money';
import { formatBR } from '../lib/dates';
import { uuid, nowISO } from '../lib/ids';
import { saveFile } from '../lib/platform';
import { IUpload, IDownload, ICheck, IX } from '../ui/icons';
import type { Merchant } from '../lib/types';

/** 从 Excel / CSV 批量导入账单 */
export function ImportTable() {
  const store = useStore();
  const { bills, merchants, accounts, settings, today, repo, guard, reload, go } = store;
  const fb = useFeedback();
  const [text, setText] = useState('');
  const [fields, setFields] = useState<Field[] | null>(null);
  const [createMissing, setCreateMissing] = useState(true);
  const [busy, setBusy] = useState(false);

  const plan: ImportPlan | null = useMemo(() => {
    if (!text.trim()) return null;
    return planImport(text, { merchants, accounts, bills, settings, today, uuid, now: nowISO() }, fields ?? undefined);
  }, [text, merchants, accounts, bills, settings, today, fields]);

  const run = async () => {
    if (!plan) return;
    const rows = plan.rows.filter((r) => r.bill && !r.duplicateOf);
    if (!rows.length) return fb.toast('没有可导入的行', { bad: true });
    setBusy(true);
    try {
      const newM: Merchant[] = [];
      if (createMissing) {
        for (const name of plan.newMerchants) {
          const m: Merchant = { id: uuid(), name, aliases: [], defaultAccountId: null, active: true, color: (merchants.length + newM.length) % 7, createdAt: nowISO(), updatedAt: nowISO() };
          newM.push(m);
        }
      }
      const byName = new Map(newM.map((m) => [m.name.toLowerCase(), m]));
      const list = rows.map((r) => {
        const b = r.bill!;
        const m = b.merchantId ? null : byName.get(b.merchantNameSnapshot.toLowerCase());
        return m ? { ...b, merchantId: m.id } : b;
      });
      const ok = await guard(async () => {
        await repo.upsertMany({ bills: list, merchants: newM });
        return true;
      });
      if (!ok) return;
      await reload();
      fb.toast(`已导入 ${list.length} 笔账单${newM.length ? `，新建 ${newM.length} 个商家` : ''}`, { action: { label: '查看账单', run: () => go({ name: 'bills' }) } });
      setText('');
      setFields(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack" aria-labelledby="h-imp">
      <h2 id="h-imp">从表格批量导入账单</h2>
      <p className="small muted" style={{ margin: 0 }}>
        从 Excel、Google 表格里复制整块内容（含表头）粘贴进来，或选择 .csv 文件。支持中文和葡文表头：商家/Fornecedor、单号/NF、开单/Emissão、到期/Vencimento、金额/Valor、付款账号、分类、备注。
      </p>
      <div className="row">
        <label className="btn">
          <IUpload />
          选择 CSV 文件
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            className="sr-only"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              setFields(null);
              setText(await f.text());
            }}
          />
        </label>
        <button
          className="btn btn-sm"
          onClick={async () => {
            const r = await saveFile('账单导入模板.csv', IMPORT_TEMPLATE, 'text/csv;charset=utf-8');
            if (r.outcome === 'saved') fb.toast('模板已下载，填好后再导入');
          }}
        >
          <IDownload />
          下载模板
        </button>
      </div>
      <div className="field">
        <label htmlFor="imp-text">或直接粘贴</label>
        <textarea
          id="imp-text"
          className="input"
          rows={4}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setFields(null);
          }}
          placeholder={'商家;单号;开单日期;到期日期;金额\nLoja Exemplo;0042;01/09/2026;01/10/2026;1.234,56'}
          spellCheck={false}
        />
      </div>

      {plan && plan.rows.length > 0 && (
        <>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <span className="pill paid">
              <ICheck width={13} height={13} /> 可导入 {plan.okCount}
            </span>
            {plan.dupCount > 0 && <span className="pill dueSoon">重复跳过 {plan.dupCount}</span>}
            {plan.badCount > 0 && <span className="pill overdue">有问题 {plan.badCount}</span>}
          </div>
          <div className="impcols">
            {plan.fields.map((f, i) => (
              <label key={i} className="impcol">
                <span className="xs muted">第 {i + 1} 列{plan.headers[i] && plan.headers[i] !== f ? `（${plan.headers[i]}）` : ''}</span>
                <select
                  className="input"
                  value={f}
                  aria-label={`第 ${i + 1} 列对应字段`}
                  onChange={(e) => {
                    const next = [...plan.fields];
                    next[i] = e.target.value as Field;
                    setFields(next);
                  }}
                >
                  {(Object.keys(FIELD_LABEL) as Field[]).map((k) => (
                    <option key={k} value={k}>
                      {FIELD_LABEL[k]}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>行</th>
                  <th>商家</th>
                  <th>到期</th>
                  <th className="r">金额</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {plan.rows.slice(0, 30).map((r) => (
                  <tr key={r.index}>
                    <td className="num">{r.index}</td>
                    <td>
                      {r.bill?.merchantNameSnapshot || r.merchantName || '—'}
                      {r.bill && !r.merchantId && <span className="tag" style={{ marginLeft: 4 }}>新商家</span>}
                    </td>
                    <td className="num">{r.bill ? formatBR(r.bill.dueDate) : '—'}</td>
                    <td className="r num">{r.bill ? formatBRL(r.bill.totalCents) : '—'}</td>
                    <td className={r.issues.length ? 'err' : r.duplicateOf ? '' : 'ok'}>
                      {r.issues.length ? (
                        <>
                          <IX width={13} height={13} /> {r.issues.join('；')}
                        </>
                      ) : r.duplicateOf ? (
                        `已存在（${r.duplicateOf.orderNumber ? `单号 ${r.duplicateOf.orderNumber}` : formatBR(r.duplicateOf.dueDate)}），跳过`
                      ) : (
                        <>
                          <ICheck width={13} height={13} /> 可导入
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {plan.rows.length > 30 && <p className="xs muted" style={{ margin: 0 }}>只显示前 30 行，导入时会处理全部 {plan.rows.length} 行。</p>}
          {plan.newMerchants.length > 0 && (
            <label className="check" style={{ padding: 0 }}>
              <input type="checkbox" checked={createMissing} onChange={(e) => setCreateMissing(e.target.checked)} />
              <span>
                自动新建 {plan.newMerchants.length} 个商家：{plan.newMerchants.slice(0, 3).join('、')}
                {plan.newMerchants.length > 3 ? '…' : ''}
              </span>
            </label>
          )}
          <div className="row">
            <button className="btn btn-primary" disabled={busy || !plan.okCount} onClick={run}>
              {busy ? <span className="spin" /> : <ICheck />}
              导入 {plan.okCount} 笔账单
            </button>
            <button className="btn btn-ghost" onClick={() => { setText(''); setFields(null); }}>
              清空
            </button>
          </div>
        </>
      )}
    </section>
  );
}
