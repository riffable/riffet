import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StatementSync } from 'node:sqlite';
import type { Mark, MarkAnchor, MarkAsset, MarkColor, MarkFacets, MarkKind, MarkListPage, MarkListQuery, MarkLocation, MarkPrompt, MarkQuote, NativeBackendId, Run, Session, WorkbenchEvent } from '../../../packages/contracts/src/index.js';
import { AppError, requireString } from './errors.js';
import { isNativeBackendId } from './backends/registry.js';
import { likePattern, MAX_INDEXED_TEXT, MAX_TOOL_INDEXED_TEXT } from './search/messages.js';
import type { Store } from './store.js';

/** Bytes kept of a message's text; a mark is a pointer with a readable copy, not an archive of the answer. */
const MAX_SNAPSHOT_BYTES = 32 * 1024;
const MAX_QUOTE_BYTES = 4 * 1024;
const MAX_NOTE_BYTES = 4 * 1024;
const MAX_PROMPT_BYTES = 4 * 1024;
/** W3C selectors use ~32 characters of context; a little more disambiguates repetitive answers. */
const MAX_CONTEXT_CHARS = 200;
/** How much of a whole-message snapshot is searched for when its ids no longer lead anywhere. */
const OPENING_CHARS = 200;
const KINDS: readonly MarkKind[] = ['message', 'span', 'image', 'file'];
/** An image is kept whole: a thumbnail would lose what someone saved it to look at again. */
export const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const COLORS: readonly MarkColor[] = ['yellow', 'green', 'blue', 'red'];

const now = () => new Date().toISOString();
/**
 * The text reduced to its letters and digits, lower-cased. A quote is taken from the rendered answer
 * (no `**`, `#`, list numbers or link targets, a client's own spacing) while the index and
 * transcripts keep the Markdown source; their skeletons are the same.
 */
const skeleton = (text: string) => text
  // What Markdown keeps out of the rendered text: list numbers and link targets.
  .replace(/^[ \t>]*\d+[.)][ \t]+/gm, '')
  .replace(/\]\([^)\s]*(?:\s+"[^"]*")?\)/g, ']')
  .replace(/[^\p{L}\p{N}]+/gu, '')
  .toLowerCase();
/** Live Claude turns are keyed by the workbench command (`claude:…:run:<commandId>:<type>`); the transcript renames them. */
const liveRunCommand = (messageId: string) => /:run:([^:]+):/.exec(messageId)?.[1];

function capBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  // A cut inside a multi-byte character decodes to U+FFFD; drop it rather than store half a character.
  return Buffer.from(text).subarray(0, max).toString('utf8').replace(/�+$/, '');
}
function optionalString(value: unknown, name: string, max: number): string | undefined {
  return value === undefined ? undefined : requireString(value, name, max);
}
function color(value: unknown): MarkColor {
  if (!COLORS.includes(value as MarkColor)) throw new AppError('INVALID_MARK_COLOR', `color must be one of ${COLORS.join(', ')}`);
  return value as MarkColor;
}
function note(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_NOTE_BYTES) throw new AppError('INVALID_MARK_NOTE', 'note must be text of at most 4 KiB');
  return value;
}

