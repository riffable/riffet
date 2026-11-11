/**
 * Fullscreen composer geometry: the three questions a browser test would otherwise have to answer.
 *
 * Fullscreen editing is the *same* card, expanded (docs/COMPOSER.md §4.1), so nothing here builds a
 * second editor — it only decides how big the panel may get, how tall the draft inside it may grow
 * before it scrolls, and when a wheel gesture at the draft's edge belongs to the transcript.
 *
 * DeepSeek Harness has no fullscreen composer to copy: §4.0 searched its input package and found
 * only "a line cap plus internal scrolling", so every number below is Riffet's own except the wheel
 * rule, which is borrowed from its `installDraftWheel` (`input/editor/view-binding.ts:65-79`).
 */

/** Panel width cap, in px. The transcript column is `max-w-[920px]` (`NativeSession.tsx:590`), so a
 *  draft wrapped in the panel wraps the way it will in the message it becomes. */
export const FULLSCREEN_MAX_WIDTH = 920;

/** Panel height as a fraction of the viewport (§4.1). A tenth stays visible above and below, which
 *  is what keeps the transcript readable behind the scrim. */
export const FULLSCREEN_HEIGHT_RATIO = 0.8;

/** Panel height cap, in px — §4.1's `min(80vh, 720px)`. Without it a tall display would open a
 *  panel taller than a draft can use, and the ratio alone would keep growing with the monitor. */
export const FULLSCREEN_MAX_HEIGHT = 720;

/** Panel height floor, in px. Below this the header, the attachment rail and the toolbar leave the
 *  draft under three lines, which is the cramped box §1 says fullscreen exists to escape. */
export const FULLSCREEN_MIN_HEIGHT = 360;

/** Viewport gutter kept free around the panel, in px (16 per side). The component's width clamp
 *  (`min(<maxWidth>px, 100vw - 32px)`) and height clamps spell the same number, so a panel can never
 *  reach the edge of the window it is floating in. */
export const FULLSCREEN_GUTTER = 32;

/**
 * Panel chrome the draft has to leave room for, in px — the number `fullscreenTextLimit` subtracts.
 *
 * It is the sum of what sits above and below the textarea inside the panel, measured from the
 * components themselves rather than from a screenshot:
 *
 * - 44 header row (`min-h-11`, the mobile touch target for the close button),
 * - 80 attachment rail (a 64px thumbnail per §5.1, `MessageAttachments.tsx:10`, plus its padding
 *   and the gap to the draft),
 * - 52 toolbar row (`size-11` controls on a phone plus their padding),
 * - 24 the panel's own padding and the gaps between those rows.
 *
 * Too small an allowance is not "more room for the draft": the card would grow past the panel and
 * push the send button out of it. Too large is the 240px box fullscreen exists to replace.
 */
export const FULLSCREEN_CHROME_ALLOWANCE = 200;

/** How close to an edge counts as "there": sub-pixel layout makes an exactly flush bottom
 *  unreachable, so the wheel rule allows the one pixel DeepSeek Harness allows. */
export const WHEEL_EDGE_TOLERANCE = 1;

/**
 * The panel's size tokens for one viewport.
 *
 * Each field is what the panel styles itself with, already clamped so no combination of them can
 * overflow the viewport it was resolved for:
 *
 * - `maxWidth` — the width cap in px, reduced by the viewport gutter and by the 920px column cap.
 * - `heightRatio` — the fraction of the viewport height the panel asks for.
 * - `minHeight` — the height in px the panel ends up with: `heightRatio` applied to this viewport,
 *   floored at 360, capped at 720 and never past the viewport itself. It is both the panel's
 *   `min-height` and the height `fullscreenTextLimit` measures against, which is why it is resolved
 *   here instead of left as a bare floor: the textarea's cap depends on it, and the token triple is
 *   the only thing `fullscreenTextLimit` is given.
 */
export interface FullscreenPanel {
  maxWidth: number;
  heightRatio: number;
  minHeight: number;
}

/** Resolve {@link FullscreenPanel} for a viewport. Pure: same viewport, same tokens. */
export function fullscreenPanel(viewport: { width: number; height: number }): FullscreenPanel {
  // The three clamps read exactly like the panel's CSS (`max(height, min-height)` against the
  // viewport), so the numbers a test pins are the numbers the browser applies.
  const height = Math.min(
    Math.max(viewport.height * FULLSCREEN_HEIGHT_RATIO, FULLSCREEN_MIN_HEIGHT),
    FULLSCREEN_MAX_HEIGHT,
    viewport.height,
  );
  return {
    maxWidth: Math.max(0, Math.min(FULLSCREEN_MAX_WIDTH, viewport.width - FULLSCREEN_GUTTER)),
    heightRatio: FULLSCREEN_HEIGHT_RATIO,
    minHeight: Math.max(0, height),
  };
}

/**
 * The long-draft cap inside the panel: what the textarea may grow to before it scrolls.
 *
 * The card is the same card as ever, so the draft still scrolls in the textarea itself (§4.0's
 * model); fullscreen only moves the cap from `min(45vh, 420px)` to the panel's own height minus the
 * chrome it has to share the panel with.
 */
export function fullscreenTextLimit(panel: FullscreenPanel): number {
  // Never the whole panel and never zero: on a viewport barely taller than the chrome allowance the
  // subtraction goes negative, and a cap of 0 would hide the draft instead of showing a small one.
  return Math.max(1, Math.min(panel.minHeight - FULLSCREEN_CHROME_ALLOWANCE, panel.minHeight - 1));
}

/**
 * Whether the remaining wheel delta belongs to the transcript rather than to the draft.
 *
 * The draft keeps the gesture while it can still move; only the leftover is passed on, so a long
 * draft scrolled to its end does not trap the wheel (§4.0 detail 2). A textarea that cannot scroll
 * at all therefore hands every wheel event over, and a zero delta — which moves nothing anywhere —
 * is never forwarded.
 */
export function shouldForwardWheel(state: { scrollTop: number; clientHeight: number; scrollHeight: number; deltaY: number }): boolean {
  const { scrollTop, clientHeight, scrollHeight, deltaY } = state;
  if (deltaY === 0) return false;
  const atTop = scrollTop <= 0;
  const atEnd = scrollTop + clientHeight >= scrollHeight - WHEEL_EDGE_TOLERANCE;
  return deltaY < 0 ? atTop : atEnd;
}
