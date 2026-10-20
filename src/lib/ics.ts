import type { Bill } from './types';
import { addDays } from './dates';
import { formatBRL, formatQuantity } from './money';
import { openCents } from './payments';
import { billTitle, categoryLabel } from './expense';

/** RFC 5545 文本转义 */
export function escapeICS(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}

/** 按 75 个 UTF-8 字节折行，不拆开多字节字符 */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (bytes + b > limit) {
      out.push(cur);
      cur = ch;
      bytes = b;
      limit = 74; // 续行以空格开头
    } else {
      cur += ch;
      bytes += b;
    }
  }
  out.push(cur);
  return out.join('\r\n ');
}

const ymd = (iso: string) => iso.replace(/-/g, '');

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** 以分钟表示的有符号 ICS 时长 */
export function icsDuration(totalMinutes: number): string {
  const sign = totalMinutes < 0 ? '-' : '';
  let m = Math.abs(totalMinutes);
  const d = Math.floor(m / 1440);
  m -= d * 1440;
  const h = Math.floor(m / 60);
  m -= h * 60;
  let s = `${sign}P`;
  if (d) s += `${d}D`;
  if (h || m || !d) {
    s += 'T';
    if (h) s += `${h}H`;
    if (m || (!h && !d)) s += `${m}M`;
  }
  return s;
}

export const ICS_UID_DOMAIN = 'zhangqi-zhushou.local';
export const billUID = (bill: Pick<Bill, 'id'>) => `${bill.id}@${ICS_UID_DOMAIN}`;

function alarm(minutesFromStart: number, text: string): string[] {
  return ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeICS(text)}`, `TRIGGER:${icsDuration(minutesFromStart)}`, 'END:VALARM'];
}

/** 单个 VEVENT（全天事件，提醒时间为圣保罗 09:00） */
export function billEvent(bill: Bill, now: Date = new Date()): string[] {
  const expense = bill.kind === 'expense';
  const part = bill.installment ? `（${bill.installment.index}/${bill.installment.count} 期）` : '';
  const open = openCents(bill);
  const partial = !bill.paidAt && open > 0 && open < bill.totalCents;
  const title = `${expense ? '缴费' : '付款'}：${billTitle(bill)} ${formatBRL(open || bill.totalCents)}${part}${partial ? '（尾款）' : ''}`;
  const desc = [
    expense ? `类型：${categoryLabel(bill.category)}` : '',
    `${expense ? '缴费单位' : '商家'}：${bill.merchantNameSnapshot}`,
    bill.orderNumber ? `订单号：${bill.orderNumber}` : '',
    `金额：${formatBRL(bill.totalCents)}`,
    partial ? `已付：${formatBRL(bill.totalCents - open)}，还差 ${formatBRL(open)}` : '',
    `付款账号：${bill.accountLabelSnapshot || '未指定'}`,
    `提前提醒：${bill.reminderDays} 天`,
    bill.paymentCode ? `付款码：${bill.paymentCode}` : '',
    bill.estimated ? '金额为预估，请以实际账单为准' : '',
    '明细：',
    ...bill.items.map((i) => `  ${formatQuantity(i.quantity)} × ${i.description} × ${formatBRL(i.unitPriceCents)} = ${formatBRL(i.subtotalCents)}`),
    bill.notes ? `备注：${bill.notes}` : '',
    '（由账期助手导出；账单修改或付款后请更新或删除此事件）',
  ]
    .filter(Boolean)
    .join('\n');
  const lines = [
    'BEGIN:VEVENT',
    `UID:${billUID(bill)}`,
    `DTSTAMP:${stamp(now)}`,
    `SEQUENCE:${Math.max(0, Math.floor(Date.parse(bill.updatedAt) / 1000) % 2147483647)}`,
    `DTSTART;VALUE=DATE:${ymd(bill.dueDate)}`,
    `DTEND;VALUE=DATE:${ymd(addDays(bill.dueDate, 1))}`,
    `SUMMARY:${escapeICS(title)}`,
    `DESCRIPTION:${escapeICS(desc)}`,
    'TRANSP:TRANSPARENT',
    'CATEGORIES:账期',
  ];
  // 全天事件从本地 00:00 开始；09:00 = +540 分钟
  const nine = 9 * 60;
  if (bill.reminderDays > 0) lines.push(...alarm(nine - bill.reminderDays * 1440, `${bill.reminderDays} 天后需付款：${title}`));
  lines.push(...alarm(nine, `今天需付款：${title}`));
  lines.push('END:VEVENT');
  return lines;
}

export function buildICS(bills: Bill[], now: Date = new Date()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ZhangqiZhushou//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:账期提醒',
    'X-WR-TIMEZONE:America/Sao_Paulo',
    ...bills.flatMap((b) => billEvent(b, now)),
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
