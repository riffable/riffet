import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { prepareBlob, readStoredBlob, writeExternalBlob, type PreparedBlob, type StoredBlobRow } from './blob-store.js';
import { foldProjection, emptyProjection, projectionCheck, type JournalFoldRow, type SessionProjection } from './projection.js';
import {
  compactJournalDrafts, compactJournalSuperseded, recompressSmallJournalBlobs,
  sweepJournalBlobs, sweepJournalExternalFiles, trimArchivedJournalToolBlobs,
  type JournalMaintenanceDeps,
} from './maintenance.js';
import {
  DRAFT_KIND, EVENT_JOIN, FOLD_BATCH, initJournalSchema, isHiddenKind,
  JOURNAL_PAYLOAD_LIMIT, laneKey, laneOfKey, MESSAGE_INLINE_BYTES, META_PREFIX,
  previewOf, scratchKeyOf, SELECT_EVENT_COLS, SESSION_UPDATE_KIND, TOMBSTONE_KIND,
  JournalGenerationChanged, JournalSessionDeleted,
  type AppendedRow, type AppendOptions, type AppendResult, type FallbackBlobResolver,
  type HeadRow, type JournalAppend, type JournalEntity, type JournalEventInput,
  type JournalHead, type JournalOptions, type JournalRow, type RawRow,
  type SessionBlobResult, type StoredJournalRow,
} from './schema.js';

export {
  DRAFT_KIND, isHiddenKind, JOURNAL_PAYLOAD_LIMIT, JournalGenerationChanged, JournalSessionDeleted,
  laneKey, laneOfKey, META_PREFIX, previewOf, scratchKeyOf, TOMBSTONE_KIND,
  type AppendedRow, type AppendOptions, type AppendResult, type FallbackBlobResolver,
  type JournalAppend, type JournalEntity, type JournalEventInput, type JournalHead,
  type JournalOptions, type JournalRow, type SessionBlobResult, type StoredJournalRow,
};

const sha1 = (text: string) => createHash('sha1').update(text).digest('base64');

export class Journal {
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;
  private savepointSeq = 0;
  private joinedEnclosing = false;
  private readonly settleHooks: Array<(committed: boolean) => void> = [];
  private readonly appendListeners = new Set<(change: JournalAppend) => void>();
  private pending: { changes: JournalAppend[]; last: Map<string, JournalAppend> } | undefined;
  readonly blobsDir: string | undefined;
  private readonly enclosing: JournalOptions['enclosingTransaction'];
  private readonly bytesNotNull: boolean;
  private fallbackBlobResolver: FallbackBlobResolver | undefined;
  private blobGcHolds = 0;
  private readonly maintenanceDeps: JournalMaintenanceDeps;

  constructor(
    readonly db: DatabaseSync,
    private readonly transaction?: <T>(fn: () => T) => T,
    private readonly afterTransaction?: (fn: (committed: boolean) => void) => void,
    private readonly deleted?: (sessionId: string) => boolean,
    options?: JournalOptions,
  ) {
    this.blobsDir = options?.blobsDir;
    this.enclosing = options?.enclosingTransaction;
    this.bytesNotNull = initJournalSchema(this.db, text => this.sql(text)).bytesNotNull;
    this.maintenanceDeps = {
      blobsDir: this.blobsDir,
      sql: text => this.sql(text),
      tx: fn => this.tx(fn),
      whenSettled: fn => this.whenSettled(fn),
      isBlobGcHeld: () => this.isBlobGcHeld(),
      getBlob: hash => this.getBlob(hash),
      storePreparedBlob: (prepared, stamp) => this.storePreparedBlob(prepared, stamp),
    };
  }

  setFallbackBlobResolver(resolver: FallbackBlobResolver | undefined): void {
    this.fallbackBlobResolver = resolver;
  }

  private sql(text: string): StatementSync {
    let statement = this.statements.get(text);
    if (!statement) this.statements.set(text, statement = this.db.prepare(text));
    return statement;
  }

