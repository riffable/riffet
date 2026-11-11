import { execFile, spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { SearchHit } from '../../../../packages/contracts/src/index.js';
import { resolveCliExecutable } from '../backends/shared/cli-resolve.js';

// File search as an IDE's "Go to File" does it (VS Code's Quick Open is the model: list every file
// the repository does not ignore, then score the names): a project's paths come from git, which reads
// them from its index in a fraction of a second even for a monorepo of several hundred thousand
// files, or from ripgrep outside git. Untracked files are slower to list (git has to walk the tree),
// so they are read in the background and joined when ready. Content search runs ripgrep, which
// honours .gitignore and searches in parallel; without it the caller walks the tree itself.

const LIST_TIMEOUT_MS = 30_000;
const UNTRACKED_TTL_MS = 60_000;
const SEARCH_TIMEOUT_MS = 20_000;
const MAX_LIST_BYTES = 512 * 1024 * 1024;
const MAX_LINE = 1000;

interface Listing { tracked: string[]; untracked: string[]; candidates?: Candidates; key: string; untrackedAt: number; refreshing?: Promise<void> }

/** Every file, then every directory, of a project, with each one's name in lower case, built once per listing. */
export interface Candidates {
  paths: string[];
  /** Lower-case last segment of each path. */
  names: string[];
  /** Index of the first directory in `paths`. */
  dirStart: number;
}

export function candidates(files: readonly string[]): Candidates {
  const dirs = new Set<string>();
  for (const file of files) for (let at = file.indexOf('/'); at > 0; at = file.indexOf('/', at + 1)) dirs.add(file.slice(0, at));
  const paths = [...files, ...dirs];
  return { paths, names: paths.map(item => item.slice(item.lastIndexOf('/') + 1).toLowerCase()), dirStart: files.length };
}

function run(file: string, args: string[], cwd: string, timeout = LIST_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, timeout, maxBuffer: MAX_LIST_BYTES, encoding: 'utf8' }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

const split = (output: string): string[] => output.split('\0').filter(Boolean);

/** Where git keeps the index of the checkout at `root`, whose change time marks a change of the tracked set. */
async function gitIndex(root: string): Promise<string | undefined> {
  try {
    const dir = (await run('git', ['rev-parse', '--git-dir'], root, 5000)).trim();
    return path.resolve(root, dir, 'index');
  } catch { return undefined; }
}

const ripgrep = (): string | undefined => {
  const resolution = resolveCliExecutable({ command: 'rg' });
  return resolution.resolved ? resolution.executable : undefined;
};

export class FileIndex {
  private readonly listings = new Map<string, Listing>();

  /**
   * The project's files, project-relative with `/`; `undefined` when neither git nor ripgrep can list
   * them, and the caller walks the tree. The tracked set is read again when git's index changes.
   */
  async paths(root: string): Promise<Candidates | undefined> {
    const index = await gitIndex(root);
    if (index) {
      const key = `git:${await stat(index).then(info => info.mtimeMs, () => 0)}`;
      let listing = this.listings.get(root);
      if (!listing || listing.key !== key) {
        // A failed listing is not kept: the caller walks the tree this time, and the next query tries again.
        const output = await run('git', ['-c', 'core.quotePath=false', 'ls-files', '-z', '--cached'], root).catch(() => undefined);
        if (output === undefined) return undefined;
        const tracked = split(output);
        listing = { tracked, untracked: listing?.untracked ?? [], key, untrackedAt: listing?.untrackedAt ?? 0 };
        this.listings.set(root, listing);
      }
      if (Date.now() - listing.untrackedAt > UNTRACKED_TTL_MS && !listing.refreshing) {
        const current = listing;
        current.refreshing = run('git', ['-c', 'core.quotePath=false', 'ls-files', '-z', '--others', '--exclude-standard'], root, 120_000)
          .then(output => { current.untracked = split(output); current.candidates = undefined; }, () => undefined)
          .finally(() => { current.untrackedAt = Date.now(); current.refreshing = undefined; });
        // The first listing of a checkout waits briefly for them; a later one uses what it has.
        if (!current.untrackedAt) await Promise.race([current.refreshing, new Promise(resolve => setTimeout(resolve, 1500))]);
      }
      return this.withDirs(listing);
    }
    const rg = ripgrep();
    if (!rg) return undefined;
    const key = 'rg';
    let listing = this.listings.get(root);
    if (!listing || listing.key !== key || Date.now() - listing.untrackedAt > UNTRACKED_TTL_MS) {
      const output = await run(rg, ['--no-config', '--files', '--null', '--hidden', '--glob', '!.git'], root).catch(() => undefined);
      if (output === undefined) return undefined;
      const files = split(output);
      listing = { tracked: files, untracked: [], key, untrackedAt: Date.now() };
      this.listings.set(root, listing);
    }
    return this.withDirs(listing);
  }

  private withDirs(listing: Listing): Candidates {
    listing.candidates ??= candidates(listing.untracked.length ? [...listing.tracked, ...listing.untracked] : listing.tracked);
    return listing.candidates;
  }
}

// ── Scoring ──────────────────────────────────────────────────────────────────

const isUpper = (code: number) => code >= 65 && code <= 90;
const isLower = (code: number) => code >= 97 && code <= 122;
const isDigit = (code: number) => code >= 48 && code <= 57;
const isSeparator = (code: number) => code === 47 || code === 95 || code === 45 || code === 46 || code === 32;

/** Where words start in a name: after a separator, at an upper-case letter after a lower-case one or a digit, at a digit run. */
function wordStarts(name: string): boolean[] {
  const starts: boolean[] = new Array(name.length);
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    const previous = index ? name.charCodeAt(index - 1) : -1;
    starts[index] = index === 0 || isSeparator(previous) || (isUpper(code) && (isLower(previous) || isDigit(previous))) || (isDigit(code) && !isDigit(previous));
  }
  return starts;
}

