/** 用浏览器自带的扫码能力（安卓 Chrome 等）从单据照片里读条码和二维码；不支持时返回空 */
export async function detectCodes(src: HTMLCanvasElement): Promise<string[]> {
  try {
    if (typeof window === 'undefined' || !('BarcodeDetector' in window)) return [];
    const BD = (window as any).BarcodeDetector;
    const det = new BD({ formats: ['qr_code', 'itf', 'code_128'] });
    const found = new Set<string>();
    // 原图 + 缩小版各试一次（大图里的细条码有时缩小后更好认）
    const tries: CanvasImageSource[] = [src];
    if (Math.max(src.width, src.height) > 1600) {
      const k = 1600 / Math.max(src.width, src.height);
      const c = document.createElement('canvas');
      c.width = Math.round(src.width * k);
      c.height = Math.round(src.height * k);
      c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
      tries.push(c);
    }
    for (const t of tries) {
      for (const r of (await det.detect(t)) as { rawValue: string }[]) if (r.rawValue) found.add(r.rawValue);
      if (found.size) break;
    }
    return [...found];
  } catch {
    return [];
  }
}
