import { isPartial, openCents } from './lib/payments';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { billStatus, inReminderWindow, notifySignature } from './lib/status';
import { todayISO, addDays, relativeDue } from './lib/dates';
import { formatBRL } from './lib/money';
import { showNotification, notifyState } from './lib/platform';

export interface ReminderSnapshot {
  overdue: number;
  soon: number;
  checkedAt: Date | null;
}

/**
 * 应用内提醒：启动、窗口聚焦、页面恢复可见、每分钟轮询时重新计算。
 * 系统通知：应用打开期间按"日期|账单|到期日|状态"签名去重。
 */
export function useReminders(): ReminderSnapshot & { recheck: () => void } {
  const { bills, settings, repo, ready } = useStore();
  const [snap, setSnap] = useState<ReminderSnapshot>({ overdue: 0, soon: 0, checkedAt: null });
  const busy = useRef(false);
  const latest = useRef({ bills, settings });
  latest.current = { bills, settings };

  const check = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const { bills, settings } = latest.current;
      const today = todayISO();
      const due = bills.filter((b) => inReminderWindow(b, today));
      const overdue = due.filter((b) => billStatus(b, today) === 'overdue').length;
      setSnap({ overdue, soon: due.length - overdue, checkedAt: new Date() });
      if (!settings.notificationsEnabled || notifyState() !== 'granted' || !due.length) return;
      const fresh = await repo.getSettings();
      const sent = new Set(fresh.notifiedSignatures);
      const newly: string[] = [];
      for (const b of due) {
        const st = billStatus(b, today, settings.dueSoonDays);
        const sig = notifySignature(b, today, st);
        if (sent.has(sig)) continue;
        const ok = await showNotification(
          st === 'overdue' ? `已逾期：${b.merchantNameSnapshot}` : `付款提醒：${b.merchantNameSnapshot}`,
          `${isPartial(b) ? `还差 ${formatBRL(openCents(b))}` : formatBRL(b.totalCents)} · ${relativeDue(b.dueDate, today)}${b.accountLabelSnapshot ? ` · ${b.accountLabelSnapshot}` : ''}`,
          `bill-${b.id}`,
        );
        if (ok) newly.push(sig);
      }
      if (newly.length) {
        const cutoff = addDays(today, -30);
        const latest = await repo.getSettings();
        const keep = latest.notifiedSignatures.filter((s) => s.slice(0, 10) >= cutoff);
        await repo.putSettings({ ...latest, notifiedSignatures: [...new Set([...keep, ...newly])] });
      }
    } catch {
      // 提醒失败不影响主流程
    } finally {
      busy.current = false;
    }
  }, [repo]);

  useEffect(() => {
    if (!ready) return;
    check();
  }, [ready, bills, settings.notificationsEnabled, check]);

  useEffect(() => {
    const onVis = () => document.visibilityState === 'visible' && check();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pageshow', check);
    const t = setInterval(check, 60_000);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pageshow', check);
      clearInterval(t);
    };
  }, [check]);

  return { ...snap, recheck: check };
}