  tx<T>(fn: () => T): T {
    if (this.transaction) return this.transaction(fn);
    if (this.depth) {
      if (!this.joinedEnclosing) return fn();
      const sp = `j_sp_${++this.savepointSeq}`;
      this.db.exec(`SAVEPOINT ${sp}`);
      try {
        const result = fn();
        this.db.exec(`RELEASE SAVEPOINT ${sp}`);
        return result;
      } catch (error) {
        try { this.db.exec(`ROLLBACK TO SAVEPOINT ${sp}; RELEASE SAVEPOINT ${sp}`); } catch { /* connection closed */ }
        throw error;
      }
    }
    if (this.enclosing?.active()) {
      this.db.exec('BEGIN IMMEDIATE');
      this.depth += 1;
      this.joinedEnclosing = true;
      this.enclosing.onSettle(committed => {
        if (!this.joinedEnclosing) return;
        this.joinedEnclosing = false;
        this.depth = Math.max(0, this.depth - 1);
        let settled = committed;
        try {
          this.db.exec(committed ? 'COMMIT' : 'ROLLBACK');
        } catch (error) {
          settled = false;
          if (!/database is not open/i.test(String(error))) {
            console.error('[riffet] journal transaction settle failed; attempting rollback:', error);
            try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
          }
        }
        this.settle(settled);
      });
      const sp = `j_sp_${++this.savepointSeq}`;
      this.db.exec(`SAVEPOINT ${sp}`);
      try {
        const result = fn();
        this.db.exec(`RELEASE SAVEPOINT ${sp}`);
        return result;
      } catch (error) {
        try { this.db.exec(`ROLLBACK TO SAVEPOINT ${sp}; RELEASE SAVEPOINT ${sp}`); } catch { /* connection closed */ }
        throw error;
      }
    }
    this.db.exec('BEGIN IMMEDIATE'); this.depth++;
    try { const result = fn(); this.db.exec('COMMIT'); this.depth--; this.settle(true); return result; }
    catch (error) { this.db.exec('ROLLBACK'); this.depth--; this.settle(false); throw error; }
  }

  private settle(committed: boolean): void { for (const hook of this.settleHooks.splice(0)) hook(committed); }

  whenSettled(fn: (committed: boolean) => void): void {
    if (this.afterTransaction) this.afterTransaction(fn);
    else if (!this.transaction && this.depth) this.settleHooks.push(fn);
    else fn(true);
  }

  // ---- changes -----------------------------------------------------------------------------

  onAppend(listener: (change: JournalAppend) => void): () => void {
    this.appendListeners.add(listener);
    return () => { this.appendListeners.delete(listener); };
  }

  private note(key: string, change: Pick<JournalAppend, 'generation' | 'fromSeq' | 'toSeq' | 'reset'>): void {
    if (!this.appendListeners.size) return;
    const where = laneOfKey(key);
    if (!where) return;
    if (!this.pending) {
      const pending = this.pending = { changes: [], last: new Map() };
      this.whenSettled(committed => {
        if (this.pending === pending) this.pending = undefined;
        if (!committed) return;
        for (const item of pending.changes) for (const listener of this.appendListeners) { try { listener(item); } catch { /* see onAppend */ } }
      });
    }
    const last = this.pending.last.get(key);
    if (last && !last.reset && !change.reset && last.generation === change.generation && last.toSeq + 1 === change.fromSeq) { last.toSeq = change.toSeq; return; }
    const entry: JournalAppend = { ...where, ...change };
    this.pending.changes.push(entry);
    this.pending.last.set(key, entry);
  }

  // ---- heads -------------------------------------------------------------------------------

  private headOf(row: HeadRow): JournalHead {
    return {
      sessionId: row.session_id, generation: row.generation, lastSeq: row.last_seq, ingestCursor: row.ingest_cursor,
      ...(row.identity !== null ? { identity: row.identity } : {}), projectionSeq: row.projection_seq,
      compactedSeq: row.compacted_seq ?? 0, updatedAt: row.updated_at,
    };
  }

  peek(sessionId: string): JournalHead | undefined {
    const row = this.sql('SELECT session_id,generation,last_seq,ingest_cursor,identity,projection_seq,compacted_seq,updated_at FROM journal_heads WHERE session_id=?').get(sessionId) as HeadRow | undefined;
    return row ? this.headOf(row) : undefined;
  }

  keysOf(sessionId: string): string[] {
    return (this.sql('SELECT session_id FROM journal_heads WHERE session_id=? OR (session_id>=? AND session_id<?) ORDER BY session_id')
      .all(sessionId, `${sessionId}#`, `${sessionId}$`) as Array<{ session_id: string }>).map(row => row.session_id);
  }

  private refuseDeleted(key: string): void {
    const owner = laneOfKey(key)?.sessionId ?? key;
    if (this.deleted?.(owner)) throw new JournalSessionDeleted(owner);
  }

  head(sessionId: string): JournalHead {
    const existing = this.peek(sessionId);
    if (existing) return existing;
    this.refuseDeleted(sessionId);
    return this.tx(() => {
      this.sql('INSERT OR IGNORE INTO journal_heads(session_id,generation,last_seq,updated_at) VALUES(?,?,0,?)').run(sessionId, randomUUID(), new Date().toISOString());
      return this.peek(sessionId)!;
    });
  }

