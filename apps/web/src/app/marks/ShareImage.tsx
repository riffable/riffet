import { createContext, Fragment, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { MarkColor, MarkQuote, ModelInfo, NativeBackendId } from '@contracts';
import { IconCopy, IconDownload } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Segmented, Switch } from '@/components/ui/controls';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useBackendLabel } from '@/lib/backends';
import { formatDate, formatNumber } from '@/lib/i18n/format';
import { parseSelection } from '@/lib/models';
import { toast } from '@/lib/toast';
import { cleanLabel, cn, errorMessage } from '@/lib/utils';
import { Markdown } from '../session/Markdown';
import { PrintRenderingContext } from '../session/printRendering';
import { findQuote, rangeAt } from '../session/textQuote';

/** The turn an answer belongs to: the prompt it replied to and the model that wrote it (a display name). */
export interface ShareTurn { prompt?: string; model?: string }

/** What an exported picture shows: a highlighted passage, or a whole answer as Markdown. */
export interface ShareSource {
  kind: 'span' | 'message';
  /** The answer's Markdown, or the passage as plain text. */
  text: string;
  /** For a passage: the answer it is in, and where in its rendered text, so the card keeps its Markdown. */
  answer?: { markdown: string; quote: MarkQuote };
  /** A saved highlight's colour; an unsaved selection has none. */
  color?: MarkColor;
  note?: string;
  title: string;
  backendId?: NativeBackendId;
  projectName?: string;
  /** When the answer was written. */
  at: string;
  /** Looked up when the export opens. */
  turn?: () => Promise<ShareTurn>;
}

/** What a conversation lends an export started inside it: its name, and the turn an answer belongs to. */
export interface ShareSession {
  title: string;
  backendId?: NativeBackendId;
  projectName?: string;
  /** The turn of the last prompt sent at or before [at]; without [at], only the conversation's model. */
  turnBefore: (at: string | undefined) => ShareTurn;
}
export const ShareSessionContext = createContext<ShareSession | undefined>(undefined);

/** A model selection value as people read it: the catalog's name when there is one, else the bare id. */
export function shareModelName(value: string | undefined, catalog?: readonly ModelInfo[]): string | undefined {
  if (!value) return undefined;
  const id = parseSelection(value).model;
  return cleanLabel(catalog?.find((item) => item.value === id)?.name ?? id) || undefined;
}

/**
 * 导出为图片 for an answer in a conversation: whether it is offered, and the dialog to render
 * where it survives the menu that opened it closing.
 */
export function useAnswerShare(text: string | undefined, at: string | undefined) {
  const session = useContext(ShareSessionContext);
  const [open, setOpen] = useState(false);
  const source = useMemo<ShareSource | undefined>(() => session && text?.trim() ? {
    kind: 'message', text, title: session.title, at: at ?? new Date().toISOString(),
    ...(session.backendId ? { backendId: session.backendId } : {}),
    ...(session.projectName ? { projectName: session.projectName } : {}),
    turn: async () => session.turnBefore(at),
  } : undefined, [session, text, at]);
  return { available: Boolean(source), open: () => setOpen(true), dialog: source ? <ShareImageDialog source={source} open={open} onOpenChange={setOpen} /> : null };
}

type Theme = 'paper' | 'ink' | 'theme';
type Font = 'sans' | 'serif';
type Width = 'auto' | 'narrow' | 'wide';
/** Where the picture came from, each shown or not on its own. */
type Meta = 'title' | 'agent' | 'model' | 'project' | 'date';
const META: Meta[] = ['title', 'agent', 'model', 'project', 'date'];
type MetaShown = Record<Meta, boolean>;
interface Prefs { theme: Theme; font: Font; width: Width; meta: MetaShown }

const PREFS_KEY = 'riffet.shareImage';
const ALL_META: MetaShown = { title: true, agent: true, model: true, project: true, date: true };
const DEFAULT_PREFS: Prefs = { theme: 'paper', font: 'sans', width: 'auto', meta: ALL_META };
/** A longer answer is cut at a paragraph: a picture is for reading, not for archiving. */
const MAX_CHARS = 3000;
/** Past this height the canvas fails in Safari; the picture is drawn at a lower density instead. */
const MAX_PIXELS_TALL = 16384;
/** Code lines longer than this fold awkwardly in the narrow card. */
const NARROW_CODE_CHARS = 60;

