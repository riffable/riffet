import { memo, useMemo, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  IconChevronRight, IconCircle, IconCircleAlert, IconCircleCheck, IconCircleDashed,
  IconDownload, IconListTodo, IconSquareArrowOutUpRight, IconX,
} from '@/components/icons';
import type { OutputRate } from '@contracts';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { CopyButton } from '@/components/ui/copy-button';
import { Tip } from '@/components/ui/tooltip';
import { downloadProjectFile, projectFileUrl } from '@/lib/files';
import { formatDuration } from '@/lib/format-duration';
import { formatNumber } from '@/lib/i18n/format';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import { CODE_PADDING, CODE_TEXT } from './codeSurface';
import { previewOnPlainClick, useFileAccess } from './fileAccess';
import { FailureDetails } from './FailureDetails';
import { ZoomableImage } from './ImageViewer';
import { lineDiff } from './lineDiff';
import { useRemembered } from './rememberedState';
import { outputRateDescription, outputTokensPerSecond, formatTokensPerSecond } from './speed';
import { useTranscriptResources } from './transcriptResources';

export function Disclosure({ icon, title, detail, inline, status, open, onToggle, children, expandable = true, tone, failed = false, opensPage, touchCompact = false }: {
  icon: ReactNode; title: ReactNode; detail?: ReactNode;
  /** Content that belongs with the title (a tool's diff counts): after the detail, ahead of the chevron. The row's state stays in `status`, at the right edge. */
  inline?: ReactNode;
  status?: ReactNode; open: boolean; onToggle: () => void; children?: ReactNode; expandable?: boolean; tone?: 'danger';
  /** Quiet failure state (icon-only tint): keeps the hover/open chevron tinted and exposes an accessible label. */
  failed?: boolean;
  /** The row leads to its own page (a subagent's transcript) instead of folding out. */
  opensPage?: boolean;
  touchCompact?: boolean;
}) {
  if (opensPage) {
    return (
      <button
        type="button"
        data-slot="disclosure"
        onClick={onToggle}
        className={cn('group/row flex min-h-[calc(24px*var(--text-scale))] w-full min-w-0 items-center gap-2 rounded-md text-left text-sm text-fg-3 transition-colors hover:text-fg-2', touchCompact ? 'no-hover:min-h-9' : 'no-hover:min-h-11', tone === 'danger' && 'text-danger hover:text-danger')}
      >
        <span className="grid size-4 shrink-0 place-items-center text-fg-4 [&_svg]:size-[15px]">{icon}</span>
        {failed && <span className="sr-only"><Trans>失败</Trans></span>}
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn('min-w-0 truncate', detail && 'max-w-[70%] shrink-0')}>{title}</span>
            {detail && (typeof detail === 'string'
              ? <span className="min-w-0 truncate font-mono text-xs text-fg-3">{detail}</span>
              : <span className="flex min-w-0 items-center gap-1.5 overflow-hidden font-mono text-xs text-fg-2">{detail}</span>)}
          </span>
          {inline}
          <IconChevronRight className="size-3.5 shrink-0 text-fg-4 transition-[opacity,transform] duration-[var(--duration-base)] can-hover:opacity-0 can-hover:group-hover/row:translate-x-0.5 can-hover:group-hover/row:opacity-100" />
        </span>
        {status && <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">{status}</span>}
      </button>
    );
  }
  const Header = expandable ? 'button' : 'div';
  return (
    <div className="flex min-w-0 flex-col">
      <Header
        {...(expandable ? { type: 'button' as const, 'aria-expanded': open, onClick: onToggle } : {})}
        data-slot="disclosure"
        className={cn('group/row flex min-h-[calc(24px*var(--text-scale))] w-full min-w-0 items-center gap-2 rounded-md text-left text-sm text-fg-3 transition-colors', touchCompact ? 'no-hover:min-h-9' : 'no-hover:min-h-11', expandable && 'hover:text-fg-2', tone === 'danger' && 'text-danger hover:text-danger')}
      >
        {/* On a pointer device the leading icon swaps to the chevron on hover, which keeps an idle
            row down to one glyph. A touch screen never reaches that state, so there the chevron is
            permanent instead — and it follows the content (title, detail, inline counts) rather
            than pinning to the right edge, the way the Mac row's hover chevron does. The row's
            state in `status` keeps the right edge. */}
        <span className="relative grid size-4 shrink-0 place-items-center [&_svg]:size-[15px]">
          <span className={cn('grid place-items-center text-fg-4 transition-opacity', expandable && 'can-hover:group-hover/row:opacity-0', open && expandable && 'can-hover:opacity-0')}>{icon}</span>
          {expandable && <IconChevronRight className={cn('absolute hidden opacity-0 transition-[opacity,transform] duration-[var(--duration-base)] ease-out-soft can-hover:block group-hover/row:opacity-100', open && 'rotate-90 opacity-100', failed && 'text-danger')} />}
        </span>
        {failed && <span className="sr-only"><Trans>失败</Trans></span>}
        {/* Budget text after the fixed icon and status, then share that space with the chevron.
            A title's 70% cap must use this remainder, not the width of the whole row. */}
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn('min-w-0 truncate', detail && 'max-w-[70%] shrink-0')}>{title}</span>
            {detail && (typeof detail === 'string'
              ? <span className="min-w-0 truncate font-mono text-xs text-fg-3">{detail}</span>
              : <span className="flex min-w-0 items-center gap-1.5 overflow-hidden font-mono text-xs text-fg-2">{detail}</span>)}
          </span>
          {inline}
          {expandable && <IconChevronRight className={cn('hidden size-3.5 shrink-0 text-fg-4 transition-transform duration-[var(--duration-base)] ease-out-soft no-hover:block', open && 'rotate-90')} />}
        </span>
        {status && <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">{status}</span>}
      </Header>
      {expandable && children && (
        <Collapse open={open}>
          <div className="ml-2 mt-0.5 mb-1.5 flex min-w-0 flex-col gap-2 edge-l pl-4 pt-0.5">{children}</div>
        </Collapse>
      )}
    </div>
  );
}

