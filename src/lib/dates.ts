/** 日期工具：内部 ISO YYYY-MM-DD；界面 DD/MM/YYYY；时区 America/Sao_Paulo */

export const TZ = 'America/Sao_Paulo';

export function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y: number, m: number): number {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

export function isValidYMD(y: number, m: number, d: number): boolean {
  return Number.isInteger(y) && Number.isInteger(m) && Number.isInteger(d) && y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

export function isValidISO(iso: unknown): boolean {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const [y, m, d] = iso.split('-').map(Number);
  return isValidYMD(y, m, d);
}

const pad = (n: number) => String(n).padStart(2, '0');
export const toISO = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

export interface DateParse {
  iso: string | null;
  error?: string;
  /** 两位年份等需要用户确认的情况，iso 为候选值 */
  needsConfirm?: boolean;
  candidate?: string;
  raw: string;
}

/** 解析 DD/MM/YYYY（也接受 - 或 . 分隔）。两位年份不静默猜测。 */
export function parseBRDate(raw: string | null | undefined, now: Date = new Date()): DateParse {
  const s = (raw ?? '').trim();
  if (!s) return { iso: null, raw: s, error: '日期为空' };
  if (isValidISO(s)) return { iso: s, raw: s };
  const m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/);
  if (!m) return { iso: null, raw: s, error: '日期格式应为 DD/MM/YYYY' };
  const d = Number(m[1]);
  const mo = Number(m[2]);
  if (m[3].length === 2) {
    const century = Math.floor(Number(todayISO(now).slice(0, 4)) / 100) * 100;
    const y = century + Number(m[3]);
    if (!isValidYMD(y, mo, d)) return { iso: null, raw: s, error: `日期不存在：${s}` };
    return { iso: null, raw: s, needsConfirm: true, candidate: toISO(y, mo, d), error: `两位年份需确认：是否为 ${y} 年？` };
  }
  const y = Number(m[3]);
  if (!isValidYMD(y, mo, d)) return { iso: null, raw: s, error: `日期不存在：${s}` };
  return { iso: toISO(y, mo, d), raw: s };
}

export function formatBR(iso: string | null | undefined): string {
  if (!iso || !isValidISO(iso)) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** 圣保罗时区下的"今天" */
export function todayISO(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** 圣保罗时区的小时（0-23） */
export function hourInSP(now: Date = new Date()): number {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(now);
  return Number(h);
}

function isoToUTCms(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function addDays(iso: string, n: number): string {
  const dt = new Date(isoToUTCms(iso) + n * 86400000);
  return toISO(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** b - a 的天数 */
export function diffDays(a: string, b: string): number {
  return Math.round((isoToUTCms(b) - isoToUTCms(a)) / 86400000);
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
export function weekdayCN(iso: string): string {
  return WEEK[new Date(isoToUTCms(iso)).getUTCDay()];
}

/** 相对描述：今天 / 明天 / 3 天后 / 逾期 2 天 */
export function relativeDue(dueISO: string, today: string): string {
  const n = diffDays(today, dueISO);
  if (n === 0) return '今天到期';
  if (n === 1) return '明天到期';
  if (n > 1) return `${n} 天后到期`;
  return `逾期 ${-n} 天`;
}

/** 月份加减（日期超出目标月天数时取月末，如 31/01 + 1 月 = 28/02） */
export function addMonths(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return toISO(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

export function endOfMonth(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return toISO(y, m, daysInMonth(y, m));
}

/** YYYY-MM 的月份加减 */
export function shiftMonth(ym: string, n: number): string {
  return addMonths(`${ym}-01`, n).slice(0, 7);
}

export function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${y}年${m}月`;
}

/** 月历网格（周日开头），返回 6 行 × 7 列的 ISO 日期，前后补齐相邻月份 */
export function monthGrid(ym: string): string[] {
  const first = `${ym}-01`;
  const dow = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1)).getUTCDay();
  const start = addDays(first, -dow);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}
