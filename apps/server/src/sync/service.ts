import type { NativeActivity, NativeContext, NativeQueue, NativeStatus, NativeStreamMessage, Run, Session, WorkbenchEvent } from '../../../../packages/contracts/src/index.js';
import { SYNC_BUDGET, type SyncFrame, type SyncLane } from '../../../../packages/contracts/src/sync.js';
import { isLiveActivity } from '../journal/activity.js';
import type { Budget, TimelineChange, TimelineService } from '../timeline/service.js';
import type { SyncConnection } from './connection.js';
import type { TranscriptIngest } from './ingest.js';
import { redactSensitiveText } from '../settings/config-documents.js';

/*
 * Sync v3 streams (docs/SYNC-V3.md, 消息; 续传与缺口): what one `GET /api/v3/sessions/:id/sync` sends.
 *
 * A stream opens with `hello`, which holds the session's state as of one synchronous tick: the lane's
 * timeline, runs, status, context and live activities are subscribed to first and read after, with
 * nothing in between, so no change can fall between what `hello` says and what follows it. Then the
 * rows a resuming client is missing (`delta`), or the newest rows (`snapshot`), then every change.
 *
 * Status, interaction, runs, context, metrics and session frames describe the whole conversation and
 * go out on the main lane's stream only; a subagent lane's stream carries its own rows, outline and
 * activities after its `hello`.
 */

export type ControlMessage = Extract<NativeStreamMessage, { type: 'status' | 'context' | 'metrics' }>;

/** A provider's control path, held open while a stream is (`NativeBackendService.watchControl`). */
export interface ControlHandle { status(): NativeStatus; context(): NativeContext | undefined; close(): void }

export interface SyncDeps {
  timeline: TimelineService;
  ingest: TranscriptIngest;
  getSession(sessionId: string): Session;
  getRun(runId: string): Run;
  /** The runs a stream holds: `hello` and every full `runs` frame. */
  runs(sessionId: string): Run[];
  /** Committed store events of the session; `session` and `run_updated` are read. */
  subscribe(sessionId: string, listener: (event: WorkbenchEvent) => void): () => void;
  control(sessionId: string, listener: (message: ControlMessage) => void): ControlHandle;
  /** Where the session's queued messages stand (`NativeDispatcher.queue`) under `status`, carried on it. */
  queue?(sessionId: string, status: NativeStatus): NativeQueue;
  /** The session's measured turns (`StatsLedger.sessionMetrics`), sent after a main lane's `hello`. */
  metrics?(sessionId: string): Extract<ControlMessage, { type: 'metrics' }>[];
}

/** What the client holds: the lane, and with `generation` and `after` where it holds it. */
export interface SyncRequest { lane: SyncLane; generation?: string; after?: number; budget: Budget }

type RowsChange = Extract<TimelineChange, { type: 'rows' }>;

const rowsFrame = (change: RowsChange): Extract<SyncFrame, { type: 'rows' }> =>
  ({ type: 'rows', generation: change.generation, from: change.from, to: change.to, upserts: change.upserts, ...(change.deletes.length ? { deletes: change.deletes } : {}) });

const metricsFrame = (message: Extract<ControlMessage, { type: 'metrics' }>): Extract<SyncFrame, { type: 'metrics' }> => ({
  type: 'metrics', metrics: message.metrics, ...(message.run ? { run: message.run } : {}),
  ...(message.runId ? { runId: message.runId } : {}), ...(message.nativeMessageId ? { nativeMessageId: message.nativeMessageId } : {}),
});

function errorFrame(error: unknown): Extract<SyncFrame, { type: 'error' }> {
  const message = error instanceof Error ? error.message : String(error);
  return { type: 'error', code: 'TRANSCRIPT_READ_FAILED', message: message.slice(0, 500), retryable: true };
}

export class SyncService {
  constructor(private readonly deps: SyncDeps) {}