function anchorOf(value: unknown): MarkAnchor {
  const input = value as Partial<MarkAnchor> | undefined;
  if (!input || typeof input !== 'object') throw new AppError('INVALID_MARK_ANCHOR', 'anchor is required');
  const messageId = requireString(input.messageId, 'anchor.messageId', 1000);
  if (input.aliases !== undefined && (!Array.isArray(input.aliases) || input.aliases.length > 20 || input.aliases.some(alias => typeof alias !== 'string' || !alias || alias.length > 500))) {
    throw new AppError('INVALID_MARK_ANCHOR', 'anchor.aliases must be at most 20 short strings');
  }
  if (input.sequence !== undefined && (!Number.isSafeInteger(input.sequence) || input.sequence < 0)) throw new AppError('INVALID_MARK_ANCHOR', 'anchor.sequence must be a non-negative integer');
  const runId = optionalString(input.runId, 'anchor.runId', 200);
  // Such an id is gone once the turn is written to the transcript; only its run can find the message again.
  if (liveRunCommand(messageId) && !runId) throw new AppError('UNSTABLE_MARK_ANCHOR', 'This message is still being written; mark it with its runId or after the turn ends');
  const nativeTurnId = optionalString(input.nativeTurnId, 'anchor.nativeTurnId', 200), generation = optionalString(input.generation, 'anchor.generation', 128);
  return {
    messageId,
    ...(input.aliases?.length ? { aliases: [...new Set(input.aliases)] } : {}),
    ...(runId ? { runId } : {}), ...(nativeTurnId ? { nativeTurnId } : {}),
    ...(input.sequence !== undefined ? { sequence: input.sequence } : {}), ...(generation ? { generation } : {}),
  };
}

function quoteOf(value: unknown): MarkQuote {
  const input = value as Partial<MarkQuote> | undefined;
  if (!input || typeof input !== 'object' || typeof input.exact !== 'string' || !input.exact.trim()) throw new AppError('INVALID_MARK_QUOTE', 'A span needs quote.exact');
  if (typeof input.prefix !== 'string' || typeof input.suffix !== 'string') throw new AppError('INVALID_MARK_QUOTE', 'quote.prefix and quote.suffix must be strings');
  for (const key of ['start', 'end'] as const) {
    if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || input[key]! < 0)) throw new AppError('INVALID_MARK_QUOTE', `quote.${key} must be a non-negative integer`);
  }
  // A cut quote still starts where the highlight did, so it keeps anchoring; its suffix no longer adjoins it.
  const exact = capBytes(input.exact, MAX_QUOTE_BYTES), cut = exact !== input.exact;
  return {
    exact, prefix: input.prefix.slice(-MAX_CONTEXT_CHARS), suffix: cut ? '' : input.suffix.slice(0, MAX_CONTEXT_CHARS),
    ...(input.start !== undefined ? { start: input.start } : {}),
    ...(input.end !== undefined && !cut ? { end: input.end } : {}),
  };
}

/** The asset of an `image` or `file` mark, and an image's bytes to keep. */
function assetOf(value: unknown, kind: MarkKind): { asset: MarkAsset; data?: Buffer } {
  const body = value as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') throw new AppError('INVALID_MARK_ASSET', `A saved ${kind} needs what it saved`);
  const name = requireString(body.name, 'asset.name', 300);
  const path = optionalString(body.path, 'asset.path', 4096);
  const mimeType = optionalString(body.mimeType, 'asset.mimeType', 100);
  const detail = optionalString(body.detail, 'asset.detail', 200);
  const asset: MarkAsset = { name, ...(path ? { path } : {}), ...(mimeType ? { mimeType } : {}), ...(detail ? { detail } : {}) };
  if (kind === 'file') return { asset };
  if (!mimeType?.startsWith('image/') || mimeType.includes('svg')) throw new AppError('INVALID_MARK_ASSET', 'A saved image must be a raster image');
  if (typeof body.data !== 'string' || !body.data) throw new AppError('INVALID_MARK_ASSET', 'A saved image needs its data');
  const data = Buffer.from(body.data, 'base64');
  if (!data.length || data.length > MAX_ASSET_BYTES) throw new AppError('MARK_ASSET_TOO_LARGE', 'A saved image must be at most 10 MiB', 413);
  return { asset: { ...asset, bytes: data.length, stored: true }, data };
}

/** One assistant message of a conversation as locate sees it: from the provider's transcript, or from the search index. */
interface Candidate { messageId: string; aliases: string[]; runId?: string; nativeTurnId?: string; sequence?: number; text: string; norm: string; truncated: boolean }

/**
 * Assistant messages in transcript order, with each message's chunks joined like the search index
 * joins them, and the transcript turn each workbench command became. With [assets], tool calls and
 * pictures count too, as what an image or file mark points at; a tool call reads as its name, path
 * and command, as the search index has it.
 */
