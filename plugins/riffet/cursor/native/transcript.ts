import { createHash, randomUUID } from 'node:crypto';
import type { NativeActivity, NativeContext, NativeWorkbenchEvent } from '@contracts';
import { activityEvent, activityId, AppError, clipDetail } from '@riffet/plugin-api/kit';
import { ChatReader, TranscriptMapper, userQuery, type ChatCompaction, type ChatMessage, type ChatMeta } from './chat-store.js';

const HISTORY_TURNS = 8;
const HISTORY_MESSAGE_LIMIT = 512;
/** What a followed chat store keeps decoded in memory, for its status, subagents and jobs. */
const TRANSCRIPT_EVENT_LIMIT = 8_000;
const TRANSCRIPT_BYTE_LIMIT = 4 * 1024 * 1024;
const NATIVE_EVENT_BYTE_LIMIT = 64 * 1024;

export function digestIds(ids: string[], count = ids.length): string {
  const hash = createHash('sha256');
  for (let index = 0; index < count; index += 1) hash.update(ids[index]!).update('\0');
  return hash.digest('hex');
}

function boundedValue(value: unknown, budget: { remaining: number; truncated: boolean }, depth = 0): unknown {
  if (depth > 8 || budget.remaining <= 0) { budget.truncated = true; return '[content truncated]'; }
  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value);
    if (bytes <= budget.remaining) { budget.remaining -= bytes; return value; }
    const suffix = '…[内容已截断]';
    const keep = Math.max(0, budget.remaining - Buffer.byteLength(suffix));
    let end = Math.min(value.length, keep);
    while (end > 0 && Buffer.byteLength(value.slice(0, end)) > keep) end -= 1;
    budget.remaining = 0;
    budget.truncated = true;
    return `${value.slice(0, end)}${suffix}`;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') { budget.remaining -= 16; return value; }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value) {
      if (budget.remaining < 32) { budget.truncated = true; break; }
      budget.remaining -= 4;
      result.push(item === undefined ? null : boundedValue(item, budget, depth + 1));
    }
    if (result.length < value.length) result.push('[content truncated]');
    return result;
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    // JSON drops an absent field; bounding must not turn it into the text "undefined".
    const entries = Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined);
    for (const [key, child] of entries) {
      const keyBytes = Buffer.byteLength(key) + 4;
      if (budget.remaining < keyBytes + 24) { budget.truncated = true; break; }
      budget.remaining -= keyBytes;
      result[key] = boundedValue(child, budget, depth + 1);
    }
    if (Object.keys(result).length < entries.length) result.payloadTruncated = true;
    return result;
  }
  return String(value);
}

function boundEvent(event: NativeWorkbenchEvent): NativeWorkbenchEvent {
  const budget = { remaining: NATIVE_EVENT_BYTE_LIMIT - 2048, truncated: false };
  let data = boundedValue(event.data, budget) as Record<string, unknown>;
  if (budget.truncated) data = { ...data, payloadTruncated: true };
  let bounded: NativeWorkbenchEvent = { ...event, data };
  if (Buffer.byteLength(JSON.stringify(bounded)) > NATIVE_EVENT_BYTE_LIMIT) {
    bounded = {
      ...event,
      data: {
        sessionUpdate: event.data.sessionUpdate,
        ...(event.data.toolCallId !== undefined ? { toolCallId: event.data.toolCallId } : {}),
        ...(event.data.toolName !== undefined ? { toolName: event.data.toolName } : {}),
        ...(event.data.kind !== undefined ? { kind: event.data.kind } : {}),
        ...(event.data.title !== undefined ? { title: String(event.data.title).slice(0, 500) } : {}),
        ...(event.data.status !== undefined ? { status: event.data.status } : {}),
        payloadTruncated: true,
      },
    };
  }
  return bounded;
}

