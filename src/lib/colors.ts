/**
 * 商家识别色：固定顺序的 7 色（已用色盲模拟校验相邻可区分），红色留给"逾期"状态。
 * 新建商家按顺序分配；旧数据没有颜色时按 id 稳定散列。
 */
export const MERCHANT_COLORS = ['蓝', '橙', '青绿', '黄', '粉', '绿', '紫'] as const;
export const COLOR_COUNT = MERCHANT_COLORS.length;

export function hashSlot(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % COLOR_COUNT;
}

export function colorSlot(m: { id?: string; color?: number | null } | null | undefined, fallbackKey = ''): number {
  if (m && typeof m.color === 'number' && m.color >= 0 && m.color < COLOR_COUNT) return m.color;
  return hashSlot(m?.id ?? fallbackKey);
}

/** 新商家用哪一色：取当前用得最少的颜色（同样少时按固定顺序） */
export function nextSlot(existing: { color?: number | null; id?: string }[]): number {
  const n = new Array(COLOR_COUNT).fill(0);
  for (const m of existing) n[colorSlot(m)]++;
  let best = 0;
  for (let i = 1; i < COLOR_COUNT; i++) if (n[i] < n[best]) best = i;
  return best;
}
