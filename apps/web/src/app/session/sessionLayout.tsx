import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from 'react';
import { flushSync } from 'react-dom';

import { cn } from '@/lib/utils';

/**
 * The conversation's geometry, decided in one place. Its only inputs are the session's own width and
 * what the reader asked for (an aside the session may show at all); never what the conversation
 * holds, so a message, a plan or a file landing cannot add or remove a column.
 */
export interface SessionLayout {
  /** The side column beside the reading column. */
  aside: 'column' | 'none';
  /** Turn navigation: lines in the side column, or a rail on the transcript's edge. */
  nav: 'outline' | 'rail';
  /** Goal and todos: in the side column, or above the composer. */
  plan: 'aside' | 'dock';
}

/** Room for a full reading column beside the 248px aside (68rem). */
export const SESSION_ASIDE_MIN_WIDTH = 1088;

/** The two answers, one object each, so an unchanged answer is the same value and a state holding it bails out. */
const WITH_ASIDE: SessionLayout = { aside: 'column', nav: 'outline', plan: 'aside' };
const WITHOUT_ASIDE: SessionLayout = { aside: 'none', nav: 'rail', plan: 'dock' };

export function sessionLayout(width: number, asideAllowed: boolean): SessionLayout {
  return asideAllowed && width >= SESSION_ASIDE_MIN_WIDTH ? WITH_ASIDE : WITHOUT_ASIDE;
}

/** A width change this large in one frame is a discrete layout step (sidebar, panel, aside), not a window drag. */
const STEP_MIN_PX = 64;
const STEP_MS = 300;
const STEP_ID = 'session-step';
/** How long after a conversation opens its geometry is still settling rather than being stepped. */
export const ASSEMBLY_MS = 800;
/** How long a wait (a missing model catalog, a session being created) lasts before it is said. */
export const WAIT_GRACE_MS = 600;

/** Where an element is painted relative to its layout box: mid-slide, the slide's current offset. */
function paintedOffset(element: HTMLElement) {
  const transform = getComputedStyle(element).transform;
  return transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m41;
}

/**
 * Measures the session and answers its layout. The width only changes in single steps (the sidebar
 * and the context panel reserve their room at once and slide over it), so the answer flips once per
 * step and never mid-animation. Each step then slides the centred columns from where they were to
 * where they now are, instead of letting them jump; the transcript's scroller and the session column
 * both clip horizontally, so a slide neither paints over the aside nor scrolls sideways.
 *
 * A step that changes the answer (the aside appearing) commits within the same frame, so the
 * columns are measured at their final place and slide there once; a step that lands mid-slide
 * starts from where the columns are painted, not from where the previous step began. A width that
 * leaves the answer as it was renders nothing, so dragging the window does not re-render the session.
 *
 * Columns also move without a step: the reading width dragged, a column mounting, one hidden under a
 * subagent page and shown again. Each column is observed too, and such a move only updates where it
 * slides from next time.
 *
 * The transcript's scrollbar gutter is published as `--session-gutter`, so a column outside the
 * scroller can centre on the same axis as the one inside it.
 */
