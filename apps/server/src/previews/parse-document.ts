import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkCjkFriendlyGfmStrikethrough from 'remark-cjk-friendly-gfm-strikethrough';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import katex from 'katex';
import { randomUUID } from 'node:crypto';
import { DOMParser, type Node as XmlNode, type Element as XmlElement } from '@xmldom/xmldom';
import type { OfficeContentNode, SupportedFileType } from 'officeparser';
import { escapeHtml } from './document.js';
import { decodePreviewText, extensionOf } from './formats.js';
import { structuredTree } from './parse-structured.js';
import type { PreviewFragment, PreviewParseInput } from './parse.js';

const mathOptions = { trust: false, strict: 'ignore' as const, throwOnError: false, maxExpand: 1000, maxSize: 20 };
const imageUrl = (value: string): boolean => /^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/i.test(value);
const attachmentImageUrl = (value: string): boolean => /^attachment:[a-f0-9-]{36}$/i.test(value);
const localImageUrl = (value: string): boolean => value.length > 0 && !/^[a-z][a-z0-9+.-]*:/i.test(value)
  && !/^[\\/]{2}/.test(value) && !/^[#?]/.test(value);
const markdownImageUrl = (value: string): boolean => imageUrl(value) || attachmentImageUrl(value) || localImageUrl(value);
const imageToken = (value: string): boolean => /^riffet-preview-image-[a-f0-9]{32}$/.test(value);
type Root = Parameters<ReturnType<typeof rehypeRaw>>[0];
type Element = Extract<Root['children'][number], { type: 'element' }>;
type Child = Root['children'][number];
type ImageReference = NonNullable<PreviewFragment['images']>[number];

// Start with GitHub's schema. Source HTML cannot supply styles, scripts or executable attributes;
// KaTeX runs only after the untrusted tree has been cleaned.
const markdownSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    '*': ['align', 'alt', 'height', 'width', 'media', 'id', 'title', 'open', 'colSpan', 'rowSpan', 'start', 'lang'],
    code: [...(defaultSchema.attributes?.code ?? []), ['className', 'math-inline', 'math-display']],
    img: [...(defaultSchema.attributes?.img ?? []), 'srcSet'],
  },
  protocols: { ...defaultSchema.protocols, src: [...(defaultSchema.protocols?.src ?? []), 'data', 'attachment'] },
  strip: [...(defaultSchema.strip ?? []), 'style', 'iframe', 'object', 'embed', 'form', 'textarea', 'button', 'select', 'template', 'meta', 'link', 'base'],
};

/** srcset URLs end at whitespace, including when a data URL contains commas. */
function imageCandidates(value: unknown): { url: string; descriptor: string }[] {
  if (typeof value !== 'string') return [];
  const candidates: { url: string; descriptor: string }[] = [];
  let index = 0;
  while (index < value.length && candidates.length < 16) {
    while (index < value.length && /[\s,]/.test(value[index]!)) index++;
    if (index >= value.length) break;
    let end = index;
    while (end < value.length && !/\s/.test(value[end]!)) end++;
    const word = value.slice(index, end);
    let url = word.replace(/,+$/, '');
    let descriptor = '';
    if (word === url) {
      const comma = value.indexOf(',', end);
      descriptor = value.slice(end, comma < 0 ? value.length : comma).trim();
      index = comma < 0 ? value.length : comma + 1;
    } else index = end;
    if (url && /^(?:[1-9]\d*w|(?:\d+(?:\.\d+)?|\.\d+)x)?$/.test(descriptor) && markdownImageUrl(url)) candidates.push({ url, descriptor });
  }
  return candidates;
}

