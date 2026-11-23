import { memo, useEffect, useRef, useState, type RefObject } from 'react';
import { useLingui } from '@lingui/react/macro';
import { IconBookmarkFilled } from '@/components/icons';
import { formatTime } from '@/lib/i18n/format';
import { cn, formatDateTime } from '@/lib/utils';
import { TRANSCRIPT_ATTR } from './readingAnchor';
import { useViewPrefs } from './viewPrefs';

export interface Turn {
  key: string;
  text: string;
  /** When the prompt was sent. */
  at?: string;
  /** The turn's native turn id and run id, as a mark's anchor names them. */
  refs?: string[];
}

/**
 * What a windowed transcript knows about rows the DOM no longer holds. While [active] the rows
 * outside the window are not mounted, so a turn's place is answered from the list's own index.
 */
export interface RowIndex {
  active(): boolean;
  /** Content-space top of the row with [key], estimated when it is not mounted. */
  topOf(key: string): number | undefined;
  /** The key of the turn-opening row at or above content-space [y]. */
  turnAt(y: number): string | undefined;
}

/** Distance (px) from the very bottom that still counts as "following the tail". */
const TAIL_SLACK = 25;
/** Smooth-jump highlight is pinned for at most this long (ms). */
const PIN_TTL_MS = 500;
/** Scroll offset applied above the target turn when jumping. */
const JUMP_OFFSET = 24;

/** Read the `data-turn` key of a row without assuming it exists (gap rows have none). */
function turnKeyOf(row: Element): string | undefined {
  const key = (row as HTMLElement).dataset?.turn;
  return typeof key === 'string' && key.length > 0 ? key : undefined;
}

/**
 * Returns the index of the turn currently being read; -1 when there is no usable information.
 *
 * Semantics (a faithful copy of DeepSeek Harness' readVisibleTurn):
 * - `line` is a y value in the *viewport* coordinate system; rows are in document order.
 * - Binary search (never a linear scan) for the last row with `getBoundingClientRect().top <= line`.
 * - From that candidate the search walks *backwards* reading only `data-turn`, so a row that is
 *   missing / has a malformed `data-turn` does not change the result (gap semantics): we keep the
 *   previous candidate rather than falling through to an adjacent row. Backwards walking reads no
 *   geometry, which is why the number of `getBoundingClientRect` calls stays logarithmic.
 * - When no candidate maps to a turn, returns `fallback` (callers pass 0).
 */
export function pickTurnIndex(rows: ArrayLike<Element>, line: number, indexByKey: Map<string, number>, fallback: number): number {
  let low = 0;
  let high = rows.length - 1;
  let candidate = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    // Skip non-laid-out children (e.g. `empty:hidden` FeedbackNotices whose rect is `0,0,0,0`)
    // so they cannot break top-order monotonicity when `line > 0`.
    let probe = mid;
    let rect = rows[probe]!.getBoundingClientRect();
    if (rect.height === 0 && rect.width === 0) {
      let left = mid - 1;
      let right = mid + 1;
      let found = -1;
      while (left >= low || right <= high) {
        if (left >= low) {
          const leftRect = rows[left]!.getBoundingClientRect();
          if (leftRect.height > 0 || leftRect.width > 0) { found = left; rect = leftRect; break; }
          left -= 1;
        }
        if (right <= high) {
          const rightRect = rows[right]!.getBoundingClientRect();
          if (rightRect.height > 0 || rightRect.width > 0) { found = right; rect = rightRect; break; }
          right += 1;
        }
      }
      if (found < 0) break;
      probe = found;
    }
    if (rect.top <= line) {
      candidate = probe;
      low = probe + 1;
    } else {
      high = probe - 1;
    }
  }
  if (candidate < 0) return fallback;
  for (let index = candidate; index >= 0; index -= 1) {
    const key = turnKeyOf(rows[index]);
    if (key !== undefined) {
      const mapped = indexByKey.get(key);
      if (mapped !== undefined) return mapped;
    }
  }
  return fallback;
}