/** Select a bounded range beginning at a user turn boundary where possible. */
export function selectHistoryStart(reader: ChatReader, ids: readonly string[], end: number, limits: { turns?: number; messages?: number } = {}): { start: number; contextIncomplete: boolean } {
  const steps = historyStartSteps(ids, end, limits);
  let step = steps.next();
  while (!step.done) step = steps.next(reader.message(step.value));
  return step.value;
}

/**
 * {@link selectHistoryStart} a message at a time, for a reader that lets the event loop turn between
 * reads: it yields the id of each message it needs, newest first, and is sent back that message.
 */
export function* historyStartSteps(ids: readonly string[], end: number, limits: { turns?: number; messages?: number } = {}): Generator<string, { start: number; contextIncomplete: boolean }, ChatMessage | undefined> {
  const turnLimit = limits.turns ?? HISTORY_TURNS, messageLimit = limits.messages ?? HISTORY_MESSAGE_LIMIT;
  let turns = 0;
  let scanned = 0;
  let oldestUser = -1;
  for (let index = end - 1; index >= 0 && scanned < messageLimit; index -= 1) {
    scanned += 1;
    const message = yield ids[index]!;
    if (message?.role === 'user' && userQuery(message)) {
      turns += 1;
      const previousUser = oldestUser;
      oldestUser = index;
      if (turns > turnLimit) return { start: previousUser, contextIncomplete: false };
    }
  }
  if (scanned < messageLimit || scanned === end) return { start: Math.max(0, end - scanned), contextIncomplete: false };
  if (oldestUser >= 0) return { start: oldestUser, contextIncomplete: false };
  return { start: Math.max(0, end - scanned), contextIncomplete: end > scanned };
}

function mapEvents(reader: ChatReader, mapper: TranscriptMapper, sessionId: string, ids: string[], start: number, end: number, seenAt?: string, absoluteOffset = 0, rawMessagePositions?: Map<number, number>, bounded = true): { events: NativeWorkbenchEvent[]; next: number; pendingIds: string[] } {
  const events: NativeWorkbenchEvent[] = [];
  let next = start;
  for (; next < end; next += 1) {
    const id = ids[next]!;
    const result = reader.readMessage(id);
    if (result.status !== 'ok') {
      if (result.status === 'missing') break;
      continue;
    }
    // A committed non-message or malformed blob will not become readable later. Skip it so it
    // cannot hold the visible tail behind a permanent pending-id retry.
    const message = result.message;
    // Blob ids identify content, not occurrences. The same prompt or answer can appear more than
    // once in a transcript, so include the absolute position for run/event identity.
    const position = absoluteOffset + next;
    const mapped = mapper.map({ id: `${position}:${id}`, message, ...(seenAt ? { seenAt } : {}) });
    for (let ordinal = 0; ordinal < mapped.length; ordinal += 1) {
      const event = mapped[ordinal]!;
      const rawPosition = rawMessagePositions?.get(position);
      const projected: NativeWorkbenchEvent = {
        sequence: 0,
        nativeId: `${position}:${id}:${ordinal}`,
        ...(event.type === 'user_message_chunk' && rawPosition !== undefined ? { nativeAliases: [`${rawPosition}:${id}:${ordinal}`] } : {}),
        sessionId,
        ...(event.runId ? { runId: event.runId } : {}),
        ...(event.nativeTurnId ? { nativeTurnId: event.nativeTurnId } : {}),
        type: event.type,
        data: event.data,
        createdAt: event.createdAt,
      };
      events.push(bounded ? boundEvent(projected) : projected);
    }
  }
  return { events, next, pendingIds: next < end ? ids.slice(next, end) : [] };
}

/** The message position an event of this store came from: its id is `<position>:<blob>:<part>`. */
const positionOf = (event: NativeWorkbenchEvent): number => Number.parseInt(event.nativeId, 10);

/**
 * Caller-owned full export: the normal mapper without its payload cap, every message and compaction in
 * store order, numbered from 1.
 */
