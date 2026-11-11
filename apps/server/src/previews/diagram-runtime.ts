export interface DiagramTheme {
  dark: boolean;
  foreground: string;
  background: string;
  line: string;
  accent: string;
  fontSize: number;
}

type Renderer = (source: string, theme: DiagramTheme, language: string) => Promise<string>;
const validColor = (value: string | null | undefined) => /^#[0-9a-f]{6}$/i.test(value ?? '') ? value! : undefined;

function readTheme(params?: URLSearchParams): DiagramTheme {
  const css = getComputedStyle(document.documentElement);
  const dark = params ? params.get('scheme') === 'dark' : css.colorScheme === 'dark';
  const color = (name: string, token: string, fallback: string) => validColor(params ? params.get(name) : css.getPropertyValue(token).trim()) ?? fallback;
  return {
    dark,
    foreground: color('color', '--fg', dark ? '#eceef1' : '#121417'),
    background: color('background', '--bg', dark ? '#1d1d20' : '#f5f6f8'),
    line: color('line', '--line', dark ? '#a1a1aa' : '#60666e'),
    accent: color('accent', '--accent', dark ? '#5b8cff' : '#3867f0'),
    fontSize: Math.min(30, Math.max(10, Number(params?.get('fontSize')) || 14)),
  };
}

const cleanCss = (text: string) => text.replace(/@import[^;]*;?/gi, '').replace(/url\(([^)]*)\)/gi, (match, raw: string) => {
  const value = raw.trim().replace(/^(['"])(.*)\1$/, '$2');
  return value.startsWith('#') || /^data:/i.test(value) ? match : 'none';
});
const dataImage = (value: string) => /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i.test(value);
const htmlLabels = new Set(['div', 'span', 'p', 'br', 'b', 'strong', 'em', 'i', 's', 'del', 'u', 'code', 'pre', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'sup', 'sub', 'a', 'img']);

/** Normalize engine output once for both message images and document-embedded diagrams. */
async function renderSvg(render: Renderer, source: string, theme: DiagramTheme, language: string, maxPixels = Infinity): Promise<SVGSVGElement> {
  if (!source.trim() || source.length > 50_000) throw new Error('Invalid diagram size');
  const text = await render(source, theme, language);
  if (text.length > 10_000_000) throw new Error('Diagram exceeds preview limit');
  const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (parsed.querySelector('parsererror') || parsed.documentElement.localName !== 'svg') throw new Error('Invalid diagram output');
  const svg = document.importNode(parsed.documentElement, true) as unknown as SVGSVGElement;
  // D2 Markdown labels use foreignObject. Keep simple text/table markup inside the opaque
  // document, removing active content and resource attributes before it can enter the DOM.
  for (const element of [svg, ...svg.querySelectorAll('*')]) {
    const name = element.localName.toLowerCase();
    const html = element.namespaceURI === 'http://www.w3.org/1999/xhtml';
    if (['script', 'iframe', 'object', 'embed', 'animate', 'animatetransform', 'set'].includes(name)
      || (html && !htmlLabels.has(name))) { element.remove(); continue; }
    for (const attribute of [...element.attributes]) {
      const attributeName = attribute.localName.toLowerCase();
      const value = attribute.value.trim();
      if (attributeName.startsWith('on') || attributeName === 'srcset'
        || (attributeName === 'src' && !dataImage(value))
        || (attributeName === 'href' && !value.startsWith('#') && !dataImage(value))
        || (/url\s*\(/i.test(value) && !/^url\(\s*['"]?#[\w:.-]+['"]?\s*\)$/i.test(value) && attributeName !== 'style')) element.removeAttributeNode(attribute);
    }
    if (name === 'style') element.textContent = cleanCss(element.textContent ?? '');
    if (element.hasAttribute('style')) element.setAttribute('style', cleanCss(element.getAttribute('style')!));
  }
  const box = svg.viewBox.baseVal;
  const width = box?.width || Number.parseFloat(svg.getAttribute('width') ?? '');
  const height = box?.height || Number.parseFloat(svg.getAttribute('height') ?? '');
  if (!(width > 0 && height > 0 && width <= 100_000 && height <= 100_000 && width * height <= maxPixels)) throw new Error('Empty or oversized diagram');
  if (!box?.width) svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.style.removeProperty('max-width');
  svg.style.backgroundColor = theme.background;
  return svg;
}

/** A self-contained engine can enrich a document or serve the existing single-diagram protocol. */
export function runDiagram(render: Renderer, languages: readonly string[]): void {
  const blocks = [...document.querySelectorAll<HTMLElement>('pre > code[class*="language-"]')].flatMap(code => {
    const language = /(?:^|\s)language-([\w-]+)/.exec(code.className)?.[1]?.toLowerCase();
    return language && languages.includes(language) ? [{ code, language }] : [];
  });
  if (blocks.length) {
    const globals = globalThis as typeof globalThis & { __riffetDiagramSlots?: number };
    const theme = readTheme();
    void (async () => {
      for (const { code, language } of blocks) {
        if ((globals.__riffetDiagramSlots ?? 0) >= 8) break;
        globals.__riffetDiagramSlots = (globals.__riffetDiagramSlots ?? 0) + 1;
        try {
          const svg = await renderSvg(render, code.textContent ?? '', theme, language, 2_000_000);
          svg.dataset.riffetDiagram = language;
          svg.style.display = 'block';
          svg.style.margin = '1em 0';
          svg.style.maxWidth = '100%';
          svg.style.height = 'auto';
          code.parentElement?.replaceWith(svg);
        } catch { /* An incomplete or unsupported diagram remains readable as its original source. */ }
      }
    })();
    return;
  }
  const params = new URLSearchParams(location.hash.slice(1));
  const source = params.get('source') ?? '';
  const target = document.getElementById('diagram');
  if (!target) return;
  const report = (status: 'ready' | 'error', svg?: string) => {
    document.documentElement.dataset.riffetMermaid = status;
    const rect = target.getBoundingClientRect();
    if (parent !== window) parent.postMessage({ type: 'riffet-mermaid', id: params.get('id'), status, svg, width: rect.width, height: rect.height }, '*');
  };
  void (async () => {
    const svg = await renderSvg(render, source, readTheme(params), params.get('language') ?? languages[0]!);
    target.replaceChildren(svg);
    await document.fonts.ready;
    report('ready', new XMLSerializer().serializeToString(svg));
  })().catch(() => { target.textContent = source; report('error'); });
}
