import { realpathSync } from 'node:fs';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { OUTPUT_BUDGET } from '../../../../packages/contracts/src/budgets.js';
import type { FileChange, FileChangeStatus, OutputAccuracy, SessionOutputDiff, SessionOutputsSummary } from '../../../../packages/contracts/src/sync.js';
import { textLineDelta, toolFileChanges } from '../../../../packages/timeline/src/lineDiff.js';
import type { RowContent } from '../../../../packages/timeline/src/rows.js';

/*
 * Server-side session output aggregation & net-diff reconstruction (docs/SESSION-OUTPUTS.md).
 *
 * Extracted from full, pre-`fitRow` tool rows so row truncation (16 KiB diff / 64 KiB row) and
 * client pagination windows (300 rows) never distort or drop outputs. When per-file CAS snapshots
 * are present, consecutive edits chain by `(preHash, postHash)` into exact net deltas and detect
 * intervening external writes without counting them as agent output.
 */

export interface StoredRowOutput {
  path: string;
  added: number;
  removed: number;
  created: boolean;
  status: FileChangeStatus;
  binary?: boolean;
  accuracy: OutputAccuracy;
  preHash?: string | null;
  postHash?: string | null;
  updatedAt?: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
// perf-rules: allow bounded to MAX_ROOT_CACHE (64) entries with FIFO eviction
const realRootCache = new Map<string, string>();
const MAX_ROOT_CACHE = 64;

function resolvedRoot(root: string): string {
  const cached = realRootCache.get(root);
  if (cached !== undefined) return cached;
  let real = resolve(root);
  try { real = realpathSync(real); } catch { /* directory may be gone */ }
  realRootCache.set(root, real);
  while (realRootCache.size > MAX_ROOT_CACHE) {
    const oldest = realRootCache.keys().next().value as string | undefined;
    if (!oldest) break;
    realRootCache.delete(oldest);
  }
  return real;
}

function stripLeadingDotSlash(value: string): string {
  let next = value;
  while (next.startsWith('./')) next = next.slice(2);
  return next;
}

/** Normalizes a raw tool/observer path against the session's project root, deduplicating aliases and relative spellings. */
export function normalizeOutputPath(rawPath: string, root?: string): { path: string; outsideProject: boolean } {
  const cleaned = rawPath.replace(/\\/g, '/').trim();
  if (!cleaned) return { path: '', outsideProject: false };
  const isAbs = cleaned.startsWith('/') || /^[A-Za-z]:\//.test(cleaned);
  if (!root) {
    const norm = posix.normalize(cleaned);
    return { path: isAbs ? norm : stripLeadingDotSlash(norm), outsideProject: false };
  }

  const base = resolve(root).replace(/\\/g, '/').replace(/\/+$/, '');
  const realBase = resolvedRoot(root).replace(/\\/g, '/').replace(/\/+$/, '');
  const candidates = new Set<string>([base, realBase]);
  for (const item of [...candidates]) {
    if (item.startsWith('/private/')) candidates.add(item.slice('/private'.length));
    else if (item.startsWith('/')) candidates.add(`/private${item}`);
  }

  if (!isAbs) {
    const rel = posix.normalize(cleaned);
    if (rel === '..' || rel.startsWith('../')) {
      const abs = resolve(base, cleaned).replace(/\\/g, '/');
      return { path: abs, outsideProject: true };
    }
    return { path: stripLeadingDotSlash(rel), outsideProject: false };
  }

  const normAbs = posix.normalize(cleaned);
  const absVariants = [normAbs];
  if (normAbs.startsWith('/private/')) absVariants.push(normAbs.slice('/private'.length));
  else if (normAbs.startsWith('/')) absVariants.push(`/private${normAbs}`);

  for (const candidateRoot of [...candidates].sort((a, b) => b.length - a.length)) {
    const prefix = `${candidateRoot}/`;
    for (const variant of absVariants) {
      if (variant.startsWith(prefix)) {
        const rel = stripLeadingDotSlash(posix.normalize(variant.slice(prefix.length)));
        if (rel && rel !== '.' && !rel.startsWith('../')) return { path: rel, outsideProject: false };
      }
    }
  }

  // Fallback for symlinks inside the project tree.
  if (isAbsolute(rawPath)) {
    try {
      const realTarget = realpathSync(rawPath);
      const rel = relative(resolvedRoot(root), realTarget).split(sep).join('/');
      if (rel && rel !== '.' && !rel.startsWith('../') && !isAbsolute(rel)) {
        return { path: stripLeadingDotSlash(posix.normalize(rel)), outsideProject: false };
      }
    } catch { /* deleted or unreachable path */ }
  }

  return { path: normAbs, outsideProject: true };
}

/**
 * Extracts file change records from one full, pre-`fitRow` timeline row.
 * Only direct changes on the tool row are extracted here; child lane rows are stored under their
 * own lanes so multi-level nested subagents aggregate cleanly without double-counting.
 */
export function extractDirectRowOutputs(row: RowContent): StoredRowOutput[] {
  if (row.kind !== 'tool') return [];
  const changes = toolFileChanges(row.event.data);
  if (!changes.length) return [];
  const updatedAt = row.event.lastAt || row.event.createdAt;
  return changes.map(change => ({
    path: change.path,
    added: change.added,
    removed: change.removed,
    created: change.created,
    status: change.status,
    ...(change.binary ? { binary: true } : {}),
    accuracy: change.accuracy ?? 'estimated',
    ...(change.preHash !== undefined ? { preHash: change.preHash } : {}),
    ...(change.postHash !== undefined ? { postHash: change.postHash } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  }));
}

/** Converts a cold-evicted subagent summary's `FileChange` entries into `StoredRowOutput` records. */
export function summaryChangesToOutputs(changes: readonly FileChange[]): StoredRowOutput[] {
  return changes.map(change => ({
    path: change.path,
    added: change.added,
    removed: change.removed,
    created: change.created,
    status: change.status ?? (change.created ? 'created' : 'modified'),
    ...(change.binary ? { binary: true } : {}),
    accuracy: change.accuracy ?? 'estimated',
    ...(change.updatedAt ? { updatedAt: change.updatedAt } : {}),
  }));
}

/** Bounded LRU cache for `(preHash, postHash) -> { added, removed }` net line deltas. */
export class OutputDiffCache {
  private readonly entries = new Map<string, { added: number; removed: number }>();

  constructor(private readonly maxEntries: number = OUTPUT_BUDGET.diffCacheEntries) {}

  get(key: string): { added: number; removed: number } | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  set(key: string, value: { added: number; removed: number }): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

interface SnapshotSegment {
  preHash: string | null;
  postHash: string | null;
  binary: boolean;
  fallbackAdded: number;
  fallbackRemoved: number;
}

interface PathBucket {
  path: string;
  outsideProject: boolean;
  segments: SnapshotSegment[];
  hasEstimated: boolean;
  estimatedAdded: number;
  estimatedRemoved: number;
  estimatedFirstStatus?: FileChangeStatus;
  estimatedLastStatus?: FileChangeStatus;
  estimatedBinary: boolean;
  updatedAt?: string;
}

export interface OutputAggregateOptions {
  root?: string;
  readBlob?: (hash: string) => Buffer | undefined;
  diffCache?: OutputDiffCache;
  maxOutputs?: number;
}

function buildBuckets(records: readonly StoredRowOutput[], root?: string): Map<string, PathBucket> {
  const byPath = new Map<string, PathBucket>();
  for (const record of records) {
    const normalized = normalizeOutputPath(record.path, root);
    if (!normalized.path) continue;
    let bucket = byPath.get(normalized.path);
    if (bucket) {
      // Touching the file again moves it to the newest position.
      byPath.delete(normalized.path);
    } else {
      bucket = {
        path: normalized.path,
        outsideProject: normalized.outsideProject,
        segments: [],
        hasEstimated: false,
        estimatedAdded: 0,
        estimatedRemoved: 0,
        estimatedBinary: false,
      };
    }
    byPath.set(normalized.path, bucket);
    if (record.updatedAt) bucket.updatedAt = record.updatedAt;

    const hasExactHashes = record.preHash !== undefined && record.postHash !== undefined;
    if (hasExactHashes) {
      const last = bucket.segments.at(-1);
      if (last && last.postHash === record.preHash) {
        // Continuous edit chain by this conversation: extend the current segment so edits cancel out cleanly.
        last.postHash = record.postHash!;
        last.binary = last.binary || Boolean(record.binary);
        last.fallbackAdded += record.added;
        last.fallbackRemoved += record.removed;
      } else {
        bucket.segments.push({
          preHash: record.preHash!,
          postHash: record.postHash!,
          binary: Boolean(record.binary),
          fallbackAdded: record.added,
          fallbackRemoved: record.removed,
        });
      }
    } else {
      bucket.hasEstimated = true;
      bucket.estimatedAdded += record.added;
      bucket.estimatedRemoved += record.removed;
      bucket.estimatedBinary = bucket.estimatedBinary || Boolean(record.binary);
      if (!bucket.estimatedFirstStatus) bucket.estimatedFirstStatus = record.status;
      bucket.estimatedLastStatus = record.status;
    }
  }
  return byPath;
}

function isReadableCasHash(hash: string | null): boolean {
  return hash === null || SHA256_HEX.test(hash);
}

function segmentDelta(
  segment: SnapshotSegment,
  readBlob: ((hash: string) => Buffer | undefined) | undefined,
  diffCache: OutputDiffCache | undefined,
): { added: number; removed: number } {
  if (segment.binary) return { added: 0, removed: 0 };
  if (segment.preHash === segment.postHash) return { added: 0, removed: 0 };
  const cacheKey = `${segment.preHash ?? 'null'}\u0000${segment.postHash ?? 'null'}`;
  const cached = diffCache?.get(cacheKey);
  if (cached) return cached;
  if (readBlob && isReadableCasHash(segment.preHash) && isReadableCasHash(segment.postHash)) {
    const beforeBuf = segment.preHash === null ? Buffer.alloc(0) : readBlob(segment.preHash);
    const afterBuf = segment.postHash === null ? Buffer.alloc(0) : readBlob(segment.postHash);
    if (beforeBuf !== undefined && afterBuf !== undefined) {
      const delta = textLineDelta(beforeBuf.toString('utf8'), afterBuf.toString('utf8'));
      diffCache?.set(cacheKey, delta);
      return delta;
    }
  }
  return { added: segment.fallbackAdded, removed: segment.fallbackRemoved };
}

/**
 * Aggregates ordered file-change records into net session outputs (newest first).
 * Files whose exact snapshots cancel out (`preHash === postHash`) or that were created and later
 * deleted within the same conversation are omitted.
 */
export function aggregateSessionOutputs(records: readonly StoredRowOutput[], options: OutputAggregateOptions = {}): SessionOutputsSummary {
  const byPath = buildBuckets(records, options.root);
  const resolved: FileChange[] = [];

  for (const bucket of byPath.values()) {
    const activeSegments = bucket.segments.filter(seg => seg.preHash !== seg.postHash);

    if (bucket.segments.length && !bucket.hasEstimated) {
      if (!activeSegments.length) continue;
      const firstPre = activeSegments[0]!.preHash;
      const lastPost = activeSegments.at(-1)!.postHash;
      if (firstPre === lastPost) continue;
      const status: FileChangeStatus = firstPre === null && lastPost !== null
        ? 'created'
        : firstPre !== null && lastPost === null
          ? 'deleted'
          : 'modified';
      const binary = activeSegments.some(seg => seg.binary);
      let added = 0;
      let removed = 0;
      if (!binary) {
        for (const seg of activeSegments) {
          const delta = segmentDelta(seg, options.readBlob, options.diffCache);
          added += delta.added;
          removed += delta.removed;
        }
      }
      const hasSnapshotDiff = binary || (isReadableCasHash(firstPre) && isReadableCasHash(lastPost) && (firstPre !== null || lastPost !== null));
      resolved.push({
        path: bucket.path,
        added,
        removed,
        created: status === 'created',
        status,
        ...(binary ? { binary: true } : {}),
        ...(bucket.outsideProject ? { outsideProject: true } : {}),
        accuracy: 'exact',
        hasSnapshotDiff,
        ...(bucket.updatedAt ? { updatedAt: bucket.updatedAt } : {}),
      });
      continue;
    }

    // Estimated-only (legacy/imported/oversized) or mixed bucket.
    const createdThenDeleted = !activeSegments.length && bucket.estimatedFirstStatus === 'created' && bucket.estimatedLastStatus === 'deleted';
    if (createdThenDeleted) continue;

    let added = bucket.estimatedAdded;
    let removed = bucket.estimatedRemoved;
    const binary = bucket.estimatedBinary || activeSegments.some(seg => seg.binary);
    if (!binary) {
      for (const seg of activeSegments) {
        const delta = segmentDelta(seg, options.readBlob, options.diffCache);
        added += delta.added;
        removed += delta.removed;
      }
    } else {
      added = 0;
      removed = 0;
    }

    const firstPre = activeSegments[0]?.preHash;
    const lastPost = activeSegments.at(-1)?.postHash;
    const status: FileChangeStatus = bucket.estimatedLastStatus === 'deleted' || (lastPost === null && !bucket.estimatedLastStatus)
      ? 'deleted'
      : bucket.estimatedFirstStatus === 'created' || firstPre === null
        ? 'created'
        : 'modified';
    const hasSnapshotDiff = activeSegments.length > 0 && (binary || (isReadableCasHash(firstPre ?? null) && isReadableCasHash(lastPost ?? null)));
    resolved.push({
      path: bucket.path,
      added,
      removed,
      created: status === 'created',
      status,
      ...(binary ? { binary: true } : {}),
      ...(bucket.outsideProject ? { outsideProject: true } : {}),
      accuracy: activeSegments.length > 0 && !bucket.hasEstimated ? 'exact' : 'estimated',
      hasSnapshotDiff,
      ...(bucket.updatedAt ? { updatedAt: bucket.updatedAt } : {}),
    });
  }

  resolved.reverse();
  const limit = options.maxOutputs ?? OUTPUT_BUDGET.maxOutputs;
  return { items: resolved.slice(0, limit), total: resolved.length };
}

/**
 * Reconstructs the session's net before/after diff for one file from its stored CAS snapshots.
 * Returns `undefined` when no readable snapshot exists (e.g. legacy conversation or oversized file).
 */
export function readSessionOutputDiff(
  records: readonly StoredRowOutput[],
  targetPath: string,
  options: { root?: string; readBlob: (hash: string) => Buffer | undefined },
): SessionOutputDiff | undefined {
  const target = normalizeOutputPath(targetPath, options.root).path;
  if (!target) return undefined;
  const bucket = buildBuckets(records, options.root).get(target);
  if (!bucket) return undefined;
  const activeSegments = bucket.segments.filter(seg => seg.preHash !== seg.postHash);
  if (!activeSegments.length) return undefined;
  const firstPre = activeSegments[0]!.preHash;
  const lastPost = activeSegments.at(-1)!.postHash;
  if (firstPre === lastPost) return undefined;
  const status: FileChangeStatus = firstPre === null && lastPost !== null
    ? 'created'
    : firstPre !== null && lastPost === null
      ? 'deleted'
      : 'modified';
  const externalEdits = activeSegments.length > 1;
  if (activeSegments.some(seg => seg.binary)) {
    return {
      path: target,
      before: '',
      after: '',
      binary: true,
      status,
      source: 'session',
      ...(externalEdits ? { externalEdits: true } : {}),
    };
  }
  if (!isReadableCasHash(firstPre) || !isReadableCasHash(lastPost)) return undefined;
  const beforeBuf = firstPre === null ? Buffer.alloc(0) : options.readBlob(firstPre);
  const afterBuf = lastPost === null ? Buffer.alloc(0) : options.readBlob(lastPost);
  if (beforeBuf === undefined || afterBuf === undefined) return undefined;
  return {
    path: target,
    before: beforeBuf.toString('utf8'),
    after: afterBuf.toString('utf8'),
    status,
    source: 'session',
    ...(externalEdits ? { externalEdits: true } : {}),
  };
}
