/**
 * The workbench owner's personal info (个人资料, docs/OWNER.md): a name and an avatar, one per server,
 * shared by every device paired with it. Riffet is single-user; this is not an account.
 */

/** Longest name, in Unicode code points, after trimming. */
export const OWNER_NAME_MAX = 32;
/** Clients crop and scale to a square of this side before uploading; the server does not resize. */
export const OWNER_AVATAR_SIDE = 512;
export const OWNER_AVATAR_MAX_BYTES = 1024 * 1024;
export const OWNER_AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type OwnerAvatarType = typeof OWNER_AVATAR_TYPES[number];

export interface OwnerAvatar {
  sha256: string;
  type: OwnerAvatarType;
  size: number;
  /** `/api/owner/avatar/<sha256>`: content-addressed, cached for good. */
  url: string;
  /** Set when the avatar came from a generated style rather than an upload. */
  generated?: { style: string; seed: string };
}

/** `GET /api/owner`, `bootstrap.owner`, and the `owner` event of `/api/lists/stream`. */
export interface OwnerInfo {
  /** Raised on every change. */
  revision: number;
  name?: string;
  avatar?: OwnerAvatar;
  /** Earlier avatars, most recently used first, at most {@link OWNER_AVATAR_HISTORY_MAX}; never includes the current one. */
  history?: OwnerAvatar[];
  updatedAt?: string;
}

/** How many earlier avatars are kept; the oldest beyond this is deleted. */
export const OWNER_AVATAR_HISTORY_MAX = 12;
/** `POST /api/owner/avatar/restore` → {@link OwnerInfo}: an entry of `history` becomes the avatar again, and the current one moves into history. `DELETE /api/owner/avatar/history/:sha256` drops one entry. */
export interface OwnerAvatarRestore { sha256: string }

/** `PATCH /api/owner`: an empty or null name clears it. */
export interface OwnerUpdate { name?: string | null }

/** `PUT /api/owner/avatar`; `DELETE /api/owner/avatar` removes it (into history). Both answer the new {@link OwnerInfo}. */
export interface OwnerAvatarUpload { type: OwnerAvatarType; data: string /* base64 */ }

/** Longest seed a client may send; a client makes up a random one per roll. */
export const OWNER_AVATAR_SEED_MAX = 64;
/** Side of `GET /api/owner/avatar-styles/<style>/preview`, in pixels. */
export const OWNER_AVATAR_PREVIEW_SIDE = 128;

/** An enabled plugin's generated avatar style, from `GET /api/owner/avatar-styles` → `{ styles }`. */
export interface OwnerAvatarStyle {
  /** Contribution id, `<pluginId>/<name>`. */
  id: string;
  pluginId: string;
  title: Record<string, string>;
  credit?: string;
  /** Draws the owner's name; offered only when there is one. */
  needsName?: boolean;
}

/**
 * `POST /api/owner/avatar/generate` → {@link OwnerInfo}; `GET /api/owner/avatar-styles/<style>/preview?seed&ink&paper`
 * → PNG of {@link OWNER_AVATAR_PREVIEW_SIDE}. `ink` and `paper` are `#rrggbb` from the client's current theme; the
 * server's neutral pair is used without them. The same request always gives the same picture.
 */
export interface OwnerAvatarGenerateRequest { style: string; seed: string; ink?: string; paper?: string }

/** What an avatar-less owner is drawn as: the name's first character, upper-cased; none without a name. */
export function ownerMonogram(name: string | undefined): string | undefined {
  const trimmed = name?.trim();
  if (!trimmed) return undefined;
  const first = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(trimmed)[Symbol.iterator]().next().value?.segment;
  return first?.toLocaleUpperCase();
}