  setCursor(sessionId: string, cursor: string | null): void {
    this.tx(() => {
      this.head(sessionId);
      this.sql('UPDATE journal_heads SET ingest_cursor=?, updated_at=? WHERE session_id=?').run(cursor, new Date().toISOString(), sessionId);
    });
  }

  setIdentity(sessionId: string, identity: string): void {
    this.tx(() => {
      this.head(sessionId);
      this.sql('UPDATE journal_heads SET identity=?, updated_at=? WHERE session_id=?').run(identity, new Date().toISOString(), sessionId);
    });
  }

  // ---- writes ------------------------------------------------------------------------------

  append(sessionId: string, inputs: readonly JournalEventInput[], options: AppendOptions = {}): AppendResult {
    const prepared = inputs.map(input => {
      const json = JSON.stringify(input.payload);
      const digest = sha1(`${input.kind}\n${input.contentKey === undefined ? json : JSON.stringify(input.contentKey)}`);
      const limit = input.kind === 'user_message_chunk' || input.kind === 'agent_message_chunk' ? MESSAGE_INLINE_BYTES : JOURNAL_PAYLOAD_LIMIT;
      const oversized = Buffer.byteLength(json) > limit;
      if (!oversized) return { input, digest, payload: json, blob: undefined as PreparedBlob | undefined };
      const blob = prepareBlob(Buffer.from(json), { mimeType: 'application/json', blobsDir: this.blobsDir });
      return { input, digest, payload: JSON.stringify(previewOf(input.payload)), blob };
    });
    return this.tx(() => {
      const head = this.head(sessionId);
      if (options.generation !== undefined && options.generation !== head.generation) throw new JournalGenerationChanged();
      const rows: AppendedRow[] = [];
      let seq = head.lastSeq;
      const stamp = new Date().toISOString();
      const insert = this.sql('INSERT INTO journal_events(session_id,seq,kind,native_id,rev,turn_id,at,payload,blob_ref,digest) VALUES(?,?,?,?,?,?,?,?,?,?)');
      const latestOf = this.sql('SELECT seq,rev,kind,digest FROM journal_events WHERE session_id=? AND native_id=? ORDER BY rev DESC LIMIT 1');
      const firstOf = this.sql('SELECT seq FROM journal_events WHERE session_id=? AND native_id=? AND rev=1');
      for (const item of prepared) {
        const { input, digest, payload, blob } = item;
        const latest = latestOf.get(sessionId, input.nativeId) as { seq: number; rev: number; kind: string; digest: string } | undefined;
        if (latest && latest.digest === digest) {
          const identity = latest.rev === 1 ? latest.seq : (firstOf.get(sessionId, input.nativeId) as { seq: number }).seq;
          rows.push({ nativeId: input.nativeId, seq: latest.seq, identity, rev: latest.rev, written: false, created: false });
          continue;
        }
        seq += 1;
        const rev = latest ? latest.rev + 1 : 1;
        const identity = latest ? (latest.rev === 1 ? latest.seq : (firstOf.get(sessionId, input.nativeId) as { seq: number }).seq) : seq;
        let blobRef: string | null = null;
        if (blob) {
          this.storePreparedBlob(blob, stamp);
          blobRef = blob.hash;
        }
        insert.run(sessionId, seq, input.kind, input.nativeId, rev, input.turnId ?? null, input.at ?? stamp, payload, blobRef, digest);
        rows.push({ nativeId: input.nativeId, seq, identity, rev, written: true, created: !latest });
      }
      const cursor = options.cursor === undefined ? head.ingestCursor : options.cursor;
      if (seq === head.lastSeq && cursor === head.ingestCursor) return { head, rows };
      this.sql('UPDATE journal_heads SET last_seq=?, ingest_cursor=?, updated_at=? WHERE session_id=?').run(seq, cursor, stamp, sessionId);
      if (seq > head.lastSeq) this.note(sessionId, { generation: head.generation, fromSeq: head.lastSeq + 1, toSeq: seq });
      return { head: { ...head, lastSeq: seq, ingestCursor: cursor, updatedAt: stamp }, rows };
    });
  }

  rebuild(sessionId: string): JournalHead {
    return this.tx(() => {
      this.sql("DELETE FROM session_blobs WHERE session_id=? AND type NOT IN ('application/vnd.riffet.discussion+json','application/vnd.riffet.session-reference+json')").run(sessionId);
      this.sql('DELETE FROM journal_events WHERE session_id=?').run(sessionId);
      this.sql('DELETE FROM journal_heads WHERE session_id=?').run(sessionId);
      const head = this.head(sessionId);
      this.note(sessionId, { generation: head.generation, fromSeq: 1, toSeq: 0, reset: 'rebuilt' });
      return head;
    });
  }

