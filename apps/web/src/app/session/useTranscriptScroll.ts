import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { captureReadingAnchor, readingAnchorTop, type ReadingAnchor } from './readingAnchor';
import { animationsOf } from '@/lib/motion';

export interface TranscriptScrollHandle {
  scrollByReader(deltaY: number, deltaMode?: number): boolean;
  /** The reader sent a message: the end comes back unless they are reading earlier turns. */
  followSent(): void;
  /** Bring the prompt of [runId] into view, when it is among the loaded rows. */
  revealRun(runId: string): void;
}

interface Options {
  scrollRef: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLElement | null>;
  spacerRef: RefObject<HTMLElement | null>;
  sessionId: string;
  resetVersion: number;
  loaded: boolean;
  resources: boolean;
  hasMoreLater: boolean;
  running: boolean;
  locate(key: string): number | undefined;
  modelAnchor(): ReadingAnchor | undefined;
  onPositionChange(synchronous: boolean): void;
}

interface Geometry { height: number; width: number; content: number }
/**
 * A disclosure the reader toggled, kept where it was on screen while what it opens or folds settles:
 * the content around it is what moves. Ends once its row has no transition running and has kept its
 * height for [HOLD_QUIET] frames. [following] is the mode at the click. Whether following goes on is
 * decided at the click, never at the end: a view that settled around the target and then went to
 * the end would move twice.
 */
interface Held { target: Element; top: number; frame: number; deadline: number; quiet: number; size: number; following: boolean }

/** Frames without change that end a hold; the region a click opens only starts moving two frames later. */
const HOLD_QUIET = 8;
const HOLD_MAX_MS = 1500;
/** What the reader toggles in place: a disclosure (process block, tool row, thought, delivery error), not a menu trigger. */
const DISCLOSURE = '[aria-expanded]:not([aria-haspopup]),summary';
/** Before the toggle: whether the click folds [target]. A `summary` has no `aria-expanded`; its `details` says. */
const folds = (target: Element) => target instanceof HTMLElement && target.tagName === 'SUMMARY' && target.parentElement instanceof HTMLDetailsElement
  ? target.parentElement.open
  : target.getAttribute('aria-expanded') === 'true';
/** Whether [target] belongs to the latest turn: no turn starts after it. */
const inLastTurn = (scroller: HTMLElement, target: Element) => {
  const turns = scroller.querySelectorAll('[data-turn]');
  const last = turns[turns.length - 1];
  return !last || last.contains(target) || Boolean(last.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING);
};
const transitioning = (element: Element) => animationsOf(element, { subtree: true }).some((animation) => 'transitionProperty' in animation && animation.playState === 'running');
interface Navigation {
  frame: number;
  resolve: () => number | undefined;
  behavior: ScrollBehavior;
  deadline: number;
  still: number;
  target?: number;
}

const geometry = (element: HTMLElement): Geometry => ({ height: element.clientHeight, width: element.clientWidth, content: element.scrollHeight });
const sameGeometry = (a: Geometry | undefined, b: Geometry) => a?.height === b.height && a.width === b.width && a.content === b.content;
const visible = (element: HTMLElement) => element.clientHeight > 0 && element.clientWidth > 0;
const bottom = (element: HTMLElement) => Math.max(0, element.scrollHeight - element.clientHeight);
const editable = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
const selecting = (element: HTMLElement) => {
  const selection = element.ownerDocument.getSelection();
  return Boolean(selection && !selection.isCollapsed && selection.rangeCount && element.contains(selection.getRangeAt(0).commonAncestorContainer));
};

/** Nested code and diff panes spend their own gestures before the transcript does. */
function innerScrollTakes(target: EventTarget | null, scroller: HTMLElement, up: boolean): boolean {
  for (let node = target instanceof Element ? target : null; node && node !== scroller; node = node.parentElement) {
    if (!(node instanceof HTMLElement) || node.scrollHeight <= node.clientHeight + 1) continue;
    const style = getComputedStyle(node);
    if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') continue;
    if (up ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight - 1) return true;
    if (style.overscrollBehaviorY === 'contain' || style.overscrollBehaviorY === 'none') return true;
  }
  return false;
}

