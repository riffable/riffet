import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync } from 'node:fs';
import { lstat, readdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { OUTPUT_BUDGET } from '../../../../../packages/contracts/src/budgets.js';
import type { FileChangeStatus, FileSnapshotRecord } from '../../../../../packages/contracts/src/sync.js';
import { textLineDelta } from '../../../../../packages/timeline/src/lineDiff.js';

/*
 * Per-file snapshot ledger for session outputs (docs/SESSION-OUTPUTS.md).
 *
 * Captures lightweight before/after file bodies into the journal's existing CAS `session_blobs`
 * store (deduplicated by SHA-256, Zstd-compressed, externalized past 128 KiB, and cleaned up on
 * session deletion). Only compact `FileSnapshotRecord` entries ride on `tool_call_update` events;
 * repeated edits to the same file reuse the prior `postHash` without re-persisting unchanged bytes.
 */

export type SnapshotBlobWriter = (sessionId: string, bytes: Buffer, mimeType: string) => string;

const BINARY_PROBE_BYTES = 8192;
const MAX_LOGS = 64;
const MAX_PENDING = 256;
const MAX_TRACKED_SESSIONS = 128;
const PENDING_STALE_MS = 30 * 60_000;

interface CapturedFile {
  exists: boolean;
  /** Content SHA-256 hex when readable within `snapshotMaxFileBytes`, `null` when absent, `undefined` when oversized/unreadable. */
  hash: string | null | undefined;
  /** Raw bytes held only for the short `begin -> finish` edit window to compute exact line deltas. */
  bytes?: Buffer;
  binary: boolean;
  size: number;
  oversized?: boolean;
}

interface PendingEdit {
  sessionId: string;
  path: string;
  canonical: string;
  before: CapturedFile;
  startedAt: number;
}

interface SessionLedgerState {
  lastPostHash: Map<string, string | null>;
  persistedHashes: Set<string>;
  persistedBytes: number;
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const scopeHash = (scope: string): string => createHash('sha256').update(scope).digest('hex').slice(0, 24);

/** Detects binary content by scanning the leading 8 KiB for NUL bytes. */
export function isBinaryBuffer(bytes: Buffer): boolean {
  const limit = Math.min(bytes.length, BINARY_PROBE_BYTES);
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) return true;
  }
  return false;
}

function canonicalKey(path: string): string {
  const abs = resolve(path);
  try { return realpathSync(abs); } catch { return abs; }
}

function endsInNewline(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const { size } = fstatSync(fd);
    if (!size) return true;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } catch { return true; }
  finally { if (fd !== undefined) closeSync(fd); }
}

const SENSITIVE_NAME = /^(?:\.env(?:\..+)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx))$/i;
const SENSITIVE_SEGMENT = /(?:^|\/)(?:\.ssh|\.gnupg|\.aws)(?:\/|$)/;

/** Never persist secret/credential file bodies into `session_blobs` (docs/guide/workspace.md). */
function isSensitivePath(rawPath: string): boolean {
  const normalized = rawPath.replace(/\\/g, '/');
  return SENSITIVE_NAME.test(basename(normalized)) || SENSITIVE_SEGMENT.test(normalized);
}

async function readFileSnapshot(path: string, maxBytes: number): Promise<CapturedFile> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return { exists: true, hash: undefined, binary: false, size: info.size, oversized: true };
    if (info.size > maxBytes) return { exists: true, hash: undefined, binary: false, size: info.size, oversized: true };
    const bytes = await readFile(path);
    return { exists: true, hash: sha256(bytes), bytes, binary: isBinaryBuffer(bytes), size: bytes.length };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { exists: false, hash: null, binary: false, size: 0 };
    return { exists: false, hash: undefined, binary: false, size: 0 };
  }
}

export class SessionFileSnapshots {
  private putBlob?: SnapshotBlobWriter;
  private maxFileBytes: number = OUTPUT_BUDGET.snapshotMaxFileBytes;
  private maxSessionBytes: number = OUTPUT_BUDGET.sessionSnapshotTotalBytes;
  private readonly pending = new Map<string, PendingEdit>();
  private readonly sessions = new Map<string, SessionLedgerState>();
  private readonly logs = new Map<string, Map<string, FileSnapshotRecord[]>>();

  constructor(private readonly dir: string) {}

  /** Wires the journal's CAS blob writer and active profile budgets from `createApp`. */
  configure(options: { putBlob?: SnapshotBlobWriter; maxFileBytes?: number; maxSessionBytes?: number }): void {
    if (options.putBlob !== undefined) this.putBlob = options.putBlob;
    if (options.maxFileBytes !== undefined) this.maxFileBytes = options.maxFileBytes;
    if (options.maxSessionBytes !== undefined) this.maxSessionBytes = options.maxSessionBytes;
  }

