import { createContext, Fragment, lazy, memo, Suspense, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef, type ReactElement, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import ReactMarkdown, { defaultUrlTransform, type Components, type ExtraProps } from 'react-markdown';
import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkCjkFriendlyGfmStrikethrough from 'remark-cjk-friendly-gfm-strikethrough';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { IconEye, IconPencilLine, IconWrapText } from '@/components/icons';
import { boundedCache } from '@/lib/bounded-cache';
import { CopyButton } from '@/components/ui/copy-button';
import { Kbd } from '@/components/ui/controls';
import { projectFileUrl } from '@/lib/files';
import { cachedHighlight, highlightCode, languageForFence, languageForPath } from '@/lib/highlight';
import { useInView } from '@/lib/use-in-view';
import { cn } from '@/lib/utils';
import { protectBareUrls } from './bareUrls';
import { relaxUnderscoreEmphasis } from '../../../../../packages/timeline/src/cjkEmphasis';
import { escapeCurrencyDollars, normalizeSlashMath } from './dollarMath';
import { CODE_PADDING, CODE_TEXT } from './codeSurface';
import { ContentFence } from './ContentFence';
import { codeFileMention, markdownLinkTarget, previewOnPlainClick, useFileAccess } from './fileAccess';
import { ZoomableImage } from './ImageViewer';
import { localImagePath, useImageSource } from './imageSource';
import { useTranscriptResources } from './transcriptResources';
import { PrintRenderingContext } from './printRendering';
import { markdownBlocks } from './markdownBlocks';
import { mayContainMath, useMath, type MathModules } from './mathRenderer';
import { useRemembered } from './rememberedState';
import { VisualizationPreview } from './VisualizationPreview';
import { rewriteVisualizationReferences, visualizationReferenceFromHref } from './visualizationReferences';
import { registerBounded } from '@/lib/cache-registry';

const MermaidDiagram = lazy(() => import('./MermaidDiagram'));
type ResourceComponents = Pick<Components, 'a' | 'img'>;

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return '';
}

/** `katex` options shared by the plugin and the ```math fence: never throw, never trust input. */
const katexOptions = { throwOnError: false, strict: 'ignore', trust: false } as const;

/**
 * A ```math fence is display TeX, the way DeepSeek Harness reads it. Anything KaTeX rejects falls
 * back to the plain code block rather than an error page: a half-written formula is normal while an
 * answer streams, and the reader would rather see their own text.
 */
function mathFenceHtml(katex: MathModules['katex'], code: string): string | undefined {
  try {
    return katex.renderToString(code, { ...katexOptions, displayMode: true });
  } catch {
    return undefined;
  }
}

/**
 * The block a fence sits in: its index, half of the place the fence's toggles are remembered under,
 * and — while it is a streaming answer's last block — the text it was parsed from, against which
 * the last fence finds out whether its closing line has arrived.
 */
const FenceBlock = createContext<{ index: number; start: number; live: string | undefined; frozen: boolean }>({ index: 0, start: 0, live: undefined, frozen: false });

export interface MarkdownHeading {
  /** Position in this Markdown instance, independent of its title or the message around it. */
  key: string;
  depth: number;
  text: string;
}

interface BlockHeading { offset: number; depth: number; text: string }
type PublishHeadings = (start: number, headings: readonly BlockHeading[] | undefined) => void;
const HeadingIndex = createContext<PublishHeadings | undefined>(undefined);
const headingIndexes = new WeakMap<HTMLElement, readonly MarkdownHeading[]>();
const noHeadings: readonly MarkdownHeading[] = [];

/** The parser's outline of the text actually displayed, including a live block's throttle/selection hold. */
export function markdownHeadings(element: HTMLElement): readonly MarkdownHeading[] {
  return headingIndexes.get(element) ?? noHeadings;
}

function MarkdownHeadingElement({ tag: Tag, node, ...props }: { tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' } & ComponentPropsWithoutRef<'h2'> & ExtraProps) {
  const block = useContext(FenceBlock);
  const indexed = useContext(HeadingIndex);
  const offset = node?.properties['data-heading-offset'];
  return <Tag {...props} data-md-heading={indexed && typeof offset === 'number' ? String(block.start + offset) : undefined} />;
}

/**
 * Whether the fence at `start…end` of a streaming block is still being written: nothing follows it
 * and its last line does not close it (a fence that has only just opened is that one line).
 */
function fenceStillOpen(text: string, start: number, end: number): boolean {
  if (text.slice(end).trim()) return false;
  const firstEnd = text.indexOf('\n', start);
  const opener = /^ {0,3}(`{3,}|~{3,})/.exec(text.slice(start, firstEnd < 0 ? end : Math.min(firstEnd, end)))?.[1];
  if (!opener) return false;
  const lastStart = text.lastIndexOf('\n', end - 1) + 1;
  if (lastStart <= start) return true;
  const close = /^[ \t>]*(`{3,}|~{3,})[ \t]*$/.exec(text.slice(lastStart, end))?.[1];
  return !close || close[0] !== opener[0] || close.length < opener.length;
}

/** A short FNV-1a digest of a fence's head: it tells a fence apart from one at the same place in the document it previews. */
function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return (hash >>> 0).toString(36);
}

