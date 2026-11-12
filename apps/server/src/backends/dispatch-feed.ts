import type { NativeWorkbenchEvent, Session } from '../../../../packages/contracts/src/index.js';
import { latestEvents, type FeedBatch, type JournalFeed, type TurnMark } from '../journal/feed.js';
import { hasTurnEnded, servingKey, turnMetaId } from '../journal/ingest.js';
import type { DispatchObservation, DispatchSnapshot, NativeDispatcherBackend } from '../native/dispatch.js';
import type { Store } from '../store.js';
import type { NativeBackendService } from './service.js';

/*
 * What the dispatcher hears of a conversation (docs/SYNC-V3.md, 接线): the journal's main lane, the events a
 * driver sends outside its transcript (`host.emitEvent`: steer receipts, hook-reported turn ends) and the
 * provider's status, as the events and statuses `NativeDispatcher.observe` reads.
 *
 * - An event is the latest version of its entity, numbered by its first row (`sequence`), which is the numbering
 *   of the fence's `baselineSequence` (`NativeBackendService.journalBaseline`).
 * - A turn's end is its run's outcome: `run_completed`, `run_failed` (with the provider's error) or
 *   `run_cancelled`, for the run its start names (`turn_started.runId`), and for whatever else ran in the turn
 *   (a steer) by the turn and the native chat, the way a hook-reported end is matched.
 * - A prompt whose echo carries no command id belongs to the run its turn names.
 * - A status naming another active turn than the last one says the turn before it is over. What the transcript
 *   recorded of that end is read and heard first, so a turn's own outcome settles its run before a newer turn
 *   can close it as unconfirmed. A CLI may announce its next turn before the rows that end the last one reach its
 *   file (Claude Code writes them in batches, its hooks at once), so while the log still holds that turn open it is
 *   read again for a moment.
 */

/** Rows of the serving log a subscriber starts from: the receipts and ends of what is still unsettled. */
const OPENING_ROWS = 2000;
/** Rows a snapshot after a send reads: only the newest can be its echo. */
const SNAPSHOT_ROWS = 200;
/** Turns whose run is remembered between batches. */
const TURN_RUNS = 64;
/** How long a status naming the next turn waits for the end of the one before it to be read, and how often it looks. */
const TURN_END_WAIT_MS = 2_000;
const TURN_END_POLL_MS = 50;

const outcomeType = { completed: 'run_completed', failed: 'run_failed', cancelled: 'run_cancelled', interrupted: 'run_cancelled' } as const;

export class DispatchFeed {
  constructor(private readonly deps: { service: NativeBackendService; feed: JournalFeed; store: Store }) {}

  /** The dispatcher's view of `service`: everything as it is, but the transcript read from the journal. */
  backend(): NativeDispatcherBackend {
    const { service } = this.deps;
    return {
      traits: backendId => service.traits(backendId),
      pending: backendId => service.backendPending(backendId),
      subscribe: (sessionId, listener) => this.subscribe(sessionId, listener),
      subscribeCorrections: listener => this.subscribeCorrections(listener),
      snapshot: async sessionId => this.snapshot(sessionId),
      reconcile: async sessionId => { await service.drainTranscript(sessionId); await this.deps.feed.delivered(); },
      canReleaseInput: (session, run) => service.canReleaseInput(session, run),
      status: sessionId => service.status(sessionId),
      sendRun: (session, run, fence, options) => service.sendRun(session, run, fence, options),
      supportsSteer: session => service.supportsSteer(session),
      steerRun: (session, run, fence) => service.steerRun(session, run, fence),
      supportsInitialPromptArgs: session => service.supportsInitialPromptArgs(session),
      supportsSendNow: session => service.supportsSendNow(session),
      commitDispatchFence: (runId, binding) => service.commitDispatchFence(runId, binding),
      requestInterrupt: sessionId => service.requestInterrupt(sessionId),
      interrupt: (session, options) => service.interrupt(typeof session === 'string' ? session : session.id, options),
    };
  }

