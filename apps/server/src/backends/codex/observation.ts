import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { CodexAppServerClient } from '../shared/codex-app-server.js';
import { NativeHookServer } from '../shared/hook-server.js';
import { workspaceObserver, type WorkspaceObserver } from '../shared/workspace-observer.js';
import { asArray, asRecord, str } from './util.js';

/*
 * What a shell command changed in the working tree, for Codex.
 *
 * Codex has no edit report for a command, and `item/started` is only a notification: nothing can run
 * before the command starts. Its hooks can: PreToolUse blocks the command until the hook returns, so
 * the app-server is started with a PreToolUse and a PostToolUse hook for `Bash` that report to this
 * process (`shared/hook-cli.mjs`, the transport Claude's hooks use). The snapshots themselves are
 * `WorkspaceObserver`'s.
 *
 * Verified on codex-cli 0.167.2, and checked on every recording and drift run (`recording.ts#hookProblems`):
 * - The hook payload's `tool_use_id` is the `commandExecution` item's `id`, and it carries `cwd` and
 *   the thread as `session_id`.
 * - PostToolUse runs after `item/completed` has been sent, and the model waits for it. So a completion
 *   is held back (`NotificationGate`) until the PostToolUse hook has recorded, or a short deadline.
 * - Hooks given with `-c` are untrusted until confirmed, an untrusted hook does not run, and the TUI
 *   asks about it each time it starts. `probe` says which it is; `trust` writes the confirmation
 *   through the CLI's own `config/batchWrite`, which is what its `/hooks` review does, and every
 *   conversation's server is confirmed before its TUI attaches. The confirmation is keyed by the
 *   hook's position and content, so the command below must not change from launch to launch: the hook
 *   scripts are copied to a fixed place and find this process through the descriptor file.
 */

const execFileAsync = promisify(execFile);
const DESCRIPTOR_NAME = 'codex-hook.json';
const SCRIPT_DIR = 'codex-hook';
const HEARTBEAT_MS = 5_000;
/** Codex's own limit on a hook, in seconds; `hook-cli.mjs` gives up a little earlier and lets the command through. */
const HOOK_TIMEOUT_S = 30;
const HOOK_CLI_TIMEOUT_MS = 25_000;
/** How long a finished command's completion waits for its PostToolUse record: the observer's own limit for an end, and the hook's start. */
const SETTLE_MS = 4_500;
const MATCHER = '^Bash$';

/** Whether observation is working: `unsupported` (this CLI has no hooks), `inactive` (not in the running server), `untrusted` (awaiting confirmation), or `active`. */
export type CodexObservationState = 'unsupported' | 'inactive' | 'untrusted' | 'active';

interface Window { threadId: string; settled: boolean; done: Promise<void>; settle(): void }
interface Route { sessionId: string; threadId(): string | undefined }

const supports = new Map<string, Promise<boolean>>();
/** A CLI that has hook trust (and so `hooks/list` and `hooks.state`) says so in its help. */
function supportsHooks(executable: string): Promise<boolean> {
  let known = supports.get(executable);
  if (!known) {
    known = execFileAsync(executable, ['--help'], { timeout: 5_000, maxBuffer: 512 * 1024, encoding: 'utf8' })
      .then(({ stdout, stderr }) => `${stdout}${stderr}`.includes('--dangerously-bypass-hook-trust'), () => false);
    supports.set(executable, known);
    void known.then(ok => { if (!ok) setTimeout(() => supports.delete(executable), 60_000).unref?.(); });
  }
  return known;
}

const tomlString = (value: string): string => JSON.stringify(value);

export class CodexObservation {
  private readonly observer: WorkspaceObserver;
  private readonly descriptorPath: string;
  private readonly scriptDir: string;
  private readonly routes = new Set<Route>();
  private readonly windows = new Map<string, Window>();
  private server?: NativeHookServer;
  private starting?: Promise<string | undefined>;
  private heartbeat?: NodeJS.Timeout;
  private writing: Promise<void> = Promise.resolve();
  private bootId = randomUUID();

  constructor(private readonly stateDir: string) {
    this.observer = workspaceObserver(stateDir);
    this.descriptorPath = join(stateDir, DESCRIPTOR_NAME);
    this.scriptDir = join(stateDir, SCRIPT_DIR);
  }

  /** Gives a conversation's commands to this observation; the returned function takes them back. */
  attach(sessionId: string, threadId: () => string | undefined): () => void {
    const route = { sessionId, threadId };
    this.routes.add(route);
    return () => { this.routes.delete(route); };
  }

