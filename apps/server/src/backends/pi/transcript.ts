import { open } from 'node:fs/promises';
import type { NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';
import type { LaneWriter, TranscriptSource, TurnEndStatus } from '../../journal/ingest.js';
import { AppError } from '../../errors.js';
import {
  isPiPrompt, piBlockEventId, piTurnEndId, projectPiEntry, projectPiTurnEnd, type PiTurnOutcome,
} from './projection.js';
import type { PiEntry } from './history.js';

/*
 * pi's session file as the session journal reads it (docs/PI.md §5, docs/SYNC-V3.md). The file is an
 * append-only JSONL tree, so a lane's cursor is a byte offset into it plus the little the next line
 * needs from the lines before it: the entry it continues, the turn it belongs to, and the last assistant
 * message of that turn. Every row is keyed by pi's own entry, block and tool ids (`projection.ts`),
 * so reading a line again writes nothing. A branch switch (an edited prompt) is rare and re-reads the
 * file to retire the rows it left; a process that is still running only adds the blocks that have not
 * reached the file yet.
 */

/** A pull reads about this much of a file, so a long import goes in steps. */
const PULL_BYTES = 4 * 1024 * 1024;
/** A first import longer than one step serves a tail window of about this much meanwhile (G4). */
const TAIL_BYTES = 1024 * 1024;
/** Rows per commit inside one long turn. */
const COMMIT_EVENTS = 256;
/** pi reports an entry just before its line reaches the file, so a report is followed by one more look. */
const SETTLE_MS = 250;
const READ_CHUNK = 1024 * 1024;
/** A read gives the event loop back after about this long, between lines. */
const SLICE_MS = 20;

/** One streamed assistant block pi has not committed to its session file yet. */
export interface PiStreamingBlock {
  /** Identity of one assistant step and block; the final entry must match it, not merely its text. */
  key: string;
  contentIndex: number;
  thought: boolean;
  text: string;
  at: string;
  /** pi's timestamp of the assistant message this block belongs to; the final entry repeats it. */
  messageTimestamp?: number;
  /** The assistant step that owns this block, when the runtime reports it. */
  step?: string;
  entryId?: string;
  turnId?: string;
  runId?: string;
}

/** What a running pi process knows before its session file does. */
export interface PiLiveFeed {
  /** Calls `wake` whenever the process reports something for the conversation; returns how to stop. */
  watch(wake: () => void): () => void;
  streaming(): PiStreamingBlock[];
  /** The workbench command that sent prompt `entryId`, when it is known. */
  command(entryId: string): { commandId?: string; runId?: string } | undefined;
  /** Whether the process that writes this conversation is still alive. A cold read may infer an abandoned turn. */
  running?(): boolean;
  /** Whether this turn is the live one; its end comes from agent_settled, never from a cold read. */
  active?(turnId: string): boolean;
  /** Removes drafts a committed entry superseded, and returns the ids they were published under. */
  superseded?(entryId: string): string[];
}

export interface PiTranscriptOptions {
  /** The workbench session the events are stamped with. */
  sessionId: string;
  /** pi's session id; a new conversation gets one with its first send. */
  nativeSessionId(): string | undefined;
  /** The session file of a pi session, when pi has written one. */
  locate(nativeSessionId: string): Promise<string | undefined>;
  live?: PiLiveFeed;
}

interface LastAssistant { r?: string; e?: string; t?: string }

/** One entry of the active chain and the rows it owns, kept so a branch switch can retire them. */
interface BranchRow { i: string; e: string[] }

/** Where the read of one lane stands. It is the lane's cursor, so a read after a restart continues exactly here. */
interface ReadState {
  /** Byte offset of the next line. */
  o: number;
  /** The file last read; a moved file is read again from its start. */
  p?: string;
  /** The last entry read; a line naming another parent starts a new branch (a rewind). */
  leaf?: string;
  /** The turn events go to, and whether it still runs. */
  turn?: string;
  open?: true;
  /** The workbench run the open turn's prompt was sent by: every event of the turn is stamped with it. */
  run?: string;
  cmd?: string;
  /** The last assistant message of the open turn, which says how it ended. */
  last?: LastAssistant;
  /** Time of the last entry, for records that carry none. */
  at?: string;
  /** The active branch and the ids of the rows it owns. */
  b?: BranchRow[];
  /** Provisional drafts published for the open turn, with the time of the assistant message they belong to. */
  d?: Array<{ i: string; t: string }>;
  /** Assistant message times whose entry is already committed; a stale live block for one must not return as a draft. */
  c?: string[];
  /** Entry ids retired by an earlier rewind; switching back to one rebuilds so Journal keeps chronological order. */
  r?: string[];
}

function encode(state: ReadState, offset: number): string {
  const { p, leaf, turn, open, run, cmd, last, at, b, d, c, r } = state;
  return JSON.stringify({
    o: offset, p, leaf, turn, open, run, cmd, last, at,
    ...(b?.length ? { b } : {}), ...(d?.length ? { d } : {}), ...(c?.length ? { c } : {}), ...(r?.length ? { r } : {}),
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

function isoTime(value: unknown, fallback: string): string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fallback;
}

function entryOf(value: unknown): PiEntry | undefined {
  const item = record(value);
  const id = str(item?.id), type = str(item?.type);
  if (!item || !id || !type) return undefined;
  return {
    ...item,
    id,
    type,
    timestamp: isoTime(item.timestamp, new Date(0).toISOString()),
    ...(typeof item.parentId === 'string' ? { parentId: item.parentId } : { parentId: null }),
  };
}

function parseLine(text: string): PiEntry | undefined {
  try { return entryOf(JSON.parse(text)); } catch { return undefined; }
}

/** The message an assistant entry carries, when it is one. */
function assistantOf(entry: PiEntry): Record<string, unknown> | undefined {
  const message = record(entry.message);
  return entry.type === 'message' && message?.role === 'assistant' ? message : undefined;
}

/** The assistant message's own time. A draft and the entry that replaces it share it; the entry's line time may differ. */
function messageStamp(entry: PiEntry): string | undefined {
  const value = assistantOf(entry)?.timestamp;
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : undefined;
}

/** The time a streamed block will carry once pi commits its assistant message. */
function streamStamp(block: PiStreamingBlock): string {
  return typeof block.messageTimestamp === 'number' && Number.isFinite(block.messageTimestamp)
    ? new Date(block.messageTimestamp).toISOString()
    : block.at;
}

function lastAssistantOf(entry: PiEntry): LastAssistant | undefined {
  const message = assistantOf(entry);
  if (!message) return undefined;
  const reason = str(message.stopReason), error = str(message.errorMessage);
  return {
    ...(reason ? { r: reason } : {}),
    ...(error ? { e: error } : {}),
    t: entry.timestamp,
  };
}

function endStatus(last: LastAssistant | undefined, cold: boolean): TurnEndStatus | undefined {
  const reason = last?.r;
  if (reason === 'stop' || reason === 'length') return 'completed';
  if (reason === 'error') return 'failed';
  if (reason === 'aborted') return 'cancelled';
  return cold ? 'interrupted' : undefined;
}

function errorOf(last: LastAssistant | undefined, status: TurnEndStatus): string | undefined {
  return status === 'failed' ? last?.e : undefined;
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
      const entry = parseLine(line.text);
      if (entry && isPiPrompt(entry)) return line.start;
    }
    if (from === 0) return 0;
  }
}

/** The root-to-leaf chain of a file, from its last appended entry. */
function chainOf(entries: readonly PiEntry[], leafId: string | undefined): PiEntry[] {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const chain: PiEntry[] = [];
  for (let current = leafId ? byId.get(leafId) : undefined, seen = new Set<string>(); current && !seen.has(current.id);) {
    seen.add(current.id);
    chain.push(current);
    current = typeof current.parentId === 'string' ? byId.get(current.parentId) : undefined;
  }
  chain.reverse();
  return chain;
}

/** One complete read of a session file, used only when the file moved or a branch changed. */
async function loadFile(path: string, nativeSessionId: string): Promise<{
  entries: PiEntry[]; chain: PiEntry[]; leaf?: string; end: number; ends: Map<string, number>;
}> {
  const { lines, end } = await readLines(path, 0, Infinity);
  let headerId: string | undefined;
  let lastTime = new Date(0).toISOString();
  const entries: PiEntry[] = [];
  const ends = new Map<string, number>();
  for (const line of lines) {
    const value = parseLine(line.text);
    if (!value) continue;
    if (value.type === 'session' && typeof (value as Record<string, unknown>).id === 'string') {
      headerId = String((value as Record<string, unknown>).id);
      continue;
    }
    const entry = { ...value, timestamp: isoTime(value.timestamp, lastTime) };
    lastTime = entry.timestamp;
    entries.push(entry);
    ends.set(entry.id, line.end);
  }
  if (headerId && headerId !== nativeSessionId) {
    throw new AppError('INVALID_NATIVE_SESSION_ID', 'The pi session file belongs to another conversation', 400);
  }
  const leaf = entries.at(-1)?.id;
  return { entries, chain: chainOf(entries, leaf), ...(leaf ? { leaf } : {}), end, ends };
}

/** pi's session file of one conversation, read into the session's main lane. */
export class PiTranscriptSource implements TranscriptSource {
  constructor(private readonly options: PiTranscriptOptions) {}

  get sessionId(): string { return this.options.sessionId; }
  get live(): PiLiveFeed | undefined { return this.options.live; }

  identity(): string | undefined { return this.options.nativeSessionId(); }

  async pull(w: LaneWriter, signal: AbortSignal): Promise<{ caughtUp: boolean }> {
    const path = await this.path();
    const size = path ? await sizeOf(path) : undefined;
    if (!path || size === undefined) {
      // pi may stream before it writes a file, or before the prompt's entry reaches it.
      if (this.options.live && w.lane === 'main') this.publish(w, decode(w.cursor) ?? { o: 0 });
      return { caughtUp: true };
    }
    const state = decode(w.cursor) ?? { o: 0 };
    // A moved or truncated file is read again by id, never as another conversation (G8).
    if ((state.p && state.p !== path) || state.o > size) {
      await this.reimport(w, path, state, signal, false);
      return { caughtUp: !signal.aborted };
    }
    let window: number | undefined;
    if (w.cursor === null && !w.scratch && size > PULL_BYTES) {
      window = await tailStart(path, size);
      if (window > 0) w.openScratch();
    }
    const scratch = w.scratch;
    if (scratch && !await this.read(scratch, path, decode(scratch.cursor) ?? { o: window ?? await tailStart(path, size) }, Infinity, signal, true, true)) return { caughtUp: false };
    const caughtUp = await this.read(w, path, decode(w.cursor) ?? { o: 0 }, PULL_BYTES, signal, !scratch, false);
    return { caughtUp: caughtUp && !signal.aborted };
  }

  watch(_w: LaneWriter, wake: () => void): () => void {
    const stop = this.options.live?.watch(() => {
      wake();
      clearTimeout(settle);
      settle = setTimeout(wake, SETTLE_MS);
      settle.unref();
    });
    let settle: NodeJS.Timeout | undefined;
    return () => { clearTimeout(settle); stop?.(); };
  }

  async drain(w: LaneWriter): Promise<void> {
    const path = await this.path();
    if (!path) return;
    const isScratch = w.scratch !== undefined;
    const target = w.scratch ?? w;
    const state = decode(target.cursor) ?? { o: 0 };
    const size = await sizeOf(path);
    if (size !== undefined && ((state.p && state.p !== path) || state.o > size)) {
      const done = await this.reimport(target, path, state, new AbortController().signal, isScratch);
      if (!done && isScratch) await this.reimport(w, path, { o: 0 }, new AbortController().signal, false);
      return;
    }
    const done = await this.read(target, path, state, Infinity, undefined, false, isScratch);
    if (!done && isScratch && w.scratch === undefined) await this.reimport(w, path, { o: 0 }, new AbortController().signal, false);
  }

  /**
   * The process ran a turn it will never end: it exited. What is on disk is read first (G6); then the
   * turn the file leaves open ends as `status`, unless a settle already ended it. The cursor no longer
   * holds it open, so an outcome read later writes nothing.
   */
  async endOpenTurns(w: LaneWriter, status: TurnEndStatus, at: string, error?: string): Promise<string[]> {
    const target = w.scratch ?? w;
    const before = decode(target.cursor);
    const pending = before?.open === true && before.turn ? before.turn : undefined;
    await this.drain(w);
    const state = decode(target.cursor);
    if (!state) return [];
    // drain may have inferred an end from what pi wrote; the process's own outcome replaces it.
    const open = state.open === true && state.turn ? state.turn : pending;
    if (!open) return [];
    const run = state.open === true ? state.run : before?.run;
    const cmd = state.open === true ? state.cmd : before?.cmd;
    const existing = target.turnEndStatus(open);
    if (existing && state.open !== true) target.turnReopened(open, at);
    const retired = (state.d ?? []).map(draft => draft.i);
    Object.assign(state, { open: undefined, turn: undefined, run: undefined, cmd: undefined, last: undefined, d: undefined });
    const outcome: PiTurnOutcome = {
      turnId: open, status, at, ...(error ? { error } : {}),
      ...(cmd ? { commandId: cmd } : {}), ...(run ? { runId: run } : {}),
    };
    const event = projectPiTurnEnd(outcome, {
      sessionId: this.options.sessionId,
      turnId: open,
      ...(cmd ? { commandId: cmd } : {}), ...(run ? { runId: run } : {}),
    });
    target.commit({ events: [event], ...(retired.length ? { retire: retired } : {}), cursor: encode(state, state.o) });
    target.turnEnded(open, status, at, error);
    return [open];
  }

  private async path(): Promise<string | undefined> {
    const nativeSessionId = this.options.nativeSessionId();
    return nativeSessionId ? await this.options.locate(nativeSessionId) : undefined;
  }

  /** Publishes what a running process streams even when its file does not exist or names no prompt yet. */
  private publish(w: LaneWriter, state: ReadState): void {
    new LaneRead(this, w, '', state, true, false, undefined).publishDrafts(state.o);
  }

  /** Reads `path` into `w` from `state`; resolves whether it reached the end. `live` adds what the process knows to a log that serves. */
  private async read(w: LaneWriter, path: string, state: ReadState, limit: number, signal: AbortSignal | undefined, live: boolean, isScratch: boolean): Promise<boolean> {
    return await new LaneRead(this, w, path, state, w.lane === 'main', isScratch, signal).run(limit, live);
  }

  /**
   * A moved, truncated or rewound file: retire the branch it left and project the active chain again.
   * Returns `false` when a scratch writer had to rebuild the lane (caller must stop writing to scratch).
   */
  async reimport(w: LaneWriter, path: string, state: ReadState, signal: AbortSignal | undefined, isScratch = false): Promise<boolean> {
    const nativeSessionId = this.options.nativeSessionId();
    if (!nativeSessionId) return true;
    const loaded = await loadFile(path, nativeSessionId);
    const prevIndex = new Map((state.b ?? []).map((row, index) => [row.i, index]));
    const prevRetired = new Set(state.r);
    let lastExisting = -1;
    let seenNew = false;
    let needsRebuild = false;
    for (const entry of loaded.chain) {
      if (prevRetired.has(entry.id)) { needsRebuild = true; break; }
      const idx = prevIndex.get(entry.id);
      if (idx === undefined) {
        seenNew = true;
      } else {
        if (seenNew || idx < lastExisting) { needsRebuild = true; break; }
        lastExisting = idx;
      }
    }
    if (needsRebuild) {
      w.rebuild('identity-changed');
      if (isScratch) return false;
      state.b = undefined;
      state.d = undefined;
      state.c = undefined;
      state.r = undefined;
      state.open = undefined;
      state.turn = undefined;
    }
    const newIds = new Set(loaded.chain.map(entry => entry.id));
    const retired: string[] = [...(state.d ?? []).map(draft => draft.i)];
    const retiredEntries = new Set(state.r);
    for (const row of state.b ?? []) {
      if (newIds.has(row.i)) continue;
      retiredEntries.add(row.i);
      retired.push(...row.e);
      retired.push(...this.options.live?.superseded?.(row.i) ?? []);
    }
    const at = state.at ?? new Date().toISOString();
    if (state.open === true && state.turn && !newIds.has(state.turn)) w.turnEnded(state.turn, 'interrupted', at);
    Object.assign(state, {
      o: loaded.end, p: path, leaf: loaded.leaf, turn: undefined, open: undefined, run: undefined,
      cmd: undefined, last: undefined, at: loaded.chain.at(-1)?.timestamp ?? at, d: undefined,
      r: retiredEntries.size ? [...retiredEntries] : undefined,
    });
    const projected = loaded.chain.map(entry => ({
      entry,
      events: projectPiEntry(entry, { sessionId: this.options.sessionId }),
      ids: this.eventIds(entry),
      end: loaded.ends.get(entry.id) ?? loaded.end,
    }));
    const kept = new Set(projected.flatMap(item => item.ids));
    const retire = [...new Set(retired)].filter(id => !kept.has(id));
    state.b = loaded.chain.map(entry => ({ i: entry.id, e: this.eventIds(entry) }));

    let events: NativeWorkbenchEvent[] = [];
    let offset = 0;
    let turn: string | undefined;
    let last: LastAssistant | undefined;
    let run: string | undefined;
    let cmd: string | undefined;
    const flush = (next: number) => {
      if (!events.length && !retire.length && encode(state, next) === w.cursor) return;
      w.commit({ events, ...(retire.length ? { retire } : {}), cursor: encode(state, next) });
      events = [];
      retire.length = 0;
    };
    const end = (turnId: string, offsetNow: number) => {
      const outcome = this.outcomeOf(loaded.chain, turnId, true);
      if (!outcome) return;
      const existing = w.turnEndStatus(turnId);
      if (existing === outcome.status) return;
      flush(offsetNow);
      if (existing) w.turnReopened(turnId, outcome.at);
      const command = this.options.live?.command(turnId);
      const event = projectPiTurnEnd({ ...outcome, ...(command?.commandId ? { commandId: command.commandId } : {}), ...(command?.runId ? { runId: command.runId } : {}) }, {
        sessionId: this.options.sessionId, turnId,
        ...(command?.commandId ? { commandId: command.commandId } : {}), ...(command?.runId ? { runId: command.runId } : {}),
      });
      w.commit({ events: [event], cursor: encode(state, offsetNow) });
      w.turnEnded(turnId, outcome.status, outcome.at, outcome.error);
    };

    for (const item of projected) {
      const { entry, events: entryEvents, end: entryEnd } = item;
      const prompt = isPiPrompt(entry);
      if (prompt) {
        if (turn && turn !== entry.id) end(turn, offset);
        flush(offset);
        const command = this.options.live?.command(entry.id);
        w.turnStarted(entry.id, entry.timestamp, command?.runId);
        turn = entry.id;
        run = command?.runId;
        cmd = command?.commandId;
        last = undefined;
      } else if (!turn && (entryEvents.length || entry.type === 'custom_message')) {
        flush(offset);
        w.turnStarted(entry.id, entry.timestamp);
        turn = entry.id;
        run = undefined;
        cmd = undefined;
        last = undefined;
      }
      const options = {
        sessionId: this.options.sessionId,
        ...(turn ? { turnId: turn } : {}),
        ...(run ? { runId: run } : {}), ...(cmd ? { commandId: cmd } : {}),
      };
      events.push(...projectPiEntry(entry, options));
      const assistant = lastAssistantOf(entry);
      if (assistant) last = assistant;
      offset = entryEnd;
      if (events.length >= COMMIT_EVENTS) flush(offset);
    }
    flush(offset);
    if (turn) {
      Object.assign(state, { turn, open: true, ...(run ? { run } : {}), ...(cmd ? { cmd } : {}), ...(last ? { last } : {}) });
      if (this.canInfer(turn)) {
        const outcome = this.outcomeOf(loaded.chain, turn, true);
        if (outcome && w.turnEndStatus(turn) !== outcome.status) {
          if (w.turnEndStatus(turn)) w.turnReopened(turn, outcome.at);
          const event = projectPiTurnEnd({ ...outcome, ...(cmd ? { commandId: cmd } : {}), ...(run ? { runId: run } : {}) }, {
            sessionId: this.options.sessionId, turnId: turn, ...(cmd ? { commandId: cmd } : {}), ...(run ? { runId: run } : {}),
          });
          w.commit({ events: [event], cursor: encode(state, loaded.end) });
          w.turnEnded(turn, outcome.status, outcome.at, outcome.error);
          Object.assign(state, { open: undefined, turn: undefined, run: undefined, cmd: undefined, last: undefined });
        }
      } else if (w.turnEndStatus(turn)) w.turnReopened(turn, new Date().toISOString());
      w.commit({ events: [], cursor: encode(state, loaded.end) });
    }
    if (signal?.aborted) return false;
    return true;
  }

  private outcomeOf(chain: readonly PiEntry[], turnId: string, cold: boolean): PiTurnOutcome | undefined {
    const start = chain.findIndex(entry => entry.id === turnId && isPiPrompt(entry));
    if (start < 0) return undefined;
    let last: LastAssistant | undefined;
    let at = chain[start]!.timestamp;
    for (let index = start + 1; index < chain.length; index += 1) {
      const entry = chain[index]!;
      if (isPiPrompt(entry)) break;
      at = entry.timestamp;
      last = lastAssistantOf(entry) ?? last;
    }
    const status = endStatus(last, cold);
    if (!status) return undefined;
    const error = errorOf(last, status);
    return { turnId, status, at: last?.t ?? at, ...(error ? { error } : {}) };
  }

  /** Whether a turn's end may be inferred from its last assistant message. A live turn waits for agent_settled. */
  canInfer(turnId: string | undefined): boolean {
    const live = this.options.live;
    if (!live) return true;
    if (turnId && live.active?.(turnId) === true) return false;
    if (live.active?.(turnId ?? '') === false) return true;
    return live.running?.() === false;
  }

  /** The ids a committed entry owns; a prompt also owns its turn's outcome row. */
  eventIds(entry: PiEntry): string[] {
    const ids = projectPiEntry(entry, { sessionId: this.options.sessionId }).map(event => event.nativeId);
    if (isPiPrompt(entry)) ids.push(piTurnEndId(entry.id));
    return [...new Set(ids)];
  }
}

/** One read of one file into one lane. Writes outside a commit come after a commit of what precedes them, and replay safely from it. */
class LaneRead {
  private events: NativeWorkbenchEvent[] = [];
  private retired: string[] = [];

  constructor(
    private readonly source: PiTranscriptSource,
    private readonly w: LaneWriter,
    private readonly path: string,
    readonly state: ReadState,
    /** The conversation's own lane: its turns are runs, with outcomes to show. */
    private readonly main: boolean,
    private readonly isScratch: boolean,
    private readonly signal: AbortSignal | undefined,
  ) {}

  async run(limit: number, live: boolean): Promise<boolean> {
    if (!this.state.p) this.state.p = this.path;
    const { lines, end, eof } = await readLines(this.path, this.state.o, limit);
    let offset = this.state.o;
    let slice = performance.now();
    for (const line of lines) {
      if (this.signal?.aborted) { this.flush(offset); return false; }
      const entry = parseLine(line.text);
      if (entry?.type !== 'session') {
        if (entry && this.state.leaf && entry.parentId !== this.state.leaf) {
          this.flush(line.start);
          return await this.source.reimport(this.w, this.path, this.state, this.signal, this.isScratch);
        }
        if (entry) this.entry(entry, line.start);
      }
      offset = line.end;
      if (this.events.length >= COMMIT_EVENTS || performance.now() - slice >= SLICE_MS) this.flush(offset);
      if (performance.now() - slice >= SLICE_MS) {
        await new Promise(resolve => setImmediate(resolve));
        slice = performance.now();
      }
    }
    this.flush(end);
    this.state.o = end;
    // A read that reaches EOF may end the turn the file leaves open; a live one waits for agent_settled.
    if (eof && this.main) this.finishCold(end);
    if (live && eof && this.main) this.publishDrafts(end);
    return eof;
  }

  /** Commits what was read before `offset`, and `extra`, with the cursor at `offset`. */
  private flush(offset: number, extra: NativeWorkbenchEvent[] = [], retire: string[] = []): void {
    const events = [...this.events, ...extra];
    const gone = [...this.retired, ...retire];
    const cursor = encode(this.state, offset);
    if (events.length || gone.length || cursor !== this.w.cursor) this.w.commit({ events, ...(gone.length ? { retire: gone } : {}), cursor });
    this.events = [];
    this.retired = [];
  }

  /** One committed entry: its turn, its rows, and what it says of the turn's outcome. */
  private entry(entry: PiEntry, at: number): void {
    const { state, w } = this;
    const prompt = isPiPrompt(entry);
    const command = prompt ? this.source.live?.command(entry.id) : undefined;
    if (prompt) {
      const previous = state.open === true ? state.turn : undefined;
      if (previous && previous !== entry.id) {
        this.flush(at);
        this.endInferred(previous, at);
      }
      this.flush(at);
      w.turnStarted(entry.id, entry.timestamp, command?.runId);
      Object.assign(state, { turn: entry.id, open: true as const, run: command?.runId, cmd: command?.commandId, last: undefined });
    }
    const projected = projectPiEntry(entry, {
      sessionId: this.source.sessionId,
      ...(state.turn ? { turnId: state.turn } : {}),
      ...(state.run ? { runId: state.run } : {}), ...(state.cmd ? { commandId: state.cmd } : {}),
    });
    if (!state.turn && (projected.length || entry.type === 'custom_message')) {
      this.flush(at);
      w.turnStarted(entry.id, entry.timestamp);
      Object.assign(state, { turn: entry.id, open: true as const, run: undefined, cmd: undefined, last: undefined });
      this.events.push(...projectPiEntry(entry, { sessionId: this.source.sessionId, turnId: entry.id }));
    } else {
      this.events.push(...projected);
    }
    const assistant = lastAssistantOf(entry);
    if (assistant) state.last = assistant;
    const owned = this.source.eventIds(entry);
    const known = state.b?.findIndex(row => row.i === entry.id) ?? -1;
    if (known >= 0) state.b![known] = { i: entry.id, e: owned };
    else (state.b ??= []).push({ i: entry.id, e: owned });
    // A committed assistant entry replaces the provisional drafts of its message; the assistant
    // message's own time is the identity, since the entry's line time may differ.
    const committed = new Set(projected.map(event => event.nativeId));
    const superseded = this.source.live?.superseded?.(entry.id) ?? [];
    const stamp = assistant ? messageStamp(entry) ?? entry.timestamp : undefined;
    if (stamp) {
      const kept = (state.c ?? []).filter(value => value !== stamp);
      state.c = [...kept, stamp].slice(-8);
    }
    const provisional = stamp ? (state.d ?? []).filter(draft => draft.t === stamp && !committed.has(draft.i)) : [];
    if (provisional.length) state.d = state.d!.filter(draft => draft.t !== stamp);
    this.retired.push(...provisional.map(draft => draft.i), ...superseded.filter(id => !committed.has(id)));
    state.leaf = entry.id;
    state.at = entry.timestamp;
  }

  /** Ends a turn whose next prompt (or the end of the file) says it is over. */
  private endInferred(turnId: string, at: number): void {
    const { state, w } = this;
    const existing = w.turnEndStatus(turnId);
    const retired = (state.d ?? []).map(draft => draft.i);
    // Capture the turn's last message and run before clearing the state they are read from.
    const last = state.last, run = state.run, cmd = state.cmd;
    const when = last?.t ?? state.at ?? new Date().toISOString();
    Object.assign(state, { open: undefined, turn: undefined, run: undefined, cmd: undefined, last: undefined, d: undefined });
    if (existing) {
      if (retired.length) this.flush(at, [], retired);
      return;
    }
    const status = endStatus(last, true) ?? 'interrupted';
    const error = errorOf(last, status);
    const outcome: PiTurnOutcome = {
      turnId, status, at: when, ...(error ? { error } : {}),
      ...(cmd ? { commandId: cmd } : {}), ...(run ? { runId: run } : {}),
    };
    this.flush(at, [projectPiTurnEnd(outcome, {
      sessionId: this.source.sessionId, turnId,
      ...(cmd ? { commandId: cmd } : {}), ...(run ? { runId: run } : {}),
    })], retired);
    w.turnEnded(turnId, status, when, error);
  }

  /** Ends the turn the file leaves open when no process is running; a live one waits for agent_settled. */
  private finishCold(end: number): void {
    const { state } = this;
    if (state.open !== true || !state.turn) return;
    if (!this.source.canInfer(state.turn)) return;
    this.flush(end);
    this.endInferred(state.turn, end);
  }

  /** Streamed text pi has not committed, under the ids its blocks will have. */
  publishDrafts(offset: number): void {
    const { state, w } = this;
    this.finishCold(offset);
    const blocks = this.source.live?.streaming() ?? [];
    if (!blocks.length) return;
    const drafts = new Map<string, NativeWorkbenchEvent>();
    const provisional: Array<{ i: string; t: string }> = [];
    const committed = new Set(state.c ?? []);
    for (const block of blocks) {
      if (!block.text) continue;
      // A block whose message is already committed must not come back as a stale draft.
      if (!block.entryId && committed.has(streamStamp(block))) continue;
      // A provisional row is keyed by the assistant step, so the next step does not overwrite it.
      const finalId = block.entryId ? piBlockEventId(block.entryId, block.contentIndex) : `draft:${block.key}`;
      if (drafts.has(finalId)) continue;
      const type = block.thought ? 'agent_thought_chunk' : 'agent_message_chunk';
      const turnId = state.turn ?? block.turnId;
      const runId = state.run ?? block.runId;
      drafts.set(finalId, {
        sequence: 0,
        sessionId: this.source.sessionId,
        ...(runId ? { runId } : {}),
        type,
        createdAt: block.at,
        nativeId: finalId,
        ...(turnId ? { nativeTurnId: turnId } : {}),
        data: { sessionUpdate: type, content: { type: 'text', text: block.text }, ...(block.thought ? { channel: 'thinking' } : {}) },
      });
      if (!block.entryId) provisional.push({ i: finalId, t: streamStamp(block) });
    }
    if (!drafts.size) return;
    const seen = new Map((state.d ?? []).map(draft => [draft.i, draft.t]));
    for (const draft of provisional) seen.set(draft.i, draft.t);
    state.d = [...seen].map(([i, t]) => ({ i, t }));
    w.commit({ events: [], drafts: [...drafts].map(([finalId, event]) => ({ finalId, event })), cursor: encode(state, offset) });
  }
}
