import type { NativeActivity } from '../../../../../packages/contracts/src/index.js';
import type { CodexAppServerClient } from '../shared/codex-app-server.js';
import { AppError } from '../../errors.js';
import type { Journal } from '../../journal/journal.js';
import {
  ACTIVITY_BLOB_LIMIT, ACTIVITY_DETAIL_LIMIT, ActivityLedger, activityId, activityOfEvent, activityTitle, clipDetail, isLiveActivity,
} from '../../journal/activity.js';
import type { CodexFlavor } from './flavors.js';
import { lastRolloutCompaction } from './rollout-records.js';
import { turnStatus } from './transcript.js';
import type { RpcItem, RpcTurn } from './types.js';
import { asArray, asRecord, readFileTail, str } from './util.js';

/** Bytes of the rollout's tail read for the compaction summary: a `compacted` row carries the replacement history. */
const SUMMARY_TAIL_BYTES = 4 * 1024 * 1024;
/** Fewest ms between two `thread/backgroundTerminals/list` calls, and how often a live one is looked at again. */
const LIST_MIN_MS = 500;
const LIVE_POLL_MS = 3_000;
const STOP_CONFIRM_TRIES = 8;
const STOP_CONFIRM_MS = 500;

/** An app-server built before an experimental method existed answers "method not found" / "unknown variant" / JSON-RPC -32601. */
export function isMethodUnsupported(error: unknown): boolean {
  if ((error as { rpcCode?: unknown } | undefined)?.rpcCode === -32601) return true;
  return /method not found|unknown method|unknown variant|-32601|not supported|unsupported/i.test(error instanceof Error ? error.message : String(error));
}

/**
 * History lacks the item's completion notification. A recorded item end or a successful turn can
 * confirm completion; merely finding a later item cannot. Without `trigger`, one in a turn the user
 * opened is automatic and one in a turn of its own was `/compact`.
 */
export function readCompaction(
  backend: string, item: RpcItem, turn: { id: string; startedAt?: number | null; completedAt?: number | null; status?: RpcTurn['status']; items?: unknown }, settled: boolean,
  trigger: 'manual' | 'auto' = asArray<RpcItem>(turn.items).some(entry => entry.type === 'userMessage') ? 'auto' : 'manual',
  known?: NativeActivity,
): NativeActivity {
  const running = !settled && asArray<RpcItem>(turn.items).at(-1) === item;
  const nativeStatus = turnStatus(turn.status);
  const completed = typeof item.completedAtMs === 'number' && Number.isFinite(item.completedAtMs);
  const status = completed || (settled && nativeStatus === 'completed') ? 'completed'
    : !settled ? running ? 'running' : 'unknown'
      : nativeStatus === 'failed' ? 'failed' : nativeStatus === 'interrupted' ? 'stopped' : 'unknown';
  // Item success survives weaker turn evidence. Interrupted history is provisional, but a
  // later failed/completed result is authoritative; only an unknown end can resume running.
  if (known && (known.status === 'completed'
    || known.status === 'failed' && status !== 'completed' && status !== 'failed'
    || known.status === 'stopped' && status !== 'completed' && status !== 'failed'
    || !isLiveActivity(known) && known.status !== 'unknown' && status === 'running')) return known;
  const startedAt = known?.startedAt ?? (
    typeof item.startedAtMs === 'number' && Number.isFinite(item.startedAtMs) ? new Date(item.startedAtMs).toISOString()
      : typeof turn.startedAt === 'number' && Number.isFinite(turn.startedAt) ? new Date(turn.startedAt * 1000).toISOString() : undefined
  );
  // Without a native end, keep the first observation the ledger already persisted. Missing
  // native times stay absent rather than becoming an epoch start or a synthetic duration.
  const endedAt = completed ? new Date(item.completedAtMs as number).toISOString()
    : settled && typeof turn.completedAt === 'number' && Number.isFinite(turn.completedAt) ? new Date(turn.completedAt * 1000).toISOString() : known?.endedAt;
  return {
    ...known,
    id: activityId(backend, `compaction:${item.id}`), kind: 'compaction', status, title: '上下文压缩', startedAt,
    endedAt: status !== 'running' ? endedAt : undefined,
    durationMs: status !== 'running' && startedAt && endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : undefined,
    compaction: { trigger, ...known?.compaction },
  };
}

