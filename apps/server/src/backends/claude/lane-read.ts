import { open, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { NativeActivity, NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';
import { activityId, activityOfEvent, isLiveActivity } from '../../journal/activity.js';
import { type LaneWriter, type TurnEndStatus } from '../../journal/ingest.js';
import { ClaudeActivities, readTaskOutputTail, type ClaudeActivitiesState } from './activity.js';
import { activeTurnOf, initialState, reduce } from './session-state.js';
import { type ClaudeSubagentMeta as SubagentMeta } from './subagents.js';
import { mapRow, type ClaudeTask, type MapperState, type ToolCall } from './row-mapper.js';
import { claudeApiFailure, claudeRowOwesStep, claudeRowSignals, parseRow, subagentSettles, subagentWake, type ClaudeRow } from './rows.js';
import type { ClaudeTranscriptSource } from './transcript-source.js';

export const READ_CHUNK = 1024 * 1024;

/** Rows per commit within a stretch that has no turn boundary or activity. */
export const COMMIT_EVENTS = 256;

/**
 * The longest a read keeps the event loop between two rows. Rows that change an activity commit one at a time (a
 * Monitor printing thousands of events), so a megabyte of them is far more than a megabyte of anything else. A
 * step after a file read and the one after it run in the same turn of the loop, so other work waits up to twice this.
 */
export const STEP_MS = 25;

export const giveWay = () => new Promise<void>(resolve => setImmediate(resolve));

export const PROBE_BYTES = 32;

/** What a cursor carries at most: ended activities, unanswered calls (and their text), recent turn keys. */
export const RETAIN_ENDED = 16;

export const OPEN_CALLS = 256;

export const CALL_TEXT = 4096;

export const RECENT_TURNS = 16;

export const QUEUE_RECEIPTS = 64;

/** Rows without a time of their own (rare) are stamped with this, never with when they were read. */
export const NO_TIME = new Date(0).toISOString();

/** Every other row type is Claude's own bookkeeping (requests, modes, titles) and maps to nothing; such lines are not parsed. */
export const MAPPED_TYPES = new Set(['user', 'assistant', 'system', 'attachment', 'queue-operation']);

export const EMPTY = Buffer.alloc(0);

/** The journal turn rows go to. `c`: opened by `/compact`; `s`: by another slash command; `p`: the CLI's prompt id. */
export interface Turn { k: string; open: boolean; p?: string; c?: 1; s?: 1; a?: 1; b?: 1 }

/**
 * A write outside a commit (a turn mark, an activity state), made right after the commit of the row that
 * caused it. The commit's cursor lists them, so a read that stopped in between makes them again (G7).
 */
export type Op = ['end', string, TurnEndStatus, string, string?] | ['start', string, string] | ['act', string, string];

/** `mapRow`'s state between rows. Tool calls keep only what their result needs. */
export interface MapperSnapshot { n?: string; u?: string; q?: string; c?: Array<[string, ToolCall]>; k?: ClaudeTask[]; x?: ClaudeActivitiesState }

export interface QueueReceipt { nativeId: string; runId: string; commandId: string }

export interface LaneState { m: MapperSnapshot; t?: Turn; r?: string[]; d?: 1; x?: Op[]; parents?: Array<[string, string]>; q?: Array<{ key?: string; receipt?: QueueReceipt; dequeued?: 1; consumed?: 1 }> }

/** File `f` of the conversation's transcripts, read up to byte `o`; `i` and `p` are the inode and the bytes before `o` it was read with. */
export interface Cursor { v: 1; f: number; o: number; i?: number; p?: string; s: LaneState; lifecycle?: 1 }

/** Older cursors kept the previous mapper identity when output continued after a control-path stop. */
export function cursorTurn(state: LaneState): Turn | undefined {
  const turn = state.t;
  return turn && !turn.p && !turn.a && state.m.n && turn.k.startsWith('claude-turn:')
    && turn.k !== state.m.n && turn.k !== state.m.u ? { ...turn, p: state.m.n, a: 1 } : turn;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function decode(cursor: string | null): Cursor | undefined {
  if (cursor === null) return undefined;
  try {
    const value = JSON.parse(cursor) as Cursor;
    return value?.v === 1 && Number.isSafeInteger(value.f) && value.f >= 0 && Number.isSafeInteger(value.o) && value.o >= 0 && record(value.s) ? value : undefined;
  } catch { return undefined; }
}

export const fresh = (f: number, o: number): Cursor => ({ v: 1, f, o, s: { m: {} }, lifecycle: 1 });

/** Whether `path` is still the file `cursor` was read from, as it was: Claude only appends (G8). Unknown files pass. */
export async function sameFile(path: string | undefined, cursor: Cursor | undefined): Promise<boolean> {
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

/** The calls a result may still answer, holding only the input fields a result reads (`mapRow`, `launchOf`). */
export class OpenCalls extends Map<string, ToolCall> {
  override set(id: string, call: ToolCall): this {
    const input: Record<string, unknown> = {};
    for (const key of ['file_path', 'subject', 'taskId', 'status', 'description', 'command', 'skill', 'task_id', 'shell_id']) {
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
export function parseLine(bytes: Buffer): ClaudeRow | undefined {
  if (bytes.length > 9 && bytes.toString('latin1', 0, 9) === '{"type":"') {
    const close = bytes.indexOf(0x22, 9);
    if (close > 9 && close < 64 && !MAPPED_TYPES.has(bytes.toString('latin1', 9, close))) return undefined;
  }
  const text = bytes.toString('utf8').trimEnd();
  if (!text) return undefined;
  try { return parseRow(text); } catch { return undefined; }
}

export async function readRange(handle: FileHandle, from: number, to: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(Math.max(0, to - from));
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, from + filled);
    if (!bytesRead) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

export async function openFile(path: string): Promise<FileHandle | undefined> {
  try { return await open(path, 'r'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * One read of one lane from its cursor. Rows go out in commits; a row that ends or opens a turn or changes
 * an activity is committed at once and its other writes follow, listed in that commit's cursor.
 */
export class LaneRead {
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
  private readonly parents: Map<string, string>;

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
    this.parents = new Map(cursor.s.parents ?? []);
    // A prior reader may have persisted this launch before its identity became ambiguous. Retire
    // only the activity, retaining the actual Skill call/result, and keep cursor state in sync.
    const invalid = activities?.list().filter(activity => source.invalidAgentActivity(activity)) ?? [];
    if (invalid.length) {
      for (const activity of invalid) activities!.forgetAgent(activity.id);
      const ids = new Set(invalid.map(activity => activity.id));
      this.ops = this.ops.filter(op => op[0] !== 'act' || !ids.has(op[1]));
      w.transaction(() => {
        w.commit({ events: [], retire: [...ids], cursor: this.encode() });
        for (const id of ids) w.activities.forget(id);
      });
    }
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
  compactionHooked(id: string, trigger: 'manual' | 'auto', at: string, promptId?: string): void {
    // A compaction held for its prompt's row changes only the cursor, which still has to be written.
    if (this.mapper.activities?.compactionHooked(id, trigger, at, this.mapper.turnId, promptId).length) this.ops.push(['act', id, at]);
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
    const signals = claudeRowSignals(row, this.parents, this.turn?.open ? this.turn.p : undefined);
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
      if (!['turn_end', 'stop_blocked', 'compact_boundary', 'command_output'].includes(signal.type)) continue;
      // The runtime and durable reader use the same end rules, including a Stop hook which sends
      // the model on. Only the current turn is needed; queue/background state belongs elsewhere.
      const transition = reduce({ ...initialState('alive'), mainTurn: {
        kind: turn.c ? 'compacting' : 'running', promptId: turn.p, origin: 'other', slash: turn.s === 1,
        transcriptSeen: true, ...(turn.b ? { stopBlocked: true } : {}),
      } }, signal);
      if (activeTurnOf(transition.state.mainTurn)?.stopBlocked) turn.b = 1; else delete turn.b;
      const ended = transition.ended;
      if (ended) this.end(ended.reason === 'stop_failure' || ended.reason === 'command' && ended.compact ? 'failed'
        : ended.reason === 'interrupted' ? 'cancelled' : 'completed', at, ended.error);
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
    const failure = claudeApiFailure(row);
    if (failure && this.turn?.open) this.end('failed', at, failure);
    else if (marker && this.turn?.open) this.end('cancelled', at);
    else if (settles === true && this.turn?.open) this.end('completed', at);
  }

  private map(row: ClaudeRow, start: number, signals: ReturnType<typeof claudeRowSignals> = []) {
    const uuid = typeof row.uuid === 'string' ? row.uuid : `line-${start}`;
    const at = typeof row.timestamp === 'string' ? row.timestamp : NO_TIME;
    // The conversation's hooks match its own input and belong to the main lane; what a command changed is looked up
    // by its call, in a subagent's lane as well.
    const hooks = this.main ? this.source.hooks : { observedChanges: this.source.hooks.observedChanges, fileSnapshots: this.source.hooks.fileSnapshots };
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
      else if (this.source.invalidAgentActivity(activity)) this.mapper.activities?.forgetAgent(activity.id);
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
    if (this.main) this.source.live?.opened(unique);
  }

  private end(status: TurnEndStatus, at: string, error?: string): void {
    if (!this.turn?.open) return;
    this.ops.push(error ? ['end', this.turn.k, status, at, error] : ['end', this.turn.k, status, at]);
    this.turn.open = false;
  }

  /** Commits the rows read so far with the cursor after them, and the writes still to make. */
  private flush(): void {
    const cursor = this.encode();
    // A text block the screen drafted is taken back in the commit that writes it, so the two never show together.
    const retire = this.main && this.events.length ? this.source.live?.committed(this.events) : undefined;
    if (this.events.length || cursor !== this.w.cursor) this.w.commit({ events: this.events, cursor, ...(retire?.length ? { retire } : {}) });
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
      ...(this.parents.size ? { parents: [...this.parents] } : {}),
    };
    const cursor: Cursor = { v: 1, f: this.f, o: this.o, ...(this.ino !== undefined ? { i: this.ino } : {}), ...(this.probe.length ? { p: this.probe.toString('base64') } : {}), s: state, lifecycle: 1 };
    return JSON.stringify(cursor);
  }
}