  drop(sessionId: string): void {
    this.tx(() => {
      this.sql('DELETE FROM session_blobs WHERE session_id=?').run(sessionId);
      this.sql('DELETE FROM journal_events WHERE session_id=?').run(sessionId);
      if (Number(this.sql('DELETE FROM journal_heads WHERE session_id=?').run(sessionId).changes)) this.note(sessionId, { fromSeq: 1, toSeq: 0, reset: 'dropped' });
    });
  }

  dropIfCopied(sessionId: string, replacement: string): void {
    this.tx(() => {
      if (sessionId === replacement || !this.peek(sessionId) || this.peek(sessionId)?.identity !== this.peek(replacement)?.identity) return;
      const missing = this.sql(`SELECT 1 FROM journal_events e WHERE e.session_id=?
        AND e.rev=(SELECT MAX(rev) FROM journal_events WHERE session_id=e.session_id AND native_id=e.native_id)
        AND NOT EXISTS (SELECT 1 FROM journal_events r WHERE r.session_id=? AND r.native_id=e.native_id AND r.digest=e.digest
          AND r.rev=(SELECT MAX(rev) FROM journal_events WHERE session_id=r.session_id AND native_id=r.native_id)) LIMIT 1`).get(sessionId, replacement);
      if (!missing) this.drop(sessionId);
    });
  }

  // ---- blobs -------------------------------------------------------------------------------

  private storePreparedBlob(prepared: PreparedBlob, stamp = new Date().toISOString()): void {
    if (this.sql('SELECT 1 AS found FROM blobs WHERE hash=?').get(prepared.hash)) return;
    if (prepared.external && this.blobsDir) writeExternalBlob(this.blobsDir, prepared);
    const storedBytes = prepared.external ? (this.bytesNotNull ? Buffer.alloc(0) : null) : prepared.storedBytes;
    this.sql('INSERT OR IGNORE INTO blobs(hash,size,stored_size,codec,external,bytes,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(prepared.hash, prepared.size, prepared.storedSize, prepared.codec, prepared.external ? 1 : 0, storedBytes, stamp);
  }

  putBlob(bytes: Buffer, mimeType?: string): string {
    const prepared = prepareBlob(bytes, { mimeType, blobsDir: this.blobsDir });
    this.storePreparedBlob(prepared);
    return prepared.hash;
  }

  getBlob(hash: string): Buffer | undefined {
    const row = this.sql('SELECT hash,codec,external,bytes FROM blobs WHERE hash=?').get(hash) as StoredBlobRow | undefined;
    return row ? readStoredBlob(row, this.blobsDir) : undefined;
  }

  blobSize(hash: string): number | undefined {
    const row = this.sql('SELECT size FROM blobs WHERE hash=?').get(hash) as { size: number } | undefined;
    return row?.size;
  }

  putSessionBlob(sessionId: string, bytes: Buffer, type = 'text/plain; charset=utf-8'): string {
    this.refuseDeleted(sessionId);
    const prepared = prepareBlob(bytes, { mimeType: type, blobsDir: this.blobsDir });
    return this.tx(() => {
      this.storePreparedBlob(prepared);
      this.sql('INSERT OR IGNORE INTO session_blobs(session_id,hash,type) VALUES(?,?,?)').run(sessionId, prepared.hash, type);
      return prepared.hash;
    });
  }

  sessionBlob(sessionId: string, hash: string): SessionBlobResult | undefined {
    const owned = this.sql('SELECT type FROM session_blobs WHERE session_id=? AND hash=?').get(sessionId, hash) as { type: string } | undefined;
    const payload = owned ? undefined : this.sql('SELECT 1 AS one FROM journal_events WHERE blob_ref=? AND (session_id=? OR (session_id>=? AND session_id<?)) LIMIT 1')
      .get(hash, sessionId, `${sessionId}#`, `${sessionId}$`);
    if (owned || payload) {
      const row = this.sql('SELECT size FROM blobs WHERE hash=?').get(hash) as { size: number } | undefined;
      if (row) return { size: row.size, type: owned?.type ?? 'application/json', bytes: () => this.getBlob(hash) ?? Buffer.alloc(0) };
    }
    return this.fallbackBlobResolver?.(sessionId, hash);
  }

  releaseSessionBlobs(sessionId: string, hashes: Iterable<string>): void {
    const release = this.sql('DELETE FROM session_blobs WHERE session_id=? AND hash=?');
    this.tx(() => { for (const hash of hashes) release.run(sessionId, hash); });
  }

  holdBlobGc(): () => void {
    this.blobGcHolds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.blobGcHolds = Math.max(0, this.blobGcHolds - 1);
    };
  }

