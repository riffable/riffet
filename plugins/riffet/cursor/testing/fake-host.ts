import type { AgentControlMessage, AgentDispatchBinding, AgentEvent } from '@riffet/plugin-api';
import {
  AppError,
  type AgentDialogs, type AgentHost, type AgentLaunchSpec, type AgentProjectView, type AgentReservation, type AgentRunRef, type AgentSessionPatch, type AgentSessionView,
  type AgentTerminalControl, type AgentTerminalHandle, type AgentTerminals, type AgentTerminalView,
} from '@riffet/plugin-api';

const notScripted = (what: string) => (): never => { throw new Error(`FakeHost: ${what} is not scripted`); };

/**
 * An in-memory `AgentHost` for the Cursor tests: sessions, projects and terminals the test owns, a pane
 * it repaints (`screen`), the writes and launches it can read back, and a session lock it can hold. A
 * write is applied before its promise is returned, which is `AgentHost.view`'s read-your-writes rule.
 * Only what the moved tests use is real; the rest throws when called.
 */
export class FakeHost implements AgentHost {
  readonly sessions = new Map<string, AgentSessionView>();
  readonly projects = new Map<string, AgentProjectView>();
  readonly terminalRecords = new Map<string, AgentTerminalView>();
  readonly reservationRecords = new Map<string, AgentReservation>();
  readonly firstMessages = new Map<string, string>();
  /** Every patch handed to `updateSession`, in call order. */
  readonly updates: AgentSessionPatch[] = [];
  readonly emitted: Array<{ sessionId: string; message: AgentControlMessage }> = [];
  /** Every event handed to `emitEvent`, in order. */
  readonly events: AgentEvent[] = [];
  /** Every fence committed, in order; `onFence` may refuse one by throwing. */
  readonly fences: Array<{ runId: string; binding?: AgentDispatchBinding }> = [];
  onFence: ((runId: string, binding?: AgentDispatchBinding) => void) | undefined;
  readonly stopped: string[] = [];
  readonly launched: Array<{ sessionId: string; spec: AgentLaunchSpec }> = [];
  /** Sessions the lock was taken for, in order. */
  readonly locked: string[] = [];
  /** While set, an operation holding the session lock waits for it. */
  lockGate: Promise<void> | undefined;
  /** What `runs.find` answers for `{ unfinished: true }`. */
  unfinished: AgentRunRef[] = [];
  runRefs: AgentRunRef[] = [];
  /** The pane every terminal shows; a test repaints it, or gives the text as a function when a script drives it. */
  screen: string | undefined | (() => string | undefined);
  /** What `interact` hands its task; a control over `screen` that writes nowhere when unset. */
  control: AgentTerminalControl | undefined;
  /** The state a terminal reports, when the test drives it (a pane that exits mid-test). */
  stateOf: ((terminalId: string) => AgentTerminalHandle['state'] | undefined) | undefined;
  /** The record a launch creates; `terminal-<n>` of the Agent's kind when unset. */
  onLaunch: ((sessionId: string, spec: AgentLaunchSpec) => Partial<AgentTerminalView> | void) | undefined;
  dialogs: AgentDialogs = {
    observe: () => undefined,
    current: async () => null,
    respond: notScripted('dialogs.respond'),
    replay: () => undefined,
    isResponding: () => false,
    owns: () => false,
  };
  private lockTail: Promise<unknown> = Promise.resolve();
  private launches = 0;

  constructor(init: { sessions?: AgentSessionView[]; projects?: AgentProjectView[]; terminals?: AgentTerminalView[]; screen?: string } = {}) {
    for (const session of init.sessions ?? []) this.sessions.set(session.id, session);
    for (const project of init.projects ?? []) this.projects.set(project.id, project);
    for (const terminal of init.terminals ?? []) this.terminalRecords.set(terminal.id, terminal);
    this.screen = init.screen;
  }

  private pane(): string | undefined { return typeof this.screen === 'function' ? this.screen() : this.screen; }

  private patch(id: string, patch: AgentSessionPatch, bump = false): AgentSessionView {
    const current = this.sessions.get(id);
    if (!current) throw new AppError('SESSION_NOT_FOUND', 'Conversation does not exist', 404);
    // The store refuses a chat another live conversation owns, whichever call carries it.
    if (patch.nativeSessionId && [...this.sessions.values()].some(other => other.id !== id && other.nativeSessionId === patch.nativeSessionId && !other.archivedAt)) {
      throw new AppError('NATIVE_SESSION_ID_IN_USE', 'Another conversation already owns this native session', 409);
    }
    this.updates.push(patch);
    const next = { ...current, ...patch, ...(bump ? { configRevision: (current.configRevision ?? 0) + 1 } : {}) };
    this.sessions.set(id, next);
    return next;
  }

