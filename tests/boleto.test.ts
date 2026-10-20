import { describe, it, expect } from 'vitest';
import { barcodeToLine, mod10, validBarcode, normalizeScanned, utilityMod11 } from '../src/lib/boleto';

describe('Boleto 条码', () => {
  it('银行 boleto：条码 → linha digitável（Banco do Brasil 文档示例）', () => {
    const code = '00193373700000001000500940144816060680935031';
    expect(validBarcode(code)).toBe(true);
    expect(barcodeToLine(code)).toBe('00190.50095 40144.816069 06809.350314 3 37370000000100');
  });
  it('扫错一位会被校验拦下', () => {
    expect(validBarcode('00193373700000001000500940144816060680935032')).toBe(false);
    expect('error' in normalizeScanned('00193373700000001000500940144816060680935032')).toBe(true);
  });
  it('公共缴费（模 10）：每 11 位一段并带校验位', () => {
    const body = '8260000000' + '1287900097000120260920030000000000'; // 43 位（不含第 4 位校验位）
    const b43 = body.slice(0, 43);
    const dv = mod10(b43);
    const code = b43.slice(0, 3) + dv + b43.slice(3);
    expect(validBarcode(code)).toBe(true);
    const line = barcodeToLine(code)!;
    const parts = line.split(' ');
    expect(parts).toHaveLength(4);
    for (const p of parts) {
      const [blk, d] = p.split('-');
      expect(blk).toHaveLength(11);
      expect(Number(d)).toBe(mod10(blk));
    }
    expect(line.replace(/\D/g, '')).toHaveLength(48);
  });
  it('公共缴费（模 11）的余数规则', () => {
    expect([0, 1].includes(utilityMod11('0'))).toBe(true);
    const b43 = '84800000000' + '12345678901234567890123456789012'.slice(0, 32);
    const code = b43.slice(0, 3) + utilityMod11(b43) + b43.slice(3);
    expect(validBarcode(code)).toBe(true);
  });
  it('PIX 复制码原样保留', () => {
    expect(normalizeScanned('00020126580014br.gov.bcb.pix0136abc')).toEqual({ code: '00020126580014br.gov.bcb.pix0136abc', kind: 'pix' });
  });
});
