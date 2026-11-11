import { createPortal, flushSync } from 'react-dom';
import { memo, useCallback, useContext, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type Ref, type RefObject } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconArrowDown, IconChevronDown, IconChevronRight, IconRefreshCw, IconSearch, IconWrench, IconX } from '@/components/icons';
import { Input, Spinner } from '@/components/ui/controls';
import { FeedbackNotice } from '@/components/ui/feedback-notice';
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';
import { isApplePlatform } from '@/lib/platform';
import { cleanLabel, cn, isRecord, scrollBehavior, str } from '@/lib/utils';
import { DEFAULT_CONTENT_WIDTH, MAX_CONTENT_WIDTH, MIN_CONTENT_WIDTH, discardContentWidthPreview, previewContentWidth, resetContentWidth, setContentWidth } from '@/lib/content-width';
import type { NativeRunRecovery, DiscussionSource, MarkQuote, Run, RunMetrics } from '@contracts';
import type { NativeHistoryLoadState } from './transcriptLoad';
import { transcriptLoadView } from './transcriptLoad';
import { timelineItemTime, type TimelineItem } from './model';
import { AnswerActions, AssistantMessage, ImageBlock, PlanBlock, reasoningPreview, StatusRow, TaskNotificationRow, ThoughtRow, toolIcons, ToolRow, TurnTriggerBlock, UserMessage, type TurnAction } from './Timeline';
import { COLUMN_GUTTER_TOTAL, ContentWidthHandle, WIDTH_HANDLE_GAP, WIDTH_HANDLE_WIDTH } from './ContentWidthHandle';
import { ActivityRow, showsRunningCompaction } from './Activities';
import { TranscriptCatchUp, TurnProcess } from './TurnProcess';
import { useLingering, WAIT_GRACE_MS } from './sessionLayout';
import { Collapse } from '@/components/ui/collapse';
import { TurnOutline, TurnRail, type RowIndex, type Turn } from './TurnRail';
import { rowKeyForMessage, type MessageFocus } from './focus-message';
import { captureReadingAnchor, findRow, type ReadingAnchor } from './readingAnchor';
import { useTranscriptScroll, type TranscriptScrollHandle } from './useTranscriptScroll';
import { heldFooterRow, transcriptTurns, type TranscriptRow, type TranscriptTurn } from './transcriptRows';
import { useEarlierHistory, type EarlierLoad } from './useEarlierHistory';
import { findQuote, rangeAt } from './textQuote';
import { markedTurns, markTargetOf, MarkSourceContext, SessionMarksContext } from './marks';
import { MarkLayer } from './MarkLayer';
import { useTranscriptResources } from './transcriptResources';
import { buildLayout, indexAt, OVERSCAN_MIN, rescaledHeight, segmentsCover, VIRTUAL_MIN_ROWS, VIRTUAL_RELEASE_ROWS, windowSegments, type RowLayout, type Segment } from './virtualRows';
import { RememberedScope, RememberedValues, useRemembered } from './rememberedState';
import { activeToolStates, currentToolActivity, toolDetail, toolKind, toolRunSummary, toolView } from './toolView';
import { NativeJobStoreContext } from './subagents';
import { isComposingKey } from './composerKeyboard';
import { relaxUnderscoreEmphasis } from './cjkEmphasis';
import { visibleText } from './markdownSource';
import { truncationOf } from '@/sync/rows';
import { FailureDetails } from './FailureDetails';
import { ChapterNavigation } from './ChapterNavigation';

const time = (value: string) => { const at = new Date(value).getTime(); return Number.isFinite(at) ? at : undefined; };

/**
 * A new row fades in where it lands. No slide: following the end, a row rising into place while the
 * view keeps the bottom reads as the whole transcript bouncing.
 */
const enter = 'animate-in fade-in-0 duration-[var(--duration-slow)] ease-[var(--ease-decelerate)]';

/** Delegations stand on their own inside the process rather than joining tools. */
function isToolRunItem(item: TimelineItem | undefined): item is Extract<TimelineItem, { kind: 'tool' }> {
  return item?.kind === 'tool' && toolKind(item.event) !== 'agent';
}

/**
 * The runs in a process block, start index to end: tool calls and the folded reasoning between
 * them, so a thought does not split one stretch of work into lone calls. Prose, delegations and
 * anything else end a run; it needs a call in it and two items, or its items stand on their own.
 */
function toolRuns(items: TimelineItem[]): Map<number, number> {
  const runs = new Map<number, number>();
  const joins = (item: TimelineItem | undefined) => isToolRunItem(item) || (item?.kind === 'thought' && item.channel === 'thinking');
  for (let start = 0; start < items.length;) {
    let end = start;
    while (joins(items[end])) end += 1;
    if (end - start > 1 && items.slice(start, end).some(isToolRunItem)) runs.set(start, end);
    start = Math.max(end, start + 1);
  }
  return runs;
}

/** A run of ordinary tool calls within the open process. */
function ToolRun({ items, followedByContent, stale, latestTurn, children, reveal }: { items: Extract<TimelineItem, { kind: 'tool' }>[]; followedByContent: boolean; stale: boolean; latestTurn: boolean; children: ReactNode; reveal?: number }) {
  const jobs = useContext(NativeJobStoreContext);
  const resources = useTranscriptResources();
  // A background job can outlive the call that started it. Subscribe while folded too.
  const subscribe = useCallback((listener: () => void) => {
    const unsubscribers = items.flatMap(item => {
      const id = str(item.event.data.toolCallId) ?? String(item.event.sequence);
      return [jobs?.subscribe(id, listener)];
    });
    return () => unsubscribers.forEach(unsubscribe => unsubscribe?.());
  }, [items, jobs]);
  const snapshot = () => {
    let active = false, incomplete = false;
    for (const item of items) {
      const id = str(item.event.data.toolCallId) ?? String(item.event.sequence);
      const job = jobs?.get(id) ?? item.job;
      const activity = currentToolActivity(item);
      const status = job?.status ?? activity?.status ?? str(item.event.data.status) ?? str(item.event.data.state);
      const reportedActive = status !== undefined && (status === 'stopping' || activeToolStates.has(status));
      const running = !resources && (job ? job.status === 'running'
        : reportedActive && (Boolean(activity) || !stale));
      active ||= running;
      incomplete ||= status === 'unknown' || reportedActive && !running;
    }
    // Primitive snapshot: one bit for active work, one for unconfirmed work.
    return Number(incomplete) * 2 + Number(active);
  };
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const active = state % 2 === 1;
  const incomplete = (state & 2) !== 0;
  const summary = toolRunSummary(items);
  const Icon = toolIcons[summary.kind] ?? IconWrench;
  const [choice, setChoice] = useRemembered<boolean | undefined>('tool-run-choice', undefined);
  const { catchingUp, quiet } = useContext(TranscriptCatchUp);
  // Mounted before the transcript caught up, a run of the newest turn may be the tail of the copy only:
  // it waits folded until what follows it is known, rather than showing open and folding as the rest
  // arrives. An earlier turn is over; nothing catching up brings changes it.
  const unconfirmed = useRef(catchingUp && latestTurn);
  if (!catchingUp) unconfirmed.current = false;
  // Reasoning, delegation or the answer closes a completed run. A growing tail opens by default,
  // while an explicit reader choice still controls it during the call.
  const open = choice ?? (unconfirmed.current ? false : active || incomplete || !followedByContent);
  const contentsId = useId();
  useLayoutEffect(() => { if (reveal !== undefined) setChoice(true); }, [reveal, setChoice]);
  return (
    <div data-tool-run-open={open} className="flex min-w-0 flex-col">
      <button type="button" aria-expanded={open} aria-controls={open ? contentsId : undefined} onClick={() => setChoice(!open)}
        className="group/tool-run flex min-h-[calc(24px*var(--text-scale))] w-fit max-w-full items-center gap-2 rounded-md text-left text-sm text-fg-3 transition-colors hover:text-fg-2 no-hover:min-h-9">
        <span className="grid size-4 shrink-0 place-items-center text-fg-4 [&_svg]:size-[15px]"><Icon /></span>
        <span className="min-w-0 truncate">{summary.label}</span>
        {/* Like a tool row's: the chevron shows under the pointer or while open, and always on touch. */}
        <IconChevronRight className={cn('size-3.5 shrink-0 text-fg-4 transition-[opacity,transform] duration-[var(--duration-base)] ease-out-soft', open ? 'rotate-90' : 'can-hover:opacity-0 can-hover:group-hover/tool-run:opacity-100')} />
      </button>
      <Collapse open={open} keep still={quiet} id={contentsId} onReveal={() => setChoice(true)}>
        <div className="ml-2 mt-0.5 mb-1.5 flex min-w-0 flex-col edge-l pl-4 pt-0.5">{children}</div>
      </Collapse>
    </div>
  );
}
/**
 * How long a row that arrived live counts as new. The entrance plays once, as it mounts; a row that
 * mounts again later (a folded block opened, a row scrolled back into a recycled list) must not
 * replay it, so the mark expires rather than lasting for the session.
 */
const FRESH_MS = 1000;
/** How long after catching up its last changes still land without animating. */
const SETTLE_MS = 300;
interface Fresh { until: number; row?: string }
/**
 * Whether [key]'s entrance plays inside [row]. Only the row it first showed in plays it: an answer
 * folded into its turn's process block when the next tool lands remounts there, and fading in a
 * second time is the blink the reader sees.
 */
const isFresh = (fresh: ReadonlyMap<string, Fresh> | undefined, key: string, row: string) => {
  const entry = fresh?.get(key);
  if (!entry || entry.until <= performance.now()) return false;
  entry.row ??= row;
  return entry.row === row;
};
/** Pages of older history a focus request reads looking for its message before giving up. */
const SEEK_PAGES = 30;
/** Where a target taller than most of the viewport starts, from the top. */
const SETTLE_TOP = 56;
const wait = (ms: number) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms); });

/** The words [quote] names in [row]'s answer body, where a highlight is drawn. */
function quoteRange(row: HTMLElement, quote: MarkQuote): Range | undefined {
  const body = row.querySelector<HTMLElement>('[data-mark-ids]') ?? row;
  const at = findQuote(body.textContent ?? '', quote);
  return at ? rangeAt(body, at.start, at.end) : undefined;
}