function transcriptCandidates(events: readonly WorkbenchEvent[], assets = false): { candidates: Candidate[]; turnByCommand: Map<string, string> } {
  const byId = new Map<string, Omit<Candidate, 'norm' | 'truncated'>>(), turnByCommand = new Map<string, string>();
  for (const event of events) {
    const data = event.data as { content?: { type?: unknown; text?: unknown }; commandId?: unknown } | undefined;
    if (event.type === 'user_message_chunk' && typeof data?.commandId === 'string' && event.runId) turnByCommand.set(data.commandId, event.runId);
    const text = event.type === 'agent_message_chunk' && data?.content?.type === 'text' && typeof data.content.text === 'string' ? data.content.text
      : assets ? assetText(event) : undefined;
    if (text === undefined) continue;
    const native = event as WorkbenchEvent & { nativeId?: unknown; nativeAliases?: unknown; nativeTurnId?: unknown };
    const messageId = typeof native.nativeId === 'string' && native.nativeId ? native.nativeId : `${event.sequence}`;
    const aliases = Array.isArray(native.nativeAliases) ? native.nativeAliases.filter((alias): alias is string => typeof alias === 'string') : [];
    const existing = byId.get(messageId);
    if (existing) {
      if (existing.text.length < MAX_SNAPSHOT_BYTES * 2) existing.text += text;
      for (const alias of aliases) if (!existing.aliases.includes(alias)) existing.aliases.push(alias);
      continue;
    }
    byId.set(messageId, {
      messageId, aliases, text, sequence: event.sequence,
      ...(event.runId ? { runId: event.runId } : {}), ...(typeof native.nativeTurnId === 'string' ? { nativeTurnId: native.nativeTurnId } : {}),
    });
  }
  return { candidates: [...byId.values()].map(candidate => ({ ...candidate, norm: skeleton(candidate.text), truncated: false })), turnByCommand };
}

/** What a tool call or picture contributes to locating an image or file mark; nothing for other events. */
function assetText(event: WorkbenchEvent): string | undefined {
  const data = event.data as { content?: { type?: unknown }; toolName?: unknown; title?: unknown; filePath?: unknown; command?: unknown } | undefined;
  if (data?.content?.type === 'image') return '';
  if (event.type !== 'tool_call' && event.type !== 'tool_call_update') return undefined;
  return [data?.toolName, data?.title, data?.filePath, data?.command].filter((part): part is string => typeof part === 'string').join(' ');
}

/**
 * Finds the mark's message among `candidates`: by alias, by id, within its run, then by its text.
 * An alias is identity and needs no proof; an id is checked against the text, because positional
 * ids (Cursor) point at a different message after a rewind.
 */
