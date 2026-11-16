import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { NativeHookServer } from '../shared/hook-server.js';

/** Name of the descriptor in the state directory; `shared/hook-target.mjs` reads the same file. */
export const CLAUDE_HOOK_DESCRIPTOR = 'claude-hook.json';
const HEARTBEAT_MS = 5_000;

export type ClaudeHookRoute = (payload: Record<string, unknown>, deliveryId: string, signal: AbortSignal) => Promise<Record<string, unknown> | void>;
/**
 * Brings up the runtime of a conversation this server manages but has no runtime for yet, so a hook from its
 * CLI can be routed. Resolves true when the conversation is ours (and its route is being registered).
 */
export type ClaudeHookWake = (nativeSessionId: string) => Promise<boolean>;

/** Hooks that change what the conversation is doing: dropping one leaves a turn, a question or a permission unseen. */
const STATEFUL_HOOKS = new Set([
  'UserPromptSubmit', 'Stop', 'StopFailure', 'PermissionRequest', 'PermissionDenied', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SessionStart', 'SessionEnd', 'PreCompact',
]);
/** How long a hook waits for its conversation to be brought up before it is let through unanswered. */
const WAKE_WAIT_MS = 5_000;
/** How long a session this server does not manage is remembered as not ours. */
const FOREIGN_MS = 15_000;

export interface ClaudeHookDescriptor {
  version: 1;
  url: string;
  token: string;
  pid: number;
  bootInstanceId: string;
  startedAt: string;
  /** Epoch milliseconds, refreshed while the server lives; a CLI treats an old one as abandoned. */
  heartbeatAt: number;
}

/**
 * The one loopback endpoint every Claude CLI of this server talks to.
 *
 * Hooks are routed by Claude's `session_id` to the runtime registered for it, so a CLI is addressed by
 * the conversation it runs rather than by a port that dies with the process that launched it. The
 * address is published in a private descriptor file that `hook-cli.mjs` reads on every hook: a CLI
 * that outlives a restart finds the new server without being told. One token covers the endpoint
 * (the file is `0600`, the same trust the old per-launch environment variable had); a request is
 * still only served when its `session_id` belongs to a runtime this server manages.
 */
export class ClaudeHookBridge {
  readonly bootInstanceId = randomUUID();
  readonly descriptorPath?: string;
  private readonly routes = new Map<string, ClaudeHookRoute>();
  /** The Claude session each Riffet conversation's runtime is registered under, for hooks of a session it has not taken up yet. */
  private readonly owners = new Map<string, string>();
  private readonly server = new NativeHookServer((payload, deliveryId, signal) => this.dispatch(payload, deliveryId, signal));
  private starting?: Promise<{ url: string; token: string }>;
  private heartbeat?: NodeJS.Timeout;
  private descriptor?: ClaudeHookDescriptor;
  private writing: Promise<void> = Promise.resolve();
  private closed = false;
  private wake?: ClaudeHookWake;
  /** Status line frames that arrived for a conversation being woken: the newest one, delivered once it is up. */
  private readonly pendingStatus = new Map<string, { payload: Record<string, unknown>; deliveryId: string; signal: AbortSignal }>();
  private readonly waking = new Map<string, Promise<boolean>>();
  private readonly foreign = new Map<string, number>();

  constructor(options: { stateDir?: string } = {}) {
    if (options.stateDir) this.descriptorPath = join(options.stateDir, CLAUDE_HOOK_DESCRIPTOR);
  }

  /** Where to ask for the runtime of a conversation a hook names that has none. */
  setWake(wake: ClaudeHookWake): void { this.wake = wake; }

  start(): Promise<{ url: string; token: string }> {
    this.starting ??= this.open().catch(error => { this.starting = undefined; throw error; });
    return this.starting;
  }

  private async open(): Promise<{ url: string; token: string }> {
    // A bridge that was closed and is started again is a new bridge: it publishes, and nothing is held back by the old close.
    this.closed = false;
    const { url, token } = await this.server.start();
    this.descriptor = { version: 1, url, token, pid: process.pid, bootInstanceId: this.bootInstanceId, startedAt: new Date().toISOString(), heartbeatAt: Date.now() };
    await this.publish();
    if (this.descriptorPath) {
      this.heartbeat = setInterval(() => { void this.publish().catch(error => this.publishFailed(error)); }, HEARTBEAT_MS);
      this.heartbeat.unref?.();
    }
    return { url, token };
  }

  private lastPublishWarning = 0;
  /** A descriptor that cannot be written leaves every surviving CLI without a server to report to: said, but not every five seconds. */
  private publishFailed(error: unknown): void {
    if (Date.now() - this.lastPublishWarning < 60_000) return;
    this.lastPublishWarning = Date.now();
    console.warn('[riffet] claude: the hook descriptor could not be written; CLIs that outlive this server will not find it', { path: this.descriptorPath, error: error instanceof Error ? error.message : String(error) });
  }

