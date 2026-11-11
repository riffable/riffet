import { msg } from '@lingui/core/macro';
import { i18n } from '@lingui/core';

/**
 * The long edge an image is allowed to keep. A phone photo is routinely 12MP and several megabytes;
 * the CLI only ever renders it, so sending the original is both a slow upload and a decode spike on
 * whichever device opens the conversation next. Matches what the mobile client does before upload.
 */
export const MAX_IMAGE_EDGE = 2048;

/**
 * The size an image should be redrawn at, or nothing when it already fits within the limit.
 *
 * Kept separate from the canvas work so the rule is testable without a DOM: the long edge is capped
 * and the other dimension keeps its aspect ratio, rounded to whole pixels.
 */
export function downscaleTarget(width: number, height: number, limit = MAX_IMAGE_EDGE): { width: number; height: number } | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  const longEdge = Math.max(width, height);
  if (longEdge <= limit) return undefined;
  const scale = limit / longEdge;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export interface UploadData {
  dataBase64: string;
  mimeType: string;
  width?: number;
  height?: number;
}

/** A file's bytes as base64, without the data-URL prefix. */
export const readBase64 = (blob: Blob, label: string) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => { const result = String(reader.result ?? ''); const comma = result.indexOf(','); resolve(comma < 0 ? result : result.slice(comma + 1)); };
  reader.onerror = () => reject(reader.error ?? new Error(i18n._(msg`无法读取 ${label}`)));
  reader.readAsDataURL(blob);
});

/**
 * The bytes, type and pixel size to upload for one draft.
 *
 * An image past the long-edge limit is redrawn first, and its reported size is the redrawn one so
 * the transcript reserves the box that actually matches what was uploaded. Everything else — a
 * small image, a non-image, or anything this browser cannot decode — uploads byte for byte, with no
 * declared size when the dimensions could not be measured.
 */
export async function readUploadData(file: File): Promise<UploadData> {
  const mimeType = file.type || 'application/octet-stream';
  // Read only on the paths that upload the original: a redrawn image must not hold a second,
  // full-size base64 copy of itself that is thrown away a moment later.
  const original = async (size?: { width: number; height: number }): Promise<UploadData> => ({ dataBase64: await readBase64(file, file.name || i18n._(msg({ message: '文件', context: 'session-file-noun' }))), mimeType, ...size });
  if (!mimeType.startsWith('image/') || typeof createImageBitmap !== 'function' || typeof document === 'undefined') return original();
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    const source = { width: bitmap.width, height: bitmap.height };
    if (!source.width || !source.height) return original();
    const target = downscaleTarget(source.width, source.height);
    if (!target) return original(source);
    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext('2d');
    if (!context) return original(source);
    context.drawImage(bitmap, 0, 0, target.width, target.height);
    // PNG may carry transparency the other formats would lose; a photo becomes JPEG, which is
    // several times smaller at a quality nobody can tell apart in a transcript thumbnail.
    const outputType = mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, outputType, 0.85));
    if (!blob) return original(source);
    return { dataBase64: await readBase64(blob, file.name || i18n._(msg({ message: '图片', context: 'session-image-name' }))), mimeType: outputType, ...target };
  } catch {
    return original();
  } finally { bitmap?.close(); }
}

/** Keeps the name honest when the upload was re-encoded into another format. */
export function uploadName(file: File, mimeType: string): string {
  const name = file.name || (mimeType.startsWith('image/') ? 'pasted.png' : 'attachment');
  // Only an actual image conversion changes the extension. Missing MIME metadata on a ZIP or
  // an unknown file must not turn its name into .jpg when the upload falls back to octet-stream.
  if (!file.type.startsWith('image/') || !['image/png', 'image/jpeg'].includes(mimeType) || mimeType === file.type) return name;
  const stem = name.replace(/\.[^.]+$/, '') || 'pasted';
  return `${stem}.${mimeType === 'image/png' ? 'png' : 'jpg'}`;
}

/** Files exposed by a clipboard or drop, including screenshots missing from `files`. */
export function clipboardFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = Array.from(data.items).filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile()).filter((file): file is File => file !== null);
  return files.length ? files : Array.from(data.files);
}
