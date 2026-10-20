import { describe, it, expect } from 'vitest';
import { easter, holidaysOf, nextBusinessDay, nonBusinessReason } from '../src/lib/holidays';

describe('巴西节假日与工作日', () => {
  it('复活节与移动节日', () => {
    expect(easter(2026)).toBe('2026-04-05');
    expect(easter(2027)).toBe('2027-03-28');
    const h = holidaysOf(2026);
    expect(h.get('2026-02-16')).toBe('狂欢节');
    expect(h.get('2026-02-17')).toBe('狂欢节');
    expect(h.get('2026-04-03')).toBe('耶稣受难日');
    expect(h.get('2026-06-04')).toBe('基督圣体节');
    expect(h.get('2026-11-20')).toBe('黑人意识日');
  });
  it('周末与节日顺延到下一个工作日', () => {
    expect(nonBusinessReason('2026-10-10')).toBe('周六');
    expect(nextBusinessDay('2026-10-10')).toBe('2026-10-13'); // 周六 → 周一 12/10 是节日 → 周二
    expect(nextBusinessDay('2026-12-25')).toBe('2026-12-28');
    expect(nextBusinessDay('2026-10-14')).toBe('2026-10-14');
    expect(nonBusinessReason('2026-10-14')).toBeNull();
  });
});
