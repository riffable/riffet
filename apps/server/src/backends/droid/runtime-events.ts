import { dirname, join } from 'node:path';
import type { NativeContext, NativeInteraction, NativeWorkbenchEvent, Session } from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import { activityId } from '../../journal/activity.js';
import { agentTitlePatch, firstHumanMessage, firstMessageTitlePatch } from '../../session-title.js';
import { nativeModelEffort, parseNativeModelSelection } from '../shared/model-selection.js';
import type { NativeBackendHost } from '../types.js';
import {
  droidBackgroundActivity, droidBackgroundEnd, droidFireAndForgetResult, droidProviderNotice, droidToolResultEvent,
  droidUserEventId, isHiddenMessage, messageFromProtocol, projectDroidMessage, type DroidAttachmentInfo,
} from './events.js';
import { findDroidTranscript, readDroidTranscript, validateDroidSessionId } from './history.js';
import { publishDroidStep, settleDroidStep } from './metering.js';
import { DROID_NO_REPLY } from './rpc.js';
import {
  askUserQuestions, childTurnEnded, droidAutonomy, droidMode, droidModelValue, dropPending, errorMessage, finite,
  LATE_COMMAND_LIMIT, LATE_COMMAND_RETAIN_MS, LONG_CONTEXT_REQUEST, notify, permissionInteraction, questionInteraction,
  readSettings, RECENT_MESSAGES, record, REMEMBERED_EVENTS, settingsChange, str, SUBAGENT_LIMIT, SUBAGENT_POLL_MS, wake,
  type DroidConversation, type DroidProcess, type DroidSettings, type DroidSubagent,
} from './runtime-shared.js';

export interface DroidEventHost {
  readonly host: NativeBackendHost;
  emitStatus(state: DroidConversation): void;
  stop(state: DroidConversation, proc: DroidProcess): Promise<void>;
  scheduleIdleStop(state: DroidConversation): void;
  applySettings(state: DroidConversation, proc: DroidProcess, change: Partial<DroidSettings>, desired?: DroidSettings): Promise<void>;
  contextBudgetChanged(proc: DroidProcess, desired: DroidSettings): boolean;
  hasActiveWork(state: DroidConversation): boolean;
  endUnechoed(state: DroidConversation, commands: Array<[string, { commandId: string; runId: string }]>, reason: string): void;
}

export function keepLateDroidCommand(
  state: DroidConversation,
  rpcId: string,
  command: { commandId: string; runId: string; attachments?: DroidAttachmentInfo[] },
): void {
  const at = Date.now();
  for (const [id, item] of state.lateCommands) if (item.expiresAt <= at) state.lateCommands.delete(id);
  while (state.lateCommands.size >= LATE_COMMAND_LIMIT) state.lateCommands.delete(state.lateCommands.keys().next().value!);
  state.lateCommands.set(rpcId, { ...command, expiresAt: at + LATE_COMMAND_RETAIN_MS });
}

function takeLateCommand(state: DroidConversation, rpcId: string): { commandId: string; runId: string; attachments?: DroidAttachmentInfo[] } | undefined {
  const late = state.lateCommands.get(rpcId);
  if (!late) return undefined;
  state.lateCommands.delete(rpcId);
  if (late.expiresAt <= Date.now()) return undefined;
  const { expiresAt: _expiresAt, ...command } = late;
  return command;
}

/** Remembers events whose identity is new, forgetting the oldest beyond the limit; returns the new ones. */
export function keepDroidEvents(state: DroidConversation, events: NativeWorkbenchEvent[], eventHost?: DroidEventHost): NativeWorkbenchEvent[] {
  const fresh: NativeWorkbenchEvent[] = [];
  for (const event of events) {
    if (state.events.has(event.nativeId)) continue;
    state.events.set(event.nativeId, event);
    fresh.push(event);
  }
  noteDroidSubagents(state, fresh, eventHost);
  for (const id of state.events.keys()) {
    if (state.events.size <= REMEMBERED_EVENTS) break;
    state.events.delete(id);
  }
  return fresh;
}

function noteSeq(state: DroidConversation, seq: number | undefined): void {
  if (seq === undefined || (state.lastSeq !== undefined && seq <= state.lastSeq)) return;
  state.lastSeq = seq;
}

