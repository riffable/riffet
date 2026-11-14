import { memo, useContext, useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconDownload, IconImage, IconPaperclip } from '@/components/icons';
import { Spinner } from '@/components/ui/controls';
import { ContentPreview } from '@/components/ContentPreview';
import { startDownload } from '@/lib/files';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { mayPreviewFile, usePreviewTheme } from '@/lib/content-preview';
import { api } from '@/lib/api';
import { boundedCache } from '@/lib/bounded-cache';
import { cn, formatBytes, pixelEdge } from '@/lib/utils';
import { ImageViewer, loadedImageSize, rememberImageSize } from './ImageViewer';
import { ASSEMBLY_MS, useLingering } from './sessionLayout';
import { useImageSource } from './imageSource';
import type { UserAttachment } from './model';
import { useTranscriptResources, type TranscriptResources } from './transcriptResources';
import { PrintImage, PrintRenderingContext } from './printRendering';

/** Uniform square tile used whenever a message carries more than one image. */
const TILE = 72;
/** Long edge of a lone image, clamped like DeepSeek Chat: extreme ratios are cropped, never squeezed. */
const SINGLE_LONG_EDGE = 240;
/** Aspect ratios outside this band are cropped (`object-fit: cover`) to keep a usable box. */
const MIN_RATIO = 0.25;
const MAX_RATIO = 4;
/**
 * Box shown while an image's pixel size is still unknown. Legacy attachments uploaded before sizes
 * were recorded land here; it keeps the slot occupied so the message cannot collapse to 0×0 and
 * jump once the bytes arrive.
 */
const UNKNOWN_BOX = { width: SINGLE_LONG_EDGE, height: SINGLE_LONG_EDGE, objectPosition: 'center' };

/** A usable pixel size from an untrusted payload, or undefined when either edge is unusable. */
function declaredSize(value: { width?: unknown; height?: unknown }): { width: number; height: number } | undefined {
  const width = pixelEdge(value.width);
  const height = pixelEdge(value.height);
  return width === undefined || height === undefined ? undefined : { width, height };
}

/**
 * `attachmentMetadata` answers by attachment id, kept for the session: a message the transcript
 * window mounts again starts from the size and MIME type already fetched, so its thumbnail does not
 * pass through the unknown-size box a second time.
 */
const metadataCache = boundedCache<string, UserAttachment>({ limit: 500 });

const attachmentChip = 'inline-flex min-h-6 min-w-0 max-w-[min(14rem,100%)] items-center gap-1 rounded-md bg-muted px-2 text-xs text-fg-2 no-hover:min-h-11';

export interface ImageBox { width: number; height: number; objectPosition: string; }

/** One image's thumbnail box: `tile` crops to a square, `single` honours the natural ratio. */
export function imageBox(variant: 'single' | 'tile', size?: { width: number; height: number }): ImageBox {
  if (variant === 'tile') return { width: TILE, height: TILE, objectPosition: 'center' };
  // `pixelEdge` also rejects NaN/Infinity, which would otherwise round to NaN and collapse the box
  // this function exists to keep stable.
  const width = pixelEdge(size?.width);
  const height = pixelEdge(size?.height);
  if (width === undefined || height === undefined) return { ...UNKNOWN_BOX };
  size = { width, height };
  const natural = size.width / size.height;
  const ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, natural));
  const box = ratio >= 1
    ? { width: SINGLE_LONG_EDGE, height: SINGLE_LONG_EDGE / ratio }
    : { width: SINGLE_LONG_EDGE * ratio, height: SINGLE_LONG_EDGE };
  // Never upscale past the original pixels; a small screenshot stays small and crisp.
  const scale = Math.min(1, size.width / box.width, size.height / box.height);
  return {
    width: Math.max(1, Math.round(box.width * scale)),
    height: Math.max(1, Math.round(box.height * scale)),
    // A very tall image keeps its top, a very wide one its left: that is where the content starts.
    objectPosition: natural < MIN_RATIO ? 'center top' : natural > MAX_RATIO ? 'left center' : 'center',
  };
}

/**
 * Decided only from what the message carries before any fetch (its receipt, or a frozen transcript's
 * resources), so an id-only receipt resolving later cannot flip the gallery between tiles and a lone
 * image, and a remount lays out the same as the first mount. A type still unknown counts as an image.
 */