/**
 * How well `query` (lower case, no `/`) names `name`; 0 for no match. In order: the whole name, the
 * name without its extension, a prefix, a run starting a word, any run, the initials of its words
 * (`lpp` for `LongPressPanel`), then letters in order with bonuses for word starts and runs.
 */
export function scoreName(name: string, query: string, lower = name.toLowerCase()): number {
  const stem = lower.includes('.') ? lower.slice(0, lower.lastIndexOf('.')) : lower;
  const short = Math.max(0, 64 - name.length);
  if (lower === query) return 10_000 + short;
  if (stem === query) return 9_000 + short;
  if (lower.startsWith(query)) return 8_000 + short;
  const starts = wordStarts(name);
  const at = lower.indexOf(query);
  if (at >= 0) {
    let first = at;
    for (let next = at; next >= 0; next = lower.indexOf(query, next + 1)) if (starts[next]) { first = next; break; }
    return (starts[first] ? 7_000 : 6_000) + short - first;
  }
  const placed = letters(lower, starts, query, true) ?? letters(lower, starts, query, false);
  if (!placed) return 0;
  return (placed.initials ? 5_000 : 3_000) + Math.max(0, placed.score) * 4 + short;
}

/**
 * `query`'s letters in order in `lower`, each at the next word start where `starts` has one before the
 * next plain occurrence (or at the first occurrence), with bonuses for word starts and runs.
 */
function letters(lower: string, starts: readonly boolean[], query: string, preferStarts: boolean): { score: number; initials: boolean } | undefined {
  let score = 0;
  let position = 0;
  let run = 0;
  let initials = true;
  for (const char of query) {
    let found = -1;
    for (let index = position; index < lower.length; index++) {
      if (lower[index] !== char) continue;
      if (found < 0) found = index;
      if (!preferStarts || starts[index]) { found = index; break; }
    }
    if (found < 0) return undefined;
    if (!starts[found]) initials = false;
    run = found === position && position > 0 ? run + 1 : 0;
    score += (starts[found] ? 12 : 1) + run * 6 - Math.min(8, found - position);
    position = found + 1;
  }
  return { score, initials };
}

/**
 * The best matches of `query` among `list` (`within` a directory prefix, if given), best first. A query
 * with `/` matches its last part against the name and the parts before it, in order, against the
 * directories. A directory ranks below the files whose names match about as well.
 */
