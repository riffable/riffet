import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  OWNER_AVATAR_HISTORY_MAX, OWNER_AVATAR_MAX_BYTES, OWNER_AVATAR_TYPES, OWNER_NAME_MAX,
  type OwnerAvatar, type OwnerAvatarStyle, type OwnerAvatarType, type OwnerInfo, type OwnerUpdate,
} from '../../../../packages/contracts/src/index.js';
import { IMAGE_MAGIC } from '../appearance/index.js';
import { AppError } from '../errors.js';
import { AvatarStyles, type AvatarStyleSource } from './avatar-styles.js';

interface StoredAvatar { sha256: string; type: OwnerAvatarType; size: number; generated?: NonNullable<OwnerAvatar['generated']> }
/** `history`: earlier avatars, most recent first, never the current one, no duplicates, at most {@link OWNER_AVATAR_HISTORY_MAX}. */
interface Stored { revision: number; name?: string; avatar?: StoredAvatar; history?: StoredAvatar[]; updatedAt?: string }

const SHA256 = /^[0-9a-f]{64}$/;
/** C0/C1 controls (newline and tab included) and the Unicode line/paragraph separators: a name is one line. */
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** The encoded form of the largest avatar, plus room for padding. */
const MAX_BASE64_LENGTH = Math.ceil(OWNER_AVATAR_MAX_BYTES / 3) * 4 + 4;

/**
 * The workbench owner's name and avatar (docs/OWNER.md): one per server, last write wins. `owner.json` holds the
 * record and `owner/<sha256>` the bytes of the current avatar and of every one in its history; the revision rises on every change so a client can tell which of
 * two copies is newer. Every change is synchronous, so two requests never interleave a read-modify-write; a generated
 * avatar is drawn first (asynchronously, by a plugin's style) and only then stored in one synchronous step.
 */
export class OwnerService {
  private readonly file: string;
  private readonly directory: string;
  private readonly listeners = new Set<(owner: OwnerInfo) => void>();
  private readonly styles?: AvatarStyles;
  private state?: Stored;

  /** `avatarStyles` is asked on first use, so it may name something built after this service (the plugin registry). */
  constructor(options: { stateDir: string; avatarStyles?: () => AvatarStyleSource }) {
    this.file = path.join(options.stateDir, 'owner.json');
    this.directory = path.join(options.stateDir, 'owner');
    const source = options.avatarStyles;
    if (source) this.styles = new AvatarStyles({ avatarStyles: () => source().avatarStyles() });
  }

  get(): OwnerInfo { return this.info(this.load()); }

  update(input: OwnerUpdate): OwnerInfo {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('INVALID_OWNER_NAME', 'Owner update must be an object');
    if (input.name === undefined) return this.get();
    if (input.name !== null && typeof input.name !== 'string') throw new AppError('INVALID_OWNER_NAME', 'name must be a string or null');
    const name = input.name?.trim() ?? '';
    if (CONTROL.test(name)) throw new AppError('INVALID_OWNER_NAME', 'name cannot contain control characters');
    if ([...name].length > OWNER_NAME_MAX) throw new AppError('INVALID_OWNER_NAME', `name is limited to ${OWNER_NAME_MAX} characters`);
    const { name: _old, ...rest } = this.load();
    return this.commit({ ...rest, ...(name ? { name } : {}) });
  }

