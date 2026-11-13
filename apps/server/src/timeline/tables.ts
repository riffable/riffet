import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { SyncLane, TimelineRow, TurnOutlineV3 } from '../../../../packages/contracts/src/sync.js';

/*
 * Where a lane's folded rows live (docs/SYNC-V3.md, 时间线由服务端折叠). Additive tables beside the journal's,
 * created if missing, so an existing database only gains them.
 *
 * - `timeline_rows`: one row per (session, lane, key). `seq` is the lane seq of its latest change and
 *   `rev` counts its changes; a row that left the timeline stays with `deleted=1` so a delta can say so.
 *   `payload` is the row as sent, without `seq` and `rev`; `digest` is of the row before it was fitted
 *   to the row budget, `bytes` the payload's size.
 * - `timeline_heads`: per lane, the `generation` the rows belong to, `head_seq`, the journal log they
 *   were folded from and how far (`journal_seq`), and `folded_through`: entities up to that journal
 *   identity are folded for good, so a cold start folds only what comes after it.
 * - `timeline_turns`: the outline, one `TurnOutlineV3` per turn; `cut` is set on a turn whose start
 *   once was `folded_through + 1`, the only places a fold may start from again.
 */

export interface TimelineHead {
  sessionId: string;
  lane: SyncLane;
  generation: string;
  /** The journal log's generation, and whether that log is the lane's scratch window. */
  journalGeneration: string | null;
  scratch: boolean;
  headSeq: number;
  foldVersion: number;
  foldedThrough: number;
  journalSeq: number;
}

/** A stored row without its payload. */
export interface RowState { key: string; pos: number; turn: string; seq: number; rev: number; runId?: string; deleted: boolean; kind: string; digest: string; bytes: number }

export interface StoredTurn { turn: string; startPos: number; cut: number | null; outline: TurnOutlineV3 }

interface HeadRecord { session_id: string; lane: string; generation: string; journal_generation: string | null; scratch: number; head_seq: number; fold_version: number; folded_through: number; journal_seq: number }
interface RowRecord { key: string; pos: number; turn: string; seq: number; rev: number; run_id: string | null; deleted: number; kind: string; digest: string; bytes: number }

const rowStateOf = (row: RowRecord): RowState => ({
  key: row.key, pos: row.pos, turn: row.turn, seq: row.seq, rev: row.rev, ...(row.run_id !== null ? { runId: row.run_id } : {}),
  deleted: row.deleted === 1, kind: row.kind, digest: row.digest, bytes: row.bytes,
});

const ROW_STATE = 'key,pos,turn,seq,rev,run_id,deleted,kind,digest,bytes';
/** A live row whose payload names the blob of its whole (`fitRow`); the substring test spares parsing every other payload. */
const CUT = `deleted=0 AND instr(payload,'"truncated":')>0`;
const TRUNCATED_REF = `json_extract(payload,'$.truncated.blobRef')`;

/** A stored row as sent: its payload with the lane's `seq` and `rev`. */
export const rowOf = (payload: string, seq: number, rev: number): TimelineRow => ({ ...JSON.parse(payload), seq, rev }) as TimelineRow;

