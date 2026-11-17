import { useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconDownload, IconImage, IconX } from '@/components/icons';
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { boundedCache } from '@/lib/bounded-cache';
import { cn } from '@/lib/utils';
import { exit } from '@/lib/motion';
import { isTextField } from '@/lib/tap-focus';
import { SaveImageButton } from './marks';
import { ASSEMBLY_MS, useLingering } from './sessionLayout';
import { ZoomPanImage } from './ZoomPanImage';
import { PrintImage, PrintRenderingContext } from './printRendering';

/**
 * Natural pixel sizes of images that have loaded, by URL, so a row the transcript window mounts
 * again reserves the settled box at once instead of growing out of the placeholder a second time.
 * Weighed by the URL: an inline `data:` image is its own key.
 */
const naturalSizes = boundedCache<string, PixelSize>({ limit: 500, maxWeight: 4_000_000, weigh: (key) => key.length });

export interface PixelSize { width: number; height: number }

/**
 * Sizes of images served by URL also outlive a reload, so a refreshed page lays its images out in
 * their own boxes instead of growing every one out of a placeholder. Inline `data:` and `blob:`
 * images are too heavy or too short-lived to keep.
 */
const STORAGE_KEY = 'riffet.imageSizes';
const STORED_LIMIT = 500;
let stored: Map<string, [number, number]> | undefined;
let storeTimer: ReturnType<typeof setTimeout> | undefined;
const persistable = (src: string) => src.length <= 1024 && !src.startsWith('data:') && !src.startsWith('blob:');

function storedSizes(): Map<string, [number, number]> {
  if (stored) return stored;
  stored = new Map();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown;
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (!Array.isArray(item) || typeof item[0] !== 'string' || !(item[1] > 0) || !(item[2] > 0)) continue;
        stored.set(item[0], [item[1], item[2]]);
        naturalSizes.set(item[0], { width: item[1], height: item[2] });
      }
    }
  } catch { /* Storage may be unavailable. */ }
  return stored;
}

/** The natural size an image at `src` loaded with before, in this page or an earlier one, if it has. */
export const loadedImageSize = (src: string): PixelSize | undefined => {
  storedSizes();
  return naturalSizes.get(src);
};

export function rememberImageSize(src: string, width: number, height: number): void {
  if (!(width > 0 && height > 0)) return;
  naturalSizes.set(src, { width, height });
  if (!persistable(src)) return;
  const sizes = storedSizes();
  const previous = sizes.get(src);
  if (previous?.[0] === width && previous[1] === height) return;
  sizes.delete(src);
  sizes.set(src, [width, height]);
  while (sizes.size > STORED_LIMIT) sizes.delete(sizes.keys().next().value!);
  // A page of images loads in a burst; one write covers it.
  clearTimeout(storeTimer);
  storeTimer = setTimeout(() => {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...sizes].map(([key, [w, h]]) => [key, w, h]))); }
    catch { /* Over quota or unavailable: the in-memory sizes still serve this page. */ }
  }, 500);
}

/**
 * Boxes held by an image whose size is unknown until it loads. Only callers that expect a picture
 * (tool output, attached images) ask for the large one; a badge or an icon growing out of it would
 * jump further than having no placeholder at all.
 */
const PLACEHOLDERS = { large: { width: 320, height: 180 }, small: { width: 96, height: 24 } };

/**
 * The width an image is shown at: its own pixels, narrowed so its height fits `maxHeight`. Written
 * as a width (the height follows from the ratio) so the column narrowing it with `max-width` keeps
 * the ratio rather than letterboxing.
 */
export const fitWidth = (size: PixelSize, maxHeight: number) => Math.min(size.width, (maxHeight * size.width) / size.height);

/**
 * The content width the frame is laid out in. An inline parent (a linked image) has no width of its
 * own, nor does one inside a skipped `content-visibility` subtree, so the nearest block-level
 * ancestor that has been laid out answers.
 */
