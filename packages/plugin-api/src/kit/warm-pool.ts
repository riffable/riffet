// One unused Agent resource started ahead of a new session's first message (`AgentBackend.prewarm`):
// a CLI in a reserved terminal, a thread on an app-server, whatever the Agent's start costs. The pool
// owns when it starts, how long it is kept and when it ends; the Agent says only how to start one,
// how to end one, and how a session takes one over. docs/PLUGIN_ARCHITECTURE.md「预热」.
import { randomUUID } from 'node:crypto';
import type { AgentPrewarmResult, AgentReservation, AgentReservationRequest, AgentTerminals } from '../agent.js';
import { PREWARM_BUDGET } from '@riffet/contracts';

/** A start that ended for a reason worth reporting and backing off from (`skipped` with it until the backoff ends). */
export class WarmupRefused extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'WarmupRefused'; }
}

export interface WarmStart {
  /** Aborts when the resource is no longer wanted (released, replaced, timed out, the pool closed). */
  signal: AbortSignal;
  /** When the host should end the resource on its own if nothing renews it (a reservation's `expiresAt`). */
  deadline: number;
  /**
   * Another key a session may match the resource by: the configuration as the Agent resolved it
   * (a normalized model id), beside the one the page asked with.
   */
  alias(key: string): void;
  /**
   * The resource ended on its own (its process exited) after the start resolved. The pool lets it go and
   * holds back the same configuration as after a failed start; a session would only find it dead.
   */
  lost(): void;
}

/**
 * Starts the resource and resolves once it can take a first message. It must end whatever it created
 * when it throws, or when `signal` aborts before it resolves; the pool ends it from then on.
 */
export type WarmStarter<T> = (start: WarmStart) => Promise<T>;

export interface WarmPoolOptions<T> {
  /** Ends a resource no session took. */
  stop(resource: T): Promise<void>;
  /** Moves the host's own deadline for it, when the host keeps one (a terminal reservation). */
  extend?(resource: T, until: number): Promise<void>;
  leaseMs?: number;
  readyTimeoutMs?: number;
  failureBackoffMs?: number;
  /** How long a session waits for one still starting before it starts its own. */
  takeWaitMs?: number;
  now?(): number;
  /**
   * Names the Agent in the line logged when a session finds one held under another key. A page changing
   * its choice just before sending explains a few; a steady stream means the two sides compute the key
   * differently and the pool never helps.
   */
  label?: string;
}

export interface WarmRequest {
  /** The configuration a session must match to take the resource: the Agent's own identity of a launch. */
  key: string;
  /** A renewal by the page holding this claim: it never takes the slot from another page. */
  claimId?: string;
  /** Renew only, start nothing: the host holds back new starts. */
  renewOnly?: boolean;
}

export interface WarmPoolStats {
  /** Sessions that took a warm resource, and those that found none to take. */
  hits: number;
  misses: number;
  /** Sessions that found none for their key while one was held for another: see `WarmPoolOptions.label`. */
  mismatched: number;
  /** Resources that became ready, starts that failed, requests answered `skipped`, and ones that ended unused. */
  ready: number;
  failed: number;
  skipped: number;
  wasted: number;
  /** Time from a start to ready. */
  readyMs: { count: number; totalMs: number; maxMs: number };
}

interface Entry<T> {
  claimId: string;
  keys: Set<string>;
  state: 'preparing' | 'ready';
  leaseUntil: number;
  resource?: T;
  abort: AbortController;
  task: Promise<T | undefined>;
  timer?: NodeJS.Timeout;
  ended: boolean;
  /** Settles once whatever it held is gone. */
  gone?: Promise<void>;
}

const reasonOf = (error: unknown): string => error instanceof WarmupRefused ? error.reason
  : typeof (error as { code?: unknown })?.code === 'string' ? String((error as { code: string }).code).toLowerCase()
    : 'warmup-failed';

/**
 * At most one unused resource, held for the page that asked for it.
 *
 * - A request for the configuration already held renews it; one for another configuration replaces it,
 *   unless it is a renewal by another page (`held_elsewhere`).
 * - Unrenewed past its lease, it ends. A page renews it while it stays open and releases it when it
 *   closes or changes its choice.
 * - A session takes it by key. One still starting is waited for: it began before the session, so it is
 *   ready sooner than a start now would be. One for another configuration is left to its page.
 * - A start that fails, or is not ready in time, is not tried again for that key until the backoff ends.
 */