function patchSession(host: NativeBackendHost, state: DroidConversation, patch: Partial<Session> | undefined): void {
  if (!patch || !Object.keys(patch).length) return;
  state.session = host.updateSession(state.workbenchSessionId, patch);
  notify(state, { type: 'session', session: state.session });
}

/** Droid's `compacting_conversation` working state is the only signal of context compaction; it carries no token counts. */
function trackCompaction(state: DroidConversation, previous: string): void {
  const compacting = state.working === 'compacting_conversation';
  if (compacting && previous !== 'compacting_conversation' && !state.compaction) {
    const id = activityId('droid', `compaction:${Date.now().toString(36)}-${++state.compactions}`);
    state.compaction = id;
    state.activities.apply({ id, kind: 'compaction', status: 'running', title: '上下文压缩', startedAt: new Date().toISOString(), compaction: { trigger: 'auto' } });
  } else if (!compacting) {
    endCompaction(state);
  }
}

function endCompaction(state: DroidConversation): void {
  const id = state.compaction;
  if (!id) return;
  state.compaction = undefined;
  const current = state.activities.get(id);
  if (current) state.activities.apply({ ...current, status: 'completed' });
}

/** A `fireAndForget` Execute that started its process: a background task that Droid gives no way to stop or to hear back from. */
function trackBackgroundShell(state: DroidConversation, toolUseId: string, content: unknown, isError: boolean): void {
  const call = state.events.get(`tool:${toolUseId}`);
  const input = record(call?.data.rawInput);
  if (call?.data.toolName !== 'Execute' || input?.fireAndForget !== true) return;
  const started = droidFireAndForgetResult(content, isError);
  if (!started) return;
  const command = str(input.command), summary = str(input.summary);
  const activity = droidBackgroundActivity(toolUseId, { ...(command ? { command } : {}), ...(summary ? { summary } : {}) }, started, new Date().toISOString());
  if (started.pid) watchBackground(state);
  state.activities.apply(activity);
}

/**
 * Droid never reports the end of a `fireAndForget` command, so its process id is the evidence: once the
 * operating system has no such process, the command is over (its exit code is not known).
 */
function watchBackground(state: DroidConversation): void {
  if (state.backgroundWatch) return;
  const watch = setInterval(() => {
    const live = state.activities.live().filter(activity => /^droid:bg:\d+$/.test(activity.id));
    if (!live.length || state.disposed) { clearInterval(watch); if (state.backgroundWatch === watch) state.backgroundWatch = undefined; return; }
    for (const activity of live) {
      const ended = droidBackgroundEnd(activity);
      if (ended) state.activities.apply({ ...activity, status: ended });
    }
  }, 5_000);
  watch.unref();
  state.backgroundWatch = watch;
}