function columnWidth(frame: HTMLElement): number | undefined {
  for (let node = frame.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === 'contents' || style.display.startsWith('inline') || node.clientWidth === 0) continue;
    return node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  }
  return undefined;
}

/**
 * The height `image` settles at once it shows `natural` with an auto height, so an explicit height
 * eased into can be dropped without a last snap. The `width`/`height` attributes give the ratio of
 * the content box, while the style width and `max-height` measure the `box-sizing` box.
 */
function settledHeight(image: HTMLImageElement, frame: HTMLElement, natural: PixelSize, maxHeight: number): number {
  const style = getComputedStyle(image);
  const edgeX = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth) + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const edgeY = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const borderBox = style.boxSizing === 'border-box';
  const column = columnWidth(frame) ?? Infinity;
  const width = Math.min(borderBox ? column : column - edgeX, fitWidth(natural, maxHeight));
  const content = ((borderBox ? width - edgeX : width) * natural.height) / natural.width;
  return Math.min(borderBox ? content + edgeY : content, maxHeight);
}

interface ZoomableImageProps {
  src: string;
  name: string;
  label?: string;
  path?: string;
  className?: string;
  size?: PixelSize;
  maxHeight?: number;
  /** The placeholder an image of unknown size holds; `large` where a screenshot or photo is expected. */
  placeholder?: keyof typeof PLACEHOLDERS;
}

/**
 * A thumbnail that opens the lightbox; a file that is gone or not an image leaves a labelled placeholder.
 *
 * With `size` (or a size seen for the same URL before) the box is reserved before the bytes arrive.
 * Without one the image holds a placeholder and fades in when it loads. Loaded as the page assembles,
 * it takes its box at once; later it opens downwards to its own height at its final width, cropped
 * while it opens rather than scaled, so it never zooms out of the placeholder's corner. Reduced
 * motion keeps only the fade. A remembered size the image turns out not to have (a file rewritten
 * in place) eases to the new one the same way.
 */
export function ZoomableImage(props: ZoomableImageProps) {
  const printing = useContext(PrintRenderingContext);
  if (printing) return <PrintImage key={props.src} src={props.src} name={props.name} />;
  // Keyed so whether the image started behind a placeholder, and how far it has loaded, belong to one URL.
  return <ZoomableImageFrame key={props.src} {...props} />;
}