export class WarmPool<T> {
  private slot?: Entry<T>;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly backoff = new Map<string, { until: number; reason: string }>();
  private readonly counters: WarmPoolStats = { hits: 0, misses: 0, mismatched: 0, ready: 0, failed: 0, skipped: 0, wasted: 0, readyMs: { count: 0, totalMs: 0, maxMs: 0 } };
  private readonly leaseMs: number;
  private readonly readyTimeoutMs: number;
  private readonly failureBackoffMs: number;
  private readonly takeWaitMs: number;
  private readonly now: () => number;

  constructor(private readonly options: WarmPoolOptions<T>) {
    this.leaseMs = options.leaseMs ?? PREWARM_BUDGET.leaseMs;
    this.readyTimeoutMs = options.readyTimeoutMs ?? PREWARM_BUDGET.readyTimeoutMs;
    this.failureBackoffMs = options.failureBackoffMs ?? PREWARM_BUDGET.failureBackoffMs;
    this.takeWaitMs = options.takeWaitMs ?? PREWARM_BUDGET.takeWaitMs;
    this.now = options.now ?? Date.now;
  }

  request(request: WarmRequest, start: WarmStarter<T>): Promise<AgentPrewarmResult> {
    return this.locked(async () => {
      if (this.closed) return this.skip('closed');
      const held = this.slot;
      if (held?.keys.has(request.key)) {
        held.leaseUntil = this.now() + this.leaseMs;
        this.arm(held);
        if (held.state === 'preparing') return { state: 'preparing', claimId: held.claimId };
        await this.extend(held);
        // A host that refused the extension has ended it; a new one starts below.
        if (!held.ended) return { state: 'ready', claimId: held.claimId, expiresAt: held.leaseUntil };
      }
      // The host holds back new starts (a workspace being restored, memory pressure); one held is kept.
      if (request.renewOnly) return this.skip('renew_only');
      if (request.claimId && held && held.claimId !== request.claimId) return this.skip('held_elsewhere');
      const failure = this.backoff.get(request.key);
      if (failure && failure.until > this.now()) return this.skip(failure.reason);
      this.backoff.delete(request.key);
      // Not waited for: the old one ends beside the new one's start.
      if (held) void this.end(held, true);
      const entry: Entry<T> = { claimId: randomUUID(), keys: new Set([request.key]), state: 'preparing', leaseUntil: this.now() + this.leaseMs, abort: new AbortController(), task: Promise.resolve(undefined), ended: false };
      this.slot = entry;
      this.arm(entry);
      entry.task = this.run(entry, start);
      return { state: 'preparing', claimId: entry.claimId };
    });
  }

  /** The page holding `claimId` closed or chose something else; one a session took is not affected. */
  async release(claimId: string): Promise<void> {
    // Waited for outside the lock: a start that is ending takes the lock to report itself.
    const ending = await this.locked(async () => ({ gone: this.slot?.claimId === claimId ? this.end(this.slot, true) : undefined }));
    await ending.gone;
  }

  /**
   * Hands the resource held for any of `keys` to a session: `adopt` binds it (claims the terminal,
   * records the thread). A failed adoption ends it. Undefined when there is none to take, and the
   * session starts its own.
   */
  async take<R>(keys: string | readonly string[], adopt: (resource: T) => Promise<R>): Promise<R | undefined> {
    const wanted = typeof keys === 'string' ? [keys] : keys;
    const matches = (entry: Entry<T> | undefined): entry is Entry<T> => Boolean(entry && wanted.some(key => entry.keys.has(key)));
    const starting = this.slot;
    if (matches(starting) && starting.state === 'preparing') {
      // Not past `takeWaitMs`: a start stuck short of its readiness timeout must not hold the first message that long.
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([starting.task, new Promise<void>(resolve => { timer = setTimeout(resolve, this.takeWaitMs); timer.unref?.(); })]);
      clearTimeout(timer);
    }
    const resource = await this.locked(async () => {
      const entry = this.slot;
      if (!matches(entry) || entry.state !== 'ready' || entry.resource === undefined) {
        this.counters.misses += 1;
        if (entry && !wanted.some(key => entry.keys.has(key))) {
          this.counters.mismatched += 1;
          console.info(`[riffet] ${this.options.label ?? 'agent'} prewarm: a new session did not match the warm one`, { held: [...entry.keys], wanted });
        }
        return undefined;
      }
      this.slot = undefined;
      entry.ended = true;
      clearTimeout(entry.timer);
      return entry.resource;
    });
    if (resource === undefined) return undefined;
    try {
      const adopted = await adopt(resource);
      this.counters.hits += 1;
      return adopted;
    } catch {
      this.counters.misses += 1;
      await this.options.stop(resource).catch(() => undefined);
      return undefined;
    }
  }

