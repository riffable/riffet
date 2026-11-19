import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type Ref } from 'react';
import { useLingui } from '@lingui/react/macro';
import { IconMinus, IconPlus } from '@/components/icons';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { shortcutLabel } from '@/lib/platform';
import { fitScale, IMAGE_GUTTER as GUTTER, type Size } from './imageFit';

const MAX_SCALE = 8;

/** The image point (in natural pixels) that is to sit at a point of the frame once the next scale is laid out. */
interface Anchor { u: number; v: number; x: number; y: number; scale: number }

/**
 * An image that can be looked into: pinch, Ctrl/⌘ + wheel or the toolbar zooms around the pointer,
 * dragging or scrolling pans, and a double-click toggles between the fitted and the actual size.
 * The frame scrolls natively, so a trackpad or wheel pans the way it does anywhere else.
 */
export function ZoomPanImage({ src, alt, tone = 'surface', className, imgRef, initialSize, onImageLoad, onError, onBackgroundClick, onImageClick }: {
  src: string;
  alt: string;
  /** `overlay` sits on the dark lightbox; `surface` on a panel of the workbench. */
  tone?: 'surface' | 'overlay';
  className?: string;
  imgRef?: Ref<HTMLImageElement>;
  /** Known natural pixel size, so the fitted box is laid out on frame 0 before `onLoad` fires. */
  initialSize?: Size | undefined;
  onImageLoad?: (size: Size) => void;
  onError?: () => void;
  /** A click outside the image that did not end a drag. */
  onBackgroundClick?: () => void;
  /** A click on the image itself that did not end a drag. */
  onImageClick?: () => void;
}) {
  const { t } = useLingui();
  const frame = useRef<HTMLDivElement>(null);
  const [image, setImage] = useState<Size | undefined>(() => initialSize);
  const [box, setBox] = useState<Size>();
  // `null` follows the fitted scale as the frame resizes; a number is a scale the reader chose.
  const [zoom, setZoom] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const anchor = useRef<Anchor | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ x: number; y: number; left: number; top: number; moved: boolean; pinch?: { distance: number; scale: number } } | null>(null);
  const suppressClick = useRef(false);

  // Reset while rendering, not in an effect: a cached image can fire `load` before an effect runs.
  const [shown, setShown] = useState(src);
  if (shown !== src) {
    setShown(src);
    setImage(initialSize);
    setZoom(null);
  }

  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    // The frame's border box, floored. `clientWidth` excludes scrollbars and rounds to the nearest
    // pixel: on a browser whose scrollbars take space, a fitted image overflowing a fractional frame
    // by that rounding brought them in, which shrank the fit and took them away again, so the image
    // kept switching between two sizes. The border box includes scrollbars and ignores transforms
    // (a dialog's entrance), so neither moves the fit.
    const measure = (width: number, height: number) => {
      const next = { w: Math.max(0, Math.floor(width)), h: Math.max(0, Math.floor(height)) };
      setBox((current) => current?.w === next.w && current.h === next.h ? current : next);
    };
    // Whole pixels until the observer reports the exact box, before the first paint.
    measure(element.offsetWidth - 1, element.offsetHeight - 1);
    const observer = new ResizeObserver(([entry]) => {
      const size = entry?.borderBoxSize?.[0];
      if (size) measure(size.inlineSize, size.blockSize);
      else measure(element.offsetWidth - 1, element.offsetHeight - 1);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const scales = image && box ? { fit: fitScale(image, box) } : { fit: 1 };
  const scale = zoom ?? scales.fit;
  // Fit is also the floor: zooming out past "the whole picture is visible" would only add margin.
  const minScale = scales.fit;
  const width = image ? image.w * scale : 0;
  const height = image ? image.h * scale : 0;
  // Floored, so a fitted image a rounding error larger than the frame does not make it scroll.
  const inner = box ? { w: Math.max(box.w, Math.floor(width + GUTTER * 2)), h: Math.max(box.h, Math.floor(height + GUTTER * 2)) } : undefined;

  const view = useRef({ scale, width, height, inner, minScale, fit: scales.fit, image });
  view.current = { scale, width, height, inner, minScale, fit: scales.fit, image };

  /** The image point under a point of the frame, honouring a zoom that has not been laid out yet. */
  const imagePoint = useCallback((x: number, y: number): { u: number; v: number } => {
    const pending = anchor.current;
    if (pending) return { u: pending.u + (x - pending.x) / pending.scale, v: pending.v + (y - pending.y) / pending.scale };
    const element = frame.current!;
    const { scale: current, width: w, height: h, inner: size } = view.current;
    const left = size ? (size.w - w) / 2 : 0;
    const top = size ? (size.h - h) / 2 : 0;
    return { u: (element.scrollLeft + x - left) / current, v: (element.scrollTop + y - top) / current };
  }, []);

  /** Zooms so the image point under `from` (frame coordinates) ends up under `to`; both default to the frame's center. */
  const zoomTo = useCallback((next: number, from?: { x: number; y: number }, to = from) => {
    const element = frame.current;
    const { image: size, minScale: min, fit } = view.current;
    if (!element || !size) return;
    const clamped = Math.min(MAX_SCALE, Math.max(min, next));
    const origin = from ?? { x: element.clientWidth / 2, y: element.clientHeight / 2 };
    const target = to ?? origin;
    if (!anchor.current && Math.abs(clamped / view.current.scale - 1) < 1e-4) {
      // Nothing to lay out, so nothing would consume an anchor: just carry the pan.
      element.scrollLeft += origin.x - target.x;
      element.scrollTop += origin.y - target.y;
      return;
    }
    const { u, v } = imagePoint(origin.x, origin.y);
    anchor.current = { u, v, x: target.x, y: target.y, scale: clamped };
    // Long screenshots can fit below 1%; an absolute tolerance would swallow each zoom step.
    setZoom(Math.abs(clamped / fit - 1) < 0.005 ? null : clamped);
  }, [imagePoint]);

  useLayoutEffect(() => {
    const element = frame.current;
    const pending = anchor.current;
    if (!element || !pending || !inner) return;
    anchor.current = null;
    element.scrollLeft = pending.u * scale + (inner.w - width) / 2 - pending.x;
    element.scrollTop = pending.v * scale + (inner.h - height) / 2 - pending.y;
  });

  const local = (clientX: number, clientY: number) => {
    const rect = frame.current!.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  // Wheel and Safari's gesture events are attached natively: React's are passive and cannot stop the page from zooming.
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const delta = Math.max(-60, Math.min(60, event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY));
      zoomTo(view.current.scale * Math.exp(-delta * 0.005), local(event.clientX, event.clientY));
    };
    let gestureStart = 1;
    const gestureBegin = (event: Event) => { event.preventDefault(); gestureStart = view.current.scale; };
    const gestureChange = (event: Event) => {
      event.preventDefault();
      const { scale: factor, clientX, clientY } = event as Event & { scale: number; clientX: number; clientY: number };
      zoomTo(gestureStart * factor, local(clientX, clientY));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    element.addEventListener('gesturestart', gestureBegin);
    element.addEventListener('gesturechange', gestureChange);
    return () => {
      element.removeEventListener('wheel', wheel);
      element.removeEventListener('gesturestart', gestureBegin);
      element.removeEventListener('gesturechange', gestureChange);
    };
  }, [zoomTo]);

  const overflowing = !!box && (width + GUTTER * 2 > box.w + 1 || height + GUTTER * 2 > box.h + 1);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    suppressClick.current = false;
    const element = frame.current!;
    pointers.current.set(event.pointerId, local(event.clientX, event.clientY));
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2, left: element.scrollLeft, top: element.scrollTop, moved: true, pinch: { distance: Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1, scale: view.current.scale } };
    } else if (pointers.current.size === 1) {
      const point = local(event.clientX, event.clientY);
      gesture.current = { ...point, left: element.scrollLeft, top: element.scrollTop, moved: false };
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || !pointers.current.has(event.pointerId)) return;
    const point = local(event.clientX, event.clientY);
    pointers.current.set(event.pointerId, point);
    if (current.pinch && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const mid = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
      zoomTo(current.pinch.scale * Math.hypot(a!.x - b!.x, a!.y - b!.y) / current.pinch.distance, { x: current.x, y: current.y }, mid);
      current.x = mid.x;
      current.y = mid.y;
      return;
    }
    const dx = point.x - current.x;
    const dy = point.y - current.y;
    if (!current.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    if (!current.moved) {
      current.moved = true;
      setDragging(true);
      // Captured only once it is a drag: a capture retargets the click, which must still land on the image.
      frame.current!.setPointerCapture(event.pointerId);
    }
    frame.current!.scrollLeft = current.left - dx;
    frame.current!.scrollTop = current.top - dy;
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    if (pointers.current.size > 0) {
      // One finger left a pinch: carry on as a pan from where the other one is.
      const [rest] = [...pointers.current.values()];
      gesture.current = { ...rest!, left: frame.current!.scrollLeft, top: frame.current!.scrollTop, moved: true };
      return;
    }
    suppressClick.current = !!gesture.current?.moved;
    gesture.current = null;
    setDragging(false);
  };

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    if (event.target instanceof HTMLImageElement) onImageClick?.();
    else onBackgroundClick?.();
  };

  const toggle = (point?: { x: number; y: number }) => {
    const { scale: current, fit } = view.current;
    zoomTo(current > fit * 1.005 ? fit : fit < 1 ? 1 : Math.min(MAX_SCALE, fit * 2), point);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (onImageClick && event.target === frame.current && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      onImageClick();
      return;
    }
    const { scale: current, fit } = view.current;
    const next = { '+': current * 1.25, '=': current * 1.25, '-': current / 1.25, '0': fit, '1': 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    zoomTo(next);
  };

  const overlay = tone === 'overlay';
  const control = cn('grid place-items-center rounded-md transition-colors disabled:opacity-50 max-md:size-10 md:size-7', overlay ? 'hover:bg-white/15 hover:text-white' : 'hover:bg-hover hover:text-fg');

  return (
    <div className={cn('relative flex min-h-0 flex-col', className)} onKeyDown={onKeyDown}>
      <div
        ref={frame}
        data-zoom-pan-frame
        tabIndex={0}
        aria-label={t`${alt}，可缩放`}
        className={cn(
          'min-h-0 flex-1 touch-none select-none overflow-auto overscroll-contain outline-none',
          // The lightbox pans by dragging and gestures; scrollbars would only cover the picture.
          overlay && 'scrollbar-none',
          dragging ? 'cursor-grabbing' : overflowing ? 'cursor-grab' : !onImageClick && image && scales.fit < 1 ? 'cursor-zoom-in' : undefined,
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClick={onClick}
        onDoubleClick={(event) => { if (!onImageClick && event.target instanceof HTMLImageElement) toggle(local(event.clientX, event.clientY)); }}
      >
        <div className="grid place-items-center" style={inner ? { width: inner.w, height: inner.h } : undefined}>
          <img
            ref={imgRef}
            src={src}
            alt={alt}
            draggable={false}
            data-zoom-pan-ready={box && image ? 'true' : undefined}
            className={cn('max-w-none', overlay ? 'rounded-md' : 'rounded-sm', !dragging && !overflowing && onImageClick && 'cursor-zoom-in', (!image || !box) && 'invisible')}
            style={image ? { width, height } : undefined}
            onLoad={(event) => {
              const size = { w: event.currentTarget.naturalWidth || 1, h: event.currentTarget.naturalHeight || 1 };
              setImage(size);
              onImageLoad?.(size);
            }}
            onError={onError}
          />
        </div>
      </div>
      {/* A touch screen pinches instead; the bar would only cover the fitted image's lower edge. */}
      {image && (
        <div
          className={cn(
            'absolute bottom-3 no-hover:hidden left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-lg p-0.5 text-xs tabular-nums mb-[env(safe-area-inset-bottom,0px)]',
            overlay ? 'bg-black/70 text-white/85 ring-1 ring-white/10 backdrop-blur-md' : 'border border-line bg-popover/95 text-fg-2 shadow-soft backdrop-blur-md',
          )}
        >
          <Tip label={t`缩小 · ${shortcutLabel('')}滚轮`} kbd="−" side="top">
            <button type="button" aria-label={t`缩小`} className={control} disabled={scale <= minScale * 1.005} onClick={() => zoomTo(scale / 1.25)}><IconMinus className="size-3.5" /></button>
          </Tip>
          <Tip label={zoom === null ? t`实际大小` : t`适应窗口`} kbd={zoom === null ? '1' : '0'} side="top">
            <button type="button" className={cn('h-7 min-w-14 rounded-md px-1.5 transition-colors max-md:h-10', overlay ? 'hover:bg-white/15 hover:text-white' : 'hover:bg-hover hover:text-fg')} onClick={() => zoomTo(zoom === null ? 1 : scales.fit)}>
              {Math.round(scale * 100)}%
            </button>
          </Tip>
          <Tip label={t`放大 · ${shortcutLabel('')}滚轮`} kbd="+" side="top">
            <button type="button" aria-label={t`放大`} className={control} disabled={scale >= MAX_SCALE - 0.005} onClick={() => zoomTo(scale * 1.25)}><IconPlus className="size-3.5" /></button>
          </Tip>
        </div>
      )}
    </div>
  );
}
