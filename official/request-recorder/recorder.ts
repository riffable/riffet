// The recording store and what goes into it. Shared by the proxy daemon (which writes) and the plugin (which
// lists, clears and prunes), so it only uses `node:` modules.

import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

// These limits belong in `packages/contracts/src/budgets.ts` (docs/guide/performance.md); until they move there,
// this is the only place that names them.
export const LIMITS = {
  /** Request or response body kept per entry; the rest is counted in `bytes` and dropped. */
  bodyBytes: 64 * 1024,
  /** A segment file is closed at this size, so deleting the oldest data never rewrites a file. */
  segmentBytes: 1024 * 1024,
  /** Disk per conversation; the oldest segments go first. */
  conversationBytes: 16 * 1024 * 1024,
  /** Disk for all conversations together; the oldest segments across conversations go first. */
  totalBytes: 128 * 1024 * 1024,
  /** A conversation with no write for this long is deleted. */
  staleMs: 14 * 24 * 60 * 60 * 1000,
} as const;

const SENSITIVE_HEADER = /authorization|cookie|api-?key|token|secret|credential|signature|password/i;
const SENSITIVE_QUERY = /key|token|secret|signature|password|auth|credential/i;

export function redactHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result[name] = SENSITIVE_HEADER.test(name) ? '[redacted]' : Array.isArray(value) ? value.join(', ') : value;
  }
  return result;
}

/** The request target with the values of credential-like query parameters replaced. */
export function redactTarget(target: string): string {
  const mark = target.indexOf('?');
  if (mark < 0) return target;
  const query = new URLSearchParams(target.slice(mark + 1));
  for (const name of [...query.keys()]) if (SENSITIVE_QUERY.test(name)) query.set(name, '[redacted]');
  return `${target.slice(0, mark)}?${query.toString()}`;
}

export interface RecordedMessage { headers: Record<string, string>; body: string; truncated: boolean }
export interface RecordEntry {
  time: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  requestBytes: number;
  responseBytes: number;
  model?: string;
  aborted?: boolean;
  error?: string;
  request: RecordedMessage;
  response?: RecordedMessage;
}

/** A conversation id is a directory name: anything else is replaced, so an id cannot leave the recordings directory. */
export function directoryName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || '_';
}

export interface RecordedConversation { name: string; bytes: number; lastAt: number; dir: string }

interface Segment { file: string; conversation: string; bytes: number; mtime: number }

export class Recordings {
  private current = new Map<string, { sequence: number; bytes: number }>();
  constructor(readonly root: string, private readonly limits: Pick<typeof LIMITS, 'segmentBytes' | 'conversationBytes' | 'totalBytes' | 'staleMs'> = LIMITS) {}

  dirOf(sessionId: string): string { return join(this.root, directoryName(sessionId)); }

  async append(sessionId: string, entry: RecordEntry): Promise<void> {
    const dir = this.dirOf(sessionId);
    let active = this.current.get(dir);
    if (!active) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const segments = await this.segments(dir, directoryName(sessionId));
      const last = segments.at(-1);
      active = last ? { sequence: sequenceOf(last.file), bytes: last.bytes } : { sequence: 1, bytes: 0 };
      this.current.set(dir, active);
    }
    const line = `${JSON.stringify(entry)}\n`;
    const write = () => appendFile(join(dir, segmentName(active.sequence)), line, { mode: 0o600 });
    try { await write(); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await write();
    }
    active.bytes += Buffer.byteLength(line);
    if (active.bytes >= this.limits.segmentBytes) {
      active.sequence += 1;
      active.bytes = 0;
      await this.enforce().catch(() => undefined);
    }
  }

  private async segments(dir: string, conversation: string): Promise<Segment[]> {
    const names = await readdir(dir).catch(() => [] as string[]);
    const found = await Promise.all(names.filter(name => /^\d{6}\.jsonl$/.test(name)).map(async name => {
      const info = await stat(join(dir, name)).catch(() => undefined);
      return info ? { file: join(dir, name), conversation, bytes: info.size, mtime: info.mtimeMs } : undefined;
    }));
    return found.filter((item): item is Segment => item !== undefined).sort((a, b) => a.file.localeCompare(b.file));
  }

  /** Conversations, newest write first. */
  async list(): Promise<RecordedConversation[]> {
    const names = await readdir(this.root).catch(() => [] as string[]);
    const all = await Promise.all(names.map(async name => {
      const dir = join(this.root, name);
      const segments = await this.segments(dir, name);
      if (!segments.length) return undefined;
      return { name, dir, bytes: segments.reduce((sum, item) => sum + item.bytes, 0), lastAt: Math.max(...segments.map(item => item.mtime)) };
    }));
    return all.filter((item): item is RecordedConversation => item !== undefined).sort((a, b) => b.lastAt - a.lastAt);
  }

  async clear(name: string): Promise<void> {
    if (name !== directoryName(name)) return;
    const dir = join(this.root, name);
    this.current.delete(dir);
    await rm(dir, { recursive: true, force: true });
  }

  /** Oldest segments first until each conversation and the whole fit; then conversations idle for too long. */
  async enforce(now = Date.now()): Promise<void> {
    const names = await readdir(this.root).catch(() => [] as string[]);
    const perConversation = await Promise.all(names.map(async name => ({ name, segments: await this.segments(join(this.root, name), name) })));
    const remaining: Segment[] = [];
    for (const { name, segments } of perConversation) {
      if (!segments.length) continue;
      if (now - Math.max(...segments.map(item => item.mtime)) > this.limits.staleMs) { await this.clear(name); continue; }
      let total = segments.reduce((sum, item) => sum + item.bytes, 0);
      // The newest segment is the one being written.
      for (const item of segments.slice(0, -1)) {
        if (total <= this.limits.conversationBytes) break;
        await rm(item.file, { force: true });
        total -= item.bytes;
        segments.splice(segments.indexOf(item), 1);
      }
      remaining.push(...segments);
    }
    let total = remaining.reduce((sum, item) => sum + item.bytes, 0);
    const newest = new Set(perConversation.flatMap(({ segments }) => segments.slice(-1).map(item => item.file)));
    for (const item of remaining.sort((a, b) => a.mtime - b.mtime)) {
      if (total <= this.limits.totalBytes) break;
      if (newest.has(item.file)) continue;
      await rm(item.file, { force: true });
      total -= item.bytes;
    }
  }
}

function segmentName(sequence: number): string { return `${String(sequence).padStart(6, '0')}.jsonl`; }
function sequenceOf(file: string): number { return Number(/(\d{6})\.jsonl$/.exec(file)?.[1] ?? 1); }
