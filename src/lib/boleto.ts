/** Boleto 条码（44 位）↔ 银行 App 可输入的「linha digitável」 */

export function mod10(num: string): number {
  let sum = 0;
  let w = 2;
  for (let i = num.length - 1; i >= 0; i--) {
    let p = Number(num[i]) * w;
    if (p > 9) p = Math.floor(p / 10) + (p % 10);
    sum += p;
    w = w === 2 ? 1 : 2;
  }
  return (10 - (sum % 10)) % 10;
}

function weighted11(num: string): number {
  let sum = 0;
  let w = 2;
  for (let i = num.length - 1; i >= 0; i--) {
    sum += Number(num[i]) * w;
    w = w === 9 ? 2 : w + 1;
  }
  return sum % 11;
}

/** 银行 boleto 条码的总校验位（模 11，结果 0/10/11 记为 1） */
export function bankDV(num43: string): number {
  const d = 11 - weighted11(num43);
  return d === 0 || d === 10 || d === 11 ? 1 : d;
}

/** 公共缴费（以 8 开头）的模 11（余数 0/1 记为 0） */
export function utilityMod11(num: string): number {
  const r = weighted11(num);
  return r === 0 || r === 1 ? 0 : 11 - r;
}

const isUtility = (code: string) => code[0] === '8';
const utilityDV = (code: string) => (code[2] === '6' || code[2] === '7' ? mod10 : utilityMod11);

/** 条码校验：防止扫错（总校验位不对就不接受） */
export function validBarcode(code: string): boolean {
  if (!/^\d{44}$/.test(code)) return false;
  if (isUtility(code)) {
    const f = utilityDV(code);
    return f(code.slice(0, 3) + code.slice(4)) === Number(code[3]);
  }
  return bankDV(code.slice(0, 4) + code.slice(5)) === Number(code[4]);
}

/** 44 位条码 → linha digitável（银行 47 位 / 公共缴费 48 位，带分隔格式） */
export function barcodeToLine(code: string): string | null {
  if (!validBarcode(code)) return null;
  if (isUtility(code)) {
    const f = utilityDV(code);
    const blocks = [0, 11, 22, 33].map((i) => code.slice(i, i + 11));
    return blocks.map((b) => `${b}-${f(b)}`).join(' ');
  }
  const free = code.slice(19);
  const f1 = code.slice(0, 4) + free.slice(0, 5);
  const f2 = free.slice(5, 15);
  const f3 = free.slice(15, 25);
  const p1 = `${f1}${mod10(f1)}`;
  const p2 = `${f2}${mod10(f2)}`;
  const p3 = `${f3}${mod10(f3)}`;
  return `${p1.slice(0, 5)}.${p1.slice(5)} ${p2.slice(0, 5)}.${p2.slice(5)} ${p3.slice(0, 5)}.${p3.slice(5)} ${code[4]} ${code.slice(5, 19)}`;
}

/** 扫码得到的原文 → 存进账单的付款码（PIX 原样保留；条码转为 linha digitável） */
export function normalizeScanned(text: string): { code: string; kind: 'pix' | 'boleto' | 'utility' | 'other' } | { error: string } {
  const t = text.trim();
  if (/^000201/.test(t)) return { code: t, kind: 'pix' };
  const digits = t.replace(/\D/g, '');
  if (digits.length === 44) {
    const line = barcodeToLine(digits);
    if (!line) return { error: '条码校验失败，可能没扫清楚，请再扫一次' };
    return { code: line, kind: isUtility(digits) ? 'utility' : 'boleto' };
  }
  if (digits.length === 47 || digits.length === 48) return { code: t, kind: digits.length === 48 ? 'utility' : 'boleto' };
  if (t.length >= 8) return { code: t, kind: 'other' };
  return { error: '没有识别到付款码' };
}

/* ---------------- 数字线（linha digitável）解析与校验 ---------------- */

export type CodeKind = 'boleto' | 'utility';

export interface LineInfo {
  kind: CodeKind;
  /** 44 位条码 */
  barcode: string;
  /** 格式化后的数字线（存进账单的付款码） */
  line: string;
  /** 金额（分）；公共缴费为"参考值"时为 null */
  amountCents: number | null;
  /** 到期日（银行 boleto 才有）；因子为 0 时为 null */
  dueDate: string | null;
  /** 银行代码（boleto）或行业分类（公共缴费） */
  bank?: string;
  segment?: 'city' | 'water' | 'energy' | 'telecom' | 'government' | 'carne' | 'fine' | 'other';
}

