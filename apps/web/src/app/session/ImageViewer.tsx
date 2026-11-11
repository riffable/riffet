import { useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconDownload, IconImage, IconX } from '@/components/icons';
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { boundedCache } from '@/lib/bounded-cache';
import { cn } from '@/lib/utils';
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

/**
 * In-app lightbox. Images must never open as a top-level tab: browsers refuse to navigate to
 * `data:` URLs, which leaves the user on a blank page.
 */
export function ImageViewer({ src, name, children }: { src: string; name: string; children: ReactNode }) {
  const { t } = useLingui();
  // A pointer close must not leave a focus ring on the thumbnail; a keyboard close should. Neither
  // applies when the preview was opened while typing: the dialog hands the caret back to that field.
  const pointer = useRef(false);
  const fromField = useRef(false);
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent
        hideClose
        aria-describedby={undefined}
        className="left-0 top-[var(--app-top,0px)] h-[var(--app-height,100dvh)] max-h-none w-full max-w-none translate-x-0 translate-y-0 rounded-none bg-black/95 p-0 text-white shadow-none"
        onOpenAutoFocus={() => { fromField.current = isTextField(document.activeElement); }}
        onPointerDownCapture={() => { pointer.current = true; }}
        onKeyDownCapture={() => { pointer.current = false; }}
        onCloseAutoFocus={(event) => { if (pointer.current && !fromField.current) event.preventDefault(); pointer.current = false; }}
      >
        <div
          className="flex h-14 shrink-0 items-center gap-2 pl-4 pr-2 pt-[env(safe-area-inset-top,0px)]"
          onClick={(event) => {
            if (event.target instanceof Element && !event.target.closest('a, button')) setOpen(false);
          }}
        >
          <DialogTitle className="min-w-0 flex-1 truncate text-sm font-medium text-white/85">{name}</DialogTitle>
          <a href={src} download={name} aria-label={t`下载图片`} className="grid size-11 place-items-center rounded-lg text-white/75 transition-colors hover:bg-white/10 hover:text-white">
            <IconDownload className="size-4.5" />
          </a>
          <DialogClose aria-label={t`关闭`} className="grid size-11 place-items-center rounded-lg text-white/75 transition-colors hover:bg-white/10 hover:text-white">
            <IconX className="size-5" />
          </DialogClose>
        </div>
        <ZoomPanImage src={src} alt={name} tone="overlay" className="min-h-0 flex-1 pb-[env(safe-area-inset-bottom,0px)]" onBackgroundClick={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
