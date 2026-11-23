import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODE_INDEX_BUDGET } from '../../../../../packages/contracts/src/budgets.js';
import type { CodeIndexStatus, CodeOutline, CodeOutlineItem, CodeSymbol, CodeSymbolResults } from '../../../../../packages/contracts/src/index.js';
import type { Candidates } from '../file-index.js';
import { WorkerPool } from './pool.js';
import { CHUNK_BITS, isIndexedWord, isTypeKind, SymbolStore, WORD_MIN_LENGTH, WORD_STOP, type Declaration, type ParsedFile, type ParsedSymbol, type SymbolRow } from './store.js';

// The declaration index of a project, for "Go to Symbol", outlines and narrowed code navigation. One
// SQLite file per project under `<stateDir>/code-index/`, filled by child processes that run tree-sitter
// over the project's Kotlin and Java files (and read its Android resource files) and write the rows themselves (a monorepo has hundreds of
// thousands of files and millions of rows: the event loop only hands out paths and reads counts, and the
// parser's heap grows with every file, hence processes that exit once a build ends). What is open, and what runs,
// is bounded by CODE_INDEX_BUDGET: indexes are opened on first use, the least recently used is closed
// past `openIndexes`, an idle one is closed after `idleCloseMs`, and closing aborts a build in progress,
// which a later build resumes because every batch is written together with the stamps of its files.
// Builds and checks run only while a page watches the index (`watch`): queries read what is there and never start
// one, and a watch that lapses or is dropped stops the build at once, workers killed mid-batch.

const SOURCE = /\.(?:kt|kts|java)$/;
/** `res/<directory>/<file>` of an Android module: resources are indexed by name (`resources`), not parsed for declarations. */
const RESOURCE = /(?:^|\/)res\/[^/]+\/[^/.][^/]*$/;
const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const NO_STATUS: CodeIndexStatus = { state: 'idle', files: 0, done: 0, symbols: 0 };

/** What code navigation asks of the index; WorkspaceService hands one to each CodeNav. */
export interface SymbolLookup {
  /** Declarations named `name` in a ready index; `undefined` when the project's index is not ready. */
  declarations(root: string, name: string): Declaration[] | undefined;
  /**
   * The source files under `within` ('' for the project) that can contain the identifier `word`: a superset
   * of the files that do. `undefined` when the index is not ready or complete, the word is not indexed, or
   * there are too many files to be worth narrowing.
   */
  wordFiles(root: string, word: string, within: string): string[] | undefined;
  /**
   * Indexed-kind files (source and resource) whose content may differ from the index: changed since the last
   * check relative to git, dirty at that check, or untracked. Answers made from the index add these files to
   * what they read. `undefined` when that cannot be told (no git, git too slow, too many files, no check
   * finished since the server started): the index is then not trusted for an answer of "none".
   */
  changedSince(root: string): Promise<string[] | undefined>;
  /** Where Android resource `type` / `name` (as `R` spells it) is defined; `undefined` when the index is not ready or complete. */
  resources(root: string, type: string, name: string): Array<{ path: string; line: number }> | undefined;
}

interface Entry {
  root: string;
  store: SymbolStore;
  status: CodeIndexStatus;
  checkedAt: number;
  usedAt: number;
  timer?: NodeJS.Timeout;
  /** The pages watching, each until its lease runs out; a build runs while one is left. */
  watchers: Map<string, number>;
  /** Fires when the soonest lease runs out. */
  watch?: NodeJS.Timeout;
  building?: Promise<void>;
  abort?: AbortController;
  pool?: WorkerPool;
  /** The commit and the uncommitted files (indexed kinds) when the last completed check began; kept in memory, so after a restart nothing is narrowed until a check finishes. */
  checked?: Checked;
  changed?: { at: number; head: string; value: Promise<string[] | undefined> };
  /** The index against the checked commit as of one write of git's index, when that is not the one the check saw. */
  staged?: { key: number; files: string[] };
}

const indexed = (file: string): boolean => SOURCE.test(file) || RESOURCE.test(file);

