import type { StatementSync } from 'node:sqlite';
import { STORAGE_BUDGET } from '../../../../packages/contracts/src/budgets.js';
import { prepareBlob, readStoredBlob, removeExternalBlob, sweepOrphanExternalBlobs, type PreparedBlob } from './blob-store.js';
import {
  ARCHIVED_TRIM_MARKER, COMPACT_BATCH, COMPACTABLE_KINDS_SQL, DICT_RECOMPRESS_MARKER,
  DRAFT_KIND, isPlainRecord,
} from './schema.js';

export interface JournalMaintenanceDeps {
  readonly blobsDir: string | undefined;
  sql(text: string): StatementSync;
  tx<T>(fn: () => T): T;
  whenSettled(fn: (committed: boolean) => void): void;
  isBlobGcHeld(): boolean;
  getBlob(hash: string): Buffer | undefined;
  storePreparedBlob(prepared: PreparedBlob, stamp?: string): void;
}

export function sweepJournalBlobs(deps: JournalMaintenanceDeps): number {
  if (deps.isBlobGcHeld()) return 0;
  const unreferenced = 'hash NOT IN (SELECT blob_ref FROM journal_events WHERE blob_ref IS NOT NULL) AND hash NOT IN (SELECT hash FROM session_blobs)';
  let externalRows: Array<{ hash: string; codec: string | null }> = [];
  const deleted = deps.tx(() => {
    if (deps.blobsDir) {
      externalRows = deps.sql(`SELECT hash, codec FROM blobs WHERE external=1 AND ${unreferenced}`).all() as Array<{ hash: string; codec: string | null }>;
    }
    return Number(deps.sql(`DELETE FROM blobs WHERE ${unreferenced}`).run().changes);
  });
  if (deps.blobsDir && externalRows.length) {
    const dir = deps.blobsDir;
    const toRemove = externalRows;
    deps.whenSettled(committed => {
      if (!committed) return;
      for (const row of toRemove) {
        if (deps.sql('SELECT 1 AS found FROM blobs WHERE hash=? AND external=1').get(row.hash)) continue;
        removeExternalBlob(dir, row.hash, row.codec);
      }
    });
  }
  return deleted;
}

export function sweepJournalExternalFiles(deps: JournalMaintenanceDeps): number {
  if (!deps.blobsDir || deps.isBlobGcHeld()) return 0;
  const exists = deps.sql('SELECT 1 AS found FROM blobs WHERE hash=? AND codec=? AND external=1');
  return sweepOrphanExternalBlobs(deps.blobsDir, (hash, codec) => Boolean(exists.get(hash, codec)));
}

export function recompressSmallJournalBlobs(deps: JournalMaintenanceDeps, options: { maxBlobs?: number; reset?: boolean } = {}): { recompressed: number; savedBytes: number } {
  const maxBlobs = options.maxBlobs ?? 1_000;
  if (maxBlobs <= 0) return { recompressed: 0, savedBytes: 0 };
  type Progress = { cursor?: string; done?: boolean };
  let progress: Progress = {};
  if (!options.reset) {
    const saved = deps.sql('SELECT json FROM settings WHERE key=?').get(DICT_RECOMPRESS_MARKER) as { json: string } | undefined;
    if (saved) {
      try { progress = JSON.parse(saved.json) as Progress; } catch { progress = {}; }
    }
    if (progress.done) return { recompressed: 0, savedBytes: 0 };
  }
  const saveProgress = (next: Progress) => {
    deps.sql('INSERT INTO settings(key,json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json')
      .run(DICT_RECOMPRESS_MARKER, JSON.stringify(next));
  };
  const pick = deps.sql(`SELECT hash, size, stored_size, codec, external, bytes FROM blobs
    WHERE external=0 AND codec IN ('raw','zstd') AND size>=? AND size<=? AND hash>?
    ORDER BY hash LIMIT ?`);
  const update = deps.sql("UPDATE blobs SET stored_size=?, codec=?, bytes=? WHERE hash=? AND external=0 AND codec IN ('raw','zstd')");
  let cursor = progress.cursor ?? '';
  let scanned = 0;
  let recompressed = 0;
  let savedBytes = 0;
  let reachedEnd = false;
  while (scanned < maxBlobs) {
    const batchSize = Math.min(200, maxBlobs - scanned);
    const rows = pick.all(STORAGE_BUDGET.blobCompressMinBytes, STORAGE_BUDGET.blobDictMaxBytes, cursor, batchSize) as Array<{
      hash: string; size: number; stored_size: number; codec: string; external: number; bytes: Uint8Array | null;
    }>;
    if (!rows.length) { reachedEnd = true; break; }
    cursor = rows.at(-1)!.hash;
    scanned += rows.length;
    const upgrades: Array<{ hash: string; storedSize: number; codec: string; bytes: Buffer; saved: number }> = [];
    for (const row of rows) {
      try {
        const plain = readStoredBlob(row, deps.blobsDir);
        if (!plain || plain[0] !== 0x7b) continue;
        const prepared = prepareBlob(plain, { mimeType: 'application/json' });
        const currentStored = row.stored_size > 0 ? row.stored_size : row.size;
        if (prepared.codec === 'zstd-d1' && prepared.storedSize + 16 < currentStored) {
          upgrades.push({
            hash: row.hash,
            storedSize: prepared.storedSize,
            codec: prepared.codec,
            bytes: prepared.storedBytes,
            saved: currentStored - prepared.storedSize,
          });
        }
      } catch { /* skip corrupt blob rather than aborting maintenance */ }
    }
    const batchEnd = rows.length < batchSize;
    deps.tx(() => {
      for (const item of upgrades) {
        const changed = Number(update.run(item.storedSize, item.codec, item.bytes, item.hash).changes);
        if (changed) { recompressed += 1; savedBytes += item.saved; }
      }
      saveProgress(batchEnd ? { done: true } : { cursor });
    });
    if (batchEnd) { reachedEnd = true; break; }
  }
  if (reachedEnd && scanned === 0) {
    deps.tx(() => saveProgress({ done: true }));
  }
  return { recompressed, savedBytes };
}

