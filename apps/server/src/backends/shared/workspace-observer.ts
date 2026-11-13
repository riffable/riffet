import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { exec, ExecError } from '../../exec.js';
import { splitUnifiedDiff } from './unified-diff.js';

/*
 * What a shell command changed in the working tree, for a tool that reports no edits of its own.
 *
 * A driver brackets one command between `begin` and `end` (Claude's PreToolUse and PostToolUse hooks);
 * each takes a snapshot of the repository the command runs in, and `end` returns the difference as
 * the `diff` blocks an edit tool's call carries, marked `observed`. The difference is the whole
 * working tree's, so a write another process makes during the command is counted too; keeping the
 * window to one command keeps that rare. Files an edit tool reported meanwhile (`noteEdit`) are left
 * to that tool.
 *
 * Windows of one working tree overlap when commands run in parallel. The snapshots, taken in order,
 * cut time into intervals, and each interval is reported once: by the first window that ends after
 * it, among the windows open across it. So nothing is counted twice, and nothing is lost when windows
 * end in a different order than they began.
 *
 * Snapshots live in a shadow repository per working tree under the server's state directory: its own
 * index and objects, the project's objects borrowed read-only through `objects/info/alternates`, and
 * the project's index copied once so the first snapshot hashes only what is uncommitted. The project's
 * `.git` is never written. Snapshots are trees, never commits or refs, and are pruned when no window
 * is open. Only git working trees are observed; one whose snapshots keep timing out is left alone for
 * a while.
 *
 * Results are kept in an append-only log per conversation (`record` / `changes`), so the transcript
 * mapping that merges them into the call's result reads the same thing on every import.
 */

/** A snapshot gives up after this long; the command runs unobserved rather than late. */
const SNAPSHOT_MS = 1500;
/** The first snapshot of a working tree hashes what is uncommitted; it runs in the background, with time for that. */
const WARM_MS = 60_000;
const PRUNE_MS = 30_000;
/** After this many snapshots in a row time out, the working tree is not observed for `PAUSE_MS`. */
const MAX_TIMEOUTS = 3;
const PAUSE_MS = 10 * 60_000;
/** At most this many files, and this much patch text, per command. */
const MAX_FILES = 50;
const MAX_FILE_PATCH = 64 * 1024;
const MAX_PATCH = 512 * 1024;
/** Loose snapshots are pruned after this many attempts, once no window is open. */
const PRUNE_EVERY = 200;
const MAX_WINDOWS = 256;
/** A window whose command never reported back (a denied call, a CLI that died) stops holding snapshots after this. */
const STALE_MS = 30 * 60_000;
const MAX_LOGS = 64;
const MAX_EDITS = 1024;

export type ObservedDiff = {
  type: 'diff';
  path: string;
  oldText: string;
  newText: string;
  lineOffset?: number;
  newLineOffset?: number;
  /** Seen in the working tree around a command, not reported by the tool. */
  observed: true;
};

interface Repo {
  root: string;
  dir: string;
  /** The newest snapshot's number; snapshot `n` and `n + 1` bound interval `n`. */
  seq: number;
  /** Snapshots an open window may still diff from. */
  trees: Map<number, string>;
  /** Intervals an earlier end already reported. */
  claimed: Set<number>;
  open: Map<string, Window>;
  tail: Promise<unknown>;
  ready?: Promise<boolean>;
  sincePrune: number;
  timeouts: number;
  pausedUntil: number;
  /** The shadow index was rebuilt once after a failure that was not a timeout. */
  reseeded: boolean;
}

/** `shown` is the working tree as the command's directory spells it; git reports it with links resolved. */
interface Window { key: string; repo: Repo; seq: number; shown: string; startedAt: number }

const deadline = <T>(task: Promise<T>, ms: number): Promise<T | undefined> => new Promise(resolve => {
  const timer = setTimeout(() => resolve(undefined), ms);
  timer.unref?.();
  task.then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(undefined); });
});

/** `root` written the way `cwd` reaches it, so paths start with the project directory the conversation knows. */
function spelled(cwd: string, root: string): string {
  try { return resolve(cwd, relative(realpathSync(cwd), root)); } catch { return root; }
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);

/** The environment without the caller's repository: a `GIT_DIR` inherited from a hook must not redirect a snapshot. */
function gitEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (!name.startsWith('GIT_')) env[name] = value;
  return { ...env, ...extra };
}

/** Whether a file ends in a newline, so an append after a torn last line starts a line of its own. */
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