  /** Whether a resource is held or starting for `key`; a session may then wait for it rather than start its own. */
  holds(key: string): boolean { return Boolean(this.slot?.keys.has(key)); }

  stats(): WarmPoolStats { return { ...this.counters, readyMs: { ...this.counters.readyMs } }; }

  async close(): Promise<void> {
    const ending = await this.locked(async () => {
      this.closed = true;
      return { gone: this.slot ? this.end(this.slot, true) : undefined };
    });
    await ending.gone;
  }

  private async run(entry: Entry<T>, start: WarmStarter<T>): Promise<T | undefined> {
    const started = this.now();
    const timeout = setTimeout(() => entry.abort.abort(new WarmupRefused('readiness-timeout')), this.readyTimeoutMs);
    timeout.unref?.();
    let resource: T;
    try {
      resource = await start({
        signal: entry.abort.signal, deadline: started + this.readyTimeoutMs + this.leaseMs,
        alias: key => { if (!entry.ended) entry.keys.add(key); },
        lost: () => { void this.locked(async () => { if (!entry.ended && entry.resource !== undefined) this.fail(entry, 'warm-exited'); }); },
      });
    } catch (error) {
      clearTimeout(timeout);
      const timedOut = entry.abort.signal.reason instanceof WarmupRefused;
      // Released or replaced while it started is not a failure, and must not hold back the next request.
      if (!entry.ended || timedOut) await this.locked(async () => this.fail(entry, timedOut ? 'readiness-timeout' : reasonOf(error)));
      return undefined;
    }
    clearTimeout(timeout);
    return await this.locked(async () => {
      if (entry.ended) {
        // It was let go while it started; the starter had already made it, so it ends here.
        this.counters.wasted += 1;
        await this.options.stop(resource).catch(() => undefined);
        return undefined;
      }
      entry.resource = resource;
      entry.state = 'ready';
      const elapsed = Math.max(0, this.now() - started);
      this.counters.ready += 1;
      this.counters.readyMs.count += 1;
      this.counters.readyMs.totalMs += elapsed;
      this.counters.readyMs.maxMs = Math.max(this.counters.readyMs.maxMs, elapsed);
      // The lease may have run out while it started; the timer then ends it now.
      this.arm(entry);
      if (!entry.ended) await this.extend(entry);
      return entry.ended ? undefined : resource;
    });
  }

  /** The lease's end, re-armed on each renewal. Under the lock. */
  private arm(entry: Entry<T>): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      void this.locked(async () => {
        if (entry.ended) return;
        if (entry.leaseUntil <= this.now()) void this.end(entry, true);
        else this.arm(entry);
      });
    }, Math.max(0, entry.leaseUntil - this.now()));
    entry.timer.unref?.();
  }

  private async extend(entry: Entry<T>): Promise<void> {
    if (entry.resource === undefined || !this.options.extend) return;
    // A host that refuses has already ended it.
    await this.options.extend(entry.resource, entry.leaseUntil).catch(() => { void this.end(entry, false); });
  }

  /**
   * Ends the entry: a starting one through its signal (the starter ends what it made), a ready one
   * here. Under the lock; the returned promise, which settles once it is gone, must be awaited outside it.
   */
  private end(entry: Entry<T>, unused: boolean): Promise<void> {
    if (entry.ended) return entry.gone ?? Promise.resolve();
    entry.ended = true;
    clearTimeout(entry.timer);
    if (this.slot === entry) this.slot = undefined;
    entry.abort.abort();
    if (entry.resource !== undefined) {
      if (unused) this.counters.wasted += 1;
      entry.gone = this.options.stop(entry.resource).catch(() => undefined);
    } else {
      entry.gone = entry.task.then(() => undefined, () => undefined);
    }
    return entry.gone;
  }

  private fail(entry: Entry<T>, reason: string): void {
    this.counters.failed += 1;
    const until = this.now() + this.failureBackoffMs;
    for (const key of entry.keys) this.backoff.set(key, { until, reason });
    void this.end(entry, false);
  }

  private skip(reason: string): AgentPrewarmResult {
    this.counters.skipped += 1;
    return { state: 'skipped', reason };
  }

  private locked<R>(task: () => Promise<R>): Promise<R> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/**
 * Waits until `judge` finds the pane ready. The screen is read once at the start and then only after
 * the pane printed something, at most every `PREWARM_BUDGET.screenReadMs`: a CLI that is starting
 * prints in bursts, and each read is a `capture-pane`. `blocked` (a login, a dialog) and an exit
 * refuse with that reason.
 */
