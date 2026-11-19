import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { STORAGE_BUDGET } from '../../../../packages/contracts/src/budgets.js';

export type BlobCodec = 'raw' | 'zstd';

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
const HASH_FILE_RE = /^([0-9a-f]{64})\.(raw|zst)$/;
const ORPHAN_TMP_AGE_MS = 10 * 60_000;

export function blobSha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function externalBlobPath(blobsDir: string, hash: string, codec: BlobCodec): string {
  const ext = codec === 'zstd' ? 'zst' : 'raw';
  return join(blobsDir, hash.slice(0, 2), `${hash}.${ext}`);
}

/**
 * Computes content hash and optional Zstd compression strictly outside database locks.
 * Logical identity (`hash`, `size`) is always derived from the uncompressed plaintext bytes.
 */
export function prepareBlob(bytes: Buffer, options: { mimeType?: string; blobsDir?: string } = {}): PreparedBlob {
  const hash = blobSha256(bytes);
  const size = bytes.length;
  let codec: BlobCodec = 'raw';
  let storedBytes = bytes;
  const compressible = size >= STORAGE_BUDGET.blobCompressMinBytes && !(options.mimeType && INCOMPRESSIBLE_MIME.test(options.mimeType));
  if (compressible) {
    const compressed = zstdCompressSync(bytes, ZSTD_OPTIONS);
    if (compressed.length + 16 < size) {
      codec = 'zstd';
      storedBytes = compressed;
    }
  }
  const storedSize = storedBytes.length;
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
  let codec: BlobCodec = row.codec === 'zstd' ? 'zstd' : 'raw';
  let encoded: Buffer | undefined;
  if (row.external === 1) {
    if (!blobsDir) return undefined;
    const altCodec: BlobCodec = codec === 'zstd' ? 'raw' : 'zstd';
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
  if (codec === 'zstd') return zstdDecompressSync(encoded);
  return encoded;
}

/** Removes a Tier-2 blob file after its database row is deleted. */
export function removeExternalBlob(blobsDir: string, hash: string, codec?: string | null): void {
  const names: BlobCodec[] = codec === 'zstd' ? ['zstd', 'raw'] : codec === 'raw' ? ['raw', 'zstd'] : ['zstd', 'raw'];
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
