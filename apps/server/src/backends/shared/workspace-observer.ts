import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { OUTPUT_BUDGET } from '../../../../../packages/contracts/src/budgets.js';
import type { FileChangeStatus, FileSnapshotRecord } from '../../../../../packages/contracts/src/sync.js';
import { exec, ExecError } from '../../exec.js';
import { isBinaryBuffer, sessionFileSnapshots, type SessionFileSnapshots } from './file-snapshots.js';
import { shellSegments } from './shell-words.js';
import { splitUnifiedDiff, type DiffHunk } from './unified-diff.js';

/*
 * What a shell command changed in the working tree, for a tool that reports no edits of its own.
 *
 * A driver brackets one command between `begin` and `end` (Claude's PreToolUse and PostToolUse hooks);
 * each takes a snapshot of the repository the command runs in, and `end` returns the difference as
 * the `diff` blocks an edit tool's call carries, marked `observed`. The difference is the whole
 * working tree's, so it can hold writes of other processes; a command that only reads (`readsOnly`)
 * opens no window, and files an edit tool is changing or changed meanwhile (`noteEdit`), in any
 * conversation, are left to that tool.
 *
 * Windows of one working tree overlap when commands run in parallel, in one conversation or several.
 * The snapshots, taken in order, cut time into intervals; the first window to end after an interval
 * settles it for every window open across it, file by file (`attribute`): a file goes to the only
 * window open across it, or else to the one window whose command names it, and to none when that does
 * not single one out. A file given to another window is held for that window's own end. So nothing is
 * counted twice, a short command does not take what a longer one beside it wrote, and a write no
 * command can be told apart for is reported nowhere rather than somewhere wrong.
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
const MAX_FILES = OUTPUT_BUDGET.maxObservedFiles;
const MAX_FILE_PATCH = 64 * 1024;
const MAX_PATCH = 512 * 1024;
/** Loose snapshots are pruned after this many attempts, once no window is open. */
const PRUNE_EVERY = 200;
const MAX_WINDOWS = 256;
/** A window whose command never reported back (a denied call, a CLI that died) stops holding snapshots after this. */
const STALE_MS = 30 * 60_000;
const MAX_LOGS = 64;
const MAX_EDITS = 1024;
const ZERO_OID = /^0+$/;
/** At most this many files per shell command read full blobs for exact snapshots; the rest keep exact `--numstat` stats. */
const MAX_OBSERVED_SNAPSHOT_BLOBS = 32;

export type ObservedDiff = {
  type: 'diff';
  path: string;
  oldText: string;
  newText: string;
  lineOffset?: number;
  newLineOffset?: number;
  /** File-level status from `git diff-tree --raw` (`A`/`M`/`D`), avoiding false `created` on partial hunks. */
  status?: FileChangeStatus;
  /** True for binary files (no text hunks, still reported in session outputs). */
  binary?: boolean;
  /** Exact `--numstat` counts carried when patch hunks are absent (binary or over patch budget). */
  added?: number;
  removed?: number;
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
  /** When each of those snapshots began: an edit noted after it is in the intervals that follow. */
  takenAt: Map<number, number>;
  /** Intervals an earlier end already settled. */
  settled: Set<number>;
  open: Map<string, Window>;
  tail: Promise<unknown>;
  ready?: Promise<boolean>;
  sincePrune: number;
  timeouts: number;
  pausedUntil: number;
  /** The shadow index was rebuilt once after a failure that was not a timeout. */
  reseeded: boolean;
}

/**
 * `shown` is the working tree as the command's directory spells it; git reports it with links resolved. `command` is the
 * command's text, whose relative paths start at `cwd`; without it (a driver that does not pass it) the window can still be
 * the only one open across a change, but never the one that names a file.
 */
interface Window {
  key: string; repo: Repo; seq: number; shown: string; cwd: string; command?: string; scope?: string; startedAt: number;
  /** What an earlier end of another window settled as this one's, by interval, for this window's own end. */
  held: Array<{ interval: number; diffs: ObservedDiff[]; snapshots: FileSnapshotRecord[] }>;
}