function relocate(mark: Mark, candidates: readonly Candidate[], runIds: ReadonlySet<string>): Candidate | undefined {
  const quote = mark.quote ? skeleton(mark.quote.exact) : '';
  const context = mark.quote ? skeleton(`${mark.quote.prefix}${mark.quote.exact}`) : '';
  const opening = skeleton(mark.snapshot.text).slice(0, OPENING_CHARS);
  // A file is found by its path; a picture has no words, so only its ids lead back to it.
  const assetKey = mark.asset ? skeleton(mark.asset.path ?? mark.asset.name) : '';
  const matches = (candidate: Candidate) => {
    if (mark.kind === 'image') return false;
    if (mark.kind === 'file') return Boolean(assetKey) && candidate.norm.includes(assetKey);
    if (mark.kind === 'span') return candidate.norm.includes(quote);
    if (!opening) return false;
    return candidate.norm.startsWith(opening) || candidate.norm.includes(opening)
      // A snapshot of a whole turn's answer runs on past its first message.
      || (candidate.norm.length >= Math.min(40, opening.length) && opening.startsWith(candidate.norm));
  };
  // A draft (`-draft:`) is the same answer while it was streaming; the settled message is the one to keep.
  const best = (all: readonly Candidate[]) => {
    const found = [...all.filter(candidate => !candidate.messageId.includes('-draft:')), ...all.filter(candidate => candidate.messageId.includes('-draft:'))];
    return found.find(candidate => candidate.messageId === mark.anchor.messageId)
      ?? (context ? found.find(candidate => candidate.norm.includes(context)) : undefined) ?? found.find(matches) ?? found[0];
  };
  const aliases = (mark.anchor.aliases ?? []).filter(Boolean);
  const byAlias = () => best(candidates.filter(candidate => aliases.some(alias => candidate.aliases.includes(alias)
    // The index keeps no aliases, but Claude's ids embed the transcript uuid that is its alias.
    || (alias.length >= 8 && candidate.messageId.split(':').includes(alias)))));
  const byId = () => candidates.find(candidate => candidate.messageId === mark.anchor.messageId && (mark.kind === 'image' || matches(candidate)));
  const byRun = () => {
    const inRun = candidates.filter(candidate => candidate.runId && runIds.has(candidate.runId));
    if (!inRun.length) return undefined;
    const found = inRun.filter(matches);
    if (found.length) return best(found);
    if (mark.kind !== 'message') return undefined;
    // The closest start: the answer may have been marked while it was still being written.
    let pick: Candidate | undefined, score = 0;
    for (const candidate of inRun) {
      let shared = 0;
      while (shared < opening.length && shared < candidate.norm.length && opening[shared] === candidate.norm[shared]) shared += 1;
      if (shared > score) { pick = candidate; score = shared; }
    }
    return score >= Math.min(20, opening.length) ? pick : undefined;
  };
  const byText = () => { const found = candidates.filter(matches); return found.length ? best(found) : undefined; };
  // Only the index had it, and too little of its text to check the quote against.
  const byIdUnchecked = () => candidates.find(candidate => candidate.messageId === mark.anchor.messageId && candidate.truncated);
  const order = liveRunCommand(mark.anchor.messageId) ? [byAlias, byRun, byId, byText] : [byAlias, byId, byRun, byText, byIdUnchecked];
  for (const step of order) { const found = step(); if (found) return found; }
  return undefined;
}

interface MarkRow { json: string; title: string | null; live: number }
const encodeCursor = (mark: Pick<Mark, 'createdAt' | 'id'>) => Buffer.from(JSON.stringify([mark.createdAt, mark.id])).toString('base64url');
function decodeCursor(value: string): [string, string] {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && parsed.length === 2 && parsed.every(part => typeof part === 'string')) return parsed as [string, string];
  } catch { /* falls through */ }
  throw new AppError('INVALID_MARK_CURSOR', 'cursor is invalid');
}

/**
 * Saved replies (收藏), stored in the workbench database beside the conversations they point at.
 * Every committed write moves `Store.marksRevision`, which is the marks ETag and rides on the
 * lists stream's `changed` event.
 */
export class MarkStore {
  private readonly statements = new Map<string, StatementSync>();
  /** [assets] is where images are kept, one file per mark named by its id. */
  constructor(private readonly store: Store, private readonly assets?: string) {}
  /** Where mark [id]'s image is kept. */
  assetFile(id: string): string | undefined {
    return this.assets ? join(this.assets, encodeURIComponent(id)) : undefined;
  }
  private sql(text: string): StatementSync {
    let statement = this.statements.get(text);
    if (!statement) this.statements.set(text, statement = this.store.db.prepare(text));
    return statement;
  }
  /** A mark as clients see it: the conversation's current title, and orphaned once the conversation is gone. */
  private read(row: MarkRow): Mark {
    const mark = JSON.parse(row.json) as Mark;
    if (!row.live) mark.state = 'orphaned';
    if (row.title) mark.snapshot.sessionTitle = row.title;
    return mark;
  }
  private find(where: string, ...params: Array<string | number>): Mark | undefined {
    const row = this.sql(`SELECT m.json AS json, json_extract(s.json,'$.title') AS title, s.id IS NOT NULL AS live
      FROM marks m LEFT JOIN sessions s ON s.id=m.session_id WHERE ${where} LIMIT 1`).get(...params) as MarkRow | undefined;
    return row ? this.read(row) : undefined;
  }
  get(id: string): Mark {
    const mark = this.find('m.id=?', id);
    if (!mark) throw new AppError('MARK_NOT_FOUND', 'This saved reply does not exist', 404);
    return mark;
  }