/** Select the Riffet theme before embedding: the system color scheme can differ on another device. */
function collectMarkdownImages(dark: boolean, images: ImageReference[]) {
  return (tree: Root): void => {
    const tokenize = (sources: string[]): string => {
      const [source] = sources;
      if (!source) return '';
      if (imageUrl(source)) return source;
      const token = `riffet-preview-image-${randomUUID().replace(/-/g, '')}`;
      images.push({ token, sources: [...new Set(sources.filter(markdownImageUrl))] });
      return token;
    };
    const walk = (parent: Root | Element): void => {
      const next: Child[] = [];
      for (const child of parent.children) {
        if (child.type !== 'element') { next.push(child); continue; }
        let element = child;
        if (element.tagName === 'picture') {
          const fallback = element.children.find((part): part is Element => part.type === 'element' && part.tagName === 'img');
          if (!fallback) continue;
          const requested = dark ? 'dark' : 'light';
          const source = element.children.find(part => part.type === 'element' && part.tagName === 'source'
            && /^\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)$/i.exec(String(part.properties.media ?? ''))?.[1]?.toLowerCase() === requested);
          const candidates = source?.type === 'element' ? imageCandidates(source.properties.srcSet) : [];
          element = fallback;
          if (candidates.length) element.properties.srcSet = candidates.map(item => `${item.url}${item.descriptor ? ` ${item.descriptor}` : ''}`).join(', ');
          else delete element.properties.srcSet;
        }
        if (element.tagName === 'source') continue;
        if (element.tagName === 'a' && typeof element.properties.href === 'string' && element.properties.href.startsWith('#')) {
          // The sanitizer prefixes IDs twice when GFM already supplied its own prefix.
          const target = element.properties.href.slice(1);
          element.properties.href = `#${target.startsWith('user-content-fn') ? defaultSchema.clobberPrefix : target.startsWith('user-content-') ? '' : defaultSchema.clobberPrefix}${target}`;
        }
        if (element.tagName === 'img') {
          const fallback = String(element.properties.src ?? '');
          const candidates = imageCandidates(element.properties.srcSet);
          delete element.properties.srcSet;
          const sources = [...candidates.map(item => item.url), ...(markdownImageUrl(fallback) ? [fallback] : [])];
          if (sources.length) element.properties.src = tokenize(sources);
          else delete element.properties.src;
        }
        walk(element);
        next.push(element);
      }
      parent.children = next;
    };
    walk(tree);
  };
}

/** Parse only sanitized HTML; the parent process resolves selected local image tokens. */
function markdownHtml(source: string, dark: boolean, images: ImageReference[]): string {
  return renderToStaticMarkup(createElement(ReactMarkdown, {
    children: source,
    remarkPlugins: [remarkGfm, remarkCjkFriendly, remarkCjkFriendlyGfmStrikethrough, remarkMath],
    rehypePlugins: [rehypeRaw, [rehypeSanitize, markdownSchema], () => collectMarkdownImages(dark, images), [rehypeKatex, mathOptions]],
    urlTransform: (url, key) => key === 'src' ? (markdownImageUrl(url) || imageToken(url) ? url : '') : (url.startsWith('#') ? url : ''),
    components: {
      img: ({ src, srcSet, alt, width, height }) => src && (markdownImageUrl(src) || imageToken(src))
        ? createElement('img', {
          src, ...(srcSet ? { srcSet } : {}), alt: alt ?? '', loading: 'lazy', decoding: 'async',
          style: {
            ...(typeof width === 'string' && /^(?:100|[1-9]?\d)%$/.test(width) ? { width } : Number(width) > 0 && Number(width) <= 4096 ? { width: Number(width) } : {}),
            ...(Number(height) > 0 && Number(height) <= 4096 ? { height: Number(height) } : {}),
          },
        }) : createElement('span', null, alt ?? ''),
    },
  }));
}

export function markdownPreview({ data, theme }: PreviewParseInput): PreviewFragment {
  const text = decodePreviewText(data);
  if (text === undefined) throw new Error('无法读取 Markdown 文本编码');
  const images: ImageReference[] = [];
  return { body: `<main class="document">${markdownHtml(text, theme.dark, images)}</main>`, images };
}

