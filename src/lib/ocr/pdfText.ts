/**
 * 不用 AI：直接从 PDF 文字层读出常见缴费单的关键字段（Boleto、FGTS/DAS 等政府缴费单、工资单、水电账单）。
 * 读不到的字段留空让人填；数字线 / PIX 由 enrich 校验。
 */
import { normalizeModelOutput, type ModelOutput, type DocType } from './protocol';
import { parseBRL } from '../money';
import { parseBRDate } from '../dates';
import { findLines } from '../boleto';
import { findPix } from '../pix';

const MONEY = /(?:R\$\s*)?(\d{1,3}(?:\.\d{3})*,\d{2})(?!\d)/;
const DATE = /(\d{2}\/\d{2}\/\d{4})/;

/** 在标签之后（同一行或下面几行）找第一个匹配 */
function after(text: string, labels: RegExp, pattern: RegExp, span = 400): string | null {
  const re = new RegExp(labels.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const tail = text.slice(m.index + m[0].length, m.index + m[0].length + span);
    const v = tail.match(pattern);
    if (v) return v[1];
  }
  return null;
}

function lineAfter(text: string, label: RegExp): string | null {
  const lines = text.split(/\r?\n/);
  const header = /Ag[eê]ncia|C[oó]digo|CPF|CNPJ|Endere[cç]o|Vencimento|Valor|Esp[eé]cie|Carteira|Quantidade|Chapa|Benefici[aá]rio|Cedente|Nome\b/i;
  const clean = (c: string) =>
    c
      .split(/\s{2,}| - (?=\d{2}\.\d{3})|\s\d{3,5}-[\dX]\b|\sR\$|\s\d{2}\.\d{3}\.\d{3}|CNPJ|CPF/)[0]
      .trim();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(label);
    if (!m) continue;
    const rest = lines[i].slice((m.index ?? 0) + m[0].length).replace(/^[\s:\-–]+/, '').trim();
    const cands = [rest, ...lines.slice(i + 1, i + 4).map((l) => l.trim())];
    for (const c of cands) {
      const v = clean(c);
      if (!v || header.test(v.split(/\s+/).slice(0, 2).join(' '))) continue;
      if (/[A-Za-zÀ-ÿ]{3,}/.test(v)) return v.slice(0, 80);
    }
  }
  return null;
}

