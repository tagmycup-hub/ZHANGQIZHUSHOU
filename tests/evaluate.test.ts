import { describe, it, expect } from 'vitest';
import { evaluateOne, evaluateHistory, exportTestSet, pct } from '../src/lib/ocr/evaluate';
import type { Bill, Merchant } from '../src/lib/types';
import fixture from './fixtures/ticket-258.model.json';

const merchants: Merchant[] = [{ id: 'm1', name: 'Loja Exemplo', aliases: [], active: true, defaultAccountId: null, createdAt: '', updatedAt: '' }];
const truth = (items: [string, number, number][], extra: Partial<Bill> = {}): Bill =>
  ({ id: 'b1', merchantId: 'm1', merchantNameSnapshot: 'Loja Exemplo', orderNumber: '0258', billDate: '2026-09-10', dueDate: '2026-10-10', accountId: null, accountLabelSnapshot: '', reminderDays: 3, paidAt: null, notes: '', items: items.map(([d, q, u], i) => ({ id: `i${i}`, description: d, quantity: q, unitPriceCents: u, subtotalCents: q * u })), totalCents: items.reduce((s, [, q, u]) => s + q * u, 0), ocrReview: { provider: 'AI', candidate: fixture, warnings: [], acknowledged: [], edits: [], confirmedAt: '2026-09-10T12:00:00Z', confirmedBy: '' }, createdAt: '', updatedAt: '', schemaVersion: 1, ...extra }) as Bill;

describe('识别准确率评测', () => {
  const pred = fixture as any;
  it('完全一致：金额、型号、明细都 100%，没有多出的行', () => {
    const items = pred.items.map((it: any) => [it.description, it.quantity ?? (it.boxes ?? 1) * (it.perBox ?? 1), it.unitPriceCents] as [string, number, number]);
    const r = evaluateOne(truth(items), { ...pred, merchant: { value: 'Loja Exemplo', confidence: 1 } } as any, merchants);
    expect(r.codes).toEqual({ ok: items.length, n: items.length });
    expect(r.lines.ok).toBe(items.length);
    expect(r.extra).toBe(0);
    expect(r.merchant).toBe(true);
  });
  it('型号读错、漏行、多行都能统计出来，并给出说明', () => {
    const r = evaluateOne(truth([['FN-A78', 30, 800], ['ZZ-999', 1, 100]]), { ...pred, items: [{ ...pred.items[0], description: 'FN-A7B' }, ...pred.items.slice(1)] } as any, merchants);
    expect(r.codes.ok).toBe(0);
    expect(r.lines).toEqual({ ok: 1, n: 2 });
    expect(r.extra).toBe(pred.items.length - 1);
    expect(r.problems.join()).toMatch(/型号「FN-A78」读成「FN-A7B」.*漏读一行「ZZ-999」/);
  });
  it('历史评测跳过手工录入和 PDF；导出测试集不含图片', () => {
    const b = truth([['FN-A78', 30, 800]]);
    const manual = { ...truth([['X', 1, 1]]), id: 'b2', ocrReview: { ...b.ocrReview!, provider: '手工对照录入' } };
    const rep = evaluateHistory([b, manual], merchants);
    expect(rep.cases.map((c) => c.billId)).toEqual(['b1']);
    expect(pct(rep.amount)).not.toBeNull();
    const set = exportTestSet([b, manual]);
    expect(set).toHaveLength(1);
    expect(JSON.stringify(set)).not.toMatch(/imageId|base64/);
  });
});
