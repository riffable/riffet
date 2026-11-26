import { createContext, Fragment, useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { MOTION_DURATION, MOTION_EASING } from '@contracts';
import { IconGripVertical } from '@/components/icons';
import { cancelAnimations, exit } from '@/lib/motion';
import { cn } from '@/lib/utils';

const EASE = `cubic-bezier(${MOTION_EASING.standard.join(', ')})`;
const ROW_DRAG_THRESHOLD = 5;

interface Item {
  start: (event: PointerEvent<HTMLButtonElement>) => void;
  step: (delta: -1 | 1) => void;
  handle: (node: HTMLButtonElement | null) => void;
}

const ItemContext = createContext<Item | undefined>(undefined);

/** True when a pointer-down landed on a nested control that should keep its own click/menu behavior. */
function isIgnoredRowControl(target: EventTarget | null, row: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest('[data-sort-ignore], [aria-haspopup], a, input, select, textarea');
  return Boolean(control && row.contains(control) && control !== row);
}

/**
 * Suppresses the synthetic click fired right after `pointerup` (single macrotask window, so the
 * user's next intentional click is never swallowed).
 */
function suppressImmediateClick(): () => void {
  const stop = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener('click', stop, { capture: true, once: true });
  const timer = window.setTimeout(() => window.removeEventListener('click', stop, true), 0);
  return () => {
    window.clearTimeout(timer);
    window.removeEventListener('click', stop, true);
  };
}

/**
 * When a whole-row drag is cancelled via Escape while the primary button is still held, wait for
 * that pointer's release (or window blur) and suppress only its synthetic click.
 */
function suppressClickAfterEscape(pointerId: number): () => void {
  let cleanupClick: (() => void) | undefined;
  const detach = () => {
    window.removeEventListener('pointerup', onRelease, true);
    window.removeEventListener('pointercancel', onRelease, true);
    window.removeEventListener('blur', onBlur);
  };
  const onRelease = (event: globalThis.PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    detach();
    cleanupClick = suppressImmediateClick();
  };
  const onBlur = () => { detach(); };
  window.addEventListener('pointerup', onRelease, true);
  window.addEventListener('pointercancel', onRelease, true);
  window.addEventListener('blur', onBlur);
  return () => {
    detach();
    cleanupClick?.();
  };
}

/**
 * Rows reordered by dragging their handle (`SortHandle`) or, with `drag="row"`, pressing and
 * dragging the row itself past a small threshold (components/navigation.md 「可排序列表」).
 * It adds no container: each row is wrapped in one element, so a parent that styles its direct
 * children (a settings group's dividers) still sees one child per row.
 *
 * `onReorder` must show the new order in the same render: the dragged rows sit at their new places
 * by offset until that render, then drop the offsets unseen. An order that does not come back
 * within a frame is taken as refused, and the rows return.
 */
export function SortableList<T extends string>({
  ids,
  onReorder,
  label,
  drag = 'handle',
  disabled = false,
  variant = 'outset',
  children,
}: {
  ids: readonly T[];
  onReorder: (ids: T[]) => void;
  /** The row's name, for what a screen reader hears after a move. */
  label: (id: T) => string;
  /** `'handle'` drags only via `SortHandle`; `'row'` lets fine pointers drag the row past a 5px threshold. */
  drag?: 'handle' | 'row';
  disabled?: boolean;
  /** `'outset'` widens the lifted row by 8px on each side (settings groups); `'inset'` stays flush (sidebars). */
  variant?: 'outset' | 'inset';
  children: (id: T) => ReactNode;
}) {
  const { t } = useLingui();
  const rows = useRef(new Map<string, HTMLElement>());
  const handles = useRef(new Map<string, HTMLButtonElement>());
  const dragging = useRef(false);
  const settle = useRef<(() => void) | undefined>(undefined);
  const activeCleanup = useRef<(() => void) | undefined>(undefined);
  const clickCleanup = useRef<(() => void) | undefined>(undefined);
  /** The handle a keyboard move came from, focused again once its row has moved; a pointer drag leaves focus alone. */
  const refocus = useRef<string | undefined>(undefined);
  const [announcement, setAnnouncement] = useState('');
  const order = ids.join('\u0000');

  // The new order has rendered where the offsets had put each row, so the offsets go without a jump.
  useLayoutEffect(() => {
    settle.current?.();
    settle.current = undefined;
    const id = refocus.current;
    refocus.current = undefined;
    if (id) handles.current.get(id)?.focus();
  }, [order]);

  // Cancel any in-flight gesture if the list disables or changes externally while dragging.
  useEffect(() => {
    if (dragging.current || disabled) activeCleanup.current?.();
  }, [disabled, order]);

  // Release window listeners, animations, and body styles if the list unmounts mid-gesture.
  useEffect(() => () => {
    activeCleanup.current?.();
    clickCleanup.current?.();
    settle.current?.();
    settle.current = undefined;
  }, []);

  const commit = (next: T[], moved: T, reset: () => void) => {
    settle.current = reset;
    onReorder(next);
    setAnnouncement(t`${label(moved)}：第 ${next.indexOf(moved) + 1} 项，共 ${next.length} 项`);
    requestAnimationFrame(() => {
      if (settle.current === reset) {
        settle.current = undefined;
        reset();
      }
    });
  };

  const beginDrag = (id: T, pointer: number, captureEl: HTMLElement, originY: number, currentY: number, suppressClick: boolean) => {
    const from = ids.indexOf(id);
    const items = ids.map((item) => rows.current.get(item));
    if (from < 0 || items.some((item) => !item)) return;
    const nodes = items as HTMLElement[];
    try { captureEl.setPointerCapture(pointer); } catch { /* pointer may already be synthetic in tests */ }
    dragging.current = true;
    const rects = nodes.map((node) => node.getBoundingClientRect());
    const node = nodes[from]!;
    const own = rects[from]!;
    // Shift siblings by the dragged row's own span (height + gap), which stays exact for variable row heights and gaps.
    const shiftUp = from + 1 < rects.length ? -(rects[from + 1]!.top - own.top) : -own.height;
    const shiftDown = from > 0 ? own.bottom - rects[from - 1]!.bottom : own.height;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    window.getSelection()?.removeAllRanges();
    node.dataset.dragging = '';
    for (const other of nodes) {
      if (other !== node) {
        other.style.transition = `transform ${MOTION_DURATION.fast}ms ${EASE}`;
        other.style.pointerEvents = 'none';
      }
    }
    const reset = () => {
      document.body.style.userSelect = prevUserSelect;
      for (const item of nodes) {
        cancelAnimations(item);
        item.style.transform = '';
        item.style.transition = '';
        item.style.pointerEvents = '';
        delete item.dataset.dragging;
      }
    };
    let dy = 0;
    let to = from;
    let finished = false;
    let stopExit: (() => void) | undefined;

    const detachListeners = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', key, true);
      captureEl.removeEventListener('lostpointercapture', onLostCapture);
      if (captureEl.hasPointerCapture?.(pointer)) captureEl.releasePointerCapture(pointer);
    };

    const abortNow = () => {
      if (activeCleanup.current === abortNow) activeCleanup.current = undefined;
      finished = true;
      detachListeners();
      stopExit?.();
      stopExit = undefined;
      dragging.current = false;
      reset();
    };
    activeCleanup.current = abortNow;

    const apply = (clientY: number) => {
      dy = Math.min(rects.at(-1)!.bottom - own.bottom, Math.max(rects[0]!.top - own.top, clientY - originY));
      node.style.transform = `translateY(${dy}px)`;
      const center = (own.top + own.bottom) / 2 + dy;
      to = from;
      for (let index = from + 1; index < rects.length; index += 1) if (center > (rects[index]!.top + rects[index]!.bottom) / 2) to = index;
      for (let index = from - 1; index >= 0; index -= 1) if (center < (rects[index]!.top + rects[index]!.bottom) / 2) to = index;
      nodes.forEach((other, index) => {
        if (other === node) return;
        const shift = from < to && index > from && index <= to ? shiftUp : to < from && index >= to && index < from ? shiftDown : 0;
        other.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };
    apply(currentY);

    const finish = (cancelled: boolean, viaEscape = false) => {
      if (finished) return;
      finished = true;
      detachListeners();
      dragging.current = false;
      if (suppressClick) {
        clickCleanup.current?.();
        clickCleanup.current = viaEscape ? suppressClickAfterEscape(pointer) : suppressImmediateClick();
      }
      const final = cancelled ? from : to;
      if (final === from) for (const other of nodes) if (other !== node) other.style.transform = '';
      const target = final === from ? 0 : final > from ? rects[final]!.bottom - own.bottom : rects[final]!.top - own.top;
      stopExit = exit(node, [{ transform: `translateY(${dy}px)` }, { transform: `translateY(${target}px)` }], { duration: MOTION_DURATION.fast, easing: EASE }, () => {
        stopExit = undefined;
        if (activeCleanup.current === abortNow) activeCleanup.current = undefined;
        if (final === from) { reset(); return; }
        const next = [...ids];
        next.splice(final, 0, next.splice(from, 1)[0]!);
        commit(next, id, reset);
      });
    };
    const move = (pointerEvent: globalThis.PointerEvent) => {
      if (pointerEvent.pointerId !== pointer) return;
      if (pointerEvent.pointerType !== 'touch' && (pointerEvent.buttons & 1) === 0) { finish(true); return; }
      apply(pointerEvent.clientY);
    };
    const up = (pointerEvent: globalThis.PointerEvent) => { if (pointerEvent.pointerId === pointer) finish(false); };
    const cancel = (pointerEvent: globalThis.PointerEvent) => { if (pointerEvent.pointerId === pointer) finish(true); };
    const onBlur = () => finish(true);
    const onLostCapture = () => { if (!finished) finish(true); };
    const key = (keyEvent: globalThis.KeyboardEvent) => {
      if (keyEvent.key !== 'Escape') return;
      // The drag takes this Escape; the dialog around the list stays open.
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      finish(true, true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', onBlur);
    window.addEventListener('keydown', key, true);
    captureEl.addEventListener('lostpointercapture', onLostCapture);
  };

  const startHandle = (id: T, event: PointerEvent<HTMLButtonElement>) => {
    if (disabled || event.button !== 0 || dragging.current || settle.current) return;
    event.preventDefault();
    activeCleanup.current?.();
    beginDrag(id, event.pointerId, event.currentTarget, event.clientY, event.clientY, false);
  };

  const startRow = (id: T, event: PointerEvent<HTMLDivElement>) => {
    if (disabled || drag !== 'row' || ids.length < 2 || event.button !== 0 || dragging.current || settle.current) return;
    if (event.pointerType === 'touch') return;
    const row = event.currentTarget;
    if (isIgnoredRowControl(event.target, row)) return;
    activeCleanup.current?.();
    const pointer = event.pointerId;
    const originX = event.clientX;
    const originY = event.clientY;
    const detach = () => {
      if (activeCleanup.current === detach) activeCleanup.current = undefined;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      window.removeEventListener('blur', detach);
    };
    const onMove = (pointerEvent: globalThis.PointerEvent) => {
      if (pointerEvent.pointerId !== pointer) return;
      if ((pointerEvent.buttons & 1) === 0) { detach(); return; }
      if (Math.hypot(pointerEvent.clientX - originX, pointerEvent.clientY - originY) < ROW_DRAG_THRESHOLD) return;
      detach();
      beginDrag(id, pointer, row, originY, pointerEvent.clientY, true);
    };
    const onEnd = (pointerEvent: globalThis.PointerEvent) => {
      if (pointerEvent.pointerId === pointer) detach();
    };
    activeCleanup.current = detach;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    window.addEventListener('blur', detach);
  };

  const step = (id: T, delta: -1 | 1) => {
    if (disabled) return;
    const from = ids.indexOf(id);
    const to = from + delta;
    if (dragging.current || from < 0 || to < 0 || to >= ids.length) return;
    const next = [...ids];
    [next[from], next[to]] = [next[to]!, next[from]!];
    refocus.current = id;
    commit(next, id, () => {});
  };

  const draggingClass = variant === 'outset'
    ? 'data-[dragging]:relative data-[dragging]:z-10 data-[dragging]:-mx-2 data-[dragging]:rounded-lg data-[dragging]:bg-elevated data-[dragging]:px-2 data-[dragging]:shadow-pop'
    : 'data-[dragging]:relative data-[dragging]:z-10 data-[dragging]:cursor-grabbing data-[dragging]:rounded-lg data-[dragging]:bg-elevated data-[dragging]:shadow-pop data-[dragging]:[&_*]:cursor-grabbing';

  return <>
    {ids.map((id) => (
      <Fragment key={id}>
        <ItemContext.Provider value={{
          start: (event) => startHandle(id, event),
          step: (delta) => step(id, delta),
          handle: (node) => { if (node) handles.current.set(id, node); else handles.current.delete(id); },
        }}>
          <div
            ref={(node) => { if (node) rows.current.set(id, node); else rows.current.delete(id); }}
            onPointerDown={drag === 'row' ? (event) => startRow(id, event) : undefined}
            className={draggingClass}
          >
            {children(id)}
          </div>
        </ItemContext.Provider>
      </Fragment>
    ))}
    <span role="status" className="sr-only">{announcement}</span>
  </>;
}

/** The grip a `SortableList` row is dragged by; ↑ ↓ move the row while it has focus. */
export function SortHandle({ label, className }: { label: string; className?: string }) {
  const item = useContext(ItemContext);
  if (!item) return null;
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    item.step(event.key === 'ArrowUp' ? -1 : 1);
  };
  return (
    <button
      ref={item.handle}
      type="button"
      aria-label={label}
      onPointerDown={item.start}
      onKeyDown={onKeyDown}
      className={cn('grid size-6 shrink-0 cursor-grab touch-none place-items-center rounded-md text-fg-4 outline-none transition-colors hover:bg-hover hover:text-fg-2 focus-visible:ring-2 focus-visible:ring-focus active:cursor-grabbing no-hover:size-11', className)}
    >
      <IconGripVertical className="size-4" />
    </button>
  );
}