export function handleDroidNotification(eventHost: DroidEventHost, state: DroidConversation, proc: DroidProcess, notification: Record<string, unknown>): void {
  if (state.proc !== proc) return;
  switch (notification.type) {
    case 'droid_working_state_changed': {
      const previous = state.working;
      state.working = str(notification.newState) ?? 'idle';
      if (state.working === 'idle') state.requestStartAt = undefined;
      else if (state.requestStartAt === undefined) state.requestStartAt = Date.now();
      trackCompaction(state, previous);
      eventHost.emitStatus(state);
      return;
    }
    case 'create_message':
      handleMessage(eventHost, state, notification);
      return;
    case 'assistant_text_delta':
    case 'thinking_text_delta':
      handleDelta(eventHost.host, state, notification);
      return;
    case 'tool_result':
      handleToolResult(eventHost, state, notification);
      return;
    case 'child_session_available': {
      const toolCallId = str(notification.toolUseId);
      const childId = str(notification.childSessionId);
      if (toolCallId && childId) registerSubagent(eventHost, state, toolCallId, childId, true, str(notification.subagentType));
      return;
    }
    case 'session_compacted':
      endCompaction(state);
      void refreshDroidContext(state);
      return;
    case 'session_token_usage_changed': {
      const usage = record(notification.lastCallTokenUsage);
      if (usage) {
        const next = { inputTokens: finite(usage.inputTokens), outputTokens: finite(usage.outputTokens), cacheReadTokens: finite(usage.cacheReadTokens), cacheCreationTokens: finite(usage.cacheCreationTokens) };
        const previous = state.lastCallUsage;
        state.lastCallUsage = next;
        if (!previous || previous.inputTokens !== next.inputTokens || previous.outputTokens !== next.outputTokens || previous.cacheReadTokens !== next.cacheReadTokens || previous.cacheCreationTokens !== next.cacheCreationTokens) void refreshDroidContext(state);
      }
      return;
    }
    case 'session_title_updated':
      if (notification.updateType === 'llm_generated') {
        patchSession(eventHost.host, state, agentTitlePatch(eventHost.host.getSession(state.workbenchSessionId), str(notification.title), state.firstMessage));
      }
      return;
    case 'settings_updated': {
      const reported = readSettings(notification.settings);
      const acknowledgement = proc.settingsRequests.get(str(notification.requestId) ?? '');
      if (acknowledgement) acknowledgement.reported = reported;
      if (!acknowledgement && state.configuring === 0 && proc.pinnedModelId && reported.modelId && reported.modelId !== proc.pinnedModelId) {
        state.reported = { ...state.reported, ...reported };
        haltModelDrift(eventHost, state, proc, reported.modelId);
        return;
      }
      const changed = (reported.modelId !== undefined && reported.modelId !== state.reported?.modelId)
        || (reported.reasoningEffort !== undefined && reported.reasoningEffort !== state.reported?.reasoningEffort);
      adoptReportedSettings(eventHost, state, reported);
      if (changed && state.configuring === 0) void refreshDroidContext(state);
      return;
    }
    case 'agent_turn_completed':
      handleTurnEnd(eventHost, state, notification);
      return;
    case 'permission_resolved': {
      const requestId = str(notification.requestId);
      const index = state.pending.findIndex(item => item.rpcId === requestId);
      if (index >= 0) {
        state.pending.splice(index, 1)[0]!.resolve(DROID_NO_REPLY);
        eventHost.emitStatus(state);
      }
      return;
    }
    default:
  }
}

function handleMessage(eventHost: DroidEventHost, state: DroidConversation, notification: Record<string, unknown>): void {
  const host = eventHost.host;
  const message = messageFromProtocol(notification.message);
  if (!message) return;
  noteSeq(state, message.seq);
  const providerNotice = droidProviderNotice(message);
  if (providerNotice && state.proc) {
    state.proc.providerNotice = providerNotice;
    if (state.proc.modelMismatch) {
      state.failure = `${state.proc.modelMismatch} ${providerNotice}`;
      notify(state, { type: 'status', status: state.status });
    }
  }
  if (message.role === 'user' && !isHiddenMessage(message) && message.visibility !== 'user_only') {
    const requestId = str(notification.requestId) ?? '';
    const command = state.commands.get(requestId) ?? takeLateCommand(state, requestId);
    if (command) {
      state.commands.delete(requestId);
      state.turns.set(message.id, { commandId: command.commandId, runId: command.runId });
    }
    state.activeTurn = message.id;
    state.turnActive = true;
    state.requestStartAt = Date.now();
    const events = keepDroidEvents(state, projectDroidMessage(message, {
      sessionId: state.workbenchSessionId,
      ...(command ? { commandId: command.commandId, runId: command.runId, ...(command.attachments ? { attachments: command.attachments } : {}) } : {}),
    }), eventHost);
    const text = firstHumanMessage(events);
    if (text) {
      state.firstMessage ??= text;
      patchSession(host, state, firstMessageTitlePatch(host.getSession(state.workbenchSessionId), text));
    }
    if (events.length) wake(state);
    return;
  }
  const turn = state.activeTurn ? state.turns.get(state.activeTurn) : undefined;
  keepDroidEvents(state, projectDroidMessage(message, { sessionId: state.workbenchSessionId, ...(turn ? { runId: turn.runId } : {}) }), eventHost);
  for (const [key, block] of state.drafts) if (block.messageId === message.id) state.drafts.delete(key);
  if (message.role === 'assistant') {
    const hasToolUse = message.content.some(block => record(block)?.type === 'tool_use');
    settleDroidStep(host, msg => notify(state, msg), state, message.id, true, hasToolUse);
    state.requestStartAt = undefined;
  }
  wake(state);
}