  /** Atomic: a CLI reading mid-write sees either the previous complete file or the next one. */
  private publish(): Promise<void> {
    const path = this.descriptorPath;
    const descriptor = this.descriptor;
    if (!path || !descriptor) return Promise.resolve();
    const write = this.writing.then(async () => {
      if (this.closed) return;
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify({ ...descriptor, heartbeatAt: Date.now() })}\n`, { mode: 0o600 });
        await chmod(temporary, 0o600);
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.writing = write.catch(() => undefined);
    return write;
  }

  /** Routes one conversation to its runtime. A newer registration for the id replaces the older. */
  register(sessionId: string, route: ClaudeHookRoute, owner?: string): () => void {
    this.routes.set(sessionId, route);
    if (owner) this.owners.set(owner, sessionId);
    return () => {
      if (this.routes.get(sessionId) === route) this.routes.delete(sessionId);
      if (owner && this.owners.get(owner) === sessionId) this.owners.delete(owner);
    };
  }

  private async dispatch(payload: Record<string, unknown>, deliveryId: string, signal: AbortSignal): Promise<Record<string, unknown> | void> {
    const sessionId = payload.session_id;
    if (typeof sessionId !== 'string') return {};
    let route = this.routes.get(sessionId);
    // A session the CLI moved to (`/clear`) goes to the runtime of the conversation that launched it, which takes it up.
    if (!route && typeof payload.riffet_owner === 'string') {
      const registered = this.owners.get(payload.riffet_owner);
      route = registered ? this.routes.get(registered) : undefined;
    }
    // A CLI that outlived a restart posts hooks before anything has opened its conversation here: bring the
    // conversation up (if it is ours) rather than let the report fall on the floor.
    if (!route && this.wake && STATEFUL_HOOKS.has(String(payload.hook_event_name ?? '')) && await this.wakeRoute(sessionId)) route = this.routes.get(sessionId);
    // A status line frame (no event name) is the only report of the context window, and an idle CLI
    // draws its bar rarely: bring the conversation up and hand the frame over once it is there, without
    // holding the bar's process open for it.
    if (payload.hook_event_name === undefined) {
      if (!route && this.wake) {
        // Only the newest frame matters: one wake per conversation, delivering whatever came last.
        const waking = this.pendingStatus.has(sessionId);
        this.pendingStatus.set(sessionId, { payload, deliveryId, signal });
        if (!waking) {
          void this.wakeRoute(sessionId).then(woken => {
            const latest = this.pendingStatus.get(sessionId);
            this.pendingStatus.delete(sessionId);
            return woken && latest ? this.routes.get(sessionId)?.(latest.payload, latest.deliveryId, latest.signal) : undefined;
          }).catch(() => undefined);
        }
        return {};
      }
      // A frame that reaches the route itself is newer than one still waiting for the wake.
      this.pendingStatus.delete(sessionId);
    }
    return route ? await route(payload, deliveryId, signal) : {};
  }

  /** Asks for the conversation's runtime and waits (briefly) until its route exists. */
  private async wakeRoute(sessionId: string): Promise<boolean> {
    const rejected = this.foreign.get(sessionId);
    if (rejected !== undefined && Date.now() - rejected < FOREIGN_MS) return false;
    let asking = this.waking.get(sessionId);
    if (!asking) {
      asking = (async () => {
        const deadline = Date.now() + WAKE_WAIT_MS;
        let ours = false;
        try { ours = await Promise.race([this.wake!(sessionId), new Promise<boolean>(resolve => setTimeout(() => resolve(false), WAKE_WAIT_MS).unref?.())]); }
        catch { ours = false; }
        if (!ours) { this.foreign.set(sessionId, Date.now()); if (this.foreign.size > 256) this.foreign.delete(this.foreign.keys().next().value!); return false; }
        while (!this.routes.has(sessionId) && Date.now() < deadline && !this.closed) await new Promise(resolve => setTimeout(resolve, 40));
        return this.routes.has(sessionId);
      })().finally(() => { this.waking.delete(sessionId); });
      this.waking.set(sessionId, asking);
    }
    return await asking;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.routes.clear();
    this.owners.clear();
    await this.writing;
    // Only the owner removes the file: a successor that already replaced it keeps its own.
    const path = this.descriptorPath;
    if (path) {
      const stored = await readFile(path, 'utf8').then(text => JSON.parse(text) as Partial<ClaudeHookDescriptor>).catch(() => undefined);
      if (stored?.bootInstanceId === this.bootInstanceId) await rm(path, { force: true }).catch(() => undefined);
    }
    this.starting = undefined;
    await this.server.close();
  }
}