  /** The `-c` arguments that register the hooks, or none when this CLI cannot run them. */
  async launchArgs(executable: string): Promise<string[]> {
    if (!await supportsHooks(executable)) return [];
    const command = await this.ensure().catch(() => undefined);
    if (!command) return [];
    const hook = `[{matcher=${tomlString(MATCHER)},hooks=[{type="command",command=${tomlString(command)},timeout=${HOOK_TIMEOUT_S}}]}]`;
    return ['-c', `hooks.PreToolUse=${hook}`, '-c', `hooks.PostToolUse=${hook}`];
  }

  /** Reads back whether the connected server runs the hooks, which is what the user's confirmation decides. */
  async probe(transport: CodexAppServerClient, cwd: string): Promise<CodexObservationState> {
    try {
      const mine = await this.listed(transport, cwd);
      return !mine.length ? 'inactive' : mine.every(hook => hook.trustStatus === 'trusted') ? 'active' : 'untrusted';
    } catch { return 'unsupported'; }
  }

  /**
   * Confirms these hooks the way the CLI's own review does, on a server started with them. Each
   * conversation's server does this before its TUI attaches, so the TUI never asks: the confirmation
   * in `config.toml` is not relied on to survive, since it has been seen to go missing from that file.
   */
  async trust(transport: CodexAppServerClient, cwd: string): Promise<CodexObservationState> {
    const pending = (await this.listed(transport, cwd)).filter(hook => hook.trustStatus !== 'trusted');
    if (pending.length) {
      await transport.request('config/batchWrite', {
        edits: pending.map(hook => ({ keyPath: 'hooks.state', value: { [hook.key]: { trusted_hash: hook.currentHash } }, mergeStrategy: 'upsert' })),
      });
    }
    return await this.probe(transport, cwd);
  }

  private async listed(transport: CodexAppServerClient, cwd: string): Promise<Array<{ key: string; currentHash: string; trustStatus: string }>> {
    const answer = asRecord(await transport.request('hooks/list', { cwds: [cwd] }, 10_000));
    const entry = asArray<Record<string, unknown>>(answer?.data)[0];
    const marker = join(this.scriptDir, 'hook-cli.mjs');
    return asArray<Record<string, unknown>>(entry?.hooks)
      .filter(hook => hook.source === 'sessionFlags' && str(hook.command)?.includes(marker))
      .flatMap(hook => {
        const key = str(hook.key); const currentHash = str(hook.currentHash);
        return key && currentHash ? [{ key, currentHash, trustStatus: String(hook.trustStatus) }] : [];
      });
  }

  /** What a command changed, as its transcript row carries it; read back from the conversation's log, so a re-import repeats it. */
  changes(sessionId: string, toolCallId: string): readonly Record<string, unknown>[] | undefined {
    return this.observer.changes(sessionId, toolCallId);
  }

  /** Exact before/after snapshots recorded for a command or fileChange tool call. */
  snapshots(sessionId: string, toolCallId: string): readonly import('../../../../../packages/contracts/src/sync.js').FileSnapshotRecord[] | undefined {
    return this.observer.snapshots(sessionId, toolCallId);
  }

  /** Takes what a notification says about edits, and whether it must wait for its PostToolUse record, and until when. */
  hold(method: string, params: Record<string, unknown>): Promise<void> | undefined {
    const item = asRecord(params.item);
    // A patch's files are its own to report: noted as it starts and ends, so a command running beside it,
    // in this conversation or another, leaves them alone.
    if (item?.type === 'fileChange' && (method === 'item/started' || method === 'item/completed')) {
      for (const change of asArray<Record<string, unknown>>(item.changes)) {
        const path = str(change.path);
        if (path) this.observer.noteEdit(path);
      }
    }
    if (method !== 'item/completed') return undefined;
    const id = item?.type === 'commandExecution' ? str(item.id) : undefined;
    const window = id ? this.windows.get(id) : undefined;
    if (!window || window.settled) return undefined;
    return Promise.race([window.done, new Promise<void>(resolveTimer => setTimeout(resolveTimer, SETTLE_MS).unref?.())]);
  }

  /** A turn that ended, or a conversation that went away, leaves no command open. */
  release(threadId: string | undefined): void {
    if (!threadId) return;
    for (const [id, window] of this.windows) {
      if (window.threadId !== threadId) continue;
      this.observer.discard(id);
      window.settle();
    }
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    await this.writing;
    const stored = await readFile(this.descriptorPath, 'utf8').then(text => JSON.parse(text) as { bootId?: string }).catch(() => undefined);
    if (stored?.bootId === this.bootId) await rm(this.descriptorPath, { force: true }).catch(() => undefined);
    const server = this.server;
    this.server = undefined;
    this.starting = undefined;
    await server?.close();
  }