  setAvatar(input: { type: unknown; data: unknown }): OwnerInfo {
    if (!input || typeof input !== 'object') throw new AppError('INVALID_OWNER_AVATAR', 'Avatar must be an object');
    const { type, data } = input;
    if (!OWNER_AVATAR_TYPES.includes(type as OwnerAvatarType)) throw new AppError('INVALID_OWNER_AVATAR', 'Avatar must be a PNG, JPEG or WebP image');
    if (typeof data !== 'string' || !data) throw new AppError('INVALID_OWNER_AVATAR', 'data must be a base64 string');
    // Judged on the encoded length first, so an oversized upload is never decoded.
    if (data.length > MAX_BASE64_LENGTH) throw tooLarge();
    if (data.length % 4 !== 0 || !BASE64.test(data)) throw new AppError('INVALID_OWNER_AVATAR', 'data is not valid base64');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > OWNER_AVATAR_MAX_BYTES) throw tooLarge();
    if (!IMAGE_MAGIC[type as OwnerAvatarType](bytes)) throw new AppError('INVALID_OWNER_AVATAR', 'The image does not match its declared type');
    return this.storeAvatar(bytes, type as OwnerAvatarType);
  }

  /** The enabled plugins' generated avatar styles (docs/OWNER.md「随机头像」). */
  avatarStyles(): OwnerAvatarStyle[] { return this.generator().list(); }

  /** Whether the style's picture depends on the owner's name, so a client cannot keep it for good. */

  /** The preview PNG of a style, drawn with the owner's current name when the style uses one. */
  previewAvatar(styleId: string, query: { seed?: unknown; ink?: unknown; paper?: unknown }): Promise<Buffer> {
    return this.generator().preview(styleId, query, this.load().name);
  }

  /** Draws the avatar a style makes of `request.seed` and stores it like an upload, remembering which style and seed it came from. */
  async generateAvatar(request: unknown): Promise<OwnerInfo> {
    const { png, style, seed } = await this.generator().generate(request, this.load().name);
    return this.storeAvatar(png, 'image/png', { style, seed });
  }

  private generator(): AvatarStyles {
    if (!this.styles) throw new AppError('OWNER_AVATAR_STYLE_NOT_FOUND', 'No such avatar style', 404);
    return this.styles;
  }

  private storeAvatar(bytes: Buffer, type: OwnerAvatarType, generated?: NonNullable<OwnerAvatar['generated']>): OwnerInfo {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const file = path.join(this.directory, sha256);
    // Content-addressed: the same bytes are already in place, and a half-written file is never visible.
    if (!isFile(file)) writeAtomic(file, bytes, 'OWNER_WRITE_FAILED');
    return this.switchAvatar({ sha256, type, size: bytes.length, ...(generated ? { generated } : {}) });
  }

  /** Removing what is not there succeeds without raising the revision; the avatar moves into history. */
  removeAvatar(): OwnerInfo {
    if (!this.load().avatar) return this.get();
    return this.switchAvatar(undefined);
  }

  /** Makes an avatar from the history the current one again; the current one takes its place at the head of the history. */
  restoreAvatar(input: unknown): OwnerInfo {
    const sha256 = input && typeof input === 'object' ? (input as { sha256?: unknown }).sha256 : undefined;
    const entry = typeof sha256 === 'string' ? this.load().history?.find(item => item.sha256 === sha256) : undefined;
    if (!entry) throw notFound();
    return this.switchAvatar(entry);
  }

  /** Forgets one earlier avatar and deletes its file. Forgetting what is not there succeeds without raising the revision. */
  removeHistory(sha256: string): OwnerInfo {
    const { history, ...rest } = this.load();
    if (!history?.some(item => item.sha256 === sha256)) return this.get();
    const kept = history.filter(item => item.sha256 !== sha256);
    const result = this.commit({ ...rest, ...(kept.length ? { history: kept } : {}) });
    this.dropUnreferenced([sha256]);
    return result;
  }

  /** The file of the current avatar or of any in the history; any other address is not found. */
  avatar(sha256: string): { file: string; type: OwnerAvatarType; size: number } {
    const stored = this.load();
    const avatar = SHA256.test(sha256) ? [stored.avatar, ...(stored.history ?? [])].find(item => item?.sha256 === sha256) : undefined;
    if (!avatar) throw notFound();
    const file = path.join(this.directory, sha256);
    if (!isFile(file)) throw notFound();
    return { file, type: avatar.type, size: avatar.size };
  }

  /** The one place the current avatar changes: the old one goes to the history head, the new one leaves it, the oldest beyond the limit is deleted. */
  private switchAvatar(next: StoredAvatar | undefined): OwnerInfo {
    const { avatar: previous, history: earlier, ...rest } = this.load();
    const history = (earlier ?? []).filter(item => item.sha256 !== next?.sha256);
    if (previous && previous.sha256 !== next?.sha256) history.unshift(previous);
    const trimmed = history.splice(OWNER_AVATAR_HISTORY_MAX);
    const result = this.commit({ ...rest, ...(next ? { avatar: next } : {}), ...(history.length ? { history } : {}) });
    this.dropUnreferenced(trimmed.map(item => item.sha256));
    return result;
  }

  subscribe(listener: (owner: OwnerInfo) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private info(stored: Stored): OwnerInfo {
    const withUrl = (avatar: StoredAvatar): OwnerAvatar => ({ ...avatar, url: `/api/owner/avatar/${avatar.sha256}` });
    return {
      revision: stored.revision,
      ...(stored.name ? { name: stored.name } : {}),
      ...(stored.avatar ? { avatar: withUrl(stored.avatar) } : {}),
      ...(stored.history?.length ? { history: stored.history.map(withUrl) } : {}),
      ...(stored.updatedAt ? { updatedAt: stored.updatedAt } : {}),
    };
  }

  private commit(next: Omit<Stored, 'revision' | 'updatedAt'>): OwnerInfo {
    const stored: Stored = { ...next, revision: this.load().revision + 1, updatedAt: new Date().toISOString() };
    writeAtomic(this.file, JSON.stringify(stored, null, 2) + '\n', 'OWNER_WRITE_FAILED');
    this.state = stored;
    const owner = this.info(stored);
    for (const listener of this.listeners) { try { listener(owner); } catch { /* a reader's failure is its own */ } }
    return owner;
  }

  /** A file is only an orphan once neither the current avatar nor the history names it; failing to delete it costs disk, not correctness. */
  private dropUnreferenced(candidates: string[]): void {
    const { avatar, history } = this.load();
    const referenced = new Set([avatar?.sha256, ...(history ?? []).map(item => item.sha256)]);
    for (const sha256 of candidates) {
      if (referenced.has(sha256)) continue;
      try { unlinkSync(path.join(this.directory, sha256)); } catch { /* already gone */ }
    }
  }

  private load(): Stored {
    if (this.state) return this.state;
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(this.file, 'utf8')); } catch (error) {
      // A damaged file must not take bootstrap down with it; the next change rewrites it.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[riffet] owner.json is unreadable; starting from an empty profile');
      return this.state = { revision: 0 };
    }
    // A backup copies the record and the pictures one after the other, so a restored record can name a picture
    // that was deleted in between; such an entry is dropped rather than served as a 404.
    const stored = parseStored(parsed);
    const present = (avatar: StoredAvatar) => isFile(path.join(this.directory, avatar.sha256));
    const { avatar, ...rest } = stored;
    return this.state = { ...rest, ...(avatar && present(avatar) ? { avatar } : {}), ...(stored.history?.length ? { history: stored.history.filter(present) } : {}) };
  }
}

