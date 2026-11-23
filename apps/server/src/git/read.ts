import { AppError } from '../errors.js';
import { GIT_READ_BUDGET } from '../../../../packages/contracts/src/budgets.js';
import type { GitBlame, GitBlameCommit } from '../../../../packages/contracts/src/index.js';

/**
 * Reads of the code viewer must never reach the network: on a partial clone a missing object is
 * fetched from the promisor remote by default, which takes minutes (or hangs on a credential prompt)
 * inside a request. With this set git (2.44 and later) reports the object as missing instead.
 */
export const READ_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' };
export const ZERO_HASH = '0'.repeat(40);

const UNAVAILABLE = /promisor|could not fetch|unable to read|missing (blob|tree|commit)|bad object|could not read|fetch-pack|lazy/i;
/** The error a failed read gets: an object a partial clone does not hold is told apart from any other failure. */
export function readFailure(operation: string, stderr: string): AppError {
  const message = stderr.trim().slice(0, 500) || `git ${operation} failed`;
  if (UNAVAILABLE.test(stderr)) return new AppError('GIT_OBJECT_UNAVAILABLE', 'This history is not on this machine (a partial clone fetches it on demand, and that is off here)', 422, { operation, detail: message });
  return new AppError('GIT_OPERATION_FAILED', message, 422, { operation });
}

/** `git blame --porcelain` output: one block per line, the commit's details only the first time it appears. */
export function parseBlame(output: string, path: string, start: number, end: number): GitBlame {
  const ranges: GitBlame['ranges'] = [];
  const commits: Record<string, GitBlameCommit> = {};
  const details = new Map<string, Partial<GitBlameCommit> & { time?: number }>();
  let current: { hash: string; line: number } | undefined;
  for (const row of output.split('\n')) {
    if (row.startsWith('\t')) {
      if (!current) continue;
      const last = ranges[ranges.length - 1];
      if (last && last.hash === current.hash && last.start + last.count === current.line) last.count += 1;
      else ranges.push({ start: current.line, count: 1, hash: current.hash });
      current = undefined;
      continue;
    }
    if (current) {
      const known = details.get(current.hash)!;
      if (row.startsWith('author ')) known.author = row.slice(7);
      else if (row.startsWith('author-time ')) known.time = Number(row.slice(12));
      else if (row.startsWith('summary ')) known.summary = row.slice(8);
      continue;
    }
    const header = /^([0-9a-f]{40,64}) \d+ (\d+)/.exec(row);
    if (!header) continue;
    current = { hash: header[1]!, line: Number(header[2]) };
    if (!details.has(current.hash)) details.set(current.hash, {});
  }
  for (const [hash, item] of details) {
    if (hash === ZERO_HASH) continue;
    commits[hash] = { hash, author: item.author ?? '', date: item.time ? new Date(item.time * 1000).toISOString() : '', summary: item.summary ?? '' };
  }
  return { path, start, end, ranges, commits };
}

/** Runs one job at a time per key; a few may wait, each leaving the queue when its request is gone. */
export class SerialQueue {
  private readonly tails = new Map<string, { tail: Promise<void>; waiting: number }>();

  async run<T>(key: string, signal: AbortSignal | undefined, job: () => Promise<T>): Promise<T> {
    const entry = this.tails.get(key) ?? { tail: Promise.resolve(), waiting: 0 };
    if (entry.waiting >= GIT_READ_BUDGET.blameWaiting) throw new AppError('GIT_BUSY', 'Too many blame requests are waiting for this repository', 429);
    entry.waiting += 1;
    const previous = entry.tail;
    let release!: () => void;
    entry.tail = new Promise<void>(resolve => { release = resolve; });
    this.tails.set(key, entry);
    let left = false;
    const leave = (): void => { if (!left) { left = true; entry.waiting -= 1; } };
    try {
      await new Promise<void>((resolve, reject) => {
        const gone = (): void => reject(new AppError('REQUEST_ABORTED', 'Request was cancelled', 499));
        if (signal?.aborted) return gone();
        signal?.addEventListener('abort', gone, { once: true });
        previous.then(() => { signal?.removeEventListener('abort', gone); resolve(); });
      });
      if (signal?.aborted) throw new AppError('REQUEST_ABORTED', 'Request was cancelled', 499);
      return await job();
    } finally {
      leave();
      // A request that left while waiting still hands the turn on only after the job ahead of it is done.
      void previous.then(release);
      if (entry.waiting === 0 && this.tails.get(key) === entry) this.tails.delete(key);
    }
  }
}

/** Bounded by count, size and age; a hit moves the entry to the newest end. */
export class BlameCache {
  private readonly entries = new Map<string, { value: GitBlame; bytes: number; at: number }>();
  private bytes = 0;
  private sweep: NodeJS.Timeout | undefined;

  get(key: string): GitBlame | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (Date.now() - entry.at > GIT_READ_BUDGET.blameCacheTtlMs) { this.bytes -= entry.bytes; return undefined; }
    entry.at = Date.now();
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: GitBlame): void {
    const old = this.entries.get(key);
    if (old) { this.bytes -= old.bytes; this.entries.delete(key); }
    const bytes = JSON.stringify(value).length * 2;
    if (bytes > GIT_READ_BUDGET.blameCacheBytes) return;
    this.entries.set(key, { value, bytes, at: Date.now() });
    this.bytes += bytes;
    while (this.entries.size > GIT_READ_BUDGET.blameCacheEntries || this.bytes > GIT_READ_BUDGET.blameCacheBytes) {
      const oldest = this.entries.keys().next().value as string;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
    this.sweep ??= setInterval(() => this.expire(), GIT_READ_BUDGET.blameCacheTtlMs / 2);
    this.sweep.unref();
  }

  private expire(): void {
    const cutoff = Date.now() - GIT_READ_BUDGET.blameCacheTtlMs;
    for (const [key, entry] of this.entries) if (entry.at < cutoff) { this.bytes -= entry.bytes; this.entries.delete(key); }
    if (!this.entries.size && this.sweep) { clearInterval(this.sweep); this.sweep = undefined; }
  }

  clear(): void { this.entries.clear(); this.bytes = 0; if (this.sweep) { clearInterval(this.sweep); this.sweep = undefined; } }
}