  isBlobGcHeld(): boolean { return this.blobGcHolds > 0; }

  // ---- compaction & retention ---------------------------------------------------------------

  sweepBlobs(): number { return sweepJournalBlobs(this.maintenanceDeps); }
  sweepExternalFiles(): number { return sweepJournalExternalFiles(this.maintenanceDeps); }
  recompressSmallBlobs(options: { maxBlobs?: number; reset?: boolean } = {}): { recompressed: number; savedBytes: number } {
    return recompressSmallJournalBlobs(this.maintenanceDeps, options);
  }
  compactDrafts(): number { return compactJournalDrafts(this.maintenanceDeps); }
  compactSuperseded(options: { minAgeMs?: number; maxUpdates?: number } = {}): number {
    return compactJournalSuperseded(this.maintenanceDeps, options);
  }
  trimArchivedToolBlobs(sessionIds: readonly string[], options: { keepBytes?: number; limit?: number; beforeAt?: string } = {}): number {
    return trimArchivedJournalToolBlobs(this.maintenanceDeps, sessionIds, options);
  }

  maintain(): { drafts: number; blobs: number } {
    const drafts = this.compactDrafts();
    return { drafts, blobs: this.sweepBlobs() };
  }

  maintainAll(options: { minAgeMs?: number; maxUpdates?: number } = {}): { drafts: number; superseded: number; blobs: number; externalFiles: number } {
    const drafts = this.compactDrafts();
    const superseded = this.compactSuperseded(options);
    const blobs = this.sweepBlobs();
    const externalFiles = this.sweepExternalFiles();
    return { drafts, superseded, blobs, externalFiles };
  }

  stats(sessionId?: string): { events: number; payloadBytes: number; blobs: number; blobBytes: number; storedBlobBytes: number } {
    const events = (sessionId
      ? this.sql('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)),0) AS bytes FROM journal_events WHERE session_id=?').get(sessionId)
      : this.sql('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)),0) AS bytes FROM journal_events').get()) as { n: number; bytes: number };
    const blobs = this.sql('SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes, COALESCE(SUM(CASE WHEN stored_size>0 THEN stored_size ELSE size END),0) AS stored FROM blobs').get() as { n: number; bytes: number; stored: number };
    return { events: events.n, payloadBytes: events.bytes, blobs: blobs.n, blobBytes: blobs.bytes, storedBlobBytes: blobs.stored };
  }

  // ---- reads -------------------------------------------------------------------------------

  private rowOf(raw: RawRow): JournalRow {
    let payload: unknown;
    if (raw.blob_ref) {
      const blob = raw.blob_codec !== undefined || raw.blob_bytes !== undefined || raw.blob_external !== undefined
        ? readStoredBlob({ hash: raw.blob_ref, codec: raw.blob_codec, external: raw.blob_external, bytes: raw.blob_bytes }, this.blobsDir)
        : this.getBlob(raw.blob_ref);
      payload = blob ? JSON.parse(blob.toString('utf8')) : JSON.parse(raw.payload);
    } else payload = JSON.parse(raw.payload);
    return {
      seq: raw.seq, kind: raw.kind, nativeId: raw.native_id, rev: raw.rev, ...(raw.turn_id ? { turnId: raw.turn_id } : {}),
      at: raw.at, digest: raw.digest, ...(raw.blob_ref ? { blobRef: raw.blob_ref } : {}), payload,
    };
  }

  range(sessionId: string, afterSeq: number, limit: number): JournalRow[] {
    return (this.sql(`SELECT ${SELECT_EVENT_COLS} FROM journal_events e ${EVENT_JOIN} WHERE e.session_id=? AND e.seq>? ORDER BY e.seq LIMIT ?`)
      .all(sessionId, afterSeq, limit) as unknown as RawRow[]).map(row => this.rowOf(row));
  }

  storedRange(key: string, afterSeq: number, limit: number): StoredJournalRow[] {
    return (this.sql(`SELECT e.seq,e.kind,e.native_id,e.rev,e.turn_id,e.at,e.payload,e.blob_ref,b.size AS blob_size FROM journal_events e ${EVENT_JOIN}
      WHERE e.session_id=? AND e.seq>? ORDER BY e.seq LIMIT ?`).all(key, afterSeq, limit) as unknown as Array<RawRow & { blob_size: number | null }>)
      .map(raw => ({
        seq: raw.seq, kind: raw.kind, nativeId: raw.native_id, rev: raw.rev, ...(raw.turn_id ? { turnId: raw.turn_id } : {}), at: raw.at, inline: raw.payload,
        ...(raw.blob_ref ? { blobRef: raw.blob_ref, ...(raw.blob_size !== null ? { blobSize: raw.blob_size } : {}) } : {}),
      }));
  }