function handleDelta(host: NativeBackendHost, state: DroidConversation, notification: Record<string, unknown>): void {
  const messageId = str(notification.messageId);
  const delta = str(notification.textDelta);
  if (!messageId || !delta) return;
  const now = Date.now();
  const step = state.steps.get(messageId) ?? {
    ...(state.activeTurn ? { turnId: state.activeTurn } : {}),
    text: '',
    requestStartAt: state.requestStartAt ?? now,
    startedAt: now,
    lastAt: now,
  };
  step.text += delta;
  step.lastAt = now;
  state.steps.set(messageId, step);
  publishDroidStep(host, msg => notify(state, msg), state, messageId, step, true);
  const blockIndex = typeof notification.blockIndex === 'number' && Number.isSafeInteger(notification.blockIndex) && notification.blockIndex >= 0 ? notification.blockIndex : 0;
  const key = `${messageId}:${blockIndex}:${String(notification.type)}`;
  const block = state.drafts.get(key) ?? { messageId, blockIndex, thought: notification.type === 'thinking_text_delta', text: '', at: new Date(now).toISOString() };
  block.text += delta;
  state.drafts.set(key, block);
  wake(state);
}

function handleToolResult(eventHost: DroidEventHost, state: DroidConversation, notification: Record<string, unknown>): void {
  const toolUseId = str(notification.toolUseId);
  const messageId = str(notification.messageId);
  if (!toolUseId || !messageId) return;
  if (state.toolMessage?.id !== messageId) {
    const seq = (state.lastSeq ?? -1) + 1;
    state.toolMessage = { id: messageId, seq };
    noteSeq(state, seq);
  }
  const tool = state.toolMessage;
  const turn = state.activeTurn ? state.turns.get(state.activeTurn) : undefined;
  const event = droidToolResultEvent({ seq: tool.seq, createdAt: new Date().toISOString() }, {
    toolUseId,
    content: notification.content,
    isError: notification.isError === true,
  }, { sessionId: state.workbenchSessionId, ...(turn ? { runId: turn.runId } : {}) });
  if (event) keepDroidEvents(state, [event]);
  const subagent = state.subagents.get(toolUseId);
  if (subagent?.running) finishSubagent(eventHost, state, subagent);
  state.requestStartAt = Date.now();
  wake(state);
  trackBackgroundShell(state, toolUseId, notification.content, notification.isError === true);
}

function handleTurnEnd(eventHost: DroidEventHost, state: DroidConversation, notification: Record<string, unknown>): void {
  const turnId = str(notification.turnId) ?? state.activeTurn;
  const reason = state.proc?.modelMismatch ? 'model_changed' : str(notification.reason) ?? 'completed';
  const turn = turnId ? state.turns.get(turnId) : undefined;
  const superseded = state.activeTurn !== undefined && turnId !== undefined && state.activeTurn !== turnId;
  for (const [messageId, step] of state.steps) {
    if (!superseded || step.turnId === turnId) settleDroidStep(eventHost.host, msg => notify(state, msg), state, messageId, !superseded);
  }
  recordChildUsage(eventHost.host, state, turnId, notification);
  // An interrupted turn can finish after its replacement has already echoed. Its accounting
  // still settles, but the new turn owns the drafts, requests, children and deferred settings.
  if (superseded) {
    wake(state);
    void refreshDroidContext(state);
    return;
  }
  // A turn Droid ended before it wrote the user message (a refused model, say) never names its
  // command; its run would otherwise wait for a receipt that is not coming. Later commands stay
  // bound: an interrupted turn can end after the message that replaces it was sent.
  const sawPrompt = turnId !== undefined && state.events.has(droidUserEventId(turnId));
  const oldest = turn || sawPrompt ? undefined : state.commands.entries().next().value;
  if (oldest) {
    state.commands.delete(oldest[0]);
    eventHost.endUnechoed(state, [oldest], reason === 'completed' ? 'error' : reason);
  }
  wake(state);
  for (const item of state.subagents.values()) {
    // A background child outlives the turn that started it; its own outcome settles it.
    if (item.running && !item.background) finishSubagent(eventHost, state, item);
  }
  state.drafts.clear();
  state.turnActive = state.commands.size > 0;
  state.activeTurn = undefined;
  state.toolMessage = undefined;
  state.requestStartAt = undefined;
  dropPending(state);
  const proc = state.proc;
  const deferred = state.deferred;
  if (proc && deferred && !proc.stopping && !proc.modelMismatch) {
    // A setter can wait for native compaction. Queue the entire application behind the same
    // session lock as send/configure so an older setter cannot land after a newer dispatch.
    void eventHost.host.withSessionLock(state.workbenchSessionId, async () => {
      if (state.disposed || state.proc !== proc || proc.exited || proc.stopping || proc.modelMismatch || state.deferred !== deferred || state.turnActive) return;
      if (eventHost.contextBudgetChanged(proc, deferred)) {
        if (eventHost.hasActiveWork(state)) return;
        await eventHost.stop(state, proc);
      } else {
        const change = settingsChange(state.reported, deferred);
        if (change) await eventHost.applySettings(state, proc, change, deferred);
      }
      if (state.deferred === deferred) state.deferred = undefined;
    }).catch(error => { state.failure = errorMessage(error); eventHost.emitStatus(state); });
  }
  eventHost.emitStatus(state);
  void refreshDroidContext(state);
}

