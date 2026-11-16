import type { NativeStatus, NativeTurnTarget, NativeWorkbenchEvent, Run } from '@contracts';
import { AppError, DeferredSteerInputs, NativeHookServer, type SteerBinding, type SteerHost } from '@riffet/plugin-api/kit';
import {
  type AgentDispatchBinding, type AgentHost, type AgentRunRef, type AgentSendRequest, type AgentSessionView, type AgentTurnStatus,
} from '@riffet/plugin-api/experimental/agent';
import type { CursorLaunchProfile } from '../cli-driver.js';
import type { CursorPort } from '../host-port.js';
import type { NativeService } from '../native/service.js';
import { chatStorePath } from '../native/chat-store.js';
import { resolveShellCall } from './shell-observation.js';
import { probeCursorHookSteer, writeCursorHookPlugin } from './launch-plugin.js';
import { CursorTranscriptSource } from './transcript-source.js';

interface ActiveGeneration extends NativeTurnTarget { terminalId: string; epoch: number }
interface Entry {
  inputs: DeferredSteerInputs;
  active?: ActiveGeneration;
  retired: Set<string>;
  ended: Set<string>;
  /** The settled store (its root) the journal last read: a store idle on its answer is read once, not every poll. */
  answered?: string;
}
/**
 * A hook ends a turn as soon as the CLI stops it, which can be before the CLI has committed the step it
 * cut short; the journal reads the store after this long, so that step stays in the turn it belongs to.
 */
