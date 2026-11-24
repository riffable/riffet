import { createPortal, flushSync } from 'react-dom';
import { useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconArrowDown, IconRefreshCw } from '@/components/icons';
import { Spinner } from '@/components/ui/controls';
import { FeedbackNotice } from '@/components/ui/feedback-notice';
import { Button } from '@/components/ui/button';
import { cn, scrollBehavior } from '@/lib/utils';
import { DEFAULT_CONTENT_WIDTH, MAX_CONTENT_WIDTH, MIN_CONTENT_WIDTH, discardContentWidthPreview, previewContentWidth, resetContentWidth, setContentWidth } from '@/lib/content-width';
import type { LaneFind, NativeRunRecovery, DiscussionSource, Run, RunMetrics, TurnOutlineV3 } from '@contracts';
import type { NativeHistoryLoadState } from './transcriptLoad';
import { transcriptLoadView } from './transcriptLoad';
import type { TimelineItem } from './model';
import type { TurnAction } from './Timeline';
import { COLUMN_GUTTER_TOTAL, ContentWidthHandle, WIDTH_HANDLE_GAP, WIDTH_HANDLE_WIDTH } from './ContentWidthHandle';
import { showsRunningCompaction } from './Activities';
import { TranscriptCatchUp } from './TurnProcess';
import { useLingering, WAIT_GRACE_MS } from './sessionLayout';
import { SWITCH_HOLD_MS, useSwitchedIn } from './sessionFrame';
import { TurnOutline, TurnRail, type RowIndex, type Turn } from './TurnRail';
import type { MessageFocus } from './focus-message';
import { findRow, type ReadingAnchor } from './readingAnchor';
import { useTranscriptScroll, type TranscriptScrollHandle } from './useTranscriptScroll';
import { heldFooterRow, transcriptTurns, type TranscriptRow, type TranscriptTurn } from './transcriptRows';
import { useEarlierHistory, type EarlierLoad } from './useEarlierHistory';
import { markedTurns, SessionMarksContext } from './marks';
import { MarkLayer } from './MarkLayer';
import { useTranscriptResources } from './transcriptResources';
import { buildLayout, indexAt, OVERSCAN_MIN, segmentsCover, VIRTUAL_MIN_ROWS, VIRTUAL_RELEASE_ROWS, windowSegments, type RowLayout, type Segment } from './virtualRows';
import { RememberedScope, RememberedValues } from './rememberedState';
import { laneTurnOf } from '@/sync/rows';
import { FailureDetails } from './FailureDetails';
import { ChapterNavigation } from './ChapterNavigation';
import { useViewPrefs } from './viewPrefs';
import { createRowObserver, isSettledNewTopic, PageProbe, SETTLE_MS, FRESH_MS, TranscriptRowView, type Fresh, type RowContext } from './TranscriptRowView';
import { TranscriptFindBar, useTranscriptFind } from './transcriptFind';
import { useTranscriptFocus } from './useTranscriptFocus';

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
  onOpenPath?: ((path: string, line?: number) => void) | undefined;
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
  /** Renders settled `/new` commands as topic dividers and collapses earlier topics by default. */
  newTopicDivider?: boolean;
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
  /** 会话内查找 over the whole lane (sync v3); without it, or when it answers nothing, the rows held are what is found. */
  onFind?: (query: string, signal?: AbortSignal) => Promise<LaneFind | undefined>;
  /** Replaces the rows with those around a lane place, for a find hit they do not hold. */
  onLoadPlace?: (pos: number, signal?: AbortSignal) => Promise<boolean>;
  onExpandRow?: (key: string) => Promise<boolean>;
  onOpenTerminal?: () => void;
  onRetryNativeRun?: (run: Run) => void;
  onCancelNativeRun?: (run: Run) => void;
  onCheckNativeRun?: (run: Run) => void;
  onContinueNativeRun?: (run: Run) => void;
  nativeRecoveries?: Record<string, NativeRunRecovery>;
  onRestoreNativeRun?: (run: Run) => void;
  /** Rewinding the code to before a turn, or forking a conversation from it. */
  onTurnAction?: (action: TurnAction, runId: string) => void;
  onDiscuss?: (source: DiscussionSource) => void;
  /** Adds a selection to the conversation's composer as a quote. */
  onQuote?: (quote: string) => void;
  runActionPending?: (run: Run) => boolean;
  /** Measured output speed per run, keyed by the run id a turn key refers to. */
  metricsByRun?: Map<string, RunMetrics>;
  /**
   * Outline status by turn key (`turn`, `turnId`, and `run:<runId>`). Drives whether a process
   * block may fold. Absent, a block still refuses to fold without a final answer or with a live run.
   */
  turnStatusByTurn?: ReadonlyMap<string, TurnOutlineV3['status']>;
  /** A search result asked to see one message: scrolled to, and highlighted briefly. */
  focus?: MessageFocus;
  /**
   * The working line: in the place a running turn holds for its footer (`heldFooterRow`), else after
   * everything else. Shown once loaded, like `empty`: while the history loads, the spinner is the only sign.
   */
  progress?: ReactNode;
}