export class WorkspaceObserver {
  private readonly repos = new Map<string, Repo>();
  private readonly roots = new Map<string, Promise<{ root: string; common: string; index: string } | undefined>>();
  private readonly windows = new Map<string, Promise<Window | undefined>>();
  private readonly logs = new Map<string, Map<string, ObservedDiff[]>>();
  /** Files edit tools reported, with when: a command's window leaves them to the tool. */
  private readonly edits = new Map<string, number>();

  constructor(private readonly dir: string) {}

  /** Snapshots the working tree `cwd` belongs to before command `key` runs. Resolves once taken or given up on. */
  async begin(key: string, cwd: string): Promise<void> {
    this.discard(key);
    this.sweep();
    // A snapshot that finishes after the command was let go opens nothing: no `end` will come for it.
    let gaveUp = false;
    const window = deadline((async (): Promise<Window | undefined> => {
      const repo = await this.repo(cwd);
      if (!repo || repo.pausedUntil > Date.now()) return undefined;
      return await this.queue(repo, async () => {
        if (gaveUp) return undefined;
        const tree = await this.snapshot(repo);
        if (!tree || gaveUp) return undefined;
        const taken: Window = { key, repo, seq: repo.seq, shown: spelled(cwd, repo.root), startedAt: Date.now() };
        repo.open.set(key, taken);
        return taken;
      });
    })(), SNAPSHOT_MS).then(taken => { if (!taken) gaveUp = true; return taken; });
    this.windows.set(key, window);
    while (this.windows.size > MAX_WINDOWS) this.discard(this.windows.keys().next().value!);
    await window;
  }

  /** What changed in the working tree since `begin(key)`; undefined when the command was not observed. */
  async end(key: string): Promise<ObservedDiff[] | undefined> {
    const pending = this.windows.get(key);
    if (!pending) return undefined;
    this.windows.delete(key);
    const window = await pending;
    if (!window || window.repo.open.get(key) !== window) return undefined;
    const { repo } = window;
    try {
      const diffs = await deadline(this.queue(repo, async () => {
        const after = await this.snapshot(repo);
        if (!after) return undefined;
        // The intervals of this window no earlier end reported, as runs of adjacent ones.
        const runs: Array<[number, number]> = [];
        for (let interval = window.seq; interval < repo.seq; interval += 1) {
          if (repo.claimed.has(interval)) continue;
          repo.claimed.add(interval);
          const run = runs.at(-1);
          if (run && run[1] === interval) run[1] = interval + 1;
          else runs.push([interval, interval + 1]);
        }
        const found: ObservedDiff[] = [];
        for (const [from, to] of runs) {
          const base = repo.trees.get(from), head = repo.trees.get(to);
          if (!base || !head || base === head) continue;
          found.push(...await this.diff(repo, base, head, window.shown) ?? []);
        }
        return found;
      }), 2 * SNAPSHOT_MS);
      return diffs?.filter(diff => (this.edits.get(diff.path) ?? 0) < window.startedAt);
    } finally {
      this.close(window);
    }
  }

  /** Forgets a window whose command never ran (its permission was denied), or is about to be taken again. */
  discard(key: string): void {
    const pending = this.windows.get(key);
    if (!pending) return;
    this.windows.delete(key);
    void pending.then(window => { if (window && window.repo.open.get(key) === window) this.close(window); });
  }

  /** An edit tool changed `path` (as the tool names it): a command's window open meanwhile leaves the file to the tool. */
  noteEdit(path: string): void {
    this.edits.delete(path);
    this.edits.set(path, Date.now());
    while (this.edits.size > MAX_EDITS) this.edits.delete(this.edits.keys().next().value!);
  }

  /** Keeps what command `key` of conversation `scope` changed. */
  record(scope: string, key: string, diffs: ObservedDiff[]): void {
    if (!diffs.length) return;
    const file = this.logFile(scope);
    try {
      mkdirSync(join(this.dir, 'changes'), { recursive: true, mode: 0o700 });
      appendFileSync(file, `${endsInNewline(file) ? '' : '\n'}${JSON.stringify({ key, diffs })}\n`, { mode: 0o600 });
    } catch { return; }
    this.log(scope).set(key, diffs);
  }

  /** What `record` kept for command `key` of conversation `scope`. */
  changes(scope: string, key: string): ObservedDiff[] | undefined {
    return this.log(scope).get(key);
  }

  /** Deletes what was kept for a conversation that is gone: it holds the contents of the files its commands changed. */
  forget(scope: string): void {
    this.logs.delete(scope);
    rmSync(this.logFile(scope), { force: true });
  }

