declare module '@plantuml/core' {
  export function renderToString(lines: string[], onSuccess: (svg: string) => void, onError: (message: string) => void, options?: { dark?: boolean; maxSvgSize?: number }): void;
}
declare module '@plantuml/core/themes.js';
declare module '@plantuml/core/emoji.js';
declare module '@plantuml/core/openiconic.js';
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
