import { nextSlot } from './lib/colors';
import { isPartial, openCents, withPayment, withoutPayment, withoutPayments } from './lib/payments';
import { useCallback } from 'react';
import { useStore } from './store';
import { useFeedback } from './ui/feedback';
import type { Bill, Merchant, PaymentAccount } from './lib/types';
import { uuid, nowISO } from './lib/ids';
import { buildICS } from './lib/ics';
import { saveFile, copyText } from './lib/platform';
import { formatBRL } from './lib/money';
import { needsNextRecurring, nextRecurring, billTitle } from './lib/expense';
import { addDays, formatBR, relativeDue } from './lib/dates';

const norm = (s: string) => s.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();

export function useActions() {
  const store = useStore();
  const { repo, guard, reload, merchants, accounts, bills, today } = store;
  const fb = useFeedback();

  /** 撤销一笔付款：只去掉这笔付款，期间做的其他修改保留；自动生成的下一期若没改过才删除 */
  const undoPayment = useCallback(
    async (billId: string, paymentId: string, next: Bill | null, receiptImageId?: string | null) => {
      await guard(async () => {
        const cur = await repo.getBill(billId);
        if (cur) await repo.putBill(withoutPayment(cur, paymentId, nowISO()));
        if (receiptImageId) await repo.deleteImage(receiptImageId);
        if (next) {
          const n = await repo.getBill(next.id);
          if (n && n.updatedAt === next.updatedAt) await repo.deleteBill(next.id);
        }
      });
      await reload();
    },
    [repo, guard, reload],
  );

  /** 记一笔付款（金额可小于账单总额；付清时自动标记已付并生成下一期） */
  const addPayment = useCallback(
    async (b: Bill, cents: number, date: string, note?: string, receipt?: Blob | null) => {
      if (cents <= 0) return;
      const receiptImageId = receipt ? await guard(() => repo.putImage(receipt)) : null;
      const pid = uuid();
      const updated = withPayment(b, { id: pid, date, cents, note, receiptImageId: receiptImageId ?? null }, nowISO());
      const next = updated.paidAt && needsNextRecurring(updated, bills) ? nextRecurring(updated, uuid(), nowISO()) : null;
      await guard(() => repo.upsertMany({ bills: next ? [updated, next] : [updated] }));
      await reload();
      const left = openCents(updated);
      fb.toast(updated.paidAt ? (next ? `已付清 ${formatBRL(b.totalCents)}，已生成下一期（${formatBR(next.dueDate)} 到期）` : `已付清 ${formatBRL(b.totalCents)}`) : `已记 ${formatBRL(cents)}，还差 ${formatBRL(left)}`, {
        action: {
          label: '撤销',
          run: () => undoPayment(b.id, pid, next, receiptImageId),
        },
      });
    },
    [bills, repo, guard, reload, fb, undoPayment],
  );

  const markPaid = useCallback(
    async (b: Bill) => {
      const rest = openCents(b);
      const pid = uuid();
      const paid = withPayment(b, { id: pid, date: today, cents: rest }, nowISO());
      const next = needsNextRecurring(paid, bills) ? nextRecurring(paid, uuid(), nowISO()) : null;
      await guard(() => repo.upsertMany({ bills: next ? [paid, next] : [paid] }));
      await reload();
      fb.toast(next ? `已付款 ${formatBRL(rest)}，已生成下一期（${formatBR(next.dueDate)} 到期）` : `已标记付款 ${formatBRL(rest)}`, {
        action: {
          label: '撤销',
          run: () => undoPayment(b.id, pid, next),
        },
      });
    },
    [repo, guard, reload, fb, bills, today, undoPayment],
  );

  const markManyPaid = useCallback(
    async (list: Bill[]) => {
      const open = list.filter((b) => !b.paidAt);
      if (!open.length) return;
      const ok = await fb.confirm({
        title: `把 ${open.length} 笔标记为已付？`,
        body: <p>合计 {formatBRL(open.reduce((s, b) => s + openCents(b), 0))}，付款日期记为今天。</p>,
        confirmLabel: '全部标记已付',
      });
      if (!ok) return;
      const t = nowISO();
      const all = [...bills];
      const writes: Bill[] = [];
      for (const b of open) {
        const paid = withPayment(b, { id: uuid(), date: today, cents: openCents(b) }, t);
        writes.push(paid);
        const n = needsNextRecurring(paid, all) ? nextRecurring(paid, uuid(), t) : null;
        if (n) {
          writes.push(n);
          all.push(n);
        }
      }
      await guard(() => repo.upsertMany({ bills: writes }));
      await reload();
      fb.toast(`已标记 ${open.length} 笔已付${writes.length > open.length ? `，生成 ${writes.length - open.length} 笔下一期账单` : ''}`);
    },
    [bills, repo, guard, reload, fb, today],
  );

  /** 复制一段可以发给商家/同事的文字 */
  const copySummary = useCallback(
    async (b: Bill) => {
      const lines = [
        `${billTitle(b)}${b.orderNumber ? ` #${b.orderNumber}` : ''}`,
        `金额：${formatBRL(b.totalCents)}${b.installment ? `（第 ${b.installment.index}/${b.installment.count} 期）` : ''}`,
        `到期：${formatBR(b.dueDate)}（${b.paidAt ? '已付款' : relativeDue(b.dueDate, today)}）`,
        isPartial(b) ? `已付：${formatBRL(b.totalCents - openCents(b))}，还差 ${formatBRL(openCents(b))}` : '',
        b.accountLabelSnapshot ? `付款账号：${b.accountLabelSnapshot}` : '',
        b.paymentCode ? `付款码：${b.paymentCode}` : '',
      ].filter(Boolean);
      const ok = await copyText(lines.join('\n'));
      fb.toast(ok ? '账单摘要已复制' : '复制失败', { bad: !ok });
    },
    [fb, today],
  );

  const copyCode = useCallback(
    async (text: string, what: string) => {
      const ok = await copyText(text);
      fb.toast(ok ? `${what}已复制，去银行 App 粘贴付款` : '复制失败，请手动选择', { bad: !ok });
    },
    [fb],
  );

  /**
   * 复制账单付款码：PIX 复制码原样（里面的空格是有效内容），Boleto 只保留数字。
   * 复制后去银行 App 付款，回到本应用时问一句「付好了吗？」，一键标记已付。
   */
  const copyBillCode = useCallback(
    async (b: Bill) => {
      const raw = (b.paymentCode ?? '').trim();
      if (!raw) return;
      const pix = /^000201/.test(raw);
      const ok = await copyText(pix ? raw : raw.replace(/\D/g, ''));
      if (!ok) return fb.toast('复制失败，请手动选择', { bad: true });
      fb.toast(`${pix ? 'PIX 复制码' : '付款码'}已复制，去银行 App 粘贴付款`);
      if (b.paidAt) return;
      const left = Date.now();
      const onVis = () => {
        if (document.visibilityState !== 'visible') return;
        const away = Date.now() - left;
        if (away < 4000) return;
        document.removeEventListener('visibilitychange', onVis);
        if (away > 30 * 60 * 1000) return;
        fb.toast(`刚才复制了「${billTitle(b)}」的付款码，付好了吗？`, { action: { label: '标记已付', run: () => markPaid(b) } });
      };
      document.addEventListener('visibilitychange', onVis);
      setTimeout(() => document.removeEventListener('visibilitychange', onVis), 30 * 60 * 1000);
    },
    [fb, markPaid],
  );

  /** 手动生成重复账单的下一期（不必等付款） */
  const generateNext = useCallback(
    async (b: Bill) => {
      if (!needsNextRecurring(b, bills)) {
        fb.toast('下一期已经存在或已超过重复结束日期');
        return;
      }
      const n = nextRecurring(b, uuid(), nowISO());
      if (!n) return;
      await guard(() => repo.putBill(n));
      await reload();
      fb.toast(`已生成下一期：${formatBR(n.dueDate)} 到期，金额待确认`);
    },
    [bills, repo, guard, reload, fb],
  );

  const markUnpaid = useCallback(
    async (b: Bill) => {
      await guard(async () => {
        await repo.putBill(withoutPayments(b, nowISO()));
        for (const p of b.payments ?? []) if (p.receiptImageId) await repo.deleteImage(p.receiptImageId);
      });
      await reload();
      fb.toast('已恢复为未付（付款记录已清空）');
    },
    [repo, guard, reload, fb],
  );

  /** 批量顺延到期日（和商家谈好延期时用） */
  const postponeMany = useCallback(
    async (list: Bill[], days: number) => {
      const open = list.filter((b) => !b.paidAt);
      if (!open.length || !days) return;
      const t = nowISO();
      const moved = open.map((b) => ({ ...b, dueDate: addDays(b.dueDate, days), updatedAt: t }));
      await guard(() => repo.upsertMany({ bills: moved }));
      await reload();
      fb.toast(`已把 ${open.length} 笔到期日顺延 ${days} 天`, {
        action: {
          label: '撤销',
          run: async () => {
            // 只把到期日改回去（期间的其他修改保留）
            await guard(async () => {
              for (const b of open) {
                const cur = await repo.getBill(b.id);
                if (cur && cur.dueDate === addDays(b.dueDate, days)) await repo.putBill({ ...cur, dueDate: b.dueDate, updatedAt: nowISO() });
              }
            });
            await reload();
          },
        },
      });
    },
    [repo, guard, reload, fb],
  );

  /** 删除一条付款记录 */
  const removePayment = useCallback(
    async (b: Bill, paymentId: string) => {
      const img = b.payments?.find((p) => p.id === paymentId)?.receiptImageId;
      await guard(async () => {
        await repo.putBill(withoutPayment(b, paymentId, nowISO()));
        if (img) await repo.deleteImage(img);
      });
      await reload();
      fb.toast('已删除这条付款记录');
    },
    [repo, guard, reload, fb],
  );

  const removeBill = useCallback(
    async (b: Bill) => {
      if (!store.requireFeature('edit')) return;
      const ok = await fb.confirm({
        title: '删除这笔账单？',
        body: (
          <>
            <p>
              {b.merchantNameSnapshot} · {formatBRL(b.totalCents)}
              {b.orderNumber ? ` · 订单 ${b.orderNumber}` : ''}
            </p>
            <p className="muted">删除后可以马上撤销；附带的票据照片会被清理。如已导入日历，请手动删除对应事件。</p>
          </>
        ),
        confirmLabel: '删除',
        danger: true,
      });
      if (!ok) return false;
      await guard(() => repo.deleteBill(b.id));
      await reload();
      fb.toast('账单已删除', {
        action: {
          label: '撤销',
          run: async () => {
            // 恢复账单内容（票据照片已随删除清理）
            const ocr = b.ocrReview ? { ...b.ocrReview, imageId: null, originalImageId: null } : null;
            const payments = b.payments?.map((p) => ({ ...p, receiptImageId: null }));
            await guard(() => repo.putBill({ ...b, ocrReview: ocr, payments, deletedAt: null, updatedAt: nowISO() }));
            await reload();
            fb.toast('已恢复账单');
          },
        },
      });
      return true;
    },
    [repo, guard, reload, fb],
  );

  const exportICS = useCallback(
    async (list: Bill[], name: string) => {
      const open = list.filter((b) => !b.paidAt);
      if (!open.length) {
        fb.toast('没有未付账单可导出', { bad: true });
        return;
      }
      const ics = buildICS(open);
      const r = await saveFile(name, ics, 'text/calendar');
      if (r.outcome === 'saved') fb.toast(`已导出 ${open.length} 个日历事件`);
      else if (r.outcome === 'shared') fb.toast('已打开系统分享');
      else if (r.outcome === 'unsupported') {
        const ok = await copyText(ics);
        fb.toast(ok ? '此处无法直接下载 .ics，日历内容已复制到剪贴板' : r.message ?? '无法导出', { bad: !ok });
      }
    },
    [fb],
  );

  const createMerchant = useCallback(
    async (name: string, alias?: string | null, extra: Partial<Merchant> = {}): Promise<string | null> => {
      const n = norm(name);
      const type = extra.type ?? 'supplier';
      const dup = merchants.find((m) => (m.type ?? 'supplier') === type && (norm(m.name) === n || m.aliases.some((a) => norm(a) === n)));
      if (dup) {
        fb.toast(`已存在商家「${dup.name}」${dup.active ? '，已为你选中' : '（已停用）'}`);
        return dup.active ? dup.id : null;
      }
      const m: Merchant = {
        id: uuid(),
        name: name.trim(),
        aliases: alias && norm(alias) !== n ? [alias.trim()] : [],
        defaultAccountId: null,
        active: true,
        color: nextSlot(merchants),
        createdAt: nowISO(),
        updatedAt: nowISO(),
        ...extra,
      };
      const ok = await guard(async () => {
        await repo.putMerchant(m);
        return true;
      });
      if (!ok) return null;
      await reload();
      fb.toast(`已保存${type === 'payee' ? '缴费单位' : '商家'}「${m.name}」`);
      return m.id;
    },
    [merchants, repo, guard, reload, fb],
  );

  const createAccount = useCallback(
    async (label: string): Promise<string | null> => {
      const n = norm(label);
      const dup = accounts.find((a) => norm(a.label) === n);
      if (dup) {
        fb.toast(`已存在账号「${dup.label}」${dup.active ? '，已为你选中' : '（已停用）'}`);
        return dup.active ? dup.id : null;
      }
      const a: PaymentAccount = { id: uuid(), label: label.trim(), type: /pix/i.test(label) ? 'pix' : 'outro', owner: '', bank: '', optionalPixHint: '', active: true, createdAt: nowISO(), updatedAt: nowISO() };
      const ok = await guard(async () => {
        await repo.putAccount(a);
        return true;
      });
      if (!ok) return null;
      await reload();
      fb.toast(`已保存付款账号「${a.label}」，可在「资料」页补充银行和 PIX`);
      return a.id;
    },
    [accounts, repo, guard, reload, fb],
  );

  return { copyBillCode, postponeMany, addPayment, removePayment, generateNext, markPaid, markManyPaid, markUnpaid, removeBill, exportICS, createMerchant, createAccount, copySummary, copyCode };
}
