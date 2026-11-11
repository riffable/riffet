import { useCallback, useRef } from 'react';
import { useLingui } from '@lingui/react/macro';

/**
 * The transcript's content-width handle: a bar in the gutter beside the centered column that can be
 * dragged left and right.
 *
 * A port of DeepSeek Harness' ConversationWidthControls (`ui-conversation`), reduced to the single
 * left side — riffet's right gutter belongs to the message rail. The mechanics are theirs and are
 * worth stating, because each one is the answer to a gesture that otherwise misbehaves:
 *
 * - The column stays centered, so moving the pointer one pixel outward widens the column by two.
 * - Pointer capture keeps the drag alive when the pointer leaves the strip (and over the composer).
 * - Moves are coalesced into one rAF, so a fast drag rewrites one custom property per frame instead
 *   of re-rendering React per pointer event.
 * - A press that never moved commits nothing: a click must not overwrite a saved preference with the
 *   window-clamped width it happened to be displaying.
 */

/** Horizontal room between the strip and the column it resizes. */
export const WIDTH_HANDLE_GAP = 6;
/** The strip's own width; its ::after draws the 2px bar at the right edge. */
export const WIDTH_HANDLE_WIDTH = 10;

/**
 * Room the columns keep for both gutters (`WIDTH_HANDLE_WIDTH + WIDTH_HANDLE_GAP` each, plus slack).
 *
 * This is what makes the handle always reachable: a column allowed to fill the whole window leaves
 * no gutter to grab, so a reader who had widened the column on a large display could not narrow it
 * again on a small one. `styles/index.css` caps the columns at `100% - 56px` above the desktop
 * breakpoint; the drag's own ceiling uses this same budget.
 */
export const COLUMN_GUTTER_TOTAL = 56;

interface Props {
  /** Offset from the frame's left edge, or null when the window leaves no gutter to drag in. */
  left: number | null;
  /** The column's displayed width when the drag starts, in px. */
  onStart: () => number;
  onDrag: (width: number) => void;
  onCommit: (width: number) => void;
  /** The gesture was aborted: drop whatever the drag previewed. */
  onCancel: () => void;
  onReset: () => void;
}

export function ContentWidthHandle({ left, onStart, onDrag, onCommit, onCancel, onReset }: Props) {
  const { t } = useLingui();
  const dragging = useRef(false);
  const origin = useRef(0);
  const latest = useRef(0);
  const base = useRef(0);
  const frame = useRef<number | null>(null);
  // The handlers are stable (pointer capture holds one element for the whole drag), so the live
  // callbacks are read through a ref rather than re-created per render.
  const callbacks = useRef({ onStart, onDrag, onCommit, onCancel });
  callbacks.current = { onStart, onDrag, onCommit, onCancel };

  /** The column is centered, so the left handle widens by twice the leftward distance. */
  const width = () => base.current + (origin.current - latest.current) * 2;
  const cancelFrame = () => {
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
  };

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    origin.current = event.clientX;
    latest.current = event.clientX;
    base.current = callbacks.current.onStart();
    dragging.current = true;
    event.currentTarget.toggleAttribute('data-dragging', true);
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    // The bar follows the pointer, which is what tells the reader the drag is live even while the
    // column width has already hit its floor or its ceiling.
    const box = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty('--width-handle-y', `${event.clientY - box.top}px`);
    latest.current = event.clientX;
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null;
      callbacks.current.onDrag(width());
    });
  }, []);

  const release = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    event.currentTarget.toggleAttribute('data-dragging', false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    cancelFrame();
    latest.current = event.clientX;
    // A press that never moved commits nothing: a click must not overwrite a saved preference with
    // the window-clamped width it happened to be displaying.
    if (latest.current !== origin.current) callbacks.current.onCommit(width());
  }, []);

  const onPointerCancel = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    event.currentTarget.toggleAttribute('data-dragging', false);
    cancelFrame();
    callbacks.current.onCancel();
  }, []);

  // The strip is a `separator`, so the keyboard gets the same axis: left widens (the column is
  // centered), right narrows, and the step grows with Shift.
  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    callbacks.current.onCommit(callbacks.current.onStart() + (event.key === 'ArrowLeft' ? step : -step));
  }, []);

  if (left === null) return null;
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t`内容宽度`}
      title={t`双击恢复默认宽度`}
      data-content-width-handle
      tabIndex={0}
      className="content-width-handle absolute bottom-0 top-0 z-0 hidden cursor-col-resize outline-none can-hover:block md:has-[~[data-chapter-navigation]]:hidden"
      style={{ left, width: WIDTH_HANDLE_WIDTH }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={release}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
    />
  );
}
