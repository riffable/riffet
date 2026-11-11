import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { cn } from '@/lib/utils';

/** Released this far below the minimum, a handle that can collapse its pane does. */
const COLLAPSE_PX = 64;

interface Props {
  /** `x` sizes a column from its side edge, `y` a row from its top or bottom edge. */
  axis: 'x' | 'y';
  value: number;
  min: number;
  /** A function is read as the drag or key press starts, so the limit can follow the window. */
  max: number | (() => number);
  /** 1 when moving right (or down) grows the pane, -1 when moving left (or up) does. */
  grow: 1 | -1;
  label: string;
  valueText?: string;
  /** Every frame of a drag, for a pane that restyles itself without a render; without it each frame commits. */
  onPreview?: (value: number) => void;
  /** The settled value: a released drag or a key press. */
  onChange: (value: number) => void;
  /** Double click. */
  onReset?: () => void;
  /** A drag released well below the minimum. */
  onCollapse?: () => void;
  className?: string;
}

/**
 * The drag strip on a resizable pane's edge, with the keyboard steps a separator offers. While it
 * drags, the root carries `data-resizing`: the cursor and text selection hold across the window,
 * and layouts that animate their own width changes can tell a drag from a step.
 */
export function ResizeHandle({ axis, value, min, max, grow, label, valueText, onPreview, onChange, onReset, onCollapse, className }: Props) {
  const drag = useRef<{ origin: number; value: number; max: number; next: number; collapse: boolean } | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);
  const element = useRef<HTMLDivElement>(null);
  /** Ends a drag from the window too: a release the handle never hears must not leave it dragging. */
  const unlisten = useRef<(() => void) | undefined>(undefined);
  const callbacks = useRef({ onPreview, onChange, onCollapse });
  callbacks.current = { onPreview, onChange, onCollapse };

  const upper = () => Math.max(min, typeof max === 'function' ? max() : max);
  const clamp = (next: number, limit: number) => Math.min(limit, Math.max(min, Math.round(next)));
  const stop = () => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
    unlisten.current?.();
    unlisten.current = undefined;
    delete document.documentElement.dataset.resizing;
    const handle = element.current;
    if (!handle) return;
    delete handle.dataset.dragging;
    // The pointer usually rests on the handle after the release; the line goes with the drag and
    // waits for the pointer to leave before hovering can show it again.
    handle.dataset.settled = '';
  };
  const finish = () => {
    const current = drag.current;
    if (!current) return;
    drag.current = undefined;
    stop();
    if (current.collapse) callbacks.current.onCollapse?.();
    else callbacks.current.onChange(current.next);
  };
  useEffect(() => () => { if (drag.current) { drag.current = undefined; stop(); } }, []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = { origin: axis === 'x' ? event.clientX : event.clientY, value, max: upper(), next: value, collapse: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.dataset.dragging = '';
    delete event.currentTarget.dataset.settled;
    document.documentElement.dataset.resizing = axis;
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', finish);
    unlisten.current = () => {
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', finish);
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    // The marker is a short stretch of the edge where the pointer is, not the whole edge.
    if (axis === 'x') event.currentTarget.style.setProperty('--resize-at', `${event.clientY - event.currentTarget.getBoundingClientRect().top}px`);
    const current = drag.current;
    if (!current) return;
    // The button is already up: the release went somewhere this handle could not hear it.
    if (!(event.buttons & 1)) { finish(); return; }
    const raw = current.value + grow * ((axis === 'x' ? event.clientX : event.clientY) - current.origin);
    current.collapse = Boolean(callbacks.current.onCollapse) && raw < min - COLLAPSE_PX;
    current.next = clamp(raw, current.max);
    frame.current ??= requestAnimationFrame(() => {
      frame.current = undefined;
      const latest = drag.current;
      if (latest) (callbacks.current.onPreview ?? callbacks.current.onChange)(latest.next);
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The key pointing the way the pane grows widens it; Shift takes a finer step.
    const step = (event.shiftKey ? 8 : 24) * grow;
    const [back, forward] = axis === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    const next = event.key === forward ? value + step
      : event.key === back ? value - step
      : event.key === 'Home' || event.key === 'PageDown' ? min
      : event.key === 'End' || event.key === 'PageUp' ? upper()
      : undefined;
    if (next === undefined) return;
    event.preventDefault();
    onChange(clamp(next, upper()));
  };

  return (
    <div
      ref={element}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={typeof max === 'number' ? max : undefined}
      aria-valuetext={valueText}
      tabIndex={0}
      className={cn('group/resize z-10 touch-none outline-none', axis === 'x' ? 'cursor-col-resize' : 'cursor-row-resize', className)}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onPointerLeave={(event) => { if (!drag.current) delete event.currentTarget.dataset.settled; }}
      onDoubleClick={onReset}
    >
      {axis === 'x' && (
        <span aria-hidden className="pointer-events-none absolute top-[clamp(40px,var(--resize-at,50%),calc(100%-40px))] left-1/2 h-20 w-0.5 -translate-1/2 rounded-full bg-focus opacity-0 transition-opacity duration-[var(--duration-base)] group-[:hover:not([data-settled])]/resize:opacity-100 group-[:hover:not([data-settled])]/resize:delay-150 group-focus-visible/resize:opacity-100 group-data-dragging/resize:opacity-100" />
      )}
    </div>
  );
}