export function untilTerminalReady(terminals: Pick<AgentTerminals, 'observe' | 'screen'>, terminalId: string, judge: (screen: string) => 'ready' | { blocked: string } | undefined, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false, reading = false, again = false, last = 0;
    let timer: NodeJS.Timeout | undefined;
    let stopObserving: () => void = () => undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopObserving();
      signal.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve();
    };
    const aborted = () => finish(signal.reason ?? new WarmupRefused('released'));
    const read = async () => {
      if (settled) return;
      if (reading) { again = true; return; }
      reading = true;
      last = Date.now();
      try {
        const screen = await terminals.screen(terminalId).catch(() => undefined);
        const verdict = screen === undefined ? undefined : judge(screen);
        if (verdict === 'ready') finish();
        else if (verdict) finish(new WarmupRefused(verdict.blocked));
      } finally {
        reading = false;
        if (again && !settled) { again = false; schedule(); }
      }
    };
    const schedule = () => {
      if (settled || timer) return;
      timer = setTimeout(() => { timer = undefined; void read(); }, Math.max(0, last + PREWARM_BUDGET.screenReadMs - Date.now()));
      timer.unref?.();
    };
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    stopObserving = terminals.observe(terminalId, observation => {
      if (observation.type === 'exit') finish(new WarmupRefused('cli-exited'));
      else if (observation.type === 'output') schedule();
    });
    void read();
  });
}

/**
 * A CLI started in a reserved terminal and waited for (`untilTerminalReady`); the reservation is
 * released when it is not ready, so the starter leaves nothing behind. For `WarmPool` with
 * {@link terminalWarmOptions}.
 */
export async function reserveWarmTerminal(terminals: Pick<AgentTerminals, 'reserve' | 'observe' | 'screen' | 'releaseReservation'>, request: Omit<AgentReservationRequest, 'expiresAt'>, start: WarmStart, judge: (screen: string) => 'ready' | { blocked: string } | undefined): Promise<AgentReservation> {
  if (start.signal.aborted) throw start.signal.reason ?? new WarmupRefused('released');
  const reservation = await terminals.reserve({ ...request, expiresAt: start.deadline });
  try {
    await untilTerminalReady(terminals, reservation.terminal.id, judge, start.signal);
    // A CLI that exits while it waits is let go at once rather than found dead by the session. Once a session
    // took it, the report is ignored; the observation ends with the process.
    const stop = terminals.observe(reservation.terminal.id, observation => { if (observation.type === 'exit') { stop(); start.lost(); } });
    return reservation;
  } catch (error) {
    await terminals.releaseReservation(reservation.terminal.id, reservation.ownerToken).catch(() => false);
    throw error;
  }
}

/** How a pool of reserved terminals ends and extends them. */
export function terminalWarmOptions(terminals: Pick<AgentTerminals, 'extendReservation' | 'releaseReservation'>): Pick<WarmPoolOptions<AgentReservation>, 'stop' | 'extend'> {
  return {
    stop: async reservation => { await terminals.releaseReservation(reservation.terminal.id, reservation.ownerToken); },
    extend: async (reservation, until) => {
      await terminals.extendReservation(reservation.terminal.id, { ownerToken: reservation.ownerToken, resourceKey: reservation.resourceKey, expiresAt: until });
    },
  };
}
