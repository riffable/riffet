import sharp from 'sharp';
import type { AvatarStyleProvider } from '@riffet/plugin-api';
import {
  OWNER_AVATAR_PREVIEW_SIDE, OWNER_AVATAR_SEED_MAX, OWNER_AVATAR_SIDE,
  type OwnerAvatarGenerateRequest, type OwnerAvatarStyle,
} from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';

/** What the picture is drawn with when a client sends no theme colors: the neutral pair the app's default theme uses. */
export const DEFAULT_AVATAR_INK = '#2b2a27';
export const DEFAULT_AVATAR_PAPER = '#efebe3';

/** A style's output is untrusted text; this is far more than any picture needs. */
export const AVATAR_SVG_MAX_BYTES = 512 * 1024;
/** One call into a plugin, which for an isolated package is a round trip to its process; longer than that round trip's own limit (`TIMEOUTS.avatar` in plugins-host/remote.ts), so its error is the one reported. */
const GENERATE_TIMEOUT_MS = 10_000;
/** Pixels sharp may decode from one SVG, whatever size it declares. */
const MAX_INPUT_PIXELS = 4096 * 4096;
const PREVIEW_CACHE_ENTRIES = 256;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const UNPRINTABLE = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/** The enabled plugins' avatar styles; the plugin registry is one. */
export interface AvatarStyleSource {
  avatarStyles(): ReadonlyArray<{
    owner: string;
    declaration: { id: string; title: Record<string, string>; credit?: string; needsName?: boolean };
    provider: AvatarStyleProvider;
  }>;
}

/**
 * Why `svg` may not be drawn, or `undefined`. A style's output comes from plugin code, so it is judged before the
 * rasterizer sees it: no script or embedded markup, no document type (entities), and no reference that leaves the
 * document, which would make the server read a file or a URL on a plugin's behalf.
 */
