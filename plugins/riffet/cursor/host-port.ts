import type { RunMetrics } from '@contracts';
import { AppError, type StatsSink } from '@riffet/plugin-api/kit';
import {
  type AgentDialogs, type AgentHost, type AgentProjectView, type AgentRunRef, type AgentSessionPatch, type AgentSessionView, type AgentTerminals, type AgentTerminalView,
} from '@riffet/plugin-api/experimental/agent';

/**
 * What `NativeService` and `NativeRuntimeManager` use of the core, in the shape they used it: reads that
 * return at once (their observation loops cannot await) and writes that are visible as soon as the call
 * returns. It is a facade over `AgentHost` and nothing else; `AgentHost.view` is what makes the reads
 * synchronous, and its read-your-writes rule is what makes `updateSession` return the new record.
 *
 * Writes cannot report failure synchronously: the host's promise rejects, and the port logs it and says
 * the session changed (`host.emit`), so readers look at the record that actually stands. A caller that
 * needs to know a write took holds on to the record it returns and compares it.
 */
export interface CursorPort {
  /** The session as the host holds it now; `SESSION_NOT_FOUND` when it is gone. */
  getSession(sessionId: string): AgentSessionView;
  /** Every session of this Agent, archived ones included. */
  listSessions(): AgentSessionView[];
  getProject(projectId: string): AgentProjectView;
  /** Writes `patch` and returns the record after it. A refused write leaves the record as it was. */
  updateSession(sessionId: string, patch: AgentSessionPatch): AgentSessionView;
  /** `updateSession` for a change of meaning (model, mode, approval): the configuration revision moves with it. */
  bumpConfig(sessionId: string, patch: AgentSessionPatch): AgentSessionView;
  /** Throws `NATIVE_SESSION_ID_IN_USE` when another live conversation owns the chat, before any write; a refusal only the host can see leaves `nativeSessionId` as it was in the record returned. */
  setNativeSessionId(sessionId: string, nativeSessionId: string | undefined): AgentSessionView;
  /** The record when `lastActivityAt` moved, otherwise undefined. */
  updateSessionActivity(sessionId: string, at: string): AgentSessionView | undefined;
  firstUserMessage(sessionId: string): string | undefined;
  /** Readers of the session record should look again. */
  sessionChanged(sessionId: string): void;

  /** A terminal of one of this Agent's sessions. A reservation is not one. */
  findTerminal(terminalId: string): AgentTerminalView | undefined;
  /** `findTerminal` that throws `TERMINAL_NOT_FOUND`. */
  getTerminal(terminalId: string): AgentTerminalView;
  listTerminals(): AgentTerminalView[];
  /** Start, read, stop, interact with and reserve panes; asynchronous as the host's own. */
  readonly terminals: AgentTerminals;
  readonly dialogs: AgentDialogs;
  /** The session lock start, configure, send and stop share. `detached` for work started from timers and events. */
  withSessionLock<T>(sessionId: string, operation: () => Promise<T>, options?: { detached?: boolean }): Promise<T>;

  readonly stats: StatsSink;
  saveRunMetrics(runId: string, metrics: RunMetrics): void;
  /**
   * The run a CLI user message belongs to, from what the host answered to an earlier ask: the host's
   * lookup is asynchronous and the transcript decoder cannot wait, so the first ask starts it and
   * answers `undefined`; the decoder asks again with its next batch (see `CursorTranscriptMeter`).
   */
  runIdForMessage(sessionId: string, nativeMessageId: string): string | undefined;
  /** The backend notes when it typed a run's prompt, because a run reference does not carry it. */
  noteInputSent(runId: string, at?: number): void;
  inputSentAt(runId: string): number | undefined;
  /** The session's runs that have not finished. */
  unfinishedRuns(sessionId: string): Promise<AgentRunRef[]>;
  /** The runs bound to one native turn (the hook bridge reads them in hooks and status polls, which cannot wait). */
  runsOfTurn(sessionId: string, nativeSessionId: string, nativeTurnId: string): AgentRunRef[];
}

/** How long a run lookup that found nothing is trusted before the host is asked again. */
const NO_RUN_RETRY_MS = 1_000;
const REMEMBERED = 512;

const remember = <T>(map: Map<string, T>, key: string, value: T): void => {
  map.delete(key);
  map.set(key, value);
  while (map.size > REMEMBERED) map.delete(map.keys().next().value!);
};