/** Document-space top of the row carrying `data-turn={key}`, relative to the scroller. */
function turnTop(scroller: HTMLElement, column: HTMLElement | null, key: string): number | undefined {
  const element = [...(column ?? scroller).querySelectorAll<HTMLElement>('[data-turn]')].find((item) => item.dataset.turn === key);
  if (!element) return undefined;
  return element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

interface TurnTracking {
  /** Reader intent survives a requested page replacement, but cancels stale load completions. */
  navigationVersion: RefObject<number>;
  turns: Turn[];
  turnsVersion?: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  columnRef: RefObject<HTMLDivElement | null>;
  /** Delegates the message viewport's position to its scroll coordinator. */
  onNavigate: (key: string, offset: number) => void;
  /** Releases following before an unloaded turn starts loading. */
  onJump?: () => void;
  rows?: RowIndex;
  /**
   * Loads a turn and resolves its actual prompt row key; outline placeholders change on arrival.
   */
  onLoadTurn?: (key: string) => Promise<string | false>;
}

/** The turn being read, tracked with a reading line plus a tail fast path, and a jump to any turn. */
function useActiveTurn({ turns, turnsVersion = 0, scrollRef, columnRef, onNavigate, onJump, navigationVersion, rows, onLoadTurn }: TurnTracking) {
  const [active, setActive] = useState(-1);
  const activeRef = useRef(-1);
  const pinRef = useRef<{ index: number; top: number; expiresAt: number } | null>(null);
  /** A turn picked before its rows were loaded; the jump lands once they are. */
  const awaitedRef = useRef<{ key: string; version: number } | undefined>(undefined);
  const [loadedRequest, setLoadedRequest] = useState<{ key: string; version: number } | undefined>(undefined);

  useEffect(() => () => { awaitedRef.current = undefined; }, []);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const indexByKey = new Map(turns.map((turn, index) => [turn.key, index]));
    const setCurrent = (index: number) => {
      if (index === activeRef.current) return;
      activeRef.current = index;
      setActive(index);
    };
    const read = () => {
      if (turns.length < 2) { setCurrent(turns.length - 1); return; }
      // A smooth jump pins the highlight until the landing position is reached or the pin expires.
      const pin = pinRef.current;
      if (pin) {
        const landed = Math.abs(scroller.scrollTop - pin.top) <= 2;
        if (!landed && Date.now() < pin.expiresAt) {
          setCurrent(pin.index);
          return;
        }
        pinRef.current = null;
      }
      // Tail fast path: while streaming / following the bottom the last turn is current, no geometry.
      if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= TAIL_SLACK) {
        setCurrent(turns.length - 1);
        return;
      }
      if (rows?.active()) {
        const key = rows.turnAt(scroller.scrollTop + Math.min(96, scroller.clientHeight * 0.2));
        setCurrent((key !== undefined ? indexByKey.get(key) : undefined) ?? 0);
        return;
      }
      const column = columnRef.current;
      if (!column) return;
      const list = column.querySelector(`:scope > [${TRANSCRIPT_ATTR.rows}]`) ?? column;
      const line = scroller.getBoundingClientRect().top + Math.min(96, scroller.clientHeight * 0.2);
      setCurrent(pickTurnIndex(list.children, line, indexByKey, 0));
    };
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => { frame = null; read(); });
    };
    const release = () => { pinRef.current = null; schedule(); };

    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(scroller);
    const column = columnRef.current;
    if (column) resizeObserver.observe(column);

    scroller.addEventListener('scroll', schedule, { passive: true });
    scroller.addEventListener('wheel', release, { passive: true });
    scroller.addEventListener('touchstart', release, { passive: true });
    scroller.addEventListener('keydown', release, { passive: true });
    scroller.addEventListener('pointerdown', release, { passive: true });
    read();
    return () => {
      scroller.removeEventListener('scroll', schedule);
      scroller.removeEventListener('wheel', release);
      scroller.removeEventListener('touchstart', release);
      scroller.removeEventListener('keydown', release);
      scroller.removeEventListener('pointerdown', release);
      resizeObserver.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [turns, turnsVersion, scrollRef, columnRef, rows]);

  const jump = (key: string) => {
    awaitedRef.current = undefined;
    const scroller = scrollRef.current;
    const mounted = scroller ? turnTop(scroller, columnRef.current, key) : undefined;
    // Not in the DOM: the list's index places it, and revealing it mounts the rows around it.
    const estimated = mounted === undefined && rows?.active() ? rows.topOf(key) : undefined;
    const top = mounted ?? estimated;
    if (scroller && top === undefined && onLoadTurn) {
      // Not loaded at all: the engine replaces the window with the rows around it, and the jump lands after.
      onJump?.();
      const request = { key, version: navigationVersion.current };
      awaitedRef.current = request;
      void onLoadTurn(key).then((loaded) => {
        if (awaitedRef.current !== request) return;
        if (loaded && request.version === navigationVersion.current) {
          request.key = loaded;
          setLoadedRequest(request);
        }
        else awaitedRef.current = undefined;
      }, () => { if (awaitedRef.current === request) awaitedRef.current = undefined; });
      return;
    }
    if (!scroller || top === undefined) return;
    const target = Math.max(0, top - JUMP_OFFSET);
    const index = turns.findIndex((turn) => turn.key === key);
    if (index >= 0) {
      pinRef.current = { index, top: target, expiresAt: Date.now() + PIN_TTL_MS };
      if (index !== activeRef.current) {
        activeRef.current = index;
        setActive(index);
      }
    }
    onNavigate(key, JUMP_OFFSET);
  };

  // Both the load and its rows must have arrived; reader input or a newer jump cancels the request.
  useEffect(() => {
    const request = awaitedRef.current;
    const scroller = scrollRef.current;
    if (!request || request !== loadedRequest || !scroller || request.version !== navigationVersion.current) return;
    const { key } = request;
    const frame = requestAnimationFrame(() => {
      if (awaitedRef.current !== request || request.version !== navigationVersion.current) return;
      const top = turnTop(scroller, columnRef.current, key) ?? (rows?.active() ? rows.topOf(key) : undefined);
      if (top === undefined) return;
      awaitedRef.current = undefined;
      jump(key);
    });
    return () => cancelAnimationFrame(frame);
    // `jump` is rebuilt every render; the list it reads is what moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns, turnsVersion, rows, loadedRequest, navigationVersion]);

  return { active, jump };
}

/** Each prompt's slot on the rail; a history longer than the band scrolls inside it instead of packing tighter. */
const RAIL_SLOT = 11;
/** How far the rail's ends fade while there is more of it past them. */
const RAIL_FADE = 16;

/** The prompt's time: the clock today, with the date before. */
function promptTime(at: string | undefined): string | undefined {
  if (!at) return undefined;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toDateString() === new Date().toDateString() ? formatTime(at) : formatDateTime(at);
}

/**
 * The turn navigation without a side column: a strip of lines or dots on the transcript's right edge,
 * a marked turn's in the accent. A long history scrolls inside the strip, which keeps the turn being
 * read near its middle unless the pointer is on it. Memoized, like `TurnOutline`: its props hold
 * still while the transcript streams, so a frame skips it.
 */
export const TurnRail = memo(function TurnRail({ className, marked, ...tracking }: TurnTracking & { className?: string; marked?: ReadonlySet<string> }) {
  const { t } = useLingui();
  const { turns } = tracking;
  const { active, jump } = useActiveTurn(tracking);
  const dots = useViewPrefs((state) => state.mark === 'dot');
  const navRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pointerInside = useRef(false);
  const followed = useRef(false);
  const [hovered, setHovered] = useState<number | null>(null);
  const hoveredRef = useRef<HTMLElement | null>(null);
  /** Vertical centre of the previewed mark, measured against the rail so it follows the strip's scroll. */
  const [previewTop, setPreviewTop] = useState<number | undefined>(undefined);
  const [edges, setEdges] = useState({ top: false, bottom: false });

  const place = (element: HTMLElement) => {
    const nav = navRef.current;
    if (nav) setPreviewTop(element.getBoundingClientRect().top - nav.getBoundingClientRect().top + element.offsetHeight / 2);
  };
  const preview = (index: number, element: HTMLElement) => { hoveredRef.current = element; setHovered(index); place(element); };
  const unpreview = () => { hoveredRef.current = null; setHovered(null); };

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const read = () => {
      const top = list.scrollTop > 1;
      const bottom = list.scrollTop + list.clientHeight < list.scrollHeight - 1;
      setEdges((held) => held.top === top && held.bottom === bottom ? held : { top, bottom });
      if (hoveredRef.current) place(hoveredRef.current);
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(list);
    list.addEventListener('scroll', read, { passive: true });
    return () => { observer.disconnect(); list.removeEventListener('scroll', read); };
  }, [turns.length]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || active < 0 || pointerInside.current || list.scrollHeight <= list.clientHeight) return;
    const top = Math.max(0, Math.min(list.scrollHeight - list.clientHeight, active * RAIL_SLOT - (list.clientHeight - RAIL_SLOT) / 2));
    if (Math.abs(top - list.scrollTop) < 1) return;
    // The first placement is where the strip opens, not a move to watch.
    const glide = followed.current && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    followed.current = true;
    list.scrollTo({ top, behavior: glide ? 'smooth' : 'auto' });
  }, [active, turns.length]);

  if (turns.length < 2) return null;

  const shown = hovered !== null ? turns[hovered] : undefined;
  const shownTime = promptTime(shown?.at);
  const mask = edges.top || edges.bottom
    ? `linear-gradient(to bottom, ${edges.top ? 'transparent' : '#000'}, #000 ${RAIL_FADE}px, #000 calc(100% - ${RAIL_FADE}px), ${edges.bottom ? 'transparent' : '#000'})`
    : undefined;

  return (
    // The strip scrolls itself so a long history stays inside the band; the preview hangs to the
    // left of the rail and must NOT be clipped with it, so it is a sibling of that strip.
    <nav
      ref={navRef}
      aria-label={t`消息导航`}
      className={cn('absolute right-1.5 top-1/2 z-(--z-rail) hidden max-h-[64%] -translate-y-1/2 flex-col items-end py-2 md:flex', className)}
      onPointerEnter={() => { pointerInside.current = true; }}
      onPointerLeave={() => { pointerInside.current = false; unpreview(); }}
    >
      <div ref={listRef} className="flex min-h-0 flex-col items-end overflow-y-auto overscroll-contain scrollbar-none" style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}>
        {turns.map((turn, index) => {
          const accent = marked?.has(turn.key);
          const tone = accent ? (index === active || hovered === index ? 'bg-accent' : 'bg-accent/60') : index === active ? 'bg-fg' : hovered === index ? 'bg-fg-3' : 'bg-fg-4/55';
          // A line grows leftwards from the edge; a dot grows about one axis, so the column stays straight.
          const width = dots ? (index === active ? 6 : hovered === index ? 5 : 4) : index === active ? 20 : hovered === index ? 12 : 7;
          return (
            <button
              key={turn.key}
              type="button"
              aria-label={t`跳到第 ${index + 1} 条消息`}
              aria-current={index === active ? 'true' : undefined}
              onClick={() => jump(turn.key)}
              onMouseEnter={(event) => preview(index, event.currentTarget)}
              onFocus={(event) => preview(index, event.currentTarget)}
              onBlur={unpreview}
              className="flex w-8 shrink-0 items-center justify-end pr-1.5 outline-none"
              style={{ height: RAIL_SLOT }}
            >
              {dots
                ? <span className="flex w-1.5 justify-center"><span className={cn('block rounded-full transition-[width,height,background-color] duration-[var(--duration-slow)] ease-[var(--ease-standard)]', tone)} style={{ width, height: width }} /></span>
                : <span className={cn('block h-[2px] rounded-full transition-[width,background-color] duration-[var(--duration-slow)] ease-[var(--ease-standard)]', tone)} style={{ width }} />}
            </button>
          );
        })}
      </div>
      {shown && previewTop !== undefined && (
        <span className="pointer-events-none absolute right-full mr-1.5 w-max max-w-[320px] -translate-y-1/2 animate-in fade-in-0 slide-in-from-right-1 duration-[var(--duration-fast)] ease-[var(--ease-decelerate)]" style={{ top: previewTop }}>
          <span className="block rounded-lg bg-popover px-3 py-2 text-left text-sm text-fg shadow-pop">
            <span className="line-clamp-4 wrap-anywhere">{shown.text}</span>
            {(shownTime || marked?.has(shown.key)) && (
              <span className="mt-1.5 flex items-center gap-1.5 text-2xs tabular-nums text-fg-4">
                {marked?.has(shown.key) && <IconBookmarkFilled aria-label={t`已收藏`} className="size-3 text-accent" />}
                {shownTime}
              </span>
            )}
          </span>
        </span>
      )}
    </nav>
  );
});

