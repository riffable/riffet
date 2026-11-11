import type { NativeHistoryState, NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';

/** What the runtime learned of one child: its rows, and whether it runs (the control path takes the latter). */
export interface CodexSubagentFrame {
  type: 'subagent'; toolCallId: string; agentId: string; subagentType?: string; title?: string; prompt?: string; model?: string;
  reset: boolean; events: NativeWorkbenchEvent[]; history?: NativeHistoryState; running?: boolean; activeTurnId?: string;
}
import type { CodexSubagentWatch, RpcItem, RpcThread, RpcTurn } from './types.js';
import {
  encodeHistoryCursor, isSpawnAgentItem, isSubagentStart, subagentName, subagentSnapshotStart, subagentToolCallId, turnStatus,
} from './transcript.js';
import { asArray, asRecord, firstLine, str } from './util.js';

/** Child threads followed per session, and how often a finished one is re-read. */
const SUBAGENT_LIMIT = 64;
const SUBAGENT_IDLE_POLL_MS = 30_000;
/** How long a live follow-up may precede the child turn it starts before the thread status decides. */
const SUBAGENT_CLAIM_GRACE_MS = 30_000;
/** Parent-side states that end a child's work; a later live claim starts a new run. */
const TERMINAL_AGENT_STATES = new Set(['completed', 'interrupted', 'errored', 'failed', 'shutdown', 'notFound', 'not_found']);
/** The most events a child's snapshot carries; its bytes are capped as well. */
const SNAPSHOT_EVENTS = 200;

/** What the subagent tracker reads through the runtime that owns the conversation. */
export interface CodexSubagentContext {
  readTurns(threadId: string): Promise<RpcTurn[] | undefined>;
  readThread(threadId: string, includeTurns: boolean): Promise<RpcThread | undefined>;
  projectChildItem(item: RpcItem, turn: RpcTurn, childThreadId: string): NativeWorkbenchEvent[];
  turnCompleted?(threadId: string, turn: RpcTurn): void;
  emit(message: CodexSubagentFrame): void;
}

/**
 * The child threads a Codex conversation's collaboration calls started: which exist, whether each
 * is working, and its transcript, read through the same app-server and published as `subagent`
 * messages to the conversation's listeners.
 */
export class CodexSubagents {
  private readonly watches = new Map<string, CodexSubagentWatch>();
  /** Parent history can confirm shutdown when the child's own history has become unreadable. */
  private readonly historyTerminals = new WeakMap<CodexSubagentWatch, Map<string, { revision: number; turnId?: string; obsolete?: boolean }>>();

  constructor(private readonly context: CodexSubagentContext) {}

  get(toolCallId: string): CodexSubagentWatch | undefined { return this.watches.get(toolCallId); }
  values(): IterableIterator<CodexSubagentWatch> { return this.watches.values(); }
  owns(threadId: string): boolean { return [...this.watches.values()].some(watch => watch.childId === threadId); }
  clear(): void { this.watches.clear(); }

  /** A live child turn changes only that child's execution, never its parent's foreground. */
  noteTurn(threadId: string, turnId: string, completed: boolean): void {
    for (const watch of this.watches.values()) {
      if (watch.childId !== threadId) continue;
      if (!completed) {
        if (watch.settledTurn?.id === turnId || (watch.running && watch.lastTurnId === turnId)) continue;
        watch.lastTurnId = turnId;
        watch.awaiting = undefined;
        // A different live start is newer execution evidence even while the child was already
        // running. Its in-flight C1 history copy must not settle or overwrite the new C2 turn.
        watch.signalRevision = (watch.signalRevision ?? 0) + 1;
        this.markRunning(watch);
      } else if (!watch.lastTurnId || watch.lastTurnId === turnId) {
        watch.lastTurnId = turnId;
        this.settle(watch);
      }
      watch.lastSyncAt = 0;
    }
  }

  /** Registers the child threads this thread's collaboration calls named, and refreshes their state. */
  note(turns: readonly RpcTurn[], live = false): void {
    const claimsSeen = new Set<string>();
    for (const turn of turns) {
      for (const item of asArray<RpcItem>(turn.items)) {
        if (item.type === 'subAgentActivity') {
          const childId = str(item.agentThreadId);
          if (!childId) continue;
          if (isSubagentStart(item)) {
            const name = subagentName(item);
            const claim = subagentToolCallId(item);
            const watch = this.watch(claim, childId, name === 'Subagent' ? undefined : name, str(item.prompt), str(item.model), 1);
            const repeat = watch !== undefined && this.repeatsSpawn(watch, claim);
            if (watch && (live || !watch.loaded) && !repeat && this.takesStatus(watch, 'pendingInit', live)) watch.agentStatus = 'pendingInit';
            if (watch && live && !repeat) this.markRunning(watch);
          } else if (item.kind === 'completed' || item.kind === 'interrupted') {
            for (const watch of this.watches.values()) if (watch.childId === childId) {
              watch.agentStatus = item.kind;
              if (live) this.settle(watch);
              else if (!watch.settledTurn && (!watch.lastClaimId || claimsSeen.has(watch.lastClaimId))) this.noteHistoryTerminal(watch, `${turn.id}:${item.id}:${item.kind}`);
            }
          }
          continue;
        }
        if (item.type !== 'collabAgentToolCall') continue;
        const receivers = asArray<unknown>(item.receiverThreadIds).map(str).filter((id): id is string => Boolean(id));
        if (!receivers.length) continue;
        const spawn = isSpawnAgentItem(item);
        if (spawn) {
          const prompt = str(item.prompt);
          const title = str(item.description) ?? firstLine(prompt ?? '');
          const claim = subagentToolCallId(item);
          const watch = this.watch(claim, receivers[0]!, title || undefined, prompt, str(item.model), 2);
          if (watch && live && !this.repeatsSpawn(watch, claim)) this.markRunning(watch);
        }
        for (const watch of this.watches.values()) {
          if (!receivers.includes(watch.childId)) continue;
          const state = asRecord(asRecord(item.agentsStates)?.[watch.childId]);
          const status = str(state?.status);
          if (!status) continue;
          const claim = subagentToolCallId(item);
          if (claim) claimsSeen.add(claim);
          // A repeat of the child's own spawn call cannot restart work that already ended.
          if (this.repeatsSpawn(watch, claim) && !TERMINAL_AGENT_STATES.has(status)) continue;
          // A copy of a follow-up that already settled is history, not a new run: reopening on its
          // old `running`, or leaving that status on the watch, would revive a finished child. The
          // call's own terminal copy still counts and settles it.
          if (!spawn && claim && claim === watch.lastClaimId && watch.awaiting === undefined && !TERMINAL_AGENT_STATES.has(status)) continue;
          if (!this.takesStatus(watch, status, live)) continue;
          watch.agentStatus = status;
          if (!live) {
            // A terminal from before a newer live follow-up must not settle it. Match the claim
            // itself or require its ordered occurrence before this terminal in the parent read.
            // A retained settled-turn fence also protects ordered newer native child work.
            if (TERMINAL_AGENT_STATES.has(status) && !watch.settledTurn
              && (!watch.lastClaimId || claimsSeen.has(watch.lastClaimId))) this.noteHistoryTerminal(watch, `${turn.id}:${item.id}:${status}`);
            continue;
          }
          if (status === 'running' || status === 'pendingInit') this.markRunning(watch, spawn ? undefined : claim);
          else if (TERMINAL_AGENT_STATES.has(status)) this.settle(watch);
        }
      }
    }
  }

  private watch(
    toolCallId: string | undefined,
    childId: string,
    taskTitle?: string,
    prompt?: string,
    model?: string,
    titlePriority: 1 | 2 = 2,
    modelPriority: 1 | 2 = 1,
  ): CodexSubagentWatch | undefined {
    if (!toolCallId) return;
    const existing = this.watches.get(toolCallId) ?? [...this.watches.values()].find(watch => watch.childId === childId);
    if (existing) {
      const changed = this.mergeMetadata(existing, taskTitle, prompt, model, titlePriority, modelPriority);
      if (changed && existing.loaded) this.context.emit(this.snapshot(existing));
      return existing;
    }
    // One panel per child: a later `sendInput`/`wait`/`followupTask` names the same thread and
    // must not add a second copy of it to the header list.
    this.watches.set(toolCallId, {
      toolCallId, childId, events: [], loaded: false, running: false, lastSyncAt: 0,
      ...(taskTitle ? { taskTitle, taskTitlePriority: titlePriority } : {}), ...(prompt ? { prompt } : {}),
      ...(model ? { model, modelPriority } : {}),
    });
    while (this.watches.size > SUBAGENT_LIMIT) {
      const finished = [...this.watches.values()].filter(watch => watch.loaded && !watch.running && !watch.syncing);
      // An active child must keep its observer even when every cache slot is occupied.
      const evicted = finished[0];
      if (!evicted) break;
      this.watches.delete(evicted.toolCallId);
    }
    return this.watches.get(toolCallId);
  }

  /**
   * A live signal outranks history. History that predates a live terminal cannot put a finished
   * child back in `running`/`pendingInit`; only a live claim or the child's own newer turn can.
   */
  private takesStatus(watch: CodexSubagentWatch, status: string, live: boolean): boolean {
    if (live || !watch.agentStatus || !TERMINAL_AGENT_STATES.has(watch.agentStatus)) return true;
    return TERMINAL_AGENT_STATES.has(status);
  }

  /**
   * A repeat of the child's own spawn call cannot restart work that already ended: its old
   * `running`/`pendingInit` copy is history. A different claim can still start a new run.
   */
  private repeatsSpawn(watch: CodexSubagentWatch, claimId: string | undefined): boolean {
    return claimId !== undefined && claimId === watch.toolCallId
      && watch.agentStatus !== undefined && TERMINAL_AGENT_STATES.has(watch.agentStatus);
  }

  /**
   * A spawn/follow-up is live before its first child history read has returned. A follow-up can
   * also precede the child turn it starts, so it records the history boundary it must pass; the
   * item's started and completed copies share an id and count as one claim, which keeps a repeated
   * activity from extending that wait. A different follow-up is new work and restarts the wait.
   */
  private markRunning(watch: CodexSubagentWatch, claim?: string): void {
    this.historyTerminals.delete(watch);
    watch.settledTurn = undefined;
    if (claim && claim !== watch.lastClaimId) {
      watch.lastClaimId = claim;
      watch.awaiting = { ...(watch.lastTurnId ? { turnId: watch.lastTurnId } : {}), known: watch.loaded, since: Date.now() };
      watch.signalRevision = (watch.signalRevision ?? 0) + 1;
    }
    if (watch.running) return;
    watch.running = true;
    watch.signalRevision = (watch.signalRevision ?? 0) + 1;
    watch.lastSyncAt = 0;
    this.context.emit({
      type: 'subagent', toolCallId: watch.toolCallId, agentId: watch.childId,
      ...(watch.subagentType ? { subagentType: watch.subagentType } : {}), ...this.taskFields(watch),
      reset: false, events: [], running: true,
    });
  }

  /** Bind each parent terminal to the child execution seen when it first became evidence. */
  private noteHistoryTerminal(watch: CodexSubagentWatch, key: string): void {
    let terminals = this.historyTerminals.get(watch);
    if (!terminals) this.historyTerminals.set(watch, terminals = new Map());
    // Repeated parent snapshots must not rebind an old shutdown to newly read child work.
    if (terminals.has(key)) return;
    terminals.set(key, { revision: watch.signalRevision ?? 0, ...(watch.lastTurnId ? { turnId: watch.lastTurnId } : {}) });
    while (terminals.size > SUBAGENT_LIMIT) terminals.delete(terminals.keys().next().value!);
  }

  /** An unreadable child plus an ordered parent terminal proves an end, absence alone does not. */
  private settleUnreadable(watch: CodexSubagentWatch): void {
    const terminal = [...(this.historyTerminals.get(watch)?.values() ?? [])].some(evidence =>
      !evidence.obsolete && evidence.revision === (watch.signalRevision ?? 0));
    if (!terminal) return;
    this.historyTerminals.delete(watch);
    if (watch.running || watch.awaiting) this.settle(watch);
  }

  /** A confirmed terminal ends this execution; a later old running copy cannot reopen it. */
  private settle(watch: CodexSubagentWatch): void {
    watch.settledTurn = {
      ...(watch.lastTurnId ? { id: watch.lastTurnId } : {}),
      ...(watch.awaiting && watch.awaiting.turnId === watch.lastTurnId ? { pending: true } : {}),
    };
    watch.awaiting = undefined;
    watch.signalRevision = (watch.signalRevision ?? 0) + 1;
    if (!watch.running) return;
    watch.running = false;
    watch.lastSyncAt = 0;
    this.context.emit({
      type: 'subagent', toolCallId: watch.toolCallId, agentId: watch.childId,
      ...(watch.subagentType ? { subagentType: watch.subagentType } : {}), ...this.taskFields(watch),
      reset: false, events: [], running: false,
    });
  }

  /** Whether the child's history holds a turn newer than the one a live claim named. */
  private claimPassed(claim: NonNullable<CodexSubagentWatch['awaiting']>, turns: readonly RpcTurn[]): boolean {
    if (!claim.known) return false;
    if (claim.turnId === undefined) return turns.length > 0;
    const index = turns.findIndex(turn => turn.id === claim.turnId);
    return index >= 0 && index < turns.length - 1;
  }

  /**
   * Whether the child is working. A history read can call the turn being executed interrupted
   * before it writes its first item, so only the newest turn is judged, and only against the
   * runtime's own status; an older interrupted turn never reopens. A status that is neither active
   * nor finished is not evidence of an end, so the last answer stands until the next read.
   */
  private stillRunning(watch: CodexSubagentWatch, turns: readonly RpcTurn[], threadState: string | undefined): boolean {
    const newest = turns.at(-1);
    if (!newest) return false;
    const settled = watch.settledTurn;
    if (settled) {
      // A terminal before the first readable turn cannot distinguish that execution from new work.
      // Bind its first snapshot, then require an ordered turn after it, not merely a different id.
      if (settled.id === undefined) {
        settled.id = newest.id;
        settled.pending = undefined;
        return false;
      }
      const boundary = turns.findIndex(turn => turn.id === settled.id);
      if (boundary < 0 || boundary === turns.length - 1) return false;
      // A terminal can settle a follow-up before its own turn is readable. That first newer turn
      // belongs to the ended claim, not to another run; only work after it may reopen the child.
      if (settled.pending) {
        settled.id = turns[boundary + 1]!.id;
        settled.pending = undefined;
        if (boundary + 1 === turns.length - 1) return false;
      }
    }
    const status = turnStatus(newest.status);
    const running = status === 'inProgress' || (status === 'interrupted'
      && (threadState === 'active' || (threadState !== 'idle' && threadState !== 'systemError' && watch.running)));
    // A newer run can span many reads; advance the fence only when that newer work has ended.
    if (settled && !running) settled.id = newest.id;
    return running;
  }

  private mergeMetadata(
    watch: CodexSubagentWatch,
    taskTitle?: string,
    prompt?: string,
    model?: string,
    titlePriority: 1 | 2 = 2,
    modelPriority: 1 | 2 = 1,
  ): boolean {
    let changed = false;
    if (taskTitle && titlePriority >= (watch.taskTitlePriority ?? 0)) {
      if (watch.taskTitle !== taskTitle) { watch.taskTitle = taskTitle; changed = true; }
      watch.taskTitlePriority = titlePriority;
    }
    if (prompt && watch.prompt !== prompt) { watch.prompt = prompt; changed = true; }
    if (model && modelPriority >= (watch.modelPriority ?? 0)) {
      if (watch.model !== model) { watch.model = model; changed = true; }
      watch.modelPriority = modelPriority;
    }
    return changed;
  }

  /** Running children sync on every tick; finished ones at most every SUBAGENT_IDLE_POLL_MS. */
  async refresh(): Promise<void> {
    await Promise.all([...this.watches.values()].map(watch => this.refreshOne(watch)));
  }

  async refreshOne(watch: CodexSubagentWatch): Promise<void> {
    if (watch.syncing) return await watch.syncing;
    if (watch.loaded && !watch.running && Date.now() - watch.lastSyncAt < SUBAGENT_IDLE_POLL_MS) return;
    const task = this.sync(watch).catch(() => { /* a projection failure cannot prove the child ended */ });
    watch.syncing = task;
    try { await task; } finally { if (watch.syncing === task) watch.syncing = undefined; }
  }

  /** Reads what a child thread holds since the last sync and sends it to the conversation's listeners. */
  private async sync(watch: CodexSubagentWatch, reread = false): Promise<void> {
    watch.lastSyncAt = Date.now();
    const revision = watch.signalRevision ?? 0;
    const turns = await this.context.readTurns(watch.childId).catch(() => undefined);
    if (!this.watches.has(watch.toolCallId)) return;
    if (!turns) { this.settleUnreadable(watch); return; }
    // A live claim or terminal that arrived while this read was in flight is newer than the copy
    // it returned. Read once more under the new boundary; a second race waits for the next tick.
    if ((watch.signalRevision ?? 0) !== revision) {
      if (!reread) return this.sync(watch, true);
      watch.lastSyncAt = 0;
      return;
    }
    if (!watch.awaiting && watch.running && watch.lastTurnId && !turns.some(turn => turn.id === watch.lastTurnId)) {
      // A live target absent from an old/empty window has no terminal or content in that read.
      // Preserve both execution and its last published transcript; an empty reset would erase
      // already observed C2 rows even though its execution fence correctly remains running.
      watch.lastSyncAt = 0;
      return;
    }
    const newest = turns.at(-1);
    for (const evidence of this.historyTerminals.get(watch)?.values() ?? []) {
      if (evidence.obsolete || evidence.revision !== revision) continue;
      // A successful same-execution read does not erase shutdown evidence. Only provider order
      // proving later child work invalidates it; an unrelated/non-overlapping window cannot.
      if (!evidence.turnId) evidence.turnId = newest?.id;
      else {
        const boundary = turns.findIndex(turn => turn.id === evidence.turnId);
        if (boundary >= 0 && boundary < turns.length - 1) evidence.obsolete = true;
      }
    }
    // Record this read before another await, so a live terminal while descendants/metadata load
    // binds the execution just seen. An older snapshot cannot move that boundary backwards.
    if (newest && (!watch.lastTurnId || turns.some(turn => turn.id === watch.lastTurnId))) watch.lastTurnId = newest.id;
    // A child can finish while its own background children carry on. Announce those descendants
    // before settling this child so the session never briefly appears finished between them.
    const known = new Set(this.watches.values());
    this.note(turns);
    await Promise.all([...this.watches.values()].filter(child => !known.has(child)).map(child => this.refreshOne(child)));
    // A live claim or terminal can also land while those descendants are being read. The copy this
    // sync started from predates it, so it must not settle the child on that copy either.
    if ((watch.signalRevision ?? 0) !== revision) {
      if (!reread) return this.sync(watch, true);
      watch.lastSyncAt = 0;
      return;
    }
    const claim = watch.awaiting;
    const passed = claim ? this.claimPassed(claim, turns) : false;
    const interrupted = newest !== undefined && turnStatus(newest.status) === 'interrupted';
    // Until the grace expires, an idle thread proves nothing: the turn a follow-up announced may
    // not have been written yet. After it, the runtime's own status decides whether work is real.
    // An interrupted newest turn needs the same status, since history may name a provisional copy
    // of the turn that is executing.
    const expired = claim !== undefined && Date.now() - claim.since >= SUBAGENT_CLAIM_GRACE_MS;
    let thread: RpcThread | undefined;
    if (!watch.metadataLoaded || expired || interrupted) {
      thread = await this.context.readThread(watch.childId, false).catch(() => undefined);
      if ((watch.signalRevision ?? 0) !== revision) {
        watch.lastSyncAt = 0;
        return;
      }
    }
    const threadState = thread?.status?.type;
    // Recovery also completes exact child interruption waiters. Provisional interrupted copies
    // on an active/unreadable owner remain unknown, just as for the parent foreground.
    for (const turn of turns) {
      const status = turnStatus(turn.status);
      if (status === 'completed' || status === 'failed' || (status === 'interrupted'
        && (threadState === 'idle' || threadState === 'systemError'))) this.context.turnCompleted?.(watch.childId, turn);
    }
    let metadataChanged = false;
    if (thread && !watch.metadataLoaded) {
      watch.metadataLoaded = true;
      if (str(thread.agentRole) && watch.subagentType !== str(thread.agentRole)) {
        watch.subagentType = str(thread.agentRole);
        metadataChanged = true;
      }
      const nextTitle = str(thread.agentNickname) ?? str(thread.name);
      if (nextTitle && !watch.title) {
        watch.title = nextTitle;
        metadataChanged = true;
      }
      const actualModel = str(thread.model);
      if (actualModel) {
        if (actualModel !== watch.model) { watch.model = actualModel; metadataChanged = true; }
        watch.modelPriority = 2;
      }
    }
    const events = turns.flatMap(turn => asArray<RpcItem>(turn.items).flatMap(item => this.context.projectChildItem(item, turn, watch.childId)));
    // Child events are numbered inside their own transcript; the parent's sequence space is separate.
    events.forEach((event, index) => { event.sequence = index + 1; });
    // Whether the child is working is the child's own newest turn, the same "is its transcript
    // still moving" signal Cursor and DSH use. The parent's `agentsStates` is only as fresh as the
    // last collaboration call, so a stale `running` there must not keep a finished child spinning.
    // A live follow-up that named new work outranks history that still stops at the previous turn:
    // only a turn newer than the one the claim named proves that work started, so the boundary
    // turn's own `inProgress` never stands for the follow-up. Until that turn appears the claim
    // holds, and only a live terminal or the thread itself going idle after the grace ends it. A
    // status the thread read could not supply is not evidence of an end, so the last state stands.
    // `pendingInit`/`running` still name a child that has no turn to look at yet. Once it has a
    // committed turn, its own history outranks these potentially stale parent-side labels.
    let running: boolean;
    if (claim) {
      if (passed) {
        watch.awaiting = undefined;
        running = this.stillRunning(watch, turns, threadState);
      } else if (!expired) {
        running = true;
      } else if (threadState === 'active') {
        running = true;
      } else if (threadState === 'idle' || threadState === 'systemError') {
        watch.awaiting = undefined;
        running = this.stillRunning(watch, turns, threadState);
      } else {
        running = watch.running;
      }
    } else {
      running = turns.length
        ? this.stillRunning(watch, turns, threadState)
        : (watch.agentStatus === 'pendingInit' || watch.agentStatus === 'running');
    }
    const becameRunning = watch.loaded && running !== watch.running;
    const previousIndex = watch.sentTailId ? events.findIndex(event => event.nativeId === watch.sentTailId) : -1;
    watch.events = events;
    watch.loaded = true;
    watch.running = running;
    watch.sentTailId = events.at(-1)?.nativeId;
    if (previousIndex < 0) {
      this.context.emit(this.snapshot(watch));
      return;
    }
    const delta = events.slice(previousIndex + 1);
    if (!delta.length && !becameRunning && !metadataChanged) return;
    if (!delta.length && metadataChanged) {
      this.context.emit(this.snapshot(watch));
      return;
    }
    this.context.emit({
      type: 'subagent', toolCallId: watch.toolCallId, agentId: watch.childId,
      ...(watch.subagentType ? { subagentType: watch.subagentType } : {}),
      ...this.taskFields(watch),
      reset: false, events: delta, running,
    });
  }

  /**
   * A child's latest events, cut to fit both an event and a byte budget. A subscriber's opening
   * burst carries one of these per child, so a phone must not be handed a megabyte per subagent;
   * whatever is cut stays behind the history cursor.
   */
  snapshot(watch: CodexSubagentWatch): CodexSubagentFrame {
    const generation = `codex-sub:${watch.childId}`;
    const start = subagentSnapshotStart(watch.events, SNAPSHOT_EVENTS);
    const tail = watch.events.slice(start);
    const firstSequence = tail[0]?.sequence;
    const hasMore = start > 0;
    const title = watch.taskTitle ?? watch.title;
    return {
      type: 'subagent', toolCallId: watch.toolCallId, agentId: watch.childId,
      ...(watch.subagentType ? { subagentType: watch.subagentType } : {}),
      ...(title ? { title } : {}), ...(watch.prompt ? { prompt: watch.prompt } : {}), ...(watch.model ? { model: watch.model } : {}),
      reset: true, events: tail,
      history: { generation, ...(hasMore && firstSequence !== undefined ? { cursor: encodeHistoryCursor(generation, firstSequence) } : {}), hasMore },
      running: watch.running,
    };
  }

  private taskFields(watch: CodexSubagentWatch): { title?: string; prompt?: string; model?: string } {
    const title = watch.taskTitle ?? watch.title;
    return { ...(title ? { title } : {}), ...(watch.prompt ? { prompt: watch.prompt } : {}), ...(watch.model ? { model: watch.model } : {}) };
  }
}
