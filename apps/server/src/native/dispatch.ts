import { basename, join, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import type { NativeDeliveryState, NativeQueue, NativeRunInput, NativeRunRecovery, NativeStatus, NativeStopRequest, NativeTurnTarget, NativeWorkbenchEvent, Run, Session, TerminalInfo } from '../../../../packages/contracts/src/index.js';
import { samePromptText } from '../../../../packages/contracts/src/prompt-match.js';
import type { Store } from '../store.js';
import type { WorkspaceService } from '../workspace/index.js';
import type { NativeBackendTraits, NativeDispatchBinding } from '../backends/types.js';
import { AppError } from '../errors.js';
import { backendIdOf } from '../session-identity.js';
import { isAgentTerminal } from '../terminal/kinds.js';
import { redactSensitiveText } from '../settings/config-documents.js';
import { admission, holdsUnconfirmed, queueOf, steerTurnEnded, type Admission } from './lane.js';

const now = () => Date.now();
/** The turn an event speaks for: a steer's receipt names its target, whatever turn its row was grouped into. */
const turnOf = (event: NativeWorkbenchEvent) => event.type === 'native_input_receipt' && typeof event.data.targetTurnId === 'string' ? event.data.targetTurnId : event.nativeTurnId;
/**
 * How long a message may keep bouncing off a CLI that is not at a prompt *and* is not running a turn
 * (still starting, or a screen we cannot read) before it is failed. Waiting behind a live turn is the
 * queue working as intended and is never counted; this only bounds a wedge that would otherwise retry
 * silently for ever. Longer than a cold Claude Code start with MCP servers and a large resume.
 */
const CLI_BUSY_LIMIT_MS = 3 * 60_000;
/**
 * How long a provider may report idle with no active turn before a run still tracked as `observed`
 * is closed as interrupted. Short enough that a lost completion event stops pinning the session as
 * busy; long enough to ride out the gap between a turn's last status and its completion event.
 */
const IDLE_RECONCILE_MS = 15_000;
/**
 * How long a run that is already waiting for its turn outcome may stay idle before it is closed as
 * unconfirmed. The plain idle window is too short for a Stop hook chain: hooks other than ours run
 * after the turn ends, and the outcome (`turn_duration` in Claude's log, `turn/completed` for
 * Codex) only lands once they finish. Closing at 15 s would show "result unconfirmed" and then
 * correct itself when that outcome arrives. Still bounded, so a truly lost outcome cannot pin the
 * session for ever.
 */
const IDLE_OUTCOME_GRACE_MS = 60_000;
/** How long a drain holds deliveries without being renewed; whoever waits for a restart renews it as it polls. */
const DRAIN_LEASE_MS = 30_000;
/** The holder of a drain request that names none (callers that predate holders). */
const LEGACY_DRAIN_HOLDER = 'legacy';
const workspacePath = (cwd: string) => { try { return realpathSync(cwd); } catch { return resolve(cwd); } };
const overlappingPaths = (left: string, right: string) => left === right || left.startsWith(right.endsWith(sep) ? right : `${right}${sep}`) || right.startsWith(left.endsWith(sep) ? left : `${left}${sep}`);

/** Whether the CLI answers this run in its own pane: the provider's verdict when it gave one, else a leading `/`. */
function isSlashCommand(native: NonNullable<Run['native']>): boolean {
  return native.slashCommand ?? native.input.text.trimStart().startsWith('/');
}

/** A replayable native outcome may refine lost-result recovery, never a user's resolution. */
function canApplyTurnOutcome(run: Run): boolean {
  const native = run.native;
  if (!native || ['completed', 'failed', 'cancelled'].includes(run.state)
    || ['acknowledged', 'cancelled', 'steer_rejected', 'steer_stopped'].includes(native.stage ?? '')
    || native.delivery === 'failed') return false;
  return native.delivery !== 'cancelled'
    || run.state === 'interrupted' && ['turn_outcome_unknown', 'runtime_exit'].includes(native.stage ?? '');
}

const isTurnOutcome = (event: NativeWorkbenchEvent) => ['run_completed', 'run_failed', 'run_cancelled', 'native_turn_reopened'].includes(event.type);
const outcomeRevision = (event: NativeWorkbenchEvent): number => Number.isSafeInteger(event.data.outcomeRevision) && Number(event.data.outcomeRevision) > 0 ? Number(event.data.outcomeRevision) : 1;

interface StopReceipt {
  request: NativeStopRequest; operation: string; state: 'pending' | 'completed';
  runId?: string; createdAt: string; replacementFingerprint?: string;
  targets?: Array<[string, NativeDeliveryState]>; terminalId?: string; terminalEpoch?: number;
  error?: { code?: string; message: string };
}

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
  canReleaseInput?(session: Session, run: Run): Promise<boolean>;
  status(sessionId: string): NativeStatus;
  /** Whether a driver is bound to the session; without it every session counts as possibly live. */
  hasRuntime?(sessionId: string): boolean;
  sendRun?(session: Session, run: Run, commitDispatchFence: (binding?: NativeDispatchBinding) => Run, options?: { now?: boolean }): Promise<void>;
  supportsSteer?(session: Session): Promise<boolean>;
  steerRun?(session: Session, run: Run, commitDispatchFence: (binding?: NativeDispatchBinding) => Run): Promise<void | { deferred: true }>;
  /** True when this session's backend can take the first user message as a launch argument. */
  supportsInitialPromptArgs?(session: Session): Promise<boolean>;
  /** True when this session's backend replaces its running turn with a message in one step of its own. */
  supportsSendNow?(session: Session): Promise<boolean>;
  commitDispatchFence?(runId: string, binding?: NativeDispatchBinding): Run;
  deliver?(session: Session, text: string, beforeWrite: DeliverFence): Promise<void>;
  /** `deliver`, replacing the running turn; see `supportsSendNow`. */
  deliverNow?(session: Session, text: string, beforeWrite: DeliverFence): Promise<void>;
  /** Release an in-flight send's receipt wait before Stop needs the same session lock. */
  requestInterrupt?(sessionId: string): void;
  interrupt(session: string | Session, options?: { clearPrompt?: boolean; expectedStop?: NativeStopRequest }): Promise<void>;
}

interface NativeDispatcherRuntime {
  withSession<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
  /** With `initialPrompt`, must call `beforeSpawn` right before spawning and abort the spawn if it throws. */
  ensure(session: Session, options?: { initialPrompt?: string; beforeSpawn?: () => void }): Promise<unknown>;
}

/** What keeps a restart waiting: a write still being confirmed, a turn or a background task that a restart would end. */
export interface RestartBlocker { sessionId: string; title: string; backendId: string; reason: 'delivery' | 'turn' | 'background' }
export interface RestartAssessment { restartable: boolean; draining: boolean; blockers: RestartBlocker[] }

/** Durable runs own execution; a browser's presence never owns the worker or its observations. */
export class NativeDispatcher {
  private readonly workers = new Map<string, Promise<void>>();
  private readonly observers = new Map<string, () => void>();
  private readonly nextAttempt = new Map<string, number>();
  private readonly leases = new Set<string>();
  /** Synchronous reservations for explicit /start calls while provider startup awaits I/O. */
  private readonly startReservations = new Map<string, number>();
  /** Destructive file operations exclude native work in the directory and its nested projects. */
  private readonly workspaceReservations = new Map<symbol, string[]>();
  /** A confirmed-interrupt request fences delivery and idle reconciliation until it settles. */
  private readonly interruptingSessions = new Set<string>();
  private readonly interruptionTasks = new Map<string, { commandId?: string; fingerprint?: string; task: Promise<Run | undefined> }>();
  private readonly recoveryChecks = new Map<string, Promise<NativeRunRecovery>>();
  private readonly recoveryActions = new Set<string>();
  private readonly steerTasks = new Map<string, Promise<Run>>();
  private readonly pendingSteerOutcomes = new Map<string, NativeWorkbenchEvent>();
  /** Native Stop can precede the transcript row that identifies its ordinary execution owner. */
  private readonly pendingTurnOutcomes = new Map<string, NativeWorkbenchEvent>();
  /** Ephemeral revision fences; the journal supplies current authority again after restart. */
  private readonly turnOutcomeRevisions = new Map<string, number>();
  private readonly offCorrections?: () => void;
  private readonly hookedTurns = new Set<string>();
  /** When each observed run was first seen with an idle, turn-less provider (see `IDLE_RECONCILE_MS`). */
  private readonly idleSince = new Map<string, number>();
  private readonly timer: NodeJS.Timeout;
  private closed = false;
  private polling = false;
  /** Per holder, until when a restart being prepared holds queued runs back; see `drain`. */
  private readonly drainLeases = new Map<string, number>();
  /** Steers that arrived during a drain (run → conversation), sent once it ends; see `steer`. */
  private readonly drainHeldSteers = new Map<string, string>();

  /**
   * `beforeTurn` runs once a turn is claimed and before anything reaches the CLI — the moment its
   * checkpoint is taken. It is best effort: a rejection never fails the turn, and one slower than
   * `beforeTurnTimeoutMs` is left behind, with `late()` telling it the turn went ahead without it.
   */
  constructor(private readonly store: Store, private readonly native: NativeDispatcherBackend, private readonly runtime: NativeDispatcherRuntime, private readonly workspace: WorkspaceService, private readonly options: { intervalMs?: number; confirmationMs?: number; beforeTurn?: (session: Session, run: Run, late: () => boolean) => Promise<unknown>; beforeTurnTimeoutMs?: number; busyLimitMs?: number; idleReconcileMs?: number; idleOutcomeGraceMs?: number } = {}) {
    this.timer = setInterval(() => this.kick(), options.intervalMs ?? 500);
    this.timer.unref();
    this.offCorrections = native.subscribeCorrections?.((sessionId, message) => this.observe(sessionId, message));
    // The application can finish registering routes before recovered work is dispatched.
    queueMicrotask(() => this.kick());
  }

