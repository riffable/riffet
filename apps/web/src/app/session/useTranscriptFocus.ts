import { useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import { useLingui } from '@lingui/react/macro';
import { toast } from '@/lib/toast';
import { animationsOf } from '@/lib/motion';
import { rowKeyForMessage, type MessageFocus } from './focus-message';
import type { TimelineItem } from './model';
import { findRow } from './readingAnchor';
import { flashRange, quoteRange } from './transcriptFind';
import type { TranscriptTurn } from './transcriptRows';
import type { EarlierLoad } from './useEarlierHistory';
import type { useTranscriptScroll } from './useTranscriptScroll';

/** Pages of older history a focus request reads looking for its message before giving up. */
const SEEK_PAGES = 30;
/** Where a target taller than most of the viewport starts, from the top. */
const SETTLE_TOP = 56;
const wait = (ms: number) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms); });

export function useTranscriptFocus({
  sessionId,
  scrollScope,
  loaded,
  historyReady,
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
  onExpandEarlierTopics,
  hasMoreHistory,
  loadingEarlier,
  onLoadEarlier,
  onReaderEnd,
  setHighlight,
}: {
  sessionId: string;
  scrollScope: string;
  loaded: boolean;
  historyReady: boolean;
  focus?: MessageFocus;
  timeline: readonly TimelineItem[];
  displayTimeline: readonly TimelineItem[];
  timelineVersion: number;
  plannedTurns: MutableRefObject<TranscriptTurn[] | undefined>;
  scrollRef: RefObject<HTMLDivElement | null>;
  scroll: ReturnType<typeof useTranscriptScroll>;
  locate: (key: string) => number | undefined;
  ensureWindow: (sync: boolean) => void;
  windowTick: number;
  earlierTopicsCollapsed: boolean;
  latestTopicKey?: string;
  onExpandEarlierTopics: (key: string) => void;
  hasMoreHistory?: boolean;
  loadingEarlier?: boolean;
  onLoadEarlier?: () => Promise<EarlierLoad>;
  onReaderEnd?: (atEnd: boolean) => void;
  setHighlight: (key: string | undefined) => void;
}) {
  const { t } = useLingui();
  /** The process row a focus opened to reach something inside it. */
  const [reveal, setReveal] = useState<{ row: string; item: string; version: number }>();
  const [landingTick, setLandingTick] = useState(0);
  const focusSettle = useRef<() => void>(undefined);
  const focusFlash = useRef<number>(undefined);
  /** An item flashed inside a row; its ring is a class on the element, not state, so it is taken off by hand. */
  const flashedItem = useRef<HTMLElement | undefined>(undefined);
  /** Ends the current flash at once: a new landing (whose timer replaces this one's) or the end of find. */
  const clearFlash = () => {
    window.clearTimeout(focusFlash.current);
    flashedItem.current?.classList.remove('timeline-focus-hit');
    flashedItem.current = undefined;
    setHighlight(undefined);
  };
  useEffect(() => () => {
    focusSettle.current?.();
    window.clearTimeout(focusFlash.current);
    flashedItem.current?.classList.remove('timeline-focus-hit');
    flashedItem.current = undefined;
  }, [scrollScope]);

  /**
   * Scrolls to the item with [key] and marks it: the words [rangeIn] picks inside it, or the item as
   * a whole when it picks none; [hold] keeps the mark (words or ring) until the next landing. Returns false
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
            opening ||= animationsOf(container).some(animation => 'transitionProperty' in animation && animation.playState === 'running');
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
    clearFlash();
    flashRange(range, hold);
    if (range) return true;
    if (item) { item.classList.add('timeline-focus-hit'); flashedItem.current = item; }
    else setHighlight(found.dataset.rowKey ?? key);
    // Held like marked words when [hold]: a find hit the page cannot mark (a folded tool's command)
    // stays ringed until the next step or the end of find, the same as one it can.
    if (!hold) focusFlash.current = window.setTimeout(clearFlash, 1600);
    return true;
  };

  /**
   * Scrolls to the message a search result asked for. It waits until that row exists, because the
   * message may only arrive with the stream or with a page of older history, and it honours one
   * request once — a later timeline change must not pull the reader back to it.
   */
  const focusHandled = useRef<MessageFocus | undefined>(undefined);
  const focusRequest = useRef<{ value: MessageFocus; scope: string; version: number }>(undefined);
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
    if (key && earlierTopicsCollapsed && !rowKeyForMessage(displayTimeline, focus) && latestTopicKey) {
      onExpandEarlierTopics(latestTopicKey);
      return;
    }
    if (key && landOn(key, (found) => focus.quote ? quoteRange(found, focus.quote) : undefined)) { focusHandled.current = focus; setReveal(undefined); }
    focusRequest.current.version = scroll.navigationVersion.current;
  }, [focus, loaded, scrollScope, timeline, displayTimeline, timelineVersion, earlierTopicsCollapsed, latestTopicKey, loadingEarlier, windowTick, reveal, landingTick, scroll]);

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
  const seek = useRef({ timeline, hasMoreHistory, onLoadEarlier, loadingEarlier, tellReaderEnd, earlierTopicsCollapsed, latestTopicKey });
  seek.current = { timeline, hasMoreHistory, onLoadEarlier, loadingEarlier, tellReaderEnd, earlierTopicsCollapsed, latestTopicKey };
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
        if (current.earlierTopicsCollapsed && current.latestTopicKey) onExpandEarlierTopics(current.latestTopicKey);
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

  return {
    reveal,
    setReveal,
    landingTick,
    seeking,
    setSeeking,
    seekingUp,
    tellReaderEnd,
    clearFlash,
    landOn,
  };
}
