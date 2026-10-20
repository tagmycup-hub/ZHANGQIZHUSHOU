import { useEffect, useRef, useState } from 'react';
import type { Pt } from '../lib/image/geometry';
import { IX, IFlash, ISwitch, ICamera, IImage } from './icons';

export const cameraSupported = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

/** 取景框在画面中的归一化位置（留白给纸张边缘） */
const GUIDE = { x: 0.05, y: 0.04, w: 0.9, h: 0.92 };

export interface CaptureResult {
  file: File;
  /** 取景框对应的四角（0–1 归一化坐标，顺时针） */
  quad: Pt[];
}

type CamError = { title: string; detail: string };

function explain(e: any): CamError {
  const n = e?.name ?? '';
  if (n === 'NotAllowedError' || n === 'SecurityError')
    return { title: '没有相机权限', detail: '请在浏览器地址栏的网站设置里允许使用相机后重试；也可以用下方的「系统相机」拍照。' };
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return { title: '没有找到可用的相机', detail: '可以改用「从相册选择」上传已拍好的照片。' };
  if (n === 'NotReadableError') return { title: '相机正被其他应用占用', detail: '关闭其他使用相机的应用后重试。' };
  return { title: '无法打开相机', detail: '当前环境不支持网页相机（例如在其他应用内嵌打开）。请用「系统相机」或「从相册选择」。' };
}

/**
 * 应用内相机：实时取景 + 文档取景框 + 闪光灯 + 前后摄像头切换。
 * 拍照后先预览，确认后返回原始分辨率图片与取景框四角（作为默认裁切）。
 */
export function CameraSheet({ onCapture, onClose, onFallbackFile }: { onCapture: (r: CaptureResult) => void; onClose: () => void; onFallbackFile: (f: File) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const [err, setErr] = useState<CamError | null>(null);
  const [ready, setReady] = useState(false);
  const [torch, setTorch] = useState<boolean | null>(null);
  const [multi, setMulti] = useState(false);
  const [shot, setShot] = useState<{ url: string; blob: Blob; w: number; h: number } | null>(null);
  const [aspect, setAspect] = useState(3 / 4);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setReady(false);
      setErr(null);
      stream.current?.getTracks().forEach((t) => t.stop());
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: facing }, width: { ideal: 3840 }, height: { ideal: 2160 } },
        });
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream.current = s;
        const v = video.current!;
        v.srcObject = s;
        await v.play().catch(() => {});
        const track = s.getVideoTracks()[0];
        const caps: any = track.getCapabilities?.() ?? {};
        setTorch(caps.torch ? false : null);
        const devs = await navigator.mediaDevices.enumerateDevices().catch(() => []);
        setMulti(devs.filter((d) => d.kind === 'videoinput').length > 1);
      } catch (e) {
        if (!cancelled) setErr(explain(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [facing]);

  useEffect(
    () => () => {
      stream.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggleTorch = async () => {
    const track = stream.current?.getVideoTracks()[0];
    if (!track || torch === null) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torch } as any] });
      setTorch(!torch);
    } catch {
      setTorch(null);
    }
  };

  const take = async () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.95));
    if (!blob) return;
    if ('vibrate' in navigator) navigator.vibrate?.(30);
    setShot({ url: URL.createObjectURL(blob), blob, w: c.width, h: c.height });
  };

  const use = () => {
    if (!shot) return;
    const x0 = GUIDE.x;
    const y0 = GUIDE.y;
    const x1 = GUIDE.x + GUIDE.w;
    const y1 = GUIDE.y + GUIDE.h;
    const file = new File([shot.blob], `camera-${Date.now()}.jpg`, { type: 'image/jpeg' });
    URL.revokeObjectURL(shot.url);
    stream.current?.getTracks().forEach((t) => t.stop());
    onCapture({ file, quad: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] });
  };

  const fileInput = (capture: boolean, label: string, icon: React.ReactNode) => (
    <label className="btn cam-alt">
      {icon}
      {label}
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
        {...(capture ? { capture: 'environment' } : {})}
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) {
            stream.current?.getTracks().forEach((t) => t.stop());
            onFallbackFile(f);
          }
        }}
      />
    </label>
  );

  return (
    <div className="cam" role="dialog" aria-modal="true" aria-label="拍摄单据">
      <div className="cam-top">
        <button className="cam-btn" aria-label="关闭相机" onClick={onClose}>
          <IX />
        </button>
        <span className="cam-title">把单据放进框里，尽量平整、光线均匀</span>
        {torch !== null && !shot && (
          <button className={`cam-btn${torch ? ' on' : ''}`} aria-label={torch ? '关闭闪光灯' : '打开闪光灯'} aria-pressed={torch} onClick={toggleTorch}>
            <IFlash />
          </button>
        )}
      </div>
      <div className="cam-stage">
        {err ? (
          <div className="cam-err" role="alert">
            <b>{err.title}</b>
            <p>{err.detail}</p>
          </div>
        ) : (
          <div className="cam-frame" style={{ aspectRatio: String(aspect) }}>
            <video
              ref={video}
              playsInline
              muted
              autoPlay
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight);
                setReady(true);
              }}
              style={{ display: shot ? 'none' : 'block' }}
            />
            {shot && <img src={shot.url} alt="刚拍的照片" />}
            {!shot && (
              <div className="cam-guide" style={{ left: `${GUIDE.x * 100}%`, top: `${GUIDE.y * 100}%`, width: `${GUIDE.w * 100}%`, height: `${GUIDE.h * 100}%` }}>
                <i className="tl" />
                <i className="tr" />
                <i className="bl" />
                <i className="br" />
              </div>
            )}
            {!ready && !shot && <div className="cam-loading">正在打开相机…</div>}
          </div>
        )}
      </div>
      <div className="cam-bottom">
        {shot ? (
          <>
            <button
              className="btn cam-alt"
              onClick={() => {
                URL.revokeObjectURL(shot.url);
                setShot(null);
              }}
            >
              重拍
            </button>
            <button className="btn btn-primary btn-lg" onClick={use}>
              使用这张
            </button>
          </>
        ) : (
          <>
            {fileInput(false, '相册', <IImage />)}
            <button className="shutter" aria-label="按下快门" disabled={!ready || !!err} onClick={take}>
              <span />
            </button>
            {multi && !err ? (
              <button className="btn cam-alt" aria-label="切换前后摄像头" onClick={() => setFacing((f) => (f === 'environment' ? 'user' : 'environment'))}>
                <ISwitch />
                切换
              </button>
            ) : (
              fileInput(true, '系统相机', <ICamera />)
            )}
          </>
        )}
      </div>
    </div>
  );
}
