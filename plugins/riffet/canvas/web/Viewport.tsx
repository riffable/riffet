import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Button, Tip, useMessages } from '@riffet/plugin-web';
import { cn } from './cn';
import { IconMaximize, IconMinus, IconPlus } from './icons';
import { catalogs } from './messages';

/*
 * The plane both canvases draw on: drag or two-finger swipe to pan, ⌘/Ctrl-wheel or pinch to zoom.
 * World coordinates are the layout's; the camera maps them to the screen as `screen = world * k + (x, y)`.
 *
 * The camera moves outside React: each move writes the world layer's transform and the dot grid's
 * offset straight to the DOM, both on their own compositor layers, so a pan repaints nothing and
 * re-renders nothing. Components read the camera through `useCameraSelect`, choosing what they
 * depend on — a zoom band, a culling window — and re-render only when that changes.
 */

export type Camera = { x: number; y: number; k: number };
export type Bounds = { x: number; y: number; w: number; h: number };

const MIN_K = 0.05, MAX_K = 2;
const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k));
const ease = (t: number) => 1 - (1 - t) ** 3;

export function useCamera(initial: Camera) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const current = useRef(initial);
  const listeners = useRef(new Set<() => void>());
  const world = useRef<HTMLDivElement | null>(null);
  const dots = useRef<HTMLDivElement | null>(null);
  const settle = useRef(0);
  const apply = useCallback(() => {
    const { x, y, k } = current.current;
    if (world.current) world.current.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${k})`;
    if (dots.current) {
      const tile = dotTile(k);
      dots.current.style.backgroundSize = `${tile}px ${tile}px`;
      dots.current.style.transform = `translate3d(${(x % tile + tile) % tile - tile}px, ${(y % tile + tile) % tile - tile}px, 0)`;
    }
  }, []);
  const worldRef = useCallback((element: HTMLDivElement | null) => { world.current = element; apply(); }, [apply]);
  const dotsRef = useCallback((element: HTMLDivElement | null) => { dots.current = element; apply(); }, [apply]);
  const subscribe = useCallback((listener: () => void) => { listeners.current.add(listener); return () => { listeners.current.delete(listener); }; }, []);
  const frame = useRef(0);
  /** Set when the reader moves the camera, so automatic following stops until they ask for it again. */
  const moved = useRef(false);
  const onMove = useRef<(() => void) | undefined>(undefined);
  /** Where the pointer last was over the plane, in screen pixels from its corner. */
  const pointer = useRef<{ x: number; y: number } | undefined>(undefined);

  const setCamera = useCallback((next: Camera | ((previous: Camera) => Camera)) => {
    const previous = current.current;
    const value = typeof next === 'function' ? next(previous) : next;
    if (value.x === previous.x && value.y === previous.y && value.k === previous.k) return;
    current.current = value;
    apply();
    if (value.k !== previous.k && world.current) {
      // A promoted layer keeps the raster of the scale it was promoted at; once a zoom comes to
      // rest, drop and retake the promotion so text is drawn sharp at the new scale.
      window.clearTimeout(settle.current);
      settle.current = window.setTimeout(() => {
        const element = world.current;
        if (!element) return;
        element.style.willChange = 'auto';
        requestAnimationFrame(() => { element.style.willChange = 'transform'; });
      }, 160);
    }
    for (const listener of listeners.current) listener();
  }, [apply]);
  const stop = useCallback(() => { cancelAnimationFrame(frame.current); frame.current = 0; }, []);
  const flight = useRef<{ from: Camera; target: Camera } | undefined>(undefined);
  const animateTo = useCallback((target: Camera, ms = 420) => {
    stop();
    cancelAnimationFrame(zoomFrame.current); zoomFrame.current = 0; zoomTarget.current = undefined;
    const began = performance.now();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setCamera(target); return; }
    flight.current = { from: current.current, target };
    const step = (now: number) => {
      const { from, target } = flight.current!;
      const t = Math.min(1, (now - began) / ms), e = ease(t);
      setCamera({ x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, k: from.k + (target.k - from.k) * e });
      frame.current = t < 1 ? requestAnimationFrame(step) : 0;
    };
    frame.current = requestAnimationFrame(step);
  }, [setCamera, stop]);
  const userMoved = useCallback(() => { stop(); moved.current = true; onMove.current?.(); }, [stop]);
  /**
   * The world moved under the camera by ([dx], [dy]) world units (cards re-formed): follow it, and
   * carry along whatever motion is under way — a wheel zoom's target, a flight, a drag — so the next
   * frame does not pull the camera back to where things used to be.
   */
  const slide = useCallback((dx: number, dy: number) => {
    const by = (camera: Camera): Camera => ({ k: camera.k, x: camera.x - dx * camera.k, y: camera.y - dy * camera.k });
    if (zoomTarget.current) zoomTarget.current = by(zoomTarget.current);
    if (frame.current && flight.current) flight.current = { from: by(flight.current.from), target: by(flight.current.target) };
    if (drag.current) drag.current.camera = by(drag.current.camera);
    setCamera(by(current.current));
  }, [setCamera]);
  /** The camera as of this instant, between renders. */
  const read = useCallback(() => current.current, []);

  /**
   * Wheel zoom eases toward where the wheel asked for, so a mouse wheel's coarse notches and a
   * trackpad's stream of small steps both read as one continuous motion. The target accumulates
   * while the camera follows it.
   */
  const zoomTarget = useRef<Camera | undefined>(undefined);
  const zoomFrame = useRef(0);
  const easeZoom = useCallback((factor: number, cx: number, cy: number) => {
    const base = zoomTarget.current ?? current.current;
    const k = clampK(base.k * factor);
    zoomTarget.current = { k, x: cx - (cx - base.x) * (k / base.k), y: cy - (cy - base.y) * (k / base.k) };
    if (zoomFrame.current) return;
    let last = performance.now();
    const step = (now: number) => {
      const target = zoomTarget.current;
      if (!target) { zoomFrame.current = 0; return; }
      // Frame-rate independent smoothing: about 90% of the way in 120ms.
      const blend = 1 - Math.exp(-(now - last) / 52);
      last = now;
      const from = current.current;
      const next = { k: from.k + (target.k - from.k) * blend, x: from.x + (target.x - from.x) * blend, y: from.y + (target.y - from.y) * blend };
      if (Math.abs(next.k - target.k) < 0.0005 && Math.abs(next.x - target.x) < 0.3 && Math.abs(next.y - target.y) < 0.3) {
        setCamera(target);
        zoomTarget.current = undefined;
        zoomFrame.current = 0;
        return;
      }
      setCamera(next);
      zoomFrame.current = requestAnimationFrame(step);
    };
    zoomFrame.current = requestAnimationFrame(step);
  }, [setCamera]);
  const stopZoom = useCallback(() => { cancelAnimationFrame(zoomFrame.current); zoomFrame.current = 0; zoomTarget.current = undefined; }, []);
  /** The camera that shows [box] whole, at most at [maxK]. */
  const framing = useCallback((box: Bounds, maxK = 1, pad = 64): Camera => {
    const k = clampK(Math.min(maxK, (size.w - pad * 2) / Math.max(box.w, 1), (size.h - pad * 2) / Math.max(box.h, 1)));
    return { k, x: size.w / 2 - (box.x + box.w / 2) * k, y: size.h / 2 - (box.y + box.h / 2) * k };
  }, [size]);
  /** The camera that puts world point ([wx], [wy]) at the screen fraction ([fx], [fy]). */
  const centering = useCallback((wx: number, wy: number, k: number, fx = 0.5, fy = 0.5): Camera => ({ k, x: size.w * fx - wx * k, y: size.h * fy - wy * k }), [size]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => entry && setSize({ w: entry.contentRect.width, h: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      // A scrolling panel over the plane keeps its own wheel.
      if ((event.target as Element).closest('[data-canvas-scroll]')) return;
      event.preventDefault();
      userMoved();
      const rect = element.getBoundingClientRect();
      pointer.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      if (event.ctrlKey || event.metaKey) {
        if (gesture !== undefined) return;
        // Lines and pages are a mouse wheel's notches; pixels a trackpad's pinch. Either way one event moves at most ×1.25.
        const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 400 : event.deltaY;
        const factor = Math.min(1.25, Math.max(0.8, Math.exp(-delta * 0.0045)));
        easeZoom(factor, event.clientX - rect.left, event.clientY - rect.top);
      } else {
        stopZoom();
        setCamera((previous) => ({ ...previous, x: previous.x - event.deltaX, y: previous.y - event.deltaY }));
      }
    };
    // Safari reports a trackpad pinch as its own gesture, scaled from where it began, not as ⌘-wheel.
    let gesture: number | undefined;
    const pinch = (raw: Event) => {
      const event = raw as Event & { scale: number; clientX: number; clientY: number };
      event.preventDefault();
      if (event.type === 'gestureend') { gesture = undefined; return; }
      if (event.type === 'gesturestart') { gesture = 1; userMoved(); return; }
      const rect = element.getBoundingClientRect();
      easeZoom(event.scale / (gesture ?? 1), event.clientX - rect.left, event.clientY - rect.top);
      gesture = event.scale;
    };
    const gestures = ['gesturestart', 'gesturechange', 'gestureend'];
    element.addEventListener('wheel', wheel, { passive: false });
    for (const type of gestures) element.addEventListener(type, pinch);
    return () => {
      element.removeEventListener('wheel', wheel);
      for (const type of gestures) element.removeEventListener(type, pinch);
    };
  }, [easeZoom, stopZoom, setCamera, userMoved]);
  useEffect(() => () => { stop(); stopZoom(); window.clearTimeout(settle.current); }, [stop, stopZoom]);

  // Dragging anywhere pans; a press that moved does not also count as a click on what is under it.
  const drag = useRef<{ id: number; x: number; y: number; camera: Camera; moved: boolean } | undefined>(undefined);
  const suppressClick = useRef(false);
  const bind = useMemo(() => ({
    onPointerDown: (event: ReactPointerEvent) => {
      if (event.button !== 0 || (event.target as Element).closest('button, input, [data-canvas-scroll]')) return;
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, camera: current.current, moved: false };
    },
    onPointerMove: (event: ReactPointerEvent) => {
      const rect = ref.current?.getBoundingClientRect();
      if (rect) pointer.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const state = drag.current;
      if (!state || state.id !== event.pointerId) return;
      const dx = event.clientX - state.x, dy = event.clientY - state.y;
      if (!state.moved && Math.hypot(dx, dy) < 4) return;
      if (!state.moved) { state.moved = true; userMoved(); stopZoom(); ref.current?.setPointerCapture(event.pointerId); }
      setCamera({ ...state.camera, x: state.camera.x + dx, y: state.camera.y + dy });
    },
    onPointerLeave: () => { pointer.current = undefined; },
    onPointerUp: (event: ReactPointerEvent) => {
      if (drag.current?.moved) suppressClick.current = true;
      drag.current = undefined;
      if (ref.current?.hasPointerCapture(event.pointerId)) ref.current.releasePointerCapture(event.pointerId);
    },
    onClickCapture: (event: React.MouseEvent) => { if (suppressClick.current) { suppressClick.current = false; event.stopPropagation(); } },
  }), [setCamera, stopZoom, userMoved]);
  // One object for as long as the plane keeps its size, so what depends on the camera does not re-run each render.
  return useMemo(
    () => ({ ref, worldRef, dotsRef, subscribe, size, setCamera, slide, animateTo, framing, centering, bind, moved, onMove, userMoved, pointer, read }),
    [subscribe, size, setCamera, slide, animateTo, framing, centering, bind, userMoved, read],
  );
}

export type CameraApi = ReturnType<typeof useCamera>;

/** How many planes are showing, so the page stops turning on a sideways swipe only while one is. */
let surfaces = 0;

/** Whether something under [target] can still scroll sideways by [dx]: its swipe is a scroll, not a page turn. */
function scrollsSideways(target: EventTarget | null, dx: number): boolean {
  for (let element = target instanceof Element ? target : null; element && element !== document.documentElement; element = element.parentElement) {
    if (element.scrollWidth <= element.clientWidth) continue;
    const overflow = getComputedStyle(element).overflowX;
    if (overflow !== 'auto' && overflow !== 'scroll') continue;
    if (dx < 0 ? element.scrollLeft > 0 : element.scrollLeft + element.clientWidth < element.scrollWidth - 1) return true;
  }
  return false;
}

/**
 * A sideways swipe the plane did not take: over the inspector, the view dots, the header. Chrome and
 * Firefox stop turning the page on the root's `overscroll-behavior-x`; Safari ignores it and only
 * keeps a swipe whose wheel events are cancelled, so one that nothing scrolls by is cancelled here.
 * On the window rather than the plane, so every wheel event of the page waits for this answer.
 */
function holdSidewaysSwipe(event: WheelEvent) {
  if (event.defaultPrevented || event.ctrlKey || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
  if (!scrollsSideways(event.target, event.deltaX)) event.preventDefault();
}

/** The plane: a dotted ground that moves with the camera, the world layer, and screen-space overlays. */
export function Surface({ api, world, overlay, className }: { api: CameraApi; world: ReactNode; overlay?: ReactNode; className?: string }) {
  // A sideways swipe the plane does not take — over a panel or a control above it — would otherwise go back a page.
  useEffect(() => {
    const root = document.documentElement;
    if (surfaces++ === 0) {
      root.style.overscrollBehaviorX = 'none';
      document.body.style.overscrollBehaviorX = 'none';
      window.addEventListener('wheel', holdSidewaysSwipe, { passive: false });
    }
    return () => {
      if (--surfaces > 0) return;
      root.style.overscrollBehaviorX = '';
      document.body.style.overscrollBehaviorX = '';
      window.removeEventListener('wheel', holdSidewaysSwipe);
    };
  }, []);
  return (
    <div
      ref={api.ref}
      className={cn('relative min-h-0 flex-1 cursor-grab touch-none select-none overflow-clip bg-subtle active:cursor-grabbing', className)}
      onPointerDown={api.bind.onPointerDown}
      onPointerMove={api.bind.onPointerMove}
      onPointerUp={api.bind.onPointerUp}
      onPointerCancel={api.bind.onPointerUp}
      onPointerLeave={api.bind.onPointerLeave}
      onClickCapture={api.bind.onClickCapture}
    >
      {/* One tile wider than the plane each way, so shifting it by under a tile never shows an edge. */}
      <div ref={api.dotsRef} aria-hidden className="pointer-events-none absolute -bottom-12 -right-12 left-0 top-0 will-change-transform" style={{ backgroundImage: 'radial-gradient(color-mix(in oklab, var(--fg) 9%, transparent) 1px, transparent 1.2px)' }} />
      <div ref={api.worldRef} className="absolute left-0 top-0 origin-top-left will-change-transform">{world}</div>
      {overlay}
    </div>
  );
}

export function ZoomControls({ api, onFit, children, className }: { api: CameraApi; onFit: () => void; children?: ReactNode; className?: string }) {
  const m = useMessages(catalogs);
  const { size } = api;
  const percent = useCameraSelect(api, (camera) => Math.round(camera.k * 100));
  const zoom = (factor: number) => {
    const camera = api.read(); api.userMoved(); api.animateTo({ k: clampK(camera.k * factor), x: size.w / 2 - (size.w / 2 - camera.x) * (clampK(camera.k * factor) / camera.k), y: size.h / 2 - (size.h / 2 - camera.y) * (clampK(camera.k * factor) / camera.k) }, 200); };
  return (
    <div className={cn('absolute bottom-4 right-4 flex items-center gap-0.5 rounded-lg border border-line bg-elevated p-0.5 shadow-soft transition-[right] duration-200', className)}>
      {children}
      <Button size="icon-sm" variant="quiet" aria-label={m.zoomOut} onClick={() => zoom(1 / 1.25)}><IconMinus className="size-3.5" /></Button>
      <button type="button" className="w-12 text-center text-xs tabular-nums text-fg-3 hover:text-fg" onClick={() => zoom(100 / percent)}>{percent}%</button>
      <Button size="icon-sm" variant="quiet" aria-label={m.zoomIn} onClick={() => zoom(1.25)}><IconPlus className="size-3.5" /></Button>
      <Tip label={m.showAll}><Button size="icon-sm" variant="quiet" aria-label={m.showAll} onClick={onFit}><IconMaximize className="size-3.5" /></Button></Tip>
    </div>
  );
}

const dotTile = (k: number) => 22 * k * (k < 0.5 ? 4 : 1);

/** What [select] makes of the camera; the component re-renders only when that value changes (by `Object.is`). */
export function useCameraSelect<T>(api: CameraApi, select: (camera: Camera) => T): T {
  return useSyncExternalStore(api.subscribe, () => select(api.read()));
}

/**
 * The part of the world worth drawing: what is on screen and a wide margin around it. It changes
 * only when the screen nears the margin's edge or the zoom has moved far from the one it was taken
 * at, so a pan inside it draws nothing new.
 */
export function useViewWindow(api: CameraApi): Bounds {
  const { size } = api;
  const taken = useRef<{ bounds: Bounds; camera: Camera; w: number; h: number } | undefined>(undefined);
  return useCameraSelect(api, (camera) => {
    const held = taken.current;
    if (held && held.w === size.w && held.h === size.h) {
      if (held.camera === camera) return held.bounds;
      const edge = 120 / camera.k, screen = visibleWorld(camera, size, 0), box = held.bounds;
      if (camera.k / held.camera.k < 1.6 && held.camera.k / camera.k < 1.25
        && screen.x >= box.x + edge && screen.y >= box.y + edge
        && screen.x + screen.w <= box.x + box.w - edge && screen.y + screen.h <= box.y + box.h - edge) return box;
    }
    const bounds = visibleWorld(camera, size, Math.max(size.w, size.h, 600) * 0.6 / camera.k);
    taken.current = { bounds, camera, w: size.w, h: size.h };
    return bounds;
  });
}

/** The part of the world on screen, widened by [margin] world units. */
export function visibleWorld(camera: Camera, size: { w: number; h: number }, margin = 300): Bounds {
  return { x: -camera.x / camera.k - margin, y: -camera.y / camera.k - margin, w: size.w / camera.k + margin * 2, h: size.h / camera.k + margin * 2 };
}

export const intersects = (a: Bounds, b: Bounds) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
