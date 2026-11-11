import { createHash } from 'node:crypto';
import type { NativeActivity, NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';
import { activityId } from '../../journal/activity.js';
import type { SyncLane } from '../../../../../packages/contracts/src/sync.js';
import type { LaneWriter, SubagentBinding, TranscriptSource, TurnEndStatus } from '../../journal/ingest.js';
import { readCompaction } from './activities.js';
import { messagePhase } from './drafts.js';
import { notificationSpan, type ItemSpans } from './item-spans.js';
import type { CodexIngestState } from './journal-space.js';
import { projectCodexItem, rowTextKey } from './project-item.js';
import { CodexQuestionHistory } from './question-history.js';
import { normalizePlanEntries } from './rollout-plan.js';
import { codexPlanNativeId, isFinalTurnStatus, isProvisionalItemId, isSpawnAgentItem, isSubagentStart, subagentName, subagentToolCallId, turnStatus, type ItemSpan } from './transcript.js';
import type { RpcItem, RpcTurn } from './types.js';
import { asArray, asRecord, str, toIso } from './util.js';

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
/** Subagents within subagents followed; the app-server's own limit is far below. */
const CHILD_DEPTH = 8;
/** A finished subagent is looked at again this often, in case a follow-up woke it. */
const CHILD_IDLE_MS = 30_000;
/** While the live feed holds, the thread is read as a backstop this often. */
const BACKSTOP_MS = 10_000;
/** Streamed text wakes the reader at most this often. */
const DRAFT_WAKE_MS = 100;
/** Live notifications kept between reads; more than this and the next read takes them from the thread. */
const LIVE_LIMIT = 5_000;
/** Streamed answer phases remembered for items whose settled copy does not state one. */
const PHASES_KEPT = 1_000;

export interface CodexTurnPage { data?: RpcTurn[]; nextCursor?: string | null }

export interface CodexTurnsRequest {
  threadId: string;
  cursor?: string;
  limit: number;
  sortDirection: 'asc' | 'desc';
  /** `notLoaded` / `summary` leave the items out: a header scan. */
  itemsView?: 'full' | 'notLoaded' | 'summary';
}

/** `thread/turns/list` of the app-server the runtime is connected to. */
export interface CodexThreadReader {
  /** One page; undefined while the thread cannot be read yet (not materialized). */
  turnsPage(request: CodexTurnsRequest): Promise<CodexTurnPage | undefined>;
  /** This reader created the thread empty, before any nonempty history was read. */
  hasEmptyHistoryBaseline?(threadId: string): boolean;
  /** Metadata-only native question requests, including requests made before this reader attached. */
  questionRequests?(threadId: string): RpcItem[];
  /** Current execution evidence; a history read can temporarily call this turn interrupted. */
  isTurnRunning?(threadId: string, turn: RpcTurn): boolean;
}

/** What the connected runtime passes on between reads. */
export interface CodexLiveFeed {
  /** A notification of the conversation's own thread. */
  notification(method: string, params: Record<string, unknown>): void;
  /** A state of a compaction or background terminal, as the runtime's activity tracker settles it. */
  activity(activity: NativeActivity): void;
  /** Whether a reader follows the conversation now; absent means one does. */
  active?(): boolean;
  /** The app-server connection that reported turns went away: what it said was running is unproven. */
  lost?(): void;
}

export interface CodexTranscriptOptions {
  /** The workbench session the lanes belong to. */
  sessionId: string;
  /** The flavor's id, which prefixes its activity ids. */
  backend: string;
  /** The thread the conversation follows now. */
  threadId(): string | undefined;
  /** A reader of the thread when one is connected; undefined while offline. */
  reader(): Promise<CodexThreadReader | undefined>;
  /** The workbench command a user item answers, by the tag the flavor echoes. */
  commandOf(item: RpcItem, turnId: string): string | undefined;
  /** The run of a workbench command. */
  runOf(commandId: string): string | undefined;
  /** The runtime's live feed while it is connected; returns how to stop. */
  observe?(feed: CodexLiveFeed): () => void;
  /** When the thread's items happened (`item-spans.ts`); a thread's own rollout, the conversation's or a subagent's. Rows keep their turn's start without it. */
  itemSpans?(threadId: string): Promise<ItemSpans | undefined>;
  /** What the provider said of a failed turn, fit to show; its end mark carries it to whoever settles the run. */
  turnError?(turn: RpcTurn): string | undefined;
}

/** How far a lane has read its thread: the v2 ingest state, and the subagents still running. */
interface LaneState extends Omit<CodexIngestState, 'v' | 'threadId'> {
  /** `[toolCallId, threadId]` of subagents spawned in this lane whose own lane has a running turn. */
  agents?: Array<[string, string]>;
  /** TRAE's positional rows and lasting text identities, checkpointed with the rows they describe. */
  copies?: TurnCopies[];
}

interface TurnCopies {
  turnId: string;
  positional: Array<[nativeId: string, text?: string, lastingId?: string]>;
  shown: Array<[nativeId: string, text: string]>;
}

/** Keep text identities bounded even when the provider returns a large answer. */
function textDigest(event: NativeWorkbenchEvent): string | undefined {
  const text = rowTextKey(event);
  return text === undefined ? undefined : createHash('sha256').update(text).digest('base64');
}

function decode(cursor: string | null): LaneState | undefined {
  if (cursor === null) return undefined;
  try {
    const parsed = JSON.parse(cursor) as CodexIngestState & LaneState;
    if (parsed?.v === 1 && (parsed.phase === 'ready' || parsed.phase === 'importing')) {
      const { v: _v, threadId: _thread, ...state } = parsed;
      return state;
    }
  } catch { /* not one of ours */ }
  // A cursor this reader cannot place is read again from the start; what the log holds already writes nothing.
  return { phase: 'importing' };
}

function encode(threadId: string, state: LaneState): string {
  const { phase, settled, open, turns, agents, copies } = state;
  return JSON.stringify({
    v: 1, threadId, phase, ...(settled ? { settled } : {}), ...(open ? { open } : {}), turns: turns ?? 0, ...(agents?.length ? { agents } : {}), ...(copies?.length ? { copies } : {}),
  });
}

const turnTime = (seconds: unknown): string | undefined => typeof seconds === 'number' && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : undefined;

/** The thread a spawning item created. */
function spawnedThread(item: RpcItem): string | undefined {
  if (isSubagentStart(item)) return str(item.agentThreadId);
  if (item.type !== 'collabAgentToolCall' || !isSpawnAgentItem(item)) return undefined;
  return asArray<unknown>(item.receiverThreadIds).map(str).find(Boolean);
}

/** Threads a later collaboration call or child notice names: each may have run again. */
function namedThreads(item: RpcItem): string[] {
  if (item.type === 'subAgentActivity') return [str(item.agentThreadId)].filter((id): id is string => Boolean(id));
  if (item.type !== 'collabAgentToolCall') return [];
  return asArray<unknown>(item.receiverThreadIds).map(str).filter((id): id is string => Boolean(id));
}

/** A subagent thread and its lane; `owner` names the log that spawned it, resolved against the writers of the current read. */
interface Child { toolCallId: string; threadId: string; writer: LaneWriter; owner: { lane: SyncLane; scratch: boolean }; depth: number; readAt: number; due: boolean }

type LiveOp =
  | { kind: 'turn'; turnId: string; at?: string }
  | { kind: 'item'; turnId: string; item: RpcItem; committed: boolean; at?: string; span?: ItemSpan }
  | { kind: 'draft'; turnId: string; itemId: string }
  | { kind: 'plan'; turnId: string; entries: Array<Record<string, unknown>>; at: string }
  | { kind: 'activity'; activity: NativeActivity };

interface Draft { turnId: string; reasoning: boolean; text: string; phase?: 'commentary' | 'final_answer'; channel?: string; part?: number }

export class CodexTranscriptSource implements TranscriptSource {
  /** The thread everything below is about; another one forgets it all. */
  private thread: string | undefined;
  private questions = new CodexQuestionHistory();
  /** One observer per native thread, regardless of how many items announce its creation. */
  private readonly children = new Map<string, Child>();
  private readonly restoredBindings = new Set<string>();
  /** Where an import continues, per lane: the turn it stopped after and the provider's page there. */
  private readonly imports = new Map<string, { settled?: string; cursor?: string; skip?: string }>();
  /** Turns whose end this source wrote: anything the live feed still says about them is in their settled copy. */
  private readonly ended = new Set<string>();
  /** Ordered lifecycle notifications, independent of lagging history snapshots. Ephemeral. */
  private readonly liveTurns = new Map<string, string>();
  private live: LiveOp[] = [];
  private readonly drafts = new Map<string, Draft>();
  /** Phases streamed for answers, for a committed item that does not state its own. */
  private readonly phases = new Map<string, 'commentary' | 'final_answer'>();
  private feeds = 0;
  /** The main lane's writer of the read in progress. */
  private main: LaneWriter | undefined;
  /** The thread has to be read: on the first pull, at a turn's end, when the feed lost something, and as a backstop. */
  private repairDue = true;

  constructor(private readonly options: CodexTranscriptOptions) {}

  identity(): string | undefined { return this.options.threadId(); }

  async pull(w: LaneWriter, signal: AbortSignal): Promise<{ caughtUp: boolean }> {
    this.main = w;
    const threadId = this.follow();
    if (!threadId) return { caughtUp: true };
    const reader = await this.options.reader();
    if (!reader || signal.aborted) return { caughtUp: false };
    this.seedQuestions(reader, threadId);
    const main = await this.readMain(w, reader, threadId, signal);
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
      activity: activity => { this.push({ kind: 'activity', activity }); wake(); },
      lost: () => {
        // A dead app-server sends no turn/completed; history alone decides the turns it was running.
        for (const [turnId, status] of this.liveTurns) if (status === 'inProgress') this.liveTurns.delete(turnId);
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
    if (!reader) return;
    this.seedQuestions(reader, threadId);
    const serving = w.scratch ?? w;
    if (decode(serving.cursor)?.phase !== 'ready') return;
    await this.refresh(serving, reader, threadId, 0);
    this.flushLive(serving, threadId);
  }

  // ---- reading ---------------------------------------------------------------------------------

  /** The thread now followed; whatever was known about another one goes. */
  private follow(): string | undefined {
    const threadId = this.identity();
    if (threadId !== this.thread) {
      this.thread = threadId;
      this.questions = new CodexQuestionHistory();
      this.children.clear();
      this.restoredBindings.clear();
      this.imports.clear();
      this.ended.clear();
      this.liveTurns.clear();
      this.live = [];
      this.drafts.clear();
      this.phases.clear();
      this.repairDue = true;
    }
    return threadId;
  }

  private async readMain(w: LaneWriter, reader: CodexThreadReader, threadId: string, signal: AbortSignal): Promise<boolean> {
    const state = decode(w.cursor);
    this.restoreAgents(w, state, 0);
    if (!state && !w.scratch) return await this.firstRead(w, reader, threadId);
    const scratch = w.scratch;
    if (scratch) {
      const window = decode(scratch.cursor);
      this.restoreAgents(scratch, window, 0);
      if (this.repairNow() && window?.phase === 'ready') await this.refresh(scratch, reader, threadId, 0, true);
      this.flushLive(scratch, threadId);
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
      await this.writeTurns(w, threadId, newer, state, depth);
      return true;
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
      await this.writeTurns(w, threadId, newer, state, depth);
      return true;
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
      state = await this.writeTurns(w, threadId, open < 0 ? turns : turns.slice(0, open), state, depth);
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
      const live = request.threadId === this.thread ? this.liveTurns.get(turn.id) : undefined;
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
   * Writes `turns` in order and moves the cursor past the settled ones; returns the state it stored. It gives
   * the event loop back every {@link SLICE_MS} between commits: one running turn can hold thousands of items.
   */
  private async writeTurns(w: LaneWriter, threadId: string, turns: readonly RpcTurn[], from: LaneState, depth: number): Promise<LaneState> {
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
    for (const turn of turns) {
      const final = await this.writeTurn(w, threadId, turn, state, depth, pause, spans);
      if (final && open === undefined) { settled = turn.id; count += 1; } else open ??= turn.id;
    }
    Object.assign(state, { ...(settled ? { settled } : {}), turns: count, agents: this.agentsOf(w) });
    if (open) state.open = open; else delete state.open;
    w.commit({ events: [], cursor: encode(threadId, state) });
    return state;
  }

  private async writeTurn(w: LaneWriter, threadId: string, turn: RpcTurn, state: LaneState, depth: number, pause: () => Promise<void>, spans?: ItemSpans): Promise<boolean> {
    const items = asArray<RpcItem>(turn.items);
    const final = isFinalTurnStatus(turn.status);
    const previous = w.turnEndStatus(turn.id);
    const status = turnStatus(turn.status);
    // A completed/failed history result is durable; a stale running snapshot cannot reopen it.
    // Interrupted is different: Codex can synthesize it while the turn is still materializing.
    if (previous && previous !== 'interrupted' && previous !== status) return true;
    if (previous === 'interrupted' && status !== 'interrupted') {
      const recovery = decode(w.cursor) ?? { phase: 'ready' as const };
      w.turnReopened(turn.id, new Date().toISOString(), encode(threadId, { ...recovery, open: turn.id }));
      this.ended.delete(`${threadId}:${turn.id}`);
    }
    const main = depth === 0;
    // A subagent's items carry no workbench commands; the conversation's carry the runs that sent them.
    const commands = items.map(item => main && item.type === 'userMessage' ? this.options.commandOf(item, turn.id) : undefined);
    const owner = commands.find((id): id is string => Boolean(id));
    const turnRun = owner ? this.options.runOf(owner) : undefined;
    const at = turnTime(turn.startedAt) ?? new Date().toISOString();
    w.turnStarted(turn.id, at, turnRun);
    const key = `${threadId}:${turn.id}`;
    const projected: NativeWorkbenchEvent[][] = [];
    for (const [index, item] of items.entries()) {
      projected.push(item.type === 'contextCompaction' ? [] : this.project(item, turn, threadId, commands[index], turnRun, at, main, spans?.(item)));
      await pause();
    }
    // TRAE CLI serves a running turn under positional ids it renames once written: a positional copy of
    // text the turn shows under a lasting id is the same row, and the settled read retires the copies.
    const copies = this.copiesOf(state, turn.id);
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
      const rows = this.reconcile(copies, subagentToolCallId(item), projected[index]!);
      events.push(...rows.events);
      retire.push(...rows.retire);
      this.noteChildren(w, item, depth, flush);
      if (events.length >= COMMIT_EVENTS) { flush(); await pause(); }
    }
    flush();
    if (!final) return false;
    // The settled copy names every item by the id it keeps: the positional rows were stand-ins for them.
    const renamed = items.every(item => !isProvisionalItemId(subagentToolCallId(item)));
    const replaced = renamed ? copies.positional.map(([id]) => id) : [];
    if (renamed) state.copies = state.copies?.filter(copy => copy !== copies);
    w.commit({ events: [], retire: replaced, cursor: encode(threadId, state) });
    // A final status does not yet make a positional snapshot durable. More lasting items can
    // arrive with the next read, so keep the turn open until they precede its end mark.
    if (!renamed) return false;
    for (const [itemId, draft] of this.drafts) if (draft.turnId === turn.id) this.drafts.delete(itemId);
    w.turnEnded(turn.id, status as TurnEndStatus, turnTime(turn.completedAt) ?? at, status === 'failed' && main ? this.options.turnError?.(turn) : undefined);
    this.ended.add(key);
    return true;
  }

  private copiesOf(state: LaneState, turnId: string): TurnCopies {
    state.copies ??= [];
    let copies = state.copies.find(copy => copy.turnId === turnId);
    if (!copies) state.copies.push(copies = { turnId, positional: [], shown: [] });
    return copies;
  }

  /** Reconcile only positional aliases; two lasting messages may legitimately contain identical text. */
  private reconcile(copies: TurnCopies, itemId: string | undefined, rows: NativeWorkbenchEvent[]): { events: NativeWorkbenchEvent[]; retire: string[] } {
    const events: NativeWorkbenchEvent[] = [], retire: string[] = [];
    for (const event of rows) {
      const text = textDigest(event);
      if (isProvisionalItemId(itemId)) {
        // Tool text is not an identity: the same command can run twice in a turn. Wait for
        // its lasting id instead of showing an unmatchable copy beside live notifications.
        if (event.type === 'tool_call' || event.type === 'tool_call_update') { retire.push(event.nativeId); continue; }
        let entry = copies.positional.find(([id]) => id === event.nativeId);
        if (!entry) copies.positional.push(entry = [event.nativeId]);
        entry[1] = text;
        // Keep claimed aliases in the cursor: history and duplicate notifications must not claim
        // a second lasting row or spend the same lasting row on another identical message.
        if (!entry[2] && text) entry[2] = copies.shown.find(([id, shown]) => shown === text && !copies.positional.some(([, , lasting]) => lasting === id))?.[0];
        if (entry[2]) { retire.push(event.nativeId); continue; }
      } else if (text) {
        const shown = copies.shown.find(([id]) => id === event.nativeId);
        if (shown) shown[1] = text; else copies.shown.push([event.nativeId, text]);
        const positional = copies.positional.find(([, , lasting]) => lasting === event.nativeId)
          ?? copies.positional.find(([, previous, lasting]) => !lasting && previous === text);
        if (positional) { positional[2] = event.nativeId; retire.push(positional[0]); }
      }
      events.push(event);
    }
    return { events, retire };
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
      ...(main ? { phase: (itemId: string) => this.phases.get(itemId) } : {}),
    });
  }

  /** A compaction the thread shows, in the lane's ledger: as the live feed reported it when it did, else as the turn implies (G10). */
  private compaction(w: LaneWriter, item: RpcItem, turn: RpcTurn, settled: boolean): void {
    const id = activityId(this.options.backend, `compaction:${item.id}`);
    w.activities.apply(readCompaction(this.options.backend, item, turn, settled, undefined, w.activities.get(id)));
  }

  // ---- subagents -------------------------------------------------------------------------------

  /** A spawning item gets its lane (G9); a later call naming a known child has it read again. */
  private noteChildren(w: LaneWriter, item: RpcItem, depth: number, flush: () => void): void {
    const spawned = spawnedThread(item);
    const toolCallId = subagentToolCallId(item);
    if (spawned && toolCallId && !isProvisionalItemId(toolCallId) && depth < CHILD_DEPTH) {
      flush();
      const known = this.children.get(spawned);
      const info = item.type === 'collabAgentToolCall'
        ? { title: str(item.description) ?? str(item.prompt)?.split('\n')[0], model: str(item.model), subagentType: str(item.agentRole) }
        : known ? {} : { title: subagentName(item), model: str(item.model) };
      this.adopt(w, toolCallId, spawned, depth + 1, info);
    }
    for (const threadId of namedThreads(item)) {
      const child = this.children.get(threadId);
      if (child) child.due = true;
    }
  }

  private adopt(spawner: LaneWriter, toolCallId: string, threadId: string, depth: number, info: { title?: string; model?: string; subagentType?: string } = {}): Child {
    const known = this.children.get(threadId);
    toolCallId = known?.toolCallId ?? toolCallId;
    const writer = spawner.child(toolCallId, threadId, info);
    const owner = this.ownerOf(spawner);
    if (known && known.threadId === threadId) { known.writer = writer; known.owner = owner; known.due = true; return known; }
    const child: Child = { toolCallId, threadId, writer, owner, depth, readAt: 0, due: true };
    this.children.set(threadId, child);
    return child;
  }

  /** Durable bindings restore finished children too: a later follow-up can wake the same thread. */
  private restoreAgents(w: LaneWriter, state: LaneState | undefined, depth: number): void {
    if (depth >= CHILD_DEPTH) return;
    const owner = this.ownerOf(w);
    const key = `${owner.lane}:${owner.scratch}:${w.generation}`;
    if (!this.restoredBindings.has(key)) {
      const bindings = new Map<string, SubagentBinding[]>();
      for (const binding of w.subagents) {
        const group = bindings.get(binding.agentId) ?? [];
        group.push(binding);
        bindings.set(binding.agentId, group);
      }
      for (const [threadId, group] of bindings) {
        // Prefer the original spawn when upgrading an older log that stored both announcements.
        const primary = group.find(binding => !binding.toolCallId.startsWith('subagent-activity:')) ?? group[0]!;
        const known = this.children.has(threadId);
        const child = this.adopt(w, primary.toolCallId, threadId, depth + 1, primary);
        const stored = decode(child.writer.cursor);
        // A finished child's stored transcript is ready already. Restore its observer so a
        // follow-up can wake it, without rereading every finished thread on the first pull.
        if (!known && stored?.phase === 'ready' && !stored.open && !state?.agents?.some(([, id]) => id === threadId)) {
          child.due = false;
          child.readAt = Date.now();
        }
        for (const binding of group) if (binding.toolCallId !== child.toolCallId) w.retireSubagent(binding.toolCallId, child.toolCallId);
      }
      this.restoredBindings.add(key);
    }
    for (const [toolCallId, threadId] of state?.agents ?? []) if (!this.children.has(threadId)) this.adopt(w, toolCallId, threadId, depth + 1);
  }

  /** The subagents spawned in `w` that are still running: their lanes are read again after a restart. */
  private agentsOf(w: LaneWriter): Array<[string, string]> {
    const agents: Array<[string, string]> = [];
    for (const child of this.children.values()) {
      const owner = this.ownerOf(w);
      if (child.owner.lane !== owner.lane || child.owner.scratch !== owner.scratch) continue;
      const state = decode(child.writer.cursor);
      if (!state || state.phase === 'importing' || state.open) agents.push([child.toolCallId, child.threadId]);
    }
    return agents;
  }

  private async readChildren(reader: CodexThreadReader, signal: AbortSignal): Promise<boolean> {
    let caughtUp = true;
    const owners = new Map<string, Child['owner']>();
    const read = new Set<Child>();
    // A child read can spawn grandchildren: they are read in the same pull, a level per pass.
    for (let pass = 0; pass <= CHILD_DEPTH; pass += 1) {
      const pending = [...this.children.values()].filter(child => !read.has(child));
      if (!pending.length) break;
      for (const child of pending) {
        read.add(child);
        caughtUp = await this.readChild(child, reader, signal) && caughtUp;
        // A previous retirement may have kept the duplicate until this read copied its contents.
        if (!child.toolCallId.startsWith('subagent-activity:')) this.writerOf(child.owner)?.retireSubagent(`subagent-activity:${child.toolCallId}`, child.toolCallId);
        owners.set(`${child.owner.lane}:${child.owner.scratch}`, child.owner);
      }
    }
    // Which subagents still run is part of where the spawning lane's next read starts.
    for (const where of owners.values()) {
      const owner = this.writerOf(where);
      if (!owner) continue;
      const state = decode(owner.cursor);
      const threadId = this.threadOf(owner);
      if (!state || !threadId) continue;
      const next = encode(threadId, { ...state, agents: this.agentsOf(owner) });
      if (next !== owner.cursor) owner.commit({ events: [], cursor: next });
    }
    return caughtUp && !signal.aborted;
  }

  /** A running child on every pull; a finished one when its parent names it again, or now and then. */
  private async readChild(child: Child, reader: CodexThreadReader, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    const state = decode(child.writer.cursor);
    this.restoreAgents(child.writer, state, child.depth);
    const running = !state || state.phase === 'importing' || Boolean(state.open);
    if (!child.due && !running && Date.now() - child.readAt < CHILD_IDLE_MS) return true;
    child.due = false;
    child.readAt = Date.now();
    return !state || state.phase === 'importing'
      ? await this.importSteps(child.writer, reader, child.threadId, state, child.depth, signal)
      : await this.refresh(child.writer, reader, child.threadId, child.depth);
  }

  /** Which log `w` is: a lane's own, or main's scratch window. */
  private ownerOf(w: LaneWriter): Child['owner'] {
    return { lane: w.lane, scratch: w.lane === 'main' && this.main !== undefined && this.main !== w && this.main.scratch === w };
  }

  /** The writer of a log in the current read. */
  private writerOf(where: Child['owner']): LaneWriter | undefined {
    if (where.lane === 'main') return where.scratch ? this.main?.scratch : this.main;
    for (const child of this.children.values()) if (child.writer.lane === where.lane) return child.writer;
    return undefined;
  }

  /** The thread a lane reads: the conversation's for main and its window, the subagent's for a child lane. */
  private threadOf(w: LaneWriter): string | undefined {
    for (const child of this.children.values()) if (child.writer === w) return child.threadId;
    return this.thread;
  }

  // ---- live feed -------------------------------------------------------------------------------

  private push(op: LiveOp): void {
    if (this.live.length >= LIVE_LIMIT) {
      // More than a read can be bothered to replay: the thread has it all, and the next read takes it from there.
      this.live = [];
      this.drafts.clear();
      this.repairDue = true;
    }
    this.live.push(op);
    if (op.kind !== 'activity' && (op.turnId === decode(this.main?.cursor ?? null)?.settled || this.ended.has(`${this.thread}:${op.turnId}`))) this.repairDue = true;
  }

  /** Takes one notification in; says whether the reader should wake now, soon (streamed text), or not at all. */
  private note(method: string, params: Record<string, unknown>): 'now' | 'soon' | undefined {
    this.follow();
    if (method === 'item/tool/requestUserInput') {
      const threadId = str(params.threadId) ?? this.thread;
      if (threadId) {
        this.questions.request(params, threadId);
        const child = this.children.get(threadId);
        if (child) child.due = true;
      }
      return 'now';
    }
    const turnId = str(params.turnId);
    if (method === 'item/agentMessage/delta' || method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
      const itemId = str(params.itemId);
      const delta = params.delta;
      if (!turnId || !itemId || typeof delta !== 'string') return undefined;
      const reasoning = method !== 'item/agentMessage/delta';
      const channel = method === 'item/reasoning/summaryTextDelta' ? 'summary' : method === 'item/reasoning/textDelta' ? 'raw' : undefined;
      let draft = this.drafts.get(itemId);
      if (!draft) this.drafts.set(itemId, draft = { turnId, reasoning, text: '', ...(channel ? { channel } : {}) });
      // Raw reasoning and its summary are one thought; the draft follows the channel that streamed first.
      if (draft.channel !== channel) return undefined;
      const index = reasoning ? (channel === 'summary' ? params.summaryIndex : params.contentIndex) : undefined;
      const part = typeof index === 'number' && Number.isSafeInteger(index) ? index : undefined;
      if (part !== undefined && draft.part !== undefined && part !== draft.part && draft.text) draft.text += '\n\n';
      if (part !== undefined) draft.part = part;
      draft.text += delta;
      const phase = messagePhase(params.phase);
      if (phase) { draft.phase = phase; this.notePhase(itemId, phase); }
      const last = this.live.at(-1);
      if (!(last?.kind === 'draft' && last.itemId === itemId)) this.push({ kind: 'draft', turnId, itemId });
      return 'soon';
    }
    if (method === 'turn/started') {
      const turn = asRecord(params.turn);
      const id = str(turn?.id);
      if (!id) return undefined;
      // Duplicate starts delivered after a known live end do not restart an immutable turn id.
      if (!this.liveTurns.has(id)) this.liveTurns.set(id, 'inProgress');
      const at = turnTime(turn?.startedAt);
      this.push({ kind: 'turn', turnId: id, ...(at ? { at } : {}) });
      return 'now';
    }
    if (method === 'turn/completed') {
      const turn = asRecord(params.turn) as RpcTurn | undefined;
      if (turn?.id && isFinalTurnStatus(turn.status)) {
        this.liveTurns.set(turn.id, turnStatus(turn.status));
        if (this.liveTurns.size > PHASES_KEPT) this.liveTurns.delete(this.liveTurns.keys().next().value!);
      }
      // The settled copy of the turn is read before its end is written (G6).
      this.repairDue = true;
      return 'now';
    }
    if (method === 'turn/plan/updated') {
      const entries = normalizePlanEntries(params.plan);
      if (!turnId || !entries) return undefined;
      this.push({ kind: 'plan', turnId, entries, at: new Date().toISOString() });
      return 'now';
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = asRecord(params.item) as RpcItem | undefined;
      if (!item || !turnId) return undefined;
      const phase = item.type === 'agentMessage' ? messagePhase(item.phase) : undefined;
      if (phase && item.id) this.notePhase(item.id, phase);
      // A compaction's states reach the ledger from the runtime's tracker (`activity`), which also knows its tokens and summary.
      if (item.type === 'contextCompaction') return undefined;
      const at = toIso(Number(params.startedAtMs));
      const span = notificationSpan(method, params, item);
      this.push({ kind: 'item', turnId, item, committed: method === 'item/completed', ...(at ? { at } : {}), ...(span ? { span } : {}) });
      if (method === 'item/completed' && item.id) this.drafts.delete(item.id);
      return 'now';
    }
    return undefined;
  }

  private notePhase(itemId: string, phase: 'commentary' | 'final_answer'): void {
    this.phases.set(itemId, phase);
    if (this.phases.size > PHASES_KEPT) this.phases.delete(this.phases.keys().next().value!);
  }

  /** Writes what the live feed said since the last read into `w`, which serves; a lane being imported reads it from the thread instead. */
  private flushLive(w: LaneWriter, threadId: string): void {
    const ops = this.live;
    if (!ops.length) return;
    this.live = [];
    const state = decode(w.cursor);
    if (state?.phase !== 'ready') { this.drafts.clear(); this.repairDue = true; return; }
    let open = state.open;
    let batch: { events: NativeWorkbenchEvent[]; drafts: Array<{ finalId: string; event: NativeWorkbenchEvent }>; retire: string[] } = { events: [], drafts: [], retire: [] };
    const flush = () => {
      const cursor = encode(threadId, { ...state, ...(open ? { open } : {}), agents: this.agentsOf(w) });
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
      if (op.kind === 'plan') { batch.events.push(this.planEvent(threadId, op.turnId, op.entries, op.at, runs.get(op.turnId))); continue; }
      if (op.kind === 'draft') {
        const draft = this.drafts.get(op.itemId);
        if (draft) batch.drafts.push(this.draftEvent(threadId, op.itemId, draft, runs.get(op.turnId)));
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
      const copies = this.copiesOf(state, op.turnId);
      const rows = this.reconcile(copies, subagentToolCallId(op.item), this.project(op.item, turn, threadId, commandId, runs.get(op.turnId), op.at ?? new Date().toISOString(), true, op.span));
      batch.events.push(...rows.events);
      batch.retire.push(...rows.retire);
      if (ended && !copies.positional.length) state.copies = state.copies?.filter(copy => copy !== copies);
      const spawned = spawnedThread(op.item);
      const toolCallId = subagentToolCallId(op.item);
      if (spawned && toolCallId && !isProvisionalItemId(toolCallId)) {
        this.noteChildren(w, op.item, 0, flush);
      } else for (const named of namedThreads(op.item)) {
        const child = this.children.get(named);
        if (child) child.due = true;
      }
      if (batch.events.length >= COMMIT_EVENTS) flush();
    }
    flush();
  }

  private draftEvent(threadId: string, itemId: string, draft: Draft, runId: string | undefined): { finalId: string; event: NativeWorkbenchEvent } {
    const kind = draft.reasoning ? 'thinking' : 'assistant';
    const type = draft.reasoning ? 'agent_thought_chunk' : 'agent_message_chunk';
    const finalId = `${threadId}:${draft.turnId}:${itemId}:${kind}`;
    // Deltas carry no phase; `item/started` named it, and the committed copy will say the same.
    const phase = draft.phase ?? this.phases.get(itemId);
    return {
      finalId,
      event: {
        sequence: 0, sessionId: this.options.sessionId, runId: runId ?? draft.turnId, type, nativeId: finalId, nativeTurnId: draft.turnId, createdAt: new Date().toISOString(),
        data: { sessionUpdate: type, ...(draft.reasoning ? { channel: draft.channel === 'summary' ? 'narration' : 'thinking' } : phase ? { phase } : {}), content: { type: 'text', text: draft.text } },
      },
    };
  }

  private planEvent(threadId: string, turnId: string, entries: Array<Record<string, unknown>>, at: string, runId: string | undefined): NativeWorkbenchEvent {
    return {
      sequence: 0, sessionId: this.options.sessionId, runId: runId ?? turnId, type: 'plan', nativeId: codexPlanNativeId(threadId, turnId), nativeTurnId: turnId,
      createdAt: at, data: { sessionUpdate: 'plan', entries },
    };
  }
}