/**
 * Follows a change Droid made itself: "always allow" raises autonomy, and leaving spec mode
 * switches to the autonomy the user picked on the plan card.
 */
function adoptReportedSettings(eventHost: DroidEventHost, state: DroidConversation, reported: Partial<DroidSettings>): void {
  state.reported = { ...state.reported, ...reported };
  // The CLI still reports the settings of its in-flight turn after a picker change was saved.
  // Keep that observation for the eventual diff, without undoing the deferred desired settings.
  if (state.configuring > 0 || state.deferred) return;
  const session = eventHost.host.getSession(state.workbenchSessionId);
  const patch: Partial<Session> = {};
  if (reported.autonomyLevel && reported.autonomyLevel !== droidAutonomy(session.approval)) patch.approval = reported.autonomyLevel;
  if (reported.interactionMode) {
    const mode = reported.interactionMode === 'spec' ? 'spec' : 'agent';
    if (mode !== droidMode(session.mode)) patch.mode = mode;
  }
  const selected = parseNativeModelSelection(session.model);
  if (reported.modelId || reported.reasoningEffort) {
    const model = reported.modelId ?? selected.model;
    const effort = reported.reasoningEffort ?? nativeModelEffort(selected);
    const next = droidModelValue(model, effort, selected.params.context === 'long' ? LONG_CONTEXT_REQUEST : undefined);
    if (next !== session.model) patch.model = next;
  }
  if (!Object.keys(patch).length) return;
  state.session = eventHost.host.bumpConfig(state.workbenchSessionId, patch);
  notify(state, { type: 'session', session: state.session });
  eventHost.emitStatus(state);
}

function haltModelDrift(eventHost: DroidEventHost, state: DroidConversation, proc: DroidProcess, actualModelId: string): void {
  if (proc.modelMismatch) return;
  proc.modelMismatch = `Droid changed the requested model from ${proc.pinnedModelId} to ${actualModelId}. The turn was stopped; the selected model was preserved.`;
  state.failure = `${proc.modelMismatch}${proc.providerNotice ? ` ${proc.providerNotice}` : ''}`;
  eventHost.emitStatus(state);
  void eventHost.stop(state, proc).catch(error => {
    state.failure = `${state.failure} ${errorMessage(error)}`;
    eventHost.emitStatus(state);
  });
}

export async function handleDroidRequest(
  eventHost: DroidEventHost,
  state: DroidConversation,
  proc: DroidProcess,
  method: string,
  params: Record<string, unknown>,
  rpcId: string,
): Promise<unknown> {
  if (state.proc !== proc) throw new Error('This Droid process is no longer attached to the workbench');
  if (proc.stopping || proc.modelMismatch) throw new Error('Droid is stopping; no further tool or user guidance will be accepted');
  const id = `droid:${state.nativeSessionId ?? state.workbenchSessionId}:${rpcId}`;
  let interaction: NativeInteraction;
  if (method === 'droid.request_permission') {
    interaction = permissionInteraction(id, rpcId, params);
    if (!interaction.actions.length) return { selectedOption: 'cancel' };
  } else if (method === 'droid.ask_user') {
    const questions = askUserQuestions(params);
    if (!questions.length) return { cancelled: true, answers: [] };
    interaction = questionInteraction(id, rpcId, questions, 0);
  } else {
    throw new Error(`Unsupported Droid request: ${method}`);
  }
  return await new Promise<unknown>(resolvePromise => {
    state.pending.push({ rpcId, method, params, interaction, questionIndex: 0, answers: [], resolve: resolvePromise });
    eventHost.emitStatus(state);
  });
}

