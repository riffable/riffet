import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { STORAGE_BUDGET } from '../../../../packages/contracts/src/budgets.js';

export type BlobCodec = 'raw' | 'zstd' | 'zstd-d1';

/** A blob prepared outside any SQLite transaction lock (hash + optional Zstd compression + tier routing). */
export interface PreparedBlob {
  hash: string;
  size: number;
  storedSize: number;
  codec: BlobCodec;
  storedBytes: Buffer;
  external: boolean;
}

export interface StoredBlobRow {
  hash: string;
  codec?: string | null;
  external?: number | null;
  bytes?: Uint8Array | null;
}

const ZSTD_OPTIONS = { params: { [zlibConstants.ZSTD_c_compressionLevel]: 3 } } as const;
const INCOMPRESSIBLE_MIME = /^(?:image|video|audio)\/|^application\/(?:zip|gzip|x-gzip|zstd|pdf|octet-stream)\b/i;
const JSON_MIME = /^application\/(?:[\w.+-]+\+)?json\b/i;
const HASH_FILE_RE = /^([0-9a-f]{64})\.(raw|zst)$/;
const ORPHAN_TMP_AGE_MS = 10 * 60_000;

/**
 * Immutable static Zstd raw-content dictionary (`codec = 'zstd-d1'`) for small/medium journal JSON payloads
 * (`<= STORAGE_BUDGET.blobDictMaxBytes`). Contains only generic public ACP/Riffet event keys and structural
 * templates. NEVER mutate existing bytes; introduce `'zstd-d2'` if a future dictionary revision is needed.
 */
const JOURNAL_JSON_DICT_V1 = Buffer.from(
  [
    '{"type":"tool_call","nativeId":"claude:","runId":"claude-turn:","createdAt":"2026-01-01T00:00:00.000Z","nativeTurnId":"claude-turn:","data":{"sessionUpdate":"tool_call","toolCallId":"toolu_","title":"","kind":"read","status":"in_progress","rawInput":{"file_path":"","path":"","command":"","pattern":"","description":"","old_string":"","new_string":"","offset":1,"limit":200,"glob":"","output_mode":"content"},"locations":[{"path":"","line":1}],"content":[{"type":"content","content":{"type":"text","text":""}}]}}',
    '{"type":"tool_call_update","nativeId":"codex:","runId":"codex-turn:","createdAt":"2026-01-01T00:00:00.000Z","nativeTurnId":"codex-turn:","data":{"sessionUpdate":"tool_call_update","toolCallId":"call_","title":"","kind":"execute","status":"completed","rawInput":{"command":"","workdir":"","timeout":30000},"rawOutput":{"stdout":"","stderr":"","exitCode":0,"output":"","durationMs":0},"jobResult":{"exitCode":0},"content":[{"type":"content","content":{"type":"text","text":"Exit code 0\\n"}},{"type":"diff","path":"","oldText":"","newText":"","lineOffset":1,"newLineOffset":1,"observed":true}]}}',
    '{"type":"agent_message_chunk","nativeId":"cursor:","createdAt":"2026-01-01T00:00:00.000Z","data":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":""},"phase":"final_answer","stopReason":"end_turn"}}',
    '{"type":"agent_thought_chunk","nativeId":"","createdAt":"2026-01-01T00:00:00.000Z","data":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":""}}}',
    '{"type":"user_message_chunk","nativeId":"","createdAt":"2026-01-01T00:00:00.000Z","data":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":""},"attachments":[{"id":"","name":"","type":"image/png"}]}}',
    '{"type":"session/update","data":{"sessionUpdate":"activity","activity":{"id":"","kind":"background_task","status":"running","title":"","toolCallId":"","startedAt":"","endedAt":"","durationMs":0,"detail":"","task":{"kind":"bash","command":"","exitCode":0}}}}',
    '{"kind":"edit","status":"failed","error":"","sourceIds":[""],"truncated":{"blobRef":"","bytes":0},"filePath":"","replace_all":false,"subagentType":"explore","prompt":"","subagent_type":"generalPurpose","model":"inherit"}',
    '{"type":"diff","path":"apps/server/src/","oldText":"import { ","newText":"export function ","type":"text","text":"```typescript\\n\\n```\\n","status":"pending","status":"running","status":"cancelled","kind":"search","kind":"think","kind":"fetch","kind":"other"}',
  ].join('\n'),
  'utf8',
);

const ZSTD_DICT_V1_OPTIONS = {
  dictionary: JOURNAL_JSON_DICT_V1,
  params: { [zlibConstants.ZSTD_c_compressionLevel]: 3 },
} as const;

export function blobSha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function externalBlobPath(blobsDir: string, hash: string, codec: BlobCodec): string {
  const ext = codec === 'raw' ? 'raw' : 'zst';
  return join(blobsDir, hash.slice(0, 2), `${hash}.${ext}`);
}

/**
 * Computes content hash and optional Zstd compression strictly outside database locks.
 * Logical identity (`hash`, `size`) is always derived from the uncompressed plaintext bytes.
 * Small/medium JSON blobs (`<= STORAGE_BUDGET.blobDictMaxBytes`) use the immutable static JSON
 * dictionary (`zstd-d1`) when it beats plain Zstd; larger blobs use plain `zstd`.
 */