export function readCompleteTranscript(path: string, sessionId: string): NativeWorkbenchEvent[] {
  const reader = new ChatReader(path);
  try {
    const snapshot = reader.snapshot();
    if (!snapshot?.rootAvailable || snapshot.contextIncomplete) throw new AppError('SHARE_HISTORY_UNAVAILABLE', 'The Cursor conversation history is incomplete', 409);
    const rootId = snapshot.meta.latestRootBlobId, ids = snapshot.messageIds, mapper = new TranscriptMapper(true);
    const mapped = mapEvents(reader, mapper, sessionId, ids, 0, ids.length, undefined, 0, snapshot.rawMessagePositions, false);
    if (mapped.pendingIds.length) throw new AppError('SHARE_HISTORY_CHANGED', 'Some conversation messages are still being written; try again shortly', 409);
    const events = [...mapped.events];
    // A compaction sits after the last message it archived, ahead of the first one after it.
    for (const compaction of [...snapshot.compactions ?? []].sort((a, b) => b.boundary - a.boundary)) {
      const at = events.findIndex(event => positionOf(event) >= compaction.boundary);
      const createdAt = events[at]?.createdAt ?? events.at(-1)?.createdAt ?? new Date(0).toISOString();
      events.splice(at < 0 ? events.length : at, 0, compactionEvent(sessionId, compaction, createdAt));
    }
    if (snapshot.pending && !sameStep(snapshot.pending, ids.length ? reader.message(ids.at(-1)!) : undefined)) {
      for (const [ordinal, event] of mapper.map({ id: `draft:${ids.length}`, message: snapshot.pending }).entries()) {
        events.push({ sequence: 0, nativeId: `draft:${ids.length}:${ordinal}`, sessionId, ...(event.runId ? { runId: event.runId } : {}), ...(event.nativeTurnId ? { nativeTurnId: event.nativeTurnId } : {}), type: event.type, data: event.data, createdAt: event.createdAt });
      }
    }
    if (reader.meta()?.latestRootBlobId !== rootId) throw new AppError('SHARE_HISTORY_CHANGED', 'The conversation is still being written; try sharing again shortly', 409);
    return visible(events).map((event, index) => ({ ...event, sequence: index + 1 }));
  } finally { reader.close(); }
}

/**
 * The activity event of one compaction the store archives. The store records no time, trigger or
 * token counts, so none are claimed; the place is the boundary the archive itself proves.
 */
function compactionEvent(sessionId: string, compaction: ChatCompaction, createdAt: string): NativeWorkbenchEvent {
  const activity: NativeActivity = {
    id: activityId('cursor', `compaction:${compaction.summaryId}`),
    kind: 'compaction', status: 'completed', title: '上下文压缩',
    ...(compaction.summary ? { detail: clipDetail(compaction.summary) } : {}),
  };
  return activityEvent(sessionId, activity, { createdAt });
}

/**
 * A root can still carry a step in flight after committing it; the committed copy wins. Step ids
 * are small counters that repeat across steps, so only the content identifies one.
 */
export function sameStep(pending: ChatMessage, committed: ChatMessage | undefined): boolean {
  return committed?.role === pending.role && JSON.stringify(committed.content) === JSON.stringify(pending.content);
}

/**
 * One chat store being followed (the parent conversation or one subagent), for what the CLI watcher
 * learns from it: whether a turn is still owed a step, its subagents and jobs, context and output speed.
 * Clients read the conversation from the session journal, not from here. `generation` changes whenever
 * the store is read again from its tail, so a batch read before that is recognised as stale.
 */