/**
 * Flashes [range] the way a focused row flashes (`::highlight(mark-focus)`), or keeps it marked
 * until the next one when [hold]. No range clears the mark.
 */
function flashRange(range: Range | undefined, hold = false) {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return;
  if (!range) { CSS.highlights.delete('mark-focus'); return; }
  const highlight = new Highlight(range);
  CSS.highlights.set('mark-focus', highlight);
  if (!hold) window.setTimeout(() => { if (CSS.highlights.get('mark-focus') === highlight) CSS.highlights.delete('mark-focus'); }, 1600);
}

/** What a `Markdown` body shows of [text]. */
const markdownShown = (text: string) => visibleText(relaxUnderscoreEmphasis(text));

/**
 * What 会话内查找 matches in an item: the text its row shows, lower-cased — a Markdown body without
 * its syntax, a tool's title (and its command, last, since a folded row shows it only as the
 * title), a thought's preview line, a failure's detail, which opens itself. The model holds every
 * row, mounted or not, which is what the page's own find cannot reach once the list is windowed.
 * Kept per item object, with the count for the last query, so a streamed frame only rescans the
 * rows it replaced.
 */
const findable = new WeakMap<TimelineItem, { text: string; root?: string; needle?: string; count?: number }>();
function findableText(item: TimelineItem, root?: string) {
  let entry = findable.get(item);
  if (entry && entry.root === root) return entry;
  let parts: (string | undefined)[] = [];
  switch (item.kind) {
    case 'user': parts = [item.text]; break;
    case 'status': parts = [item.text, item.detail]; break;
    case 'assistant': parts = [markdownShown(item.text)]; break;
    case 'thought': parts = [item.channel === 'narration' ? markdownShown(item.text) : reasoningPreview(item.text)]; break;
    case 'tool': {
      const { job } = item;
      if (job) { parts = [job.title, job.title.trim() === job.command.trim() ? undefined : job.command]; break; }
      const view = toolView(item.event, root);
      const subagent = view.kind === 'agent' && isRecord(item.event.data.subagent) ? item.event.data.subagent : undefined;
      parts = [view.title, subagent ? str(subagent.type) : toolDetail(view), view.command && cleanLabel(view.title) !== cleanLabel(view.command) ? view.command : undefined];
      break;
    }
    case 'plan': parts = item.entries.map((entry) => String(entry.content ?? entry.title ?? '')); break;
    case 'task_notification': {
      const detail = item.status === 'failed' ? item.detail : undefined;
      parts = [item.command && item.title.trim() === item.command.trim() ? undefined : item.title, item.command, detail && item.taskKind === 'subagent' ? markdownShown(detail) : detail];
      break;
    }
    case 'activity': {
      const { activity } = item;
      const command = activity.task?.command;
      const name = activity.command?.name;
      // A compaction shows its state and sizes, not its title.
      if (activity.kind === 'background_task') parts = [activity.title || command, command && activity.title.trim() !== command.trim() ? command : undefined];
      else if (activity.kind === 'local_command' && command) parts = [command, activity.detail];
      else if (activity.kind === 'local_command') parts = [name && `/${name}`, activity.detail || (name ? undefined : activity.title)];
      break;
    }
  }
  entry = { text: parts.filter(Boolean).join('\n').toLowerCase(), root };
  findable.set(item, entry);
  return entry;
}

/** An item [needle] occurs in [count] times, and the index of the row that shows it. */
interface FindHit { key: string; row: number; count: number }

function findHits(rows: readonly TranscriptRow[], needle: string, root?: string): FindHit[] {
  const hits: FindHit[] = [];
  rows.forEach((row, index) => {
    for (const item of row.type === 'item' ? [row.item] : row.type === 'process' ? row.items : row.notices) {
      const entry = findableText(item, root);
      if (entry.needle !== needle) {
        let count = 0;
        for (let at = entry.text.indexOf(needle); at >= 0; at = entry.text.indexOf(needle, at + needle.length)) count += 1;
        entry.needle = needle;
        entry.count = count;
      }
      if (entry.count) hits.push({ key: item.key, row: index, count: entry.count });
    }
  });
  return hits;
}

/**
 * The [nth] occurrence of [needle] in [element]'s text. None when the rendered text holds fewer than
 * the model counted (a folded part, syntax the count misjudged): the row then flashes as a whole,
 * rather than every later step stopping on its last occurrence again.
 */
function occurrenceRange(element: HTMLElement, needle: string, nth: number): Range | undefined {
  const text = (element.textContent ?? '').toLowerCase();
  let start = text.indexOf(needle);
  for (let count = 0; start >= 0 && count < nth; count += 1) start = text.indexOf(needle, start + needle.length);
  return start < 0 ? undefined : rangeAt(element, start, start + needle.length);
}

/**
 * Measures the mounted rows. A row's extent is its box plus its margins, because the gaps between
 * rows are margins and the list's offsets must add up to what the column really occupies. The
 * heights are only written down here; the list reads them the next time it lays itself out, since
 * a mounted row is in the DOM at its real size whatever the list believes about it.
 */
function createRowObserver(heights: Map<string, number>, markDirty: () => void) {
  const observed = new Map<string, HTMLElement>();
  let observer: ResizeObserver | undefined;
  const extent = (element: HTMLElement, box: number, style = getComputedStyle(element)) =>
    box + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
  /** Rows mounting again at a remembered height, waiting for `standIn`. */
  let returning: { key: string; element: HTMLElement; known: number }[] = [];
  /**
   * A row the browser may skip (`content-visibility: auto`) mounting again stands in at the height
   * it last had, rather than the flat estimate, until it renders. Once rendered, `auto` remembers
   * its real size on its own. Every style is read before any size is written: interleaved, each
   * row's read would lay the list out again, once per row when a whole list remounts.
   */
  const standIn = () => {
    if (!returning.length) return;
    const rows = returning;
    returning = [];
    const sizes = rows.map(({ key, element, known }) => {
      if (observed.get(key) !== element) return undefined;
      const style = getComputedStyle(element);
      return style.contentVisibility === 'auto' ? Math.max(0, known - extent(element, 0, style)) : undefined;
    });
    rows.forEach(({ element }, index) => {
      const size = sizes[index];
      if (size !== undefined) element.style.containIntrinsicSize = `auto ${size}px`;
    });
  };
  const record = (key: string, height: number) => {
    if (Math.abs((heights.get(key) ?? -1) - height) <= 0.5) return false;
    heights.set(key, height);
    return true;
  };
  return {
    measure(key: string, element: HTMLElement | null) {
      const held = observed.get(key);
      if (held && held !== element) { observer?.unobserve(held); observed.delete(key); }
      if (!element || held === element) return;
      observed.set(key, element);
      // Stood in once the commit has attached every row (`standIn`); a microtask covers a row that
      // remounts on its own, without the list committing.
      const known = heights.get(key);
      if (known !== undefined && returning.push({ key, element, known }) === 1) queueMicrotask(standIn);
      observer ??= new ResizeObserver((entries) => {
        let changed = false;
        for (const entry of entries) {
          const target = entry.target as HTMLElement;
          const rowKey = target.dataset.rowKey;
          if (rowKey && target.isConnected) changed = record(rowKey, extent(target, entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height)) || changed;
        }
        if (changed) markDirty();
      });
      observer.observe(element);
    },
    /**
     * The column's text width went from [from] to [to] px: every remembered height was for the old
     * wrapping. Mounted rows are measured again; the rest are rescaled (`rescaledHeight`) rather
     * than dropped back to the flat estimate, so the rows the reader has not reached yet keep
     * roughly their place.
     */
    rewrap(from: number, to: number) {
      for (const [key, height] of heights) {
        const element = observed.get(key);
        heights.set(key, element?.isConnected ? extent(element, element.getBoundingClientRect().height) : rescaledHeight(height, from, to));
      }
      for (const [key, element] of observed) if (!heights.has(key)) heights.set(key, extent(element, element.getBoundingClientRect().height));
      markDirty();
    },
    standIn,
    disconnect() { observer?.disconnect(); observed.clear(); returning = []; },
  };
}

/** What every row needs besides its own data. The handlers are stable for the view's lifetime. */
interface RowContext {
  sessionId: string;
  onOpenSession?: (id: string) => void;
  /** Reports a mounted row's element (or its going away) so its height is known to the windowed list. */
  measure: (key: string, element: HTMLElement | null) => void;
  /** The list is windowed: rows scroll out of the DOM and come back, so their layout must not depend on staying mounted. */
  virtual: boolean;
  /** Reader intent, kept independently of scroll position during streamed layout changes. */
  following: RefObject<boolean>;
  /** Rows that arrived after the transcript first showed, until when their entrance may play. */
  fresh: ReadonlyMap<string, Fresh> | undefined;
  root?: string;
  onOpenPath: (path: string, line?: number) => void;
  onOpenInEditor?: (path: string, line?: number) => void;
  onOpenTerminal?: () => void;
  onRetryNativeRun?: (run: Run) => void;
  onCancelNativeRun?: (run: Run) => void;
  onCheckNativeRun?: (run: Run) => void;
  onContinueNativeRun?: (run: Run) => void;
  nativeRecoveries?: Record<string, NativeRunRecovery>;
  onSendQueuedNow?: (run: Run) => void;
  onRestoreNativeRun?: (run: Run) => void;
  onTurnAction?: (action: TurnAction, runId: string) => void;
  /** Fetches the whole of a row sent cut to a preview (sync v3). */
  onExpandRow?: (key: string) => Promise<boolean>;
  completedProcessesOpen?: boolean;
}

/** Under a row the server sent cut to a preview: fetches the rest when asked. */
function TruncatedMore({ item, expand }: { item: TimelineItem; expand?: (key: string) => Promise<boolean> }) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  if (!expand || !truncationOf(item)) return null;
  return (
    <Button size="xs" variant="quiet" className="mt-1 self-start text-fg-3" disabled={busy} onClick={() => { setBusy(true); void expand(item.key).finally(() => setBusy(false)); }}>
      {busy ? <Spinner className="size-3.5" /> : <IconChevronDown />}{t`显示全部`}
    </Button>
  );
}

/**
 * Where more history loads as the reader nears it: a spinner while a page is on its way, a retry once loading keeps failing.
 * Its box is the retry's height whenever there is more history that way, so neither a page starting nor a failure moves the rows.
 */
