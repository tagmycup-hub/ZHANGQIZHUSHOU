import { useEffect, useRef, useState } from 'react';
import { Modal } from './feedback';
import { normalizeScanned } from '../lib/boleto';
import { IImage } from './icons';

type Detector = { detect(src: CanvasImageSource | ImageBitmap): Promise<{ rawValue: string; format: string }[]> };

export const scanSupported = () => typeof window !== 'undefined' && 'BarcodeDetector' in window;

function makeDetector(): Detector | null {
  try {
    const BD = (window as any).BarcodeDetector;
    return new BD({ formats: ['qr_code', 'itf', 'code_128', 'ean_13'] });
  } catch {
    return null;
  }
}

/** 扫 Boleto 条码或 PIX 二维码，返回整理好的付款码 */
export function ScannerSheet({ onResult, onClose }: { onResult: (code: string, kind: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hint, setHint] = useState('把条码横放在框内，或对准 PIX 二维码');
  const done = useRef(false);

  const accept = (raw: string) => {
    const r = normalizeScanned(raw);
    if ('error' in r) {
      setHint(r.error);
      return false;
    }
    done.current = true;
    try {
      navigator.vibrate?.(40);
    } catch {}
    onResult(r.code, r.kind);
    return true;
  };

  useEffect(() => {
    const det = makeDetector();
    if (!det) {
      setErr('这个浏览器不支持扫码');
      return;
    }
    let stream: MediaStream | null = null;
    let timer = 0;
    let cancelled = false;
    (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 } }, audio: false });
        // 相机还没打开就关了弹窗：立刻释放
        if (cancelled || !video.current) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        const v = video.current;
        v.srcObject = stream;
        await v.play();
        const tick = async () => {
          if (done.current || cancelled) return;
          try {
            const codes = await det.detect(v);
            if (cancelled) return;
            for (const c of codes) if (accept(c.rawValue)) return;
          } catch {}
          if (!cancelled) timer = window.setTimeout(tick, 250);
        };
        tick();
      } catch {
        if (!cancelled) setErr('无法打开相机。可以改用「从相册选图」。');
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Modal title="扫码填写付款码" onClose={onClose}>
      {!err && (
        <div className="scanbox">
          <video ref={video} playsInline muted />
          <span className="scanframe" aria-hidden="true" />
        </div>
      )}
      <p className={`small ${err ? 'err' : 'muted'}`} style={{ margin: 0 }} role="status">
        {err ?? hint}
      </p>
      <label className="btn" style={{ alignSelf: 'flex-start' }}>
        <IImage />
        从相册选图
        <input
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            const det = makeDetector();
            if (!f || !det) return;
            try {
              const bmp = await createImageBitmap(f);
              const codes = await det.detect(bmp);
              if (!codes.length) return setHint('图里没找到条码或二维码，换一张清楚些的');
              for (const c of codes) if (accept(c.rawValue)) return;
            } catch {
              setHint('这张图无法识别');
            }
          }}
        />
      </label>
    </Modal>
  );
}
