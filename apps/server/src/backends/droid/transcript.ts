import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { NativeActivity, NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';
import { activityId } from '../../journal/activity.js';
import type { LaneWriter, SubagentInfo, TranscriptSource, TurnEndStatus } from '../../journal/ingest.js';
import {
  droidBackgroundActivity, droidBackgroundEnd, droidBlockEventId, droidFireAndForgetResult, droidTurnEndId, isDroidPrompt, isHiddenMessage,
  messageFromJsonl, projectDroidMessage, projectDroidTurnEnd, type DroidMessage,
} from './events.js';
import { validateDroidSessionId } from './history.js';

/*
 * Droid's transcript as the session journal reads it (docs/SYNC-V3.md, 写入契约). Droid only appends to a
 * session's JSONL file, so a lane's cursor is a byte offset into it, with the little a line needs from the
 * lines before it: the turn it belongs to and the tip of the branch. Every row is keyed by Droid's own
 * message, block and tool ids (`events.ts`), so reading a line again writes nothing. A running process
 * only adds what has not reached the file yet: streamed text, subagents that are still working, and the
 * notifications that say when to read (`DroidLiveFeed`).
 */

/** A pull reads about this much of a file, so a long import goes in steps. */
const PULL_BYTES = 4 * 1024 * 1024;
/** A first import longer than one step serves a tail window of about this much meanwhile (G4). */
const TAIL_BYTES = 1024 * 1024;
/** Rows per commit inside one long turn. */
const COMMIT_EVENTS = 256;
/** Droid may report a message just before its line reaches the file, so a report is followed by one more look. */
const SETTLE_MS = 250;
const READ_CHUNK = 1024 * 1024;
/** A read gives the event loop back after about this long, between lines. */
const SLICE_MS = 20;
const COMPACTION_TITLE = '上下文压缩';

/** A streamed assistant block that Droid has not committed. */
export interface DroidStreamingBlock { messageId: string; blockIndex: number; thought: boolean; text: string; at: string }

/** What a running Droid process knows before its session file does. */
export interface DroidLiveFeed {
  /** Calls `wake` whenever the process reports something for the conversation; returns how to stop. */
  watch(wake: () => void): () => void;
  streaming(): DroidStreamingBlock[];
  /** Subagents the process reports as running, by the `Task` call that started each. */
  running(): Array<{ toolCallId: string; childId: string; subagentType?: string }>;
  /** The workbench command that sent prompt `messageId`, when it is known. */
  command(messageId: string): { commandId?: string; runId?: string } | undefined;
}

export interface DroidTranscriptOptions {
  /** The workbench session the events are stamped with. */
  sessionId: string;
  /** Droid's session id; a new conversation gets one with its first send. */
  nativeSessionId(): string | undefined;
  /** The session file of a Droid session, when Droid has written one. */
  locate(nativeSessionId: string): Promise<string | undefined>;
  live?: DroidLiveFeed;
}

/** Where the read of one lane stands. It is the lane's cursor, so a read after a restart continues exactly here. */
interface ReadState {
  /** Byte offset of the next line. */
  o: number;
  /** Starting byte offset of this lane's read window (non-zero only for a tail scratch window). */
  start?: number;
  /** The last message read; a message naming another parent starts a new branch (a rewind). */
  leaf?: string;
  /** The turn events go to, and whether it still runs. */
  turn?: string;
  open?: true;
  /** The workbench run the open turn's prompt was sent by: every event of the turn is stamped with it. */
  run?: string;
  /** The open turn was started by an event, not a prompt or a cue: no outcome will name it. */
  auto?: true;
  /** Turns a later prompt overtook before their outcome arrived. */
  pending?: string[];
  /** The hidden message an unprompted run starts with; Droid's outcome names the run after it. */
  cue?: string;
  /** Time of the last message, for records that carry none. */
  at?: string;
  /** `fireAndForget` commands waiting for their result, by tool use id. */
  ff?: Record<string, { command?: string; summary?: string }>;
  /** Subagents still being followed: `Task` tool use id -> child session id. */
  kids?: Record<string, string>;
  /** `Task` calls whose result has not named their child yet: what the call says of it. */
  sa?: Record<string, SubagentInfo>;
}

function encode(state: ReadState, offset: number): string {
  const { start, leaf, turn, open, run, auto, pending, cue, at, ff, kids, sa } = state;
  return JSON.stringify({
    o: offset, ...(start ? { start } : {}), leaf, turn, open, run, auto, ...(pending?.length ? { pending } : {}), cue, at,
    ...(ff && Object.keys(ff).length ? { ff } : {}), ...(kids && Object.keys(kids).length ? { kids } : {}),
    ...(sa && Object.keys(sa).length ? { sa } : {}),
  });
}

function decode(cursor: string | null): ReadState | undefined {
  if (cursor === null) return undefined;
  try {
    const state = JSON.parse(cursor) as ReadState;
    return Number.isSafeInteger(state?.o) && state.o >= 0 ? state : { o: 0 };
  } catch {
    return { o: 0 };
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function time(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
}

function entryOf(text: string): Record<string, unknown> | undefined {
  try { return record(JSON.parse(text)); } catch { return undefined; }
}

function turnStatus(reason: string): TurnEndStatus {
  return reason === 'completed' ? 'completed' : reason === 'cancelled' ? 'cancelled' : 'failed';
}

interface Line { text: string; start: number; end: number }

/**
 * The complete lines of `path` from byte `from`, about `limit` bytes of them (a longer line is read
 * whole). A last line without its newline is still being written and is left for the next read.
 */
async function readLines(path: string, from: number, limit: number): Promise<{ lines: Line[]; end: number; eof: boolean }> {
  let file;
  try { file = await open(path, 'r'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { lines: [], end: from, eof: true };
    throw error;
  }
  try {
    const { size } = await file.stat();
    const lines: Line[] = [];
    let offset = from, position = from, pending = Buffer.alloc(0);
    while (position < size && offset - from < limit) {
      // Grows with an unfinished line, so a huge one costs linear time.
      const chunk = Buffer.allocUnsafe(Math.min(Math.max(READ_CHUNK, pending.length), size - position));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      pending = pending.length ? Buffer.concat([pending, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      let at = 0;
      for (let newline = pending.indexOf(10); newline >= 0 && offset - from < limit; newline = pending.indexOf(10, at)) {
        lines.push({ text: pending.toString('utf8', at, newline), start: offset, end: offset + newline + 1 - at });
        offset += newline + 1 - at;
        at = newline + 1;
      }
      pending = pending.subarray(at);
    }
    return { lines, end: offset, eof: offset >= size || offset - from < limit };
  } finally {
    await file.close();
  }
}

async function sizeOf(path: string): Promise<number | undefined> {
  try {
    const file = await open(path, 'r');
    try { return (await file.stat()).size; } finally { await file.close(); }
  } catch {
    return undefined;
  }
}

/** Where a tail window of about {@link TAIL_BYTES} starts: at a prompt, so every turn in it is whole; 0 when none is later than the start. */
async function tailStart(path: string, size: number): Promise<number> {
  for (let span = TAIL_BYTES; ; span *= 2) {
    const from = Math.max(0, size - span);
    const { lines } = await readLines(path, from, size - from);
    // A window that starts mid-line has a fragment for its first line.
    for (const line of from > 0 ? lines.slice(1) : lines) {
      const message = messageFromJsonl(entryOf(line.text));
      if (message && isDroidPrompt(message)) return line.start;
    }
    if (from === 0) return 0;
  }
}

/** Droid's session file of one conversation, read into its lanes. */
export class DroidTranscriptSource implements TranscriptSource {
  constructor(private readonly options: DroidTranscriptOptions) {}

  get sessionId(): string { return this.options.sessionId; }
  get live(): DroidLiveFeed | undefined { return this.options.live; }

  identity(): string | undefined { return this.options.nativeSessionId(); }

  async pull(w: LaneWriter, signal: AbortSignal): Promise<{ caughtUp: boolean }> {
    const path = await this.path();
    const size = path ? await sizeOf(path) : undefined;
    if (!path || size === undefined) return { caughtUp: true };
    // Droid only appends: a file shorter than what was read of it is another file under the same name.
    if (Math.max(decode(w.cursor)?.o ?? 0, decode(w.scratch?.cursor ?? null)?.o ?? 0) > size) w.rebuild('identity-changed');
    let window: number | undefined;
    if (w.cursor === null && !w.scratch && size > PULL_BYTES) {
      window = await tailStart(path, size);
      if (window > 0) w.openScratch();
    }
    const scratch = w.scratch;
    if (scratch) {
      const start = window ?? await tailStart(path, size);
      if (!await this.read(scratch, path, decode(scratch.cursor) ?? { o: start, start }, Infinity, signal, true, true)) return { caughtUp: false };
    }
    const caughtUp = await this.read(w, path, decode(w.cursor) ?? { o: 0 }, PULL_BYTES, signal, !scratch, false);
    return { caughtUp: caughtUp && !signal.aborted };
  }

  watch(_w: LaneWriter, wake: () => void): () => void {
    let settle: NodeJS.Timeout | undefined;
    const stop = this.options.live?.watch(() => {
      wake();
      clearTimeout(settle);
      settle = setTimeout(wake, SETTLE_MS);
      settle.unref();
    });
    return () => { clearTimeout(settle); stop?.(); };
  }

  async drain(w: LaneWriter): Promise<void> {
    const path = await this.path();
    if (!path) return;
    const isScratch = w.scratch !== undefined;
    const target = w.scratch ?? w;
    const done = await this.read(target, path, decode(target.cursor) ?? { o: 0 }, Infinity, undefined, false, isScratch);
    if (!done && isScratch && w.scratch === undefined) await this.read(w, path, { o: 0 }, Infinity, undefined, false, false);
  }

  command(messageId: string): { commandId?: string; runId?: string } | undefined {
    return this.options.live?.command(messageId);
  }

  /**
   * The process ran a turn it will never end: it exited. What is on disk is read first (G6); then the turn
   * the log has open ends as `status`, and any turn it had overtaken as interrupted, on the log that serves.
   * The cursor no longer holds them open, so an outcome line read later writes nothing. Resolves the turns ended.
   */
  async endOpenTurns(w: LaneWriter, status: TurnEndStatus, at: string, error?: string): Promise<string[]> {
    await this.drain(w);
    const target = w.scratch ?? w;
    const state = decode(target.cursor);
    if (!state) return [];
    const open = state.open && state.turn ? state.turn : undefined;
    const overtaken = state.pending ?? [];
    if (!open && !overtaken.length) return [];
    Object.assign(state, { open: undefined, run: undefined, auto: undefined, pending: undefined });
    target.transaction(() => {
      target.commit({ events: [], cursor: encode(state, state.o) });
      for (const turn of overtaken) target.turnEnded(turn, 'interrupted', at);
      if (open) target.turnEnded(open, status, at, error);
    });
    return [...overtaken, ...open ? [open] : []];
  }

  /** External turn-end settlement (G6 / D2): drains disk and clears matching open/pending cursor state atomically. */
  async settleTurnEnd(w: LaneWriter, end: { turnId: string; status: TurnEndStatus; at: string; error?: string }): Promise<boolean> {
    await this.drain(w);
    const target = w.scratch ?? w;
    const state = decode(target.cursor);
    if (!state) return false;
    const isOpen = state.open && state.turn === end.turnId;
    const pendingIdx = state.pending?.indexOf(end.turnId) ?? -1;
    if (!isOpen && pendingIdx < 0) return false;
    if (isOpen) Object.assign(state, { open: undefined, run: undefined, auto: undefined });
    if (pendingIdx >= 0 && state.pending) {
      const nextPending = state.pending.filter(id => id !== end.turnId);
      state.pending = nextPending.length ? nextPending : undefined;
    }
    target.transaction(() => {
      target.commit({ events: [], cursor: encode(state, state.o) });
      target.turnEnded(end.turnId, end.status, end.at, end.error);
    });
    return true;
  }

  private async path(): Promise<string | undefined> {
    const nativeSessionId = this.options.nativeSessionId();
    return nativeSessionId ? await this.options.locate(nativeSessionId) : undefined;
  }

  /** Reads `path` into `w` from `state`; resolves whether it reached the end. `live` adds what the process knows to a log that serves. */
  private async read(w: LaneWriter, path: string, state: ReadState, limit: number, signal: AbortSignal | undefined, live: boolean, isScratch: boolean): Promise<boolean> {
    return await new LaneRead(this, w, path, state, w.lane === 'main', isScratch, signal).run(limit, live);
  }
}

/** One read of one file into one lane. Writes outside a commit come after a commit of what precedes them, and replay safely from it. */
class LaneRead {
  private events: NativeWorkbenchEvent[] = [];
  private retired: string[] = [];

  constructor(
    private readonly source: DroidTranscriptSource,
    private readonly w: LaneWriter,
    private readonly path: string,
    readonly state: ReadState,
    /** The conversation's own lane: its turns are runs, with outcomes to show. */
    private readonly main: boolean,
    private readonly isScratch: boolean,
    private readonly signal: AbortSignal | undefined,
  ) {}

  async run(limit: number, live: boolean): Promise<boolean> {
    const { lines, end, eof } = await readLines(this.path, this.state.o, limit);
    let slice = performance.now();
    for (const line of lines) {
      if (this.signal?.aborted) { this.flush(line.start); return false; }
      const entry = entryOf(line.text);
      if (entry?.type === 'agent_turn_outcome') this.outcome(entry, line);
      else if (entry?.type === 'compaction_state') this.compaction(entry, line);
      else {
        const message = messageFromJsonl(entry);
        if (message && !await this.message(message, line)) return false;
      }
      if (this.events.length >= COMMIT_EVENTS || performance.now() - slice >= SLICE_MS) this.flush(line.end);
      if (performance.now() - slice >= SLICE_MS) {
        await new Promise(resolve => setImmediate(resolve));
        slice = performance.now();
      }
    }
    this.flush(end);
    this.state.o = end;
    const types = new Map<string, string>();
    if (live && eof && this.main) {
      this.drafts();
      for (const kid of this.source.live?.running() ?? []) {
        (this.state.kids ??= {})[kid.toolCallId] ??= kid.childId;
        if (kid.subagentType) types.set(kid.toolCallId, kid.subagentType);
      }
    }
    for (const [toolCallId, childId] of Object.entries(this.state.kids ?? {})) {
      const subagentType = types.get(toolCallId);
      if (!await this.follow(toolCallId, childId, false, subagentType ? { subagentType } : {})) delete this.state.kids![toolCallId];
    }
    this.flush(end);
    for (const activity of this.w.activities.live()) {
      const ended = droidBackgroundEnd(activity);
      if (ended) this.w.activities.apply({ ...activity, status: ended });
    }
    return eof;
  }

  /** Commits what was read before `offset`, and `extra`, with the cursor at `offset`. */
  private flush(offset: number, extra: NativeWorkbenchEvent[] = []): void {
    const events = [...this.events, ...extra];
    const cursor = encode(this.state, offset);
    if (events.length || this.retired.length || cursor !== this.w.cursor) this.w.commit({ events, ...(this.retired.length ? { retire: this.retired } : {}), cursor });
    this.events = [];
    this.retired = [];
  }

  private async message(message: DroidMessage, line: Line, replaying = false): Promise<boolean> {
    const { state, w } = this;
    if (!replaying && message.parentId && state.leaf && message.parentId !== state.leaf) {
      if (!await this.rewind(message, line.start)) return false;
    }
    const hidden = isHiddenMessage(message);
    const prompt = !hidden && isDroidPrompt(message);
    const command = prompt && this.main ? this.source.command(message.id) : undefined;
    const runId = prompt ? command?.runId : state.open ? state.run : undefined;
    // The journal numbers the rows; a message Droid wrote without a `seq` is still projected.
    const projected = hidden ? [] : projectDroidMessage({ ...message, seq: message.seq ?? 0 }, {
      sessionId: this.source.sessionId,
      ...(command?.commandId ? { commandId: command.commandId } : {}),
      ...(runId ? { runId } : {}),
    });
    if (prompt) {
      this.flush(line.start);
      // An unnamed run is over once someone asks again; a named turn keeps waiting for its outcome.
      if (state.open && state.auto) w.turnEnded(state.turn!, 'completed', state.at ?? message.createdAt);
      else if (state.open && state.turn !== message.id) (state.pending ??= []).push(state.turn!);
      w.turnStarted(message.id, message.createdAt, command?.runId);
      Object.assign(state, { turn: message.id, open: true, run: command?.runId, auto: undefined, cue: undefined });
    } else if (projected.length && !state.open) {
      this.flush(line.start);
      const turnId = state.cue ?? message.id;
      w.turnStarted(turnId, message.createdAt);
      Object.assign(state, { turn: turnId, open: true, run: undefined, auto: state.cue ? undefined : true, cue: undefined });
    } else if (hidden && !state.open && message.role === 'user' && !message.id.startsWith('context-')) {
      state.cue = message.id;
    }
    const events = projected.map(event => ({ ...event, nativeTurnId: state.turn! }));
    for (const event of events) {
      const toolCallId = str(event.data.toolCallId), call = record(event.data.subagent);
      if (event.type !== 'tool_call' || !toolCallId || !call) continue;
      const title = str(call.description), subagentType = str(call.type);
      (state.sa ??= {})[toolCallId] = { ...(title ? { title } : {}), ...(subagentType ? { subagentType } : {}) };
    }
    const links = events.flatMap(event => {
      const toolCallId = str(event.data.toolCallId), agentId = str(record(event.data.subagentResult)?.agentId);
      return event.type === 'tool_call_update' && toolCallId && agentId ? [{ toolCallId, agentId }] : [];
    });
    const started = this.backgroundStarts(message);
    if (links.length || started.length) {
      this.flush(line.start, events);
      for (const activity of started) w.activities.apply(activity);
      for (const { toolCallId, agentId } of links) {
        if (await this.follow(toolCallId, agentId, true)) (state.kids ??= {})[toolCallId] = agentId;
        else delete state.kids?.[toolCallId];
        delete state.sa?.[toolCallId];
      }
    } else this.events.push(...events);
    this.noteBackgroundCalls(message);
    state.leaf = message.id;
    state.at = message.createdAt;
    return true;
  }

  private outcome(entry: Record<string, unknown>, line: Line): void {
    const { state, w } = this;
    const turnId = str(entry.turnId), reason = str(entry.reason);
    if (!turnId || !reason || !state.turn) return;
    const pending = state.pending?.includes(turnId) ?? false;
    // Droid names an unprompted run after a message this read may not have taken for its start.
    const current = state.open === true && (state.turn === turnId || (!pending && state.auto === true));
    if (!current && !pending) return;
    const ended = current ? state.turn : turnId;
    const at = state.at ?? new Date().toISOString();
    const command = this.main ? this.source.command(ended) : undefined;
    const event = this.main ? projectDroidTurnEnd({ turnId: ended, reason }, 0, at, {
      sessionId: this.source.sessionId,
      ...(command?.commandId ? { commandId: command.commandId } : {}),
      ...(command?.runId ? { runId: command.runId } : {}),
    }) : undefined;
    this.flush(line.start, event ? [{ ...event, nativeTurnId: ended }] : []);
    w.turnEnded(ended, turnStatus(reason), at);
    if (!current) {
      state.pending = state.pending!.filter(id => id !== turnId);
      return;
    }
    // Droid's loop is done: a turn it overtook and never named again is not coming back.
    for (const turn of state.pending ?? []) w.turnEnded(turn, 'interrupted', at);
    Object.assign(state, { open: undefined, run: undefined, auto: undefined, pending: undefined });
  }

  private compaction(entry: Record<string, unknown>, line: Line): void {
    const id = str(entry.id);
    if (!id || !this.state.turn) return;
    const endedAt = time(entry.timestamp) ?? this.state.at;
    this.flush(line.start);
    this.w.activities.apply({
      id: activityId('droid', `compaction:${id}`), kind: 'compaction', status: 'completed', title: COMPACTION_TITLE,
      ...(this.state.at ? { startedAt: this.state.at } : {}), ...(endedAt ? { endedAt } : {}), compaction: { trigger: 'auto' },
    });
  }

  /**
   * A message continuing from another than the last one: Droid rewound, and what the branch it left holds
   * leaves the transcript. Read from the start of the file, which is rare enough to afford.
   * When an ancestor in the resumed branch is missing (retired by an earlier rewind, or outside a
   * tail scratch window), rebuild the lane and replay only the kept ancestor chain in order.
   */
  private async rewind(message: DroidMessage, at: number): Promise<boolean> {
    const { lines } = await readLines(this.path, 0, at);
    const byId = new Map<string, { message: DroidMessage; start: number }>();
    for (const line of lines) {
      const known = messageFromJsonl(entryOf(line.text));
      if (known) byId.set(known.id, { message: known, start: line.start });
    }
    const kept = new Set([message.id]);
    const ancestors: Array<{ message: DroidMessage; start: number }> = [];
    for (let id = message.parentId; id && !kept.has(id); id = byId.get(id)?.message.parentId) {
      kept.add(id);
      const found = byId.get(id);
      if (found) ancestors.push(found);
    }
    const windowStart = this.state.start ?? 0;
    const buffered = new Set(this.events.map(event => event.nativeId));
    const parentRow = message.parentId ? byId.get(message.parentId) : undefined;
    let missingAncestor = Boolean(parentRow && parentRow.start < windowStart);
    if (!missingAncestor) {
      for (const { message: ancestor, start } of ancestors) {
        if (start < windowStart || isHiddenMessage(ancestor)) continue;
        const projected = projectDroidMessage({ ...ancestor, seq: ancestor.seq ?? 0 }, { sessionId: this.source.sessionId });
        if (projected.some(event => !buffered.has(event.nativeId) && !this.w.event(event.nativeId))) {
          missingAncestor = true;
          break;
        }
      }
    }
    if (missingAncestor) {
      this.w.rebuild('identity-changed');
      if (this.isScratch) return false;
      this.events = [];
      this.retired = [];
      for (const key of Object.keys(this.state) as Array<keyof ReadState>) delete this.state[key];
      this.state.o = 0;
      let onKeptBranch = false;
      for (const line of lines) {
        const entry = entryOf(line.text);
        if (entry?.type === 'agent_turn_outcome') {
          const turnId = str(entry.turnId);
          if (turnId && kept.has(turnId)) this.outcome(entry, line);
        } else if (entry?.type === 'compaction_state') {
          if (onKeptBranch) this.compaction(entry, line);
        } else {
          const prior = messageFromJsonl(entry);
          if (prior) {
            onKeptBranch = kept.has(prior.id);
            if (onKeptBranch) await this.message(prior, line, true);
          }
        }
        if (this.events.length >= COMMIT_EVENTS) this.flush(line.end);
      }
      this.flush(at);
      return true;
    }
    const left: DroidMessage[] = [];
    for (let id = this.state.leaf, seen = new Set<string>(); id && !kept.has(id) && !seen.has(id); id = byId.get(id)?.message.parentId) {
      seen.add(id);
      const gone = byId.get(id)?.message;
      if (gone) left.push(gone);
    }
    if (!left.length) return true;
    const prompts = new Set(left.filter(isDroidPrompt).map(item => item.id));
    for (const item of left) this.retired.push(...projectDroidMessage({ ...item, seq: item.seq ?? 0 }, { sessionId: this.source.sessionId }).map(event => event.nativeId));
    this.retired.push(...[...prompts].map(droidTurnEndId));
    this.flush(at);
    const { state, w } = this;
    const when = state.at ?? message.createdAt;
    for (const turn of state.pending ?? []) if (prompts.has(turn)) w.turnEnded(turn, 'interrupted', when);
    state.pending = state.pending?.filter(turn => !prompts.has(turn));
    if (state.open && prompts.has(state.turn!)) {
      w.turnEnded(state.turn!, 'interrupted', when);
      Object.assign(state, { open: undefined, run: undefined, auto: undefined });
    }
    return true;
  }

  /** Reads a subagent's own session file into its lane; resolves whether it is still worth following. */
  private async follow(toolCallId: string, childId: string, settled: boolean, info: SubagentInfo = {}): Promise<boolean> {
    try { validateDroidSessionId(childId); } catch { return false; }
    const child = this.w.child(toolCallId, childId, { ...this.state.sa?.[toolCallId], ...info });
    const read = new LaneRead(this.source, child, join(dirname(this.path), `${childId}.jsonl`), decode(child.cursor) ?? { o: 0 }, false, false, this.signal);
    const reached = await read.run(Infinity, false);
    // Its result in the parent means it is done; a live one is done once its turn has ended.
    return !(reached && (settled || (read.state.turn !== undefined && !read.state.open)));
  }

  /** Background tasks whose `fireAndForget` command this message reports as started. */
  private backgroundStarts(message: DroidMessage): NativeActivity[] {
    const waiting = this.state.ff;
    if (!waiting) return [];
    return message.content.flatMap(value => {
      const block = record(value);
      const toolUseId = str(block?.tool_use_id) ?? str(block?.toolUseId);
      const input = toolUseId ? waiting[toolUseId] : undefined;
      if (block?.type !== 'tool_result' || !toolUseId || !input) return [];
      const started = droidFireAndForgetResult(block.content, block.is_error === true || block.isError === true);
      if (!started) return [];
      const activity = droidBackgroundActivity(toolUseId, input, started, message.createdAt);
      // A command whose process cannot be watched has no end anyone will see.
      return [{ ...activity, status: started.pid ? droidBackgroundEnd(activity) ?? 'running' : 'unknown' }];
    });
  }

  private noteBackgroundCalls(message: DroidMessage): void {
    for (const value of message.content) {
      const block = record(value);
      const input = record(block?.input);
      const id = str(block?.id);
      if (block?.type === 'tool_use' && block.name === 'Execute' && input?.fireAndForget === true && id) {
        (this.state.ff ??= {})[id] = { ...(str(input.command) ? { command: str(input.command) } : {}), ...(str(input.summary) ? { summary: str(input.summary) } : {}) };
      } else if (block?.type === 'tool_result' && this.state.ff) {
        delete this.state.ff[str(block.tool_use_id) ?? str(block.toolUseId) ?? ''];
      }
    }
  }

  /** Streamed text Droid has not committed, under the ids its blocks will have. */
  private drafts(): void {
    const { state } = this;
    if (!state.open || !state.turn) return;
    const drafts = new Map<string, NativeWorkbenchEvent>();
    for (const block of this.source.live?.streaming() ?? []) {
      const finalId = droidBlockEventId(block.messageId, block.blockIndex);
      if (drafts.has(finalId) || !block.text) continue;
      const type = block.thought ? 'agent_thought_chunk' : 'agent_message_chunk';
      drafts.set(finalId, {
        sequence: 0, sessionId: this.source.sessionId, ...(state.run ? { runId: state.run } : {}), type, createdAt: block.at, nativeId: finalId, nativeTurnId: state.turn,
        data: { sessionUpdate: type, content: { type: 'text', text: block.text }, ...(block.thought ? { channel: 'thinking' } : {}) },
      });
    }
    if (drafts.size) this.w.commit({ events: [], drafts: [...drafts].map(([finalId, event]) => ({ finalId, event })), cursor: this.w.cursor });
  }
}
