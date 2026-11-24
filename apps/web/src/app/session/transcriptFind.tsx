import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { useLingui } from '@lingui/react/macro';
import { IconChevronDown, IconSearch, IconX } from '@/components/icons';
import { PENDING_ROW_POS, type LaneFind, type LaneFindHit, type MarkQuote } from '@contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/controls';
import { toast } from '@/lib/toast';
import { countOccurrences, findableText, findNeedle } from '../../../../../packages/timeline/src/findText';
import { POS_STEP } from '../../../../../packages/timeline/src/rows';
import { matches } from '../shortcuts';
import { isComposingKey } from './composerKeyboard';
import type { TimelineItem } from './model';
import { captureReadingAnchor, type ReadingAnchor } from './readingAnchor';
import { findQuote, rangeAt } from './textQuote';
import type { TranscriptRow } from './transcriptRows';
import type { useTranscriptScroll } from './useTranscriptScroll';

/** How long typing pauses before a find asks the server about the whole lane. */
const FIND_DEBOUNCE_MS = 200;

/** The words [quote] names in [row]'s answer body, where a highlight is drawn. */
export function quoteRange(row: HTMLElement, quote: MarkQuote): Range | undefined {
  const body = row.querySelector<HTMLElement>('[data-mark-ids]') ?? row;
  const at = findQuote(body.textContent ?? '', quote);
  return at ? rangeAt(body, at.start, at.end) : undefined;
}

/**
 * Flashes [range] the way a focused row flashes (`::highlight(mark-focus)`), or keeps it marked
 * until the next one when [hold]. No range clears the mark.
 */
export function flashRange(range: Range | undefined, hold = false) {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return;
  if (!range) { CSS.highlights.delete('mark-focus'); return; }
  const highlight = new Highlight(range);
  CSS.highlights.set('mark-focus', highlight);
  if (!hold) window.setTimeout(() => { if (CSS.highlights.get('mark-focus') === highlight) CSS.highlights.delete('mark-focus'); }, 1600);
}

/**
 * What 会话内查找 counts in an item (`findableText`, the server's rule too), kept per item object with
 * the count for the last query, so a streamed frame only rescans the rows it replaced. The model holds
 * every row, mounted or not, which is what the page's own find cannot reach once the list is windowed.
 */
const findable = new WeakMap<TimelineItem, { text: string; root?: string; needle?: string; count?: number }>();
function findableEntry(item: TimelineItem, root?: string) {
  let entry = findable.get(item);
  if (entry && entry.root === root) return entry;
  entry = { text: findableText(item, root), root };
  findable.set(item, entry);
  return entry;
}

/**
 * A row [needle] occurs in [count] times, at its lane place [pos]; [row] is the index of the
 * transcript row that shows it, absent for one the window does not hold, which a step loads first.
 */
interface FindHit { key: string; pos: number; count: number; row?: number }
/** An item's lane place: its row's, which the item's sequence keeps to the step (`timelineItem`). */
const placeOf = (item: TimelineItem) => item.event.sequence * POS_STEP;

function findHits(rows: readonly TranscriptRow[], needle: string, root?: string): FindHit[] {
  const hits: FindHit[] = [];
  rows.forEach((row, index) => {
    for (const item of row.type === 'item' ? [row.item] : row.type === 'process' ? row.items : row.notices) {
      const entry = findableEntry(item, root);
      if (entry.needle !== needle) {
        entry.needle = needle;
        entry.count = countOccurrences(entry.text, needle);
      }
      if (entry.count) hits.push({ key: item.key, pos: placeOf(item), count: entry.count, row: index });
    }
  });
  return hits;
}

/**
 * The server's hits for the whole lane around the ones counted here: a row the window holds is
 * counted as it shows now (a streamed or expanded row may have moved on since the server read it),
 * and the rest stand before or after the window, which they cannot be inside of.
 */
function laneHits(served: readonly LaneFindHit[], held: readonly FindHit[], rows: readonly TranscriptRow[]): FindHit[] {
  const keys = new Set<string>();
  let low = Infinity;
  for (const row of rows) for (const item of row.type === 'item' ? [row.item] : row.type === 'process' ? row.items : row.notices) {
    keys.add(item.key);
    const place = placeOf(item);
    if (place < PENDING_ROW_POS) low = Math.min(low, place);
  }
  const away = served.filter((hit) => !keys.has(hit.key)).map((hit) => ({ key: hit.key, pos: hit.pos, count: hit.count }));
  return [...away.filter((hit) => hit.pos < low), ...held, ...away.filter((hit) => hit.pos >= low)];
}

