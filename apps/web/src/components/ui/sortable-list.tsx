import { createContext, Fragment, useContext, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { MOTION_DURATION, MOTION_EASING } from '@contracts';
import { IconGripVertical } from '@/components/icons';
import { cancelAnimations, exit } from '@/lib/motion';
import { cn } from '@/lib/utils';

const EASE = `cubic-bezier(${MOTION_EASING.standard.join(', ')})`;

interface Item {
  start: (event: PointerEvent<HTMLButtonElement>) => void;
  step: (delta: -1 | 1) => void;
  handle: (node: HTMLButtonElement | null) => void;
}

const ItemContext = createContext<Item | undefined>(undefined);

/**
 * Rows reordered by dragging their handle (`SortHandle`) or pressing ↑ ↓ on it (components/navigation.md
 * 「可排序列表」). It adds no container: each row is wrapped in one element, so a parent that styles its
 * direct children (a settings group's dividers) still sees one child per row.
 *
 * `onReorder` must show the new order in the same render: the dragged rows sit at their new places
 * by offset until that render, then drop the offsets unseen. An order that does not come back
 * within a frame is taken as refused, and the rows return.
 */
export function SortableList<T extends string>({ ids, onReorder, label, children }: {
  ids: readonly T[];
  onReorder: (ids: T[]) => void;
  /** The row's name, for what a screen reader hears after a move. */
  label: (id: T) => string;
  children: (id: T) => ReactNode;
}) {
  const { t } = useLingui();
  const rows = useRef(new Map<string, HTMLElement>());
  const handles = useRef(new Map<string, HTMLButtonElement>());
  const dragging = useRef(false);
  const settle = useRef<(() => void) | undefined>(undefined);
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

  const commit = (next: T[], moved: T, reset: () => void) => {
    settle.current = reset;
    onReorder(next);
    setAnnouncement(t`${label(moved)}：第 ${next.indexOf(moved) + 1} 项，共 ${next.length} 项`);
    requestAnimationFrame(() => { settle.current?.(); settle.current = undefined; });
  };

  const start = (id: T, event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || dragging.current || settle.current) return;
    const from = ids.indexOf(id);
    const items = ids.map((item) => rows.current.get(item));
    if (from < 0 || items.some((item) => !item)) return;
    const nodes = items as HTMLElement[];
    event.preventDefault();
    const pointer = event.pointerId;
    const handle = event.currentTarget;
    handle.setPointerCapture(pointer);
    dragging.current = true;
    const rects = nodes.map((node) => node.getBoundingClientRect());
    const node = nodes[from]!;
    const own = rects[from]!;
    const originY = event.clientY;
    node.dataset.dragging = '';
    for (const other of nodes) if (other !== node) other.style.transition = `transform ${MOTION_DURATION.fast}ms ${EASE}`;
    const reset = () => {
      for (const item of nodes) {
        cancelAnimations(item);
        item.style.transform = '';
        item.style.transition = '';
        delete item.dataset.dragging;
      }
    };
    let dy = 0;
    let to = from;
    const move = (pointerEvent: globalThis.PointerEvent) => {
      if (pointerEvent.pointerId !== pointer) return;
      dy = Math.min(rects.at(-1)!.bottom - own.bottom, Math.max(rects[0]!.top - own.top, pointerEvent.clientY - originY));
      node.style.transform = `translateY(${dy}px)`;
      const center = (own.top + own.bottom) / 2 + dy;
      to = from;
      for (let index = from + 1; index < rects.length; index += 1) if (center > (rects[index]!.top + rects[index]!.bottom) / 2) to = index;
      for (let index = from - 1; index >= 0; index -= 1) if (center < (rects[index]!.top + rects[index]!.bottom) / 2) to = index;
      nodes.forEach((other, index) => {
        if (other === node) return;
        const shift = from < to && index > from && index <= to ? -own.height : to < from && index >= to && index < from ? own.height : 0;
        other.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };
    const finish = (cancelled: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
      dragging.current = false;
      const final = cancelled ? from : to;
      if (final === from) for (const other of nodes) if (other !== node) other.style.transform = '';
      const target = final === from ? 0 : final > from ? rects[final]!.bottom - own.bottom : rects[final]!.top - own.top;
      exit(node, [{ transform: `translateY(${dy}px)` }, { transform: `translateY(${target}px)` }], { duration: MOTION_DURATION.fast, easing: EASE }, () => {
        if (final === from) { reset(); return; }
        const next = [...ids];
        next.splice(final, 0, next.splice(from, 1)[0]!);
        commit(next, id, reset);
      });
    };
    const up = (pointerEvent: globalThis.PointerEvent) => { if (pointerEvent.pointerId === pointer) finish(false); };
    const cancel = (pointerEvent: globalThis.PointerEvent) => { if (pointerEvent.pointerId === pointer) finish(true); };
    const key = (keyEvent: globalThis.KeyboardEvent) => {
      if (keyEvent.key !== 'Escape') return;
      // The drag takes this Escape; the dialog around the list stays open.
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      finish(true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
  };

  const step = (id: T, delta: -1 | 1) => {
    const from = ids.indexOf(id);
    const to = from + delta;
    if (dragging.current || from < 0 || to < 0 || to >= ids.length) return;
    const next = [...ids];
    [next[from], next[to]] = [next[to]!, next[from]!];
    refocus.current = id;
    commit(next, id, () => {});
  };

  return <>
    {ids.map((id) => (
      <Fragment key={id}>
        <ItemContext.Provider value={{
          start: (event) => start(id, event),
          step: (delta) => step(id, delta),
          handle: (node) => { if (node) handles.current.set(id, node); else handles.current.delete(id); },
        }}>
          <div
            ref={(node) => { if (node) rows.current.set(id, node); else rows.current.delete(id); }}
            className="data-[dragging]:relative data-[dragging]:z-10 data-[dragging]:-mx-2 data-[dragging]:rounded-lg data-[dragging]:bg-elevated data-[dragging]:px-2 data-[dragging]:shadow-pop"
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