export function useSessionLayout(asideAllowed: boolean) {
  // The session component survives switching to the terminal, but these DOM nodes do not.
  // Callback refs make the observer follow their lifetime, including the new nodes on return.
  const [container, containerRef] = useState<HTMLDivElement | null>(null);
  const [column, columnRef] = useState<HTMLDivElement | null>(null);
  /** The answer the session's width alone gives; whether the aside may show at all is applied on top. */
  const [fits, setFits] = useState(WITHOUT_ASIDE);

  useLayoutEffect(() => {
    if (!container || !column) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    // Always publish the first measurement: a newly mounted narrow container must also replace
    // a wide layout retained from before the terminal view was opened.
    let answer: SessionLayout | undefined;
    /** Where each column's left edge was laid out at the last measure, transforms aside. */
    const lefts = new WeakMap<HTMLElement, number>();
    /** Each observed column's width at its last report: a column only growing taller has not moved. */
    const widths = new WeakMap<Element, number>();
    const columns = new Set<HTMLElement>();
    let gutter = -1;
    // The conversation is still assembling (its aside mounting, the transcript loading, fonts) for a
    // moment after it opens: what moves then is the page arriving, not a step the reader took, and
    // it appears in place under the transcript's own fade instead of sliding in.
    let assembling = true;
    const assembled = window.setTimeout(() => { assembling = false; }, ASSEMBLY_MS);
    const measure = (step: boolean) => {
      const next = sessionLayout(container.clientWidth, true);
      if (next !== answer) {
        answer = next;
        if (step) flushSync(() => setFits(next));
        else setFits(next);
      }
      const scroller = column.querySelector<HTMLElement>('[data-transcript-scroll]');
      // A hidden transcript (a subagent page over it) has no gutter to report; keep the last one.
      const nextGutter = !scroller ? 0 : scroller.offsetWidth ? scroller.offsetWidth - scroller.clientWidth : gutter;
      if (nextGutter >= 0 && nextGutter !== gutter) {
        gutter = nextGutter;
        container.style.setProperty('--session-gutter', `${gutter}px`);
      }
      const targets = [...column.querySelectorAll<HTMLElement>('[data-content-column]')];
      for (const target of columns) if (!targets.includes(target)) { observer.unobserve(target); columns.delete(target); }
      for (const target of targets) if (!columns.has(target)) { observer.observe(target); columns.add(target); }
      // Each column slides by how far its own left edge moved, not by the session's centre: a column
      // below its width cap widens in place (its left edge stays), while a capped one is re-centred.
      // Sliding a widened column by the centre's move would throw it left and bring it back.
      const moves = targets.map((target) => {
        const offset = paintedOffset(target);
        const rect = target.getBoundingClientRect();
        // A hidden column (a subagent page over the transcript) has no place; keep its last one.
        if (!rect.width) return { target, offset, delta: 0 };
        const left = rect.left - offset;
        const previous = lefts.get(target);
        lefts.set(target, left);
        return { target, offset, delta: previous === undefined ? 0 : previous - left };
      });
      // The first answer lands before the first paint (the aside included), so it is where the
      // columns start, not a step to slide from.
      if (!step || assembling || reduced.matches) return;
      for (const { target, offset, delta } of moves) {
        if (Math.abs(delta) < STEP_MIN_PX / 2) continue;
        for (const animation of target.getAnimations()) if (animation.id === STEP_ID) animation.cancel();
        target.animate([{ transform: `translateX(${delta + offset}px)` }, { transform: 'none' }], { id: STEP_ID, duration: STEP_MS, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
      }
    };
    // The observer's first call reports the sizes it started with: a baseline, not a step.
    let observed = false;
    const observer = new ResizeObserver((entries) => {
      let session = false;
      let moved = false;
      for (const entry of entries) {
        if (entry.target === container || entry.target === column) { session = true; continue; }
        const width = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
        if (widths.get(entry.target) !== width) moved = true;
        widths.set(entry.target, width);
      }
      // Only the session itself changing width is a step; a column moving on its own is a new baseline.
      // A pane being dragged (`ResizeHandle`) moves the width in many small frames, like the window.
      if (session || moved) measure(observed && session && !document.documentElement.dataset.resizing);
      observed = true;
    });
    observer.observe(container);
    observer.observe(column);
    measure(false);
    return () => { observer.disconnect(); window.clearTimeout(assembled); };
  }, [container, column]);

  return { containerRef, columnRef, layout: asideAllowed ? fits : WITHOUT_ASIDE };
}

/**
 * A column of the conversation's reading width. Every centred session column uses it, so the
 * transcript, the composer and the terminal drawer share one cap, one padding and one axis.
 * `outside` marks a column that is not inside the transcript's scroller: it gives up the scroller's
 * gutter on its right so both centre on the same line.
 */
export function ContentColumn({ outside, className, ...props }: ComponentProps<'div'> & { outside?: boolean }) {
  const column = <div data-content-column className={cn('mx-auto w-full max-w-(--content-width) px-3 sm:px-4 md:px-12', className)} {...props} />;
  return outside ? <div className="pr-(--session-gutter)">{column}</div> : column;
}

/**
 * The last present value, for a region that collapses away: while it animates closed it keeps
 * showing what it held instead of emptying first and then shrinking from nothing.
 */
export function useHeld<T>(value: T | undefined | null | false): T | undefined {
  const held = useRef<T | undefined>(undefined);
  if (value !== undefined && value !== null && value !== false) held.current = value;
  return held.current;
}

/**
 * [value] once it has held for [ms]; false the moment it stops. A wait that ends within the grace
 * (a catalog that lands quickly) never shows, so its row does not open and close on every load.
 */
export function useLingering(value: boolean, ms: number): boolean {
  const [lasted, setLasted] = useState(false);
  useEffect(() => {
    setLasted(false);
    if (!value) return;
    const timer = window.setTimeout(() => setLasted(true), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return value && lasted;
}
