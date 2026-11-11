import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Session } from '../../../../packages/contracts/src/index.js';
import { AppError, sessionInTerminal } from '../errors.js';
import type { Store } from '../store.js';
import type { SessionLockHandle } from '../agent-host/session-lock.js';
import type { NativeBackendService } from '../backends/service.js';
import type { NativePtyLaunchSpec } from '../backends/types.js';
import { processAlive, processStarts, sameStart } from '../backends/shared/process-identity.js';

/** How often held conversations are checked for a terminal CLI that is gone. */
const SWEEP_MS = 5_000;
/** `riffet resume` reports its CLI's pid right after spawning it; a hold that never got one was abandoned. */
const UNCLAIMED_MS = 2 * 60_000;
/** How long a forced take-back waits for the terminal CLI to exit after SIGTERM. */
const FORCE_WAIT_MS = 5_000;
const RESTING = new Set<Session['state']>(['idle', 'interrupted', 'failed']);
/** What only the server and the `riffet resume` that asked for the hold know; kept beside the session, not on it. */
const SECRET_PREFIX = 'terminal-hold:';

interface HoldSecret { token: string; startedAt?: string }

export interface TerminalHoldDeps {
  store: Store;
  nativeBackends: NativeBackendService;
  runtime: SessionLockHandle;
  log(message: string, fields: Record<string, unknown>): void;
}

/**
 * Conversations handed to a terminal (`riffet resume`, docs/TERMINAL-SESSIONS.md). While one is held,
 * that terminal's CLI is its only writer: sends are refused (`SessionCommands.admit`), launches too
 * (`NativeBackendService.ensure`), the reclaimer leaves it alone, and the timeline follows what the
 * terminal writes. The hold ends when the terminal CLI exits or the conversation is taken back.
 *
 * The CLI is known by its pid and the time it started, so a later process reusing the number neither
 * keeps the hold nor receives a forced take-back's SIGTERM. Until `riffet resume` reports the pid, the
 * hold counts as starting: nobody else can take it or hand it out again.
 */
