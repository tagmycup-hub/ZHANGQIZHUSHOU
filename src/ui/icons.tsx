import type { SVGProps } from 'react';

const P = (d: string) => (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <path d={d} />
  </svg>
);

export const IHome = P('M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z');
export const IList = P('M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01');
export const IPlus = P('M12 5v14M5 12h14');
export const IStore = P('M3 9l1.5-5h15L21 9M3 9v11h18V9M3 9h18M9 20v-6h6v6');
export const ISettings = P('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z');
export const ICamera = P('M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z');
export const IImage = P('M21 15l-5-5L5 21M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z');
export const IEdit = P('M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z');
export const ICheck = P('M20 6L9 17l-5-5');
export const IUndo = P('M3 7v6h6M3 13a9 9 0 1 0 3-7.7L3 8');
export const ITrash = P('M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6');
export const ICal = P('M3 5h18v16H3zM16 3v4M8 3v4M3 10h18');
export const IBell = P('M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0');
export const IDownload = P('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3');
export const IUpload = P('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12');
export const IRotate = P('M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5');
export const ISearch = P('M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3');
export const ICopy = P('M9 9h11v11H9zM5 15H4V4h11v1');
export const IX = P('M18 6L6 18M6 6l12 12');
export const ISpark = P('M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z');
export const IWallet = P('M3 7h18v13H3zM3 7l3-4h12l3 4M16 13h2');
export const IShield = P('M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z');
export const IDatabase = P('M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3zM4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3');
export const IEye = P('M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z');
export const IReceipt = P('M5 2h14v20l-3-2-2 2-2-2-2 2-2-2-3 2zM9 7h6M9 11h6M9 15h4');
export const IBolt = P('M13 2L3 14h8l-1 8 10-12h-8z');
export const IRepeat = P('M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3');
export const ICheckSquare = P('M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11');
export const IFlash = P('M7 2h10l-2 7h4L9 22l2-9H7z');
export const ISwitch = P('M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5');
export const ICloud = P('M17.5 19H7a5 5 0 1 1 1.1-9.9A6 6 0 0 1 19.6 11 4 4 0 0 1 17.5 19z');
export const IChevron = P('M9 18l6-6-6-6');
export const IFilter = P('M3 5h18M6 12h12M10 19h4');
export const ISun = P('M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4');
export const IMoon = P('M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z');
export const IChart = P('M3 21h18M6 17V10M11 17V5M16 17v-4M21 17V8');
export const IScan = P('M3 7V4h3M21 7V4h-3M3 17v3h3M21 17v3h-3M7 8v8M10 8v8M13 8v8M17 8v8');
