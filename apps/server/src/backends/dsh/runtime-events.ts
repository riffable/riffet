import type { NativeStatus, NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';
import { estimateTokens } from '../../metrics/tokens.js';
import { runTracker, type RunMetricsTracker } from '../../metrics/turn-metrics.js';
import { firstHumanMessage, providerTitlePatch } from '../../session-title.js';
import type { NativeBackendProfileConfig } from '../types.js';
import { projectDshEvent } from './events.js';
import { dshGoalChange } from './goal.js';
import { canonicalDshModelValue, configAdoption, displayedPermission } from './selection.js';
import type { DshRuntimeSettings } from './settings.js';
import { dshAttemptWindow, dshTurns, mergeDshUsage, openTurn, pickRunId, readDshUsage, recentRecord, sessionGeneration, statusFor } from './transcript.js';
import type { DshAttachmentInfo, DshAttempt, DshConversation, DshSessionReadResult, DshSubagent } from './types.js';
import { asRecord, nonEmpty } from './util.js';
import {
  nameDshFromMessage, noteDshContext, noteDshContextBreakdown, notifyListeners, projectDshChild, REMEMBERED_EVENTS,
  rememberDshEvent, rememberDshTurnCommand, SUBAGENT_IDLE_POLL_MS, SUBAGENT_INITIAL_RECORDS, SUBAGENT_LIMIT, TRANSCRIPT_PAGE_SIZE,
} from './runtime-shared.js';

export interface DshEventHost {
  readonly settings: DshRuntimeSettings;
  isConfiguring(sessionId: string): boolean;
  ensureStarted(provision: boolean): Promise<boolean>;
  readPage(state: DshConversation, before: number | undefined, limit: number, nativeSessionId?: string, after?: number): Promise<DshSessionReadResult>;
  noteObservers(nativeSessionId: string, method: string, params: Record<string, unknown>): void;
  cacheEvents(state: DshConversation, rawEvents: unknown[]): NativeWorkbenchEvent[];
  refreshSubagents(state: DshConversation, items?: readonly DshSubagent[]): Promise<void>;
  statusFromResponse(state: DshConversation, response: DshSessionReadResult['status'] | { status?: 'busy' | 'idle'; model?: string; provider?: string; reasoningEffort?: string; approval?: string; permission?: string } | undefined): NativeStatus;
  emitStatus(state: DshConversation): void;
  markOffline(state: DshConversation, error: unknown): void;
  turnFailureMessage(data: Record<string, unknown>, profile?: NativeBackendProfileConfig): string | undefined;
}

export async function readRecentDshEvents(host: DshEventHost, state: DshConversation): Promise<DshSessionReadResult> {
  let page = await host.readPage(state, undefined, TRANSCRIPT_PAGE_SIZE);
  if (!page.found || !page.hasMore) return page;
  const newest: unknown[][] = [page.events];
  let start = page.start;
  let collected = page.events.length;
  while (start > 0 && collected < REMEMBERED_EVENTS) {
    page = await host.readPage(state, start, Math.min(TRANSCRIPT_PAGE_SIZE, REMEMBERED_EVENTS - collected));
    if (!page.found || !page.events.length) break;
    newest.unshift(page.events);
    collected += page.events.length;
    start = page.start;
  }
  const last = page;
  return {
    ...last,
    found: true,
    nativeSessionId: state.nativeSessionId,
    events: newest.flat(),
    start,
    before: last.total,
    total: last.total,
    hasMore: start > 0,
  };
}

/**
 * Reads the conversation's newest records once a subscriber attaches: the status, context and settings
 * DSH reports with them, and the subagents they started. Their transcript reaches clients through the
 * journal (`journal-source.ts`).
 */
export async function refreshDshConversation(host: DshEventHost, state: DshConversation): Promise<void> {
  const statusBeforeRead = state.status;
  let result: DshSessionReadResult;
  try {
    if (!await host.ensureStarted(false)) return;
    result = await readRecentDshEvents(host, state);
  } catch (error) {
    host.markOffline(state, error);
    return;
  }
  if (!result.found) {
    if (state.status === statusBeforeRead) { state.status = { phase: 'offline' }; host.emitStatus(state); }
    return;
  }
  // Before the events are folded, so the fact that arrived with this page and the ones inside it
  // publish as one frame.
  noteDshContextBreakdown(state, result.contextBreakdown);
  const events = host.cacheEvents(state, result.events);
  state.historyTotal = result.total;
  noteDshSubagents(state, events);
  await host.refreshSubagents(state);
  // Reading history and children can take seconds. A live notification received during either
  // read is newer than this and must keep its activity phase.
  if (state.status === statusBeforeRead) {
    state.status = state.active ? host.statusFromResponse(state, result.status) : { ...host.statusFromResponse(state, result.status), phase: dshTurns.report(state, 'idle') };
  }
  const adoption = configAdoption({
    // Only a preset DSH itself reported is followed: an idle read, or knob values matching no
    // preset, report none, and the record is re-applied at the next open or send instead.
    reported: { model: state.status.model, approval: result.status?.permission },
    recorded: { model: state.session.model, approval: state.session.approval },
    configuring: host.isConfiguring(state.workbenchSessionId),
    canonical: value => canonicalDshModelValue(value, host.settings.defaultModel),
  });
  const permission = displayedPermission(adoption.approval);
  state.status = {
    ...state.status,
    model: adoption.model,
    ...(permission !== undefined ? { approval: permission, permission } : {}),
  };
  if (adoption.patch) {
    state.session = adoption.bump ? state.host.bumpConfig(state.workbenchSessionId, adoption.patch) : state.host.updateSession(state.workbenchSessionId, adoption.patch);
    notifyListeners(state, { type: 'session', session: state.session });
  }
  host.emitStatus(state);
}

export async function pollDshConversation(host: DshEventHost, state: DshConversation, hasPeer: boolean): Promise<void> {
  if (!state.listeners.size || !hasPeer) return;
  const statusBeforeRead = state.status;
  try {
    // Every read replays the whole DSH log, so the newest window and the records after the cursor
    // come back from one read; only a gap wider than a page needs more.
    const newest = await host.readPage(state, undefined, TRANSCRIPT_PAGE_SIZE, state.nativeSessionId, state.historyTotal);
    if (!newest.found) return;
    const previousTotal = state.historyTotal;
    if (newest.total !== previousTotal) host.noteObservers(state.nativeSessionId, 'session/read', { total: newest.total });
    const resetRequired = newest.total < previousTotal || newest.total - previousTotal > REMEMBERED_EVENTS;
    if (resetRequired) {
      const result = await readRecentDshEvents(host, state);
      const events = host.cacheEvents(state, result.events);
      state.historyTotal = result.total;
      noteDshSubagents(state, events);
      await host.refreshSubagents(state);
      if (result.status && state.status === statusBeforeRead) {
        state.status = host.statusFromResponse(state, result.status);
        host.emitStatus(state);
      }
      return;
    }
    if (newest.total > state.historyTotal) {
      const newestStart = newest.start ?? Math.max(0, newest.total - newest.events.length);
      let before = newestStart;
      const rawPages: unknown[][] = [newest.events.slice(Math.max(0, state.historyTotal - newestStart))];
      while (before > state.historyTotal) {
        const limit = Math.min(TRANSCRIPT_PAGE_SIZE, before - state.historyTotal);
        const page = await host.readPage(state, before, limit);
        if (!page.found || page.start >= before) break;
        rawPages.unshift(page.events);
        before = page.start;
      }
      const rawEvents = rawPages.flat();
      const previous = new Set(state.events.keys());
      noteDshSubagents(state, host.cacheEvents(state, rawEvents).filter(event => !previous.has(event.nativeId)));
    }
    state.historyTotal = newest.total;
    await host.refreshSubagents(state);
    // Status can change without a durable record. Polling also repairs missed notifications,
    // but never replaces a live update that arrived while the snapshot/children were read.
    if (newest.status && state.status === statusBeforeRead) {
      state.status = host.statusFromResponse(state, newest.status);
      host.emitStatus(state);
    }
  } catch (error) {
    host.markOffline(state, error);
  }
}

export function cacheDshEvents(host: DshEventHost, state: DshConversation, rawEvents: unknown[]): NativeWorkbenchEvent[] {
  noteDshContext(state, rawEvents);
  const projected = projectDshEvents(host, state, rawEvents);
  for (const event of projected) rememberDshEvent(state, event);
  return projected;
}

export function projectDshEvents(host: DshEventHost, state: DshConversation, rawEvents: unknown[]): NativeWorkbenchEvent[] {
  const result: NativeWorkbenchEvent[] = [];
  let activeTurn: number | undefined;
  const turnCommands = new Map<number, string>();
  for (const raw of rawEvents) {
    const event = asRecord(raw);
    if (!event) continue;
    const data = asRecord(event.data) ?? {};
    if (event.type === 'turn/start' && Number.isSafeInteger(data.turn)) activeTurn = data.turn as number;
    const messageCommandId = event.type === 'user/message' && asRecord(data.source)?.kind === 'user'
      ? nonEmpty(asRecord(data.source)?.rpcId)
      : undefined;
    if (event.type === 'user/message' && asRecord(data.source)?.kind !== 'user') continue;
    if (messageCommandId && activeTurn !== undefined) {
      turnCommands.set(activeTurn, messageCommandId);
      rememberDshTurnCommand(state, activeTurn, messageCommandId);
    }
    const commandId = messageCommandId ?? (event.type === 'turn/end' && Number.isSafeInteger(data.turn) ? turnCommands.get(data.turn as number) : undefined);
    const resolvedCommandId = commandId ?? (event.type === 'turn/end' && Number.isSafeInteger(data.turn) ? state.turnCommands.get(data.turn as number) : undefined);
    const liveCommand = resolvedCommandId ? state.commandMap.get(resolvedCommandId) : undefined;
    result.push(...projectDshEvent(event, {
      sessionId: state.workbenchSessionId,
      ...(liveCommand ? { runId: liveCommand.runId } : {}),
      ...(resolvedCommandId ? { commandId: resolvedCommandId } : {}),
      ...(liveCommand?.attachments ? { attachments: liveCommand.attachments } : {}),
      ...(event.type === 'turn/end' ? { failureMessage: host.turnFailureMessage(data, state.profile) } : {}),
    }));
    if (event.type === 'turn/end' && Number.isSafeInteger(data.turn)) {
      turnCommands.delete(data.turn as number);
      if (activeTurn === data.turn) activeTurn = undefined;
    }
  }
  return result;
}

/** Registers the children that newly projected parent or child events started. */
export function noteDshSubagents(state: DshConversation, events: readonly NativeWorkbenchEvent[]): DshSubagent[] {
  const created: DshSubagent[] = [];
  for (const event of events) {
    if (event.type !== 'tool_call_update') continue;
    const toolCallId = nonEmpty(event.data.toolCallId);
    const childId = nonEmpty(asRecord(event.data.subagentResult)?.agentId);
    if (!toolCallId || !childId || state.subagents.has(toolCallId)) continue;
    const item: DshSubagent = { toolCallId, childId, total: 0, loaded: false, running: false, lastChangeAt: Date.now(), lastSyncAt: 0 };
    state.subagents.set(toolCallId, item);
    created.push(item);
  }
  while (state.subagents.size > SUBAGENT_LIMIT) {
    const items = [...state.subagents.values()];
    const evicted = items.filter(item => !item.running).sort((left, right) => left.lastChangeAt - right.lastChangeAt)[0] ?? items[0]!;
    state.subagents.delete(evicted.toolCallId);
  }
  return created.filter(item => state.subagents.has(item.toolCallId));
}

export function followDshSubagents(host: DshEventHost, state: DshConversation, events: readonly NativeWorkbenchEvent[]): void {
  const created = noteDshSubagents(state, events);
  if (created.length) void host.refreshSubagents(state, created);
}

/** Running children sync on every call; finished ones at most every SUBAGENT_IDLE_POLL_MS. */
export async function refreshDshSubagents(host: DshEventHost, state: DshConversation, items: readonly DshSubagent[] = [...state.subagents.values()]): Promise<void> {
  const now = Date.now();
  await Promise.all(items.map(async (item) => {
    if (item.syncing) return await item.syncing;
    if (item.loaded && !item.running && now - item.lastSyncAt < SUBAGENT_IDLE_POLL_MS) return;
    const task = syncDshSubagent(host, state, item).catch(() => { /* an unreadable child keeps its last state */ });
    item.syncing = task;
    try { await task; } finally { if (item.syncing === task) item.syncing = undefined; }
  }));
}

/** Reads what a child committed since the last sync: whether it runs, and the children it started; its lane reads the same records. */
async function syncDshSubagent(host: DshEventHost, state: DshConversation, item: DshSubagent): Promise<void> {
  item.lastSyncAt = Date.now();
  const newest = await host.readPage(state, undefined, 1, item.childId);
  if (!newest.found || !state.subagents.has(item.toolCallId)) return;
  const reset = !item.loaded || sessionGeneration(item.childId, newest) !== item.generation
    || newest.total < item.total || newest.total - item.total > SUBAGENT_INITIAL_RECORDS;
  if (reset) {
    const page = await host.readPage(state, undefined, SUBAGENT_INITIAL_RECORDS, item.childId);
    if (!page.found || !state.subagents.has(item.toolCallId)) return;
    item.total = page.before;
    item.generation = sessionGeneration(item.childId, page);
    item.loaded = true;
    // The window can start after the turn opened; a crashed child must not spin forever.
    item.running = openTurn(page.events) ?? recentRecord(page.events);
    item.lastChangeAt = Date.now();
    host.noteObservers(state.nativeSessionId, 'subagent/read', { agentId: item.childId, total: page.total });
    notifyListeners(state, { type: 'subagent', toolCallId: item.toolCallId, agentId: item.childId, running: item.running });
    followDshSubagents(host, state, projectDshChild(state, page.events));
    return;
  }
  if (newest.total === item.total) return;
  host.noteObservers(state.nativeSessionId, 'subagent/read', { agentId: item.childId, total: newest.total });
  const delta = await host.readPage(state, newest.total, newest.total - item.total, item.childId);
  if (!delta.found || !state.subagents.has(item.toolCallId) || delta.start !== item.total) return;
  const events = projectDshChild(state, delta.events);
  const running = openTurn(delta.events) ?? item.running;
  item.total = delta.before;
  item.lastChangeAt = Date.now();
  if (!events.length && running === item.running) return;
  item.running = running;
  notifyListeners(state, { type: 'subagent', toolCallId: item.toolCallId, agentId: item.childId, running });
  followDshSubagents(host, state, events);
}

export function handleDshSessionEvent(host: DshEventHost, state: DshConversation, params: Record<string, unknown>): void {
  const raw = params.event;
  const event = asRecord(raw);
  if (!event) return;
  noteDshContext(state, [event]);
  const eventData = asRecord(event.data) ?? {};
  const commandId = nonEmpty(params.commandId);
  const runId = pickRunId(params);
  const attachments = Array.isArray(params.attachments) ? params.attachments.flatMap((item): DshAttachmentInfo[] => {
    const value = asRecord(item);
    if (!value || typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.mimeType !== 'string') return [];
    return [{ id: value.id, name: value.name, mimeType: value.mimeType, ...(typeof value.width === 'number' ? { width: value.width } : {}), ...(typeof value.height === 'number' ? { height: value.height } : {}) }];
  }) : undefined;
  if (commandId && runId) {
    state.commandMap.set(commandId, { runId, ...(attachments ? { attachments } : {}) });
    // Bind the turn here rather than waiting for the poll, so a response that starts immediately
    // still reports its speed against the run the user actually sent.
    if (state.activeTurn !== undefined) rememberDshTurnCommand(state, state.activeTurn, commandId);
  }
  if (event.type === 'turn/start' && Number.isSafeInteger(eventData.turn)) state.activeTurn = eventData.turn as number;
  if (event.type === 'turn/end' && Number.isSafeInteger(eventData.turn) && state.activeTurn === eventData.turn) state.activeTurn = undefined;
  if (event.type === 'session/title' && typeof asRecord(event.data)?.title === 'string') {
    // DSH's own title is a ~10-character summary aimed at its own UI; here it is only a stopgap
    // for a conversation that has no name yet (see session-title.ts).
    const patch = providerTitlePatch(state.host.getSession(state.workbenchSessionId), asRecord(event.data)?.title as string);
    if (patch) {
      const session = state.host.updateSession(state.workbenchSessionId, patch);
      notifyListeners(state, { type: 'session', session });
    }
    return;
  }
  if (event.type === 'user/message' && asRecord(eventData.source)?.kind !== 'user') return;
  const projected = projectDshEvent(event, {
    sessionId: state.workbenchSessionId,
    ...(runId ? { runId } : {}),
    ...(commandId ? { commandId } : {}),
    ...(attachments?.length ? { attachments } : {}),
    ...(event.type === 'turn/end' ? { failureMessage: host.turnFailureMessage(eventData, state.profile) } : {}),
  });
  // A replayed history carries the conversation's first human message, which is what finally
  // names a resumed conversation (DSH's own title only ever fills a placeholder).
  const humanMessage = firstHumanMessage(projected);
  if (humanMessage) nameDshFromMessage(state, humanMessage);
  const fresh = projected.filter(item => rememberDshEvent(state, item));
  followDshSubagents(host, state, fresh);
  const goal = dshGoalChange(state.host.getSession(state.workbenchSessionId).goal, fresh);
  if (goal !== undefined) notifyListeners(state, { type: 'session', session: state.host.updateSession(state.workbenchSessionId, { goal: goal ?? undefined }) });
  // The committed record carries the provider's exact accounting even when no `usage` chunk
  // was streamed, and it commits before the attempt's `end` frame, so the running attempt can
  // still adopt the number rather than settling on an estimate.
  if (event.type === 'assistant/message') adoptCommittedDshUsage(state, eventData);
  if (event.type === 'turn/start') state.status = statusFor(state, 'busy');
  // Goal continuations and queued inbox messages can start another turn immediately. Only the
  // live agent lifecycle (notification or session/read) can say the agent is actually idle.
  host.emitStatus(state);
}

export function handleDshAgentStatus(host: DshEventHost, state: DshConversation, params: Record<string, unknown>): void {
  if (params.status === 'disposed') {
    state.active = false;
    state.status = statusFor(state, 'offline');
  } else if (params.status === 'running') {
    state.active = true;
    state.status = statusFor(state, 'busy');
  } else if (params.status === 'idle') {
    state.active = true;
    state.status = statusFor(state, 'idle');
  }
  host.emitStatus(state);
}

export function handleDshAssistantStream(state: DshConversation, params: Record<string, unknown>): void {
  const frame = asRecord(params.assistantStream);
  if (!frame) return;
  const attemptId = nonEmpty(frame.attemptId) ?? 'attempt';
  if (frame.type === 'start') {
    // The opening frame is the only one that names the turn; every later chunk arrives with
    // just the attempt id, so the turn has to be remembered here.
    state.attempts.set(attemptId, {
      turn: typeof frame.turn === 'number' ? frame.turn : -1,
      step: typeof frame.step === 'number' ? frame.step : -1,
      attemptId,
      text: '',
      startedAt: 0,
      lastAt: 0,
      startedWallAt: Date.now(),
    });
    return;
  }
  if (frame.type === 'end') {
    settleDshAttempt(state, attemptId);
    return;
  }
  const chunk = asRecord(frame.chunk);
  if (!chunk) return;
  if (chunk.type === 'usage') {
    // Provider accounting for the whole attempt, usually delivered just before `finish`. It is
    // the only exact count DSH offers, so it replaces whatever the deltas estimated. The ledger
    // write waits until the attempt settles.
    const attempt = state.attempts.get(attemptId);
    const usage = readDshUsage(asRecord(chunk.usage), nonEmpty(chunk.model) ?? nonEmpty(frame.model));
    if (attempt && usage) attempt.usage = mergeDshUsage(attempt.usage, usage);
    return;
  }
  // Tool-call arguments are generated output too: they take real time to stream and the provider
  // bills them, so they extend the measured window and feed the estimate. They are deliberately
  // not turned into transcript rows — the durable tool call is what the timeline renders — but
  // leaving them out of the measurement ended the window early on every tool-using step and made
  // the reported rate read high.
  if (chunk.type === 'tool-call') {
    const attempt = state.attempts.get(attemptId);
    if (attempt) attempt.hasUnstreamed = true;
    return;
  }
  const streamingAnswer = chunk.type === 'text-delta' || chunk.type === 'reasoning-delta';
  if (!streamingAnswer && chunk.type !== 'tool-call-delta') return;
  const produced = streamingAnswer
    ? (typeof chunk.text === 'string' ? chunk.text : '')
    : (typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : '');
  if (!produced) return;
  const attempt = state.attempts.get(attemptId) ?? {
    turn: typeof frame.turn === 'number' ? frame.turn : -1, step: -1, attemptId, text: '',
    startedAt: 0, lastAt: 0, startedWallAt: Date.now(),
  };
  state.attempts.set(attemptId, attempt);
  // `frame.time` is the session's own timestamp for the chunk, not our receive time, so the
  // measured window is model generation rather than network transit.
  const at = typeof frame.time === 'number' ? frame.time : Date.now();
  attempt.text += produced;
  if (!attempt.startedAt) attempt.startedAt = at;
  attempt.lastAt = at;
  publishDshAttempt(state, attempt);
}

/**
 * Adopt a committed message's usage onto the attempt that produced it. Turn and step identify
 * the attempt because DSH only names them on the opening frame, which is why the running
 * attempts are keyed by attempt id but searched by position here.
 */
function adoptCommittedDshUsage(state: DshConversation, eventData: Record<string, unknown>): void {
  const usage = readDshUsage(asRecord(eventData.usage), nonEmpty(eventData.model));
  if (!usage) return;
  const turn = typeof eventData.turn === 'number' ? eventData.turn : undefined;
  const step = typeof eventData.step === 'number' ? eventData.step : undefined;
  if (turn === undefined || step === undefined) return;
  for (const attempt of state.attempts.values()) {
    if (attempt.turn !== turn || attempt.step !== step) continue;
    attempt.usage = mergeDshUsage(attempt.usage, usage);
    return;
  }
}

/** The run a turn belongs to, so a step's speed lands on the turn the user actually sent. */
function runForDshTurn(state: DshConversation, turn: number): string | undefined {
  // With exactly one turn in flight there is only one answer, which covers the window between a
  // stream starting and its turn becoming known. Two concurrent turns stay unresolved on purpose.
  const commandId = state.turnCommands.get(turn)
    ?? (state.turnCommands.size === 1 ? state.turnCommands.values().next().value : undefined);
  return commandId ? state.commandMap.get(commandId)?.runId : undefined;
}

function dshMetricsFor(state: DshConversation, runId: string | undefined, turn: number): RunMetricsTracker {
  return runTracker(state.metrics, runId ?? `turn:${turn}`, { runId }, {
    emit: message => notifyListeners(state, message), save: (id, run) => state.host.saveRunMetrics(id, run),
  });
}

function publishDshAttempt(state: DshConversation, attempt: DshAttempt): void {
  const range = dshAttemptWindow(attempt);
  if (!range) return;
  const tracker = dshMetricsFor(state, runForDshTurn(state, attempt.turn), attempt.turn);
  tracker.update({
    stepId: attempt.attemptId,
    text: attempt.text,
    ...(attempt.usage ? { outputTokens: attempt.usage.outputTokens } : {}),
    ...range,
    live: true,
  });
}

/** Publish a finished attempt once, with the provider's count when it reported one. */
function settleDshAttempt(state: DshConversation, attemptId: string): void {
  const attempt = state.attempts.get(attemptId);
  if (!attempt) return;
  state.attempts.delete(attemptId);
  const range = dshAttemptWindow(attempt);
  if (!range) return;
  const tracker = dshMetricsFor(state, runForDshTurn(state, attempt.turn), attempt.turn);
  tracker.update({
    stepId: attemptId,
    text: attempt.text,
    ...(attempt.usage ? { outputTokens: attempt.usage.outputTokens } : {}),
    ...(attempt.usage?.reasoningTokens === undefined ? {} : { reasoningTokens: attempt.usage.reasoningTokens }),
    ...range,
    live: false,
  }, true);
  recordSettledDshAttempt(state, attempt, range);
}

/**
 * One settled DSH attempt. The step id is `turn:<n>:step:<n>` when the opening frame named both,
 * which is also what a durable `assistant/message` carries, so a disk backfill uses the same
 * rule. An attempt that never learned its position falls back to `attempt:<attemptId>`.
 */
function recordSettledDshAttempt(state: DshConversation, attempt: DshAttempt, range: { startedAt: number; endedAt: number; window: 'stream' | 'transcript' | 'observed' }): void {
  const usage = attempt.usage;
  const provider = usage !== undefined;
  const outputTokens = provider ? usage.outputTokens : Math.max(0, Math.round(estimateTokens(attempt.text)));
  if (!provider && !attempt.text.trim()) return;
  const stepId = attempt.turn >= 0 && attempt.step >= 0
    ? `turn:${attempt.turn}:step:${attempt.step}`
    : `attempt:${attempt.attemptId}`;
  try {
    state.host.stats?.recordUsage(state.workbenchSessionId, runForDshTurn(state, attempt.turn), {
      stepId,
      ...(usage?.model ? { model: usage.model } : {}),
      startedAt: range.startedAt,
      endedAt: range.endedAt,
      window: range.window,
      tokenSource: provider ? 'provider' : 'estimated',
      outputTokens,
      ...(usage?.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
      ...(usage?.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
      ...(usage?.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
      ...(usage?.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
    });
  } catch { /* statistics must never affect the stream */ }
}
