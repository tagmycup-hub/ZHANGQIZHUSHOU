/** 画布图像处理：解码、旋转、透视矫正、增强（浏览器端） */
import { homography, warpSize, type Pt } from './geometry';

export const ACCEPT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_PIXELS = 40_000_000;
/** 处理时的工作分辨率上限（长边），足够保留手写数字 */
export const WORK_MAX_SIDE = 3000;

export class ImageError extends Error {}

export async function decodeImage(file: File | Blob): Promise<HTMLCanvasElement> {
  const type = file.type || '';
  if (type && !ACCEPT_TYPES.includes(type)) throw new ImageError(`不支持的图片类型：${type}。请使用 JPG、PNG 或 WebP`);
  if (file.size > MAX_FILE_BYTES) throw new ImageError(`图片过大（${(file.size / 1048576).toFixed(1)} MB），上限 25 MB`);
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  } catch {
    if (/heic|heif/.test(type) || /\.hei[cf]$/i.test((file as File).name ?? '')) {
      throw new ImageError('此浏览器无法解码 HEIC 图片。请在手机相机设置中改为「兼容性最佳」(JPG)，或先截图再上传');
    }
    throw new ImageError('图片无法解码，文件可能已损坏');
  }
  if (bmp.width * bmp.height > MAX_PIXELS) {
    bmp.close();
    throw new ImageError('图片像素过多（上限 4000 万像素）');
  }
  const s = Math.min(1, WORK_MAX_SIDE / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c;
}

/** 任意角度旋转（度），画布自动扩展，背景填白 */
export function rotateCanvas(src: HTMLCanvasElement, deg: number): HTMLCanvasElement {
  const r = (deg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(r));
  const sin = Math.abs(Math.sin(r));
  const w = Math.round(src.width * cos + src.height * sin);
  const h = Math.round(src.width * sin + src.height * cos);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2, h / 2);
  ctx.rotate(r);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

/** 透视矫正：反向映射 + 双线性插值 */
export function warpQuad(src: HTMLCanvasElement, quad: Pt[], maxSide = 2400): HTMLCanvasElement {
  const { w, h } = warpSize(quad, maxSide);
  const H = homography([{ x: 0, y: 0 }, { x: w - 1, y: 0 }, { x: w - 1, y: h - 1 }, { x: 0, y: h - 1 }], quad);
  const sctx = src.getContext('2d')!;
  const sd = sctx.getImageData(0, 0, src.width, src.height).data;
  const SW = src.width;
  const SH = src.height;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d')!;
  const img = octx.createImageData(w, h);
  const od = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const den = H[6] * x + H[7] * y + H[8];
      const sx = (H[0] * x + H[1] * y + H[2]) / den;
      const sy = (H[3] * x + H[4] * y + H[5]) / den;
      const o = (y * w + x) * 4;
      if (sx < 0 || sy < 0 || sx > SW - 1 || sy > SH - 1) {
        od[o] = od[o + 1] = od[o + 2] = 255;
        od[o + 3] = 255;
        continue;
      }
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(x0 + 1, SW - 1);
      const y1 = Math.min(y0 + 1, SH - 1);
      const fx = sx - x0;
      const fy = sy - y0;
      const i00 = (y0 * SW + x0) * 4;
      const i10 = (y0 * SW + x1) * 4;
      const i01 = (y1 * SW + x0) * 4;
      const i11 = (y1 * SW + x1) * 4;
      for (let k = 0; k < 3; k++) {
        const top = sd[i00 + k] * (1 - fx) + sd[i10 + k] * fx;
        const bot = sd[i01 + k] * (1 - fx) + sd[i11 + k] * fx;
        od[o + k] = top * (1 - fy) + bot * fy;
      }
      od[o + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

export type Variant = 'color' | 'gray' | 'binary';
export const VARIANT_LABEL: Record<Variant, string> = { color: '原色矫正版', gray: '灰度增强版', binary: '黑字白底版' };

function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.getContext('2d')!.drawImage(src, 0, 0);
  return c;
}

/** 抑制浅蓝色表格线：只处理"偏蓝且较亮"的像素，深色笔迹（含蓝色圆珠笔）保留 */
function suppressBlue(d: Uint8ClampedArray) {
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (b - r > 35 && b - g > 5 && lum > 120) {
      d[i] = d[i + 1] = d[i + 2] = 255;
    }
  }
}

function toGray(d: Uint8ClampedArray, w: number, h: number): Float32Array {
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; p < g.length; i += 4, p++) g[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return g;
}

export function enhance(src: HTMLCanvasElement, variant: Variant, opts: { suppressBlueLines?: boolean } = {}): HTMLCanvasElement {
  const c = cloneCanvas(src);
  if (variant === 'color' && !opts.suppressBlueLines) return c;
  const ctx = c.getContext('2d')!;
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const { width: w, height: h } = c;
  if (opts.suppressBlueLines) suppressBlue(d);
  if (variant === 'color') {
    ctx.putImageData(img, 0, 0);
    return c;
  }
  const g = toGray(d, w, h);
  if (variant === 'gray') {
    // 1%–99% 直方图拉伸
    const hist = new Uint32Array(256);
    for (const v of g) hist[v | 0]++;
    const total = g.length;
    let lo = 0;
    let hi = 255;
    for (let acc = 0, i = 0; i < 256; i++) if ((acc += hist[i]) > total * 0.01) { lo = i; break; }
    for (let acc = 0, i = 255; i >= 0; i--) if ((acc += hist[i]) > total * 0.01) { hi = i; break; }
    const span = Math.max(1, hi - lo);
    for (let p = 0, i = 0; p < g.length; p++, i += 4) {
      const v = Math.max(0, Math.min(255, ((g[p] - lo) / span) * 255));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  } else {
    // 自适应阈值（积分图局部均值）
    const W = w + 1;
    const integ = new Float64Array(W * (h + 1));
    for (let y = 1; y <= h; y++) {
      let row = 0;
      for (let x = 1; x <= w; x++) {
        row += g[(y - 1) * w + (x - 1)];
        integ[y * W + x] = integ[(y - 1) * W + x] + row;
      }
    }
    const r = Math.max(8, Math.round(Math.min(w, h) / 40));
    for (let y = 0; y < h; y++) {
      const ya = Math.max(0, y - r);
      const yb = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const xa = Math.max(0, x - r);
        const xb = Math.min(w, x + r + 1);
        const area = (xb - xa) * (yb - ya);
        const sum = integ[yb * W + xb] - integ[ya * W + xb] - integ[yb * W + xa] + integ[ya * W + xa];
        const v = g[y * w + x] < (sum / area) * 0.86 ? 0 : 255;
        const i = (y * w + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function canvasToBlob(c: HTMLCanvasElement, type = 'image/jpeg', quality = 0.9): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new ImageError('图片编码失败'))), type, quality));
}

/** 生成用于识别/存储的图片：长边上限，JPEG */
export async function exportForRecognition(c: HTMLCanvasElement, maxSide = 2000): Promise<Blob> {
  const s = Math.min(1, maxSide / Math.max(c.width, c.height));
  if (s === 1) return canvasToBlob(c, 'image/jpeg', 0.92);
  const t = document.createElement('canvas');
  t.width = Math.round(c.width * s);
  t.height = Math.round(c.height * s);
  const ctx = t.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(c, 0, 0, t.width, t.height);
  return canvasToBlob(t, 'image/jpeg', 0.92);
}