function PageProbe({ probeRef, failed, loading, onRetry, className }: { probeRef: Ref<HTMLDivElement>; failed: boolean; loading?: boolean; onRetry: () => void; className: string }) {
  const { t } = useLingui();
  return (
    <div ref={probeRef} className={cn('flex h-6 items-center justify-center', className)}>
      {failed ? <Button size="xs" variant="quiet" className="text-fg-3" onClick={onRetry}><IconRefreshCw />{t`重新加载`}</Button> : loading && <Spinner />}
    </div>
  );
}

/**
 * `actionPending` is the row's own answer to `runActionPending`, asked by the list: a send or an
 * interrupt flips it for every message at once, and as a plain flag it re-renders only the rows
 * whose answer actually changed, instead of invalidating the shared context for all of them.
 */
const TranscriptRowView = memo(function TranscriptRowView({ row, highlighted, reveal, actionPending, progress, suppressHeldFooter, latestTurn, footerPinned, context }: { row: TranscriptRow; highlighted: boolean; reveal?: { item: string; version: number }; actionPending: boolean; progress?: ReactNode; suppressHeldFooter: boolean; latestTurn: boolean; footerPinned: boolean; context: RowContext }) {
  const { fresh, root, onOpenPath, onOpenInEditor, measure } = context;
  const attach = useCallback((element: HTMLElement | null) => measure(row.key, element), [measure, row.key]);
  // Both explicit choices survive virtual unmounting; undefined means automatic folding.
  const [processChoice, rememberProcessChoice] = useRemembered<boolean | undefined>('process', undefined);
  const markTarget = useMemo(() => row.type === 'item' ? markTargetOf(row.item, row.runId) : undefined, [row]);
  // Off-screen rows are skipped by the browser in a whole list. A windowed one unmounts them
  // instead, and measuring needs every mounted row at its real size.
  const contained = context.virtual ? '' : '[content-visibility:auto] [contain-intrinsic-size:auto_88px]';
  const footerProgress = row.type !== 'trigger' && row.footer === 'held' && !suppressHeldFooter ? { progress: progress ?? null } : {};
  if (row.type === 'process') {
    const { items, gaps, running } = row;
    // Background task status can settle much later than its owning process. Its elapsed time
    // belongs to the task row; the process header and footer follow actual model output.
    const first = items.find((item) => item.kind !== 'activity')!;
    const lastOutputIndex = items.findLastIndex((item) => item.kind !== 'activity');
    const runs = toolRuns(items);
    const runCovered = new Set([...runs].flatMap(([start, end]) => Array.from({ length: end - start - 1 }, (_, offset) => start + 1 + offset)));
    const lastTime = timelineItemTime(items[lastOutputIndex]!);
    return (
      <div ref={attach} data-row-key={row.key} className={cn(
        // `-mx-2` widens the contained row by the turn header's own padding. Paint containment
        // (from `content-visibility`) clips anything that overhangs it, so the header cannot
        // reach its padded pill outward from inside — widening the box keeps the pill's padding
        // and rounded corners while the icon stays on the text column. `TurnProcess` cancels it
        // for the expanded contents.
        '-mx-2 min-w-0', contained,
        row.spaced ? 'timeline-gap-block' : '',
        highlighted && 'timeline-focus-hit',
      )}>
        <TurnProcess
          running={running}
          issueCount={items.filter((item) => item.kind === 'status' && item.tone === 'danger').length}
          interrupted={row.interrupted}
          startedAt={time(first.event.createdAt)}
          endedAt={time(lastTime)}
          footerTime={row.settled ? lastTime : undefined}
          footerPinned={footerPinned}
          footerActions={<AnswerActions text={row.answerText} runId={row.runId} onTurnAction={context.onTurnAction} at={lastTime} />}
          defaultOpen={context.completedProcessesOpen}
          choice={processChoice}
          following={context.following}
          onOpenChange={rememberProcessChoice}
          reveal={reveal?.version}
          {...footerProgress}
        >
          {items.map((item, itemIndex) => {
            if (runCovered.has(itemIndex)) return null;
            const end = runs.get(itemIndex);
            if (end !== undefined) {
              const run = items.slice(itemIndex, end);
              const tools = run.filter(isToolRunItem);
              const showItem = (entry: TimelineItem, index: number) => (
                <div key={entry.key} data-item-key={entry.key} className={cn('min-w-0', isFresh(fresh, entry.key, row.key) && enter)}>
                  <RememberedScope.Provider value={entry.key}><MarkSourceContext.Provider value={entry.event}>
                    {entry.kind === 'tool'
                      ? <ToolRow item={entry} onOpenPath={onOpenPath} onOpenInEditor={onOpenInEditor} root={root} stale={!running} more={context.onExpandRow && truncationOf(entry) ? <TruncatedMore item={entry} expand={context.onExpandRow} /> : undefined} />
                      : entry.kind === 'thought' ? <ThoughtRow text={entry.text} channel={entry.channel} running={running && itemIndex + index === lastOutputIndex} /> : null}
                  </MarkSourceContext.Provider></RememberedScope.Provider>
                </div>
              );
              return <RememberedScope.Provider key={item.key} value={item.key}>
                <div className={cn('min-w-0', gaps[itemIndex], isFresh(fresh, item.key, row.key) && enter)}>
                  <ToolRun items={tools} stale={!running} latestTurn={latestTurn} followedByContent={(!row.interrupted && row.followedByAnswer) || end < items.length}
                    reveal={run.some(entry => reveal?.item === entry.key) ? reveal?.version : undefined}>
                    {run.map(showItem)}
                  </ToolRun>
                </div>
              </RememberedScope.Provider>;
            }
            let inner: ReactNode = null;
            switch (item.kind) {
              case 'tool': inner = <ToolRow item={item} onOpenPath={onOpenPath} onOpenInEditor={onOpenInEditor} root={root} stale={!running} more={context.onExpandRow && truncationOf(item) ? <TruncatedMore item={item} expand={context.onExpandRow} /> : undefined} />; break;
              case 'thought': inner = <ThoughtRow text={item.text} channel={item.channel} running={running && itemIndex === lastOutputIndex} />; break;
              case 'assistant': inner = <AssistantMessage text={item.text} showActions={false} streaming={running && itemIndex === lastOutputIndex} mark={markTargetOf(item, row.runId)} />; break;
              case 'plan': inner = <PlanBlock entries={item.entries} />; break;
              case 'image': inner = <ImageBlock src={item.src} />; break;
              case 'status': inner = <StatusRow tone={item.tone} text={item.text} detail={item.detail} reveal={reveal?.item === item.key ? reveal.version : undefined} />; break;
              case 'activity': inner = <ActivityRow item={item} />; break;
              default: inner = null;
            }
            return (
              <div key={item.key} data-item-key={item.key} className={cn('min-w-0', gaps[itemIndex], isFresh(fresh, item.key, row.key) && enter)}>
                <RememberedScope.Provider value={item.key}><MarkSourceContext.Provider value={item.event}>{inner}</MarkSourceContext.Provider></RememberedScope.Provider>
                {item.kind !== 'tool' && <TruncatedMore item={item} expand={context.onExpandRow} />}
              </div>
            );
          })}
        </TurnProcess>
      </div>
    );
  }
  if (row.type === 'trigger') {
    return (
      <div ref={attach} data-row-key={row.key} className={cn('-ml-1.5 min-w-0 pl-1.5', contained, row.gap)}>
        <TurnTriggerBlock notices={row.notices} />
      </div>
    );
  }
  const { item, settled } = row;
  let content: ReactNode = null;
  if (item.kind === 'user') content = <UserMessage text={item.text} attachments={item.attachments} references={item.references} recipientSessionId={context.sessionId} onOpenSession={context.onOpenSession} time={timelineItemTime(item) || undefined} footerPinned={footerPinned} run={item.run} runActionPending={actionPending} onOpenTerminal={context.onOpenTerminal} onRetryNativeRun={context.onRetryNativeRun} onCancelNativeRun={context.onCancelNativeRun} onCheckNativeRun={context.onCheckNativeRun} onContinueNativeRun={context.onContinueNativeRun} nativeRecoveries={context.nativeRecoveries} onSendQueuedNow={context.onSendQueuedNow} onRestoreNativeRun={context.onRestoreNativeRun} />;
  else if (item.kind === 'assistant') content = <AssistantMessage chapters text={item.text} showActions={settled} streaming={!settled} time={settled ? timelineItemTime(item) || undefined : undefined} footerPinned={footerPinned} metrics={row.metrics} runId={row.runId} onTurnAction={context.onTurnAction} mark={markTarget} {...footerProgress} />;
  else if (item.kind === 'task_notification') content = <TaskNotificationRow item={item} />;
  else if (item.kind === 'activity') content = <ActivityRow item={item} />;
  return (
    <div
      ref={attach}
      data-row-key={item.key}
      data-turn={item.kind === 'user' ? item.key : undefined}
      // `-ml-1.5 pl-1.5` widens the contained row by 6px on the left without moving its content,
      // so an action row that hangs 6px outward (the answer's copy button) keeps its rounded
      // hover pill: paint containment from `content-visibility` clips anything that overhangs.
      className={cn('-ml-1.5 min-w-0 pl-1.5', contained, row.gap, highlighted && 'timeline-focus-hit', isFresh(fresh, item.key, row.key) && enter)}
    >
      {content}
      <TruncatedMore item={item} expand={context.onExpandRow} />
    </div>
  );
});