/**
 * The sole owner of transcript scrolling. Following and reading survive layout changes; a
 * navigation temporarily owns placement, and reader input cancels it. Resize callbacks always
 * restore the anchor saved before the change, never an anchor measured from the shifted rows.
 */
export function useTranscriptScroll(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const following = useRef(!options.resources && !options.hasMoreLater);
  const anchor = useRef<ReadingAnchor | null>(null);
  const navigationVersion = useRef(0);
  // A requested page replacement resets layout, but does not supersede the reader's request.
  const intentVersion = useRef(0);
  const [atBottom, setAtBottom] = useState(!options.hasMoreLater);
  const bottomVisible = useRef(atBottom);
  const state = useRef({
    active: false,
    sessionId: options.sessionId,
    initialized: false,
    hidden: false,
    geometry: undefined as Geometry | undefined,
    naturalContent: undefined as number | undefined,
    top: 0,
    owned: undefined as number | undefined,
    navigation: undefined as Navigation | undefined,
    held: undefined as Held | undefined,
    request: undefined as AbortController | undefined,
    readerUntil: 0,
    pointerHeld: false,
    touchY: undefined as number | undefined,
    readerTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  });

  const controller = useMemo(() => {
    const current = () => state.current.active ? latest.current.scrollRef.current : null;
    const spacerHeight = () => {
      const spacer = latest.current.spacerRef.current;
      return spacer ? Number.parseFloat(spacer.style.height) || 0 : 0;
    };
    const setSpacer = (height: number) => {
      const spacer = latest.current.spacerRef.current;
      if (!spacer) return;
      const next = height > 0.5 ? `${Math.ceil(height)}px` : '';
      if (spacer.style.height !== next) spacer.style.height = next;
    };
    const naturalContent = (element: HTMLElement) => {
      // Measure the un-clamped content column rather than `element.scrollHeight`, which is always
      // floored at `element.clientHeight` and would undercount the spacer needed in short sessions.
      const content = latest.current.contentRef.current;
      return Math.max(0, (content ? content.offsetHeight : element.scrollHeight) - spacerHeight());
    };
    const naturalBottom = (element: HTMLElement) => Math.max(0, naturalContent(element) - element.clientHeight);
    const spacerNeeded = (element: HTMLElement, top: number) =>
      top > 0.5 ? Math.max(0, top + element.clientHeight - naturalContent(element)) : 0;
    const reclaimSpacer = (element: HTMLElement) => {
      if (state.current.held || state.current.navigation) return;
      if (following.current) { setSpacer(0); return; }
      const held = spacerHeight();
      if (held <= 0) return;
      setSpacer(Math.min(held, spacerNeeded(element, element.scrollTop)));
    };
    const capture = () => {
      const element = current();
      if (element && visible(element) && !following.current && !state.current.navigation) {
        anchor.current = captureReadingAnchor(element, latest.current.modelAnchor);
      }
    };
    const reportBottom = () => {
      const element = current();
      if (!element || !visible(element)) return;
      const value = !latest.current.hasMoreLater && naturalBottom(element) - element.scrollTop < 64;
      if (bottomVisible.current !== value) { bottomVisible.current = value; setAtBottom(value); }
    };
    const remember = (element: HTMLElement) => {
      state.current.geometry = geometry(element);
      state.current.naturalContent = naturalContent(element);
      state.current.top = element.scrollTop;
    };
    const write = (element: HTMLElement, top: number, behavior: ScrollBehavior = 'auto', allowSpacer = false) => {
      const desired = Math.max(0, top);
      if (allowSpacer) {
        const contentHeight = naturalContent(element);
        const deficit = spacerNeeded(element, desired);
        const contentShrank = state.current.naturalContent !== undefined && contentHeight < state.current.naturalContent - 0.5;
        // A fold the reader clicked near the end lets the content above come down instead of leaving
        // a blank tail under the held row; only folds nobody clicked keep the view with the spacer.
        if (contentShrank && !state.current.held) setSpacer(deficit);
        else if (spacerHeight() > 0) setSpacer(Math.min(spacerHeight(), deficit));
      } else if (following.current) {
        setSpacer(0);
      }
      const target = Math.max(0, Math.min(bottom(element), desired));
      // Keep ownership until a reader signal or an unknown native scroll. A one-frame lock
      // expires before delayed scroll events and native smooth-scroll inertia finish.
      state.current.owned = target;
      if (Math.abs(element.scrollTop - target) > 0.5) element.scrollTo({ top: target, behavior });
      remember(element);
      reportBottom();
    };
    const cancelNavigation = () => {
      const operation = state.current.navigation;
      if (!operation) return;
      cancelAnimationFrame(operation.frame);
      state.current.navigation = undefined;
      const element = current();
      // An instant scroll to the current position stops the browser's smooth animation.
      if (element) {
        element.scrollTo({ top: element.scrollTop, behavior: 'instant' });
        state.current.owned = element.scrollTop;
        remember(element);
      }
    };
    const clearReader = () => {
      clearTimeout(state.current.readerTimer);
      state.current.readerTimer = undefined;
      state.current.readerUntil = 0;
    };
    const cancelRequest = () => {
      state.current.request?.abort();
      state.current.request = undefined;
    };
    const dropHold = () => {
      const held = state.current.held;
      if (!held) return;
      cancelAnimationFrame(held.frame);
      state.current.held = undefined;
    };
    const cancelPending = () => {
      navigationVersion.current += 1;
      intentVersion.current += 1;
      cancelRequest();
      cancelNavigation();
      dropHold();
      state.current.owned = undefined;
    };
    const finishReader = () => {
      const hadReader = state.current.readerUntil > 0 || state.current.pointerHeld;
      const element = current();
      if (hadReader && element && visible(element) && !state.current.navigation) {
        reclaimSpacer(element);
        reconcile();
      }
      clearReader();
    };
    const deferReaderEnd = () => {
      clearTimeout(state.current.readerTimer);
      // scrollend is preferred; this covers engines without it and gestures that hit an edge.
      state.current.readerTimer = setTimeout(finishReader, 180);
    };
    const readerInput = (up?: boolean) => {
      const element = current();
      const keepFollowing = up === false && element && !latest.current.hasMoreLater && !selecting(element)
        && (following.current || bottom(element) - element.scrollTop <= 2);
      cancelPending();
      // A downward gesture at the end may produce no scroll event at all.
      if (keepFollowing) {
        clearReader();
        following.current = true;
        anchor.current = null;
        setSpacer(0);
        if (element) reconcile();
        return;
      }
      following.current = false;
      capture();
      state.current.readerUntil = performance.now() + 240;
      deferReaderEnd();
    };
    const release = () => {
      cancelPending();
      clearReader();
      following.current = false;
      capture();
      reportBottom();
    };
    const reconcile = () => {
      const element = current();
      if (!element || !latest.current.loaded) return;
      if (!visible(element)) { state.current.hidden = true; return; }
      state.current.hidden = false;
      // Following is the reader's intent, not a fact about the rows: a window that lost its end keeps
      // the view at its bottom, where the page probe brings the newest rows back.
      if (!state.current.initialized) {
        state.current.initialized = true;
        if (following.current) setSpacer(0);
        write(element, following.current ? bottom(element) : 0);
        capture();
      } else if (!state.current.navigation) {
        const held = state.current.held;
        if (held?.target.isConnected) {
          write(element, element.scrollTop + held.target.getBoundingClientRect().top - element.getBoundingClientRect().top - held.top, 'auto', true);
        } else if (following.current) {
          setSpacer(0);
          write(element, bottom(element));
        } else if (anchor.current) {
          const anchored = Math.max(0, readingAnchorTop(element, anchor.current, latest.current.locate));
          let top = anchored;
          // Preserve native gesture movement since the last capture while compensating layout.
          // The scroller always disables native `overflow-anchor`, so `element.scrollTop - baseline`
          // is strictly reader gesture movement across every browser.
          if ((state.current.pointerHeld || performance.now() < state.current.readerUntil) && anchored <= bottom(element)) {
            const baseline = Math.max(0, Math.min(bottom(element), anchor.current.scrollTop));
            top = anchored + element.scrollTop - baseline;
          }
          write(element, top, 'auto', true);
          capture();
        } else {
          reclaimSpacer(element);
          remember(element);
          capture();
        }
      }
      reportBottom();
      latest.current.onPositionChange(false);
    };
    /** The hold is over. Following survives it only where the hold left the view: still at the end. */
    const endHold = () => {
      const held = state.current.held;
      const element = current();
      dropHold();
      if (!held || !element || !visible(element)) return;
      if (following.current && (!held.following || latest.current.hasMoreLater || selecting(element) || naturalBottom(element) - element.scrollTop > 2)) following.current = false;
      if (following.current) {
        setSpacer(0);
        anchor.current = null;
        reconcile();
        return;
      }
      // Where the hold left the view is the reader's place now, not the anchor from before the click.
      capture();
      reportBottom();
      latest.current.onPositionChange(false);
    };
    /**
     * The reader toggled [target]: it stays where it is on screen until the change settles. Not while
     * following through a fold (it cannot take the end away) or through opening something in the
     * running turn (opened to watch it): there the end stays put every frame and the content above moves.
     */
    const hold = (target: Element) => {
      const element = current();
      if (!element || !visible(element) || state.current.navigation) return;
      dropHold();
      if (following.current && (folds(target) || (latest.current.running && inLastTurn(element, target)))) return;
      const row = target.closest('[data-row-key]');
      // The toggled row's own height, so rows streaming in elsewhere do not keep the hold to its limit.
      const size = (scroller: HTMLElement) => row ? row.getBoundingClientRect().height : scroller.scrollHeight;
      const held: Held = {
        target, top: target.getBoundingClientRect().top - element.getBoundingClientRect().top,
        frame: 0, deadline: performance.now() + HOLD_MAX_MS, quiet: 0, size: size(element), following: following.current,
      };
      state.current.held = held;
      const tick = () => {
        if (state.current.held !== held) return;
        const scroller = current();
        if (!scroller || !target.isConnected) { endHold(); return; }
        // Resize callbacks place every frame the content height changes; this covers the rest.
        reconcile();
        const next = size(scroller);
        held.quiet = next === held.size && !transitioning(row ?? target) ? held.quiet + 1 : 0;
        held.size = next;
        if (held.quiet >= HOLD_QUIET || performance.now() >= held.deadline) endHold();
        else held.frame = requestAnimationFrame(tick);
      };
      held.frame = requestAnimationFrame(tick);
    };
    const followEnd = () => {
      cancelPending();
      clearReader();
      following.current = !latest.current.hasMoreLater;
      anchor.current = null;
      if (following.current) setSpacer(0);
      if (following.current) reconcile(); else capture();
    };
    const navigate = (resolve: () => number | undefined, navigationOptions?: { behavior?: ScrollBehavior }) => {
      release();
      setSpacer(0);
      anchor.current = null;
      const operation: Navigation = { frame: 0, resolve, behavior: navigationOptions?.behavior ?? 'auto', deadline: performance.now() + 1500, still: 0 };
      state.current.navigation = operation;
      const finish = () => {
        if (state.current.navigation !== operation) return;
        cancelNavigation();
        capture();
        reportBottom();
      };
      const place = () => {
        if (state.current.navigation !== operation) return;
        const element = current();
        if (!element) { finish(); return; }
        const top = visible(element) ? operation.resolve() : undefined;
        if (top !== undefined && Number.isFinite(top)) {
          const target = Math.max(0, Math.min(bottom(element), top));
          const changed = operation.target === undefined || Math.abs(operation.target - target) > 0.5;
          if (changed || (operation.behavior !== 'smooth' && Math.abs(element.scrollTop - target) > 1)) {
            operation.target = target;
            write(element, target, operation.behavior);
            latest.current.onPositionChange(false);
          }
          operation.still = Math.abs(element.scrollTop - target) <= 1 && !changed ? operation.still + 1 : 0;
        }
        if (state.current.navigation !== operation) return;
        if (operation.still >= 12 || performance.now() >= operation.deadline) finish();
        else operation.frame = requestAnimationFrame(place);
      };
      place();
      return finish;
    };
    return {
      following,
      anchor,
      navigationVersion,
      intentVersion,
      get atBottom() { return bottomVisible.current; },
      preserveBeforeChange() { capture(); },
      reconcile,
      release,
      navigate,
      beginRequest() {
        cancelRequest();
        const request = new AbortController();
        state.current.request = request;
        return {
          signal: request.signal,
          finish() { if (state.current.request === request) state.current.request = undefined; },
        };
      },
      followEnd,
      /** Still in the latest turn, whose start [turnTop] is not below the view, a reader who sends follows the end. */
      followSent(turnTop: number | undefined) {
        const element = current();
        if (!element || following.current || latest.current.hasMoreLater) return;
        if (turnTop !== undefined && turnTop > element.scrollTop + element.clientHeight) return;
        followEnd();
      },
      scrollByReader(deltaY: number, deltaMode = 0) {
        const element = current();
        if (!element || !visible(element) || !Number.isFinite(deltaY) || !deltaY) return false;
        const delta = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? element.clientHeight : 1);
        const target = Math.max(0, Math.min(bottom(element), element.scrollTop + delta));
        readerInput(delta < 0);
        write(element, target);
        reclaimSpacer(element);
        state.current.owned = undefined;
        if (!latest.current.hasMoreLater && !selecting(element) && spacerHeight() === 0 && bottom(element) - element.scrollTop <= 2) {
          following.current = true;
          anchor.current = null;
        }
        capture();
        latest.current.onPositionChange(false);
        return true;
      },
      attach(element: HTMLElement, content: HTMLElement | null) {
        const onScroll = () => {
          if (!visible(element)) { state.current.hidden = true; return; }
          if (state.current.hidden) {
            reconcile();
            latest.current.onPositionChange(true);
            return;
          }
          const nextGeometry = geometry(element);
          const layoutChanged = !sameGeometry(state.current.geometry, nextGeometry);
          const reader = state.current.pointerHeld || performance.now() < state.current.readerUntil;
          const owned = state.current.navigation || (state.current.owned !== undefined && Math.abs(element.scrollTop - state.current.owned) <= 1);
          if (layoutChanged && !state.current.navigation) {
            reconcile();
            if (reader && !owned) {
              state.current.readerUntil = performance.now() + 240;
              deferReaderEnd();
            }
            latest.current.onPositionChange(true);
            return;
          }
          if (reader && !owned) {
            reclaimSpacer(element);
            following.current = !latest.current.hasMoreLater && !selecting(element) && spacerHeight() === 0 && bottom(element) - element.scrollTop <= 2;
            state.current.owned = undefined;
            if (following.current) anchor.current = null; else capture();
            state.current.readerUntil = performance.now() + 240;
            deferReaderEnd();
          } else if (!reader && !owned && !layoutChanged && Math.abs(element.scrollTop - state.current.top) > 0.5) {
            // A move no input came with. While reading it is the reader's own (assistive technology
            // scrolls without wheel or key events) and becomes the place to keep. While following it
            // cannot end following: only reader input does (focus moved by assistive technology counts,
            // see `onFocusIn`), so the view goes back to the end instead of being stranded by layout.
            if (following.current) {
              write(element, bottom(element));
              latest.current.onPositionChange(true);
              return;
            }
            cancelPending();
            reclaimSpacer(element);
            capture();
          }
          remember(element);
          reportBottom();
          latest.current.onPositionChange(true);
        };
        const onWheel = (event: WheelEvent) => {
          if (!event.ctrlKey && event.deltaY && !innerScrollTakes(event.target, element, event.deltaY < 0)) readerInput(event.deltaY < 0);
        };
        const onTouchStart = (event: TouchEvent) => { state.current.touchY = event.touches[0]?.clientY; };
        const onTouchMove = (event: TouchEvent) => {
          const y = event.touches[0]?.clientY;
          if (y !== undefined && state.current.touchY !== undefined && y !== state.current.touchY && !innerScrollTakes(event.target, element, y > state.current.touchY)) readerInput(y > state.current.touchY);
          state.current.touchY = y;
        };
        const onKeyDown = (event: KeyboardEvent) => {
          if (event.defaultPrevented || editable(event.target) || event.altKey || event.metaKey || event.ctrlKey) return;
          if (event.target instanceof Element && event.target.closest('button,a[href],[role="button"],[role="slider"],[role="menu"],[role="listbox"]')) return;
          const up = ['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey);
          const down = ['ArrowDown', 'PageDown', 'End', ' '].includes(event.key);
          if ((up || down) && !innerScrollTakes(event.target, element, up)) readerInput(up);
        };
        const onPointerDown = (event: PointerEvent) => {
          if (event.button !== 0 || editable(event.target)) return;
          state.current.pointerHeld = true;
          // A scrollbar drag leaves following immediately. Clicking content only cancels an
          // old navigation; an actual scroll or text selection decides the reading mode.
          if (event.target === element) readerInput();
          else { cancelPending(); capture(); }
        };
        // Before React's handler toggles it, so the place taken is the one the reader clicked at.
        const onClick = (event: MouseEvent) => {
          const target = event.target instanceof Element ? event.target.closest(DISCLOSURE) : null;
          if (target && element.contains(target)) hold(target);
        };
        const onPointerUp = () => {
          if (!state.current.pointerHeld) return;
          state.current.pointerHeld = false;
          state.current.readerUntil = performance.now() + 240;
          deferReaderEnd();
        };
        // Keyboard and screen-reader navigation move focus before they scroll the focused row into view.
        const onFocusIn = (event: FocusEvent) => {
          if (event.target === element || state.current.pointerHeld) return;
          state.current.readerUntil = performance.now() + 240;
          deferReaderEnd();
        };
        const onSelectionChange = () => {
          if (!visible(element) || editable(element.ownerDocument.activeElement) || !selecting(element)) return;
          release();
        };
        const observer = new ResizeObserver(reconcile);
        observer.observe(element);
        if (content) observer.observe(content);
        element.addEventListener('scroll', onScroll, { passive: true });
        element.addEventListener('scrollend', finishReader);
        element.addEventListener('wheel', onWheel, { passive: true });
        element.addEventListener('touchstart', onTouchStart, { passive: true });
        element.addEventListener('touchmove', onTouchMove, { passive: true });
        element.addEventListener('keydown', onKeyDown);
        element.addEventListener('pointerdown', onPointerDown);
        element.addEventListener('click', onClick, true);
        element.addEventListener('focusin', onFocusIn);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);
        element.ownerDocument.addEventListener('selectionchange', onSelectionChange);
        return () => {
          observer.disconnect();
          setSpacer(0);
          element.removeEventListener('scroll', onScroll);
          element.removeEventListener('scrollend', finishReader);
          element.removeEventListener('wheel', onWheel);
          element.removeEventListener('touchstart', onTouchStart);
          element.removeEventListener('touchmove', onTouchMove);
          element.removeEventListener('keydown', onKeyDown);
          element.removeEventListener('pointerdown', onPointerDown);
          element.removeEventListener('click', onClick, true);
          element.removeEventListener('focusin', onFocusIn);
          window.removeEventListener('pointerup', onPointerUp);
          window.removeEventListener('pointercancel', onPointerUp);
          element.ownerDocument.removeEventListener('selectionchange', onSelectionChange);
          cancelNavigation();
          cancelRequest();
          dropHold();
          clearReader();
        };
      },
      reset() {
        navigationVersion.current += 1;
        cancelRequest();
        if (state.current.sessionId !== latest.current.sessionId) {
          intentVersion.current += 1;
          state.current.sessionId = latest.current.sessionId;
        }
        cancelNavigation();
        dropHold();
        clearReader();
        setSpacer(0);
        state.current.initialized = false;
        state.current.hidden = false;
        state.current.geometry = undefined;
        state.current.naturalContent = undefined;
        state.current.owned = undefined;
        state.current.pointerHeld = false;
        state.current.touchY = undefined;
        following.current = !latest.current.resources && !latest.current.hasMoreLater;
        anchor.current = null;
      },
    };
  }, []);

  useLayoutEffect(() => {
    state.current.active = true;
    controller.reset();
    return () => { controller.reset(); state.current.active = false; };
  }, [options.sessionId, options.resetVersion, options.loaded, options.resources, controller]);

  useLayoutEffect(() => {
    const element = options.scrollRef.current;
    if (!element) return;
    return controller.attach(element, options.contentRef.current);
  }, [options.sessionId, options.resetVersion, options.loaded, options.scrollRef, options.contentRef, controller]);

  useLayoutEffect(() => controller.reconcile());
  return controller;
}