function readPrefs(): Prefs {
  try {
    const saved = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? 'null') as (Partial<Omit<Prefs, 'meta'>> & { meta?: Partial<MetaShown>; source?: boolean }) | null;
    if (!saved || typeof saved !== 'object') return DEFAULT_PREFS;
    // `source` was one switch for all of them.
    const fallback = saved.source !== false;
    const meta = Object.fromEntries(META.map((key) => [key, typeof saved.meta?.[key] === 'boolean' ? saved.meta[key] : fallback])) as MetaShown;
    return {
      theme: saved.theme === 'ink' || saved.theme === 'theme' ? saved.theme : 'paper',
      font: saved.font === 'serif' ? 'serif' : 'sans',
      width: saved.width === 'narrow' || saved.width === 'wide' ? saved.width : 'auto',
      meta,
    };
  } catch { return DEFAULT_PREFS; }
}
function writePrefs(prefs: Prefs) {
  try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* Storage may be unavailable. */ }
}

/** A table, or code too wide for the narrow card, asks for the wide one. */
export function prefersWide(markdown: string): boolean {
  if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/m.test(markdown)) return true;
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced && line.length > NARROW_CODE_CHARS) return true;
  }
  return false;
}

/**
 * The answer cut to [MAX_CHARS] at a paragraph, with a fence the cut leaves open closed; `total`
 * (its length to the nearest hundred characters) is set only when something was cut.
 */
export function shareExcerpt(text: string): { source: string; total?: number } {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_CHARS) return { source: trimmed };
  const head = trimmed.slice(0, MAX_CHARS);
  let end = head.lastIndexOf('\n\n');
  if (end < MAX_CHARS / 3) end = head.lastIndexOf('\n');
  if (end < MAX_CHARS / 3) end = MAX_CHARS;
  let source = head.slice(0, end).trimEnd();
  if ((source.match(/^\s*```/gm)?.length ?? 0) % 2 === 1) source += '\n```';
  return { source, total: Math.round(trimmed.replace(/\s/g, '').length / 100) * 100 };
}

const quoteTier = (length: number) => length <= 60 ? 'l' : length <= 160 ? 'm' : 's';
const pad = (value: number) => String(value).padStart(2, '0');
function formatDay(value: string): string {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? '' : formatDate(at, { year: 'numeric', month: 'long', day: 'numeric' });
}
function fileName(title: string, fallback: string): string {
  const now = new Date();
  // eslint-disable-next-line no-control-regex
  const name = title.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, 40) || fallback;
  return `Riffet-${name}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.png`;
}

function Wordmark() {
  return (
    <svg viewBox="-1.6 0 67.2 22" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" aria-label="Riffet" role="img">
      <path d="M0 20V2h5a4.5 4.5 0 0 1 0 9H0M3.6 11l6.4 9" />
      <path d="M15.4 8v12" />
      <circle cx="15.4" cy="2.6" r="1.736" fill="currentColor" stroke="none" />
      <path d="M23 20V6a4 4 0 0 1 4-4M20.8 8h4.4" />
      <path d="M32.8 20V6a4 4 0 0 1 4-4M30.6 8h4.4" />
      <path d="M40.4 14h12a6 6 0 1 0-1.76 4.24" />
      <path d="M60 2v14a4 4 0 0 0 4 4M57.8 8h4.4" />
    </svg>
  );
}

/**
 * A passage cut from its answer as rendered: the blocks it runs across, each trimmed to the part
 * selected, or, when it is one paragraph and nothing more (`plain`), what is inside that paragraph. `wide` when it
 * holds a table or a long code line.
 */
export interface SharePassage { nodes: DocumentFragment; plain: boolean; wide: boolean; length: number }

function passageOf(range: Range, root: Element): SharePassage {
  let nodes = range.cloneContents();
  // A passage inside one block comes out as bare inline content; give it back the blocks it was in.
  const common = range.commonAncestorContainer;
  for (let element = common instanceof Element ? common : common.parentElement; element && element !== root && root.contains(element); element = element.parentElement) {
    const shell = element.cloneNode(false) as Element;
    shell.append(nodes);
    nodes = document.createDocumentFragment();
    nodes.append(shell);
  }
  // A list taken up part-way keeps its numbers.
  const starts: number[] = [];
  const first = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  for (let element = first; element && element !== root; element = element.parentElement) {
    const list = element.parentElement;
    if (element.tagName === 'LI' && list?.tagName === 'OL') starts.unshift(Number(list.getAttribute('start') ?? 1) + [...list.children].indexOf(element));
  }
  for (let element = nodes.firstElementChild, index = 0; element && index < starts.length; element = element.firstElementChild) {
    if (element.tagName === 'OL') element.setAttribute('start', String(starts[index++]));
  }
  for (const element of nodes.querySelectorAll('[id]')) element.removeAttribute('id');
  const blocks = [...nodes.children];
  const plain = blocks.length === 1 && blocks[0]!.tagName === 'P' && !blocks[0]!.querySelector('p, pre, ul, ol, table, blockquote, h1, h2, h3, h4, h5, h6, img');
  const wide = Boolean(nodes.querySelector('table')) || [...nodes.querySelectorAll('pre')].some((pre) => (pre.textContent ?? '').split('\n').some((line) => line.length > NARROW_CODE_CHARS));
  const length = [...(nodes.textContent ?? '').trim()].length;
  if (plain) {
    // One paragraph is set as a quote: only what is inside it.
    const inline = document.createDocumentFragment();
    inline.append(...blocks[0]!.childNodes);
    nodes = inline;
  }
  return { nodes, plain, wide, length };
}

/**
 * The passage of [answer] with its Markdown, found again in a hidden rendering of the whole answer;
 * `undefined` while that renders or when the passage is not in it. `source` must be mounted for it to be found.
 */
export function useSharePassage(answer: ShareSource['answer']) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [passage, setPassage] = useState<SharePassage>();
  useEffect(() => {
    if (!host || !answer) { setPassage(undefined); return; }
    let timer: number | undefined;
    const extract = () => {
      timer = undefined;
      const root = host.querySelector('.md') ?? host;
      const at = findQuote(root.textContent ?? '', answer.quote);
      const range = at && rangeAt(root, at.start, at.end);
      setPassage(range ? passageOf(range, root) : undefined);
    };
    extract();
    // Highlighted code and math arrive after the first render.
    const observer = new MutationObserver(() => { window.clearTimeout(timer); timer = window.setTimeout(extract, 60); });
    observer.observe(host, { childList: true, subtree: true, characterData: true });
    return () => { observer.disconnect(); window.clearTimeout(timer); };
  }, [host, answer]);
  const source = answer ? (
    <div ref={setHost} hidden aria-hidden>
      <PrintRenderingContext.Provider value><Markdown text={answer.markdown} /></PrintRenderingContext.Provider>
    </div>
  ) : null;
  return { passage, source };
}