/**
 * Registers the children that projected `Task` results name, in the conversation or in a
 * subagent's own transcript (whose calls are not resident).
 */
function noteDroidSubagents(state: DroidConversation, events: readonly NativeWorkbenchEvent[], eventHost?: DroidEventHost): void {
  for (const event of events) {
    if (event.type !== 'tool_call_update') continue;
    const toolCallId = str(event.data.toolCallId);
    const childId = str(record(event.data.subagentResult)?.agentId);
    if (!toolCallId || !childId || state.subagents.has(toolCallId)) continue;
    const call = events.find(item => item.type === 'tool_call' && item.data.toolCallId === toolCallId) ?? state.events.get(`tool:${toolCallId}`);
    registerSubagent(eventHost, state, toolCallId, childId, false, undefined, record(call?.data.subagent));
  }
}

/** `call` is the spawning call's `subagent` data; a live child's call is resident in the conversation. */
function registerSubagent(
  eventHost: DroidEventHost | undefined,
  state: DroidConversation,
  toolCallId: string,
  childId: string,
  running: boolean,
  subagentType?: string,
  call = record(state.events.get(`tool:${toolCallId}`)?.data.subagent),
): void {
  try { validateDroidSessionId(childId); } catch { return; }
  let item = state.subagents.get(toolCallId);
  if (!item) {
    const type = subagentType ?? str(call?.type);
    item = { toolCallId, childId, background: call?.background === true, running: false, lastChangeAt: Date.now(), ...(type ? { subagentType: type } : {}) };
    state.subagents.set(toolCallId, item);
    while (state.subagents.size > SUBAGENT_LIMIT) {
      const items = [...state.subagents.values()];
      const evicted = items.filter(entry => !entry.running).sort((left, right) => left.lastChangeAt - right.lastChangeAt)[0] ?? items[0]!;
      state.subagents.delete(evicted.toolCallId);
    }
    scheduleSubagents(eventHost, state);
  }
  if (running && !item.running) {
    item.running = true;
    scheduleSubagents(eventHost, state);
    notify(state, { type: 'subagent', toolCallId, agentId: childId, running: true });
  }
  if (state.subagents.has(toolCallId)) void syncSubagent(eventHost, state, item);
}

/** Keeps exactly one child poll per conversation, and only while one of its children runs. */
function scheduleSubagents(eventHost: DroidEventHost | undefined, state: DroidConversation): void {
  const running = !state.disposed && [...state.subagents.values()].some(item => item.running);
  if (running && !state.subagentTimer) {
    state.subagentTimer = setInterval(() => {
      for (const item of state.subagents.values()) if (item.running) void syncSubagent(eventHost, state, item);
    }, SUBAGENT_POLL_MS);
    state.subagentTimer.unref();
  } else if (!running && state.subagentTimer) {
    clearInterval(state.subagentTimer);
    state.subagentTimer = undefined;
  }
}

/** The child stopped (its result arrived, or the turn ended): one last read settles its page. */
export function finishDroidSubagent(eventHost: DroidEventHost | undefined, state: DroidConversation, item: DroidSubagent): void {
  finishSubagent(eventHost, state, item);
}

function finishSubagent(eventHost: DroidEventHost | undefined, state: DroidConversation, item: DroidSubagent): void {
  item.running = false;
  scheduleSubagents(eventHost, state);
  // Budget changes are applied on the next send; finishing a child must never stop its parent.
  eventHost?.scheduleIdleStop(state);
  void (async () => {
    await item.syncing?.catch(() => undefined);
    await syncSubagent(eventHost, state, item);
    notify(state, { type: 'subagent', toolCallId: item.toolCallId, agentId: item.childId, running: false });
  })();
}

/** Children live beside their parent's session file. */
async function childPath(state: DroidConversation, childId: string): Promise<string | undefined> {
  if (!state.nativeSessionId) return undefined;
  const parent = await findDroidTranscript(state.nativeSessionId, state.project.cwd);
  return parent ? join(dirname(parent), `${childId}.jsonl`) : undefined;
}

