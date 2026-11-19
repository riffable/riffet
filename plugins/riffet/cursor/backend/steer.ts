import { isAbsolute, resolve } from 'node:path';
import type { NativeStatus, NativeTurnTarget, NativeWorkbenchEvent, Run } from '@contracts';
import { AppError, DeferredSteerInputs, NativeHookServer, redactSensitiveText, type SteerBinding, type SteerHost } from '@riffet/plugin-api/kit';
import {
  type AgentDispatchBinding, type AgentHost, type AgentRunRef, type AgentSendRequest, type AgentSessionView,
} from '@riffet/plugin-api/experimental/agent';
import { redactCursorOutput, type CursorLaunchProfile } from '../cli-driver.js';
import type { CursorPort } from '../host-port.js';
import type { NativeService, SettledCursorTurn } from '../native/service.js';
import { chatStorePath } from '../native/chat-store.js';
import { resolveShellCall } from './shell-observation.js';
import { probeCursorHookSteer, writeCursorHookPlugin } from './launch-plugin.js';
import { CursorTranscriptSource, type CursorTurnResult } from './transcript-source.js';

/** The tools whose hooks name a file they change: the CLI reports every edit, a replacement included, as `Write`. */
const EDIT_TOOLS = new Set(['Write', 'Delete', 'StrReplace', 'Edit', 'MultiEdit']);

interface ActiveGeneration extends NativeTurnTarget { terminalId: string }
interface Entry {
  inputs: DeferredSteerInputs;
  active?: ActiveGeneration;
  retired: Set<string>;
  /** Run outcomes already published, including hooks whose journal read has yet to land. */
  ended: Map<string, TurnOutcome>;
  /** The last verified idle root and the read currently checking one. */
  answered?: { key: string; hasError: boolean };
  settling?: true;
}
/**
 * A hook ends a turn as soon as the CLI stops it, which can be before the CLI has committed the step it
 * cut short; the journal reads the store after this long, so that step stays in the turn it belongs to.
 */
const TRANSCRIPT_END_DELAY_MS = 3_000;
const TURN_OUTCOME_EVENT = { completed: 'run_completed', failed: 'run_failed', cancelled: 'run_cancelled' } as const;
type TurnOutcome = CursorTurnResult & { status: keyof typeof TURN_OUTCOME_EVENT; at: string };
const sameTarget = (left: NativeTurnTarget | undefined, right: NativeTurnTarget) => left?.nativeSessionId === right.nativeSessionId && left.turnId === right.turnId;
const turnKey = (target: NativeTurnTarget) => JSON.stringify([target.nativeSessionId, target.turnId]);

/** The CLI's generic tool-hook RPC exposes parentToolCallId even if generation ids are shared. */
function childHook(payload: Record<string, unknown>, nativeSessionId: string): boolean {
  return ['parent_tool_call_id', 'parent_conversation_id', 'subagent_id'].some(key => typeof payload[key] === 'string' && payload[key] !== '')
    || payload.is_subagent === true
    || typeof payload.agent_id === 'string' && payload.agent_id !== '' && payload.agent_id !== nativeSessionId;
}

/** What the kit's deferred inputs read of a run: the host's reference, in the shape of the core's run record. */
const asRun = (run: AgentRunRef): Run => ({
  id: run.id, sessionId: run.sessionId, commandId: run.commandId, prompt: '', state: run.state, createdAt: '', updatedAt: '',
  ...(run.error !== undefined ? { error: run.error } : {}),
  native: {
    delivery: run.delivery, intent: run.intent, stage: run.stage, nativeSessionId: run.nativeSessionId, nativeTurnId: run.nativeTurnId, nativeMessageId: run.nativeMessageId,
    renderedText: run.renderedText, ownerRunId: run.ownerRunId, config: run.config, resolvedConfig: run.resolvedConfig, input: run.inputText === undefined ? undefined : { text: run.inputText },
  },
}) as unknown as Run;

