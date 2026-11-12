import type { NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';
import type { RolloutPlanSnapshot } from './rollout-plan.js';
import { rowTextKey } from './project-item.js';
import { isFinalTurnStatus, timestampOf, turnIdAt } from './transcript.js';
import { THREAD_MATERIALIZATION_GRACE_MS, ROUTINE_TURNS, TAIL_TURNS, TURN_CACHE_THREADS } from './runtime-limits.js';
import { isEmptyThreadRolloutError, isTurnsListUnsupportedError, isUnmaterializedThreadError } from './errors.js';
import type { RpcThread, RpcTurn } from './types.js';
import type { CodexAppServerClient } from '../shared/codex-app-server.js';
import type { CodexSubagents } from './subagents.js';
import { asArray, asRecord, str } from './util.js';

/**
 * The pure steps of reading a thread's history: which turns are unchanged, how a cached read is
 * extended, which rows a read keeps of what the runtime already holds. State stays in the runtime.
 */

/** Settled turns whose marker has not moved since the last published read. */
export function stableTurnIdsOf(turns: readonly RpcTurn[], markersNow: ReadonlyMap<string, string>, markersSeen: ReadonlyMap<string, string>): Set<string> {
  const stableTurns = new Set<string>();
  for (const turn of turns) if (isFinalTurnStatus(turn.status) && markersSeen.get(turn.id) === markersNow.get(turn.id)) stableTurns.add(turn.id);
  return stableTurns;
}

/** Puts a turn's plan row among its projected events; `projected` is changed in place. */
export function insertPlanEvent(projected: NativeWorkbenchEvent[], planEvent: NativeWorkbenchEvent, rolloutPlan: RolloutPlanSnapshot | undefined, turnId: string): void {
  // Restore relative order before the first numbering. An existing sequence always wins on
  // later reads: moving published events would invalidate history cursors and streamed rows.
  const callId = rolloutPlan?.turnId === turnId && planEvent.createdAt === rolloutPlan.timestamp ? rolloutPlan.callId : undefined;
  const anchor = callId ? projected.findLastIndex(event => {
    const item = asRecord(event.raw);
    return item?.id === callId || item?.callId === callId || item?.call_id === callId;
  }) : -1;
  // Some app-servers omit plan calls from history. This is a semantic fallback, not a claim
  // about timestamps (item createdAt is the turn's start, not its position within the turn).
  const answer = projected.findIndex(event => event.type === 'agent_message_chunk' && event.data.phase === 'final_answer');
  projected.splice(anchor >= 0 ? anchor + 1 : answer >= 0 ? answer : projected.length, 0, planEvent);
}

/** This read's events by id, with the resident rows that outrank or are missing from it. */
export function mergeResidentEvents(
  events: readonly NativeWorkbenchEvent[],
  resident: readonly NativeWorkbenchEvent[],
  superseded: ReadonlySet<string>,
  streaming: ReadonlySet<string>,
  liveCompletedIds: ReadonlySet<string>,
  committed: ReadonlySet<string>,
  eventsBeforeRead: ReadonlyMap<string, NativeWorkbenchEvent>,
): Map<string, NativeWorkbenchEvent> {
  const unique = new Map<string, NativeWorkbenchEvent>();
  for (const event of events) if (!unique.has(event.nativeId)) unique.set(event.nativeId, event);
  // A row whose item has since been returned under the id it keeps is that item's provisional
  // copy, and the settled one replaces it rather than joining it.
  for (const event of resident) {
    if (superseded.has(event.nativeId) || streaming.has(event.nativeId)) continue;
    // A notification received after this read began is newer than its frozen response. A live
    // completion also outranks partial in-progress history on subsequent polls; an explicitly
    // final record requested after that notification remains authoritative (including edits).
    const newerCompletion = liveCompletedIds.has(event.nativeId) &&
      (!committed.has(event.nativeId) || eventsBeforeRead.get(event.nativeId) !== event);
    if (newerCompletion || !unique.has(event.nativeId)) unique.set(event.nativeId, event);
  }
  return unique;
}

/**
 * The text rows these turns already show under the ids their items keep, by turn id.
 *
 * Rows a positional item added are left out: this is the settled side of the comparison, and a
 * copy standing in for a settled row must not pass for one.
 */
export function shownTextRowsOf(provisionalRows: ReadonlyMap<string, string[]>, residentEvents: readonly NativeWorkbenchEvent[], threadId: string, turnIds: readonly string[]): Map<string, Set<string>> {
  const provisional = new Set([...provisionalRows.values()].flat());
  const wanted = new Set(turnIds);
  const rows = new Map<string, Set<string>>();
  for (const event of residentEvents) {
    if (provisional.has(event.nativeId) || !event.nativeId.startsWith(`${threadId}:`)) continue;
    const turnId = event.nativeId.slice(threadId.length + 1).split(':')[0];
    if (!turnId || !wanted.has(turnId)) continue;
    const key = rowTextKey(event);
    if (!key) continue;
    const keys = rows.get(turnId) ?? new Set<string>();
    keys.add(key);
    rows.set(turnId, keys);
  }
  return rows;
}

/** The cached turns carried over a fresh tail page, or undefined when the page does not join them. */
export function extendCachedTurns(cachedTurns: readonly RpcTurn[], tail: readonly RpcTurn[]): RpcTurn[] | undefined {
  // The page must overlap the cached list, and everything it leaves to the cache must be final:
  // a turn still running there could have changed since it was read.
  const joint = tail.length ? cachedTurns.findIndex(turn => turn.id === tail[0]!.id) : -1;
  if (joint >= 0 && cachedTurns.slice(0, joint).every(turn => isFinalTurnStatus(turn.status))) {
    return [...cachedTurns.slice(0, joint), ...tail];
  }
  return undefined;
}

/** What a paged read returns once its pages are collected. */
export function settleTurnPages(turns: RpcTurn[], legacyRead: boolean, complete: boolean, maxTurns: number | undefined): { turns: RpcTurn[]; legacy: boolean; complete: boolean } {
  if (!legacyRead) turns.reverse();
  // The legacy read has no paging: it already holds the whole thread, so only its tail is worked on.
  if (legacyRead && maxTurns && turns.length > maxTurns) return { turns: turns.slice(-maxTurns), legacy: true, complete: false };
  return { turns, legacy: legacyRead, complete: complete || legacyRead };
}

/** Whether this runtime started the thread and has read no turn of it yet, within the grace after its first message. */
export function withinMaterializationGrace(materialization: { threadId: string; startedAt?: number } | undefined, threadId: string): boolean {
  if (materialization?.threadId !== threadId) return false;
  return materialization.startedAt === undefined || Date.now() - materialization.startedAt < THREAD_MATERIALIZATION_GRACE_MS;
}

/** Whether a failed paginated read is a child thread that has not flushed its live history yet. */
export function isFlushUnavailableMessage(error: unknown, threadId: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.match(/^failed to flush live thread history before paginated read: thread (.+) not found$/i)?.[1] === threadId;
}

/** The rollout's latest plan, tied to the turn it belongs to among `turns` when one can be found. */
export function planSnapshotForTurns(snapshot: RolloutPlanSnapshot, turns: readonly RpcTurn[]): RolloutPlanSnapshot {
  const matchingTurn = snapshot.turnId && turns.some(turn => turn.id === snapshot.turnId)
    ? snapshot.turnId
    : turnIdAt(timestampOf(snapshot.timestamp), turns);
  const { turnId: _loggedTurnId, ...plan } = snapshot;
  return matchingTurn ? { ...plan, turnId: matchingTurn } : plan;
}

/** The newest proposed plan of a turn among `events`. */
export function latestPlanTextOf(events: readonly NativeWorkbenchEvent[], prefix: string | undefined): string | undefined {
  const event = events.findLast(candidate => candidate.type === 'tool_call' && candidate.data.kind === 'plan' && (!prefix || candidate.nativeId.startsWith(prefix)));
  const content = asArray<Record<string, unknown>>(event?.data.content).find(part => part.type === 'markdown');
  return str(content?.text);
}

/** Only a confirmed new thread may start empty; the first input starts its bounded disk catch-up. */
export type CodexMaterialization = { threadId: string; startedAt?: number } | undefined;

/** What history reading asks of the runtime that owns the connection. */
export interface CodexHistoryReaderContext {
  requireTransport(): CodexAppServerClient;
  label(): string;
  subagents(): Pick<CodexSubagents, 'values' | 'owns'>;
  /** The command being dispatched, while one is in flight. */
  dispatchCommandId(): string | undefined;
  foregroundEndedTurnId(): string | undefined;
  /** Whether a window read only needs to cover what may have changed lately. */
  routineWindow(): boolean;
}

/** Reads a thread's turns over the app-server and tracks whether a new thread has materialized yet. */
export class CodexHistoryReader {
  materialization: CodexMaterialization;
  private readonly turnCache = new Map<string, { transport: CodexAppServerClient; turns: RpcTurn[] }>();
  private readonly childHistoryPendingSince = new Map<string, number>();

  constructor(private readonly host: CodexHistoryReaderContext) {}

  /** A newly created thread starts empty until its first turn is read. */
  startMaterialization(threadId: string): void {
    this.materialization = { threadId };
  }

  /** A page of the thread was read, so it is no longer pending as a child. */
  clearChildPending(threadId: string): void {
    this.childHistoryPendingSince.delete(threadId);
  }

  async readThread(threadId: string, includeTurns: boolean, materialization = this.materialization): Promise<RpcThread | undefined> {
    try {
      const response = await this.host.requireTransport().request<{ thread: RpcThread }>('thread/read', { threadId, includeTurns });
      return response.thread;
    } catch (error) {
      if (this.isHistoryPending(threadId, error, materialization) || isTurnsListUnsupportedError(error)) return undefined;
      throw error;
    }
  }

  async readLegacyTurns(threadId: string): Promise<RpcTurn[] | 'pending' | undefined> {
    const materialization = this.materialization;
    try {
      const response = await this.host.requireTransport().request<{ thread?: RpcThread }>('thread/read', { threadId, includeTurns: true });
      if (!response.thread) throw new Error(`${this.host.label()} app-server thread/read did not return a thread while loading legacy history.`);
      if (!Array.isArray(response.thread.turns)) throw new Error(`${this.host.label()} app-server thread/read returned invalid legacy turns.`);
      this.noteMaterialized(threadId, response.thread.turns);
      return response.thread.turns;
    } catch (error) {
      // Before its first user message a new thread answers every read after the first with "list_turns
      // is not supported yet" (codex-cli 0.166), the same pending state under the name of an old server.
      if (this.isHistoryPending(threadId, error, materialization) || (isTurnsListUnsupportedError(error) && this.isMaterializing(threadId, materialization))) {
        return this.isEmptyNewThread(threadId) ? [] : 'pending';
      }
      if (isTurnsListUnsupportedError(error)) return undefined;
      throw error;
    }
  }

  isHistoryPending(threadId: string, error: unknown, materialization: CodexMaterialization): boolean {
    if (!isUnmaterializedThreadError(error, threadId) && !isEmptyThreadRolloutError(error, threadId)) return false;
    // Classify against this request's starting evidence: a concurrent successful page may
    // have cleared the runtime's field before an older empty-rollout reply arrives.
    if (materialization?.threadId === threadId) return this.isMaterializing(threadId, materialization);
    const watch = [...this.host.subagents().values()].find(candidate => candidate.childId === threadId);
    if (!watch || watch.loaded || !watch.running) return false;
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(threadId)) return false;
    const since = this.childHistoryPendingSince.get(threadId) ?? Date.now();
    this.childHistoryPendingSince.set(threadId, since);
    return Date.now() - since < THREAD_MATERIALIZATION_GRACE_MS;
  }

  /** This runtime started the thread and has read no turn of it yet, within the grace after its first message. */
  isMaterializing(threadId: string, materialization: CodexMaterialization): boolean {
    return withinMaterializationGrace(materialization, threadId);
  }

  isChildFlushUnavailable(threadId: string, error: unknown): boolean {
    if (!this.host.subagents().owns(threadId)) return false;
    return isFlushUnavailableMessage(error, threadId);
  }

  isEmptyNewThread(threadId: string): boolean {
    return this.materialization?.threadId === threadId && this.materialization.startedAt === undefined && !this.host.dispatchCommandId();
  }

  beginMaterialization(): void {
    if (this.materialization && this.materialization.startedAt === undefined) this.materialization.startedAt = Date.now();
  }

  noteMaterialized(threadId: string, turns: readonly RpcTurn[]): void {
    if (turns.length && this.materialization?.threadId === threadId) this.materialization = undefined;
  }

  /**
   * Every turn of one thread, newest page first reversed into conversational order.
   *
   * Both the parent conversation and each subagent thread are read this way, so a child is exactly
   * as cheap to follow as the parent. `undefined` means the thread cannot be read yet: still being
   * materialized, or an app-server too old for `thread/turns/list` and for its legacy fallback.
   */
  async readTurns(threadId: string): Promise<RpcTurn[] | undefined> {
    const transport = this.host.requireTransport();
    const cached = this.turnCache.get(threadId);
    if (cached?.transport === transport) {
      // Any failure here is left to the complete read below, which knows how to report it.
      const page = await transport.request<{ data?: RpcTurn[]; nextCursor?: string | null }>('thread/turns/list', {
        threadId, limit: TAIL_TURNS, sortDirection: 'desc', itemsView: 'full',
      }).catch(() => undefined);
      const tail = Array.isArray(page?.data) ? [...page.data].reverse() : undefined;
      if (page && tail) {
        if (!page.nextCursor) return this.cacheTurns(threadId, transport, tail);
        const extended = extendCachedTurns(cached.turns, tail);
        if (extended) return this.cacheTurns(threadId, transport, extended);
      }
    }
    const read = await this.readAllTurns(threadId);
    // The legacy fallback has no paging to take a tail from, so its result is never reused.
    if (read && read !== 'pending' && !read.legacy) this.cacheTurns(threadId, transport, read.turns);
    else this.turnCache.delete(threadId);
    return read && read !== 'pending' ? read.turns : undefined;
  }

  private cacheTurns(threadId: string, transport: CodexAppServerClient, turns: RpcTurn[]): RpcTurn[] {
    this.turnCache.delete(threadId);
    this.turnCache.set(threadId, { transport, turns });
    while (this.turnCache.size > TURN_CACHE_THREADS) this.turnCache.delete(this.turnCache.keys().next().value!);
    return turns;
  }

  async readAllTurns(threadId: string, maxTurns?: number, throughTurnId?: string): Promise<{ turns: RpcTurn[]; legacy: boolean; complete: boolean } | 'pending' | undefined> {
    const turns: RpcTurn[] = [];
    let legacyRead = false;
    let complete = false;
    let cursor: string | undefined;
    for (let pageCount = 0; pageCount < 100; pageCount += 1) {
      const materialization = this.materialization;
      let response: { data?: RpcTurn[]; nextCursor?: string | null };
      const params = {
        threadId,
        ...(cursor ? { cursor } : {}),
        limit: maxTurns ? Math.min(100, maxTurns - turns.length) : 100,
        sortDirection: 'desc',
        itemsView: 'full',
      };
      try {
        response = await this.host.requireTransport().request<{ data?: RpcTurn[]; nextCursor?: string | null }>('thread/turns/list', params);
      } catch (error) {
        if (pageCount === 0 && this.isHistoryPending(threadId, error, materialization)) {
          return this.isEmptyNewThread(threadId) ? { turns: [], legacy: false, complete: true } : 'pending';
        }
        if (this.isChildFlushUnavailable(threadId, error)) {
          try {
            response = await this.host.requireTransport().request<{ data?: RpcTurn[]; nextCursor?: string | null }>('thread/turns/list', params);
          } catch (retryError) {
            // Retry the identical page even mid-read, but never translate an opaque cursor or
            // accept absent/empty legacy history as recovery of an unavailable live owner.
            if (!this.isChildFlushUnavailable(threadId, retryError) || cursor) throw retryError;
            const legacyTurns = await this.readLegacyTurns(threadId);
            if (!legacyTurns || legacyTurns === 'pending' || !legacyTurns.length) throw retryError;
            this.childHistoryPendingSince.delete(threadId);
            turns.push(...legacyTurns);
            legacyRead = true;
            break;
          }
        } else if (pageCount === 0 && isTurnsListUnsupportedError(error)) {
          const legacyTurns = await this.readLegacyTurns(threadId);
          if (!legacyTurns || legacyTurns === 'pending') return legacyTurns;
          this.childHistoryPendingSince.delete(threadId);
          turns.push(...legacyTurns);
          legacyRead = true;
          break;
        } else throw error;
      }
      if (!Array.isArray(response.data)) throw new Error(`${this.host.label()} app-server thread/turns/list returned invalid history data.`);
      this.noteMaterialized(threadId, response.data);
      this.childHistoryPendingSince.delete(threadId);
      turns.push(...response.data);
      if (!response.nextCursor) { complete = true; break; }
      // Recovery needs an ordered overlap with the observed end, not every old turn. Stop as
      // soon as that boundary is in the page; unrelated history stays outside routine polling.
      if (throughTurnId && response.data.some(turn => turn.id === throughTurnId)) break;
      // A bounded read stops once it has the newest `maxTurns`; the rest of the thread stays unread.
      if (maxTurns && turns.length >= maxTurns) break;
      if (response.nextCursor === cursor || pageCount === 99) {
        throw new Error(`${this.host.label()} app-server history paging did not reach the beginning of the thread.`);
      }
      cursor = response.nextCursor;
    }
    return settleTurnPages(turns, legacyRead, complete, maxTurns);
  }

  /**
   * The newest turns of the thread, in order. Once the journal holds the thread a read only needs to
   * cover what may have changed since (the last few turns); before that it takes a window large enough
   * to serve while the rest is imported. `complete` says the window reaches the thread's first turn.
   */
  async readThreadWindow(threadId: string): Promise<{ turns: RpcTurn[]; complete: boolean } | 'pending' | undefined> {
    // Read only for its own bookkeeping once the journal serves, a runtime keeps to the newest turns after its first read.
    let read = await this.readAllTurns(threadId, this.host.routineWindow() ? ROUTINE_TURNS : TAIL_TURNS);
    const ended = this.host.foregroundEndedTurnId();
    if (read && read !== 'pending' && !read.complete && ended && !read.turns.some(turn => turn.id === ended)) {
      // The foreground end may fall out of the three-turn tail while nobody receives starts.
      // Different ids alone cannot prove new work: hydrate back to the end and use provider
      // order. The caller's observation fence still rejects reads raced by a newer live end.
      read = await this.readAllTurns(threadId, undefined, ended);
    }
    return read && read !== 'pending' ? { turns: read.turns, complete: read.complete } : read;
  }
}