/** The occurrence a new query starts from: the first at or below [reading], else the last above it. */
function startIndex(hits: readonly FindHit[], reading: number): number {
  let index = 0, seen = 0;
  for (const hit of hits) {
    if (hit.pos >= reading) return seen;
    seen += hit.count;
    index = seen - 1;
  }
  return index;
}

/** Occurrence [index] counted across [hits]: its row and its place among the row's own. */
function occurrenceAt(hits: readonly FindHit[], index: number): { hit: FindHit; nth: number } | undefined {
  let rest = index;
  for (const hit of hits) {
    if (rest < hit.count) return { hit, nth: rest };
    rest -= hit.count;
  }
  return undefined;
}

/** Where [at] stands counted across [hits], or -1 once its row no longer holds it. */
function occurrenceIndex(hits: readonly FindHit[], at: { key: string; nth: number } | undefined): number {
  if (!at) return -1;
  let seen = 0;
  for (const hit of hits) {
    if (hit.key === at.key) return at.nth < hit.count ? seen + at.nth : -1;
    seen += hit.count;
  }
  return -1;
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
 * 会话内查找. ⌘F / Ctrl+F over the conversation on screen opens a find bar that matches the model
 * instead of the DOM: a windowed list and a block never opened leave most of a long transcript out
 * of the page, where the browser's own find cannot see it. A second press inside the bar is the
 * browser's again.
 */
export function useTranscriptFind({
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
  onExpandEarlierTopics,
  onFind,
  onLoadPlace,
  landOn,
  clearFlash,
  setReveal,
  setSeeking,
}: {
  sessionId: string;
  scrollScope: string;
  timeline: readonly TimelineItem[];
  timelineVersion: number;
  rowsAll: readonly TranscriptRow[];
  root?: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  frameRef: RefObject<HTMLDivElement | null>;
  scroll: ReturnType<typeof useTranscriptScroll>;
  modelAnchor: () => ReadingAnchor | undefined;
  windowTick: number;
  reveal: { row: string; item: string; version: number } | undefined;
  landingTick: number;
  earlierTopicsCollapsed: boolean;
  latestTopicKey?: string;
  onExpandEarlierTopics: (key: string) => void;
  onFind?: (query: string, signal?: AbortSignal) => Promise<LaneFind | undefined>;
  onLoadPlace?: (pos: number, signal?: AbortSignal) => Promise<boolean>;
  landOn: (key: string, rangeIn: (found: HTMLElement) => Range | undefined, hold?: boolean) => boolean;
  clearFlash: () => void;
  setReveal: (value: { row: string; item: string; version: number } | undefined) => void;
  setSeeking: (seeking: boolean) => void;
}) {
  const { t } = useLingui();
  const [findTarget, setFindTarget] = useState<{ key: string; needle: string; nth: number }>();
  const findHandled = useRef<typeof findTarget>(undefined);
  const findRequest = useRef<{ value: NonNullable<typeof findTarget>; version: number; scope: string }>(undefined);
  useEffect(() => {
    if (!findTarget || findHandled.current === findTarget) return;
    if (findRequest.current?.value !== findTarget) {
      scroll.release();
      findRequest.current = { value: findTarget, version: scroll.navigationVersion.current, scope: scrollScope };
    }
    // The rows replaced whole (the page a step loaded lands a frame after the step) reset the
    // scroll and move its version: that is not the reader going elsewhere, so the request stands.
    if (findRequest.current.scope !== scrollScope) findRequest.current = { ...findRequest.current, version: scroll.navigationVersion.current, scope: scrollScope };
    if (findRequest.current.version !== scroll.navigationVersion.current) { findHandled.current = findTarget; setReveal(undefined); return; }
    if (landOn(findTarget.key, (found) => occurrenceRange(found, findTarget.needle, findTarget.nth), true)) { findHandled.current = findTarget; setReveal(undefined); }
    findRequest.current.version = scroll.navigationVersion.current;
  }, [findTarget, timeline, timelineVersion, windowTick, reveal, landingTick, scroll, scrollScope]);

  /**
   * [at] is the occurrence on show, by row and place in it, so a list that grows around it (the
   * server's answer, a page loaded, a streamed row) keeps it; [reading] is the lane place the query
   * started from, and [moved] whether the reader has stepped since.
   */
  const [find, setFind] = useState<{ query: string; at?: { key: string; nth: number }; reading: number; moved: boolean }>();
  const findInput = useRef<HTMLInputElement>(null);
  /** Where the keyboard was before the bar took it, and goes back to when it closes. */
  const findReturn = useRef<HTMLElement | null>(null);
  const needle = (find && findNeedle(find.query)) ?? '';
  const heldHits = useMemo(() => (needle ? findHits(rowsAll, needle, root) : []), [rowsAll, needle, root]);
  /** The server's count of the whole lane for [needle]; until it answers, or without it, the held rows are what is counted. */
  const [served, setServed] = useState<{ needle: string; result: LaneFind }>();
  const hits = useMemo(() => (served && served.needle === needle ? laneHits(served.result.hits, heldHits, rowsAll) : heldHits), [served, needle, heldHits, rowsAll]);
  const findTotal = hits.reduce((sum, hit) => sum + hit.count, 0);
  const findIndex = occurrenceIndex(hits, find?.at);
  const findOpen = useRef(false);
  findOpen.current = Boolean(find);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Esc closes an open bar wherever the keyboard is, as a browser's own find does, except in a
      // field of its own (the draft) or a dialog, whose Esc is theirs. The bar handles its own.
      if (event.key === 'Escape' && findOpen.current && !event.defaultPrevented && !isComposingKey(event)) {
        const scroller = scrollRef.current;
        const active = document.activeElement;
        const editable = active instanceof HTMLElement && (active.isContentEditable || active.matches('input, textarea, select'));
        if (!scroller || !scroller.getClientRects().length || scroller.closest('[inert]') || editable || active?.closest('[role="dialog"],[role="alertdialog"]')) return;
        event.preventDefault();
        closeFindRef.current();
        return;
      }
      if (event.defaultPrevented || !matches(event, 'find')) return;
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
      flushSync(() => setFind((current) => current ?? { query: '', reading: 0, moved: false }));
      findInput.current?.focus();
      findInput.current?.select();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // A page or a jump replaces the rows, not the conversation: the bar and its place stay.
  useEffect(() => { setFind(undefined); setServed(undefined); setFindTarget(undefined); }, [sessionId]);

  // The whole lane is asked once typing pauses. What streams in later is held, and counted here.
  useEffect(() => {
    if (!needle || !onFind || !find) return;
    const query = find.query;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void onFind(query, controller.signal).then((result) => {
        if (!controller.signal.aborted) setServed(result ? { needle, result } : undefined);
      });
    }, FIND_DEBOUNCE_MS);
    return () => { window.clearTimeout(timer); controller.abort(); };
    // Asked again for a new query, not for each keystroke's object.
  }, [needle, onFind]);

  /** Shows occurrence [nth] of [hit]: landed on when the rows hold it, else once the rows around it are loaded. */
  const findPage = useRef<AbortController | undefined>(undefined);
  const showHit = (hit: FindHit, lower: string, nth: number) => {
    findPage.current?.abort();
    findPage.current = undefined;
    if (hit.row !== undefined) { setFindTarget({ key: hit.key, needle: lower, nth }); return; }
    if (earlierTopicsCollapsed && latestTopicKey) {
      onExpandEarlierTopics(latestTopicKey);
      if (timeline.some((item) => item.key === hit.key) || !onLoadPlace) {
        setFindTarget({ key: hit.key, needle: lower, nth });
        return;
      }
    }
    if (!onLoadPlace) { setFindTarget({ key: hit.key, needle: lower, nth }); return; }
    const request = scroll.beginRequest();
    findPage.current = new AbortController();
    const page = findPage.current;
    request.signal.addEventListener('abort', () => page.abort());
    setSeeking(true);
    void onLoadPlace(hit.pos, page.signal).catch(() => false).then((loaded) => {
      if (page.signal.aborted) return;
      if (loaded) setFindTarget({ key: hit.key, needle: lower, nth });
      else toast.error(t`无法加载这处结果所在的历史`);
    }).finally(() => {
      request.finish();
      if (findPage.current === page) findPage.current = undefined;
      // A later step that needs no page clears the request without one taking its place.
      if (!findPage.current) setSeeking(false);
    });
  };

  /** The lane place the reader is at: the row at the top of the view, else the first row held. */
  const readingPlace = () => {
    const scroller = scrollRef.current;
    const anchor = scroller ? captureReadingAnchor(scroller, modelAnchor).rows[0]?.key : undefined;
    const row = (anchor ? rowsAll.find((candidate) => candidate.key === anchor) : undefined) ?? rowsAll[0];
    const item = row ? (row.type === 'item' ? row.item : row.type === 'process' ? row.items[0] : row.notices[0]) : undefined;
    return item ? placeOf(item) : 0;
  };

  /** A new query starts from the reader: the first occurrence at or below the top of the view, else the last one above it. */
  const search = (query: string) => {
    const lower = findNeedle(query) ?? '';
    const list = lower ? findHits(rowsAll, lower, root) : [];
    const reading = readingPlace();
    const at = occurrenceAt(list, startIndex(list, reading));
    setFind({ query, reading, moved: false, ...(at ? { at: { key: at.hit.key, nth: at.nth } } : {}) });
    if (at) showHit(at.hit, lower, at.nth);
    else { findPage.current?.abort(); flashRange(undefined); }
  };

  // The server's answer can hold an occurrence nearer the reader than any the rows held (one above
  // the window, say): until the reader steps, the query starts from there instead.
  const startedFrom = useRef<typeof served>(undefined);
  useEffect(() => {
    if (!find || find.moved || !served || served.needle !== needle || startedFrom.current === served) return;
    startedFrom.current = served;
    const at = occurrenceAt(hits, startIndex(hits, find.reading));
    if (!at || (find.at?.key === at.hit.key && find.at.nth === at.nth)) return;
    setFind({ ...find, at: { key: at.hit.key, nth: at.nth } });
    showHit(at.hit, needle, at.nth);
    // Once per answer.
  }, [served, hits]);

  const step = (delta: number) => {
    if (!find || !findTotal) return;
    const from = findIndex < 0 ? (delta > 0 ? -1 : 0) : findIndex;
    const at = occurrenceAt(hits, (((from + delta) % findTotal) + findTotal) % findTotal);
    if (!at) return;
    setFind({ ...find, at: { key: at.hit.key, nth: at.nth }, moved: true });
    showHit(at.hit, needle, at.nth);
  };

  const closeFindRef = useRef(() => {});
  const closeFind = () => {
    setFind(undefined);
    setServed(undefined);
    setFindTarget(undefined);
    findPage.current?.abort();
    clearFlash();
    flashRange(undefined);
    const back = findReturn.current;
    findReturn.current = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
  };
  closeFindRef.current = closeFind;

  return { find, findInput, findTotal, findIndex, search, step, closeFind };
}

