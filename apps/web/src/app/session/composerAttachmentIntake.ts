import { msg } from '@lingui/core/macro';
import { i18n } from '@lingui/core';
import type { Attachment } from '@contracts';
import { formatBytes } from '@/lib/utils';

/*
 * The composer's attachment intake rules: what may be attached, why a batch is refused as a batch,
 * and how a draft attachment is identified for duplicate suppression.
 *
 * Pure and DOM-free, like `composerKeyboard.ts`, `image-upload.ts` and `streamResume.ts`: the rules
 * are the part that must not drift, so they are testable without a browser. Everything that needs
 * the browser — clipboard, drag & drop, `FileReader` — stays in the component.
 *
 * The limits are the server's, repeated here so a batch that cannot be accepted is refused before
 * a single byte is uploaded (`apps/server/src/app.ts:252`, `apps/server/src/workspace/index.ts:18`).
 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 20;
export const MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024;
/** Thumbnail edge, matching `MessageAttachments.tsx`'s TILE so a draft and a sent message line up. */
export const COMPOSER_IMAGE_TILE = 64;

/**
 * One attachment already in the draft, with the `dedupeKey` it was accepted under. Carrying the key
 * beside the attachment is what lets a second drop of the same file be recognised without reading
 * it again.
 */
export interface DraftAttachment { attachment: Attachment; key: string }

/** A file on its way to the draft, drawn in the shape the attachment will take: a tile or a chip. */
export interface PendingUpload { key: string; name: string; size: number; image: boolean; error?: string; attachmentId?: string }

/** The part of a `File` the intake rules read — enough to decide, little enough to fake in a test. */
export interface CandidateFile { name: string; size: number; type: string; lastModified?: number }

/**
 * Re-exported rather than reimplemented: the size on a draft chip and the size the context panel
 * shows for the same file must not be able to drift apart.
 */
export { formatBytes };

/** Metadata hints, never an admission whitelist: unknown files upload as generic binary. */
const EXTENSION_MIME_TYPES: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', json: 'application/json', pdf: 'application/pdf',
  csv: 'text/csv', zip: 'application/zip', tar: 'application/x-tar', gz: 'application/gzip',
  tgz: 'application/gzip', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp',
  heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff', ico: 'image/x-icon',
};

/** Some platforms provide no MIME type (or only a generic binary type) for local files. */
export function attachmentMimeType(file: Pick<CandidateFile, 'name' | 'type'>): string {
  const type = file.type.split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/octet-stream' && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) return type;
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return Object.hasOwn(EXTENSION_MIME_TYPES, extension) ? EXTENSION_MIME_TYPES[extension]! : 'application/octet-stream';
}

/**
 * The verdict for a whole intake batch: `null` accepts it, a Chinese sentence refuses it.
 *
 * All-or-nothing is the point (§5.3, and DSH's `intakeFiles` does the same): accepting the files
 * that happen to fit and silently dropping the rest loses the very thing the user was sending. The
 * reason names the offending file, because "上传失败" is not a reason — the user has to know which
 * file to drop.
 */
export function validateIntake(candidates: readonly CandidateFile[], existing: number, limit = MAX_ATTACHMENTS_PER_MESSAGE): string | null {
  if (existing + candidates.length > limit) {
    // The current count only earns a mention when there is one; "已有 0 个" would read as noise.
    return existing > 0 ? i18n._(msg`最多 ${limit} 个附件，当前这条已有 ${existing} 个`) : i18n._(msg`最多 ${limit} 个附件`);
  }
  // The first offending file decides, in batch order — the order the files were picked or dropped.
  for (const file of candidates) {
    // A size we cannot read is not a size that is too large; the server reads the bytes and stays
    // the authority on them.
    if (file.size > MAX_ATTACHMENT_BYTES) return i18n._(msg`单个附件最大 ${formatBytes(MAX_ATTACHMENT_BYTES)}：${file.name} 超了`);
  }
  return null;
}

/**
 * Identity for duplicate suppression: same name, same size, same modification time is the same file
 * arriving twice.
 *
 * No content hash. Reading 64 KiB of every dropped file to catch the rare pair of different files
 * with identical metadata costs latency on every intake, and §5.2 leaves the hash optional.
 */
