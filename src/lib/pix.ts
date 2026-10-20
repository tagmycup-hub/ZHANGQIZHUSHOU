/** PIX「复制码」（BR Code / EMV）解析：校验 CRC，读出金额与收款方 */

export function crc16(s: string): string {
  let crc = 0xffff;
  for (let i = 0; i < s.length; i++) {
    crc ^= s.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function tlv(s: string): Map<string, string> | null {
  const m = new Map<string, string>();
  let i = 0;
  while (i < s.length) {
    const id = s.slice(i, i + 2);
    const len = Number(s.slice(i + 2, i + 4));
    if (!/^\d{2}$/.test(id) || !Number.isInteger(len) || i + 4 + len > s.length) return null;
    m.set(id, s.slice(i + 4, i + 4 + len));
    i += 4 + len;
  }
  return m;
}

export interface PixInfo {
  code: string;
  valid: boolean;
  amountCents: number | null;
  merchantName: string | null;
  city: string | null;
  /** 动态码（金额在银行服务器上，码里没有） */
  dynamic: boolean;
}

export function parsePix(raw: string): PixInfo | null {
  const code = raw.replace(/[\r\n\t]/g, '').trim();
  if (!/^000201/.test(code) || !/br\.gov\.bcb\.pix/i.test(code)) return null;
  const body = code.slice(0, -4);
  const valid = code.slice(-8, -4) === '6304' && crc16(body) === code.slice(-4).toUpperCase();
  const t = tlv(code);
  const amt = t?.get('54');
  const acct = t?.get('26') ?? '';
  const sub = tlv(acct);
  return {
    code,
    valid,
    amountCents: amt && /^\d+(\.\d{1,2})?$/.test(amt) ? Math.round(Number(amt) * 100) : null,
    merchantName: t?.get('59') ?? null,
    city: t?.get('60') ?? null,
    dynamic: !!sub?.get('25'),
  };
}

/** 文字里找 PIX 复制码（逐行找；收款方名称里可以有空格） */
export function findPix(text: string): PixInfo[] {
  const out: PixInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    for (const m of line.match(/000201.*?6304[0-9A-Fa-f]{4}/g) ?? []) {
      const p = parsePix(m);
      if (p) out.push(p);
    }
  }
  return out;
}