/** Nodes React does not own, copied in afresh whenever they change. */
function Nodes({ nodes, className, as: Tag = 'div' }: { nodes: Node; className?: string; as?: 'div' | 'p' }) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => { ref.current?.replaceChildren(nodes.cloneNode(true)); }, [nodes]);
  return <Tag ref={ref as Ref<never>} className={className} />;
}

/** What a picture can say about where it came from; an item without a value is left out. */
export interface ShareMeta { title?: string; agent?: string; model?: string; project?: string; date?: string }

/** The picture itself, at 1×; every measure is in `styles/index.css` under `.share-card`. */
export function ShareCard({ source, passage, wide, theme, font, meta, prompt, note, ref }: {
  source: ShareSource; passage?: SharePassage; wide: boolean; theme: Theme; font: Font; meta: ShareMeta; prompt?: string; note?: string; ref?: Ref<HTMLDivElement>;
}) {
  const { t } = useLingui();
  const span = source.kind === 'span';
  const excerpt = useMemo(() => span ? undefined : shareExcerpt(source.text), [span, source.text]);
  const quote = span ? source.text.trim() : '';
  const sub = [
    meta.agent, meta.model, meta.project, meta.date,
    excerpt?.total ? t`节选 · 全文约 ${formatNumber(excerpt.total)} 字` : undefined,
  ].filter(Boolean);
  const bare = !meta.title && sub.length === 0;
  return (
    <div ref={ref} data-mark={span ? source.color : undefined} className={cn('share-card', `share-${theme}`, wide && 'share-wide', font === 'serif' && 'share-serif')}>
      <div className="share-sheet">
        {prompt && <div className="share-ask"><div className="share-label"><Trans>提问</Trans></div><p className="share-text">{prompt}</p></div>}
        {span ? (
          <>
            <div aria-hidden className="share-qmark">“</div>
            {passage?.plain
              ? <Nodes as="p" nodes={passage.nodes} className={cn('share-quote share-quote-rich share-text', `share-quote-${quoteTier(passage.length)}`)} />
              : passage
                ? <Nodes nodes={passage.nodes} className="md share-md share-text" />
                : <p className={cn('share-quote share-text', `share-quote-${quoteTier([...quote].length)}`)}>{quote}</p>}
          </>
        ) : (
          <>
            <Markdown text={excerpt!.source} className="share-md share-text" />
            {excerpt!.total !== undefined && <div aria-hidden className="share-more">……</div>}
          </>
        )}
        {note && <div className="share-note"><div className="share-label"><Trans>批注</Trans></div><p className="share-text">{note}</p></div>}
        <footer className={cn('share-foot', bare && 'share-foot-bare')}>
          {!bare && (
            <div className="share-meta">
              {meta.title && <div className="share-title">{meta.title}</div>}
              {sub.length > 0 && <div className="share-sub">{sub.map((part, index) => <Fragment key={index}>{index > 0 && <i>·</i>}{part}</Fragment>)}</div>}
            </div>
          )}
          <Wordmark />
        </footer>
      </div>
    </div>
  );
}