/** A changed file of one interval, as git names it under the working tree. */
type Changed = {
  path: string;
  status: FileChangeStatus;
  binary: boolean;
  added: number;
  removed: number;
  oidA: string;
  oidB: string;
  hunks: DiffHunk[];
};

/** Programs that write nothing in the working tree, given none of the arguments `readerArgsWrite` refuses. */
const READERS = new Set([
  'cat', 'head', 'tail', 'ls', 'pwd', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'cut', 'tr', 'nl', 'file', 'stat', 'du',
  'which', 'type', 'echo', 'printf', 'true', 'test', 'basename', 'dirname', 'realpath', 'readlink', 'jq', 'diff',
  'cmp', 'comm', 'cd', 'sort', 'uniq', 'sed', 'awk', 'find', 'git', 'od', 'shasum', 'md5', 'sha256sum', 'md5sum',
  // Looking at the machine rather than the files.
  'ps', 'pgrep', 'lsof', 'df', 'vm_stat', 'uptime', 'uname', 'sw_vers', 'id', 'whoami', 'groups', 'hostname', 'date',
  'printenv', 'sleep', 'top', 'sysctl', 'launchctl',
]);
const GIT_READERS = new Set([
  'diff', 'status', 'log', 'show', 'blame', 'grep', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'cat-file',
  'describe', 'shortlog', 'merge-base', 'diff-tree', 'diff-index', 'diff-files', 'for-each-ref', 'show-ref', 'check-ignore',
]);

function readerArgsWrite(program: string, args: string[]): boolean {
  const operands = args.filter(arg => !arg.startsWith('-'));
  switch (program) {
    // `w file` and `s///w file` write; a script merely containing "w " stays observed too.
    case 'sed': return args.some(arg => /^(-[a-zA-Z]*i|--in-place)/.test(arg) || /[wWe]\s/.test(arg));
    case 'awk': return args.some(arg => arg === '-i' || /system|getline|[>|]/.test(arg));
    case 'sort': return args.some(arg => /^(-[a-zA-Z]*o|--output)/.test(arg));
    case 'uniq': return operands.length > 1;
    case 'rg': return args.some(arg => arg.startsWith('--pre'));
    case 'top': return !args.some(arg => /^-[a-zA-Z]*l/.test(arg));
    case 'sysctl': return args.some(arg => arg.includes('=') || /^-[a-zA-Z]*w/.test(arg));
    case 'launchctl': return !['list', 'print', 'print-disabled', 'blame', 'version', 'help'].includes(operands[0] ?? '');
    case 'find': return args.some(arg => /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/.test(arg));
    case 'git': {
      let index = 0;
      // Options before the subcommand; the ones naming a directory or a setting take the next word.
      while (index < args.length && args[index]!.startsWith('-')) index += ['-C', '-c'].includes(args[index]!) ? 2 : 1;
      return !GIT_READERS.has(args[index] ?? '') || args.some(arg => arg.startsWith('--output'));
    }
    default: return false;
  }
}

/**
 * Whether a shell command is a pipeline of readers that cannot change the working tree. Conservative:
 * anything not recognized (a substitution, a background job, a redirection to a file, an unknown
 * program) is taken to write, so the command stays observed.
 */