export async function officePreview({ data, name }: PreviewParseInput): Promise<PreviewFragment> {
  const { OfficeParser } = await import('officeparser');
  const hints: Record<string, SupportedFileType> = { docm: 'docx', dotx: 'docx', pptm: 'pptx', ppsx: 'pptx', potx: 'pptx', ott: 'odt', otp: 'odp', otg: 'odg', latex: 'tex', ltx: 'tex' };
  const ext = extensionOf(name);
  const ast = await OfficeParser.parseOffice(Buffer.from(data), {
    fileType: hints[ext] ?? (['tex', 'rtf', 'docx', 'pptx', 'odt', 'odp', 'odg', 'epub'].includes(ext) ? ext as SupportedFileType : undefined),
    extractAttachments: true, ocr: false, allowRemoteAssets: false, includeRawContent: false,
    abortSignal: AbortSignal.timeout(10_000), maxPasswordAttempts: 0,
    decompressionLimits: {
      maxUncompressedBytes: 64 * 1024 * 1024, maxZipEntries: 5000, maxXmlElements: 100_000,
      maxTableCells: 100_000, maxRawContentLength: 0, maxRepeatedContent: 2_000_000,
    },
  });
  // OfficeParser's HTML charts use a CDN script. Preserve their data as static tables instead;
  // the caller's document remains fully offline, including on a device with no chart engine.
  let chartCells = 20_000, chartCharacters = 1_000_000;
  const cell = (value: string): OfficeContentNode => {
    const text = value.slice(0, Math.max(0, Math.min(2048, chartCharacters)));
    chartCharacters -= text.length;
    return { type: 'cell', children: [{ type: 'paragraph', text, children: [{ type: 'text', text }] }] };
  };
  function staticCharts(nodes: OfficeContentNode[], depth = 0): OfficeContentNode[] {
    if (depth > 64) return [];
    return nodes.map(node => {
      if (node.type === 'chart') {
        const chart = ast.attachments.find(attachment => attachment.name === node.metadata?.attachmentName)?.chartData;
        if (!chart || chartCells <= 0) return { type: 'paragraph', text: node.text ?? '', children: [{ type: 'text', text: node.text ?? '' }] };
        const sets = chart.dataSets.slice(0, 32);
        const count = Math.min(500, Math.max(chart.labels.length, ...sets.map(set => set.values.length)), Math.floor(chartCells / (sets.length + 1)));
        chartCells -= (count + 1) * (sets.length + 1);
        return { type: 'table', children: [
          { type: 'row', children: [cell(chart.title ?? ''), ...sets.map(set => cell(set.name ?? ''))] },
          ...Array.from({ length: count }, (_, index): OfficeContentNode => ({ type: 'row', children: [cell(chart.labels[index] ?? String(index + 1)), ...sets.map(set => cell(set.values[index] ?? ''))] })),
        ] };
      }
      return node.children ? { ...node, children: staticCharts(node.children, depth + 1) } : node;
    });
  }
  ast.content = staticCharts(ast.content);
  const result = await ast.to('html', {
    includeImages: 'image-only', maxInlineImageBytes: 16 * 1024 * 1024, includeCharts: false,
    htmlConfig: { standalone: false, omitDefaultTextColor: true, gatedEmbeds: true },
  });
  const entities: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };
  const body = result.value.replace(/<(span|div)\b[^>]*class="math math-(inline|block)"[^>]*>([\s\S]*?)<\/\1>/g, (_all, _tag, mode: string, escaped: string) => {
    const text = escaped.replace(/&(?:amp|lt|gt|quot|apos|#39);/g, entity => entities[entity]);
    const delimiter = mode === 'block' ? 2 : 1;
    const tex = text.slice(delimiter, -delimiter);
    return katex.renderToString(tex, { ...mathOptions, displayMode: mode === 'block' });
  });
  const clipped = ast.warnings.some(warning => String(warning.code).includes('LIMIT_EXCEEDED'));
  return { body: `<main class="document">${body}${clipped ? '<p class="muted">内容较多，仅显示前一部分</p>' : ''}</main>` };
}

/** Keep rich notebook output inert rather than trusting the notebook's saved HTML or JavaScript. */
function notebookHtml(source: string): string {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) return `<pre>${escapeHtml(source)}</pre>`;
  let document;
  try { document = new DOMParser({ locator: false, onError() {} }).parseFromString(`<html><body>${source}</body></html>`, 'text/html'); }
  catch { return `<pre>${escapeHtml(source)}</pre>`; }
  const allowed = new Set('p div span br hr b strong em i u s sub sup h1 h2 h3 h4 h5 h6 pre code blockquote ul ol li table thead tbody tfoot tr th td caption details summary img a'.split(' '));
  const dropped = new Set('script style iframe object embed template form input textarea button meta link base'.split(' '));
  let nodes = 20_000, characters = 1_000_000;
  function visit(node: XmlNode, depth: number): string {
    if (nodes-- <= 0 || characters <= 0 || depth > 64) return '';
    if (node.nodeType === 3 || node.nodeType === 4) {
      const text = (node.nodeValue ?? '').slice(0, Math.min(characters, 32_768));
      characters -= text.length;
      return escapeHtml(text);
    }
    if (node.nodeType !== 1 && node.nodeType !== 9) return '';
    const element = node as XmlElement;
    const tag = (element.tagName ?? '').toLowerCase();
    if (dropped.has(tag)) return '';
    if (tag === 'img') {
      const src = element.getAttribute('src') ?? '';
      const alt = element.getAttribute('alt') ?? '';
      return imageUrl(src) && src.length < 8_000_000 ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt.slice(0, 4096))}">` : escapeHtml(alt);
    }
    const children: string[] = [];
    for (let child = node.firstChild; child && nodes > 0 && characters > 0; child = child.nextSibling) children.push(visit(child, depth + 1));
    if (!allowed.has(tag)) return children.join('');
    const attrs = ['td', 'th'].includes(tag) ? ['colspan', 'rowspan'].map(name => {
      const value = Number(element.getAttribute(name));
      return Number.isInteger(value) && value > 0 && value <= 1000 ? ` ${name}="${value}"` : '';
    }).join('') : '';
    return `<${tag}${attrs}>${children.join('')}</${tag}>`;
  }
  return visit(document, 0);
}