function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className={cn('flex min-h-6 items-center justify-between gap-3', disabled ? 'cursor-not-allowed' : 'cursor-pointer')}>
      <span className={cn('min-w-0 truncate text-sm', disabled ? 'text-fg-4' : 'text-fg-2')}>{label}</span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={label} />
    </label>
  );
}

/** Watches [element]'s border box. */
function useSize(element: HTMLElement | null) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(() => setSize({ width: element.offsetWidth, height: element.offsetHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return size;
}

/**
 * 导出图片: the card as it will be saved, beside the few choices that change it. The narrow card
 * is drawn at 3× and the wide one at 2×, so both come out about 1440 px across.
 */
export function ShareImageDialog({ source, open, onOpenChange }: { source: ShareSource; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="workspace" mobileFullscreen aria-describedby={undefined} className="h-[min(760px,calc(100dvh-32px))] overflow-hidden md:flex-row">
        <ShareImageContents source={source} open={open} />
      </DialogContent>
    </Dialog>
  );
}

function ShareImageContents({ source, open }: { source: ShareSource; open: boolean }) {
  const { t } = useLingui();
  const [prefs, setPrefs] = useState(readPrefs);
  const [showPrompt, setShowPrompt] = useState(false);
  const [showNote, setShowNote] = useState(false);
  /** undefined while it is looked up. */
  const [turn, setTurn] = useState<ShareTurn>();
  const [busy, setBusy] = useState(false);
  const label = useBackendLabel();
  const { passage, source: passageSource } = useSharePassage(source.answer);
  const [card, setCard] = useState<HTMLDivElement | null>(null);
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const size = useSize(card);
  const stageSize = useSize(stage);

  useEffect(() => {
    if (!open) return;
    if (!source.turn) { setTurn({}); return; }
    let live = true;
    setTurn(undefined);
    source.turn().then((found) => { if (live) setTurn({ ...(found.prompt?.trim() ? { prompt: found.prompt.trim() } : {}), ...(found.model ? { model: found.model } : {}) }); }, () => { if (live) setTurn({}); });
    return () => { live = false; };
  }, [open, source]);

  const update = (patch: Partial<Prefs>) => setPrefs((current) => { const next = { ...current, ...patch }; writePrefs(next); return next; });
  const shown = useMemo(() => source.kind === 'message' ? shareExcerpt(source.text).source : '', [source]);
  const wide = prefs.width === 'wide' || (prefs.width === 'auto' && (source.kind === 'message' ? prefersWide(shown) : Boolean(passage?.wide)));
  const density = wide ? 2 : 3;
  const scale = size.height ? Math.min(density, Math.floor((MAX_PIXELS_TALL / size.height) * 100) / 100) : density;
  const fit = size.width && stageSize.width ? Math.min(1, (stageSize.width - 48) / size.width) : 1;
  const render = async (node: HTMLElement) => (await import('modern-screenshot')).domToBlob(node, { scale, type: 'image/png' });

  const copy = () => {
    if (!card) return;
    if (!window.isSecureContext || !navigator.clipboard?.write || typeof ClipboardItem === 'undefined') { toast.error(t`当前连接不支持复制图片，请改用保存`); return; }
    setBusy(true);
    // Safari keeps the clipboard write only if it starts inside the click, so it is handed the pending image.
    navigator.clipboard.write([new ClipboardItem({ 'image/png': render(card) })])
      .then(() => toast.success(t`已复制图片`), (error: unknown) => toast.error(errorMessage(error, t`无法复制图片`)))
      .finally(() => setBusy(false));
  };
  const save = async () => {
    if (!card) return;
    setBusy(true);
    try {
      const blob = await render(card);
      const file = new File([blob], fileName(source.title, t`收藏`), { type: 'image/png' });
      // A phone saves pictures through its share sheet; a download there lands among files.
      if (window.matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file] }); return; }
        catch (error) { if (error instanceof DOMException && error.name === 'AbortError') return; }
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) { toast.error(errorMessage(error, t`无法生成图片`)); }
    finally { setBusy(false); }
  };

  const message = source.kind === 'message';
  const prompt = message ? turn?.prompt : undefined;
  const values: ShareMeta = {
    title: source.title,
    ...(source.backendId ? { agent: label(source.backendId) } : {}),
    ...(turn?.model ? { model: turn.model } : {}),
    ...(source.projectName ? { project: source.projectName } : {}),
    ...(formatDay(source.at) ? { date: formatDay(source.at) } : {}),
  };
  const meta: ShareMeta = Object.fromEntries(META.filter((key) => prefs.meta[key] && values[key]).map((key) => [key, values[key]]));
  const metaLabels: Record<Meta, string> = { title: t({ message: '会话标题', context: 'share-image-meta' }), agent: 'Agent', model: t`模型`, project: t`项目`, date: t`日期` };
  // The model is still being looked up: its switch waits rather than appearing late.
  const metaRows = META.filter((key) => values[key] || (key === 'model' && turn === undefined));
  return (
    <>
        {passageSource}
        <div ref={setStage} className={cn('min-h-0 flex-1 overflow-auto px-6 py-8 md:py-10', prefs.theme === 'ink' ? 'share-stage-ink' : prefs.theme === 'paper' ? 'share-stage-paper' : 'bg-muted')}>
          <div className="mx-auto" style={{ width: size.width * fit, height: size.height * fit }}>
            <div className="w-max origin-top-left" style={{ transform: `scale(${fit})` }}>
              <ShareCard
                ref={setCard}
                source={source}
                wide={wide}
                theme={prefs.theme}
                font={prefs.font}
                meta={meta}
                {...(passage ? { passage } : {})}
                {...(showPrompt && prompt ? { prompt } : {})}
                {...(showNote && source.note ? { note: source.note } : {})}
              />
            </div>
          </div>
        </div>
        <aside className="flex max-h-[45dvh] w-full shrink-0 flex-col border-t border-line md:max-h-none md:w-72 md:border-l md:border-t-0">
          <div className="flex h-13 shrink-0 items-center px-5"><DialogTitle className="text-base"><Trans>导出图片</Trans></DialogTitle></div>
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 pb-4">
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium text-fg-3"><Trans>主题</Trans></span>
              <Segmented<Theme> value={prefs.theme} onChange={(theme) => update({ theme })} ariaLabel={t`主题`} options={[{ value: 'paper', label: t`纸白` }, { value: 'ink', label: t`墨黑` }, { value: 'theme', label: t`跟随主题` }]} />
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium text-fg-3"><Trans>字体</Trans></span>
              <Segmented<Font> value={prefs.font} onChange={(font) => update({ font })} ariaLabel={t`字体`} options={[{ value: 'sans', label: t`黑体` }, { value: 'serif', label: t`宋体` }]} />
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium text-fg-3"><Trans>宽度</Trans></span>
              <Segmented<Width> value={prefs.width} onChange={(width) => update({ width })} ariaLabel={t`宽度`} options={[{ value: 'auto', label: t`自动` }, { value: 'narrow', label: t`竖版` }, { value: 'wide', label: t`宽版` }]} />
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium text-fg-3"><Trans>显示</Trans></span>
              <div className="flex flex-col gap-2.5">
                {message && (prompt || turn === undefined) && <Toggle label={t`提问`} checked={showPrompt && Boolean(prompt)} disabled={!prompt} onChange={setShowPrompt} />}
                {source.note && <Toggle label={t`批注`} checked={showNote} onChange={setShowNote} />}
                {metaRows.map((key) => (
                  <Toggle key={key} label={metaLabels[key]} checked={prefs.meta[key] && Boolean(values[key])} disabled={!values[key]} onChange={(value) => update({ meta: { ...prefs.meta, [key]: value } })} />
                ))}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 flex-col gap-2.5 border-t border-line px-5 py-4">
            <span className="text-xs tabular-nums text-fg-4">
              {size.width ? `${Math.round(size.width * scale)} × ${Math.round(size.height * scale)} px · PNG · ${scale}×` : '\u00a0'}
            </span>
            <div className="flex gap-2">
              <Button className="flex-1" disabled={busy || !card} onClick={() => void save()}><IconDownload className="size-3.5" /><Trans>保存 PNG</Trans></Button>
              <Button variant="primary" className="flex-1" disabled={!card} onClick={copy} busy={busy}><IconCopy className="size-3.5" /><Trans>复制图片</Trans></Button>
            </div>
          </div>
        </aside>
    </>
  );
}