const TRANSCRIPT_END_DELAY_MS = 3_000;
const TURN_END_STATUS = { run_completed: 'completed', run_failed: 'failed', run_cancelled: 'cancelled' } as const satisfies Record<string, AgentTurnStatus>;
const sameTarget = (left: NativeTurnTarget | undefined, right: NativeTurnTarget) => left?.nativeSessionId === right.nativeSessionId && left.turnId === right.turnId;

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
      transcript: (session, events) => { for (const receipt of this.receiptEvents(session, events)) host.emitEvent(session.id, receipt); },
      offline: session => this.reject(session.id, 'Cursor connection is no longer writable'),
      answered: (session, target) => this.answered(session, target),
    });
  }

  bind(sessionId: string): Entry {
    let entry = this.entries.get(sessionId);
    if (!entry) {
      entry = { retired: new Set(), ended: new Set(), inputs: new DeferredSteerInputs(this.steerHost, {
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
    if (terminal.state === 'exited' || terminal.epoch !== active.epoch || !sameTarget(this.activeTurn(this.port.getSession(sessionId)), request.target)) {
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
    await this.observeShell(session, payload);
    return this.port.withSessionLock(session.id, async () => {
      const current = this.port.getSession(session.id);
      if (signal.aborted || current.archivedAt || current.nativeSessionId !== nativeSessionId) return {};
      const interruptedTool = event === 'postToolUseFailure' && payload.is_interrupt === true;
      if (event === 'stop' || event === 'sessionEnd' || interruptedTool) {
        this.end(entry, session.id, target, !interruptedTool && payload.status === 'completed' ? 'run_completed' : payload.status === 'error' ? 'run_failed' : 'run_cancelled');
        return {};
      }
      if (entry.retired.has(turnId)) return {};
      if (event === 'beforeSubmitPrompt') {
        if (entry.active && !sameTarget(entry.active, target)) this.reject(session.id, 'Cursor generation changed before the input was consumed');
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
          if (previous === 'answered') this.end(entry, session.id, entry.active, 'run_completed');
          else this.reject(session.id, 'Cursor started another generation');
        }
        entry.active = { ...target, terminalId: terminal.id, epoch: terminal.epoch };
        this.native.notifyTurnChanged(session.id);
        return {};
      }
      if (event !== 'postToolUse' && event !== 'postToolUseFailure') return {};
      if (!sameTarget(this.activeTurn(this.port.getSession(session.id)), target) || entry.active?.epoch !== terminal.epoch) return {};
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
   * Never fails the hook; a command that cannot be told from another running the same text is left unobserved.
   */
  private async observeShell(session: AgentSessionView, payload: Record<string, unknown>): Promise<void> {
    const changes = this.host.workspaceChanges;
    const event = payload.hook_event_name;
    const hookId = payload.tool_use_id;
    const input = payload.tool_input as { command?: unknown; block_until_ms?: unknown; cwd?: unknown } | undefined;
    if (!changes || payload.tool_name !== 'Shell' || typeof hookId !== 'string' || !hookId) return;
    if (event !== 'preToolUse' && event !== 'postToolUse' && event !== 'postToolUseFailure') return;
    try {
      if (event === 'preToolUse') {
        // `block_until_ms: 0` backgrounds the command: it outlives its hooks, so there is no end to compare at.
        if (typeof input?.command !== 'string' || input.block_until_ms === 0) return;
        const roots = payload.workspace_roots;
        const cwd = [input.cwd, payload.cwd, Array.isArray(roots) ? roots[0] : undefined].find((value): value is string => typeof value === 'string' && value !== '')
          ?? this.port.getProject(session.projectId).cwd;
        await changes.begin(session.id, hookId, cwd);
        return;
      }
      const diffs = await changes.end(session.id, hookId);
      if (!diffs?.length || typeof input?.command !== 'string' || typeof payload.conversation_id !== 'string') return;
      const store = chatStorePath(this.profile.configDir, this.port.getProject(session.projectId).cwd, payload.conversation_id);
      const callId = await resolveShellCall(store, input.command);
      if (callId) changes.record(session.id, callId, diffs);
    } catch { /* observation is best effort */ }
  }

  /**
   * The chat store ends on an answer while the CLI sits idle. That is the CLI's own record of a
   * finished turn, and the only one left when the provider never asks for the Stop hook (some
   * gateways do not), so it ends the turn as completed. Whichever of the two arrives first wins.
   *
   * The generation the hooks are tracking ends whatever turn the store names: a turn the CLI starts
   * itself after a task notification carries no request id. A turn no hook tracks ends only while
   * a run still waits on it (the service restarted mid-turn); a turn already over is left as it was.
   */
  answered(session: AgentSessionView, answer: { nativeSessionId: string; turnId?: string; rootId?: string }): void {
    const entry = this.entries.get(session.id);
    if (!entry || session.nativeSessionId !== answer.nativeSessionId) return;
    if (entry.active?.nativeSessionId === answer.nativeSessionId) this.end(entry, session.id, entry.active, 'run_completed');
    if (answer.turnId && !entry.ended.has(answer.turnId)) {
      const target = { nativeSessionId: answer.nativeSessionId, turnId: answer.turnId };
      if (this.owner(session.id, target)?.state === 'running') this.end(entry, session.id, target, 'run_completed');
    }
    // The journal ends a turn whose store ends on an answer as it reads it; this read is for a session nobody follows.
    const settled = `${answer.nativeSessionId}:${answer.rootId ?? ''}`;
    if (entry.answered === settled) return;
    entry.answered = settled;
    this.endTranscript(session.id, 'completed', answer.turnId, 0);
  }

  private end(entry: Entry, sessionId: string, target: NativeTurnTarget, type: 'run_completed' | 'run_failed' | 'run_cancelled'): void {
    const { nativeSessionId, turnId } = target;
    if (entry.ended.has(turnId)) return;
    entry.ended.add(turnId);
    if (entry.ended.size > 256) entry.ended.delete(entry.ended.values().next().value!);
    this.retire(entry, turnId);
    if (sameTarget(entry.active, target)) entry.active = undefined;
    entry.inputs.finish(target, { type });
    const owner = this.owner(sessionId, target);
    this.host.emitEvent(sessionId, {
      ...(owner ? { runId: owner.id } : {}), nativeTurnId: turnId,
      nativeId: `cursor:${nativeSessionId}:${turnId}:terminal`, type,
      data: { sessionUpdate: type, ...(owner ? { commandId: owner.commandId, nativeMessageId: owner.nativeMessageId } : {}), nativeSessionId, nativeTurnId: turnId }, createdAt: new Date().toISOString(),
    });
    this.endTranscript(sessionId, TURN_END_STATUS[type], turnId, TRANSCRIPT_END_DELAY_MS);
    this.onTurnEnded?.(sessionId);
    this.native.notifyTurnChanged(sessionId);
  }

  /**
   * Ends the turn on the session journal (sync v3) when its store will not: a step that never returned
   * leaves it open there. The store is read first, and a turn that read ended stays as it was. Hooks
   * never wait for it.
   */
  private endTranscript(sessionId: string, status: AgentTurnStatus, turnId: string | undefined, delayMs: number): void {
    const at = new Date().toISOString();
    const end = () => void this.host.transcript.withSource(sessionId, (source, w) => (source instanceof CursorTranscriptSource ? source.endTurn(w, status, at, turnId) : undefined)).catch(() => undefined);
    if (delayMs) setTimeout(end, delayMs).unref();
    else end();
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