export function textToModel(text: string, today: string): ModelOutput | null {
  // NFKC：把 "ﬁ" 等连字还原；再把字母间隔排版（"L Í Q U I D O"）合并
  const t = text
    .normalize('NFKC')
    .replace(/\u00a0/g, ' ')
    .replace(/\b(?:[A-ZÀ-Ú] ){2,}[A-ZÀ-Ú]\b/g, (w) => w.replace(/ /g, ''));
  if (t.replace(/\s/g, '').length < 30) return null;
  const lines = findLines(t, today);
  const pix = findPix(t).find((p) => p.valid) ?? null;
  const low = t.toLowerCase();

  let docType: DocType = 'receipt';
  let categoryHint: string | null = null;
  let merchant: string | null = null;
  if (/recibo de pagamento de sal[aá]rio|holerite|contracheque/i.test(t)) {
    docType = 'payslip';
    categoryHint = 'payroll';
    merchant = lineAfter(t, /\bNome\b/i);
    const nm = t.match(/N[ºo°]\s*Reg\.?[^\n]*\n\s*\d+\s+([A-ZÀ-Ú][A-ZÀ-Ú ]{4,60})/);
    if (nm) merchant = nm[1].trim();
  } else if (/fgts/i.test(t) && /guia|gfd|recolher/i.test(t)) {
    docType = 'tax';
    categoryHint = 'payroll';
    merchant = 'FGTS';
  } else if (/documento de arrecada[cç][aã]o do simples|\bDAS\b/.test(t)) {
    docType = 'tax';
    categoryHint = 'tax';
    merchant = 'DAS Simples Nacional';
  } else if (/\bDARF\b/.test(t)) {
    docType = 'tax';
    categoryHint = 'tax';
    merchant = 'DARF';
  } else if (lines[0]?.kind === 'utility' || /total a pagar|conta de (luz|[aá]gua|g[aá]s)/i.test(t)) {
    docType = 'utility';
    const seg = lines[0]?.segment;
    categoryHint = seg === 'water' ? 'water' : seg === 'energy' ? 'electricity' : seg === 'telecom' ? 'internet' : /enel|light|cpfl|cemig|energia/i.test(t) ? 'electricity' : /sabesp|[aá]gua/i.test(t) ? 'water' : /comg[aá]s|g[aá]s/i.test(t) ? 'gas' : null;
  } else if (lines[0]?.kind === 'boleto' || /ficha de compensa[cç][aã]o|benefici[aá]rio/i.test(t)) {
    docType = 'boleto';
    if (/honor[aá]rios cont[aá]beis|contabil/i.test(low)) categoryHint = 'accounting';
    else if (/aluguel/i.test(t)) categoryHint = 'rent';
    else if (/condom[ií]nio/i.test(t)) categoryHint = 'condo';
  }
  if (!merchant && (docType === 'boleto' || docType === 'receipt')) merchant = lineAfter(t, /Benefici[aá]rio(?!\s*final)/i) ?? lineAfter(t, /Cedente/i);
  if (!merchant && docType === 'utility') merchant = /enel/i.test(t) ? 'Enel' : /sabesp/i.test(t) ? 'Sabesp' : /comg[aá]s/i.test(t) ? 'Comgás' : null;

  const dueRaw =
    after(t, /Pagar (?:este documento )?at[eé]/, DATE) ??
    after(t, /Data de vencimento|Vencimento/, DATE) ??
    null;
  const amountRaw =
    (docType === 'payslip' ? after(t, /A ?RECEBER/, MONEY, 120) : null) ??
    after(t, /Valor do Documento|Valor documento|\(=\)\s*Valor do Documento/, MONEY) ??
    after(t, /Total a pagar|Valor a recolher|Total da Guia|Valor total|Total\s*:/, MONEY) ??
    null;
  const ref = t.match(/(?:Compet[eê]ncia|M[eê]s de Refer[eê]ncia|Refer[eê]ncia)[\s:]*\n?\s*([A-Za-zçÇ]+\s*\/\s*\d{4}|\d{2}\/\d{4})/i)?.[1] ?? after(t, /Compet[eê]ncia/, /([A-Za-zç]+\/\d{4}|\d{2}\/\d{4})/, 200);
  const docNo = after(t, /N[uú]mero do documento|N[ºo°]\s*(?:do\s*)?documento/, /\b(\d[\d/.\-]{3,20})\b/, 160);
  const billRaw = after(t, /Data (?:do )?documento|Data de emiss[aã]o|Data de gera[cç][aã]o/, DATE, 160);

  const cents = amountRaw ? parseBRL(amountRaw).cents : null;
  const due = dueRaw ? parseBRDate(dueRaw).iso : null;
  const bill = billRaw ? parseBRDate(billRaw).iso : null;
  if (!cents && !lines.length && !pix && !due) return null;
  return normalizeModelOutput({
    docType,
    merchant: { value: merchant, confidence: merchant ? 0.9 : 0 },
    orderNumber: { value: docNo, confidence: docNo ? 0.9 : 0 },
    billDate: { raw: billRaw, iso: bill, confidence: bill ? 0.95 : 0 },
    dueDate: { raw: dueRaw, iso: due, confidence: due ? 0.95 : 0 },
    amountDue: { raw: amountRaw, cents, confidence: cents ? 0.95 : 0 },
    paymentLine: lines[0]?.line ?? null,
    pixCode: pix?.code ?? null,
    referenceMonth: ref ?? null,
    categoryHint,
    items: [],
    printedTotalRaw: null,
    printedTotalCents: null,
    unparsedLines: [],
    warnings: [],
  });
}