  /** Persists a buffer into `session_blobs` within the per-session byte budget; deduplicates repeated hashes. */
  persistBlob(sessionId: string, bytes: Buffer, binary: boolean): string | undefined {
    if (!this.putBlob) return undefined;
    if (bytes.length > this.maxFileBytes) return undefined;
    const hash = sha256(bytes);
    const state = this.sessionState(sessionId);
    if (state.persistedHashes.has(hash)) return hash;
    if (state.persistedBytes + bytes.length > this.maxSessionBytes) return undefined;
    try {
      const stored = this.putBlob(sessionId, bytes, binary ? 'application/octet-stream' : 'text/plain; charset=utf-8');
      state.persistedHashes.add(stored);
      state.persistedBytes += bytes.length;
      return stored;
    } catch {
      return undefined;
    }
  }

  /**
   * Captures a single file's state before an edit tool runs (`PreToolUse` / `item/started`).
   * Reuses the prior `postHash` in memory without re-writing unchanged bytes to CAS.
   */
  async beginEdit(sessionId: string, toolCallId: string, rawPath: string): Promise<void> {
    if (!sessionId || !toolCallId || !rawPath) return;
    this.sweepPending();
    const canonical = canonicalKey(rawPath);
    const before = await readFileSnapshot(rawPath, this.maxFileBytes);
    const sensitive = isSensitivePath(canonical);
    if (sensitive) {
      before.hash = undefined;
    } else if (before.bytes && before.hash) {
      const state = this.sessionState(sessionId);
      const sameAsLast = state.lastPostHash.get(canonical) === before.hash && state.persistedHashes.has(before.hash);
      if (!sameAsLast) {
        const stored = this.persistBlob(sessionId, before.bytes, before.binary);
        if (!stored) before.hash = undefined;
      }
    }
    const key = `${sessionId}\u0000${toolCallId}`;
    this.pending.delete(key);
    this.pending.set(key, { sessionId, path: rawPath, canonical, before, startedAt: Date.now() });
    while (this.pending.size > MAX_PENDING) {
      const oldest = this.pending.keys().next().value as string | undefined;
      if (!oldest) break;
      this.pending.delete(oldest);
    }
  }

  /** Discards a pending edit snapshot when the tool call was denied or never ran. */
  discardEdit(sessionId: string, toolCallId: string): void {
    this.pending.delete(`${sessionId}\u0000${toolCallId}`);
  }

  /**
   * Captures the file's post-edit state (`PostToolUse` / `item/completed`), writes the snapshot
   * record to the session log, and returns it. Returns `undefined` if the file did not change.
   */
  async finishEdit(sessionId: string, toolCallId: string, options: { applied: boolean; rawPath?: string }): Promise<FileSnapshotRecord[] | undefined> {
    const key = `${sessionId}\u0000${toolCallId}`;
    const held = this.pending.get(key);
    this.pending.delete(key);
    if (!options.applied) return undefined;
    const path = options.rawPath ?? held?.path;
    if (!path) return undefined;
    const canonical = held?.canonical ?? canonicalKey(path);
    const before = held?.before;
    const after = await readFileSnapshot(path, this.maxFileBytes);
    const sensitive = isSensitivePath(canonical);
    if (sensitive) {
      after.hash = undefined;
    } else if (after.bytes && after.hash) {
      const stored = this.persistBlob(sessionId, after.bytes, after.binary);
      if (!stored) after.hash = undefined;
    }

    // No change on disk at all.
    if (before && before.exists === after.exists && before.hash !== undefined && before.hash === after.hash) return undefined;

    const status: FileChangeStatus = !before?.exists && after.exists
      ? 'created'
      : before?.exists && !after.exists
        ? 'deleted'
        : 'modified';
    const binary = Boolean(before?.binary || after.binary);
    let added = 0;
    let removed = 0;
    if (!binary && (before?.bytes || !before?.exists) && (after.bytes || !after.exists)) {
      const beforeText = before?.bytes ? before.bytes.toString('utf8') : '';
      const afterText = after.bytes ? after.bytes.toString('utf8') : '';
      const delta = textLineDelta(beforeText, afterText);
      added = delta.added;
      removed = delta.removed;
    }

    const record: FileSnapshotRecord = {
      path,
      ...(before ? { preHash: before.hash } : {}),
      ...(after.hash !== undefined ? { postHash: after.hash } : {}),
      status,
      ...(binary ? { binary: true } : {}),
      added,
      removed,
      ...(after.exists ? { bytes: after.size } : {}),
    };
    if (after.hash !== undefined) this.sessionState(sessionId).lastPostHash.set(canonical, after.hash);
    const list = [record];
    this.record(sessionId, toolCallId, list);
    return list;
  }

