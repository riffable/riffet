import { useLayoutEffect, useRef, type PointerEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { PanelFrame } from '../state/uiStore';

export const MIN_W = 320, MIN_H = 240;
/** An edge this close to where it would rest snaps there. The inset clears the conversation card's own 8px margin. */
export const SNAP = 16, INSET = 16;

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
type Gesture = { mode: 'move' | Edge; x: number; y: number; frame: PanelFrame; box: Box; next: PanelFrame; moved: boolean };
/**
 * The container (the element the frame is rendered in: the row beside the sidebar, below any tab strip) and where it
 * sits in the frame's positioned ancestor, which is wider: frames are kept in container coordinates and offset when painted.
 */
interface Box { w: number; h: number; dx: number; dy: number }

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
const snapTo = (value: number, target: number) => Math.abs(value - target) <= SNAP ? target : undefined;

/** The frame as it sits in this container: attached edges keep their inset, the rest is clamped inside. */
function resolve(frame: PanelFrame, box: Box): PanelFrame {
  const w = Math.round(clamp(frame.w, MIN_W, box.w - INSET * 2));
  const h = Math.round(clamp(frame.h, MIN_H, box.h - INSET * 2));
  const x = frame.ax === 'left' ? INSET : frame.ax === 'right' ? box.w - INSET - w : clamp(frame.x, 0, box.w - w);
  const y = frame.ay === 'top' ? INSET : frame.ay === 'bottom' ? box.h - INSET - h : clamp(frame.y, 0, box.h - h);
  return { ...frame, x: Math.round(x), y: Math.round(y), w, h };
}

/** Which edges a settled frame rests against, so a resized container keeps it there. */
function attach(frame: PanelFrame, box: Box): PanelFrame {
  const { ax: _ax, ay: _ay, ...bare } = frame;
  const left = frame.x === INSET, right = frame.x + frame.w === box.w - INSET;
  const top = frame.y === INSET, bottom = frame.y + frame.h === box.h - INSET;
  const ax = left ? 'left' : right ? 'right' : undefined;
  const ay = top ? 'top' : bottom ? 'bottom' : undefined;
  return { ...bare, ...(ax ? { ax } : {}), ...(ay ? { ay } : {}) };
}

/** Moves one axis of a span; the near edge snaps first, then the far one. */
function moveAxis(start: number, size: number, delta: number, low: number, high: number) {
  const at = clamp(start + delta, low, high - size);
  const near = snapTo(at, low + INSET), far = snapTo(at + size, high - INSET);
  if (near !== undefined && (far === undefined || Math.abs(at - low - INSET) <= Math.abs(at + size - high + INSET))) return near;
  return far !== undefined ? far - size : at;
}

/** Drags the near and/or far edge of one axis; the other edge stays put. */
function resizeAxis(start: number, size: number, delta: number, low: number, high: number, minSize: number, dragNear: boolean, dragFar: boolean): [number, number] {
  let a = start, b = start + size;
  if (dragNear) a = clamp(start + delta, low, b - minSize);
  if (dragFar) b = clamp(start + size + delta, a + minSize, high);
  if (dragNear) a = Math.min(snapTo(a, low + INSET) ?? a, b - minSize);
  if (dragFar) b = Math.max(snapTo(b, high - INSET) ?? b, a + minSize);
  return [Math.round(a), Math.round(b - a)];
}

const zones: Array<{ edge: Edge; className: string }> = [
  { edge: 'n', className: 'inset-x-0 -top-[3px] h-[6px] cursor-ns-resize' },
  { edge: 's', className: 'inset-x-0 -bottom-[3px] h-[6px] cursor-ns-resize' },
  { edge: 'w', className: 'inset-y-0 -left-[3px] w-[6px] cursor-ew-resize' },
  { edge: 'e', className: 'inset-y-0 -right-[3px] w-[6px] cursor-ew-resize' },
  { edge: 'nw', className: '-left-[4px] -top-[4px] size-3 cursor-nwse-resize' },
  { edge: 'se', className: '-bottom-[4px] -right-[4px] size-3 cursor-nwse-resize' },
  { edge: 'ne', className: '-right-[4px] -top-[4px] size-3 cursor-nesw-resize' },
  { edge: 'sw', className: '-bottom-[4px] -left-[4px] size-3 cursor-nesw-resize' },
];

/**
 * A context panel floating over its container (the element it is rendered in): dragged by its
 * header, resized from any edge, snapping to the container's edges. The frame is written straight
 * to the element's style during a gesture and committed once on release, so the workbench does not
 * render per frame; the transitions here never touch position or size.
 */
export function FloatingPanelFrame({ frame, defaultWidth, shown, inert, onCommit, children }: {
  frame: PanelFrame | undefined;
  /** The width of a first float, before it has been sized. */
  defaultWidth: number;
  /** Faded in; false while closed or just mounted. */
  shown: boolean;
  inert: boolean;
  onCommit: (frame: PanelFrame) => void;
  children: ReactNode;
}) {
  const element = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | undefined>(undefined);
  const latest = useRef({ frame, defaultWidth, onCommit });
  latest.current = { frame, defaultWidth, onCommit };
  const offset = useRef({ dx: 0, dy: 0 });

  const box = (): Box | undefined => {
    const target = element.current;
    const parent = target?.parentElement;
    if (!target || !parent) return undefined;
    const rect = parent.getBoundingClientRect();
    const holder = target.offsetParent as HTMLElement | null;
    const base = holder?.getBoundingClientRect();
    const dx = base ? rect.left - base.left - holder!.clientLeft : 0;
    const dy = base ? rect.top - base.top - holder!.clientTop : 0;
    offset.current = { dx, dy };
    return { w: rect.width, h: rect.height, dx, dy };
  };
  const paint = (resolved: PanelFrame) => {
    const style = element.current?.style;
    if (!style) return;
    style.left = `${resolved.x + offset.current.dx}px`;
    style.top = `${resolved.y + offset.current.dy}px`;
    style.width = `${resolved.w}px`;
    style.height = `${resolved.h}px`;
  };
  const place = () => {
    const size = box();
    if (!size || gesture.current) return;
    const { frame: stored, defaultWidth: width } = latest.current;
    const base: PanelFrame = stored ?? { x: 0, y: INSET, w: width, h: Math.round(size.h * 0.7), ax: 'right', ay: 'top' };
    paint(resolve(base, size));
  };
  useLayoutEffect(place, [frame, defaultWidth]);
  useLayoutEffect(() => {
    const parent = element.current?.parentElement;
    if (!parent) return;
    const observer = new ResizeObserver(place);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  const begin = (event: PointerEvent<HTMLDivElement>, mode: Gesture['mode']) => {
    const size = box();
    const target = element.current;
    if (!size || !target) return;
    const rect = target.getBoundingClientRect();
    const parent = target.parentElement!.getBoundingClientRect();
    const start: PanelFrame = { x: Math.round(rect.left - parent.left), y: Math.round(rect.top - parent.top), w: Math.round(rect.width), h: Math.round(rect.height) };
    event.preventDefault();
    target.setPointerCapture(event.pointerId);
    gesture.current = { mode, x: event.clientX, y: event.clientY, frame: start, box: size, next: start, moved: false };
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    const edge = target.closest<HTMLElement>('[data-edge]')?.dataset.edge as Edge | undefined;
    if (edge) { begin(event, edge); return; }
    if (target.closest('[data-panel-drag]') && !target.closest('button, a, input, select, textarea, [role="tab"], [role="button"], [role="menuitem"]')) begin(event, 'move');
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current) return;
    if (!(event.buttons & 1)) { finish(); return; }
    const { frame: start, box: size, mode } = current;
    const dx = event.clientX - current.x, dy = event.clientY - current.y;
    let next: PanelFrame;
    if (mode === 'move') {
      next = { ...start, x: moveAxis(start.x, start.w, dx, 0, size.w), y: moveAxis(start.y, start.h, dy, 0, size.h) };
    } else {
      const [x, w] = resizeAxis(start.x, start.w, dx, 0, size.w, MIN_W, mode.includes('w'), mode.includes('e'));
      const [y, h] = resizeAxis(start.y, start.h, dy, 0, size.h, MIN_H, mode.includes('n'), mode.includes('s'));
      next = { x, y, w, h };
    }
    next = { ...next, x: Math.round(next.x), y: Math.round(next.y) };
    current.next = next;
    current.moved = true;
    paint(next);
  };
  const finish = () => {
    const current = gesture.current;
    if (!current) return;
    gesture.current = undefined;
    if (!current.moved) return;
    // Spanning both side insets attaches to the left.
    latest.current.onCommit(attach(current.next, current.box));
  };

  return (
    <div
      ref={element}
      className={cn(
        'absolute z-(--z-panel) transition-[opacity,scale] duration-[var(--duration-base)] ease-out-soft',
        shown ? 'opacity-100 scale-100' : 'scale-[0.98] opacity-0',
      )}
      aria-hidden={inert || undefined}
      inert={inert}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
    >
      <div className="relative flex size-full overflow-hidden rounded-xl border border-line bg-bg shadow-pop">{children}</div>
      {zones.map(({ edge, className }) => <div key={edge} data-edge={edge} aria-hidden className={cn('absolute z-10 touch-none', className)} />)}
    </div>
  );
}
