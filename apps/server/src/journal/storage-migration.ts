import { existsSync, renameSync, rmSync, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SERVER_BUDGET, STORAGE_BUDGET } from '../../../../packages/contracts/src/budgets.js';
import type { FileChange } from '../../../../packages/contracts/src/sync.js';
import { toolFileChanges } from '../../../../packages/timeline/src/lineDiff.js';
import { openSqliteDatabase, storageLayoutForControlDb } from '../sqlite-storage.js';
import { prepareBlob, writeExternalBlob } from './blob-store.js';
import { DRAFT_KIND, JOURNAL_PAYLOAD_LIMIT, Journal, previewOf } from './journal.js';
import { generationOf } from '../timeline/fold.js';
import { TimelineTables } from '../timeline/tables.js';

const LEGACY_L1_TABLES = ['journal_heads', 'journal_events', 'blobs', 'session_blobs'] as const;
const LEGACY_L2_TABLES = ['timeline_heads', 'timeline_rows', 'timeline_turns', 'message_index', 'message_index_sessions', 'message_index_fts'] as const;
const LEGACY_ALL_TABLES = [...LEGACY_L1_TABLES, ...LEGACY_L2_TABLES] as const;

const COMPACTABLE_KINDS = new Set(['draft', 'tool_call', 'tool_call_update', 'agent_message_chunk', 'agent_thought_chunk', 'session/update']);
const BATCH_ROWS = 2_000;

function existingTables(db: DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  return new Set(rows.map(r => r.name));
}

/** True when `controlDbPath` still contains legacy L1/L2 tables that belong in `journal.db` / `derived.db`. */
export function needsStorageLayoutMigration(controlDbPath: string): boolean {
  if (controlDbPath === ':memory:' || !existsSync(controlDbPath)) return false;
  const db = new DatabaseSync(controlDbPath, { readOnly: true, timeout: 5000 });
  try {
    const tables = existingTables(db);
    return LEGACY_ALL_TABLES.some(name => tables.has(name));
  } finally {
    db.close();
  }
}

function removeDbFiles(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
}

function promoteTempDb(tempPath: string, targetPath: string): void {
  // Checkpoint and flush WAL before renaming so the target is a single self-contained file.
  const db = new DatabaseSync(tempPath);
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
  } finally {
    db.close();
  }
  rmSync(`${tempPath}-wal`, { force: true });
  rmSync(`${tempPath}-shm`, { force: true });
  rmSync(`${targetPath}-wal`, { force: true });
  rmSync(`${targetPath}-shm`, { force: true });
  renameSync(tempPath, targetPath);
}

/**
 * Atomically splits a legacy single-file `workbench.db` into the three-database layout:
 * - `workbench.db` (L0): control plane tables only, shrunk with VACUUM + INCREMENTAL auto-vacuum.
 * - `journal.db` + `blobs/` (L1): journal envelopes (<= 2 KiB), superseded revisions stripped, Zstd CAS blobs.
 * - `derived.db` (L2): hot timeline lanes + asymmetrically trimmed `message_index` (cold rows dropped).
 *
 * Crash-safe & idempotent: source `workbench.db` is read-only until both companion databases are
 * completely written, flushed and atomically renamed into place.
 */
