import { describe, it, expect } from 'vitest';
import { parseLine, findLines, factorToDate, barcodeToLine, mod10 } from '../src/lib/boleto';
import { parsePix, findPix, crc16 } from '../src/lib/pix';

const T = '2026-10-09';

describe('数字线解析', () => {
  it('银行数字线：校验各段，读出金额（旧基准示例）', () => {
    const i = parseLine('00190.50095 40144.816069 06809.350314 3 37370000000100', T)!;
    expect(i.kind).toBe('boleto');
    expect(i.amountCents).toBe(100);
    expect(i.bank).toBe('001');
    expect(i.barcode).toBe('00193373700000001000500940144816060680935031');
  });
  it('数字线里有一位读错就不接受', () => {
    expect(parseLine('00190.50095 40144.816069 06809.350315 3 37370000000100', T)).toBeNull();
  });
  it('到期因子：2025-02-22 起从 1000 重新计数', () => {
    expect(factorToDate(1000, T)).toBe('2025-02-22');
    expect(factorToDate(1601, T)).toBe('2026-10-16');
    expect(factorToDate(3737, '2007-01-01')).toBe('2007-12-31');
    expect(factorToDate(0, T)).toBeNull();
  });
  it('公共缴费：48 位数字线 → 金额与行业', () => {
    const b43 = '83600000000' + '92440048200097626231811205101810011'.slice(0, 32);
    const code = b43.slice(0, 3) + mod10(b43) + b43.slice(3);
    const line = barcodeToLine(code)!;
    const i = parseLine(line, T)!;
    expect(i.kind).toBe('utility');
    expect(i.segment).toBe('energy');
    expect(i.amountCents).toBe(Number(code.slice(4, 15)));
  });
  it('从一段文字里找出数字线', () => {
    const text = 'Banco 001-9   00190.50095 40144.816069 06809.350314 3 37370000000100\nVencimento 31/12/2007';
    expect(findLines(text, T).map((x) => x.amountCents)).toEqual([100]);
  });
});

describe('PIX 复制码', () => {
  const make = (body: string) => body + '6304' + crc16(body + '6304');
  it('静态码：校验 CRC，读出金额和收款方（名称里可以有空格）', () => {
    const code = make('000201' + '26330014br.gov.bcb.pix0111123456789015204000053039865406150.005802BR5913LOJA EXEMPLO 6009SAO PAULO62070503***');
    const p = parsePix(code)!;
    expect(p.valid).toBe(true);
    expect(p.amountCents).toBe(15000);
    expect(p.merchantName).toBe('LOJA EXEMPLO ');
    expect(p.dynamic).toBe(false);
  });
  it('CRC 不对标为无效', () => {
    const code = make('00020126330014br.gov.bcb.pix01111234567890152040000530398654041.005802BR5901X6001Y62070503***');
    expect(parsePix(code.slice(0, -1) + (code.endsWith('0') ? '1' : '0'))!.valid).toBe(false);
  });
  it('动态码（金额在银行服务器）', () => {
    const code = make('00020101021226600014br.gov.bcb.pix2538pix.example.com/api/v2/cobv/abc123def45204000053039865802BR5905BANCO6008Brasilia62070503***');
    const p = findPix(`PIX Copia e Cola:\n   ${code}\n`)[0];
    expect(p.valid).toBe(true);
    expect(p.dynamic).toBe(true);
    expect(p.amountCents).toBeNull();
  });
});

describe('数字线查找不凑数', () => {
  it('分行错位的数字不会被拼成假数字线', () => {
    const text = '001-\n00190.00009 03326.293002 01730.887179 6\n9 15900000030000\n1730887 33.423.888/0001-24';
    for (const l of findLines(text, T)) expect(l.line).not.toBe('10010.02011 73088.717969 91590.000005 9 00000903326293');
  });
  it('标准格式能找到（含 44 位连续条码）', () => {
    const t = 'x 00193373700000001000500940144816060680935031 y';
    expect(findLines(t, T).map((l) => l.amountCents)).toEqual([100]);
  });
});
