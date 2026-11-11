import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

declare const __RIFFET_PDF_WORKER__: string;

type PreviewData = {
  data: string;
  name: string;
  theme: { foreground: string; background: string; line: string; accent: string; dark: boolean };
  assets?: { cmaps?: Record<string, string>; standardFonts?: Record<string, string> };
};

const MAX_PAGES = 200;
const MAX_PIXELS = 4_000_000;
const MAX_DIMENSION = 4096;

function bytes(encoded: string): Uint8Array {
  return Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
}

async function main() {
  const input = document.getElementById('riffet-preview-data');
  if (!input?.textContent) throw new Error('缺少 PDF 内容');
  const payload = JSON.parse(input.textContent) as PreviewData;
  input.remove();
  const root = document.getElementById('preview') ?? document.createElement('main');
  root.id = 'pdf-preview';
  if (!root.isConnected) document.body.append(root);
  const style = document.createElement('style');
  style.textContent = `
    html,body{margin:0;min-height:100%;font:14px system-ui,sans-serif}
    #pdf-preview{padding:12px;box-sizing:border-box}
    #pdf-preview>header{position:sticky;top:0;z-index:2;padding:8px 0;font-variant-numeric:tabular-nums}
    .riffet-pdf-page{position:relative;margin:12px auto;background:white;color:#222;box-shadow:0 1px 5px #0002;overflow:hidden;max-width:100%}
    .riffet-pdf-page canvas{display:block;width:100%;height:100%}
    .riffet-pdf-label{position:absolute;inset:8px auto auto 8px;font:12px system-ui}
    .textLayer{position:absolute;inset:0;overflow:clip;line-height:1;letter-spacing:normal;word-spacing:normal;text-align:initial;text-size-adjust:none;forced-color-adjust:none;transform-origin:0 0;--scale-round-x:1px;--scale-round-y:1px;--min-font-size:1;--text-scale-factor:calc(var(--total-scale-factor) * var(--min-font-size));--min-font-size-inv:calc(1 / var(--min-font-size))}
    .textLayer :is(span,br){color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0% 0%;user-select:text;-webkit-user-select:text}
    .textLayer>:not(.markedContent),.textLayer .markedContent span:not(.markedContent){z-index:1;--font-height:0;font-size:calc(var(--text-scale-factor) * var(--font-height));--scale-x:1;--rotate:0deg;transform:rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv))}
    .textLayer .markedContent{display:contents}.textLayer ::selection{background:#357adf66}
    .textLayer[data-main-rotation="90"]{transform:rotate(90deg) translateY(-100%)}
    .textLayer[data-main-rotation="180"]{transform:rotate(180deg) translate(-100%,-100%)}
    .textLayer[data-main-rotation="270"]{transform:rotate(270deg) translateX(-100%)}
  `;
  document.head.append(style);
  document.body.style.background = payload.theme.background;
  document.body.style.color = payload.theme.foreground;
  const status = document.createElement('header');
  status.style.background = payload.theme.background;
  status.textContent = payload.name;
  root.append(status);
  const workerURL = URL.createObjectURL(new Blob([__RIFFET_PDF_WORKER__], { type: 'text/javascript' }));
  const worker = new Worker(workerURL, { type: 'module' });
  GlobalWorkerOptions.workerPort = worker;
  class EmbeddedBinaryDataFactory {
    async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
      const data = kind === 'cMapUrl' ? payload.assets?.cmaps?.[filename] : kind === 'standardFontDataUrl' ? payload.assets?.standardFonts?.[filename] : undefined;
      if (!data) throw new Error(`缺少内嵌 PDF 字体资源：${filename}`);
      return bytes(data);
    }
  }
  const options = {
    data: bytes(payload.data), useWorkerFetch: false, BinaryDataFactory: EmbeddedBinaryDataFactory,
    isEvalSupported: false, useWasm: false, useSystemFonts: true, disableFontFace: false,
    cMapPacked: true, cMapUrl: 'embedded:/', standardFontDataUrl: 'embedded:/',
    maxImageSize: 16_000_000, canvasMaxAreaInBytes: MAX_PIXELS * 4, enableXfa: false,
    isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
  };
  payload.data = '';
  const loading = getDocument(options);
  let locked = false;
  loading.onPassword = () => { locked = true; status.textContent = '此 PDF 需要密码，请下载后打开'; void loading.destroy(); };
  let pdf: PDFDocumentProxy;
  try { pdf = await loading.promise; }
  catch (error) { worker.terminate(); URL.revokeObjectURL(workerURL); if (locked) return; throw error; }
  const count = Math.min(pdf.numPages, MAX_PAGES);
  status.textContent = pdf.numPages > MAX_PAGES ? `${pdf.numPages} 页 · 预览前 ${MAX_PAGES} 页` : `${pdf.numPages} 页`;
  const first = await pdf.getPage(1);
  const firstViewport = first.getViewport({ scale: 1 });
  const ratio = firstViewport.height / firstViewport.width;
  first.cleanup();
  type PageState = { index: number; node: HTMLElement; visible: boolean; rendered: boolean; generation: number; dispose?: () => void };
  const pages: PageState[] = [];
  let chain = Promise.resolve();
  const width = () => Math.max(120, Math.min(root.clientWidth - 24, 1200));
  async function render(state: PageState) {
    if (!state.visible || state.rendered) return;
    state.rendered = true;
    const generation = ++state.generation;
    let page: PDFPageProxy | undefined;
    try {
      page = await pdf.getPage(state.index);
      if (!state.visible || generation !== state.generation) { page.cleanup(); return; }
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(width() / base.width, MAX_DIMENSION / Math.max(base.width, base.height), Math.sqrt(MAX_PIXELS / (base.width * base.height)));
      const viewport = page.getViewport({ scale });
      const pixelRatio = Math.min(devicePixelRatio || 1, 2, MAX_DIMENSION / Math.max(viewport.width, viewport.height), Math.sqrt(MAX_PIXELS / (viewport.width * viewport.height)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width * pixelRatio));
      canvas.height = Math.max(1, Math.floor(viewport.height * pixelRatio));
      state.node.style.width = `${viewport.width}px`;
      state.node.style.height = `${viewport.height}px`;
      state.node.replaceChildren(canvas);
      const task = page.render({ canvas, viewport, transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0] });
      let text: TextLayer | undefined;
      state.dispose = () => { task.cancel(); text?.cancel(); canvas.width = 0; canvas.height = 0; page?.cleanup(); };
      await task.promise;
      if (!state.visible || generation !== state.generation) return;
      const textContainer = document.createElement('div');
      textContainer.className = 'textLayer';
      textContainer.style.setProperty('--total-scale-factor', `${scale * viewport.userUnit}`);
      state.node.append(textContainer);
      text = new TextLayer({ container: textContainer, viewport, textContentSource: page.streamTextContent({ includeMarkedContent: true }) });
      await text.render();
    } catch (error) {
      if (generation !== state.generation || !state.visible) return;
      state.node.textContent = error instanceof Error ? `第 ${state.index} 页：${error.message}` : `第 ${state.index} 页无法预览`;
      page?.cleanup();
    }
  }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const state = pages[Number((entry.target as HTMLElement).dataset.page) - 1];
      if (!state) continue;
      state.visible = entry.isIntersecting;
      if (state.visible) chain = chain.then(() => render(state));
      else {
        state.generation++; state.dispose?.(); state.dispose = undefined; state.rendered = false;
        state.node.replaceChildren();
      }
    }
  }, { rootMargin: '600px' });
  for (let index = 1; index <= count; index++) {
    const node = document.createElement('section');
    node.className = 'riffet-pdf-page'; node.dataset.page = String(index);
    node.setAttribute('aria-label', `第 ${index} 页`);
    node.style.width = `${width()}px`; node.style.height = `${width() * ratio}px`;
    root.append(node);
    pages.push({ index, node, visible: false, rendered: false, generation: 0 });
    observer.observe(node);
  }
  let lastWidth = width();
  new ResizeObserver(() => {
    const nextWidth = width();
    if (Math.abs(nextWidth - lastWidth) < 1) return;
    lastWidth = nextWidth;
    for (const state of pages) {
      state.generation++; state.dispose?.(); state.dispose = undefined; state.rendered = false;
      state.node.replaceChildren(); state.node.style.width = `${nextWidth}px`; state.node.style.height = `${nextWidth * ratio}px`;
      if (state.visible) chain = chain.then(() => render(state));
    }
  }).observe(root);
  addEventListener('pagehide', () => { observer.disconnect(); for (const state of pages) state.dispose?.(); void loading.destroy(); worker.terminate(); URL.revokeObjectURL(workerURL); }, { once: true });
}

void main().catch(error => {
  const failure = document.createElement('p');
  failure.textContent = error instanceof Error ? `PDF 预览失败：${error.message}` : 'PDF 预览失败';
  document.body.append(failure);
});