function parseAvatar(value: unknown): StoredAvatar | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const avatar = value as Record<string, unknown>;
  if (typeof avatar.sha256 !== 'string' || !SHA256.test(avatar.sha256) || !OWNER_AVATAR_TYPES.includes(avatar.type as OwnerAvatarType) || !Number.isSafeInteger(avatar.size)) return undefined;
  const generated = avatar.generated as Record<string, unknown> | undefined;
  const validGenerated = generated && typeof generated.style === 'string' && generated.style && typeof generated.seed === 'string' && generated.seed;
  return { sha256: avatar.sha256, type: avatar.type as OwnerAvatarType, size: avatar.size as number, ...(validGenerated ? { generated: { style: generated.style as string, seed: generated.seed as string } } : {}) };
}

function parseStored(value: unknown): Stored {
  const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const avatar = parseAvatar(input.avatar);
  const seen = new Set([avatar?.sha256]);
  const history: StoredAvatar[] = [];
  for (const entry of Array.isArray(input.history) ? input.history : []) {
    const item = parseAvatar(entry);
    if (!item || seen.has(item.sha256) || history.length >= OWNER_AVATAR_HISTORY_MAX) continue;
    seen.add(item.sha256);
    history.push(item);
  }
  return {
    revision: Number.isSafeInteger(input.revision) && (input.revision as number) >= 0 ? input.revision as number : 0,
    ...(typeof input.name === 'string' && input.name ? { name: input.name } : {}),
    ...(avatar ? { avatar } : {}),
    ...(history.length ? { history } : {}),
    ...(typeof input.updatedAt === 'string' ? { updatedAt: input.updatedAt } : {}),
  };
}

const tooLarge = () => new AppError('OWNER_AVATAR_TOO_LARGE', 'The avatar is larger than 1 MiB', 413);
const notFound = () => new AppError('OWNER_AVATAR_NOT_FOUND', 'No such avatar', 404);

function isFile(file: string): boolean { try { return statSync(file).isFile(); } catch { return false; } }

/** Temp file, fsync, rename: a reader sees the old file or the whole new one. Directories are 0700, files 0600. */
function writeAtomic(file: string, content: string | Buffer, code: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  } catch {
    if (fd !== undefined) try { closeSync(fd); } catch { /* close after a failed write */ }
    try { unlinkSync(temp); } catch { /* the temp file may not exist */ }
    throw new AppError(code, 'The personal info could not be saved', 500);
  }
}
