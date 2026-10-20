/** 页面间传递的临时对象（不持久化） */
import type { Pt } from './lib/image/geometry';

let pendingFile: { file: File; quad?: Pt[] } | null = null;
let pendingCamera = false;

export const setPendingFile = (f: File | null, quad?: Pt[]) => (pendingFile = f ? { file: f, quad } : null);
export const takePendingFile = () => {
  const f = pendingFile;
  pendingFile = null;
  return f;
};
export const setPendingCamera = () => (pendingCamera = true);
export const takePendingCamera = () => {
  const v = pendingCamera;
  pendingCamera = false;
  return v;
};

export interface PendingRecognition {
  state: unknown;
  image: Blob;
  original?: Blob;
}
let pendingRec: PendingRecognition | null = null;
export const setPendingRecognition = (r: PendingRecognition | null) => (pendingRec = r);
export const takePendingRecognition = () => {
  const r = pendingRec;
  pendingRec = null;
  return r;
};