export function prepareBlob(bytes: Buffer, options: { mimeType?: string; blobsDir?: string } = {}): PreparedBlob {
  const hash = blobSha256(bytes);
  const size = bytes.length;
  let codec: BlobCodec = 'raw';
  let storedBytes = bytes;
  const compressible = size >= STORAGE_BUDGET.blobCompressMinBytes && !(options.mimeType && INCOMPRESSIBLE_MIME.test(options.mimeType));
  if (compressible) {
    const isSmallJsonObject = size <= STORAGE_BUDGET.blobDictMaxBytes
      && bytes[0] === 0x7b
      && Boolean(options.mimeType && JSON_MIME.test(options.mimeType));
    const compressed = isSmallJsonObject
      ? zstdCompressSync(bytes, ZSTD_DICT_V1_OPTIONS)
      : zstdCompressSync(bytes, ZSTD_OPTIONS);
    if (compressed.length + 16 < size) {
      codec = isSmallJsonObject ? 'zstd-d1' : 'zstd';
      storedBytes = compressed;
    }
  }
  const storedSize = storedBytes.length;
  // Dictionary-compressed blobs are strictly <= 16 KiB, so external Tier-2 files are always plain `zstd` or `raw`.
  const external = Boolean(options.blobsDir && storedSize >= STORAGE_BUDGET.blobExternalBytes);
  return { hash, size, storedSize, codec, storedBytes, external };
}

/** Writes an immutable Tier-2 external blob file atomically; a no-op if already present. */
export function writeExternalBlob(blobsDir: string, prepared: PreparedBlob): void {
  if (!prepared.external) return;
  const target = externalBlobPath(blobsDir, prepared.hash, prepared.codec);
  if (existsSync(target)) return;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, prepared.storedBytes, { mode: 0o600 });
  try {
    renameSync(temp, target);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* ignore */ }
    if (!existsSync(target)) throw error;
  }
}

/** Reads and transparently decompresses a blob from either SQLite inline bytes or the Tier-2 directory. */
export function readStoredBlob(row: StoredBlobRow, blobsDir?: string): Buffer | undefined {
  let codec: BlobCodec = row.codec === 'zstd-d1' ? 'zstd-d1' : row.codec === 'zstd' ? 'zstd' : 'raw';
  let encoded: Buffer | undefined;
  if (row.external === 1) {
    if (!blobsDir) return undefined;
    const altCodec: BlobCodec = codec === 'raw' ? 'zstd' : 'raw';
    const primary = externalBlobPath(blobsDir, row.hash, codec);
    const fallback = externalBlobPath(blobsDir, row.hash, altCodec);
    try { encoded = readFileSync(primary); }
    catch {
      try { encoded = readFileSync(fallback); codec = altCodec; } catch { return undefined; }
    }
  } else if (row.bytes) {
    encoded = Buffer.from(row.bytes);
  }
  if (!encoded) return undefined;
  if (codec === 'zstd-d1') return zstdDecompressSync(encoded, { dictionary: JOURNAL_JSON_DICT_V1 });
  if (codec === 'zstd') return zstdDecompressSync(encoded);
  return encoded;
}

/** Removes a Tier-2 blob file after its database row is deleted. */
export function removeExternalBlob(blobsDir: string, hash: string, codec?: string | null): void {
  const names: BlobCodec[] = codec === 'raw' ? ['raw', 'zstd'] : ['zstd', 'raw'];
  for (const kind of names) {
    try { unlinkSync(externalBlobPath(blobsDir, hash, kind)); } catch { /* already gone */ }
  }
}

/**
 * Cleans up stale `.tmp` files and unreferenced Tier-2 blob files left behind by crashes.
 * Matches both `hash` and `codec` so mismatched-extension leftovers are also cleaned.
 */
export function sweepOrphanExternalBlobs(blobsDir: string, isKnown: (hash: string, codec: BlobCodec) => boolean, nowMs = Date.now()): number {
  if (!existsSync(blobsDir)) return 0;
  let removed = 0;
  let shards: string[];
  try { shards = readdirSync(blobsDir); } catch { return 0; }
  for (const shard of shards) {
    if (!/^[0-9a-f]{2}$/.test(shard)) continue;
    const shardDir = join(blobsDir, shard);
    let names: string[];
    try { names = readdirSync(shardDir); } catch { continue; }
    for (const name of names) {
      const full = join(shardDir, name);
      if (name.endsWith('.tmp')) {
        try {
          if (nowMs - statSync(full).mtimeMs >= ORPHAN_TMP_AGE_MS) { unlinkSync(full); removed += 1; }
        } catch { /* ignore */ }
        continue;
      }
      const match = HASH_FILE_RE.exec(name);
      if (!match) continue;
      const codec: BlobCodec = match[2] === 'zst' ? 'zstd' : 'raw';
      if (!isKnown(match[1]!, codec)) {
        try { unlinkSync(full); removed += 1; } catch { /* ignore */ }
      }
    }
  }
  return removed;
}
