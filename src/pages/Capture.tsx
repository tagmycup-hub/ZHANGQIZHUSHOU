import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { useFeedback, Modal } from '../ui/feedback';
import { takePendingFile, takePendingCamera, setPendingRecognition } from '../pending';
import { CameraSheet, cameraSupported } from '../ui/Camera';
import { decodeImage, rotateCanvas, warpQuad, enhance, exportForRecognition, ImageError, VARIANT_LABEL, type Variant } from '../lib/image/process';
import { checkQuad, type Pt } from '../lib/image/geometry';
import { listProviders, pickProvider, recognize, RecognizeError, usefulProviders, type ProviderInfo, type ProviderId } from '../lib/ocr/providers';
import { draftFromModel, type EditorState, type ModelOutput } from '../lib/ocr/protocol';
import { applyLearning, buildCatalog, buildHints, matchMerchantSmart } from '../lib/ocr/learn';
import { enrichDraft } from '../lib/ocr/enrich';
import { textToModel } from '../lib/ocr/pdfText';
import { isPdf, readPdf } from '../lib/pdf';
import { detectCodes } from '../lib/image/codes';
import { StatementReview } from './StatementReview';
import { addDays, formatBR, parseBRDate, todayISO } from '../lib/dates';
import { formatBRL } from '../lib/money';
import { computeDueDates } from '../lib/terms';
import { uuid } from '../lib/ids';
import { ICamera, IImage, IRotate, ISpark, IShield, IEdit } from '../ui/icons';

type Step = 'pick' | 'adjust' | 'enhance' | 'recognize' | 'statement';

const ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.pdf';

const normAngle = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

function defaultQuad(w: number, h: number): Pt[] {
  const ix = w * 0.03;
  const iy = h * 0.03;
  return [
    { x: ix, y: iy },
    { x: w - ix, y: iy },
    { x: w - ix, y: h - iy },
    { x: ix, y: h - iy },
  ];
}