  private ensure(): Promise<string | undefined> {
    this.starting ??= this.open().catch(error => { this.starting = undefined; throw error; });
    return this.starting;
  }

  /** Copies the hook scripts to a fixed place, starts the endpoint, publishes it, and returns the hook command. */
  private async open(): Promise<string> {
    await mkdir(this.scriptDir, { recursive: true, mode: 0o700 });
    const here = dirname(fileURLToPath(import.meta.url));
    // The bundle ships the scripts next to itself; a source checkout has them in `shared/`.
    const source = existsSync(resolve(here, 'hook-cli.mjs')) && existsSync(resolve(here, 'hook-target.mjs')) ? here : resolve(here, '../shared');
    for (const name of ['hook-cli.mjs', 'hook-target.mjs']) {
      const from = resolve(source, name);
      const to = join(this.scriptDir, name);
      const [next, previous] = await Promise.all([readFile(from, 'utf8'), readFile(to, 'utf8').catch(() => undefined)]);
      if (next !== previous) await writeFile(to, next, { mode: 0o600 });
    }
    this.server ??= new NativeHookServer((payload) => this.onHook(payload));
    const { url, token } = await this.server.start();
    this.bootId = randomUUID();
    const startedAt = new Date().toISOString();
    const publish = (): Promise<void> => {
      const write = this.writing.then(async () => {
        const temporary = `${this.descriptorPath}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, `${JSON.stringify({ version: 1, url, token, pid: process.pid, bootId: this.bootId, startedAt, heartbeatAt: Date.now() })}\n`, { mode: 0o600 });
          await chmod(temporary, 0o600);
          await rename(temporary, this.descriptorPath);
        } catch (error) {
          await rm(temporary, { force: true }).catch(() => undefined);
          throw error;
        }
      });
      this.writing = write.catch(() => undefined);
      return write;
    };
    await publish();
    this.heartbeat = setInterval(() => { void publish().catch(() => undefined); }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
    const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
    // Everything in this string is part of the hook's identity: a change asks the user to confirm again.
    return `${quote(process.execPath)} ${quote(join(this.scriptDir, 'hook-cli.mjs'))} ${HOOK_CLI_TIMEOUT_MS} --descriptor ${quote(this.descriptorPath)}`;
  }

  private async onHook(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = str(payload.tool_use_id);
    const threadId = str(payload.session_id);
    const event = str(payload.hook_event_name);
    if (!id || !threadId || payload.tool_name !== 'Bash') return {};
    const route = [...this.routes].find(candidate => candidate.threadId() === threadId);
    // The server hosts every thread, including ones this process does not manage.
    if (!route) return {};
    if (event === 'PreToolUse') {
      let settle!: () => void;
      const done = new Promise<void>(resolveWindow => { settle = resolveWindow; });
      const window: Window = { threadId, settled: false, done, settle: () => { if (window.settled) return; window.settled = true; this.windows.delete(id); settle(); } };
      this.windows.set(id, window);
      await this.observer.begin(id, str(payload.cwd) ?? '/', str(asRecord(payload.tool_input)?.command), route.sessionId);
    } else if (event === 'PostToolUse') {
      const window = this.windows.get(id);
      try {
        const diffs = await this.observer.end(id, route.sessionId);
        if (diffs?.length) this.observer.record(route.sessionId, id, diffs);
      } finally { window?.settle(); }
    }
    return {};
  }
}

const observations = new Map<string, CodexObservation>();
/** The observation of a state directory; one process-wide, as `workspaceObserver` is. */
export function codexObservation(stateDir: string): CodexObservation {
  let observation = observations.get(stateDir);
  if (!observation) observations.set(stateDir, observation = new CodexObservation(stateDir));
  return observation;
}

/**
 * Delivers notifications in order, holding the ones that must wait. Once one waits, every later one
 * waits behind it: the transcript must not see the next item before the command it follows.
 */
export class NotificationGate {
  private tail: Promise<void> | undefined;
  private queued = 0;

  push(hold: Promise<void> | undefined, deliver: () => void): void {
    if (!this.tail && !hold) { deliver(); return; }
    this.queued += 1;
    const next = (this.tail ?? Promise.resolve()).then(() => hold).then(deliver, deliver).catch(error => console.error('[riffet] codex: a held notification failed', error)).finally(() => {
      this.queued -= 1;
      if (this.queued === 0) this.tail = undefined;
    });
    this.tail = next;
  }
}