/** What the runtime lends this class: the connection, the log, and the one place an activity row is written. */
export interface CodexActivityHost {
  readonly flavor: CodexFlavor;
  readonly sessionId: string;
  threadId(): string | undefined;
  /** The connection when it is up, else undefined. */
  transport(): CodexAppServerClient | undefined;
  journal(): Journal;
  contextUsed(): number | undefined;
  rolloutFile(threadId: string): Promise<string | undefined>;
  /** Writes one state to the log and the live stream, and republishes the status. */
  write(activity: NativeActivity, turnId: string | undefined): void;
  hasListeners(): boolean;
}

interface Terminal {
  itemId?: string;
  command?: string;
  turnId?: string;
  startedAt: string;
  /** The command item that spawned this terminal has returned. */
  completed?: boolean;
  /** The provider explicitly detached the process; its exit code may be synthetic. */
  backgrounded?: boolean;
  /** A terminal command status reported a real exit code, so the process itself is over. */
  exited?: boolean;
  /** Listed once already since that completion, which is what says it outlived the command. */
  listed?: boolean;
}

/**
 * Codex / TRAE CLI system activities: context compactions (the `contextCompaction` item, with the
 * summary from the rollout's `compacted` row) and background terminals
 * (`thread/backgroundTerminals/*`, experimental in both CLIs).
 */
export class CodexActivities {
  readonly ledger: ActivityLedger;
  private readonly turnOf = new Map<string, string>();
  private readonly turnsWithUser = new Set<string>();
  private readonly terminals = new Map<string, Terminal>();
  private support: 'unknown' | 'yes' | 'no' = 'unknown';
  /** The stop method is missing although listing works (or the other way round): remembered so no later command retries it. */
  private stopSupported = true;
  private hinted = true;
  private lastList = 0;
  private task: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private retry: NodeJS.Timeout | undefined;
  private reconciled = false;
  private pendingPost: string | undefined;
  /** Stops asked for and not yet settled: a repeated request joins the first instead of terminating twice. */
  private readonly stopping = new Map<string, Promise<NativeActivity>>();

  constructor(private readonly host: CodexActivityHost) {
    this.ledger = new ActivityLedger((activity) => this.host.write(activity, this.turnOf.get(activity.id)), id => {
      const entity = this.host.journal().entity(this.host.sessionId, id);
      const activity = activityOfEvent(entity?.payload);
      if (activity?.kind !== 'compaction' || !id.startsWith(`${this.host.flavor.id}:compaction:`)) return undefined;
      if (entity?.turnId) this.turnOf.set(id, entity.turnId);
      return activity;
    });
    // Completion notices, token counts and summaries outlive this runtime. Restore their
    // evidence before history can supply a weaker turn-derived outcome.
    this.ledger.restore(this.host.journal().activityEntities(this.host.sessionId).flatMap(entity => {
      const activity = activityOfEvent(entity.payload);
      if (!activity || activity.kind !== 'compaction' || !activity.id.startsWith(`${this.host.flavor.id}:compaction:`)) return [];
      if (entity.turnId) this.turnOf.set(activity.id, entity.turnId);
      return [activity];
    }));
  }

  private get prefix(): string { return `${this.host.flavor.id}:terminal:`; }
  private compactionId(item: RpcItem): string { return activityId(this.host.flavor.id, `compaction:${item.id}`); }

  // ---- compaction ---------------------------------------------------------------------------

