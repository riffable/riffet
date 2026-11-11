/**
 * Images an agent's tools produced, as tool content items the browser can render.
 *
 * An image is referenced by its file path whenever one is known; the browser loads it through the
 * project's read-only image route. Base64 travels inline only when small: a transcript event is
 * capped at 64 KB, and a screenshot is usually larger than that. What an omitted image knows about
 * itself still travels — its name, byte count and pixel size — so the row names which image it left
 * out instead of only saying that one was left out.
 */
export const INLINE_IMAGE_LIMIT = 40 * 1024;

const IMAGE_PATH = /\.(?:png|jpe?g|gif|webp|bmp|avif)$/i;

export interface ToolImageSource {
  path?: string;
  data?: string;
  mimeType?: string;
  /** The file's own name: a store-backed image has no readable path to take a basename from. */
  name?: string;
  bytes?: number;
  width?: number;
  height?: number;
}

export function isImagePath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && !/[\r\n]/.test(value) && IMAGE_PATH.test(value.trim());
}

/** Base64 length → the bytes it encodes, so a placeholder can state the image's own byte count. */
function encodedBytes(data: string): number {
  return Buffer.byteLength(data, 'base64');
}

function known(source: ToolImageSource, bytes: number | undefined): Record<string, unknown> {
  const positive = (value: number | undefined) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
  const name = source.name?.trim();
  const size = positive(bytes);
  const width = positive(source.width);
  const height = positive(source.height);
  return {
    ...(name ? { name: name.slice(0, 240) } : {}),
    ...(size !== undefined ? { bytes: size } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  };
}

/** One tool content item for an image; `omitted` when it has no path and is too large to inline. */
export function toolImageContent(source: ToolImageSource, options: { unbounded?: boolean } = {}): Record<string, unknown> {
  const mimeType = source.mimeType?.startsWith('image/') ? source.mimeType : undefined;
  if (source.path) return { type: 'content', content: { type: 'image', path: source.path.trim(), ...known(source, source.bytes), ...(mimeType ? { mimeType } : {}) } };
  if (source.data && mimeType && (options.unbounded || source.data.length <= INLINE_IMAGE_LIMIT)) return { type: 'content', content: { type: 'image', data: source.data, mimeType, ...known(source, source.bytes) } };
  return { type: 'content', content: { type: 'image', omitted: true, ...known(source, source.bytes ?? (source.data ? encodedBytes(source.data) : undefined)), ...(mimeType ? { mimeType } : {}) } };
}

/**
 * Absolute image paths a tool announced in its text output, such as "Saved screenshot to /tmp/a.png".
 * Only for tools whose purpose is to produce an image; a file listing would otherwise become a gallery.
 */
export function announcedImagePaths(text: string, limit = 4): string[] {
  const paths = new Set<string>();
  for (const match of text.matchAll(/(?:^|[\s"'`(<\[])((?:\/|[A-Za-z]:[\\/])[^\s"'`<>()\[\]]+\.(?:png|jpe?g|gif|webp|bmp|avif))(?=$|[\s"'`)>\].,;:])/gim)) {
    paths.add(match[1]!);
    if (paths.size >= limit) break;
  }
  return [...paths];
}

/** Image paths named by a structured result's top-level string fields. */
export function imagePathFields(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.values(value as Record<string, unknown>).filter(isImagePath).map(path => path.trim());
}