  private terminal(id: string): AgentTerminalView | undefined { return this.terminalRecords.get(id) ?? this.reservationRecords.get(id)?.terminal as AgentTerminalView | undefined; }

  private handle(id: string): AgentTerminalHandle {
    const info = this.terminal(id);
    if (!info) throw new AppError('TERMINAL_NOT_FOUND', 'Terminal does not exist', 404);
    return { id, epoch: info.epoch, state: this.stateOf?.(id) ?? info.state };
  }

  private reservation(id: string): AgentReservation {
    const reservation = this.reservationRecords.get(id);
    if (!reservation) throw new AppError('WARMUP_NOT_FOUND', 'This warm terminal is no longer available', 404);
    return reservation;
  }

  /** Cursor names no model source. */
  readonly modelSources: AgentHost['modelSources'] = { resolve: async () => undefined };
  readonly terminals: AgentTerminals = {
    inspect: async () => undefined,
    launch: async (sessionId, spec) => {
      this.launched.push({ sessionId, spec });
      const made = this.onLaunch?.(sessionId, spec) ?? {};
      const id = made.id ?? `terminal-${this.launches += 1}`;
      const record: AgentTerminalView = {
        id, projectId: this.sessions.get(sessionId)?.projectId ?? '', sessionId, title: spec.title ?? '', kind: spec.kind ?? 'native', state: 'running',
        persistent: true, epoch: 1, cols: 80, rows: 24, createdAt: new Date(0).toISOString(), ...made,
      };
      this.terminalRecords.set(id, record);
      return this.handle(id);
    },
    get: async (id) => this.handle(id),
    screen: async (id) => { this.handle(id); return this.pane(); },
    paste: async () => undefined,
    sendKeys: async () => undefined,
    stop: async (id) => { this.stopped.push(id); },
    interact: async (id, task, options) => {
      this.handle(id);
      options?.authorize?.();
      return task(this.control ?? { screen: async () => this.pane(), keys: async () => undefined, paste: async () => undefined });
    },
    observe: () => () => undefined,
    panePid: async () => undefined,
    reserve: async (request) => {
      const id = `warm-${(this.launches += 1)}`;
      const terminal = { id, epoch: 1, state: 'running' } as const;
      const reservation: AgentReservation = { terminal, ownerToken: request.ownerToken, resourceKey: request.resourceKey, nativeSessionId: request.nativeSessionId, expiresAt: request.expiresAt };
      this.reservationRecords.set(id, reservation);
      this.launched.push({ sessionId: '', spec: request.spec });
      return reservation;
    },
    claim: async (id, claim) => {
      const reservation = this.reservation(id);
      if (reservation.ownerToken !== claim.ownerToken || reservation.resourceKey !== claim.resourceKey) throw new AppError('WARMUP_MISMATCH', 'This warm terminal does not match the request', 409);
      this.reservationRecords.delete(id);
      this.terminalRecords.set(id, {
        id, projectId: this.sessions.get(claim.sessionId)?.projectId ?? '', sessionId: claim.sessionId, title: '', kind: 'cursor', state: 'running',
        persistent: true, epoch: 1, cols: 80, rows: 24, createdAt: new Date(0).toISOString(),
      });
      return this.handle(id);
    },
    extendReservation: async (id, extension) => {
      const reservation = this.reservation(id);
      if (reservation.ownerToken !== extension.ownerToken || reservation.resourceKey !== extension.resourceKey) throw new AppError('WARMUP_MISMATCH', 'This warm terminal does not match the request', 409);
      return { ...reservation, expiresAt: extension.expiresAt };
    },
    reservations: async (ownerToken) => [...this.reservationRecords.values()].filter(item => !ownerToken || item.ownerToken === ownerToken),
    releaseReservation: async (id, ownerToken) => {
      const reservation = this.reservationRecords.get(id);
      if (!reservation || reservation.ownerToken !== ownerToken) return false;
      this.reservationRecords.delete(id);
      this.stopped.push(id);
      return true;
    },
  };