  storedRow(key: string, seq: number): (StoredJournalRow & { digest: string; text: string; blobMissing?: true }) | undefined {
    const raw = this.sql(`SELECT ${SELECT_EVENT_COLS},b.size AS blob_size FROM journal_events e ${EVENT_JOIN} WHERE e.session_id=? AND e.seq=?`)
      .get(key, seq) as unknown as (RawRow & { blob_size: number | null }) | undefined;
    if (!raw) return undefined;
    const blob = raw.blob_ref
      ? raw.blob_codec !== undefined && raw.blob_codec !== null
        ? readStoredBlob({ hash: raw.blob_ref, codec: raw.blob_codec, external: raw.blob_external, bytes: raw.blob_bytes }, this.blobsDir)
        : this.getBlob(raw.blob_ref)
      : undefined;
    return {
      seq: raw.seq, kind: raw.kind, nativeId: raw.native_id, rev: raw.rev, ...(raw.turn_id ? { turnId: raw.turn_id } : {}), at: raw.at, inline: raw.payload,
      ...(raw.blob_ref ? { blobRef: raw.blob_ref, ...(raw.blob_size !== null ? { blobSize: raw.blob_size } : {}) } : {}),
      digest: raw.digest, text: blob ? blob.toString('utf8') : raw.payload, ...(raw.blob_ref && !blob ? { blobMissing: true as const } : {}),
    };
  }

  rowCount(key: string): number {
    return (this.sql('SELECT COUNT(*) AS n FROM journal_events WHERE session_id=?').get(key) as { n: number }).n;
  }

  entity(sessionId: string, nativeId: string): JournalEntity | undefined {
    const raw = this.sql(`SELECT ${SELECT_EVENT_COLS} FROM journal_events e ${EVENT_JOIN} WHERE e.session_id=? AND e.native_id=? ORDER BY e.rev DESC LIMIT 1`)
      .get(sessionId, nativeId) as unknown as RawRow | undefined;
    if (!raw) return undefined;
    const identity = raw.rev === 1 ? raw.seq : (this.sql('SELECT seq FROM journal_events WHERE session_id=? AND native_id=? AND rev=1').get(sessionId, nativeId) as { seq: number }).seq;
    return { ...this.rowOf(raw), identity };
  }

  retraction(sessionId: string, nativeId: string): JournalRow | undefined {
    const raw = this.sql(`SELECT ${SELECT_EVENT_COLS} FROM journal_events e ${EVENT_JOIN}
      WHERE e.session_id=? AND e.native_id=? AND e.kind=? ORDER BY e.rev DESC LIMIT 1`).get(sessionId, nativeId, TOMBSTONE_KIND) as unknown as RawRow | undefined;
    return raw ? this.rowOf(raw) : undefined;
  }

  firstEntity(sessionId: string, kind: string): JournalEntity | undefined {
    const first = this.sql(`SELECT e.native_id FROM journal_events e WHERE e.session_id=? AND e.rev=1
      AND (SELECT kind FROM journal_events WHERE session_id=e.session_id AND native_id=e.native_id ORDER BY rev DESC LIMIT 1)=?
      ORDER BY e.seq LIMIT 1`).get(sessionId, kind) as { native_id: string } | undefined;
    return first ? this.entity(sessionId, first.native_id) : undefined;
  }

  *turnEntitiesNewestFirst(sessionId: string, turnId: string, kind: string): Generator<JournalRow> {
    const rows = this.sql(`SELECT ${SELECT_EVENT_COLS} FROM journal_events e ${EVENT_JOIN}
      WHERE e.session_id=? AND e.turn_id=? AND e.payload<>'{}' AND e.kind=?
        AND e.rev=(SELECT MAX(rev) FROM journal_events WHERE session_id=e.session_id AND native_id=e.native_id)
      ORDER BY (SELECT seq FROM journal_events WHERE session_id=e.session_id AND native_id=e.native_id AND rev=1) DESC`)
      .iterate(sessionId, turnId, kind);
    for (const raw of rows) yield this.rowOf(raw as unknown as RawRow);
  }

  locate(sessionId: string, nativeId: string): { identity: number; rev: number; seq: number; kind: string; digest: string; turnId?: string } | undefined {
    const latest = this.sql('SELECT seq,rev,kind,digest,turn_id FROM journal_events WHERE session_id=? AND native_id=? ORDER BY rev DESC LIMIT 1').get(sessionId, nativeId) as { seq: number; rev: number; kind: string; digest: string; turn_id: string | null } | undefined;
    if (!latest) return undefined;
    const identity = latest.rev === 1 ? latest.seq : (this.sql('SELECT seq FROM journal_events WHERE session_id=? AND native_id=? AND rev=1').get(sessionId, nativeId) as { seq: number }).seq;
    return { identity, rev: latest.rev, seq: latest.seq, kind: latest.kind, digest: latest.digest, ...(latest.turn_id ? { turnId: latest.turn_id } : {}) };
  }