export function avatarSvgProblem(svg: unknown): string | undefined {
  if (typeof svg !== 'string' || !svg.trim()) return 'it is not SVG text';
  if (Buffer.byteLength(svg) > AVATAR_SVG_MAX_BYTES) return `it is larger than ${AVATAR_SVG_MAX_BYTES / 1024} KiB`;
  if (!/<svg[\s>]/i.test(svg)) return 'it is not an SVG document';
  if (/<\s*(?:[\w.-]+:)?(?:script|foreignObject|image)\b/i.test(svg)) return 'it contains script, foreignObject or image elements';
  // A CSS escape can spell `url(` or `@import` past the checks below.
  if (svg.includes('\\')) return 'it contains a backslash';
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(svg)) return 'it declares a document type or entity';
  // A character reference can spell any of the checks below.
  if (/&#/.test(svg)) return 'it uses numeric character references';
  if (/@import/i.test(svg)) return 'it imports a stylesheet';
  for (const match of svg.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    if (!(match[1] ?? match[2] ?? match[3] ?? '').trim().startsWith('#')) return 'it references something outside the document';
  }
  for (const match of svg.matchAll(/url\s*\(\s*([^)]*)/gi)) {
    if (!/^["']?#/.test(match[1]!.trim())) return 'it references something outside the document';
  }
  return undefined;
}

/**
 * An opaque square PNG of `side` pixels. Drawn at twice the size and scaled down, so a style that gives no size
 * of its own is still sharp, and flattened on `paper` so a style that leaves the corners empty does not leave a hole.
 */
export async function rasterizeAvatar(svg: string, side: number, paper: string): Promise<Buffer> {
  const input = Buffer.from(svg);
  const { width } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  const density = Math.min(1200, Math.max(36, Math.round(72 * 2 * side / (width || side))));
  return sharp(input, { density, limitInputPixels: MAX_INPUT_PIXELS })
    .resize(side, side, { fit: 'cover' })
    .flatten({ background: paper })
    .png()
    .toBuffer();
}

interface Entry { provider: AvatarStyleProvider; png: Buffer }

/**
 * The generated-avatar half of the owner service (docs/OWNER.md「随机头像」): finds an enabled style, asks it for
 * an SVG, checks that and draws it. Previews are kept in a small least-recently-used cache; a picture is
 * a function of its request, so the cache only saves work, and an entry made by a provider that has since been
 * replaced is not used.
 */
export class AvatarStyles {
  private readonly previews = new Map<string, Entry>();

  constructor(private readonly source: AvatarStyleSource) {}

  list(): OwnerAvatarStyle[] {
    return this.source.avatarStyles().map(({ owner, declaration }) => ({
      id: declaration.id, pluginId: owner, title: declaration.title,
      ...(declaration.credit ? { credit: declaration.credit } : {}),
      ...(declaration.needsName ? { needsName: true } : {}),
    }));
  }

  /** Whether the preview of this style depends on the owner's name, so it cannot be cached for good. */

  async preview(styleId: string, query: { seed?: unknown; ink?: unknown; paper?: unknown }, name: string | undefined): Promise<Buffer> {
    const request = checkRequest({ seed: query.seed, ink: query.ink, paper: query.paper, style: styleId });
    const found = this.find(request.style);
    const key = [request.style, request.seed, request.ink, request.paper, found.declaration.needsName ? name ?? '' : ''].join('\0');
    const cached = this.previews.get(key);
    if (cached?.provider === found.provider) {
      this.previews.delete(key);
      this.previews.set(key, cached);
      return cached.png;
    }
    const png = await this.render(request, OWNER_AVATAR_PREVIEW_SIDE, name);
    this.previews.set(key, { provider: found.provider, png });
    if (this.previews.size > PREVIEW_CACHE_ENTRIES) this.previews.delete(this.previews.keys().next().value!);
    return png;
  }

  /** The full-size PNG for a `POST /api/owner/avatar/generate` request. */
  async generate(input: unknown, name: string | undefined): Promise<{ png: Buffer; style: string; seed: string }> {
    const request = checkRequest(input);
    const png = await this.render(request, OWNER_AVATAR_SIDE, name);
    return { png, style: request.style, seed: request.seed };
  }

  private find(styleId: string): ReturnType<AvatarStyleSource['avatarStyles']>[number] {
    const found = this.source.avatarStyles().find(item => item.declaration.id === styleId);
    if (!found) throw new AppError('OWNER_AVATAR_STYLE_NOT_FOUND', 'No such avatar style', 404);
    return found;
  }

  private async render(request: Required<OwnerAvatarGenerateRequest>, side: number, name: string | undefined): Promise<Buffer> {
    const { declaration, provider } = this.find(request.style);
    if (declaration.needsName && !name) throw new AppError('OWNER_AVATAR_NEEDS_NAME', 'This style draws the owner\'s name; set one first', 409);
    const failed = (reason: string) => new AppError('OWNER_AVATAR_STYLE_FAILED', `The avatar style ${request.style} failed: ${reason}`, 502);
    let svg: unknown;
    try {
      svg = await withTimeout(Promise.resolve().then(() => provider.generate({
        seed: request.seed, size: side, ink: request.ink, paper: request.paper, ...(declaration.needsName && name ? { name } : {}),
      })), GENERATE_TIMEOUT_MS);
    } catch (error) { throw failed(error instanceof Error ? error.message : String(error)); }
    const problem = avatarSvgProblem(svg);
    if (problem) throw failed(problem);
    try { return await rasterizeAvatar(svg as string, side, request.paper); } catch { throw failed('its picture could not be drawn'); }
  }
}

function checkRequest(input: unknown): Required<OwnerAvatarGenerateRequest> {
  const invalid = (message: string) => new AppError('INVALID_OWNER_AVATAR', message);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Generate request must be an object');
  const { style, seed, ink = DEFAULT_AVATAR_INK, paper = DEFAULT_AVATAR_PAPER } = input as Record<string, unknown>;
  if (typeof style !== 'string' || !style) throw invalid('style must be a style id');
  if (typeof seed !== 'string' || !seed || [...seed].length > OWNER_AVATAR_SEED_MAX || UNPRINTABLE.test(seed)) throw invalid(`seed must be 1 to ${OWNER_AVATAR_SEED_MAX} printable characters`);
  for (const [key, color] of [['ink', ink], ['paper', paper]] as const) if (typeof color !== 'string' || !HEX_COLOR.test(color)) throw invalid(`${key} must be a #rrggbb color`);
  return { style, seed, ink: (ink as string).toLowerCase(), paper: (paper as string).toLowerCase() };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000}s`)), ms); })])
    .finally(() => clearTimeout(timer));
}