  noteUserMessage(turnId: string): void { this.turnsWithUser.add(turnId); if (this.turnsWithUser.size > 256) this.turnsWithUser.delete(this.turnsWithUser.values().next().value!); }

  /** A compaction nobody asked for in a turn that has a user message is automatic; a turn made only of it was `/compact`. */
  private trigger(turn: { id: string; items?: unknown }): 'manual' | 'auto' {
    return this.turnsWithUser.has(turn.id) || asArray<RpcItem>(turn.items).some(item => item.type === 'userMessage') ? 'auto' : 'manual';
  }

  /** The activity a read of the thread shows for a compaction item: what the live notices said, else what the turn implies. */
  presented(item: RpcItem, turn: { id: string; startedAt?: number | null; completedAt?: number | null; status?: RpcTurn['status']; items?: unknown }, settled: boolean): NativeActivity {
    return readCompaction(this.host.flavor.id, item, turn, settled, this.trigger(turn), this.ledger.get(this.compactionId(item)));
  }

  compactionStarted(item: RpcItem, turnId: string, startedAtMs: number): void {
    if (!str(item.id)) return;
    const id = this.compactionId(item);
    this.turnOf.set(id, turnId);
    const pre = this.host.contextUsed();
    this.ledger.apply({
      id, kind: 'compaction', status: 'running', title: '上下文压缩',
      startedAt: Number.isFinite(startedAtMs) ? new Date(startedAtMs).toISOString() : new Date().toISOString(),
      compaction: { trigger: this.trigger({ id: turnId }), ...(pre !== undefined ? { preTokens: pre } : {}) },
    });
  }