export function TranscriptView({ embedded = false, scrollHandleRef, sessionId, onOpenSession, timeline, timelineVersion = 0, resetVersion = 0, turns: suppliedTurns, turnsVersion = 0, loaded, catchingUp = false, historyLoad: suppliedHistoryLoad, onRetryHistory, running, activeTurnId, root, onOpenPath, onOpenInEditor, onOpenTerminal, empty, lead, children, pendingConfirmationCount = 0, hasMoreHistory, completedProcessesOpen, newTopicDivider = false, historyContextIncomplete, historyStale, loadingEarlier, onLoadEarlier, hasMoreLater, loadingLater, onLoadLater, onReaderEnd, onJumpToLatest, onLoadTurn, onFind, onLoadPlace, onExpandRow, onRetryNativeRun, onCancelNativeRun, onCheckNativeRun, onContinueNativeRun, nativeRecoveries, onRestoreNativeRun, onTurnAction, onDiscuss, onQuote, runActionPending, metricsByRun, turnStatusByTurn, focus, outlineTarget, progress: suppliedProgress }: Props) {
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
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
    scrollRef, contentRef, spacerRef, sessionId, resetVersion, loaded,
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
    if (windowed.current && !scroll.following.current && rowObserver.syncMounted() && layoutCache.current) {
      layoutCache.current.dirty = true;
    }
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
  const settledNewTopicKeys = useMemo(() => {
    if (!newTopicDivider) return undefined;
    const keys = new Set<string>();
    for (const item of timeline) {
      if (isSettledNewTopic(item)) keys.add(item.key);
    }
    return keys;
  }, [newTopicDivider, timeline, timelineVersion]);
  const turns = useMemo<Turn[]>(() => {
    if (suppliedTurns) {
      if (!newTopicDivider) return suppliedTurns;
      let changed = false;
      const mapped = suppliedTurns.map((turn) => {
        const settled = settledNewTopicKeys?.has(turn.key) || (turn.key.startsWith('outline-turn:') && turn.text.trim() === '/new');
        if (!settled) return turn;
        changed = true;
        return { ...turn, text: t`新话题` };
      });
      return changed ? mapped : suppliedTurns;
    }
    return timeline.flatMap((item) => (item.kind === 'user' ? [{ key: item.key, text: newTopicDivider && isSettledNewTopic(item) ? t`新话题` : item.text.trim() || (item.attachments.length ? t`附件` : ''), at: item.event.createdAt }] : []));
  }, [suppliedTurns, timeline, timelineVersion, newTopicDivider, settledNewTopicKeys, t]);
  const latestTopicIndex = useMemo(() => {
    if (!newTopicDivider || hasMoreLater) return -1;
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      if (isSettledNewTopic(timeline[index]!)) return index;
    }
    return -1;
  }, [newTopicDivider, hasMoreLater, timeline, timelineVersion]);
  const latestTopicKey = latestTopicIndex >= 0 ? timeline[latestTopicIndex]!.key : undefined;
  const [expandedTopicKey, setExpandedTopicKey] = useState<string | undefined>(undefined);
  useEffect(() => { setExpandedTopicKey(undefined); }, [sessionId, resetVersion]);
  const canCollapseEarlier = Boolean(latestTopicKey && (latestTopicIndex > 0 || hasMoreHistory));
  const earlierTopicsOpen = Boolean(latestTopicKey && expandedTopicKey === latestTopicKey);
  const earlierTopicsCollapsed = canCollapseEarlier && !earlierTopicsOpen;
  const displayTimeline = useMemo(() => (
    earlierTopicsCollapsed && latestTopicIndex > 0 ? timeline.slice(latestTopicIndex) : timeline
  ), [earlierTopicsCollapsed, latestTopicIndex, timeline, timelineVersion]);
  const toggleEarlierTopics = useCallback(() => {
    if (!latestTopicKey) return;
    setExpandedTopicKey((current) => (current === latestTopicKey ? undefined : latestTopicKey));
  }, [latestTopicKey]);
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
  const progress = loaded ? suppliedProgress : undefined;
  const historyLoad = suppliedHistoryLoad ?? { state: loaded ? 'ready' : 'loading' };
  const loadView = transcriptLoadView(loaded, historyLoad);
  const showLoading = useLingering(loadView === 'loading', WAIT_GRACE_MS);
  // Replacing another conversation, the transcript fades in once, briefly, as the Mac's does; the frame
  // around it stays. Opening the page, or a copy that had to be waited for, arrives as before.
  const loadedInPlace = useSwitchedIn(loaded);
  // A copy painted from memory or disk is only the tail the last visit saved: catching up still
  // brings the rows after it, unfolds the newest turn's run, and moves the bottom the view is pinned
  // to. Replacing another conversation, it stays unseen until it has caught up, so the one fade shows
  // it settled; a server slower than `SWITCH_HOLD_MS` gets the copy shown rather than a blank column.
  const heldLong = useLingering(loadedInPlace, SWITCH_HOLD_MS);
  const holding = loadedInPlace && catchingUp && !heldLong;
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

  const scrollScope = `${sessionId}:${resetVersion}`;
  useEffect(() => { setHighlight(undefined); }, [scrollScope]);

  const earlier = useEarlierHistory({
    scrollRef, probeRef: earlierProbe, scope: `${sessionId}:${resetVersion}`,
    enabled: loaded && !earlierTopicsCollapsed && Boolean(hasMoreHistory && onLoadEarlier), paused: Boolean(loadingEarlier || historyStale),
    version: timelineVersion, load: onLoadEarlier,
  });
  const laterProbe = useRef<HTMLDivElement>(null);
  const later = useEarlierHistory({
    scrollRef, probeRef: laterProbe, scope: `${sessionId}:${resetVersion}:later`, below: true,
    enabled: loaded && Boolean(hasMoreLater && onLoadLater), paused: Boolean(loadingLater), version: timelineVersion, load: onLoadLater,
  });

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
  const pendingNavigate = useRef<{ key: string; offset: number; heading?: string } | undefined>(undefined);
  useEffect(() => { pendingNavigate.current = undefined; }, [scrollScope]);
  const navigateToRow = useCallback((key: string, offset: number) => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const resolve = () => {
      const top = rowTop(key);
      return top === undefined ? undefined : top - offset;
    };
    const target = resolve();
    if (target === undefined) {
      if (earlierTopicsCollapsed && latestTopicKey) {
        pendingNavigate.current = { key, offset };
        setExpandedTopicKey(latestTopicKey);
      }
      return;
    }
    const far = !findRow(scroller, key) || Math.abs(target - scroller.scrollTop) > scroller.clientHeight * 3;
    scroll.navigate(resolve, { behavior: far ? 'auto' : scrollBehavior() });
  }, [rowTop, scroll, earlierTopicsCollapsed, latestTopicKey]);
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
    if (!mounted && rowTop(key) === undefined && earlierTopicsCollapsed && latestTopicKey) {
      pendingNavigate.current = { key, offset: 24, heading };
      setExpandedTopicKey(latestTopicKey);
      return;
    }
    scroll.navigate(resolve, { behavior: mounted ? scrollBehavior() : 'auto' });
  }, [rowTop, scroll, earlierTopicsCollapsed, latestTopicKey]);
  useLayoutEffect(() => {
    if (earlierTopicsCollapsed || !pendingNavigate.current) return;
    const pending = pendingNavigate.current;
    pendingNavigate.current = undefined;
    if (pending.heading !== undefined) navigateToChapter(pending.key, pending.heading);
    else navigateToRow(pending.key, pending.offset);
  }, [earlierTopicsCollapsed, timelineVersion, navigateToRow, navigateToChapter]);
  useImperativeHandle(scrollHandleRef, () => ({
    scrollByReader: scroll.scrollByReader,
    followSent: () => scroll.followSent(latestTurn.current === undefined ? undefined : rowTop(latestTurn.current)),
    revealRun: (runId) => {
      const item = timeline.find((entry) => entry.kind === 'user' && entry.run?.id === runId);
      if (item) navigateToRow(item.key, 24);
    },
  }), [scroll, rowTop, timeline, navigateToRow]);
  const loadTurn = useCallback(async (key: string) => {
    if (earlierTopicsCollapsed && latestTopicKey) {
      setExpandedTopicKey(latestTopicKey);
      if (timeline.some((item) => item.key === key)) return key;
    }
    if (!onLoadTurn) return false;
    const request = scroll.beginRequest();
    try { return await onLoadTurn(key, request.signal); }
    finally { request.finish(); }
  }, [onLoadTurn, scroll, earlierTopicsCollapsed, latestTopicKey, timeline]);

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
    const next = transcriptTurns(displayTimeline, running, metricsByRun, plannedTurns.current, activeTurnId, turnStatusByTurn);
    plannedTurns.current = next;
    return next;
  }, [displayTimeline, timelineVersion, earlierTopicsCollapsed, running, metricsByRun, activeTurnId, turnStatusByTurn, selectionRevision]);
  // Flat, not one parent per turn: older history or a settled slash command can move a turn's
  // boundary, and a row re-parented that way would remount and drop its expanded state.
  // Each row also gets a deterministic turn-scoped slot (`turnId:kind:ordinal`) so reading anchors
  // survive a provisional live draft being replaced by its committed row under a new key.
  const { rowsAll, slotByKey } = useMemo(() => {
    const rows: TranscriptRow[] = [];
    const slots = new Map<string, string>();
    for (const turn of rowTurns) {
      const first = turn.rows[0];
      const firstItem = !first ? undefined : first.type === 'item' ? first.item : first.type === 'process' ? first.items[0] : first.notices[0];
      const turnId = (firstItem ? laneTurnOf(firstItem) : undefined) ?? turn.key;
      const counts = new Map<string, number>();
      for (const row of turn.rows) {
        rows.push(row);
        const kind = row.type === 'item' ? row.item.kind : row.type;
        const ordinal = counts.get(kind) ?? 0;
        counts.set(kind, ordinal + 1);
        slots.set(row.key, `${turnId}:${kind}:${ordinal}`);
      }
    }
    return { rowsAll: rows, slotByKey: slots };
  }, [rowTurns]);
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

  const {
    reveal,
    setReveal,
    landingTick,
    seeking,
    setSeeking,
    seekingUp,
    tellReaderEnd,
    clearFlash,
    landOn,
  } = useTranscriptFocus({
    sessionId,
    scrollScope,
    loaded,
    historyReady: loaded && historyLoad.state === 'ready' && !historyStale,
    focus,
    timeline,
    displayTimeline,
    timelineVersion,
    plannedTurns,
    scrollRef,
    scroll,
    locate,
    ensureWindow,
    windowTick,
    earlierTopicsCollapsed,
    latestTopicKey,
    onExpandEarlierTopics: (key) => setExpandedTopicKey(key),
    hasMoreHistory,
    loadingEarlier,
    onLoadEarlier,
    onReaderEnd,
    setHighlight,
  });

  positionChange.current = (synchronous) => {
    ensureWindow(synchronous);
    // Before any page is asked for: which end a full window keeps decides what that page may cost.
    const scroller = scrollRef.current;
    if (scroller?.clientHeight) tellReaderEnd(!seekingUp.current && (scroll.following.current || scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= scroller.scrollTop));
    earlier.check();
    later.check();
  };

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
  const handlers = useRef({ onOpenPath, onOpenInEditor, onOpenTerminal, onRetryNativeRun, onCancelNativeRun, onCheckNativeRun, onContinueNativeRun, nativeRecoveries, onRestoreNativeRun, onTurnAction, onExpandRow });
  useLayoutEffect(() => { handlers.current = { onOpenPath, onOpenInEditor, onOpenTerminal, onRetryNativeRun, onCancelNativeRun, onCheckNativeRun, onContinueNativeRun, nativeRecoveries, onRestoreNativeRun, onTurnAction, onExpandRow }; });
  const stable = useMemo(() => ({
    openPath: (path: string, line?: number) => handlers.current.onOpenPath?.(path, line),
    openInEditor: (path: string, line?: number) => handlers.current.onOpenInEditor?.(path, line),
    openTerminal: () => handlers.current.onOpenTerminal?.(),
    retry: (run: Run) => handlers.current.onRetryNativeRun?.(run),
    cancel: (run: Run) => handlers.current.onCancelNativeRun?.(run),
    check: (run: Run) => handlers.current.onCheckNativeRun?.(run),
    continue: (run: Run) => handlers.current.onContinueNativeRun?.(run),
    restore: (run: Run) => handlers.current.onRestoreNativeRun?.(run),
    turnAction: (action: TurnAction, runId: string) => handlers.current.onTurnAction?.(action, runId),
    expand: (key: string) => handlers.current.onExpandRow?.(key) ?? Promise.resolve(false),
  }), []);
  const fresh = seen.current?.fresh;
  const foldTiming = useViewPrefs((state) => state.processFoldTiming);
  const rowContext = useMemo<RowContext>(() => ({
    sessionId, onOpenSession, fresh, root, completedProcessesOpen, virtual, foldTiming,
    newTopicDivider, latestTopicKey, canCollapseEarlier, earlierTopicsCollapsed, onToggleEarlierTopics: toggleEarlierTopics,
    measure: rowObserver.measure,
    ...(onOpenPath ? { onOpenPath: stable.openPath } : {}),
    ...(onOpenInEditor ? { onOpenInEditor: stable.openInEditor } : {}),
    ...(onOpenTerminal ? { onOpenTerminal: stable.openTerminal } : {}),
    ...(onRetryNativeRun ? { onRetryNativeRun: stable.retry } : {}),
    ...(onCancelNativeRun ? { onCancelNativeRun: stable.cancel } : {}),
    ...(onCheckNativeRun ? { onCheckNativeRun: stable.check } : {}),
    ...(onContinueNativeRun ? { onContinueNativeRun: stable.continue } : {}),
    nativeRecoveries,
    ...(onRestoreNativeRun ? { onRestoreNativeRun: stable.restore } : {}),
    ...(onTurnAction ? { onTurnAction: stable.turnAction } : {}),
    ...(onExpandRow ? { onExpandRow: stable.expand } : {}),
  }), [sessionId, onOpenSession, fresh, root, completedProcessesOpen, virtual, foldTiming, newTopicDivider, latestTopicKey, canCollapseEarlier, earlierTopicsCollapsed, toggleEarlierTopics, rowObserver, stable, Boolean(onOpenPath), Boolean(onOpenInEditor), Boolean(onOpenTerminal), Boolean(onRetryNativeRun), Boolean(onCancelNativeRun), Boolean(onCheckNativeRun), Boolean(onContinueNativeRun), nativeRecoveries, Boolean(onRestoreNativeRun), Boolean(onTurnAction), Boolean(onExpandRow)]);

  // The working line holds the turn's footer unless a later inline activity has taken its place.
  const heldFooter = heldFooterRow(rowsAll);
  const lastRow = rowsAll.at(-1);
  // Under a prompt, the standalone working line follows its meta row; after a settled turn or
  // activity, it starts a new block at the density-scaled block gap (matching turn-after-footer).
  const standaloneProgressGap = !lastRow ? '' : lastRow.type === 'item' && lastRow.item.kind === 'user' ? 'mt-3' : 'timeline-gap-block';
  // A pending interaction or a visible compaction row already explains the pause.
  const suppressHeldFooter = !progress && (pendingConfirmationCount > 0 || (running && showsRunningCompaction(timeline)));
  const latestRows = rowTurns.at(-1)?.rows;
  const renderRow = (row: TranscriptRow) => (
    <RememberedScope.Provider key={row.key} value={row.key}>
      <TranscriptRowView
        row={row}
        slot={slotByKey.get(row.key) ?? row.key}
        highlighted={highlight === row.key}
        reveal={reveal?.row === row.key ? reveal : undefined}
        actionPending={row.type === 'item' && row.item.kind === 'user' && row.item.run ? runActionPending?.(row.item.run) ?? false : false}
        suppressHeldFooter={suppressHeldFooter || row.key !== heldFooter}
        latestTurn={latestRows?.includes(row) ?? false}
        footerPinned={row === rowsAll.at(-1)}
        progressShown={Boolean(progress) && row === rowsAll.at(-1)}
        {...(row.key === heldFooter && progress ? { progress } : {})}
        context={rowContext}
      />
    </RememberedScope.Provider>
  );

  const { find, findInput, findTotal, findIndex, search, step, closeFind } = useTranscriptFind({
    sessionId,
    scrollScope,
    timeline,
    timelineVersion,
    rowsAll,
    root,
    scrollRef,
    frameRef,
    scroll,
    modelAnchor,
    windowTick,
    reveal,
    landingTick,
    earlierTopicsCollapsed,
    latestTopicKey,
    onExpandEarlierTopics: (key) => setExpandedTopicKey(key),
    onFind,
    onLoadPlace,
    landOn,
    clearFlash,
    setReveal,
    setSeeking,
  });

  return (
    <div ref={frameRef} className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        data-transcript-scroll
        // Never scrolls sideways: a column sliding after a session step (`useSessionLayout`) would
        // otherwise overflow it for the slide's length and flash a horizontal scrollbar.
        // `overflow-anchor: none` gives `useTranscriptScroll` sole, deterministic ownership across
        // all browsers without racing Chromium's black-box ScrollAnchor.
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain [scrollbar-gutter:stable] [overflow-anchor:none]"
      >
        <div
          ref={contentRef}
          data-content-column={embedded ? undefined : true}
          role="region"
          aria-label={t`会话记录`}
          aria-busy={running || loadingEarlier || !loaded || undefined}
          className={cn('mx-auto flex w-full flex-col pb-4', embedded ? 'px-4 pt-4' : 'max-w-(--content-width) px-3 pt-6 sm:px-4 sm:pt-8 md:px-12', holding ? 'opacity-0' : loaded && 'animate-in fade-in-0', loaded && (loadedInPlace ? 'duration-[var(--duration-base)] ease-[var(--ease-decelerate)]' : 'duration-[var(--duration-slow)]'))}>
          {showLoading && <div className="flex justify-center py-24"><Spinner className="size-5" /></div>}
          <FeedbackNotice scope={sessionId} tone="warning" className="mb-5" message={historyLoad.state === 'error' && (historyLoad.message || t`无法同步最新会话记录。`)}
            action={() => <Button size="xs" variant="secondary" onClick={() => onRetryHistory?.()}><IconRefreshCw /><Trans>重试同步</Trans></Button>}
            recovered={historyLoad.state === 'ready'} renderMessage={message => <FailureDetails text={t`无法同步最新会话记录。`} detail={message.text} />} />
          {loaded && !earlierTopicsCollapsed && !hasMoreHistory && lead}
          {loaded && !displayTimeline.length && empty}
          <FeedbackNotice scope={sessionId} message={loaded && historyContextIncomplete && t`这段历史的前置上下文不完整，部分工具结果可能需要加载更早记录后才能完整显示。`} tone="neutral" className="mb-4" noticeClassName="rounded-lg px-3 py-2 text-xs text-fg-3" icon={null} />
          {/* Older history loads ahead of the reader; a page on its way shows here, and a retry once loading keeps failing. */}
          {loaded && !earlierTopicsCollapsed && hasMoreHistory && <PageProbe probeRef={earlierProbe} failed={earlier.failed} loading={loadingEarlier} onRetry={earlier.retry} className="mb-5" />}
          {/* A streamed frame hands unchanged rows back as the same objects, so their memo still holds.
              A long list mounts only a window of them, with empty spacers standing in for the height of
              the rest; the spacers keep their keys, so the rows never remount when the mode changes.
              Dedicated `[data-transcript-rows]` isolates row bisection (`readingAnchor`, `TurnRail`)
              from notices, probes, interaction cards, and trailing spacers. */}
          <div data-transcript-rows className="flex min-w-0 flex-col">
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
          </div>
          {loaded && hasMoreLater && <PageProbe probeRef={laterProbe} failed={later.failed} loading={loadingLater} onRetry={later.retry} className="mt-5" />}
          {children}
          {progress && !heldFooter && <div className={standaloneProgressGap}>{progress}</div>}
          {/* Temporary room below closing rows so collapsing near the end never clamps the reader; reclaimed as the reader scrolls or content grows. */}
          <div ref={spacerRef} aria-hidden data-transcript-spacer className="shrink-0" />
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

      {!embedded && <ChapterNavigation scrollRef={scrollRef} columnRef={contentRef} onNavigate={navigateToChapter} scope={`${sessionId}:${resetVersion}`} />}

      <div role="status" className="sr-only">{announcement.text && <span key={announcement.seq}>{announcement.text}</span>}</div>
      {!resources && <MarkLayer scrollRef={scrollRef} onDiscuss={onDiscuss} onQuote={onQuote} />}
      {find && (
        <TranscriptFindBar
          find={find}
          findInput={findInput}
          findTotal={findTotal}
          findIndex={findIndex}
          onSearch={search}
          onStep={step}
          onClose={closeFind}
        />
      )}
      {seeking && (
        <div role="status" className="absolute left-1/2 top-3 z-10 inline-flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-elevated/95 px-3 text-xs text-fg-2 shadow-soft backdrop-blur">
          <Spinner className="size-3.5" /><Trans>正在定位…</Trans>
        </div>
      )}
      {!embedded && !outlineTarget && <TurnRail turns={turns} turnsVersion={turnsVersion} marked={markedKeys} scrollRef={scrollRef} columnRef={contentRef} onJump={onJump} onNavigate={navigateToRow} navigationVersion={scroll.intentVersion} rows={rowIndex} onLoadTurn={onLoadTurn || earlierTopicsCollapsed ? loadTurn : undefined} />}
      {!embedded && outlineTarget && createPortal(<TurnOutline turns={turns} turnsVersion={turnsVersion} scrollRef={scrollRef} columnRef={contentRef} onJump={onJump} onNavigate={navigateToRow} navigationVersion={scroll.intentVersion} rows={rowIndex} onLoadTurn={onLoadTurn || earlierTopicsCollapsed ? loadTurn : undefined} />, outlineTarget)}
      {confirmationOffscreen && (
        <button
          type="button"
          onClick={jumpToConfirmation}
          className="absolute bottom-12 left-1/2 z-10 inline-flex h-9 max-md:bottom-16 max-md:h-11 -translate-x-1/2 items-center gap-1.5 rounded-full border border-warning/30 bg-elevated/95 px-3 text-xs font-medium text-fg-2 shadow-soft backdrop-blur transition-colors hover:text-fg"
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
          'absolute bottom-3 left-1/2 z-10 inline-flex h-7 max-md:h-11 -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-elevated/95 px-3 text-xs font-medium text-fg-2 shadow-soft backdrop-blur transition-[opacity,transform] duration-[var(--duration-base)] ease-out-soft hover:text-fg',
          atBottom ? 'pointer-events-none translate-y-2 opacity-0' : 'translate-y-0 opacity-100',
        )}
      >
        <IconArrowDown className="size-3.5" /><Trans>回到底部</Trans>
      </button>
    </div>
  );
}