/**
 * Previews (graphs, pages) that have been on screen, by their text: a fence the transcript window
 * mounts again goes straight to its preview instead of showing the source until the observer
 * reports it in view. Cleared wholesale past a bound; forgetting only costs that one wait.
 */
const shownPreviews = new Set<string>();
function rememberPreview(key: string): void {
  if (shownPreviews.size >= 2_000) shownPreviews.clear();
  shownPreviews.add(key);
}

/** Some agents cite code as ```12:40:path/to/file.ts — a line range and a file, not a language. */
function citation(info: string): { start: number; end: number; path: string } | undefined {
  const match = /^(\d+):(\d+):(.+)$/.exec(info.trim());
  return match ? { start: Number(match[1]), end: Number(match[2]), path: match[3]! } : undefined;
}

/** Keeps the filename and line range visible when a long directory path has to truncate. */
function CitedFenceLabel({ cited }: { cited: { start: number; end: number; path: string } }) {
  const slash = cited.path.lastIndexOf('/');
  const dir = slash > 0 ? cited.path.slice(0, slash) : '';
  const file = slash > 0 ? cited.path.slice(slash + 1) : cited.path;
  return (
    <span className="flex min-w-0 items-center overflow-hidden font-mono text-2xs text-fg-3" title={`${cited.path} · L${cited.start}–${cited.end}`}>
      {dir ? (
        <>
          <span className="min-w-0 shrink-[99] truncate">{dir}</span>
          <span className="shrink-0">/</span>
          <span className="min-w-0 shrink truncate">{file}</span>
        </>
      ) : (
        <span className="min-w-0 truncate">{file}</span>
      )}
      <span className="shrink-0 whitespace-nowrap">{'\u00A0·\u00A0'}L{cited.start}–{cited.end}</span>
    </span>
  );
}

