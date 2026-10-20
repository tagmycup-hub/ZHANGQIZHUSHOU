/** 纯几何：四边形校验与透视变换（单应矩阵） */
export interface Pt {
  x: number;
  y: number;
}

function cross(o: Pt, a: Pt, b: Pt) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function segmentsIntersect(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

export function polygonArea(q: Pt[]): number {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const p = q[i];
    const n = q[(i + 1) % q.length];
    a += p.x * n.y - n.x * p.y;
  }
  return a / 2;
}

export interface QuadCheck {
  ok: boolean;
  error?: string;
}

/**
 * 四角顺序：左上、右上、右下、左下（屏幕坐标下为顺时针）。
 * 拒绝交叉、退化（面积过小）、凹四边形与逆时针顺序。
 */
export function checkQuad(q: Pt[], minArea = 400): QuadCheck {
  if (q.length !== 4) return { ok: false, error: '需要 4 个角点' };
  if (segmentsIntersect(q[0], q[1], q[2], q[3]) || segmentsIntersect(q[1], q[2], q[3], q[0])) return { ok: false, error: '四边形边线交叉，请调整角点顺序' };
  const area = polygonArea(q);
  if (area <= 0) return { ok: false, error: '角点应按 左上→右上→右下→左下 顺时针放置' };
  if (area < minArea) return { ok: false, error: '裁切区域太小' };
  const signs = q.map((_, i) => Math.sign(cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4])));
  if (signs.some((s) => s <= 0)) return { ok: false, error: '四边形必须是凸的（不能有凹角或三点共线）' };
  return { ok: true };
}

/** 求解把 src 四点映射到 dst 四点的 3x3 单应矩阵（按行展开，h33 = 1） */
export function homography(src: Pt[], dst: Pt[]): number[] {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(A, b);
  return [...h, 1];
}

function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) throw new Error('四边形退化，无法矫正');
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function applyH(h: number[], p: Pt): Pt {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w };
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** 输出尺寸：取对边较长者，按上限等比缩放 */
export function warpSize(q: Pt[], maxSide = 2400): { w: number; h: number } {
  let w = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
  let h = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const s = Math.min(1, maxSide / Math.max(w, h));
  w = Math.max(1, Math.round(w * s));
  h = Math.max(1, Math.round(h * s));
  return { w, h };
}