export function migrateStorageLayout(controlDbPath: string, log: (line: string) => void = console.log): boolean {
  const layout = storageLayoutForControlDb(controlDbPath);
  if (!layout || !existsSync(controlDbPath)) return false;
  // Set SQLITE_TMPDIR before opening SQLite connections so temp files during VACUUM stay beside the database.
  process.env.SQLITE_TMPDIR ??= layout.stateDir;
  if (!needsStorageLayoutMigration(controlDbPath)) return false;
  const sourceBytes = statSync(controlDbPath).size + (statSync(`${controlDbPath}-wal`, { throwIfNoEntry: false })?.size ?? 0);
  const disk = statfsSync(layout.stateDir);
  const available = disk.bavail * disk.bsize;
  if (available < sourceBytes) {
    throw new Error(`Not enough free disk space to migrate storage layout: need at least ${(sourceBytes / 1048576).toFixed(1)} MiB, only ${(available / 1048576).toFixed(1)} MiB available`);
  }

  const src = new DatabaseSync(controlDbPath, { readOnly: true, timeout: 5000 });
  const srcTables = existingTables(src);
  const hasL1 = LEGACY_L1_TABLES.some(name => srcTables.has(name));
  const hasL2 = LEGACY_L2_TABLES.some(name => srcTables.has(name));
  const shouldMigrateL1 = hasL1 && !existsSync(layout.journal);
  const shouldMigrateL2 = hasL2 && !existsSync(layout.derived);

  const journalTemp = `${layout.journal}.migrating`;
  const derivedTemp = `${layout.derived}.migrating`;

  try {
    // Identify hot sessions (active within `coldTimelineDays` or currently running) so cold timeline rows are not copied.
    const coldCutoff = new Date(Date.now() - SERVER_BUDGET.coldTimelineDays * 86_400_000).toISOString();
    const hotSessions = new Set<string>();
    if (srcTables.has('sessions')) {
      const runningStates = new Set(['starting', 'running', 'waiting', 'cancelling']);
      for (const row of src.prepare("SELECT id, json_extract(json,'$.lastActivityAt') AS last, json_extract(json,'$.updatedAt') AS updated, json_extract(json,'$.state') AS state FROM sessions").all() as Array<{ id: string; last: string | null; updated: string | null; state: string | null }>) {
        const latest = [row.last, row.updated].filter((v): v is string => typeof v === 'string').sort().at(-1);
        if ((row.state && runningStates.has(row.state)) || (latest && latest >= coldCutoff)) hotSessions.add(row.id);
      }
    }

    // Collect truncated row blob hashes that are safely reconstructible from the journal (non-empty bounded
    // `sourceIds`, not guarded/scalars-truncated, not status/job/pending), so legacy duplicate `RowContent`
    // JSON blobs are not carried forward into the new CAS store.
    const skippableTruncatedBlobs = new Set<string>();
    if (shouldMigrateL1 && srcTables.has('timeline_rows')) {
      const rows = src.prepare(`SELECT kind, payload FROM timeline_rows WHERE deleted=0 AND instr(payload,'"truncated":')>0`)
        .all() as Array<{ kind: string; payload: string }>;
      for (const row of rows) {
        if (row.kind === 'status') continue;
        if (row.payload.includes('"job":{') || row.payload.includes('"pending":')) continue;
        try {
          const parsed = JSON.parse(row.payload) as {
            truncated?: { blobRef?: unknown };
            event?: { sourceIds?: unknown; data?: { truncated?: unknown } };
          };
          const sourceIds = parsed.event?.sourceIds;
          const ref = parsed.truncated?.blobRef;
          if (typeof ref === 'string' && ref && Array.isArray(sourceIds) && sourceIds.length > 0 && sourceIds.length <= 64 && parsed.event?.data?.truncated !== true) {
            skippableTruncatedBlobs.add(ref);
          }
        } catch { /* ignore malformed row */ }
      }
    }

    if (shouldMigrateL1) {
      log(`[storage] migrating L1 journal to ${layout.journal} (stripping superseded revisions & Zstd compressing blobs)...`);
      removeDbFiles(journalTemp);
      const jdb = openSqliteDatabase(journalTemp);
      try {
        // Construct Journal to initialize v3 schema cleanly.
        const journal = new Journal(jdb, undefined, undefined, undefined, { blobsDir: layout.blobsDir });
        void journal;

        const insertHead = jdb.prepare(`INSERT OR REPLACE INTO journal_heads
          (session_id,generation,last_seq,ingest_cursor,projection,projection_seq,updated_at,identity,compacted_seq)
          VALUES(?,?,?,?,?,?,?,?,?)`);
        const insertEvent = jdb.prepare(`INSERT INTO journal_events
          (session_id,seq,kind,native_id,rev,turn_id,at,digest,blob_ref,payload)
          VALUES(?,?,?,?,?,?,?,?,?,?)`);
        const insertBlob = jdb.prepare(`INSERT OR IGNORE INTO blobs
          (hash,size,stored_size,codec,external,bytes,created_at)
          VALUES(?,?,?,?,?,?,?)`);
        const insertSessionBlob = jdb.prepare('INSERT OR IGNORE INTO session_blobs(session_id,hash,type) VALUES(?,?,?)');

        // 1. Copy journal_heads (mark `compacted_seq = last_seq` because superseded revisions are stripped during copy).
        if (srcTables.has('journal_heads')) {
          const hasIdentity = (src.prepare('PRAGMA table_info(journal_heads)').all() as Array<{ name: string }>).some(c => c.name === 'identity');
          const heads = src.prepare(`SELECT session_id,generation,last_seq,ingest_cursor,projection,projection_seq,updated_at${hasIdentity ? ',identity' : ''} FROM journal_heads`)
            .all() as Array<{ session_id: string; generation: string; last_seq: number; ingest_cursor: string | null; projection: string | null; projection_seq: number; updated_at: string; identity?: string | null }>;
          jdb.exec('BEGIN IMMEDIATE');
          for (const h of heads) {
            insertHead.run(h.session_id, h.generation, h.last_seq, h.ingest_cursor, h.projection, h.projection_seq, h.updated_at, h.identity ?? null, h.last_seq);
          }
          jdb.exec('COMMIT');
        }

        // Helper to read a legacy blob's raw bytes.
        const readLegacyBlob = srcTables.has('blobs')
          ? src.prepare('SELECT bytes, created_at FROM blobs WHERE hash=?')
          : undefined;
        const writtenBlobs = new Set<string>();
        const storeBlob = (rawBytes: Buffer, mimeType: string | undefined, createdAt: string): string => {
          const prepared = prepareBlob(rawBytes, { mimeType, blobsDir: layout.blobsDir });
          if (!writtenBlobs.has(prepared.hash)) {
            if (prepared.external) writeExternalBlob(layout.blobsDir, prepared);
            insertBlob.run(prepared.hash, prepared.size, prepared.storedSize, prepared.codec, prepared.external ? 1 : 0, prepared.external ? null : prepared.storedBytes, createdAt);
            writtenBlobs.add(prepared.hash);
          }
          return prepared.hash;
        };

        // 2. Copy journal_events lane-by-lane, stripping superseded revisions and compressing > 2 KiB payloads.
        if (srcTables.has('journal_events')) {
          const maxRevByEntity = src.prepare(`SELECT native_id, MAX(rev) AS max_rev FROM journal_events WHERE session_id=? AND kind<>'${DRAFT_KIND}' GROUP BY native_id`);
          const selectEvents = src.prepare('SELECT seq,kind,native_id,rev,turn_id,at,payload,blob_ref,digest FROM journal_events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?');
          const sessions = (src.prepare('SELECT DISTINCT session_id FROM journal_events').all() as Array<{ session_id: string }>).map(r => r.session_id);
          let totalEvents = 0, strippedEvents = 0;

          for (const sessionId of sessions) {
            const committedMax = new Map<string, number>();
            for (const row of maxRevByEntity.all(sessionId) as Array<{ native_id: string; max_rev: number }>) {
              committedMax.set(row.native_id, row.max_rev);
            }
            let afterSeq = 0;
            for (;;) {
              const rows = selectEvents.all(sessionId, afterSeq, BATCH_ROWS) as Array<{
                seq: number; kind: string; native_id: string; rev: number; turn_id: string | null; at: string; payload: string; blob_ref: string | null; digest: string;
              }>;
              if (!rows.length) break;
              afterSeq = rows.at(-1)!.seq;
              jdb.exec('BEGIN IMMEDIATE');
              try {
                for (const row of rows) {
                  totalEvents += 1;
                  const topRev = committedMax.get(row.native_id);
                  const superseded = topRev !== undefined && row.rev < topRev && COMPACTABLE_KINDS.has(row.kind);
                  if (superseded) {
                    strippedEvents += 1;
                    insertEvent.run(sessionId, row.seq, row.kind, row.native_id, row.rev, row.turn_id, row.at, row.digest, null, '{}');
                    continue;
                  }
                  let payload = row.payload;
                  let blobRef: string | null = null;
                  if (row.blob_ref && readLegacyBlob) {
                    const raw = readLegacyBlob.get(row.blob_ref) as { bytes: Uint8Array; created_at: string } | undefined;
                    if (raw) {
                      const buf = Buffer.from(raw.bytes);
                      blobRef = storeBlob(buf, 'application/json', raw.created_at || row.at);
                      if (Buffer.byteLength(payload) > JOURNAL_PAYLOAD_LIMIT) {
                        try { payload = JSON.stringify(previewOf(JSON.parse(buf.toString('utf8')))); } catch { /* keep existing preview */ }
                      }
                    }
                  } else if (Buffer.byteLength(payload) > JOURNAL_PAYLOAD_LIMIT) {
                    const buf = Buffer.from(payload);
                    blobRef = storeBlob(buf, 'application/json', row.at);
                    try { payload = JSON.stringify(previewOf(JSON.parse(payload))); } catch { payload = '{"truncated":true}'; }
                  }
                  insertEvent.run(sessionId, row.seq, row.kind, row.native_id, row.rev, row.turn_id, row.at, row.digest, blobRef, payload);
                }
                jdb.exec('COMMIT');
              } catch (error) {
                jdb.exec('ROLLBACK');
                throw error;
              }
            }
          }
          log(`[storage] migrated ${totalEvents} journal rows (${strippedEvents} superseded revisions stripped, ${writtenBlobs.size} compressed blobs)`);
        }

        // 3. Copy durable session_blobs (images, activities, discussions, session references — skipping legacy reconstructible cut rows).
        if (srcTables.has('session_blobs') && readLegacyBlob) {
          const allSessionBlobs = src.prepare('SELECT session_id, hash, type FROM session_blobs').all() as Array<{ session_id: string; hash: string; type: string }>;
          let kept = 0, skipped = 0;
          jdb.exec('BEGIN IMMEDIATE');
          try {
            for (const sb of allSessionBlobs) {
              if (sb.type === 'application/json' && skippableTruncatedBlobs.has(sb.hash)) {
                skipped += 1;
                continue;
              }
              const raw = readLegacyBlob.get(sb.hash) as { bytes: Uint8Array; created_at: string } | undefined;
              if (!raw) continue;
              const hash = storeBlob(Buffer.from(raw.bytes), sb.type, raw.created_at || new Date().toISOString());
              insertSessionBlob.run(sb.session_id, hash, sb.type);
              kept += 1;
            }
            jdb.exec('COMMIT');
          } catch (error) {
            jdb.exec('ROLLBACK');
            throw error;
          }
          log(`[storage] migrated ${kept} session blobs (dropped ${skipped} redundant truncated-row copies)`);
        }
      } finally {
        jdb.close();
      }
    }

    if (shouldMigrateL2) {
      log(`[storage] migrating L2 derived views to ${layout.derived}...`);
      removeDbFiles(derivedTemp);
      const ddb = openSqliteDatabase(derivedTemp);
      try {
        // Initialize timeline tables + search tables.
        const tables = new TimelineTables(ddb);
        void tables;
        ddb.exec(`
          CREATE TABLE IF NOT EXISTS message_index (
            session_id TEXT NOT NULL, message_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL,
            PRIMARY KEY (session_id, message_id));
          CREATE INDEX IF NOT EXISTS message_index_session ON message_index(session_id);
          CREATE TABLE IF NOT EXISTS message_index_sessions (session_id TEXT PRIMARY KEY, indexed_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS derived_meta (key TEXT PRIMARY KEY, json TEXT NOT NULL);`);

        // 1. Migrate timeline heads, hot rows & turns; cold sessions keep only heads (with subagent summaries).
        if (srcTables.has('timeline_heads')) {
          const hasEpoch = (src.prepare('PRAGMA table_info(timeline_heads)').all() as Array<{ name: string }>).some(c => c.name === 'epoch');
          const hasSummary = (src.prepare('PRAGMA table_info(timeline_heads)').all() as Array<{ name: string }>).some(c => c.name === 'summary');
          const heads = src.prepare(`SELECT session_id,lane,generation,journal_generation,scratch,${hasEpoch ? 'epoch' : '0 AS epoch'},head_seq,fold_version,folded_through,journal_seq,${hasSummary ? 'summary' : 'NULL AS summary'},updated_at FROM timeline_heads`)
            .all() as Array<{ session_id: string; lane: string; generation: string; journal_generation: string | null; scratch: number; epoch: number; head_seq: number; fold_version: number; folded_through: number; journal_seq: number; summary: string | null; updated_at: string }>;
          const insertHead = ddb.prepare(`INSERT OR REPLACE INTO timeline_heads
            (session_id,lane,generation,journal_generation,scratch,epoch,head_seq,fold_version,folded_through,journal_seq,summary,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
          const insertRow = ddb.prepare(`INSERT OR REPLACE INTO timeline_rows
            (session_id,lane,key,pos,turn,seq,rev,run_id,deleted,kind,digest,bytes,truncated_hash,payload)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
          const insertTurn = ddb.prepare(`INSERT OR REPLACE INTO timeline_turns
            (session_id,lane,turn,start_pos,cut,payload) VALUES(?,?,?,?,?,?)`);
          const countLive = srcTables.has('timeline_rows')
            ? src.prepare('SELECT COUNT(*) AS n FROM timeline_rows WHERE session_id=? AND lane=? AND deleted=0')
            : undefined;
          const selectToolPayloads = srcTables.has('timeline_rows')
            ? src.prepare("SELECT payload FROM timeline_rows WHERE session_id=? AND lane=? AND kind='tool' AND deleted=0 ORDER BY pos")
            : undefined;
          const selectRows = srcTables.has('timeline_rows')
            ? src.prepare(`SELECT key,pos,turn,seq,rev,run_id,deleted,kind,digest,bytes,payload,
                CASE WHEN deleted=0 AND instr(payload,'"truncated":')>0 AND json_valid(payload) THEN json_extract(payload,'$.truncated.blobRef') END AS tref
              FROM timeline_rows WHERE session_id=? AND lane=?`)
            : undefined;
          const selectTurns = srcTables.has('timeline_turns')
            ? src.prepare('SELECT turn,start_pos,cut,payload FROM timeline_turns WHERE session_id=? AND lane=?')
            : undefined;

          // Keep a session's rows if it is hot OR if no `sessions` table existed (standalone unit test DB).
          const keepRows = (sessionId: string) => !srcTables.has('sessions') || hotSessions.has(sessionId);
          for (const h of heads) {
            const hot = keepRows(h.session_id);
            ddb.exec('BEGIN IMMEDIATE');
            try {
              if (hot) {
                insertHead.run(h.session_id, h.lane, h.generation, h.journal_generation, h.scratch, h.epoch, h.head_seq, h.fold_version, h.folded_through, h.journal_seq, h.summary, h.updated_at);
                if (selectRows) {
                  for (const r of selectRows.all(h.session_id, h.lane) as Array<{ key: string; pos: number; turn: string; seq: number; rev: number; run_id: string | null; deleted: number; kind: string; digest: string; bytes: number; payload: string; tref: string | null }>) {
                    insertRow.run(h.session_id, h.lane, r.key, r.pos, r.turn, r.seq, r.rev, r.run_id, r.deleted, r.kind, r.digest, r.bytes, r.tref, r.payload);
                  }
                }
                if (selectTurns) {
                  for (const t of selectTurns.all(h.session_id, h.lane) as Array<{ turn: string; start_pos: number; cut: number | null; payload: string }>) {
                    insertTurn.run(h.session_id, h.lane, t.turn, t.start_pos, t.cut, t.payload);
                  }
                }
              } else {
                // Cold lane: drop rows/turns during migration; preserve subagent summary (rows + file changes).
                let summary = h.summary;
                if (!summary && h.lane !== 'main' && countLive) {
                  const n = (countLive.get(h.session_id, h.lane) as { n: number }).n;
                  if (n > 0) {
                    const byPath = new Map<string, FileChange>();
                    if (selectToolPayloads) {
                      for (const row of selectToolPayloads.all(h.session_id, h.lane) as Array<{ payload: string }>) {
                        try {
                          const parsed = JSON.parse(row.payload) as { kind?: unknown; event?: { data?: Record<string, unknown> } };
                          if (parsed.kind !== 'tool' || !parsed.event?.data) continue;
                          for (const change of toolFileChanges(parsed.event.data)) {
                            const cur = byPath.get(change.path);
                            byPath.delete(change.path);
                            byPath.set(change.path, cur ? { ...cur, added: cur.added + change.added, removed: cur.removed + change.removed } : change);
                          }
                        } catch { /* ignore malformed row */ }
                      }
                    }
                    summary = JSON.stringify({ rows: n, changes: [...byPath.values()].slice(-200) });
                  }
                }
                const nextEpoch = h.head_seq > 0 || h.folded_through > 0 ? h.epoch + 1 : h.epoch;
                insertHead.run(h.session_id, h.lane, generationOf(h.journal_generation ?? undefined, nextEpoch), h.journal_generation, h.scratch, nextEpoch, 0, h.fold_version, 0, 0, summary, h.updated_at);
              }
              ddb.exec('COMMIT');
            } catch (error) {
              ddb.exec('ROLLBACK');
              throw error;
            }
          }
        }

        // 2. Migrate message_index (trimming `tool` rows to `STORAGE_BUDGET.toolIndexChars`).
        if (srcTables.has('message_index')) {
          const selectMsg = src.prepare('SELECT rowid, session_id, message_id, kind, text, at FROM message_index WHERE rowid>? ORDER BY rowid LIMIT ?');
          const insertMsg = ddb.prepare('INSERT OR REPLACE INTO message_index(session_id,message_id,kind,text,at) VALUES(?,?,?,?,?)');
          let afterRowid = 0;
          for (;;) {
            const batch = selectMsg.all(afterRowid, BATCH_ROWS) as Array<{ rowid: number; session_id: string; message_id: string; kind: string; text: string; at: string }>;
            if (!batch.length) break;
            afterRowid = batch.at(-1)!.rowid;
            ddb.exec('BEGIN IMMEDIATE');
            try {
              for (const row of batch) {
                const text = row.kind === 'tool' && row.text.length > STORAGE_BUDGET.toolIndexChars
                  ? row.text.slice(0, STORAGE_BUDGET.toolIndexChars).trim()
                  : row.text;
                insertMsg.run(row.session_id, row.message_id, row.kind, text, row.at);
              }
              ddb.exec('COMMIT');
            } catch (error) {
              ddb.exec('ROLLBACK');
              throw error;
            }
          }
        }
        if (srcTables.has('message_index_sessions')) {
          const rows = src.prepare('SELECT session_id, indexed_at FROM message_index_sessions').all() as Array<{ session_id: string; indexed_at: string }>;
          const insertMark = ddb.prepare('INSERT OR REPLACE INTO message_index_sessions(session_id,indexed_at) VALUES(?,?)');
          ddb.exec('BEGIN IMMEDIATE');
          try {
            for (const row of rows) insertMark.run(row.session_id, row.indexed_at);
            ddb.exec('COMMIT');
          } catch (error) {
            ddb.exec('ROLLBACK');
            throw error;
          }
        }
      } finally {
        ddb.close();
      }
    }
  } catch (error) {
    src.close();
    removeDbFiles(journalTemp);
    removeDbFiles(derivedTemp);
    throw error;
  }
  src.close();

  // Atomically promote migrated companion databases before touching the source control database.
  if (shouldMigrateL1) promoteTempDb(journalTemp, layout.journal);
  if (shouldMigrateL2) promoteTempDb(derivedTemp, layout.derived);

  // Drop migrated legacy tables from L0 `workbench.db` and shrink it in place (only small L0 tables remain).
  process.env.SQLITE_TMPDIR ??= layout.stateDir;
  const control = new DatabaseSync(controlDbPath, { timeout: 5000 });
  try {
    control.exec('PRAGMA temp_store=FILE; PRAGMA foreign_keys=OFF;');
    control.exec(`
      DROP TRIGGER IF EXISTS message_index_fts_insert;
      DROP TRIGGER IF EXISTS message_index_fts_update;
      DROP TRIGGER IF EXISTS message_index_fts_delete;
      DROP TABLE IF EXISTS message_index_fts;
      DROP TABLE IF EXISTS message_index;
      DROP TABLE IF EXISTS message_index_sessions;
      DROP TABLE IF EXISTS timeline_rows;
      DROP TABLE IF EXISTS timeline_turns;
      DROP TABLE IF EXISTS timeline_heads;
      DROP TABLE IF EXISTS session_blobs;
      DROP TABLE IF EXISTS journal_events;
      DROP TABLE IF EXISTS journal_heads;
      DROP TABLE IF EXISTS blobs;
    `);
    control.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA auto_vacuum=INCREMENTAL; VACUUM; PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE);');
  } finally {
    control.close();
  }
  // Invalidate any pre-migration scan cache so the storage page reflects the new three-database layout immediately.
  rmSync(join(layout.stateDir, 'storage-scan.json'), { force: true });
  log(`[storage] storage layout migration complete (${controlDbPath} -> L0 + journal.db + derived.db + blobs/)`);
  return true;
}
