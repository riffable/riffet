import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { cn } from '@/lib/utils';
import { animationsOf } from '@/lib/motion';

interface Props {
  open: boolean;
  children: ReactNode;
  className?: string;
  /**
   * Children stay mounted once shown. Folded, they are `hidden="until-found"`: they keep their own
   * state, an entrance inside does not replay, and find-in-page still reaches the text, which opens
   * the region at once and calls [onReveal] so the owner's state follows.
   */
  keep?: boolean;
  onReveal?: () => void;
  /** Changes land at once, without the height and fade, for a state that is still settling rather than being changed. */
  still?: boolean;
  /** For `aria-controls`. */
  id?: string;
}

/** DOM attribute marking a `Collapse` region's settled/transitioning state for scroll anchoring. */
export const COLLAPSE_STATE_ATTR = 'data-collapse-state';

/**
 * Height-animated region.
 *
 * Uses `grid-template-rows` so it works with content of any height without measuring
 * it, and keeps children mounted only while open or still animating closed — so a
 * hidden region cannot hold sockets or subscriptions open (unless [keep] says otherwise).
 * The inner box clips only while it moves: settled open, shadows and popovers inside reach out.
 * Under reduced motion the global rules keep only the opacity transition, so the height lands at
 * once and the fade's `transitionend` still settles the region.
 */
export function Collapse({ open, children, className, keep, onReveal, still, id }: Props) {
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);
  /** At rest in its current state: open without clipping, or folded and hidden/unmounted. */
  const [settled, setSettled] = useState(true);
  /** A [still] change or find-in-page match opened/closed the region with transitions disabled. */
  const [instant, setInstant] = useState(false);
  /** Browser find-in-page (`beforematch`) just opened the region before the owner's `open` prop catches up. */
  const revealing = useRef(false);
  if (open) revealing.current = false;

  // Commit [still] state changes synchronously during render so the very first commit lands in the
  // target geometry (`grid-rows-[0fr]` / `grid-rows-[1fr]` + `transition-none`), letting parent
  // layout effects (such as transcript scroll reconciliation) read the final height before paint.
  if (still && !revealing.current && (expanded !== open || !settled || (open && !mounted) || (!open && !keep && mounted))) {
    setExpanded(open);
    setSettled(true);
    setInstant(true);
    if (open) setMounted(true);
    else if (!keep) setMounted(false);
  }

  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const latest = useRef({ open, keep, onReveal, still });
  latest.current = { open, keep, onReveal, still };
  const shown = useRef(open);
  /** The `expanded` the DOM shows, written on commit. */
  const rendered = useRef(expanded);
  useLayoutEffect(() => {
    rendered.current = expanded;
    if ((still || instant) && expanded === open && settled) shown.current = open;
  });

  const finish = () => {
    if (latest.current.open || latest.current.keep) setSettled(true);
    else setMounted(false);
  };
  // In a layout effect so a region opening and one closing in the same commit move together: one
  // that waited a frame to open would leave the stack short for that frame.
  useLayoutEffect(() => {
    // Nothing to animate: the first render already shows this state, or a [still] / find-in-page change landed it.
    if (shown.current === open || (open && expanded && settled)) { shown.current = open; return; }
    shown.current = open;
    setInstant(false);
    if (!open) setExpanded(false);
    // Folded in the DOM already: it can start now. Otherwise the layout effect below starts it once mounted.
    else if (mounted) { void outer.current?.offsetHeight; setExpanded(true); }
    else setMounted(true);
    setSettled(false);
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        // A region that cannot run its transition (inside content the browser skips, or not
        // rendered at all) never sends `transitionend`; it settles now instead of staying half done.
        // No animation means that only once the DOM shows the target: under load React may not have
        // committed `expanded` yet, and settling then would drop the clip for the whole opening.
        let waited = 0;
        const check = () => {
          if (rendered.current !== open && ++waited < COMMIT_WAIT_FRAMES) { frame = requestAnimationFrame(check); return; }
          // Any listed animation counts, finished or not: a finished one that fills still means a transition owns the box.
          if (!outer.current || !animationsOf(outer.current, { all: true }).length) finish();
        };
        frame = requestAnimationFrame(check);
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);
  // Just mounted folded to open: read the folded box first so the height transitions from it, before paint.
  useLayoutEffect(() => {
    if (!mounted || expanded || settled || !latest.current.open) return;
    void outer.current?.offsetHeight;
    setExpanded(true);
  }, [mounted]);

  const hidden = Boolean(keep && !open && !expanded && settled);
  // React only writes `hidden` as a boolean, so `until-found` is set here. A browser without it
  // reads any value as plain `hidden`, which the base styles turn into `display: none`.
  useLayoutEffect(() => {
    const element = inner.current;
    if (!element || !keep) return;
    if (hidden) element.setAttribute('hidden', supportsUntilFound() ? 'until-found' : '');
    else element.removeAttribute('hidden');
  }, [hidden, keep, mounted]);

  // Flush the new geometry with transitions off before re-enabling transitions on the next frame,
  // so no stray CSS transition starts from the synchronous state change.
  useLayoutEffect(() => {
    if (!instant) return;
    void outer.current?.offsetHeight;
    const frame = requestAnimationFrame(() => setInstant(false));
    return () => cancelAnimationFrame(frame);
  }, [instant, expanded, settled]);
  useEffect(() => {
    const element = inner.current;
    if (!element || !keep) return;
    const reveal = () => {
      revealing.current = true;
      flushSync(() => { setInstant(true); setExpanded(true); setSettled(true); });
      latest.current.onReveal?.();
      queueMicrotask(() => { revealing.current = false; });
    };
    element.addEventListener('beforematch', reveal);
    return () => element.removeEventListener('beforematch', reveal);
  }, [keep, mounted]);

  if (!mounted) return null;
  const collapseState = settled ? (expanded ? 'open' : 'closed') : (open ? 'opening' : 'closing');
  return (
    <div
      ref={outer}
      {...{ [COLLAPSE_STATE_ATTR]: collapseState }}
      className={cn(
        // The column is pinned to the region's width: with no clip on the settled child, an `auto`
        // track would grow to the child's min-content (a long unbroken line) and push it past the column.
        'grid grid-cols-[minmax(0,1fr)] transition-[grid-template-rows,opacity] duration-[var(--duration-base)] ease-out-soft',
        expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        instant && 'transition-none',
        className,
      )}
      onTransitionEnd={(event) => { if (event.target === event.currentTarget && expanded === open) finish(); }}
    >
      <div ref={inner} id={id} className={cn('min-h-0 min-w-0', !(settled && expanded) && 'overflow-hidden')}>{children}</div>
    </div>
  );
}

/** Frames to wait for React to commit the target state before settling without a transition anyway. */
const COMMIT_WAIT_FRAMES = 30;

let untilFound: boolean | undefined;
function supportsUntilFound(): boolean {
  untilFound ??= typeof document !== 'undefined' && 'onbeforematch' in document.body;
  return untilFound;
}