export function readsOnly(command: string): boolean {
  const commands = shellSegments(command)?.map(segment => segment.words);
  if (!commands) return false;
  return commands.length > 0 && commands.every(segment => {
    const start = segment.findIndex(item => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(item));
    const words = start < 0 ? [] : segment.slice(start);
    const program = words[0]?.split('/').at(-1);
    return Boolean(program && READERS.has(program) && !readerArgsWrite(program, words.slice(1)));
  });
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `text` names `name` as a whole path: not as part of a longer word, nor, with `asDir`, of a longer path. */
function names(text: string, name: string, asDir = false): boolean {
  if (!name || name === '.' || name.startsWith('..')) return false;
  return new RegExp(`(?:^|[^\\w.\\-${asDir ? '/' : ''}])${escapeRegExp(name)}(?![\\w.\\-/])`).test(text);
}

/**
 * The window an interval's change to `path` (as git names it under the working tree) belongs to, among the windows open
 * across the interval. The only one, or the one whose command names the file: by its path (from the working tree, from
 * the command's directory, or absolute), else by its file name, else by a directory it is in. Two windows naming it
 * alike, or none, leave it to nobody.
 */
function attribute(path: string, windows: readonly Window[]): Window | undefined {
  if (windows.length === 1) return windows[0];
  const forms = (window: Window, relativePath: string) => {
    const absolute = join(window.shown, relativePath);
    return [relativePath, absolute, relative(window.cwd, absolute)];
  };
  const parents: string[] = [];
  for (let dir = dirname(path); dir !== '.' && dir !== '/' && dir !== ''; dir = dirname(dir)) parents.push(dir);
  const tiers: Array<(window: Window, command: string) => boolean> = [
    (window, command) => forms(window, path).some(form => names(command, form)),
    (_window, command) => names(command, basename(path)),
    (window, command) => parents.some(dir => forms(window, dir).some(form => names(command, form, true))),
  ];
  for (const tier of tiers) {
    const naming = windows.filter(window => window.command !== undefined && tier(window, window.command));
    if (naming.length) return naming.length === 1 ? naming[0] : undefined;
  }
  return undefined;
}

const sameWindows = (a: readonly Window[], b: readonly Window[]) => a.length === b.length && a.every((window, index) => window === b[index]);

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
  /** Per shadow-repo directory serialization queue shared by snapshot/prune and `maintain()`. */
  private readonly dirQueues = new Map<string, Promise<unknown>>();
  private readonly roots = new Map<string, Promise<{ root: string; common: string; index: string } | undefined>>();
  private readonly windows = new Map<string, Promise<Window | undefined>>();
  private readonly logs = new Map<string, Map<string, ObservedDiff[]>>();
  /** Files edit tools reported, with when: a command's window leaves them to the tool. */
  private readonly edits = new Map<string, number>();
  private snapshotStore?: SessionFileSnapshots;

  constructor(private readonly dir: string) {}

  /** Connects the per-session snapshot ledger so shell-observed changes also persist exact snapshots. */
  attachSnapshots(store: SessionFileSnapshots): void {
    this.snapshotStore = store;
  }

  /** Access to the paired single-file snapshot ledger, when attached. */
  get fileSnapshots(): SessionFileSnapshots | undefined {
    return this.snapshotStore;
  }

  /** Reads back exact snapshot records (from edit tools or shell observation) for a tool call. */
  snapshots(scope: string, key: string): FileSnapshotRecord[] | undefined {
    return this.snapshotStore?.snapshots(scope, key);
  }

  /**
   * Snapshots the working tree `cwd` belongs to before command `key` runs. Resolves once taken or given up on.
   * A `command` that only reads opens no window: what changes meanwhile is another writer's.
   */
  async begin(key: string, cwd: string, command?: string, scope?: string): Promise<void> {
    this.discard(key);
    if (command !== undefined && readsOnly(command)) return;
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
        const taken: Window = {
          key, repo, seq: repo.seq, shown: spelled(cwd, repo.root), cwd,
          ...(command !== undefined ? { command } : {}),
          ...(scope !== undefined ? { scope } : {}),
          startedAt: Date.now(), held: [],
        };
        repo.open.set(key, taken);
        return taken;
      });
    })(), SNAPSHOT_MS).then(taken => { if (!taken) gaveUp = true; return taken; });
    this.windows.set(key, window);
    while (this.windows.size > MAX_WINDOWS) this.discard(this.windows.keys().next().value!);
    await window;
  }

  /** What changed in the working tree since `begin(key)` that is this command's; undefined when the command was not observed. */
  async end(key: string, scope?: string): Promise<ObservedDiff[] | undefined> {
    const pending = this.windows.get(key);
    if (!pending) return undefined;
    this.windows.delete(key);
    const window = await pending;
    if (!window || window.repo.open.get(key) !== window) return undefined;
    if (scope && !window.scope) window.scope = scope;
    const { repo } = window;
    try {
      const found = await deadline(this.queue(repo, async () => {
        const orderedDiffs = (entries: Window['held']) => entries.sort((a, b) => a.interval - b.interval).flatMap(entry => entry.diffs);
        const orderedSnapshots = (entries: Window['held']) => entries.sort((a, b) => a.interval - b.interval).flatMap(entry => entry.snapshots);
        const after = await this.snapshot(repo);
        // What other ends settled as this command's stands; the rest is left to the windows still open across it.
        if (!after) {
          const heldSnapshots = orderedSnapshots([...window.held]);
          if (window.scope && heldSnapshots.length) this.snapshotStore?.record(window.scope, key, heldSnapshots);
          return window.held.length ? orderedDiffs([...window.held]) : undefined;
        }
        // The intervals of this window no earlier end settled, as runs of adjacent ones with the same windows open across them.
        const runs: Array<{ from: number; to: number; open: Window[] }> = [];
        for (let interval = window.seq; interval < repo.seq; interval += 1) {
          if (repo.settled.has(interval)) continue;
          repo.settled.add(interval);
          const open = [...repo.open.values()].filter(candidate => candidate.seq <= interval);
          const run = runs.at(-1);
          if (run && run.to === interval && sameWindows(run.open, open)) run.to = interval + 1;
          else runs.push({ from: interval, to: interval + 1, open });
        }
        const own = [...window.held];
        // Leave headroom before the `2 * SNAPSHOT_MS` deadline so large commands never time out fetching full blobs.
        const blobDeadline = Date.now() + SNAPSHOT_MS;
        let blobBudget = MAX_OBSERVED_SNAPSHOT_BLOBS;
        for (const { from, to, open } of runs) {
          const base = repo.trees.get(from), head = repo.trees.get(to);
          if (!base || !head || base === head) continue;
          const since = repo.takenAt.get(from) ?? window.startedAt;
          for (const item of await this.diff(repo, base, head) ?? []) {
            if ([repo.root, ...open.map(candidate => candidate.shown)].some(root => (this.edits.get(join(root, item.path)) ?? 0) >= since)) continue;
            const owner = attribute(item.path, open);
            if (!owner) continue;
            const fullPath = join(owner.shown, item.path);
            const diffs: ObservedDiff[] = item.hunks.length
              ? item.hunks.map(hunk => ({ type: 'diff' as const, path: fullPath, ...hunk, status: item.status, observed: true as const }))
              : [{
                type: 'diff' as const,
                path: fullPath,
                oldText: '',
                newText: '',
                status: item.status,
                ...(item.binary ? { binary: true } : {}),
                added: item.added,
                removed: item.removed,
                observed: true as const,
              }];
            const snapshots: FileSnapshotRecord[] = [];
            if (owner.scope && this.snapshotStore) {
              const fetchBlobs = blobBudget > 0 && Date.now() < blobDeadline;
              if (fetchBlobs && !item.binary) blobBudget -= 1;
              const snap = await this.buildObservedSnapshot(repo, owner.scope, fullPath, item, fetchBlobs);
              if (snap) snapshots.push(snap);
            }
            (owner === window ? own : owner.held).push({ interval: from, diffs, snapshots });
          }
        }
        const finalSnapshots = orderedSnapshots(own);
        if (window.scope && finalSnapshots.length) this.snapshotStore?.record(window.scope, key, finalSnapshots);
        return orderedDiffs(own);
      }), 2 * SNAPSHOT_MS);
      return found;
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
    this.snapshotStore?.forget(scope);
  }

  /**
   * Non-destructive housekeeping for `workspace-observer/`:
   * - removes orphaned `changes/<hash>.jsonl` files older than `minAgeMs` whose conversation no longer exists;
   * - removes shadow repos whose origin `.git/objects` (from `objects/info/alternates`) no longer exists on disk;
   * - prunes loose snapshot tree objects from idle shadow repos with no open command windows.
   */
  async maintain(
    liveSessionIds: ReadonlySet<string>,
    options: { minAgeMs?: number; nowMs?: number } = {},
  ): Promise<{ prunedChanges: number; prunedRepos: number; prunedShadowRepos: number }> {
    const minAgeMs = options.minAgeMs ?? 24 * 60 * 60_000;
    const cutoff = (options.nowMs ?? Date.now()) - minAgeMs;
    const result = { prunedChanges: 0, prunedRepos: 0, prunedShadowRepos: 0 };

    const liveHashes = new Set<string>();
    for (const id of liveSessionIds) liveHashes.add(`${hash(id)}.jsonl`);
    const changesDir = join(this.dir, 'changes');
    for (const name of await readdir(changesDir).catch(() => [] as string[])) {
      if (!/^[0-9a-f]{24}\.jsonl$/.test(name) || liveHashes.has(name)) continue;
      const full = join(changesDir, name);
      const info = await lstat(full).catch(() => undefined);
      if (info?.isFile() && info.mtimeMs <= cutoff) {
        await rm(full, { force: true }).catch(() => undefined);
        result.prunedChanges += 1;
      }
    }
    if (this.snapshotStore) {
      result.prunedChanges += await this.snapshotStore.maintain(liveSessionIds, options);
    }

    const reposDir = join(this.dir, 'repos');
    for (const name of await readdir(reposDir).catch(() => [] as string[])) {
      if (!/^[0-9a-f]{24}$/.test(name)) continue;
      const repoDir = join(reposDir, name);
      await this.queueDir(repoDir, async () => {
        const tracked = [...this.repos.values()].find(item => item.dir === repoDir);
        if (tracked && tracked.open.size > 0) return;
        const info = await lstat(repoDir).catch(() => undefined);
        if (!info?.isDirectory()) return;
        const altText = await readFile(join(repoDir, 'objects', 'info', 'alternates'), 'utf8').catch(() => '');
        const altTarget = altText.split('\n')[0]?.trim();
        if (altTarget && !existsSync(altTarget) && info.mtimeMs <= cutoff) {
          await rm(repoDir, { recursive: true, force: true }).catch(() => undefined);
          if (tracked) this.repos.delete(tracked.root);
          result.prunedRepos += 1;
          return;
        }
        // Prune loose unreachable tree snapshots from idle shadow repositories (under per-dir lock).
        if (tracked) {
          if (await this.prune(tracked)) result.prunedShadowRepos += 1;
        } else {
          try {
            // Use a grace window for untracked on-disk shadow repos so any fresh loose objects stay safe.
            await exec('git', ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', 'prune', '--expire=1.hour.ago'], {
              timeout: PRUNE_MS,
              env: gitEnv({ GIT_DIR: repoDir }),
            });
            result.prunedShadowRepos += 1;
          } catch { /* best-effort shadow repo prune */ }
        }
      });
    }
    return result;
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
    for (const seq of repo.trees.keys()) if (seq < oldest) { repo.trees.delete(seq); repo.takenAt.delete(seq); }
    for (const interval of repo.settled) if (interval < oldest) repo.settled.delete(interval);
    if (!repo.open.size && repo.sincePrune >= PRUNE_EVERY) void this.queue(repo, () => this.prune(repo));
  }

  /** Windows whose command never reported back stop holding snapshots. */
  private sweep(): void {
    const stale = Date.now() - STALE_MS;
    for (const repo of this.repos.values()) for (const window of [...repo.open.values()]) if (window.startedAt < stale) this.close(window);
  }

  private queueDir<T>(repoDir: string, task: () => Promise<T>): Promise<T> {
    const prev = this.dirQueues.get(repoDir) ?? Promise.resolve();
    const run = prev.then(task, task);
    const settled = run.catch(() => undefined);
    this.dirQueues.set(repoDir, settled);
    void settled.finally(() => { if (this.dirQueues.get(repoDir) === settled) this.dirQueues.delete(repoDir); });
    return run;
  }

  private queue<T>(repo: Repo, task: () => Promise<T>): Promise<T> {
    const run = this.queueDir(repo.dir, task);
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
        root: found.root, dir: join(this.dir, 'repos', hash(found.root)), seq: 0, trees: new Map(), takenAt: new Map(), settled: new Set(), open: new Map(),
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
    const startedAt = Date.now();
    try {
      await this.git(repo, ['-C', repo.root, 'add', '-A', '--ignore-errors', '--', '.'], { timeout });
      const tree = (await this.git(repo, ['write-tree'], { timeout })).trim();
      if (!tree) return undefined;
      repo.seq += 1;
      repo.trees.set(repo.seq, tree);
      repo.takenAt.set(repo.seq, startedAt);
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

  private async readGitBlob(repo: Repo, oid: string): Promise<Buffer | undefined> {
    if (!oid || ZERO_OID.test(oid)) return undefined;
    try {
      const sizeText = (await this.git(repo, ['cat-file', '-s', oid])).trim();
      const size = Number(sizeText);
      if (!Number.isFinite(size) || size > OUTPUT_BUDGET.snapshotMaxFileBytes) return undefined;
      const stdout = await this.git(repo, ['cat-file', '-p', oid], { maxBuffer: OUTPUT_BUDGET.snapshotMaxFileBytes + 64 * 1024 });
      return Buffer.from(stdout, 'utf8');
    } catch {
      return undefined;
    }
  }

  private async buildObservedSnapshot(repo: Repo, scope: string, fullPath: string, item: Changed, fetchBlobs: boolean): Promise<FileSnapshotRecord | undefined> {
    if (!this.snapshotStore) return undefined;
    let preHash: string | null | undefined = ZERO_OID.test(item.oidA) ? null : undefined;
    let postHash: string | null | undefined = ZERO_OID.test(item.oidB) ? null : undefined;
    let binary = item.binary;
    if (!binary && fetchBlobs) {
      if (preHash === undefined) {
        const beforeBuf = await this.readGitBlob(repo, item.oidA);
        if (beforeBuf) {
          if (isBinaryBuffer(beforeBuf)) binary = true;
          else preHash = this.snapshotStore.persistBlob(scope, beforeBuf, false);
        }
      }
      if (!binary && postHash === undefined) {
        const afterBuf = await this.readGitBlob(repo, item.oidB);
        if (afterBuf) {
          if (isBinaryBuffer(afterBuf)) binary = true;
          else postHash = this.snapshotStore.persistBlob(scope, afterBuf, false);
        }
      }
    }
    if (binary) {
      // Binary files keep distinct non-null sentinel hashes from git OIDs so net-zero detection still works without storing large binaries.
      preHash = ZERO_OID.test(item.oidA) ? null : `git:${item.oidA}`;
      postHash = ZERO_OID.test(item.oidB) ? null : `git:${item.oidB}`;
    }
    return {
      path: fullPath,
      ...(preHash !== undefined ? { preHash } : {}),
      ...(postHash !== undefined ? { postHash } : {}),
      status: item.status,
      ...(binary ? { binary: true } : {}),
      added: binary ? 0 : item.added,
      removed: binary ? 0 : item.removed,
      observed: true,
    };
  }

  private async diff(repo: Repo, base: string, after: string): Promise<Changed[] | undefined> {
    try {
      const [rawOut, numstatOut] = await Promise.all([
        this.git(repo, ['diff-tree', '-r', '-z', '--raw', '--no-renames', base, after]),
        this.git(repo, ['diff-tree', '-r', '-z', '--numstat', '--no-renames', base, after]),
      ]);
      // `--raw -z` pairs: `:<modeA> <modeB> <oidA> <oidB> <status>\0<path>\0`
      const rawTokens = rawOut.split('\0');
      const rawEntries = new Map<string, { status: FileChangeStatus; oidA: string; oidB: string }>();
      for (let i = 0; i + 1 < rawTokens.length; i += 2) {
        const meta = rawTokens[i]!.replace(/^\n/, '');
        const path = rawTokens[i + 1]!;
        if (!meta.startsWith(':') || !path) continue;
        const parts = meta.slice(1).split(/\s+/);
        if (parts.length < 5) continue;
        const oidA = parts[2]!;
        const oidB = parts[3]!;
        const code = parts[4]![0];
        const status: FileChangeStatus = code === 'A' ? 'created' : code === 'D' ? 'deleted' : 'modified';
        rawEntries.set(path, { status, oidA, oidB });
      }
      // `--numstat -z` entries: `<added>\t<removed>\t<path>\0` (`-\t-\t<path>` for binary).
      const stats = new Map<string, { added: number; removed: number; binary: boolean }>();
      for (const field of numstatOut.split('\0')) {
        const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(field.replace(/^\n/, ''));
        if (!match) continue;
        const binary = match[1] === '-' || match[2] === '-';
        const added = binary ? 0 : Number(match[1]);
        const removed = binary ? 0 : Number(match[2]);
        stats.set(match[3]!, { added, removed, binary });
      }
      const selected: Array<{ path: string; status: FileChangeStatus; oidA: string; oidB: string; added: number; removed: number; binary: boolean }> = [];
      for (const [path, raw] of rawEntries) {
        if (selected.length >= MAX_FILES) break;
        const stat = stats.get(path) ?? { added: 0, removed: 0, binary: false };
        // Skip mode-only no-op changes for modified text files with 0 line delta.
        if (raw.status === 'modified' && !stat.binary && stat.added === 0 && stat.removed === 0 && raw.oidA === raw.oidB) continue;
        selected.push({ path, ...raw, ...stat });
      }
      if (!selected.length) return [];

      const textPaths = selected.filter(item => !item.binary).map(item => item.path);
      const hunksByPath = new Map<string, DiffHunk[]>();
      if (textPaths.length) {
        const patch = await this.git(repo, ['--literal-pathspecs', 'diff-tree', '-r', '-p', '-U3', '--no-renames', '--no-color', '--no-ext-diff', base, after, '--', ...textPaths], { maxBuffer: 16 * 1024 * 1024 });
        const named = new Map(textPaths.map(path => [`diff --git a/${path} b/${path}`, path]));
        let budget = MAX_PATCH;
        for (const section of patch.split(/^(?=diff --git )/m)) {
          const headerLine = section.slice(0, section.indexOf('\n'));
          const path = named.get(headerLine);
          if (!path || budget <= 0) continue;
          const text = section.length > Math.min(MAX_FILE_PATCH, budget) ? section.slice(0, section.lastIndexOf('\n', Math.min(MAX_FILE_PATCH, budget))) : section;
          budget -= text.length;
          const hunks = splitUnifiedDiff(text).filter(hunk => hunk.oldText || hunk.newText);
          if (hunks.length) hunksByPath.set(path, hunks);
        }
      }

      return selected.map(item => ({
        path: item.path,
        status: item.status,
        binary: item.binary,
        added: item.added,
        removed: item.removed,
        oidA: item.oidA,
        oidB: item.oidB,
        hunks: hunksByPath.get(item.path) ?? [],
      }));
    } catch {
      return undefined;
    }
  }

  private async prune(repo: Repo): Promise<boolean> {
    if (repo.open.size) return false;
    try {
      await this.git(repo, ['prune', '--expire=now'], { timeout: PRUNE_MS });
      repo.trees.clear();
      repo.takenAt.clear();
      repo.settled.clear();
      repo.sincePrune = 0;
      return true;
    } catch { return false; }
  }
}

const observers = new Map<string, WorkspaceObserver>();

/** The one observer of a state directory: windows of every conversation in a working tree share its snapshots. */
export function workspaceObserver(stateDir: string): WorkspaceObserver {
  let observer = observers.get(stateDir);
  if (!observer) {
    observer = new WorkspaceObserver(join(stateDir, 'workspace-observer'));
    observer.attachSnapshots(sessionFileSnapshots(stateDir));
    observers.set(stateDir, observer);
  }
  return observer;
}