function ZoomableImageFrame({ src, name, label, path, className, size, maxHeight = 320, placeholder: reserve = 'small' }: ZoomableImageProps) {
  const { t } = useLingui();
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // While easing to the settled box: the explicit height being transitioned to.
  const [settling, setSettling] = useState<number>();
  const frame = useRef<HTMLSpanElement>(null);
  const assembled = useLingering(true, ASSEMBLY_MS);
  useEffect(() => {
    if (settling === undefined) return;
    // `transitionend` never fires when reduced motion drops the height transition.
    const timer = window.setTimeout(() => setSettling(undefined), 320);
    return () => window.clearTimeout(timer);
  }, [settling]);
  const known = size ?? loadedImageSize(src);
  // Only an image that was not ready on mount had a placeholder to fade out of.
  const [placeholder] = useState(!known);
  const pending = !known && !loaded;
  const box = PLACEHOLDERS[reserve];
  if (failed) {
    const notice = <><IconImage className="size-3.5 shrink-0" /><span className="min-w-0 truncate"><Trans>图片无法加载{label ? ` · ${label}` : ''}</Trans></span></>;
    // The small placeholder is already a line this tall; a larger reserved box keeps its size and
    // shows the failure inside, so the transcript does not shrink by the height the image held.
    if (!known && reserve === 'small') {
      return <span className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-subtle px-2 py-1 text-xs text-fg-3">{notice}</span>;
    }
    return (
      <span
        className={cn('flex max-w-full items-center justify-center gap-1.5 overflow-hidden rounded-lg border border-line bg-subtle px-2 text-xs text-fg-3', className)}
        style={known
          ? { width: fitWidth(known, maxHeight), aspectRatio: `${known.width} / ${known.height}`, maxHeight }
          : { width: box.width, height: Math.min(box.height, maxHeight) }}
      >
        {notice}
      </span>
    );
  }
  const style: CSSProperties | undefined = pending
    ? { width: box.width, height: Math.min(box.height, maxHeight) }
    : known ? { width: fitWidth(known, maxHeight), ...(settling !== undefined ? { height: settling } : {}) } : undefined;
  return (
    <span ref={frame} className="group/image relative block w-fit max-w-full">
      <ImageViewer src={src} name={name}>
        <button type="button" aria-label={t`预览图片`} className="relative block w-fit max-w-full cursor-zoom-in">
          {placeholder && <span aria-hidden data-image-placeholder className={cn('absolute inset-0 rounded-lg bg-muted transition-opacity duration-[var(--duration-base)]', !pending && 'opacity-0')} />}
          <img
            data-image-thumb
            data-pending={pending || undefined}
            className={cn(
              'relative h-auto max-w-full rounded-lg border border-line object-contain',
              (placeholder || settling !== undefined) && 'transition-[height,opacity] duration-[var(--duration-base)] ease-out-soft',
              settling !== undefined && 'object-cover object-top',
              pending && 'opacity-0',
              className,
            )}
            style={{ maxHeight, ...style }}
            {...(known ? { width: known.width, height: known.height } : {})}
            src={src}
            alt={name}
            loading="lazy"
            onLoad={(event) => {
              const image = event.currentTarget;
              const natural = { width: image.naturalWidth, height: image.naturalHeight };
              setLoaded(true);
              if (natural.width <= 0 || natural.height <= 0 || !frame.current) return;
              rememberImageSize(src, natural.width, natural.height);
              const target = settledHeight(image, frame.current, natural, maxHeight);
              // The placeholder already holds an explicit height to ease from; while the page
              // assembles there is nothing to ease from, the image is part of what appears.
              if (!known) { if (assembled) setSettling(target); return; }
              // A declared size is trusted; a remembered one is only what this URL showed last time.
              if (size || (known.width === natural.width && known.height === natural.height)) return;
              // Pin the box the stale size gave before the new ratio paints, then ease from it.
              flushSync(() => setSettling(settledHeight(image, frame.current!, known, maxHeight)));
              void image.offsetHeight;
              setSettling(target);
            }}
            onTransitionEnd={(event) => { if (event.propertyName === 'height') setSettling(undefined); }}
            onError={() => setFailed(true)}
          />
        </button>
      </ImageViewer>
      <SaveImageButton src={src} name={name} {...(path ? { path } : {})} />
    </span>
  );
}

/** A close is played by the open viewer: it calls `done` once the viewer has left the screen. */
type Closer = (done: () => void) => void;

const FALLBACK_EASING = 'cubic-bezier(0.2, 0.7, 0.2, 1)';

/** The shared duration and easing tokens, read where WAAPI cannot resolve `var()` itself. */
function motionTokens() {
  const style = getComputedStyle(document.documentElement);
  return {
    duration: parseFloat(style.getPropertyValue('--duration-slow')) || 300,
    easing: style.getPropertyValue('--ease-out-soft').trim() || FALLBACK_EASING,
  };
}

/** The on-screen rect of `element` when it is laid out and at least partly in the viewport. */
function visibleRect(element: Element | null | undefined): DOMRect | undefined {
  if (!element?.isConnected) return undefined;
  const rect = element.getBoundingClientRect();
  const inside = rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
  return rect.width > 0 && rect.height > 0 && inside ? rect : undefined;
}

/** `transform` that maps a box laid out at `to` onto `from` (top-left origin, uniform scale by width). */
function flipTransform(from: DOMRect, to: DOMRect): string {
  return `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width})`;
}

