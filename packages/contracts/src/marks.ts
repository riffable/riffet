import type { NativeBackendId } from './agent-ids.js';

/**
 * A saved reply (收藏): a whole assistant answer, or a highlighted span inside one. See docs/MARKS.md.
 *
 * Native message ids are only as stable as their backend makes them, so a mark keeps several ways back
 * to its message (anchor) plus a copy of the text (snapshot) that stays readable when none of them work.
 */
/** `image` and `file` save something an agent showed or touched on the way: a picture, a file it read or wrote. */
export type MarkKind = 'message' | 'span' | 'image' | 'file';
export type MarkColor = 'yellow' | 'green' | 'blue' | 'red';
export interface MarkAnchor {
  /** The message's `nativeId` when the mark was made. */
  messageId: string;
  /** `nativeAliases` of that message, e.g. Claude's transcript uuid, which outlives a provider session id change. */
  aliases?: string[];
  runId?: string; nativeTurnId?: string;
  /** Event sequence, for clients that focus by sequence. */
  sequence?: number;
  /** Native history generation at the time; a different one means positional ids may have shifted. */
  generation?: string;
}
/** A W3C TextQuoteSelector over the message's rendered plain text; offsets are hints only. */
export interface MarkQuote { exact: string; prefix: string; suffix: string; start?: number; end?: number }
export interface MarkSnapshot {
  /** The whole message (or the turn's answer) as plain text, capped by the server. */
  text: string;
  sessionTitle: string;
  /** When the marked message was written. */
  at: string;
}
/** What an `image` or `file` mark saved. */
export interface MarkAsset {
  /** File name, shown on the card. */
  name: string;
  /** Where it was: a path inside the project, or absolute. Absent for an image that only ever existed inline. */
  path?: string;
  mimeType?: string;
  bytes?: number;
  /** An image's copy, kept by the server so it outlives the file and the conversation: `GET /api/marks/:id/asset`. */
  stored?: boolean;
  /** For a file: what the agent did with it, e.g. `写入` or `+12 −3`. */
  detail?: string;
}
export interface Mark {
  id: string;
  sessionId: string; projectId: string; backendId?: NativeBackendId;
  kind: MarkKind;
  anchor: MarkAnchor;
  /** Present exactly when `kind` is `span`. */
  quote?: MarkQuote;
  /** Present exactly when `kind` is `image` or `file`. */
  asset?: MarkAsset;
  snapshot: MarkSnapshot;
  note?: string;
  color?: MarkColor;
  /** `orphaned` once the message can no longer be found, including after its conversation is deleted. */
  state: 'ok' | 'orphaned';
  createdAt: string; updatedAt: string;
}
/** `POST /api/marks`. `id` is client-generated and makes the request idempotent. */
export interface MarkCreateRequest {
  id: string; sessionId: string; kind: MarkKind;
  anchor: MarkAnchor; quote?: MarkQuote;
  /** For `image`: `data` is the picture, base64, at most 10 MiB; the server keeps it. */
  asset?: Omit<MarkAsset, 'stored' | 'bytes'> & { data?: string };
  snapshot: { text: string; at: string };
  note?: string; color?: MarkColor;
}
/** `PATCH /api/marks/:id`. `null` clears a field. */
export interface MarkUpdateRequest { note?: string | null; color?: MarkColor | null }
/** `GET /api/marks` query: every filter is optional; `q` searches snapshot, quote and note. */
export interface MarkListQuery {
  sessionId?: string; projectId?: string; backendId?: NativeBackendId;
  /** One kind, or several (`kind=image&kind=file`). */
  kind?: MarkKind | MarkKind[]; state?: Mark['state']; q?: string;
  limit?: number; cursor?: string;
}
/** Newest first. */
export interface MarkListPage { marks: Mark[]; nextCursor?: string; total: number }
/** `GET /api/marks/:id/locate`: where the message is now. `found: false` also marks it orphaned. */
export type MarkLocation =
  | { found: true; mark: Mark; messageId: string; runId?: string; sequence?: number }
  | { found: false; mark: Mark };
/**
 * `GET /api/marks/:id/prompt`: the user message that led to the marked answer, and the model that wrote it
 * (the run's, else the conversation's current one, as a model selection value); each is absent when it is not known.
 */
export interface MarkPrompt { text?: string; model?: string }
/** Distinct projects and agents that currently have at least one saved reply. */
export interface MarkFacets { projectIds: string[]; backendIds: NativeBackendId[] }