interface Props {
  /** A small embedded chat uses its own width and omits main-conversation navigation. */
  embedded?: boolean;
  /** A host can hand the composer's unused wheel motion to this exact conversation. */
  scrollHandleRef?: Ref<TranscriptScrollHandle>;
  sessionId: string;
  onOpenSession?: (id: string) => void;
  timeline: TimelineItem[];
  timelineVersion?: number;
  resetVersion?: number;
  turns?: Turn[];
  turnsVersion?: number;
  /**
   * Where the wide layout lists the turns (`layout.nav === 'outline'`). Given one, the edge rail
   * stands down.
   */
  outlineTarget?: HTMLElement | null;
  loaded: boolean;
  /** Rows still arriving are history the reader missed (`NativeSessionState.catchingUp`): they land without entrances or folds. */
  catchingUp?: boolean;
  historyLoad?: NativeHistoryLoadState;
  onRetryHistory?: () => void;
  running: boolean;
  activeTurnId?: string;
  root?: string;
  onOpenPath: (path: string, line?: number) => void;
  onOpenInEditor?: (path: string, line?: number) => void;
  /** Shown once loaded when there is nothing in the timeline yet. */
  empty?: ReactNode;
  /** Where the conversation came from, shown above its first message once that is loaded. */
  lead?: ReactNode;
  /** Trailing content inside the scroll area (pending interactions, working indicator…). */
  children?: ReactNode;
  /** Number of pending confirmations placed in the trailing content. */
  pendingConfirmationCount?: number;
  hasMoreHistory?: boolean;
  /** Keep finished process disclosures open in focused subagent transcripts. */
  completedProcessesOpen?: boolean;
  historyContextIncomplete?: boolean;
  historyStale?: boolean;
  loadingEarlier?: boolean;
  onLoadEarlier?: () => Promise<EarlierLoad>;
  /** The rows end before the conversation does (sync v3, after paging up past the window or jumping): later ones load on the way down. */
  hasMoreLater?: boolean;
  loadingLater?: boolean;
  onLoadLater?: () => Promise<EarlierLoad>;
  /** Which end of the rows the reader is nearer to, for the window that holds them: over its budget it gives up the other end. */
  onReaderEnd?: (atEnd: boolean) => void;
  /** Back to the conversation's newest rows, for 回到底部 while later ones are not loaded. */
  onJumpToLatest?: (signal?: AbortSignal) => Promise<boolean>;
  /** Loads a turn the rows do not hold yet, for the turn rail and outline; see `TurnTracking.onLoadTurn`. */
  onLoadTurn?: (key: string, signal?: AbortSignal) => Promise<string | false>;
  onExpandRow?: (key: string) => Promise<boolean>;
  onOpenTerminal?: () => void;
  onRetryNativeRun?: (run: Run) => void;
  onCancelNativeRun?: (run: Run) => void;
  onCheckNativeRun?: (run: Run) => void;
  onContinueNativeRun?: (run: Run) => void;
  nativeRecoveries?: Record<string, NativeRunRecovery>;
  onSendQueuedNow?: (run: Run) => void;
  onRestoreNativeRun?: (run: Run) => void;
  /** Rewinding the code to before a turn, or forking a conversation from it. */
  onTurnAction?: (action: TurnAction, runId: string) => void;
  onDiscuss?: (source: DiscussionSource) => void;
  runActionPending?: (run: Run) => boolean;
  /** Measured output speed per run, keyed by the run id a turn key refers to. */
  metricsByRun?: Map<string, RunMetrics>;
  /** A search result asked to see one message: scrolled to, and highlighted briefly. */
  focus?: MessageFocus;
  /** The working line: in the place a running turn holds for its footer (`heldFooterRow`), else after everything else. */
  progress?: ReactNode;
}