  private logFile(scope: string): string { return join(this.dir, 'changes', `${hash(scope)}.jsonl`); }

  private log(scope: string): Map<string, ObservedDiff[]> {
    let log = this.logs.get(scope);
    if (log) { this.logs.delete(scope); this.logs.set(scope, log); return log; }
    log = new Map();
    try {
      for (const line of readFileSync(this.logFile(scope), 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const entry = JSON.parse(line) as { key?: unknown; diffs?: unknown };
          if (typeof entry.key === 'string' && Array.isArray(entry.diffs)) log.set(entry.key, entry.diffs as ObservedDiff[]);
        } catch { /* a torn line */ }
      }
    } catch { /* nothing recorded yet */ }
    this.logs.set(scope, log);
    while (this.logs.size > MAX_LOGS) this.logs.delete(this.logs.keys().next().value!);
    return log;
  }

  /** A closed window lets go of the snapshots only it needed; with none open, the shadow repository may be pruned. */
  private close(window: Window): void {
    const { repo } = window;
    if (repo.open.get(window.key) === window) repo.open.delete(window.key);
    const oldest = Math.min(repo.seq, ...[...repo.open.values()].map(open => open.seq));
    for (const seq of repo.trees.keys()) if (seq < oldest) repo.trees.delete(seq);
    for (const interval of repo.claimed) if (interval < oldest) repo.claimed.delete(interval);
    if (!repo.open.size && repo.sincePrune >= PRUNE_EVERY) void this.queue(repo, () => this.prune(repo));
  }

  /** Windows whose command never reported back stop holding snapshots. */
  private sweep(): void {
    const stale = Date.now() - STALE_MS;
    for (const repo of this.repos.values()) for (const window of [...repo.open.values()]) if (window.startedAt < stale) this.close(window);
  }

  private queue<T>(repo: Repo, task: () => Promise<T>): Promise<T> {
    const run = repo.tail.then(task, task);
    repo.tail = run.catch(() => undefined);
    return run;
  }