export class Transcript {
  readonly reader: ChatReader;
  rootId: string | undefined;
  events: NativeWorkbenchEvent[] = [];
  generation: string = randomUUID();
  private totalCount = 0;
  private prefixDigest = digestIds([]);
  private nextIndex = 0;
  private pendingIds: string[] = [];
  private pendingStart = 0;
  /** Whether an unread suffix belongs to new activity instead of the baseline/history load. */
  private pendingActivity = false;
  private rawMessagePositions: Map<number, number> | undefined;
  private eventSizes: number[] = [];
  private eventBytes = 0;
  private initialized = false;
  private rootReady = false;
  /** Whether this chat's store actually decodes; `undefined` before the first attempt. */
  status: 'ok' | 'unavailable' | 'unparsed' | undefined;
  /** When the store last grew while being followed; the baseline load does not count. */
  lastActivityAt = 0;
  /**
   * The step the CLI has not committed yet, mapped behind `events` at the position it will take.
   * It is replaced whole whenever the step changes and is never part of `events` or history.
   */
  draft: NativeWorkbenchEvent[] = [];
  private draftSource: ChatMessage | undefined;
  private draftKey = '';
  private draftSince: { position: number; at: string } | undefined;
  private mapper = new TranscriptMapper();
  /** Compactions already reported, by summary id: a root is re-read on every change. */
  private readonly placedCompactions = new Set<string>();

  constructor(readonly chatId: string, path: string, private readonly sessionId: string) {
    this.reader = new ChatReader(path);
  }

  /** Returns what changed since the last call, or undefined when nothing did. */
  refresh(): { reset: boolean; activity: boolean; events: NativeWorkbenchEvent[]; draftChanged: boolean; meta: ChatMeta; context?: NativeContext } | undefined {
    // The store is the CLI's private format, so "cannot read it" is a real state we have to
    // report: a missing file and an undecodable one look identical to a user otherwise.
    if (!this.reader.available()) { this.status = 'unavailable'; return undefined; }
    const meta = this.reader.meta();
    if (!meta) { this.status = 'unparsed'; return undefined; }
    this.status = 'ok';
    if (this.initialized && this.rootReady && meta.latestRootBlobId === this.rootId) {
      // A root can point at a blob before SQLite commits it. Keep retrying just that suffix, but
      // do not decode the unchanged root or its full message-ID list on every poll.
      if (!this.pendingIds.length) return undefined;
      const retried = mapEvents(this.reader, this.mapper, this.sessionId, this.pendingIds, 0, this.pendingIds.length, this.pendingActivity ? new Date().toISOString() : undefined, this.pendingStart, this.rawMessagePositions);
      const absolute = retried.events;
      const consumed = retried.next;
      this.pendingStart += consumed;
      this.pendingIds = this.pendingIds.slice(consumed);
      this.nextIndex = this.pendingStart;
      const activity = this.pendingActivity;
      if (activity && consumed) this.lastActivityAt = Date.now();
      if (!this.pendingIds.length) this.pendingActivity = false;
      this.appendEvents(absolute);
      const draftChanged = this.updateDraft();
      if (!absolute.length && !draftChanged) return undefined;
      return { reset: false, activity, events: absolute, draftChanged, meta, ...(this.context ? { context: this.context } : {}) };
    }
    const snapshot = this.reader.snapshot(meta);
    if (!snapshot) { this.status = 'unparsed'; return undefined; }
    if (!snapshot.rootAvailable) {
      // A missing root blob is different from an unchanged, successfully decoded root: retry it.
      this.rootId = undefined;
      this.rootReady = false;
      return undefined;
    }
    const ids = snapshot.messageIds;
    const previousTotalCount = this.totalCount;
    const sameBranch = this.initialized && ids.length >= this.totalCount && digestIds(ids, this.totalCount) === this.prefixDigest;
    const activity = this.initialized && sameBranch && (ids.length > previousTotalCount || this.pendingActivity);
    if (activity) this.lastActivityAt = Date.now();
    const reset = this.initialized && !sameBranch;
    const backlog = sameBranch ? ids.length - this.nextIndex : ids.length;
    const rebaseToTail = !this.initialized || reset || backlog > HISTORY_MESSAGE_LIMIT;
    const seenAt = activity && !rebaseToTail ? new Date().toISOString() : undefined;
    if (reset) this.generation = randomUUID();
    if (rebaseToTail) {
      this.mapper = new TranscriptMapper();
      this.events = [];
      this.eventSizes = [];
      this.eventBytes = 0;
      this.placedCompactions.clear();
      const selected = selectHistoryStart(this.reader, ids, ids.length);
      this.initialTailStart = selected.start;
      this.nextIndex = selected.start;
    }
    const start = this.nextIndex;
    this.rawMessagePositions = snapshot.rawMessagePositions;
    const mapped = mapEvents(this.reader, this.mapper, this.sessionId, ids, start, ids.length, seenAt, 0, this.rawMessagePositions);
    this.nextIndex = mapped.next;
    this.pendingStart = mapped.next;
    this.pendingIds = mapped.pendingIds;
    this.pendingActivity = activity && mapped.pendingIds.length > 0;
    this.totalCount = ids.length;
    this.prefixDigest = digestIds(ids);
    this.rootId = meta.latestRootBlobId;
    this.rootReady = true;
    this.initialized = true;
    this.appendEvents(mapped.events);
    // A compaction is discovered when its archive lands, which can be long after the messages it
    // archived were mapped: it is reported with this change, so the watcher learns it finished.
    const freshCompactions: NativeWorkbenchEvent[] = [];
    for (const compaction of snapshot.compactions ?? []) {
      if (this.placedCompactions.has(compaction.summaryId)) continue;
      // Before the loaded tail: that compaction is old news.
      if (compaction.boundary <= this.initialTailStart) continue;
      const createdAt = mapped.events.find((event) => positionOf(event) >= compaction.boundary)?.createdAt
        ?? mapped.events.at(-1)?.createdAt ?? seenAt ?? new Date().toISOString();
      this.placedCompactions.add(compaction.summaryId);
      freshCompactions.push(compactionEvent(this.sessionId, compaction, createdAt));
    }
    this.context = snapshot.context;
    this.draftSource = snapshot.pending && !sameStep(snapshot.pending, ids.length ? this.reader.message(ids.at(-1)!) : undefined) ? snapshot.pending : undefined;
    const draftChanged = this.updateDraft();
    return {
      reset: reset || rebaseToTail,
      activity,
      events: rebaseToTail ? this.events : [...mapped.events, ...freshCompactions],
      draftChanged,
      meta,
      ...(snapshot.context ? { context: snapshot.context } : {}),
    };
  }