export function cursorPort(host: AgentHost): CursorPort {
  const view = host.view;
  const warn = (what: string, error: unknown) => console.warn(`[riffet] cursor: ${what}: ${error instanceof Error ? error.message : String(error)}`);
  /** Fires a write whose record is already visible in the view; a failure is logged and announced instead of thrown. */
  const write = (sessionId: string, call: () => Promise<unknown>, what: string): void => {
    const refused = (error: unknown) => {
      warn(what, error);
      try { host.emit(sessionId, { type: 'session' }); } catch { /* the session is gone */ }
    };
    try { call().catch(refused); } catch (error) { refused(error); }
  };
  const current = (sessionId: string): AgentSessionView => {
    const session = view.session(sessionId);
    if (!session) throw new AppError('SESSION_NOT_FOUND', 'Conversation does not exist', 404);
    return session;
  };
  const runIds = new Map<string, { runId?: string; at: number; pending: boolean }>();
  const inputSent = new Map<string, number>();

  return {
    getSession: current,
    listSessions: () => view.sessions(),
    getProject: (projectId) => {
      const project = view.project(projectId);
      if (!project) throw new AppError('PROJECT_NOT_FOUND', 'Project does not exist', 404);
      return project;
    },
    updateSession: (sessionId, patch) => {
      write(sessionId, () => host.updateSession(sessionId, patch), 'session update refused');
      return current(sessionId);
    },
    bumpConfig: (sessionId, patch) => {
      write(sessionId, () => host.updateSession(sessionId, patch, { bump: true }), 'session update refused');
      return current(sessionId);
    },
    setNativeSessionId: (sessionId, nativeSessionId) => {
      const self = current(sessionId);
      // The store's rule (`assertNativeIdentityAvailable`) as far as the view shows it: another live conversation of
      // this Agent owns the chat. What only the host's run records can show (an archived owner with a run in flight)
      // is refused by the host itself, and the record returned then keeps the old id.
      if (nativeSessionId && !self.archivedAt && view.sessions().some((other) => other.id !== sessionId && other.nativeSessionId === nativeSessionId && !other.archivedAt)) {
        throw new AppError('NATIVE_SESSION_ID_IN_USE', 'This native session is already bound to another conversation', 409);
      }
      write(sessionId, () => host.setNativeSessionId(sessionId, nativeSessionId), 'native session id refused');
      return current(sessionId);
    },
    updateSessionActivity: (sessionId, at) => {
      const before = view.session(sessionId)?.lastActivityAt;
      write(sessionId, () => host.recordActivity(sessionId, at), 'activity not recorded');
      const after = view.session(sessionId);
      return after && after.lastActivityAt !== before ? after : undefined;
    },
    firstUserMessage: (sessionId) => view.firstUserMessage(sessionId),
    sessionChanged: (sessionId) => { try { host.emit(sessionId, { type: 'session' }); } catch { /* the session is gone */ } },

    findTerminal: (terminalId) => view.terminal(terminalId),
    getTerminal: (terminalId) => {
      const terminal = view.terminal(terminalId);
      if (!terminal) throw new AppError('TERMINAL_NOT_FOUND', 'Terminal does not exist', 404);
      return terminal;
    },
    listTerminals: () => view.terminals(),
    terminals: host.terminals,
    dialogs: host.dialogs,
    withSessionLock: (sessionId, operation, options) => host.withSessionLock(sessionId, operation, options),

    stats: {
      recordUsage: (sessionId, runId, usage) => host.stats.recordUsage(sessionId, runId, usage),
      observeEvents: (sessionId, events) => host.stats.observeEvents(sessionId, events),
    },
    saveRunMetrics: (runId, metrics) => host.stats.saveRunMetrics(runId, metrics),
    runIdForMessage: (sessionId, nativeMessageId) => {
      const key = `${sessionId}\0${nativeMessageId}`;
      const known = runIds.get(key);
      if (known?.runId) return known.runId;
      if (known && (known.pending || Date.now() - known.at < NO_RUN_RETRY_MS)) return undefined;
      remember(runIds, key, { at: Date.now(), pending: true });
      host.runs.find(sessionId, { nativeMessageId }).then(
        (runs) => {
          // The core's own record of the hand-over, which also covers a first message launched on argv and a run from before a restart.
          if (runs[0]?.inputSentAt !== undefined) remember(inputSent, runs[0].id, runs[0].inputSentAt);
          remember(runIds, key, { ...(runs[0] ? { runId: runs[0].id } : {}), at: Date.now(), pending: false });
        },
        () => remember(runIds, key, { at: Date.now(), pending: false }),
      );
      return undefined;
    },
    noteInputSent: (runId, at = Date.now()) => { remember(inputSent, runId, at); },
    inputSentAt: (runId) => inputSent.get(runId),
    unfinishedRuns: (sessionId) => host.runs.find(sessionId, { unfinished: true }),
    runsOfTurn: (sessionId, nativeSessionId, nativeTurnId) => view.runsOfTurn(sessionId, nativeSessionId, nativeTurnId),
  };
}