const agentBinding = (binding: SteerBinding | undefined): AgentDispatchBinding | undefined => binding && {
  ...(binding.nativeSessionId ? { nativeSessionId: binding.nativeSessionId } : {}),
  ...(binding.nativeTurnId ? { nativeTurnId: binding.nativeTurnId } : {}),
  ...(binding.ownerRunId ? { ownerRunId: binding.ownerRunId } : {}),
  ...(binding.terminalId ? { terminal: { id: binding.terminalId, ...(binding.terminalEpoch !== undefined ? { epoch: binding.terminalEpoch } : {}) } } : {}),
  ...(binding.renderedText !== undefined ? { renderedText: binding.renderedText } : {}),
  ...(binding.nativeInputBoundary !== undefined ? { nativeInputBoundary: binding.nativeInputBoundary } : {}),
  ...(binding.slashCommand !== undefined ? { slashCommand: binding.slashCommand } : {}),
  ...(binding.resolvedConfig ? { resolvedConfig: binding.resolvedConfig } : {}),
};

/** A hook boundary is the only write path: no composer, Enter, follow-up or new provider task. */
export class CursorSteerBridge {
  /** The CLI began compacting a conversation (`preCompact` hook); the owner of the stream shows it. */
  onPreCompact?: (sessionId: string, info: { generationId?: string; trigger?: 'manual' | 'auto'; preTokens?: number }) => void;
  /** A turn ended or the CLI went away; a compaction still running at that point will not finish. */
  onTurnEnded?: (sessionId: string) => void;
  private readonly entries = new Map<string, Entry>();
  private readonly server = new NativeHookServer((payload, _deliveryId, signal) => this.handle(payload, signal));
  private readonly steerHost: SteerHost;
  private plugin?: Promise<string[]>;
  private closed = false;

  constructor(
    private readonly host: AgentHost,
    private readonly port: CursorPort,
    private readonly native: NativeService,
    private readonly stateDir: string,
    private readonly profile: CursorLaunchProfile,
  ) {
    this.steerHost = {
      getSession: sessionId => port.getSession(sessionId),
      emitEvent: (sessionId, event) => host.emitEvent(sessionId, event),
      findRunsByNativeTurn: (sessionId, nativeSessionId, turnId) => port.runsOfTurn(sessionId, nativeSessionId, turnId).map(asRun),
    };
    native.useTurnObserver({
      activeTurn: session => this.activeTurn(session),
      recordedOutcome: (sessionId, target) => this.recordedOutcome(sessionId, target)?.status,
      transcript: (session, events) => { for (const receipt of this.receiptEvents(session, events)) host.emitEvent(session.id, receipt); },
      offline: session => this.reject(session.id, 'Cursor connection is no longer writable'),
      answered: (session, target, stillIdle) => { void this.answered(session, target, stillIdle).catch(() => undefined); },
    });
  }

  bind(sessionId: string): Entry {
    let entry = this.entries.get(sessionId);
    if (!entry) {
      entry = { retired: new Set(), ended: new Map(), inputs: new DeferredSteerInputs(this.steerHost, {
        backendId: 'cursor', sessionId, currentTarget: () => this.activeTurn(this.port.getSession(sessionId)),
      }) };
      this.entries.set(sessionId, entry);
      // Read-only indexing may visit many old conversations. Idle entries contain no pending
      // input; their receipts/outcomes can be rebuilt from the durable native history and runs.
      if (this.entries.size > 256) {
        for (const [id, candidate] of this.entries) {
          if (id !== sessionId && !candidate.active) this.entries.delete(id);
          if (this.entries.size <= 256) break;
        }
      }
    }
    return entry;
  }

  async launchArgs(session?: AgentSessionView): Promise<string[]> {
    if (this.closed) return [];
    if (session) this.bind(session.id);
    if (!await probeCursorHookSteer(this.profile)) return [];
    if (this.closed) return [];
    this.plugin ??= this.server.start().then(bridge => writeCursorHookPlugin(this.stateDir, bridge)).then(plugin => ['--plugin-dir', plugin]);
    return this.plugin;
  }

  activeTurn(session: AgentSessionView): NativeStatus['activeTurn'] {
    const entry = this.entries.get(session.id);
    const active = entry?.active;
    if (!entry || !active || session.archivedAt || session.terminalId !== active.terminalId
      || session.nativeSessionId !== active.nativeSessionId
      || ['failed', 'interrupted', 'cancelling'].includes(session.state)) return undefined;
    const owner = this.owner(session.id, active);
    return { nativeSessionId: active.nativeSessionId, turnId: active.turnId, ...(owner ? { ownerRunId: owner.id } : {}) };
  }

