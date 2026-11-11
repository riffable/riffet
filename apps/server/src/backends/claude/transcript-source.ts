import { open, readdir, readFile, stat, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type { NativeActivity, NativeWorkbenchEvent, Run, Session } from '../../../../../packages/contracts/src/index.js';
import { SYNC_BUDGET } from '../../../../../packages/contracts/src/sync.js';
import { activityId, activityOfEvent, isLiveActivity } from '../../journal/activity.js';
import type { LaneWriter, SubagentInfo, TranscriptSource, TurnEndStatus } from '../../journal/ingest.js';
import { ClaudeActivities, readTaskOutputTail, type ClaudeActivitiesState } from './activity.js';
import {
  claudePromptKey, claudeRowOwesStep, claudeRowSignals, mapRow, parseRow, subagentSettles, subagentWake,
  type ClaudeRow, type ClaudeTask, type ClaudeTranscriptHooks, type MapperState, type ToolCall,
} from './history.js';

/*
 * Claude Code's transcript as the session journal reads it (docs/SYNC-V3.md, 写入契约). The CLI only
 * appends to `<projects>/<dir>/<sessionId>.jsonl`, so a lane's cursor is a byte offset into the file, the
 * file's identity (inode, and the bytes just before the offset) and what mapping a row needs from the
 * rows before it: the open turn, unanswered tool calls, the task plan and the system activities. Rows
 * are mapped by `mapRow`, the mapping the live view uses, so every entity is keyed by the row's own
 * `uuid` and content part and reading a line again writes nothing. Subagents are read from their own
 * `subagents/agent-<id>.jsonl` into a lane per spawning tool call.
 */

/** A pull reads about this much, so a long import goes in steps that leave the event loop free. */
const PULL_BYTES = 4 * 1024 * 1024;
const READ_CHUNK = 1024 * 1024;
/** Rows per commit within a stretch that has no turn boundary or activity. */
const COMMIT_EVENTS = 256;
/**
 * The longest a read keeps the event loop between two rows. Rows that change an activity commit one at a time (a
 * Monitor printing thousands of events), so a megabyte of them is far more than a megabyte of anything else. A
 * step after a file read and the one after it run in the same turn of the loop, so other work waits up to twice this.
 */
const STEP_MS = 25;
const giveWay = () => new Promise<void>(resolve => setImmediate(resolve));
/** A tail window holds at least what the largest snapshot a client may ask for needs (G4). */
const TAIL_ROWS = SYNC_BUDGET.snapshot.maxRows;
const TAIL_BYTES = SYNC_BUDGET.snapshot.maxBytes;
/** How far back a tail window is looked for: a transcript with less conversation than that in it starts at its first prompt there. */
const TAIL_SCAN_BYTES = 8 * PULL_BYTES;
const PROBE_BYTES = 32;
/** What a cursor carries at most: ended activities, unanswered calls (and their text), recent turn keys. */
const RETAIN_ENDED = 16;
const OPEN_CALLS = 256;
const CALL_TEXT = 4096;
const RECENT_TURNS = 16;
const QUEUE_RECEIPTS = 64;
/** Rows without a time of their own (rare) are stamped with this, never with when they were read. */
const NO_TIME = new Date(0).toISOString();
/** Every other row type is Claude's own bookkeeping (requests, modes, titles) and maps to nothing; such lines are not parsed. */
const MAPPED_TYPES = new Set(['user', 'assistant', 'system', 'attachment', 'queue-operation']);
const EMPTY = Buffer.alloc(0);

export interface ClaudeTranscriptSourceOptions {
  /** The workbench session the events are stamped with. */
  sessionId: string;
  /** Claude's session id now; a launch that had to start over gets a new one. */
  nativeSessionId(): string | undefined;
  /** The ids the conversation ran under before, oldest first: their transcripts lead it (`Session.previousNativeSessionIds`). */
  previousNativeSessionIds?(): readonly string[];
  /** The transcript file of a Claude session, once the CLI has written one. */
  locate(nativeSessionId: string): Promise<string | undefined>;
  /** Calls `wake` when the CLI may have written something (a hook, the runtime's transcript poll); returns how to stop. */
  watch?(wake: () => void): () => void;
  /**
   * Since when the CLI writing the conversation is known to be gone, while it is: what it left open never ends on its
   * own. Undefined while it may be running, or nothing knows.
   */
  exited?(): string | undefined;
  /** What a running conversation knows about its rows; nothing that acts on the CLI. */
  hooks?: Pick<ClaudeTranscriptHooks, 'additionalContext' | 'commandForUserMessage' | 'promptText' | 'putBlob'> & {
    /** Persisted input fences survive the runtime and the journal's read cursor. */
    inputRuns?: () => readonly Run[];
    inputReceipt?: (event: NativeWorkbenchEvent) => void;
    /** Native input queue receipts use this file's durable byte boundary, never the model's response text. */
    queuedInput?: (row: ClaudeRow, position: { offset: number; inode?: number; receipt?: QueueReceipt }) => NativeWorkbenchEvent[];
  };
}

/** The journal turn rows go to. `c`: opened by `/compact`; `s`: by another slash command; `p`: the CLI's prompt id. */
interface Turn { k: string; open: boolean; p?: string; c?: 1; s?: 1; a?: 1 }
/**
 * A write outside a commit (a turn mark, an activity state), made right after the commit of the row that
 * caused it. The commit's cursor lists them, so a read that stopped in between makes them again (G7).
 */
type Op = ['end', string, TurnEndStatus, string, string?] | ['start', string, string] | ['act', string, string];
/** `mapRow`'s state between rows. Tool calls keep only what their result needs. */
interface MapperSnapshot { n?: string; u?: string; q?: string; c?: Array<[string, ToolCall]>; k?: ClaudeTask[]; x?: ClaudeActivitiesState }
interface QueueReceipt { nativeId: string; runId: string; commandId: string }
interface LaneState { m: MapperSnapshot; t?: Turn; r?: string[]; d?: 1; x?: Op[]; q?: Array<{ key?: string; receipt?: QueueReceipt; dequeued?: 1; consumed?: 1 }> }
/** File `f` of the conversation's transcripts, read up to byte `o`; `i` and `p` are the inode and the bytes before `o` it was read with. */
interface Cursor { v: 1; f: number; o: number; i?: number; p?: string; s: LaneState }

/** Older cursors kept the previous mapper identity when output continued after a control-path stop. */
function cursorTurn(state: LaneState): Turn | undefined {
  const turn = state.t;
  return turn && !turn.p && !turn.a && state.m.n && turn.k.startsWith('claude-turn:')
    && turn.k !== state.m.n && turn.k !== state.m.u ? { ...turn, p: state.m.n, a: 1 } : turn;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function decode(cursor: string | null): Cursor | undefined {
  if (cursor === null) return undefined;
  try {
    const value = JSON.parse(cursor) as Cursor;
    return value?.v === 1 && Number.isSafeInteger(value.f) && value.f >= 0 && Number.isSafeInteger(value.o) && value.o >= 0 && record(value.s) ? value : undefined;
  } catch { return undefined; }
}

const fresh = (f: number, o: number): Cursor => ({ v: 1, f, o, s: { m: {} } });

/** The calls a result may still answer, holding only the input fields a result reads (`mapRow`, `launchOf`). */
class OpenCalls extends Map<string, ToolCall> {
  override set(id: string, call: ToolCall): this {
    const input: Record<string, unknown> = {};
    for (const key of ['file_path', 'subject', 'taskId', 'status', 'description', 'command']) {
      const value = call.input[key];
      if (typeof value === 'string') input[key] = value.length > CALL_TEXT ? value.slice(0, CALL_TEXT) : value;
    }
    this.delete(id);
    super.set(id, { name: call.name, input, ...(call.runId ? { runId: call.runId } : {}), ...(call.nativeTurnId ? { nativeTurnId: call.nativeTurnId } : {}) });
    while (this.size > OPEN_CALLS) this.delete(this.keys().next().value!);
    return this;
  }
}

/** One line: unparsed when its type leads it and is one that maps to nothing, `undefined` when it is not a row. */
function parseLine(bytes: Buffer): ClaudeRow | undefined {
  if (bytes.length > 9 && bytes.toString('latin1', 0, 9) === '{"type":"') {
    const close = bytes.indexOf(0x22, 9);
    if (close > 9 && close < 64 && !MAPPED_TYPES.has(bytes.toString('latin1', 9, close))) return undefined;
  }
  const text = bytes.toString('utf8').trimEnd();
  if (!text) return undefined;
  try { return parseRow(text); } catch { return undefined; }
}

/** The complete lines of `bytes`, which start at file offset `from`; a fragment before the first newline is dropped when `partial`. */
function linesOf(bytes: Buffer, from: number, partial: boolean): Array<{ start: number; bytes: Buffer }> {
  const lines: Array<{ start: number; bytes: Buffer }> = [];
  let at = partial ? bytes.indexOf(0x0a) + 1 : 0;
  if (partial && at === 0) return lines;
  for (let newline = bytes.indexOf(0x0a, at); newline >= 0; newline = bytes.indexOf(0x0a, at)) {
    lines.push({ start: from + at, bytes: bytes.subarray(at, newline + 1) });
    at = newline + 1;
  }
  return lines;
}

async function readRange(handle: FileHandle, from: number, to: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(Math.max(0, to - from));
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, from + filled);
    if (!bytesRead) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/** What a receipt scan keeps of a transcript suffix, in file order: the CLI's queue moves and its prompt rows. */
type SuffixStep =
  | { op: 'enqueue'; offset: number; at: number; text?: string }
  | { op: 'dequeue' }
  | { op: 'popAll' }
  | { op: 'remove'; text?: string }
  | { op: 'prompt'; offset: number; event?: NativeWorkbenchEvent };

/** A human prompt of the suffix; `queued` when the CLI ran it from its queue, placed at the row that queued it. */
interface SuffixPrompt { event: NativeWorkbenchEvent; offset: number; at: number; queued?: true }

function promptText(event: NativeWorkbenchEvent): string | undefined {
  const text = (event.data.content as { text?: unknown } | undefined)?.text;
  return typeof text === 'string' ? text : undefined;
}

/**
 * The human prompts of a transcript suffix, each placed where the CLI took it in. A prompt the CLI ran
 * from its own input queue stands at the row that queued it: that is the position and time a dispatch
 * fence is compared with, and the prompt row itself may come long after a later send. What the queue
 * held when the suffix begins is not in it, so it is inferred first: a dequeue or remove the suffix's
 * own enqueues cannot answer took an input queued earlier, and that many unknown inputs are put ahead.
 * A prompt run from an unknown input, or whose text is not the one queued, is left out.
 */
function suffixPrompts(steps: readonly SuffixStep[]): SuffixPrompt[] {
  const replay = (unknown: number) => {
    const queue: Array<{ offset?: number; at?: number; text?: string; dequeued?: true }> = Array.from({ length: unknown }, () => ({}));
    const users: SuffixPrompt[] = [];
    let missing = 0;
    for (const step of steps) {
      if (step.op === 'enqueue') queue.push({ offset: step.offset, at: step.at, ...(step.text !== undefined ? { text: step.text } : {}) });
      else if (step.op === 'popAll') queue.length = 0;
      else if (step.op === 'dequeue') {
        const input = queue.find(item => !item.dequeued);
        if (input) input.dequeued = true; else missing += 1;
      } else if (step.op === 'remove') {
        let index = step.text === undefined ? -1 : queue.findIndex(item => !item.dequeued && item.text === step.text);
        if (index < 0) index = queue.findIndex(item => !item.dequeued && item.text === undefined);
        if (index >= 0) queue.splice(index, 1); else missing += 1;
      } else {
        const index = queue.findIndex(item => item.dequeued);
        const input = index >= 0 ? queue.splice(index, 1)[0] : undefined;
        const text = step.event && promptText(step.event);
        if (!step.event || text === undefined) continue;
        if (!input) users.push({ event: step.event, offset: step.offset, at: Date.parse(step.event.createdAt) });
        else if (input.offset !== undefined && input.text !== undefined && claudePromptKey(input.text) === claudePromptKey(text)) {
          users.push({ event: step.event, offset: input.offset, at: input.at!, queued: true });
        }
      }
    }
    return { users, missing };
  };
  const first = replay(0);
  return first.missing ? replay(first.missing).users : first.users;
}

async function openFile(path: string): Promise<FileHandle | undefined> {
  try { return await open(path, 'r'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Whether `path` is still the file `cursor` was read from, as it was: Claude only appends (G8). Unknown files pass. */
async function sameFile(path: string | undefined, cursor: Cursor | undefined): Promise<boolean> {
  if (!path || !cursor || (cursor.o === 0 && cursor.i === undefined)) return true;
  const handle = await openFile(path);
  if (!handle) return true;
  try {
    const { ino, size } = await handle.stat();
    if (cursor.i !== undefined && cursor.i !== ino) return false;
    if (size < cursor.o) return false;
    if (!cursor.p) return true;
    const probe = Buffer.from(cursor.p, 'base64');
    return (await readRange(handle, cursor.o - probe.length, cursor.o)).equals(probe);
  } finally { await handle.close(); }
}

/**
 * Where a first import's tail window starts (G4): at a prompt, so every turn in it is whole, holding at
 * least the rows or bytes of the largest snapshot; 0 when the whole file is that small.
 */
async function tailStart(path: string): Promise<number> {
  const handle = await openFile(path);
  if (!handle) return 0;
  try {
    const { size } = await handle.stat();
    for (let span = PULL_BYTES; ; span *= 2) {
      const from = Math.max(0, size - span);
      const lines = linesOf(await readRange(handle, from, size), from, from > 0);
      let rows = 0, bytes = 0, earliest = 0, since = performance.now();
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (performance.now() - since > STEP_MS) { await giveWay(); since = performance.now(); }
        const line = lines[index]!;
        const row = parseLine(line.bytes);
        if (!row || row.isSidechain === true) continue;
        if (row.type === 'user' || row.type === 'assistant') { rows += 1; bytes += line.bytes.length; }
        if (!claudeRowSignals(row).some(signal => signal.type === 'prompt')) continue;
        earliest = line.start;
        if (rows >= TAIL_ROWS || bytes >= TAIL_BYTES) return line.start;
      }
      if (from === 0) return 0;
      if (span >= TAIL_SCAN_BYTES) return earliest;
    }
  } finally { await handle.close(); }
}

/** `background`: launched to outlive its turn, so it is an activity of the main lane too; `at`: when the metadata was last written. */
interface SubagentMeta {
  agentId: string; toolUseId: string; parentAgentId?: string; finished: boolean; stopped: boolean; background: boolean; at: string; file: string; meta: string;
  info: SubagentInfo;
}

/**
 * The conversation's transcripts, read into its lanes: `main` from the session file (and, before it, the
 * files of the ids it ran under earlier), `sub:<toolCallId>` from each subagent's own file.
 */
export class ClaudeTranscriptSource implements TranscriptSource {
  /** Where each Claude session's file was found; a file that went is looked for again. */
  private readonly located = new Map<string, string>();
  /** Subagent metadata as last read, by file, and the lane writers handed out for the main writer of one generation. */
  private readonly metas = new Map<string, { mtimeMs: number; size: number; meta?: SubagentMeta }>();
  private lanes?: { owner: LaneWriter; generation: string; writers: Map<string, LaneWriter>; bound: Map<string, { spawner: LaneWriter; info: string }>; read: Map<string, string> };

  private readonly inputCommands = new Map<string, string>();
  private inputScan?: string;
  private readonly repairedInputs = new Set<string>();

  constructor(private readonly options: ClaudeTranscriptSourceOptions) {}

  get sessionId(): string { return this.options.sessionId; }
  get hooks(): NonNullable<ClaudeTranscriptSourceOptions['hooks']> {
    const hooks = this.options.hooks ?? {};
    return { ...hooks, commandForUserMessage: hooks.inputRuns
      ? message => this.inputCommands.get(message.uuid)
      : hooks.commandForUserMessage };
  }

  identity(): string | undefined {
    const current = this.options.nativeSessionId();
    return current ? [...(this.options.previousNativeSessionIds?.() ?? []), current].join(' ') : undefined;
  }

  /** The `Session` the mapping stamps rows with; ids derive from the current Claude session. */
  session(): Session {
    return { id: this.options.sessionId, nativeSessionId: this.options.nativeSessionId(), updatedAt: NO_TIME } as Session;
  }

  async pull(w: LaneWriter, signal: AbortSignal): Promise<{ caughtUp: boolean }> {
    const files = await this.files();
    const current = files.at(-1);
    if (!current) return { caughtUp: true };
    for (const target of [w, w.scratch]) {
      const cursor = target ? decode(target.cursor) : undefined;
      if (cursor && !await sameFile(files[cursor.f], cursor)) { w.rebuild('identity-changed'); break; }
    }
    const receipts = await this.recoverInputs(current, signal);
    const metas = await this.subagents(current);
    await this.window(w, files, metas, signal);
    if (signal.aborted) return { caughtUp: false };
    const { done } = await this.read(w, files, decode(w.cursor) ?? fresh(0, 0), PULL_BYTES, metas, signal);
    this.publishInputs(w, receipts);
    const children = await this.children(w, metas, PULL_BYTES, signal);
    return { caughtUp: done && children && !signal.aborted };
  }

  watch(_w: LaneWriter, wake: () => void): () => void {
    return this.options.watch?.(wake) ?? (() => undefined);
  }

  async drain(w: LaneWriter): Promise<void> {
    const files = await this.files();
    const current = files.at(-1);
    if (!current) return;
    const receipts = await this.recoverInputs(current);
    const metas = await this.subagents(current);
    // A lane never read gets its tail window like a first pull would, not a whole import in one go (G4).
    if (!await this.window(w, files, metas)) await this.read(w, files, decode(w.cursor) ?? fresh(0, 0), Infinity, metas);
    this.publishInputs(w, receipts);
    await this.children(w, metas, Infinity);
  }

  /**
   * Ends the turn rows go to, for the control path when the transcript will not (the CLI took a prompt back
   * without a row): reads what is on disk first (G6), and records the end in the cursor so a row read later
   * opens a turn of its own. With `promptId`, only if the open turn is that prompt's; without, whatever turn
   * is open, which only a caller that knows nothing will write to it may want (a CLI that is gone ends its
   * turn through `exited` instead). A lane nothing was read into has no turn to end. Returns the turn ended.
   */
  async endTurn(w: LaneWriter, status: TurnEndStatus, at: string, promptId?: string): Promise<string | undefined> {
    await this.drain(w);
    const target = w.scratch ?? w;
    const cursor = decode(target.cursor);
    const turn = cursor && cursorTurn(cursor.s);
    if (!cursor || !turn?.open || (promptId !== undefined && turn.p !== promptId && turn.k !== promptId)) return undefined;
    cursor.s.t = turn;
    target.turnEnded(turn.k, status, at);
    turn.open = false;
    target.commit({ events: [], cursor: JSON.stringify(cursor) });
    return turn.k;
  }

  /**
   * A compaction its PreCompact hook announced before any row of it, written as the lane's own activity after what is
   * on disk, so the boundary read later completes the same one.
   */
  async compactionHooked(w: LaneWriter, id: string, trigger: 'manual' | 'auto', at: string): Promise<void> {
    await this.drain(w);
    const target = w.scratch ?? w;
    const cursor = decode(target.cursor);
    if (cursor) new LaneRead(this, target, cursor, true).compactionHooked(id, trigger, at);
  }

  /** A control-path end survives a missing JSONL marker; only that exact, already-read prompt is closed. */
  closedPrompt(w: LaneWriter, promptId: string): boolean {
    const state = decode((w.scratch ?? w).cursor)?.s;
    const turn = state && cursorTurn(state);
    return turn?.open === false && (turn.p === promptId || turn.k === promptId);
  }

  /** The execution grouping clients read, including continued output after a control-path end. */
  activeTurn(w: LaneWriter): { turnId: string; promptId?: string } | undefined {
    const state = decode((w.scratch ?? w).cursor)?.s;
    const turn = state && cursorTurn(state);
    return turn?.open ? { turnId: turn.k, ...(turn.p ? { promptId: turn.p } : {}) } : undefined;
  }

  /**
   * A receipt is established from the complete file suffix, never the row currently being mapped.
   * Every later write (including cancelled/acknowledged writes) fences off the previous input.
   * Both sides must be unique: two native prompts or equal Run boundaries are left unresolved.
   */
  private async recoverInputs(path: string, signal?: AbortSignal): Promise<Array<{ event: NativeWorkbenchEvent; run: Run }>> {
    const runs = this.options.hooks?.inputRuns?.();
    const nativeSessionId = this.options.nativeSessionId();
    if (!runs || !nativeSessionId) return [];
    const fences = runs.flatMap(run => {
      const native = run.native;
      if (native?.backendId !== 'claude' || native.nativeSessionId !== nativeSessionId || !native.nativeInputBoundary) return [];
      try {
        const fence = record(JSON.parse(native.nativeInputBoundary));
        if (fence?.type !== 'claude-transcript' || fence.nativeSessionId !== nativeSessionId
          || !Number.isSafeInteger(fence.offset) || (fence.offset as number) < 0
          || (fence.inode !== undefined && typeof fence.inode !== 'number')) return [];
        return [{ run, offset: fence.offset as number, inode: fence.inode as number | undefined }];
      } catch { return []; }
    });
    const handle = await openFile(path);
    if (!handle) return [];
    try {
      const { ino, size, mtimeMs } = await handle.stat();
      const compatible = fences.filter(fence => fence.inode === undefined || fence.inode === ino);
      // A later fence beyond EOF means this inode was truncated; no earlier fence remains proof.
      if (compatible.some(fence => fence.offset > size)) { this.inputCommands.clear(); this.inputScan = undefined; return []; }
      const key = JSON.stringify([nativeSessionId, ino, size, mtimeMs, compatible.map(({ run, offset }) =>
        [run.id, offset, run.native!.nativeMessageId, run.native!.delivery, run.native!.stage])]);
      if (key === this.inputScan) return [];
      const eligible = compatible.filter(({ run }) => !run.native!.slashCommand && run.native!.intent !== 'steer'
        && (run.native!.nativeMessageId
          ? run.native!.nativeMessageId.startsWith(`claude:${nativeSessionId}:`) && !run.native!.nativeMessageId.startsWith(`claude:${nativeSessionId}:queue:`)
            && !this.repairedInputs.has(`${run.id}:${run.native!.nativeMessageId}`)
          : ['dispatching', 'input_sent', 'uncertain'].includes(run.native!.delivery)));
      this.inputCommands.clear();
      for (const { run } of compatible) {
        const id = run.native!.nativeMessageId;
        const prefix = `claude:${nativeSessionId}:`;
        if (id?.startsWith(prefix) && id.endsWith(':0') && !id.startsWith(`${prefix}queue:`)) this.inputCommands.set(id.slice(prefix.length, -2), run.commandId);
      }
      if (!eligible.length) { this.inputScan = key; return []; }
      const from = Math.min(...eligible.map(fence => fence.offset));
      // A fence captured in the middle of an unfinished JSONL row must not make that row claimable.
      const partial = from > 0 && (await readRange(handle, from - 1, from))[0] !== 0x0a;
      const steps: SuffixStep[] = [];
      let at = from, buffer = EMPTY, skipPartial = partial;
      while (at < size) {
        if (signal?.aborted) return [];
        const chunk = await readRange(handle, at, Math.min(size, at + Math.max(READ_CHUNK, buffer.length)));
        if (!chunk.length) break;
        const joined = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
        const start = at - buffer.length;
        const lines = linesOf(joined, start, skipPartial);
        for (const line of lines) {
          const row = parseLine(line.bytes);
          if (!row || row.isSidechain === true || row.agentId !== undefined
            || (row.sessionId !== undefined && row.sessionId !== nativeSessionId)) continue;
          if (row.type === 'queue-operation') {
            const text = typeof row.content === 'string' ? row.content : undefined;
            if (row.operation === 'enqueue') steps.push({ op: 'enqueue', offset: line.start, at: Date.parse(String(row.timestamp)), ...(text !== undefined ? { text } : {}) });
            else if (row.operation === 'dequeue') steps.push({ op: 'dequeue' });
            else if (row.operation === 'popAll') steps.push({ op: 'popAll' });
            else if (row.operation === 'remove') steps.push({ op: 'remove', ...(text !== undefined ? { text } : {}) });
            continue;
          }
          if (row.type !== 'user') continue;
          const prompt = claudeRowSignals(row).some(signal => signal.type === 'prompt');
          const human = typeof row.uuid === 'string' && row.isMeta !== true && row.isCompactSummary !== true && row.isVisibleInTranscriptOnly !== true
            && (record(row.origin)?.kind === undefined || record(row.origin)?.kind === 'human');
          const mapper: MapperState = { turnAt: '', calls: new Map(), tasks: new Map(), activities: new ClaudeActivities(this.sessionId) };
          const event = human ? mapRow(row, line.start, { ...this.session(), nativeSessionId }, mapper, { unbounded: true }, false).find(event => event.type === 'user_message_chunk') : undefined;
          if (prompt || event) steps.push({ op: 'prompt', offset: line.start, ...(event ? { event: { ...event, sequence: 0 } } : {}) });
        }
        const last = joined.lastIndexOf(0x0a);
        if (last >= 0) { buffer = joined.subarray(last + 1); skipPartial = false; }
        else buffer = joined;
        at += chunk.length;
        await giveWay();
      }
      if (nativeSessionId !== this.options.nativeSessionId()) { this.inputCommands.clear(); return []; }
      const users = suffixPrompts(steps);
      const matches = eligible.map(fence => {
        const native = fence.run.native!;
        const next = compatible.filter(other => other.offset > fence.offset).reduce((limit, other) => Math.min(limit, other.offset), Infinity);
        const at = native.timings?.dispatchAt;
        const candidates = users.filter(user => {
          if (native.nativeMessageId) return user.event.nativeId === native.nativeMessageId;
          if (compatible.some(other => other.run.native!.nativeMessageId === user.event.nativeId)
            || compatible.filter(other => other.offset === fence.offset).length !== 1
            || user.offset < fence.offset || user.offset >= next || at === undefined || !Number.isFinite(at)
            || !Number.isFinite(user.at) || user.at < at
            // A queued input is the queue receipt's to claim; this only settles one whose send was left unknown.
            || user.queued && native.delivery !== 'uncertain') return false;
          const text = promptText(user.event);
          return text !== undefined && claudePromptKey(text) === claudePromptKey(native.renderedText ?? native.input.text);
        });
        return { run: fence.run, candidates };
      });
      const receipts: Array<{ event: NativeWorkbenchEvent; run: Run }> = [];
      for (const match of matches) {
        if (match.candidates.length !== 1) continue;
        const user = match.candidates[0]!;
        if (matches.filter(other => other.candidates.some(candidate => candidate.event.nativeId === user.event.nativeId)).length !== 1) continue;
        const event = { ...user.event, data: { ...user.event.data, commandId: match.run.commandId } };
        this.inputCommands.set(event.nativeAliases![0]!, match.run.commandId);
        receipts.push({ event, run: match.run });
      }
      this.inputScan = key;
      return receipts;
    } finally { await handle.close(); }
  }

  /** Repair already-ingested rows before announcing their receipt; the input itself is never replayed. */
  private publishInputs(writer: LaneWriter, receipts: Array<{ event: NativeWorkbenchEvent; run: Run }>): void {
    for (const { event, run } of receipts) {
      if (run.native?.nativeSessionId !== this.options.nativeSessionId()) { this.inputScan = undefined; continue; }
      const w = writer.scratch ?? writer;
      if (!w.canReproject(event)) { this.inputScan = undefined; continue; }
      w.commit({ events: [event], cursor: w.cursor!, reproject: true });
      const nativeTurnId = event.nativeTurnId ?? event.runId!;
      if (!w.turnEndStatus(nativeTurnId)) w.turnStarted(nativeTurnId, event.createdAt, run.id);
      this.repairedInputs.add(`${run.id}:${event.nativeId}`);
      this.options.hooks?.inputReceipt?.({ ...event, runId: run.id, nativeTurnId,
        type: 'native_input_receipt', data: { commandId: run.commandId, nativeSessionId: this.options.nativeSessionId() } });
    }
  }

  private async files(): Promise<Array<string | undefined>> {
    const current = this.options.nativeSessionId();
    if (!current) return [];
    const ids = [...(this.options.previousNativeSessionIds?.() ?? []), current];
    const paths = await Promise.all(ids.map(async id => {
      const known = this.located.get(id);
      if (known && await stat(known).then(info => info.isFile(), () => false)) return known;
      const found = await this.options.locate(id);
      if (found) this.located.set(id, found); else this.located.delete(id);
      return found;
    }));
    return paths.at(-1) ? paths : [];
  }

  private async totalSize(files: ReadonlyArray<string | undefined>): Promise<number> {
    const sizes = await Promise.all(files.map(file => file ? stat(file).then(info => info.size, () => 0) : 0));
    return sizes.reduce((sum, size) => sum + size, 0);
  }

  /**
   * The tail window of a first import (G4), opened or read up to the end: what serves while `w` is imported from
   * the start. True while one serves.
   */
  private async window(w: LaneWriter, files: ReadonlyArray<string | undefined>, metas: readonly SubagentMeta[], signal?: AbortSignal): Promise<boolean> {
    const current = files.at(-1)!;
    if (w.cursor === null && !w.scratch && await this.totalSize(files) > PULL_BYTES) {
      const start = await tailStart(current);
      if (start > 0 || files.length > 1) await this.read(w.openScratch(), files, fresh(files.length - 1, start), Infinity, metas, signal);
    } else if (w.scratch) {
      await this.read(w.scratch, files, decode(w.scratch.cursor) ?? fresh(files.length - 1, await tailStart(current)), Infinity, metas, signal);
    }
    return w.scratch !== undefined;
  }

  /** Reads one main lane from `cursor`; once it is read to the end, what the files beside it say is settled in it too. */
  private async read(w: LaneWriter, files: ReadonlyArray<string | undefined>, cursor: Cursor, limit: number, metas: readonly SubagentMeta[], signal?: AbortSignal): Promise<{ done: boolean; read: number }> {
    const reader = new LaneRead(this, w, cursor, true);
    const result = await reader.run(files, limit, signal);
    if (result.done && !signal?.aborted) await reader.settle(metas, this.options.exited?.());
    return result;
  }

  /** Every subagent of the conversation into its lane, the agent that spawned it naming it there (G9). */
  private async children(w: LaneWriter, metas: readonly SubagentMeta[], limit: number, signal?: AbortSignal): Promise<boolean> {
    if (!metas.length) return true;
    if (this.lanes?.owner !== w || this.lanes.generation !== w.generation) this.lanes = { owner: w, generation: w.generation, writers: new Map(), bound: new Map(), read: new Map() };
    const lanes = this.lanes;
    const exited = this.options.exited?.();
    let budget = limit, caughtUp = true;
    for (const meta of metas) {
      // The metadata file can acquire its title after this child was first opened. The writer keeps
      // its identity/cursor and only records fields that changed, even when the transcript did not.
      // Its first spawner stays: naming it again from a parent found later would record it twice.
      const described = JSON.stringify(meta.info);
      const bound = lanes.bound.get(meta.toolUseId);
      let child = lanes.writers.get(meta.toolUseId);
      if (!child || bound?.info !== described) {
        const spawner = bound?.spawner ?? (meta.parentAgentId ? lanes.writers.get(metas.find(item => item.agentId === meta.parentAgentId)?.toolUseId ?? '') ?? w : w);
        child = spawner.child(meta.toolUseId, meta.agentId, meta.info);
        lanes.writers.set(meta.toolUseId, child);
        lanes.bound.set(meta.toolUseId, { spawner, info: described });
      }
      if (signal?.aborted || budget <= 0) { caughtUp = false; continue; }
      const info = await stat(meta.file).catch(() => undefined);
      if (!info) continue;
      // A child that has not changed since it was read is not opened again.
      const seen = `${info.ino}:${info.size}:${info.mtimeMs}:${meta.finished}:${meta.stopped}:${exited ?? ''}`;
      if (lanes.read.get(meta.toolUseId) === `${seen}:${child.cursor}`) continue;
      let cursor = decode(child.cursor);
      if (cursor && !await sameFile(meta.file, cursor)) { child.rebuild('identity-changed'); cursor = undefined; }
      const reader = new LaneRead(this, child, cursor ?? fresh(0, 0), false);
      const { done, read } = await reader.run([meta.file], budget, signal);
      budget -= read;
      if (!done) { caughtUp = false; continue; }
      // A child stopped or done for good writes no end of its own when it was cut off mid-round, nor one the CLI took with it.
      if (meta.finished || meta.stopped) reader.finish(meta.stopped ? 'cancelled' : 'completed', new Date(info.mtimeMs).toISOString());
      else if (exited) reader.finish('interrupted', exited);
      lanes.read.set(meta.toolUseId, `${seen}:${child.cursor}`);
    }
    return caughtUp;
  }

  /** The children `<session>/subagents/agent-<id>.meta.json` names a tool call for, each after the agent that spawned it. */
  private async subagents(file: string): Promise<SubagentMeta[]> {
    const root = join(dirname(file), basename(file).replace(/\.jsonl$/, ''), 'subagents');
    let entries: string[];
    try { entries = await readdir(root); } catch { return []; }
    const metas: SubagentMeta[] = [];
    for (const entry of entries) {
      if (!entry.startsWith('agent-') || !entry.endsWith('.meta.json')) continue;
      const agentId = entry.slice('agent-'.length, -'.meta.json'.length);
      const path = join(root, entry);
      const info = await stat(path).catch(() => undefined);
      if (!agentId || !info) continue;
      let known = this.metas.get(path);
      if (!known || known.mtimeMs !== info.mtimeMs || known.size !== info.size) {
        let meta: SubagentMeta | undefined;
        try {
          const value = record(JSON.parse(await readFile(path, 'utf8')));
          const toolUseId = typeof value?.toolUseId === 'string' && value.toolUseId ? value.toolUseId : undefined;
          const text = (field: unknown) => typeof field === 'string' && field.trim() ? field.trim() : undefined;
          // `inherit` names no model: the agent runs on its parent's.
          const title = text(value?.description), subagentType = text(value?.agentType), model = text(value?.model) === 'inherit' ? undefined : text(value?.model);
          if (toolUseId) meta = {
            agentId, toolUseId, finished: value!.finished === true, stopped: value!.stoppedByUser === true, background: value!.requestShape === 'background',
            at: new Date(info.mtimeMs).toISOString(), file: join(root, `agent-${agentId}.jsonl`), meta: path,
            info: { ...(title ? { title } : {}), ...(subagentType ? { subagentType } : {}), ...(model ? { model } : {}) },
            ...(typeof value!.parentAgentId === 'string' ? { parentAgentId: value!.parentAgentId } : {}),
          };
        } catch { /* half written: read again once it changes */ }
        this.metas.set(path, known = { mtimeMs: info.mtimeMs, size: info.size, ...(meta ? { meta } : {}) });
      }
      if (known.meta) metas.push(known.meta);
    }
    const depth = (meta: SubagentMeta, seen = new Set<string>()): number => {
      const parent = meta.parentAgentId ? metas.find(item => item.agentId === meta.parentAgentId) : undefined;
      if (!parent || seen.has(parent.agentId)) return 0;
      seen.add(parent.agentId);
      return 1 + depth(parent, seen);
    };
    return metas.map(meta => ({ meta, depth: depth(meta) }))
      .sort((left, right) => left.depth - right.depth || (left.meta.agentId < right.meta.agentId ? -1 : left.meta.agentId > right.meta.agentId ? 1 : 0))
      .map(item => item.meta);
  }
}

/**
 * One read of one lane from its cursor. Rows go out in commits; a row that ends or opens a turn or changes
 * an activity is committed at once and its other writes follow, listed in that commit's cursor.
 */
class LaneRead {
  private events: NativeWorkbenchEvent[] = [];
  private ops: Op[] = [];
  private readonly mapper: MapperState;
  private turn?: Turn;
  private recent: string[];
  /** A subagent's round has given its answer: a message from the agent leading it starts the next one. */
  private settled: boolean;
  private f: number;
  private o: number;
  private ino?: number;
  private probe: Buffer;
  private queuedInputs: NonNullable<LaneState['q']>;

  constructor(private readonly source: ClaudeTranscriptSource, private readonly w: LaneWriter, cursor: Cursor, private readonly main: boolean) {
    const { m, t, r, d, x } = cursor.s;
    const putBlob = source.hooks.putBlob;
    const activities = !main ? undefined
      : m.x ? ClaudeActivities.restore(source.sessionId, { ...(putBlob ? { putBlob } : {}) }, m.x, { retainEnded: RETAIN_ENDED })
        : new ClaudeActivities(source.sessionId, { ...(putBlob ? { putBlob } : {}) }, { retainEnded: RETAIN_ENDED });
    this.mapper = {
      ...(m.n ? { nativeTurnId: m.n } : {}), ...(m.u ? { turnId: m.u } : {}), ...(m.q ? { turnPromptId: m.q } : {}), turnAt: '',
      calls: new OpenCalls(m.c ?? []), tasks: new Map((m.k ?? []).map(task => [task.id, task])), ...(activities ? { activities } : {}),
    };
    if (t) this.turn = { ...cursorTurn(cursor.s)! };
    this.recent = r ?? [];
    this.settled = d === 1;
    this.f = cursor.f;
    this.o = cursor.o;
    if (cursor.i !== undefined) this.ino = cursor.i;
    this.probe = cursor.p ? Buffer.from(cursor.p, 'base64') : EMPTY;
    this.ops = x ?? [];
    this.queuedInputs = cursor.s.q ?? [];
  }

  /** Reads `files` from the cursor on, about `limit` bytes of them; `done` once the last one is read to its end. */
  async run(files: ReadonlyArray<string | undefined>, limit: number, signal?: AbortSignal): Promise<{ done: boolean; read: number }> {
    // What the last commit listed is made again (each write is idempotent), then the activities still running are put
    // into the writer's ledger, so a stop can find them. One the mapping ended (`settle`) stays ended.
    this.apply();
    for (const activity of this.mapper.activities?.list() ?? []) if (activity.status === 'running') this.w.activities.apply(activity);
    let read = 0, done = false;
    for (;;) {
      const path = this.f < files.length ? files[this.f] : undefined;
      const last = this.f >= files.length - 1;
      if (path) {
        const file = await this.file(path, limit - read, signal);
        read += file.read;
        if (!file.eof) break;
      }
      if (last) { done = true; break; }
      this.f += 1;
      this.queuedInputs = [];
      this.o = 0;
      this.ino = undefined;
      this.probe = EMPTY;
    }
    this.flush();
    return { done, read };
  }

  /** The round still open ends: the subagent's metadata says it is over, or the CLI is gone. */
  finish(status: TurnEndStatus, at: string): void {
    if (!this.turn?.open) return;
    this.end(status, at);
    this.flush();
    this.apply();
    this.flush();
  }

  /**
   * What no row of a lane read to its end says, written as a row's writes are (G7, G10) and kept in the mapping's
   * state, so a later read does not bring a running state back: a background subagent its metadata calls finished or
   * stopped, the tail of an ended task's output file (read once), and with the CLI gone (`exited`) the activities
   * and the turn it left open, ended when it was found gone.
   */
  async settle(metas: readonly SubagentMeta[], exited: string | undefined): Promise<void> {
    const activities = this.mapper.activities;
    if (!activities) return;
    for (const meta of metas) {
      const id = activityId('claude', meta.agentId);
      if (meta.background && (meta.finished || meta.stopped) && activities.ended(id, meta.stopped ? 'stopped' : 'completed', meta.at)) this.ops.push(['act', id, meta.at]);
    }
    const owed = activities.owedOutputs();
    for (const [id, path] of owed) {
      const text = await readTaskOutputTail(path);
      const at = activities.get(id)?.endedAt ?? NO_TIME;
      if (activities.outputRead(id, text, at)) this.ops.push(['act', id, at]);
    }
    if (exited) {
      for (const activity of activities.list()) if (isLiveActivity(activity) && activities.ended(activity.id, 'unknown', exited)) this.ops.push(['act', activity.id, exited]);
      this.end('interrupted', exited);
    }
    if (!this.ops.length && !owed.length) return;
    this.flush();
    this.apply();
    this.flush();
  }

  /** See `ClaudeTranscriptSource.compactionHooked`. */
  compactionHooked(id: string, trigger: 'manual' | 'auto', at: string): void {
    if (!this.mapper.activities?.compactionHooked(id, trigger, at, this.mapper.turnId).length) return;
    this.ops.push(['act', id, at]);
    this.flush();
    this.apply();
    this.flush();
  }

  private async file(path: string, budget: number, signal?: AbortSignal): Promise<{ eof: boolean; read: number }> {
    const handle = await openFile(path);
    if (!handle) return { eof: true, read: 0 };
    try {
      const { size, ino } = await handle.stat();
      this.ino = ino;
      let read = 0, buffer = EMPTY, at = this.o, position = this.o, since = performance.now();
      for (;;) {
        if (signal?.aborted) return { eof: false, read };
        let start = 0;
        for (let newline = buffer.indexOf(0x0a); newline >= 0; newline = buffer.indexOf(0x0a, start)) {
          const line = buffer.subarray(start, newline + 1);
          this.line(line, at + start);
          start = newline + 1;
          read += line.length;
          if (read >= budget) return { eof: this.o >= size, read };
          // Between two rows the lane is as a stop would leave it; reads of a session never overlap (`pullLane`).
          if (performance.now() - since > STEP_MS) {
            await giveWay();
            since = performance.now();
            if (signal?.aborted) return { eof: false, read };
          }
        }
        buffer = buffer.subarray(start);
        at += start;
        // A last line without its newline is still being written; it is read once it is whole.
        if (position >= size) return { eof: true, read };
        const chunk = await readRange(handle, position, Math.min(size, position + Math.max(READ_CHUNK, buffer.length)));
        since = performance.now();
        if (!chunk.length) return { eof: true, read };
        position += chunk.length;
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      }
    } finally { await handle.close(); }
  }

  private line(bytes: Buffer, start: number): void {
    const row = parseLine(bytes);
    if (row) { if (this.main) this.mainRow(row, start); else this.childRow(row, start); }
    this.o = start + bytes.length;
    this.probe = Buffer.from(bytes.length >= PROBE_BYTES ? bytes.subarray(-PROBE_BYTES) : Buffer.concat([this.probe, bytes]).subarray(-PROBE_BYTES));
    if (this.ops.length) { this.flush(); this.apply(); }
    else if (this.events.length >= COMMIT_EVENTS) this.flush();
  }

  private mainRow(row: ClaudeRow, start: number): void {
    const m = this.mapper;
    const signals = claudeRowSignals(row);
    const prompt = signals.find(signal => signal.type === 'prompt');
    // The CLI's interruption marker names the prompt it ends: it closes a turn and never opens one.
    const marker = signals.some(signal => signal.type === 'turn_end' && signal.reason === 'interrupted');
    const before = m.turnId;
    const { visible, activities, uuid, at } = this.map(row, start, signals);
    if (m.turnId !== before && !marker && m.turnId) {
      const text = visible.find(event => event.type === 'user_message_chunk')?.data.content as { text?: unknown } | undefined;
      const typed = typeof text?.text === 'string' ? text.text : '';
      const compact = prompt?.type === 'prompt' && prompt.compact === true || /^\/compact(?:\s|$)/.test(typed);
      const slash = prompt?.type === 'prompt' && prompt.slash === true || typed.startsWith('/');
      const promptId = m.nativeTurnId ?? m.turnPromptId;
      this.open(m.nativeTurnId ?? m.turnId, uuid, at, { ...(promptId ? { p: promptId } : {}), ...(compact ? { c: 1 } : {}), ...(slash ? { s: 1 } : {}) });
    }
    this.place(visible, activities, uuid, at);
    for (const signal of signals) {
      const turn = this.turn;
      if (!turn?.open) break;
      if (signal.type === 'turn_end' && signal.reason === 'duration' && !turn.c) this.end('completed', at);
      else if (signal.type === 'turn_end' && signal.reason === 'stop_failure') this.end('failed', at, signal.error);
      else if (signal.type === 'turn_end' && signal.reason === 'interrupted' && (!signal.promptId || !turn.p || signal.promptId === turn.p)) this.end('cancelled', at);
      else if (signal.type === 'compact_boundary' && turn.c) this.end('completed', at);
      else if (signal.type === 'command_output' && (turn.s || turn.c)) this.end(turn.c ? 'failed' : 'completed', at);
    }
  }

  /** A subagent's row: its rounds are its turns, opened by its prompt or a wake after an answer, ended by the answer. */
  private childRow(row: ClaudeRow, start: number): void {
    const m = this.mapper;
    const before = m.turnId;
    const uuid = typeof row.uuid === 'string' ? row.uuid : `line-${start}`;
    if (this.settled && subagentWake(row)) { m.turnId = `claude-turn:${uuid}`; this.settled = false; }
    const settles = subagentSettles(row);
    if (settles !== undefined) this.settled = settles;
    const marker = row.type === 'user' && claudeRowOwesStep(row) === false;
    const { visible, activities, at } = this.map(row, start);
    if (m.turnId !== before && !marker && m.turnId) this.open(m.turnId, uuid, at, {});
    this.place(visible, activities, uuid, at);
    if (marker && this.turn?.open) this.end('cancelled', at);
    else if (settles === true && this.turn?.open) this.end('completed', at);
  }

  private map(row: ClaudeRow, start: number, signals: ReturnType<typeof claudeRowSignals> = []) {
    const uuid = typeof row.uuid === 'string' ? row.uuid : `line-${start}`;
    const at = typeof row.timestamp === 'string' ? row.timestamp : NO_TIME;
    const hooks = this.main ? this.source.hooks : {};
    // Queuing/consuming an input is a receipt, not an execution boundary. In particular an input
    // absorbed mid-turn must not open an anonymous turn or close the turn still producing output.
    if (this.main && row.type === 'queue-operation' && row.isSidechain !== true && row.agentId === undefined) {
      const text = typeof row.content === 'string' ? row.content : undefined;
      const key = text === undefined ? undefined : createHash('sha256').update(text).digest('hex');
      let index = row.operation === 'remove' && key ? this.queuedInputs.findIndex(input => !input.consumed && !input.dequeued && input.key === key) : -1;
      if (row.operation === 'remove' && index < 0) index = this.queuedInputs.findIndex(input => !input.consumed && !input.dequeued && input.key === undefined);
      if (row.operation === 'dequeue') index = this.queuedInputs.findIndex(input => !input.consumed && !input.dequeued);
      const receipt = index >= 0 ? this.queuedInputs[index]!.receipt : undefined;
      const events = (this.source.hooks.queuedInput?.(row, { offset: start, ...(this.ino !== undefined ? { inode: this.ino } : {}), ...(receipt ? { receipt } : {}) }) ?? [])
        .filter(event => event.type !== 'native_input_receipt' || !this.queuedInputs.some(input => input.receipt?.commandId === event.data.commandId && input.receipt?.nativeId !== event.nativeId));
      this.events.push(...events);
      if (row.operation === 'enqueue') {
        const accepted = events.find(event => event.type === 'native_input_receipt' && event.runId && typeof event.data.commandId === 'string');
        this.queuedInputs.push({ ...(key ? { key } : {}), ...(accepted ? { receipt: { nativeId: accepted.nativeId, runId: accepted.runId!, commandId: accepted.data.commandId as string } } : {}) });
      } else if (index >= 0 && row.operation === 'dequeue') this.queuedInputs[index]!.dequeued = 1;
      else if (index >= 0) this.consumeQueuedInput(index);
      else if (row.operation === 'popAll') {
        for (let index = this.queuedInputs.length - 1; index >= 0; index -= 1) if (!this.queuedInputs[index]!.consumed) this.consumeQueuedInput(index);
      }
    }
    const visible: Array<Omit<NativeWorkbenchEvent, 'sequence'>> = [];
    const activities: string[] = [];
    for (const event of mapRow(row, start, this.source.session(), this.mapper, hooks, !this.main)) {
      const activity = activityOfEvent(event);
      if (!activity) visible.push(event);
      else if (!activities.includes(activity.id)) activities.push(activity.id);
    }
    if (this.main && row.type === 'user') {
      const prompt = visible.find(event => event.type === 'user_message_chunk');
      const content = prompt?.data.content as { text?: unknown } | undefined;
      // Notifications and hidden peer prompts consume the native queue too; their message
      // need not render as a human bubble. Use the same classification that opened the turn.
      if (prompt || signals.some(signal => signal.type === 'prompt') || visible.some(event => event.type === 'task_notification')) {
        const key = typeof content?.text === 'string' ? createHash('sha256').update(content.text).digest('hex') : undefined;
        const index = this.queuedInputs.findIndex(input => !input.consumed && input.dequeued);
        const input = this.queuedInputs[index];
        if (input) {
          if (prompt) {
            // The durable queue order is authoritative over a runtime's provisional text claim.
            const { commandId: _claim, ...data } = prompt.data;
            prompt.data = { ...data, ...(input.key === key && input.receipt ? { commandId: input.receipt.commandId } : {}) };
          }
          this.consumeQueuedInput(index);
        }
      }
    }
    return { visible, activities, uuid, at };
  }

  /** Retain recent command claims until the dispatcher has durably observed their receipts. */
  private consumeQueuedInput(index: number): void {
    const input = this.queuedInputs[index]!;
    if (input.receipt) input.consumed = 1;
    else this.queuedInputs.splice(index, 1);
    if (this.queuedInputs.filter(input => input.consumed).length > QUEUE_RECEIPTS) {
      this.queuedInputs.splice(this.queuedInputs.findIndex(input => input.consumed), 1);
    }
  }

  /** Puts a row's events into the turn they belong to (G3), and lists the activity states it changed (G10). */
  private place(visible: ReadonlyArray<Omit<NativeWorkbenchEvent, 'sequence'>>, activities: readonly string[], uuid: string, at: string): void {
    // Anything shown after its turn ended (a late result, work after an answer) opens a turn of its own (G6).
    if ((visible.length && !this.turn?.open) || (activities.length && !this.turn)) {
      const promptId = this.mapper.nativeTurnId ?? this.mapper.turnPromptId;
      this.open(`claude-turn:${uuid}`, uuid, at, { a: 1, ...(promptId ? { p: promptId } : {}) });
    }
    const turn = this.turn;
    if (!turn) return;
    for (const event of visible) this.events.push({ ...event, ...(turn.a && event.runId === this.mapper.turnId ? { runId: turn.k } : {}), sequence: 0, nativeTurnId: turn.k });
    if (!activities.length) return;
    this.ops.push(['start', turn.k, at]);
    for (const id of activities) this.ops.push(['act', id, at]);
  }

  /** Turn `key` begins with this row; the turn before it ends here if nothing ended it (a prompt after a prompt). */
  private open(key: string, uuid: string, at: string, flags: Omit<Turn, 'k' | 'open'>): void {
    if (key === this.turn?.k && this.turn.open) return;
    const unique = key === this.turn?.k || this.recent.includes(key) ? `claude-turn:${uuid}` : key;
    if (this.turn?.open) this.end('completed', at);
    this.turn = { k: unique, open: true, ...flags };
    this.recent = [...this.recent, unique].slice(-RECENT_TURNS);
  }

  private end(status: TurnEndStatus, at: string, error?: string): void {
    if (!this.turn?.open) return;
    this.ops.push(error ? ['end', this.turn.k, status, at, error] : ['end', this.turn.k, status, at]);
    this.turn.open = false;
  }

  /** Commits the rows read so far with the cursor after them, and the writes still to make. */
  private flush(): void {
    const cursor = this.encode();
    if (this.events.length || cursor !== this.w.cursor) this.w.commit({ events: this.events, cursor });
    this.events = [];
  }

  /** Makes the writes the last commit listed. */
  private apply(): void {
    for (const op of this.ops) {
      if (op[0] === 'end') this.w.turnEnded(op[1], op[2], op[3], op[4]);
      else if (op[0] === 'start') this.w.turnStarted(op[1], op[2]);
      else {
        const activity: NativeActivity | undefined = this.mapper.activities?.get(op[1]);
        const when = new Date(op[2]);
        if (activity) this.w.activities.apply(activity, Number.isFinite(when.getTime()) ? when : undefined);
      }
    }
    this.ops = [];
  }

  private encode(): string {
    const m = this.mapper;
    const mapper: MapperSnapshot = {
      ...(m.nativeTurnId ? { n: m.nativeTurnId } : {}), ...(m.turnId ? { u: m.turnId } : {}), ...(m.turnPromptId ? { q: m.turnPromptId } : {}),
      ...(m.calls.size ? { c: [...m.calls] } : {}), ...(m.tasks.size ? { k: [...m.tasks.values()] } : {}),
      ...(m.activities ? { x: m.activities.state() } : {}),
    };
    const state: LaneState = {
      m: mapper, ...(this.turn ? { t: this.turn } : {}), ...(this.recent.length ? { r: this.recent } : {}),
      ...(this.settled ? { d: 1 as const } : {}), ...(this.ops.length ? { x: this.ops } : {}),
      ...(this.queuedInputs.length ? { q: this.queuedInputs } : {}),
    };
    const cursor: Cursor = { v: 1, f: this.f, o: this.o, ...(this.ino !== undefined ? { i: this.ino } : {}), ...(this.probe.length ? { p: this.probe.toString('base64') } : {}), s: state };
    return JSON.stringify(cursor);
  }
}

/** Who to wake when a conversation's transcript may have changed: the hooks and the transcript poll a running CLI already has. */
export class ClaudeTranscriptChanges {
  private readonly wakes = new Map<string, Set<() => void>>();

  on(sessionId: string, wake: () => void): () => void {
    let set = this.wakes.get(sessionId);
    if (!set) this.wakes.set(sessionId, set = new Set());
    set.add(wake);
    return () => { set.delete(wake); if (!set.size && this.wakes.get(sessionId) === set) this.wakes.delete(sessionId); };
  }

  emit(sessionId: string): void {
    for (const wake of this.wakes.get(sessionId) ?? []) { try { wake(); } catch { /* a reader's failure is its own */ } }
  }
}
