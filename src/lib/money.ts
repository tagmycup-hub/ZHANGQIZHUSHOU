/**
 * 金额工具：内部一律使用整数分（centavos）。
 * 解析巴西格式：千位用 "."，小数用 ","。
 */

export interface MoneyParse {
  /** 解析出的分；无法确定时为 null */
  cents: number | null;
  /** 格式存在歧义（需人工确认） */
  ambiguous: boolean;
  /** 歧义时的候选值（分） */
  candidates: number[];
  /** 无法解析的原因 */
  error?: string;
  raw: string;
}

export interface MoneyParseOptions {
  /** 调用方确认 "1.234" 这类写法是千位分组 */
  groupingKnown?: boolean;
}

const MAX_CENTS = 1_000_000_000_00; // R$ 1 bilhão，超出视为异常

function digitsToInt(s: string): number {
  // 逐位累加，避免浮点
  let n = 0;
  for (const ch of s) n = n * 10 + (ch.charCodeAt(0) - 48);
  return n;
}

function result(raw: string, cents: number | null, ambiguous = false, candidates: number[] = [], error?: string): MoneyParse {
  if (cents !== null && cents > MAX_CENTS) return { raw, cents: null, ambiguous: false, candidates: [], error: '金额超出合理范围' };
  return { raw, cents, ambiguous, candidates, error };
}

export function parseBRL(input: string | number | null | undefined, opts: MoneyParseOptions = {}): MoneyParse {
  if (input === null || input === undefined) return result('', null, false, [], '空值');
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) return result(String(input), null, false, [], '不是有效金额');
    // 数字输入按"元"理解，四舍五入到分
    return result(String(input), Math.round(input * 100));
  }
  const raw = input;
  let s = input.trim().replace(/^R\$\s*/i, '').replace(/\s+/g, '');
  if (s.startsWith('-')) return result(raw, null, false, [], '不允许负数金额');
  if (s === '') return result(raw, null, false, [], '空值');
  if (!/^[0-9.,]+$/.test(s)) return result(raw, null, false, [], '包含非数字字符');
  if (!/[0-9]/.test(s)) return result(raw, null, false, [], '没有数字');

  const commaCount = (s.match(/,/g) || []).length;
  const dotCount = (s.match(/\./g) || []).length;

  // 情况 1：有逗号 —— 逗号是小数分隔符（巴西格式）
  if (commaCount > 1) return result(raw, null, false, [], '出现多个逗号');
  if (commaCount === 1) {
    const [intPart, decPart] = s.split(',');
    if (dotCount > 0) {
      // 1.234,56 —— 点必须是规范千位分组
      if (!/^\d{1,3}(\.\d{3})+$/.test(intPart)) return result(raw, null, false, [], '千位分组格式不正确');
    } else if (!/^\d*$/.test(intPart)) {
      return result(raw, null, false, [], '整数部分格式不正确');
    }
    const intDigits = intPart.replace(/\./g, '') || '0';
    if (decPart.length === 0) return result(raw, digitsToInt(intDigits) * 100, true, [digitsToInt(intDigits) * 100], '逗号后没有数字');
    if (decPart.length === 1) return result(raw, digitsToInt(intDigits) * 100 + digitsToInt(decPart) * 10);
    if (decPart.length === 2) return result(raw, digitsToInt(intDigits) * 100 + digitsToInt(decPart));
    if (decPart.length === 3 && dotCount === 0) {
      // "1,234" 可能是英文千位写法
      return result(raw, null, true, [digitsToInt(intDigits + decPart) * 100], '逗号后有 3 位数字，可能是千位分组');
    }
    return result(raw, null, false, [], '小数位过多');
  }

  // 情况 2：只有点
  if (dotCount === 0) return result(raw, digitsToInt(s) * 100);
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    const cents = digitsToInt(s.replace(/\./g, '')) * 100;
    if (opts.groupingKnown) return result(raw, cents);
    const alt: number[] = [cents];
    if (dotCount === 1) {
      // 也可能是英文小数 1.234 —— 超过 2 位小数，不作为金额候选
    }
    return result(raw, null, true, alt, '"." 可能是千位分组，需确认');
  }
  if (dotCount === 1) {
    const [i, d] = s.split('.');
    if (/^\d*$/.test(i) && /^\d{1,2}$/.test(d)) {
      const cents = digitsToInt(i || '0') * 100 + (d.length === 1 ? digitsToInt(d) * 10 : digitsToInt(d));
      return result(raw, null, true, [cents], '"." 被当作小数点使用，需确认');
    }
  }
  return result(raw, null, false, [], '无法识别的金额格式');
}

/** 严格解析：歧义或错误都返回 null */
export function parseBRLStrict(input: string, opts: MoneyParseOptions = {}): number | null {
  const r = parseBRL(input, opts);
  return r.ambiguous ? null : r.cents;
}

/** 数量解析，支持 "2,5" 与 "2.5"，最多 3 位小数；返回千分之一单位的整数 */
export function parseQuantityMilli(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input <= 0) return null;
    return Math.round(input * 1000);
  }
  const s = input.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,3})?$/.test(s)) return null;
  const [i, d = ''] = s.split('.');
  const milli = digitsToInt(i) * 1000 + digitsToInt((d + '000').slice(0, 3));
  return milli > 0 ? milli : null;
}

export function milliToQuantity(milli: number): number {
  return milli / 1000;
}

/**
 * 小计 = 数量 × 单价。
 * 舍入规则：数量按千分位整数计算，结果四舍五入（0.5 分向上进位，金额非负）。
 */
export function lineSubtotalCents(quantity: number, unitPriceCents: number): number {
  const milli = Math.round(quantity * 1000);
  const product = milli * unitPriceCents; // 整数
  return Math.floor((product + 500) / 1000);
}

export function sumCents(values: number[]): number {
  let t = 0;
  for (const v of values) {
    if (!Number.isInteger(v)) throw new Error('sumCents 只接受整数分');
    t += v;
  }
  return t;
}

export function formatBRL(cents: number | null | undefined, withSymbol = true): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const int = Math.floor(abs / 100);
  const dec = String(abs % 100).padStart(2, '0');
  const intStr = String(int).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${neg ? '-' : ''}${withSymbol ? 'R$ ' : ''}${intStr},${dec}`;
}

/** 编辑框使用的格式（不带符号） */
export function centsToInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  return formatBRL(cents, false);
}

export function formatQuantity(q: number): string {
  return Number.isInteger(q) ? String(q) : String(q).replace('.', ',');
}
