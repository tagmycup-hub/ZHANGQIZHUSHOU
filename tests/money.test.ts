import { describe, it, expect } from 'vitest';
import { parseBRL, formatBRL, lineSubtotalCents, parseQuantityMilli, sumCents } from '../src/lib/money';

describe('parseBRL 巴西金额', () => {
  it('1.234,56 → 123456', () => expect(parseBRL('1.234,56').cents).toBe(123456));
  it('R$ 1.234,56 → 123456', () => expect(parseBRL('R$ 1.234,56').cents).toBe(123456));
  it('1234,56 → 123456', () => expect(parseBRL('1234,56').cents).toBe(123456));
  it('8 → 800', () => expect(parseBRL('8').cents).toBe(800));
  it('8,5 → 850', () => expect(parseBRL('8,5').cents).toBe(850));
  it('1.234 明确千位 → 123400', () => expect(parseBRL('1.234', { groupingKnown: true }).cents).toBe(123400));
  it('1.234 上下文不足 → 歧义', () => {
    const r = parseBRL('1.234');
    expect(r.ambiguous).toBe(true);
    expect(r.cents).toBeNull();
    expect(r.candidates).toContain(123400);
  });
  it('15.50 小数点写法 → 歧义', () => {
    const r = parseBRL('15.50');
    expect(r.ambiguous).toBe(true);
    expect(r.candidates).toEqual([1550]);
  });
  it('1,234 → 歧义', () => expect(parseBRL('1,234').ambiguous).toBe(true));
  it('拒绝错误分组 12.34,00', () => expect(parseBRL('12.34,00').cents).toBeNull());
  it('拒绝负数与字母', () => {
    expect(parseBRL('-5').cents).toBeNull();
    expect(parseBRL('8O').cents).toBeNull();
  });
  it('拒绝多位小数', () => expect(parseBRL('1,2345').cents).toBeNull());
  it('1.234.567,89', () => expect(parseBRL('1.234.567,89').cents).toBe(123456789));
});

describe('formatBRL', () => {
  it('格式化', () => {
    expect(formatBRL(123456)).toBe('R$ 1.234,56');
    expect(formatBRL(5)).toBe('R$ 0,05');
    expect(formatBRL(-150)).toBe('-R$ 1,50');
    expect(formatBRL(100000000)).toBe('R$ 1.000.000,00');
  });
});

describe('算术（整数分）', () => {
  it('0.1 + 0.2 不出现浮点误差', () => expect(sumCents([10, 20])).toBe(30));
  it('sumCents 拒绝非整数', () => expect(() => sumCents([1.5])).toThrow());
  it('小计 = 数量 × 单价', () => expect(lineSubtotalCents(30, 800)).toBe(24000));
  it('小数数量四舍五入（0.5 分进位）', () => {
    expect(lineSubtotalCents(1.5, 333)).toBe(500); // 499.5 → 500
    expect(lineSubtotalCents(0.333, 100)).toBe(33); // 33.3 → 33
    expect(lineSubtotalCents(2.5, 1)).toBe(3); // 2.5 → 3
  });
  it('数量解析', () => {
    expect(parseQuantityMilli('2,5')).toBe(2500);
    expect(parseQuantityMilli('30')).toBe(30000);
    expect(parseQuantityMilli('0')).toBeNull();
    expect(parseQuantityMilli('1,2345')).toBeNull();
    expect(parseQuantityMilli('abc')).toBeNull();
  });
});