  /**
   * Maps the uncommitted step, once every committed message before it has been read, at the
   * position its message will take; true when what the draft shows changed.
   */
  private updateDraft(): boolean {
    const pending = this.pendingIds.length ? undefined : this.draftSource;
    const position = this.totalCount;
    const key = pending ? `${position}:${JSON.stringify(pending)}` : '';
    if (key === this.draftKey) return false;
    this.draftKey = key;
    const shown = this.draft.length > 0;
    if (!pending) {
      this.draft = [];
      this.draftSince = undefined;
      return shown;
    }
    if (this.draftSince?.position !== position) this.draftSince = { position, at: new Date().toISOString() };
    const mapped = this.mapper.fork().map({ id: `${position}:draft`, message: pending, seenAt: this.draftSince.at });
    this.draft = mapped.map((event, ordinal) => boundEvent({
      sequence: 0,
      nativeId: `${position}:draft:${ordinal}`,
      sessionId: this.sessionId,
      ...(event.runId ? { runId: event.runId } : {}),
      ...(event.nativeTurnId ? { nativeTurnId: event.nativeTurnId } : {}),
      type: event.type,
      data: event.data,
      createdAt: event.createdAt,
    }));
    return shown || this.draft.length > 0;
  }

  private initialTailStart = 0;
  private context: NativeContext | undefined;

  private appendEvents(events: NativeWorkbenchEvent[]): void {
    for (const event of events) {
      const size = Buffer.byteLength(JSON.stringify(event));
      this.events.push(event);
      this.eventSizes.push(size);
      this.eventBytes += size;
    }
    this.trimEvents();
  }

