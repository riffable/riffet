import { rmSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { MESSAGE_SEARCH_BUDGET, STORAGE_BUDGET } from '../../../../packages/contracts/src/index.js';
import type { IdentifiedSession } from '../session-identity.js';
import { openSqliteDatabase, quickCheckDatabase, type StorageLayoutPaths } from '../sqlite-storage.js';
import { now, type IndexedMessageRow, type MessageSearchHit, type StorePort } from './shared.js';

export function openDerivedDatabase(layout: StorageLayoutPaths | undefined): DatabaseSync {
  const derivedPath = layout?.derived ?? ':memory:';
  const init = (db: DatabaseSync) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS message_index (
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        at TEXT NOT NULL,
        PRIMARY KEY (session_id, message_id));
      CREATE INDEX IF NOT EXISTS message_index_session ON message_index(session_id); CREATE INDEX IF NOT EXISTS message_index_at ON message_index(at);
      CREATE TABLE IF NOT EXISTS message_index_sessions (session_id TEXT PRIMARY KEY, indexed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS derived_meta (key TEXT PRIMARY KEY, json TEXT NOT NULL);`);
    return db;
  };
  let opened: DatabaseSync | undefined;
  try {
    opened = openSqliteDatabase(derivedPath, { role: 'derived' });
    if (derivedPath !== ':memory:' && !quickCheckDatabase(opened)) {
      throw new Error('derived.db failed PRAGMA quick_check');
    }
    return init(opened);
  } catch (error) {
    if (opened) { try { opened.close(); } catch { /* ignore */ } }
    if (derivedPath === ':memory:') throw error;
    console.warn('[riffet] derived.db could not be opened or failed integrity check; recreating rebuildable cache:', error);
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${derivedPath}${suffix}`, { force: true });
    return init(openSqliteDatabase(derivedPath, { role: 'derived' }));
  }
}

export function getDerivedMeta<T>(port: StorePort, key: string, fallback: T): T {
  const row = port.derivedSql('SELECT json FROM derived_meta WHERE key=?').get(key) as { json: string } | undefined;
  return row ? JSON.parse(row.json) as T : fallback;
}

export function setDerivedMeta(port: StorePort, key: string, value: unknown): void {
  port.derivedSql('INSERT INTO derived_meta(key,json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json').run(key, JSON.stringify(value));
}

/**
 * Trigram index over `message_index.text`, so a substring search reads candidates instead of
 * every message. External content keeps the text stored once; `detail=none` keeps the index at
 * about the size of the text. The index only proposes rows: a search re-checks each candidate
 * against `message_index` itself, so a stale entry can hide nothing it should not, only miss.
 * Rows are linked by rowid, which a full VACUUM may renumber; the start-up check rebuilds then.
 */