  activityEntities(sessionId: string): JournalEntity[] {
    const rows = this.sql(`SELECT ${SELECT_EVENT_COLS} FROM journal_events e ${EVENT_JOIN}
      WHERE e.session_id=? AND e.kind='${SESSION_UPDATE_KIND}' AND e.rev=(SELECT MAX(rev) FROM journal_events WHERE session_id=e.session_id AND native_id=e.native_id)
      ORDER BY e.seq`).all(sessionId) as unknown as RawRow[];
    const firstOf = this.sql('SELECT seq FROM journal_events WHERE session_id=? AND native_id=? AND rev=1');
    return rows.map(raw => ({ ...this.rowOf(raw), identity: raw.rev === 1 ? raw.seq : (firstOf.get(sessionId, raw.native_id) as { seq: number }).seq }));
  }

  subagentEntities(sessionId: string): JournalRow[] {
    const rows = this.sql(`SELECT ${SELECT_EVENT_COLS} FROM journal_events e ${EVENT_JOIN}
      WHERE e.session_id=? AND e.native_id>='meta:subagent:' AND e.native_id<'meta:subagent;' AND e.kind='meta.subagent'
        AND e.rev=(SELECT MAX(rev) FROM journal_events WHERE session_id=e.session_id AND native_id=e.native_id)
      ORDER BY (SELECT seq FROM journal_events WHERE session_id=e.session_id AND native_id=e.native_id AND rev=1)`)
      .all(sessionId) as unknown as RawRow[];
    return rows.map(row => this.rowOf(row));
  }

  toolEntities(sessionId: string, toolCallId: string): JournalRow[] {
    const rows = this.sql(`SELECT ${SELECT_EVENT_COLS} FROM journal_events e ${EVENT_JOIN}
      WHERE e.session_id=? AND e.kind IN ('tool_call','tool_call_update') AND json_extract(e.payload,'$.data.toolCallId')=?
        AND e.rev=(SELECT MAX(rev) FROM journal_events WHERE session_id=e.session_id AND native_id=e.native_id)
      ORDER BY e.seq`).all(sessionId, toolCallId) as unknown as RawRow[];
    return rows.map(row => this.rowOf(row));
  }

  lastTurn(sessionId: string): string | undefined {
    const row = this.sql('SELECT turn_id FROM journal_events WHERE session_id=? AND +turn_id IS NOT NULL ORDER BY seq DESC LIMIT 1').get(sessionId) as { turn_id: string } | undefined;
    return row?.turn_id;
  }

  lastStartedTurn(sessionId: string): string | undefined {
    const row = this.sql(`SELECT turn_id FROM journal_events WHERE session_id=? AND native_id>='meta:turn:' AND native_id<'meta:turn;'
      AND kind='meta.turn_started' AND rev=1 ORDER BY seq DESC LIMIT 1`).get(sessionId) as { turn_id: string } | undefined;
    return row?.turn_id;
  }

  entitiesBefore(sessionId: string, beforeIdentity: number, limit: number, includeDrafts = false): JournalEntity[] {
    const firsts = this.sql('SELECT seq,native_id FROM journal_events WHERE session_id=? AND rev=1 AND seq<? ORDER BY seq DESC LIMIT ?');
    const latestOf = this.sql(`SELECT ${SELECT_EVENT_COLS} FROM journal_events e ${EVENT_JOIN} WHERE e.session_id=? AND e.native_id=? ORDER BY e.rev DESC LIMIT 1`);
    const found: JournalEntity[] = [];
    const page = Math.max(limit, 64);
    let cursor = beforeIdentity;
    while (found.length < limit) {
      const candidates = firsts.all(sessionId, cursor, page) as Array<{ seq: number; native_id: string }>;
      if (!candidates.length) break;
      for (const candidate of candidates) {
        cursor = candidate.seq;
        const latest = latestOf.get(sessionId, candidate.native_id) as unknown as RawRow;
        if (isHiddenKind(latest.kind) && !(includeDrafts && latest.kind === DRAFT_KIND)) continue;
        found.push({ ...this.rowOf(latest), identity: candidate.seq });
        if (found.length >= limit) break;
      }
    }
    return found.reverse();
  }

  tail(sessionId: string, limit: number, includeDrafts = false): JournalEntity[] {
    return this.entitiesBefore(sessionId, Number.MAX_SAFE_INTEGER, limit, includeDrafts);
  }

