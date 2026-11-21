import type { NativeBackendHost } from '../types.js';
import type { NativeStatus, NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';
import { messagePhase, type CodexDraftStream } from './drafts.js';
import type { CodexActivities } from './activities.js';
import type { CodexEventLog } from './event-log.js';
import type { CodexFlavor } from './flavors.js';
import type { CodexHistoryReader } from './history-read.js';
import type { CodexHistorySync } from './history-sync.js';
import type { CodexInteractions } from './pending.js';
import type { CodexSettings } from './settings.js';
import type { CodexSubagents } from './subagents.js';
import type { CodexTerminal } from './terminal.js';
import type { CodexThread } from './thread.js';
import type { CodexTurns } from './turns.js';
import type { CodexContextMeter, CodexTurnMetering } from './metering.js';
import type { CodexObservation } from './observation.js';
import { noteItemMeter } from './metering.js';
import { notificationSpan } from './item-spans.js';
import { normalizePlanEntries } from './rollout-plan.js';
import { codexGoal } from './goal.js';
import { parseAsyncQuestionReplies } from './interactions.js';
import { isCodexQuestionTool } from './question-history.js';
import { isCodexToolItem, projectCompletedTool, projectStartedTool } from './transcript.js';
import { userMessageText } from './project-item.js';
import { safeProviderError } from './errors.js';
import type { RpcItem, RpcThread, RpcTurn } from './types.js';
import { asArray, asRecord, finiteToken, str, toIso } from './util.js';

type Params = Record<string, unknown>;

/** A native command waiting for the turn it starts; the notifications tell it which turns began (`dispatch.ts`). */
export interface NotifiedCommand {
  readonly type: 'compact' | 'review';
  readonly previousTurns: ReadonlySet<string>;
  readonly startedTurns: Set<string>;
  readonly userTurns: Set<string>;
}

/** What `CodexNotifications` needs from the runtime that owns it. */
export interface CodexNotificationsContext {
  readonly host: NativeBackendHost;
  readonly sessionId: string;
  readonly flavor: CodexFlavor;
  readonly profileConfig: Record<string, unknown>;
  readonly observation?: CodexObservation;
  readonly log: CodexEventLog;
  readonly turns: CodexTurns;
  readonly thread: CodexThread;
  readonly interactions: CodexInteractions;
  readonly settings: CodexSettings;
  readonly sync: CodexHistorySync;
  readonly subagents: CodexSubagents;
  readonly metering: CodexTurnMetering;
  readonly usage: CodexContextMeter;
  readonly drafts: CodexDraftStream;
  readonly activities: CodexActivities;
  readonly terminal: CodexTerminal;
  readonly reader: CodexHistoryReader;
  threadId(): string | undefined;
  status(): NativeStatus;
  /** What kind of notice the status shows now, so a transient one is only cleared by its own condition. */
  noticeSource(): string | undefined;
  nativeCommand(): NotifiedCommand | undefined;
  confirmNativeCommand(turnId: string): void;
  commandIdOf(item: RpcItem, turnId: string | undefined): string | undefined;
  /** A root turn started: the thread's earlier error is over, and only this turn can explain a later one. */
  rootTurnStarted(turnId: string | undefined): void;
  applyThreadStatus(status: RpcThread['status']): void;
  refreshStatus(change: {
    link?: 'quiet' | 'working'; model?: string;
    notice?: { text: string; level: NativeStatus['noticeLevel']; source: 'transient' | 'other' } | undefined;
  }): void;
}

/**
 * Routes the app-server's notifications to the object that owns what each one changes.
 *
 * It owns the routing tables (method name to handler), the order in which a notification is passed
 * to the journal's reader relative to its handling, and the provider notice that lasts only while its
 * condition does (queue position, model fallback).
 *
 * It does not own the order in which notifications arrive (`NotificationGate`, held by the
 * connection), nor any state a handler changes beyond that notice: handlers call the methods of the
 * turns, interactions, settings, log and the other objects, in the order the original chain did.
 */
export class CodexNotifications {
  /** A provider notice that holds only while its condition does, such as a queue position. */
  private transientNotice: string | undefined;
  /** Notifications of the conversation's own thread. */
  private readonly routes = new Map<string, (params: Params) => void>();
  /** Notifications of a child thread: the child tracker reads the rest (see `routeChild`). */
  private readonly childRoutes = new Map<string, (params: Params, threadId: string) => void>();

  constructor(private readonly ctx: CodexNotificationsContext) {
    const { interactions } = ctx;
    const streamed = (method: string) => this.routes.set(method, params => this.streamDelta(method, params));
    for (const method of ['item/agentMessage/delta', 'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta']) streamed(method);
    for (const method of ['item/started', 'item/completed']) this.routes.set(method, params => this.item(method, params));
    this.routes.set('turn/started', params => this.turnStarted('turn/started', params));
    this.routes.set('turn/completed', params => this.turnCompleted(params));
    this.routes.set('turn/plan/updated', params => this.planUpdated(params));
    this.routes.set('thread/tokenUsage/updated', params => this.tokenUsage(params));
    this.routes.set('thread/status/changed', params => ctx.applyThreadStatus(asRecord(params.status) as RpcThread['status']));
    this.routes.set('thread/settings/updated', params => this.settingsUpdated(params));
    this.routes.set('thread/name/updated', params => ctx.settings.adoptProviderTitle(str(params.name)));
    this.routes.set('thread/goal/updated', params => this.goalUpdated(params));
    this.routes.set('thread/goal/cleared', () => ctx.settings.adoptGoal(undefined));
    this.routes.set('queue/status', params => this.queueStatus(params));
    this.routes.set('model/fallback', params => this.modelFallback(params));
    this.routes.set('model/loopDetectedRecovering', () => ctx.refreshStatus({ notice: { text: `The model repeated itself; ${ctx.flavor.label} compacted the context and is retrying.`, level: 'info', source: 'other' } }));
    this.routes.set('mode/changeRequested', params => interactions.raiseModeChange(params));
    this.routes.set('mode/changeResolved', params => interactions.settleModeChange(params));
    this.routes.set('serverRequest/resolved', params => interactions.settleRequest(params));
    // Child settings/status/usage/text are read by the child tracker, not projected or adopted
    // into the parent's mode, permissions, context meter, journal lane or foreground turn.
    this.childRoutes.set('mode/changeRequested', params => interactions.raiseModeChange(params));
    this.childRoutes.set('mode/changeResolved', params => interactions.settleModeChange(params));
    this.childRoutes.set('serverRequest/resolved', params => interactions.settleRequest(params));
    for (const method of ['turn/started', 'turn/completed']) this.childRoutes.set(method, (params, threadId) => this.childTurn(method, params, threadId));
    for (const method of ['item/started', 'item/completed']) this.childRoutes.set(method, params => this.childItem(params));
  }

  /** Handles one notification, after the gate released it in order. */
  route(method: string, params: Params): void {
    const threadId = str(params.threadId);
    if (threadId && threadId !== this.ctx.threadId()) {
      if (this.ctx.subagents.owns(threadId)) this.childRoutes.get(method)?.(params, threadId);
      return;
    }
    // Native TUI input can precede the workbench's first send. Observe it before waking the
    // journal reader, and never restart the deadline on subsequent items or turns.
    if (threadId === this.ctx.threadId() && (method === 'turn/started' || method === 'turn/completed'
      || (method.startsWith('item/') && typeof params.turnId === 'string'))) this.ctx.reader.beginMaterialization();
    // A started turn is passed on after its own handling; everything else before it.
    if (method !== 'turn/started') this.ctx.log.forward(method, params);
    this.routes.get(method)?.(params);
  }

  private childTurn(method: string, params: Params, threadId: string): void {
    const turnId = str(asRecord(params.turn)?.id);
    if (!turnId) return;
    const completed = method === 'turn/completed';
    this.ctx.subagents.noteTurn(threadId, turnId, completed);
    if (completed) {
      this.ctx.turns.completeWaiters(turnId, threadId);
      this.ctx.interactions.clearTurnInteractions(turnId, threadId);
      this.ctx.refreshStatus({ link: 'quiet', notice: undefined });
    }
    void this.ctx.subagents.refresh();
  }

  private childItem(params: Params): void {
    const item = asRecord(params.item) as RpcItem | undefined;
    const turnId = str(params.turnId);
    if (item && turnId && (item.type === 'subAgentActivity' || item.type === 'collabAgentToolCall')) {
      this.ctx.subagents.note([{ id: turnId, items: [item] }], true);
    }
    void this.ctx.subagents.refresh();
  }

  private turnStarted(method: string, params: Params): void {
    const { ctx } = this;
    ctx.turns.clearForegroundEnded();
    const turn = asRecord(params.turn);
    const id = str(turn?.id);
    ctx.rootTurnStarted(id);
    const command = ctx.nativeCommand();
    if (id) {
      if (command?.type === 'compact' && !command.previousTurns.has(id)) {
        command.startedTurns.add(id);
        if (asArray<RpcItem>(turn?.items).some(item => item.type === 'userMessage')) command.userTurns.add(id);
      }
      ctx.turns.dropProvisionalInterrupt(id);
      ctx.turns.markActive(id);
      ctx.log.noteTurnStart({ id, startedAt: typeof turn?.startedAt === 'number' ? turn.startedAt : undefined });
      if (!command) ctx.turns.bindDispatchedTurn(id);
      const meter = ctx.metering.meterFor(id);
      if (typeof turn?.startedAt === 'number') meter.requestStartAt = turn.startedAt * 1000;
      else meter.requestStartAt ??= Date.now();
    }
    ctx.refreshStatus({ link: 'working', notice: undefined });
    ctx.log.forward(method, params);
  }

  /**
   * Streamed text is shown as a draft until `item/completed` commits the item and replaces it, so
   * the answer is readable while the TUI is still printing it without ever rendering twice.
   */
  private streamDelta(method: string, params: Params): void {
    const { ctx } = this;
    // Output means the turn is no longer waiting in a provider queue.
    if (this.transientNotice) this.showTransientNotice(undefined);
    ctx.metering.noteStreamDelta(str(params.turnId), params.delta, method, str(params.itemId));
    const threadId = ctx.threadId() ?? 'unknown';
    const kind = method === 'item/agentMessage/delta' ? 'assistant' : 'thinking';
    const nativeId = `${threadId}:${params.turnId}:${params.itemId}:${kind}`;
    const partial = ctx.log.partialRow(nativeId);
    const text = partial && str(asRecord(partial.data.content)?.text);
    const noted = ctx.drafts.note(method, params, threadId, partial && text !== undefined ? { text, sequence: partial.sequence, phase: partial.data.phase } : undefined);
    if (partial && text !== undefined && noted === partial.nativeId) ctx.log.dropRow(partial);
  }

  private tokenUsage(params: Params): void {
    const tokenUsage = asRecord(params.tokenUsage);
    const usage = this.ctx.usage.turnUsage(str(params.turnId), tokenUsage);
    if (usage) this.ctx.metering.noteTurnUsage(str(params.turnId), usage);
    void this.ctx.usage.applyUsageFrame(tokenUsage, params).catch(() => undefined);
  }

  private planUpdated(params: Params): void {
    const turnId = str(params.turnId);
    const entries = normalizePlanEntries(params.plan);
    if (turnId && entries) this.ctx.log.publishPlanSnapshot(turnId, entries, params);
  }

  private turnCompleted(params: Params): void {
    const { ctx } = this;
    const turn = asRecord(params.turn);
    const turnId = str(turn?.id);
    ctx.observation?.release(ctx.threadId());
    ctx.thread.clearStandingWrites();
    const command = ctx.nativeCommand();
    if (turnId && command?.type === 'compact') {
      const items = asArray<RpcItem>(turn?.items);
      if (items.some(item => item.type === 'userMessage')) command.userTurns.add(turnId);
      if (items.some(item => item.type === 'contextCompaction')) ctx.confirmNativeCommand(turnId);
    }
    if (turn && turnId) {
      for (const item of asArray<RpcItem>(turn.items)) {
        if (item.type === 'userMessage') this.noteUserMessage(turnId, ctx.log.projectItem(item, turn as unknown as RpcTurn));
        ctx.metering.noteCompletedOutput(turnId, item);
      }
    }
    if (turnId) ctx.metering.settleTurnMetrics(turnId);
    if (turn && turnId) ctx.activities.noteTurn(turn as unknown as RpcTurn, true, true);
    if (turnId) ctx.activities.turnCompleted(turnId, turn?.status as RpcTurn['status']);
    ctx.activities.hint();
    this.transientNotice = undefined;
    void ctx.usage.refreshContextBreakdown();
    if (turn && turnId) {
      const completedTurn = turn as unknown as RpcTurn;
      ctx.log.projectKnownUserReceipts(completedTurn);
      ctx.log.emitTurnOutcome(completedTurn, turnId);
    }
    if (turnId) ctx.interactions.clearTurnInteractions(turnId);
    if (turnId) {
      ctx.turns.completeWaiters(turnId);
      ctx.turns.completeForeground(turnId);
    }
    // An interrupted item may never be committed; the reset below drops whatever it streamed.
    if (turnId) ctx.drafts.dropTurn(turnId);
    ctx.refreshStatus({ link: ctx.turns.dispatchCommandId ? 'working' : 'quiet', notice: undefined });
    if (ctx.terminal.appearancePending && ctx.status().phase === 'idle') {
      // This handler can inherit the async scope of a locked operation; queue behind it instead.
      const relaunch = () => ctx.terminal.relaunchTuiForAppearance();
      void (ctx.host.withDetachedSessionLock ? ctx.host.withDetachedSessionLock(ctx.sessionId, relaunch) : ctx.host.withSessionLock(ctx.sessionId, relaunch)).catch(() => undefined);
    }
    void ctx.sync.refreshEvents()
      .catch(error => ctx.sync.noteHistoryFailure(error));
  }

  private queueStatus(params: Params): void {
    // A busy provider holds the request in its own queue; without this the turn just looks stuck.
    if (str(params.state) === 'ready') {
      this.showTransientNotice(undefined);
      return;
    }
    const position = finiteToken(params.position);
    // An exhausted daily quota lowers priority instead of rejecting the turn, so say why the
    // request is waiting rather than presenting it as ordinary queue contention.
    const fallback = params.modelQuotaLowPriority === true
      ? 'Daily quota is used up; this request is running at low priority.'
      : `Waiting in the ${this.ctx.flavor.label} queue${position === undefined ? '' : ` (position ${position})`}.`;
    this.showTransientNotice(safeProviderError(str(params.message) ?? fallback, this.ctx.profileConfig));
  }

  private modelFallback(params: Params): void {
    const event = asRecord(params.event);
    const model = (key: string) => str(asRecord(event?.[key])?.model);
    const type = str(event?.type);
    if (type === 'attemptStarted') this.showTransientNotice(`${model('from') ?? 'The model'} is unavailable; trying ${model('to') ?? 'a fallback model'}.`);
    else if (type === 'committed' && model('target')) {
      this.showTransientNotice(undefined);
      this.ctx.refreshStatus({ model: model('target'), notice: { text: `This turn is answered by ${model('target')} instead.`, level: 'info', source: 'other' } });
    } else if (type === 'exhausted') this.showTransientNotice(undefined);
  }

  private settingsUpdated(params: Params): void {
    const settings = asRecord(params.threadSettings);
    this.ctx.thread.noteModel(str(settings?.model));
    if (this.ctx.threadId() && params.threadId === this.ctx.threadId()) this.ctx.settings.observe(settings);
  }

  private goalUpdated(params: Params): void {
    // A status this version does not know leaves the shown goal as it is.
    const goal = codexGoal(params.goal);
    if (goal || params.goal === null) this.ctx.settings.adoptGoal(goal);
  }

  private item(method: string, params: Params): void {
    const { ctx } = this;
    const item = asRecord(params.item) as RpcItem | undefined;
    const turnId = str(params.turnId);
    if (!item || !turnId) return;
    const command = ctx.nativeCommand();
    if (item.type === 'userMessage' && command?.type === 'compact') command.userTurns.add(turnId);
    if (item.type === 'fileChange' && typeof item.id === 'string' && ctx.thread.isStanding()) {
      ctx.thread.noteStandingWrites(item.id, method === 'item/started'
        ? asArray<Record<string, unknown>>(item.changes).flatMap(change => [str(change.path), str(asRecord(change.kind)?.move_path)]).filter((path): path is string => Boolean(path))
        : undefined);
    }
    if (item.type === 'contextCompaction') {
      if (command?.type === 'compact') ctx.confirmNativeCommand(turnId);
      if (ctx.thread.isStanding()) {
        // As Claude Code's PreCompact and its SessionStart after one: the 助理 saves what matters, and is then told.
        if (method === 'item/started') { try { ctx.host.standing?.compacting?.(ctx.sessionId); } catch { /* a standing host's trouble is not the turn's */ } }
        else ctx.thread.noteCompacted();
      }
      if (method === 'item/started') ctx.activities.compactionStarted(item, turnId, Number(params.startedAtMs));
      else ctx.activities.compactionCompleted(item, turnId, typeof params.completedAtMs === 'number' ? params.completedAtMs : undefined);
      return;
    }
    if (item.type === 'userMessage') {
      ctx.activities.noteUserMessage(turnId);
      // A finished goal steps aside once the conversation moves on, as on every backend.
      if (method === 'item/started' && ctx.host.getSession(ctx.sessionId).goal?.status === 'complete') ctx.settings.adoptGoal(undefined);
    }
    if (item.type === 'commandExecution') {
      ctx.activities.noteCommand(item, turnId);
      if (method === 'item/completed') ctx.activities.sync();
    }
    if (method === 'item/started' && item.type === 'agentMessage' && !str(item.text) && messagePhase(item.phase)) {
      ctx.drafts.note('item/agentMessage/delta', { itemId: item.id, turnId, delta: '', phase: item.phase }, ctx.threadId() ?? 'unknown');
    }
    const itemTiming = itemNotificationTiming(params, item);
    noteItemMeter(ctx.metering, method, item, turnId, itemTiming);
    const turn = ctx.turns.turnRun(turnId);
    const commandId = ctx.commandIdOf(item, turnId);
    if (commandId) ctx.turns.noteLiveCommand(commandId, toIso(Number(params.startedAtMs)));
    const itemTurn = { id: turnId, startedAt: Number(params.startedAtMs) / 1000 };
    // The notification states its own times; the rollout, which may not have the line yet, is the fallback.
    const span = notificationSpan(method, params, item) ?? ctx.log.rolloutSpan(ctx.threadId() ?? 'unknown', item);
    const projected = isCodexQuestionTool(item) ? ctx.log.projectItem(item, itemTurn, { span })
      : isCodexToolItem(item)
      ? method === 'item/started'
        ? projectStartedTool(item, ctx.sessionId, ctx.threadId() ?? 'unknown', turnId, turn?.runId, turn?.createdAt, span)
        : projectCompletedTool(item, ctx.sessionId, ctx.threadId() ?? 'unknown', turnId, turn?.runId, turn?.createdAt, span, id => ctx.observation?.changes(ctx.sessionId, id))
      : ctx.log.projectItem(item, itemTurn, { span });
    if (item.type === 'userMessage') this.noteUserMessage(turnId, projected);
    if (method === 'item/completed') ctx.metering.noteCompletedOutput(turnId, item, itemTiming);
    if (method === 'item/completed' && item.type === 'agentMessage') ctx.interactions.noteAsyncQuestions(item, turnId);
    if (item.type === 'userMessage') {
      // Answered from the TUI or another client: the envelope names the questions it settles.
      const answered = new Set(parseAsyncQuestionReplies(userMessageText(item))?.map(reply => reply.questionItemId));
      if (answered.size) ctx.interactions.dropAsyncQuestions(question => answered.has(question.questionItemId) || answered.has(question.itemId));
    }
    if (item.type === 'subAgentActivity' || item.type === 'collabAgentToolCall') {
      ctx.subagents.note([{ ...itemTurn, items: [item] }], true);
      void ctx.subagents.refresh();
    }
    if (method === 'item/completed') {
      if (item.id) ctx.drafts.settle(item.id);
      for (const event of projected) {
        ctx.log.noteLiveCompleted(event.nativeId);
        ctx.log.pushEvent(event, true);
      }
      return;
    }
    for (const event of projected) ctx.log.pushEvent(event);
  }

  private noteUserMessage(turnId: string, events: NativeWorkbenchEvent[]): void {
    const { ctx } = this;
    const event = events.find(candidate => candidate.type === 'user_message_chunk');
    const commandId = str(event?.data.commandId);
    if (commandId) ctx.turns.rememberCommand(turnId, commandId, true);
    if (event && !ctx.metering.isSettled(turnId)) ctx.metering.meterFor(turnId).nativeMessageId ??= event.nativeId;
    const outcome = ctx.turns.pendingOutcome(turnId);
    if (commandId && outcome) queueMicrotask(() => ctx.log.emitTurnOutcome(outcome, turnId));
  }

  /** Shows a notice that lasts only while its condition holds, without clearing an unrelated one. */
  private showTransientNotice(text: string | undefined): void {
    this.transientNotice = text;
    if (text) this.ctx.refreshStatus({ notice: { text, level: 'info', source: 'transient' } });
    else if (this.ctx.noticeSource() === 'transient') this.ctx.refreshStatus({ notice: undefined });
  }
}

/** Extract real epoch millisecond timestamps from an item notification, ignoring small test/ordinal values. */
function itemNotificationTiming(params: Params, item: RpcItem): { startedAtMs?: number; completedAtMs?: number } | undefined {
  const MIN_EPOCH_MS = 1_000_000_000_000;
  const pick = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= MIN_EPOCH_MS ? value : undefined;
  const startedAtMs = pick(params.startedAtMs) ?? pick(item.startedAtMs);
  const completedAtMs = pick(params.completedAtMs) ?? pick(item.completedAtMs);
  return startedAtMs !== undefined || completedAtMs !== undefined ? { startedAtMs, completedAtMs } : undefined;
}