const CLIP_EDGE_LINES = 200;
const CLIP_EDGE_CHARS = 40_000;

/**
 * The head and tail of an output too long to lay out whole. The box only shows a few hundred
 * pixels of it anyway, and a log of tens of thousands of lines costs the whole transcript its
 * layout; the middle stays one click away.
 */
function clipOutput(text: string): { head: string; tail: string; hiddenLines: number } | undefined {
  let lines = 1;
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) lines += 1;
  if (lines > CLIP_EDGE_LINES * 2 + 50) {
    let headEnd = 0;
    for (let count = 0; count < CLIP_EDGE_LINES; count += 1) headEnd = text.indexOf('\n', headEnd) + 1;
    let tailStart = text.length;
    for (let count = 0; count < CLIP_EDGE_LINES; count += 1) tailStart = text.lastIndexOf('\n', tailStart - 1);
    const head = text.slice(0, headEnd).slice(0, CLIP_EDGE_CHARS);
    const tail = text.slice(tailStart + 1).slice(-CLIP_EDGE_CHARS);
    return { head, tail, hiddenLines: lines - CLIP_EDGE_LINES * 2 };
  }
  if (text.length > CLIP_EDGE_CHARS * 2 + 10_000) return { head: text.slice(0, CLIP_EDGE_CHARS), tail: text.slice(-CLIP_EDGE_CHARS), hiddenLines: 0 };
  return undefined;
}

/**
 * [copy] is the whole text the block stands for, offered from its corner: an output too long to lay
 * out shows only its ends, and a command block starts with a prompt sign that is not the command.
 * [remember] names the block's expansion within its row, so two blocks in one row need two names.
 */
export function CodeBlock({ children, className, maxHeight = 'max-h-72', copy, remember = 'code' }: { children: ReactNode; className?: string; maxHeight?: string; copy?: string; remember?: string }) {
  const { t } = useLingui();
  const [full, setFull] = useRemembered(`${remember}:full`, false);
  const clip = useMemo(() => (typeof children === 'string' ? clipOutput(children) : undefined), [children]);
  // The copy button keeps a corner of its own rather than covering the end of the first line.
  const pre = cn('overflow-auto rounded-lg bg-subtle text-fg-2 whitespace-pre-wrap break-words', CODE_PADDING, CODE_TEXT, copy && 'pr-9 no-hover:min-h-11 no-hover:pr-12', maxHeight, className);
  const block = !clip || full ? <pre className={pre}>{children}</pre> : (
    <pre className={pre}>
      {clip.head}
      <button type="button" onClick={() => setFull(true)} className="my-1 block rounded-md bg-hover px-2 py-0.5 font-sans text-2xs text-fg-3 hover:text-fg-2 no-hover:min-h-11">
        {clip.hiddenLines > 0 ? t`省略 ${formatNumber(clip.hiddenLines)} 行 · 展开全部` : t`中间部分已省略 · 展开全部`}
      </button>
      {clip.tail}
    </pre>
  );
  if (!copy) return block;
  return (
    <div className="group/codeblock relative min-w-0">
      {block}
      <CopyButton text={copy} className="absolute right-1 top-1 opacity-0 group-hover/codeblock:opacity-100 focus-visible:opacity-100 no-hover:right-0 no-hover:top-0 no-hover:opacity-100" />
    </div>
  );
}

