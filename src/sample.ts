/** 首次打开时的示例数据（id 以 sample- 开头，可在首页一键清除） */
import type { Bill, Merchant, PaymentAccount } from './lib/types';
import { addDays } from './lib/dates';
import { recompute } from './lib/bill';

export const isSampleId = (id: string) => id.startsWith('sample-');

export function makeSampleData(today: string): { bills: Bill[]; merchants: Merchant[]; accounts: PaymentAccount[] } {
  const now = new Date().toISOString();
  const accounts: PaymentAccount[] = [
    { id: 'sample-acc-pix', label: 'PIX 公司主账户', type: 'pix', owner: '示例公司', bank: 'Itaú', optionalPixHint: '12.345.678/0001-90', active: true, createdAt: now, updatedAt: now },
    { id: 'sample-acc-boleto', label: 'Boleto 银行单', type: 'boleto', owner: '示例公司', bank: 'Bradesco', optionalPixHint: '', active: true, createdAt: now, updatedAt: now },
  ];
  const merchants: Merchant[] = [
    { id: 'sample-m-1', color: 0, name: '示例 · Brás 配件批发', aliases: ['BRAS ACESSORIOS'], defaultAccountId: 'sample-acc-pix', active: true, term: { kind: 'days', days: 30 }, createdAt: now, updatedAt: now },
    { id: 'sample-m-2', color: 1, name: '示例 · 25 de Março 包装', aliases: [], defaultAccountId: 'sample-acc-boleto', active: true, createdAt: now, updatedAt: now },
    { id: 'sample-m-3', color: 6, name: '示例 · Bom Retiro 杯具', aliases: [], defaultAccountId: 'sample-acc-pix', active: true, term: { kind: 'installments', days: [30, 60, 90] }, createdAt: now, updatedAt: now },
    { id: 'sample-p-1', color: 2, name: '示例 · Sabesp', aliases: [], defaultAccountId: 'sample-acc-boleto', active: true, type: 'payee', defaultCategory: 'water', recurring: true, term: { kind: 'monthDay', day: 20, monthOffset: 0 }, createdAt: now, updatedAt: now },
    { id: 'sample-p-2', color: 3, name: '示例 · DAS Simples Nacional', aliases: ['DAS'], defaultAccountId: 'sample-acc-pix', active: true, type: 'payee', defaultCategory: 'tax', recurring: true, term: { kind: 'monthDay', day: 20, monthOffset: 1 }, createdAt: now, updatedAt: now },
  ];
  const mk = (n: number, m: Merchant, order: string, billOffset: number, dueOffset: number, items: [number, string, number][], paid = false, reminderDays = 3): Bill =>
    recompute({
      id: `sample-bill-${n}`,
      merchantId: m.id,
      merchantNameSnapshot: m.name,
      orderNumber: order,
      billDate: addDays(today, billOffset),
      dueDate: addDays(today, dueOffset),
      accountId: m.defaultAccountId,
      accountLabelSnapshot: accounts.find((a) => a.id === m.defaultAccountId)!.label,
      reminderDays,
      paidAt: paid ? now : null,
      notes: '示例数据',
      items: items.map(([q, d, u], i) => ({ id: `s${n}-${i}`, quantity: q, description: d, unitPriceCents: u, subtotalCents: 0 })),
      totalCents: 0,
      ocrReview: null,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });
  const bills = [
    mk(1, merchants[0], '0231', -35, -3, [[20, 'FN-B12', 750], [10, 'CA22-5', 1400]]),
    mk(2, merchants[1], '1187', -20, 1, [[3, 'Caixa 20x20', 4590], [1, 'Fita adesiva', 1290]]),
    { ...mk(3, merchants[0], '0264', -12, 5, [[12, 'KH-1695', 1850], [6, 'FN-B20', 990], [4, 'CA40-1', 2200], [2, 'Cabo USB-C', 1450]]), payments: [{ id: 'sample-pay-1', date: addDays(today, -2), cents: 15000, note: '定金' }] },
    mk(4, merchants[2], '77', -4, 26, [[48, 'Garrafa 750ml', 2150], [24, 'Tampa inox', 390]], false, 5),
    mk(5, merchants[1], '1150', -40, -10, [[2, 'Plástico bolha', 8900]], true),
  ];
  const exp = (n: number, m: Merchant, cat: string, billOffset: number, dueOffset: number, cents: number, extra: Partial<Bill> = {}): Bill => ({
    ...mk(n, m, '', billOffset, dueOffset, [[1, '整单金额（未列明细）', cents]]),
    amountMode: 'total',
    kind: 'expense',
    category: cat,
    recurrence: { freq: 'monthly', seriesId: `sample-series-${n}` },
    notes: '示例数据',
    ...extra,
  });
  bills.push(
    exp(6, merchants[3], 'water', -6, 4, 18790, { paymentCode: '82600000001-2 87900097000-1 01202609200-3 00000000000-0' }),
    exp(7, merchants[4], 'tax', -10, 12, 76120),
  );
  // 过去几个月已付的账单，让「每月流水」有内容可看
  const paidOn = (off: number) => new Date(Date.parse(addDays(today, off) + 'T15:00:00Z')).toISOString();
  const hist: [number, Merchant, number, number, number, 'supplier' | 'water' | 'tax'][] = [
    [8, merchants[0], -62, -32, 98400, 'supplier'],
    [9, merchants[2], -75, -45, 154000, 'supplier'],
    [10, merchants[1], -95, -65, 41200, 'supplier'],
    [11, merchants[0], -120, -90, 132500, 'supplier'],
    [12, merchants[2], -150, -118, 87600, 'supplier'],
    [13, merchants[3], -40, -26, 17950, 'water'],
    [14, merchants[3], -70, -56, 16820, 'water'],
    [15, merchants[4], -45, -33, 71300, 'tax'],
    [16, merchants[4], -76, -64, 68900, 'tax'],
  ];
  for (const [n, m, bo, dOff, cents, cat] of hist) {
    const base = cat === 'supplier' ? mk(n, m, String(900 + n), bo, dOff, [[1, '整单金额（未列明细）', cents]]) : exp(n, m, cat, bo, dOff, cents, { recurrence: null });
    bills.push({ ...base, amountMode: 'total', paidAt: paidOn(dOff - (n % 3)) });
  }
  return { bills, merchants, accounts };
}
