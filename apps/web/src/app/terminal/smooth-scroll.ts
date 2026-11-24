import type { IDisposable, Terminal } from '@xterm/xterm';

/** A finger must travel this far, mostly vertically, before it scrolls rather than taps. */
const SWIPE_SLOP_PX = 8;
/** Momentum keeps this share of its speed per millisecond: a fling coasts for roughly half a second. */
const FLING_FRICTION_PER_MS = 0.996;
/** Below this speed (px/ms) a fling stops, and a release this slow does not start one. */
const FLING_MIN_SPEED = 0.03;
/** Release speed is measured over the last part of the swipe. */
const FLING_SAMPLE_MS = 80;
/** Alt+wheel scrolls this many times faster, as xterm's own `fastScrollSensitivity` does. */
const FAST_SCROLL = 5;

/**
 * Pixel-precise scrolling through the emulator's scrollback.
 *
 * xterm 6 positions its viewport in whole rows (`Viewport._handleScroll` rounds the scroll offset
 * to a row), so a trackpad or a finger moves the text in row-sized jumps that lag behind the hand.
 * Here the position is kept in pixels: xterm scrolls to the whole row, and the screen is shifted
 * relative to the row xterm has actually painted so a deferred `RenderDebouncer` frame never
 * flashes a full row backwards when crossing a row boundary. The row below the viewport is not
 * drawn, so a strip under one row high stays blank at the bottom edge while resting between rows.
 *
 * The wheel and swipes stay xterm's whenever they belong to the program: a program that reads the
 * mouse gets them as mouse events, and the alternate screen gets them as arrow keys.
 */