  /**
   * A restarted process has no hook memory. A foreground run still executing on the live terminal
   * becomes the active turn again, unless this bridge already ended it or the chat store has.
   */
  async hydrate(session: AgentSessionView): Promise<void> {
    if (this.closed || session.archivedAt || !session.nativeSessionId || !session.terminalId
      || ['failed', 'interrupted', 'cancelling'].includes(session.state)) return;
    const entry = this.bind(session.id);
    if (entry.active) return;
    const terminal = this.port.findTerminal(session.terminalId);
    if (!terminal || terminal.state === 'exited') return;
    const nativeSessionId = session.nativeSessionId;
    const runs = await this.port.unfinishedRuns(session.id);
    if (this.closed || entry.active) return;
    const run = runs.find(candidate => {
      const bound = (candidate as AgentRunRef & { terminalId?: string }).terminalId;
      return candidate.intent !== 'steer' && candidate.state === 'running' && candidate.delivery === 'observed'
        && candidate.nativeSessionId === nativeSessionId && Boolean(candidate.nativeTurnId)
        && (!bound || bound === terminal.id);
    });
    const turnId = run?.nativeTurnId;
    if (!turnId) return;
    const target = { nativeSessionId, turnId };
    if (entry.retired.has(turnId) || entry.ended.has(turnKey(target))) return;
    const state = this.native.turnState(session.id, target);
    // `undefined` means the store has not been read yet; `open` means the turn is still in it.
    if (state !== undefined && state !== 'open') return;
    const current = this.port.getSession(session.id);
    const fresh = this.port.findTerminal(terminal.id);
    if (!fresh || fresh.state === 'exited' || this.closed || entry.active || current.archivedAt
      || current.terminalId !== fresh.id || current.nativeSessionId !== nativeSessionId
      || ['failed', 'interrupted', 'cancelling'].includes(current.state)) return;
    entry.active = { nativeSessionId, turnId, terminalId: fresh.id };
    this.native.notifyTurnChanged(session.id);
  }

  recordedOutcome(sessionId: string, target: NativeTurnTarget): TurnOutcome | undefined {
    return this.entries.get(sessionId)?.ended.get(turnKey(target));
  }

  /** The run the turn belongs to: the one that is not a steer. Read from the host's records at the call. */
  private owner(sessionId: string, target: NativeTurnTarget): AgentRunRef | undefined {
    return this.port.runsOfTurn(sessionId, target.nativeSessionId, target.turnId).find(run => run.intent !== 'steer');
  }

  async enqueue(request: AgentSendRequest & { target: NativeTurnTarget }, text: string): Promise<{ deferred: true }> {
    const sessionId = request.context.session.id;
    const entry = this.bind(sessionId);
    const active = entry.active;
    if (!sameTarget(this.activeTurn(this.port.getSession(sessionId)), request.target) || !active) {
      throw new AppError('STEER_TARGET_CHANGED', 'The Cursor turn ended or has no steer connection', 409);
    }
    const terminal = await this.port.terminals.get(active.terminalId);
    // `terminal.epoch` tracks browser write leases (opening or closing the terminal drawer bumps it)
    // and is not process identity; only terminal exit or rebinding invalidates the live turn.
    if (terminal.state === 'exited' || terminal.id !== active.terminalId || !sameTarget(this.activeTurn(this.port.getSession(sessionId)), request.target)) {
      throw new AppError('STEER_TARGET_CHANGED', 'The Cursor steer target or terminal connection changed', 409);
    }
    const owner = this.owner(sessionId, request.target);
    return entry.inputs.enqueue({
      runId: request.runId, commandId: request.commandId, target: request.target,
      commitDispatchFence: binding => this.host.commitDispatchFence(request.runId, agentBinding(binding)),
    }, text, {
      backendId: 'cursor', terminalId: terminal.id, terminalEpoch: terminal.epoch,
      nativeSessionId: request.target.nativeSessionId, nativeTurnId: request.target.turnId,
      ...(owner ? { ownerRunId: owner.id, resolvedConfig: owner.resolvedConfig ?? owner.config } : {}),
      renderedText: text,
    });
  }

  private retire(entry: Entry, turnId: string): void {
    entry.retired.add(turnId);
    while (entry.retired.size > 256) entry.retired.delete(entry.retired.values().next().value!);
  }

