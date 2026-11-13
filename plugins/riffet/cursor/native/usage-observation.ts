import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Metadata observed on one native agent stream; input includes cache and output includes reasoning. */
export interface CursorUsageCapture {
  v: 1;
  nativeSessionId: string;
  nativeTurnId: string;
  requestId: string;
  startedAt: number;
  endedAt: number;
  /** The client requested this model; it is not an assertion about the billed model. */
  requestedModel?: string;
  rawUsage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  };
}

export const CURSOR_USAGE_FILE = /^[a-f0-9]{64}\.json$/;
const MAX_BYTES = 16 * 1024;
const COUNT_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const;
const KEYS = ['v', 'nativeSessionId', 'nativeTurnId', 'requestId', 'startedAt', 'endedAt', 'requestedModel', 'rawUsage'];
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function parse(value: unknown): CursorUsageCapture | undefined {
  if (!record(value) || value.v !== 1 || Object.keys(value).some(key => !KEYS.includes(key))
    || !id(value.nativeSessionId) || !id(value.nativeTurnId) || !id(value.requestId)
    || !count(value.startedAt) || !count(value.endedAt)
    || (value.requestedModel !== undefined && !id(value.requestedModel)) || !record(value.rawUsage)) return undefined;
  if (Object.entries(value.rawUsage).some(([key, value]) => !(COUNT_KEYS as readonly string[]).includes(key) || !count(value))) return undefined;
  return value as unknown as CursorUsageCapture;
}

/** Invalid, oversized and nonregular files stay on disk for inspection without blocking other records. */
export function readCursorUsage(dir: string): Array<{ file: string; observation: CursorUsageCapture }> {
  const out: Array<{ file: string; observation: CursorUsageCapture }> = [];
  let names: string[];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (!CURSOR_USAGE_FILE.test(name)) continue;
    let fd: number | undefined;
    try {
      const file = join(dir, name);
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_BYTES) continue;
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let size = 0, next: number;
      while (size < buffer.length && (next = readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += next;
      const bytes = buffer.subarray(0, size);
      if (size > MAX_BYTES || `${createHash('sha256').update(bytes).digest('hex')}.json` !== name) continue;
      const observation = parse(JSON.parse(bytes.toString('utf8')));
      if (observation) out.push({ file, observation });
    } catch { /* an incomplete or invalid record cannot hold up the rest of the queue */ }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  return out;
}