export function attachSmoothScroll(term: Terminal, host: HTMLElement, getSensitivity?: () => number): IDisposable {
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
  if (!screen) return { dispose() {} };
  /** Pixels past the top of logical row `row`, in [0, row height). */
  let offset = 0;
  let row = term.buffer.active.viewportY;
  /** Top buffer row currently painted on the terminal canvas/DOM. */
  let renderedRow = row;
  let scrolling = false;
  const ownsScroll = () => term.buffer.active.type === 'normal' && term.modes.mouseTrackingMode === 'none';
  const cellHeight = () => {
    const core = term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } } } };
    const measured = core._core?._renderService?.dimensions?.css?.cell?.height;
    return measured && measured > 0 ? measured : screen.offsetHeight / term.rows;
  };
  const paint = () => {
    const cell = cellHeight();
    if (!cell) return;
    const rowDelta = row - renderedRow;
    // Wait for `onRender` on viewport-sized jumps instead of pushing the stale canvas off-screen.
    if (Math.abs(rowDelta) >= term.rows) return;
    const ratio = window.devicePixelRatio || 1;
    // Whole device pixels keep text crisp once the scroll settles between rows.
    const shift = Math.round((rowDelta * cell + offset) * ratio) / ratio;
    screen.style.transform = shift ? `translateY(${-shift}px)` : '';
  };

  let fling: number | undefined;
  const stopFling = () => {
    if (fling !== undefined) { cancelAnimationFrame(fling); fling = undefined; }
  };

  /** Moves by `dy` pixels (positive toward newer output); false at either end. */
  const scrollBy = (dy: number) => {
    const cell = cellHeight();
    if (!cell) return false;
    const buffer = term.buffer.active;
    const current = buffer.viewportY * cell + offset;
    const next = Math.min(Math.max(current + dy, 0), buffer.baseY * cell);
    if (next === current) return false;
    const target = Math.floor(next / cell);
    offset = next - target * cell;
    if (target !== buffer.viewportY) {
      scrolling = true;
      try { term.scrollToLine(target); }
      finally { scrolling = false; }
    }
    row = buffer.viewportY;
    if (row !== target) offset = row >= buffer.baseY ? 0 : Math.min(Math.max(next - row * cell, 0), cell);
    paint();
    return next > 0 && next < buffer.baseY * cell;
  };
  // Anything else that moves the viewport (new output while following, typing, the scrollbar,
  // back to live, a resize) lands on a whole row.
  const snap = () => {
    row = term.buffer.active.viewportY;
    renderedRow = row;
    offset = 0;
    paint();
  };
  const subscriptions = [
    term.onScroll(() => {
      if (scrolling) return;
      const buffer = term.buffer.active;
      if (!ownsScroll() || buffer.viewportY >= buffer.baseY) snap();
      // A full scrollback drops its oldest line as output arrives and moves the viewport up one row to
      // keep the text still; shift `renderedRow` by the same delta so the visual position stays put.
      else {
        renderedRow += buffer.viewportY - row;
        row = buffer.viewportY;
      }
    }),
    term.onRender((event) => {
      if (event.start !== 0 || event.end < term.rows - 1) return;
      const nextRendered = term.buffer.active.viewportY;
      if (nextRendered === renderedRow) return;
      renderedRow = nextRendered;
      paint();
    }),
    term.onResize(snap),
    term.buffer.onBufferChange(snap),
  ];

  const startFling = (speed: number) => {
    let last = performance.now();
    const step = (now: number) => {
      const elapsed = Math.min(now - last, 50);
      last = now;
      speed *= FLING_FRICTION_PER_MS ** elapsed;
      if (Math.abs(speed) >= FLING_MIN_SPEED && scrollBy(speed * elapsed)) {
        fling = requestAnimationFrame(step);
      } else {
        fling = undefined;
      }
    };
    fling = requestAnimationFrame(step);
  };

  // Capture on the host, ahead of xterm's viewport listener, which would snap back to a whole row.
  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey || !ownsScroll() || event.deltaY === 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const cell = cellHeight();
    const lines = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? cell : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? cell * term.rows : 1;
    const sensitivity = getSensitivity?.() ?? 1;
    stopFling();
    scrollBy(event.deltaY * lines * sensitivity * (event.altKey ? FAST_SCROLL : 1));
    event.preventDefault();
    event.stopPropagation();
  };

  let swipe: { x: number; y: number; mode: 'pending' | 'vertical' | 'ignore'; samples: { y: number; t: number }[] } | undefined;
  const onTouchStart = (event: TouchEvent) => {
    stopFling();
    const touch = event.touches[0];
    swipe = event.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY, mode: 'pending', samples: [] } : undefined;
  };
  const onTouchMove = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (!swipe || swipe.mode === 'ignore' || !touch) return;
    const dy = touch.clientY - swipe.y;
    if (swipe.mode === 'pending') {
      if (Math.abs(dy) < SWIPE_SLOP_PX && Math.abs(touch.clientX - swipe.x) < SWIPE_SLOP_PX) return;
      if (Math.abs(touch.clientX - swipe.x) > Math.abs(dy)) { swipe.mode = 'ignore'; return; }
      swipe.mode = 'vertical';
    }
    if (ownsScroll()) {
      // A finger moving down brings older lines into view, as the wheel does scrolling up.
      scrollBy(-dy);
      swipe.y = touch.clientY;
      const now = performance.now();
      swipe.samples.push({ y: touch.clientY, t: now });
      while (swipe.samples.length > 2 && now - swipe.samples[0]!.t > FLING_SAMPLE_MS) swipe.samples.shift();
      return;
    }
    // The program reads the mouse or sits on the alternate screen: one wheel step per row of travel,
    // which xterm encodes the way the program asked for.
    const cell = cellHeight();
    const steps = cell ? Math.trunc(dy / cell) : 0;
    if (!steps) return;
    swipe.y += steps * cell;
    for (let index = 0; index < Math.abs(steps); index += 1) {
      term.element?.dispatchEvent(new WheelEvent('wheel', { deltaY: steps > 0 ? -1 : 1, deltaMode: WheelEvent.DOM_DELTA_LINE, clientX: touch.clientX, clientY: touch.clientY, bubbles: true, cancelable: true }));
    }
  };
  const onTouchEnd = () => {
    const samples = swipe?.mode === 'vertical' ? swipe.samples : [];
    swipe = undefined;
    const first = samples[0];
    const last = samples[samples.length - 1];
    if (!first || !last || last.t - first.t <= 0 || performance.now() - last.t > FLING_SAMPLE_MS || !ownsScroll()) return;
    const speed = (first.y - last.y) / (last.t - first.t);
    if (Math.abs(speed) >= FLING_MIN_SPEED) startFling(speed);
  };

  host.addEventListener('wheel', onWheel, { capture: true, passive: false });
  host.addEventListener('touchstart', onTouchStart, { passive: true });
  host.addEventListener('touchmove', onTouchMove, { passive: true });
  host.addEventListener('touchend', onTouchEnd, { passive: true });
  host.addEventListener('touchcancel', onTouchEnd, { passive: true });
  return {
    dispose() {
      stopFling();
      subscriptions.forEach((subscription) => subscription.dispose());
      host.removeEventListener('wheel', onWheel, true);
      host.removeEventListener('touchstart', onTouchStart);
      host.removeEventListener('touchmove', onTouchMove);
      host.removeEventListener('touchend', onTouchEnd);
      host.removeEventListener('touchcancel', onTouchEnd);
      screen.style.transform = '';
    },
  };
}