export class TerminalHolds {
  private readonly follows = new Map<string, () => void>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: TerminalHoldDeps) {}

  /** Picks up holds that outlived a restart of the service. */
  start(): void {
    for (const session of this.held()) this.follow(session);
    this.schedule();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const stop of this.follows.values()) stop();
    this.follows.clear();
  }

  async hold(sessionId: string): Promise<{ session: Session; launch: NativePtyLaunchSpec; token: string }> {
    return this.deps.runtime.withSession(sessionId, async () => {
      const session = this.deps.store.getSession(sessionId);
      if (session.kind !== 'native') throw new AppError('NOT_NATIVE', 'Only agent conversations continue in a terminal', 409);
      if (session.archivedAt) throw new AppError('ARCHIVED_SESSION', 'Restore this conversation first', 409);
      if (session.terminalHold && await this.occupied(session)) throw new AppError('SESSION_IN_TERMINAL', 'This conversation is already open in a terminal', 409);
      if (!RESTING.has(session.state) || this.deps.store.listUnfinishedNativeRuns(sessionId).length) {
        throw new AppError('SESSION_BUSY', 'Wait for the current turn to finish', 409);
      }
      const launch = await this.deps.nativeBackends.releaseToTerminal(session);
      const token = randomBytes(24).toString('base64url');
      const updated = this.deps.store.transaction(() => {
        this.deps.store.setSetting(SECRET_PREFIX + sessionId, { token } satisfies HoldSecret);
        return this.deps.store.updateSession(sessionId, { terminalHold: { since: new Date().toISOString() } });
      });
      this.follow(updated);
      this.schedule();
      return { session: updated, launch, token };
    });
  }

  /**
   * The reader copied the command to resume the conversation in a terminal of their own: stops this
   * conversation's CLI here, so theirs is the only writer. Refused while a turn runs, which stopping would cut off.
   */
  async releaseCli(sessionId: string): Promise<Session> {
    return this.deps.runtime.withSession(sessionId, async () => {
      const session = this.deps.store.getSession(sessionId);
      if (session.kind !== 'native') throw new AppError('NOT_NATIVE', 'Only agent conversations continue in a terminal', 409);
      // A held Codex conversation's terminal is joined to the app-server stopping would end.
      if (session.terminalHold) throw sessionInTerminal();
      if (!RESTING.has(session.state) || this.deps.store.listUnfinishedNativeRuns(sessionId).length) {
        throw new AppError('SESSION_BUSY', 'Wait for the current turn to finish', 409);
      }
      await this.deps.nativeBackends.stopOwnCli(session);
      return this.deps.store.getSession(sessionId);
    });
  }

  /** `riffet resume` names the CLI it started, so the hold ends when that process does. */
  async claim(sessionId: string, input: { pid?: unknown; token?: unknown }): Promise<Session> {
    const { pid, token } = input;
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) throw new AppError('INVALID_PID', 'pid must be a positive integer');
    return this.deps.runtime.withSession(sessionId, async () => {
      const session = this.deps.store.getSession(sessionId);
      const secret = this.secret(sessionId);
      if (!session.terminalHold || !secret) throw new AppError('NO_TERMINAL_HOLD', 'This conversation is not open in a terminal', 409);
      if (typeof token !== 'string' || !sameToken(token, secret.token)) throw new AppError('TERMINAL_HOLD_MISMATCH', 'This hold was handed to another terminal', 409);
      if (session.terminalHold.pid) throw new AppError('TERMINAL_HOLD_MISMATCH', 'This hold already names its CLI', 409);
      const starts = await processStarts([pid]);
      if (!starts) throw new AppError('PROCESS_CHECK_FAILED', 'Could not check the terminal CLI; try again', 503);
      const startedAt = starts.get(pid);
      if (!startedAt || !processAlive(pid)) throw new AppError('INVALID_PID', 'No such process', 409);
      return this.deps.store.transaction(() => {
        this.deps.store.setSetting(SECRET_PREFIX + sessionId, { ...secret, startedAt } satisfies HoldSecret);
        return this.deps.store.updateSession(sessionId, { terminalHold: { ...session.terminalHold!, pid } });
      });
    });
  }

  /**
   * Ends the hold. A terminal CLI still running, or one `riffet resume` is still starting, ends it only
   * with `force`: otherwise there would be a second writer. `force` stops that exact process.
   */
  async release(sessionId: string, options: { force?: boolean } = {}): Promise<Session> {
    return this.deps.runtime.withSession(sessionId, async () => {
      const session = this.deps.store.getSession(sessionId);
      const hold = session.terminalHold;
      if (!hold) return session;
      if (await this.occupied(session)) {
        if (!options.force) throw new AppError('TERMINAL_STILL_RUNNING', 'The CLI in the terminal is still running', 409, hold.pid ? { pid: hold.pid } : undefined);
        if (hold.pid) {
          try { process.kill(hold.pid, 'SIGTERM'); } catch { /* exited meanwhile */ }
          const deadline = Date.now() + FORCE_WAIT_MS;
          while (await this.running(sessionId, hold.pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
          if (await this.running(sessionId, hold.pid)) throw new AppError('TERMINAL_STILL_RUNNING', 'The CLI in the terminal did not exit', 409, { pid: hold.pid });
        }
      }
      return this.clear(sessionId);
    });
  }

  /** The hold's CLI runs, or `riffet resume` is still starting it. */
  private async occupied(session: Session, now = Date.now()): Promise<boolean> {
    const hold = session.terminalHold;
    if (!hold) return false;
    if (!hold.pid) return now - (Date.parse(hold.since) || now) <= UNCLAIMED_MS && Boolean(this.secret(session.id));
    return this.running(session.id, hold.pid);
  }

  /** `pid` is still the process the hold was claimed with. */
  private async running(sessionId: string, pid: number): Promise<boolean> {
    if (!processAlive(pid)) return false;
    const startedAt = this.secret(sessionId)?.startedAt;
    const starts = await processStarts([pid]);
    // Unknown counts as running: ending the hold under a CLI that still writes would make two writers.
    if (!starts) return true;
    return sameStart(starts.get(pid), startedAt);
  }

  private secret(sessionId: string): HoldSecret | undefined {
    return this.deps.store.getSetting<HoldSecret | undefined>(SECRET_PREFIX + sessionId, undefined);
  }

  private clear(sessionId: string): Session {
    this.unfollow(sessionId);
    return this.deps.store.transaction(() => {
      this.deps.store.deleteSetting(SECRET_PREFIX + sessionId);
      return this.deps.store.updateSession(sessionId, { terminalHold: undefined });
    });
  }

  private unfollow(sessionId: string): void {
    this.follows.get(sessionId)?.();
    this.follows.delete(sessionId);
    if (!this.follows.size) { clearInterval(this.timer); this.timer = undefined; }
  }

  private held(): Session[] {
    return this.deps.store.listSessions().filter(session => session.terminalHold);
  }

  private follow(session: Session): void {
    if (this.follows.has(session.id)) return;
    try { this.follows.set(session.id, this.deps.nativeBackends.followExternal(session)); }
    catch (error) { this.deps.log('following a terminal-held conversation failed', { sessionId: session.id, error: error instanceof Error ? error.message : String(error) }); this.follows.set(session.id, () => undefined); }
  }

  private schedule(): void {
    if (this.timer || !this.follows.size) return;
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.timer.unref();
  }

  /** Releases holds whose terminal CLI exited without `riffet resume` saying so (a closed window, a killed shell). */
  async sweep(now = Date.now()): Promise<void> {
    const held = this.held();
    // A conversation deleted while held never reaches `clear`.
    for (const sessionId of [...this.follows.keys()]) if (!held.some(session => session.id === sessionId)) this.unfollow(sessionId);
    for (const session of held) {
      if (await this.occupied(session, now)) continue;
      const hold = session.terminalHold!;
      await this.deps.runtime.withDetachedSession(session.id, async () => {
        const current = this.deps.store.getSession(session.id);
        if (current.terminalHold?.since === hold.since && current.terminalHold.pid === hold.pid && !await this.occupied(current)) this.clear(session.id);
      }).catch(error => this.deps.log('releasing a terminal hold failed', { sessionId: session.id, error: error instanceof Error ? error.message : String(error) }));
    }
  }
}

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