  reject(sessionId: string, reason: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    if (entry.active) this.retire(entry, entry.active.turnId);
    entry.active = undefined;
    entry.inputs.reject(reason);
    this.native.notifyTurnChanged(sessionId);
  }

  /** Stop may reject pending guidance while retaining the turn identity needed by write guards. */
  rejectPending(sessionId: string, reason: string): void {
    this.entries.get(sessionId)?.inputs.reject(reason);
  }

  receiptEvents(session: AgentSessionView, events: NativeWorkbenchEvent[]): NativeWorkbenchEvent[] {
    const entry = this.entries.get(session.id);
    if (!entry) return [];
    const receipts: NativeWorkbenchEvent[] = [];
    for (const event of events) {
      if (event.type !== 'cursor_tool_context' || typeof event.data.text !== 'string') continue;
      receipts.push(...entry.inputs.receiptEvents(event.data.text, event.nativeId ?? String(event.sequence), event.createdAt));
    }
    return receipts;
  }

  private async handle(payload: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const nativeSessionId = typeof payload.conversation_id === 'string' ? payload.conversation_id : undefined;
    const turnId = typeof payload.generation_id === 'string' ? payload.generation_id : undefined;
    const event = payload.hook_event_name;
    if (!nativeSessionId || !turnId || typeof event !== 'string') return {};
    if (childHook(payload, nativeSessionId)) return {};
    const session = this.native.sessionForChat(nativeSessionId);
    if (!session) return {};
    const entry = this.bind(session.id);
    const target = { nativeSessionId, turnId };
    // Outside the session lock: the snapshot can take a second or two, and the command waits for this hook but nothing else should.
    await this.observeWorkspace(session, payload);
    return this.port.withSessionLock(session.id, async () => {
      const current = this.port.getSession(session.id);
      if (signal.aborted || current.archivedAt || current.nativeSessionId !== nativeSessionId) return {};
      const interruptedTool = event === 'postToolUseFailure' && payload.is_interrupt === true;
      if (event === 'stop' || event === 'sessionEnd' || interruptedTool) {
        const status = !interruptedTool && payload.status === 'completed' ? 'completed' : payload.status === 'error' ? 'failed' : 'cancelled';
        this.end(entry, session.id, target, { status, at: new Date().toISOString() });
        return {};
      }
      if (entry.retired.has(turnId)) return {};
      if (event === 'beforeSubmitPrompt') {
        // The generation exists when the prompt is submitted, which is before the first tool hook.
        if (entry.active && !sameTarget(entry.active, target)) this.reject(session.id, 'Cursor generation changed before the input was consumed');
        if (current.terminalId) {
          const terminal = await this.port.terminals.get(current.terminalId);
          if (!signal.aborted && terminal.state !== 'exited' && this.port.getSession(session.id).terminalId === terminal.id) {
            entry.active = { ...target, terminalId: terminal.id };
            this.native.notifyTurnChanged(session.id);
          }
        }
        return {};
      }
      if (event === 'preCompact') {
        const preTokens = typeof payload.context_tokens === 'number' && Number.isFinite(payload.context_tokens) ? payload.context_tokens : undefined;
        this.onPreCompact?.(session.id, {
          generationId: turnId, trigger: payload.trigger === 'manual' ? 'manual' : 'auto',
          ...(preTokens !== undefined ? { preTokens } : {}),
        });
        return {};
      }
      if (!current.terminalId) return {};
      const terminal = await this.port.terminals.get(current.terminalId);
      if (signal.aborted || terminal.state === 'exited' || this.port.getSession(session.id).terminalId !== terminal.id) return {};
      if (event === 'preToolUse') {
        if (entry.active && !sameTarget(entry.active, target)) {
          // A chat runs one turn at a time, so another generation id is a new turn only once the store shows this one
          // over. Until then the hook names no turn this chat is running: it must neither end the turn nor take its inputs.
          const previous = this.native.turnState(session.id, entry.active);
          if (previous === 'open') return {};
          if (previous === 'answered') this.end(entry, session.id, entry.active, { status: 'completed', at: new Date().toISOString() });
          else this.reject(session.id, 'Cursor started another generation');
        }
        entry.active = { ...target, terminalId: terminal.id };
        this.native.notifyTurnChanged(session.id);
        return {};
      }
      if (event !== 'postToolUse' && event !== 'postToolUseFailure') return {};
      if (!sameTarget(this.activeTurn(this.port.getSession(session.id)), target) || entry.active?.terminalId !== terminal.id) return {};
      // claim removes the matching inbox entries before it awaits their fences, and the session lock keeps the
      // other hooks of this conversation out meanwhile. Parallel tool hooks cannot deliver the same input twice,
      // and a stopped/changed generation can never claim it.
      const owner = this.owner(session.id, target);
      const context = await entry.inputs.claimAsync(target, { terminalId: terminal.id, terminalEpoch: terminal.epoch,
        ...(owner ? { ownerRunId: owner.id, resolvedConfig: owner.resolvedConfig ?? owner.config } : {}),
      });
      return context ? { additional_context: context } : {};
    });
  }