export function compactJournalDrafts(deps: JournalMaintenanceDeps): number {
  const pick = deps.sql(`SELECT rowid AS id FROM journal_events d WHERE d.kind='${DRAFT_KIND}' AND d.payload<>'{}' AND d.rowid>? AND EXISTS (
    SELECT 1 FROM journal_events n WHERE n.session_id=d.session_id AND n.native_id=d.native_id AND n.rev>d.rev AND n.kind<>'${DRAFT_KIND}')
    ORDER BY d.rowid LIMIT ?`);
  const empty = deps.sql(`UPDATE journal_events SET payload='{}', blob_ref=NULL WHERE rowid=?`);
  let after = 0, emptied = 0;
  for (;;) {
    const ids = (pick.all(after, COMPACT_BATCH) as Array<{ id: number }>).map(row => row.id);
    if (!ids.length) return emptied;
    deps.tx(() => { for (const id of ids) emptied += Number(empty.run(id).changes); });
    after = ids.at(-1)!;
    if (ids.length < COMPACT_BATCH) return emptied;
  }
}

export function compactJournalSuperseded(deps: JournalMaintenanceDeps, options: { minAgeMs?: number; maxUpdates?: number } = {}): number {
  const minAgeMs = options.minAgeMs ?? STORAGE_BUDGET.supersededLagMs;
  const maxUpdates = options.maxUpdates ?? 2_000;
  const cutoff = minAgeMs > 0 ? new Date(Date.now() - minAgeMs).toISOString() : undefined;
  const heads = deps.sql('SELECT session_id, last_seq, compacted_seq FROM journal_heads WHERE last_seq > compacted_seq').all() as Array<{ session_id: string; last_seq: number; compacted_seq: number }>;
  const pickNewer = deps.sql(`SELECT seq, native_id, rev, at FROM journal_events
    WHERE session_id=? AND seq>? AND rev>1 AND kind<>'${DRAFT_KIND}' ORDER BY seq LIMIT ?`);
  const stripOlder = deps.sql(`UPDATE journal_events SET payload='{}', blob_ref=NULL
    WHERE session_id=? AND native_id=? AND rev<? AND kind IN (${COMPACTABLE_KINDS_SQL}) AND (payload<>'{}' OR blob_ref IS NOT NULL)`);
  const advance = deps.sql('UPDATE journal_heads SET compacted_seq=? WHERE session_id=? AND compacted_seq<?');
  let stripped = 0;
  for (const head of heads) {
    if (stripped >= maxUpdates) break;
    let cursor = head.compacted_seq;
    let blockedAt: number | undefined;
    for (;;) {
      const batch = pickNewer.all(head.session_id, cursor, COMPACT_BATCH) as Array<{ seq: number; native_id: string; rev: number; at: string }>;
      if (!batch.length) break;
      const eligible: Array<{ seq: number; native_id: string; rev: number }> = [];
      for (const row of batch) {
        if (cutoff && row.at > cutoff) { blockedAt = row.seq - 1; break; }
        eligible.push(row);
        cursor = row.seq;
      }
      if (eligible.length) {
        deps.tx(() => {
          for (const row of eligible) stripped += Number(stripOlder.run(head.session_id, row.native_id, row.rev).changes);
          advance.run(cursor, head.session_id, cursor);
        });
      }
      if (blockedAt !== undefined || batch.length < COMPACT_BATCH || stripped >= maxUpdates) break;
    }
    if (blockedAt === undefined && stripped < maxUpdates && head.last_seq > cursor) {
      deps.tx(() => { advance.run(head.last_seq, head.session_id, head.last_seq); });
    }
  }
  return stripped;
}

