declare const __SINGLE__: boolean;
interface Window { claude?: { use(name: string): Promise<any> } }
declare module '*?raw' {
  const content: string;
  export default content;
}
declare module '*.js?raw' {
  const content: string;
  export default content;
}
declare module '*.sql?raw' {
  const content: string;
  export default content;
}
declare module 'pdfjs-dist/legacy/build/pdf.mjs';
declare module 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';
