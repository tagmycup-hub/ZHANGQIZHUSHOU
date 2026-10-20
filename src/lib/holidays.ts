/** 巴西全国节假日与工作日（Boleto 到期日遇周末/节假日顺延到下一个工作日） */
import { addDays } from './dates';

/** 复活节（格里高利历，Meeus 算法） */
export function easter(y: number): string {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const cache = new Map<number, Map<string, string>>();

/** 某年的全国节假日（含银行不营业的狂欢节周一、周二） */
export function holidaysOf(y: number): Map<string, string> {
  const hit = cache.get(y);
  if (hit) return hit;
  const e = easter(y);
  const fixed: [string, string][] = [
    ['01-01', '元旦'],
    ['04-21', '蒂拉登特斯日'],
    ['05-01', '劳动节'],
    ['09-07', '独立日'],
    ['10-12', '圣母显灵日'],
    ['11-02', '万灵节'],
    ['11-15', '共和国日'],
    ['11-20', '黑人意识日'],
    ['12-25', '圣诞节'],
  ];
  const m = new Map<string, string>(fixed.map(([md, n]) => [`${y}-${md}`, n]));
  m.set(addDays(e, -48), '狂欢节');
  m.set(addDays(e, -47), '狂欢节');
  m.set(addDays(e, -2), '耶稣受难日');
  m.set(addDays(e, 60), '基督圣体节');
  cache.set(y, m);
  return m;
}

const weekday = (iso: string) => new Date(`${iso}T12:00:00Z`).getUTCDay();

export function holidayName(iso: string): string | null {
  return holidaysOf(Number(iso.slice(0, 4))).get(iso) ?? null;
}

/** 非工作日的原因（周六、周日或节日名），工作日返回 null */
export function nonBusinessReason(iso: string): string | null {
  const h = holidayName(iso);
  if (h) return h;
  const w = weekday(iso);
  return w === 0 ? '周日' : w === 6 ? '周六' : null;
}

/** 当天或之后的第一个工作日 */
export function nextBusinessDay(iso: string): string {
  let d = iso;
  for (let i = 0; i < 15 && nonBusinessReason(d); i++) d = addDays(d, 1);
  return d;
}

/** 某月第 n 个工作日（工资一般在次月第 5 个工作日前发放） */
export function nthBusinessDay(ym: string, n: number): string {
  let d = `${ym}-01`;
  let count = 0;
  for (let i = 0; i < 40; i++) {
    if (!nonBusinessReason(d)) {
      count++;
      if (count === n) return d;
    }
    d = addDays(d, 1);
  }
  return d;
}