export function trimArchivedJournalToolBlobs(deps: JournalMaintenanceDeps, sessionIds: readonly string[], options: { keepBytes?: number; limit?: number; beforeAt?: string } = {}): number {
  const keepBytes = options.keepBytes ?? STORAGE_BUDGET.archivedTrimKeepBytes;
  const minBytes = keepBytes * 2;
  const limit = options.limit ?? 40;
  const beforeAt = options.beforeAt;
  if (!sessionIds.length || keepBytes <= 0) return 0;
  const find = deps.sql(`SELECT e.session_id, e.seq, e.blob_ref, b.size FROM journal_events e
    JOIN blobs b ON b.hash = e.blob_ref
    WHERE (e.session_id=? OR (e.session_id>=? AND e.session_id<?))
      AND (e.session_id>? OR (e.session_id=? AND e.seq>?))
      AND e.kind IN ('tool_call','tool_call_update') AND e.blob_ref IS NOT NULL AND b.size > ?
      ${beforeAt ? 'AND e.at < ?' : ''}
    ORDER BY e.session_id ASC, e.seq ASC
    LIMIT ?`);
  const update = deps.sql('UPDATE journal_events SET blob_ref=? WHERE session_id=? AND seq=? AND blob_ref=?');
  const batchSize = Math.max(limit, 40);
  let trimmed = 0;
  for (const sessionId of sessionIds) {
    let cursorSession = '';
    let cursorSeq = 0;
    while (trimmed < limit) {
      const args = beforeAt
        ? [sessionId, `${sessionId}#`, `${sessionId}$`, cursorSession, cursorSession, cursorSeq, minBytes, beforeAt, batchSize]
        : [sessionId, `${sessionId}#`, `${sessionId}$`, cursorSession, cursorSession, cursorSeq, minBytes, batchSize];
      const candidates = find.all(...args) as Array<{ session_id: string; seq: number; blob_ref: string; size: number }>;
      if (!candidates.length) break;
      const tail = candidates[candidates.length - 1]!;
      cursorSession = tail.session_id;
      cursorSeq = tail.seq;
      for (const candidate of candidates) {
        if (trimmed >= limit) break;
        const raw = deps.getBlob(candidate.blob_ref);
        if (!raw) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(raw.toString('utf8')); } catch { continue; }
        const shrunk = trimToolPayloadOutputs(parsed, keepBytes);
        if (!shrunk) continue;
        const nextBytes = Buffer.from(JSON.stringify(shrunk));
        if (nextBytes.length >= candidate.size) continue;
        const prepared = prepareBlob(nextBytes, { mimeType: 'application/json', blobsDir: deps.blobsDir });
        deps.tx(() => {
          deps.storePreparedBlob(prepared);
          update.run(prepared.hash, candidate.session_id, candidate.seq, candidate.blob_ref);
        });
        trimmed += 1;
      }
      if (candidates.length < batchSize) break;
    }
    if (trimmed >= limit) break;
  }
  return trimmed;
}

function headTailTrim(text: string, keepBytes: number): string | undefined {
  const total = Buffer.byteLength(text);
  if (total <= keepBytes) return undefined;
  const half = Math.max(256, Math.floor((keepBytes - Buffer.byteLength(ARCHIVED_TRIM_MARKER)) / 2));
  const buf = Buffer.from(text);
  const head = buf.subarray(0, half).toString('utf8').replace(/\uFFFD+$/, '');
  const tail = buf.subarray(Math.max(half, buf.length - half)).toString('utf8').replace(/^\uFFFD+/, '');
  return `${head}${ARCHIVED_TRIM_MARKER}${tail}`;
}

function trimToolPayloadOutputs(payload: unknown, keepBytes: number): Record<string, unknown> | undefined {
  if (!isPlainRecord(payload) || !isPlainRecord(payload.data)) return undefined;
  let changed = false;
  const data: Record<string, unknown> = { ...payload.data };
  if (Array.isArray(data.content)) {
    data.content = data.content.map(block => {
      if (!isPlainRecord(block) || block.type === 'diff') return block;
      if (block.type === 'content' && isPlainRecord(block.content) && block.content.type === 'text' && typeof block.content.text === 'string') {
        const trimmed = headTailTrim(block.content.text, keepBytes);
        if (trimmed !== undefined) { changed = true; return { ...block, content: { ...block.content, text: trimmed } }; }
      }
      return block;
    });
  }
  if (typeof data.rawOutput === 'string') {
    const trimmed = headTailTrim(data.rawOutput, keepBytes);
    if (trimmed !== undefined) { changed = true; data.rawOutput = trimmed; }
  } else if (isPlainRecord(data.rawOutput)) {
    let rawChanged = false;
    const nextRaw: Record<string, unknown> = { ...data.rawOutput };
    for (const [key, value] of Object.entries(nextRaw)) {
      if (typeof value === 'string') {
        const trimmed = headTailTrim(value, keepBytes);
        if (trimmed !== undefined) { nextRaw[key] = trimmed; rawChanged = true; }
      }
    }
    if (rawChanged) { changed = true; data.rawOutput = nextRaw; }
  }
  return changed ? { ...payload, data } : undefined;
}