export function CapturePage() {
  const { go, settings, saveSettings, merchants, accounts, bills, cloud, getToken, auth, refreshAccount } = useStore();
  const supa = cloud;
  const fb = useFeedback();
  const [step, setStep] = useState<Step>('pick');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const base = useRef<HTMLCanvasElement | null>(null);
  const [angle, setAngle] = useState(0);
  const [rotated, setRotated] = useState<HTMLCanvasElement | null>(null);
  const [quad, setQuad] = useState<Pt[]>([]);
  const [warped, setWarped] = useState<HTMLCanvasElement | null>(null);
  const [blue, setBlue] = useState(false);
  const [variant, setVariant] = useState<Variant>('gray');
  const [thumbs, setThumbs] = useState<Record<Variant, string>>({ color: '', gray: '', binary: '' });
  const variants = useRef<Record<Variant, HTMLCanvasElement | null>>({ color: null, gray: null, binary: null });

  /* ---------- 选择图片 ---------- */
  const [camOpen, setCamOpen] = useState(false);
  const autoRun = useRef(false);
  const codes = useRef<string[]>([]);
  const pdfText = useRef<string | null>(null);
  const [pdfModel, setPdfModel] = useState<ModelOutput | null>(null);
  const loadToken = useRef(0);
  const isPdfLoaded = useRef(false);
  const angleRef = useRef(0);
  const skipRotate = useRef(false);
  const load = useCallback(async (f: File, quadHint?: Pt[]) => {
    setErr(null);
    const token = ++loadToken.current;
    codes.current = [];
    pdfText.current = null;
    setPdfModel(null);
    setAiOpen(false);
    // 换图时清掉上一张的增强版本，避免把旧图发去识别
    variants.current = { color: null, gray: null, binary: null };
    setThumbs({ color: '', gray: '', binary: '' });
    setWarped(null);
    // 角度从非 0 复位时，旋转效果不要覆盖相机给的裁切框
    if (angleRef.current !== 0) skipRotate.current = true;
    isPdfLoaded.current = isPdf(f);
    if (isPdf(f)) {
      setBusy('正在读取 PDF…');
      try {
        const r = await readPdf(f);
        base.current = r.canvas;
        pdfText.current = r.text;
        setPdfModel(textToModel(r.text, todayISO()));
        setAngle(0);
        setRotated(r.canvas);
        setQuad(defaultQuad(r.canvas.width, r.canvas.height));
        setWarped(r.canvas);
        setVariant('color');
        setStep('recognize');
        detectCodes(r.canvas).then((c) => token === loadToken.current && (codes.current = c));
        await buildVariants(r.canvas, false);
      } catch {
        setErr('PDF 打不开（可能加密或已损坏）。可以截图后上传图片。');
        setStep('pick');
      } finally {
        setBusy(null);
      }
      return;
    }
    setBusy('正在读取图片…');
    try {
      const c = await decodeImage(f);
      detectCodes(c).then((r) => token === loadToken.current && (codes.current = r));
      base.current = c;
      setAngle(0);
      setRotated(c);
      setQuad(quadHint ? quadHint.map((p) => ({ x: p.x * c.width, y: p.y * c.height })) : defaultQuad(c.width, c.height));
      setStep('adjust');
    } catch (e) {
      setErr(e instanceof ImageError ? e.message : '图片读取失败，请换一张');
      setStep('pick');
    } finally {
      setBusy(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const f = takePendingFile();
    if (f) load(f.file, f.quad);
    else if (takePendingCamera() && cameraSupported()) setCamOpen(true);
  }, [load]);

  /* ---------- 旋转 ---------- */
  angleRef.current = angle;
  useEffect(() => {
    if (!base.current) return;
    if (skipRotate.current) {
      skipRotate.current = false;
      return;
    }
    const t = setTimeout(() => {
      const r = angle === 0 ? base.current! : rotateCanvas(base.current!, angle);
      setRotated(r);
      setQuad(defaultQuad(r.width, r.height));
    }, 120);
    return () => clearTimeout(t);
  }, [angle]);

  /* ---------- 增强版本 ---------- */
  const buildVariants = useCallback(async (src: HTMLCanvasElement, suppress: boolean) => {
    setBusy('生成增强版本…');
    await new Promise((r) => setTimeout(r, 30));
    try {
      const out: Record<Variant, string> = { color: '', gray: '', binary: '' };
      for (const v of ['color', 'gray', 'binary'] as Variant[]) {
        const c = enhance(src, v, { suppressBlueLines: suppress });
        variants.current[v] = c;
        const t = document.createElement('canvas');
        const s = 300 / Math.max(c.width, c.height);
        t.width = Math.round(c.width * s);
        t.height = Math.round(c.height * s);
        t.getContext('2d')!.drawImage(c, 0, 0, t.width, t.height);
        out[v] = t.toDataURL('image/jpeg', 0.8);
        await new Promise((r) => setTimeout(r, 0));
      }
      setThumbs(out);
    } finally {
      setBusy(null);
    }
  }, []);

  const applyCrop = async (quick = false) => {
    if (!rotated) return;
    const chk = checkQuad(quad, (rotated.width * rotated.height) / 400);
    if (!chk.ok) {
      setErr(chk.error!);
      return;
    }
    setErr(null);
    setBusy('透视矫正中…');
    await new Promise((r) => setTimeout(r, 30));
    try {
      const w = warpQuad(rotated, quad, 2400);
      setWarped(w);
      setStep(quick ? 'recognize' : 'enhance');
      autoRun.current = quick;
      await buildVariants(w, blue);
    } catch (e: any) {
      setErr(e?.message ?? '矫正失败');
      setBusy(null);
    }
  };

  /* ---------- 识别 ---------- */
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [provider, setProvider] = useState<ProviderId | null>(null);
  const [consent, setConsent] = useState<ProviderInfo | null>(null);
  const [remember, setRemember] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [recErr, setRecErr] = useState<{ code: string; message: string } | null>(null);
  const [chinese, setChinese] = useState(false);
  // PDF 已读出文字时，AI 识别默认折叠（PDF 文字更准、不上传）
  const [aiOpen, setAiOpen] = useState(false);
  const ctl = useRef<AbortController | null>(null);

  useEffect(() => {
    if (step !== 'recognize' || providers) return;
    (async () => listProviders(settings.recognizeEndpoint, settings.recognizeToken, supa ? { ...supa, bearer: await getToken() } : null))().then((all) => {
      const ps = usefulProviders(all);
      setProviders(ps);
      setProvider((cur) => cur ?? pickProvider(ps, settings.lastProvider));
    });
  }, [step, providers, settings.recognizeEndpoint, settings.recognizeToken, settings.lastProvider, supa?.url, supa?.key, supa?.fn, auth.session?.user.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 一键识别：增强版本生成完且识别方式已就绪后自动开始
  useEffect(() => {
    if (!autoRun.current || step !== 'recognize' || !providers || busy || !variants.current.gray) return;
    autoRun.current = false;
    const p = providers.find((x) => x.id === provider && x.available);
    if (p) run(p);
  }, [step, providers, provider, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => ctl.current?.abort(), []);

  const makeBase = (billIso: string | null, merchantRaw: string | null, candidates: string[]) => {
    const m = matchMerchantSmart(merchantRaw, candidates, merchants)?.merchant ?? null;
    const accId = (m?.defaultAccountId && accounts.find((a) => a.id === m.defaultAccountId && a.active)?.id) || (accounts.find((a) => a.id === settings.defaultAccountId && a.active)?.id ?? null);
    return {
      merchantId: m?.id ?? null,
      merchantName: m?.name ?? '',
      accountId: accId,
      accountLabel: accounts.find((a) => a.id === accId)?.label ?? '',
      dueDateText: billIso ? formatBR(addDays(billIso, 30)) : '',
      reminderDays: String(settings.defaultReminderDays),
    };
  };

  const images = async () => {
    const v = variants.current[variant] ?? warped!;
    const processed = await exportForRecognition(v, 2000);
    const original = base.current ? await exportForRecognition(base.current, 2000) : undefined;
    return { processed, original };
  };

  const sessionConsent = useRef(false);
  const run = async (p: ProviderInfo) => {
    if (p.sendsImage && !settings.cloudConsent && !sessionConsent.current) {
      setConsent(p);
      return;
    }
    setRecErr(null);
    ctl.current = new AbortController();
    setProgress('准备图片…');
    try {
      const { processed, original } = await images();
      const hints = p.id === 'local' ? '' : buildHints(merchants, bills);
      const r = await recognize(p.id, processed, { endpoint: settings.recognizeEndpoint, token: settings.recognizeToken, supa, hints, accessToken: p.id === 'supabase' ? await getToken() : null, signal: ctl.current.signal, onProgress: setProgress, chinese });
      if (settings.lastProvider !== p.id) saveSettings({ lastProvider: p.id });
      if (p.id === 'supabase' && auth.session) void refreshAccount();
      let out = r.output;
      // 本机 OCR：印刷体单据再用文字规则读一遍金额、到期日、数字线
      if (p.id === 'local' && r.rawText) {
        const tm = textToModel(r.rawText, todayISO());
        if (tm) out = out.items.length ? { ...out, docType: tm.docType, amountDue: tm.amountDue, dueDate: tm.dueDate, paymentLine: tm.paymentLine, categoryHint: tm.categoryHint } : { ...tm, unparsedLines: out.unparsedLines };
      }
      await finish(out, p.label, r.rawText, { processed, original }, p.id === 'local' ? r.rawText : null);
    } catch (e: any) {
      if (e instanceof RecognizeError) {
        if (e.code !== 'cancelled') setRecErr({ code: e.code, message: e.message });
      } else setRecErr({ code: 'unknown', message: e?.message ?? '识别失败' });
    } finally {
      setProgress(null);
      ctl.current = null;
    }
  };

  /** 识别结果 → 核对页（对账单 → 批量导入页） */
  const [statement, setStatement] = useState<{ model: ModelOutput; url: string } | null>(null);
  const statementUrl = useRef<string | null>(null);
  statementUrl.current = statement?.url ?? null;
  useEffect(() => () => { if (statementUrl.current) URL.revokeObjectURL(statementUrl.current); }, []);
  const finish = async (o: ModelOutput, label: string, rawText: string | null, imgs: { processed: Blob; original?: Blob }, ocrText: string | null) => {
    const hasMoney = (o.amountDue?.cents ?? null) !== null || !!o.paymentLine || !!o.pixCode;
    if (!o.items.length && !o.merchant.value && !o.unparsedLines.length && !hasMoney && !o.statement?.entries.length && !codes.current.length) {
      setRecErr({ code: 'empty', message: '没有识别到任何内容。请换用增强版本、重新裁切到单据区域，或换一个识别方式。' });
      return;
    }
    if (o.docType === 'statement' && o.statement && o.statement.entries.length) {
      setStatement({ model: o, url: URL.createObjectURL(imgs.processed) });
      setStep('statement');
      return;
    }
    const billIso = o.billDate.iso ?? parseBRDate(o.billDate.raw ?? '').iso;
    let state: EditorState = draftFromModel(o, label, makeBase(billIso, o.merchant.value, o.merchant.candidates ?? []), uuid, rawText);
    state = enrichDraft(state, o, { detected: codes.current, pdfText: [pdfText.current, ocrText].filter(Boolean).join('\n') || null }, todayISO()).state;
    // 已匹配到的商家决定类型：供应商 → 商家货款；缴费单位 → 日常缴费
    const matched = state.merchantId ? merchants.find((x) => x.id === state.merchantId) : null;
    const mm = matchMerchantSmart(o.merchant.value, o.merchant.candidates ?? [], merchants);
    if (state.ocr) state.ocr = { ...state.ocr, merchantMatch: mm && mm.merchant.id === state.merchantId ? { how: mm.how, score: mm.score, via: mm.via } : null };
    // 学习：按以前的修改自动更正、与历史一致的行免核对、给出常用型号建议
    if (matched && label !== 'PDF 文字') {
      const lr = applyLearning(state, matched, buildCatalog(bills));
      state = lr.state;
      if (state.ocr && lr.notes.length) state.ocr = { ...state.ocr, learnNotes: lr.notes };
    }
    if (matched && (matched.type ?? 'supplier') === 'supplier' && o.docType !== 'payslip' && o.docType !== 'tax' && o.docType !== 'utility') {
      state.kind = 'supplier';
      state.category = null;
    } else if (matched?.type === 'payee') {
      state.kind = 'expense';
      state.category = state.category ?? matched.defaultCategory ?? null;
    }
    // 缴费单据：没匹配到缴费单位时保留单据上的名称
    if (state.kind === 'expense' && !state.merchantId && o.merchant.value) state.merchantName = o.merchant.value;
    // 供应商单据按商家账期算到期日（单据上没有到期日时）
    if (state.kind !== 'expense' && matched?.term && !o.dueDate?.iso && !state.paymentCode) {
      const b = parseBRDate(state.billDateText).iso;
      const due = b ? computeDueDates(matched.term, b)[0] : null;
      if (due) state.dueDateText = formatBR(due);
    }
    if (!o.items.length && state.amountMode !== 'total') state.rows = [{ key: uuid(), qtyText: '', desc: '', unitText: '' }];
    setPendingRecognition({ state, image: imgs.processed, original: imgs.original } as any);
    if (!o.items.length && state.amountMode !== 'total') fb.toast('只识别出部分信息，明细需要手工补全', { bad: true });
    go({ name: 'review' }, true);
  };

  /** PDF 文字直接生成草稿（不上传、不用 AI） */
  const usePdfText = async () => {
    if (!pdfModel) return;
    setBusy('准备…');
    try {
      const { processed, original } = await images();
      await finish(pdfModel, 'PDF 文字', pdfText.current, { processed, original }, null);
    } finally {
      setBusy(null);
    }
  };

  const manualWithImage = async () => {
    setBusy('准备图片…');
    try {
      const { processed, original } = await images();
      const state: EditorState = {
        ...makeBase(null, null, []),
        orderNumber: '',
        billDateText: '',
        notes: '',
        dueBeforeConfirmed: false,
        rows: [0, 1, 2].map(() => ({ key: uuid(), qtyText: '', desc: '', unitText: '' })),
        ocr: { provider: '手工对照录入', merchantRaw: null, merchantConfidence: 1, merchantCandidates: [], orderConfidence: 1, orderRaw: null, billDateRaw: null, billDateConfidence: 1, printedTotalRaw: null, unparsedLines: [], modelWarnings: [], candidate: null },
      };
      setPendingRecognition({ state, image: processed, original } as any);
      go({ name: 'review' }, true);
    } finally {
      setBusy(null);
    }
  };

  /* ---------- 渲染 ---------- */
  return (
    <>
      <ol className="chips" aria-label="步骤" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {(['pick', 'adjust', 'enhance', 'recognize'] as Step[]).filter(() => step !== 'statement').map((s, i) => (
          <li key={s}>
            <span className="chip" aria-current={step === s ? 'step' : undefined} style={step === s ? { background: 'var(--ink)', color: 'var(--card)', borderColor: 'var(--ink)', display: 'inline-flex', alignItems: 'center' } : { display: 'inline-flex', alignItems: 'center' }}>
              {i + 1}. {({ pick: '选图', adjust: '裁切旋转', enhance: '增强', recognize: '识别', statement: '导入' } as Record<Step, string>)[s]}
            </span>
          </li>
        ))}
      </ol>

      {err && (
        <div className="banner bad" role="alert">
          <span className="grow">{err}</span>
        </div>
      )}
      {busy && (
        <div className="card stack" aria-live="polite">
          <span className="row">
            <span className="spin" /> {busy}
          </span>
          <div className="progress">
            <div />
          </div>
        </div>
      )}

      {step === 'pick' && !busy && (
        <div className="card stack">
          <h2>拍下或选择单据</h2>
          <p className="muted small">订单、Boleto 银行单、水电账单、税费单（FGTS / DAS）、工资单、对账单截图都可以；支持照片和 PDF。尽量平铺、光线均匀、让单据占满画面。</p>
          <div className="grid2">
            {cameraSupported() ? (
              <button className="btn btn-primary btn-lg" onClick={() => setCamOpen(true)}>
                <ICamera />
                拍照
              </button>
            ) : (
              <label className="btn btn-primary btn-lg">
                <ICamera />
                拍照
                <input type="file" accept={ACCEPT} capture="environment" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) load(f); }} />
              </label>
            )}
            <label className="btn btn-lg">
              <IImage />
              相册 / PDF
              <input type="file" accept={ACCEPT} className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) load(f); }} />
            </label>
          </div>
          <button className="btn btn-ghost" onClick={() => go({ name: 'new' }, true)}>
            <IEdit />
            不用图片，直接手工录入
          </button>
        </div>
      )}

      {step === 'adjust' && rotated && (
        <div className="stack">
          <div className="card stack">
            <div className="section-head">
              <h2>拖动四个角，框住单据</h2>
              <button className="link" onClick={() => setQuad(defaultQuad(rotated.width, rotated.height))}>
                重置
              </button>
            </div>
            <p className="small muted">可以只框明细表或总计区域，把旁边的纸张和桌面排除在外。角点顺序：左上 → 右上 → 右下 → 左下。</p>
            <QuadEditor canvas={rotated} quad={quad} onChange={setQuad} />
            <div className="row">
              <button className="btn btn-sm" onClick={() => setAngle((a) => normAngle(a - 90))}>
                <IRotate style={{ transform: 'scaleX(-1)' }} />
                左转 90°
              </button>
              <button className="btn btn-sm" onClick={() => setAngle((a) => normAngle(a + 90))}>
                <IRotate />
                右转 90°
              </button>
              <span className="small muted num">当前 {angle}°</span>
            </div>
            <div className="field">
              <label htmlFor="fine">微调角度（纸张歪斜时用）</label>
              <input id="fine" type="range" className="range" min={-180} max={180} step={0.5} value={angle} onChange={(e) => setAngle(Number(e.target.value))} />
            </div>
          </div>
          <div className="row end">
            <button className="btn btn-ghost" onClick={() => { setStep('pick'); base.current = null; }}>
              换一张
            </button>
            <button className="btn" onClick={() => applyCrop(false)} disabled={!!busy}>
              调整增强
            </button>
            <button className="btn btn-primary" onClick={() => applyCrop(true)} disabled={!!busy}>
              <ISpark />
              一键识别
            </button>
          </div>
        </div>
      )}

      {step === 'enhance' && warped && !busy && (
        <div className="stack">
          <div className="card stack">
            <h2>选择识别用的版本</h2>
            <div className="variant-grid" role="group" aria-label="图片版本">
              {(['color', 'gray', 'binary'] as Variant[]).map((v) => (
                <button key={v} className="variant" aria-pressed={variant === v} onClick={() => setVariant(v)}>
                  {thumbs[v] && <img src={thumbs[v]} alt={VARIANT_LABEL[v]} />}
                  {VARIANT_LABEL[v]}
                </button>
              ))}
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={blue}
                onChange={(e) => {
                  setBlue(e.target.checked);
                  buildVariants(warped, e.target.checked);
                }}
              />
              <span>
                <b>淡化蓝色表格线</b>
                <br />
                <span className="small muted">只去掉浅蓝色格线，深色笔迹保留；如果数字被淡化请关闭。</span>
              </span>
            </label>
            <p className="small muted">原始照片会一并保存，复核时随时可以切换查看。</p>
          </div>
          <div className="row end">
            <button className="btn btn-ghost" onClick={() => setStep('adjust')}>
              返回裁切
            </button>
            <button className="btn btn-primary" onClick={() => setStep('recognize')}>
              下一步：识别
            </button>
          </div>
        </div>
      )}

      {step === 'statement' && statement && (
        <StatementReview
          model={statement.model}
          imageUrl={statement.url}
          onCancel={() => {
            URL.revokeObjectURL(statement.url);
            setStatement(null);
            setStep('recognize');
          }}
        />
      )}

      {step === 'recognize' && pdfModel && (
        <div className="card stack pdfquick">
          <h2>PDF 里已读到这些信息</h2>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {pdfModel.merchant.value && <li>收款方：{pdfModel.merchant.value}</li>}
            {pdfModel.amountDue?.cents != null && <li>金额：{formatBRL(pdfModel.amountDue.cents)}</li>}
            {pdfModel.dueDate?.iso && <li>到期：{formatBR(pdfModel.dueDate.iso)}</li>}
            {pdfModel.paymentLine && <li>数字线已校验</li>}
            {pdfModel.pixCode && <li>含 PIX 复制码</li>}
          </ul>
          <button className="btn btn-primary" onClick={usePdfText} disabled={!!busy || !!progress}>
            直接用 PDF 内容生成账单（不上传）
          </button>
          <span className="xs muted">PDF 文字比照片识别更准{aiOpen ? '；也可以在下方用 AI 识别整页' : ''}。</span>
        </div>
      )}

      {step === 'recognize' && pdfModel && !aiOpen && (
        <div className="row end">
          <button className="btn btn-ghost" onClick={() => setStep('pick')} disabled={!!busy}>
            返回
          </button>
          <button className="btn btn-soft" onClick={() => setAiOpen(true)} disabled={!!busy}>
            <ISpark />
            改用 AI 识别整页…
          </button>
        </div>
      )}

      {step === 'recognize' && (!pdfModel || aiOpen) && (
        <div className="stack">
          <div className="card stack">
            <h2>{pdfModel ? '或用 AI 识别整页' : '选择识别方式'}</h2>
            {!providers && (
              <span className="row small muted">
                <span className="spin" /> 检查可用的识别方式…
              </span>
            )}
            {providers?.map((p) => (
              <button key={p.id} className="provider" aria-pressed={provider === p.id} disabled={!p.available || !!progress} onClick={() => setProvider(p.id)}>
                <span className="radio" aria-hidden="true" />
                <span className="stack" style={{ gap: 2 }}>
                  <b>
                    {p.label} {(p.id === 'supabase' || p.id === 'claude') && p.available && <span className="pill brand">推荐 · 手写更准</span>}
                  </b>
                  <span className="small muted">{p.cost}</span>
                  {p.reason && <span className="small err">{p.reason}</span>}
                  {p.sendsImage && p.available && <span className="xs muted">会发送：你选中的这 1 张处理后图片{p.id === 'supabase' ? '和你的常用商家/型号（帮助辨认手写）' : ''}</span>}
                  {p.id === 'supabase' && p.available && auth.account && auth.account.usage.limit >= 0 && (
                    <span className="xs muted">{auth.account.usage.period === 'trial' ? '试用期' : '本月'} AI 识别已用 {auth.account.usage.ai} / {auth.account.usage.limit} 次</span>
                  )}
                </span>
              </button>
            ))}
            {providers?.some((p) => p.needsLogin) && (
              <div className="banner ok">
                <span className="grow small">登录账号后就能用 AI 识别（邮箱验证码，不用密码）。</span>
                <button className="btn btn-sm btn-primary" onClick={() => go({ name: 'account' })}>
                  去登录
                </button>
              </div>
            )}
            {provider === 'local' && (
              <label className="check">
                <input type="checkbox" checked={chinese} onChange={(e) => setChinese(e.target.checked)} />
                <span className="small">同时识别中文（语言包约 20 MB，首次较慢）</span>
              </label>
            )}
          </div>

          {progress && (
            <div className="card stack" aria-live="polite">
              <span className="row">
                <span className="spin" />
                {progress}
              </span>
              <div className="progress">
                <div />
              </div>
              <button className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => ctl.current?.abort()}>
                取消识别
              </button>
            </div>
          )}

          {recErr && (
            <div className="banner bad" role="alert">
              <span className="grow">{recErr.message}</span>
              {recErr.code === 'quota' || recErr.code === 'login' ? (
                <button className="btn btn-sm btn-primary" onClick={() => go({ name: 'account' })}>
                  {recErr.code === 'quota' ? '查看套餐' : '去登录'}
                </button>
              ) : (
                <button className="btn btn-sm" onClick={() => { const p = providers?.find((x) => x.id === provider); if (p) run(p); }}>
                  重试
                </button>
              )}
              <button className="btn btn-sm" onClick={() => setStep('enhance')}>
                换个版本
              </button>
            </div>
          )}

          <div className="row end">
            <button className="btn btn-ghost" onClick={() => setStep(pdfModel || isPdfLoaded.current ? 'pick' : 'enhance')} disabled={!!progress}>
              返回
            </button>
            <button className="btn" onClick={manualWithImage} disabled={!!progress || !!busy}>
              对照图片手工录入
            </button>
            <button
              className="btn btn-primary"
              disabled={!provider || !!progress || !!busy || !providers?.find((p) => p.id === provider)?.available}
              onClick={() => {
                const p = providers?.find((x) => x.id === provider);
                if (p) run(p);
              }}
            >
              <ISpark />
              开始识别
            </button>
          </div>
        </div>
      )}

      {camOpen && (
        <CameraSheet
          onClose={() => setCamOpen(false)}
          onCapture={({ file, quad }) => {
            setCamOpen(false);
            load(file, quad);
          }}
          onFallbackFile={(f) => {
            setCamOpen(false);
            load(f);
          }}
        />
      )}

      {step === 'recognize' && (!pdfModel || aiOpen) && providers && !providers.some((p) => p.available && p.id !== 'local') && (
        <div className="card stack">
          <h3>开启 AI 识别，手写和中文也能读</h3>
          <p className="small">
            现在只有本机 OCR（手写较弱）。在你同步用的 Supabase 里部署一个识别函数、填上 Gemini 密钥（约 5 分钟），之后所有导入了同步配置的设备都能直接用。
          </p>
          <button className="btn btn-soft" style={{ alignSelf: 'flex-start' }} onClick={() => go({ name: 'settings' })}>
            去开启
          </button>
        </div>
      )}

      {consent && (
        <Modal title="发送图片进行识别？" onClose={() => setConsent(null)}>
          <div className="stack small">
            <p className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
              <IShield width={22} height={22} style={{ flexShrink: 0, color: 'var(--brand)' }} />
              <span>
                <b>发送内容：</b>你刚才处理后的这 1 张单据图片，不含其他账单或资料。
              </span>
            </p>
            <p>
              <b>用途：</b>由{consent.label}读取文字，生成待复核的草稿；结果不会自动入账。
            </p>
            <p>
              <b>费用：</b>
              {consent.cost}。
            </p>
            <p className="muted">不同意也没关系：可以用「本机 OCR」或「对照图片手工录入」，图片不会离开设备。</p>
            <label className="check">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              <span>以后不再询问（可在「设置」里撤销）</span>
            </label>
          </div>
          <div className="row end">
            <button className="btn btn-ghost" onClick={() => setConsent(null)}>
              不同意
            </button>
            <button
              className="btn btn-primary"
              onClick={async () => {
                const p = consent;
                setConsent(null);
                sessionConsent.current = true;
                if (remember) await saveSettings({ cloudConsent: true });
                await run(p);
              }}
            >
              同意并识别
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function QuadEditor({ canvas, quad, onChange }: { canvas: HTMLCanvasElement; quad: Pt[]; onChange: (q: Pt[]) => void }) {
  const holder = useRef<HTMLDivElement>(null);
  const disp = useRef<HTMLCanvasElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<number | null>(null);
  const [loupe, setLoupe] = useState<Pt | null>(null);

  useEffect(() => {
    const d = disp.current!;
    const s = Math.min(1, 1400 / Math.max(canvas.width, canvas.height));
    d.width = Math.round(canvas.width * s);
    d.height = Math.round(canvas.height * s);
    d.getContext('2d')!.drawImage(canvas, 0, 0, d.width, d.height);
  }, [canvas]);

  const toPt = (e: React.PointerEvent): Pt => {
    const r = svg.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(canvas.width, ((e.clientX - r.left) / r.width) * canvas.width)),
      y: Math.max(0, Math.min(canvas.height, ((e.clientY - r.top) / r.height) * canvas.height)),
    };
  };
  const R = Math.max(canvas.width, canvas.height) / 45;
  const ok = checkQuad(quad).ok;
  const labels = ['左上', '右上', '右下', '左下'];

  const nudge = (i: number, dx: number, dy: number) => {
    const step = Math.max(canvas.width, canvas.height) / 200;
    onChange(quad.map((p, j) => (j === i ? { x: Math.max(0, Math.min(canvas.width, p.x + dx * step)), y: Math.max(0, Math.min(canvas.height, p.y + dy * step)) } : p)));
  };

  return (
    <div className="stage" ref={holder}>
      <canvas ref={disp} aria-hidden="true" />
      <svg
        ref={svg}
        viewBox={`0 0 ${canvas.width} ${canvas.height}`}
        preserveAspectRatio="none"
        onPointerMove={(e) => {
          if (drag.current === null) return;
          const p = toPt(e);
          setLoupe(p);
          onChange(quad.map((q, j) => (j === drag.current ? p : q)));
        }}
        onPointerUp={() => {
          drag.current = null;
          setLoupe(null);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setLoupe(null);
        }}
      >
        <path d={`M0 0H${canvas.width}V${canvas.height}H0Z ${quad.length ? `M${quad.map((p) => `${p.x} ${p.y}`).join('L')}Z` : ''}`} fill="rgba(10,8,30,0.55)" fillRule="evenodd" />
        {quad.length === 4 && <polygon points={quad.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={ok ? '#8a82f4' : '#ff5d73'} strokeWidth={R / 5} />}
        {quad.map((p, i) => (
          <g key={i}>
            <circle
              cx={p.x}
              cy={p.y}
              r={R * 2}
              className="handle-hit"
              role="slider"
              tabIndex={0}
              aria-label={`${labels[i]}角点，用方向键微调`}
              aria-valuetext={`${Math.round(p.x)}, ${Math.round(p.y)}`}
              onPointerDown={(e) => {
                (e.target as Element).setPointerCapture?.(e.pointerId);
                drag.current = i;
              }}
              onKeyDown={(e) => {
                const m: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
                if (m[e.key]) {
                  e.preventDefault();
                  nudge(i, ...m[e.key]);
                }
              }}
            />
            <circle cx={p.x} cy={p.y} r={R * 0.6} className="handle" style={{ strokeWidth: R / 5, pointerEvents: 'none' }} />
            <text x={p.x} y={p.y - R * 1.1} textAnchor="middle" fontSize={R * 0.9} fill="#fff" style={{ pointerEvents: 'none', fontWeight: 700 }}>
              {labels[i]}
            </text>
          </g>
        ))}
        {loupe && <circle cx={loupe.x} cy={loupe.y} r={R * 0.15} fill="#ffcf33" />}
      </svg>
      {!ok && quad.length === 4 && (
        <div className="xs" style={{ position: 'absolute', left: 8, bottom: 8, background: '#b3203a', color: '#fff', padding: '4px 8px', borderRadius: 8 }}>
          {checkQuad(quad).error}
        </div>
      )}
    </div>
  );
}