  /**
   * Streams the lane to `connection` until it closes. The session is read now and followed meanwhile;
   * `hello` waits for the journal's rows to be folded, not for that read: it says it is catching up,
   * and `caughtUp` follows once what the read found is in the lane.
   */
  async open(connection: SyncConnection, sessionId: string, request: SyncRequest): Promise<void> {
    const { ingest, timeline } = this.deps;
    connection.onClose(ingest.follow(sessionId));
    const reading = ingest.read(sessionId);
    await timeline.ready(sessionId, request.lane);
    if (connection.ended) return;
    let detach: () => void;
    try { detach = this.attach(connection, sessionId, request, reading !== undefined); }
    catch (error) {
      // A conversation deleted meanwhile, or a read that failed: the client reconnects and finds out.
      console.warn(`[sync] opening ${sessionId} ${request.lane} failed:`, error);
      connection.destroy();
      return;
    }
    connection.onClose(detach);
    // Rows go out queued behind control frames, so the client compares `headSeq` with what it holds.
    void reading?.then(() => timeline.ready(sessionId, request.lane)).then(head => {
      if (!connection.ended) connection.control({ type: 'caughtUp', generation: head.generation, headSeq: head.headSeq });
    });
  }

  /** Subscribes, then sends `hello` and what the client is missing, all in this tick. Returns how to stop. */
  private attach(connection: SyncConnection, sessionId: string, request: SyncRequest, catchingUp: boolean): () => void {
    const { timeline } = this.deps;
    const { lane } = request;
    const main = lane === 'main';
    const offs: Array<() => void> = [];
    let opened = false;
    // What went out last, so an unchanged value is not sent again.
    const sent = { status: '', interaction: '', context: '', session: '', activities: '' };
    const changed = (key: keyof typeof sent, value: unknown) => {
      const json = JSON.stringify(value ?? null);
      if (json === sent[key]) return false;
      sent[key] = json;
      return true;
    };

    // ---- the lane: rows, outline and live activities --------------------------------------
    const live = new Map<string, NativeActivity>();
    const loadActivities = () => {
      live.clear();
      for (const activity of timeline.liveActivities(sessionId, lane)) live.set(`activity:${activity.id}`, activity);
    };
    const liveList = () => [...live.values()].slice(-SYNC_BUDGET.liveActivities);
    const sendActivities = () => { const list = liveList(); if (changed('activities', list)) connection.control({ type: 'activities', live: list }); };
    const sendOutline = () => { const outline = timeline.outline(sessionId, lane, SYNC_BUDGET.outlineTurns); connection.control({ type: 'outline', turnCount: outline.turnCount, turns: outline.turns }); };
    offs.push(timeline.subscribe(sessionId, lane, change => {
      if (!opened) return;
      if (change.type === 'rows') {
        connection.rows(rowsFrame(change));
        let moved = false;
        for (const row of change.upserts) {
          if (row.kind !== 'activity') continue;
          if (isLiveActivity(row.activity)) live.set(row.key, row.activity); else live.delete(row.key);
          moved = true;
        }
        for (const key of change.deletes) moved = live.delete(key) || moved;
        if (moved) sendActivities();
      } else if (change.type === 'reset') {
        // Everything the client holds of the lane is gone: the reset, then the new generation's newest rows.
        connection.reset({ type: 'reset', generation: change.generation, reason: change.reason }, timeline.snapshot(sessionId, lane, request.budget));
        sendOutline();
        loadActivities();
        sendActivities();
      } else connection.control({ type: 'outline', turnCount: change.turnCount, turns: change.turns });
    }));

    // ---- the conversation: status, interaction, context, metrics ----------------------------
    // The queue moves with the runs as well as with the provider's status, so the status goes out again
    // when either changes, carrying the queue as it stands then.
    let provider: NativeStatus = { phase: 'offline' };
    const withQueue = (status: NativeStatus): NativeStatus => {
      let queue: NativeQueue | undefined;
      try { queue = this.deps.queue?.(sessionId, status); } catch { /* a conversation deleted meanwhile */ }
      return queue ? { ...status, queue } : status;
    };
    const sendStatus = (status: NativeStatus) => {
      provider = status;
      const interaction = status.interaction ?? null;
      if (changed('interaction', interaction)) connection.control({ type: 'interaction', interaction });
      const current = withQueue(status);
      if (changed('status', current)) connection.control({ type: 'status', status: current });
    };
    let control: ControlHandle | undefined;
    let controlError: unknown;
    try {
      control = this.deps.control(sessionId, message => {
        if (!opened || !main) return;
        if (message.type === 'status') sendStatus(message.status);
        else if (message.type === 'context') { if (changed('context', message.context)) connection.control({ type: 'context', ...(message.context ? { context: message.context } : {}) }); }
        else connection.control(metricsFrame(message));
      });
      offs.push(() => control!.close());
    } catch (error) {
      controlError = error;
      console.warn('[sync] conversation control could not be opened', {
        sessionId, lane,
        code: typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'NATIVE_STATUS_UNAVAILABLE',
        message: redactSensitiveText(error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]+/g, ' ').slice(0, 500),
      });
    }