export class TimelineTables {
  private readonly statements = new Map<string, StatementSync>();

  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS timeline_heads (
        session_id TEXT NOT NULL, lane TEXT NOT NULL, generation TEXT NOT NULL, journal_generation TEXT, scratch INTEGER NOT NULL DEFAULT 0,
        head_seq INTEGER NOT NULL DEFAULT 0, fold_version INTEGER NOT NULL, folded_through INTEGER NOT NULL DEFAULT 0,
        journal_seq INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (session_id, lane));
      CREATE TABLE IF NOT EXISTS timeline_rows (
        session_id TEXT NOT NULL, lane TEXT NOT NULL, key TEXT NOT NULL, pos INTEGER NOT NULL, turn TEXT NOT NULL,
        seq INTEGER NOT NULL, rev INTEGER NOT NULL, run_id TEXT, deleted INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL, digest TEXT NOT NULL, bytes INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (session_id, lane, key));
      CREATE INDEX IF NOT EXISTS timeline_rows_seq ON timeline_rows(session_id, lane, seq);
      CREATE INDEX IF NOT EXISTS timeline_rows_pos ON timeline_rows(session_id, lane, pos);
      -- The prompts a fold of a lane's tail is seeded from (see fold.ts): one per turn, where the lane holds every row.
      CREATE INDEX IF NOT EXISTS timeline_rows_user ON timeline_rows(session_id, lane, pos) WHERE kind='user' AND deleted=0;
      CREATE TABLE IF NOT EXISTS timeline_turns (
        session_id TEXT NOT NULL, lane TEXT NOT NULL, turn TEXT NOT NULL, start_pos INTEGER NOT NULL, cut INTEGER, payload TEXT NOT NULL,
        PRIMARY KEY (session_id, lane, turn));
      CREATE INDEX IF NOT EXISTS timeline_turns_pos ON timeline_turns(session_id, lane, start_pos);`);
  }

  private sql(text: string): StatementSync {
    let statement = this.statements.get(text);
    if (!statement) this.statements.set(text, statement = this.db.prepare(text));
    return statement;
  }

  // ---- heads -------------------------------------------------------------------------------

  head(sessionId: string, lane: SyncLane): TimelineHead | undefined {
    const row = this.sql('SELECT * FROM timeline_heads WHERE session_id=? AND lane=?').get(sessionId, lane) as HeadRecord | undefined;
    return row ? {
      sessionId: row.session_id, lane: row.lane as SyncLane, generation: row.generation, journalGeneration: row.journal_generation, scratch: row.scratch === 1,
      headSeq: row.head_seq, foldVersion: row.fold_version, foldedThrough: row.folded_through, journalSeq: row.journal_seq,
    } : undefined;
  }

  /** Changes whenever any lane of the session folds a row: each lane's generation and head seq, joined. */
  revision(sessionId: string): string {
    return (this.sql('SELECT lane,generation,head_seq FROM timeline_heads WHERE session_id=? ORDER BY lane').all(sessionId) as Array<{ lane: string; generation: string; head_seq: number }>)
      .map(row => `${row.lane}:${row.generation}:${row.head_seq}`).join(',');
  }

  putHead(head: TimelineHead): void {
    this.sql(`INSERT INTO timeline_heads(session_id,lane,generation,journal_generation,scratch,head_seq,fold_version,folded_through,journal_seq,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id,lane) DO UPDATE SET generation=excluded.generation, journal_generation=excluded.journal_generation,
      scratch=excluded.scratch, head_seq=excluded.head_seq, fold_version=excluded.fold_version, folded_through=excluded.folded_through,
      journal_seq=excluded.journal_seq, updated_at=excluded.updated_at`)
      .run(head.sessionId, head.lane, head.generation, head.journalGeneration, head.scratch ? 1 : 0, head.headSeq, head.foldVersion, head.foldedThrough, head.journalSeq, new Date().toISOString());
  }

  /** The blobs holding the whole of the lane's cut rows (`truncated.blobRef`); of the session's every lane without one. */
  truncatedBlobs(sessionId: string, lane?: SyncLane): string[] {
    const rows = (lane === undefined
      ? this.sql(`SELECT ${TRUNCATED_REF} AS ref FROM timeline_rows WHERE session_id=? AND ${CUT}`).all(sessionId)
      : this.sql(`SELECT ${TRUNCATED_REF} AS ref FROM timeline_rows WHERE session_id=? AND lane=? AND ${CUT}`).all(sessionId, lane)) as Array<{ ref: unknown }>;
    return rows.flatMap(row => typeof row.ref === 'string' ? [row.ref] : []);
  }

  /** The blob holding the whole of a stored row that was cut, if it was. */
  truncatedBlobOf(sessionId: string, lane: SyncLane, key: string): string | undefined {
    const row = this.sql(`SELECT ${TRUNCATED_REF} AS ref FROM timeline_rows WHERE session_id=? AND lane=? AND key=? AND ${CUT}`).get(sessionId, lane, key) as { ref: unknown } | undefined;
    return typeof row?.ref === 'string' ? row.ref : undefined;
  }

  /** Every row and turn of a lane goes; its head is the caller's to rewrite. */
  clearLane(sessionId: string, lane: SyncLane): void {
    this.sql('DELETE FROM timeline_rows WHERE session_id=? AND lane=?').run(sessionId, lane);
    this.sql('DELETE FROM timeline_turns WHERE session_id=? AND lane=?').run(sessionId, lane);
  }

  dropSession(sessionId: string): void {
    for (const table of ['timeline_rows', 'timeline_turns', 'timeline_heads']) this.sql(`DELETE FROM ${table} WHERE session_id=?`).run(sessionId);
  }

  // ---- rows --------------------------------------------------------------------------------

  rowState(sessionId: string, lane: SyncLane, key: string): RowState | undefined {
    const row = this.sql(`SELECT ${ROW_STATE} FROM timeline_rows WHERE session_id=? AND lane=? AND key=?`).get(sessionId, lane, key) as RowRecord | undefined;
    return row ? rowStateOf(row) : undefined;
  }

  row(sessionId: string, lane: SyncLane, key: string): (RowState & { payload: string }) | undefined {
    const row = this.sql(`SELECT ${ROW_STATE},payload FROM timeline_rows WHERE session_id=? AND lane=? AND key=?`).get(sessionId, lane, key) as (RowRecord & { payload: string }) | undefined;
    return row ? { ...rowStateOf(row), payload: row.payload } : undefined;
  }

  /** The live rows at or after `pos`: the part of a lane a fold of its tail produces. */
  rowsFrom(sessionId: string, lane: SyncLane, pos: number): RowState[] {
    return (this.sql(`SELECT ${ROW_STATE} FROM timeline_rows WHERE session_id=? AND lane=? AND pos>=? AND deleted=0`).all(sessionId, lane, pos) as unknown as RowRecord[]).map(rowStateOf);
  }

  /** Payloads of the live user rows before `pos`. */
  usersBefore(sessionId: string, lane: SyncLane, pos: number): Array<{ runId?: string; payload: string }> {
    return (this.sql("SELECT run_id,payload FROM timeline_rows WHERE session_id=? AND lane=? AND pos<? AND kind='user' AND deleted=0").all(sessionId, lane, pos) as Array<{ run_id: string | null; payload: string }>)
      .map(row => ({ ...(row.run_id !== null ? { runId: row.run_id } : {}), payload: row.payload }));
  }

  /** The user and assistant rows of one turn, in order, as sent. */
  textRows(sessionId: string, lane: SyncLane, turn: string, from: number, to: number): TimelineRow[] {
    return (this.sql("SELECT seq,rev,payload FROM timeline_rows WHERE session_id=? AND lane=? AND pos>=? AND pos<=? AND turn=? AND kind IN ('user','assistant') AND deleted=0 ORDER BY pos, key").all(sessionId, lane, from, to, turn) as Array<{ seq: number; rev: number; payload: string }>)
      .map(row => rowOf(row.payload, row.seq, row.rev));
  }

  /** Payloads of the session's live tool rows in every lane that name a location or an image. */
  toolPayloadsNaming(sessionId: string): string[] {
    return (this.sql(`SELECT payload FROM timeline_rows WHERE session_id=? AND key>='tool:' AND key<'tool;' AND deleted=0 AND (instr(payload,'"locations":[{')>0 OR instr(payload,'"image"')>0)`).all(sessionId) as Array<{ payload: string }>).map(row => row.payload);
  }

  /** Live tool rows before `pos`, keys and places only. */
  toolsBefore(sessionId: string, lane: SyncLane, pos: number): Array<{ key: string; pos: number }> {
    return this.sql("SELECT key,pos FROM timeline_rows WHERE session_id=? AND lane=? AND key>='tool:' AND key<'tool;' AND pos<? AND deleted=0").all(sessionId, lane, pos) as Array<{ key: string; pos: number }>;
  }

  putRow(sessionId: string, lane: SyncLane, state: RowState, payload: string): void {
    this.sql(`INSERT INTO timeline_rows(session_id,lane,key,pos,turn,seq,rev,run_id,deleted,kind,digest,bytes,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(session_id,lane,key) DO UPDATE SET pos=excluded.pos, turn=excluded.turn, seq=excluded.seq, rev=excluded.rev, run_id=excluded.run_id,
      deleted=excluded.deleted, kind=excluded.kind, digest=excluded.digest, bytes=excluded.bytes, payload=excluded.payload`)
      .run(sessionId, lane, state.key, state.pos, state.turn, state.seq, state.rev, state.runId ?? null, state.deleted ? 1 : 0, state.kind, state.digest, state.bytes, payload);
  }

  countLive(sessionId: string, lane: SyncLane): number {
    return (this.sql('SELECT COUNT(*) AS n FROM timeline_rows WHERE session_id=? AND lane=? AND deleted=0').get(sessionId, lane) as { n: number }).n;
  }

  /** How many rows changed after `seq`, and how big they are now. */
  changedSince(sessionId: string, lane: SyncLane, seq: number): { rows: number; bytes: number } {
    const row = this.sql('SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes FROM timeline_rows WHERE session_id=? AND lane=? AND seq>?').get(sessionId, lane, seq) as { n: number; bytes: number };
    return { rows: row.n, bytes: row.bytes };
  }

  /** Rows changed after `seq`, by seq: live ones with their payload, deleted ones as their key. */
  changesSince(sessionId: string, lane: SyncLane, seq: number): Array<{ key: string; seq: number; rev: number; deleted: boolean; payload: string }> {
    return (this.sql('SELECT key,seq,rev,deleted,payload FROM timeline_rows WHERE session_id=? AND lane=? AND seq>? ORDER BY seq').all(sessionId, lane, seq) as Array<{ key: string; seq: number; rev: number; deleted: number; payload: string }>)
      .map(row => ({ ...row, deleted: row.deleted === 1 }));
  }

  /** Live rows before `pos`, newest first: places and sizes, for picking a window within a budget. */
  placesBefore(sessionId: string, lane: SyncLane, pos: number, limit: number): Array<{ key: string; pos: number; bytes: number }> {
    return this.sql('SELECT key,pos,bytes FROM timeline_rows WHERE session_id=? AND lane=? AND pos<? AND deleted=0 ORDER BY pos DESC, key DESC LIMIT ?').all(sessionId, lane, pos, limit) as Array<{ key: string; pos: number; bytes: number }>;
  }

  /** Live rows at or after `pos`, oldest first: places and sizes. */
  placesFrom(sessionId: string, lane: SyncLane, pos: number, limit: number): Array<{ key: string; pos: number; bytes: number }> {
    return this.sql('SELECT key,pos,bytes FROM timeline_rows WHERE session_id=? AND lane=? AND pos>=? AND deleted=0 ORDER BY pos, key LIMIT ?').all(sessionId, lane, pos, limit) as Array<{ key: string; pos: number; bytes: number }>;
  }

  /** Live rows with `from <= pos <= to`, in order. */
  rowsBetween(sessionId: string, lane: SyncLane, from: number, to: number): TimelineRow[] {
    return (this.sql('SELECT seq,rev,payload FROM timeline_rows WHERE session_id=? AND lane=? AND pos>=? AND pos<=? AND deleted=0 ORDER BY pos, key').all(sessionId, lane, from, to) as Array<{ seq: number; rev: number; payload: string }>)
      .map(row => rowOf(row.payload, row.seq, row.rev));
  }

  /** The lane's live rows a find reads, places and revisions only; `image` rows hold no text. */
  findPlaces(sessionId: string, lane: SyncLane): Array<{ key: string; pos: number; turn: string; rev: number }> {
    return this.sql("SELECT key,pos,turn,rev FROM timeline_rows WHERE session_id=? AND lane=? AND deleted=0 AND kind<>'image'").all(sessionId, lane) as Array<{ key: string; pos: number; turn: string; rev: number }>;
  }

  /** The same rows with their content after [after] in place order, [limit] at a time, for a find reading the lane for the first time. */
  findRows(sessionId: string, lane: SyncLane, after: { pos: number; key: string } | undefined, limit: number): Array<{ key: string; pos: number; turn: string; rev: number; row: TimelineRow }> {
    const rows = (after
      ? this.sql("SELECT key,pos,turn,seq,rev,payload FROM timeline_rows WHERE session_id=? AND lane=? AND (pos>? OR (pos=? AND key>?)) AND deleted=0 AND kind<>'image' ORDER BY pos, key LIMIT ?").all(sessionId, lane, after.pos, after.pos, after.key, limit)
      : this.sql("SELECT key,pos,turn,seq,rev,payload FROM timeline_rows WHERE session_id=? AND lane=? AND deleted=0 AND kind<>'image' ORDER BY pos, key LIMIT ?").all(sessionId, lane, limit)) as Array<{ key: string; pos: number; turn: string; seq: number; rev: number; payload: string }>;
    return rows.map(row => ({ key: row.key, pos: row.pos, turn: row.turn, rev: row.rev, row: rowOf(row.payload, row.seq, row.rev) }));
  }

  /** The lane's live tool rows in order, as key and content digest: a reader redoes only the rows that changed. */
  toolDigests(sessionId: string, lane: SyncLane): Array<{ key: string; digest: string }> {
    return this.sql("SELECT key,digest FROM timeline_rows WHERE session_id=? AND lane=? AND kind='tool' AND deleted=0 ORDER BY pos").all(sessionId, lane) as Array<{ key: string; digest: string }>;
  }

  /** The lane's activity rows (`activity:<id>`), in order. */
  activityRows(sessionId: string, lane: SyncLane): TimelineRow[] {
    return (this.sql("SELECT seq,rev,payload FROM timeline_rows WHERE session_id=? AND lane=? AND key>='activity:' AND key<'activity;' AND deleted=0 ORDER BY pos, key").all(sessionId, lane) as Array<{ seq: number; rev: number; payload: string }>)
      .map(row => rowOf(row.payload, row.seq, row.rev));
  }

  hasBefore(sessionId: string, lane: SyncLane, pos: number): boolean {
    return Boolean(this.sql('SELECT 1 AS one FROM timeline_rows WHERE session_id=? AND lane=? AND pos<? AND deleted=0 LIMIT 1').get(sessionId, lane, pos));
  }

  hasAfter(sessionId: string, lane: SyncLane, pos: number): boolean {
    return Boolean(this.sql('SELECT 1 AS one FROM timeline_rows WHERE session_id=? AND lane=? AND pos>? AND deleted=0 LIMIT 1').get(sessionId, lane, pos));
  }

  // ---- turns -------------------------------------------------------------------------------

  putTurn(sessionId: string, lane: SyncLane, outline: TurnOutlineV3, cut: number | null): void {
    this.sql(`INSERT INTO timeline_turns(session_id,lane,turn,start_pos,cut,payload) VALUES(?,?,?,?,?,?)
      ON CONFLICT(session_id,lane,turn) DO UPDATE SET start_pos=excluded.start_pos, cut=COALESCE(excluded.cut, timeline_turns.cut), payload=excluded.payload`)
      .run(sessionId, lane, outline.turn, outline.startPos, cut, JSON.stringify(outline));
  }

  deleteTurn(sessionId: string, lane: SyncLane, turn: string): void {
    this.sql('DELETE FROM timeline_turns WHERE session_id=? AND lane=? AND turn=?').run(sessionId, lane, turn);
  }

  turn(sessionId: string, lane: SyncLane, turn: string): TurnOutlineV3 | undefined {
    const row = this.sql('SELECT payload FROM timeline_turns WHERE session_id=? AND lane=? AND turn=?').get(sessionId, lane, turn) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as TurnOutlineV3 : undefined;
  }

  turnsFrom(sessionId: string, lane: SyncLane, pos: number): StoredTurn[] {
    return this.turnRows(this.sql('SELECT turn,start_pos,cut,payload FROM timeline_turns WHERE session_id=? AND lane=? AND start_pos>=? ORDER BY start_pos').all(sessionId, lane, pos));
  }

  turnsBefore(sessionId: string, lane: SyncLane, pos: number): StoredTurn[] {
    return this.turnRows(this.sql('SELECT turn,start_pos,cut,payload FROM timeline_turns WHERE session_id=? AND lane=? AND start_pos<? ORDER BY start_pos').all(sessionId, lane, pos));
  }

  turnCount(sessionId: string, lane: SyncLane): number {
    return (this.sql('SELECT COUNT(*) AS n FROM timeline_turns WHERE session_id=? AND lane=?').get(sessionId, lane) as { n: number }).n;
  }

  /** The newest `limit` turns (every turn without one), oldest first, and how many the lane has. */
  outline(sessionId: string, lane: SyncLane, limit?: number): { turnCount: number; turns: TurnOutlineV3[] } {
    const turnCount = this.turnCount(sessionId, lane);
    const rows = limit === undefined
      ? this.sql('SELECT payload FROM timeline_turns WHERE session_id=? AND lane=? ORDER BY start_pos').all(sessionId, lane)
      : this.sql('SELECT payload FROM timeline_turns WHERE session_id=? AND lane=? ORDER BY start_pos DESC LIMIT ?').all(sessionId, lane, limit).reverse();
    return { turnCount, turns: (rows as Array<{ payload: string }>).map(row => JSON.parse(row.payload) as TurnOutlineV3) };
  }

  /** The latest place a fold of the lane may start from that is at or before identity `at`. */
  cutAtOrBefore(sessionId: string, lane: SyncLane, at: number): number | undefined {
    const row = this.sql('SELECT MAX(cut) AS cut FROM timeline_turns WHERE session_id=? AND lane=? AND cut IS NOT NULL AND cut<=?').get(sessionId, lane, at) as { cut: number | null };
    return row.cut ?? undefined;
  }

  private turnRows(rows: unknown[]): StoredTurn[] {
    return (rows as Array<{ turn: string; start_pos: number; cut: number | null; payload: string }>)
      .map(row => ({ turn: row.turn, startPos: row.start_pos, cut: row.cut, outline: JSON.parse(row.payload) as TurnOutlineV3 }));
  }
}