const textOf = (value: unknown): string => Array.isArray(value) ? value.filter(part => typeof part === 'string').join('') : typeof value === 'string' ? value : '';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export async function notebookPreview({ data, theme }: PreviewParseInput): Promise<PreviewFragment> {
  const text = decodePreviewText(data);
  if (text === undefined) throw new Error('无法读取 Notebook 文本编码');
  const notebook = record(JSON.parse(text));
  if (!Array.isArray(notebook.cells)) throw new Error('Notebook 缺少单元格');
  let characters = 2_000_000, imageBytes = 16_000_000;
  let clipped = notebook.cells.length > 500;
  const cells: string[] = [];
  const images: ImageReference[] = [];
  for (const raw of notebook.cells.slice(0, 500)) {
    if (characters <= 0) { clipped = true; break; }
    const cell = record(raw);
    let source = textOf(cell.source);
    if (source.length > Math.min(200_000, characters)) { source = source.slice(0, Math.min(200_000, characters)); clipped = true; }
    characters -= source.length;
    let body = cell.cell_type === 'markdown' ? markdownHtml(source, theme.dark, images) : `<pre><code>${escapeHtml(source)}</code></pre>`;
    if (Array.isArray(cell.outputs)) for (const rawOutput of cell.outputs.slice(0, 100)) {
      const output = record(rawOutput);
      const mime = record(output.data);
      let rendered = '';
      for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']) {
        const original = textOf(mime[type]);
        if (!original) continue;
        const image = type === 'image/svg+xml' ? Buffer.from(original).toString('base64') : original.replace(/\s/g, '');
        if (image.length > imageBytes || !/^[A-Za-z0-9+/=]+$/.test(image)) { clipped = true; continue; }
        imageBytes -= image.length;
        rendered = `<img src="data:${type};base64,${image}" alt="">`;
        break;
      }
      if (!rendered && characters > 0) {
        const html = textOf(mime['text/html']);
        const value = html || textOf(mime['text/markdown']) || textOf(mime['text/plain']) || textOf(output.text)
          || (Array.isArray(output.traceback) ? textOf(output.traceback.map(line => String(line) + '\n')) : '');
        const limited = value.slice(0, Math.min(200_000, characters));
        characters -= limited.length;
        if (value.length > limited.length) clipped = true;
        if (limited) rendered = html ? notebookHtml(limited) : mime['text/markdown'] ? markdownHtml(limited, theme.dark, images) : `<pre>${escapeHtml(limited)}</pre>`;
        else if (mime['application/json']) {
          const size = JSON.stringify(mime['application/json']).length;
          const budget = Math.min(200_000, characters);
          rendered = structuredTree(mime['application/json'], budget);
          characters -= Math.min(size, budget);
          if (size > budget) clipped = true;
        }
      }
      if (rendered) body += `<div class="output">${rendered}</div>`;
    }
    const execution = typeof cell.execution_count === 'number' && Number.isFinite(cell.execution_count) ? `<small>[${cell.execution_count}]</small>` : '';
    cells.push(`<section class="cell">${execution}${body}</section>`);
  }
  return { body: `<main class="document">${cells.join('')}${clipped ? '<p class="muted">内容较多，仅显示前一部分</p>' : ''}</main>`, images };
}
