import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { useFeedback } from '../ui/feedback';
import { evaluableBills, evaluateHistory, evaluateOne, summarize, exportTestSet, pct, TARGETS, type EvalReport, type Ratio } from '../lib/ocr/evaluate';
import { listProviders, pickProvider, recognize, usefulProviders, RecognizeError } from '../lib/ocr/providers';
import { buildHints } from '../lib/ocr/learn';
import { saveFile } from '../lib/platform';
import { IChart } from '../ui/icons';

function Tile({ label, r, target, invert, hint }: { label: string; r: Ratio; target?: number; invert?: boolean; hint?: string }) {
  const v = invert ? null : pct(r);
  const good = invert ? r.ok === 0 : v !== null && target !== undefined ? v / 100 >= target : null;
  return (
    <div className={`evtile${good === false ? ' bad' : good ? ' good' : ''}`}>
      <span className="xs muted">{label}</span>
      <b className="num">{invert ? `${r.ok} 行` : v === null ? '—' : `${v}%`}</b>
      <span className="xs muted">{invert ? `${r.n} 张单据里` : r.n ? `${r.ok}/${r.n}` : '没有数据'}{hint ? ` · ${hint}` : ''}</span>
    </div>
  );
}

function ReportView({ rep, onOpen }: { rep: EvalReport; onOpen: (id: string) => void }) {
  const worst = [...rep.cases].filter((c) => c.problems.length).sort((a, b) => b.problems.length - a.problems.length).slice(0, 8);
  return (
    <div className="stack">
      <div className="evgrid">
        <Tile label="金额" r={rep.amount} target={TARGETS.amount} hint="目标 ≥95%" />
        <Tile label="型号" r={rep.codes} target={TARGETS.codes} hint="目标 ≥90%" />
        <Tile label="明细行完整率" r={rep.lines} target={TARGETS.lines} />
        <Tile label="多出的行（疑似编造）" r={rep.extra} invert />
        <Tile label="数量×单价" r={rep.qtyPrice} target={0.9} />
        <Tile label="商家" r={rep.merchant} target={0.9} />
        {rep.dueDate.n > 0 && <Tile label="到期日" r={rep.dueDate} target={0.95} />}
      </div>
      {Object.keys(rep.byProvider).length > 1 && (
        <div className="list">
          {Object.entries(rep.byProvider).map(([p, v]) => (
            <div key={p} className="li small">
              <span className="grow">{p}（{v.n} 张）</span>
              <span>金额 {pct(v.amount) ?? '—'}% · 型号 {pct(v.codes) ?? '—'}%</span>
            </div>
          ))}
        </div>
      )}
      {worst.length > 0 && (
        <details className="more">
          <summary>问题最多的单据（{worst.length}）</summary>
          <div className="list">
            {worst.map((c) => (
              <button key={c.billId} className="li" style={{ textAlign: 'left' }} onClick={() => onOpen(c.billId)}>
                <span className="grow stack" style={{ gap: 2 }}>
                  <span className="t">{c.label}</span>
                  <span className="xs muted">{c.problems.slice(0, 4).join('；')}</span>
                </span>
                <span aria-hidden="true">›</span>
              </button>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/** 识别准确率：用你复核保存后的账单当标准答案 */
export function EvalSection() {
  const { bills, merchants, repo, go, today, cloud, getToken, settings } = useStore();
  const fb = useFeedback();
  const list = useMemo(() => evaluableBills(bills), [bills]);
  const history = useMemo(() => (list.length ? evaluateHistory(bills, merchants) : null), [bills, merchants, list.length]);
  const [rerun, setRerun] = useState<EvalReport | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const withImage = list.filter((b) => b.ocrReview?.imageId);

  const doRerun = async () => {
    const n = Math.min(10, withImage.length);
    const ok = await fb.confirm({ title: `用当前 AI 重新识别 ${n} 张？`, body: <p>会用本机保存的单据图片重新识别最近 {n} 张（每张占 1 次 AI 识别额度），和你保存的结果对比，看换了提示词/模型后准不准。图片会发送到你的识别服务。</p>, confirmLabel: '开始' });
    if (!ok) return;
    const supa = cloud ? { ...cloud, bearer: await getToken() } : null;
    const ps = usefulProviders(await listProviders(settings.recognizeEndpoint, settings.recognizeToken, supa)).filter((p) => p.id !== 'local');
    const pid = pickProvider(ps, settings.lastProvider);
    if (!pid) return fb.toast('没有可用的 AI 识别方式（设置 → AI 识别）', { bad: true });
    const hints = buildHints(merchants, bills);
    const cases = [];
    const ctl = new AbortController();
    try {
      const recent = [...withImage].sort((a, b) => (b.ocrReview!.confirmedAt ?? '').localeCompare(a.ocrReview!.confirmedAt ?? '')).slice(0, n);
      for (let i = 0; i < recent.length; i++) {
        const b = recent[i];
        setProgress(`重新识别 ${i + 1}/${recent.length}：${b.merchantNameSnapshot}`);
        const img = await repo.getImage(b.ocrReview!.imageId!);
        if (!img) continue;
        const r = await recognize(pid, img, { endpoint: settings.recognizeEndpoint, token: settings.recognizeToken, supa, hints, accessToken: supa?.bearer ?? null, signal: ctl.signal });
        cases.push(evaluateOne(b, r.output, merchants, ps.find((p) => p.id === pid)?.label ?? pid));
      }
      setRerun(summarize(cases));
      fb.toast(`已重新识别 ${cases.length} 张`);
    } catch (e) {
      fb.toast(e instanceof RecognizeError ? e.message : `重新识别失败：${(e as Error).message}`, { bad: true });
      if (cases.length) setRerun(summarize(cases));
    } finally {
      setProgress(null);
    }
  };

  const doExport = async () => {
    const json = JSON.stringify({ format: 'zhangqi-ocr-testset', exportedAt: new Date().toISOString(), cases: exportTestSet(bills) }, null, 2);
    const r = await saveFile(`识别测试集-${today}.json`, json, 'application/json');
    if (r.outcome === 'saved' || r.outcome === 'shared') fb.toast(`已导出 ${list.length} 条标注`);
  };

  return (
    <section className="card stack" aria-labelledby="h-eval">
      <h2 id="h-eval" className="row">
        <IChart width={20} height={20} /> 识别准确率
      </h2>
      <p className="small">用你核对后保存的账单当标准答案，对比 AI 当时识别出的结果。核对过的单据越多，这里越准；你在核对时的修改也会被记住，下次同一商家自动更正。</p>
      {!history ? (
        <p className="small muted">还没有识别后保存的账单。用「拍照识别」录入几张单据后，这里会显示金额、型号、明细完整率等指标。</p>
      ) : (
        <>
          <span className="xs muted">历史识别 {history.cases.length} 张（不额外花额度）</span>
          <ReportView rep={history} onOpen={(id) => go({ name: 'edit', id })} />
        </>
      )}
      {rerun && (
        <>
          <h3>本次重新识别（{rerun.cases.length} 张）</h3>
          <ReportView rep={rerun} onOpen={(id) => go({ name: 'edit', id })} />
        </>
      )}
      {progress && (
        <span className="row small" aria-live="polite">
          <span className="spin" /> {progress}
        </span>
      )}
      <div className="row">
        <button className="btn btn-sm" disabled={!withImage.length || !!progress} onClick={doRerun}>
          用当前 AI 重新识别并评分
        </button>
        <button className="btn btn-sm btn-ghost" disabled={!list.length} onClick={doExport}>
          导出测试集（JSON）
        </button>
      </div>
      {!!list.length && !withImage.length && <span className="xs muted">这些账单的单据照片不在这台设备上（照片不参与同步），不能重新识别。</span>}
    </section>
  );
}