export function TranscriptFindBar({
  find,
  findInput,
  findTotal,
  findIndex,
  onSearch,
  onStep,
  onClose,
}: {
  find: { query: string };
  findInput: RefObject<HTMLInputElement | null>;
  findTotal: number;
  findIndex: number;
  onSearch: (query: string) => void;
  onStep: (delta: number) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  return (
    <div
      role="search"
      className="absolute right-3 top-3 z-10 flex items-center gap-0.5 rounded-xl border border-line bg-elevated/95 p-1 shadow-soft backdrop-blur max-md:left-3"
      // The field and the buttons alike: a step clicked with the mouse leaves the keyboard on its button.
      onKeyDown={(event) => { if (event.key === 'Escape' && !isComposingKey(event.nativeEvent)) { event.preventDefault(); onClose(); } }}
    >
      <label className="relative min-w-0 flex-1">
        <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-4" />
        <Input
          ref={findInput}
          autoFocus
          value={find.query}
          aria-label={t`在会话中查找`}
          className="h-7 w-56 pl-8 max-md:w-full"
          onChange={(event) => onSearch(event.target.value)}
          onKeyDown={(event) => {
            if (isComposingKey(event.nativeEvent)) return;
            if (event.key === 'Enter') { event.preventDefault(); onStep(event.shiftKey ? -1 : 1); }
          }}
        />
      </label>
      {find.query && <span role="status" className="shrink-0 px-1.5 text-xs tabular-nums text-fg-3">{findTotal ? Math.max(findIndex, 0) + 1 : 0}/{findTotal}</span>}
      <Button size="icon-sm" variant="quiet" aria-label={t`上一个`} disabled={!findTotal} onClick={() => onStep(-1)}><IconChevronDown className="rotate-180" /></Button>
      <Button size="icon-sm" variant="quiet" aria-label={t`下一个`} disabled={!findTotal} onClick={() => onStep(1)}><IconChevronDown /></Button>
      <Button size="icon-sm" variant="quiet" aria-label={t`关闭查找`} onClick={onClose}><IconX /></Button>
    </div>
  );
}
