import type { NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';
import { activityId } from '../../journal/activity.js';
import type { LaneWriter, TranscriptSource, TurnEndStatus } from '../../journal/ingest.js';
import { readCompaction } from './activities.js';
import { CHILD_DEPTH, CodexChildren, type Child } from './children.js';
import { isMissingThreadError } from './errors.js';
import type { ItemSpans } from './item-spans.js';
import { copiesOf, cursorThread, decode, encode, planEvent, reconcile, spawnedThread, turnTime, namedThreads, type LaneState } from './lane-state.js';
import { CodexLiveIntake } from './live-intake.js';
import { projectCodexItem } from './project-item.js';
import { CodexQuestionHistory } from './question-history.js';
import { isFinalTurnStatus, isProvisionalItemId, isSubagentStart, subagentToolCallId, turnStatus, type ItemSpan } from './transcript.js';
import type { CodexThreadReader, CodexTranscriptOptions, CodexTurnPage, CodexTurnsRequest } from './transcript-types.js';
import type { RpcItem, RpcTurn } from './types.js';
import { asArray, asRecord, str } from './util.js';

export { newTopicAfter, newTopicBoundary } from './lane-state.js';
export type { CodexLiveFeed, CodexThreadReader, CodexTranscriptOptions, CodexTurnPage, CodexTurnsRequest } from './transcript-types.js';

/*
 * A Codex / TRAE CLI thread as the session journal reads it (sync v3, journal/ingest.ts).
 *
 * The app-server is the only reader of a thread: its notifications while it is connected, and
 * `thread/turns/list` for what they cannot carry — a first import, a catch-up after nobody was
 * connected, and the settled copy of a turn that just ended. Every entity is named after its item's
 * own id (`project-item.ts`), so a re-read, a restart or the live feed write the same entity (G2).
 * The cursor is the v2 ingest state (`journal-space.ts`): the newest settled turn everything up to
 * which is in the log, and the turn still running; a read starts after the one and re-reads the
 * other, from wherever the service restarted (G7). Every turn the thread has — typed into an
 * attached `codex --remote` TUI as much as sent from the workbench — has its start and end (G3),
 * and a turn ends only once its settled copy has been read (G6). Subagent threads are read into the
 * lanes of the calls that spawned them (G9); compactions are activity states of the lane's ledger, and
 * so are the runtime's background terminals (G10). Only another thread starts the lane over (G8): the
 * same thread no longer holding the turn the log stopped at is one.
 */

/** Turns of a first read; a thread with more is served from this tail window while it is imported (G4). */
const TAIL_TURNS = 20;
/** Turns a routine read asks for first; it pages back further only until it finds where the log stopped. */
const ROUTINE_TURNS = 3;
/** How far a routine read looks back before the log is taken to trail the thread and is imported forward. */
const REPAIR_TURNS = 20;
/** Settled turns per page of an import, and pages per pull. */
const IMPORT_PAGE_TURNS = 3;
const IMPORT_PAGES = 4;
/** Turn headers per page, and pages, when a resumed import looks for the turn it stopped after. */
const LOCATE_PAGE = 100;
const LOCATE_PAGES = 1_000;
/** Events per commit; turn marks, activity states and child lanes are written between commits. */
const COMMIT_EVENTS = 200;
/** A write of turns gives the event loop back after about this long. */
const SLICE_MS = 20;
/** A finished subagent is looked at again this often, in case a follow-up woke it. */
const CHILD_IDLE_MS = 30_000;
/** While the live feed holds, the thread is read as a backstop this often. */
const BACKSTOP_MS = 10_000;
/** Streamed text wakes the reader at most this often. */
const DRAFT_WAKE_MS = 100;

export class CodexTranscriptSource implements TranscriptSource {
  /** The thread everything below is about; another one forgets it all. */
  private thread: string | undefined;
  private questions = new CodexQuestionHistory();
  /** The subagent threads and their lanes. */
  private readonly children: CodexChildren;
  /** What the live feed said since the last read: queued writes, streamed drafts, phases and turn states. */
  private readonly intake: CodexLiveIntake;
  /** Where an import continues, per lane: the turn it stopped after and the provider's page there. */
  private readonly imports = new Map<string, { settled?: string; cursor?: string; skip?: string }>();
  /** Turns whose end this source wrote: anything the live feed still says about them is in their settled copy. */
  private readonly ended = new Set<string>();
  private feeds = 0;
  /** The main lane's writer of the read in progress. */
  private main: LaneWriter | undefined;
  /** The thread has to be read: on the first pull, at a turn's end, when the feed lost something, and as a backstop. */
  private repairDue = true;

  constructor(private readonly options: CodexTranscriptOptions) {
    this.children = new CodexChildren({ main: () => this.main, thread: () => this.thread });
    this.intake = new CodexLiveIntake({
      sessionId: options.sessionId,
      turnEnded: turnId => this.ended.has(`${this.thread}:${turnId}`),
      settledTurn: () => decode(this.main?.cursor ?? null)?.settled,
      repairSoon: () => { this.repairDue = true; },
    });
  }
  /**
   * The conversation's first thread: a new topic goes on in another thread (`/new`) without starting the lane over,
   * whose rows of the earlier threads stay. Only a conversation that follows another thread altogether is a new identity.
   */
  identity(): string | undefined { return this.earlier()[0] ?? this.options.threadId(); }

  /** The threads before the current one, oldest first. */
  private earlier(): readonly string[] {
    const current = this.options.threadId();
    return (this.options.earlierThreads?.() ?? []).filter(id => id !== current);
  }

  async pull(w: LaneWriter, signal: AbortSignal): Promise<{ caughtUp: boolean }> {
    this.main = w;
    const threadId = this.follow();
    if (!threadId && !this.earlier().length) return { caughtUp: true };
    const reader = await this.options.reader();
    if (!reader || signal.aborted) return { caughtUp: false };
    // A new topic can have moved the conversation to another thread while the reader came up.
    const current = this.follow();
    if (current) this.seedQuestions(reader, current);
    const main = await this.readChain(w, reader, current, signal);
    const children = await this.readChildren(reader, signal);
    return { caughtUp: main && children && !signal.aborted };
  }

  watch(_w: LaneWriter, wake: () => void): () => void {
    let draftTimer: NodeJS.Timeout | undefined;
    const soon = () => {
      if (draftTimer) return;
      draftTimer = setTimeout(() => { draftTimer = undefined; wake(); }, DRAFT_WAKE_MS);
      draftTimer.unref();
    };
    const stop = this.options.observe?.({
      notification: (method, params) => { const how = this.note(method, params); if (how === 'now') wake(); else if (how === 'soon') soon(); },
      activity: activity => { this.intake.push({ kind: 'activity', activity }); wake(); },
      lost: () => {
        // A dead app-server sends no turn/completed; history alone decides the turns it was running.
        this.intake.forgetRunning();
        this.repairDue = true;
        wake();
      },
    });
    if (stop) this.feeds += 1;
    // The feed can miss a notification (a reconnect, a TUI turn on another socket); a read now and then catches it.
    const backstop = setInterval(() => { this.repairDue = true; wake(); }, BACKSTOP_MS);
    backstop.unref();
    return () => {
      clearInterval(backstop);
      if (draftTimer) clearTimeout(draftTimer);
      if (!stop) return;
      stop();
      this.feeds -= 1;
      this.repairDue = true;
    };
  }

  async drain(w: LaneWriter): Promise<void> {
    this.main = w;
    const threadId = this.follow();
    if (!threadId) return;
    const reader = await this.options.reader();
    if (!reader || this.follow() !== threadId) return;
    this.seedQuestions(reader, threadId);
    // A lane still in an earlier thread is brought to this one first; its cursor names a turn this thread lacks.
    if (this.behind(w, threadId)) { await this.readChain(w, reader, threadId, new AbortController().signal); return; }
    const serving = w.scratch ?? w;
    if (decode(serving.cursor)?.phase !== 'ready') return;
    await this.refresh(serving, reader, threadId, 0);
    this.flushLive(serving, threadId);
  }

  // ---- reading ---------------------------------------------------------------------------------

  /** The thread now followed; whatever was known about another one goes. */
  private follow(): string | undefined {
    const threadId = this.options.threadId();
    if (threadId !== this.thread) {
      this.thread = threadId;
      this.questions = new CodexQuestionHistory();
      this.children.clear();
      this.imports.clear();
      this.ended.clear();
      this.intake.reset();
      this.repairDue = true;
    }
    return threadId;
  }

  /** Whether the main lane was last written in a thread before `current`. */
  private behind(w: LaneWriter, current: string | undefined): boolean {
    const at = cursorThread(w.cursor);
    return at !== undefined && at !== current && this.earlier().includes(at);
  }

  /**
   * Brings the main lane to the thread the conversation follows now. Each earlier thread is read to its end in
   * turn, then the message that ended it, then the next: they are settled and do not change. A lane never read
   * imports them from the first, while a window serves the current thread's newest turns.
   */
  private async readChain(w: LaneWriter, reader: CodexThreadReader, current: string | undefined, signal: AbortSignal): Promise<boolean> {
    const earlier = this.earlier();
    if (!earlier.length) return current ? await this.readMain(w, reader, current, signal) : true;
    if (w.cursor === null && !w.scratch) return await this.firstChainRead(w, reader, earlier[0]!, current);
    for (let steps = 0; steps <= earlier.length && !signal.aborted; steps += 1) {
      // A cursor that names no thread of the conversation is read again from its first thread.
      const at = cursorThread(w.cursor) ?? earlier[0]!;
      if (at === current || !earlier.includes(at)) return current ? await this.readMain(w, reader, current, signal) : true;
      if (w.scratch) {
        const window = decode(w.scratch.cursor);
        this.children.restoreAgents(w.scratch, window, 0);
        if (current && this.repairNow() && window?.phase === 'ready') {
          if (!await this.refresh(w.scratch, reader, current, 0, true)) return false;
        }
        if (current && w.scratch) this.flushLive(w.scratch, current);
      }
      const state = decode(w.cursor) ?? { phase: 'importing' as const };
      this.children.restoreAgents(w, state, 0);
      let done: boolean;
      try {
        done = state.phase === 'importing'
          ? await this.importSteps(w, reader, at, state, 0, signal)
          : await this.refresh(w, reader, at, 0);
      } catch (error) {
        // A thread whose rollout is gone has nothing more to read.
        if (!isMissingThreadError(error, at)) throw error;
        done = true;
      }
      // The thread was rewritten and the lane started over, or it is not all read yet.
      if (!done || cursorThread(w.cursor) !== at) return false;
      const next = earlier[earlier.indexOf(at) + 1] ?? current;
      // The next thread is still being started.
      if (!next) return true;
      this.leaveThread(w, at, next);
    }
    return false;
  }

  /** A lane never read, of a conversation that has had earlier topics: a window onto the current thread, and an import from the first. */
  private async firstChainRead(w: LaneWriter, reader: CodexThreadReader, first: string, current: string | undefined): Promise<boolean> {
    this.repairDue = false;
    const page = current ? await this.readPage(reader, { threadId: current, limit: TAIL_TURNS, sortDirection: 'desc' }) : undefined;
    const turns = [...asArray<RpcTurn>(page?.data)].reverse();
    if (current && turns.length) await this.writeTurns(w.openScratch(), current, turns, { phase: 'ready' }, 0);
    w.commit({ events: [], cursor: encode(first, { phase: 'importing', turns: 0 }) });
    return false;
  }

  /**
   * The lane has read `threadId` to its end: the message that ended it follows, as a turn of its own that started
   * no model turn, and the lane goes on in `next`. A turn the thread left open never ends now, so it ends interrupted.
   */
  private leaveThread(w: LaneWriter, threadId: string, next: string): void {
    const state = decode(w.cursor);
    if (state?.open && w.turnEndStatus(state.open) === undefined) w.turnEnded(state.open, 'interrupted', new Date().toISOString());
    const topic = this.options.topicAfter?.(threadId);
    const turnId = `${threadId}:topic`;
    if (topic) w.turnStarted(turnId, topic.at, topic.runId);
    const events: NativeWorkbenchEvent[] = topic ? [{
      sequence: 0, sessionId: this.options.sessionId, runId: topic.runId, type: 'user_message_chunk',
      data: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: topic.text }, commandId: topic.commandId },
      createdAt: topic.at, nativeId: `${turnId}:web:${topic.commandId}:user`, nativeTurnId: turnId,
    }] : [];
    w.commit({ events, cursor: encode(next, { phase: 'ready', turns: state?.turns ?? 0 }) });
    if (topic) w.turnEnded(turnId, 'completed', topic.at);
    // Nothing of `next` is in the lane yet, whatever the live feed has carried.
    this.repairDue = true;
  }

  private async readMain(w: LaneWriter, reader: CodexThreadReader, threadId: string, signal: AbortSignal): Promise<boolean> {
    const state = decode(w.cursor);
    this.children.restoreAgents(w, state, 0);
    if (!state && !w.scratch) return await this.firstRead(w, reader, threadId);
    const scratch = w.scratch;
    if (scratch) {
      const window = decode(scratch.cursor);
      this.children.restoreAgents(scratch, window, 0);
      if (this.repairNow() && window?.phase === 'ready') {
        if (!await this.refresh(scratch, reader, threadId, 0, true)) return false;
      }
      if (w.scratch === scratch) this.flushLive(scratch, threadId);
    }
    if (!state || state.phase === 'importing') return await this.importSteps(w, reader, threadId, state, 0, signal);
    // Reconcile the boundary before consuming its live ops. A formerly poisoned cursor must not
    // discard those ops, or replay its old cancellation when the user receipt is recovered.
    const caughtUp = this.repairNow() ? await this.refresh(w, reader, threadId, 0) : true;
    this.flushLive(w, threadId);
    return caughtUp;
  }

  /** Reads are skipped only while the live feed carries the thread and nothing says it missed anything. */
  private repairNow(): boolean {
    const due = this.repairDue || this.feeds === 0;
    this.repairDue = false;
    return due;
  }

  /** A lane never read: the newest turns, and when the thread has more, they serve from a scratch window while the rest is imported. */
  private async firstRead(w: LaneWriter, reader: CodexThreadReader, threadId: string): Promise<boolean> {
    this.repairDue = false;
    const page = await this.readPage(reader, { threadId, limit: TAIL_TURNS, sortDirection: 'desc' });
    if (!page) {
      // Only a confirmed new thread can serve live rows before its first disk read. Completion,
      // connection loss and the backstop retry history without making every delta reread it.
      // caughtUp stops the import's tight loop; the runtime still reports history as loading.
      if (reader.hasEmptyHistoryBaseline?.(threadId)) {
        await this.writeTurns(w, threadId, [], { phase: 'ready' }, 0);
        this.flushLive(w, threadId);
      }
      return true;
    }
    const turns = [...asArray<RpcTurn>(page.data)].reverse();
    if (!page.nextCursor) {
      await this.writeTurns(w, threadId, turns, { phase: 'ready' }, 0);
      return true;
    }
    const scratch = w.openScratch();
    await this.writeTurns(scratch, threadId, turns, { phase: 'ready' }, 0);
    w.commit({ events: [], cursor: encode(threadId, { phase: 'importing', turns: 0 }) });
    return false;
  }

  /**
   * Brings a ready lane up to the thread: the turns after the settled one the cursor names, found by
   * paging back from the newest; a lane that trails further than a routine read looks is imported forward.
   */
  private async refresh(w: LaneWriter, reader: CodexThreadReader, threadId: string, depth: number, window = false): Promise<boolean> {
    let state = decode(w.cursor) ?? { phase: 'ready' as const };
    const collected: RpcTurn[] = [];
    let found = false, complete = false;
    for (let cursor: string | undefined, limit = ROUTINE_TURNS; ;) {
      const page = await this.readPage(reader, { threadId, ...(cursor ? { cursor } : {}), limit, sortDirection: 'desc' });
      if (!page) return true;
      const data = asArray<RpcTurn>(page.data);
      const at = state.settled ? data.findIndex(turn => turn.id === state.settled) : -1;
      if (at >= 0) {
        // A durable end is not revisited: completed, failed and cancelled ends are final history.
        const end = w.turnEndStatus(state.settled!);
        if (end !== undefined && end !== 'interrupted') {
          collected.push(...data.slice(0, at));
          found = true;
          break;
        }
        // An interrupted end may have been a provisional read before the turn's first item. Re-read
        // that boundary: a turn typed into a TUI has no live feed to correct the cursor for us.
        collected.push(...data.slice(0, at + 1));
        let previous: string | undefined = data[at + 1]?.id;
        if (!previous && page.nextCursor) {
          const older = await reader.turnsPage({ threadId, cursor: page.nextCursor, limit: 1, sortDirection: 'desc' });
          if (!older) return false;
          previous = older.data?.[0]?.id;
        }
        state = { ...state, turns: Math.max(0, (state.turns ?? 1) - 1) };
        if (previous) state.settled = previous; else delete state.settled;
        found = true;
        break;
      }
      collected.push(...data);
      if (!page.nextCursor || page.nextCursor === cursor) { complete = !page.nextCursor; break; }
      if (collected.length >= REPAIR_TURNS) break;
      cursor = page.nextCursor;
      limit = Math.min(LOCATE_PAGE, REPAIR_TURNS - collected.length);
    }
    const newer = collected.reverse();
    if (found || (complete && !state.settled)) {
      return Boolean(await this.writeTurns(w, threadId, newer, state, depth));
    }
    if (complete) {
      // An empty answer is a thread not readable yet (a resume still materializing), not one without the turn.
      if (!newer.length) return true;
      // The thread no longer has the turn the log stopped at: it is not the conversation the log holds.
      this.rewritten(w, depth);
      return false;
    }
    // A scratch window is only a tail: it takes the newest turns as they are. The lane itself is imported forward.
    if (window) {
      return Boolean(await this.writeTurns(w, threadId, newer, state, depth));
    }
    w.commit({ events: [], cursor: encode(threadId, { ...state, phase: 'importing' }) });
    return await this.importSteps(w, reader, threadId, { ...state, phase: 'importing' }, depth, new AbortController().signal);
  }

  /** The lane's thread was rewritten under the same id (a rollback): the lane starts over, and a main lane takes the session with it. */
  private rewritten(w: LaneWriter, depth: number): void {
    w.rebuild('identity-changed');
    if (depth > 0) { this.imports.delete(w.lane); return; }
    this.thread = undefined;
    this.follow();
  }

  /** Settled turns oldest first, a bounded step per pull; once it reaches the running turn the lane is ready and read as usual. */
  private async importSteps(w: LaneWriter, reader: CodexThreadReader, threadId: string, from: LaneState | undefined, depth: number, signal: AbortSignal): Promise<boolean> {
    let state: LaneState = { ...(from ?? {}), phase: 'importing' };
    let at = this.imports.get(w.lane);
    if (!at || at.settled !== state.settled) {
      at = { ...(state.settled ? { settled: state.settled, skip: state.settled } : {}) };
      if (state.settled) {
        const located = await this.locate(reader, threadId, state.settled);
        if (located === null) return false;
        if (!located) {
          // The turn the import stopped after is gone: the thread was rewritten.
          this.rewritten(w, depth);
          return false;
        }
        if (located.cursor) at.cursor = located.cursor;
      }
    }
    for (let pages = 0; pages < IMPORT_PAGES && !signal.aborted; pages += 1) {
      const page = await this.readPage(reader, { threadId, ...(at.cursor ? { cursor: at.cursor } : {}), limit: IMPORT_PAGE_TURNS, sortDirection: 'asc' });
      // The conversation's import waits for its thread; a subagent's thread that cannot be read has nothing to import.
      if (!page) return depth > 0;
      let turns = asArray<RpcTurn>(page.data);
      if (at.skip) {
        const index = turns.findIndex(turn => turn.id === at!.skip);
        if (index >= 0) { turns = turns.slice(index + 1); delete at.skip; } else turns = [];
      }
      const open = turns.findIndex(turn => !isFinalTurnStatus(turn.status));
      const nextState = await this.writeTurns(w, threadId, open < 0 ? turns : turns.slice(0, open), state, depth);
      if (!nextState) return false;
      state = nextState;
      if (open >= 0 || !page.nextCursor) {
        // The settled history is in: the running turn and whatever follows are read the way a ready lane is.
        this.imports.delete(w.lane);
        w.commit({ events: [], cursor: encode(threadId, { ...state, phase: 'ready' }) });
        return await this.refresh(w, reader, threadId, depth);
      }
      at = { ...(state.settled ? { settled: state.settled } : {}), cursor: page.nextCursor };
      this.imports.set(w.lane, at);
    }
    return false;
  }

  /** The ascending page holding `turnId`, by turn headers only; undefined when the thread has no such turn, null when it cannot be read. */
  private async locate(reader: CodexThreadReader, threadId: string, turnId: string): Promise<{ cursor?: string } | undefined | null> {
    let cursor: string | undefined;
    for (let pages = 0; pages < LOCATE_PAGES; pages += 1) {
      const request = { threadId, ...(cursor ? { cursor } : {}), limit: LOCATE_PAGE, sortDirection: 'asc' as const };
      const page = await reader.turnsPage({ ...request, itemsView: 'notLoaded' }).catch(() => reader.turnsPage({ ...request, itemsView: 'summary' }));
      if (!page || (!pages && !asArray<RpcTurn>(page.data).length)) return null;
      if (asArray<RpcTurn>(page.data).some(turn => turn.id === turnId)) return cursor ? { cursor } : {};
      if (!page.nextCursor || page.nextCursor === cursor) return undefined;
      cursor = page.nextCursor;
    }
    return undefined;
  }

  // ---- writing ---------------------------------------------------------------------------------

  /** Replays only question identities/metadata; each source keeps its own answer and run state. */
  private seedQuestions(reader: CodexThreadReader, threadId: string): void {
    for (const item of reader.questionRequests?.(threadId) ?? []) {
      this.questions.request({ itemId: item.id, questions: asRecord(item.arguments)?.questions }, threadId);
    }
  }

  /** A running owner outranks a provisional interrupted history read, including after reattach. */
  private async readPage(reader: CodexThreadReader, request: CodexTurnsRequest): Promise<CodexTurnPage | undefined> {
    const page = await reader.turnsPage(request);
    // Requests can arrive during the awaited page read. Seed before any main or child item is
    // projected; a reader started after the request cannot rely only on the live feed.
    this.seedQuestions(reader, request.threadId);
    if (!page) return undefined;
    return { ...page, data: asArray<RpcTurn>(page.data).map(turn => {
      const live = request.threadId === this.thread ? this.intake.turnState(turn.id) : undefined;
      const running = live === 'inProgress' || live === undefined && reader.isTurnRunning?.(request.threadId, turn);
      const status = turnStatus(turn.status);
      if (live && live !== 'inProgress' && status !== live) {
        // Completion can precede the history flush. Keep polling for its matching settled copy;
        // a stale interrupted snapshot must not replace the result received on this connection.
        this.repairDue = true;
        return { ...turn, status: live === 'interrupted' ? live : 'inProgress', completedAt: undefined };
      }
      return status === 'interrupted' && running ? { ...turn, status: 'inProgress', completedAt: undefined } : turn;
    }) };
  }

  /**
   * Writes `turns` in order and moves the cursor past the settled ones; returns the state it stored,
   * or `undefined` when an out-of-order late materialization required rebuilding the lane. It gives
   * the event loop back every {@link SLICE_MS} between commits: one running turn can hold thousands of items.
   */
  private async writeTurns(w: LaneWriter, threadId: string, turns: readonly RpcTurn[], from: LaneState, depth: number): Promise<LaneState | undefined> {
    const state: LaneState = { ...from };
    let { settled } = from;
    // An unresolved positional snapshot can precede this import page. Do not advance the
    // durable boundary past it until a later refresh actually rereads its lasting copy.
    let open = from.open && !turns.some(turn => turn.id === from.open) ? from.open : undefined;
    let count = from.turns ?? 0;
    const spans = await this.options.itemSpans?.(threadId);
    let since = performance.now();
    const pause = async () => {
      if (performance.now() - since < SLICE_MS) return;
      await new Promise(resolve => setImmediate(resolve));
      since = performance.now();
    };
    const lastPersisted = w.cursor === null ? -1 : this.lastPersistedTurnIndex(w, threadId, turns, depth, spans);
    for (const [turnIndex, turn] of turns.entries()) {
      const outcome = await this.writeTurn(w, threadId, turn, turnIndex < lastPersisted, state, depth, pause, spans);
      if (outcome === 'rebuilt') return undefined;
      if (outcome && open === undefined) { settled = turn.id; count += 1; } else open ??= turn.id;
    }
    Object.assign(state, { ...(settled ? { settled } : {}), turns: count, agents: this.children.agentsOf(w) });
    if (open) state.open = open; else delete state.open;
    w.commit({ events: [], cursor: encode(threadId, state) });
    return state;
  }

  /** Highest index in `turns` that already has a persisted row or turn end in `w`, or `-1`. */
  private lastPersistedTurnIndex(w: LaneWriter, threadId: string, turns: readonly RpcTurn[], depth: number, spans?: ItemSpans): number {
    const main = depth === 0;
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index]!;
      if (w.turnEndStatus(turn.id) !== undefined) return index;
      const items = asArray<RpcItem>(turn.items);
      const at = turnTime(turn.startedAt) ?? new Date().toISOString();
      for (const item of items) {
        if (item.type === 'contextCompaction') continue;
        const cmd = main && item.type === 'userMessage' ? this.options.commandOf(item, turn.id) : undefined;
        const run = cmd ? this.options.runOf(cmd) : undefined;
        for (const ev of this.project(item, turn, threadId, cmd, run, at, main, spans?.(item))) {
          if (w.eventOrder ? w.eventOrder(ev.nativeId) !== undefined : Boolean(w.event(ev.nativeId))) return index;
        }
      }
    }
    return -1;
  }

  private async writeTurn(w: LaneWriter, threadId: string, turn: RpcTurn, hasLaterPersisted: boolean, state: LaneState, depth: number, pause: () => Promise<void>, spans?: ItemSpans): Promise<boolean | 'rebuilt'> {
    const items = asArray<RpcItem>(turn.items);
    const final = isFinalTurnStatus(turn.status);
    const previous = w.turnEndStatus(turn.id);
    const status = turnStatus(turn.status);
    // A completed/failed history result is durable; a stale running snapshot cannot reopen it.
    // Interrupted is different: Codex can synthesize it while the turn is still materializing.
    if (previous && previous !== 'interrupted' && previous !== status) return true;
    const main = depth === 0;
    // A subagent's items carry no workbench commands; the conversation's carry the runs that sent them.
    const commands = items.map(item => main && item.type === 'userMessage' ? this.options.commandOf(item, turn.id) : undefined);
    const owner = commands.find((id): id is string => Boolean(id));
    const turnRun = owner ? this.options.runOf(owner) : undefined;
    const at = turnTime(turn.startedAt) ?? new Date().toISOString();
    const key = `${threadId}:${turn.id}`;
    const projected: NativeWorkbenchEvent[][] = [];
    for (const [index, item] of items.entries()) {
      projected.push(item.type === 'contextCompaction' ? [] : this.project(item, turn, threadId, commands[index], turnRun, at, main, spans?.(item)));
      await pause();
    }
    // TRAE CLI serves a running turn under positional ids it renames once written: a positional copy of
    // text the turn shows under a lasting id is the same row, and the settled read retires the copies.
    const copies = copiesOf(state, turn.id);
    const reconciled = items.map((item, index) =>
      item.type === 'contextCompaction' ? { events: [] as NativeWorkbenchEvent[], retire: [] as string[] } : reconcile(copies, subagentToolCallId(item), projected[index]!),
    );
    const renamed = final && items.every(item => !isProvisionalItemId(subagentToolCallId(item)));
    const allRetired = new Set<string>(reconciled.flatMap(rows => rows.retire));
    if (renamed) for (const [id] of copies.positional) allRetired.add(id);
    // Journal pins each entity's sort order to its rev=1 seq. Rebuild only when a new row would
    // jump across turns or invert sequential (non-tool) content, or a renamed provisional item
    // lands ahead of already-committed rows. Tool updates merge onto their tool_call without
    // allocating a row, and concurrent or long-running tool_calls legitimately complete out of
    // start order relative to other tools and intermediate messages.
    const hasRetired = allRetired.size > 0;
    let hasNewRow = false;
    let seenNewNonTool = false;
    let seenNewTool = false;
    let lastNonToolOrder = -1;
    for (const rows of reconciled) {
      for (const ev of rows.events) {
        if (allRetired.has(ev.nativeId) || ev.type === 'tool_call_update') continue;
        const order = w.eventOrder ? w.eventOrder(ev.nativeId) : (w.event(ev.nativeId) ? 0 : undefined);
        const isTool = ev.type === 'tool_call';
        if (order === undefined) {
          hasNewRow = true;
          if (isTool) seenNewTool = true; else seenNewNonTool = true;
          continue;
        }
        if (isTool) {
          if (hasRetired && (seenNewNonTool || seenNewTool || order < lastNonToolOrder)) { this.rewritten(w, depth); return 'rebuilt'; }
        } else {
          if (seenNewNonTool || seenNewTool || order < lastNonToolOrder) { this.rewritten(w, depth); return 'rebuilt'; }
          lastNonToolOrder = order;
        }
      }
    }
    if (hasNewRow && hasLaterPersisted) {
      this.rewritten(w, depth);
      return 'rebuilt';
    }
    if (previous === 'interrupted' && status !== 'interrupted') {
      const recovery = decode(w.cursor) ?? { phase: 'ready' as const };
      w.turnReopened(turn.id, new Date().toISOString(), encode(threadId, { ...recovery, open: turn.id }));
      this.ended.delete(`${threadId}:${turn.id}`);
    }
    w.turnStarted(turn.id, at, turnRun);
    let events: NativeWorkbenchEvent[] = [];
    let retire: string[] = [];
    const flush = () => {
      // A positional row and its lasting copy can both arrive before this batch is committed.
      // Retirement only finds persisted rows, so do not insert aliases retired by this batch.
      if (events.length || retire.length) w.commit({ events: events.filter(event => !retire.includes(event.nativeId!)), retire, cursor: encode(threadId, state) });
      events = []; retire = [];
    };
    for (const [index, item] of items.entries()) {
      if (item.type === 'contextCompaction') {
        if (main && str(item.id)) { flush(); this.compaction(w, item, turn, final); }
        continue;
      }
      const rows = reconciled[index]!;
      events.push(...rows.events);
      retire.push(...rows.retire);
      this.children.noteChildren(w, item, depth, flush);
      if (events.length >= COMMIT_EVENTS) { flush(); await pause(); }
    }
    flush();
    if (!final) return false;
    // The settled copy names every item by the id it keeps: the positional rows were stand-ins for them.
    const replaced = renamed ? copies.positional.map(([id]) => id) : [];
    if (renamed) state.copies = state.copies?.filter(copy => copy !== copies);
    w.commit({ events: [], retire: replaced, cursor: encode(threadId, state) });
    // A final status does not yet make a positional snapshot durable. More lasting items can
    // arrive with the next read, so keep the turn open until they precede its end mark.
    if (!renamed) return false;
    this.intake.dropDrafts(turn.id);
    w.turnEnded(turn.id, status as TurnEndStatus, turnTime(turn.completedAt) ?? at, status === 'failed' && main ? this.options.turnError?.(turn) : undefined);
    this.ended.add(key);
    return true;
  }


  private project(item: RpcItem, turn: RpcTurn, threadId: string, commandId: string | undefined, turnRun: string | undefined, createdAt: string, main: boolean, span?: ItemSpan): NativeWorkbenchEvent[] {
    const childThread = spawnedThread(item);
    const child = childThread ? this.children.get(childThread) : undefined;
    // A TRAE spawn and its activity are two announcements of one call. Keep the richer spawn
    // item, or the standalone activity when no collaboration call is available yet.
    if (isSubagentStart(item) && (child || asArray<RpcItem>(turn.items).some(other => other.type === 'collabAgentToolCall' && spawnedThread(other) === childThread))) return [];
    if (child && !isProvisionalItemId(subagentToolCallId(item)) && item.id !== child.toolCallId) item = { ...item, id: child.toolCallId };
    const runId = (commandId ? this.options.runOf(commandId) : undefined) ?? turnRun ?? turn.id;
    return projectCodexItem(item, turn, {
      sessionId: this.options.sessionId, threadId, runId, createdAt, ...(span ? { span } : {}), ...(commandId ? { commandId } : {}), questions: this.questions,
      ...(this.options.observedChanges ? { observedChanges: this.options.observedChanges } : {}),
      ...(main ? { phase: (itemId: string) => this.intake.phaseOf(itemId) } : {}),
    });
  }

  /** A compaction the thread shows, in the lane's ledger: as the live feed reported it when it did, else as the turn implies (G10). */
  private compaction(w: LaneWriter, item: RpcItem, turn: RpcTurn, settled: boolean): void {
    const id = activityId(this.options.backend, `compaction:${item.id}`);
    w.activities.apply(readCompaction(this.options.backend, item, turn, settled, undefined, w.activities.get(id)));
  }


  private async readChildren(reader: CodexThreadReader, signal: AbortSignal): Promise<boolean> {
    let caughtUp = true;
    const owners = new Map<string, Child['owner']>();
    const read = new Set<Child>();
    // A child read can spawn grandchildren: they are read in the same pull, a level per pass.
    for (let pass = 0; pass <= CHILD_DEPTH; pass += 1) {
      const pending = this.children.values().filter(child => !read.has(child));
      if (!pending.length) break;
      for (const child of pending) {
        read.add(child);
        caughtUp = await this.readChild(child, reader, signal) && caughtUp;
        // A previous retirement may have kept the duplicate until this read copied its contents.
        if (!child.toolCallId.startsWith('subagent-activity:')) this.children.writerOf(child.owner)?.retireSubagent(`subagent-activity:${child.toolCallId}`, child.toolCallId);
        owners.set(`${child.owner.lane}:${child.owner.scratch}`, child.owner);
      }
    }
    // Which subagents still run is part of where the spawning lane's next read starts.
    for (const where of owners.values()) {
      const owner = this.children.writerOf(where);
      if (!owner) continue;
      const state = decode(owner.cursor);
      const threadId = this.children.threadOf(owner);
      if (!state || !threadId) continue;
      const next = encode(threadId, { ...state, agents: this.children.agentsOf(owner) });
      if (next !== owner.cursor) owner.commit({ events: [], cursor: next });
    }
    return caughtUp && !signal.aborted;
  }

  /** A running child on every pull; a finished one when its parent names it again, or now and then. */
  private async readChild(child: Child, reader: CodexThreadReader, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    const state = decode(child.writer.cursor);
    this.children.restoreAgents(child.writer, state, child.depth);
    const running = !state || state.phase === 'importing' || Boolean(state.open);
    if (!child.due && !running && Date.now() - child.readAt < CHILD_IDLE_MS) return true;
    child.due = false;
    child.readAt = Date.now();
    return !state || state.phase === 'importing'
      ? await this.importSteps(child.writer, reader, child.threadId, state, child.depth, signal)
      : await this.refresh(child.writer, reader, child.threadId, child.depth);
  }


  // ---- live feed -------------------------------------------------------------------------------

  /** Takes one notification in; says whether the reader should wake now, soon (streamed text), or not at all. */
  private note(method: string, params: Record<string, unknown>): 'now' | 'soon' | undefined {
    this.follow();
    if (method !== 'item/tool/requestUserInput') return this.intake.note(method, params);
    const threadId = str(params.threadId) ?? this.thread;
    if (threadId) {
      this.questions.request(params, threadId);
      this.children.markDue(threadId);
    }
    return 'now';
  }

  /** Writes what the live feed said since the last read into `w`, which serves; a lane being imported reads it from the thread instead. */
  private flushLive(w: LaneWriter, threadId: string): void {
    // The live feed is of the thread followed now; a read of a thread it has since left must not write it.
    if (!this.intake.queued || threadId !== this.thread) return;
    const ops = this.intake.take();
    const state = decode(w.cursor);
    if (state?.phase !== 'ready') { this.intake.clearDrafts(); this.repairDue = true; return; }
    let open = state.open;
    let batch: { events: NativeWorkbenchEvent[]; drafts: Array<{ finalId: string; event: NativeWorkbenchEvent }>; retire: string[] } = { events: [], drafts: [], retire: [] };
    const flush = () => {
      const cursor = encode(threadId, { ...state, ...(open ? { open } : {}), agents: this.children.agentsOf(w) });
      if (batch.events.length || batch.drafts.length || batch.retire.length || cursor !== w.cursor) w.commit({ ...batch, events: batch.events.filter(event => !batch.retire.includes(event.nativeId!)), cursor });
      batch = { events: [], drafts: [], retire: [] };
    };
    const runs = new Map<string, string>();
    for (const op of ops) {
      if (op.kind === 'activity') { flush(); w.activities.apply(op.activity); continue; }
      // A late committed item is still content of this turn. The journal de-duplicates it by id;
      // only provisional updates are discarded once the reconciled history really ended it.
      const ended = w.turnEndStatus(op.turnId) !== undefined;
      if (ended && (op.kind !== 'item' || !op.committed)) continue;
      // A turn the feed shows running is where a restarted read starts again.
      if (!ended) open ??= op.turnId;
      if (op.kind === 'turn') { flush(); w.turnStarted(op.turnId, op.at ?? new Date().toISOString()); continue; }
      if (op.kind === 'plan') {
        if (batch.drafts.length) flush();
        batch.events.push(planEvent(this.options.sessionId, threadId, op.turnId, op.entries, op.at, runs.get(op.turnId)));
        continue;
      }
      if (op.kind === 'draft') {
        const draft = this.intake.draftRow(threadId, op.itemId, runs.get(op.turnId));
        if (draft) {
          // Keep events and drafts in arrival order since commit() appends events before drafts.
          if (batch.events.length) flush();
          batch.drafts.push(draft);
        }
        continue;
      }
      const turn: RpcTurn = { id: op.turnId, ...(op.at ? { startedAt: Date.parse(op.at) / 1000 } : {}) };
      const commandId = op.item.type === 'userMessage' ? this.options.commandOf(op.item, op.turnId) : undefined;
      const run = commandId ? this.options.runOf(commandId) : undefined;
      if (run && !runs.has(op.turnId)) {
        runs.set(op.turnId, run);
        flush();
        w.turnStarted(op.turnId, op.at ?? new Date().toISOString(), run);
      }
      const copies = copiesOf(state, op.turnId);
      const rows = reconcile(copies, subagentToolCallId(op.item), this.project(op.item, turn, threadId, commandId, runs.get(op.turnId), op.at ?? new Date().toISOString(), true, op.span));
      if (batch.drafts.length && rows.events.length) flush();
      batch.events.push(...rows.events);
      batch.retire.push(...rows.retire);
      if (ended && !copies.positional.length) state.copies = state.copies?.filter(copy => copy !== copies);
      const spawned = spawnedThread(op.item);
      const toolCallId = subagentToolCallId(op.item);
      if (spawned && toolCallId && !isProvisionalItemId(toolCallId)) {
        this.children.noteChildren(w, op.item, 0, flush);
      } else for (const named of namedThreads(op.item)) this.children.markDue(named);
      if (batch.events.length >= COMMIT_EVENTS) flush();
    }
    flush();
  }

}
