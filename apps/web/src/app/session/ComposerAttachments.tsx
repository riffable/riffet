import { memo, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { Attachment } from '@contracts';
import { IconFileText, IconImage, IconPaperclip, IconTextQuote, IconX } from '@/components/icons';
import { Spinner } from '@/components/ui/controls';
import { attachmentPath, isAgentReference, isSessionReference, type PromptContextReference } from '@/lib/api';
import { AgentLogo } from '@/components/AgentLogo';
import { basename } from '@/lib/utils';
import { COMPOSER_IMAGE_TILE, focusIndexAfterRemoval, formatBytes, isImageAttachment, type PendingUpload } from './composerAttachmentIntake';
import { ImageViewer } from './ImageViewer';
import { quoteLabel } from './quotes';

/*
 * The composer's attachment area, as a controlled component: the draft arrays and every mutation
 * live in `Composer`, this file only draws them and reports intent. Nothing here owns a window
 * listener, a timer or a fetch — the same reason the intake rules live in `composerAttachmentIntake.ts`.
 *
 * Two variants, one per screen shape already in `Composer`:
 *
 * - `rail`    the wrapped rows: file references on one row, attachments on the next (§5.4). Images
 *             are 64px thumbnails that open the existing `ImageViewer`; everything else is a chip.
 * - `summary` the one-line mobile summary; the host keeps its expand toggle and its chevron.
 */

/** 64px square, shared by the thumbnail and the upload placeholder so the row cannot jump. */
const TILE_STYLE = { width: COMPOSER_IMAGE_TILE, height: COMPOSER_IMAGE_TILE };

/**
 * Marks the rail's focus targets, one per item, the way `TranscriptView` marks rows: queried, never
 * styled. In DOM order — references, then images, then files — which is the order removal walks.
 */
const TILE_SELECTOR = '[data-attachment-tile]';

/**
 * The composer's chip, copied out of `Composer.tsx` rather than imported — it is a local there, and
 * a draft chip has to keep looking like the reference chip it sits beside. `meta` is the slot the
 * file size goes in: outside the truncating span, so a long name shortens before the size vanishes.
 * Without [onRemove] (still uploading) the ✕ keeps its room, so the finished chip takes the same box.
 */
function Chip({ icon, children, meta, title, removeLabel, disabled, onRemove, onOpen }: {
  icon: ReactNode; children: ReactNode; meta?: ReactNode; title?: string; removeLabel?: string; disabled?: boolean; onRemove?: () => void; onOpen?: () => void;
}) {
  const { t } = useLingui();
  const label = removeLabel ?? t`移除`;
  return (
    <span title={title} className="group/chip inline-flex min-h-7 max-w-64 min-w-0 items-center gap-1 rounded-md bg-subtle pl-1.5 pr-0.5 text-xs text-fg-2 md:h-6 md:min-h-0">
      <span className="shrink-0 text-fg-3 [&_svg]:size-3">{icon}</span>
      {onOpen ? <button type="button" data-attachment-tile disabled={disabled} onClick={onOpen} className="min-h-11 min-w-0 truncate rounded text-left hover:underline focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 md:min-h-0">{children}</button> : <span className="min-w-0 truncate">{children}</span>}
      {meta && <span className="shrink-0 tabular-nums text-fg-3">{meta}</span>}
      {onRemove
        ? <button type="button" data-attachment-tile aria-label={label} disabled={disabled} onClick={onRemove} className="grid size-11 shrink-0 place-items-center rounded text-fg-4 hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-50 md:size-4"><IconX className="size-3" /></button>
        : <span aria-hidden className="size-11 shrink-0 md:size-4" />}
    </span>
  );
}

function ImageTile({ attachment, disabled, onRemove, onError }: {
  attachment: Attachment; disabled?: boolean; onRemove: () => void; onError: (message: string) => void;
}) {
  const { t } = useLingui();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const source = attachmentPath(attachment.id);
  return (
    <span className="relative shrink-0">
      {failed ? (
        /*
         * A tile whose bytes did not arrive keeps its slot, its size and its place in the focus
         * order — the user can retry it or remove it, and deleting a neighbour still lands on a
         * real button. The failure is reported once, because a silent grey square is exactly the
         * "上传失败" the design refuses to ship.
         */
        <button
          type="button"
          data-attachment-tile
          aria-label={t`图片无法加载，重试：${attachment.name}`}
          title={attachment.name}
          onClick={() => { setFailed(false); setAttempt((value) => value + 1); }}
          className="grid shrink-0 place-items-center rounded-lg border border-line bg-subtle text-fg-4 transition-colors hover:text-fg-3"
          style={TILE_STYLE}
        >
          <IconImage className="size-5" />
        </button>
      ) : (
        <ImageViewer src={source} name={attachment.name}>
          <button type="button" data-attachment-tile aria-label={t`预览图片：${attachment.name}`} title={attachment.name} className="grid shrink-0 cursor-zoom-in place-items-center overflow-hidden rounded-lg border border-line bg-subtle" style={TILE_STYLE}>
            {/* Remounting on retry is what makes the browser ask for the bytes again; the button
                itself stays, so focus is never lost to a failed load. */}
            <img key={attempt} className="size-full object-cover" loading="lazy" decoding="async" src={source} alt={attachment.name} onError={() => { setFailed(true); onError(t`图片无法加载：${attachment.name}`); }} />
          </button>
        </ImageViewer>
      )}
      <button
        type="button"
        aria-label={t`移除 ${attachment.name}`}
        disabled={disabled}
        onClick={onRemove}
        /*
         * The hit area is a full 44px square on touch, and on a 64px tile it has to hang outside
         * the corner: kept inside, it would swallow the taps meant for the preview. The visible
         * chrome stays smaller than the target at every size.
         */
        className="group/remove absolute -right-5 -top-5 grid size-11 place-items-center rounded-full disabled:pointer-events-none disabled:opacity-50 md:-right-3 md:-top-3 md:size-6"
      >
        <span aria-hidden className="grid size-6 place-items-center rounded-full border border-line bg-elevated/95 text-fg-2 shadow-soft transition-colors group-hover/remove:bg-hover group-hover/remove:text-fg md:size-5"><IconX className="size-3" /></span>
      </button>
    </span>
  );
}

function UploadingTile({ name }: { name: string }) {
  return (
    <span role="status" title={name} className="grid shrink-0 place-items-center gap-1 rounded-lg border border-dashed border-line-strong bg-subtle text-2xs text-fg-3" style={TILE_STYLE}>
      <Spinner className="size-4" />
      <span><Trans>上传中</Trans></span>
    </span>
  );
}

export interface ComposerAttachmentsProps {
  attachments: Attachment[];
  references: PromptContextReference[];
  /** Bitmask matching `references`: `'1'` marks a reference already rendered inline in the textarea, so it is omitted from the chip rail. */
  hiddenMask?: string;
  /** Quotes taken from answers, after the references (quotes.ts). */
  quotes: readonly string[];
  /** Each drawn where its attachment will appear, in its shape, so finishing an upload moves nothing. */
  pending: readonly PendingUpload[];
  disabled?: boolean;
  /** `rail` = desktop/wrapped rows; `summary` = the collapsed mobile row's content. */
  variant?: 'rail' | 'summary';
  onRemoveAttachment: (id: string) => void;
  onRetryUpload?: (key: string) => void;
  onRemoveUpload?: (key: string) => void;
  onRemoveReference: (index: number) => void;
  onRemoveQuote: (index: number) => void;
  onOpenReferenceSession?: (id: string) => void;
  /**
   * Accepted so the host can hand the rail the same intake path it uses for the window-level drop.
   * The rail attaches no listeners of its own: the card above it already owns the drop, and a
   * second handler in between would upload every file twice.
   */
  onDropFiles: (files: File[]) => void;
  onError: (message: string) => void;
}

/** Memoized: the host re-renders on every keystroke of the draft, and the rail does not depend on it. */
export const ComposerAttachments = memo(function ComposerAttachments({ attachments, references, hiddenMask, quotes, pending, disabled, variant = 'rail', onRemoveAttachment, onRemoveReference, onRemoveQuote, onOpenReferenceSession, onRetryUpload, onRemoveUpload, onError }: ComposerAttachmentsProps): ReactNode {
  const { t } = useLingui();
  const railRef = useRef<HTMLDivElement>(null);
  const pendingFocusRef = useRef<{ index?: number; attachmentId?: string; reference?: PromptContextReference; quotes?: readonly string[] } | undefined>(undefined);
  const images = attachments.filter(isImageAttachment);
  const files = attachments.filter((attachment) => !isImageAttachment(attachment));
  const uploading = pending.length > 0;

  /**
   * Focus follows the removal (§7.3) across the whole rail: reference chips, thumbnails and file
   * chips are one row of targets. The intent is recorded when the ✕ is pressed but applied only
   * after React committed the shorter list, because at click time the removed item is still in the
   * DOM and the neighbour has not taken its index yet. `index` being absent means the rail has
   * nothing left to focus; handing the caret back to the textarea is the host's decision.
   */
  useLayoutEffect(() => {
    const pending = pendingFocusRef.current;
    pendingFocusRef.current = undefined;
    if (!pending || pending.index === undefined) return;
    // A host that refused the removal must not have focus moved as if it had happened.
    const kept = pending.attachmentId !== undefined ? attachments.some((item) => item.id === pending.attachmentId)
      : pending.quotes ? quotes === pending.quotes : references.includes(pending.reference!);
    if (kept) return;
    railRef.current?.querySelectorAll<HTMLElement>(TILE_SELECTOR)[pending.index]?.focus();
  }, [attachments, references, quotes]);

  // Tiles per reference: a session one opens and removes; inline references have none (they live in the text).
  const isInline = (index: number, item: PromptContextReference) => isAgentReference(item) || hiddenMask?.[index] === '1';
  const tilesOf = (item: PromptContextReference, index: number) => isInline(index, item) ? 0 : isSessionReference(item) && onOpenReferenceSession ? 2 : 1;
  const referencePositions = references.map((_, index) => references.slice(0, index).reduce((count, item, itemIndex) => count + tilesOf(item, itemIndex), 0));
  const referenceTargets = references.reduce((count, item, index) => count + tilesOf(item, index), 0);
  const chips = references.filter((item, index) => !isInline(index, item));
  const total = referenceTargets + quotes.length + attachments.length;
  const removeQuote = (index: number) => {
    pendingFocusRef.current = { index: focusIndexAfterRemoval(referenceTargets + index, total), quotes };
    onRemoveQuote(index);
  };
  const removeReference = (index: number) => {
    pendingFocusRef.current = { index: focusIndexAfterRemoval(referencePositions[index]!, total - (isSessionReference(references[index]!) && onOpenReferenceSession ? 1 : 0)), reference: references[index] };
    onRemoveReference(index);
  };
  const removeAttachment = (attachment: Attachment) => {
    const image = images.indexOf(attachment);
    const position = referenceTargets + quotes.length + (image >= 0 ? image : images.length + files.indexOf(attachment));
    pendingFocusRef.current = { index: focusIndexAfterRemoval(position, total), attachmentId: attachment.id };
    onRemoveAttachment(attachment.id);
  };

  if (!attachments.length && !chips.length && !quotes.length && !uploading) return null;

  if (variant === 'summary') {
    // Content only: the host keeps the button, its chevron and its `aria-expanded`.
    return (
      <>
        <IconPaperclip className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {[
            attachments.length ? t`${attachments.length} 个附件` : '',
            chips.length + quotes.length ? t`${chips.length + quotes.length} 个引用` : '',
            uploading ? t`上传中` : '',
          ].filter(Boolean).join(' · ')}
        </span>
      </>
    );
  }

  return (
    <div ref={railRef} className="flex flex-col gap-1.5 px-3 pt-3">
      {/* References and attachments stay on separate rows: thumbnails would push a reference chip
          onto the next line anyway, and two stable rows beat one mixed, reflowing one (§5.4). */}
      {(chips.length > 0 || quotes.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {references.map((reference, index) => {
            // Inline mentions (`@member`, `@Agent`, `@file`, `@session`) are marked in the text, not drawn as chips.
            if (isAgentReference(reference) || hiddenMask?.[index] === '1') return null;
            const session = isSessionReference(reference);
            const name = session ? reference.title ?? reference.sessionId : `${basename(reference.path)}${reference.line ? `:${reference.line}` : ''}`;
            return <Chip key={`${session ? reference.sessionId : reference.path}:${index}`} icon={session ? <AgentLogo backend={reference.backendId ?? 'cursor'} size={12} /> : <IconFileText />} title={session ? reference.title ?? reference.sessionId : reference.path} removeLabel={session ? t`移除会话引用` : t`移除 ${name}`} disabled={disabled} onRemove={() => removeReference(index)} onOpen={session && onOpenReferenceSession ? () => onOpenReferenceSession(reference.sessionId) : undefined}>
              {name}
            </Chip>;
          })}
          {quotes.map((quote, index) => (
            <Chip key={`quote:${index}`} icon={<IconTextQuote />} title={quote} removeLabel={t`移除引用`} disabled={disabled} onRemove={() => removeQuote(index)}>
              {quoteLabel(quote)}
            </Chip>
          ))}
        </div>
      )}
      {(images.length > 0 || files.length > 0 || uploading) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {images.map((attachment) => (
            <ImageTile key={attachment.id} attachment={attachment} disabled={disabled} onRemove={() => removeAttachment(attachment)} onError={onError} />
          ))}
          {pending.filter((upload) => upload.image && !upload.error).map((upload) => <UploadingTile key={upload.key} name={upload.name} />)}
          {files.map((attachment) => (
            <Chip key={attachment.id} icon={<IconPaperclip />} title={attachment.name} meta={formatBytes(attachment.size)} removeLabel={t`移除 ${attachment.name}`} disabled={disabled} onRemove={() => removeAttachment(attachment)}>
              {attachment.name}
            </Chip>
          ))}
          {pending.filter((upload) => !upload.image && !upload.error).map((upload) => (
            <Chip key={upload.key} icon={<Spinner />} title={upload.name} meta={formatBytes(upload.size)}>{upload.name}</Chip>
          ))}
          {pending.filter(upload => upload.error).map(upload => (
            <Chip key={upload.key} icon={<IconPaperclip />} title={upload.error} removeLabel={t`移除 ${upload.name}`} disabled={disabled} onRemove={() => onRemoveUpload?.(upload.key)}>
              <button type="button" data-attachment-tile disabled={disabled} onClick={() => onRetryUpload?.(upload.key)} className="text-danger underline underline-offset-2" aria-label={t`重试上传 ${upload.name}`}>{upload.name} · {upload.error === t`请重新选择文件` ? t`请重新选择文件` : t`上传失败`}</button>
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
});
