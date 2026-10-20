import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { useFeedback } from '../ui/feedback';
import { learnFromReview } from '../lib/ocr/learn';
import { useActions } from '../actions';
import { Combobox, type ComboItem } from '../ui/Combobox';
import { DOC_LABEL, computeIssues, saveGate, parseRow, computedTotal, isBlankRow, stateTotal, itemsForSave, isTotalMode, repeatRuleOf, TOTAL_ONLY_DESC, type EditorState, type Issue, type RowState } from '../lib/ocr/protocol';
import { REPEAT_PRESETS, UNIT_LABEL, presetKey, ruleOf, makeRecurrence, describeRepeat, type RepeatUnit } from '../lib/recurrence';
import { DateField, dueQuickDates } from '../ui/Calendar';
import { dailyTotals } from '../lib/monthly';
import { computeDueDates, describeTerm, buildInstallmentBills, splitCents } from '../lib/terms';
import { findDuplicate } from '../lib/importTable';
import { isPartial, openCents, reconcileOnEdit } from '../lib/payments';
import { nonBusinessReason, nextBusinessDay } from '../lib/holidays';
import { ScannerSheet, scanSupported } from '../ui/Scanner';
import { IScan } from '../ui/icons';
import { EXPENSE_CATEGORIES, categoryLabel, categoryOf, describePaymentCode } from '../lib/expense';
import { copyText } from '../lib/platform';
import { parseBRL, formatBRL, formatQuantity, centsToInput } from '../lib/money';
import { parseBRDate, formatBR, addDays, todayISO, diffDays, addMonths, TZ, weekdayCN } from '../lib/dates';
import { uuid, nowISO, maskHint } from '../lib/ids';
import { recompute } from '../lib/bill';
import type { Bill, OcrReviewRecord } from '../lib/types';
import { ACCOUNT_TYPE_LABEL } from '../lib/types';
import { IX, IPlus, IEye, ICheck, ITrash, ICopy } from '../ui/icons';
import { takePendingRecognition } from '../pending';

const blankRow = (): RowState => ({ key: uuid(), qtyText: '', desc: '', unitText: '' });

function isoToBR(iso: string) {
  return formatBR(iso);
}

/** 付款时间戳 → 圣保罗日期 DD/MM/YYYY */
function paidAtToBR(paidAt: string): string {
  const d = new Date(paidAt);
  if (Number.isNaN(d.getTime())) return '';
  return isoToBR(todayISO(d));
}

/** DD/MM/YYYY → 当天圣保罗中午的时间戳（避免跨时区变日期） */
function brToPaidAt(text: string): string | null {
  const iso = parseBRDate(text).iso;
  return iso ? new Date(`${iso}T12:00:00-03:00`).toISOString() : null;
}

/** 按商家账期规则生成到期日补丁 */
function termPatch(rule: NonNullable<import('../lib/types').Merchant['term']>, billISO: string, editing = false): Partial<EditorState> {
  const dues = computeDueDates(rule, billISO);
  if (!dues.length) return {};
  return { dueDateText: isoToBR(dues[0]), dueAuto: true, dueBeforeConfirmed: false, splitInstallments: rule.kind === 'installments' && !editing };
}

function repeatFields(rule: { unit: RepeatUnit; every: number } | null, until: string | null = null): Partial<EditorState> {
  const key = presetKey(rule);
  return { repeatKey: key, repeatEvery: rule ? String(rule.every) : '1', repeatUnit: rule?.unit ?? 'month', repeatUntil: until ? isoToBR(until) : '' };
}

/** 从已有账单生成编辑状态 */
function stateFromBill(b: Bill): EditorState {
  const totalOnly = b.amountMode === 'total';
  return {
    merchantId: b.merchantId,
    merchantName: b.merchantNameSnapshot,
    accountId: b.accountId,
    accountLabel: b.accountLabelSnapshot,
    orderNumber: b.orderNumber,
    billDateText: isoToBR(b.billDate),
    dueDateText: isoToBR(b.dueDate),
    reminderDays: String(b.reminderDays),
    notes: b.notes,
    rows: totalOnly
      ? [blankRow()]
      : b.items.map((i) => ({ key: i.id, qtyText: formatQuantity(i.quantity), desc: i.description, unitText: centsToInput(i.unitPriceCents), printedSubtotalRaw: null })),
    dueBeforeConfirmed: !!b.dueBeforeBillConfirmed,
    amountMode: totalOnly ? 'total' : 'items',
    totalText: totalOnly ? centsToInput(b.totalCents) : '',
    totalDesc: totalOnly && b.items[0]?.description !== TOTAL_ONLY_DESC ? b.items[0]?.description ?? '' : '',
    paidDateText: b.paidAt ? paidAtToBR(b.paidAt) : '',
    kind: b.kind ?? 'supplier',
    category: b.category ?? null,
    paymentCode: b.paymentCode ?? '',
    recurring: !!b.recurrence,
    ...repeatFields(b.recurrence ? ruleOf(b.recurrence) : null, b.recurrence?.until ?? null),
    dueAuto: false,
    splitInstallments: false,
  };
}

interface ReviewMeta {
  imageId: string | null;
  originalImageId: string | null;
}

interface DraftPayload {
  editor: EditorState;
  acks: string[];
  confirmed: boolean;
  meta: ReviewMeta;
}