export function dedupeKey(file: CandidateFile): string {
  // An unknown modification time is a stable 0 rather than `undefined`: the key is compared, never
  // displayed, so two files that both lack one are the same kind of unknown.
  return `${file.name}:${file.size}:${file.lastModified ?? 0}`;
}

/**
 * Splits a batch into the files worth uploading and the ones already present, preserving order so
 * the draft reads in the order the user dropped things.
 *
 * The batch is compared against itself as well as against `keys`, which is what keeps the same
 * screenshot dragged twice in one gesture from becoming two attachments (§5.2).
 */
export function newCandidates(candidates: readonly CandidateFile[], keys: ReadonlySet<string>): { kept: CandidateFile[]; skipped: CandidateFile[] } {
  const { keptIndices, skipped } = newCandidateIndices(candidates, keys);
  return { kept: keptIndices.map((index) => candidates[index]!), skipped };
}

/**
 * The same split, expressed in indices.
 *
 * `planIntake` needs positions to hand `Composer` back the `File` objects it started from, and
 * identity comparison would be wrong here rather than merely awkward: the same object legitimately
 * appears twice in one batch, so `kept.includes(file)` would keep both copies of a duplicate.
 */
function newCandidateIndices(candidates: readonly CandidateFile[], keys: ReadonlySet<string>): { keptIndices: number[]; skipped: CandidateFile[] } {
  const seen = new Set(keys);
  const keptIndices: number[] = [];
  const skipped: CandidateFile[] = [];
  candidates.forEach((candidate, index) => {
    const key = dedupeKey(candidate);
    if (seen.has(key)) { skipped.push(candidate); return; }
    seen.add(key);
    keptIndices.push(index);
  });
  return { keptIndices, skipped };
}

/** Whether the tile strip renders this attachment; everything else stays a chip. */
export function isImageAttachment(attachment: Attachment): boolean {
  return attachment.mimeType.startsWith('image/');
}

/**
 * What one intake gesture should actually do: nothing, refuse, or upload these files.
 *
 * The order of the two questions is the whole point. Limits are checked against the *whole* batch
 * first, so a batch that cannot be accepted is refused before any deduplication could quietly shrink
 * it into something acceptable — "you may attach 20, and you dropped 21" must not become "18 new
 * files were accepted". Only then are duplicates removed, because a duplicate is not a limit
 * violation: dropping the same screenshot twice is absorbed silently (§5.2).
 *
 * Returned as data rather than performed here, so the rule can be tested without a browser and
 * `Composer` keeps the only side effects (uploads, toasts, the draft array).
 */
export interface IntakeEntry { readonly index: number; readonly file: CandidateFile; readonly key: string }

export type IntakePlan =
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'upload'; readonly entries: readonly IntakeEntry[]; readonly duplicateCount: number };

export function planIntake(candidates: readonly CandidateFile[], existing: number, keys: ReadonlySet<string>, limit = MAX_ATTACHMENTS_PER_MESSAGE): IntakePlan {
  const reason = validateIntake(candidates, existing, limit);
  if (reason) return { kind: 'rejected', reason };
  const { keptIndices, skipped } = newCandidateIndices(candidates, keys);
  if (!keptIndices.length) return { kind: 'empty' };
  // The index travels with the candidate: `Composer` holds `File` objects and this module must not
  // (it has no DOM), so position is how the two lists are matched back up without re-deriving keys.
  return {
    kind: 'upload',
    entries: keptIndices.map((index) => ({ index, file: candidates[index]!, key: dedupeKey(candidates[index]!) })),
    duplicateCount: skipped.length,
  };
}

/**
 * Where focus goes after the tile at `removed` disappears from a strip of `count` tiles (§7.3).
 *
 * The tile after the removed one slides into its index, so that index is the neighbour to land on;
 * the last tile has no successor and falls back to the one before it. `undefined` means the strip
 * has nothing left to focus — the textarea is the host's decision, not this module's — and it also
 * covers a caller passing an index we never rendered.
 */
export function focusIndexAfterRemoval(removed: number, count: number): number | undefined {
  if (removed < 0 || removed >= count || count < 2) return undefined;
  return removed === count - 1 ? count - 2 : removed;
}