  /**
   * What a shell command changes in the working tree is not in the chat store, so it is seen from outside: a snapshot
   * before the command (`preToolUse` holds the command until it returns) and a comparison after it. Kept under the
   * call's store id, which only the store knows (`resolveShellCall`), so that every import of the transcript finds it.
   * A file an edit tool changes (the hooks name every edit `Write`) is noted as it starts and ends, so a command running
   * beside it, in this conversation or another, leaves the file to the edit.
   * Never fails the hook; a command that cannot be told from another running the same text is left unobserved.
   */
  private async observeWorkspace(session: AgentSessionView, payload: Record<string, unknown>): Promise<void> {
    const changes = this.host.workspaceChanges;
    const event = payload.hook_event_name;
    const hookId = payload.tool_use_id;
    const input = payload.tool_input as { command?: unknown; block_until_ms?: unknown; cwd?: unknown; file_path?: unknown; path?: unknown } | undefined;
    if (!changes || (event !== 'preToolUse' && event !== 'postToolUse' && event !== 'postToolUseFailure')) return;
    const roots = payload.workspace_roots;
    const cwd = () => [input?.cwd, payload.cwd, Array.isArray(roots) ? roots[0] : undefined].find((value): value is string => typeof value === 'string' && value !== '')
      ?? this.port.getProject(session.projectId).cwd;
    try {
      if (typeof payload.tool_name === 'string' && EDIT_TOOLS.has(payload.tool_name)) {
        const path = [input?.file_path, input?.path].find((value): value is string => typeof value === 'string' && value !== '');
        if (path) changes.noteEdit(session.id, isAbsolute(path) ? path : resolve(cwd(), path));
        return;
      }
      if (payload.tool_name !== 'Shell' || typeof hookId !== 'string' || !hookId) return;
      if (event === 'preToolUse') {
        // `block_until_ms: 0` backgrounds the command: it outlives its hooks, so there is no end to compare at.
        if (typeof input?.command !== 'string' || input.block_until_ms === 0) return;
        await changes.begin(session.id, hookId, cwd(), input.command);
        return;
      }
      const diffs = await changes.end(session.id, hookId);
      if (!diffs?.length || typeof input?.command !== 'string' || typeof payload.conversation_id !== 'string') return;
      const store = chatStorePath(this.profile.configDir, this.port.getProject(session.projectId).cwd, payload.conversation_id);
      const callId = await resolveShellCall(store, input.command);
      if (callId) changes.record(session.id, callId, diffs);
    } catch { /* observation is best effort */ }
  }

