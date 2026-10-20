import { describe, it, expect } from 'vitest';
import { escapeICS, foldLine, buildICS, icsDuration, billUID } from '../src/lib/ics';
import type { Bill } from '../src/lib/types';

const bill: Bill = {
  id: '11111111-2222-4333-8444-555555555555',
  merchantId: 'm1', merchantNameSnapshot: 'Loja; Silva, & Cia\\Ltda', orderNumber: '0258',
  billDate: '2026-09-12', dueDate: '2026-10-12', accountId: 'a1', accountLabelSnapshot: 'PIX Itaú',
  reminderDays: 3, paidAt: null, notes: '第一行\n第二行',
  items: [{ id: 'i1', quantity: 30, description: 'FN-A78', unitPriceCents: 800, subtotalCents: 24000 }],
  totalCents: 24000, ocrReview: null, createdAt: '2026-09-12T10:00:00Z', updatedAt: '2026-09-12T10:00:00Z', schemaVersion: 1,
};

describe('ICS A08', () => {
  it('转义特殊字符', () => {
    expect(escapeICS('a;b,c\\d\ne')).toBe('a\\;b\\,c\\\\d\\ne');
  });
  it('折行不超过 75 字节且不拆字符', () => {
    const long = 'DESCRIPTION:' + '账期'.repeat(60);
    const folded = foldLine(long);
    const enc = new TextEncoder();
    for (const l of folded.split('\r\n')) expect(enc.encode(l).length).toBeLessThanOrEqual(75);
    expect(folded.split('\r\n').map((l, i) => (i ? l.slice(1) : l)).join('')).toBe(long);
  });
  it('时长格式', () => {
    expect(icsDuration(540 - 3 * 1440)).toBe('-P2DT15H');
    expect(icsDuration(540)).toBe('PT9H');
    expect(icsDuration(-1440)).toBe('-P1D');
    expect(icsDuration(0)).toBe('PT0M');
  });
  it('事件内容正确且 UID 稳定', () => {
    const now = new Date('2026-09-15T12:00:00Z');
    const a = buildICS([bill], now);
    const b = buildICS([bill], new Date('2026-09-20T12:00:00Z'));
    const uid = (s: string) => s.match(/UID:(.*)/)![1];
    expect(uid(a)).toBe(billUID(bill));
    expect(uid(a)).toBe(uid(b));
    const unfolded = a.replace(/\r\n /g, '');
    expect(unfolded).toContain('DTSTART;VALUE=DATE:20261012');
    expect(unfolded).toContain('DTEND;VALUE=DATE:20261013');
    expect(unfolded).toContain('Loja\\; Silva\\, & Cia\\\\Ltda');
    expect(unfolded).toContain('R$ 240\\,00');
    expect(unfolded).toContain('PIX Itaú');
    expect(unfolded).toContain('TRIGGER:-P2DT15H');
    expect(unfolded).toContain('TRIGGER:PT9H');
    expect(unfolded).toContain('第一行\\n第二行');
    expect(a.endsWith('\r\n')).toBe(true);
    expect(a.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
  });
});