export function ensureMessageSearchIndex(port: StorePort): void {
  const exists = port.derivedSql("SELECT 1 AS found FROM sqlite_master WHERE name='message_index_fts'").get();
  port.derivedDb.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS message_index_fts USING fts5(text, tokenize='trigram', detail=none, content='message_index', content_rowid='rowid');
    CREATE TRIGGER IF NOT EXISTS message_index_fts_insert AFTER INSERT ON message_index BEGIN
      INSERT INTO message_index_fts(rowid,text) VALUES (new.rowid,new.text); END;
    CREATE TRIGGER IF NOT EXISTS message_index_fts_update AFTER UPDATE OF text ON message_index WHEN old.text IS NOT new.text BEGIN
      INSERT INTO message_index_fts(message_index_fts,rowid,text) VALUES ('delete',old.rowid,old.text);
      INSERT INTO message_index_fts(rowid,text) VALUES (new.rowid,new.text); END;
    CREATE TRIGGER IF NOT EXISTS message_index_fts_delete AFTER DELETE ON message_index BEGIN
      INSERT INTO message_index_fts(message_index_fts,rowid,text) VALUES ('delete',old.rowid,old.text); END;`);
  const shape = port.derivedSql('SELECT COUNT(*) AS total, COALESCE(MAX(rowid),0) AS top FROM message_index').get() as { total: number; top: number };
  const marker = getDerivedMeta<{ total: number; top: number } | undefined>(port, 'message-index-fts-v1', undefined);
  if (exists && marker && marker.total === shape.total && marker.top === shape.top) return;
  if (exists && marker === undefined && shape.total === 0) { setDerivedMeta(port, 'message-index-fts-v1', shape); return; }
  port.derivedDb.exec("INSERT INTO message_index_fts(message_index_fts) VALUES('rebuild')");
  setDerivedMeta(port, 'message-index-fts-v1', shape);
}

/** Records the shape the search index was last known to match, for the next start's check. */
export function noteMessageIndexShape(port: StorePort): void {
  try { setDerivedMeta(port, 'message-index-fts-v1', port.derivedSql('SELECT COUNT(*) AS total, COALESCE(MAX(rowid),0) AS top FROM message_index').get()); } catch { /* checked again next start */ }
}

export function hotTimelineSessions(port: StorePort): Set<string> {
  const hot = new Set<string>();
  try {
    const hasTimeline = port.derivedSql("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='timeline_rows'").get();
    if (hasTimeline) {
      for (const row of port.derivedSql('SELECT DISTINCT session_id FROM timeline_rows').all() as Array<{ session_id: string }>) {
        hot.add(row.session_id);
      }
    }
  } catch { /* ignore */ }
  return hot;
}

/** `indexedAt` is when the transcript was read; activity after it makes the conversation stale again. */
export function indexMessages(port: StorePort, messages: readonly IndexedMessageRow[], indexedAt = now()): number {
  if (!messages.length) return 0;
  // L2 has no cross-database foreign key to L0 `sessions`; verify live ownership first.
  const liveIds = new Set(port.allSessions().map(session => session.id));
  const valid = messages.filter(message => liveIds.has(message.sessionId));
  if (!valid.length) return 0;
  return port.derivedTx(() => {
    // An unchanged message is left alone, so re-indexing a window rewrites only what moved.
    const statement = port.derivedSql(`INSERT INTO message_index(session_id,message_id,kind,text,at) VALUES(?,?,?,?,?) ON CONFLICT(session_id,message_id) DO UPDATE SET kind=excluded.kind,text=excluded.text,at=excluded.at
      WHERE kind IS NOT excluded.kind OR text IS NOT excluded.text OR at IS NOT excluded.at`);
    const mark = port.derivedSql('INSERT INTO message_index_sessions(session_id,indexed_at) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET indexed_at=MAX(indexed_at,excluded.indexed_at)');
    const sessions = new Set<string>();
    let written = 0;
    for (const message of valid) {
      try { statement.run(message.sessionId, message.messageId, message.kind, message.text, message.at); written += 1; sessions.add(message.sessionId); } catch { /* skipped */ }
    }
    for (const sessionId of sessions) mark.run(sessionId, indexedAt);
    return written;
  });
}

/** The earliest indexed message of one kind, if a transcript has been indexed for the session. */
export function firstIndexedText(port: StorePort, sessionId: string, kind: IndexedMessageRow['kind']): string | undefined {
  const row = port.derivedSql('SELECT text FROM message_index WHERE session_id=? AND kind=? AND text<>? ORDER BY at LIMIT 1').get(sessionId, kind, '') as { text: string } | undefined;
  return row?.text;
}

/** The latest indexed user prompt at or before `at` (seconds precision), for mark context lookup. */
export function latestIndexedPromptBefore(port: StorePort, sessionId: string, at: string): string | undefined {
  const row = port.derivedSql("SELECT text FROM message_index WHERE session_id=? AND kind='user' AND text<>'' AND substr(at,1,19)<=substr(?,1,19) ORDER BY at DESC, rowid DESC LIMIT 1")
    .get(sessionId, at) as { text: string } | undefined;
  return row?.text;
}

/** Indexed assistant (and optionally tool) rows of one conversation, for mark relocation. */
export function indexedCandidatesForMark(port: StorePort, sessionId: string, includeTools: boolean): Array<{ messageId: string; kind: IndexedMessageRow['kind']; text: string }> {
  return port.derivedSql(`SELECT message_id AS messageId, kind, text FROM message_index WHERE session_id=? AND (kind='assistant' OR (? AND kind='tool')) AND text<>'' ORDER BY at, rowid`)
    .all(sessionId, includeTools ? 1 : 0) as Array<{ messageId: string; kind: IndexedMessageRow['kind']; text: string }>;
}

/** Every indexed user and assistant message of a conversation, oldest first, with its tool calls when `tools` is set. */
export function indexedMessages(port: StorePort, sessionId: string, options: { tools?: boolean } = {}): Array<{ kind: 'user' | 'assistant' | 'tool'; text: string; at: string }> {
  return port.derivedSql(`SELECT kind,text,at FROM message_index WHERE session_id=? AND kind IN (${options.tools ? "'user','assistant','tool'" : "'user','assistant'"}) AND text<>'' ORDER BY at, rowid`).all(sessionId) as Array<{ kind: 'user' | 'assistant' | 'tool'; text: string; at: string }>;
}

/** A bounded tail from the search index, without loading earlier rows or tools. */
export function recentIndexedMessages(port: StorePort, sessionId: string, limit: number, characters: number): Array<{ role: 'user' | 'assistant'; text: string; at: string }> {
  const rows = port.derivedSql("SELECT kind AS role,substr(text,1,?) AS text,at FROM message_index WHERE session_id=? AND kind IN ('user','assistant') AND text<>'' ORDER BY at DESC,rowid DESC LIMIT ?")
    .all(characters, sessionId, limit) as Array<{ role: 'user' | 'assistant'; text: string; at: string }>;
  return rows.reverse();
}

export function hitFromSession(session: IdentifiedSession, messageId: string, kind: MessageSearchHit['kind'], text: string, at: string): MessageSearchHit {
  return {
    sessionId: session.id, projectId: session.projectId, sessionTitle: session.displayTitle ?? session.title,
    archived: Boolean(session.archivedAt), backendId: session.backendId,
    messageId, kind, text, at,
  };
}

function scopedSessions(port: StorePort, sessionId?: string, excludedBackendIds?: readonly string[], excludeTaskWorkspaces = false, hidePluginAgents = false, assistantHistory = false): Map<string, IdentifiedSession> {
  const hidden = excludedBackendIds?.length ? new Set(excludedBackendIds) : undefined;
  const projectsById = excludeTaskWorkspaces || assistantHistory ? new Map(port.listProjects().map(project => [project.id, project])) : undefined;
  const allowed = new Map<string, IdentifiedSession>();
  for (const session of port.allSessions()) {
    if (sessionId !== undefined && session.id !== sessionId) continue;
    if (hidden?.has(session.backendId)) continue;
    if (hidePluginAgents && session.backendId.includes('.')) continue;
    const system = projectsById?.get(session.projectId)?.system;
    if (excludeTaskWorkspaces && system === 'task-workspace') continue;
    if (assistantHistory && (session.origin?.kind === 'assistant' || system === 'quick-chat')) continue;
    allowed.set(session.id, session);
  }
  return allowed;
}

/** Assistant and tool text, newest first. Prompts come from `searchPrompts`, which is complete. */
export function searchIndexedMessages(port: StorePort, pattern: string, limit: number, sessionId?: string, excludedBackendIds?: readonly string[], excludeTaskWorkspaces = false, hidePluginAgents = false, assistantHistory = false): MessageSearchHit[] {
  if (limit <= 0) return [];
  const allowed = scopedSessions(port, sessionId, excludedBackendIds, excludeTaskWorkspaces, hidePluginAgents, assistantHistory);
  if (!allowed.size) return [];
  const indexed = /^%[^%_\\]+%$/.test(pattern) && [...pattern.slice(1, -1)].length >= 3;
  const hits: MessageSearchHit[] = [];
  const pushRows = (rows: Array<{ sessionId: string; messageId: string; kind: MessageSearchHit['kind']; text: string; at: string }>) => {
    for (const row of rows) {
      const session = allowed.get(row.sessionId);
      if (!session) continue;
      hits.push(hitFromSession(session, row.messageId, row.kind, row.text, row.at));
      if (hits.length >= limit) break;
    }
  };
  if (sessionId !== undefined) {
    const rows = (indexed
      ? port.derivedSql(`SELECT m.session_id AS sessionId, m.message_id AS messageId, m.kind AS kind, m.text AS text, m.at AS at
        FROM message_index_fts f JOIN message_index m ON m.rowid = f.rowid
        WHERE f.text LIKE ? AND m.text LIKE ? ESCAPE '\\' AND m.session_id=? ORDER BY m.at DESC LIMIT ?`).all(pattern, pattern, sessionId, limit)
      : port.derivedSql(`SELECT m.session_id AS sessionId, m.message_id AS messageId, m.kind AS kind, m.text AS text, m.at AS at
        FROM message_index m
        WHERE m.text LIKE ? ESCAPE '\\' AND m.session_id=? ORDER BY m.at DESC LIMIT ?`).all(pattern, sessionId, limit)) as Array<{ sessionId: string; messageId: string; kind: MessageSearchHit['kind']; text: string; at: string }>;
    pushRows(rows);
    return hits;
  }
  // Stream rows in descending time order once (O(N)) rather than repeating LIMIT/OFFSET sorts.
  const iter = (indexed
    ? port.derivedSql(`SELECT m.session_id AS sessionId, m.message_id AS messageId, m.kind AS kind, m.text AS text, m.at AS at
      FROM message_index_fts f JOIN message_index m ON m.rowid = f.rowid
      WHERE f.text LIKE ? AND m.text LIKE ? ESCAPE '\\' ORDER BY m.at DESC`).iterate(pattern, pattern)
    : port.derivedSql(`SELECT m.session_id AS sessionId, m.message_id AS messageId, m.kind AS kind, m.text AS text, m.at AS at
      FROM (SELECT session_id, message_id, kind, text, at FROM message_index ORDER BY at DESC LIMIT ${MESSAGE_SEARCH_BUDGET.scanRows}) m
      WHERE m.text LIKE ? ESCAPE '\\' ORDER BY m.at DESC`).iterate(pattern)) as IterableIterator<{ sessionId: string; messageId: string; kind: MessageSearchHit['kind']; text: string; at: string }>;
  try {
    for (const row of iter) {
      const session = allowed.get(row.sessionId);
      if (!session) continue;
      hits.push(hitFromSession(session, row.messageId, row.kind, row.text, row.at));
      if (hits.length >= limit) break;
    }
  } finally {
    iter.return?.();
  }
  return hits;
}

function staleMessageSessions(port: StorePort, backendIds: readonly string[], sessionId?: string, excludeTaskWorkspaces = false): IdentifiedSession[] {
  if (!backendIds.length) return [];
  const backends = new Set(backendIds);
  const allowed = scopedSessions(port, sessionId, undefined, excludeTaskWorkspaces);
  const indexedAt = new Map(
    (port.derivedSql('SELECT session_id, indexed_at FROM message_index_sessions').all() as Array<{ session_id: string; indexed_at: string }>)
      .map(row => [row.session_id, row.indexed_at] as const),
  );
  const hasMessage = new Set(
    (port.derivedSql('SELECT DISTINCT session_id FROM message_index').all() as Array<{ session_id: string }>)
      .map(row => row.session_id),
  );
  const stale: IdentifiedSession[] = [];
  for (const session of allowed.values()) {
    if (session.kind !== 'native' || !backends.has(session.backendId)) continue;
    const marked = indexedAt.get(session.id);
    const isStale = marked === undefined ? !hasMessage.has(session.id) : marked < (session.lastActivityAt ?? '');
    if (isStale) stale.push(session);
  }
  return stale;
}

/**
 * Conversations whose index may be behind, most recently active first, restricted to the
 * providers whose transcripts may be read without starting them: never indexed, or active since
 * they last were. A conversation indexed before that time was recorded counts as current.
 */
export function sessionsMissingMessages(port: StorePort, backendIds: readonly string[], limit: number, sessionId?: string, excludeTaskWorkspaces = false): IdentifiedSession[] {
  return staleMessageSessions(port, backendIds, sessionId, excludeTaskWorkspaces)
    .sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''))
    .slice(0, limit);
}

/** How many of those conversations are still missing from the index. */
export function countSessionsMissingMessages(port: StorePort, backendIds: readonly string[], sessionId?: string, excludeTaskWorkspaces = false): number {
  return staleMessageSessions(port, backendIds, sessionId, excludeTaskWorkspaces).length;
}

/**
 * Keeps L2 search index bounded and low-fragmentation: trims any legacy oversized `tool` rows down to
 * `STORAGE_BUDGET.toolIndexChars` in bounded batches (persisting completion in `derived_meta` so
 * steady-state maintenance never full-scans `message_index`), and merges FTS5 segments incrementally.
 */
export function maintainDerivedSearch(port: StorePort, options: { maxToolTrims?: number; fullOptimize?: boolean } = {}): { trimmedTools: number } {
  const maxToolTrims = options.maxToolTrims ?? 2_000;
  const cap = STORAGE_BUDGET.toolIndexChars;
  let trimmedTools = 0;
  try {
    const doneCap = getDerivedMeta<number | undefined>(port, 'tool-index-trimmed-cap', undefined);
    if (maxToolTrims > 0 && cap > 0 && (doneCap === undefined || doneCap > cap)) {
      const rows = port.derivedSql(`SELECT rowid FROM message_index WHERE kind='tool' AND length(text)>? LIMIT ?`)
        .all(cap, maxToolTrims) as Array<{ rowid: number }>;
      if (rows.length) {
        const trim = port.derivedSql(`UPDATE message_index SET text=substr(text,1,?) WHERE rowid=?`);
        port.derivedTx(() => {
          for (const row of rows) trimmedTools += Number(trim.run(cap, row.rowid).changes);
        });
        noteMessageIndexShape(port);
      }
      if (rows.length < maxToolTrims) setDerivedMeta(port, 'tool-index-trimmed-cap', cap);
    }
    const hasFts = port.derivedSql("SELECT 1 AS found FROM sqlite_master WHERE name='message_index_fts'").get();
    if (hasFts) {
      if (options.fullOptimize) {
        port.derivedDb.exec("INSERT INTO message_index_fts(message_index_fts) VALUES('optimize')");
      } else {
        port.derivedDb.exec("INSERT INTO message_index_fts(message_index_fts, rank) VALUES('merge', 64)");
      }
    }
  } catch { /* derived search maintenance is best-effort */ }
  return { trimmedTools };
}