/**
 * The wide layout's turn navigation: every prompt as a line in the session's side column, the one
 * being read in full ink. A long history scrolls inside its own band, which follows the current line,
 * so the sections below it stay in reach.
 */
export const TurnOutline = memo(function TurnOutline(tracking: TurnTracking) {
  const { t } = useLingui();
  const { turns } = tracking;
  const { active, jump } = useActiveTurn(tracking);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const list = listRef.current;
    const item = active >= 0 ? list?.children[active] as HTMLElement | undefined : undefined;
    if (!list || !item) return;
    const top = item.getBoundingClientRect().top - list.getBoundingClientRect().top;
    if (top < 0 || top + item.offsetHeight > list.clientHeight) list.scrollTop += top - list.clientHeight / 3;
  }, [active]);

  // The side column is there from the session's first message, so the outline is too.
  if (!turns.length) return null;
  return (
    <nav aria-label={t`本会话`}>
      <h2 className="mb-1.5 flex items-center px-2 text-2xs font-medium text-fg-4">{t`本会话`}<span className="ml-auto tabular-nums">{turns.length}</span></h2>
      <ol ref={listRef} className="max-h-[min(45vh,400px)] overflow-y-auto overscroll-contain scrollbar-none">
        {turns.map((turn, index) => (
          <li key={turn.key}>
            <button
              type="button"
              aria-current={index === active ? 'true' : undefined}
              onClick={() => jump(turn.key)}
              title={turn.text}
              className={cn('flex w-full min-w-0 items-baseline gap-2 rounded-lg px-2 py-1 text-left text-sm transition-colors hover:bg-hover', index === active ? 'font-medium text-fg' : 'text-fg-3 hover:text-fg-2')}
            >
              {/* The number is the turn list's left content, so it sits on the column's left edge —
                  the same edge as a todo's glyph and an output's file name. Right-aligning it inside
                  the 16px column pushed its glyph ~10px right of everything else in the aside. */}
              <span className={cn('w-4 shrink-0 text-left text-2xs tabular-nums', index === active ? 'text-accent' : 'text-fg-4')}>{index + 1}</span>
              <span className="min-w-0 flex-1 truncate">{turn.text}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
});