  /** A settled idle root confirms completion or gives a known hook outcome another chance to land. */
  async answered(session: AgentSessionView, answer: SettledCursorTurn, stillIdle: () => boolean): Promise<void> {
    if (this.closed || session.nativeSessionId !== answer.nativeSessionId) return;
    const entry = this.bind(session.id);
    const active = entry.active;
    if (active && (active.nativeSessionId !== answer.nativeSessionId || answer.turnId && active.turnId !== answer.turnId)) return;
    const target = answer.turnId ? { nativeSessionId: answer.nativeSessionId, turnId: answer.turnId } : active;
    const key = target && turnKey(target);
    const recorded = key ? entry.ended.get(key) : undefined;
    const settled = JSON.stringify([answer.nativeSessionId, answer.rootId, answer.turnId]);
    if (entry.settling || (entry.answered?.key === settled && (!answer.error || entry.answered.hasError))) return;
    // A Stop can arrive during this read. Let it provide the outcome before this snapshot retries.
    const stillCurrent = () => !this.closed && this.entries.get(session.id) === entry && entry.active === active
      && (!key || entry.ended.get(key) === recorded) && stillIdle();
    if (!stillCurrent()) return;
    const owner = target && this.owner(session.id, target);
    // A restarted bridge may be looking at a turn whose outcome was already persisted by the dispatcher.
    const interrupted = owner?.state === 'cancelled' || owner?.state === 'interrupted' && owner.stage !== 'turn_outcome_unknown';
    const status = recorded?.status ?? (interrupted ? 'cancelled' : answer.error || owner?.state === 'failed' ? 'failed' : 'completed');
    // A Stop can contain just the status. Its Run's generic fallback must not hide a later pane error.
    const reason = status === 'failed' ? answer.error ?? (!recorded ? owner?.error : undefined) : undefined;
    const error = recorded?.error ?? (reason ? redactSensitiveText(redactCursorOutput(this.profile, reason)).slice(0, 1000) : undefined);
    const outcome: TurnOutcome = { status, at: recorded?.at ?? new Date().toISOString(), ...(error ? { error } : {}) };
    entry.settling = true;
    try {
      const ended = await this.endTranscript(session.id, answer, outcome, stillCurrent);
      if (!ended || !stillCurrent()) return;
      entry.answered = { key: settled, hasError: Boolean(answer.error || error) };
      if (recorded && key && error !== recorded.error) {
        entry.ended.set(key, outcome);
      } else if (!recorded && target && (active || owner?.state === 'running')) {
        this.end(entry, session.id, target, outcome, true);
      }
    } finally {
      entry.settling = undefined;
    }
  }

  private end(entry: Entry, sessionId: string, target: NativeTurnTarget, outcome: TurnOutcome, journalEnded = false): void {
    const { nativeSessionId, turnId } = target;
    const key = turnKey(target);
    if (entry.ended.has(key)) return;
    entry.ended.set(key, outcome);
    if (entry.ended.size > 256) entry.ended.delete(entry.ended.keys().next().value!);
    this.retire(entry, turnId);
    if (sameTarget(entry.active, target)) entry.active = undefined;
    const type = TURN_OUTCOME_EVENT[outcome.status];
    const { at, error } = outcome;
    entry.inputs.finish(target, { type, ...(error ? { error } : {}) });
    const owner = this.owner(sessionId, target);
    this.host.emitEvent(sessionId, {
      ...(owner ? { runId: owner.id } : {}), nativeTurnId: turnId,
      nativeId: `cursor:${nativeSessionId}:${turnId}:terminal`, type,
      data: { sessionUpdate: type, ...(owner ? { commandId: owner.commandId, nativeMessageId: owner.nativeMessageId } : {}), nativeSessionId, nativeTurnId: turnId,
        ...(error ? { error } : {}) }, createdAt: at,
    });
    if (!journalEnded) setTimeout(() => {
      void this.endTranscript(sessionId, target, entry.ended.get(key) ?? outcome);
    }, TRANSCRIPT_END_DELAY_MS).unref();
    if (!entry.active) this.onTurnEnded?.(sessionId);
    this.native.notifyTurnChanged(sessionId);
  }

  /** Recheck the native chat and any idle observation when the journal is ready to write. */
  private endTranscript(sessionId: string, target: { nativeSessionId: string; turnId?: string; rootId?: string },
    outcome: TurnOutcome, stillIdle?: () => boolean): Promise<boolean | undefined> {
    const stillCurrent = () => {
      if (this.closed || (stillIdle && !stillIdle())) return false;
      const session = this.port.getSession(sessionId);
      return !session.archivedAt && session.nativeSessionId === target.nativeSessionId;
    };
    return this.host.transcript.withSource(sessionId, (source, w) => {
      if (source instanceof CursorTranscriptSource && stillCurrent()) {
        return source.endTurn(w, { ...outcome, turnId: target.turnId, expectedRoot: target.rootId, stillCurrent });
      }
    }).catch(() => undefined);
  }

  dispose(sessionId: string): void { this.reject(sessionId, 'Conversation closed'); this.entries.delete(sessionId); }

  async close(): Promise<void> {
    this.closed = true;
    for (const sessionId of this.entries.keys()) this.reject(sessionId, 'Cursor hook bridge closed');
    this.entries.clear();
    await this.plugin?.catch(() => undefined);
    await this.server.close();
  }
}