  private async repo(cwd: string): Promise<Repo | undefined> {
    let located = this.roots.get(cwd);
    if (!located) {
      located = exec('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--git-path', 'index'], { timeout: SNAPSHOT_MS, env: gitEnv({}) })
        .then(({ stdout }) => {
          const [root, common, index] = stdout.split('\n');
          return root && common && index ? { root, common, index } : undefined;
        }, () => undefined);
      this.roots.set(cwd, located);
      while (this.roots.size > MAX_WINDOWS) this.roots.delete(this.roots.keys().next().value!);
    }
    const found = await located;
    if (!found) { this.roots.delete(cwd); return undefined; }
    let repo = this.repos.get(found.root);
    if (!repo) {
      repo = {
        root: found.root, dir: join(this.dir, 'repos', hash(found.root)), seq: 0, trees: new Map(), claimed: new Set(), open: new Map(),
        tail: Promise.resolve(), sincePrune: 0, timeouts: 0, pausedUntil: 0, reseeded: false,
      };
      this.repos.set(found.root, repo);
    }
    const current = repo;
    current.ready ??= this.queue(current, () => this.prepare(current, found.common, found.index)).then(ok => {
      if (!ok) current.ready = undefined;
      // The first snapshot hashes what is uncommitted, which can take a while; it runs once, queued, so a command
      // that comes meanwhile goes unobserved rather than waiting for it.
      else void this.queue(current, () => this.snapshot(current, WARM_MS));
      return ok;
    });
    return await current.ready ? current : undefined;
  }

  private async prepare(repo: Repo, common: string, index: string): Promise<boolean> {
    try {
      if (!existsSync(join(repo.dir, 'HEAD'))) {
        mkdirSync(repo.dir, { recursive: true, mode: 0o700 });
        await this.git(repo, ['init', '-q']);
        await this.git(repo, ['config', 'core.autocrlf', 'false']);
        await this.git(repo, ['config', 'gc.auto', '0']);
      }
      mkdirSync(join(repo.dir, 'objects', 'info'), { recursive: true });
      writeFileSync(join(repo.dir, 'objects', 'info', 'alternates'), `${join(common, 'objects')}\n`);
      const exclude = join(common, 'info', 'exclude');
      mkdirSync(join(repo.dir, 'info'), { recursive: true });
      if (existsSync(exclude)) copyFileSync(exclude, join(repo.dir, 'info', 'exclude'));
      if (!existsSync(join(repo.dir, 'index')) && existsSync(index)) copyFileSync(index, join(repo.dir, 'index'));
      return true;
    } catch {
      return false;
    }
  }

  private git(repo: Repo, args: string[], options: { timeout?: number; maxBuffer?: number } = {}): Promise<string> {
    return exec('git', ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', ...args], {
      timeout: options.timeout ?? SNAPSHOT_MS, maxBuffer: options.maxBuffer ?? 1024 * 1024,
      env: gitEnv({ GIT_DIR: repo.dir, GIT_WORK_TREE: repo.root, GIT_INDEX_FILE: join(repo.dir, 'index') }),
    }).then(({ stdout }) => stdout);
  }

  /** The working tree as a tree object, kept as the next snapshot; undefined when it could not be taken in time. */
  private async snapshot(repo: Repo, timeout = SNAPSHOT_MS): Promise<string | undefined> {
    // Only this queue writes the shadow index; a lock is what a killed snapshot left.
    rmSync(join(repo.dir, 'index.lock'), { force: true });
    repo.sincePrune += 1;
    try {
      await this.git(repo, ['-C', repo.root, 'add', '-A', '--ignore-errors', '--', '.'], { timeout });
      const tree = (await this.git(repo, ['write-tree'], { timeout })).trim();
      if (!tree) return undefined;
      repo.seq += 1;
      repo.trees.set(repo.seq, tree);
      repo.timeouts = 0;
      return tree;
    } catch (error) {
      if (error instanceof ExecError && error.killed) {
        repo.timeouts += 1;
        if (repo.timeouts >= MAX_TIMEOUTS) { repo.pausedUntil = Date.now() + PAUSE_MS; repo.timeouts = 0; }
      } else if (!repo.reseeded) {
        // The copied index can name what the shadow cannot read (a split index, an object the project pruned since):
        // it is rebuilt once from the working tree.
        repo.reseeded = true;
        rmSync(join(repo.dir, 'index'), { force: true });
      }
      return undefined;
    }
  }

  private async diff(repo: Repo, base: string, after: string, shown: string): Promise<ObservedDiff[] | undefined> {
    try {
      const fields = (await this.git(repo, ['diff-tree', '-r', '-z', '--numstat', '--no-renames', base, after])).split('\0');
      // `added\tremoved\tpath`, `-\t-\tpath` for a binary file, which has no lines to show.
      const paths = fields.flatMap(field => {
        const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(field.replace(/^\n/, ''));
        return match && match[1] !== '-' && (match[1] !== '0' || match[2] !== '0') ? [match[3]!] : [];
      }).slice(0, MAX_FILES);
      if (!paths.length) return [];
      const patch = await this.git(repo, ['--literal-pathspecs', 'diff-tree', '-r', '-p', '-U3', '--no-renames', '--no-color', '--no-ext-diff', base, after, '--', ...paths], { maxBuffer: 16 * 1024 * 1024 });
      // A section is named by its header: a file that became a link has two, and one whose name git quotes is skipped.
      const named = new Map(paths.map(path => [`diff --git a/${path} b/${path}`, path]));
      const diffs: ObservedDiff[] = [];
      let budget = MAX_PATCH;
      for (const section of patch.split(/^(?=diff --git )/m)) {
        const path = named.get(section.slice(0, section.indexOf('\n')));
        if (!path || budget <= 0) continue;
        const text = section.length > Math.min(MAX_FILE_PATCH, budget) ? section.slice(0, section.lastIndexOf('\n', Math.min(MAX_FILE_PATCH, budget))) : section;
        budget -= text.length;
        for (const hunk of splitUnifiedDiff(text)) {
          if (!hunk.oldText && !hunk.newText) continue;
          diffs.push({ type: 'diff', path: join(shown, path), ...hunk, observed: true });
        }
      }
      return diffs;
    } catch {
      return undefined;
    }
  }

  private async prune(repo: Repo): Promise<void> {
    if (repo.open.size) return;
    try {
      await this.git(repo, ['prune', '--expire=now'], { timeout: PRUNE_MS });
      repo.trees.clear();
      repo.claimed.clear();
      repo.sincePrune = 0;
    } catch { /* tried again after the next batch */ }
  }
}

const observers = new Map<string, WorkspaceObserver>();

/** The one observer of a state directory: windows of every conversation in a working tree share its snapshots. */
export function workspaceObserver(stateDir: string): WorkspaceObserver {
  let observer = observers.get(stateDir);
  if (!observer) observers.set(stateDir, observer = new WorkspaceObserver(join(stateDir, 'workspace-observer')));
  return observer;
}