  /** Corrections remain observable after an erroneous end released the live provider watch. */
  private subscribeCorrections(listener: (sessionId: string, message: DispatchObservation) => void): () => void {
    const { feed, store } = this.deps;
    let closed = false;
    const deliver = (batch: FeedBatch) => {
      if (closed) return;
      const events = this.events(batch, new Map());
      if (events.some(event => ['run_completed', 'run_failed', 'run_cancelled', 'native_turn_reopened'].includes(event.type)
        || event.type === 'user_message_chunk' && typeof event.data.commandId === 'string')) listener(batch.sessionId, { type: 'events', events });
    };
    const off = feed.subscribe((_id, lane) => lane === 'main', batch => {
      const turns = new Set<string>();
      if (batch.items.some(item => {
        if ('mark' in item) return item.mark.edge !== 'started';
        if (item.event.type === 'user_message_chunk' && typeof item.event.data.commandId === 'string') return true;
        const turnId = item.event.nativeTurnId;
        if (!turnId || turns.has(turnId)) return false;
        turns.add(turnId);
        return (feed.turnEnd(batch.sessionId, turnId)?.revision ?? 0) > 1;
      })) deliver(batch);
    });
    // A crash can commit the corrected journal row before updating its Run. Read only those
    // exact persisted bindings; this neither opens a provider connection nor fetches history.
    queueMicrotask(() => {
      if (closed) return;
      const turns = new Set<string>();
      for (const run of store.listProviderEndedNativeRuns()) {
        const native = run.native!;
        const session = store.getSession(run.sessionId);
        if (session.nativeSessionId !== native.nativeSessionId) continue;
        const key = JSON.stringify([run.sessionId, native.nativeTurnId]);
        if (turns.has(key)) continue;
        const mark = feed.turnEnd(run.sessionId, native.nativeTurnId!);
        if (!mark || mark.revision <= 1) continue;
        // The journal correction may already have reached the Run before the last shutdown.
        // Replaying its older retraction again would reset an already settled result's timings.
        const settled = mark.edge === 'ended' && (mark.status === 'completed'
          ? run.state === 'completed' && native.stage === 'completed'
          : mark.status === 'failed' ? run.state === 'failed' && native.stage === 'provider_failed'
          : run.state === 'interrupted' && native.stage === 'provider_cancelled');
        if (settled && run.error === mark.error) continue;
        turns.add(key);
        const recent = feed.recent(run.sessionId, 'main', OPENING_ROWS);
        deliver({ ...recent, items: [{ mark }, ...recent.items.filter(item => 'event' in item && item.event.nativeTurnId === mark.turnId)] });
      }
    });
    return () => { closed = true; off(); };
  }

  /** The conversation's receipts from now on, opening with the newest rows of its log and its status. */
  subscribe(sessionId: string, listener: (message: DispatchObservation) => void): () => void {
    const { service, feed } = this.deps;
    let closed = false;
    const deliver = (message: DispatchObservation) => { if (!closed) { try { listener(message); } catch { /* the dispatcher's own */ } } };
    const runs = new Map<string, string>();
    let turn: string | undefined;
    let statuses = Promise.resolve();
    // The provider watch is held for the dispatcher's sake, which also has the conversation read into the journal.
    const control = service.watchControl(sessionId, message => {
      if (message.type !== 'status') return;
      const next = message.status.activeTurn?.turnId;
      const moved = next !== undefined && next !== turn;
      const left = turn;
      if (next !== undefined) turn = next;
      statuses = statuses.then(async () => {
        if (moved) await this.readEnd(sessionId, left, () => closed);
        deliver(message);
      });
    });
    const offEvents = service.watchEvents(sessionId, event => deliver({ type: 'events', events: [event] }));
    const offFeed = feed.subscribe((id, lane) => id === sessionId && lane === 'main', batch => {
      const events = this.events(batch, runs);
      if (events.length) deliver({ type: 'events', events });
    });
    queueMicrotask(() => {
      if (closed) return;
      deliver({ type: 'events', events: this.events(feed.recent(sessionId, 'main', OPENING_ROWS), runs) });
      deliver({ type: 'status', status: control.status() });
    });
    return () => { closed = true; offFeed(); offEvents(); control.close(); };
  }

  /** Reads the transcript into the log until it holds the end of `turnId` (when it holds its start), or for a moment at most. */
  private async readEnd(sessionId: string, turnId: string | undefined, closed: () => boolean): Promise<void> {
    const { service, feed, store: { journal } } = this.deps;
    const deadline = Date.now() + TURN_END_WAIT_MS;
    for (;;) {
      await service.drainTranscript(sessionId);
      await feed.delivered();
      const { key } = servingKey(journal, sessionId, 'main');
      const open = turnId !== undefined && journal.locate(key, turnMetaId(turnId, 'started')) !== undefined && !hasTurnEnded(journal, key, turnId);
      if (!open || closed() || Date.now() >= deadline) return;
      await new Promise(resolve => setTimeout(resolve, TURN_END_POLL_MS));
    }
  }