/** Reads a child's session file: the subagents it started in turn, and whether a background child is done. Its lane reads the same file. */
async function syncSubagent(eventHost: DroidEventHost | undefined, state: DroidConversation, item: DroidSubagent): Promise<void> {
  if (item.syncing) return await item.syncing;
  const task = (async () => {
    const path = await childPath(state, item.childId);
    const transcript = path ? await readDroidTranscript(path, item.childId).catch(() => undefined) : undefined;
    if (!transcript || state.subagents.get(item.toolCallId) !== item) return;
    item.lastChangeAt = Date.now();
    wake(state);
    noteDroidSubagents(state, transcript.chain.slice(-RECENT_MESSAGES).flatMap(message => projectDroidMessage(message, { sessionId: state.workbenchSessionId })), eventHost);
    if (item.running && item.background && childTurnEnded(transcript)) finishSubagent(eventHost, state, item);
  })();
  item.syncing = task;
  try { await task; } finally { if (item.syncing === task) item.syncing = undefined; }
}

/** Droid reports what a turn's subagents spent only in total, at the end of the turn. */
function recordChildUsage(host: NativeBackendHost, state: DroidConversation, turnId: string | undefined, notification: Record<string, unknown>): void {
  const usage = record(notification.childTokenUsage);
  const outputTokens = finite(usage?.outputTokens);
  if (!turnId || !usage || !outputTokens) return;
  const endedAt = Date.now();
  const durationMs = finite(notification.durationMs);
  try {
    host.stats.recordUsage(state.workbenchSessionId, state.turns.get(turnId)?.runId, {
      stepId: `${turnId}:subagents`,
      agentKind: 'subagent',
      ...(durationMs !== undefined ? { startedAt: endedAt - durationMs } : {}),
      endedAt,
      tokenSource: 'provider',
      outputTokens,
      ...(finite(usage.inputTokens) !== undefined ? { inputTokens: finite(usage.inputTokens) } : {}),
      ...(finite(usage.cacheReadTokens) !== undefined ? { cacheReadTokens: finite(usage.cacheReadTokens) } : {}),
      ...(finite(usage.cacheCreationTokens) !== undefined ? { cacheWriteTokens: finite(usage.cacheCreationTokens) } : {}),
      ...(finite(usage.thinkingTokens) !== undefined ? { reasoningTokens: finite(usage.thinkingTokens) } : {}),
    });
  } catch { /* statistics must never affect the stream */ }
}

export async function refreshDroidContext(state: DroidConversation, required = false): Promise<void> {
  const proc = state.proc;
  if (!proc || proc.exited || proc.stopping) {
    if (required) throw new AppError('NATIVE_CONTEXT_BUDGET_UNCONFIRMED', 'Droid stopped before confirming the effective context budget.', 503);
    return;
  }
  const sequence = ++proc.contextRefreshSequence;
  try {
    const breakdown = await proc.rpc.request<Record<string, unknown>>('droid.get_context_breakdown', {}, { timeoutMs: 15_000 });
    if (state.proc !== proc || proc.exited || proc.stopping) {
      if (required) throw new AppError('NATIVE_CONTEXT_BUDGET_UNCONFIRMED', 'Droid changed processes before confirming the effective context budget.', 503);
      return;
    }
    const size = finite(breakdown.contextBudget);
    if (size === undefined || size <= 0) {
      if (required) throw new AppError('NATIVE_CONTEXT_BUDGET_UNCONFIRMED', 'Droid did not report an effective context budget; the long-context request was not confirmed.', 503);
      return;
    }
    if (sequence !== proc.contextRefreshSequence) return;
    // usedTokens/categories estimate message characters. The native compaction meter instead
    // uses the last call's measured input/cache/output total; it may legitimately exceed budget.
    const used = finite(breakdown.lastCallCompactionTokens);
    if (used === undefined || used < 0) {
      state.context = undefined;
      notify(state, { type: 'context' });
      return;
    }
    const context: NativeContext = {
      used,
      size,
      limitKind: 'compaction',
      breakdownEstimated: true,
      breakdown: (Array.isArray(breakdown.categories) ? breakdown.categories : []).flatMap(item => {
        const category = record(item);
        const label = str(category?.name);
        const tokens = finite(category?.tokens);
        if (!label || tokens === undefined) return [];
        return [{ id: str(category?.colorKey) ?? label.toLowerCase().replace(/\W+/g, '-'), label, tokens }];
      }),
    };
    state.context = context;
    notify(state, { type: 'context', context });
  } catch (error) {
    if (required) throw error;
    // The meter keeps its last value during ordinary background refreshes.
  }
}