  /** Persists snapshot records (from edit tools or `WorkspaceObserver`) to the session's append-only log. */
  record(scope: string, key: string, records: FileSnapshotRecord[]): void {
    if (!records.length) return;
    const state = this.sessionState(scope);
    for (const item of records) {
      if (item.postHash !== undefined) state.lastPostHash.set(canonicalKey(item.path), item.postHash);
    }
    const file = this.logFile(scope);
    try {
      mkdirSync(join(this.dir, 'snapshots'), { recursive: true, mode: 0o700 });
      appendFileSync(file, `${endsInNewline(file) ? '' : '\n'}${JSON.stringify({ key, records })}\n`, { mode: 0o600 });
    } catch { return; }
    this.log(scope).set(key, records);
  }

  /** Reads back recorded snapshot records for a tool call, surviving restarts and transcript re-imports. */
  snapshots(scope: string, key: string): FileSnapshotRecord[] | undefined {
    return this.log(scope).get(key);
  }

  /** Removes per-session memory state and on-disk snapshot ledger log when a conversation is deleted. */
  forget(scope: string): void {
    this.logs.delete(scope);
    this.sessions.delete(scope);
    for (const [key, entry] of this.pending) {
      if (entry.sessionId === scope) this.pending.delete(key);
    }
    rmSync(this.logFile(scope), { force: true });
  }

  /** Housekeeping for orphaned `snapshots/<hash>.jsonl` files whose conversation no longer exists. */
  async maintain(liveSessionIds: ReadonlySet<string>, options: { minAgeMs?: number; nowMs?: number } = {}): Promise<number> {
    const minAgeMs = options.minAgeMs ?? 24 * 60 * 60_000;
    const cutoff = (options.nowMs ?? Date.now()) - minAgeMs;
    const liveHashes = new Set<string>();
    for (const id of liveSessionIds) liveHashes.add(`${scopeHash(id)}.jsonl`);
    const snapshotsDir = join(this.dir, 'snapshots');
    let pruned = 0;
    for (const name of await readdir(snapshotsDir).catch(() => [] as string[])) {
      if (!/^[0-9a-f]{24}\.jsonl$/.test(name) || liveHashes.has(name)) continue;
      const full = join(snapshotsDir, name);
      const info = await lstat(full).catch(() => undefined);
      if (info?.isFile() && info.mtimeMs <= cutoff) {
        await rm(full, { force: true }).catch(() => undefined);
        pruned += 1;
      }
    }
    return pruned;
  }

  private sessionState(sessionId: string): SessionLedgerState {
    let state = this.sessions.get(sessionId);
    if (state) {
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, state);
      return state;
    }
    state = { lastPostHash: new Map(), persistedHashes: new Set(), persistedBytes: 0 };
    this.sessions.set(sessionId, state);
    while (this.sessions.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.sessions.delete(oldest);
    }
    return state;
  }

  private sweepPending(): void {
    const cutoff = Date.now() - PENDING_STALE_MS;
    for (const [key, entry] of this.pending) {
      if (entry.startedAt < cutoff) this.pending.delete(key);
    }
  }

  private logFile(scope: string): string {
    return join(this.dir, 'snapshots', `${scopeHash(scope)}.jsonl`);
  }

  private log(scope: string): Map<string, FileSnapshotRecord[]> {
    let entries = this.logs.get(scope);
    if (entries) {
      this.logs.delete(scope);
      this.logs.set(scope, entries);
      return entries;
    }
    entries = new Map();
    try {
      for (const line of readFileSync(this.logFile(scope), 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as { key?: unknown; records?: unknown };
          if (typeof parsed.key === 'string' && Array.isArray(parsed.records)) entries.set(parsed.key, parsed.records as FileSnapshotRecord[]);
        } catch { /* ignore torn line */ }
      }
    } catch { /* nothing recorded yet */ }
    this.logs.set(scope, entries);
    while (this.logs.size > MAX_LOGS) {
      const oldest = this.logs.keys().next().value as string | undefined;
      if (!oldest) break;
      this.logs.delete(oldest);
    }
    return entries;
  }
}

// perf-rules: allow one ledger instance per stateDir, mirroring workspaceObserver
const stores = new Map<string, SessionFileSnapshots>();

/** Process-wide snapshot ledger per state directory, sharing its folder with `WorkspaceObserver`. */
export function sessionFileSnapshots(stateDir: string): SessionFileSnapshots {
  let store = stores.get(stateDir);
  if (!store) stores.set(stateDir, store = new SessionFileSnapshots(join(stateDir, 'workspace-observer')));
  return store;
}