const SEGMENT: Record<string, LineInfo['segment']> = { '1': 'city', '2': 'water', '3': 'energy', '4': 'telecom', '5': 'government', '6': 'carne', '7': 'fine', '9': 'other' };

const addDaysISO = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/**
 * 到期因子 → 日期。2025-02-22 起因子从 1000 重新开始（FEBRABAN 规则），
 * 旧基准 1997-10-07。取离 today 最近的那个解释。
 */
export function factorToDate(factor: number, today: string): string | null {
  if (!factor) return null;
  const oldD = addDaysISO('1997-10-07', factor);
  const newD = factor >= 1000 ? addDaysISO('2025-02-22', factor - 1000) : null;
  if (!newD) return oldD;
  const dist = (d: string) => Math.abs(Date.parse(d) - Date.parse(today));
  return dist(newD) <= dist(oldD) ? newD : oldD;
}

/** 银行数字线（47 位）→ 条码；各段校验位不对返回 null */
function bankLineToBarcode(d: string): string | null {
  const f1 = d.slice(0, 9), dv1 = Number(d[9]);
  const f2 = d.slice(10, 20), dv2 = Number(d[20]);
  const f3 = d.slice(21, 31), dv3 = Number(d[31]);
  if (mod10(f1) !== dv1 || mod10(f2) !== dv2 || mod10(f3) !== dv3) return null;
  const barcode = d.slice(0, 4) + d[32] + d.slice(33, 47) + f1.slice(4) + f2 + f3;
  return validBarcode(barcode) ? barcode : null;
}

/** 公共缴费数字线（48 位）→ 条码 */
function utilityLineToBarcode(d: string): string | null {
  const blocks = [0, 12, 24, 36].map((i) => d.slice(i, i + 12));
  const f = d[2] === '6' || d[2] === '7' ? mod10 : utilityMod11;
  for (const b of blocks) if (f(b.slice(0, 11)) !== Number(b[11])) return null;
  const barcode = blocks.map((b) => b.slice(0, 11)).join('');
  return validBarcode(barcode) ? barcode : null;
}

/** 从条码读出金额、到期日等 */
export function barcodeInfo(barcode: string, today: string): LineInfo | null {
  if (!validBarcode(barcode)) return null;
  const line = barcodeToLine(barcode)!;
  if (barcode[0] === '8') {
    const real = barcode[2] === '6' || barcode[2] === '8';
    return { kind: 'utility', barcode, line, amountCents: real ? Number(barcode.slice(4, 15)) : null, dueDate: null, segment: SEGMENT[barcode[1]] ?? 'other' };
  }
  return { kind: 'boleto', barcode, line, amountCents: Number(barcode.slice(9, 19)) || null, dueDate: factorToDate(Number(barcode.slice(5, 9)), today), bank: barcode.slice(0, 3) };
}

/** 解析一串数字线 / 条码文字（允许空格、点、横线）；校验不通过返回 null */
export function parseLine(text: string, today: string): LineInfo | null {
  const d = text.replace(/\D/g, '');
  if (d.length === 44) return barcodeInfo(d, today);
  if (d.length === 47) {
    const b = bankLineToBarcode(d);
    return b ? barcodeInfo(b, today) : null;
  }
  if (d.length === 48 && d[0] === '8') {
    const b = utilityLineToBarcode(d);
    return b ? barcodeInfo(b, today) : null;
  }
  return null;
}

/**
 * 在一段文字里找出所有能通过校验的数字线（PDF 文字、OCR 文字、模型读到的原文）。
 * 只认标准格式（分组写法或恰好 44/47/48 位的连续数字），不在长串数字里滑动截取——否则可能"凑出"一条能通过校验的假数字线。
 */
export function findLines(text: string, today: string): LineInfo[] {
  const patterns = [
    /(?<![\d.])\d{5}[.\s]?\d{5}\s+\d{5}[.\s]?\d{6}\s+\d{5}[.\s]?\d{6}\s+\d\s+\d{14}(?!\d)/g, // 银行
    /(?<!\d)8\d{10}[-\s]?\d\s+\d{11}[-\s]?\d\s+\d{11}[-\s]?\d\s+\d{11}[-\s]?\d(?!\d)/g, // 公共缴费
    /(?<!\d)(?:\d{47}|8\d{47}|\d{44})(?!\d)/g, // 连续数字
  ];
  const out: LineInfo[] = [];
  const seen = new Set<string>();
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const info = parseLine(m[0], today);
      if (info && !seen.has(info.barcode)) {
        seen.add(info.barcode);
        out.push(info);
      }
    }
  }
  return out;
}