/**
 * The lightbox's content. Opening grows the image from the thumbnail to its fitted place while the
 * backdrop and bar fade in; closing runs it backwards. The flying image is a copy laid over the
 * viewer (the viewer's frame scrolls and would clip it, and the zoom/pan layout stays untouched),
 * while the real one stays hidden until the copy lands. Without a thumbnail on screen, or with
 * reduced motion, only the fade plays.
 */
function ViewerBody({ src, name, thumb, closer, onClose }: {
  src: string;
  name: string;
  thumb: () => Element | null | undefined;
  closer: RefObject<Closer | null>;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const backdrop = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  // Stops whatever flight is running and puts the real image back.
  const settle = useRef<(() => void) | null>(null);
  const thumbOf = useRef(thumb);
  thumbOf.current = thumb;

  const fades = (from: number, to: number, done?: () => void) => {
    const { duration, easing } = motionTokens();
    const stops = [backdrop, bar, stage].map((target, index) => {
      const element = target.current;
      if (!element) return () => {};
      const stop: () => void = exit(element, [{ opacity: from }, { opacity: to }], { duration, easing }, () => {
        if (to === 1) stop();
        if (index === 0) done?.();
      });
      return stop;
    });
    return () => stops.forEach((stop) => stop());
  };

  /** Flies a copy of the image between two rects; `to` is where the copy is laid out. */
  const fly = (root: HTMLElement, source: DOMRect, laid: DOMRect, forward: boolean, done: () => void) => {
    const { duration, easing } = motionTokens();
    const bounds = root.getBoundingClientRect();
    const copy = document.createElement('img');
    copy.src = src;
    copy.alt = '';
    copy.setAttribute('aria-hidden', 'true');
    copy.draggable = false;
    copy.className = 'pointer-events-none absolute z-10 max-w-none rounded-md';
    Object.assign(copy.style, { left: `${laid.left - bounds.left}px`, top: `${laid.top - bounds.top}px`, width: `${laid.width}px`, height: `${laid.height}px`, transformOrigin: '0 0' });
    root.appendChild(copy);
    const shifted = flipTransform(source, laid);
    const keyframes = forward ? [{ transform: shifted }, { transform: 'none' }] : [{ transform: 'none' }, { transform: shifted }];
    const stop = exit(copy, keyframes, { duration, easing }, done);
    return () => { stop(); copy.remove(); };
  };

  useLayoutEffect(() => {
    const root = backdrop.current?.parentElement;
    const real = stage.current?.querySelector('img');
    if (!root || !real) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const source = visibleRect(thumbOf.current());
    let alive = true;
    let stopFly: (() => void) | undefined;
    let waiting: (() => void) | undefined;
    const stopFades = fades(0, 1);
    const land = () => { stopFly?.(); stopFly = undefined; waiting?.(); waiting = undefined; real.style.visibility = ''; };
    settle.current = () => { stopFades(); land(); };

    if (source && !reduced) {
      real.style.visibility = 'hidden';
      // The copy needs the real image's fitted box, which exists once it has loaded and been laid out.
      let attempts = 0;
      const measure = () => {
        if (!alive) return;
        const laid = real.complete && real.naturalWidth > 0 && real.style.width ? visibleRect(real) : undefined;
        if (laid) {
          stopFly = fly(root, source, laid, true, land);
          return;
        }
        if (++attempts > 600 || real.complete && real.naturalWidth === 0) { land(); return; }
        frame = requestAnimationFrame(measure);
      };
      let frame = requestAnimationFrame(measure);
      waiting = () => cancelAnimationFrame(frame);
    }
    return () => { alive = false; settle.current?.(); settle.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    closer.current = (done) => {
      const root = backdrop.current?.parentElement;
      const real = stage.current?.querySelector('img');
      settle.current?.();
      settle.current = null;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const target = visibleRect(thumbOf.current());
      const current = real && real.style.width ? visibleRect(real) : undefined;
      if (!root || !target || !current || reduced) {
        fades(1, 0, done);
        return;
      }
      real!.style.visibility = 'hidden';
      fly(root, target, current, false, done);
      // The backdrop and bar go with the flight; the stage's own fade would show the real image's toolbar leaving late.
      fades(1, 0);
    };
    return () => { closer.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closer]);

  return (
    <>
      {/* Opaque: a translucent stage lets the page's text show through around the picture. */}
      <div ref={backdrop} className="pointer-events-none absolute inset-0 -z-10 bg-black" />
      <div
        ref={bar}
        className="flex h-14 shrink-0 items-center gap-2 pl-4 pr-2 pt-[env(safe-area-inset-top,0px)]"
        onClick={(event) => {
          if (event.target instanceof Element && !event.target.closest('a, button')) onClose();
        }}
      >
        <DialogTitle className="sr-only">{name}</DialogTitle>
        <span className="flex-1" />
        <a href={src} download={name} aria-label={t`下载图片`} className="grid size-11 place-items-center rounded-lg text-white/75 transition-colors hover:bg-white/10 hover:text-white">
          <IconDownload className="size-4.5" />
        </a>
        <DialogClose aria-label={t`关闭`} className="grid size-11 place-items-center rounded-lg text-white/75 transition-colors hover:bg-white/10 hover:text-white">
          <IconX className="size-5" />
        </DialogClose>
      </div>
      <div ref={stage} className="flex min-h-0 flex-1 flex-col">
        <ZoomPanImage src={src} alt={name} tone="overlay" className="min-h-0 flex-1 pb-[env(safe-area-inset-bottom,0px)]" onBackgroundClick={onClose} />
      </div>
    </>
  );
}

/**
 * In-app lightbox. Images must never open as a top-level tab: browsers refuse to navigate to
 * `data:` URLs, which leaves the user on a blank page.
 */
export function ImageViewer({ src, name, children }: { src: string; name: string; children: ReactNode }) {
  // A pointer close must not leave a focus ring on the thumbnail; a keyboard close should. Neither
  // applies when the preview was opened while typing: the dialog hands the caret back to that field.
  const pointer = useRef(false);
  const fromField = useRef(false);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const closer = useRef<Closer | null>(null);
  const closing = useRef(false);
  // Every way out (button, Esc, backdrop, bar) asks here; the dialog closes when the exit has played.
  const requestClose = () => {
    if (!open || closing.current) return;
    closing.current = true;
    const play = closer.current;
    const finish = () => { closing.current = false; setOpen(false); };
    if (play) play(finish); else finish();
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (next) setOpen(true); else requestClose(); }}>
      <DialogTrigger asChild ref={trigger}>{children}</DialogTrigger>
      <DialogContent
        hideClose
        aria-describedby={undefined}
        className="left-0 top-[var(--app-top,0px)] h-[var(--app-height,100dvh)] max-h-none w-full max-w-none translate-x-0 translate-y-0 rounded-none bg-transparent p-0 text-white shadow-none"
        // The viewer plays its own enter and exit; the dialog's default zoom and fade would stack on it.
        style={{ animation: 'none' }}
        onOpenAutoFocus={() => { fromField.current = isTextField(document.activeElement); }}
        onPointerDownCapture={() => { pointer.current = true; }}
        onKeyDownCapture={() => { pointer.current = false; }}
        onCloseAutoFocus={(event) => { if (pointer.current && !fromField.current) event.preventDefault(); pointer.current = false; }}
      >
        <ViewerBody
          src={src}
          name={name}
          thumb={() => trigger.current?.matches('img') ? trigger.current : trigger.current?.querySelector('img[data-image-thumb]')}
          closer={closer}
          onClose={requestClose}
        />
      </DialogContent>
    </Dialog>
  );
}
