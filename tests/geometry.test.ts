import { describe, it, expect } from 'vitest';
import { checkQuad, homography, applyH, warpSize } from '../src/lib/image/geometry';

describe('四角裁切', () => {
  const sq = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  it('合法顺时针凸四边形', () => expect(checkQuad(sq).ok).toBe(true));
  it('拒绝交叉', () => expect(checkQuad([sq[0], sq[2], sq[1], sq[3]]).ok).toBe(false));
  it('拒绝逆时针', () => expect(checkQuad([...sq].reverse()).ok).toBe(false));
  it('拒绝退化', () => expect(checkQuad([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 5, y: 1 }]).ok).toBe(false));
  it('拒绝凹四边形', () => expect(checkQuad([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 30, y: 30 }, { x: 0, y: 100 }]).ok).toBe(false));
});

describe('透视变换', () => {
  it('单应矩阵把四角精确映射', () => {
    const src = [{ x: 10, y: 20 }, { x: 300, y: 5 }, { x: 320, y: 400 }, { x: 0, y: 380 }];
    const dst = [{ x: 0, y: 0 }, { x: 299, y: 0 }, { x: 299, y: 399 }, { x: 0, y: 399 }];
    const H = homography(dst, src);
    dst.forEach((p, i) => {
      const q = applyH(H, p);
      expect(q.x).toBeCloseTo(src[i].x, 6);
      expect(q.y).toBeCloseTo(src[i].y, 6);
    });
  });
  it('输出尺寸受上限约束', () => {
    const s = warpSize([{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 2000 }, { x: 0, y: 2000 }], 2400);
    expect(s).toEqual({ w: 2400, h: 1200 });
  });
});