export function EditorPage({ mode, id, copyFrom, initialKind }: { mode: 'new' | 'edit' | 'review'; id?: string; copyFrom?: string; initialKind?: 'supplier' | 'expense' }) {
  const store = useStore();
  const { repo, settings, merchants, accounts, go, back, reload, guard, bills } = store;
  const fb = useFeedback();
  const actions = useActions();
  const [state, setState] = useState<EditorState | null>(null);
  const [existing, setExisting] = useState<Bill | null>(null);
  const [acks, setAcks] = useState<Set<string>>(new Set());
  const [confirmed, setConfirmed] = useState(false);
  const [meta, setMeta] = useState<ReviewMeta>({ imageId: null, originalImageId: null });
  const [images, setImages] = useState<{ processed: Blob | null; original: Blob | null }>({ processed: null, original: null });
  const [selRow, setSelRow] = useState<string | null>(null);
  const [pane, setPane] = useState<'form' | 'img'>('form');
  const [saving, setSaving] = useState(false);
  const [missing, setMissing] = useState(false);
  const [paidToggle, setPaidToggle] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [catOpen, setCatOpen] = useState(false);
  const [triedSave, setTriedSave] = useState(false);
  const autoAccount = useRef(true);
  const loaded = useRef(false);

  /* ---------- 初始化 ---------- */
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    (async () => {
      if (mode === 'new' && copyFrom) {
        const src = await guard(() => repo.getBill(copyFrom));
        if (src) {
          const t = todayISO();
          const term = Math.max(0, diffDays(src.billDate, src.dueDate));
          const st = stateFromBill(src);
          autoAccount.current = false;
          setState({
            ...st,
            rows: st.amountMode === 'total' ? [blankRow()] : st.rows.map((r) => ({ ...r, key: uuid() })),
            orderNumber: '',
            billDateText: isoToBR(t),
            dueDateText: isoToBR(addDays(t, term)),
            dueBeforeConfirmed: false,
            paidDateText: '',
            copiedFrom: { id: src.id, label: `${src.merchantNameSnapshot}${src.orderNumber ? ` #${src.orderNumber}` : ''} · ${formatBRL(src.totalCents)} · 到期 ${formatBR(src.dueDate)}` },
          });
          return;
        }
      }
      if (mode === 'new' && initialKind === 'expense') {
        const t = todayISO();
        const accId = accounts.find((a) => a.id === settings.defaultAccountId && a.active)?.id ?? null;
        setState({
          merchantId: null,
          merchantName: '',
          accountId: accId,
          accountLabel: accounts.find((a) => a.id === accId)?.label ?? '',
          orderNumber: '',
          billDateText: isoToBR(t),
          dueDateText: '',
          reminderDays: String(settings.defaultReminderDays),
          notes: '',
          rows: [blankRow()],
          dueBeforeConfirmed: false,
          amountMode: 'total',
          totalText: '',
          totalDesc: '',
          paidDateText: '',
          kind: 'expense',
          category: null,
          paymentCode: '',
          recurring: true,
          ...repeatFields({ unit: 'month', every: 1 }),
        });
        return;
      }
      if (mode === 'new') {
        const t = todayISO();
        const m = merchants.find((x) => x.id === settings.defaultMerchantId && x.active && x.type !== 'payee');
        const accId = (m?.defaultAccountId && accounts.find((a) => a.id === m.defaultAccountId && a.active)?.id) || (accounts.find((a) => a.id === settings.defaultAccountId && a.active)?.id ?? null);
        setState({
          merchantId: m?.id ?? null,
          merchantName: m?.name ?? '',
          accountId: accId,
          accountLabel: accounts.find((a) => a.id === accId)?.label ?? '',
          orderNumber: '',
          billDateText: isoToBR(t),
          dueDateText: isoToBR(addDays(t, 30)),
          reminderDays: String(settings.defaultReminderDays),
          notes: '',
          rows: [blankRow(), blankRow()],
          dueBeforeConfirmed: false,
          amountMode: 'items',
          totalText: '',
          totalDesc: '',
          paidDateText: '',
          kind: 'supplier',
          ...(m?.term ? termPatch(m.term, t) : {}),
        });
        return;
      }
      if (mode === 'edit' && id) {
        const b = await guard(() => repo.getBill(id));
        if (!b) {
          setMissing(true);
          return;
        }
        setExisting(b);
        autoAccount.current = false;
        setState(stateFromBill(b));
        setPaidToggle(!!b.paidAt);
        if (b.ocrReview?.imageId) {
          const [p, o] = await Promise.all([repo.getImage(b.ocrReview.imageId), b.ocrReview.originalImageId ? repo.getImage(b.ocrReview.originalImageId) : Promise.resolve(undefined)]);
          setImages({ processed: p ?? null, original: o ?? null });
        }
        return;
      }
      // review
      const pending = takePendingRecognition();
      if (pending) {
        const p = pending as unknown as { state: EditorState; image: Blob; original?: Blob };
        const imageId = (await guard(() => repo.putImage(p.image))) ?? null;
        const originalImageId = p.original ? (await guard(() => repo.putImage(p.original!))) ?? null : null;
        const m = { imageId, originalImageId };
        setMeta(m);
        setImages({ processed: p.image, original: p.original ?? null });
        autoAccount.current = !p.state.accountId;
        setState(p.state);
        await guard(() => repo.putDraft({ state: { editor: p.state, acks: [], confirmed: false, meta: m } satisfies DraftPayload, imageId }));
        return;
      }
      const d = await guard(() => repo.getDraft());
      if (!d) {
        setMissing(true);
        return;
      }
      const pl = d.state as DraftPayload;
      setState(pl.editor);
      setAcks(new Set(pl.acks));
      setConfirmed(pl.confirmed);
      setMeta(pl.meta);
      const [p, o] = await Promise.all([pl.meta.imageId ? repo.getImage(pl.meta.imageId) : undefined, pl.meta.originalImageId ? repo.getImage(pl.meta.originalImageId) : undefined]);
      setImages({ processed: p ?? null, original: o ?? null });
    })();
  }, [mode, id, copyFrom, initialKind, repo, guard, merchants, accounts, settings]);

  const dueTotals = useMemo(() => dailyTotals(bills, { excludeId: existing?.id }), [bills, existing?.id]);

  /* ---------- 复核草稿自动保存 ---------- */
  useEffect(() => {
    if (mode !== 'review' || !state) return;
    const t = setTimeout(() => {
      repo.putDraft({ state: { editor: state, acks: [...acks], confirmed, meta } satisfies DraftPayload, imageId: meta.imageId }).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [mode, state, acks, confirmed, meta, repo]);

  const issues = useMemo(() => (state ? computeIssues(state) : []), [state]);
  const gate = useMemo(() => (state ? saveGate(state, issues, acks, confirmed) : { canSave: false, reasons: [] }), [state, issues, acks, confirmed]);
  const loud = mode === 'review' || triedSave;
  const isQuiet = (i: Issue) => !loud && (/:empty$|^items:none$|:(qty|unit|desc)$/.test(i.id) || /为空/.test(i.message));
  const byField = useMemo(() => {
    const m = new Map<string, Issue['level']>();
    for (const i of issues) {
      if (isQuiet(i)) continue;
      const k = i.rowKey ? `${i.rowKey}:${i.field}` : i.field;
      if (i.level === 'block' || !acks.has(i.id)) m.set(k, m.get(k) === 'block' ? 'block' : i.level);
    }
    return m;
  }, [issues, acks, loud]); // eslint-disable-line react-hooks/exhaustive-deps
  const cls = (k: string) => (byField.get(k) === 'block' ? ' bad' : byField.get(k) === 'warn' ? ' warn' : '');

  const set = useCallback((patch: Partial<EditorState>) => setState((s) => (s ? { ...s, ...patch } : s)), []);
  const setRow = (key: string, patch: Partial<RowState>) => setState((s) => (s ? { ...s, rows: s.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) } : s));

  const isExpenseMode = state?.kind === 'expense';
  const merchantItems: ComboItem[] = useMemo(
    () =>
      merchants
        .filter((m) => m.active && (isExpenseMode ? m.type === 'payee' : m.type !== 'payee'))
        .map((m) => ({
          id: m.id,
          label: m.name,
          terms: m.aliases,
          isDefault: m.id === settings.defaultMerchantId,
          sub:
            [
              m.defaultCategory ? categoryLabel(m.defaultCategory) : '',
              m.term ? `账期：${describeTerm(m.term)}` : '',
              m.aliases.length ? `别名：${m.aliases.join('、')}` : '',
              m.defaultAccountId ? `默认账号：${accounts.find((a) => a.id === m.defaultAccountId)?.label ?? '—'}` : '',
            ]
              .filter(Boolean)
              .join(' · ') || undefined,
        })),
    [merchants, accounts, settings.defaultMerchantId, isExpenseMode],
  );
  const accountItems: ComboItem[] = useMemo(
    () =>
      accounts
        .filter((a) => a.active)
        .map((a) => ({
          id: a.id,
          label: a.label,
          terms: [a.bank, a.owner],
          isDefault: a.id === settings.defaultAccountId,
          sub: [ACCOUNT_TYPE_LABEL[a.type], a.bank, a.owner, a.optionalPixHint ? maskHint(a.optionalPixHint) : ''].filter(Boolean).join(' · '),
        })),
    [accounts, settings.defaultAccountId],
  );

  const chooseMerchant = (mid: string | null, list = merchants) => {
    const m = list.find((x) => x.id === mid);
    if (!m) {
      set({ merchantId: null, merchantName: '' });
      return;
    }
    const patch: Partial<EditorState> = { merchantId: m.id, merchantName: m.name };
    if (m.term) Object.assign(patch, termPatch(m.term, parseBRDate(state?.billDateText ?? '').iso ?? store.today, mode === 'edit'));
    if (m.type === 'payee') {
      if (m.defaultCategory && !state?.category) patch.category = m.defaultCategory;
      if (m.repeat) Object.assign(patch, repeatFields(m.repeat, state?.repeatUntil ? parseBRDate(state.repeatUntil).iso : null));
      else if (m.recurring) Object.assign(patch, repeatFields({ unit: 'month', every: 1 }));
    }
    if (autoAccount.current && m.defaultAccountId) {
      const a = accounts.find((x) => x.id === m.defaultAccountId && x.active);
      if (a) {
        patch.accountId = a.id;
        patch.accountLabel = a.label;
      }
    }
    set(patch);
  };

  if (missing) {
    return (
      <div className="card empty">
        <h3>{mode === 'review' ? '没有待复核的识别结果' : '找不到这笔账单'}</h3>
        <p>{mode === 'review' ? '可能已保存或已放弃。' : '它可能已被删除。'}</p>
        <button className="btn btn-primary" onClick={() => go({ name: 'home' }, true)}>
          回到首页
        </button>
      </div>
    );
  }
  if (!state) {
    return (
      <div className="card empty">
        <span className="spin" />
        <p>加载中…</p>
      </div>
    );
  }

  const total = stateTotal(state);
  const totalMode = isTotalMode(state);
  const curMerchant = merchants.find((m) => m.id === state.merchantId) ?? null;
  const rule = curMerchant?.term ?? null;
  const expenseMode = state.kind === 'expense';
  const partyWord = expenseMode ? '缴费单位' : '商家';
  const installmentDues = (() => {
    if (existing || rule?.kind !== 'installments' || !state.splitInstallments) return [];
    const b = parseBRDate(state.billDateText).iso;
    if (!b) return [];
    const dues = computeDueDates(rule, b);
    const userDue = parseBRDate(state.dueDateText).iso;
    if (userDue && dues.length && userDue !== dues[0]) {
      const shift = diffDays(dues[0], userDue);
      return dues.map((d) => addDays(d, shift));
    }
    return dues;
  })();

  const setBillDate = (v: string) => {
    const patch: Partial<EditorState> = { billDateText: v };
    const iso = parseBRDate(v).iso;
    if (state.dueAuto && rule && iso) Object.assign(patch, termPatch(rule, iso, !!existing), { splitInstallments: state.splitInstallments });
    set(patch);
  };

  const switchKind = (k: 'supplier' | 'expense') => {
    if ((state.kind ?? 'supplier') === k) return;
    const keepMerchant = curMerchant && (k === 'expense' ? curMerchant.type === 'payee' : curMerchant.type !== 'payee');
    const hasRows = state.rows.some((r) => !isBlankRow(r));
    set({
      kind: k,
      ...(keepMerchant ? {} : { merchantId: null, merchantName: '' }),
      ...(k === 'expense' && !hasRows ? { amountMode: 'total' as const } : {}),
      ...(k === 'expense' && (state.repeatKey ?? 'none') === 'none' ? repeatFields({ unit: 'month', every: 1 }) : {}),
      ...(k === 'supplier' ? { category: null } : {}),
      splitInstallments: false,
    });
  };
  const isReview = mode === 'review' || !!existing?.ocrReview;
  const billISO = parseBRDate(state.billDateText).iso;
  const dueISO = parseBRDate(state.dueDateText).iso;
  const dupOrder =
    !expenseMode && state.orderNumber.trim() && bills.find((b) => b.id !== existing?.id && b.orderNumber === state.orderNumber.trim() && (b.merchantId ? b.merchantId === state.merchantId : b.merchantNameSnapshot === state.merchantName));

  const focusIssue = (i: Issue) => {
    if (i.rowKey) {
      setSelRow(i.rowKey);
    }
    setPane('form');
    setTimeout(() => {
      const suffix = i.field === 'qty' ? 'qty' : i.field === 'unit' ? 'unit' : 'desc';
      // 桌面是表格（row-），手机是卡片（rowc-）：取当前可见的那个
      const cands = i.rowKey ? [`row-${i.rowKey}-${suffix}`, `rowc-${i.rowKey}-${suffix}`] : [`f-${i.field}`];
      const els = cands.map((id) => document.getElementById(id)).filter((e): e is HTMLElement => !!e);
      const target = els.find((e) => e.offsetParent !== null) ?? els[0] ?? null;
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      (target as HTMLElement | null)?.focus?.({ preventScroll: true });
    }, 50);
  };

  const applyFix = (i: Issue, second = false) => {
    if (second && i.fix2) {
      const v = isoToBR(i.fix2.value);
      set(i.fix2.target === 'billDate' ? { billDateText: v } : { dueDateText: v });
      return;
    }
    if (!i.fix) return;
    if (i.fix.kind === 'confirmYear' && i.fix.value && i.fix.target) {
      const v = isoToBR(i.fix.value);
      set(i.fix.target === 'billDate' ? { billDateText: v } : { dueDateText: v });
    } else if (i.fix.kind === 'confirmDueBefore') set({ dueBeforeConfirmed: true });
    else if (i.fix.kind === 'setRow' && i.rowKey && i.fix.value != null) {
      const f = i.fix.rowField;
      setRow(i.rowKey, f === 'qty' ? { qtyText: i.fix.value } : f === 'unit' ? { unitText: i.fix.value } : { desc: i.fix.value });
      // 采用建议即视为已核对这一条
      setAcks((s) => new Set([...s, i.id]));
    }
  };

  const inline = (...fields: string[]) => {
    if (loud && mode === 'review') return null;
    const list = issues.filter((i) => i.level === 'block' && fields.includes(i.field) && !isQuiet(i));
    if (!list.length) return null;
    return (
      <div className="stack" style={{ gap: 4 }}>
        {list.map((i) => (
          <span key={i.id} className="err row" style={{ gap: 6 }}>
            {i.message}
            {i.fix && (
              <button type="button" className="btn btn-sm" onClick={() => applyFix(i)}>
                <ICheck />
                {i.fix.label}
              </button>
            )}
            {i.fix2 && (
              <button type="button" className="btn btn-sm btn-soft" onClick={() => applyFix(i, true)}>
                {i.fix2.label}
              </button>
            )}
          </span>
        ))}
      </div>
    );
  };

  const toggleAck = (id: string) =>
    setAcks((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const ackAll = () => setAcks((s) => new Set([...s, ...issues.filter((i) => i.level === 'warn').map((i) => i.id)]));

  const discard = async () => {
    const ok = await fb.confirm({ title: '放弃这次识别？', body: '识别结果和本次上传的图片都会被删除，不会生成账单。', confirmLabel: '放弃', danger: true });
    if (!ok) return;
    await guard(async () => {
      if (meta.imageId) await repo.deleteImage(meta.imageId);
      if (meta.originalImageId) await repo.deleteImage(meta.originalImageId);
      await repo.clearDraft();
    });
    go({ name: 'home' }, true);
  };

  const save = async () => {
    if (saving) return;
    if (!gate.canSave) {
      setTriedSave(true);
      const first = issues.find((i) => i.level === 'block');
      if (first) focusIssue(first);
      return;
    }
    setSaving(true);
    try {
      const bISO = parseBRDate(state.billDateText).iso!;
      const dISO = parseBRDate(state.dueDateText).iso!;
      const items = itemsForSave(state, uuid);
      let paidAt: string | null = null;
      if (paidToggle && state.paidDateText?.trim()) {
        paidAt = existing?.paidAt && paidAtToBR(existing.paidAt) === state.paidDateText.trim() ? existing.paidAt : brToPaidAt(state.paidDateText);
      }
      const merchant = merchants.find((m) => m.id === state.merchantId);
      const account = accounts.find((a) => a.id === state.accountId);
      let ocrReview: OcrReviewRecord | null = existing?.ocrReview ?? null;
      if (mode === 'review' && state.ocr) {
        const edits: OcrReviewRecord['edits'] = [];
        if (totalMode) edits.push({ field: 'amountMode', from: 'items', to: { mode: 'total', total: state.totalText } });
        (totalMode ? [] : state.rows).forEach((r, idx) => {
          if (!r.orig) {
            if (!isBlankRow(r)) edits.push({ field: `items[${idx}]`, from: null, to: { qty: r.qtyText, desc: r.desc, unit: r.unitText } });
            return;
          }
          if (r.orig.qty !== r.qtyText) edits.push({ field: `items[${idx}].quantity`, from: r.orig.qty, to: r.qtyText });
          if (r.orig.desc !== r.desc) edits.push({ field: `items[${idx}].description`, from: r.orig.desc, to: r.desc });
          if (r.orig.unit !== r.unitText) edits.push({ field: `items[${idx}].unitPrice`, from: r.orig.unit, to: r.unitText });
          if (isBlankRow(r)) edits.push({ field: `items[${idx}]`, from: r.orig, to: null });
        });
        if ((state.ocr.merchantRaw ?? '') !== state.merchantName) edits.push({ field: 'merchant', from: state.ocr.merchantRaw, to: state.merchantName });
        if ((state.ocr.orderRaw ?? '') !== state.orderNumber) edits.push({ field: 'orderNumber', from: state.ocr.orderRaw, to: state.orderNumber });
        if ((state.ocr.billDateRaw ?? '') !== state.billDateText) edits.push({ field: 'billDate', from: state.ocr.billDateRaw, to: state.billDateText });
        ocrReview = {
          provider: state.ocr.provider,
          rawText: state.ocr.rawText ?? null,
          candidate: state.ocr.candidate,
          warnings: issues.filter((i) => i.level === 'warn').map((i) => i.message),
          acknowledged: issues.filter((i) => acks.has(i.id)).map((i) => i.id),
          edits,
          confirmedAt: nowISO(),
          confirmedBy: '本机用户',
          imageId: meta.imageId,
          originalImageId: meta.originalImageId,
        };
      }
      const now = nowISO();
      const bill: Bill = recompute({
        id: existing?.id ?? uuid(),
        merchantId: merchant?.id ?? state.merchantId,
        merchantNameSnapshot: merchant?.name ?? (state.merchantName || (expenseMode ? categoryLabel(state.category) : '')),
        orderNumber: state.orderNumber.trim(),
        billDate: bISO,
        dueDate: dISO,
        dueBeforeBillConfirmed: state.dueBeforeConfirmed,
        accountId: account?.id ?? state.accountId,
        accountLabelSnapshot: account?.label ?? state.accountLabel,
        reminderDays: Number(state.reminderDays),
        paidAt,
        notes: state.notes.slice(0, 1000),
        items,
        amountMode: totalMode ? 'total' : 'items',
        kind: expenseMode ? 'expense' : 'supplier',
        category: expenseMode ? state.category ?? null : null,
        paymentCode: (state.paymentCode ?? '').trim(),
        recurrence: makeRecurrence(repeatRuleOf(state), existing?.recurrence?.seriesId ?? uuid(), state.repeatUntil?.trim() ? parseBRDate(state.repeatUntil).iso : null, dISO, mode === 'new' ? null : existing),
        estimated: false,
        installment: existing?.installment ?? null,
        totalCents: 0,
        ocrReview,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        deletedAt: null,
        schemaVersion: 1,
      });
      // 防止重复录入：同商家 + 同单号，或同商家 + 同到期日 + 同金额
      const dup = installmentDues.length >= 2 ? null : findDuplicate(store.bills, bill, bill.id);
      if (dup) {
        const go2 = await fb.confirm({
          title: '可能重复录入',
          body: (
            <>
              <p>
                已经有一笔 <b>{dup.merchantNameSnapshot}</b>
                {dup.orderNumber ? ` · 单号 ${dup.orderNumber}` : ''} · {formatBRL(dup.totalCents)} · 到期 {isoToBR(dup.dueDate)}。
              </p>
              <p className="muted">如果这是另一笔账单（比如同一天两张单），可以继续保存；否则建议直接编辑原来那笔。</p>
            </>
          ),
          confirmLabel: '仍然保存',
        });
        if (!go2) {
          setSaving(false);
          return;
        }
      }
      const settled = reconcileOnEdit(mode === 'new' ? null : existing, bill, paidAt, uuid);
      const toSave = installmentDues.length >= 2 ? buildInstallmentBills(settled, installmentDues, uuid) : [settled];
      const ok = await guard(async () => {
        // 识别学习：识别名称记为别名、型号修改记为自动更正
        const learned = mode === 'review' && merchant ? learnFromReview(state, merchant) : null;
        await repo.upsertMany({ bills: toSave, ...(learned && merchant ? { merchants: [{ ...merchant, ...learned, updatedAt: nowISO() }] } : {}) });
        if (mode === 'review') await repo.clearDraft();
        return true;
      });
      if (!ok) return;
      await reload();
      if (toSave.length > 1) {
        fb.toast(`已按分期保存 ${toSave.length} 笔，共 ${formatBRL(bill.totalCents)}`);
        go({ name: 'bills', filter: 'unpaid' }, true);
        return;
      }
      if (existing && existing.dueDate !== bill.dueDate) fb.toast('已保存。到期日有变，如已导入日历请更新旧事件');
      else
        fb.toast(existing ? '已保存修改' : `已保存 ${formatBRL(bill.totalCents)}`, {
          action: { label: '再复制一笔', run: () => go({ name: 'copy', id: bill.id }) },
        });
      if (existing) back();
      else go({ name: 'bills', filter: 'unpaid' }, true);
    } finally {
      setSaving(false);
    }
  };

  const blocks = issues.filter((i) => i.level === 'block');
  const warns = issues.filter((i) => i.level === 'warn');
  const pendingWarns = warns.filter((i) => !acks.has(i.id));
  const selBox = state.rows.find((r) => r.key === selRow)?.bbox ?? null;

  const switchMode = (m: 'items' | 'total') => {
    if (m === (state.amountMode ?? 'items')) return;
    if (m === 'total') {
      const ct = computedTotal(state.rows);
      set({ amountMode: 'total', totalText: state.totalText || (ct > 0 ? centsToInput(ct) : state.ocr?.printedTotalRaw ?? '') });
    } else {
      const cents = parseBRL(state.totalText ?? '').cents;
      const hasRows = state.rows.some((r) => !isBlankRow(r));
      set({
        amountMode: 'items',
        rows: hasRows || !cents ? state.rows : [{ key: uuid(), qtyText: '1', desc: (state.totalDesc ?? '').trim() || TOTAL_ONLY_DESC, unitText: centsToInput(cents) }],
      });
    }
  };

  const shiftCopyDates = (kind: 'term' | 'month') => {
    const src = bills.find((b) => b.id === state.copiedFrom?.id);
    if (!src) return;
    if (kind === 'month') set({ billDateText: isoToBR(addMonths(src.billDate, 1)), dueDateText: isoToBR(addMonths(src.dueDate, 1)), dueBeforeConfirmed: false });
    else set({ billDateText: isoToBR(store.today), dueDateText: isoToBR(addDays(store.today, Math.max(0, diffDays(src.billDate, src.dueDate)))), dueBeforeConfirmed: false });
  };

  const form = (
    <div className="stack">
      {state.copiedFrom && (
        <div className="banner info">
          <span className="grow small">
            复制自 <b>{state.copiedFrom.label}</b>。订单号已清空，请核对日期和金额。
          </span>
          <div className="qchips">
            <button type="button" onClick={() => shiftCopyDates('term')}>
              从今天起算同样账期
            </button>
            <button type="button" onClick={() => shiftCopyDates('month')}>
              原日期顺延 1 个月
            </button>
          </div>
        </div>
      )}
      {mode === 'review' && state.ocr && (
        <div className="banner info">
          <span className="grow small">
            {state.ocr.docType && state.ocr.docType !== 'order' ? <>识别为<b>{DOC_LABEL[state.ocr.docType]}</b>。</> : null}
            识别结果只是草稿，<b>请逐项对照原图</b>。{totalMode ? '' : '总额始终按明细重新计算，不采用图片上的数字。'}
          </span>
        </div>
      )}
      {mode === 'review' && !!(state.ocr?.facts?.length || state.ocr?.learnNotes?.length || state.rows.some((r) => r.learned)) && (
        <div className="banner ok facts">
          <ul>
            {(state.ocr?.facts ?? []).map((f) => (
              <li key={f}>✓ {f}</li>
            ))}
            {(state.ocr?.learnNotes ?? []).map((f) => (
              <li key={f}>✓ {f}</li>
            ))}
            {state.rows
              .filter((r) => r.learned)
              .map((r) => (
                <li key={r.key} className="xs">
                  · {r.learned}
                </li>
              ))}
          </ul>
        </div>
      )}

      {existing?.estimated && (
        <div className="banner warn">
          <span className="grow small">
            这是自动生成的<b>下期账单</b>，金额沿用上期。收到实际账单后请修改金额并保存，保存后「预估」标记会去掉。
          </span>
        </div>
      )}

      <section className="card stack">
        {(
          <div className="seg" role="group" aria-label="账单类型" style={{ alignSelf: 'flex-start' }}>
            <button type="button" aria-pressed={!expenseMode} onClick={() => switchKind('supplier')}>
              商家货款
            </button>
            <button type="button" aria-pressed={expenseMode} onClick={() => switchKind('expense')}>
              日常缴费
            </button>
          </div>
        )}
        {expenseMode && (
          <div className="field" id="f-category" tabIndex={-1}>
            <span className="label">缴费类型</span>
            {state.category && !catOpen ? (
              <div className="row" style={{ gap: 8 }}>
                <span className="cat cat-picked" aria-label={`已选：${categoryLabel(state.category)}`}>
                  <span className="cat-m" aria-hidden="true">
                    {categoryOf(state.category)?.mark}
                  </span>
                  <span className="cat-l">{categoryLabel(state.category)}</span>
                </span>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setCatOpen(true)}>
                  更改
                </button>
              </div>
            ) : (
            <div className={`catgrid${byField.get('category') ? ' bad' : ''}`} role="radiogroup" aria-label="缴费类型">
              {EXPENSE_CATEGORIES.map((c) => (
                <button key={c.id} type="button" role="radio" aria-checked={state.category === c.id} className="cat" onClick={() => { set({ category: c.id }); setCatOpen(false); }}>
                  <span className="cat-m" aria-hidden="true">
                    {c.mark}
                  </span>
                  <span className="cat-l">{c.label}</span>
                  <span className="cat-p">{c.pt}</span>
                </button>
              ))}
            </div>
            )}
          </div>
        )}
        <div className="grid2 stack-sm">
          <div className="field">
            <label htmlFor="f-merchant">{expenseMode ? '缴费单位（可空）' : '商家'}</label>
            <Combobox
              id="f-merchant"
              className={cls('merchant')}
              items={merchantItems}
              value={state.merchantId}
              fallbackLabel={state.merchantId ? state.merchantName : ''}
              onChange={(mid) => chooseMerchant(mid)}
              onCreate={async (name) => {
                const nid = await actions.createMerchant(name, state.ocr?.merchantRaw, expenseMode ? { type: 'payee', defaultCategory: state.category ?? null, recurring: true } : undefined);
                if (nid) chooseMerchant(nid, await repo.listMerchants());
                return nid;
              }}
              createLabel={`新增${partyWord}并保存`}
              placeholder={expenseMode ? '如 Sabesp、Enel、DAS' : '搜索或输入新商家'}
            />
            {expenseMode && !state.merchantId && (categoryOf(state.category)?.suggestions.length ?? 0) > 0 && (
              <div className="qchips">
                <span className="xs muted">常见：</span>
                {categoryOf(state.category)!.suggestions.map((n) => {
                  const m = merchants.find((x) => x.active && x.type === 'payee' && x.name.toLowerCase() === n.toLowerCase());
                  return (
                    <button
                      key={n}
                      type="button"
                      onClick={async () => {
                        if (m) return chooseMerchant(m.id);
                        const nid = await actions.createMerchant(n, null, { type: 'payee', defaultCategory: state.category ?? null, recurring: true });
                        if (nid) chooseMerchant(nid, await repo.listMerchants());
                      }}
                    >
                      {m ? n : `＋ ${n}`}
                    </button>
                  );
                })}
              </div>
            )}
            {!state.merchantId && state.merchantName && <span className="hint">{mode === 'review' ? '识别名称' : '历史名称'}：{state.merchantName}</span>}
            {state.ocr?.merchantRaw && (
              <div className="qchips">
                <span className="xs muted">图片写的是：</span>
                {[state.ocr.merchantRaw, ...state.ocr.merchantCandidates.filter((c) => c !== state.ocr!.merchantRaw)].slice(0, 3).map((c) => {
                  const m = merchants.find((x) => x.active && (x.name === c || x.aliases.includes(c)));
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={async () => {
                        if (m) chooseMerchant(m.id);
                        else {
                          const nid = await actions.createMerchant(c);
                          if (nid) chooseMerchant(nid, await repo.listMerchants());
                        }
                      }}
                    >
                      {m ? `选 ${m.name}` : `＋ ${c}`}
                    </button>
                  );
                })}
              </div>
            )}
            {state.merchantId && !expenseMode && state.merchantId !== settings.defaultMerchantId && (
              <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start', paddingLeft: 0 }} onClick={() => store.saveSettings({ defaultMerchantId: state.merchantId })}>
                设为默认商家
              </button>
            )}
            {state.merchantId && expenseMode && state.category && curMerchant && curMerchant.defaultCategory !== state.category && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ alignSelf: 'flex-start', paddingLeft: 0 }}
                onClick={async () => {
                  await guard(() => repo.putMerchant({ ...curMerchant, defaultCategory: state.category ?? null, updatedAt: nowISO() }));
                  await reload();
                  fb.toast(`「${curMerchant.name}」以后默认归为${categoryLabel(state.category)}`);
                }}
              >
                记住为{categoryLabel(state.category)}
              </button>
            )}
          </div>
          <div className="field">
            <label htmlFor="f-account">付款账号</label>
            <Combobox
              id="f-account"
              items={accountItems}
              value={state.accountId}
              fallbackLabel={state.accountId ? state.accountLabel : ''}
              onChange={(aid) => {
                autoAccount.current = false;
                const a = accounts.find((x) => x.id === aid);
                set({ accountId: a?.id ?? null, accountLabel: a?.label ?? '' });
              }}
              onCreate={async (label) => {
                const nid = await actions.createAccount(label);
                if (nid) {
                  const list = await repo.listAccounts();
                  const a = list.find((x) => x.id === nid);
                  autoAccount.current = false;
                  set({ accountId: nid, accountLabel: a?.label ?? label });
                }
                return nid;
              }}
              createLabel="新增账号并保存"
              placeholder="选择付款账号（可空）"
            />
            {!state.accountId && state.accountLabel && <span className="hint">历史账号：{state.accountLabel}</span>}
            <div className="row" style={{ gap: 4 }}>
              {state.merchantId && state.accountId && merchants.find((m) => m.id === state.merchantId)?.defaultAccountId !== state.accountId && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ paddingLeft: 0 }}
                  onClick={async () => {
                    const m = merchants.find((x) => x.id === state.merchantId)!;
                    await guard(() => repo.putMerchant({ ...m, defaultAccountId: state.accountId, updatedAt: nowISO() }));
                    await reload();
                    fb.toast(`「${m.name}」以后默认用这个账号`);
                  }}
                >
                  设为该商家默认账号
                </button>
              )}
              {state.accountId && state.accountId !== settings.defaultAccountId && (
                <button type="button" className="btn btn-ghost btn-sm" style={{ paddingLeft: 0 }} onClick={() => store.saveSettings({ defaultAccountId: state.accountId })}>
                  设为全局默认
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="grid2 stack-sm">
          <div className="field">
            <label htmlFor="f-orderNumber">{expenseMode ? '单号 / 参考号' : '订单号'}</label>
            <input id="f-orderNumber" className={`input mono${cls('orderNumber')}`} inputMode="text" autoComplete="off" value={state.orderNumber} onChange={(e) => set({ orderNumber: e.target.value })} placeholder="可空，保留前导零" />
            {dupOrder && <span className="err">同商家已有订单号 {state.orderNumber} 的账单（到期 {formatBR(dupOrder.dueDate)}），请确认不是重复录入</span>}
          </div>
          <div className="field">
            <label htmlFor="f-reminderDays">提前提醒（天）</label>
            <input id="f-reminderDays" className={`input num${cls('reminderDays')}`} inputMode="numeric" value={state.reminderDays} onChange={(e) => set({ reminderDays: e.target.value.replace(/[^\d]/g, '') })} />
            <div className="qchips">
              {[0, 1, 3, 5, 7].map((d) => (
                <button key={d} type="button" onClick={() => set({ reminderDays: String(d) })}>
                  {d === 0 ? '当天' : `${d} 天`}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="grid2 stack-sm">
          <div className="field">
            <label htmlFor="f-billDate">账单日期</label>
            <DateField
              id="f-billDate"
              title="选择账单日期"
              className={cls('billDate')}
              value={state.billDateText}
              today={store.today}
              onChange={setBillDate}
              quick={[{ label: '昨天', iso: addDays(store.today, -1) }]}
              hintNode={state.ocr?.billDateRaw ? <span className="hint">图片原文：{state.ocr.billDateRaw}</span> : null}
            />
            {inline('billDate')}
          </div>
          <div className="field">
            <label htmlFor="f-dueDate">到期日期</label>
            <DateField
              id="f-dueDate"
              title="选择到期日期"
              className={cls('dueDate')}
              value={state.dueDateText}
              today={store.today}
              totals={dueTotals}
              quick={dueQuickDates(billISO, store.today)}
              onChange={(v) => set({ dueDateText: v, dueBeforeConfirmed: false, dueAuto: false })}
              hintNode={
                rule ? (
                  state.dueAuto ? (
                    <span className="hint ok-hint">✓ 已按「{curMerchant!.name}」账期（{describeTerm(rule)}）自动计算</span>
                  ) : (
                    <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start', paddingLeft: 0 }} onClick={() => billISO && set(termPatch(rule, billISO, !!existing))}>
                      按「{curMerchant!.name}」账期重新计算
                    </button>
                  )
                ) : null
              }
            />
            {inline('dueDate')}
            {dueISO && nonBusinessReason(dueISO) && (
              <span className="hint warn-hint">
                {isoToBR(dueISO).slice(0, 5)} 是{nonBusinessReason(dueISO)}，银行顺延到 {weekdayCN(nextBusinessDay(dueISO))} {isoToBR(nextBusinessDay(dueISO)).slice(0, 5)}。
                <button type="button" className="linkbtn" onClick={() => set({ dueDateText: isoToBR(nextBusinessDay(dueISO)), dueBeforeConfirmed: false, dueAuto: false })}>
                  改为 {isoToBR(nextBusinessDay(dueISO)).slice(0, 5)}
                </button>
              </span>
            )}
            {billISO && (
              <div className="qchips" aria-label="按账期天数填写">
                <span className="xs muted">账期：</span>
                {[7, 15, 30, 45, 60].map((d) => (
                  <button key={d} type="button" onClick={() => set({ dueDateText: isoToBR(addDays(billISO, d)), dueBeforeConfirmed: false, dueAuto: false })}>
                    +{d}
                  </button>
                ))}
                <button type="button" onClick={() => set({ dueDateText: isoToBR(addMonths(billISO, 1)), dueBeforeConfirmed: false, dueAuto: false })}>
                  下月同日
                </button>
              </div>
            )}
          </div>
        </div>

        {rule?.kind === 'installments' && !existing && (
          <div className="instbox stack" style={{ gap: 6 }}>
            <label className="check" style={{ padding: 0 }}>
              <input type="checkbox" checked={!!state.splitInstallments} onChange={(e) => set({ splitInstallments: e.target.checked })} />
              <span>
                <b>按分期保存</b>（{describeTerm(rule)}，每期单独提醒）
              </span>
            </label>
            {installmentDues.length >= 2 && (
              <div className="tbl-wrap">
                <table className="tbl num">
                  <tbody>
                    {installmentDues.map((d, i) => (
                      <tr key={d + i}>
                        <td>
                          第 {i + 1}/{installmentDues.length} 期
                        </td>
                        <td>{formatBR(d)}</td>
                        <td className="r" style={{ fontWeight: 800 }}>
                          {total > 0 ? formatBRL(splitCents(total, installmentDues.length)[i]) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <div className="field">
          <label htmlFor="f-paymentCode">Boleto 条码 / PIX 复制码（可空）</label>
          <div className="datefield">
            <input id="f-paymentCode" className={`input mono${cls('paymentCode')}`} autoComplete="off" spellCheck={false} value={state.paymentCode ?? ''} onChange={(e) => set({ paymentCode: e.target.value })} placeholder="粘贴后付款时一键复制" />
            <button
              type="button"
              className="btn datebtn"
              aria-label="从剪贴板粘贴"
              title="粘贴"
              onClick={async () => {
                try {
                  const t = await navigator.clipboard.readText();
                  if (t) set({ paymentCode: t.trim() });
                } catch {
                  fb.toast('无法读取剪贴板，请长按输入框粘贴', { bad: true });
                }
              }}
            >
              <ICopy />
            </button>
            {scanSupported() && (
              <button type="button" className="btn datebtn" aria-label="扫码填写付款码" title="扫 Boleto 条码或 PIX 二维码" onClick={() => setScanOpen(true)}>
                <IScan />
              </button>
            )}
          </div>
          {scanOpen && (
            <ScannerSheet
              onClose={() => setScanOpen(false)}
              onResult={(code, kind) => {
                set({ paymentCode: code });
                setScanOpen(false);
                fb.toast(kind === 'pix' ? '已填入 PIX 复制码' : kind === 'other' ? '已填入扫描结果，请核对' : '已把条码转换为可输入的数字线');
              }}
            />
          )}
          {state.paymentCode?.trim() && <span className="hint">{describePaymentCode(state.paymentCode)} · {state.paymentCode.replace(/\D/g, '').length} 位数字</span>}
        </div>

        <div className="field" id="f-repeat" tabIndex={-1}>
          <label htmlFor="f-repeatKey">重复</label>
          <div className="row" style={{ gap: 8 }}>
            <select
              id="f-repeatKey"
              className={`input${cls('repeat')}`}
              style={{ width: 'auto', minWidth: 140 }}
              value={state.repeatKey ?? (state.recurring ? 'm1' : 'none')}
              onChange={(e) => set({ repeatKey: e.target.value })}
            >
              <option value="none">不重复</option>
              {REPEAT_PRESETS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
              <option value="custom">自定义…</option>
            </select>
            {state.repeatKey === 'custom' && (
              <>
                <span className="small">每</span>
                <input className={`input num${cls('repeat')}`} style={{ width: 72 }} inputMode="numeric" aria-label="间隔" value={state.repeatEvery ?? ''} onChange={(e) => set({ repeatEvery: e.target.value.replace(/\D/g, '') })} />
                <select className="input" style={{ width: 'auto' }} aria-label="单位" value={state.repeatUnit ?? 'month'} onChange={(e) => set({ repeatUnit: e.target.value as RepeatUnit })}>
                  {(Object.keys(UNIT_LABEL) as RepeatUnit[]).map((u) => (
                    <option key={u} value={u}>
                      {UNIT_LABEL[u]}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
          {(state.repeatKey ?? 'none') !== 'none' && (
            <>
              <div className="field" style={{ maxWidth: 320 }}>
                <label htmlFor="f-repeatUntil">结束日期（可空 = 一直重复）</label>
                <DateField id="f-repeatUntil" title="选择重复结束日期" value={state.repeatUntil ?? ''} today={store.today} onChange={(v) => set({ repeatUntil: v })} />
              </div>
              <span className="hint">
                {repeatRuleOf(state) ? `${describeRepeat(repeatRuleOf(state))}：` : ''}付款后自动生成下一期
              </span>
            </>
          )}
          {inline('repeat')}
        </div>

        {(
          <div className="stack" style={{ gap: 6 }}>
            <label className="check" style={{ padding: 0 }}>
              <input
                type="checkbox"
                checked={paidToggle}
                onChange={async (e) => {
                  const on = e.target.checked;
                  // 取消勾选会清空多笔付款记录：先确认
                  if (!on && existing && (existing.payments?.length ?? 0) > 1) {
                    const ok = await fb.confirm({ title: '取消「已付款」？', body: <p>这笔账单有 {existing.payments!.length} 条付款记录，保存后会全部清空。只想改某一笔付款，请到账单详情里删除那一条。</p>, confirmLabel: '仍然取消' });
                    if (!ok) return;
                  }
                  setPaidToggle(on);
                  set({ paidDateText: on ? state.paidDateText || isoToBR(store.today) : '' });
                }}
              />
              <span>
                <b>已付款</b>
              </span>
            </label>
            {!paidToggle && existing && isPartial(existing) && (
              <span className="hint">
                已分次付 {formatBRL(existing.totalCents - openCents(existing))}，还差 {formatBRL(openCents(existing))}。付款记录在账单详情里管理；勾选「已付款」会把剩余部分记为一笔付款。
              </span>
            )}
            {paidToggle && (
              <div className="field" style={{ maxWidth: 320 }}>
                <label htmlFor="f-paidDate">付款日期</label>
                <DateField id="f-paidDate" title="选择付款日期" className={cls('paidDate')} value={state.paidDateText ?? ''} today={store.today} onChange={(v) => set({ paidDateText: v })} />
              </div>
            )}
          </div>
        )}
      </section>

      <section className="card stack" aria-label="明细">
        <div className="section-head" style={{ flexWrap: 'wrap' }}>
          <h2>{totalMode ? '金额' : '明细'}</h2>
          <div className="seg" role="group" aria-label="金额填写方式">
            <button type="button" aria-pressed={!totalMode} onClick={() => switchMode('items')}>
              逐行明细
            </button>
            <button type="button" aria-pressed={totalMode} onClick={() => switchMode('total')}>
              仅填总金额
            </button>
          </div>
        </div>
        {totalMode ? (
          <div className="stack">
            <div className="grid2 stack-sm">
              <div className="field">
                <label htmlFor="f-totalOnly">总金额 R$</label>
                <input id="f-totalOnly" className={`input num big-input${cls('totalOnly')}`} inputMode="decimal" autoComplete="off" placeholder="例如 1.234,56" value={state.totalText ?? ''} onChange={(e) => set({ totalText: e.target.value })} />
                {inline('totalOnly')}
                {state.ocr?.printedTotalRaw && (
                  <div className="qchips">
                    <span className="xs muted">图片 TOTAL：</span>
                    <button type="button" onClick={() => set({ totalText: state.ocr!.printedTotalRaw! })}>
                      用 {state.ocr.printedTotalRaw}
                    </button>
                    {computedTotal(state.rows) > 0 && (
                      <button type="button" onClick={() => set({ totalText: centsToInput(computedTotal(state.rows)) })}>
                        用明细合计 {formatBRL(computedTotal(state.rows), false)}
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div className="field">
                <label htmlFor="f-totalDesc">说明（可空）</label>
                <input id="f-totalDesc" className="input" value={state.totalDesc ?? ''} onChange={(e) => set({ totalDesc: e.target.value })} placeholder={TOTAL_ONLY_DESC} maxLength={120} />
              </div>
            </div>
          </div>
        ) : (
        <>
        <div className="items-wrap has-cards">
          <table className="items-table">
            <thead>
              <tr>
                <th>数量</th>
                <th>型号 / 描述</th>
                <th>单价 R$</th>
                <th style={{ textAlign: 'right' }}>小计</th>
                <th>
                  <span className="sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {state.rows.map((r) => (
                <ItemRowTable key={r.key} r={r} cls={cls} sel={selRow === r.key} onSel={() => setSelRow(r.key)} setRow={setRow} onRemove={() => set({ rows: state.rows.filter((x) => x.key !== r.key) })} onView={r.bbox ? () => { setSelRow(r.key); setPane('img'); } : undefined} />
              ))}
            </tbody>
          </table>
        </div>
        <div className="item-cards">
          {state.rows.map((r, idx) => (
            <ItemRowCard key={r.key} idx={idx} r={r} cls={cls} sel={selRow === r.key} onSel={() => setSelRow(r.key)} setRow={setRow} onRemove={() => set({ rows: state.rows.filter((x) => x.key !== r.key) })} onView={r.bbox ? () => { setSelRow(r.key); setPane('img'); } : undefined} />
          ))}
        </div>
        <button type="button" className="btn btn-soft" onClick={() => set({ rows: [...state.rows, blankRow()] })}>
          <IPlus />
          添加一行
        </button>
        </>
        )}
        <div className="totalbar" id="f-total">
          <span className="stack" style={{ gap: 0 }}>
            <span className="small" style={{ fontWeight: 700 }}>{totalMode ? '保存金额' : '计算总额'}</span>
            {state.ocr?.printedTotalRaw && !totalMode && (
              <span className={`xs ${byField.get('total') ? 'err' : 'muted'}`}>
                图片 TOTAL：{state.ocr.printedTotalRaw}
                {(() => {
                  const p = parseBRL(state.ocr!.printedTotalRaw!, { groupingKnown: true });
                  return p.cents !== null && p.cents !== total ? `（差额 ${formatBRL(total - p.cents)}）` : p.cents === total ? ' ✓ 一致' : '';
                })()}
              </span>
            )}
          </span>
          <span className="t num">{formatBRL(total)}</span>
        </div>
      </section>

      {state.ocr && state.ocr.unparsedLines.length > 0 && !totalMode && (
        <section className="card stack" id="f-unparsed">
          <h3>未解析的行</h3>
          <p className="small muted">这些行包含数字但没有形成明细。如果是漏掉的商品，请点「转为明细」后补全。</p>
          {state.ocr.unparsedLines.map((l, i) => (
            <div key={i} className="row between" style={{ borderTop: '1px dashed var(--line)', paddingTop: 8 }}>
              <span className="mono grow" style={{ overflowWrap: 'anywhere' }}>{l}</span>
              <button type="button" className="btn btn-sm" onClick={() => set({ rows: [...state.rows, { ...blankRow(), desc: '', qtyText: '', unitText: '', needsReview: true, confidence: 0 }] })}>
                转为明细
              </button>
            </div>
          ))}
        </section>
      )}

      <section className="card stack">
        <div className="field">
          <label htmlFor="f-notes">备注</label>
          <textarea id="f-notes" className={`input${cls('notes')}`} maxLength={1000} value={state.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="如：月结、含运费、找某某结账" />
          <span className="hint">{state.notes.length}/1000</span>
        </div>
      </section>

      {existing && (
        <section className="card stack">
          {existing.ocrReview && (
            <details className="more">
              <summary>识别记录（{existing.ocrReview.provider}，{new Date(existing.ocrReview.confirmedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} 确认）</summary>
              <div className="stack small" style={{ paddingTop: 8 }}>
                <span>人工修改 {existing.ocrReview.edits.length} 处，核对警告 {existing.ocrReview.acknowledged.length} 条。</span>
                {existing.ocrReview.edits.map((e, i) => (
                  <span key={i} className="mono xs">
                    {e.field}: {JSON.stringify(e.from)} → {JSON.stringify(e.to)}
                  </span>
                ))}
              </div>
            </details>
          )}
          <button type="button" className="btn btn-soft" style={{ alignSelf: 'flex-start' }} onClick={() => go({ name: 'copy', id: existing.id })}>
            <ICopy />
            复制为新账单
          </button>
          <button type="button" className="btn btn-danger-text" style={{ alignSelf: 'flex-start' }} onClick={async () => (await actions.removeBill(existing)) && go({ name: 'bills' }, true)}>
            <ITrash />
            删除这笔账单
          </button>
        </section>
      )}
    </div>
  );

  const showIssues = mode === 'review' || triedSave;
  const issuesPanel = showIssues && issues.length > 0 && (
    <section className="card stack" aria-label="需要处理的问题" id="f-issues">
      <div className="section-head">
        <h3>
          需要处理 · <span className="err">{blocks.length} 必改</span>
          {isReview && warns.length > 0 && <span style={{ color: 'var(--soon)' }}> · {pendingWarns.length} 待核对</span>}
        </h3>
        {mode === 'review' && pendingWarns.length > 1 && (
          <button className="link" onClick={ackAll}>
            全部标为已核对
          </button>
        )}
      </div>
      <div className="issues">
        {issues
          .filter((i) => i.level === 'block' || mode === 'review')
          .map((i) => {
            const done = i.level === 'warn' && acks.has(i.id);
            return (
              <div key={i.id} className={`issue ${done ? 'done' : i.level}`}>
                <span className="ic" aria-hidden="true">
                  {done ? '✓' : i.level === 'block' ? '!' : '?'}
                </span>
                <div className="txt stack" style={{ gap: 6 }}>
                  <button className="goto" onClick={() => focusIssue(i)}>
                    <span className="sr-only">{i.level === 'block' ? '必须修正：' : '警告：'}</span>
                    {i.message}
                  </button>
                  {i.fix && (
                    <div className="inline-fix">
                      <button className="btn btn-sm" onClick={() => applyFix(i)}>
                        <ICheck />
                        {i.fix.label}
                      </button>
                      {i.fix2 && (
                        <button className="btn btn-sm btn-soft" onClick={() => applyFix(i, true)}>
                          {i.fix2.label}
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {i.level === 'warn' && mode === 'review' && (
                  <label>
                    <input type="checkbox" checked={done} onChange={() => toggleAck(i.id)} />
                    已核对
                  </label>
                )}
              </div>
            );
          })}
      </div>
    </section>
  );

  const saveBar = (
    <div className="savebar">
      <div className="row between" style={{ flexWrap: 'nowrap' }}>
        <span className="stack" style={{ gap: 0, minWidth: 0 }}>
          <span className="xs muted">保存金额</span>
          <span className="num" style={{ fontWeight: 800, fontSize: '1.2rem' }}>
            {formatBRL(total)}
          </span>
        </span>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          {mode === 'review' ? (
            <button className="btn btn-ghost btn-sm" onClick={discard}>
              放弃
            </button>
          ) : (
            <button className="btn btn-ghost btn-sm" onClick={back}>
              取消
            </button>
          )}
          <button className="btn btn-primary" disabled={(mode === 'review' && !gate.canSave) || saving} aria-disabled={!gate.canSave} onClick={save} aria-describedby="gate-reasons">
            {saving ? <span className="spin" /> : <ICheck />}
            {mode === 'review' ? '确认保存' : '保存'}
          </button>
        </div>
      </div>
      {mode === 'review' && (
        <label className="check" style={{ padding: 0, minHeight: 36 }}>
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          <span style={{ fontWeight: 700 }}>我已对照原图确认</span>
        </label>
      )}
      {!gate.canSave && (loud || issues.some((i) => i.level === 'block' && !isQuiet(i))) && (
        <span id="gate-reasons" className="xs err">
          {gate.reasons.join('；')}
        </span>
      )}
    </div>
  );

  if (!images.processed && mode !== 'review') {
    return (
      <>
        {issuesPanel}
        {form}
        {saveBar}
      </>
    );
  }

  return (
    <>
      <div className="mobile-switch">
        <div className="seg" role="group" aria-label="切换视图" style={{ width: '100%' }}>
          <button style={{ flex: 1 }} aria-pressed={pane === 'img'} onClick={() => setPane('img')}>
            原图
          </button>
          <button style={{ flex: 1 }} aria-pressed={pane === 'form'} onClick={() => setPane('form')}>
            核对字段{blocks.length + pendingWarns.length ? ` (${blocks.length + (mode === 'review' ? pendingWarns.length : 0)})` : ''}
          </button>
        </div>
      </div>
      <div className="review">
        <div className={`imgpane ${pane === 'img' ? '' : 'hide-mobile'}`}>
          <ImagePane processed={images.processed} original={images.original} box={selBox} rows={state.rows} selRow={selRow} onSelRow={(k) => { setSelRow(k); }} />
        </div>
        <div className={`stack ${pane === 'form' ? '' : 'hide-mobile'}`}>
          {issuesPanel}
          {form}
        </div>
      </div>
      {saveBar}
    </>
  );
}

function ItemRowTable({ r, cls, sel, onSel, setRow, onRemove, onView }: { r: RowState; cls: (k: string) => string; sel: boolean; onSel: () => void; setRow: (k: string, p: Partial<RowState>) => void; onRemove: () => void; onView?: () => void }) {
  const p = parseRow(r);
  const printed = r.printedSubtotalRaw ? parseBRL(r.printedSubtotalRaw, { groupingKnown: true }) : null;
  const mismatch = printed && printed.cents !== null && p.subtotalCents !== null && printed.cents !== p.subtotalCents;
  const k = r.key;
  return (
    <tr className={sel ? 'sel' : ''} onFocus={onSel} onClick={onSel}>
      <td className="c-qty">
        <input id={`row-${k}-qty`} aria-label="数量" className={`input num${cls(`${k}:qty`)}${cls(`${k}:row`)}`} inputMode="decimal" value={r.qtyText} onChange={(e) => setRow(k, { qtyText: e.target.value })} />
      </td>
      <td>
        <input id={`row-${k}-desc`} aria-label="型号或描述" className={`input mono${cls(`${k}:desc`)}${cls(`${k}:row`)}`} autoCapitalize="characters" spellCheck={false} value={r.desc} onChange={(e) => setRow(k, { desc: e.target.value })} />
        {(r.needsReview || (r.confidence !== undefined && r.confidence < 0.85)) && (
          <span className="rowflag">
            置信度 {r.confidence !== undefined ? `${Math.round(r.confidence * 100)}%` : '低'}
          </span>
        )}
      </td>
      <td className="c-unit">
        <input id={`row-${k}-unit`} aria-label="单价" className={`input num${cls(`${k}:unit`)}${cls(`${k}:row`)}`} inputMode="decimal" value={r.unitText} onChange={(e) => setRow(k, { unitText: e.target.value })} />
      </td>
      <td className="c-sub">
        <div className="subcell num">
          <span>{p.subtotalCents !== null ? formatBRL(p.subtotalCents, false) : '—'}</span>
          {r.printedSubtotalRaw && <span className={`printed${mismatch ? ' bad' : ''}`}>图片 {r.printedSubtotalRaw}{mismatch ? ' ≠' : ' ✓'}</span>}
        </div>
      </td>
      <td className="c-x">
        <div className="stack" style={{ gap: 2 }}>
          <button type="button" className="btn btn-ghost iconbtn" aria-label="删除此行" onClick={onRemove}>
            <IX />
          </button>
          {onView && (
            <button type="button" className="btn btn-ghost iconbtn only-narrow" aria-label="在原图上查看" onClick={onView}>
              <IEye />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function ItemRowCard({ r, idx, cls, sel, onSel, setRow, onRemove, onView }: { r: RowState; idx: number; cls: (k: string) => string; sel: boolean; onSel: () => void; setRow: (k: string, p: Partial<RowState>) => void; onRemove: () => void; onView?: () => void }) {
  const p = parseRow(r);
  const printed = r.printedSubtotalRaw ? parseBRL(r.printedSubtotalRaw, { groupingKnown: true }) : null;
  const mismatch = printed && printed.cents !== null && p.subtotalCents !== null && printed.cents !== p.subtotalCents;
  const k = r.key;
  return (
    <div className={`item-card${sel ? ' sel' : ''}`} onFocus={onSel} onClick={onSel}>
      <div className="field full">
        <label htmlFor={`rowc-${k}-desc`}>
          第 {idx + 1} 行 · 型号 / 描述
          {(r.needsReview || (r.confidence !== undefined && r.confidence < 0.85)) && <span className="rowflag">置信度 {r.confidence !== undefined ? `${Math.round(r.confidence * 100)}%` : '低'}</span>}
        </label>
        <input id={`rowc-${k}-desc`} className={`input mono${cls(`${k}:desc`)}${cls(`${k}:row`)}`} autoCapitalize="characters" spellCheck={false} value={r.desc} onChange={(e) => setRow(k, { desc: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor={`rowc-${k}-qty`}>数量</label>
        <input id={`rowc-${k}-qty`} className={`input num${cls(`${k}:qty`)}${cls(`${k}:row`)}`} inputMode="decimal" value={r.qtyText} onChange={(e) => setRow(k, { qtyText: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor={`rowc-${k}-unit`}>单价 R$</label>
        <input id={`rowc-${k}-unit`} className={`input num${cls(`${k}:unit`)}${cls(`${k}:row`)}`} inputMode="decimal" value={r.unitText} onChange={(e) => setRow(k, { unitText: e.target.value })} />
      </div>
      <div className="foot">
        <span className="stack num" style={{ gap: 0 }}>
          <b>小计 {p.subtotalCents !== null ? formatBRL(p.subtotalCents) : '—'}</b>
          {r.printedSubtotalRaw && <span className={`xs ${mismatch ? 'err' : 'muted'}`}>图片小计 {r.printedSubtotalRaw}{mismatch ? ' ≠ 不一致' : ' ✓'}</span>}
        </span>
        <span className="row" style={{ gap: 2 }}>
          {onView && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onView}>
              <IEye />
              看原图
            </button>
          )}
          <button type="button" className="btn btn-ghost iconbtn" aria-label={`删除第 ${idx + 1} 行`} onClick={onRemove}>
            <IX />
          </button>
        </span>
      </div>
    </div>
  );
}

function ImagePane({ processed, original, box, rows, selRow, onSelRow }: { processed: Blob | null; original: Blob | null; box: [number, number, number, number] | null; rows: RowState[]; selRow: string | null; onSelRow: (k: string) => void }) {
  const [which, setWhich] = useState<'processed' | 'original'>('processed');
  const [zoom, setZoom] = useState(1);
  const blob = which === 'original' && original ? original : processed;
  const [url, setUrl] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!blob) return;
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  useEffect(() => {
    if (!box || which !== 'processed' || !boxRef.current) return;
    const el = boxRef.current;
    const img = el.querySelector('img');
    if (!img) return;
    el.scrollTo({ top: Math.max(0, box[1] * img.clientHeight - el.clientHeight / 3), left: Math.max(0, box[0] * img.clientWidth - 20), behavior: 'smooth' });
  }, [box, which, zoom]);
  if (!blob) return <div className="empty">没有保存图片</div>;
  const withBox = rows.filter((r) => r.bbox);
  return (
    <>
      <div className="row between">
        <div className="seg" role="group" aria-label="图片版本">
          <button aria-pressed={which === 'processed'} onClick={() => setWhich('processed')}>
            识别用图
          </button>
          {original && (
            <button aria-pressed={which === 'original'} onClick={() => setWhich('original')}>
              原始照片
            </button>
          )}
        </div>
        <div className="row" style={{ gap: 4 }}>
          <button className="btn btn-sm iconbtn" aria-label="缩小" onClick={() => setZoom((z) => Math.max(1, z - 0.5))} disabled={zoom <= 1}>
            −
          </button>
          <span className="xs num" style={{ minWidth: 36, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
          <button className="btn btn-sm iconbtn" aria-label="放大" onClick={() => setZoom((z) => Math.min(4, z + 0.5))} disabled={zoom >= 4}>
            +
          </button>
        </div>
      </div>
      <div className="imgbox" ref={boxRef}>
        <div style={{ position: 'relative', width: `${zoom * 100}%` }}>
          {url && <img src={url} alt="票据图片" />}
          {which === 'processed' &&
            withBox.map((r) => (
              <div
                key={r.key}
                className="box"
                style={{
                  left: `${r.bbox![0] * 100}%`,
                  top: `${r.bbox![1] * 100}%`,
                  width: `${r.bbox![2] * 100}%`,
                  height: `${r.bbox![3] * 100}%`,
                  opacity: r.key === selRow ? 1 : 0,
                }}
              />
            ))}
        </div>
      </div>
      {withBox.length > 0 ? (
        <div className="qchips" aria-label="在图上定位明细行">
          <span className="xs muted">定位：</span>
          {rows.map((r, i) =>
            r.bbox ? (
              <button key={r.key} type="button" onClick={() => onSelRow(r.key)} style={r.key === selRow ? { borderColor: 'var(--hl-line)', background: 'var(--hl)' } : undefined}>
                {i + 1} {r.desc || '?'}
              </button>
            ) : null,
          )}
        </div>
      ) : (
        <span className="xs muted">此次识别没有提供行位置，请用放大功能逐行核对。</span>
      )}
    </>
  );
}