const escapeText = (text: string) => text.replace(/[&<>]/g, (char) => (char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;'));

/**
 * One fenced code block.
 *
 * The highlighting is refractor, lazily loaded (the same engine the file preview uses), so a fence
 * costs nothing until it is on screen and only tokenizes once its text has settled: the fence a
 * streaming answer is still writing (its closing line not in yet) stays plain, and otherwise an
 * 80ms debounce means the work runs on the text the reader actually ends up with. Colors already
 * built for the exact text (`cachedHighlight`) paint on mount. The rendered HTML is pinned to the
 * text it was built from; when the text has only grown past it, the old colors stay over the part
 * they cover and the rest is plain, so a fence never drops back to plain text between two passes.
 *
 * Wrapping is on by default, matching DeepSeek Harness — a chat column is narrow enough that
 * horizontal scrolling hides more than it reveals — with a per-block toggle for the times it does
 * not, and the copy button reads the source text, never the highlighted DOM. Both toggles are
 * remembered for the fence's place in its transcript row, so they survive the row being windowed out.
 *
 * A `markdown` fence is a document an agent pasted whole (a draft, a report); it gets one more
 * toggle that renders it with the same renderer as the answer around it, because reading a long
 * draft as source is not reading it. The rendered view is built on demand and from the fence's own
 * text, so nothing is parsed until someone asks for it. A graph or a page preview waits for the
 * fence to close: a half-written one fails anyway, and every attempt would build a new frame.
 */
function CodeFence({ info, code, start, end, resourceComponents }: { info: string; code: string; start: number | undefined; end: number | undefined; resourceComponents?: ResourceComponents }) {
  const { t } = useLingui();
  const printing = useContext(PrintRenderingContext);
  const block = useContext(FenceBlock);
  const open = block.live !== undefined && start !== undefined && end !== undefined && fenceStillOpen(block.live, start, end);
  // The block, the offset in it and the first line name the fence's remembered toggles; all three hold while it streams, once that line is in.
  const lineEnd = code.indexOf('\n');
  const place = `md-fence:${block.index}.${start ?? ''}:${digest(`${info}\n${code.slice(0, Math.min(200, lineEnd < 0 ? code.length : lineEnd))}`)}`;
  const [wrapped, setWrapped] = useRemembered(`${place}:wrap`, true);
  const [previewOverride, setPreview] = useRemembered<boolean | undefined>(`${place}:preview`, undefined);
  const [frame, observed] = useInView<HTMLDivElement>();
  const cited = useMemo(() => citation(info), [info]);
  const language = useMemo(() => (cited ? languageForPath(cited.path) : languageForFence(info)), [cited, info]);
  const mathFence = /^(?:math|latex|tex)$/i.test(info);
  const mathModules = useMath(mathFence);
  const math = useMemo(() => (mathFence && mathModules ? mathFenceHtml(mathModules.katex, code) : undefined), [mathFence, mathModules, code]);
  const diagram = /^(?:mermaid|mmd|dot|graphviz|gv|plantuml|puml|uml|wsd|d2|vega|vega-lite|vegalite|vl)$/i.test(info.trim());
  const markup = /^(?:html?|svg)$/i.test(info.trim());
  const renderable = diagram || markup || /^(?:md|markdown|mdx)$/i.test(info.trim());
  const preview = printing ? diagram : previewOverride ?? diagram;
  const previewing = preview && !(open && (diagram || markup));
  const previewKey = previewing && (diagram || markup) ? `${info}\u0000${code.length}:${digest(code)}` : undefined;
  const inView = printing || observed || (previewKey !== undefined && shownPreviews.has(previewKey));
  useEffect(() => { if (observed && previewKey) rememberPreview(previewKey); }, [observed, previewKey]);
  const cached = useMemo(() => cachedHighlight(code, language), [code, language]);
  const [rendered, setRendered] = useState<{ code: string; language: string; html: string }>();

  useEffect(() => {
    if (block.frozen || !inView || !language || previewing || open || cached) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void highlightCode(code, language).then((html) => {
        if (!cancelled && (html || printing)) setRendered({ code, language, html: html ?? escapeText(code) });
      });
    }, printing ? 0 : 80);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [block.frozen, inView, code, language, previewing, open, cached, printing]);

  const held = rendered && rendered.language === language && code.startsWith(rendered.code) ? rendered.html + escapeText(code.slice(rendered.code.length)) : undefined;
  const highlighted = useRef(math ?? cached ?? held);
  // A pending highlighter or math module may settle independently of the parent Markdown render.
  if (!block.frozen) highlighted.current = math ?? cached ?? held;
  const html = highlighted.current;
  const source = (
    <pre
      data-code-wrap={wrapped || undefined}
      className={cn(CODE_PADDING, CODE_TEXT, 'text-fg', wrapped ? 'whitespace-pre-wrap break-words' : 'overflow-x-auto')}
    >
      {html ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}
    </pre>
  );
  const previewLabel = preview ? t`显示源码` : t({ message: '渲染预览', context: 'session-render-preview-toggle' });
  const highlightPending = language && code.length > 0 && cached === undefined && !(rendered?.language === language && rendered.code === code);
  return (
    <div ref={frame} data-print-pending={printing && !previewing && ((mathFence && !mathModules) || highlightPending) ? '' : undefined} className="md-code group/code my-3 overflow-hidden rounded-lg bg-subtle first:mt-0">
      {/*
        The header is its own surface (`bg-muted`), not the block's (`bg-subtle`): with one
        background the language and the buttons sat on the code itself and the 1px rule under them
        was the only thing separating chrome from content. DeepSeek Harness gives its banner its own
        alias token for the same reason. Every fence gets this, not only markdown ones.
      */}
      <div className="md-code-head flex h-8 items-center justify-between bg-muted edge-b pl-3 pr-1 no-hover:h-11">
        {cited
          ? <CitedFenceLabel cited={cited} />
          : <span className="min-w-0 truncate font-mono text-2xs uppercase tracking-wide text-fg-3">{info || 'text'}</span>}
        <div className="flex shrink-0 items-center gap-0.5">
          {renderable && (
            <button
              type="button"
              aria-pressed={preview}
              aria-label={previewLabel}
              title={previewLabel}
              className={cn('inline-flex h-6 items-center rounded-md px-1.5 text-xs transition-colors hover:bg-hover hover:text-fg no-hover:size-11 no-hover:justify-center no-hover:px-0', preview ? 'text-accent' : 'text-fg-2')}
              onClick={() => setPreview(!preview)}
            >
              {preview ? <IconPencilLine className="size-3.5" /> : <IconEye className="size-3.5" />}
            </button>
          )}
          <button
            type="button"
            aria-pressed={wrapped}
            aria-label={wrapped ? t`取消自动换行` : t`自动换行`}
            title={wrapped ? t`取消自动换行` : t`自动换行`}
            className={cn('inline-flex h-6 items-center rounded-md px-1.5 text-xs transition-colors hover:bg-hover hover:text-fg no-hover:size-11 no-hover:justify-center no-hover:px-0', wrapped ? 'text-fg-2' : 'text-fg-4')}
            onClick={() => setWrapped(!wrapped)}
          >
            <IconWrapText className="size-3.5" />
          </button>
          <CopyButton text={code} label={t`复制代码`} className="no-hover:size-11 no-hover:justify-center no-hover:px-0" />
        </div>
      </div>
      {previewing && diagram ? (
        <Suspense fallback={printing ? <div data-print-pending>{source}</div> : source}>
          {inView ? <MermaidDiagram code={code} language={info.toLowerCase()} fallback={source} /> : source}
        </Suspense>
      ) : previewing && markup ? (
        <ContentFence code={code} language={info.toLowerCase()} active={inView} />
      ) : previewing ? (
        <div className={CODE_PADDING}>
          <Markdown text={code} resourceComponents={resourceComponents} streaming={open} />
        </div>
      ) : source}
    </div>
  );
}

/**
 * TeX while KaTeX is still on its way: the source in the type and spacing the rendered formula
 * takes (`.md .katex` and `.katex-display` in `styles/index.css`), so the formula arriving replaces
 * the text in place instead of a code block's box. A failed load leaves it like this, still readable.
 */
function PendingMath({ display, children }: { display: boolean; children: ReactNode }) {
  return display
    ? <div className="my-3 overflow-x-auto py-0.5 text-center text-[1.21em] italic leading-[1.2] [overflow-wrap:anywhere]">{children}</div>
    : <span className="text-[1.05em] italic">{children}</span>;
}

function markdownPre(children: ReactNode, node: ExtraProps['node'], resourceComponents?: ResourceComponents) {
  const child = Array.isArray(children) ? children[0] : children;
  const className = child && typeof child === 'object' && 'props' in child ? String((child as { props: { className?: string } }).props.className ?? '') : '';
  if (/\bmath-display\b/.test(className)) return <PendingMath display>{textOf(children).replace(/\n$/, '')}</PendingMath>;
  const info = /language-(\S+)/.exec(className)?.[1] ?? '';
  return <CodeFence info={info} code={textOf(children).replace(/\n$/, '')} start={node?.position?.start.offset} end={node?.position?.end.offset} resourceComponents={resourceComponents} />;
}

/** An image inside a link is most likely a badge: it holds a line while loading, not a picture's box. */
const InsideLink = createContext(false);

const components: Components = {
  h1: (props) => <MarkdownHeadingElement tag="h1" {...props} />,
  h2: (props) => <MarkdownHeadingElement tag="h2" {...props} />,
  h3: (props) => <MarkdownHeadingElement tag="h3" {...props} />,
  h4: (props) => <MarkdownHeadingElement tag="h4" {...props} />,
  h5: (props) => <MarkdownHeadingElement tag="h5" {...props} />,
  h6: (props) => <MarkdownHeadingElement tag="h6" {...props} />,
  pre: ({ children, node }) => markdownPre(children, node),
  a({ children, href }) {
    return <InsideLink.Provider value><MarkdownLink href={href}>{children}</MarkdownLink></InsideLink.Provider>;
  },
  code({ children, className }) {
    if (className && /\bmath-inline\b/.test(className)) return <PendingMath display={false}>{children}</PendingMath>;
    return <MarkdownCode className={className}>{children}</MarkdownCode>;
  },
  img({ src, alt }) {
    return typeof src === 'string' && src ? <MarkdownImage src={src} alt={alt ?? ''} /> : null;
  },
  blockquote({ node, children }) {
    const kind = node?.properties['data-alert'];
    return <blockquote data-alert={typeof kind === 'string' ? kind : undefined}>{typeof kind === 'string' && <strong className="mb-1 block text-xs font-semibold uppercase tracking-wide">{kind}</strong>}{children}</blockquote>;
  },
  // The table scrolls horizontally when its columns need the room, and a hidden overflow is not
  // keyboard-reachable in Chromium unless the element itself takes focus (the reveal-on-hover rule
  // in `styles/index.css` follows the same idea).
  table({ node, children }) {
    return <MarkdownTable node={node}>{children}</MarkdownTable>;
  },
  kbd({ children }) {
    return <Kbd className="mx-0.5 align-baseline">{children}</Kbd>;
  },
} as Components;

interface HastNodeLike {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNodeLike[];
}

function inlineCodeMarkdown(text: string): string {
  let maxFence = 0;
  for (const match of text.matchAll(/`+/g)) maxFence = Math.max(maxFence, match[0].length);
  const fence = '`'.repeat(maxFence + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

function tableCellMarkdown(node: HastNodeLike): string {
  if (node.type === 'text') return node.value ?? '';
  if (node.type !== 'element') return '';
  if (node.tagName === 'br') return '<br>';
  const classes = Array.isArray(node.properties?.className) ? node.properties.className : [];
  if (classes.includes('katex-html')) return '';
  if (node.tagName === 'annotation' && node.properties?.encoding === 'application/x-tex') {
    const tex = (node.children ?? []).map((child) => (child.type === 'text' ? child.value ?? '' : '')).join('').trim();
    return tex ? `$${tex}$` : '';
  }
  if (classes.includes('katex-mathml')) {
    const annotation = (node.children ?? []).map(tableCellMarkdown).join('');
    if (annotation) return annotation;
  }
  if (node.tagName === 'math') {
    for (const child of node.children ?? []) {
      const tex = tableCellMarkdown(child);
      if (tex.startsWith('$') && tex.endsWith('$')) return tex;
    }
  }
  if (node.tagName === 'semantics') {
    for (const child of node.children ?? []) {
      if (child.type === 'element' && child.tagName === 'annotation') return tableCellMarkdown(child);
    }
  }
  const inner = (node.children ?? []).map(tableCellMarkdown).join('');
  if (node.tagName === 'code') {
    if (classes.includes('math-inline')) return `$${inner}$`;
    return inlineCodeMarkdown(inner);
  }
  return inner;
}

function tableMarkdownText(table: ExtraProps['node'] | undefined): string {
  if (!table) return '';
  const rows: Array<{ cells: string[]; aligns: Array<string | undefined> }> = [];
  const collectRows = (node: HastNodeLike) => {
    if (node.type !== 'element') return;
    if (node.tagName === 'tr') {
      const cells: string[] = [];
      const aligns: Array<string | undefined> = [];
      for (const child of node.children ?? []) {
        if (child.type !== 'element' || (child.tagName !== 'th' && child.tagName !== 'td')) continue;
        const text = tableCellMarkdown(child).replace(/\r?\n+/g, ' ').trim().replace(/\|/g, '\\|');
        cells.push(text);
        const align = child.properties?.align;
        aligns.push(typeof align === 'string' ? align : undefined);
      }
      if (cells.length) rows.push({ cells, aligns });
      return;
    }
    for (const child of node.children ?? []) collectRows(child);
  };
  collectRows(table as unknown as HastNodeLike);
  if (!rows.length) return '';
  const columns = rows.reduce((max, row) => Math.max(max, row.cells.length), 0);
  if (!columns) return '';
  const padRow = (cells: string[]) => `| ${Array.from({ length: columns }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  const sep = Array.from({ length: columns }, (_, i) => {
    const align = rows[0]?.aligns[i];
    if (align === 'center') return ':---:';
    if (align === 'right') return '---:';
    if (align === 'left') return ':---';
    return '---';
  });
  return [padRow(rows[0]!.cells), `| ${sep.join(' | ')} |`, ...rows.slice(1).map((row) => padRow(row.cells))].join('\n');
}

function MarkdownTable({ node, children }: { node?: ExtraProps['node']; children?: ReactNode }) {
  const { t } = useLingui();
  const markdown = useMemo(() => tableMarkdownText(node), [node]);
  return (
    <div className="md-table group/table relative w-fit max-w-full">
      <table tabIndex={0}>{children}</table>
      {markdown && (
        <span className="md-table-copy absolute bottom-full right-0 -mr-1 pb-1.5 pl-6 pr-1 pt-2">
          <CopyButton text={markdown} label={t`复制表格`} size="xs" />
        </span>
      )}
    </div>
  );
}

/**
 * A link to a local file opens it in the side preview. The href is the file itself, so a modified
 * or middle click opens it in a tab and the browser's own "save link" downloads it.
 */
function MarkdownLink({ href, children }: { href: string | undefined; children: ReactNode }) {
  const { t } = useLingui();
  const files = useFileAccess();
  const resources = useTranscriptResources();
  const visualization = visualizationReferenceFromHref(href);
  if (visualization) {
    if (resources) {
      const resource = resources.resources[visualization.path];
      const title = visualization.title || visualization.path.split('/').pop() || t`交互预览`;
      return resource ? <a href={resource.previewUrl ?? resource.url} target="_blank" rel="noopener noreferrer">{title}</a> : <span className="text-fg-3"><Trans>{title} · 预览不可用</Trans></span>;
    }
    return <VisualizationPreview reference={visualization} />;
  }
  const target = markdownLinkTarget(href);
  if (resources && href) {
    const resource = resources.resources[href] ?? (target.kind === 'file' ? resources.resources[target.path] : undefined);
    if (resource) return <a href={resource.url} target="_blank" rel="noopener noreferrer">{children}</a>;
    if (target.kind !== 'web' || /^\/api\//.test(href)) return <span>{children}</span>;
  }
  if (target.kind === 'text') return <span title={href}>{children}</span>;
  if (target.kind === 'web' || !files?.open) return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
  const open = files.open;
  const path = files.resolve?.(target.path) ?? target.path;
  return (
    <a
      href={projectFileUrl(files.projectId, path)}
      target="_blank"
      rel="noopener"
      title={t`在右侧预览 ${path}${target.line ? `:${target.line}` : ''}`}
      onClick={previewOnPlainClick(open, path, target.line)}
    >{children}</a>
  );
}

/**
 * A run of code the agent writes as `path/to/file.ts:42` is a reference to a file it just touched,
 * so it opens that file (`resolve`) the way a Markdown link does, a modified click included; `codeFileMention` keeps commands, identifiers
 * and folders out. Fenced blocks arrive with a `language-` class and are passed through untouched —
 * the `pre` override above owns their rendering.
 */
function MarkdownCode({ className, children }: { className?: string; children?: ReactNode }) {
  const { t } = useLingui();
  const files = useFileAccess();
  const text = textOf(children).trim();
  const target = files?.open && !className ? codeFileMention(text) : undefined;
  if (!target || !files?.open) return <code className={className}>{children}</code>;
  const open = files.open;
  const path = files.resolve?.(target.path) ?? target.path;
  return (
    <a
      href={projectFileUrl(files.projectId, path)}
      target="_blank"
      rel="noopener"
      className="md-file-mention"
      title={t`在右侧预览 ${path}${target.line ? `:${target.line}` : ''}`}
      onClick={previewOnPlainClick(open, path, target.line)}
    >
      <code>{children}</code>
    </a>
  );
}

/** Agents reference files they wrote by path; those load through the project's read-only image route. */
function MarkdownImage({ src, alt }: { src: string; alt: string }) {
  const { t } = useLingui();
  const imageSource = useImageSource();
  const path = localImagePath(src);
  const resources = useTranscriptResources();
  const linked = useContext(InsideLink);
  if (resources && path && !imageSource(path)) return <span className="text-xs text-fg-3">{alt || t`图片不可用`}</span>;
  if (resources && src.startsWith('/api/')) return <span className="text-xs text-fg-3">{alt || t`图片不可用`}</span>;
  const resolved = (path && imageSource(path)) || src;
  const label = path ?? (alt || undefined);
  return <ZoomableImage src={resolved} name={alt || path?.split('/').pop() || t({ message: '图片', context: 'session-image-name' })} {...(label ? { label } : {})} maxHeight={448} className="my-1" placeholder={linked ? 'small' : 'large'} />;
}

/** The default transform drops `file:` URLs; they name a local file the project routes can serve. */
function urlTransform(url: string, key: string): string {
  if (key === 'href' && visualizationReferenceFromHref(url)) return url;
  return (key === 'src' || key === 'href') && /^file:\/\//i.test(url) ? url : defaultUrlTransform(url);
}

interface MarkdownNode {
  type: string;
  value?: string;
  depth?: number;
  position?: { start: { offset?: number } };
  children?: MarkdownNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

/** GitHub alerts remain ordinary Markdown; only their marker receives semantic styling. */
function remarkAlerts() {
  return (tree: unknown) => {
    const visit = (node: MarkdownNode) => {
      const paragraph = node.type === 'blockquote' ? node.children?.[0] : undefined;
      const first = paragraph?.type === 'paragraph' ? paragraph.children?.[0] : undefined;
      const match = first?.type === 'text' ? /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\r?\n|$)/i.exec(first.value ?? '') : undefined;
      if (match && first) {
        first.value = first.value!.slice(match[0].length);
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, 'data-alert': match[1]!.toLowerCase() } };
        if (!first.value && paragraph?.children?.length === 1) node.children?.shift();
      }
      node.children?.forEach(visit);
    };
    visit(tree as MarkdownNode);
  };
}

/**
 * Converts a narrow set of safe inline HTML tags (`<br>`, matched `<kbd>`, `<sup>`, `<sub>` pairs)
 * without enabling full `rehype-raw`, so generic brackets like `<T>` and unclosed streaming tags
 * stay literal text.
 */
function remarkSafeHtml() {
  const SAFE_BREAKS = /^(?:<br\s*\/?>\s*)+$/i;
  const SAFE_BREAK_ITEM = /<br\s*\/?>/gi;
  const SAFE_TAG_OPEN = /^<(kbd|sup|sub)>$/i;
  const SAFE_TAG_CLOSE = /^<\/(kbd|sup|sub)>$/i;
  const SAFE_INLINE_PAIR = /^<(kbd|sup|sub)>([^<>]+)<\/\1>$/i;

  return (tree: unknown) => {
    const transformChildren = (children: MarkdownNode[]) => {
      for (let index = 0; index < children.length; index += 1) {
        const node = children[index]!;
        if (node.type === 'html') {
          const raw = (node.value ?? '').trim();
          if (SAFE_BREAKS.test(raw)) {
            const count = raw.match(SAFE_BREAK_ITEM)?.length ?? 1;
            const breaks: MarkdownNode[] = Array.from({ length: count }, () => ({ type: 'break' }));
            children.splice(index, 1, ...breaks);
            index += breaks.length - 1;
            continue;
          }
          const single = SAFE_INLINE_PAIR.exec(raw);
          if (single) {
            const tag = single[1]!.toLowerCase();
            children[index] = {
              type: 'safeInlineHtml',
              data: { hName: tag },
              children: [{ type: 'text', value: single[2]! }],
            };
            continue;
          }
          const open = SAFE_TAG_OPEN.exec(raw);
          if (open) {
            const tag = open[1]!.toLowerCase();
            let closeIndex = -1;
            for (let scan = index + 1; scan < children.length; scan += 1) {
              const candidate = children[scan]!;
              if (candidate.type !== 'html') continue;
              const candidateRaw = (candidate.value ?? '').trim();
              const nestedOpen = SAFE_TAG_OPEN.exec(candidateRaw);
              if (nestedOpen && nestedOpen[1]!.toLowerCase() === tag) break;
              const close = SAFE_TAG_CLOSE.exec(candidateRaw);
              if (close && close[1]!.toLowerCase() === tag) {
                closeIndex = scan;
                break;
              }
            }
            if (closeIndex > index) {
              const inner = children.slice(index + 1, closeIndex);
              transformChildren(inner);
              children.splice(index, closeIndex - index + 1, {
                type: 'safeInlineHtml',
                data: { hName: tag },
                children: inner,
              });
              continue;
            }
          }
        }
        if (node.children?.length) transformChildren(node.children);
      }
    };
    const root = tree as MarkdownNode;
    if (root.children?.length) transformChildren(root.children);
  };
}

/** CommonMark leaves `**结论：**正文` as literal asterisks; `remark-cjk-friendly` lets it close. */
const remarkPlugins = [remarkAlerts, remarkGfm, remarkCjkFriendly, remarkCjkFriendlyGfmStrikethrough, remarkMath, remarkSafeHtml];
const noPlugins: [] = [];

/**
 * Parsed blocks by text and by whether KaTeX was in, shared by every message: a row the transcript
 * window unmounts and mounts again would otherwise parse its whole answer again. What is kept is
 * react-markdown's synchronous output, an element tree; the components in it (fences, links,
 * images) still render per mount, against the context they mount in, which is also why only trees
 * built with the shared `components` are kept. Bounded by count and by total text.
 */
interface ParsedBlock { element: ReactElement; headings: readonly BlockHeading[] }
const blockCache = boundedCache<string, ParsedBlock>({ limit: 500, maxWeight: 500_000, weigh: (key) => key.length });
registerBounded('markdown-blocks', blockCache, 500, 500_000);

function renderBlock(text: string, math: MathModules | undefined, renderComponents: Components, remember: boolean): ParsedBlock {
  const key = `${math ? 'tex' : ''}\u0000${text}`;
  const hit = remember ? blockCache.get(key) : undefined;
  if (hit) return hit;
  const headings: BlockHeading[] = [];
  const inlineText = (node: MarkdownNode): string => node.value ?? node.children?.map(inlineText).join('') ?? '';
  // Root headings only: quoted examples and a fenced document have their own structure. The
  // cached elements keep local positions; the instance's contexts supply their block and scope.
  const collectHeadings = () => (tree: unknown) => {
    for (const node of (tree as MarkdownNode).children ?? []) {
      const offset = node.position?.start.offset;
      if (node.type !== 'heading' || node.depth === undefined || offset === undefined) continue;
      const title = inlineText(node).replace(/\s+/g, ' ').trim();
      if (!title) continue;
      headings.push({ offset, depth: node.depth, text: title });
      node.data = { ...node.data, hProperties: { ...node.data?.hProperties, 'data-heading-offset': offset } };
    }
  };
  const element = ReactMarkdown({
    children: text,
    remarkPlugins: [...remarkPlugins, collectHeadings],
    rehypePlugins: math ? [[math.rehypeKatex, katexOptions]] : noPlugins,
    components: renderComponents,
    urlTransform,
  });
  const parsed = { element, headings };
  if (remember) blockCache.set(key, parsed);
  return parsed;
}

/** Past this, a live block re-parses on a clock instead of on every delta (see `useLiveText`). */
const LIVE_THROTTLE_CHARS = 2_000;

/**
 * The text a block parses. While it is a streaming answer's last block and long enough to cost
 * something — once `markdownBlocks` stops splitting, the last block runs to the end of the answer —
 * a new text lands at most once per interval, 100ms up to about 6KB and growing with the text to 1s,
 * and the block keeps what it last parsed in between. A block that is no longer live shows its
 * current text at once.
 */
function useLiveText(text: string, live: boolean, frozen = false): string {
  const throttled = live && text.length > LIVE_THROTTLE_CHARS;
  const [shown, setShown] = useState(text);
  const shownAt = useRef(0);
  // Unthrottled it follows the text, so throttling starts from what is on screen.
  if (!throttled && !frozen && shown !== text) setShown(text);
  useEffect(() => {
    if (frozen || !throttled || shown === text) return;
    const interval = Math.min(1_000, Math.max(100, text.length / 64));
    const timer = window.setTimeout(() => { shownAt.current = performance.now(); setShown(text); }, shownAt.current + interval - performance.now());
    return () => window.clearTimeout(timer);
  }, [frozen, throttled, shown, text]);
  return frozen || throttled ? shown : text;
}

/**
 * One top-level block, parsed only when its own text (or the math renderer) changes. A live block
 * is never cached: its text is gone by the next delta.
 */
const MarkdownBlock = memo(function MarkdownBlock({ text, index, start, live, frozen, math, resourceComponents }: { text: string; index: number; start: number; live: boolean; frozen: boolean; math: MathModules | undefined; resourceComponents?: ResourceComponents }) {
  const shown = useLiveText(text, live, frozen);
  const renderComponents = useMemo(() => resourceComponents ? {
    ...components, ...resourceComponents,
    pre: ({ children, node }: { children?: ReactNode } & ExtraProps) => markdownPre(children, node, resourceComponents),
  } : components, [resourceComponents]);
  const parsed = useMemo(() => renderBlock(shown, math, renderComponents, !live && renderComponents === components), [shown, math, renderComponents, live]);
  const block = useMemo(() => ({ index, start, live: live ? shown : undefined }), [index, start, live, shown]);
  const displayed = useRef({ parsed, block });
  if (!frozen) displayed.current = { parsed, block };
  const publish = useContext(HeadingIndex);
  const headings = displayed.current.parsed.headings;
  const headingStart = displayed.current.block.start;
  useLayoutEffect(() => {
    publish?.(headingStart, headings);
    return () => publish?.(headingStart, undefined);
  }, [publish, headingStart, headings]);
  const context = useMemo(() => ({ ...displayed.current.block, frozen }), [displayed.current.block, frozen]);
  return <FenceBlock.Provider value={context}>{displayed.current.parsed.element}</FenceBlock.Provider>;
});

/**
 * The source rewrites the parser needs, in order: internal references first (they are links the
 * model wrote as a protocol), then the three places GFM's inline rules and Chinese prose disagree —
 * `_` emphasis, prices, and where a bare URL ends. Each leaves code alone.
 */
function prepare(text: string, visualizationLabel: string): string {
  // Explicit TeX delimiters must survive the price heuristic, including `\(x\)2`.
  return protectBareUrls(normalizeSlashMath(escapeCurrencyDollars(relaxUnderscoreEmphasis(rewriteVisualizationReferences(text, visualizationLabel)))));
}

/**
 * Rendered block by block (see `markdownBlocks`), so a streaming answer re-parses only its last
 * block. The `\n` between blocks is the text node the whole-document parse puts between top-level
 * nodes, which keeps the DOM the same as parsing the text in one piece.
 *
 * `streaming` says the text is still arriving, which makes its last block live: re-parsed on a
 * clock once it is long, kept out of the parse cache, and its unclosed fence left plain.
 */
export const Markdown = memo(function Markdown({ text, className, resourceComponents, streaming = false, chapters = false }: { text: string; className?: string; resourceComponents?: ResourceComponents; streaming?: boolean; chapters?: boolean }) {
  const printing = useContext(PrintRenderingContext);
  const { t } = useLingui();
  const body = useRef<HTMLDivElement>(null);
  const publishHeadings = useMemo<PublishHeadings>(() => {
    const indexed = new Map<number, readonly BlockHeading[]>();
    let queued = false;
    return (start, headings) => {
      if (headings) indexed.set(start, headings); else indexed.delete(start);
      if (queued) return;
      queued = true;
      // Child layout effects publish together; a live block replacing its parse is one update,
      // and an unchanged outline does not wake the transcript on every streamed token.
      queueMicrotask(() => {
        queued = false;
        const element = body.current;
        if (!element) return;
        const next = [...indexed].sort(([a], [b]) => a - b).flatMap(([start, values]) => values.map((heading) => ({ key: String(start + heading.offset), depth: heading.depth, text: heading.text })));
        const previous = markdownHeadings(element);
        if (next.length === previous.length && next.every((heading, position) => heading.key === previous[position]!.key && heading.depth === previous[position]!.depth && heading.text === previous[position]!.text)) return;
        headingIndexes.set(element, next);
        element.dispatchEvent(new Event('markdown-headings', { bubbles: true }));
      });
    };
  }, []);
  const displayed = useRef({ text, streaming });
  const held = useRef(false);
  const dragging = useRef(false);
  const [selecting, setSelecting] = useState(false);
  // Preserve the rendered subtree while it owns a selection. SSE and the server keep running;
  // clearing the selection publishes the latest text in one render, including the final delta.
  if (!held.current) displayed.current = { text, streaming };
  useLayoutEffect(() => {
    const element = body.current;
    if (!element || !streaming && !selecting) return;
    const read = () => {
      const selection = document.getSelection();
      const inside = Boolean(selection && !selection.isCollapsed && selection.rangeCount && element.contains(selection.getRangeAt(0).commonAncestorContainer));
      const next = dragging.current || inside;
      held.current = next;
      setSelecting(next);
    };
    const down = (event: PointerEvent) => { if (event.button === 0) { dragging.current = true; read(); } };
    const up = () => { dragging.current = false; read(); };
    element.addEventListener('pointerdown', down);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    document.addEventListener('selectionchange', read);
    window.addEventListener('blur', up);
    return () => {
      element.removeEventListener('pointerdown', down);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      document.removeEventListener('selectionchange', read);
      window.removeEventListener('blur', up);
    };
  }, [streaming, selecting]);
  const shown = displayed.current;
  // Until KaTeX arrives, remark-math's nodes render as `PendingMath`.
  const math = useMath(mayContainMath(shown.text));
  const visualizationLabel = t`交互预览`;
  const preparedText = useMemo(() => prepare(shown.text, visualizationLabel), [shown.text, visualizationLabel]);
  const blocks = useMemo(() => {
    let end = 0;
    return markdownBlocks(preparedText).map((text) => {
      // Separating blank lines are omitted by the splitter. Keep each block's document offset
      // so appending a reference definition can merge blocks without renaming earlier headings.
      const start = preparedText.indexOf(text, end);
      end = start + text.length;
      return { text, start };
    });
  }, [preparedText]);
  return (
    <div ref={body} data-print-pending={printing && mayContainMath(shown.text) && !math ? '' : undefined} className={cn('md', className)}>
      <HeadingIndex.Provider value={chapters ? publishHeadings : undefined}>
      {blocks.map((block, index) => <Fragment key={index}>{index > 0 && '\n'}<MarkdownBlock text={block.text} index={index} start={block.start} live={shown.streaming && index === blocks.length - 1} frozen={selecting} math={math} resourceComponents={resourceComponents} /></Fragment>)}
      </HeadingIndex.Provider>
    </div>
  );
});
