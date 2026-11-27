import { resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import type { NativeQueue, NativeRunRecovery, NativeStatus, NativeStopRequest, NativeWorkbenchEvent, Run, Session } from '../../../../packages/contracts/src/index.js';
import type { Store } from '../store.js';
import type { WorkspaceService } from '../workspace/index.js';
import type { NativeBackendTraits, NativeDispatchBinding } from '../backends/types.js';
import { AppError } from '../errors.js';
import { backendIdOf } from '../session-identity.js';
import { admission, queueOf } from './lane.js';
import { runNeedsDispatchWatch, SessionActor, type SessionActorHost, type SessionDispatchOptions } from './session-actor.js';

const now = () => Date.now();
/** How long a drain holds deliveries without being renewed; whoever waits for a restart renews it as it polls. */
const DRAIN_LEASE_MS = 30_000;
/** The holder of a drain request that names none (callers that predate holders). */
const LEGACY_DRAIN_HOLDER = 'legacy';
const workspacePath = (cwd: string) => { try { return realpathSync(cwd); } catch { return resolve(cwd); } };
const overlappingPaths = (left: string, right: string) => left === right || left.startsWith(right.endsWith(sep) ? right : `${right}${sep}`) || right.startsWith(left.endsWith(sep) ? left : `${left}${sep}`);

/** `baselineSequence`: only an event after it can be the prompt's echo. */
type DeliverFence = (info: { terminalId: string; epoch: number; chatId?: string; baselineSequence?: number }) => void;

/**
 * What the dispatcher hears of a conversation (`backends/dispatch-feed.ts`): events that settle its runs —
 * prompts echoed with their command id, input receipts, turn outcomes — and the provider's status.
 */
export type DispatchObservation = { type: 'events'; events: NativeWorkbenchEvent[] } | { type: 'status'; status: NativeStatus };

/** The newest events of a conversation and its status, read without waiting for anything to change. */
export interface DispatchSnapshot { events: NativeWorkbenchEvent[]; status: NativeStatus; nativeSessionId?: string }

export interface NativeDispatcherBackend {
  /** What the dispatcher needs to know about a backend's turns; see `NativeBackendTraits`. */
  traits?(backendId: string): NativeBackendTraits;
  /** The backend has no driver yet but its plugin is on its way (a start-up that is not over): its queued runs wait instead of failing as unavailable. */
  pending?(backendId: string): boolean;
  subscribe(sessionId: string, listener: (message: DispatchObservation) => void): () => void;
  /** Passive journal corrections, including ends corrected after the ordinary observer closed. */
  subscribeCorrections?(listener: (sessionId: string, message: DispatchObservation) => void): () => void;
  snapshot(sessionId: string): Promise<DispatchSnapshot>;
  reconcile?(sessionId: string): Promise<void>;
  canReleaseAfterLaterTurn?(session: Session, run: Run): Promise<boolean>;
  canReleaseInput?(session: Session, run: Run): Promise<boolean>;
  status(sessionId: string): NativeStatus;
  /** Whether a driver is bound to the session; without it every session counts as possibly live. */
  hasRuntime?(sessionId: string): boolean;
  /** `settled`: the backend carried the message out itself and no native turn follows. */
  sendRun?(session: Session, run: Run, commitDispatchFence: (binding?: NativeDispatchBinding) => Run, options?: { now?: boolean; expectedStop?: NativeStopRequest }): Promise<void | { settled: true }>;
  supportsSteer?(session: Session): Promise<boolean>;
  steerRun?(session: Session, run: Run, commitDispatchFence: (binding?: NativeDispatchBinding) => Run): Promise<void | { deferred: true }>;
  /** True when this session's backend can take the first user message as a launch argument. */
  supportsInitialPromptArgs?(session: Session): Promise<boolean>;
  /** True when this session's backend can atomically stop a specified execution; defaults to true when omitted. */
  supportsTargetedStop?(session: Session): Promise<boolean>;
  /** True when this session's backend replaces its running turn with a message in one step of its own. */
  supportsSendNow?(session: Session): Promise<boolean>;
  commitDispatchFence?(runId: string, binding?: NativeDispatchBinding): Run;
  deliver?(session: Session, text: string, beforeWrite: DeliverFence): Promise<void>;
  /** `deliver`, replacing the running turn; see `supportsSendNow`. */
  deliverNow?(session: Session, text: string, beforeWrite: DeliverFence): Promise<void>;
  /** Release an in-flight send's receipt wait before Stop needs the same session lock. */
  requestInterrupt?(sessionId: string): void;
  interrupt(session: string | Session, options?: { clearPrompt?: boolean; expectedStop?: NativeStopRequest }): Promise<void>;
  /** Journal `meta.turn_ended` for a turn a confirmed stop just closed, without waiting for the CLI's own hook. */
  endTurn?(sessionId: string, turnId: string, status: 'interrupted', at: string): Promise<void>;
}

interface NativeDispatcherRuntime {
  withSession<T>(sessionId: string, operation: () => Promise<T>, options?: { detached?: boolean }): Promise<T>;
  /** With `initialPrompt`, must call `beforeSpawn` right before spawning and abort the spawn if it throws. */
  ensure(session: Session, options?: { initialPrompt?: string; beforeSpawn?: () => void | Promise<void> }): Promise<unknown>;
}

/** What keeps a restart waiting: a write still being confirmed, a turn or a background task that a restart would end. */
export interface RestartBlocker { sessionId: string; title: string; backendId: string; reason: 'delivery' | 'turn' | 'background' }
export interface RestartAssessment { restartable: boolean; draining: boolean; blockers: RestartBlocker[] }

/**
 * Routes work to one `SessionActor` per conversation. Cross-session concerns — workspace reservations,
 * prewarm holds, drain leases, restartability — stay here. A conversation with nothing left to do is
 * dropped, observer and timer included.
 *
 * `beforeTurn` is started once a turn is claimed, with the time it was claimed at (`since`), and
 * nothing waits for it: the turn's checkpoint is taken while the message goes out, and tells apart by
 * that time what the turn may already have changed. It is best effort: a rejection never fails the turn.
 */
export class NativeDispatcher {
  private readonly actors = new Map<string, SessionActor>();
  /** Destructive file operations exclude native work in the directory and its nested projects. */
  private readonly workspaceReservations = new Map<symbol, string[]>();
  /** Workspaces a warm CLI is being set up in, by how many calls (`holdWorkspaceForPrewarm`). */
  private readonly prewarmHolds = new Map<string, number>();
  private readonly offCorrections?: () => void;
  private closed = false;
  /** A full-library discovery is already walking sessions; a nested one would admit the same run twice. */
  private scanning = false;
  /** Per holder, until when a restart being prepared holds queued runs back; see `drain`. */
  private readonly drainLeases = new Map<string, number>();
  private readonly host: SessionActorHost;

  constructor(private readonly store: Store, private readonly native: NativeDispatcherBackend, private readonly runtime: NativeDispatcherRuntime, private readonly workspace: WorkspaceService, private readonly options: SessionDispatchOptions = {}) {
    const dispatcher = this;
    this.host = {
      store, native, runtime, workspace, options,
      get closed() { return dispatcher.closed; },
      draining: () => dispatcher.draining,
      workspaceReserved: session => dispatcher.workspaceReserved(session),
      workspaceBusy: () => dispatcher.workspaceBusy(),
      onIdle: (sessionId, actor) => dispatcher.evict(sessionId, actor),
      current: sessionId => dispatcher.actors.get(sessionId),
    };
    // Journal corrections keep arriving after a conversation's own observer has been released.
    this.offCorrections = native.subscribeCorrections?.((sessionId, message) => {
      if (this.closed) return;
      this.actor(sessionId).observe(sessionId, message);
    });
    // Recovered work is dispatched once routes are registered, not on a standing poll.
    queueMicrotask(() => { if (!this.closed) this.kick(); });
  }

  /**
   * Wake one conversation, or every conversation that still has work. With no id, unfinished runs are
   * read once so a newly persisted message gains an actor; each actor then schedules only its own deadline.
   */
  kick(sessionId?: string): void {
    if (this.closed) return;
    if (sessionId !== undefined) {
      const existing = this.actors.get(sessionId);
      if (existing) existing.kick();
      else if (this.store.listUnfinishedNativeRuns(sessionId).some(runNeedsDispatchWatch)) this.actor(sessionId).kick();
      return;
    }
    if (this.scanning) return;
    this.scanning = true;
    try {
      const sessions = new Set(this.store.listUnfinishedNativeRuns().filter(runNeedsDispatchWatch).map(run => run.sessionId));
      for (const id of sessions) this.actor(id).step();
      for (const id of [...this.actors.keys()]) if (!sessions.has(id)) this.actors.get(id)?.step();
    } finally { this.scanning = false; }
  }

  /** Drops and stops any in-memory actor for a deleted conversation so no watch or timer outlives it. */
  async forget(sessionId: string): Promise<void> {
    const actor = this.actors.get(sessionId);
    if (!actor) return;
    this.actors.delete(sessionId);
    await actor.shutdown();
  }

  /**
   * Holds back every new delivery while a restart waits for the running turns (`restartability`). New
   * messages are still accepted and persisted as queued. In memory only, and a lease: a restart ends it, and
   * so does `DRAIN_LEASE_MS` without renewal, so a waiting script that dies does not hold messages back.
   * Each caller holds its own lease (`holder`): turning one off leaves the others' drains in place.
   */
  drain(on: boolean, holder = LEGACY_DRAIN_HOLDER): void {
    if (on) this.drainLeases.set(holder, now() + DRAIN_LEASE_MS); else this.drainLeases.delete(holder);
    if (!on) this.kick();
  }

  private get draining(): boolean {
    const at = now();
    let held = false;
    for (const [holder, until] of this.drainLeases) {
      if (until > at) held = true; else this.drainLeases.delete(holder);
    }
    return held;
  }

  /**
   * Whether the service can restart now without ending work (docs/DELIVERY.md, 重启). A write being prepared or
   * confirmed always blocks: a restart would leave it uncertain. Claude, Cursor, Codex and Traex keep their CLI
   * (tmux or a detached app-server) through a restart (`survivesRestart`) and their observed turns are picked up
   * again afterwards, so nothing else of theirs blocks. A turn, a pending prompt or a background task of any
   * other backend (Droid, Pi, DSH, chat: child processes or in-process) ends with the service, so it blocks.
   */
  restartability(): RestartAssessment {
    const blockers: RestartBlocker[] = [];
    const runsBySession = new Map<string, Run[]>();
    for (const run of this.store.listUnfinishedNativeRuns()) {
      const list = runsBySession.get(run.sessionId);
      if (list) list.push(run); else runsBySession.set(run.sessionId, [run]);
    }
    // Only a session with an unfinished run, an active state or a live runtime can block; the rest is skipped before any status read.
    const candidates = this.store.listSessions().filter(session =>
      runsBySession.has(session.id) || ['starting', 'running', 'waiting', 'cancelling'].includes(session.state) || (this.native.hasRuntime?.(session.id) ?? true));
    for (const session of candidates) {
      const backendId = backendIdOf(session);
      const runs = runsBySession.get(session.id) ?? [];
      const blocker = (reason: RestartBlocker['reason']) => blockers.push({ sessionId: session.id, title: session.displayTitle ?? session.title, backendId, reason });
      // An in-flight write blocks whether or not the session was archived meanwhile.
      if (runs.some(run => ['preparing', 'dispatching', 'input_sent'].includes(run.native?.delivery ?? ''))) { blocker('delivery'); continue; }
      if (session.archivedAt) continue;
      if (this.traits(backendId).survivesRestart) continue;
      if (runs.some(run => run.native?.delivery === 'observed' && run.state === 'running')
        || ['starting', 'running', 'waiting', 'cancelling'].includes(session.state)) { blocker('turn'); continue; }
      try {
        const activity = this.native.status(session.id).activity;
        if (activity?.background || activity?.compacting) blocker('background');
      } catch { /* no live runtime: nothing in flight */ }
    }
    return { restartable: blockers.length === 0, draining: this.draining, blockers };
  }

  /** Whether anything of the conversation is in flight here: a delivery, start, stop, recovery or unfinished run. */
  busy(sessionId: string): boolean {
    const actor = this.actors.get(sessionId);
    return actor?.worker !== undefined || (actor?.startReservations ?? 0) > 0 || actor?.interrupting === true
      || actor?.recoveryActive === true || this.store.listUnfinishedNativeRuns(sessionId).some(run => !run.native?.queueReleasedAt);
  }

  /** The queued run a worker of the conversation has taken up and not moved on from `queued` yet. */
  taken(sessionId: string): string | undefined {
    return this.actors.get(sessionId)?.taken();
  }

  /** Where the conversation's queue stands, for clients (`NativeStatus.queue`), read against the status it goes out with. */
  queue(sessionId: string, status: NativeStatus): NativeQueue {
    const actor = this.actors.get(sessionId);
    if (actor) return actor.queue(status);
    const session = this.store.getSession(sessionId);
    return queueOf(admission({
      runs: this.store.listUnfinishedNativeRuns(sessionId), status,
      sending: false, stopping: false, recovering: false,
      workspaceReserved: this.workspaceReserved(session),
      waitsWhileStarting: Boolean(this.traits(session.backendId).acceptsInputWhileBusy),
      pendingRelaunch: Boolean(session.configPending && this.traits(session.backendId).relaunchesForPendingConfig),
      steerTurnSettled: run => this.store.isSteerTargetTurnEnded(run),
      retryAt: () => 0, now: now(),
    }));
  }

  /**
   * Fences a conversation against a second concurrent open of itself.
   *
   * Explicit restore/merge reservations also fence startup. Sharing a working tree used to be disqualifying, on the grounds
   * that two agents editing one checkout can overwrite each other — but that is a judgement for
   * whoever opened the two conversations, and enforcing it meant a conversation stuck while
   * starting, or merely waiting on an approval, silently locked every sibling in the directory
   * and in its parents. Binding two conversations to one CLI chat, the case that genuinely
   * corrupts a transcript, is already impossible: `Store.assertNativeIdentityAvailable` refuses
   * the second binding outright.
   */
  reserveSessionStart(sessionId: string, options: { shared?: boolean } = {}): () => void {
    if (this.closed) throw new AppError('DISPATCH_STOPPED', 'The service is shutting down', 503);
    const session = this.store.getSession(sessionId);
    if (this.store.getProject(session.projectId).archivedAt) throw new AppError('ARCHIVED_PROJECT', 'Restore this project before running a conversation', 409);
    if (this.workspaceReserved(session)) throw this.workspaceBusy();
    const actor = this.actor(sessionId);
    if (actor.startReservations > 0 && !options.shared) {
      throw new AppError('NATIVE_SESSION_BUSY', 'This conversation is starting; try again shortly', 409, { sessionId });
    }
    actor.startReservations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      actor.startReservations = Math.max(0, actor.startReservations - 1);
      this.settleActor(sessionId, actor);
    };
  }

  private workspaceBusy(): AppError {
    return new AppError('PROJECT_BUSY', 'Finish active conversation turns or project file operations before changing this workspace', 409);
  }

  private workspaceReserved(session: Session): boolean {
    if (!this.workspaceReservations.size) return false;
    const cwd = workspacePath(this.store.getProject(session.projectId).cwd);
    return [...this.workspaceReservations.values()].some(paths => paths.some(path => overlappingPaths(path, cwd)));
  }

  /**
   * Holds the project's workspace while a warm CLI is set up in it: a restore/merge is refused meanwhile,
   * conversations are not (a warm CLI changes no file). Throws `PROJECT_BUSY` while a restore/merge holds it.
   */
  holdWorkspaceForPrewarm(projectId: string): () => void {
    if (this.closed) throw new AppError('DISPATCH_STOPPED', 'The service is shutting down', 503);
    const path = workspacePath(this.store.getProject(projectId).cwd);
    if ([...this.workspaceReservations.values()].some(paths => paths.some(held => overlappingPaths(held, path)))) throw this.workspaceBusy();
    this.prewarmHolds.set(path, (this.prewarmHolds.get(path) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.prewarmHolds.get(path) ?? 1) - 1;
      if (remaining) this.prewarmHolds.set(path, remaining);
      else this.prewarmHolds.delete(path);
    };
  }

  /** Atomically excludes native dispatch and startup until a restore/merge finishes its writes. */
  reserveWorkspace(projectIds: string[]): () => void {
    if (this.closed) throw new AppError('DISPATCH_STOPPED', 'The service is shutting down', 503);
    const paths = projectIds.map(id => workspacePath(this.store.getProject(id).cwd));
    if ([...this.workspaceReservations.values()].some(existing => existing.some(path => paths.some(candidate => overlappingPaths(path, candidate))))) throw this.workspaceBusy();
    if ([...this.prewarmHolds.keys()].some(held => paths.some(candidate => overlappingPaths(held, candidate)))) throw this.workspaceBusy();
    for (const session of this.store.listSessions()) {
      const cwd = workspacePath(this.store.getProject(session.projectId).cwd);
      if (!paths.some(path => overlappingPaths(path, cwd))) continue;
      if (['starting', 'running', 'waiting', 'cancelling'].includes(session.state)
        || this.store.listUnfinishedNativeRuns(session.id).some(run => !run.native?.queueReleasedAt)
        || this.actors.get(session.id)?.blocksWorkspace()) throw this.workspaceBusy();
    }
    const token = Symbol('workspace');
    this.workspaceReservations.set(token, paths);
    return () => { if (this.workspaceReservations.delete(token)) this.kick(); };
  }

  /** Delivers exactly one additional input to its original live turn under the session lock. */
  steer(sessionId: string, runId: string): Promise<Run> {
    const actor = this.actor(sessionId);
    try {
      return Promise.resolve(actor.steer(sessionId, runId)).finally(() => this.settleActor(sessionId, actor));
    } catch (error) {
      this.settleActor(sessionId, actor);
      throw error;
    }
  }

  cancel(sessionId: string, runId: string): Run {
    const actor = this.actor(sessionId);
    try { return actor.cancel(sessionId, runId); }
    finally { this.settleActor(sessionId, actor); }
  }

  /** Checks only the persisted request and existing provider evidence; never submits input. */
  check(sessionId: string, runId: string): Promise<NativeRunRecovery> {
    const actor = this.actor(sessionId);
    return actor.check(sessionId, runId).finally(() => this.settleActor(sessionId, actor));
  }

  /** A user may release a proven-empty input, while late evidence still corrects its history. */
  continue(sessionId: string, runId: string, queuedRunIds: string[]): Promise<Run> {
    const actor = this.actor(sessionId);
    return Promise.resolve(actor.continue(sessionId, runId, queuedRunIds)).finally(() => this.settleActor(sessionId, actor));
  }

  /**
   * Stop the in-flight CLI turn and, when requested, accept its replacement before the dispatch
   * fence is released. This makes the stop receipt and follow-up acceptance one ordered action:
   * no queued prompt can slip between the two HTTP calls.
   */
  interrupt(sessionId: string, stop?: NativeStopRequest): Promise<Run | undefined> {
    const actor = this.actor(sessionId);
    return Promise.resolve(actor.interrupt(sessionId, stop)).finally(() => this.settleActor(sessionId, actor));
  }

  interruptAndSend(sessionId: string, commandId: string, submit: () => Run, stop?: NativeStopRequest, replacementFingerprint?: string): Promise<Run> {
    const actor = this.actor(sessionId);
    return Promise.resolve(actor.interruptAndSend(sessionId, commandId, submit, stop, replacementFingerprint)).finally(() => this.settleActor(sessionId, actor));
  }

  /** Stop the current turn and promote an existing queued run ahead of the rest of its queue. */
  sendQueuedNow(sessionId: string, runId: string, stop?: NativeStopRequest): Promise<Run> {
    const actor = this.actor(sessionId);
    return Promise.resolve(actor.sendQueuedNow(sessionId, runId, stop)).finally(() => this.settleActor(sessionId, actor));
  }

  async close(): Promise<void> {
    this.closed = true;
    const actors = [...this.actors.values()];
    this.actors.clear();
    this.offCorrections?.();
    await Promise.all(actors.map(actor => actor.shutdown()));
  }

  private traits(backendId: string | undefined): NativeBackendTraits {
    return (backendId && this.native.traits?.(backendId)) || {};
  }

  private actor(sessionId: string): SessionActor {
    let actor = this.actors.get(sessionId);
    if (!actor) {
      actor = new SessionActor(this.host, sessionId);
      // A call that races shutdown must not put a new actor back into the map close() just cleared.
      if (!this.closed) this.actors.set(sessionId, actor);
    }
    return actor;
  }

  /** Drop a conversation that has finished, so its observer and timer do not stay for the life of the process. */
  private evict(sessionId: string, actor: SessionActor): void {
    if (this.closed || this.actors.get(sessionId) !== actor || !actor.isIdle()) return;
    this.actors.delete(sessionId);
    void actor.shutdown();
  }

  private settleActor(sessionId: string, actor: SessionActor): void {
    if (this.actors.get(sessionId) === actor) actor.settle();
  }
}
