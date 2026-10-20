/** 浏览器能力封装：文件保存、复制、通知 */
import { getDownloads } from './ocr/providers';

export type SaveOutcome = 'saved' | 'shared' | 'declined' | 'unsupported';

export async function saveFile(filename: string, data: string, mime: string): Promise<{ outcome: SaveOutcome; message?: string }> {
  // 1) 在 Claude 中打开时，走平台下载能力
  const dl = await getDownloads();
  if (dl) {
    try {
      await dl.save({ filename, data });
      return { outcome: 'saved' };
    } catch (e: any) {
      if (e?.code === 'declined') return { outcome: 'declined' };
      if (e?.code !== 'rejected_extension' && e?.code !== 'extension_not_enabled') {
        if (e?.code === 'rate_limited') return { outcome: 'declined', message: '已有一个保存确认框，请先处理' };
      }
      // 继续尝试分享
    }
  }
  // 2) 手机端系统分享（可直接存到"文件"或发送到日历）
  try {
    const file = new File([data], filename, { type: mime });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      return { outcome: 'shared' };
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') return { outcome: 'declined' };
  }
  // 3) 普通浏览器下载
  if (!dl) {
    try {
      const url = URL.createObjectURL(new Blob([data], { type: mime }));
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return { outcome: 'saved' };
    } catch {}
  }
  return { outcome: 'unsupported', message: '当前环境不允许直接下载此类文件，已提供复制方式' };
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export type NotifyState = 'granted' | 'denied' | 'default' | 'unsupported';

export function notifyState(): NotifyState {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission as NotifyState;
}

export async function requestNotify(): Promise<NotifyState> {
  if (typeof Notification === 'undefined') return 'unsupported';
  try {
    return (await Notification.requestPermission()) as NotifyState;
  } catch {
    return notifyState();
  }
}

export async function showNotification(title: string, body: string, tag: string): Promise<boolean> {
  if (notifyState() !== 'granted') return false;
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (reg) {
      await reg.showNotification(title, { body, tag, icon: 'icon.svg', badge: 'icon.svg', data: { url: location.href } });
      return true;
    }
  } catch {}
  try {
    new Notification(title, { body, tag });
    return true;
  } catch {
    return false;
  }
}

export function googleCalendarUrl(title: string, dueISO: string, nextISO: string, details: string): string {
  const p = new URLSearchParams({ action: 'TEMPLATE', text: title, dates: `${dueISO.replace(/-/g, '')}/${nextISO.replace(/-/g, '')}`, details, ctz: 'America/Sao_Paulo' });
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}