export function rankPaths(list: Candidates, query: string, limit: number, within = ''): Array<{ path: string; directory: boolean }> {
  const parts = query.trim().toLowerCase().split('/').filter(Boolean);
  const name = parts.pop();
  if (!name) return [];
  const top: Array<{ index: number; score: number }> = [];
  let floor = -Infinity;
  const first = name[0]!;
  const order = (a: { index: number; score: number }, b: { index: number; score: number }) => b.score - a.score || list.paths[a.index]!.length - list.paths[b.index]!.length;
  for (let index = 0; index < list.paths.length; index++) {
    const lower = list.names[index]!;
    // Most names do not even contain the first letter: skip them before scoring.
    if (!lower.includes(first)) continue;
    const item = list.paths[index]!;
    if (within && !item.startsWith(within)) continue;
    let score = scoreName(item.slice(item.length - lower.length), name, lower);
    if (!score) continue;
    if (parts.length) {
      // Each part in order in the directories: a whole directory name counts most, then the start of one.
      const dir = `/${item.slice(0, Math.max(0, item.length - lower.length - 1)).toLowerCase()}/`;
      let from = 0;
      for (const part of parts) {
        const whole = dir.indexOf(`/${part}/`, from);
        const start = whole >= 0 ? whole : dir.indexOf(`/${part}`, from);
        const found = start >= 0 ? start + 1 : dir.indexOf(part, from);
        if (found < 0) { score = 0; break; }
        score += whole >= 0 ? 400 : start >= 0 ? 200 : 0;
        from = found + part.length;
      }
      if (!score) continue;
    }
    if (index >= list.dirStart) score -= 3_500;
    // Between equal names, the shallower path.
    let depth = 0;
    for (let at = item.indexOf('/'); at >= 0 && depth < 63; at = item.indexOf('/', at + 1)) depth++;
    score = score * 64 - depth;
    if (top.length >= limit && score <= floor) continue;
    top.push({ index, score });
    if (top.length > limit * 4) { top.sort(order); top.length = limit; floor = top.at(-1)!.score; }
  }
  return top.sort(order).slice(0, limit).map(({ index }) => ({ path: list.paths[index]!, directory: index >= list.dirStart }));
}

// ── Content ──────────────────────────────────────────────────────────────────

/**
 * Lines containing `needle` (case-insensitive, literal) under `base`, with ripgrep; `undefined` when
 * it is not installed. Stops once `limit + offset` lines are found, so a common word costs no more
 * than a rare one. The first page takes what its threads find first; a later page reads in path
 * order (one thread), so pages neither overlap nor skip. Paths are relative to `root`. `signal`
 * ends the search, for a client that went away.
 */
export function ripgrepSearch(root: string, base: string, needle: string, limit: number, offset: number, signal?: AbortSignal): Promise<SearchHit[] | undefined> {
  const rg = ripgrep();
  if (!rg) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const want = limit + offset;
    const hits: SearchHit[] = [];
    const child = spawn(rg, [
      '--no-config', ...(offset > 0 ? ['--sort', 'path'] : []), '--null', '--line-number', '--no-heading', '--color', 'never', '--fixed-strings', '--ignore-case',
      '--max-filesize', '2M', '--max-columns', String(MAX_LINE), '--max-columns-preview', '--hidden', '--glob', '!.git', '--', needle, '.',
    ], { cwd: base, stdio: ['ignore', 'pipe', 'ignore'] });
    let buffer = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      child.kill('SIGTERM');
      // ripgrep reports in the order its threads finish; a stable order reads better.
      hits.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
      resolve(hits.slice(offset, want));
    };
    const timer = setTimeout(finish, SEARCH_TIMEOUT_MS);
    if (signal?.aborted) finish(); else signal?.addEventListener('abort', finish, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const nul = line.indexOf('\0');
        const colon = line.indexOf(':', nul + 1);
        if (nul < 0 || colon < 0) continue;
        const file = path.relative(root, path.resolve(base, line.slice(0, nul))).split(path.sep).join('/');
        hits.push({ path: file, line: Number(line.slice(nul + 1, colon)), text: line.slice(colon + 1, colon + 1 + MAX_LINE) });
        if (hits.length >= want) { finish(); return; }
      }
    });
    child.on('close', finish);
    child.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve(undefined); } });
  });
}