    // ---- the store: session and runs --------------------------------------------------------
    const sendSession = () => {
      let session: Session;
      try { session = this.deps.getSession(sessionId); } catch { return; }
      if (changed('session', session)) connection.control({ type: 'session', session });
    };
    // Several updates inside a tick (a commit broadcasts its events back to back) go out once.
    let pendingRuns: Set<string> | undefined, allRuns = false;
    const flushRuns = () => {
      const ids = pendingRuns ?? new Set<string>(), all = allRuns;
      pendingRuns = undefined;
      allRuns = false;
      if (connection.ended) return;
      sendSession();
      let runs: Run[] | undefined;
      if (!all) try { runs = [...ids].map(id => this.deps.getRun(id)); } catch { /* a run that is gone: send them all */ }
      if (runs) for (const run of runs) connection.control({ type: 'run', run });
      else connection.control({ type: 'runs', runs: this.deps.runs(sessionId) });
      // After the runs it names.
      sendStatus(provider);
    };
    offs.push(this.deps.subscribe(sessionId, event => {
      if (!opened || !main) return;
      if (event.type === 'session') { sendSession(); return; }
      if (event.type !== 'run_updated') return;
      if (!pendingRuns) { pendingRuns = new Set(); queueMicrotask(flushRuns); }
      if (event.runId) pendingRuns.add(event.runId); else allRuns = true;
    }));
    offs.push(this.deps.ingest.onError((failed, error) => { if (opened && failed === sessionId) connection.control(errorFrame(error)); }));

    const detach = () => {
      for (const off of offs.splice(0)) {
        try { off(); } catch { /* every subscription is let go */ }
      }
    };

    // ---- hello, then what the client is missing -------------------------------------------
    try {
      const session = this.deps.getSession(sessionId);
      provider = control ? control.status() : { phase: 'offline' };
      const status = withQueue(provider);
      const context = control?.context();
      const resumed = request.generation !== undefined && request.after !== undefined
        ? timeline.resume(sessionId, lane, { generation: request.generation, after: request.after, ...request.budget }) : undefined;
      const snapshot = resumed ? undefined : timeline.snapshot(sessionId, lane, request.budget);
      const outline = timeline.outline(sessionId, lane, SYNC_BUDGET.outlineTurns);
      loadActivities();
      const activities = liveList();
      changed('status', status);
      changed('interaction', status.interaction ?? null);
      changed('context', context);
      changed('session', session);
      changed('activities', activities);
      connection.control({
        type: 'hello', protocol: 3, lane,
        generation: resumed ? resumed.head.generation : snapshot!.generation,
        headSeq: resumed ? resumed.head.headSeq : snapshot!.asOfSeq,
        mode: resumed ? 'delta' : 'snapshot',
        session, status, interaction: status.interaction ?? null, runs: this.deps.runs(sessionId), activities,
        ...(context ? { context } : {}),
        outline: { turnCount: outline.turnCount, turns: outline.turns },
        ...(catchingUp ? { catchingUp } : {}),
      });
      if (resumed) for (const frame of resumed.frames) connection.rows(rowsFrame(frame));
      else connection.snapshot(snapshot!);
      // Every measured turn's speed, including turns typed in the CLI, which no Run carries.
      if (main) for (const message of this.deps.metrics?.(sessionId) ?? []) connection.control(metricsFrame(message));
      // A read that failed before this stream opened, and has not succeeded since.
      const failure = this.deps.ingest.failure(sessionId);
      if (failure !== undefined) connection.control(errorFrame(failure));
      if (controlError !== undefined) {
        const code = (controlError as { code?: unknown }).code;
        connection.control({ type: 'error', code: typeof code === 'string' ? code : 'NATIVE_STATUS_UNAVAILABLE', message: controlError instanceof Error ? controlError.message.slice(0, 500) : 'The conversation status is unavailable', retryable: true });
      }
    } catch (error) { detach(); throw error; }
    opened = true;
    return detach;
  }
}
