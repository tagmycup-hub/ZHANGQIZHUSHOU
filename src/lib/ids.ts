export function uuid(): string {
  const c: Crypto | undefined = (globalThis as any).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const nowISO = () => new Date().toISOString();

export function maskHint(v: string): string {
  const s = v.trim();
  if (s.length <= 4) return s ? '•'.repeat(s.length) : '';
  return `${'•'.repeat(Math.min(6, s.length - 4))}${s.slice(-4)}`;
}