  recentMessages(sessionId: string, limit: number, characters: number): Array<{ role: 'user' | 'assistant'; text: string; at: string }> {
    const rows = this.sql(`SELECT latest.kind, latest.at, substr(json_extract(latest.payload,'$.data.content.text'),1,?) AS text
      FROM journal_events first JOIN journal_events latest ON latest.session_id=first.session_id AND latest.seq=(
        SELECT seq FROM journal_events WHERE session_id=first.session_id AND native_id=first.native_id ORDER BY rev DESC LIMIT 1
      )
      WHERE first.session_id=? AND first.rev=1 AND first.kind IN ('user_message_chunk','agent_message_chunk','draft')
        AND latest.kind IN ('user_message_chunk','agent_message_chunk') AND json_extract(latest.payload,'$.data.content.type')='text'
        AND trim(json_extract(latest.payload,'$.data.content.text'))<>''
      ORDER BY first.seq DESC LIMIT ?`).all(characters, sessionId, limit) as Array<{ kind: string; at: string; text: string }>;
    return rows.reverse().map(row => ({ role: row.kind === 'user_message_chunk' ? 'user' : 'assistant', text: row.text.trim(), at: row.at }));
  }

  hasEntitiesBefore(sessionId: string, identity: number): boolean {
    return this.entitiesBefore(sessionId, identity, 1).length > 0;
  }

  // ---- projection ---------------------------------------------------------------------------

  private rowDigestAt(sessionId: string, seq: number): string {
    if (seq <= 0) return '';
    const row = this.sql('SELECT digest FROM journal_events WHERE session_id=? AND seq=?').get(sessionId, seq) as { digest: string } | undefined;
    return row?.digest ?? '';
  }

  private foldFrom(sessionId: string, projection: SessionProjection, upTo: number): SessionProjection {
    let current = projection;
    while (current.asOfSeq < upTo) {
      const batch = this.sql('SELECT seq,kind,native_id,rev,turn_id,at,payload,blob_ref,digest FROM journal_events WHERE session_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?')
        .all(sessionId, current.asOfSeq, upTo, FOLD_BATCH) as unknown as RawRow[];
      if (!batch.length) break;
      const rows: JournalFoldRow[] = batch.map(raw => {
        const previous = raw.rev > 1 && (!isHiddenKind(raw.kind) || raw.kind === TOMBSTONE_KIND && raw.native_id.endsWith(':started'))
          ? this.sql('SELECT kind,turn_id FROM journal_events WHERE session_id=? AND native_id=? AND rev=?')
            .get(sessionId, raw.native_id, raw.rev - 1) as { kind: string; turn_id: string | null } | undefined : undefined;
        return {
          seq: raw.seq, kind: raw.kind, nativeId: raw.native_id, rev: raw.rev, turnId: raw.turn_id ?? undefined, at: raw.at,
          ...(previous ? { previousTurnId: previous.turn_id ?? undefined, previousKind: previous.kind } : {}),
          payload: JSON.parse(raw.payload),
        };
      });
      current = foldProjection(current, rows);
      current = { ...current, check: projectionCheck(current.asOfSeq, batch[batch.length - 1]!.digest) };
    }
    return current;
  }

  rebuildProjection(sessionId: string): SessionProjection {
    return this.tx(() => {
      const head = this.head(sessionId);
      const projection = this.foldFrom(sessionId, emptyProjection(), head.lastSeq);
      this.saveProjection(sessionId, projection);
      return projection;
    });
  }

  private saveProjection(sessionId: string, projection: SessionProjection): void {
    this.sql('UPDATE journal_heads SET projection=?, projection_seq=? WHERE session_id=?').run(JSON.stringify(projection), projection.asOfSeq, sessionId);
  }

  projection(sessionId: string): SessionProjection {
    const head = this.head(sessionId);
    const stored = this.sql('SELECT projection FROM journal_heads WHERE session_id=?').get(sessionId) as { projection: string | null };
    let cached: SessionProjection | undefined;
    try { cached = stored.projection ? JSON.parse(stored.projection) as SessionProjection : undefined; } catch { cached = undefined; }
    const valid = cached && cached.v === 1 && cached.asOfSeq === head.projectionSeq && cached.asOfSeq <= head.lastSeq
      && cached.check === projectionCheck(cached.asOfSeq, this.rowDigestAt(sessionId, cached.asOfSeq));
    if (!valid) return this.rebuildProjection(sessionId);
    if (cached!.asOfSeq === head.lastSeq) return cached!;
    return this.tx(() => {
      const next = this.foldFrom(sessionId, cached!, head.lastSeq);
      this.saveProjection(sessionId, next);
      return next;
    });
  }
}