export function messageImageVariant(attachments: readonly UserAttachment[], frozen?: TranscriptResources['resources']): 'single' | 'tile' {
  const images = attachments.filter(attachment => {
    const type = (attachment.id ? frozen?.[attachment.id]?.mimeType : undefined) ?? attachment.mimeType;
    return !type || type.toLowerCase().startsWith('image/');
  }).length;
  return images > 1 ? 'tile' : 'single';
}

function MessageAttachment({ attachment, variant }: { attachment: UserAttachment; variant: 'single' | 'tile' }) {
  const { t } = useLingui();
  const printing = useContext(PrintRenderingContext);
  const previewTheme = usePreviewTheme();
  const resources = useTranscriptResources();
  const imageSource = useImageSource();
  const frozen = attachment.id ? resources?.resources[attachment.id] : undefined;
  const remembered = attachment.id && !resources ? metadataCache.get(attachment.id) : undefined;
  const [metadata, setMetadata] = useState<UserAttachment>(frozen ? { ...attachment, ...frozen } : remembered ?? attachment);
  const [size, setSize] = useState<{ width: number; height: number } | undefined>(declaredSize(frozen ?? remembered ?? attachment));
  const [unavailable, setUnavailable] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // Set once the bytes arrive into a guessed box (a size this URL showed before, or none), so it eases to the image's own.
  const [easing, setEasing] = useState(false);
  const [retry, setRetry] = useState(0);
  const assembled = useLingering(true, ASSEMBLY_MS);

  useEffect(() => {
    const known = attachment.id && !resources ? metadataCache.get(attachment.id) : undefined;
    setMetadata(frozen ? { ...attachment, ...frozen } : known ?? attachment);
    setSize(declaredSize(frozen ?? known ?? attachment));
    setUnavailable(Boolean(resources && attachment.id && !frozen));
    setImageFailed(false);
    setLoaded(false);
    setEasing(false);
    if (resources || !attachment.id || known) return;
    // A CLI receipt names the file and its MIME type but never carries the pixel size, and the
    // upload metadata on disk does. Fetching it lets the thumbnail reserve its exact box before the
    // image decodes instead of resizing afterwards. Older id-only receipts need it regardless.
    if (attachment.mimeType && attachment.width && attachment.height) return;
    let active = true;
    void api.attachmentMetadata(attachment.id).then((value) => {
      const declared = declaredSize(value);
      const next: UserAttachment = { id: value.id, name: value.name, mimeType: value.mimeType, size: value.size, ...(declared ?? {}) };
      metadataCache.set(attachment.id!, next);
      if (!active) return;
      setMetadata(next);
      if (declared) setSize(declared);
    }).catch(() => {
      // A known attachment is still renderable without its metadata; only an id-only receipt is
      // genuinely unusable, so it alone reports the failure.
      if (active && !attachment.mimeType) setUnavailable(true);
    });
    return () => { active = false; };
  }, [attachment.id, attachment.name, attachment.mimeType, attachment.width, attachment.height, attachment.path, attachment.type, retry, resources, frozen]);

  const name = metadata.name === metadata.id ? t`附件` : metadata.name;
  const isImage = metadata.mimeType ? metadata.mimeType.startsWith('image/') : metadata.type === 'image';
  // Uploaded images keep their stable id; a native CLI image path is read through the project route.
  const source = metadata.id
    ? resources ? frozen?.url : `/api/attachments/${encodeURIComponent(metadata.id)}`
    : isImage && metadata.path ? imageSource(metadata.path) : undefined;
  if (unavailable && resources) return <span className={attachmentChip}><IconPaperclip className="size-3 shrink-0" /><span><Trans>{name} · 附件不可用</Trans></span></span>;
  if (unavailable) return <button type="button" className={`${attachmentChip} hover:bg-hover`} title={t`重新读取附件`} aria-label={t`重新读取附件`} onClick={() => setRetry(value => value + 1)}><IconPaperclip className="size-3 shrink-0" /><span><Trans>附件不可用</Trans></span></button>;

  if (source && isImage) {
    if (printing) return <PrintImage key={source} src={source} name={name} />;
    // An image that loaded before shows at once in the box it settled in.
    const seen = loadedImageSize(source);
    const box = imageBox(variant, size ?? seen);
    if (imageFailed) {
      // Bytes that did not arrive keep the thumbnail's box, so the message does not shrink to a chip;
      // a retry runs the effect again, which clears the failure and mounts a fresh <img>. The label
      // is the composer's failed tile's, `{0}` and all, so it reads from a member expression.
      return (
        <button
          type="button"
          aria-label={t`图片无法加载，重试：${metadata.name}`}
          title={name}
          onClick={() => setRetry(value => value + 1)}
          className="grid shrink-0 place-items-center rounded-xl bg-muted text-fg-4 transition-colors hover:text-fg-3"
          style={{ width: box.width, height: box.height }}
        >
          <IconImage className="size-5" />
        </button>
      );
    }
    const shown = loaded || seen !== undefined;
    return (
      <ImageViewer src={source} name={name}>
          <button
            type="button"
            aria-label={t`预览图片：${name}`}
            title={name}
            className={cn('relative grid shrink-0 place-items-center overflow-hidden rounded-xl bg-muted transition-opacity hover:opacity-90', easing && 'transition-[width,height,opacity] duration-[var(--duration-base)] ease-out-soft')}
            style={{ width: box.width, height: box.height }}
          >
            <img
              className={cn('size-full object-cover', !shown && 'opacity-0')}
              src={source}
              alt={name}
              loading="lazy"
              decoding="async"
              style={{ objectPosition: box.objectPosition }}
              onLoad={(event) => {
                const { naturalWidth, naturalHeight } = event.currentTarget;
                rememberImageSize(source, naturalWidth, naturalHeight);
                // Self-heal legacy or wrong metadata, and a remembered size the file no longer has
                // (a native path rewritten in place), but never re-measure a box we already trust.
                if (naturalWidth && naturalHeight && !size) {
                  // As the page assembles the thumbnail takes its box at once, with everything else.
                  setEasing(assembled);
                  setSize((current) => current ?? declaredSize({ width: naturalWidth, height: naturalHeight }));
                }
                setLoaded(true);
              }}
              onError={() => setImageFailed(true)}
            />
            {!shown && <Spinner className="absolute size-4 text-fg-4" />}
          </button>
      </ImageViewer>
    );
  }

  const content = <><IconPaperclip className="size-3 shrink-0" /><span className="truncate">{name}</span>{metadata.size !== undefined && <span className="shrink-0 text-fg-4">{formatBytes(metadata.size)}</span>}</>;
  const previewUrl = metadata.id && resources ? frozen?.previewUrl : source ? `${source}${source.includes('?') ? '&' : '?'}render=preview&${previewTheme}` : undefined;
  if (source && previewUrl && metadata.mimeType && mayPreviewFile(name, metadata.mimeType)) {
    return (
      <Dialog>
        <DialogTrigger asChild>
          <button type="button" title={name} aria-label={t`预览：${name}`} className={`${attachmentChip} hover:bg-hover`}>{content}</button>
        </DialogTrigger>
        <DialogContent mobileFullscreen size="workspace" className="h-[min(85dvh,900px)] overflow-hidden" aria-describedby={undefined}>
          <DialogHeader className="flex-row items-center gap-2">
            <DialogTitle className="min-w-0 flex-1 truncate text-sm" title={name}>{name}</DialogTitle>
            <Button size="icon-xs" variant="quiet" asChild>
              <a href={source} download={name} aria-label={t`下载`} title={t`下载`}><IconDownload /></a>
            </Button>
          </DialogHeader>
          <ContentPreview title={name} url={previewUrl} onDownload={() => startDownload(source)} />
        </DialogContent>
      </Dialog>
    );
  }
  return source && metadata.mimeType
    ? <a href={source} download={name} title={name} className={`${attachmentChip} hover:bg-hover`}>{content}</a>
    : <span title={name} className={attachmentChip}>{content}</span>;
}

export const MessageAttachments = memo(function MessageAttachments({ attachments }: { attachments: UserAttachment[] }) {
  const resources = useTranscriptResources();
  if (!attachments.length) return null;
  // Older receipts can omit the MIME type; those still count as image candidates so a screenshot
  // history keeps laying out as a gallery instead of flipping to chips.
  const variant = messageImageVariant(attachments, resources?.resources);
  return (
    <div className="flex max-w-[82%] flex-wrap items-end justify-end gap-1.5">
      {attachments.map((attachment, index) => <MessageAttachment key={`${attachment.id ?? attachment.name}:${index}`} attachment={attachment} variant={variant} />)}
    </div>
  );
});
