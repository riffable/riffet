import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';

/** Below this many entries a list mounts whole; windowing only pays for itself past it (docs/guide/web-performance.md §2.2). */
export const LIST_WINDOW_MIN = 150;
/** Extra distance kept mounted above and below the viewport, so a fling does not show blank rows. */
const OVERSCAN_PX = 800;

export interface ListWindow {
  /** [from, to) of the entries to mount. */
  from: number;
  to: number;
  /** Space standing in for the entries before and after the window; put it on the list as padding. */
  padTop: number;
  padBottom: number;
  /** Ref for the element of entry `index`: its height becomes the height of every entry of its kind. */
  measure: (index: number) => (element: HTMLElement | null) => void;
  /** Whether the list is windowed at all. */
  windowed: boolean;
  /** Scrolls entry `index` into view when it is not mounted, as `scrollIntoView({ block: 'nearest' })` would. */
  reveal: (index: number) => void;
}

interface Options {
  count: number;
  /** A kind per entry; entries of one kind are taken to be one height (rows, headers, buttons). */
  kindOf: (index: number) => string;
  /** The height of a kind not yet measured. */
  estimate: (kind: string) => number;
  /** The scrolling element, and the list inside it (it may sit below other content). */
  scroller: RefObject<HTMLElement | null>;
  list: RefObject<HTMLElement | null>;
}

/**
 * Mounts only the entries of a long list that are near the viewport. Built for lists of uniform rows
 * (sidebar, palettes, pickers): each kind of entry has one height, learned from the first mounted
 * entry of that kind and kept current by a ResizeObserver, so text scale and touch layouts are right
 * without a constant per platform. The transcript, whose rows all differ, has its own (`virtualRows`).
 */
export function useListWindow({ count, kindOf, estimate, scroller, list }: Options): ListWindow {
  const windowed = count > LIST_WINDOW_MIN;
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map());
  const kindOfRef = useRef(kindOf);
  kindOfRef.current = kindOf;
  const windowedRef = useRef(windowed);
  windowedRef.current = windowed;
  const offsets = useMemo(() => {
    if (!windowed) return new Float64Array(0);
    const result = new Float64Array(count + 1);
    for (let index = 0; index < count; index += 1) {
      const kind = kindOf(index);
      result[index + 1] = result[index]! + (heights.get(kind) ?? estimate(kind));
    }
    return result;
    // kindOf and estimate are read for the entries as they are now; callers recreate them with the entries.
  }, [windowed, count, kindOf, estimate, heights]);

  const initial = Math.min(count, 60);
  const [range, setRange] = useState<readonly [number, number]>([0, initial]);

  const update = useCallback(() => {
    const scroll = scroller.current;
    const body = list.current;
    if (!windowed || !scroll || !body) return;
    const listTop = body.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
    const top = scroll.scrollTop - listTop;
    const bottom = top + scroll.clientHeight;
    setRange((current) => {
      const [from, to] = current;
      // Still covered with a margin to spare: keep the window and skip the render.
      if (to <= count && offsets[from]! <= Math.max(0, top - OVERSCAN_PX / 4) && offsets[to]! >= Math.min(offsets[count]!, bottom + OVERSCAN_PX / 4)) return current;
      const next = [indexAt(offsets, count, top - OVERSCAN_PX), Math.min(count, indexAt(offsets, count, bottom + OVERSCAN_PX) + 1)] as const;
      return next[0] === from && next[1] === to ? current : next;
    });
  }, [windowed, scroller, list, count, offsets]);

  // A new list or new heights can leave the window anywhere: place it again before paint.
  useLayoutEffect(update, [update]);

  useEffect(() => {
    const scroll = scroller.current;
    if (!windowed || !scroll) return;
    let frame = 0;
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; update(); }); };
    scroll.addEventListener('scroll', onScroll, { passive: true });
    const resize = new ResizeObserver(onScroll);
    resize.observe(scroll);
    return () => { scroll.removeEventListener('scroll', onScroll); resize.disconnect(); cancelAnimationFrame(frame); };
  }, [windowed, scroller, update]);

  // One observer for the mounted entries; a kind's height is whatever its entries last measured.
  const observed = useRef(new Map<Element, string>());
  const observer = useMemo(() => typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver((entries) => {
    setHeights((current) => {
      let next: Map<string, number> | undefined;
      for (const entry of entries) {
        const kind = observed.current.get(entry.target);
        const height = entry.borderBoxSize?.[0]?.blockSize ?? (entry.target as HTMLElement).offsetHeight;
        if (!kind || !(height > 0) || Math.abs((current.get(kind) ?? -1) - height) < 0.5) continue;
        next ??= new Map(current);
        next.set(kind, height);
      }
      return next ?? current;
    });
  }), []);
  useEffect(() => () => observer?.disconnect(), [observer]);

  const refs = useRef(new Map<number, (element: HTMLElement | null) => void>());
  const measure = useCallback((index: number) => {
    let ref = refs.current.get(index);
    if (!ref) {
      let last: HTMLElement | null = null;
      ref = (element) => {
        if (last) { observer?.unobserve(last); observed.current.delete(last); }
        last = element;
        if (element && windowedRef.current) {
          observed.current.set(element, kindOfRef.current(index));
          observer?.observe(element);
        }
      };
      refs.current.set(index, ref);
    }
    return ref;
  }, [observer]);

  const reveal = useCallback((index: number) => {
    const scroll = scroller.current;
    const body = list.current;
    if (!windowed || !scroll || !body || index < 0 || index >= count) return;
    const listTop = body.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
    const top = listTop + offsets[index]!;
    const bottom = listTop + offsets[index + 1]!;
    if (top < scroll.scrollTop) scroll.scrollTop = top;
    else if (bottom > scroll.scrollTop + scroll.clientHeight) scroll.scrollTop = bottom - scroll.clientHeight;
  }, [windowed, scroller, list, count, offsets]);

  if (!windowed) return { from: 0, to: count, padTop: 0, padBottom: 0, measure, windowed, reveal };
  const from = Math.min(range[0], count);
  const to = Math.min(Math.max(range[1], from), count);
  return { from, to, padTop: offsets[from]!, padBottom: offsets[count]! - offsets[to]!, measure, windowed, reveal };
}

/** The entry containing [y]: the last one whose top is at or above it. */
function indexAt(offsets: Float64Array, count: number, y: number): number {
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (offsets[middle]! <= y) low = middle; else high = middle - 1;
  }
  return Math.min(low, Math.max(0, count - 1));
}