  /**
   * The prompt mark [id]'s answer replied to: the last indexed user message written before the
   * answer. Only the search index is read, so a conversation never indexed has none. `model` is the
   * one the answer's run used, or the conversation's current one when the run is not known.
   */
  prompt(id: string): MarkPrompt {
    const mark = this.get(id);
    const text = this.store.latestIndexedPromptBefore(mark.sessionId, mark.snapshot.at);
    let run: Run | undefined;
    try { run = mark.anchor.runId ? this.store.getRun(mark.anchor.runId) : undefined; } catch { run = undefined; }
    const model = run?.native?.resolvedConfig?.model ?? run?.native?.config.model ?? this.store.findSession(mark.sessionId)?.model;
    return { ...(text ? { text: capBytes(text, MAX_PROMPT_BYTES) } : {}), ...(model ? { model } : {}) };
  }

  list(query: { [K in keyof MarkListQuery]?: unknown }, limit: number, excludeTaskWorkspaces = false): MarkListPage {
    const where: string[] = [], params: Array<string | number> = [];
    if (excludeTaskWorkspaces) where.push("m.project_id NOT IN (SELECT id FROM projects WHERE json_extract(json,'$.system')='task-workspace')");
    const filter = (value: unknown, name: string, clause: string, allowed?: (value: string) => boolean) => {
      if (value === undefined || value === '') return;
      const text = requireString(value, name, 200);
      if (allowed && !allowed(text)) throw new AppError('INVALID_MARK_FILTER', `${name} is not a known value`);
      where.push(clause); params.push(text);
    };
    filter(query.sessionId, 'sessionId', 'm.session_id=?');
    filter(query.projectId, 'projectId', 'm.project_id=?');
    filter(query.backendId, 'backendId', "json_extract(m.json,'$.backendId')=?", isNativeBackendId);
    const kinds = (Array.isArray(query.kind) ? query.kind : query.kind === undefined || query.kind === '' ? [] : [query.kind]).map(value => requireString(value, 'kind', 20));
    if (kinds.some(value => !KINDS.includes(value as MarkKind)) || kinds.length > KINDS.length) throw new AppError('INVALID_MARK_FILTER', 'kind is not a known value');
    if (kinds.length) { where.push(`json_extract(m.json,'$.kind') IN (${kinds.map(() => '?').join(',')})`); params.push(...kinds); }
    filter(query.state, 'state', "(CASE WHEN s.id IS NULL THEN 'orphaned' ELSE json_extract(m.json,'$.state') END)=?", value => value === 'ok' || value === 'orphaned');
    if (typeof query.q === 'string' && query.q.trim()) {
      const pattern = likePattern(requireString(query.q.trim(), 'q', 200));
      where.push(`(${["json_extract(m.json,'$.snapshot.text')", "json_extract(m.json,'$.quote.exact')", "json_extract(m.json,'$.note')", "json_extract(m.json,'$.snapshot.sessionTitle')", "json_extract(s.json,'$.title')"]
        .map(field => `${field} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
      params.push(pattern, pattern, pattern, pattern, pattern);
    }
    const from = 'FROM marks m LEFT JOIN sessions s ON s.id=m.session_id';
    const total = (this.sql(`SELECT COUNT(*) AS total ${from}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`).get(...params) as { total: number }).total;
    if (typeof query.cursor === 'string' && query.cursor) {
      const [createdAt, id] = decodeCursor(query.cursor);
      where.push('(m.created_at<? OR (m.created_at=? AND m.id<?))'); params.push(createdAt, createdAt, id);
    }
    const rows = this.sql(`SELECT m.json AS json, json_extract(s.json,'$.title') AS title, s.id IS NOT NULL AS live ${from}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`).all(...params, limit + 1) as unknown as MarkRow[];
    const marks = rows.slice(0, limit).map(row => this.read(row));
    return { marks, ...(rows.length > limit ? { nextCursor: encodeCursor(marks.at(-1)!) } : {}), total };
  }

  /** Distinct project and agent ids that actually hold at least one mark. */
  facets(excludeTaskWorkspaces = false): MarkFacets {
    const where = excludeTaskWorkspaces ? "WHERE m.project_id NOT IN (SELECT id FROM projects WHERE json_extract(json,'$.system')='task-workspace')" : '';
    const projectRows = this.sql(`SELECT DISTINCT m.project_id AS projectId FROM marks m ${where}`).all() as Array<{ projectId: string }>;
    const backendRows = this.sql(`SELECT DISTINCT json_extract(m.json,'$.backendId') AS backendId FROM marks m ${where}`).all() as Array<{ backendId: string | null }>;
    return {
      projectIds: projectRows.map(row => row.projectId),
      backendIds: backendRows.map(row => row.backendId).filter((id): id is NativeBackendId => typeof id === 'string' && isNativeBackendId(id)),
    };
  }

  /**
   * Idempotent on `id`; a second mark of the same message, or of the same span of it, returns the
   * first rather than stacking up duplicates from two devices.
   */
  create(value: unknown): Mark {
    const body = value as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object') throw new AppError('INVALID_MARK', 'A saved reply is required');
    const id = requireString(body.id, 'id', 100), sessionId = requireString(body.sessionId, 'sessionId', 100);
    const kind = body.kind as MarkKind;
    if (!KINDS.includes(kind)) throw new AppError('INVALID_MARK_KIND', 'kind must be message, span, image or file');
    const anchor = anchorOf(body.anchor);
    if (kind !== 'span' && body.quote !== undefined) throw new AppError('INVALID_MARK_QUOTE', 'Only a highlight has a quote');
    if ((kind === 'message' || kind === 'span') && body.asset !== undefined) throw new AppError('INVALID_MARK_ASSET', 'Only an image or file mark has an asset');
    const saved = kind === 'image' || kind === 'file' ? assetOf(body.asset, kind) : undefined;
    if (saved?.data && !this.assets) throw new AppError('MARK_ASSETS_UNAVAILABLE', 'This server cannot keep images', 503);
    const quote = kind === 'span' ? quoteOf(body.quote) : undefined;
    const snapshot = body.snapshot as { text?: unknown; at?: unknown } | undefined;
    if (!snapshot || typeof snapshot.text !== 'string' || typeof snapshot.at !== 'string' || !Number.isFinite(Date.parse(snapshot.at))) {
      throw new AppError('INVALID_MARK_SNAPSHOT', 'snapshot needs the message text and when it was written');
    }
    const snapshotText = capBytes(snapshot.text, MAX_SNAPSHOT_BYTES), snapshotAt = new Date(snapshot.at).toISOString();
    const noteText = body.note === undefined || body.note === '' ? undefined : note(body.note);
    const markColor = body.color === undefined ? undefined : color(body.color);
    return this.store.transaction(() => {
      const existing = this.find('m.id=?', id);
      if (existing) return existing;
      const session: Session = this.store.getSession(sessionId);
      const duplicate = saved
        ? this.find(`m.session_id=? AND json_extract(m.json,'$.kind')=? AND json_extract(m.json,'$.anchor.messageId')=? AND json_extract(m.json,'$.asset.name')=? AND coalesce(json_extract(m.json,'$.asset.path'),'')=?`, sessionId, kind, anchor.messageId, saved.asset.name, saved.asset.path ?? '')
        : quote
        ? this.find(`m.session_id=? AND json_extract(m.json,'$.kind')='span' AND json_extract(m.json,'$.anchor.messageId')=? AND json_extract(m.json,'$.quote.exact')=? AND json_extract(m.json,'$.quote.prefix')=?`, sessionId, anchor.messageId, quote.exact, quote.prefix)
        : this.find(`m.session_id=? AND json_extract(m.json,'$.kind')='message' AND json_extract(m.json,'$.anchor.messageId')=?`, sessionId, anchor.messageId);
      if (duplicate) return duplicate;
      const stamp = now();
      const mark: Mark = {
        id, sessionId, projectId: session.projectId, ...(session.backendId ? { backendId: session.backendId } : {}),
        kind, anchor, ...(quote ? { quote } : {}), ...(saved ? { asset: saved.asset } : {}),
        snapshot: { text: snapshotText, sessionTitle: session.displayTitle ?? session.title, at: snapshotAt },
        ...(noteText !== undefined ? { note: noteText } : {}), ...(markColor ? { color: markColor } : {}),
        state: 'ok', createdAt: stamp, updatedAt: stamp,
      };
      // Written before the row: a row whose image is missing would be worse than an image without a row.
      if (saved?.data) { mkdirSync(this.assets!, { recursive: true, mode: 0o700 }); writeFileSync(this.assetFile(id)!, saved.data, { mode: 0o600 }); }
      this.sql('INSERT INTO marks(id,session_id,project_id,created_at,json) VALUES(?,?,?,?,?)').run(id, sessionId, mark.projectId, stamp, JSON.stringify(mark));
      this.store.marksChanged();
      return mark;
    });
  }

  /** `null` clears a field; an absent one stays as it is. */
  update(id: string, value: unknown): Mark {
    const body = (value ?? {}) as Record<string, unknown>;
    if (typeof body !== 'object') throw new AppError('INVALID_MARK', 'A change is required');
    const noteText = body.note === undefined || body.note === null ? body.note : note(body.note);
    const markColor = body.color === undefined || body.color === null ? body.color : color(body.color);
    return this.patch(id, mark => {
      if (noteText === null || noteText === '') delete mark.note; else if (noteText !== undefined) mark.note = noteText;
      if (markColor === null) delete mark.color; else if (markColor !== undefined) mark.color = markColor;
    });
  }
  private patch(id: string, change: (mark: Mark) => void): Mark {
    return this.store.transaction(() => {
      const row = this.sql('SELECT json FROM marks WHERE id=?').get(id) as { json: string } | undefined;
      if (!row) throw new AppError('MARK_NOT_FOUND', 'This saved reply does not exist', 404);
      const mark = JSON.parse(row.json) as Mark;
      change(mark);
      const next = JSON.stringify({ ...mark, updatedAt: now() });
      this.sql('UPDATE marks SET json=? WHERE id=?').run(next, id);
      this.store.marksChanged();
      return this.get(id);
    });
  }

  /** Deleting what is already gone succeeds, so a retried or offline-queued delete settles. */
  remove(ids: readonly string[]): number {
    return this.store.transaction(() => {
      let removed = 0;
      for (const id of ids) {
        removed += Number(this.sql('DELETE FROM marks WHERE id=?').run(id).changes);
        const file = this.assetFile(id);
        if (file) rmSync(file, { force: true });
      }
      if (removed) this.store.marksChanged();
      return removed;
    });
  }

  /**
   * Where the mark's message is now. The search index answers when it still holds the message under
   * the same id; otherwise the provider's transcript is read once (`readTranscript` returns nothing
   * for providers that cannot be read without starting them). A message found under another id is
   * re-anchored there; one found nowhere leaves the mark orphaned, with its snapshot to read.
   */
  async locate(id: string, readTranscript: (sessionId: string) => Promise<readonly WorkbenchEvent[]>): Promise<MarkLocation> {
    const mark = this.get(id);
    const live = this.sql('SELECT 1 AS found FROM sessions WHERE id=?').get(mark.sessionId);
    if (!live) return { found: false, mark: this.settle(mark, undefined) };
    const assets = mark.kind === 'image' || mark.kind === 'file';
    const indexed = this.store.indexedCandidatesForMark(mark.sessionId, assets)
      .map(row => ({
        messageId: row.messageId,
        aliases: [],
        text: row.text,
        norm: skeleton(row.text),
        truncated: row.kind === 'tool' ? row.text.length >= MAX_TOOL_INDEXED_TEXT - 16 : row.text.length >= MAX_INDEXED_TEXT - 100,
      }) satisfies Candidate);
    let found = liveRunCommand(mark.anchor.messageId) ? undefined : relocate({ ...mark, anchor: { messageId: mark.anchor.messageId } }, indexed.filter(row => row.messageId === mark.anchor.messageId && !row.truncated), new Set());
    if (!found) {
      let events: readonly WorkbenchEvent[] = [];
      try { events = await readTranscript(mark.sessionId); } catch { /* the index alone still answers */ }
      const { candidates, turnByCommand } = transcriptCandidates(events, assets);
      const seen = new Set(candidates.map(candidate => candidate.messageId));
      const runIds = new Set<string>();
      if (mark.anchor.runId) {
        runIds.add(mark.anchor.runId);
        let commandId = liveRunCommand(mark.anchor.messageId);
        try { commandId ??= this.store.getRun(mark.anchor.runId).commandId; } catch { /* a transcript turn id, not a workbench run */ }
        const turn = commandId ? turnByCommand.get(commandId) : undefined;
        if (turn) runIds.add(turn);
      }
      found = relocate(mark, [...candidates, ...indexed.filter(row => !seen.has(row.messageId))], runIds);
      // Pictures are not indexed, and some providers' transcripts cannot be read from here: with
      // nothing to check against, the saved place is the best guess, and the client looks for it.
      if (!found && assets && !events.length) return { found: true, mark, messageId: mark.anchor.messageId, ...(mark.anchor.runId ? { runId: mark.anchor.runId } : {}), ...(mark.anchor.sequence !== undefined ? { sequence: mark.anchor.sequence } : {}) };
    }
    const settled = this.settle(mark, found);
    if (!found) return { found: false, mark: settled };
    const anchor = settled.anchor;
    return { found: true, mark: settled, messageId: anchor.messageId, ...(anchor.runId ? { runId: anchor.runId } : {}), ...(anchor.sequence !== undefined ? { sequence: anchor.sequence } : {}) };
  }
  /** Writes the outcome only when it changes something, so locating a healthy mark is a read. */
  private settle(mark: Mark, found: Candidate | undefined): Mark {
    const state: Mark['state'] = found ? 'ok' : 'orphaned';
    const same = found?.messageId === mark.anchor.messageId;
    const anchor: MarkAnchor = !found ? mark.anchor : {
      ...mark.anchor, messageId: found.messageId,
      ...(found.aliases.length ? { aliases: found.aliases } : same ? {} : { aliases: undefined }),
      runId: found.runId ?? (same ? mark.anchor.runId : undefined),
      nativeTurnId: found.nativeTurnId ?? (same ? mark.anchor.nativeTurnId : undefined),
      sequence: found.sequence ?? (same ? mark.anchor.sequence : undefined),
    };
    for (const key of Object.keys(anchor) as Array<keyof MarkAnchor>) if (anchor[key] === undefined) delete anchor[key];
    const stored = this.sql('SELECT json FROM marks WHERE id=?').get(mark.id) as { json: string } | undefined;
    const current = stored ? JSON.parse(stored.json) as Mark : undefined;
    if (!current || (current.state === state && JSON.stringify(current.anchor) === JSON.stringify(anchor))) return { ...mark, state, anchor };
    try { return this.patch(mark.id, next => { next.state = state; next.anchor = anchor; }); }
    catch { return { ...mark, state, anchor }; }
  }
}