  kick(): void {
    if (this.closed || this.polling) return;
    this.polling = true;
    try {
      const runs = this.store.listUnfinishedNativeRuns();
      const unfinishedIds = new Set(runs.map(run => run.id));
      for (const id of this.nextAttempt.keys()) if (!unfinishedIds.has(id)) this.nextAttempt.delete(id);
      for (const id of this.pendingSteerOutcomes.keys()) if (!unfinishedIds.has(id)) this.pendingSteerOutcomes.delete(id);
      for (const id of this.idleSince.keys()) if (!unfinishedIds.has(id)) this.idleSince.delete(id);
      if (!this.draining) this.resumeDrainHeldSteers();
      const sessions = new Set(runs.map(run => run.sessionId));
      for (const [id, unsubscribe] of this.observers) if (!sessions.has(id)) { unsubscribe(); this.observers.delete(id); }
      for (const id of sessions) {
        if (this.workspaceReserved(this.store.getSession(id))) continue;
        // Opening the watch resolves the conversation's profile, which may no longer exist. That is this
        // conversation's problem, not the process's (kick runs off a timer): it goes on unobserved, and the
        // send below fails its queued run with the same error. The watch is tried again on the next tick.
        if (!this.observers.has(id)) {
          try { this.observers.set(id, this.native.subscribe(id, message => this.observe(id, message))); }
          catch { /* unresolvable profile: see above */ }
        }
        // A run queued before a restart for a backend whose plugin is still starting is not failed for its absence; the next tick sees it.
        if (this.native.pending?.(this.store.getSession(id).backendId ?? '')) continue;
        let pending = runs.filter(run => run.sessionId === id);
        if (this.sendOrphanedSteers(id, pending)) pending = this.store.listUnfinishedNativeRuns(id);
        // Nothing to start: the provider's status is not read for it.
        if (!pending.some(run => run.native?.intent !== 'steer' && run.native?.delivery === 'queued')) continue;
        // Draining: nothing new reaches a CLI. The run stays queued, survives the restart and is sent after it.
        if (this.draining) continue;
        const { next: run, held } = this.admission(id, pending);
        if (held || !run) continue;
        this.leases.add(id);
        const work = this.runtime.withSession(id, () => this.execute(run.id)).catch(() => undefined).finally(() => {
          this.leases.delete(id); this.workers.delete(id);
        });
        this.workers.set(id, work);
      }
      for (const run of runs) {
        if (run.native?.queueReleasedAt) continue;
        if (run.native?.delivery === 'observed' && typeof this.native.status === 'function'
          && (run.native.expectsTurnOutcome || run.native.intent === 'steer' || this.idleSince.has(run.id) || (run.native.timings?.firstOutputAt ?? run.native.timings?.busyAt ?? 0) > 0 && now() - (run.native.timings?.firstOutputAt ?? run.native.timings?.busyAt ?? now()) >= 500)) {
          this.observe(run.sessionId, { type: 'status', status: this.native.status(run.sessionId) });
        }
        if (run.native?.delivery === 'input_sent' && now() - (run.native.timings?.inputSentAt ?? now()) > (this.options.confirmationMs ?? 30_000)) {
          const terminal = this.matchingTerminal(run);
          const session = this.store.getSession(run.sessionId);
          // RPC backends such as DSH have no PTY to match. Their fenced provider/chat identity is
          // the link: a busy inbox may take longer than the confirmation window to emit its echo.
          const linkedProtocol = this.native.sendRun && run.native.nativeSessionId
            && run.native.nativeSessionId === session.nativeSessionId
            && run.native.backendId === session.backendId;
          const status = linkedProtocol || (terminal && terminal.state !== 'exited')
            ? this.native.status(run.sessionId) : undefined;
          // A live, correctly linked CLI that is still busy or showing a dialog may simply be
          // taking a long time to persist its transcript echo. Keep the write fenced as
          // input_sent; status alone is never a receipt and must not fabricate observed.
          if (status?.phase === 'busy' || status?.phase === 'attention') continue;
          this.store.transitionNativeRun(run.id, ['input_sent'], { delivery: 'uncertain', stage: 'confirmation',
            diagnostic: { code: 'NATIVE_RECEIPT_TIMEOUT', message: 'The provider receipt did not arrive within the confirmation window', stage: 'confirmation', at: new Date().toISOString() },
          }, { state: 'interrupted', error: '暂时无法确认是否已发送' });
        }
      }
    } finally { this.polling = false; }
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

  /** A drain that ended without a restart lets the steers it held go to their turn; one whose turn is over meanwhile goes on as the next message. */
  private resumeDrainHeldSteers(): void {
    for (const [runId, sessionId] of this.drainHeldSteers) {
      this.drainHeldSteers.delete(runId);
      try { void this.steer(sessionId, runId).catch(() => undefined); } catch { /* sent on as a message or gone */ }
    }
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
      const blocker = (reason: RestartBlocker['reason']) => blockers.push({ sessionId: session.id, title: session.title, backendId, reason });
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

  /** `admission` over the conversation's runs and what this dispatcher is doing with it right now. */
  private admission(sessionId: string, runs: readonly Run[], status = this.readStatus(sessionId)): Admission {
    const session = this.store.getSession(sessionId);
    return admission({
      runs, status,
      sending: this.workers.has(sessionId), stopping: this.interruptingSessions.has(sessionId), recovering: this.recoveryActions.has(sessionId),
      workspaceReserved: this.workspaceReserved(session),
      waitsWhileStarting: Boolean(this.traits(session.backendId).acceptsInputWhileBusy),
      pendingRelaunch: Boolean(session.configPending && this.traits(session.backendId).relaunchesForPendingConfig),
      retryAt: runId => this.nextAttempt.get(runId) ?? 0, now: now(),
    });
  }

  /** Whether anything of the conversation is in flight here: a delivery, start, stop, recovery or unfinished run. */
  busy(sessionId: string): boolean {
    return this.workers.has(sessionId) || this.startReservations.has(sessionId) || this.interruptingSessions.has(sessionId)
      || this.recoveryActions.has(sessionId) || this.leases.has(sessionId) || this.store.listUnfinishedNativeRuns(sessionId).length > 0;
  }

  /** Where the conversation's queue stands, for clients (`NativeStatus.queue`), read against the status it goes out with. */
  queue(sessionId: string, status: NativeStatus): NativeQueue {
    return queueOf(this.admission(sessionId, this.store.listUnfinishedNativeRuns(sessionId), status));
  }

  private readStatus(sessionId: string): NativeStatus | undefined {
    try { return this.native.status(sessionId); } catch { return undefined; }
  }

  /**
   * A steer still waiting for its turn when that turn is over goes out as the next message. Its
   * provider rejects what it still holds when a turn ends; this covers a steer the provider never
   * reported back on (its hook connection lost, a service restart before the steer was taken).
   */
  private sendOrphanedSteers(sessionId: string, runs: readonly Run[]): boolean {
    const orphaned = runs.filter(run => run.native?.intent === 'steer' && ['queued', 'preparing'].includes(run.native.delivery) && !this.steerTasks.has(run.id));
    if (!orphaned.length) return false;
    const status = this.readStatus(sessionId);
    let moved = false;
    for (const run of orphaned) if (steerTurnEnded(run, status)) moved = this.requeueSteer(run.id) || moved;
    return moved;
  }

  private requeueSteer(runId: string): boolean {
    this.pendingSteerOutcomes.delete(runId);
    this.nextAttempt.delete(runId);
    return Boolean(this.store.requeueSteer(runId));
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
    if (this.startReservations.has(sessionId) && !options.shared) {
      throw new AppError('NATIVE_SESSION_BUSY', 'This conversation is starting; try again shortly', 409, { sessionId });
    }
    this.startReservations.set(sessionId, (this.startReservations.get(sessionId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.startReservations.get(sessionId) ?? 1) - 1;
      if (remaining) this.startReservations.set(sessionId, remaining);
      else this.startReservations.delete(sessionId);
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

  /** Atomically excludes native dispatch and startup until a restore/merge finishes its writes. */
  reserveWorkspace(projectIds: string[]): () => void {
    if (this.closed) throw new AppError('DISPATCH_STOPPED', 'The service is shutting down', 503);
    const paths = projectIds.map(id => workspacePath(this.store.getProject(id).cwd));
    if ([...this.workspaceReservations.values()].some(existing => existing.some(path => paths.some(candidate => overlappingPaths(path, candidate))))) throw this.workspaceBusy();
    for (const session of this.store.listSessions()) {
      const cwd = workspacePath(this.store.getProject(session.projectId).cwd);
      if (!paths.some(path => overlappingPaths(path, cwd))) continue;
      if (['starting', 'running', 'waiting', 'cancelling'].includes(session.state)
        || this.store.listUnfinishedNativeRuns(session.id).length
        || this.leases.has(session.id) || this.workers.has(session.id) || this.startReservations.has(session.id)
        || [...this.steerTasks.keys()].some(id => this.store.getRun(id).sessionId === session.id)
        || this.interruptingSessions.has(session.id)) throw this.workspaceBusy();
    }
    const token = Symbol('workspace');
    this.workspaceReservations.set(token, paths);
    return () => { if (this.workspaceReservations.delete(token)) this.kick(); };
  }

  private async render(input: NativeRunInput): Promise<string> {
    const extras = input.context.map(item => `@${item.path}${item.line ? `:${item.line}` : ''}`);
    for (const id of input.attachmentIds) {
      const { attachment, data } = await this.workspace.readAttachment(id);
      const directory = join(tmpdir(), 'riffet-attachments', attachment.id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const target = join(directory, basename(attachment.name) || 'attachment');
      await writeFile(target, data, { mode: 0o600 });
      extras.push(target);
    }
    return [input.text, ...(extras.length ? ['', ...extras] : [])].join('\n');
  }

  /**
   * Phase-1 gate for routing a run's text to a brand-new agent CLI as a positional launch argument
   * rather than through the TUI composer. Only safe for a brand-new session's first user message with no
   * attachments/context — in that case there is no existing composer draft to collide with, no
   * live TUI to coordinate against, and no slash command. Everything else keeps the legacy
   * paste-into-composer path intact.
   */
  private canUseArgvInitialPrompt(session: Session, initial: NonNullable<Run['native']>): boolean {
    if (initial.stage === 'interrupt_followup') return false;
    if (!initial.input.text || initial.input.text.trimStart().startsWith('/')) return false;
    if (initial.input.attachmentIds.length > 0) return false;
    if (initial.input.context.length > 0 || initial.input.references?.length) return false;
    if (session.resumePicker) return false;
    // Linux MAX_ARG_STRLEN is 128 KiB per arg; cap conservatively at 64 KiB so execve never
    // fails with E2BIG for a composer paste. Larger drafts fall back to the paste path, which
    // streams through a tmux paste-buffer and has no comparable limit.
    if (Buffer.byteLength(initial.input.text, 'utf8') > 64 * 1024) return false;
    // A live terminal cannot absorb a positional argv prompt retroactively — fall back to paste.
    if (session.terminalId) {
      try { if (this.store.getTerminal(session.terminalId).state !== 'exited') return false; }
      catch { /* terminal row gone; a fresh spawn will be created */ }
    }
    return true;
  }

  private async beforeTurn(session: Session, run: Run): Promise<void> {
    let timer: NodeJS.Timeout | undefined, late = false;
    const limit = new Promise<void>(resolve => { timer = setTimeout(() => { late = true; resolve(); }, this.options.beforeTurnTimeoutMs ?? 10_000); timer.unref(); });
    const abandoned = () => late || this.closed || this.store.getRun(run.id).native?.delivery !== 'preparing';
    try { await Promise.race([Promise.resolve().then(() => this.options.beforeTurn!(session, run, abandoned)).catch(() => undefined), limit]); } finally { clearTimeout(timer); }
  }

  /**
   * With `now`, the run replaces the turn in progress through the backend's own send-now path; it is
   * called from inside an interrupt, whose fence it is the one write allowed through.
   */
  private async execute(runId: string, options: { now?: boolean } = {}): Promise<void> {
    let run = this.store.getRun(runId);
    if (run.native?.intent === 'steer') throw new AppError('STEER_ACTION_UNSUPPORTED', 'A steer message cannot be sent as a new turn', 409);
    if (this.closed || run.native?.delivery !== 'queued') return;
    // Admitted before a drain began and waited for the conversation's lock: it stays queued, and a kick after the drain sends it.
    if (this.draining) return;
    const initial = run.native;
    const checkpoint = Boolean(this.options.beforeTurn && !initial.checkpointAttempted && !isSlashCommand(initial));
    if (!this.store.transitionNativeRun(runId, ['queued'], { delivery: 'preparing', stage: 'runtime', attempt: initial.attempt + 1, ...(checkpoint ? { checkpointAttempted: true } : {}), timings: { ...initial.timings, prepareAt: now() } })) return;
    try {
      let session = this.store.getSession(run.sessionId);
      if (session.archivedAt) throw new AppError('ARCHIVED_SESSION', 'This conversation is archived', 409);
      if (this.store.getProject(session.projectId).archivedAt) throw new AppError('ARCHIVED_PROJECT', 'Restore this project before running a conversation', 409);
      if (checkpoint) await this.beforeTurn(session, run);
      // Checkpoint I/O may outlive cancellation or shutdown. Neither may start a CLI as a side
      // effect after the caller has already stopped this still-uncommitted turn.
      if (this.closed) throw new AppError('DISPATCH_STOPPED', 'The service is restarting; the message was not sent', 409);
      if (this.store.getRun(runId).native?.delivery !== 'preparing') return;
      session = this.store.getSession(run.sessionId);
      if (session.archivedAt) throw new AppError('ARCHIVED_SESSION', 'This conversation is archived', 409);
      if (!options.now && this.interruptingSessions.has(session.id)) throw new AppError('NATIVE_INTERRUPT_IN_PROGRESS', 'The current turn is stopping; the message was not sent', 409);
      // A queued input is delivered under the settings in effect when it actually starts, the way
      // DSH resolves a selection at step assembly. `initial.config` remains the record of what was
      // accepted — `sendRun` reads the live session, and what it really used lands in the fence's
      // `resolvedConfig` — so a switch made while the message waited neither silently runs the old
      // settings nor fails the message. A run already in flight is a different case, and
      // A switch asked for while this run is in flight is deferred by its backend (terminal-based
      // ones relaunch a CLI only when it is idle; DSH applies one without disturbing the turn), so
      // nothing here has to refuse it.
      // Decide BEFORE spawning: can this run's text be delivered as a positional argv to a
      // brand-new agent CLI, skipping the "paste into TUI composer" path entirely? Only when
      // (a) no live terminal yet, (b) the composer owns the message (not a slash command),
      // (c) no attachments/context extras (render() may append file paths; keep the simple
      // single-line argv contract for Phase 1). This is Phase 1 of the botmux-layered refactor
      // in plans/replicated-gathering-hammock.md.
      // Only a backend that declares the capability can absorb a launch-time prompt; everything
      // else keeps its own send path. render() has no side effects here because the gate above
      // already rejected attachments and context extras.
      const argvPrompt = this.canUseArgvInitialPrompt(session, initial) && await this.native.supportsInitialPromptArgs?.(session) === true
        ? await this.render(initial.input)
        : undefined;
      // A resumed chat already has rows; only an echo after them can be this prompt's receipt.
      const argvBaseline = argvPrompt !== undefined && session.nativeSessionId
        ? (await this.native.snapshot(session.id)).events.at(-1)?.sequence ?? 0
        : 0;
      let argvFenced = false;
      // The argv prompt is delivered by the spawn itself, so the write fence has to be committed
      // before the process exists: recovery then sees an uncertain delivery and never replays it,
      // and a cancel is refused because the CLI may already be running it.
      const beforeSpawn = () => {
        if (this.closed) throw new AppError('DISPATCH_STOPPED', 'The service is restarting; the message was not sent', 409);
        if (this.interruptingSessions.has(session.id)) throw new AppError('NATIVE_INTERRUPT_IN_PROGRESS', 'The current turn is stopping; the message was not sent', 409);
        const latest = this.store.getSession(session.id);
        const nativeSessionId = latest.nativeSessionId;
        const changed = this.store.transitionNativeRun(runId, ['preparing'], {
          delivery: 'dispatching', stage: 'input', backendId: latest.backendId,
          ...(nativeSessionId ? { nativeSessionId } : {}),
          baselineSequence: argvBaseline, renderedText: argvPrompt,
          resolvedConfig: { model: latest.model, mode: latest.mode, approval: latest.approval },
          timings: { ...this.store.getRun(runId).native?.timings, dispatchAt: now() },
        });
        if (!changed) throw new AppError('RUN_CANCELLED', 'The message was cancelled', 409);
        argvFenced = true;
      };
      await this.runtime.ensure(session, argvPrompt !== undefined ? { initialPrompt: argvPrompt, beforeSpawn } : {});
      if (this.closed) throw new AppError('DISPATCH_STOPPED', 'The service is restarting', 409);
      session = this.store.getSession(run.sessionId);
      // The launch returned without passing through the fence hook, so whether a CLI got the prompt
      // on its argv is unknown; pasting it as well could run it twice.
      if (argvPrompt !== undefined && !argvFenced) {
        this.store.transitionNativeRun(runId, ['preparing'], { delivery: 'uncertain', stage: 'confirmation',
          diagnostic: { code: 'NATIVE_INPUT_FENCE_MISSING', message: 'The initial prompt launch returned without committing its input fence', stage: 'runtime', at: new Date().toISOString() },
        }, { state: 'interrupted', error: '暂时无法确认是否已发送' });
        return;
      }
      if (argvPrompt !== undefined) {
        const latest = this.store.getSession(session.id);
        if (!latest.terminalId) throw new AppError('TERMINAL_NOT_RUNNING', 'The CLI did not start', 503);
        const info = this.store.getTerminal(latest.terminalId);
        const fence = this.store.getRun(runId).native!;
        // The CLI could have exited immediately on bad args (unsupported model/context, denied
        // trust in a nested dir, OOM, …). Fail fast with a clear state instead of parking the
        // run on `input_sent` waiting for a transcript echo that will never arrive.
        if (info.state === 'exited') {
          this.store.transitionNativeRun(runId, ['dispatching'], { delivery: 'failed', stage: 'prepare' }, { state: 'failed', error: latest.error ?? `${this.cliName(latest.backendId)}启动后立即退出，请检查模型/上下文配置` });
          return;
        }
        // The transcript echo may already have bound the run to `observed`; it still gets its terminal.
        if (fence.delivery === 'dispatching' || fence.delivery === 'observed') {
          this.store.transitionNativeRun(runId, [fence.delivery], {
            ...(fence.delivery === 'dispatching' ? { delivery: 'input_sent', stage: 'confirmation' } : {}),
            terminalId: info.id, terminalEpoch: info.epoch,
            timings: { ...fence.timings, inputSentAt: now() },
          });
        }
      } else if (this.native.sendRun) {
        await this.native.sendRun(session, run, binding => {
          if (this.closed) throw new AppError('DISPATCH_STOPPED', 'The service is restarting; the message was not sent', 409);
          if (!options.now && this.interruptingSessions.has(session.id)) throw new AppError('NATIVE_INTERRUPT_IN_PROGRESS', 'The current turn is stopping; the message was not sent', 409);
          const latest = this.store.getSession(session.id);
          // No configuration comparison here: `runtime.ensure` re-reads the store and `sendRun`
          // delivers under the live settings, so a switch made while the message waited is meant to
          // govern it rather than fail it.
          if (this.native.commitDispatchFence) return this.native.commitDispatchFence(runId, binding);
          const changed = this.store.transitionNativeRun(runId, ['preparing'], {
            delivery: 'dispatching', stage: 'input', backendId: latest.backendId,
            ...(binding?.nativeSessionId ? { nativeSessionId: binding.nativeSessionId } : {}),
            ...(binding?.terminalId ? { terminalId: binding.terminalId } : latest.terminalId ? { terminalId: latest.terminalId } : {}),
            ...(binding?.terminalEpoch !== undefined ? { terminalEpoch: binding.terminalEpoch } : {}),
            ...(binding?.baselineSequence !== undefined ? { baselineSequence: binding.baselineSequence } : {}),
            ...(binding?.renderedText !== undefined ? { renderedText: binding.renderedText } : {}),
            ...(binding?.slashCommand !== undefined ? { slashCommand: binding.slashCommand } : {}),
            ...(binding?.resolvedConfig ? { resolvedConfig: binding.resolvedConfig } : {}),
            timings: { ...this.store.getRun(runId).native?.timings, dispatchAt: now() },
          });
          if (!changed) throw new AppError('RUN_CANCELLED', 'The message was cancelled', 409);
          return changed;
        }, options.now ? { now: true } : undefined);
      } else {
        const text = await this.render(initial.input);
        const deliver = options.now ? this.native.deliverNow : this.native.deliver;
        if (!deliver) throw new AppError('NATIVE_BACKEND_SEND_UNAVAILABLE', 'Backend cannot send native messages', 503);
        await deliver.call(this.native, session, text, ({ terminalId, epoch, chatId, baselineSequence = 0 }) => {
          if (this.closed) throw new AppError('DISPATCH_STOPPED', 'The service is restarting; the message was not sent', 409);
          if (!options.now && this.interruptingSessions.has(session.id)) throw new AppError('NATIVE_INTERRUPT_IN_PROGRESS', 'The current turn is stopping; the message was not sent', 409);
          const latest = this.store.getSession(session.id);
          // The pane is the one thing that must not move under a delivery in progress: pasting into a
          // replaced terminal would type the message into a dead or unrelated session. The settings
          // are deliberately not compared — the message is delivered under the live ones.
          if (latest.terminalId !== terminalId) throw new AppError('TERMINAL_REBOUND', 'The conversation moved to another terminal; send the message again', 409);
          const nativeSessionId = chatId ?? latest.nativeSessionId;
          const changed = this.store.transitionNativeRun(runId, ['preparing'], {
            delivery: 'dispatching', stage: 'input', terminalId, terminalEpoch: epoch,
            backendId: latest.backendId,
            ...(nativeSessionId ? { nativeSessionId } : {}),
            baselineSequence, renderedText: text,
            resolvedConfig: { model: latest.model, mode: latest.mode, approval: latest.approval },
            timings: { ...this.store.getRun(runId).native?.timings, dispatchAt: now() },
          });
          if (!changed) throw new AppError('RUN_CANCELLED', 'The message was cancelled', 409);
        });
      }
      // The argv path committed `input_sent` itself; both send paths stop at `dispatching`.
      if (argvPrompt === undefined) {
        run = this.store.getRun(runId);
        this.store.transitionNativeRun(runId, ['dispatching'], { delivery: 'input_sent', stage: 'confirmation', timings: { ...run.native?.timings, inputSentAt: now() } });
      }
      // A slash command the CLI answers in its own pane uses a successful PTY submission as its delivery boundary.
      if (this.traits(session.backendId).settlesSlashOnSubmit && isSlashCommand(this.store.getRun(runId).native ?? initial)) this.store.transitionNativeRun(runId, ['input_sent'], { stage: 'command_sent' }, { state: 'completed' });
      else {
        // Only a head start on the receipt the stream brings anyway. A provider that cannot list a
        // thread whose first turn it is still writing (Codex) fails this read, and that says nothing
        // about a message the send already handed over.
        const snapshot = await this.native.snapshot(session.id).catch(() => undefined);
        if (snapshot) {
          this.observe(session.id, { type: 'events', events: snapshot.events });
          this.observe(session.id, { type: 'status', status: snapshot.status });
        }
      }
    } catch (error) {
      run = this.store.getRun(runId);
      const delivery = run.native?.delivery;
      if (delivery === 'cancelled' || delivery === 'observed') return;
      const message = error instanceof Error ? error.message : '无法执行消息';
      if (delivery === 'dispatching' || delivery === 'input_sent') {
        this.store.transitionNativeRun(runId, [delivery], {
          delivery: 'uncertain', stage: 'confirmation',
          diagnostic: { ...(error instanceof AppError ? { code: error.code } : {}),
            message: redactSensitiveText(message).slice(0, 1000), stage: run.native?.stage, at: new Date().toISOString() },
        }, { state: 'interrupted', error: '暂时无法确认是否已发送' });
      } else if (delivery === 'preparing') {
        const code = error instanceof AppError ? error.code : '';
        if (['CLI_BUSY', 'CLI_INTERACTION_REQUIRED', 'TERMINAL_INTERACTION_BUSY', 'TERMINAL_INTERACTION_STALE', 'TERMINAL_CONTROL_STALE', 'TERMINAL_DETACHED', 'DISPATCH_STOPPED', 'NATIVE_INTERRUPT_IN_PROGRESS', 'NATIVE_LAUNCH_ABORTED'].includes(code)) {
          // Nothing reached the CLI (the run never left `preparing`), so failing here repeats no side effect.
          const { blockedAt: since, ...timings } = run.native?.timings ?? {};
          const blockedAt = code === 'CLI_BUSY' && !this.runningTurn(run.sessionId) ? since ?? now() : undefined;
          const limit = this.options.busyLimitMs ?? CLI_BUSY_LIMIT_MS;
          if (blockedAt !== undefined && now() - blockedAt >= limit) {
            this.store.transitionNativeRun(runId, ['preparing'], { delivery: 'failed', stage: 'prepare', timings }, {
              state: 'failed',
              error: '终端未就绪，请检查后重试。',
            });
            return;
          }
          this.nextAttempt.set(run.id, now() + 1500);
          this.store.transitionNativeRun(runId, ['preparing'], { delivery: 'queued', stage: initial.stage === 'interrupt_followup' ? 'interrupt_followup' : code === 'CLI_INTERACTION_REQUIRED' ? 'interaction' : 'waiting', timings: blockedAt === undefined ? timings : { ...timings, blockedAt } }, { state: 'queued', error: undefined });
        } else {
          this.store.transitionNativeRun(runId, ['preparing'], { delivery: 'failed', stage: 'prepare' }, { state: 'failed', error: message });
        }
      }
    }
  }

  private traits(backendId: string | undefined): NativeBackendTraits {
    return (backendId && this.native.traits?.(backendId)) || {};
  }

  /** What messages call a backend's CLI: "<name> CLI" when it has a name (`terminalName`), else "CLI". */
  private cliName(backendId: string | undefined): string {
    const name = this.traits(backendId).terminalName;
    return name ? `${name} CLI ` : 'CLI ';
  }

  /** A turn (or a dialog inside one) is in flight: a busy CLI is then waiting its turn, not wedged. */
  private runningTurn(sessionId: string): boolean {
    try {
      const status = this.native.status(sessionId);
      if (['busy', 'attention'].includes(status.phase)) return true;
      // A settings relaunch waits for background work to end; the message waits with it and is not failed meanwhile.
      // Otherwise background work does not count: a CLI wedged away from its prompt is still bounded by the limit.
      const session = this.store.getSession(sessionId);
      return Boolean(session.configPending && this.traits(session.backendId).relaunchesForPendingConfig
        && (status.activity?.background || status.activity?.compacting));
    } catch { return false; }
  }

  /** Delivers exactly one additional input to its original live turn under the session lock. */
  steer(sessionId: string, runId: string): Promise<Run> {
    const existing = this.steerTasks.get(runId);
    if (existing) return existing;
    const run = this.store.getRun(runId);
    if (this.workspaceReserved(this.store.getSession(sessionId))) return Promise.reject(this.workspaceBusy());
    if (run.sessionId !== sessionId || run.native?.intent !== 'steer') throw new AppError('RUN_NOT_FOUND', 'The steer message does not exist', 404);
    if (run.native.delivery !== 'queued') return Promise.resolve(run);
    // Draining: a steer waits like any other send. A boundary wait could hold the restart for the rest of the
    // turn; the steer stays queued instead, goes to its turn if the drain ends without a restart, and becomes
    // the next message after one (the store's recovery), as a steer a restart caught before writing does.
    if (this.draining) { this.drainHeldSteers.set(runId, sessionId); return Promise.resolve(run); }
    const task = this.runtime.withSession(sessionId, async () => {
      let current = this.store.getRun(runId);
      if (current.native?.delivery !== 'queued') return current;
      this.store.transitionNativeRun(runId, ['queued'], { delivery: 'preparing', stage: 'steer_preparing', attempt: current.native.attempt + 1 });
      try {
        const check = () => {
          if (this.closed) throw new AppError('DISPATCH_STOPPED', 'The service is shutting down; the steer message was not sent', 503);
          if (this.interruptingSessions.has(sessionId)) throw new AppError('NATIVE_INTERRUPT_IN_PROGRESS', 'The current turn is stopping; the steer message was not sent', 409);
          const session = this.store.getSession(sessionId);
          if (session.archivedAt) throw new AppError('ARCHIVED_SESSION', 'This conversation is archived', 409);
          const status = this.native.status(sessionId), target = status.activeTurn;
          if (status.interaction) throw new AppError('CLI_INTERACTION_REQUIRED', 'Handle the pending confirmation first', 409);
          if (!target || session.nativeSessionId !== current.native!.nativeSessionId || target.nativeSessionId !== current.native!.nativeSessionId || target.turnId !== current.native!.nativeTurnId) {
            throw new AppError('STEER_TARGET_CHANGED', 'The target turn ended or changed; the steer message was not sent', 409);
          }
          const owner = this.store.findRunsByNativeTurn(sessionId, target.nativeSessionId, target.turnId).find(run => !run.native?.intent);
          if (owner) this.trackTurnOutcome(owner, status);
          if (this.store.listUnfinishedNativeRuns(sessionId).some(other => other.id !== runId && holdsUnconfirmed(other, status))) {
            throw new AppError('NATIVE_DELIVERY_UNCERTAIN', 'Another message has an unconfirmed outcome; check it first', 409);
          }
          return session;
        };
        const session = check();
        if (!this.native.steerRun || !await this.native.supportsSteer?.(session)) throw new AppError('STEER_UNSUPPORTED', 'This backend does not support steering', 409);
        // A validated live target is required before subscribing; a cold backend must not be
        // launched merely because an expired steer was retried.
        if (!this.observers.has(sessionId)) this.observers.set(sessionId, this.native.subscribe(sessionId, message => this.observe(sessionId, message)));
        const result = await this.native.steerRun(session, current, binding => {
          // A steer sent on as the next message is no steer any more: a late claim of it must not write it.
          if (this.store.getRun(runId).native?.intent !== 'steer') throw new AppError('RUN_CANCELLED', 'The steer message was sent on as the next message', 409);
          check();
          if (binding?.nativeSessionId && binding.nativeSessionId !== current.native!.nativeSessionId || binding?.nativeTurnId && binding.nativeTurnId !== current.native!.nativeTurnId) {
            throw new AppError('STEER_TARGET_CHANGED', 'The steer target changed', 409);
          }
          if (this.native.commitDispatchFence) return this.native.commitDispatchFence(runId, binding);
          const changed = this.store.transitionNativeRun(runId, ['preparing'], { ...binding, delivery: 'dispatching', stage: 'steer_input', timings: { ...this.store.getRun(runId).native?.timings, dispatchAt: now() } });
          if (!changed) throw new AppError('RUN_CANCELLED', 'The steer message was cancelled', 409);
          return changed;
        });
        const delivered = this.store.getRun(runId);
        if (result?.deferred) {
          // The input is still ours until the next matching native tool boundary. Keep the
          // preparation cancellable, and release this short lock so hooks/config/stop can run.
          this.store.transitionNativeRun(runId, ['preparing'], { stage: 'steer_waiting_boundary' });
          return this.store.getRun(runId);
        }
        if (delivered.native!.delivery === 'preparing') throw new AppError('STEER_REJECTED', 'The backend has not accepted the steer message', 409);
        this.store.transitionNativeRun(runId, [delivered.native!.delivery], {
          ...(delivered.native!.delivery === 'dispatching' ? { delivery: 'input_sent' as const, stage: 'steer_confirmation' } : {}),
          timings: { ...delivered.native!.timings, inputSentAt: now(), providerAcceptedAt: now() },
        });
        const snapshot = await this.native.snapshot(sessionId).catch(() => undefined);
        if (snapshot) this.observe(sessionId, { type: 'events', events: snapshot.events });
      } catch (error) {
        const failed = this.store.getRun(runId);
        const delivery = failed.native!.delivery;
        // Nothing was written: what could not reach this turn reaches the next one instead.
        if (delivery === 'queued' || delivery === 'preparing') this.requeueSteer(runId);
        else if (!['observed', 'failed', 'cancelled'].includes(delivery)) {
          const definite = error instanceof AppError && ['STEER_TARGET_CHANGED', 'STEER_REJECTED', 'STEER_UNSUPPORTED', 'RUN_CANCELLED'].includes(error.code);
          if (definite) this.pendingSteerOutcomes.delete(runId);
          this.store.transitionNativeRun(runId, [delivery], { delivery: definite ? 'failed' : 'uncertain', stage: definite ? 'steer_rejected' : 'steer_confirmation',
            diagnostic: { ...(error instanceof AppError ? { code: error.code } : {}), message: redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 1000), stage: failed.native?.stage, at: new Date().toISOString() },
          }, {
            state: definite ? 'failed' : 'interrupted', error: definite && error instanceof Error ? error.message : '暂时无法确认是否已发送',
          });
        }
      }
      return this.store.getRun(runId);
    }).finally(() => { this.steerTasks.delete(runId); this.kick(); });
    this.steerTasks.set(runId, task);
    return task;
  }

  private observe(sessionId: string, message: DispatchObservation): void {
    if (this.closed) return;
    if (message.type === 'events') {
      this.reconcileTurnCorrections(sessionId, message.events);
      for (const source of message.events) {
        let event = source;
        if (event.type === 'native_input_rejected' && event.data.receiptKind === 'native_command') {
          const commandId = typeof event.data.commandId === 'string' ? event.data.commandId : undefined;
          const run = commandId ? this.store.findRunByCommand(sessionId, commandId) : undefined;
          const native = run?.native;
          const session = this.store.getSession(sessionId);
          // Command rejection has no provider turn. Validate its own dispatch identity instead
          // of routing it through the turn-outcome filter or inventing a turn to pass that filter.
          if (event.sessionId !== sessionId || !run || !native || native.intent === 'steer' || native.slashCommand !== true
            || event.nativeTurnId || native.nativeTurnId || native.nativeMessageId
            || native.backendId !== session.backendId || !native.nativeSessionId || event.data.nativeSessionId !== native.nativeSessionId
            || session.nativeSessionId !== native.nativeSessionId || event.runId !== undefined && event.runId !== run.id
            || !['dispatching', 'input_sent', 'uncertain'].includes(native.delivery) || !canApplyTurnOutcome(run)) continue;
          const error = typeof event.data.error === 'string' ? redactSensitiveText(event.data.error).slice(0, 1000) : 'The native command was rejected.';
          this.store.transitionNativeRun(run.id, [native.delivery], { delivery: 'failed', stage: 'provider_failed',
            timings: { ...native.timings, completedAt: now() } }, { state: 'failed', error });
          continue;
        }
        if (isTurnOutcome(event)) {
          const scope = this.turnOutcomeScope(sessionId, event);
          // Explicit chat identities must match even for command-tagged outcomes.
          if (typeof event.data.nativeSessionId === 'string' && !scope) continue;
          if (scope && outcomeRevision(event) < (this.turnOutcomeRevisions.get(scope.key) ?? 1)) continue;
          if (event.type === 'native_turn_reopened') continue;
        }
        let taggedCommandId = typeof event.data.commandId === 'string' ? event.data.commandId : undefined;
        if (!taggedCommandId && event.nativeTurnId && ['run_completed', 'run_failed', 'run_cancelled'].includes(event.type)
          && typeof event.data.nativeSessionId === 'string') {
          const session = this.store.getSession(sessionId), nativeSessionId = event.data.nativeSessionId;
          if (session.nativeSessionId !== nativeSessionId) continue;
          const key = JSON.stringify([sessionId, nativeSessionId, event.nativeTurnId]);
          this.pendingTurnOutcomes.set(key, event);
          if (this.pendingTurnOutcomes.size > 256) this.pendingTurnOutcomes.delete(this.pendingTurnOutcomes.keys().next().value!);
          const turnRuns = this.store.findRunsByNativeTurn(sessionId, nativeSessionId, event.nativeTurnId);
          const owner = turnRuns.find(run => !run.native?.intent && run.native?.nativeMessageId);
          if (!owner) continue;
          this.pendingTurnOutcomes.delete(key);
          // A historical outcome names a turn, not one Riffet submission. The ordinary owner may
          // already be settled while receipted steers in that turn still await its real outcome.
          const outcomes = turnRuns.filter(run => run.native?.nativeMessageId && canApplyTurnOutcome(run))
            .map(run => ({ ...event, runId: owner.id, data: { ...event.data, commandId: run.commandId } }));
          if (outcomes.length) this.observe(sessionId, { type: 'events', events: outcomes });
          continue;
        }
        const matchingRun = taggedCommandId ? this.store.findRunByCommand(sessionId, taggedCommandId)
          : event.type === 'user_message_chunk' ? this.store.findRunByNativeMessage(sessionId, event.nativeId) : undefined;
        if (!matchingRun?.native) continue;
        const commandId = taggedCommandId ?? matchingRun.commandId;
        const current = this.store.getRun(matchingRun.id);
        if (!current.native) continue;
        // A steer's own lifecycle, arriving after it was sent on as the next message (a late claim the fence
        // refused, a provider ending the turn after the sweep): it speaks for the old turn, not this run's.
        if ((event.type === 'native_input_rejected' || event.type === 'native_input_submitted') && current.native.intent !== 'steer') continue;
        const eventTurn = turnOf(event);
        if (current.native.nativeTurnId && eventTurn && current.native.nativeTurnId !== eventTurn) continue;
        if (current.native.intent === 'steer' && eventTurn !== current.native.nativeTurnId) continue;
        if (eventTurn && !current.native.nativeTurnId) this.store.transitionNativeRun(current.id, [current.native.delivery], { nativeTurnId: eventTurn });
        if (current.native.intent === 'steer' && !current.native.ownerRunId && current.native.nativeSessionId && current.native.nativeTurnId
          && (event.type === 'user_message_chunk' || event.type === 'native_input_receipt')) {
          const owner = this.store.findRunsByNativeTurn(sessionId, current.native.nativeSessionId, current.native.nativeTurnId).find(run => !run.native?.intent);
          if (owner) this.store.transitionNativeRun(current.id, [current.native.delivery], { ownerRunId: owner.id });
        }
        const receiptEvent = message.events.find(item => (item.type === 'user_message_chunk' || item.type === 'native_input_receipt')
          && item.data.commandId === commandId && (!current.native!.nativeTurnId || turnOf(item) === current.native!.nativeTurnId));
        // The provider let go of a steer it never wrote (its turn ended or stopped first): it becomes the next message.
        if (event.type === 'native_input_rejected' && current.native.intent === 'steer' && event.data.beforeWrite === true) {
          this.requeueSteer(current.id);
          continue;
        }
        if (event.type === 'native_input_submitted' && current.native.intent === 'steer') {
          this.store.transitionNativeRun(current.id, ['dispatching'], { delivery: 'input_sent', stage: 'steer_confirmation',
            timings: { ...current.native.timings, inputSentAt: now() } });
          continue;
        }
        if (event.type === 'run_completed' || event.type === 'run_failed' || event.type === 'run_cancelled') {
          if (current.native.intent === 'steer' && ['steer_rejected', 'acknowledged', 'cancelled'].includes(current.native.stage ?? '')) {
            this.pendingSteerOutcomes.delete(current.id);
            continue;
          }
          if (current.native.intent === 'steer' && !current.native.nativeMessageId && !receiptEvent) {
            this.pendingSteerOutcomes.set(current.id, event);
            continue;
          }
          const providerMessageId = typeof event.data.nativeMessageId === 'string' && event.data.nativeMessageId.length <= 500
            ? event.data.nativeMessageId : undefined;
          const nativeMessageId = receiptEvent?.nativeId ?? providerMessageId ?? current.native.nativeMessageId;
          const sameTerminal = event.type === 'run_completed'
            ? current.state === 'completed' && current.native.delivery === 'observed'
            : event.type === 'run_failed'
              ? current.state === 'failed' && current.native.delivery === 'failed'
              : current.state === 'interrupted' && current.native.delivery === 'cancelled';
          if (sameTerminal) {
            if (!current.native.nativeMessageId && nativeMessageId) this.store.transitionNativeRun(current.id, [current.native.delivery], { nativeMessageId });
            continue;
          }
          if (!canApplyTurnOutcome(current)) continue;
          if (event.type === 'run_completed') {
            this.store.transitionNativeRun(current.id, [current.native.delivery], {
              delivery: 'observed', stage: 'completed', ...(nativeMessageId ? { nativeMessageId } : {}),
              timings: { ...current.native.timings, observedAt: current.native.timings?.observedAt ?? now(), completedAt: now() },
            }, { state: 'completed', error: undefined });
          } else if (event.type === 'run_failed') {
            const error = typeof event.data.error === 'string' ? event.data.error.slice(0, 1000) : 'Native backend reported that this run failed.';
            this.store.transitionNativeRun(current.id, [current.native.delivery], {
              delivery: 'failed', stage: 'provider_failed', ...(nativeMessageId ? { nativeMessageId } : {}),
              timings: { ...current.native.timings, completedAt: now() },
            }, { state: 'failed', error });
          } else {
            const reason = typeof event.data.reason === 'string' ? event.data.reason.slice(0, 1000) : undefined;
            this.store.transitionNativeRun(current.id, [current.native.delivery], {
              delivery: 'cancelled', stage: 'provider_cancelled', ...(nativeMessageId ? { nativeMessageId } : {}),
              timings: { ...current.native.timings, interruptedAt: now() },
            }, { state: 'interrupted', error: reason });
          }
          // A turn that ended is the conversation's latest activity. The sidebar orders each day by
          // when a conversation last ran, so a long turn must not fall back to the time its prompt
          // went out and sink below conversations that were merely touched since.
          this.store.updateSessionActivity(current.sessionId);
        } else if ((event.type === 'user_message_chunk' || event.type === 'native_input_receipt') && !current.native.nativeMessageId) {
          // A provider-echoed command id is durable receipt evidence. Its sequence may have been
          // rebuilt after restart and cannot be compared with the previous process's boundary.
          // An uncertain run is parked as interrupted only until its receipt turns up, which is this.
          const isFinished = current.native.delivery !== 'uncertain'
            && (['completed', 'failed', 'cancelled', 'interrupted'].includes(current.state) || ['failed', 'cancelled'].includes(current.native.delivery));
          const stoppedSteer = current.native.intent === 'steer' && current.native.stage === 'steer_stopped';
          const session = this.store.getSession(sessionId);
          const linkedSessionId = session.nativeSessionId;
          const expectedSessionId = current.native.nativeSessionId;
          if (expectedSessionId && linkedSessionId !== expectedSessionId) continue;
          this.store.transitionNativeRun(current.id, [current.native.delivery], isFinished
            ? { nativeMessageId: event.nativeId }
            : {
              delivery: stoppedSteer ? 'cancelled' : 'observed', stage: stoppedSteer ? 'interrupted' : 'executing', nativeMessageId: event.nativeId,
              ...(linkedSessionId ? { nativeSessionId: linkedSessionId } : {}),
              timings: { ...current.native.timings, observedAt: current.native.timings?.observedAt ?? now(), ...(event.type === 'native_input_receipt' ? { providerAcceptedAt: now() } : {}) },
            }, isFinished ? {} : { state: stoppedSteer || current.native.queueReleasedAt ? 'interrupted' : 'running', error: undefined });
          const outcome = this.pendingSteerOutcomes.get(current.id);
          if (outcome) { this.pendingSteerOutcomes.delete(current.id); this.observe(sessionId, { type: 'events', events: [outcome] }); }
        }
        if (event.type === 'user_message_chunk' || event.type === 'native_input_receipt') {
          const bound = this.store.getRun(current.id);
          this.trackTurnOutcome(bound);
          this.replayTurnOutcome(bound);
        }
      }
    }
    const runs = this.store.listUnfinishedNativeRuns(sessionId);
    for (const run of runs) {
      const delivery = run.native!;
      // A slash command answered in the CLI's own pane uses successful PTY submission as its completion
      // boundary. The CLI may also publish a transcript echo while deliver() is still resolving;
      // allowing that echo to move dispatching → observed would race the explicit command_sent
      // transition and leave the command pending forever when it has no assistant text output.
      const backendId = this.store.getSession(sessionId).backendId;
      if (this.traits(backendId).settlesSlashOnSubmit && isSlashCommand(delivery)) continue;
      if (delivery.intent !== 'steer' && message.type === 'events' && ['dispatching', 'input_sent', 'uncertain', 'observed'].includes(delivery.delivery)) {
        const session = this.store.getSession(sessionId);
        const linkedSessionId = session.nativeSessionId;
        const expectedSessionId = delivery.nativeSessionId;
        if ((delivery.terminalId && session.terminalId !== delivery.terminalId) || (expectedSessionId && expectedSessionId !== linkedSessionId)) continue;
        // Untagged echoes need the captured boundary; protocol command ids identify the
        // submission across restarts even when the transcript's sequence numbers have changed.
        // This is evidence of receipt, never a license to replay an ambiguous input.
        // The CLI's stored copy can differ from what we sent by a few mangled characters, so the
        // receipt is recognised through the shared tolerant comparison rather than by exact text.
        // Exact equality would leave this run `uncertain` forever, fencing every later message.
        const sent = (delivery.renderedText ?? delivery.input.text).trim();
        const backendId = session.backendId;
        const afterBaseline = message.events.filter(event => event.sequence > (delivery.baselineSequence ?? Infinity));
        const matches = this.traits(backendId).untaggedEcho
          ? afterBaseline.filter(event => event.type === 'user_message_chunk'
            && samePromptText(sent, ((event.data.content as { text?: string } | undefined)?.text ?? '').trim()))
          : message.events.filter(event => event.type === 'user_message_chunk' && event.data.commandId === run.commandId);
        if (!delivery.nativeMessageId && matches.length === 1) {
          this.store.transitionNativeRun(run.id, ['dispatching', 'input_sent', 'uncertain'], {
            delivery: 'observed', nativeMessageId: matches[0]!.nativeId,
            ...(matches[0]!.nativeTurnId ? { nativeTurnId: matches[0]!.nativeTurnId } : {}),
            ...(session.nativeSessionId ? { nativeSessionId: session.nativeSessionId } : {}),
            stage: 'executing', timings: { ...delivery.timings, observedAt: now() },
          }, { state: delivery.queueReleasedAt ? 'interrupted' : 'running', error: undefined });
          const bound = this.store.getRun(run.id);
          this.trackTurnOutcome(bound);
          this.replayTurnOutcome(bound);
        }
        const updated = this.store.getRun(run.id);
        if (updated.native?.delivery === 'observed' && !updated.native.timings?.firstOutputAt && message.events.some(event => event.sequence > (delivery.baselineSequence ?? Infinity) && event.type === 'agent_message_chunk')) {
          this.store.transitionNativeRun(run.id, ['observed'], { timings: { ...updated.native.timings, firstOutputAt: updated.native.timings?.firstOutputAt ?? now() } });
        }
      }
      if (message.type === 'status') {
        this.trackTurnOutcome(this.store.getRun(run.id), message.status);
        let current = this.store.getRun(run.id);
        // Keep historical released inputs observable until an actual end arrives. An idle timer
        // must not remove their observer or turn their old receipt into a new running task.
        if (current.native?.queueReleasedAt) { this.idleSince.delete(run.id); continue; }
        const matchingTerminal = this.matchingTerminal(current);
        const target = message.status.activeTurn;
        const linkedSession = this.store.getSession(sessionId);
        const expectedSessionId = current.native?.nativeSessionId;
        if ((expectedSessionId && expectedSessionId !== linkedSession.nativeSessionId)
          || current.native?.terminalId && !matchingTerminal) {
          this.idleSince.delete(run.id);
          continue;
        }
        if (current.native?.delivery === 'uncertain' && current.native.stage === 'turn_outcome_unknown'
          && current.native.nativeMessageId && current.native.nativeSessionId
          && this.traits(current.native.backendId).reportsTurnOutcome
          && ['busy', 'attention', 'idle'].includes(message.status.phase)
          && (!target || target.nativeSessionId === current.native.nativeSessionId)
          && current.native.nativeSessionId === linkedSession.nativeSessionId) {
          // Older service versions parked a known receipt as uncertain after losing its Stop.
          // Resume observation from the same chat's current state, without changing delivery facts.
          current = this.store.transitionNativeRun(run.id, ['uncertain'], {
            delivery: 'observed', stage: 'executing', expectsTurnOutcome: true,
          }, { state: 'running', error: undefined }) ?? current;
        }
        if (current.native?.delivery === 'observed' && current.native.nativeMessageId && current.native.nativeTurnId
          && (current.native.expectsTurnOutcome || current.native.intent === 'steer') && target
          && ['busy', 'attention'].includes(message.status.phase)
          && target.nativeSessionId === current.native.nativeSessionId
          && target.turnId !== current.native.nativeTurnId) {
          // A newer turn in this exact chat proves the old turn is no longer active, not that it
          // succeeded. Its known receipt must not fence that newer work or require a resend check.
          this.store.transitionNativeRun(run.id, ['observed'], {
            delivery: 'cancelled', stage: 'turn_outcome_unknown', timings: { ...current.native.timings, interruptedAt: now() },
          }, { state: 'interrupted', error: '会话已进入后续任务，但未收到原任务的完成确认；消息已送达，不会重发。' });
          this.idleSince.delete(run.id);
          queueMicrotask(() => this.kick());
          continue;
        }
        if (current.native?.delivery === 'uncertain' && current.native.stage === 'runtime_exit'
          && current.native.nativeMessageId
          && ['busy', 'idle', 'attention'].includes(message.status.phase)
          && matchingTerminal && matchingTerminal.state !== 'exited') {
          // runtime_exit is recoverable only when an exact transcript receipt already bound this
          // run, the same persisted CLI terminal still exists for this session/chat, and its
          // current state is busy/idle/attention. Terminal epoch changes track browser leases,
          // so they deliberately do not participate in process identity here.
          current = this.store.transitionNativeRun(run.id, ['uncertain'], {
            delivery: 'observed', stage: 'executing',
          }, { state: 'running', error: undefined }) ?? current;
        }
        if (current.native?.delivery === 'observed' && !current.native.intent && !current.native.expectsTurnOutcome && !(current.native.nativeTurnId && this.traits(current.native.backendId).completesOnTurnEvent) && message.status.phase === 'idle' && (current.native.timings?.firstOutputAt || current.native.timings?.busyAt) && !this.interruptingSessions.has(sessionId)) {
          this.store.transitionNativeRun(run.id, ['observed'], { stage: 'completed', timings: { ...current.native.timings, completedAt: now() } }, { state: 'completed' });
          this.store.updateSessionActivity(sessionId);
        } else if (message.status.phase === 'busy' && ['dispatching', 'input_sent', 'observed'].includes(current.native?.delivery ?? '') && !current.native?.timings?.busyAt) {
          this.store.transitionNativeRun(run.id, ['dispatching', 'input_sent', 'observed'], { timings: { ...current.native?.timings, busyAt: now() } });
        } else if (message.status.phase === 'offline' && ['dispatching', 'input_sent', 'observed'].includes(current.native?.delivery ?? '')) {
          const mayBeRunning = this.traits(this.store.getSession(sessionId).backendId).offlineMayBeRunning;
          const terminalExited = this.matchingTerminal(current)?.state === 'exited';
          if (terminalExited) {
            if (current.native?.delivery === 'observed') {
              // The CLI echoed this prompt, so delivery is settled, and an exited CLI cannot still be
              // running it. Close the turn like an interrupt instead of fencing later messages.
              this.store.transitionNativeRun(run.id, ['observed'], { delivery: 'cancelled', stage: 'runtime_exit', timings: { ...current.native.timings, interruptedAt: now() } }, { state: 'interrupted', error: 'CLI 在回复过程中退出，这条回复可能不完整。' });
            } else {
              const startupError = this.store.getSession(sessionId).error;
              this.store.transitionNativeRun(run.id, ['dispatching', 'input_sent'], { delivery: 'uncertain', stage: 'runtime_exit' }, { state: 'interrupted', error: startupError ? `${startupError} 尚未确认消息是否送达，系统不会自动重发。` : 'Native backend exited before delivery could be confirmed. The message will not be resent automatically.' });
            }
          } else if (mayBeRunning && current.native?.delivery !== 'observed') {
            // A lost app-server or hook connection does not prove that the native CLI child
            // stopped. Fence the run and its workspace until a later idle status or terminal exit.
            this.store.transitionNativeRun(run.id, ['dispatching', 'input_sent', 'observed'], {
              delivery: 'uncertain', stage: 'runtime_exit',
            }, { state: 'interrupted', error: 'Native backend connection was lost while its process may still be running. The message will not be resent automatically.' });
          }
        }
        this.reconcileIdleRun(sessionId, run.id, message.status);
      }
    }
  }

  private turnOutcomeScope(sessionId: string, event: NativeWorkbenchEvent): { key: string; nativeSessionId: string; turnId: string } | undefined {
    if (event.sessionId !== sessionId || !event.nativeTurnId) return undefined;
    const command = typeof event.data.commandId === 'string' ? this.store.findRunByCommand(sessionId, event.data.commandId) : undefined;
    const nativeSessionId = typeof event.data.nativeSessionId === 'string' ? event.data.nativeSessionId
      : command?.native?.nativeSessionId;
    const session = this.store.getSession(sessionId);
    if (!nativeSessionId || nativeSessionId !== session.nativeSessionId) return undefined;
    if (command?.native && ((command.native.nativeSessionId ?? nativeSessionId) !== nativeSessionId
      || command.native.nativeTurnId && command.native.nativeTurnId !== event.nativeTurnId)) return undefined;
    return { key: JSON.stringify([sessionId, nativeSessionId, event.nativeTurnId]), nativeSessionId, turnId: event.nativeTurnId };
  }

  /** Take all correction evidence before receipts can replay cached outcomes from this batch. */
  private reconcileTurnCorrections(sessionId: string, events: NativeWorkbenchEvent[]): void {
    const newest = new Map<string, { nativeSessionId: string; turnId: string; revision: number; type: string }>();
    for (const event of events) {
      if (!isTurnOutcome(event)) continue;
      const scope = this.turnOutcomeScope(sessionId, event);
      if (!scope) continue;
      const revision = outcomeRevision(event);
      if (revision > (newest.get(scope.key)?.revision ?? 0)) newest.set(scope.key, { ...scope, revision, type: event.type });
    }
    for (const [key, correction] of newest) {
      // Revision 1 is the default fence, so only corrections are kept, and only the newest few.
      if (correction.revision <= (this.turnOutcomeRevisions.get(key) ?? 1)) continue;
      this.turnOutcomeRevisions.delete(key);
      this.turnOutcomeRevisions.set(key, correction.revision);
      if (this.turnOutcomeRevisions.size > 256) this.turnOutcomeRevisions.delete(this.turnOutcomeRevisions.keys().next().value!);
      this.pendingTurnOutcomes.delete(key);
      for (const run of this.store.findRunsByNativeTurn(sessionId, correction.nativeSessionId, correction.turnId)) {
        this.pendingSteerOutcomes.delete(run.id);
        const native = run.native!;
        // Only the provider's mistaken cancellation is retractable. User stops, tracking
        // resolutions, actual failures and successful completions remain terminal. The fences are
        // not persisted: a restart replays the current end, and a cancellation that still stands
        // already matches the provider-cancelled Run.
        if (correction.type === 'run_cancelled' || run.state !== 'interrupted' || native.delivery !== 'cancelled' || native.stage !== 'provider_cancelled') continue;
        this.idleSince.delete(run.id);
        this.store.transitionNativeRun(run.id, ['cancelled'], {
          delivery: native.nativeMessageId ? 'observed' : 'input_sent',
          stage: native.nativeMessageId ? 'executing' : native.intent === 'steer' ? 'steer_confirmation' : 'confirmation',
          expectsTurnOutcome: true,
        }, { state: 'running', error: undefined });
      }
    }
  }

  /**
   * A provider that stays idle is no longer running this run, yet a lost completion event (hook
   * Stop, app-server turn end) would leave it `observed` and the session busy for ever. An active
   * turn the status still claims for this very run is that same lost event's residue — for a
   * hook-driven provider it is set by a tool hook and only the lost Stop clears it — so it cannot veto the idle screen;
   * a claim naming another turn still can. Delivery is already confirmed, so nothing can be sent
   * twice: close it as interrupted with a `turn_outcome_unknown` stage (shown as "result
   * unconfirmed") that no longer fences later sends. A completion or failure event for the same
   * turn that turns up later still sets the real result.
   *
   * A run that is explicitly waiting for its turn outcome gets `IDLE_OUTCOME_GRACE_MS` instead of
   * the plain idle window: another Stop hook may still be running after ours, and judging the
   * result unconfirmed while it works is a false alarm the late outcome would then have to correct.
   */
  private reconcileIdleRun(sessionId: string, runId: string, status: NativeStatus): void {
    const current = this.store.getRun(runId);
    const claimed = status.activeTurn;
    const staleClaim = claimed !== undefined && claimed.turnId === current.native?.nativeTurnId
      && (current.native?.nativeSessionId === undefined || claimed.nativeSessionId === current.native.nativeSessionId);
    if (status.phase !== 'idle' || (claimed && !staleClaim) || current.native?.delivery !== 'observed' || current.state !== 'running' || this.interruptingSessions.has(sessionId)) {
      this.idleSince.delete(runId);
      return;
    }
    const since = this.idleSince.get(runId) ?? now();
    this.idleSince.set(runId, since);
    // A run waiting for its reported turn outcome gets the longer grace: the outcome is already
    // known to be coming, and another Stop hook may simply still be running.
    const window = current.native?.expectsTurnOutcome
      ? (this.options.idleOutcomeGraceMs ?? IDLE_OUTCOME_GRACE_MS)
      : (this.options.idleReconcileMs ?? IDLE_RECONCILE_MS);
    if (now() - since < window) return;
    this.idleSince.delete(runId);
    const closed = this.store.transitionNativeRun(runId, ['observed'], {
      delivery: 'cancelled', stage: 'turn_outcome_unknown', timings: { ...current.native.timings, interruptedAt: now() },
    }, { state: 'interrupted', error: '会话已回到空闲，但未收到该任务的完成确认，结果未确认；消息已送达，不会重发。' });
    if (closed) queueMicrotask(() => this.kick());
  }

  private trackTurnOutcome(run: Run, status?: NativeStatus): void {
    const native = run.native, target = status?.activeTurn;
    if (!native || native.intent || !this.traits(native.backendId).reportsTurnOutcome) return;
    if (target) {
      this.hookedTurns.add(JSON.stringify([run.sessionId, target.nativeSessionId, target.turnId]));
      if (this.hookedTurns.size > 256) this.hookedTurns.delete(this.hookedTurns.values().next().value!);
    }
    if (native.expectsTurnOutcome || !native.nativeSessionId || !native.nativeTurnId
      || !this.hookedTurns.has(JSON.stringify([run.sessionId, native.nativeSessionId, native.nativeTurnId]))) return;
    this.store.transitionNativeRun(run.id, [native.delivery], { expectsTurnOutcome: true });
  }

  private replayTurnOutcome(run: Run): void {
    const native = run.native;
    if (!native || native.intent || !native.nativeMessageId || !native.nativeSessionId || !native.nativeTurnId) return;
    const key = JSON.stringify([run.sessionId, native.nativeSessionId, native.nativeTurnId]);
    const outcome = this.pendingTurnOutcomes.get(key);
    if (!outcome) return;
    this.pendingTurnOutcomes.delete(key);
    this.observe(run.sessionId, { type: 'events', events: [outcome] });
  }

  /** Returns persisted terminal state only when the Run still belongs to this exact session/chat. */
  private matchingTerminal(run: Run): TerminalInfo | undefined {
    const details = run.native;
    if (!details?.terminalId) return undefined;
    const session = this.store.getSession(run.sessionId);
    const linkedSessionId = session.nativeSessionId;
    const expectedSessionId = details.nativeSessionId;
    if (session.kind !== 'native' || session.terminalId !== details.terminalId || (expectedSessionId && linkedSessionId !== expectedSessionId)) return undefined;
    try {
      const terminal = this.store.getTerminal(details.terminalId);
      if (terminal.id !== details.terminalId || terminal.projectId !== session.projectId || !isAgentTerminal(terminal) || terminal.sessionId !== session.id) return undefined;
      return terminal;
    } catch {
      return undefined;
    }
  }

  cancel(sessionId: string, runId: string): Run {
    const run = this.store.getRun(runId);
    if (run.sessionId !== sessionId || !run.native) throw new AppError('RUN_NOT_FOUND', 'The message does not exist', 404);
    const changed = this.store.transitionNativeRun(runId, ['queued', 'preparing'], { delivery: 'cancelled', stage: 'cancelled' }, { state: 'cancelled' });
    if (!changed && !['cancelled', 'completed', 'failed'].includes(run.state)) throw new AppError('RUN_ALREADY_DISPATCHED', 'The message may already be running; use Stop instead', 409);
    this.pendingSteerOutcomes.delete(runId);
    return changed ?? run;
  }

  /** Checks only the persisted request and existing provider evidence; never submits input. */
  check(sessionId: string, runId: string): Promise<NativeRunRecovery> {
    const key = JSON.stringify([sessionId, runId]);
    const existing = this.recoveryChecks.get(key);
    if (existing) return existing;
    const task = this.readRecovery(sessionId, runId).finally(() => {
      if (this.recoveryChecks.get(key) === task) this.recoveryChecks.delete(key);
    });
    this.recoveryChecks.set(key, task);
    return task;
  }

  private recoveryRun(sessionId: string, runId: string): Run {
    const run = this.store.getRun(runId);
    if (run.sessionId !== sessionId || !run.native) throw new AppError('RUN_NOT_FOUND', 'The message does not exist', 404);
    return run;
  }

  private queuedRunIds(sessionId: string): string[] {
    return this.store.listUnfinishedNativeRuns(sessionId)
      .filter(run => run.native?.delivery === 'queued' && !run.native.intent).map(run => run.id);
  }

  private async readRecovery(sessionId: string, runId: string): Promise<NativeRunRecovery> {
    this.recoveryRun(sessionId, runId);
    await this.native.reconcile?.(sessionId);
    const snapshot = await this.native.snapshot(sessionId);
    this.observe(sessionId, { type: 'events', events: snapshot.events });
    this.observe(sessionId, { type: 'status', status: snapshot.status });
    let run = this.recoveryRun(sessionId, runId);
    const session = this.store.getSession(sessionId);
    const native = run.native!;
    const status = snapshot.status;
    let canContinue = native.delivery === 'uncertain' && !native.queueReleasedAt
      && !session.archivedAt && !this.workers.has(sessionId) && !this.interruptingSessions.has(sessionId)
      && !this.workspaceReserved(session) && status.phase === 'idle' && !status.activeTurn
      && !status.activity?.background && !status.activity?.compacting
      && Boolean(native.nativeSessionId && native.nativeSessionId === session.nativeSessionId)
      && (!native.terminalId || native.terminalId === session.terminalId);
    if (canContinue) canContinue = await this.native.canReleaseInput?.(session, run) ?? false;
    // The proof awaited I/O. A receipt or rebind during that read invalidates the offered action.
    run = this.recoveryRun(sessionId, runId);
    const latest = this.store.getSession(sessionId);
    const currentStatus = this.native.status(sessionId);
    canContinue &&= run.native?.delivery === 'uncertain' && !run.native.queueReleasedAt
      && latest.nativeSessionId === session.nativeSessionId && latest.terminalId === session.terminalId
      && currentStatus.phase === 'idle' && !currentStatus.activeTurn
      && !currentStatus.activity?.background && !currentStatus.activity?.compacting;
    return { run, canContinue, queuedRunIds: this.queuedRunIds(sessionId) };
  }

  /** A user may release a proven-empty input, while late evidence still corrects its history. */
  async continue(sessionId: string, runId: string, queuedRunIds: string[]): Promise<Run> {
    const run = this.recoveryRun(sessionId, runId);
    if (run.native?.queueReleasedAt) return run;
    if (this.recoveryActions.has(sessionId)) throw new AppError('NATIVE_RECOVERY_BUSY', 'A recovery action is already running', 409);
    this.recoveryActions.add(sessionId);
    try {
      return await this.runtime.withSession(sessionId, async () => {
        const checked = await this.readRecovery(sessionId, runId);
        if (!checked.canContinue) throw new AppError('NATIVE_RECOVERY_UNSAFE', 'The original input cannot yet be safely released', 409);
        if (JSON.stringify(checked.queuedRunIds) !== JSON.stringify(queuedRunIds)) throw new AppError('NATIVE_QUEUE_CHANGED', 'The queued messages changed; review them before continuing', 409);
        return this.store.transitionNativeRun(runId, ['uncertain'], { queueReleasedAt: new Date().toISOString() })
          ?? this.recoveryRun(sessionId, runId);
      });
    } finally { this.recoveryActions.delete(sessionId); this.kick(); }
  }

  /**
   * Stop the in-flight CLI turn and, when requested, accept its replacement before the dispatch
   * fence is released. This makes the stop receipt and follow-up acceptance one ordered action:
   * no queued prompt can slip between the two HTTP calls.
   */
  interrupt(sessionId: string, stop?: NativeStopRequest): Promise<Run | undefined> {
    return this.beginInterrupt(sessionId, undefined, undefined, undefined, stop);
  }

  interruptAndSend(sessionId: string, commandId: string, submit: () => Run, stop?: NativeStopRequest, replacementFingerprint?: string): Promise<Run> {
    if (!commandId || commandId.length > 200) return Promise.reject(new AppError('INVALID_COMMAND_ID', 'commandId must be a non-empty string up to 200 characters'));
    if (stop && !replacementFingerprint) return Promise.reject(new AppError('NATIVE_STOP_CONFLICT', 'The replacement message must keep its original identity', 409));
    return this.beginInterrupt(sessionId, commandId, submit, undefined, stop, replacementFingerprint).then(run => {
      if (!run) throw new AppError('NATIVE_INTERRUPT_SUBMISSION_FAILED', 'The turn stopped, but the follow-up message could not be queued', 500);
      return run;
    });
  }

  /** Stop the current turn and promote an existing queued run ahead of the rest of its queue. */
  sendQueuedNow(sessionId: string, runId: string, stop?: NativeStopRequest): Promise<Run> {
    const operationKey = `queued:${runId}`;
    const inFlight = this.interruptionTasks.get(sessionId);
    if (!stop && inFlight?.commandId === operationKey) {
      return inFlight.task.then(run => {
        if (!run) throw new AppError('NATIVE_INTERRUPT_SUBMISSION_FAILED', 'The turn stopped, but the queued message could not be promoted', 500);
        return run;
      });
    }

    let run: Run;
    try { run = this.store.getRun(runId); }
    catch (error) { return Promise.reject(error); }
    if (run.sessionId !== sessionId || !run.native) return Promise.reject(new AppError('RUN_NOT_FOUND', 'The message does not exist', 404));
    if (run.native.intent === 'steer') return Promise.reject(new AppError('STEER_ACTION_UNSUPPORTED', 'A steer message cannot interrupt and be sent as a new turn', 409));
    // Repeated clicks after a successful promotion are idempotent and must not interrupt the
    // follow-up that may already be running.
    if (run.native.stage === 'interrupt_followup' || Number.isFinite(run.native.timings?.promotedAt)) return Promise.resolve(run);
    if (run.native.delivery !== 'queued' || run.state !== 'queued') {
      return Promise.reject(new AppError('NATIVE_RUN_NOT_QUEUED', 'Only a message that is still queued can run now', 409));
    }

    return this.beginInterrupt(sessionId, operationKey, () => {
      const current = this.store.getRun(runId);
      if (current.sessionId !== sessionId || !current.native) throw new AppError('RUN_NOT_FOUND', 'The message does not exist', 404);
      if (current.native.stage === 'interrupt_followup' || Number.isFinite(current.native.timings?.promotedAt)) return current;
      if (current.native.delivery !== 'queued' || current.state !== 'queued') {
        throw new AppError('NATIVE_RUN_NOT_QUEUED', 'The queued message was cancelled or already started', 409);
      }
      this.nextAttempt.delete(runId);
      return current;
    }, runId, stop).then(promoted => {
      if (!promoted) throw new AppError('NATIVE_INTERRUPT_SUBMISSION_FAILED', 'The turn stopped, but the queued message could not be promoted', 500);
      return promoted;
    });
  }

  private stopReceipt(sessionId: string, stop: NativeStopRequest): StopReceipt | undefined {
    return this.store.getSetting<Record<string, StopReceipt>>(`native-stops:${sessionId}`, {})[JSON.stringify(stop.requestId)];
  }

  private saveStopReceipt(sessionId: string, receipt: StopReceipt): void {
    const key = `native-stops:${sessionId}`;
    // Keep the request tombstone: eviction would turn an old retry into another Stop.
    this.store.setSetting(key, { ...this.store.getSetting<Record<string, StopReceipt>>(key, {}), [JSON.stringify(receipt.request.requestId)]: receipt });
  }

  private stopFingerprint(stop: NativeStopRequest, operation: string, replacementFingerprint?: string): string {
    return JSON.stringify([operation, stop.requestId, stop.nativeSessionId, stop.turnId ?? null,
      stop.terminalId ?? null, stop.terminalEpoch ?? null, replacementFingerprint ?? null]);
  }

  private assertStopBinding(sessionId: string, stop: NativeStopRequest, receipt?: StopReceipt): void {
    const session = this.store.getSession(sessionId);
    const terminalId = receipt?.terminalId ?? stop.terminalId;
    const epoch = receipt?.terminalEpoch ?? stop.terminalEpoch;
    let terminal: TerminalInfo | undefined;
    if (terminalId) { try { terminal = this.store.getTerminal(terminalId); } catch { /* missing identity is not a stop receipt */ } }
    if ((session.nativeSessionId ?? '') !== stop.nativeSessionId
      || (terminalId !== undefined && (session.terminalId !== terminalId || !terminal || terminal.sessionId !== sessionId || terminal.projectId !== session.projectId))
      || (epoch !== undefined && terminal?.epoch !== epoch)
      || (receipt && session.terminalId && !terminalId)) {
      throw new AppError('NATIVE_STOP_TARGET_CHANGED', 'The original task changed; no stop was sent', 409);
    }
  }

  private assertStopTarget(sessionId: string, stop: NativeStopRequest): void {
    this.assertStopBinding(sessionId, stop);
    const status = this.native.status(sessionId);
    if (status.phase === 'offline' || status.connection && status.connection.state !== 'connected') {
      throw new AppError('NATIVE_STOP_UNCONFIRMED', 'Reconnect before stopping the original task', 409);
    }
    if ((status.activeTurn?.turnId ?? undefined) !== stop.turnId
      || (status.activeTurn && status.activeTurn.nativeSessionId !== stop.nativeSessionId)) {
      throw new AppError('NATIVE_STOP_TARGET_CHANGED', 'The original task changed; no stop was sent', 409);
    }
  }

  /** A targeted Stop never resolves another turn or a previously released historical input. */
  private stopTargets(sessionId: string, stop?: NativeStopRequest): Map<string, NativeDeliveryState> {
    return new Map(this.store.listUnfinishedNativeRuns(sessionId).filter(run => {
      const native = run.native;
      if (!native || native.delivery === 'queued') return false;
      if (!stop) return true;
      return !native.queueReleasedAt && native.nativeSessionId === stop.nativeSessionId
        && native.nativeTurnId === stop.turnId
        && (stop.terminalId === undefined || native.terminalId === stop.terminalId)
        && (stop.terminalEpoch === undefined || native.terminalEpoch === undefined || native.terminalEpoch === stop.terminalEpoch);
    }).map(run => [run.id, run.native!.delivery]));
  }

  /** Exact provider ends or the original process's exit establish an end; idle alone never does. */
  private stopEnded(sessionId: string, receipt: StopReceipt, events: NativeWorkbenchEvent[]): boolean {
    const stop = receipt.request;
    if (receipt.terminalId && receipt.terminalEpoch !== undefined) {
      const terminal = this.store.getTerminal(receipt.terminalId);
      if (terminal.epoch === receipt.terminalEpoch && terminal.state === 'exited') return true;
    }
    if (!stop.turnId) return false;
    const outcome = (event: NativeWorkbenchEvent) => ['run_completed', 'run_failed', 'run_cancelled'].includes(event.type)
      && this.turnOutcomeScope(sessionId, event)?.nativeSessionId === stop.nativeSessionId && event.nativeTurnId === stop.turnId
      && outcomeRevision(event) >= (this.turnOutcomeRevisions.get(JSON.stringify([sessionId, stop.nativeSessionId, stop.turnId])) ?? 1);
    if (events.some(outcome)) return true;
    const key = JSON.stringify([sessionId, stop.nativeSessionId, stop.turnId]);
    const pending = this.pendingTurnOutcomes.get(key);
    if (pending && outcome(pending)) return true;
    return this.store.findRunsByNativeTurn(sessionId, stop.nativeSessionId, stop.turnId).some(run =>
      run.native?.stage === 'provider_cancelled' && run.native.delivery === 'cancelled' && run.state === 'interrupted'
      || run.native?.stage === 'provider_failed' && run.state === 'failed'
      || run.native?.stage === 'completed' && run.state === 'completed');
  }

  private async recoverStop(sessionId: string, receipt: StopReceipt, submit?: () => Run, promotedRunId?: string): Promise<Run | undefined> {
    this.assertStopBinding(sessionId, receipt.request, receipt);
    await this.native.reconcile?.(sessionId);
    const snapshot = await this.native.snapshot(sessionId);
    this.observe(sessionId, { type: 'events', events: snapshot.events });
    this.observe(sessionId, { type: 'status', status: snapshot.status });
    this.assertStopBinding(sessionId, receipt.request, receipt);
    if (!this.stopEnded(sessionId, receipt, snapshot.events)) {
      throw new AppError('NATIVE_STOP_UNCONFIRMED', 'The previous stop has not been confirmed; check the original task status', 409);
    }
    const session = this.store.getSession(sessionId);
    const targets = this.stopTargets(sessionId, receipt.request);
    const original = (receipt.targets ?? []).map(([id]) => this.store.getRun(id))
      .find(run => !run.native?.queueReleasedAt && run.native?.nativeSessionId === receipt.request.nativeSessionId
        && run.native?.nativeTurnId === receipt.request.turnId)
      ?? this.store.findRunsByNativeTurn(sessionId, receipt.request.nativeSessionId, receipt.request.turnId ?? '').find(run => !run.native?.intent && !run.native?.queueReleasedAt);
    // A pending stop may have left input in the CLI's composer/queue. Only the backend can prove
    // it absent; a confirmed turn end alone does not make a replacement safe to submit.
    if (submit || this.traits(session.backendId).stopKeepsPendingInput) {
      const status = this.native.status(sessionId);
      if (status.phase !== 'idle' || status.activeTurn || status.activity?.background || status.activity?.compacting
        || status.connection && status.connection.state !== 'connected'
        || !original || !await this.native.canReleaseInput?.(session, original)) {
        throw new AppError('NATIVE_STOP_UNCONFIRMED', 'The original input has not been confirmed safe to continue', 409);
      }
      this.assertStopBinding(sessionId, receipt.request, receipt);
      const latest = this.native.status(sessionId);
      if (latest.phase !== 'idle' || latest.activeTurn || latest.activity?.background || latest.activity?.compacting
        || latest.connection && latest.connection.state !== 'connected') {
        throw new AppError('NATIVE_STOP_TARGET_CHANGED', 'A newer task is running; the replacement was not sent', 409);
      }
    }
    return this.store.transaction(() => {
      const interrupted = this.settleInterrupted(targets, this.traits(session.backendId));
      const run = submit ? this.acceptFollowUp(submit, promotedRunId) : interrupted;
      this.saveStopReceipt(sessionId, { ...receipt, state: 'completed', ...(run ? { runId: run.id } : {}) });
      return run;
    });
  }

  private beginInterrupt(sessionId: string, commandId?: string, submit?: () => Run, promotedRunId?: string, stop?: NativeStopRequest, replacementFingerprint?: string): Promise<Run | undefined> {
    if (this.workspaceReserved(this.store.getSession(sessionId))) return Promise.reject(this.workspaceBusy());
    const operation = commandId ?? 'stop';
    const operationKey = stop ? `stop:${stop.requestId}` : commandId;
    const fingerprint = stop ? this.stopFingerprint(stop, operation, replacementFingerprint) : undefined;
    const receipt = stop ? this.stopReceipt(sessionId, stop) : undefined;
    if (receipt && this.stopFingerprint(receipt.request, receipt.operation, receipt.replacementFingerprint) !== fingerprint) {
      return Promise.reject(new AppError('NATIVE_STOP_CONFLICT', 'This stop request belongs to a different operation', 409));
    }
    if (receipt?.state === 'completed') return Promise.resolve(receipt.runId ? this.store.getRun(receipt.runId) : undefined);
    const existing = this.interruptionTasks.get(sessionId);
    if (existing) {
      if (operationKey && existing.commandId === operationKey) {
        if (existing.fingerprint !== fingerprint) return Promise.reject(new AppError('NATIVE_STOP_CONFLICT', 'This stop request belongs to a different operation', 409));
        return existing.task;
      }
      return Promise.reject(new AppError('NATIVE_INTERRUPT_IN_PROGRESS', 'The current turn is stopping; try again shortly', 409));
    }
    if (receipt && this.recoveryActions.has(sessionId)) return Promise.reject(new AppError('NATIVE_RECOVERY_BUSY', 'A recovery action is already running', 409));
    if (!receipt) {
      try { if (stop) this.assertStopTarget(sessionId, stop); }
      catch (error) { return Promise.reject(error); }
    }
    this.interruptingSessions.add(sessionId);
    if (receipt) this.recoveryActions.add(sessionId);
    const targets = this.stopTargets(sessionId, stop);
    const task = Promise.resolve().then(() => {
      if (receipt) return this.runtime.withSession(sessionId, () => this.recoverStop(sessionId, receipt, submit, promotedRunId));
      // This releases only a read-only receipt wait; every external Stop remains under the lock.
      this.native.requestInterrupt?.(sessionId);
      return this.runtime.withSession(sessionId, async () => {
        if (stop) {
          this.assertStopTarget(sessionId, stop);
          const session = this.store.getSession(sessionId);
          const terminal = session.terminalId ? this.store.getTerminal(session.terminalId) : undefined;
          this.saveStopReceipt(sessionId, { request: stop, operation, state: 'pending', createdAt: new Date().toISOString(),
            ...(replacementFingerprint ? { replacementFingerprint } : {}), targets: [...targets],
            ...(terminal ? { terminalId: terminal.id, terminalEpoch: terminal.epoch } : {}) });
        }
        let run: Run | undefined;
        try { run = await this.performInterrupt(sessionId, submit, targets, promotedRunId, stop); }
        catch (error) {
          if (!stop || error instanceof AppError && error.code === 'NATIVE_STOP_TARGET_CHANGED') throw error;
          this.saveStopReceipt(sessionId, { ...this.stopReceipt(sessionId, stop)!, error: {
            ...(error instanceof AppError ? { code: error.code } : {}),
            message: redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 1000),
          } });
          throw new AppError('NATIVE_STOP_UNCONFIRMED', 'The stop has not been confirmed; check the original task status', 409);
        }
        if (stop) this.saveStopReceipt(sessionId, { ...this.stopReceipt(sessionId, stop)!, state: 'completed', ...(run ? { runId: run.id } : {}) });
        return run;
      });
    }).finally(() => {
      this.interruptingSessions.delete(sessionId);
      if (receipt) this.recoveryActions.delete(sessionId);
      if (this.interruptionTasks.get(sessionId)?.task === task) this.interruptionTasks.delete(sessionId);
      this.kick();
    });
    this.interruptionTasks.set(sessionId, { ...(operationKey ? { commandId: operationKey } : {}), ...(fingerprint ? { fingerprint } : {}), task });
    return task;
  }

  private async performInterrupt(sessionId: string, submit: (() => Run) | undefined, targets: Map<string, NativeDeliveryState>, promotedRunId?: string, stop?: NativeStopRequest): Promise<Run | undefined> {
    const session = this.store.getSession(sessionId);
    if (session.kind !== 'native') throw new AppError('NOT_NATIVE', 'Only native conversations can be interrupted', 409);
    if (!session.terminalId && targets.size > 0 && !this.native.sendRun) {
      throw new AppError('TERMINAL_NOT_RUNNING', 'Could not confirm whether the current turn stopped', 409);
    }
    let accepted: Run | undefined;
    // A backend that replaces its turn itself gets the follow-up straight away. Should it never
    // reach the CLI, the run is still first in the queue and the stop below goes ahead as before.
    if (submit && !stop && !this.draining && session.terminalId && await this.native.supportsSendNow?.(session) === true) {
      accepted = this.acceptFollowUp(submit, promotedRunId);
      if (accepted.native && !isSlashCommand(accepted.native) && accepted.native.delivery === 'queued' && accepted.state === 'queued') {
        await this.execute(accepted.id, { now: true });
        const after = this.store.getRun(accepted.id);
        if (after.native?.delivery === 'failed') return after;
        if (after.native?.delivery !== 'queued') {
          this.settleInterrupted(targets, this.traits(session.backendId));
          return after;
        }
        this.nextAttempt.delete(after.id);
      }
    }
    // NativeService only resolves after the live pane is confirmed idle or the same terminal
    // epoch exits. An error leaves the active run and the new draft untouched.
    if (stop) this.assertStopTarget(sessionId, stop);
    if (this.native.sendRun) await this.native.interrupt(sessionId, { clearPrompt: Boolean(submit), ...(stop ? { expectedStop: stop } : {}) });
    else await this.native.interrupt(session, { clearPrompt: Boolean(submit), ...(stop ? { expectedStop: stop } : {}) });

    const interrupted = this.settleInterrupted(targets, this.traits(session.backendId));
    if (submit) return accepted ? this.store.getRun(accepted.id) : this.acceptFollowUp(submit, promotedRunId);
    return interrupted;
  }

  /** Accepts the follow-up of an interrupt as the first run of its queue. */
  private acceptFollowUp(submit: () => Run, promotedRunId?: string): Run {
    const accepted = submit();
    if (accepted.native?.delivery === 'queued' && accepted.state === 'queued') {
      return this.store.transitionNativeRun(accepted.id, ['queued'], {
        stage: 'interrupt_followup',
        ...(accepted.id === promotedRunId ? { timings: { ...accepted.native.timings, promotedAt: accepted.native.timings?.promotedAt ?? now() } } : {}),
      }) ?? accepted;
    }
    return accepted;
  }

  /** Closes the runs a confirmed stop ended; returns the last one the CLI had been running. */
  private settleInterrupted(targets: Map<string, NativeDeliveryState>, traits: NativeBackendTraits): Run | undefined {
    let interrupted: Run | undefined;
    for (const [runId, initialDelivery] of targets) {
      const run = this.store.getRun(runId);
      const delivery = run.native?.delivery;
      if (!delivery || ['completed', 'failed', 'cancelled'].includes(run.state)) continue;
      // Text a CLI may already hold in its input box or queue (Claude) is neither delivered nor taken
      // back by a stop: the stop only ends what was running. Its own records settle the run — a prompt
      // row starts it, a `queue-operation` removal or a cleared input box (reported as `run_cancelled`)
      // cancels it — so a message is never closed as cancelled while the CLI can still submit it.
      if (traits.stopKeepsPendingInput && run.native?.intent !== 'steer'
        && (delivery === 'dispatching' || delivery === 'input_sent'
          // Stop may have released a send's receipt wait to acquire this lock. That makes the
          // delivery uncertain; it does not prove the CLI removed the input it may still hold.
          || delivery === 'uncertain' && !run.native?.nativeMessageId
          // A queue receipt proves delivery, but names no executing turn. Stopping the main
          // turn cannot take back this input; its own native consumption/removal must settle it.
          || delivery === 'observed' && !run.native?.nativeTurnId)) continue;
      // Preparing never crossed the write fence, even if its worker has since returned it to the
      // queue because this interrupt request owned the terminal lock. Other states may have been
      // accepted by the CLI and remain visible as an interrupted run.
      const preparing = initialDelivery === 'preparing';
      // A steer the stop came before is kept as the next message, like the messages queued behind it.
      if (preparing && run.native?.intent === 'steer') { this.requeueSteer(run.id); continue; }
      const allowed: NativeDeliveryState[] = preparing ? ['queued', 'preparing'] : [delivery];
      if (!preparing && run.native?.intent === 'steer' && !run.native.nativeMessageId) {
        // Stopping the turn does not establish whether an unconfirmed input reached it.
        // Preserve that ambiguity until its exact receipt appears or tracking is discarded.
        this.store.transitionNativeRun(run.id, allowed, {
          delivery: 'uncertain', stage: 'steer_stopped',
          timings: { ...run.native.timings, interruptedAt: now() },
        }, { state: 'interrupted', error: run.error ?? '任务已停止，补充消息是否收到仍无法确认。' });
        continue;
      }
      const changed = this.store.transitionNativeRun(run.id, allowed, {
        delivery: 'cancelled',
        stage: preparing ? 'cancelled' : 'interrupted',
        timings: { ...run.native?.timings, ...(preparing ? {} : { interruptedAt: now() }) },
      }, preparing
        ? { state: 'cancelled', error: undefined }
        : { state: 'interrupted', error: undefined });
      if (changed) this.pendingSteerOutcomes.delete(runId);
      if (changed && !preparing) interrupted = changed;
    }
    return interrupted;
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    for (const unsubscribe of this.observers.values()) unsubscribe();
    this.observers.clear();
    this.offCorrections?.();
    await Promise.allSettled(this.workers.values());
    await Promise.allSettled(this.steerTasks.values());
    await Promise.allSettled([...this.interruptionTasks.values()].map(({ task }) => task));
    this.pendingSteerOutcomes.clear();
    this.pendingTurnOutcomes.clear();
    this.turnOutcomeRevisions.clear();
    this.hookedTurns.clear();
  }
}