export function TranscriptView({ embedded = false, scrollHandleRef, sessionId, onOpenSession, timeline, timelineVersion = 0, resetVersion = 0, turns: suppliedTurns, turnsVersion = 0, loaded, catchingUp = false, historyLoad: suppliedHistoryLoad, onRetryHistory, running, activeTurnId, root, onOpenPath, onOpenInEditor, onOpenTerminal, empty, lead, children, pendingConfirmationCount = 0, hasMoreHistory, completedProcessesOpen, historyContextIncomplete, historyStale, loadingEarlier, onLoadEarlier, hasMoreLater, loadingLater, onLoadLater, onReaderEnd, onJumpToLatest, onLoadTurn, onExpandRow, onRetryNativeRun, onCancelNativeRun, onCheckNativeRun, onContinueNativeRun, nativeRecoveries, onSendQueuedNow, onRestoreNativeRun, onTurnAction, onDiscuss, runActionPending, metricsByRun, focus, outlineTarget, progress }: Props) {
  const { t } = useLingui();
  const resources = useTranscriptResources();
  const [confirmationOffscreen, setConfirmationOffscreen] = useState(false);
  /**
   * What a screen reader hears: the conversation's state changes, not its rows. The list itself is
   * not live, because windowing remounts rows the reader scrolls back to and each remount would be
   * read out as new. `seq` re-keys the text so the same message announced twice is heard twice.
   */
  const [announcement, setAnnouncement] = useState({ text: '', seq: 0 });
  const announced = useRef({ sessionId, running, confirmations: pendingConfirmationCount });
  useEffect(() => {
    const previous = announced.current;
    announced.current = { sessionId, running, confirmations: pendingConfirmationCount };
    // Switching conversations changes both values without anything having happened.
    if (previous.sessionId !== sessionId) return;
    const text = pendingConfirmationCount > previous.confirmations ? (pendingConfirmationCount > 1 ? t`${pendingConfirmationCount} 项待确认` : t`需要确认`)
      : previous.running && !running ? t`本轮已结束`
      : '';
    if (text) setAnnouncement((current) => ({ text, seq: current.seq + 1 }));
  }, [sessionId, running, pendingConfirmationCount]);
  /** The row a search result pointed at, rung for a moment so the reader can find it. */
  const [highlight, setHighlight] = useState<string>();
  /** The process row a focus opened to reach something inside it. */
  const [reveal, setReveal] = useState<{ row: string; item: string; version: number }>();
  const [landingTick, setLandingTick] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const earlierProbe = useRef<HTMLDivElement>(null);
  const headKey = useRef<string | undefined>(undefined);
  /*
   * Windowing. A long transcript mounts only the rows near the reader. Every row's height is
   * remembered by key once it has been measured (an estimate stands in until then), and from those
   * the list knows where each row sits, which is what scrolling to a row, restoring a reading
   * position and the turn rail ask when the row itself is not in the DOM.
   */
  const heights = useRef(new Map<string, number>());
  const heightsSession = useRef({ sessionId, resetVersion });
  const layoutCache = useRef<{ rows: readonly TranscriptRow[]; layout: RowLayout; dirty: boolean } | null>(null);
  const listMarker = useRef<HTMLDivElement>(null);
  /** Where the rows start within the scroller's content: the header above them is not fixed. */
  const listTop = useRef(0);
  const windowed = useRef(false);
  const renderedSegments = useRef<readonly Segment[]>([]);
  const [windowTick, setWindowTick] = useState(0);
  const rowLayoutChange = useRef<() => void>(() => {});
  const rowObserver = useMemo(() => createRowObserver(heights.current, () => {
    if (layoutCache.current) layoutCache.current.dirty = true;
    rowLayoutChange.current();
  }), []);
  useEffect(() => () => rowObserver.disconnect(), [rowObserver]);
  // Ahead of this view's other layout effects, which measure rows: the rows mounted in this commit
  // stand in at their remembered heights first, as when each wrote its own as it attached.
  useLayoutEffect(() => rowObserver.standIn());
  const layoutFor = useCallback((rows?: readonly TranscriptRow[]): RowLayout | undefined => {
    const cached = layoutCache.current;
    const target = rows ?? cached?.rows;
    if (!target) return undefined;
    if (cached && cached.rows === target && !cached.dirty) return cached.layout;
    const layout = buildLayout(target, heights.current);
    layoutCache.current = { rows: target, layout, dirty: false };
    return layout;
  }, []);
  /** Content-space top of a row, mounted or not. */
  const locate = useCallback((key: string): number | undefined => {
    const layout = windowed.current ? layoutFor() : undefined;
    const index = layout?.indexOf(key);
    return layout && index !== undefined ? listTop.current + layout.offsets[index]! : undefined;
  }, [layoutFor]);
  /** Where the row with [key] starts in the scroller's content: measured when mounted, else from the list's index. */
  const rowTop = useCallback((key: string): number | undefined => {
    const scroller = scrollRef.current;
    const row = scroller ? findRow(scroller, key) : undefined;
    return scroller && row ? scroller.scrollTop + row.getBoundingClientRect().top - scroller.getBoundingClientRect().top : locate(key);
  }, [locate]);
  /** The reading position as the list's index sees it, for when no row is mounted where the reader is. */
  const modelAnchor = useCallback((): ReadingAnchor | undefined => {
    const scroller = scrollRef.current;
    const layout = windowed.current ? layoutFor() : undefined;
    if (!scroller || !layout || !layout.rows.length) return undefined;
    const index = indexAt(layout.offsets, layout.rows.length, scroller.scrollTop - listTop.current);
    return { rows: [{ key: layout.rows[index]!.key, top: listTop.current + layout.offsets[index]! - scroller.scrollTop }], scrollTop: scroller.scrollTop };
  }, [layoutFor]);
  useLayoutEffect(() => {
    const marker = listMarker.current;
    const scroller = scrollRef.current;
    if (marker && scroller) listTop.current = marker.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  });
  const positionChange = useRef<(synchronous: boolean) => void>(() => {});
  const onPositionChange = useCallback((synchronous: boolean) => positionChange.current(synchronous), []);
  const scroll = useTranscriptScroll({
    scrollRef, contentRef, sessionId, resetVersion, loaded,
    resources: Boolean(resources), hasMoreLater: Boolean(hasMoreLater), running,
    locate, modelAnchor, onPositionChange,
  });
  const atBottom = scroll.atBottom;
  rowLayoutChange.current = scroll.reconcile;
  /**
   * Where the viewport's top is within the list: the end while following the bottom, the reading
   * anchor's row while one is pending (scrollTop may still say where the reader was before the rows
   * changed), else the scroll position. The render that picks the mounted window and the check that
   * asks whether it still covers the reader both read it here: when they measured differently, the
   * check never saw the window the render had just mounted and remounted it without end.
   */
  const viewTop = (layout: RowLayout, count: number, viewport: number): number => {
    const pending = scroll.anchor.current?.rows[0];
    const pendingIndex = pending?.key ? layout.indexOf(pending.key) : undefined;
    return scroll.following.current ? layout.offsets[count]! - viewport
      : pendingIndex !== undefined ? layout.offsets[pendingIndex]! - pending!.top
      : (scrollRef.current?.scrollTop ?? 0) - listTop.current;
  };
  /** Window remounts in the current frame; past a few, the next one waits for the next frame. */
  const windowRemounts = useRef({ count: 0, deferred: false });
  const latestTurn = useRef<string | undefined>(undefined);
  /**
   * Mounts a different window when the reader has moved close to the edge of the mounted one. Done
   * in the scroll event, synchronously, so the rows are there before the next paint instead of
   * a blank stretch; a layout effect passes `false` because it may not flush on its own.
   */
  const ensureWindow = (sync: boolean) => {
    const scroller = scrollRef.current;
    const layout = windowed.current && !scroll.following.current ? layoutFor() : undefined;
    if (!scroller || !layout) return;
    const viewport = scroller.clientHeight || 800;
    const margin = Math.max(OVERSCAN_MIN, viewport) / 2;
    const top = viewTop(layout, layout.rows.length, viewport);
    if (segmentsCover(renderedSegments.current, layout.offsets, layout.rows.length, top - margin, top + viewport + margin)) return;
    // The rows about to mount change what sits above the reader; note where they are first.
    scroll.preserveBeforeChange();
    // A window that keeps missing within one frame would otherwise remount inside the commit until
    // React gives up on the whole tree; the next frame measures again instead.
    const remounts = windowRemounts.current;
    if (remounts.count === 0) requestAnimationFrame(() => { remounts.count = 0; });
    remounts.count += 1;
    if (remounts.count > 3) {
      if (!remounts.deferred) {
        remounts.deferred = true;
        requestAnimationFrame(() => { remounts.deferred = false; setWindowTick((value) => value + 1); });
      }
      return;
    }
    if (!sync) { setWindowTick((value) => value + 1); return; }
    flushSync(() => setWindowTick((value) => value + 1));
  };
  const turns = useMemo<Turn[]>(() => suppliedTurns ?? timeline.flatMap((item) => (item.kind === 'user' ? [{ key: item.key, text: item.text.trim() || (item.attachments.length ? t`附件` : ''), at: item.event.createdAt }] : [])), [suppliedTurns, timeline, timelineVersion]);
  const sessionMarks = useContext(SessionMarksContext);
  // Held while it names the same prompts, so the memoized rail keeps its props. A streamed frame
  // cannot move a mark to another turn; the marks and the turn list moving (a window loaded) can.
  const markedRef = useRef<ReadonlySet<string>>(new Set());
  const markedKeys = useMemo(() => {
    const next = markedTurns(sessionMarks?.marks ?? [], turns, timeline);
    const held = markedRef.current;
    if (next.size !== held.size || [...next].some((key) => !held.has(key))) markedRef.current = next;
    return markedRef.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionMarks?.marks, turns, turnsVersion]);
  // What catching up brings, and what its end settles (a block left without an answer, a tail run
  // still going), lands without animating; live changes a moment later animate again.
  const quiet = !useLingering(!catchingUp, SETTLE_MS);
  const catchUp = useMemo(() => ({ catchingUp, quiet }), [catchingUp, quiet]);
  const seen = useRef<{ session: string; keys: Set<string>; fresh: Map<string, Fresh>; length: number } | null>(null);
  const historyLoad = suppliedHistoryLoad ?? { state: loaded ? 'ready' : 'loading' };
  const loadView = transcriptLoadView(loaded, historyLoad);
  const showLoading = useLingering(loadView === 'loading', WAIT_GRACE_MS);
  if (loaded) {
    if (seen.current?.session !== sessionId) seen.current = { session: sessionId, keys: new Set(timeline.map((item) => item.key)), fresh: new Map(), length: timeline.length };
    else if (timelineVersion > 0) {
      const { keys, fresh } = seen.current;
      const now = performance.now();
      for (const [key, entry] of fresh) if (entry.until <= now) fresh.delete(key);
      const added: string[] = [];
      for (let index = timeline.length - 1; index >= 0; index -= 1) {
        const item = timeline[index]!;
        if (keys.has(item.key)) break;
        keys.add(item.key);
        added.push(item.key);
      }
      // A key that took the place of a row gone in the same frame (one the server keyed again) is
      // not new to the reader: only the newest keys beyond those replaced play an entrance.
      const replaced = Math.max(0, seen.current.length + added.length - timeline.length);
      if (!quiet) for (const key of added.slice(0, added.length - replaced)) fresh.set(key, { until: now + FRESH_MS });
    }
    seen.current.length = timeline.length;
  }

  /*
   * 内容宽度: the drag strip beside the column. Measured, not computed from the custom property:
   * the column is centered and capped, so its real offset from the frame's left edge is the only
   * value that stays right when the window is narrower than the preference.
   */
  const frameRef = useRef<HTMLDivElement>(null);
  const columnWidth = useRef(DEFAULT_CONTENT_WIDTH);
  const [handleLeft, setHandleLeft] = useState<number | null>(null);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const content = contentRef.current;
    if (embedded || !frame || !content) return;
    const measure = () => {
      const frameRect = frame.getBoundingClientRect();
      const contentRect = content.getBoundingClientRect();
      columnWidth.current = contentRect.width;
      const gutter = contentRect.left - frameRect.left;
      const room = WIDTH_HANDLE_WIDTH + WIDTH_HANDLE_GAP;
      setHandleLeft(gutter >= room + 4 ? gutter - room : null);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    observer.observe(content);
    measure();
    return () => observer.disconnect();
  }, [embedded]);
  /** The widest column this window can show while both gutters keep a strip's worth of room. */
  const widthCeiling = () => {
    const frame = frameRef.current;
    return frame ? Math.max(MIN_CONTENT_WIDTH, frame.clientWidth - COLUMN_GUTTER_TOTAL) : MAX_CONTENT_WIDTH;
  };

  // Wrapping depends on the column's width, so a new width rescales the remembered heights.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const textWidth = () => {
      const style = getComputedStyle(content);
      return content.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    };
    let width = textWidth();
    const observer = new ResizeObserver(() => {
      const next = textWidth();
      if (Math.abs(next - width) < 1) return;
      rowObserver.rewrap(width, next);
      width = next;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [rowObserver]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || pendingConfirmationCount === 0) {
      setConfirmationOffscreen(false);
      return;
    }
    const update = () => {
      const bounds = scroller.getBoundingClientRect();
      const cards = [...scroller.querySelectorAll<HTMLElement>('[data-pending-confirmation]')];
      const offscreen = cards.some((card) => {
        const rect = card.getBoundingClientRect();
        const visible = Math.max(0, Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top));
        const enoughToRecognize = Math.min(120, Math.max(36, rect.height * 0.25));
        return visible < enoughToRecognize;
      });
      setConfirmationOffscreen(offscreen);
    };
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    if (contentRef.current) observer.observe(contentRef.current);
    scroller.addEventListener('scroll', update, { passive: true });
    update();
    return () => {
      observer.disconnect();
      scroller.removeEventListener('scroll', update);
    };
  // The cards live in `children`, a new element on every render; their arrival changes the count,
  // and the observer and the scroll listener cover everything that moves them after that.
  }, [sessionId, pendingConfirmationCount]);

  /**
   * Scrolls to the item with [key] and marks it: the words [rangeIn] picks inside it, or the item as
   * a whole when it picks none; [hold] keeps the words marked until the next landing. Returns false
   * while the item is not there to land on yet — windowed out (the scroll mounts it, and the new
   * window runs the caller again) or inside a folded block that is opening — so a caller retries on
   * the next change and honours a request once it returned true.
   */
  const landOn = (key: string, rangeIn: (found: HTMLElement) => Range | undefined, hold = false): boolean => {
    const scroller = scrollRef.current;
    if (!scroller) return false;
    let row = findRow(scroller, key);
    let target = key;
    let item: HTMLElement | undefined;
    if (!row) {
      const parent = plannedTurns.current?.flatMap((turn) => turn.rows).find((candidate) => candidate.type === 'process'
        ? candidate.items.some((entry) => entry.key === key)
        : candidate.type === 'trigger' && candidate.notices.some((entry) => entry.key === key));
      if (parent) {
        target = parent.key;
        row = findRow(scroller, target);
        // Inside a folded process (a picture, a tool call): open it, and come back once it shows.
        if (row) {
          item = row.querySelector<HTMLElement>(`[data-item-key="${CSS.escape(key)}"]`) ?? undefined;
          const folded = row.querySelector('[data-process-open="false"]') || item?.closest('[data-tool-run-open="false"]');
          let opening = false;
          // Only containing disclosures affect the target's placement. A transition elsewhere
          // in the row (such as a hovered tool button) must not block search navigation.
          for (let container = item?.parentElement; container && container !== row; container = container.parentElement) {
            opening ||= container.getAnimations().some(animation => 'transitionProperty' in animation && animation.playState === 'running');
          }
          if (parent.type === 'process' && (!item || folded || item.closest('[hidden]') || opening)) {
            if (reveal?.row !== target || reveal.item !== key) {
              setReveal({ row: target, item: key, version: (reveal?.version ?? 0) + 1 });
            }
            return false;
          }
        }
      }
    }
    if (!row) {
      // Windowed out: scroll to where the list places it. The window that mounts it re-runs this.
      const placed = locate(target);
      if (placed === undefined) return false;
      scroll.navigate(() => {
        const top = locate(target);
        return top === undefined ? undefined : top - scroller.clientHeight / 2;
      });
      ensureWindow(false);
      return false;
    }
    const found = item ?? row;
    const range = rangeIn(found);
    // Held in refs, not the caller's effect cleanup: the timeline changes many times while it settles.
    focusSettle.current?.();
    focusSettle.current = scroll.navigate(() => {
      const currentRow = findRow(scroller, target);
      if (!currentRow) return undefined;
      const currentItem = item ? currentRow.querySelector<HTMLElement>(`[data-item-key="${CSS.escape(key)}"]`) : undefined;
      const current = currentItem ?? currentRow;
      const box = (rangeIn(current) ?? current).getBoundingClientRect();
      const view = scroller.getBoundingClientRect();
      const offset = box.height > view.height * 0.6 ? SETTLE_TOP : (view.height - box.height) / 2;
      return scroller.scrollTop + box.top - view.top - offset;
    });
    window.clearTimeout(focusFlash.current);
    flashRange(range, hold);
    if (range) return true;
    if (item) { item.classList.add('timeline-focus-hit'); focusFlash.current = window.setTimeout(() => item.classList.remove('timeline-focus-hit'), 1600); }
    else { setHighlight(found.dataset.rowKey ?? key); focusFlash.current = window.setTimeout(() => setHighlight(undefined), 1600); }
    return true;
  };

  /**
   * Scrolls to the message a search result asked for. It waits until that row exists, because the
   * message may only arrive with the stream or with a page of older history, and it honours one
   * request once — a later timeline change must not pull the reader back to it.
   */
  const focusHandled = useRef<MessageFocus | undefined>(undefined);
  const focusRequest = useRef<{ value: MessageFocus; scope: string; version: number }>(undefined);
  const scrollScope = `${sessionId}:${resetVersion}`;
  // Opening two nested regions can commit after the request effect, even with no new timeline
  // data. Retry while their DOM settles; reader navigation still cancels through the same gate.
  useEffect(() => {
    if (!reveal) return;
    const started = performance.now();
    let frame = 0;
    const tick = () => {
      setLandingTick(value => value + 1);
      if (performance.now() - started < 1500) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [reveal, scrollScope]);
  useEffect(() => {
    if (!focus || !loaded || loadingEarlier) return;
    if (focusRequest.current?.value !== focus || focusRequest.current.scope !== sessionId) {
      scroll.release();
      focusHandled.current = undefined;
      focusRequest.current = { value: focus, scope: sessionId, version: scroll.navigationVersion.current };
    }
    if (focusHandled.current === focus) return;
    if (focusRequest.current.version !== scroll.navigationVersion.current) { focusHandled.current = focus; setReveal(undefined); return; }
    const key = rowKeyForMessage(timeline, focus);
    if (key && landOn(key, (found) => focus.quote ? quoteRange(found, focus.quote) : undefined)) { focusHandled.current = focus; setReveal(undefined); }
    focusRequest.current.version = scroll.navigationVersion.current;
  }, [focus, loaded, scrollScope, timeline, timelineVersion, loadingEarlier, windowTick, reveal, landingTick, scroll]);

  /** The occurrence 会话内查找 moved to; landed the same way as a focus, and once. */
  const [findTarget, setFindTarget] = useState<{ key: string; needle: string; nth: number }>();
  const findHandled = useRef<typeof findTarget>(undefined);
  const findRequest = useRef<{ value: NonNullable<typeof findTarget>; version: number }>(undefined);
  useEffect(() => {
    if (!findTarget || findHandled.current === findTarget) return;
    if (findRequest.current?.value !== findTarget) {
      scroll.release();
      findRequest.current = { value: findTarget, version: scroll.navigationVersion.current };
    }
    if (findRequest.current.version !== scroll.navigationVersion.current) { findHandled.current = findTarget; setReveal(undefined); return; }
    if (landOn(findTarget.key, (found) => occurrenceRange(found, findTarget.needle, findTarget.nth), true)) { findHandled.current = findTarget; setReveal(undefined); }
    findRequest.current.version = scroll.navigationVersion.current;
  }, [findTarget, timeline, timelineVersion, windowTick, reveal, landingTick, scroll]);
  const focusSettle = useRef<() => void>(undefined);
  const focusFlash = useRef<number>(undefined);
  useEffect(() => () => { focusSettle.current?.(); window.clearTimeout(focusFlash.current); }, [scrollScope]);

  /**
   * A focused message older than anything loaded: pages back through the history until it is
   * there (the effect above then scrolls to it), the history ends, or [SEEK_PAGES] pages were read.
   * It waits for the stream's first snapshot, since a message newer than the cached copy arrives
   * with that rather than with an older page.
   */
  const [seeking, setSeeking] = useState(false);
  /** The end of the rows the window was last told the reader is nearer to; a seek heads for the top whatever the view shows. */
  const readerEnd = useRef<boolean | undefined>(undefined);
  const seekingUp = useRef(false);
  const tellReaderEnd = (atEnd: boolean) => {
    if (!onReaderEnd || readerEnd.current === atEnd) return;
    readerEnd.current = atEnd;
    onReaderEnd(atEnd);
  };
  useEffect(() => { readerEnd.current = undefined; }, [scrollScope]);
  const seek = useRef({ timeline, hasMoreHistory, onLoadEarlier, loadingEarlier, tellReaderEnd });
  seek.current = { timeline, hasMoreHistory, onLoadEarlier, loadingEarlier, tellReaderEnd };
  const historyReady = loaded && historyLoad.state === 'ready' && !historyStale;
  useEffect(() => {
    if (!focus || !historyReady || focusHandled.current === focus) return;
    let cancelled = false;
    const version = scroll.navigationVersion.current;
    const currentRequest = () => !cancelled && version === scroll.navigationVersion.current;
    void (async () => {
      let pages = 0, failures = 0, idle = 0;
      while (currentRequest()) {
        const current = seek.current;
        if (rowKeyForMessage(current.timeline, focus)) return;
        if (!current.hasMoreHistory || !current.onLoadEarlier || pages >= SEEK_PAGES) {
          toast.info(pages >= SEEK_PAGES ? t`向前翻了 ${SEEK_PAGES} 页仍未找到这条消息` : t`没有在会话中找到这条消息，它可能已被删除或改写`);
          return;
        }
        setSeeking(true);
        seekingUp.current = true;
        current.tellReaderEnd(false);
        // A page the transcript is already loading on its own counts as this one; wait for it.
        const result = current.loadingEarlier ? 'none' : await current.onLoadEarlier();
        if (!currentRequest()) return;
        if (result === 'progress') { pages += 1; failures = 0; idle = 0; await wait(32); }
        else if (result === 'failed') {
          if (++failures >= 3) { toast.error(t`无法加载更早的历史，未能定位到这条消息`); return; }
          await wait(1000 * failures);
        } else {
          if (++idle > 40) { toast.info(t`暂时无法定位这条消息`); return; }
          await wait(250);
        }
      }
    })().finally(() => {
      // The view says where the reader is again from its next move.
      seekingUp.current = false;
      if (!cancelled) setSeeking(false);
    });
    return () => { cancelled = true; seekingUp.current = false; setSeeking(false); };
  }, [focus, historyReady, scrollScope, scroll]);

  const earlier = useEarlierHistory({
    scrollRef, probeRef: earlierProbe, scope: `${sessionId}:${resetVersion}`,
    enabled: loaded && Boolean(hasMoreHistory && onLoadEarlier), paused: Boolean(loadingEarlier || historyStale),
    version: timelineVersion, load: onLoadEarlier,
  });
  const laterProbe = useRef<HTMLDivElement>(null);
  const later = useEarlierHistory({
    scrollRef, probeRef: laterProbe, scope: `${sessionId}:${resetVersion}:later`, below: true,
    enabled: loaded && Boolean(hasMoreLater && onLoadLater), paused: Boolean(loadingLater), version: timelineVersion, load: onLoadLater,
  });
  positionChange.current = (synchronous) => {
    ensureWindow(synchronous);
    // Before any page is asked for: which end a full window keeps decides what that page may cost.
    const scroller = scrollRef.current;
    if (scroller?.clientHeight) tellReaderEnd(!seekingUp.current && (scroll.following.current || scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= scroller.scrollTop));
    earlier.check();
    later.check();
  };

  const scrollToBottom = () => {
    // The newest rows are not loaded: they replace these, and the view starts at their end.
    if (hasMoreLater && onJumpToLatest) {
      scroll.release();
      const request = scroll.beginRequest();
      void onJumpToLatest(request.signal).catch(() => false).finally(request.finish);
      return;
    }
    scroll.followEnd();
  };
  const onJump = scroll.release;
  const navigateToRow = useCallback((key: string, offset: number) => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const resolve = () => {
      const top = rowTop(key);
      return top === undefined ? undefined : top - offset;
    };
    const target = resolve();
    if (target === undefined) return;
    const far = !findRow(scroller, key) || Math.abs(target - scroller.scrollTop) > scroller.clientHeight * 3;
    scroll.navigate(resolve, { behavior: far ? 'auto' : scrollBehavior() });
  }, [rowTop, scroll]);
  const navigateToChapter = useCallback((key: string, heading: string) => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let mounted = Boolean(findRow(scroller, key));
    const resolve = () => {
      const row = findRow(scroller, key);
      if (row) {
        mounted = true;
        const target = row.querySelector<HTMLElement>(`[data-chapter-body] > .md [data-md-heading="${CSS.escape(heading)}"]`);
        return target ? scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 24 : undefined;
      }
      // Only use the row's top to mount it initially. Once mounted, wait for the heading through
      // a parse/layout update instead of pulling an in-flight chapter jump back to the row's top.
      if (mounted) return undefined;
      const top = rowTop(key);
      return top === undefined ? undefined : top - 24;
    };
    scroll.navigate(resolve, { behavior: mounted ? scrollBehavior() : 'auto' });
  }, [rowTop, scroll]);
  useImperativeHandle(scrollHandleRef, () => ({
    scrollByReader: scroll.scrollByReader,
    followSent: () => scroll.followSent(latestTurn.current === undefined ? undefined : rowTop(latestTurn.current)),
    revealRun: (runId) => {
      const item = timeline.find((entry) => entry.kind === 'user' && entry.run?.id === runId);
      if (item) navigateToRow(item.key, 24);
    },
  }), [scroll, rowTop, timeline, navigateToRow]);
  const loadTurn = useCallback(async (key: string) => {
    const request = scroll.beginRequest();
    try { return await onLoadTurn?.(key, request.signal) ?? false; }
    finally { request.finish(); }
  }, [onLoadTurn, scroll]);

  const jumpToConfirmation = () => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const bounds = scroller.getBoundingClientRect();
    const cards = [...scroller.querySelectorAll<HTMLElement>('[data-pending-confirmation]')];
    const target = cards.find((card) => {
      const rect = card.getBoundingClientRect();
      const visible = Math.max(0, Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top));
      return visible < Math.min(120, Math.max(36, rect.height * 0.25));
    }) ?? cards[0];
    if (!target) return;
    scroll.navigate(() => target.isConnected
      ? scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16
      : undefined, { behavior: scrollBehavior() });
    // The pill that was pressed goes away once the card shows; the keyboard lands on the card instead of the page.
    (target.querySelector<HTMLElement>('article[tabindex]') ?? target).focus({ preventScroll: true });
  };

  const plannedTurns = useRef<TranscriptTurn[] | undefined>(undefined);
  const heldSelection = useRef(false);
  const [selectionRevision, setSelectionRevision] = useState(0);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let dragging = false;
    const read = () => {
      const selection = document.getSelection();
      const inside = Boolean(selection && !selection.isCollapsed && selection.rangeCount && scroller.contains(selection.getRangeAt(0).commonAncestorContainer));
      const held = dragging || inside;
      if (heldSelection.current === held) return;
      heldSelection.current = held;
      setSelectionRevision(value => value + 1);
    };
    const down = (event: PointerEvent) => {
      if (event.button === 0 && event.target instanceof Element && event.target.closest('[data-mark-ids]')) { dragging = true; read(); }
    };
    const up = () => { dragging = false; read(); };
    scroller.addEventListener('pointerdown', down);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    document.addEventListener('selectionchange', read);
    window.addEventListener('blur', up);
    return () => {
      heldSelection.current = false;
      scroller.removeEventListener('pointerdown', down);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      document.removeEventListener('selectionchange', read);
      window.removeEventListener('blur', up);
    };
  }, [sessionId]);
  const rowTurns = useMemo(() => {
    // Later tool output can regroup a reply into a process row. Defer that reparenting too,
    // otherwise it unmounts the selected Markdown even when its own text rendering is held.
    if (heldSelection.current && plannedTurns.current) return plannedTurns.current;
    const next = transcriptTurns(timeline, running, metricsByRun, plannedTurns.current, activeTurnId);
    plannedTurns.current = next;
    return next;
  }, [timeline, timelineVersion, running, metricsByRun, activeTurnId, selectionRevision]);
  // Flat, not one parent per turn: older history or a settled slash command can move a turn's
  // boundary, and a row re-parented that way would remount and drop its expanded state.
  const rowsAll = useMemo(() => rowTurns.flatMap((turn) => turn.rows), [rowTurns]);
  latestTurn.current = rowTurns.at(-1)?.rows[0]?.key;
  if (heightsSession.current.sessionId !== sessionId || heightsSession.current.resetVersion !== resetVersion) {
    heights.current.clear();
    layoutCache.current = null;
    heightsSession.current = { sessionId, resetVersion };
    headKey.current = undefined;
    windowed.current = false;
  }
  /*
   * A page of older rows arrived: the head row is now below others. This render is the last moment
   * the DOM still shows the old layout, so the reader's place is taken here — a position taken when
   * the request started would be wherever the reader has scrolled since. Following the bottom needs
   * none; the content observer keeps it there.
   */
  const head = rowsAll[0]?.key;
  if (head !== headKey.current) {
    const scroller = scrollRef.current;
    if (headKey.current !== undefined && scroller && loaded && rowsAll.findIndex((row) => row.key === headKey.current) > 0) {
      scroll.preserveBeforeChange();
    }
    headKey.current = head;
  }
  windowed.current = loaded && (rowsAll.length >= VIRTUAL_MIN_ROWS || (windowed.current && rowsAll.length >= VIRTUAL_RELEASE_ROWS));
  const virtual = windowed.current;
  const layout = virtual ? layoutFor(rowsAll)! : undefined;
  let segments: readonly Segment[] = [];
  if (layout) {
    const viewport = scrollRef.current?.clientHeight || 800;
    const top = viewTop(layout, rowsAll.length, viewport);
    // The last row always stays mounted: it is the one that streams. The rest of its turn is windowed
    // like any other, so one turn thousands of rows long costs no more than the reader can see.
    const tailStart = rowsAll.length - 1;
    segments = windowSegments(layout.offsets, rowsAll.length, tailStart, top, viewport, Math.max(OVERSCAN_MIN, viewport));
  }
  renderedSegments.current = segments;
  /** What rows keep across being windowed out and back (`useRemembered`), for this conversation only. */
  const remembered = useMemo(() => new Map<string, unknown>(), [sessionId]);
  const rowIndex = useMemo<RowIndex>(() => ({
    active: () => windowed.current,
    topOf: locate,
    turnAt: (y) => {
      const current = windowed.current ? layoutFor() : undefined;
      if (!current?.turnRows.length) return undefined;
      const top = y - listTop.current;
      let low = 0;
      let high = current.turnRows.length - 1;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (current.offsets[current.turnRows[middle]!]! <= top) low = middle;
        else high = middle - 1;
      }
      return current.rows[current.turnRows[low]!]!.key;
    },
  }), [layoutFor, locate]);

  // Callers pass fresh closures on every render; the rows reach the latest one through this ref, so
  // a parent render alone never invalidates a memoized turn. Presence still decides what renders.
  const handlers = useRef({ onOpenPath, onOpenInEditor, onOpenTerminal, onRetryNativeRun, onCancelNativeRun, onCheckNativeRun, onContinueNativeRun, nativeRecoveries, onSendQueuedNow, onRestoreNativeRun, onTurnAction, onExpandRow });
  useLayoutEffect(() => { handlers.current = { onOpenPath, onOpenInEditor, onOpenTerminal, onRetryNativeRun, onCancelNativeRun, onCheckNativeRun, onContinueNativeRun, nativeRecoveries, onSendQueuedNow, onRestoreNativeRun, onTurnAction, onExpandRow }; });
  const stable = useMemo(() => ({
    openPath: (path: string, line?: number) => handlers.current.onOpenPath(path, line),
    openInEditor: (path: string, line?: number) => handlers.current.onOpenInEditor?.(path, line),
    openTerminal: () => handlers.current.onOpenTerminal?.(),
    retry: (run: Run) => handlers.current.onRetryNativeRun?.(run),
    cancel: (run: Run) => handlers.current.onCancelNativeRun?.(run),
    check: (run: Run) => handlers.current.onCheckNativeRun?.(run),
    continue: (run: Run) => handlers.current.onContinueNativeRun?.(run),
    restore: (run: Run) => handlers.current.onRestoreNativeRun?.(run),
    sendNow: (run: Run) => handlers.current.onSendQueuedNow?.(run),
    turnAction: (action: TurnAction, runId: string) => handlers.current.onTurnAction?.(action, runId),
    expand: (key: string) => handlers.current.onExpandRow?.(key) ?? Promise.resolve(false),
  }), []);
  const fresh = seen.current?.fresh;
  const rowContext = useMemo<RowContext>(() => ({
    sessionId, onOpenSession, fresh, root, completedProcessesOpen, virtual, following: scroll.following,
    measure: rowObserver.measure,
    onOpenPath: stable.openPath,
    ...(onOpenInEditor ? { onOpenInEditor: stable.openInEditor } : {}),
    ...(onOpenTerminal ? { onOpenTerminal: stable.openTerminal } : {}),
    ...(onRetryNativeRun ? { onRetryNativeRun: stable.retry } : {}),
    ...(onCancelNativeRun ? { onCancelNativeRun: stable.cancel } : {}),
    ...(onCheckNativeRun ? { onCheckNativeRun: stable.check } : {}),
    ...(onContinueNativeRun ? { onContinueNativeRun: stable.continue } : {}),
    nativeRecoveries,
    ...(onRestoreNativeRun ? { onRestoreNativeRun: stable.restore } : {}),
    ...(onSendQueuedNow ? { onSendQueuedNow: stable.sendNow } : {}),
    ...(onTurnAction ? { onTurnAction: stable.turnAction } : {}),
    ...(onExpandRow ? { onExpandRow: stable.expand } : {}),
  }), [sessionId, onOpenSession, fresh, root, completedProcessesOpen, virtual, rowObserver, stable, Boolean(onOpenInEditor), Boolean(onOpenTerminal), Boolean(onRetryNativeRun), Boolean(onCancelNativeRun), Boolean(onCheckNativeRun), Boolean(onContinueNativeRun), nativeRecoveries, Boolean(onSendQueuedNow), Boolean(onRestoreNativeRun), Boolean(onTurnAction), Boolean(onExpandRow)]);

  // The working line holds the turn's footer unless a later inline activity has taken its place.
  const heldFooter = heldFooterRow(rowsAll);
  // A visible compaction row already carries progress. Its preceding turn needs no empty slot.
  const suppressHeldFooter = running && !progress && showsRunningCompaction(timeline);
  const latestRows = rowTurns.at(-1)?.rows;
  const renderRow = (row: TranscriptRow) => (
    <RememberedScope.Provider key={row.key} value={row.key}>
      <TranscriptRowView
        row={row}
        highlighted={highlight === row.key}
        reveal={reveal?.row === row.key ? reveal : undefined}
        actionPending={row.type === 'item' && row.item.kind === 'user' && row.item.run ? runActionPending?.(row.item.run) ?? false : false}
        suppressHeldFooter={suppressHeldFooter || row.key !== heldFooter}
        latestTurn={latestRows?.includes(row) ?? false}
        footerPinned={row === rowsAll.at(-1)}
        {...(row.key === heldFooter && progress ? { progress } : {})}
        context={rowContext}
      />
    </RememberedScope.Provider>
  );

  /*
   * 会话内查找. ⌘F / Ctrl+F over the conversation on screen opens a find bar that matches the model
   * instead of the DOM: a windowed list and a block never opened leave most of a long transcript out
   * of the page, where the browser's own find cannot see it. A second press inside the bar is the
   * browser's again.
   */
  const [find, setFind] = useState<{ query: string; index: number }>();
  const findInput = useRef<HTMLInputElement>(null);
  /** Where the keyboard was before the bar took it, and goes back to when it closes. */
  const findReturn = useRef<HTMLElement | null>(null);
  const needle = find?.query.toLowerCase() ?? '';
  const hits = useMemo(() => (needle ? findHits(rowsAll, needle, root) : []), [rowsAll, needle, root]);
  const findTotal = hits.reduce((sum, hit) => sum + hit.count, 0);
  const findOpen = useRef(false);
  findOpen.current = Boolean(find);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = isApplePlatform ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!mod || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'f' || event.defaultPrevented || isComposingKey(event)) return;
      const scroller = scrollRef.current;
      // Only the conversation on screen: not one hidden behind a subagent page, behind the
      // fullscreen composer or under a dialog, and not while the keyboard is in a side panel or a
      // terminal (the dock shares the session's `main`; the page's own find still reads its rows).
      if (!scroller || !scroller.getClientRects().length || scroller.closest('[inert]')) return;
      const active = document.activeElement;
      const dialog = scroller.closest('[role="dialog"],[role="alertdialog"]');
      const region = dialog ?? scroller.closest('main') ?? frameRef.current?.parentElement;
      if (active === findInput.current || (active instanceof Element && active !== document.body && region && !region.contains(active))) return;
      if (active instanceof Element && (active.closest('[data-terminal]') || active.closest('[role="dialog"],[role="alertdialog"]') !== dialog)) return;
      event.preventDefault();
      if (!findOpen.current) findReturn.current = active instanceof HTMLElement && active !== document.body ? active : null;
      flushSync(() => setFind((current) => current ?? { query: '', index: 0 }));
      findInput.current?.focus();
      findInput.current?.select();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  useEffect(() => { setFind(undefined); setFindTarget(undefined); setHighlight(undefined); }, [scrollScope]);
  /** Lands on occurrence [index] (counted across [list]) of [lower]. */
  const showHit = (list: readonly FindHit[], lower: string, index: number) => {
    let rest = index;
    for (const hit of list) {
      if (rest < hit.count) { setFindTarget({ key: hit.key, needle: lower, nth: rest }); return; }
      rest -= hit.count;
    }
  };
  /** A new query starts from the reader: the first occurrence at or below the top of the view, else the last one above it. */
  const search = (query: string) => {
    const lower = query.toLowerCase();
    const list = lower ? findHits(rowsAll, lower, root) : [];
    const scroller = scrollRef.current;
    const anchor = scroller ? captureReadingAnchor(scroller, modelAnchor).rows[0]?.key : undefined;
    const reading = Math.max(0, anchor ? rowsAll.findIndex((row) => row.key === anchor) : 0);
    let index = 0, seen = 0;
    for (const hit of list) {
      if (hit.row >= reading) { index = seen; break; }
      seen += hit.count;
      index = seen - 1;
    }
    setFind({ query, index });
    if (list.length) showHit(list, lower, index);
    else flashRange(undefined);
  };
  const step = (delta: number) => {
    if (!find || !findTotal) return;
    const index = (((Math.min(find.index, findTotal - 1) + delta) % findTotal) + findTotal) % findTotal;
    setFind({ ...find, index });
    showHit(hits, needle, index);
  };
  const closeFind = () => {
    setFind(undefined);
    flashRange(undefined);
    const back = findReturn.current;
    findReturn.current = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
  };

  return (
    <div ref={frameRef} className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        data-transcript-scroll
        // Never scrolls sideways: a column sliding after a session step (`useSessionLayout`) would
        // otherwise overflow it for the slide's length and flash a horizontal scrollbar.
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain [scrollbar-gutter:stable] [overflow-anchor:none]"
      >
        <div
          ref={contentRef}
          data-content-column={embedded ? undefined : true}
          role="region"
          aria-label={t`会话记录`}
          aria-busy={running || loadingEarlier || !loaded || undefined}
          className={cn('mx-auto flex w-full flex-col pb-4', embedded ? 'px-4 pt-4' : 'max-w-(--content-width) px-3 pt-6 sm:px-4 sm:pt-8 md:px-12', loaded && 'animate-in fade-in-0 duration-[var(--duration-slow)]')}>
          {showLoading && <div className="flex justify-center py-24"><Spinner className="size-5" /></div>}
          <FeedbackNotice scope={sessionId} tone="warning" className="mb-5" message={historyLoad.state === 'error' && (historyLoad.message || t`无法同步最新会话记录。`)}
            action={() => <Button size="xs" variant="secondary" onClick={() => onRetryHistory?.()}><IconRefreshCw /><Trans>重试同步</Trans></Button>}
            recovered={historyLoad.state === 'ready'} renderMessage={message => <FailureDetails text={t`无法同步最新会话记录。`} detail={message.text} />} />
          {loaded && !hasMoreHistory && lead}
          {loaded && !timeline.length && empty}
          <FeedbackNotice scope={sessionId} message={loaded && historyContextIncomplete && t`这段历史的前置上下文不完整，部分工具结果可能需要加载更早记录后才能完整显示。`} tone="neutral" className="mb-4" noticeClassName="rounded-lg px-3 py-2 text-xs text-fg-3" icon={null} />
          {/* Older history loads ahead of the reader; a page on its way shows here, and a retry once loading keeps failing. */}
          {loaded && hasMoreHistory && <PageProbe probeRef={earlierProbe} failed={earlier.failed} loading={loadingEarlier} onRetry={earlier.retry} className="mb-5" />}
          {/* A streamed frame hands unchanged rows back as the same objects, so their memo still holds.
              A long list mounts only a window of them, with empty spacers standing in for the height of
              the rest; the spacers keep their keys, so the rows never remount when the mode changes. */}
          <TranscriptCatchUp.Provider value={catchUp}><RememberedValues.Provider value={remembered}>
          {layout ? (() => {
            const mounted: ReactNode[] = [];
            let cursor = 0;
            segments.forEach(([from, to], segment) => {
              mounted.push(<div key={`space:${segment}`} ref={segment === 0 ? listMarker : undefined} aria-hidden data-virtual-spacer style={{ height: layout.offsets[from]! - layout.offsets[cursor]! }} />);
              for (let index = from; index < to; index += 1) mounted.push(renderRow(rowsAll[index]!));
              cursor = to;
            });
            mounted.push(<div key="space:end" aria-hidden data-virtual-spacer style={{ height: layout.offsets[rowsAll.length]! - layout.offsets[cursor]! }} />);
            return mounted;
          })() : rowsAll.map(renderRow)}
          </RememberedValues.Provider></TranscriptCatchUp.Provider>
          {loaded && hasMoreLater && <PageProbe probeRef={laterProbe} failed={later.failed} loading={loadingLater} onRetry={later.retry} className="mt-5" />}
          {children}
          {progress && !heldFooter && <div className={timeline.length ? 'mt-3' : ''}>{progress}</div>}
        </div>
      </div>

      {!embedded && <ContentWidthHandle
        left={handleLeft}
        onStart={() => columnWidth.current}
        onDrag={(next) => previewContentWidth(Math.min(next, widthCeiling()))}
        onCommit={(next) => setContentWidth(Math.min(next, widthCeiling()))}
        onCancel={discardContentWidthPreview}
        onReset={resetContentWidth}
      />}

      {!embedded && !resources && <ChapterNavigation scrollRef={scrollRef} columnRef={contentRef} onNavigate={navigateToChapter} scope={`${sessionId}:${resetVersion}`} />}

      <div role="status" className="sr-only">{announcement.text && <span key={announcement.seq}>{announcement.text}</span>}</div>
      {!resources && <MarkLayer scrollRef={scrollRef} onDiscuss={onDiscuss} />}
      {find && (
        <div role="search" className="absolute right-3 top-3 z-10 flex items-center gap-0.5 rounded-xl border border-line bg-elevated/95 p-1 shadow-xs backdrop-blur max-md:left-3">
          <label className="relative min-w-0 flex-1">
            <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-4" />
            <Input
              ref={findInput}
              autoFocus
              value={find.query}
              aria-label={t`在会话中查找`}
              className="h-7 w-56 pl-8 max-md:w-full"
              onChange={(event) => search(event.target.value)}
              onKeyDown={(event) => {
                if (isComposingKey(event.nativeEvent)) return;
                if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
                else if (event.key === 'Escape') { event.preventDefault(); closeFind(); }
              }}
            />
          </label>
          {find.query && <span role="status" className="shrink-0 px-1.5 text-xs tabular-nums text-fg-3">{findTotal ? Math.min(find.index, findTotal - 1) + 1 : 0}/{findTotal}</span>}
          <Button size="icon-sm" variant="quiet" aria-label={t`上一个`} disabled={!findTotal} onClick={() => step(-1)}><IconChevronDown className="rotate-180" /></Button>
          <Button size="icon-sm" variant="quiet" aria-label={t`下一个`} disabled={!findTotal} onClick={() => step(1)}><IconChevronDown /></Button>
          <Button size="icon-sm" variant="quiet" aria-label={t`关闭查找`} onClick={closeFind}><IconX /></Button>
        </div>
      )}
      {seeking && (
        <div role="status" className="absolute left-1/2 top-3 z-10 inline-flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-elevated/95 px-3 text-xs text-fg-2 shadow-xs backdrop-blur">
          <Spinner className="size-3.5" /><Trans>正在定位…</Trans>
        </div>
      )}
      {!embedded && !outlineTarget && <TurnRail turns={turns} turnsVersion={turnsVersion} marked={markedKeys} scrollRef={scrollRef} columnRef={contentRef} onJump={onJump} onNavigate={navigateToRow} navigationVersion={scroll.intentVersion} rows={rowIndex} onLoadTurn={onLoadTurn ? loadTurn : undefined} />}
      {!embedded && outlineTarget && createPortal(<TurnOutline turns={turns} turnsVersion={turnsVersion} scrollRef={scrollRef} columnRef={contentRef} onJump={onJump} onNavigate={navigateToRow} navigationVersion={scroll.intentVersion} rows={rowIndex} onLoadTurn={onLoadTurn ? loadTurn : undefined} />, outlineTarget)}
      {confirmationOffscreen && (
        <button
          type="button"
          onClick={jumpToConfirmation}
          className="absolute bottom-12 left-1/2 z-10 inline-flex h-9 max-md:bottom-16 max-md:h-11 -translate-x-1/2 items-center gap-1.5 rounded-full border border-warning/30 bg-elevated/95 px-3 text-xs font-medium text-fg-2 shadow-xs backdrop-blur transition-colors hover:text-fg"
        >
          {pendingConfirmationCount > 1 ? t`${pendingConfirmationCount} 项待确认` : t`需要确认`} · <Trans>查看</Trans>
        </button>
      )}
      <button
        type="button"
        tabIndex={atBottom ? -1 : 0}
        aria-hidden={atBottom}
        onClick={scrollToBottom}
        className={cn(
          'absolute bottom-3 left-1/2 z-10 inline-flex h-7 max-md:h-11 -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-elevated/95 px-3 text-xs font-medium text-fg-2 shadow-xs backdrop-blur transition-[opacity,transform] duration-[var(--duration-base)] ease-out-soft hover:text-fg',
          atBottom ? 'pointer-events-none translate-y-2 opacity-0' : 'translate-y-0 opacity-100',
        )}
      >
        <IconArrowDown className="size-3.5" /><Trans>回到底部</Trans>
      </button>
    </div>
  );
}
