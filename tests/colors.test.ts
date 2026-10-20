import { describe, it, expect } from 'vitest';
import { colorSlot, hashSlot, nextSlot, COLOR_COUNT } from '../src/lib/colors';

describe('商家识别色', () => {
  it('有颜色用自己的，没有按 id 稳定散列', () => {
    expect(colorSlot({ id: 'a', color: 4 })).toBe(4);
    expect(colorSlot({ id: 'abc' })).toBe(hashSlot('abc'));
    expect(colorSlot({ id: 'x', color: 99 })).toBe(hashSlot('x'));
    expect(hashSlot('whatever')).toBeLessThan(COLOR_COUNT);
  });
  it('新商家取用得最少的颜色，按固定顺序', () => {
    expect(nextSlot([])).toBe(0);
    expect(nextSlot([{ color: 0 }, { color: 1 }])).toBe(2);
    expect(nextSlot([0, 1, 2, 3, 4, 5, 6, 0].map((c) => ({ color: c })))).toBe(1);
  });
});
