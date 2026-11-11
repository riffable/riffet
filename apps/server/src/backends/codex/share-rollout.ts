import { open, stat } from 'node:fs/promises';
import { AppError } from '../../errors.js';
import { MAX_ROLLOUT_BYTES } from './config.js';
import { findCodexRollout } from './rollout-usage.js';
import { asRecord, str } from './util.js';

interface RolloutFile { path: string; ino: number; dev: number; end: number; observedSize: number; observedMtime: number; allowIncompleteTail: boolean; parent?: RolloutFile }

const unavailable = () => new AppError('SHARE_HISTORY_UNAVAILABLE', 'The conversation history contains a corrupted record', 409);
const changed = () => new AppError('SHARE_HISTORY_CHANGED', 'The conversation history changed; generate the preview again', 409);
export const shareHistoryTooLarge = () => new AppError('SHARE_HISTORY_TOO_LARGE', 'The selected conversation is too large; share less', 413);

function observe(file: RolloutFile, info: { ino: number; dev: number; size: number; mtimeMs: number } | undefined): void {
  if (!info || info.ino !== file.ino || info.dev !== file.dev || info.size < file.observedSize
    || (info.size === file.observedSize && info.mtimeMs !== file.observedMtime)) throw changed();
  file.observedSize = info.size; file.observedMtime = info.mtimeMs;
}

/** The line cap bounds JSON parsing too; a large file never becomes one large in-memory string. */
async function* lines(file: RolloutFile, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  signal?.throwIfAborted();
  const handle = await open(file.path, 'r');
  try {
    const before = await handle.stat();
    observe(file, before);
    const chunk = Buffer.allocUnsafe(256 * 1024);
    let position = 0, bytes = 0;
    let parts: Buffer[] = [];
    while (position < file.end) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, file.end - position), position);
      if (!bytesRead) throw changed();
      position += bytesRead;
      let start = 0;
      for (let index = 0; index < bytesRead; index++) {
        if (chunk[index] !== 10) continue;
        const part = chunk.subarray(start, index);
        bytes += part.length;
        if (bytes > MAX_ROLLOUT_BYTES) throw shareHistoryTooLarge();
        const body = Buffer.concat([...parts, part], bytes).toString('utf8');
        parts = []; bytes = 0; start = index + 1;
        if (!body.trim()) continue;
        let row: Record<string, unknown> | undefined;
        try { row = asRecord(JSON.parse(body)); } catch { throw unavailable(); }
        if (row) yield row;
      }
      if (start < bytesRead) {
        const part = Buffer.from(chunk.subarray(start, bytesRead));
        bytes += part.length;
        if (bytes > MAX_ROLLOUT_BYTES) throw shareHistoryTooLarge();
        parts.push(part);
      }
    }
    // Only the actual file EOF may contain a pending append. A fork cutoff is a committed prefix.
    if (bytes) {
      const body = Buffer.concat(parts, bytes).toString('utf8');
      let row: Record<string, unknown> | undefined;
      try { row = asRecord(JSON.parse(body)); } catch { if (!file.allowIncompleteTail) throw unavailable(); }
      if (row) yield row;
    }
  } finally {
    const after = await handle.stat();
    await handle.close();
    const current = await stat(file.path).catch(() => undefined);
    observe(file, after);
    observe(file, current);
  }
}

/** Resolve each inherited prefix once, fixing its byte boundary for every catalog/content pass. */
export async function shareRolloutReader(stateHome: string, threadId: string, signal?: AbortSignal, includeInherited = true): Promise<{
  scan(visit: (row: Record<string, unknown>) => void): Promise<void>;
}> {
  const resolve = async (id: string, ancestors = new Set<string>(), limit?: number): Promise<RolloutFile> => {
    signal?.throwIfAborted();
    if (ancestors.has(id) || ancestors.size > 32) throw new AppError('SHARE_HISTORY_UNAVAILABLE', 'The conversation history inheritance is invalid', 409);
    const path = await findCodexRollout(stateHome, id);
    if (!path) throw new AppError(ancestors.size ? 'SHARE_HISTORY_UNAVAILABLE' : 'SHARE_HISTORY_NOT_FOUND', 'The conversation history file does not exist', 409);
    const info = await stat(path);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0 || limit > info.size)) throw new AppError('SHARE_HISTORY_UNAVAILABLE', 'The inherited conversation history is incomplete', 409);
    const file: RolloutFile = { path, ino: info.ino, dev: info.dev, end: limit ?? info.size, observedSize: info.size, observedMtime: info.mtimeMs, allowIncompleteTail: limit === undefined };
    let meta: Record<string, unknown> | undefined;
    for await (const row of lines(file, signal)) {
      if (row.type === 'session_meta') { meta = asRecord(row.payload); break; }
    }
    if (str(meta?.id ?? meta?.session_id) !== id) throw new AppError('SHARE_HISTORY_SCOPE_MISMATCH', 'The conversation history id does not match', 409);
    const base = asRecord(meta?.history_base), parentId = str(base?.thread_id);
    if (parentId) {
      if (!Number.isSafeInteger(base?.end_byte_offset) || (base!.end_byte_offset as number) < 0) throw new AppError('SHARE_HISTORY_UNAVAILABLE', 'The inherited conversation history is incomplete', 409);
      if (includeInherited) file.parent = await resolve(parentId, new Set([...ancestors, id]), base!.end_byte_offset as number);
    }
    return file;
  };
  const root = await resolve(threadId);
  const scan = async (file: RolloutFile, visit: (row: Record<string, unknown>) => void): Promise<void> => {
    if (file.parent) await scan(file.parent, visit);
    for await (const row of lines(file, signal)) visit(row);
  };
  return { scan: visit => scan(root, visit) };
}