function git(root: string, args: string[], timeout: number, signal?: AbortSignal): Promise<string | undefined> {
  return new Promise(resolve => {
    // GIT_OPTIONAL_LOCKS=0: a check in the background never takes git's index lock from the user's own commands.
    execFile('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, timeout, maxBuffer: CODE_INDEX_BUDGET.changedListBytes, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, ...(signal ? { signal } : {}) }, (error, stdout) => resolve(error ? undefined : stdout));
  });
}

/**
 * Changed files, project-relative: without `head` the working tree against git's index, with it the index against that commit.
 * The plumbing commands, not `git diff`: that one refreshes and rewrites the index, racing the user's `git commit` for its lock.
 * A file only touched (same content, new mtime) is then listed too, which only adds a file to read.
 */
const differing = async (root: string, head: string | undefined, timeout: number, signal?: AbortSignal): Promise<string[] | undefined> =>
  (await git(root, [...(head ? ['diff-index', '--cached'] : ['diff-files']), '--name-only', '-z', '--relative', ...(head ? [head, '--'] : [])], timeout, signal))?.split('\0').filter(Boolean);

const mtimeOf = (file: string): Promise<number | undefined> => stat(file).then(info => info.mtimeMs, () => undefined);

/** What a completed check knew of git when it began. */
interface Checked {
  head: string;
  /** Uncommitted files (indexed kinds) at that moment. */
  dirty: Set<string>;
  /** git's index file, and when the index was last written and which files it then differed from `head` in: reused while the file is unchanged. */
  indexFile?: string;
  indexKey?: number;
  staged?: string[];
}

async function snapshot(root: string, signal: AbortSignal): Promise<Checked | undefined> {
  const head = (await git(root, ['rev-parse', 'HEAD'], 10_000, signal))?.trim();
  if (!head) return undefined;
  const dir = (await git(root, ['rev-parse', '--git-dir'], 10_000, signal))?.trim();
  const indexFile = dir ? path.resolve(root, dir, 'index') : undefined;
  const before = indexFile ? await mtimeOf(indexFile) : undefined;
  const staged = await differing(root, head, 120_000, signal);
  const unstaged = await differing(root, undefined, 120_000, signal);
  if (!staged || !unstaged) return undefined;
  const steady = before !== undefined && before === (await mtimeOf(indexFile!));
  return { head, dirty: new Set([...staged, ...unstaged].filter(indexed)), ...(indexFile ? { indexFile } : {}), ...(steady ? { indexKey: before, staged: staged.filter(indexed) } : {}) };
}

const sourceFiles = (list: Candidates): string[] => list.paths.slice(0, list.dirStart).filter(indexed);

export class SymbolIndexes implements SymbolLookup {
  private readonly entries = new Map<string, Entry>();
  private outlinePool?: WorkerPool;
  private outlineTimer?: NodeJS.Timeout;
  private closed = false;
  private readonly dir: string;
  private readonly data: Record<string, unknown>;

  constructor(options: { stateDir: string; paths: (root: string) => Promise<Candidates | undefined>; untracked: (root: string) => Promise<string[] | undefined> }, private readonly budget: { [K in keyof typeof CODE_INDEX_BUDGET]: number } = CODE_INDEX_BUDGET) {
    this.dir = path.join(options.stateDir, 'code-index');
    this.listing = options.paths;
    this.untracked = options.untracked;
    this.data = {
      treeSitter: createRequire(import.meta.url).resolve('web-tree-sitter'),
      grammars: { kotlin: here('./grammars/tree-sitter-kotlin.wasm'), java: here('./grammars/tree-sitter-java.wasm') },
      fileBytes: budget.fileBytes,
      wordMinLength: WORD_MIN_LENGTH, wordStop: WORD_STOP, chunkBits: CHUNK_BITS,
    };
  }
  private readonly listing: (root: string) => Promise<Candidates | undefined>;
  private readonly untracked: (root: string) => Promise<string[] | undefined>;

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  private fileOf(root: string): string {
    return path.join(this.dir, `${createHash('sha256').update(root).digest('hex').slice(0, 16)}.db`);
  }

  /** The open index of a project; without `create`, only one that already exists on disk. */
  private open(root: string, create: boolean): Entry | undefined {
    if (this.closed) return undefined;
    let entry = this.entries.get(root);
    if (!entry) {
      const file = this.fileOf(root);
      if (!create && !existsSync(file)) return undefined;
      const store = new SymbolStore(file);
      const counts = store.counts();
      const builtAt = store.meta('builtAt');
      entry = { root, store, watchers: new Map(), usedAt: Date.now(), checkedAt: 0, status: builtAt ? { state: 'ready', files: counts.files, done: counts.files, symbols: counts.symbols, builtAt } : { ...NO_STATUS, files: counts.files, done: counts.files, symbols: counts.symbols } };
      this.entries.set(root, entry);
      this.evict();
    }
    entry.usedAt = Date.now();
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { void this.closeEntry(entry!); }, this.budget.idleCloseMs);
    entry.timer.unref();
    return entry;
  }

  /** Closes the least recently used indexes past the limit; one that is not building goes first. */
  private evict(): void {
    while (this.entries.size > this.budget.openIndexes) {
      const all = [...this.entries.values()].sort((a, b) => Number(Boolean(a.building)) - Number(Boolean(b.building)) || a.usedAt - b.usedAt);
      void this.closeEntry(all[0]!);
    }
  }

  private async closeEntry(entry: Entry): Promise<void> {
    if (this.entries.get(entry.root) === entry) this.entries.delete(entry.root);
    clearTimeout(entry.timer);
    clearTimeout(entry.watch);
    entry.abort?.abort();
    await entry.pool?.terminate();
    await entry.building?.catch(() => undefined);
    try { entry.store.close(); } catch { /* closed already */ }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.outlineTimer);
    await Promise.all([...this.entries.values()].map(entry => this.closeEntry(entry)));
    await this.outlinePool?.terminate();
    this.outlinePool = undefined;
  }

  // ── Building ───────────────────────────────────────────────────────────────

  /** Starts a build when the index has none, or last looked at the project `recheckMs` ago; only for a watched index. */
  private ensure(entry: Entry): void {
    if (entry.building) return;
    const stale = Date.now() - entry.checkedAt > this.budget.recheckMs;
    if (entry.status.state === 'idle' || stale) this.start(entry, false);
  }

  private start(entry: Entry, force: boolean): void {
    if (entry.building) return;
    const abort = new AbortController();
    entry.abort = abort;
    // Under way from now: listing the files of a large project takes seconds before the first batch.
    if (entry.status.state === 'idle') entry.status = { ...entry.status, state: 'building', done: 0 };
    entry.building = this.build(entry, force, abort.signal).finally(() => {
      entry.building = undefined;
      entry.abort = undefined;
      // Stopped: a first build is not running any more, and an index that was ready answers as before.
      if (abort.signal.aborted) entry.status = entry.status.state === 'building' ? { ...entry.status, state: 'idle' } : { ...entry.status, done: entry.status.files };
    });
  }

  /** Stops a build in progress now. What finished batches wrote stays, and the next build goes on from there. */
  private stop(entry: Entry): void {
    if (!entry.building) return;
    entry.abort?.abort();
    void entry.pool?.terminate();
  }

  /**
   * Keeps the index of `root` up to date while a page shows it: a build starts when there is none or the last
   * check is `recheckMs` old, and runs while some page renews its `lease` within `watchMs`. A page that leaves
   * drops its lease (`watching: false`); once no lease is left a build in progress is stopped, so one page leaving
   * does not stop the build another still shows. Nothing else starts a build.
   */
  watch(root: string, lease: string, watching: boolean): CodeIndexStatus {
    if (!watching) {
      const entry = this.entries.get(root);
      if (!entry) return NO_STATUS;
      entry.watchers.delete(lease);
      this.lapse(entry);
      return entry.status;
    }
    const entry = this.open(root, true);
    if (!entry) return NO_STATUS;
    this.renew(entry, lease);
    this.ensure(entry);
    return entry.status;
  }

  private renew(entry: Entry, lease: string): void {
    entry.watchers.set(lease, Date.now() + this.budget.watchMs);
    this.lapse(entry);
  }

  /** Drops the leases that ran out: with none left the build stops, else this runs again when the soonest runs out. */
  private lapse(entry: Entry): void {
    const now = Date.now();
    for (const [lease, until] of entry.watchers) if (until <= now) entry.watchers.delete(lease);
    clearTimeout(entry.watch);
    entry.watch = undefined;
    if (!entry.watchers.size) { this.stop(entry); return; }
    entry.watch = setTimeout(() => this.lapse(entry), Math.min(...entry.watchers.values()) - now);
    entry.watch.unref();
  }

  private async build(entry: Entry, force: boolean, signal: AbortSignal): Promise<void> {
    const { store, root } = entry;
    const first = entry.status.state !== 'ready';
    const pool = new WorkerPool(here('./parse-worker.mjs'), this.budget.workers, this.data, this.budget.workerRecycleFiles);
    entry.pool = pool;
    try {
      // Taken before any file is compared: what differs from this commit now, or did then, is what a later answer must read afresh.
      const seen = await snapshot(root, signal);
      const list = await this.listing(root);
      if (signal.aborted) return;
      if (!list) throw new Error('The project has no file list: git or ripgrep is needed');
      const all = sourceFiles(list);
      const files = all.slice(0, this.budget.maxFiles);
      const truncated = all.length > files.length;
      entry.status = { ...entry.status, state: first ? 'building' : 'ready', files: files.length, done: 0 };
      await pool.run({ type: 'sweep', db: store.file, present: files, reset: force }, 0);
      if (signal.aborted) return;

      // Each batch is compared with the index, parsed where it changed and written by the worker that took it.
      let next = 0;
      const lane = async () => {
        while (!signal.aborted && next < files.length) {
          const batch = files.slice(next, next += this.budget.batchFiles);
          const symbols = await this.index(pool, root, store.file, batch, force);
          if (signal.aborted) return;
          entry.status = { ...entry.status, done: entry.status.done + batch.length, ...(symbols === undefined ? {} : { symbols }) };
        }
      };
      await Promise.all(Array.from({ length: this.budget.workers }, lane));
      if (signal.aborted) return;

      await pool.run({ type: 'optimize', db: store.file }, 0);
      if (signal.aborted) return;
      const counts = store.counts();
      const builtAt = new Date().toISOString();
      store.setMeta('builtAt', builtAt);
      entry.checkedAt = Date.now();
      entry.checked = seen;
      entry.changed = undefined;
      entry.staged = undefined;
      entry.status = { state: 'ready', files: files.length, done: files.length, symbols: counts.symbols, builtAt, ...(truncated ? { error: `Only the first ${files.length} source files are indexed` } : {}) };
    } catch (error) {
      if (signal.aborted) return;
      entry.checkedAt = Date.now();
      entry.status = { ...entry.status, state: entry.status.builtAt ? 'ready' : 'failed', error: error instanceof Error ? error.message : String(error) };
    } finally {
      entry.pool = undefined;
      await pool.terminate();
    }
  }

  /**
   * One batch through a worker, answered with the index's declaration total. When the worker dies on
   * it, file by file, and a file that takes a worker down again is recorded as bad. When no task of the
   * pool ever finished, the workers themselves cannot run (missing script or grammar): that fails the
   * build instead of recording a whole project as unparseable.
   */
  private async index(pool: WorkerPool, root: string, db: string, batch: string[], force: boolean): Promise<number | undefined> {
    type Answer = { symbols: number };
    try {
      return (await pool.run<Answer>({ type: 'index', db, root, files: batch, force }, batch.length)).symbols;
    } catch (error) {
      // The sweep that began the build counts: a child that ran it can run, so a death here is the batch's own doing.
      if (pool.completed === 0 || /closed/.test(String(error))) throw error;
      let symbols: number | undefined;
      for (const file of batch) {
        try { symbols = (await pool.run<Answer>({ type: 'index', db, root, files: [file], force }, 1)).symbols; }
        catch (inner) {
          if (/closed/.test(String(inner))) throw inner;
          symbols = (await pool.run<Answer>({ type: 'index', db, root, files: [file], force: true, markBad: true }, 0)).symbols;
        }
      }
      return symbols;
    }
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  /** The state of a project's index; one never built is idle and creates nothing on disk. */
  status(root: string): CodeIndexStatus {
    return (this.open(root, false)?.status ?? NO_STATUS);
  }

  rebuild(root: string): CodeIndexStatus {
    const entry = this.open(root, true);
    if (!entry) return NO_STATUS;
    // A rebuild asked for runs at least a lease long, as a watch would; the page asking renews its own lease meanwhile.
    this.renew(entry, 'rebuild');
    this.start(entry, true);
    if (entry.status.state !== 'building') entry.status = { ...entry.status, done: 0 };
    return entry.status;
  }

  /**
   * Declarations whose names match `query`, best first: the whole name, then names it starts, then
   * names whose word initials it starts (`FF` for `FeedFragment`), then names containing it. Equal
   * matches put the shorter name first, then a type before a member. Before the index is ready the answer is
   * empty with its status; asking does not start a build (`watch` does).
   */
  search(root: string, query: string, options: { types: boolean; limit: number }): CodeSymbolResults {
    const entry = this.open(root, false);
    if (!entry) return { items: [], index: NO_STATUS };
    const q = query.trim();
    if (!q || entry.status.state !== 'ready') return { items: [], index: entry.status };
    const lower = q.toLowerCase();
    const tiers = entry.store.candidates(lower, options.types, this.budget.candidateRows, options.limit);
    const seen = new Set<string>();
    const ranked: Array<{ row: SymbolRow; tier: number; exactCase: number }> = [];
    const add = (rows: SymbolRow[], tier: number) => {
      for (const row of rows) {
        const key = `${row.path}:${row.line}:${row.column}:${row.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        ranked.push({ row, tier, exactCase: row.name.startsWith(q) ? 1 : 0 });
      }
    };
    add(tiers.exact, 4); add(tiers.prefix, 3);
    // Initials are checked in JS too: the index range also holds names whose initials merely begin like the query.
    add(tiers.initials.filter(row => row.initials?.startsWith(lower)), 2);
    add(tiers.contains, 1);
    ranked.sort((a, b) => b.tier - a.tier || b.exactCase - a.exactCase || a.row.name.length - b.row.name.length
      || Number(isTypeKind(b.row.kind)) - Number(isTypeKind(a.row.kind)) || (a.row.path < b.row.path ? -1 : a.row.path > b.row.path ? 1 : a.row.line - b.row.line));
    const packages = new Map<string, string | undefined>();
    const items: CodeSymbol[] = ranked.slice(0, options.limit).map(({ row }) => {
      if (!packages.has(row.path)) packages.set(row.path, entry.store.packageOf(row.path));
      const pkg = packages.get(row.path);
      return { name: row.name, kind: row.kind, path: row.path, line: row.line, column: row.column, ...(row.container ? { container: row.container } : {}), ...(pkg ? { package: pkg } : {}) };
    });
    return { items, index: entry.status };
  }

  private ready(root: string): Entry | undefined {
    const entry = this.open(root, false);
    return entry && entry.status.state === 'ready' ? entry : undefined;
  }

  declarations(root: string, name: string): Declaration[] | undefined {
    return this.ready(root)?.store.declarations(name, this.budget.definitionRows);
  }

  /** A trustworthy index: ready, and covering every file the project lists (a truncated one, or one whose last check failed, answers nothing). */
  private complete(root: string): Entry | undefined {
    const entry = this.ready(root);
    // As fresh as the last check, plus `changedSince`; checks only run while the index is watched.
    return entry && !entry.status.error ? entry : undefined;
  }

  changedSince(root: string): Promise<string[] | undefined> {
    const entry = this.complete(root);
    if (!entry?.checked) return Promise.resolve(undefined);
    const checked = entry.checked;
    if (entry.changed?.head === checked.head && Date.now() - entry.changed.at < this.budget.changedTtlMs) return entry.changed.value;
    const value = Promise.all([differing(root, undefined, this.budget.changedGitMs), this.stagedFiles(entry, checked), this.untracked(root)]).then(([unstaged, staged, untracked]) => {
      if (!unstaged || !staged || !untracked) return undefined;
      const all = new Set([...unstaged, ...staged, ...checked.dirty, ...untracked].filter(indexed));
      return all.size > this.budget.changedFiles ? undefined : [...all];
    });
    entry.changed = { at: Date.now(), head: checked.head, value };
    return value;
  }

  /** What the index of git differs from the checked commit in: the check's own answer while the index file is as it was, else compared again (slow, hence kept until the file changes). */
  private async stagedFiles(entry: Entry, checked: Checked): Promise<string[] | undefined> {
    const key = checked.indexFile ? await mtimeOf(checked.indexFile) : undefined;
    if (key !== undefined && key === checked.indexKey) return checked.staged;
    if (key !== undefined && entry.staged?.key === key) return entry.staged.files;
    const files = (await differing(entry.root, checked.head, this.budget.changedIndexMs))?.filter(indexed);
    if (files && key !== undefined) entry.staged = { key, files };
    return files;
  }

  wordFiles(root: string, word: string, within: string): string[] | undefined {
    if (!isIndexedWord(word)) return undefined;
    return this.complete(root)?.store.wordFiles(word, within, this.budget.referenceFiles);
  }

  resources(root: string, type: string, name: string): Array<{ path: string; line: number }> | undefined {
    return this.complete(root)?.store.resources(type, name, this.budget.definitionRows);
  }

  // ── Outline ────────────────────────────────────────────────────────────────

  /**
   * The declarations of one file, parsed on the spot and independent of the index. A single file is
   * small, but the parser and its grammars are tens of megabytes of WebAssembly: they live in one worker
   * that stops after `outlineIdleMs`, so the server's own heap never holds them.
   */
  async outline(absolute: string, relative: string): Promise<CodeOutline> {
    if (this.closed || !SOURCE.test(relative)) return { path: relative, items: [] };
    this.outlinePool ??= new WorkerPool(here('./parse-worker.mjs'), 1, this.data, this.budget.workerRecycleFiles);
    const pool = this.outlinePool;
    clearTimeout(this.outlineTimer);
    this.outlineTimer = setTimeout(() => { this.outlinePool = undefined; void pool.terminate(); }, this.budget.outlineIdleMs);
    this.outlineTimer.unref();
    const { results } = await pool.run<{ results: ParsedFile[] }>({ type: 'parse', root: path.dirname(absolute), files: [path.basename(absolute)] }, 1);
    const file = results[0];
    return { path: relative, ...(file?.package ? { package: file.package } : {}), items: outlineTree((file?.symbols ?? []).slice(0, this.budget.outlineItems)) };
  }
}

/** Declarations in document order with their nesting depth, as a tree. */
export function outlineTree(symbols: readonly ParsedSymbol[]): CodeOutlineItem[] {
  const roots: CodeOutlineItem[] = [];
  const stack: Array<{ depth: number; item: CodeOutlineItem }> = [];
  for (const symbol of symbols) {
    const item: CodeOutlineItem = { name: symbol.name, kind: symbol.kind, line: symbol.line, column: symbol.column };
    while (stack.length && stack.at(-1)!.depth >= symbol.depth) stack.pop();
    const parent = stack.at(-1)?.item;
    if (parent) (parent.children ??= []).push(item); else roots.push(item);
    stack.push({ depth: symbol.depth, item });
  }
  return roots;
}