  /** What `observe` reads of a snapshot: the newest rows of the log and the status, no provider read. */
  snapshot(sessionId: string): DispatchSnapshot {
    const session = this.deps.store.getSession(sessionId);
    const native = session.nativeSessionId;
    return {
      events: this.events(this.deps.feed.recent(sessionId, 'main', SNAPSHOT_ROWS), new Map()),
      status: this.deps.service.status(sessionId),
      ...(native ? { nativeSessionId: native } : {}),
    };
  }

  /** A batch as the dispatcher's events: rows as they are, a prompt given its run's command id, a turn's end as its runs' outcome. */
  private events(batch: FeedBatch, runs: Map<string, string>): NativeWorkbenchEvent[] {
    let session: Session | undefined;
    try { session = this.deps.store.getSession(batch.sessionId); } catch { return []; }
    const chat = session.nativeSessionId;
    const out: NativeWorkbenchEvent[] = [];
    // A feed chunk may carry the receipt while its correction lies in a later chunk. Read the
    // current authority first so that receipt cannot replay an already obsolete cached end.
    const turns = new Set(batch.items.map(item => 'mark' in item ? item.mark.turnId : item.event.nativeTurnId));
    for (const turnId of turns) {
      if (!turnId) continue;
      const mark = this.deps.feed.turnEnd(batch.sessionId, turnId);
      if (mark && mark.revision > 1) {
        const runId = runs.get(turnId) ?? this.startedRun(batch.sessionId, turnId);
        const reopened = this.deps.feed.turnReopened(batch.sessionId, turnId);
        if (reopened && reopened.revision < mark.revision) out.push(...this.outcome(batch.sessionId, reopened, runId, chat));
        out.push(...this.outcome(batch.sessionId, mark, runId, chat));
      }
    }
    // Each entity once, as it now stands: a receipt has to be the one match of its batch.
    const latest = new Set(latestEvents(batch.items));
    for (const item of batch.items) {
      if ('event' in item) {
        if (!latest.has(item.event)) continue;
        const event = item.event;
        const runId = event.type === 'user_message_chunk' && typeof event.data.commandId !== 'string' ? event.runId ?? (event.nativeTurnId ? runs.get(event.nativeTurnId) : undefined) : undefined;
        const commandId = runId ? this.commandOf(runId) : undefined;
        out.push(commandId ? { ...event, runId: runId!, data: { ...event.data, commandId } } : event);
        continue;
      }
      const mark = item.mark;
      if (mark.edge === 'started') {
        if (mark.runId) { runs.delete(mark.turnId); runs.set(mark.turnId, mark.runId); if (runs.size > TURN_RUNS) runs.delete(runs.keys().next().value!); }
        continue;
      }
      out.push(...this.outcome(batch.sessionId, mark, runs.get(mark.turnId) ?? this.startedRun(batch.sessionId, mark.turnId), chat));
    }
    return out;
  }

  private outcome(sessionId: string, mark: TurnMark, runId: string | undefined, chat: string | undefined): NativeWorkbenchEvent[] {
    const type = mark.edge === 'reopened' ? 'native_turn_reopened' : outcomeType[mark.status!];
    const detail = mark.error ? (type === 'run_failed' ? { error: mark.error } : type === 'run_cancelled' ? { reason: mark.error } : {}) : {};
    const base = { sequence: mark.seq, sessionId, type, nativeId: turnMetaId(mark.turnId, 'ended'), nativeTurnId: mark.turnId, createdAt: mark.at };
    const events: NativeWorkbenchEvent[] = [];
    const commandId = runId ? this.commandOf(runId) : undefined;
    const data = { ...(chat ? { nativeSessionId: chat } : {}), outcomeRevision: mark.revision, ...detail };
    if (commandId) events.push({ ...base, runId: runId!, data: { commandId, ...data } });
    if (chat) events.push({ ...base, data });
    return events;
  }

  /** The run a turn's start names, for a turn whose start came before this subscriber did. */
  private startedRun(sessionId: string, turnId: string): string | undefined {
    const { journal } = this.deps.store;
    const runId = (journal.entity(servingKey(journal, sessionId, 'main').key, turnMetaId(turnId, 'started'))?.payload as { runId?: unknown } | undefined)?.runId;
    return typeof runId === 'string' && runId ? runId : undefined;
  }

  private commandOf(runId: string): string | undefined {
    try { return this.deps.store.getRun(runId).commandId; } catch { return undefined; }
  }
}