  compactionCompleted(item: RpcItem, turnId: string, completedAtMs?: number): void {
    if (!str(item.id)) return;
    const id = this.compactionId(item);
    this.turnOf.set(id, turnId);
    const known = this.ledger.get(id);
    const completed = typeof completedAtMs === 'number' && Number.isFinite(completedAtMs) ? completedAtMs : item.completedAtMs;
    const endedAt = typeof completed === 'number' && Number.isFinite(completed)
      ? new Date(completed).toISOString() : new Date().toISOString();
    // A late item completion replaces the provisional end and its derived duration together.
    const end = known?.status === 'completed' ? {} : {
      endedAt,
      ...(known?.startedAt ? { durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(known.startedAt)) } : {}),
    };
    const done = this.ledger.apply(known ? { ...known, status: 'completed', ...end } : {
      id, kind: 'compaction', status: 'completed', title: '上下文压缩', ...end, compaction: { trigger: this.trigger({ id: turnId }) },
    });
    this.pendingPost = done.id;
    void this.attachSummary(done.id);
  }

  /** Only a successful turn can stand in for a missing item completion; confirmed compactions stay successful. */
  turnCompleted(turnId: string, nativeStatus?: RpcTurn['status']): void {
    const status = turnStatus(nativeStatus);
    this.ledger.settleWhere(activity => activity.kind === 'compaction' && this.turnOf.get(activity.id) === turnId,
      status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : status === 'interrupted' ? 'stopped' : 'unknown');
    this.pendingPost = undefined;
  }

  /** Called on a read of a turn: a compaction it shows as running, or ended, is brought into line. */
  noteTurn(turn: RpcTurn, settled: boolean, live: boolean): void {
    for (const item of asArray<RpcItem>(turn.items)) {
      if (item.type === 'userMessage') this.noteUserMessage(turn.id);
      if (item.type === 'commandExecution' && live) this.noteCommand(item, turn.id);
      if (item.type !== 'contextCompaction' || !str(item.id) || !live) continue;
      const id = this.compactionId(item);
      this.turnOf.set(id, turn.id);
      this.ledger.apply(readCompaction(this.host.flavor.id, item, turn, settled, this.trigger(turn), this.ledger.get(id)));
    }
  }

  /** The next context reading after a compaction is what it left. */
  noteContext(used: number): void {
    const id = this.pendingPost;
    if (!id) return;
    const current = this.ledger.get(id);
    if (!current?.compaction) { this.pendingPost = undefined; return; }
    const pre = current.compaction.preTokens;
    if (pre !== undefined && used >= pre) return;
    this.pendingPost = undefined;
    this.ledger.apply({ ...current, compaction: { ...current.compaction, postTokens: used } });
  }

  /** The summary Codex wrote into the rollout when it compacted; may land a moment after the item completes. */
  private async attachSummary(id: string): Promise<void> {
    const threadId = this.host.threadId();
    if (!threadId) return;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 1_500));
      try {
        const file = await this.host.rolloutFile(threadId);
        const current = this.ledger.get(id);
        if (!file || !current) return;
        const summary = lastRolloutCompaction(await readFileTail(file, SUMMARY_TAIL_BYTES));
        const wrote = summary?.timestamp ? Date.parse(summary.timestamp) : Number.NaN;
        const started = current.startedAt ? Date.parse(current.startedAt) : Number.NaN;
        if (!summary?.message || (Number.isFinite(wrote) && Number.isFinite(started) && wrote < started - 1_000)) continue;
        const text = summary.message;
        const blobRef = text.length > ACTIVITY_DETAIL_LIMIT
          ? this.host.journal().putSessionBlob(this.host.sessionId, Buffer.from(text.slice(0, ACTIVITY_BLOB_LIMIT)))
          : undefined;
        this.ledger.apply({ ...current, detail: clipDetail(text), ...(blobRef ? { blobRef } : {}) });
        return;
      } catch { /* the rollout may not exist yet or be half written; the next attempt looks again */ }
    }
  }

  // ---- background terminals --------------------------------------------------------------------

  /** A command that carries a PTY process id may leave a terminal behind: look at the list soon. */
  noteCommand(item: RpcItem, turnId: string): void {
    const processId = str(item.processId);
    if (!processId) return;
    const previous = this.terminals.get(processId);
    const status = str(item.status);
    const backgrounded = status === 'backgrounded';
    const terminal = status === 'completed' || status === 'failed' || status === 'declined';
    // TRAE's detached command reports a synthetic exitCode=0. Only a terminal command status
    // makes an exit code evidence that the process itself ended.
    const exitCode = item.exitCode;
    this.terminals.set(processId, {
      ...previous, itemId: str(item.id) ?? previous?.itemId, command: str(item.command) ?? previous?.command, turnId,
      completed: terminal || backgrounded || previous?.completed === true,
      backgrounded: backgrounded || previous?.backgrounded === true,
      exited: (terminal && exitCode !== undefined && exitCode !== null) || previous?.exited === true,
      startedAt: previous?.startedAt ?? new Date().toISOString(),
    });
    if (this.terminals.size > 256) this.terminals.delete(this.terminals.keys().next().value!);
    this.hinted = true;
  }

  /**
   * A terminal whose command item completed without an exit code, and that is listed again since: the
   * tool call returned while the process kept running, which is what makes it a background terminal.
   */
  private awaitingBackground(processId: string, info: Terminal | undefined): boolean {
    return info !== undefined && info.completed === true && info.exited !== true && info.listed === true
      && !this.ledger.get(this.prefix + processId);
  }

  /** Whether any terminal still needs its second look before it can be called a background one. */
  private awaitingSecondLook(): boolean {
    for (const [processId, info] of this.terminals) if (this.awaitingBackground(processId, info)) return true;
    return false;
  }

  /** One look at the thread's background terminals when something suggests they changed, and while any is live. */
  sync(): void {
    if (this.support === 'no' || this.task || !this.host.transport() || !this.host.threadId()) return;
    if (!this.hinted && !this.liveTerminals().length && !this.awaitingSecondLook()) return;
    const wait = LIST_MIN_MS - (Date.now() - this.lastList);
    if (wait > 0) {
      // Too soon after the last look: try again when the gap has passed, so a hint is never left waiting for a slow poll.
      if (!this.retry && this.host.hasListeners()) {
        this.retry = setTimeout(() => { this.retry = undefined; this.sync(); }, wait + 20);
        this.retry.unref();
      }
      return;
    }
    this.task = this.refresh().catch(() => undefined).finally(() => { this.task = undefined; });
  }

  hint(): void { this.hinted = true; this.sync(); }

  private liveTerminals(): NativeActivity[] { return this.ledger.live().filter(activity => activity.id.startsWith(this.prefix)); }

  private async list(): Promise<Map<string, { itemId?: string; command?: string }>> {
    const transport = this.host.transport();
    const threadId = this.host.threadId();
    if (!transport || !threadId) throw new Error('not connected');
    let result: Record<string, unknown> | undefined;
    try {
      result = asRecord(await transport.request('thread/backgroundTerminals/list', { threadId }, 8_000));
    } catch (error) {
      // An app-server built before the experimental method exists answers "method not found" (or "unknown variant").
      if (isMethodUnsupported(error)) this.support = 'no';
      throw error;
    }
    this.support = 'yes';
    const listed = new Map<string, { itemId?: string; command?: string }>();
    for (const entry of asArray<unknown>(result?.data)) {
      const record = asRecord(entry);
      const processId = str(record?.processId);
      if (processId) listed.set(processId, { itemId: str(record?.itemId), command: str(record?.command) });
    }
    // TRAE CLI lists bare process ids; the command comes from the item that started the process.
    for (const processId of asArray<unknown>(result?.processIds)) if (typeof processId === 'string' && processId) listed.set(processId, {});
    return listed;
  }

  private async refresh(): Promise<void> {
    this.lastList = Date.now();
    this.hinted = false;
    const listed = await this.list();
    const seen = new Set<string>();
    for (const [processId, entry] of listed) {
      const info = this.terminals.get(processId);
      const command = entry.command ?? info?.command;
      const itemId = entry.itemId ?? info?.itemId;
      const id = this.prefix + processId;
      const startedAt = info?.startedAt ?? new Date().toISOString();
      if (info?.turnId) this.turnOf.set(id, info.turnId);
      // A PTY can remain listed briefly after a real exit. An explicit `backgrounded` item is
      // already evidence of detachment; otherwise a completed command without an exit code must
      // survive a second list before it can be called background work.
      const backgrounded = info === undefined || (info.exited !== true &&
        (info.backgrounded === true || (info.completed === true && info.listed === true)));
      if (info) info.listed = true;
      if (!backgrounded) continue;
      seen.add(id);
      this.ledger.apply({
        id, kind: 'background_task', status: 'running', title: activityTitle(command ?? '', '后台终端'), startedAt,
        ...(itemId ? { toolCallId: itemId } : {}), stop: { via: 'protocol' },
        task: { kind: 'terminal', ...(command ? { command: command.slice(0, 2048) } : {}) },
      });
    }
    // A terminal this runtime saw running and that is no longer listed has ended; a stop that was asked for ended by it.
    for (const activity of this.liveTerminals()) {
      if (!seen.has(activity.id)) this.ledger.apply({ ...activity, status: activity.status === 'stopping' ? 'stopped' : 'completed' });
    }
    // An absent process has also finished when it disappeared before its second look. Without
    // clearing the candidate, it would keep the confirmation poll alive with no activity to end.
    for (const [processId] of this.terminals) {
      if (!listed.has(processId)) this.terminals.delete(processId);
    }
    this.reconcileLogged(seen);
    this.arm();
  }

  /**
   * Terminals the log still shows as running from before this runtime existed: the first successful
   * list is the evidence that the ones it does not name are gone.
   */
  private reconcileLogged(listed: Set<string>): void {
    if (this.reconciled) return;
    this.reconciled = true;
    try {
      // Read through the activity rows' own index: folding a long log's projection would hold the event loop.
      for (const entity of this.host.journal().activityEntities(this.host.sessionId)) {
        const logged = activityOfEvent(entity.payload);
        if (!logged || logged.kind !== 'background_task' || !logged.id.startsWith(this.prefix) || listed.has(logged.id) || this.ledger.get(logged.id)) continue;
        if (isLiveActivity(logged)) this.ledger.apply({ ...logged, status: 'unknown' });
      }
    } catch { /* the log is a record, not a dependency of the live state */ }
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.host.hasListeners()) return;
    const live = this.liveTerminals().length > 0;
    // A terminal waiting for its second look is polled on the list's own cadence, not the slower live one.
    if (!live && !this.awaitingSecondLook()) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.sync(); }, live ? LIVE_POLL_MS : LIST_MIN_MS);
    this.timer.unref();
  }

  /** Stops a background terminal: `stopping` now, `stopped` once the provider says it is gone. */
  stop(id: string): Promise<NativeActivity> {
    const inflight = this.stopping.get(id);
    if (inflight) return inflight;
    const run = this.stopOnce(id).finally(() => this.stopping.delete(id));
    this.stopping.set(id, run);
    return run;
  }

  private async stopOnce(id: string): Promise<NativeActivity> {
    const flavor = this.host.flavor;
    if (this.support === 'no' || !this.stopSupported) throw new AppError('ACTIVITY_STOP_UNSUPPORTED', `This ${flavor.label} build cannot stop background terminals`, 409);
    const known = this.ledger.get(id);
    if (!known?.id.startsWith(this.prefix)) throw new AppError('ACTIVITY_NOT_FOUND', 'This activity is not known to the conversation', 404);
    const transport = this.host.transport();
    const threadId = this.host.threadId();
    if (!transport || !threadId) throw new AppError('NATIVE_OFFLINE', `${flavor.label} is not connected`, 409);
    const { token } = this.ledger.beginStop(id);
    const processId = id.slice(this.prefix.length);
    try {
      const reply = asRecord(await transport.request(flavor.backgroundTerminalStop, { threadId, processId }, 10_000));
      const outcome = str(reply?.outcome);
      // The reply itself is evidence only when it says the process is gone; a requested termination is confirmed by the list.
      if (reply?.terminated === true || outcome === 'alreadyExited') return this.ledger.apply({ ...this.ledger.get(id)!, status: 'stopped' });
      for (let attempt = 0; attempt < STOP_CONFIRM_TRIES; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, STOP_CONFIRM_MS));
        this.lastList = 0;
        if (!(await this.list()).has(processId)) return this.ledger.apply({ ...this.ledger.get(id)!, status: 'stopped' });
        if (reply?.terminated === false) break;
      }
      // Still listed after the bounded wait: the terminate had no effect, so the terminal is running and the caller is told.
      throw new AppError('ACTIVITY_STOP_FAILED', `${flavor.label} did not stop this terminal`, 409);
    } catch (error) {
      if (token !== undefined) this.ledger.stopFailed(id, token);
      if (error instanceof AppError) throw error;
      if (isMethodUnsupported(error)) {
        this.stopSupported = false;
        throw new AppError('ACTIVITY_STOP_UNSUPPORTED', `This ${flavor.label} build cannot stop background terminals`, 409);
      }
      throw new AppError('ACTIVITY_STOP_FAILED', `${flavor.label} could not stop this terminal`, 502);
    }
  }

  /** The connection is gone: what was live can no longer be vouched for. */
  lost(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.ledger.settleWhere(activity => activity.kind === 'background_task', 'unknown');
    this.ledger.settleWhere(activity => activity.kind === 'compaction', 'unknown');
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.retry) clearTimeout(this.retry);
    this.timer = undefined;
    this.retry = undefined;
  }
}
