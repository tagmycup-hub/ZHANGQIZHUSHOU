/**
 * 本地 OCR 行重建：按词框物理纵坐标聚类成行，再从左到右解析
 * 数量 / 型号 / 单价 / 小计。无法可靠解析的行进入 unparsedLines。
 */
import type { ModelOutput, ModelItem, BBox } from './protocol';
import { parseBRL, parseQuantityMilli } from '../money';

export interface Word {
  text: string;
  confidence: number; // 0–100（tesseract 口径）
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Line {
  words: Word[];
  y0: number;
  y1: number;
  x0: number;
  x1: number;
}

function median(ns: number[]): number {
  if (!ns.length) return 0;
  const s = [...ns].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function groupLines(words: Word[]): Line[] {
  const ws = words.filter((w) => w.text.trim());
  if (!ws.length) return [];
  const h = median(ws.map((w) => w.y1 - w.y0)) || 10;
  const sorted = [...ws].sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
  const lines: { words: Word[]; cy: number }[] = [];
  for (const w of sorted) {
    const cy = (w.y0 + w.y1) / 2;
    const last = lines[lines.length - 1];
    if (last && Math.abs(cy - last.cy) <= h * 0.6) {
      last.words.push(w);
      last.cy = last.words.reduce((s, x) => s + (x.y0 + x.y1) / 2, 0) / last.words.length;
    } else lines.push({ words: [w], cy });
  }
  return lines.map((l) => {
    const words = l.words.sort((a, b) => a.x0 - b.x0);
    return {
      words,
      y0: Math.min(...words.map((w) => w.y0)),
      y1: Math.max(...words.map((w) => w.y1)),
      x0: Math.min(...words.map((w) => w.x0)),
      x1: Math.max(...words.map((w) => w.x1)),
    };
  });
}

const MONEY_RE = /^(R\$)?\d{1,3}(\.\d{3})*(,\d{1,2})?$|^(R\$)?\d+(,\d{1,2})?$/i;
const QTY_RE = /^\d+([.,]\d{1,3})?$/;
const lineText = (l: Line) => l.words.map((w) => w.text).join(' ');
const hasManyNumbers = (t: string) => (t.match(/\d+/g) || []).length >= 2;

export interface RowParse {
  quantity: number;
  description: string;
  unitPriceRaw: string;
  unitPriceCents: number;
  printedSubtotalRaw: string | null;
  printedSubtotalCents: number | null;
}

/** 解析一行：数量 描述… 单价 [小计] */
export function parseItemLine(texts: string[]): RowParse | null {
  const t = texts.map((s) => s.replace(/[|]/g, '').trim()).filter(Boolean);
  if (t.length < 3) return null;
  if (!QTY_RE.test(t[0])) return null;
  const milli = parseQuantityMilli(t[0]);
  if (milli === null) return null;
  const tail = t.slice(1);
  const moneyIdx = tail.map((s, i) => (MONEY_RE.test(s) ? i : -1)).filter((i) => i >= 0);
  if (!moneyIdx.length) return null;
  const last = moneyIdx[moneyIdx.length - 1];
  if (last !== tail.length - 1) return null; // 行尾必须是金额
  let unitI: number;
  let subI: number | null;
  const prev = moneyIdx.length >= 2 ? moneyIdx[moneyIdx.length - 2] : -1;
  if (prev === last - 1 && prev >= 1) {
    unitI = prev;
    subI = last;
  } else {
    unitI = last;
    subI = null;
  }
  const descTokens = tail.slice(0, unitI);
  // 描述中出现纯数字 token，说明列拆分不可靠，交给人工
  if (descTokens.some((x) => /^\d+([.,]\d+)?$/.test(x))) return null;
  const desc = descTokens.join(' ').trim();
  if (!desc || !/[A-Za-z\u4e00-\u9fff]/.test(desc)) return null;
  const up = parseBRL(tail[unitI]);
  if (up.cents === null || up.ambiguous) return null;
  let subCents: number | null = null;
  if (subI !== null) {
    const sp = parseBRL(tail[subI], { groupingKnown: true });
    subCents = sp.cents;
  }
  return { quantity: milli / 1000, description: desc, unitPriceRaw: tail[unitI], unitPriceCents: up.cents, printedSubtotalRaw: subI !== null ? tail[subI] : null, printedSubtotalCents: subCents };
}

const TOTAL_RE = /^(total|tot\.?|合计|总计|soma)[:：]?$/i;
const DATE_RE = /\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})\b/;

/** 把 OCR 词框转成与视觉模型相同的协议输出 */
export function wordsToModelOutput(words: Word[], imgW: number, imgH: number): ModelOutput {
  const lines = groupLines(words);
  const items: ModelItem[] = [];
  const unparsed: string[] = [];
  let printedTotalRaw: string | null = null;
  let dateRaw: string | null = null;
  let dateConf = 0;
  let orderRaw: string | null = null;
  let orderConf = 0;
  const headerLines: Line[] = [];
  for (const l of lines) {
    const texts = l.words.map((w) => w.text);
    const text = lineText(l);
    const conf = Math.min(...l.words.map((w) => w.confidence)) / 100;
    const bbox: BBox = [l.x0 / imgW, l.y0 / imgH, (l.x1 - l.x0) / imgW, (l.y1 - l.y0) / imgH];
    const dm = text.match(DATE_RE);
    if (dm && !dateRaw) {
      dateRaw = dm[0];
      dateConf = conf;
    }
    const ti = texts.findIndex((x) => TOTAL_RE.test(x.replace(/[:：]$/, '')));
    if (ti >= 0) {
      const after = texts.slice(ti + 1).find((x) => MONEY_RE.test(x));
      if (after) printedTotalRaw = after;
      else unparsed.push(text);
      continue;
    }
    const om = text.match(/(?:n[º°o]\.?|pedido|订单|no\.?)\s*[:#]?\s*([0-9]{2,})/i);
    if (om && !orderRaw) {
      orderRaw = om[1];
      orderConf = conf;
      continue;
    }
    const row = parseItemLine(texts);
    if (row) {
      items.push({ row: items.length + 1, ...row, confidence: conf, needsReview: conf < 0.85, bbox });
    } else if (hasManyNumbers(text) && !dm) {
      unparsed.push(text);
    } else if (!items.length) {
      headerLines.push(l);
    }
  }
  const merchantLine = headerLines.find((l) => /[A-Za-z一-鿿]{2,}/.test(lineText(l)) && !DATE_RE.test(lineText(l)));
  return {
    merchant: { value: merchantLine ? lineText(merchantLine) : null, confidence: merchantLine ? Math.min(...merchantLine.words.map((w) => w.confidence)) / 100 * 0.6 : 0, candidates: headerLines.slice(0, 3).map(lineText) },
    orderNumber: { value: orderRaw, confidence: orderConf },
    billDate: { raw: dateRaw, iso: null, confidence: dateConf },
    items,
    printedTotalRaw,
    printedTotalCents: null,
    unparsedLines: unparsed,
    warnings: ['本地 OCR 对手写字识别能力有限，所有字段请逐一核对'],
  };
}
