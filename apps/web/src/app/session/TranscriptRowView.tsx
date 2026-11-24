import { memo, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { useLingui } from '@lingui/react/macro';
import { IconChevronDown, IconChevronRight, IconRefreshCw, IconWrench } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { Spinner } from '@/components/ui/controls';
import type { NativeRunRecovery, Run } from '@contracts';
import { cn } from '@/lib/utils';
import { truncationOf } from '@/sync/rows';
import { ActivityRow } from './Activities';
import { AgentCallRow, agentToolName } from './agentCalls';
import { MarkSourceContext } from './marks';
import { timelineItemTime, type TimelineItem } from './model';
import { RememberedScope, RememberedValues, useRemembered } from './rememberedState';
import { AnswerActions, AssistantMessage, ImageBlock, MergedToolRow, MessageFooter, PlanBlock, StatusRow, TaskNotificationRow, ThoughtRow, toolIcons, ToolRow, TopicDivider, TurnTriggerBlock, useItemsDiffStats, UserMessage, type TurnAction } from './Timeline';
import { groupAdjacentToolRunEntries, toolKind, toolRunSummary } from './toolView';
import { shareModelKey, shareModelLabel, useTranscriptResources } from './transcriptResources';
import type { TranscriptRow } from './transcriptRows';
import { TranscriptCatchUp, TurnProcess } from './TurnProcess';
import type { ProcessFoldTiming } from './viewPrefs';
import { rescaledHeight } from './virtualRows';
import { markTargetOf } from './marks';

const time = (value: string) => { const at = new Date(value).getTime(); return Number.isFinite(at) ? at : undefined; };

/** Settled `/new` topic boundary in the personal assistant's main conversation. */
export function isSettledNewTopic(item: TimelineItem): boolean {
  if (item.kind !== 'user' || item.text.trim() !== '/new' || item.attachments.length || item.references?.length) return false;
  if (!item.run) return true;
  return item.run.state === 'completed' && !item.run.error;
}

/**
 * A new row fades in where it lands. No slide: following the end, a row rising into place while the
 * view keeps the bottom reads as the whole transcript bouncing.
 */
const enter = 'animate-in fade-in-0 duration-[var(--duration-slow)] ease-[var(--ease-decelerate)]';

/** Delegations stand on their own inside the process rather than joining tools; so does a call of another Agent (docs/AGENT-CALLS.md). */
function isToolRunItem(item: TimelineItem | undefined): item is Extract<TimelineItem, { kind: 'tool' }> {
  return item?.kind === 'tool' && toolKind(item.event) !== 'agent' && agentToolName(item.event.data) !== 'agent_call';
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

function rememberedItemOpen(remembered: ReadonlyMap<string, unknown> | undefined, item: TimelineItem): boolean {
  if (!remembered) return false;
  const prefix = `${item.key}\n`;
  return remembered.get(`${prefix}tool`) === true
    || remembered.get(`${prefix}job`) === true
    || remembered.get(`${prefix}thought`) === true
    || remembered.get(`${prefix}notice`) === true
    || remembered.get(`${prefix}activity`) === true;
}

function hasOpenProcessDetail(remembered: ReadonlyMap<string, unknown> | undefined, items: readonly TimelineItem[], runs: ReadonlyMap<number, number>): boolean {
  if (!remembered?.size) return false;
  for (let index = 0; index < items.length;) {
    const end = runs.get(index);
    if (end !== undefined) {
      const choice = remembered.get(`${items[index]!.key}\ntool-run-choice`);
      if (choice === true) return true;
      if (choice !== false) {
        for (let at = index; at < end; at += 1) if (rememberedItemOpen(remembered, items[at]!)) return true;
      }
      index = end;
      continue;
    }
    if (rememberedItemOpen(remembered, items[index]!)) return true;
    index += 1;
  }
  return false;
}

/** A run of ordinary tool calls within the open process. */
function ToolRun({ items, entries, followedByContent, latestTurn, root, children, reveal }: { items: Extract<TimelineItem, { kind: 'tool' }>[]; entries: readonly TimelineItem[]; followedByContent: boolean; latestTurn: boolean; root?: string; children: ReactNode; reveal?: number }) {
  const remembered = useContext(RememberedValues);
  const [, refresh] = useState(0);
  const summary = useMemo(() => toolRunSummary(items, root), [items, root]);
  const diffStats = useItemsDiffStats(items, root);
  const Icon = toolIcons[summary.kind] ?? IconWrench;
  const [choice, setChoice] = useRemembered<boolean | undefined>('tool-run-choice', undefined);
  const { catchingUp, quiet } = useContext(TranscriptCatchUp);
  // Mounted before the transcript caught up, a run of the newest turn may be the tail of the copy only:
  // it waits folded until what follows it is known, rather than showing open and folding as the rest
  // arrives. An earlier turn is over; nothing catching up brings changes it.
  const unconfirmed = useRef(catchingUp && latestTurn);
  if (!catchingUp) unconfirmed.current = false;
  const childOpen = entries.some((entry) => rememberedItemOpen(remembered, entry));
  // Subsequent content (prose, delegation, or the answer) folds a tool run regardless of whether a
  // command inside it is still running in the background, unless the reader opened a row inside it.
  // A growing tail opens by default, while an explicit reader choice still controls it.
  const open = choice ?? (unconfirmed.current ? false : !followedByContent || childOpen);
  const contentsId = useId();
  useLayoutEffect(() => { if (reveal !== undefined) setChoice(true); }, [reveal, setChoice]);
  return (
    <div data-tool-run-open={open} data-tool-run-choice={choice === true ? 'true' : undefined} className="flex min-w-0 flex-col">
      <button type="button" aria-expanded={open} aria-controls={open ? contentsId : undefined} onClick={() => setChoice(!open)}
        className="group/tool-run flex min-h-[calc(24px*var(--text-scale))] w-fit max-w-full items-center gap-2 rounded-md text-left text-sm text-fg-3 transition-colors hover:text-fg-2 no-hover:min-h-9">
        <span className="grid size-4 shrink-0 place-items-center text-fg-4 [&_svg]:size-[15px]"><Icon /></span>
        <span className="min-w-0 truncate">{summary.label}</span>
        {diffStats && (diffStats.added > 0 || diffStats.removed > 0) && (
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums">
            {diffStats.added > 0 && <span className="text-[var(--diff-add-marker)]">+{diffStats.added}</span>}
            {diffStats.removed > 0 && <span className="text-[var(--diff-del-marker)]">−{diffStats.removed}</span>}
          </span>
        )}
        {/* Like a tool row's: the chevron shows under the pointer or while open, and always on touch. */}
        <IconChevronRight className={cn('size-3.5 shrink-0 text-fg-4 transition-[opacity,transform] duration-[var(--duration-base)] ease-out-soft', open ? 'rotate-90' : 'can-hover:opacity-0 can-hover:group-hover/tool-run:opacity-100')} />
      </button>
      <Collapse open={open} keep still={quiet} id={contentsId} onReveal={() => setChoice(true)}>
        <div className="ml-2 mt-0.5 mb-1.5 flex min-w-0 flex-col edge-l pl-4 pt-0.5" onClick={() => refresh((n) => n + 1)}>{children}</div>
      </Collapse>
    </div>
  );
}

/**
 * How long a row that arrived live counts as new. The entrance plays once, as it mounts; a row that
 * mounts again later (a folded block opened, a row scrolled back into a recycled list) must not
 * replay it, so the mark expires rather than lasting for the session.
 */
export const FRESH_MS = 1000;
/** How long after catching up its last changes still land without animating. */
export const SETTLE_MS = 300;
export interface Fresh { until: number; row?: string }
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

/**
 * Measures the mounted rows. A row's extent is its box plus its margins, because the gaps between
 * rows are margins and the list's offsets must add up to what the column really occupies. The
 * heights are only written down here; the list reads them the next time it lays itself out, since
 * a mounted row is in the DOM at its real size whatever the list believes about it.
 */
export function createRowObserver(heights: Map<string, number>, markDirty: () => void) {
  const observed = new Map<string, HTMLElement>();
  let observer: ResizeObserver | undefined;
  const extent = (element: HTMLElement, box: number, style = getComputedStyle(element)) =>
    box + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
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
      observer ??= new ResizeObserver((entries) => {
        let changed = false;
        for (const entry of entries) {
          const target = entry.target as HTMLElement;
          const rowKey = target.dataset.rowKey;
          if (rowKey && target.isConnected) changed = record(rowKey, extent(target, entry.borderBoxSize?.[0]?.blockSize ?? target.getBoundingClientRect().height)) || changed;
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
    /**
     * Synchronously refreshes heights of currently mounted rows so windowed layout checks inside a
     * commit (such as an instant process fold) see the new heights before the async ResizeObserver.
     */
    syncMounted() {
      let changed = false;
      for (const [key, element] of observed) {
        if (!element.isConnected) continue;
        changed = record(key, extent(element, element.getBoundingClientRect().height)) || changed;
      }
      return changed;
    },
    disconnect() { observer?.disconnect(); observed.clear(); },
  };
}

/** What every row needs besides its own data. The handlers are stable for the view's lifetime. */
export interface RowContext {
  sessionId: string;
  onOpenSession?: (id: string) => void;
  /** Reports a mounted row's element (or its going away) so its height is known to the windowed list. */
  measure: (key: string, element: HTMLElement | null) => void;
  /** The list is windowed: rows scroll out of the DOM and come back, so their layout must not depend on staying mounted. */
  virtual: boolean;
  /** Rows that arrived after the transcript first showed, until when their entrance may play. */
  fresh: ReadonlyMap<string, Fresh> | undefined;
  root?: string;
  onOpenPath?: ((path: string, line?: number) => void) | undefined;
  onOpenInEditor?: (path: string, line?: number) => void;
  onOpenTerminal?: () => void;
  onRetryNativeRun?: (run: Run) => void;
  onCancelNativeRun?: (run: Run) => void;
  onCheckNativeRun?: (run: Run) => void;
  onContinueNativeRun?: (run: Run) => void;
  nativeRecoveries?: Record<string, NativeRunRecovery>;
  onRestoreNativeRun?: (run: Run) => void;
  onTurnAction?: (action: TurnAction, runId: string) => void;
  /** Fetches the whole of a row sent cut to a preview (sync v3). */
  onExpandRow?: (key: string) => Promise<boolean>;
  completedProcessesOpen?: boolean;
  foldTiming: ProcessFoldTiming;
  newTopicDivider?: boolean;
  latestTopicKey?: string;
  canCollapseEarlier?: boolean;
  earlierTopicsCollapsed?: boolean;
  onToggleEarlierTopics?: () => void;
}

/** Under a row the server sent cut to a preview: fetches the rest when asked. */
function TruncatedMore({ item, expand }: { item: TimelineItem; expand?: (key: string) => Promise<boolean> }) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  if (!expand || !truncationOf(item)) return null;
  return (
    <Button size="xs" variant="quiet" className="mt-1 self-start text-fg-3" busy={busy} onClick={() => { setBusy(true); void expand(item.key).finally(() => setBusy(false)); }}>
      <IconChevronDown />{t`显示全部`}
    </Button>
  );
}

/**
 * Where more history loads as the reader nears it: a spinner while a page is on its way, a retry once loading keeps failing.
 * Its box is the retry's height whenever there is more history that way, so neither a page starting nor a failure moves the rows.
 */
export function PageProbe({ probeRef, failed, loading, onRetry, className }: { probeRef: Ref<HTMLDivElement>; failed: boolean; loading?: boolean; onRetry: () => void; className: string }) {
  const { t } = useLingui();
  return (
    <div ref={probeRef} className={cn('flex h-6 items-center justify-center', className)}>
      {failed ? <Button size="xs" variant="quiet" className="text-fg-3" onClick={onRetry}><IconRefreshCw />{t`重新加载`}</Button> : loading && <Spinner />}
    </div>
  );
}

function revealInRange(items: readonly TimelineItem[], start: number, end: number, reveal?: { item: string; version: number }): { item: string; version: number } | undefined {
  if (!reveal) return undefined;
  for (let i = start; i < end; i += 1) {
    if (items[i]!.key === reveal.item) return reveal;
  }
  return undefined;
}

const ToolRunBlock = memo(function ToolRunBlock({ items, start, end, lastOutputIndex, rowKey, gap, running, latestTurn, followedByContent, reveal, fresh, root, onOpenPath, onOpenInEditor, onExpandRow }: {
  items: readonly TimelineItem[];
  start: number;
  end: number;
  lastOutputIndex: number;
  rowKey: string;
  gap?: string;
  running: boolean;
  latestTurn: boolean;
  followedByContent: boolean;
  reveal?: { item: string; version: number };
  fresh?: ReadonlyMap<string, Fresh>;
  root?: string;
  onOpenPath?: (path: string, line?: number) => void;
  onOpenInEditor?: (path: string, line?: number) => void;
  onExpandRow?: RowContext['onExpandRow'];
}) {
  const run = useMemo(() => items.slice(start, end), [items, start, end]);
  const tools = useMemo(() => run.filter(isToolRunItem), [run]);
  const grouped = useMemo(() => groupAdjacentToolRunEntries(run, root), [run, root]);
  const moreOf = useCallback(
    (entry: Extract<TimelineItem, { kind: 'tool' }>) =>
      onExpandRow && truncationOf(entry) ? <TruncatedMore item={entry} expand={onExpandRow} /> : undefined,
    [onExpandRow],
  );
  const firstKey = items[start]!.key;
  return (
    <RememberedScope.Provider value={firstKey}>
      <div className={cn('min-w-0', gap, isFresh(fresh, firstKey, rowKey) && enter)}>
        <ToolRun items={tools} entries={run} latestTurn={latestTurn} root={root} followedByContent={followedByContent} reveal={reveal?.version}>
          {grouped.map((entry) => entry.kind === 'single' ? (
            <div key={entry.item.key} data-item-key={entry.item.key} className={cn('min-w-0', isFresh(fresh, entry.item.key, rowKey) && enter)}>
              <RememberedScope.Provider value={entry.item.key}><MarkSourceContext.Provider value={entry.item.event}>
                {entry.item.kind === 'tool'
                  ? <ToolRow item={entry.item} onOpenPath={onOpenPath} onOpenInEditor={onOpenInEditor} root={root} stale={!running} more={moreOf(entry.item)} />
                  : entry.item.kind === 'thought' ? <ThoughtRow text={entry.item.text} channel={entry.item.channel} running={running && start + entry.index === lastOutputIndex} /> : null}
              </MarkSourceContext.Provider></RememberedScope.Provider>
            </div>
          ) : (
            <div key={entry.key} className={cn('min-w-0', isFresh(fresh, entry.key, rowKey) && enter)}>
              <RememberedScope.Provider value={entry.key}>
                <MergedToolRow
                  items={entry.items}
                  presentation={entry.presentation}
                  onOpenPath={onOpenPath}
                  onOpenInEditor={onOpenInEditor}
                  root={root}
                  moreOf={moreOf}
                  reveal={reveal && entry.items.some(sub => reveal.item === sub.key) ? reveal.version : undefined}
                />
              </RememberedScope.Provider>
            </div>
          ))}
        </ToolRun>
      </div>
    </RememberedScope.Provider>
  );
});

/**
 * `actionPending` is the row's own answer to `runActionPending`, asked by the list: a send or an
 * interrupt flips it for every message at once, and as a plain flag it re-renders only the rows
 * whose answer actually changed, instead of invalidating the shared context for all of them.
 */
export const TranscriptRowView = memo(function TranscriptRowView({ row, slot, highlighted, reveal, actionPending, progress, progressShown = false, suppressHeldFooter, latestTurn, footerPinned, context }: { row: TranscriptRow; slot: string; highlighted: boolean; reveal?: { item: string; version: number }; actionPending: boolean; progress?: ReactNode; progressShown?: boolean; suppressHeldFooter: boolean; latestTurn: boolean; footerPinned: boolean; context: RowContext }) {
  const { fresh, root, onOpenPath, onOpenInEditor, measure } = context;
  const resources = useTranscriptResources();
  const remembered = useContext(RememberedValues);
  const attach = useCallback((element: HTMLElement | null) => measure(row.key, element), [measure, row.key]);
  // Both explicit choices survive virtual unmounting; undefined means automatic folding.
  const [processChoice, rememberProcessChoice] = useRemembered<boolean | undefined>('process', undefined);
  const markTarget = useMemo(() => row.type === 'item' ? markTargetOf(row.item, row.runId) : undefined, [row]);
  const hasTurnFooter = row.type !== 'trigger' && row.footer !== 'none' && (row.footer !== 'held' || !suppressHeldFooter);
  const footerProgress = row.type !== 'trigger' && row.footer === 'held' && !suppressHeldFooter ? { progress: progress ?? null } : {};
  if (row.type === 'process') {
    const { items, gaps, running } = row;
    // Background task status can settle much later than its owning process. Its elapsed time
    // belongs to the task row; the process header and footer follow actual model output.
    const output = (item: TimelineItem) => item.kind !== 'activity' && item.kind !== 'task_notification';
    const first = items.find(output)!;
    const lastOutputIndex = items.findLastIndex(output);
    const runs = toolRuns(items);
    const detailOpen = hasOpenProcessDetail(remembered, items, runs);
    const runCovered = new Set([...runs].flatMap(([start, end]) => Array.from({ length: end - start - 1 }, (_, offset) => start + 1 + offset)));
    const lastTime = timelineItemTime(items[lastOutputIndex]!);
    return (
      <div ref={attach} data-row-key={row.key} data-row-slot={slot} className={cn(
        // `-mx-2` widens the row by the turn header's own padding so the icon stays on the text
        // column; `TurnProcess` cancels it for the expanded contents.
        '-mx-2 min-w-0',
        hasTurnFooter && 'turn-footer-row can-hover:-mx-6 can-hover:px-4',
        row.spaced ? 'timeline-gap-block' : '',
        highlighted && 'timeline-focus-hit',
      )}>
        <TurnProcess
          running={running}
          issueCount={row.issueCount}
          interrupted={row.interrupted}
          stopped={row.stopped}
          startedAt={time(first.event.createdAt)}
          endedAt={time(lastTime)}
          footerTime={row.settled ? lastTime : undefined}
          footerPinned={footerPinned}
          footerActions={<AnswerActions text={row.answerText} runId={row.runId} onTurnAction={context.onTurnAction} at={lastTime} />}
          defaultOpen={context.completedProcessesOpen}
          canAutoFold={row.canAutoFold && (context.foldTiming === 'turn-end' || !latestTurn)}
          detailOpen={detailOpen}
          choice={processChoice}
          onOpenChange={rememberProcessChoice}
          reveal={reveal?.version}
          {...footerProgress}
        >
          {items.map((item, itemIndex) => {
            if (runCovered.has(itemIndex)) return null;
            const end = runs.get(itemIndex);
            if (end !== undefined) {
              return (
                <ToolRunBlock
                  key={item.key}
                  items={items}
                  start={itemIndex}
                  end={end}
                  lastOutputIndex={lastOutputIndex}
                  rowKey={row.key}
                  gap={gaps[itemIndex]}
                  running={running}
                  latestTurn={latestTurn}
                  followedByContent={(!row.interrupted && row.followedByAnswer) || end < items.length}
                  reveal={revealInRange(items, itemIndex, end, reveal)}
                  fresh={fresh}
                  root={root}
                  onOpenPath={onOpenPath}
                  onOpenInEditor={onOpenInEditor}
                  onExpandRow={context.onExpandRow}
                />
              );
            }
            let inner: ReactNode = null;
            switch (item.kind) {
              case 'tool': inner = agentToolName(item.event.data) === 'agent_call' ? <AgentCallRow item={item} stale={!running} /> : <ToolRow item={item} onOpenPath={onOpenPath} onOpenInEditor={onOpenInEditor} root={root} stale={!running} more={context.onExpandRow && truncationOf(item) ? <TruncatedMore item={item} expand={context.onExpandRow} /> : undefined} />; break;
              case 'thought': inner = <ThoughtRow text={item.text} channel={item.channel} running={running && itemIndex === lastOutputIndex} />; break;
              case 'assistant': inner = <AssistantMessage text={item.text} showActions={false} streaming={running && itemIndex === lastOutputIndex} mark={markTargetOf(item, row.runId)} />; break;
              case 'plan': inner = <PlanBlock entries={item.entries} />; break;
              case 'image': inner = <ImageBlock src={item.src} />; break;
              case 'activity': inner = <ActivityRow item={item} root={root} />; break;
              case 'task_notification': inner = <TaskNotificationRow item={item} root={root} more={<TruncatedMore item={item} expand={context.onExpandRow} />} />; break;
              default: inner = null;
            }
            return (
              <div key={item.key} data-item-key={item.key} className={cn('min-w-0', gaps[itemIndex], isFresh(fresh, item.key, row.key) && enter)}>
                <RememberedScope.Provider value={item.key}><MarkSourceContext.Provider value={item.event}>{inner}</MarkSourceContext.Provider></RememberedScope.Provider>
                {item.kind !== 'tool' && item.kind !== 'task_notification' && <TruncatedMore item={item} expand={context.onExpandRow} />}
              </div>
            );
          })}
        </TurnProcess>
      </div>
    );
  }
  if (row.type === 'trigger') {
    return (
      <div ref={attach} data-row-key={row.key} data-row-slot={slot} className={cn('-ml-1.5 min-w-0 pl-1.5', row.gap)}>
        <TurnTriggerBlock notices={row.notices} root={context.root} moreOf={(notice) => <TruncatedMore item={notice} expand={context.onExpandRow} />} />
      </div>
    );
  }
  const { item, settled } = row;
  let content: ReactNode = null;
  if (item.kind === 'user') {
    if (context.newTopicDivider && isSettledNewTopic(item)) {
      content = (
        <TopicDivider
          time={timelineItemTime(item) || undefined}
          collapsible={Boolean(context.canCollapseEarlier && item.key === context.latestTopicKey)}
          collapsed={Boolean(context.earlierTopicsCollapsed)}
          onToggle={context.onToggleEarlierTopics}
        />
      );
    } else {
      content = <UserMessage stopShown={row.stopped} hasTurnOutput={settled} progressShown={progressShown} from={item.event.data.from === 'coordinator' || item.event.data.from === 'peer' ? item.event.data.from : undefined} text={item.text} attachments={item.attachments} references={item.references} recipientSessionId={context.sessionId} onOpenSession={context.onOpenSession} time={timelineItemTime(item) || undefined} footerPinned={footerPinned} run={item.run} failureShown={item.failureShown} runActionPending={actionPending} onOpenTerminal={context.onOpenTerminal} onRetryNativeRun={context.onRetryNativeRun} onCancelNativeRun={context.onCancelNativeRun} onCheckNativeRun={context.onCheckNativeRun} onContinueNativeRun={context.onContinueNativeRun} nativeRecoveries={context.nativeRecoveries} onRestoreNativeRun={context.onRestoreNativeRun} />;
    }
  }
  else if (item.kind === 'assistant') {
    const models = resources?.modelInfo
      ? item.event.sourceEvents
          .map((source) => ('nativeId' in source && typeof source.nativeId === 'string' && Object.hasOwn(resources.modelInfo!, source.nativeId) ? resources.modelInfo![source.nativeId] : undefined))
          .filter((info): info is NonNullable<typeof info> => Boolean(info))
      : [];
    const showModels = models.length > 0 && (!resources?.commonModelKey || models.some((info) => shareModelKey(info) !== resources.commonModelKey));
    const modelLabel = showModels ? [...new Map(models.map((info) => [shareModelKey(info), shareModelLabel(info)])).values()].join(' / ') : undefined;
    content = <AssistantMessage chapters stopped={row.stopped && settled} text={item.text} showActions={settled} streaming={row.footer === 'held'} time={settled ? timelineItemTime(item) || undefined : undefined} modelLabel={modelLabel} footerPinned={footerPinned} metrics={row.metrics} runId={row.runId} onTurnAction={context.onTurnAction} mark={markTarget} {...footerProgress} />;
  }
  else if (item.kind === 'tool') {
    content = (
      <div className="group/message flex min-w-0 flex-col gap-2.5">
        <RememberedScope.Provider value={item.key}><MarkSourceContext.Provider value={item.event}>
          <ToolRow item={item} onOpenPath={onOpenPath} onOpenInEditor={onOpenInEditor} root={root} stale={row.footer !== 'held'} more={context.onExpandRow && truncationOf(item) ? <TruncatedMore item={item} expand={context.onExpandRow} /> : undefined} />
          {hasTurnFooter && <MessageFooter text={row.answerText} showActions={settled} stopped={row.stopped && settled} time={settled ? timelineItemTime(item) || undefined : undefined} footerPinned={footerPinned} metrics={row.metrics} runId={row.runId} onTurnAction={context.onTurnAction} {...footerProgress} />}
        </MarkSourceContext.Provider></RememberedScope.Provider>
      </div>
    );
  }
  else if (item.kind === 'task_notification') content = <TaskNotificationRow item={item} root={context.root} more={<TruncatedMore item={item} expand={context.onExpandRow} />} />;
  else if (item.kind === 'activity') content = <ActivityRow item={item} root={context.root} />;
  else if (item.kind === 'status') content = <StatusRow tone={item.tone} text={item.text} detail={item.detail} reveal={reveal?.item === item.key ? reveal.version : undefined}
    footer={<MessageFooter text={row.answerText} showActions={settled} time={settled ? timelineItemTime(item) || undefined : undefined} footerPinned={footerPinned} metrics={row.metrics} runId={row.runId} onTurnAction={context.onTurnAction} {...footerProgress} />} />;
  return (
    <div
      ref={attach}
      data-row-key={item.key}
      data-row-slot={slot}
      data-turn={item.kind === 'user' ? item.key : undefined}
      // `-ml-1.5 pl-1.5` widens the row by 6px on the left without moving its content, matching
      // the footer's outward action pill.
      className={cn('-ml-1.5 min-w-0 pl-1.5', hasTurnFooter && 'turn-footer-row can-hover:-ml-5.5 can-hover:-mr-4 can-hover:pl-5.5 can-hover:pr-4', row.gap, highlighted && 'timeline-focus-hit', isFresh(fresh, item.key, row.key) && enter)}
    >
      {content}
      {item.kind !== 'task_notification' && item.kind !== 'tool' && <TruncatedMore item={item} expand={context.onExpandRow} />}
    </div>
  );
});