const DIFF_ROW: Record<'same' | 'add' | 'del', { row: string; gutter: string; sign: string }> = {
  same: { row: '', gutter: 'text-fg-4', sign: 'text-fg-4' },
  add: { row: 'bg-[var(--diff-add)]', gutter: 'bg-[var(--diff-add-gutter)] text-[var(--diff-add-marker)]', sign: 'text-[var(--diff-add-marker)]' },
  del: { row: 'bg-[var(--diff-del)]', gutter: 'bg-[var(--diff-del-gutter)] text-[var(--diff-del-marker)]', sign: 'text-[var(--diff-del-marker)]' },
};

/**
 * Rows a diff card lays out before it folds the rest. The card scrolls inside a few hundred pixels,
 * and a rewrite of a long file would otherwise mount every row into the transcript at once.
 */
const DIFF_PREVIEW_LINES = 300;

export function DiffView({ path, nameOnly, before, after, lineOffset, newLineOffset, trailingLines, onOpenPath, onOpenInEditor, outside, remember = 'diff' }: { path?: string; /** The row above already spells the path out; the card names the file alone. */ nameOnly?: boolean; before: string; after: string; lineOffset?: number; newLineOffset?: number; trailingLines?: number; onOpenPath?: (path: string) => void; onOpenInEditor?: (path: string) => void; outside?: boolean; remember?: string }) {
  const { t } = useLingui();
  const resources = useTranscriptResources();
  const canOpen = !resources || Boolean(path && resources.resources[path]);
  const diff = useMemo(() => lineDiff(before, after, 3, lineOffset, trailingLines, newLineOffset ?? lineOffset), [before, after, lineOffset, newLineOffset, trailingLines]);
  const [expanded, setExpanded] = useRemembered(`${remember}:all`, false);
  const hiddenLines = diff && !expanded ? Math.max(0, diff.lines.length - DIFF_PREVIEW_LINES) : 0;
  const shownLines = diff ? (hiddenLines ? diff.lines.slice(0, DIFF_PREVIEW_LINES) : diff.lines) : [];
  // Prose is read, not scanned by column: its lines run to a paragraph each, so they fold instead of scrolling sideways.
  const wrap = Boolean(path && /\.(md|mdx|mdc|markdown|txt|rst)$/i.test(path));
  // A file that did not exist has no old line numbers to show.
  const created = !before;
  const stats = (diff || created) && (
    <span className="ml-1 flex shrink-0 items-center gap-1.5 font-mono tabular-nums">
      {created && <span className="font-sans text-fg-3"><Trans>新文件</Trans></span>}
      {diff && diff.added > 0 && <span className="text-[var(--diff-add-marker)]">+{diff.added}</span>}
      {diff && diff.removed > 0 && <span className="text-[var(--diff-del-marker)]">−{diff.removed}</span>}
    </span>
  );
  return (
    <div className="overflow-hidden rounded-lg bg-subtle">
      <div className="flex min-h-8 items-center gap-2 edge-b bg-subtle px-3 text-xs no-hover:min-h-11">
        {path ? (
          <span className="group/diffpath flex min-w-0 flex-1 items-center gap-1 max-md:flex-wrap">
            <PathLink path={path} canOpen={canOpen} onOpenPath={onOpenPath} className="flex min-h-8 min-w-0 items-center font-mono text-fg-2 max-md:w-full max-md:text-left no-hover:min-h-11" title={canOpen ? outside ? t`项目目录之外，只读预览 ${path}` : t`在右侧预览 ${path}` : path}><PathText path={nameOnly ? path.slice(path.lastIndexOf('/') + 1) : path} /></PathLink>
            {stats}
            <CopyButton text={path} label={t`复制路径`} className={cn(pathActionClass, 'opacity-0 group-hover/diffpath:opacity-100')} />
            <FileDownloadButton path={path} className="opacity-0 group-hover/diffpath:opacity-100" />
            {onOpenInEditor && <PathEditButton onClick={() => onOpenInEditor(path)} className="opacity-0 group-hover/diffpath:opacity-100 focus-visible:opacity-100" />}
          </span>
        ) : <span className="flex items-center gap-1 text-fg-3"><Trans>文件变更</Trans>{stats}</span>}
      </div>
      {diff ? (
        <div className="max-h-80 overflow-auto py-1 font-mono text-xs leading-[18px]">
          {/* One box as wide as the longest line, so every row's tint runs the full scroll width. */}
          <div className={wrap ? undefined : 'w-max min-w-full'}>
            {shownLines.map((line, index) => line.type === 'gap' ? (
              <div key={index} className="my-0.5 bg-subtle px-3 py-0.5 font-sans text-2xs text-fg-3">{line.text}</div>
            ) : (
              <div key={index} className={cn('flex', DIFF_ROW[line.type].row)}>
                <span className={cn('sticky left-0 flex shrink-0 select-none', line.type === 'same' ? 'bg-subtle' : DIFF_ROW[line.type].row)}>
                  {!created && <span className={cn('w-9 shrink-0 pr-2 text-right', DIFF_ROW[line.type].gutter)}>{line.type === 'add' ? '' : line.oldNo}</span>}
                  <span className={cn('w-9 shrink-0 pr-2 text-right', DIFF_ROW[line.type].gutter)}>{line.type === 'del' ? '' : line.newNo}</span>
                  <span className={cn('w-5 shrink-0 text-center', DIFF_ROW[line.type].sign)}>{line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '}</span>
                </span>
                <span className={cn('pr-4', wrap ? 'min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre', line.type === 'same' ? 'text-fg-2' : 'text-fg')}>{line.text || ' '}</span>
              </div>
            ))}
          </div>
          {hiddenLines > 0 && (
            <button type="button" onClick={() => setExpanded(true)} className="mx-3 my-1 block rounded-md bg-hover px-2 py-0.5 font-sans text-2xs text-fg-3 hover:text-fg-2 no-hover:min-h-11">
              {t`省略 ${formatNumber(hiddenLines)} 行 · 展开全部`}
            </button>
          )}
        </div>
      ) : <CodeBlock className="rounded-none border-0" maxHeight="max-h-80" copy={after} remember={`${remember}:file`}>{after}</CodeBlock>}
    </div>
  );
}

/**
 * A path set so the file it names is never the part that gets cut: the directory steps back and
 * gives up its tail when the row is short.
 */
function PathText({ path }: { path: string }) {
  const slash = path.lastIndexOf('/');
  if (slash <= 0) return <span className="min-w-0 truncate">{path}</span>;
  return <><span className="min-w-0 truncate text-fg-4">{path.slice(0, slash)}</span><span className="shrink-0 text-fg-4">/</span><span className="max-w-full shrink-0 truncate">{path.slice(slash + 1)}</span></>;
}

/**
 * Filename-only path display for tool rows (hover tooltip & expanded details carry the full path),
 * keeping dense read/edit streaks scannable without a wall of repeated directory prefixes.
 */
export function ToolPathText({ path }: { path: string }) {
  const clean = path.replace(/\/+$/, '');
  const slash = clean.lastIndexOf('/');
  const name = slash <= 0 ? (clean || path) : clean.slice(slash + 1);
  return <Tip label={path}><span className="min-w-0 truncate text-fg-2">{name}</span></Tip>;
}

/**
 * A path in a tool row. In a project it links to the file itself, so a plain click previews it on the
 * right and a modified or middle click opens it in a tab; a shared transcript keeps a plain button.
 */
export function PathLink({ path, line, canOpen = true, onOpenPath, className, quiet = false, title, children }: {
  path: string; line?: number | undefined; canOpen?: boolean;
  onOpenPath?: ((path: string, line?: number) => void) | undefined;
  className: string; quiet?: boolean; title?: string; children: ReactNode;
}) {
  const files = useFileAccess();
  const resources = useTranscriptResources();
  if (files && !resources && onOpenPath) {
    return <a href={projectFileUrl(files.projectId, path)} target="_blank" rel="noopener" onClick={previewOnPlainClick(onOpenPath, path, line)} className={cn(className, quiet ? 'hover:text-fg-2' : 'hover:text-accent')} title={title}>{children}</a>;
  }
  return <button type="button" disabled={!canOpen || !onOpenPath} onClick={() => onOpenPath?.(path, line)} className={cn(className, quiet ? 'enabled:hover:text-fg-2' : 'enabled:hover:text-accent', 'disabled:cursor-text')} title={title}>{children}</button>;
}

/** Copy, download and open-in-editor beside a path: one size, one colour. */
export const pathActionClass = 'grid size-5 shrink-0 place-items-center rounded-md px-0 text-fg-3 transition-colors hover:bg-hover hover:text-fg focus-visible:opacity-100 no-hover:size-11 no-hover:opacity-100 [&_svg]:size-3.5';

export function FileDownloadButton({ path, className }: { path: string; className?: string }) {
  const { t } = useLingui();
  const files = useFileAccess();
  const resources = useTranscriptResources();
  const resource = resources?.resources[path];
  if (resources) return resource ? <a href={resource.url} download={resource.name} aria-label={t`下载文件`} title={t`下载文件`} className={cn(pathActionClass, className)}><IconDownload /></a> : null;
  if (!files) return null;
  return (
    <button
      type="button"
      aria-label={t`下载文件`}
      title={t`下载文件`}
      onClick={() => downloadProjectFile(files.projectId, path)}
      className={cn(pathActionClass, className)}
    >
      <IconDownload />
    </button>
  );
}

export function PathEditButton({ onClick, className }: { onClick: () => void; className?: string }) {
  const { t } = useLingui();
  return (
    <button
      type="button"
      aria-label={t`在编辑器中打开`}
      title={t`在编辑器中打开`}
      onClick={onClick}
      className={cn(pathActionClass, className)}
    >
      <IconSquareArrowOutUpRight />
    </button>
  );
}

// motion-loop: the step in progress turns; the global reduced-motion rule stops it
const planIcon = (status: unknown) => status === 'completed' ? <IconCircleCheck className="size-4 text-success" /> : status === 'cancelled' ? <IconX className="size-4 text-fg-4" /> : status === 'in_progress' ? <IconCircleDashed className="size-4 animate-[spin_3s_linear_infinite] text-accent" /> : <IconCircle className="size-4 text-fg-4" />;

export function PlanList({ entries }: { entries: Record<string, unknown>[] }) {
  const { t } = useLingui();
  return (
    <ul className="flex flex-col gap-1.5">
      {entries.map((entry, index) => (
        <li key={String(entry.id ?? index)} className="flex min-w-0 items-start gap-2 text-sm">
          <span className="mt-0.5 shrink-0">{planIcon(entry.status)}</span>
          <span className={cn('min-w-0 flex-1 text-fg [overflow-wrap:anywhere]', (entry.status === 'completed' || entry.status === 'cancelled') && 'text-fg-3 line-through decoration-fg-4')}>{String(entry.content ?? entry.title ?? t`任务 ${index + 1}`)}</span>
        </li>
      ))}
    </ul>
  );
}

export const PlanBlock = memo(function PlanBlock({ entries }: { entries: Record<string, unknown>[] }) {
  const { t } = useLingui();
  if (!entries.length) return null;
  const done = entries.filter((entry) => entry.status === 'completed').length;
  return (
    <div className="rounded-xl bg-subtle px-4 py-3">
      <div className="mb-2.5 flex items-center gap-2 text-sm">
        <IconListTodo className="size-4 text-fg-3" />
        <span className="font-medium text-fg">{t`待办`}</span>
        <span className="text-fg-3">{done}/{entries.length}</span>
        <div className="ml-auto h-1 w-20 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-success transition-[width]" style={{ width: `${entries.length ? (done / entries.length) * 100 : 0}%` }} /></div>
      </div>
      <PlanList entries={entries} />
    </div>
  );
});

export const StatusRow = memo(function StatusRow({ tone, text, detail, reveal, footer }: { tone: 'danger' | 'muted'; text: string; detail?: string; reveal?: number; footer?: ReactNode }) {
  return (
    <div className="group/message flex min-w-0 flex-col gap-2.5">
      <FailureDetails text={text} detail={detail} reveal={reveal}
        className={cn('text-sm', tone === 'danger' ? 'text-danger' : 'text-fg-3')}
        leading={tone === 'danger' ? <IconCircleAlert className="size-3.5" /> : <IconX className="size-3.5" />}
      />
      {footer}
    </div>
  );
});

export const ImageBlock = memo(function ImageBlock({ src }: { src: string }) {
  const { t } = useLingui();
  const resources = useTranscriptResources();
  const source = resources ? resources.resources[src]?.url ?? (/^(?:https?:|data:image\/)/i.test(src) ? src : undefined) : src;
  if (!source) return <span className="text-xs text-fg-3"><Trans>图片不可用</Trans></span>;
  return <ZoomableImage src={source} name={t`Agent 附加的图片`} maxHeight={448} className="rounded-xl" placeholder="large" />;
});

/** A notice's own numbers, in the same compact shape the subagent list uses. */
export const compactTokens = (value: number) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M`
  : value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`
    : String(Math.round(value));

/** Under ten seconds a tenth still says something; past that it is the transcript's one duration shape. */
export const compactDuration = (ms: number) => ms > 0 && ms < 10_000 ? `${(ms / 1_000).toFixed(1)}s` : formatDuration(ms);

/** Split out so only the label re-renders each second, and only when there is a start to count from. */
function ElapsedSince({ startedAt }: { startedAt: number }) {
  const elapsed = useNow() - startedAt;
  // The slot holds a minute's worth (`59s`) and exists from the start, so the clock growing
  // (and the first second passing) does not move the rate beside it.
  return <span className="min-w-[3ch] text-xs tabular-nums text-fg-3">{elapsed >= 1000 ? formatDuration(elapsed) : null}</span>;
}

/**
 * `startedAt` (epoch ms) is when the run in progress began; without it no elapsed time is shown.
 * `outputRate` is the server's rolling wall-clock output window for this session.
 */
export function WorkingIndicator({ startedAt, outputRate, connected = true, label }: { startedAt?: number; outputRate?: OutputRate; connected?: boolean; label?: string }) {
  const { t } = useLingui();
  const shownLabel = label ?? t`正在处理`;
  const rate = outputTokensPerSecond(outputRate, connected);
  const estimated = outputRate?.tokens === 'estimated' || outputRate?.tokens === 'mixed';
  return (
    // The clock and the rate tick every second; `aria-live="off"` keeps a screen reader from
    // reading them out each time while the status itself is still announced once.
    <div role="status" className="flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      {/* motion-loop: liveness dot while the run is working */}
      <span className="grid size-4 shrink-0 place-items-center"><span className="size-2 rounded-full bg-accent animate-pulse-dot" /></span>
      <span className="text-shimmer font-medium">{shownLabel}</span>
      {startedAt !== undefined && Number.isFinite(startedAt) && <span aria-live="off" className="contents"><ElapsedSince startedAt={startedAt} /></span>}
      {rate !== undefined && outputRate && (
        // An estimate is dimmed and marked `~`, so it never reads as a measurement even in a screenshot.
        <span aria-live="off" title={outputRateDescription(outputRate)} className={cn('text-xs tabular-nums', estimated ? 'text-fg-4' : 'text-fg-3')}>
          {estimated ? '~' : ''}{formatTokensPerSecond(rate)} tok/s
        </span>
      )}
    </div>
  );
}

/**
 * The main agent's turn has ended but work it delegated is still running, and its results will open
 * the next turn. Shells and monitors are not counted: they may never end. Quieter than
 * `WorkingIndicator`: nothing is being written, so no clock and no rate.
 */
export function BackgroundWorkIndicator({ agents, workflows = 0, onOpen }: { agents: number; workflows?: number; onOpen?: () => void }) {
  const { t } = useLingui();
  const label = !workflows ? t`${agents} 个子 Agent 运行中`
    : !agents ? t`${workflows} 个工作流运行中`
    : t`${agents} 个子 Agent、${workflows} 个工作流运行中`;
  const dot = <span className="grid size-4 shrink-0 place-items-center"><span className="size-2 rounded-full bg-fg-4" /></span>;
  return (
    <div role="status" className="flex min-h-6 items-center text-sm">
      {onOpen
        // As tall as `WorkingIndicator`, with its dot in the same column: the button's padding sits outside it.
        ? <Button variant="quiet" size="sm" className="-ml-2.5 h-6 gap-2" onClick={onOpen}>{dot}{label}</Button>
        : <span className="flex items-center gap-2 font-medium text-fg-3">{dot}{label}</span>}
    </div>
  );
}