  readonly view: AgentHost['view'] = {
    session: id => this.sessions.get(id),
    sessions: () => [...this.sessions.values()],
    project: id => this.projects.get(id),
    terminal: id => this.terminalRecords.get(id),
    terminals: () => [...this.terminalRecords.values()],
    firstUserMessage: id => this.firstMessages.get(id),
    runsOfTurn: (_id, nativeSessionId, nativeTurnId) => this.runRefs.filter(run => run.nativeSessionId === nativeSessionId && run.nativeTurnId === nativeTurnId),
  };

  readonly runs: AgentHost['runs'] = {
    find: async (_sessionId, query) => ('unfinished' in query ? this.unfinished : this.runRefs.filter(run => 'nativeMessageId' in query && run.nativeMessageId === query.nativeMessageId)),
  };

  readonly usage: Array<{ sessionId: string; runId: string | undefined }> = [];
  readonly metrics: Array<{ runId: string }> = [];
  readonly stats: AgentHost['stats'] = {
    recordUsage: (sessionId, runId) => { this.usage.push({ sessionId, runId }); },
    saveRunMetrics: runId => { this.metrics.push({ runId }); },
    observeEvents: () => undefined,
  };

  readonly transcript: AgentHost['transcript'] = {
    wake: () => undefined,
    drain: async () => undefined,
    endTurn: async () => undefined,
    ingest: async () => undefined,
    withSource: async () => undefined,
  };

  readonly interactionReceipts: AgentHost['interactionReceipts'] = { get: async () => undefined, save: async (_id, _requestId, receipt) => receipt };

  error(code: string, message: string, statusCode?: number): Error { return new AppError(code, message, statusCode); }
  async session(id: string): Promise<AgentSessionView> { return this.view.session(id) ?? notScripted(`session ${id}`)(); }
  async project(id: string): Promise<AgentProjectView> { return this.view.project(id) ?? notScripted(`project ${id}`)(); }
  async profile(): Promise<{ id: string; name: string; config: Record<string, unknown> }> { return { id: 'default', name: 'Cursor CLI', config: {} }; }
  async firstUserMessage(id: string): Promise<string | undefined> { return this.firstMessages.get(id); }
  async setNativeSessionId(id: string, nativeSessionId: string | undefined): Promise<AgentSessionView> {
    const current = this.sessions.get(id);
    if (!current) throw new AppError('SESSION_NOT_FOUND', 'Conversation does not exist', 404);
    if (current.nativeSessionId === nativeSessionId) return current;
    if (nativeSessionId && [...this.sessions.values()].some(other => other.id !== id && other.nativeSessionId === nativeSessionId && !other.archivedAt)) {
      throw new AppError('NATIVE_SESSION_ID_IN_USE', 'Another conversation already owns this native session', 409);
    }
    const next = { ...current, nativeSessionId };
    this.sessions.set(id, next);
    return next;
  }
  async updateSession(id: string, patch: AgentSessionPatch, options?: { bump?: boolean }): Promise<AgentSessionView> { return this.patch(id, patch, options?.bump); }
  async recordActivity(id: string, at: string): Promise<AgentSessionView | undefined> {
    const current = this.sessions.get(id);
    if (!current || (current.lastActivityAt && Date.parse(current.lastActivityAt) >= Date.parse(at))) return undefined;
    const next = { ...current, lastActivityAt: at };
    this.sessions.set(id, next);
    return next;
  }
  emit(sessionId: string, message: AgentControlMessage): void { this.emitted.push({ sessionId, message }); }
  emitEvent(_sessionId: string, event: AgentEvent): void { this.events.push(event); }
  async commitDispatchFence(runId: string, binding?: AgentDispatchBinding): Promise<void> {
    this.onFence?.(runId, binding);
    this.fences.push({ runId, ...(binding ? { binding } : {}) });
  }
  async beforeSpawn(): Promise<void> { /* a launch is never refused */ }
  checkStopTarget: AgentHost['checkStopTarget'] = async () => { /* a stop target never changes unless a test says so */ };
  async isRunCancelled(): Promise<boolean> { return false; }
  readAttachment = notScripted('readAttachment');
  bindRiffetMcp(): () => void { return () => {}; }
  async riffetMcp(): Promise<undefined> { return undefined; }

  withSessionLock<T>(sessionId: string, operation: () => Promise<T> | T): Promise<T> {
    const run = this.lockTail.then(async () => { this.locked.push(sessionId); await this.lockGate; return operation(); });
    this.lockTail = run.catch(() => undefined);
    return run;
  }
}