  private trimEvents(): void {
    while (this.events.length > TRANSCRIPT_EVENT_LIMIT || this.eventBytes > TRANSCRIPT_BYTE_LIMIT) {
      const firstRun = this.events[0]?.runId;
      let remove = 0;
      if (firstRun) {
        while (remove < this.events.length && this.events[remove]?.runId === firstRun) remove += 1;
      } else {
        const firstMessage = this.events[0]?.nativeId.split(':')[0];
        while (remove < this.events.length && this.events[remove]?.nativeId.split(':')[0] === firstMessage) remove += 1;
      }
      // If the oldest turn alone exceeds the budget, evict oldest whole messages from that turn
      // so its newest answer remains available.
      if (remove >= this.events.length && (this.eventBytes > TRANSCRIPT_BYTE_LIMIT || this.events.length > TRANSCRIPT_EVENT_LIMIT)) {
        const firstMessage = this.events[0]?.nativeId.split(':')[0];
        remove = 0;
        while (remove < this.events.length && this.events[remove]?.nativeId.split(':')[0] === firstMessage) remove += 1;
        // Even one message can expand into enough separate tool/text events to exceed the cache
        // budget. Keep its newest event so the most recent answer still appears in the tail.
        if (remove >= this.events.length && this.events.length > 1) remove = this.events.length - 1;
      }
      if (!remove) break;
      for (const size of this.eventSizes.splice(0, remove)) this.eventBytes -= size;
      this.events.splice(0, remove);
    }
  }

  /** Whether the latest decoded message leaves the model owing another step. */
  awaitingReply(): boolean {
    return this.mapper.awaitingReply;
  }

  /**
   * Whether the store ends on an answer: every message is decoded, no step is still being written,
   * and the last committed message is an assistant answer that calls nothing. This is the CLI's own
   * record of a finished turn, which holds even when its Stop hook never fires.
   */
  answered(): boolean {
    return this.status === 'ok' && !this.pendingIds.length && !this.draftSource && !this.mapper.awaitingReply;
  }

  /** The CLI's request id of the turn the last message belongs to; `undefined` for a turn the CLI started itself. */
  turnId(): string | undefined {
    return this.mapper.turnId;
  }

  /**
   * Where the committed store leaves the turn with this request id: still `open`, `answered` (it is the last
   * turn and ends on an answer), or `superseded` (a later prompt follows it, however it ended). A turn the
   * store has not recorded yet, or a store that does not decode, is `open`: nothing shows it over.
   */
  turnState(turnId: string): 'open' | 'answered' | 'superseded' {
    if (this.status !== 'ok') return 'open';
    if (this.mapper.turnId === turnId) return this.pendingIds.length || this.mapper.awaitingReply ? 'open' : 'answered';
    return this.events.some(event => event.type === 'user_message_chunk' && event.nativeTurnId === turnId) ? 'superseded' : 'open';
  }

  /** Release SQLite and decoded blobs while retaining the bounded events and generation. */
  releaseReader(): void {
    this.reader.close();
  }

  close(): void {
    this.reader.close();
    this.events = [];
    this.eventSizes = [];
    this.eventBytes = 0;
    this.pendingIds = [];
    this.pendingActivity = false;
    this.rootId = undefined;
    this.rootReady = false;
    this.initialized = false;
    this.totalCount = 0;
    this.prefixDigest = digestIds([]);
    this.nextIndex = 0;
    this.pendingStart = 0;
    this.rawMessagePositions = undefined;
    this.initialTailStart = 0;
    this.context = undefined;
    this.status = undefined;
    this.generation = randomUUID();
    this.mapper = new TranscriptMapper();
    this.placedCompactions.clear();
  }
}

/** Events worth sending to a reader: schema lookups and job bookkeeping are not conversation. */
export const visible = (events: NativeWorkbenchEvent[]) => events.filter((event) => event.data.hidden !== true);
