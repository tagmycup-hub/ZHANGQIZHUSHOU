/** PDF 单据：渲染第一页为图片，并读取文字层（银行 PDF 通常可以直接读出数字线、金额和日期） */

export interface PdfResult {
  canvas: HTMLCanvasElement;
  text: string;
  pages: number;
}

export const isPdf = (f: File | Blob) => f.type === 'application/pdf' || ('name' in f && /\.pdf$/i.test((f as File).name));

let lib: Promise<typeof import('pdfjs-dist')> | null = null;
async function pdfjs() {
  if (!lib) {
    lib = (async () => {
      // 解析器直接在页面里运行（不另开 worker 文件），任何静态托管和单文件版都能用
      const [m, w] = await Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.min.mjs')]);
      (globalThis as any).pdfjsWorker = w;
      return m as unknown as typeof import('pdfjs-dist');
    })();
  }
  return lib;
}

/** 按行拼接文字（同一行的文字块按 x 排序），便于找数字线和「Vencimento 16/10/2026」 */
function joinLines(items: { str: string; transform: number[] }[]): string {
  const rows = new Map<number, { x: number; s: string }[]>();
  for (const it of items) {
    if (!it.str.trim()) continue;
    const y = Math.round(it.transform[5] / 3);
    const r = rows.get(y) ?? [];
    r.push({ x: it.transform[4], s: it.str });
    rows.set(y, r);
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, r]) => r.sort((a, b) => a.x - b.x).map((x) => x.s).join(' '))
    .join('\n');
}

export async function readPdf(file: Blob, maxSide = 2200): Promise<PdfResult> {
  const m = await pdfjs();
  const doc = await m.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  try {
    const texts: string[] = [];
    for (let i = 1; i <= Math.min(doc.numPages, 3); i++) {
      const p = await doc.getPage(i);
      const tc = await p.getTextContent();
      texts.push(joinLines(tc.items as any));
    }
    const page = await doc.getPage(1);
    const v1 = page.getViewport({ scale: 1 });
    const scale = Math.min(4, maxSide / Math.max(v1.width, v1.height));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return { canvas, text: texts.join('\n\n'), pages: doc.numPages };
  } finally {
    void doc.destroy();
  }
}
