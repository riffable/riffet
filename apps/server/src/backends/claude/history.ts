import { createHash } from 'node:crypto';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { NativeActivity, NativeHistoryState, NativeWorkbenchEvent, Session, SessionGoal } from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import { activeTurnOf, initialState, reduce, type BackgroundAgent, type ClaudeSessionState, type ClaudeSignal } from './session-state.js';
import { ClaudeActivities, outputPreview, readTaskOutputTail, stoppable, type ClaudeTaskKind } from './activity.js';
import { ActivityLedger, activityEvent, activityId, activityOfEvent, isLiveActivity } from '../../journal/activity.js';
import { firstHumanMessage } from '../../session-title.js';
import { claudeGoalChange } from './goal.js';
import { ClaudeSubagentDiscovery } from './subagents.js';
import { MAX_TRANSCRIPT_BYTES, record, string, CLAUDE_TURN_FAILED, isTerminalType, type ClaudeRow, subagentWake, subagentSettles, claudeRowOwesStep, claudeRowSignals, parseRow, transcriptLines } from './rows.js';
import { type MapperState, type ClaudeTranscriptHooks, mapRow } from './row-mapper.js';
import { type ClaudeStepMeasurement, ClaudeStepMeter } from './step-meter.js';
/** Bytes just before the read offset that must still match, or the file was rewritten in place. */
const TRANSCRIPT_PROBE_BYTES = 256;
const SNAPSHOT_EVENTS = 500;
const HISTORY_PAGE_SIZE = 100;
/** Subagent transcripts kept per session. */
const SUBAGENT_LIMIT = 64;
/** Bytes one subagent's opening snapshot may spend; older events stay behind its history cursor. */
const SUBAGENT_SNAPSHOT_BYTES = 96 * 1024;
/** How often the subagents directory is listed; child files themselves are read only when they grow. */
const SUBAGENT_SCAN_MS = 1_000;
/**
 * A child transcript followed so its spawning tool row can open it.
 *
 * Claude Code keeps every subagent in its own `agent-<agentId>.jsonl` beside the session file, and
 * names the parent's `Agent`/`Task` tool_use in `agent-<agentId>.meta.json`, so the mapping is an
 * identity rather than a guess.
 */
interface ClaudeSubagentState {
  readonly toolCallId: string;
  readonly agentId: string;
  readonly file: string;
  subagentType?: string;
  description?: string;
  parentAgentId?: string;
  stoppedByUser?: boolean;
  finished?: boolean;
  /** The transcript reported it over (a TaskStop result, a terminal report) and nothing relaunched it. */
  over?: boolean;
  /** Launched to run in the background: it keeps going after the main turn ends. */
  background?: boolean;
  /** The child file's identity at the last read, so an unchanged child is not parsed again. */
  size: number;
  mtimeMs: number;
  /** What has been read of the child file, as for the parent: a grown file is read from `offset` on. */
  ino?: number;
  offset: number;
  probe: Buffer;
  /** Where mapping the child's rows stands, so an append maps only its new rows. */
  progress?: SubagentProgress;
  loaded: boolean;
  running: boolean;
  /** Whether the child's last conversation row leaves it owing another step (see `claudeRowOwesStep`). */
  owesStep: boolean;
  lastAt: number;
  mapped: NativeWorkbenchEvent[];
  /** Absolute index into `mapped` already handed to listeners, and the identity at that edge. */
  sentUpTo: number;
  sentTailId?: string;
  /** The `runId` of the child's current round: what its frames name as the live turn while it runs. */
  turnId?: string;
}

interface SubagentProgress { mapper: MapperState; lines: number; owesStep: boolean; settled: boolean }

/** The live turn a child's frame names: only while it runs, and only once a round is known. */
function liveSubagentTurn(state: ClaudeSubagentState, running: boolean): { activeTurnId?: string } {
  return running && state.turnId ? { activeTurnId: state.turnId } : {};
}

function subagentRunning(state: ClaudeSubagentState): boolean {
  return state.stoppedByUser !== true && state.finished !== true && state.over !== true && state.owesStep;
}

/** A subagent update, shaped exactly like the stream frame that carries it. */
/** What the reader learned of one child: its newest rows, or those after the last frame, and whether it runs. */
export interface ClaudeSubagentFrame {
  type: 'subagent'; toolCallId: string; agentId: string; subagentType?: string; title?: string; prompt?: string; model?: string;
  reset: boolean; events: NativeWorkbenchEvent[]; history?: NativeHistoryState; running?: boolean; activeTurnId?: string;
}

/** A page of a child's older rows. */
export interface ClaudeHistoryPage { events: NativeWorkbenchEvent[]; history: NativeHistoryState }

function historyCursor(generation: string, start: number): string {
  return Buffer.from(JSON.stringify({ generation, start })).toString('base64url');
}

/** Serialized size of one event, the unit the snapshot budget is spent in. */
function eventBytes(event: NativeWorkbenchEvent): number {
  return Buffer.byteLength(JSON.stringify(event));
}

/**
 * Where a subagent snapshot's window starts: at most [count] events, at most
 * [SUBAGENT_SNAPSHOT_BYTES] bytes. The newest event is always kept so the window is never empty.
 */
function snapshotStart(events: readonly NativeWorkbenchEvent[], count: number): number {
  if (!events.length) return 0;
  let start = Math.max(0, events.length - 1);
  let bytes = eventBytes(events[start]!);
  while (start > 0 && events.length - start < count && bytes + eventBytes(events[start - 1]!) <= SUBAGENT_SNAPSHOT_BYTES) {
    start -= 1;
    bytes += eventBytes(events[start]!);
  }
  return start;
}

function readHistoryCursor(cursor: string): { generation: string; start: number } | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const value = record(parsed);
    if (typeof value?.generation !== 'string' || !Number.isSafeInteger(value.start) || (value.start as number) < 0) return undefined;
    return { generation: value.generation, start: value.start as number };
  } catch { return undefined; }
}

/**
 * The state-relevant rows read by one refresh. `replay` means they are the whole file (first read, or the
 * file was replaced): the consumer starts its state over from them instead of continuing it.
 */
export interface ClaudeTranscriptLifecycle { replay: boolean; signals: ClaudeSignal[] }
export interface ClaudeTranscriptRefresh {
  reset: boolean;
  events: NativeWorkbenchEvent[];
  steps: ClaudeStepMeasurement[];
  subagents: ClaudeSubagentFrame[];
  lifecycle: ClaudeTranscriptLifecycle;
}
const EMPTY_PARENT: Omit<ClaudeTranscriptRefresh, 'subagents'> = { reset: false, events: [], steps: [], lifecycle: { replay: false, signals: [] } };
const EMPTY_REFRESH: ClaudeTranscriptRefresh = { ...EMPTY_PARENT, subagents: [] };

type OpenToolUse = { id: string; name: string; input: Record<string, unknown> };

/** Everything mapping the parent file carries from one row to the next. */
interface ParentProgress {
  state: MapperState;
  turnState: ClaudeSessionState;
  parents: Map<string, string>;
  meter: ClaudeStepMeter;
  /** Calls the conversation's own thread has made and not had answered yet, in order. */
  openCalls: Map<string, OpenToolUse>;
  aiTitle?: string;
  customTitle?: string;
  goal?: SessionGoal;
}

function newProgress(sessionId: string, putBlob: (text: string) => string | undefined): ParentProgress {
  return {
    state: { turnAt: '', calls: new Map(), tasks: new Map(), activities: new ClaudeActivities(sessionId, { putBlob }) },
    turnState: initialState('alive'), parents: new Map(), meter: new ClaudeStepMeter(), openCalls: new Map(),
  };
}

function trackOpenToolUses(open: Map<string, OpenToolUse>, row: ClaudeRow): void {
  const content = row.message?.content;
  if (row.isSidechain === true || row.agentId !== undefined || !Array.isArray(content)) return;
  for (const raw of content) {
    const part = record(raw);
    if (part?.type === 'tool_use' && typeof part.id === 'string' && typeof part.name === 'string') open.set(part.id, { id: part.id, name: part.name, input: record(part.input) ?? {} });
    else if (part?.type === 'tool_result' && typeof part.tool_use_id === 'string') open.delete(part.tool_use_id);
  }
}

/** The bytes just before the new read offset, after reading [read] from [from]. */
function nextProbe(previous: Buffer, from: number, read: Buffer): Buffer {
  return Buffer.from(read.length >= TRANSCRIPT_PROBE_BYTES ? read.subarray(read.length - TRANSCRIPT_PROBE_BYTES)
    : Buffer.concat([from === 0 ? Buffer.alloc(0) : previous, read]).subarray(-TRANSCRIPT_PROBE_BYTES));
}

/** Whether [next] keeps every event of [previous] as it was, in place: then only its tail is news. */
function startsWithEvents(next: readonly NativeWorkbenchEvent[], previous: readonly NativeWorkbenchEvent[]): boolean {
  if (previous.length > next.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    const left = previous[index]!, right = next[index]!;
    if (left !== right && (left.nativeId !== right.nativeId || JSON.stringify(left) !== JSON.stringify(right))) return false;
  }
  return true;
}

/** Read-only durable JSONL history. It never starts a Claude process or modifies the transcript. */
export class ClaudeTranscript {
  readonly generation: string;
  private file?: string;
  /** The CLI-owned file this reader has already located, for the pre-write input fence. */
  get path(): string | undefined { return this.file; }
  /**
   * What has been read of the parent file: the byte offset after its last complete line, every row
   * up to there (`undefined` for a line that is not an object), the bytes just before the offset,
   * and the stat it was read at. A poll that finds the same stat reads nothing; one that finds the
   * file grown reads only the new tail. A file that shrank or was replaced is read again in full.
   */
  private offset = 0;
  private rows: Array<ClaudeRow | undefined> = [];
  private probe: Buffer = Buffer.alloc(0);
  private fileStamp?: { ino: number; size: number; mtimeMs: number };
  /** Where the mapping of the rows read so far stands, so an append maps only the rows it adds. */
  private progress?: ParentProgress;
  private loaded = false;
  private fileGeneration = 0;
  private mapped: NativeWorkbenchEvent[] = [];
  /**
   * Events the runtime made up (a Run's end) and the number of file events that preceded each when it
   * was made. They take their place in `mapped` so one counter numbers everything the stream carries:
   * a file event read later can never share a sequence with them.
   */
  private injected: Array<{ after: number; event: Omit<NativeWorkbenchEvent, 'sequence'> }> = [];
  private fileEvents = 0;
  private steps: ClaudeStepMeasurement[] = [];
  private userIds = new Set<string>();
  private titleValue: string | undefined;
  private titleRenamedValue = false;
  private goalValue: SessionGoal | undefined;
  private readonly subagents = new Map<string, ClaudeSubagentState>();
  private subagentScannedAt = 0;
  private readonly discovery = new ClaudeSubagentDiscovery();
  private transcriptState: 'ok' | 'unavailable' | 'unparsed' = 'unavailable';
  /** The latest state of every system activity: what the last mapping found, with what the runtime added since. */
  private activityCache?: { version: number; list: NativeActivity[] };
  /** Folds `mapped` as it grows; dropped whenever an event already folded is replaced. */
  private activityLedger?: { ledger: ActivityLedger; applied: number };
  /** The first human message once found, else how far `mapped` has been searched for one. */
  private firstHuman: { text?: string; scanned: number } = { scanned: 0 };
  /** Changes whenever `mapped` does, so `activities()` is derived once per change. */
  private mappedVersion = 0;
  /** Output files of the tasks the last mapping saw, by activity id; and those already read. */
  private outputFiles: ReadonlyMap<string, string> = new Map();
  /** Agent ids the transcript reported over (stopped, or a terminal report) and nothing relaunched. */
  private agentsOver: ReadonlySet<string> = new Set();
  private readonly tailed = new Set<string>();
  private readonly blobRefs = new Map<string, string>();

  constructor(private readonly session: Session, private readonly nativeSessionId: string, private readonly hooks: ClaudeTranscriptHooks = {}) {
    this.generation = `claude:${nativeSessionId}`;
  }

  get state(): 'ok' | 'unavailable' | 'unparsed' { return this.transcriptState; }

  /**
   * The conversation's name as Claude Code recorded it: the latest `custom-title` row (`/rename`,
   * or a desktop client), else the latest `ai-title` row its own model writes after the first turn.
   */
  get title(): string | undefined { return this.titleValue; }

  /** Whether `title` is a `custom-title` row — someone chose it — rather than Claude Code's own `ai-title`. */
  get titleRenamed(): boolean { return this.titleRenamedValue; }

  /** The conversation's `/goal` as its rows leave it. */
  get goal(): SessionGoal | undefined { return this.goalValue; }

  /** Rows of the conversation's earlier provider sessions, oldest first; unreadable ones are skipped. */
  private async precedingRows(): Promise<Array<ClaudeRow | undefined>> {
    const configDir = this.hooks.precedingConfigDir;
    const rows: Array<ClaudeRow | undefined> = [];
    if (!configDir) return rows;
    let budget = MAX_TRANSCRIPT_BYTES;
    for (const id of this.session.previousNativeSessionIds ?? []) {
      const file = await findClaudeTranscript(configDir, id);
      if (!file) {
        if (this.hooks.unbounded) throw new AppError('SHARE_HISTORY_UNAVAILABLE', 'The previous Claude Code conversation history file does not exist', 409);
        continue;
      }
      try {
        const info = await stat(file);
        if (info.size > budget) {
          if (this.hooks.unbounded) throw new AppError('SHARE_HISTORY_TOO_LARGE', 'The previous Claude Code conversation history exceeds the read limit', 413);
          continue;
        }
        budget -= info.size;
        for (const line of transcriptLines(await readFile(file))) {
          try { rows.push(parseRow(line, this.hooks.unbounded)); }
          catch (error) { if (this.hooks.unbounded) throw error; /* a torn line of a finished session */ }
        }
      } catch (error) { if (this.hooks.unbounded) throw error; /* an earlier session's file that cannot be read leaves a gap, not an error */ }
    }
    return rows;
  }

  /** Reads the whole file again on the next refresh, e.g. to re-map rows once the caller can tell more about them. */
  rescan(): void { this.fileStamp = undefined; }

  /**
   * Signals read but not yet handed to a consumer. `setFile` reads the file itself, and what it finds
   * (the whole conversation, on a first read) must still reach whoever replays it.
   */
  private backlog: ClaudeTranscriptLifecycle = { replay: false, signals: [] };

  private drain(read: ClaudeTranscriptLifecycle): ClaudeTranscriptLifecycle {
    const merged = read.replay ? read : { replay: this.backlog.replay, signals: [...this.backlog.signals, ...read.signals] };
    this.backlog = { replay: false, signals: [] };
    return merged;
  }

  async setFile(file: string | undefined): Promise<void> {
    if (this.file === file) return;
    this.file = file;
    this.fileGeneration += 1;
    this.loaded = false;
    this.titleValue = undefined;
    this.titleRenamedValue = false;
    this.goalValue = undefined;
    this.offset = 0;
    this.rows = [];
    this.probe = Buffer.alloc(0);
    this.fileStamp = undefined;
    this.progress = undefined;
    this.replaceMapped([]);
    this.outputFiles = new Map();
    this.agentsOver = new Set();
    this.tailed.clear();
    this.injected = [];
    this.fileEvents = 0;
    this.steps = [];
    this.userIds.clear();
    this.subagents.clear();
    this.discovery.clear();
    this.subagentScannedAt = 0;
    this.transcriptState = file ? 'unparsed' : 'unavailable';
    this.backlog = { replay: false, signals: [] };
    if (file) this.backlog = (await this.load()).lifecycle;
  }

  async refresh(): Promise<ClaudeTranscriptRefresh> {
    const read = await this.load();
    // What the files say about tasks that ended, which the rows do not carry (a task's output, a child's own metadata).
    const settled = await this.settleActivities();
    return { ...read, ...(settled.length && !read.reset ? { events: [...read.events, ...settled] } : {}), lifecycle: this.drain(read.lifecycle) };
  }

  private async load(): Promise<ClaudeTranscriptRefresh> {
    const generation = this.fileGeneration;
    const parent = await this.refreshParent();
    if (generation !== this.fileGeneration) return { ...EMPTY_REFRESH };
    const subagents = this.hooks.skipSubagents ? [] : await this.refreshSubagents();
    if (generation !== this.fileGeneration) return { ...EMPTY_REFRESH };
    return { ...parent, subagents };
  }

  private async refreshParent(): Promise<Omit<ClaudeTranscriptRefresh, 'subagents'>> {
    if (!this.file) { this.transcriptState = 'unavailable'; return { ...EMPTY_PARENT }; }
    const generation = this.fileGeneration;
    try {
      const info = await stat(this.file);
      if (generation !== this.fileGeneration) return { ...EMPTY_PARENT };
      if (info.size > MAX_TRANSCRIPT_BYTES) throw new Error('transcript exceeds read limit');
      const stamp = { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs };
      if (this.loaded && this.fileStamp && this.fileStamp.ino === stamp.ino && this.fileStamp.size === stamp.size && this.fileStamp.mtimeMs === stamp.mtimeMs) {
        return { ...EMPTY_PARENT, steps: this.steps };
      }
      const tail = await readTail(this.file, this.offset, this.probe, info.size, info.ino, this.fileStamp?.ino);
      if (generation !== this.fileGeneration) return { ...EMPTY_PARENT };
      // Anything but an append — shrunk, replaced, or rewritten under the bytes already read — is a
      // new file as far as the events are concerned.
      const changed = tail.from === 0 && this.offset > 0;
      const completeBytes = tail.bytes.lastIndexOf(0x0a) + 1;
      if (!changed && completeBytes === 0) {
        this.loaded = true;
        this.fileStamp = stamp;
        return { ...EMPTY_PARENT, steps: this.steps };
      }
      const newRows: Array<ClaudeRow | undefined> = tail.from === 0 ? await this.precedingRows() : [];
      if (generation !== this.fileGeneration) return { ...EMPTY_PARENT };
      for (const line of transcriptLines(tail.bytes.subarray(0, completeBytes))) {
        try { newRows.push(parseRow(line, this.hooks.unbounded)); }
        catch {
          this.transcriptState = 'unparsed';
          return { ...EMPTY_PARENT };
        }
      }
      const liveAppend = this.loaded && !changed;
      const offset = tail.from + completeBytes;
      const probe = nextProbe(this.probe, tail.from, tail.bytes.subarray(0, completeBytes));
      // An append continues the mapping where the last read left it; anything read from the start
      // (a first read, a rewritten file, a `rescan`) maps every row again.
      const full = tail.from === 0;
      if (!full && !this.progress) { this.fileStamp = undefined; return { ...EMPTY_PARENT, steps: this.steps }; }
      const progress = full ? newProgress(this.session.id, text => this.blob(text)) : this.progress!;
      const mapped: NativeWorkbenchEvent[] = full ? [] : this.mapped;
      const before = mapped.length;
      const userIds = full ? new Set<string>() : this.userIds;
      const signals: ClaudeSignal[] = [];
      let fileEvents = full ? 0 : this.fileEvents;
      // On an append every event the runtime made up is already in `mapped`, where `inject` put it.
      let placed = full ? 0 : this.injected.length;
      const placeInjected = (all = false) => {
        while (placed < this.injected.length && (all || this.injected[placed]!.after <= fileEvents)) {
          mapped.push({ ...this.injected[placed]!.event, sequence: mapped.length + 1 });
          placed += 1;
        }
      };
      let index = full ? 0 : this.rows.length;
      try {
        for (const value of newRows) {
          index += 1;
          if (!value) continue;
          const rowSignals = claudeRowSignals(value, progress.parents, activeTurnOf(progress.turnState.mainTurn)?.promptId);
          signals.push(...rowSignals);
          if (value.type === 'user' && typeof value.uuid === 'string') userIds.add(value.uuid);
          if (value.type === 'ai-title' && typeof value.aiTitle === 'string') progress.aiTitle = value.aiTitle;
          if (value.type === 'custom-title' && typeof value.customTitle === 'string') progress.customTitle = value.customTitle;
          const goalChange = claudeGoalChange(progress.goal, value);
          if (goalChange !== undefined) progress.goal = goalChange ?? undefined;
          trackOpenToolUses(progress.openCalls, value);
          const events = mapRow(value, index, this.session, progress.state, this.hooks);
          progress.meter.add(value, events);
          for (const event of events) {
            placeInjected();
            mapped.push({ ...event, sequence: mapped.length + 1 });
            fileEvents += 1;
          }
          // A Stop hook is only a fast notification. The CLI's own end record must carry the
          // same result after a restart, when the send and hook callbacks no longer exist.
          // Reuse the lifecycle reducer so an old interruption or a compaction cannot close
          // another turn, and an interruption followed by a duration never reports success.
          for (const signal of rowSignals) {
            const transition = reduce(progress.turnState, signal);
            progress.turnState = transition.state;
            const ended = transition.ended;
            if (!ended?.promptId || !['stop', 'duration', 'interrupted', 'stop_failure'].includes(ended.reason)) continue;
            placeInjected();
            // The hook already injected this turn's end live; the file record is only the
            // durable copy for after a restart. Synthesizing a second terminal here would
            // show the interruption (or completion) twice.
            if (this.injected.some(entry => entry.event.nativeTurnId === ended.promptId && isTerminalType(entry.event.type))) continue;
            mapped.push({
              sequence: mapped.length + 1, sessionId: this.session.id,
              nativeId: `claude:${this.nativeSessionId}:${string(value.uuid) ?? `line-${index}`}:turn-end`,
              nativeTurnId: ended.promptId, createdAt: string(value.timestamp) ?? this.session.updatedAt,
              type: ended.reason === 'interrupted' ? 'run_cancelled' : ended.reason === 'stop_failure' ? 'run_failed' : 'run_completed',
              data: { nativeSessionId: string(value.sessionId) ?? this.nativeSessionId,
                ...(ended.reason === 'interrupted' ? { reason: 'Claude confirmed that the turn was interrupted.' } : {}),
                ...(ended.reason === 'stop_failure' ? { error: ended.error ?? CLAUDE_TURN_FAILED } : {}) },
            });
            fileEvents += 1;
          }
        }
      } catch {
        // A row the mapper could not take leaves the mapping half advanced: undo what reached
        // `mapped`, and read the whole file again next time.
        if (!full) {
          mapped.length = before;
          this.progress = undefined;
          this.fileStamp = undefined;
        }
        this.transcriptState = 'unparsed';
        return { ...EMPTY_PARENT };
      }
      placeInjected(true);
      // Only a full mapping can disagree with what was sent: an append leaves every earlier event as it was.
      const eventReset = full && (changed || !startsWithEvents(mapped, this.mapped));
      const append = eventReset ? mapped : mapped.slice(full ? this.mapped.length : before);
      this.offset = offset;
      if (full) this.rows = newRows; else for (const row of newRows) this.rows.push(row);
      this.probe = probe;
      this.fileStamp = stamp;
      this.progress = progress;
      if (full) this.replaceMapped(mapped); else this.mappedVersion += 1;
      this.fileEvents = fileEvents;
      this.outputFiles = new Map(progress.state.activities!.outputFiles());
      this.agentsOver = new Set(progress.state.activities!.agentsOver());
      this.steps = progress.meter.steps();
      this.userIds = userIds;
      this.titleValue = progress.customTitle ?? progress.aiTitle;
      this.titleRenamedValue = progress.customTitle !== undefined;
      this.goalValue = progress.goal;
      this.transcriptState = 'ok';
      this.loaded = true;
      return { reset: eventReset, events: append, steps: this.steps, lifecycle: { replay: !liveAppend, signals } };
    } catch (error) {
      if (generation !== this.fileGeneration) return { ...EMPTY_PARENT };
      this.transcriptState = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unavailable' : 'unparsed';
      return { ...EMPTY_PARENT };
    }
  }

  /** Registers newly written children, then reads whichever of them grew since the last poll. */
  private async refreshSubagents(): Promise<ClaudeSubagentFrame[]> {
    if (!this.file) return [];
    const now = Date.now();
    if (now - this.subagentScannedAt >= SUBAGENT_SCAN_MS) {
      this.subagentScannedAt = now;
      await this.scanSubagents(this.file);
    }
    const frames: ClaudeSubagentFrame[] = [];
    for (const state of this.subagents.values()) {
      const frame = await this.readSubagent(state);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  private async scanSubagents(file: string): Promise<void> {
    const metas = await this.discovery.read(file);
    for (const [toolCallId, state] of this.subagents) {
      if (this.discovery.invalidates(state.agentId, toolCallId)) this.subagents.delete(toolCallId);
    }
    // A discovery revision can retract a launch without changing the main transcript.
    this.activityCache = undefined;
    for (const meta of metas) {
      const toolCallId = meta.toolUseId, agentId = meta.agentId;
      const existing = this.subagents.get(toolCallId);
      const state: ClaudeSubagentState = existing?.agentId === agentId ? existing : {
        toolCallId, agentId, file: meta.file,
        size: 0, mtimeMs: 0, offset: 0, probe: Buffer.alloc(0), loaded: false, running: false, owesStep: false, lastAt: 0, mapped: [], sentUpTo: 0,
      };
      if (meta.info.subagentType) state.subagentType = meta.info.subagentType;
      if (meta.info.title) state.description = meta.info.title;
      if (meta.parentAgentId) state.parentAgentId = meta.parentAgentId;
      state.stoppedByUser = meta.stopped;
      state.finished = meta.finished;
      state.background = meta.background;
      this.subagents.set(toolCallId, state);
    }
    while (this.subagents.size > SUBAGENT_LIMIT) {
      const finished = [...this.subagents.values()].filter(state => state.loaded && !state.running);
      const evicted = (finished.length ? finished : [...this.subagents.values()]).sort((left, right) => left.lastAt - right.lastAt)[0];
      if (!evicted) break;
      this.subagents.delete(evicted.toolCallId);
    }
  }

  /**
   * Reads one child file and turns it into a stream frame. An unchanged file is skipped, so the
   * runner's 300ms poll costs a `stat` per child rather than a full parse.
   */
  private async readSubagent(state: ClaudeSubagentState): Promise<ClaudeSubagentFrame | undefined> {
    let info;
    try { info = await stat(state.file); } catch { return undefined; }
    state.over = this.agentsOver.has(state.agentId);
    if (state.loaded && info.size === state.size && info.mtimeMs === state.mtimeMs) {
      // Metadata or the parent's task report can end a child without changing its transcript.
      // A quiet tool call still owes its result and cannot prove an end by elapsed time alone.
      const running = subagentRunning(state);
      if (running === state.running) return undefined;
      state.running = running;
      return {
        type: 'subagent', toolCallId: state.toolCallId, agentId: state.agentId,
        ...(state.subagentType ? { subagentType: state.subagentType } : {}),
        reset: false, events: [], running, ...liveSubagentTurn(state, running),
      };
    }
    if (info.size > MAX_TRANSCRIPT_BYTES) return undefined;
    let tail: { from: number; bytes: Buffer };
    try { tail = await readTail(state.file, state.offset, state.probe, info.size, info.ino, state.ino); } catch { return undefined; }
    const completeBytes = tail.bytes.lastIndexOf(0x0a) + 1;
    const rows: Array<ClaudeRow | undefined> = [];
    for (const line of transcriptLines(tail.bytes.subarray(0, completeBytes))) {
      try { rows.push(parseRow(line, this.hooks.unbounded)); } catch { return undefined; }
    }
    // Only what was added since the last read is mapped; a child rewritten in place is mapped again whole.
    const full = tail.from === 0;
    if (!full && !state.progress) { state.ino = undefined; return undefined; }
    // A child file is entirely sidechain rows, and its tool calls are its own: the conversation
    // hooks (permissions, model, command matching) belong to the parent and are not run here.
    const progress: SubagentProgress = full ? { mapper: { turnAt: '', calls: new Map(), tasks: new Map() }, lines: 0, owesStep: true, settled: false } : state.progress!;
    const base = full ? [] : state.mapped;
    const added: NativeWorkbenchEvent[] = [];
    const mapper = progress.mapper;
    try {
      for (const value of rows) {
        progress.lines += 1;
        if (!value) continue;
        progress.owesStep = claudeRowOwesStep(value) ?? progress.owesStep;
        // A wake after the child's answer is hidden context, not a prompt row, yet the work after it is a new round.
        if (progress.settled && subagentWake(value)) {
          mapper.turnId = `claude-turn:${string(value.uuid) ?? `line-${progress.lines}`}`;
          mapper.turnAt = string(value.timestamp) ?? mapper.turnAt;
          progress.settled = false;
        }
        progress.settled = subagentSettles(value) ?? progress.settled;
        // Every child row carries the prompt id of the parent turn it was written in, unchanged across the
        // child's own rounds: those are told apart by `runId`, so the parent's id is not passed on.
        for (const { nativeTurnId: _parentTurn, ...event } of mapRow(value, progress.lines, this.session, mapper, { unbounded: this.hooks.unbounded, observedChanges: this.hooks.observedChanges }, true)) {
          added.push({ ...event, sequence: base.length + added.length + 1 });
        }
      }
    } catch {
      // The mapping is half advanced: the next read starts the child over.
      state.progress = undefined;
      state.ino = undefined;
      return undefined;
    }
    const mapped = full ? added : base;
    if (!full) for (const event of added) mapped.push(event);
    state.ino = info.ino;
    state.offset = tail.from + completeBytes;
    state.probe = nextProbe(state.probe, tail.from, tail.bytes.subarray(0, completeBytes));
    state.progress = progress;
    const owesStep = progress.owesStep;
    state.turnId = mapper.turnId;
    // Progress and attachment rows map to no event but are still the child writing.
    const lastAt = Math.max(Date.parse(mapped.at(-1)?.createdAt ?? '') || 0, info.mtimeMs);
    const continued = state.sentUpTo > 0 && state.sentUpTo <= mapped.length
      && mapped[state.sentUpTo - 1]?.nativeId === state.sentTailId;
    state.owesStep = owesStep;
    const running = subagentRunning(state);
    const becameRunning = state.loaded && running !== state.running;
    state.size = info.size;
    state.mtimeMs = info.mtimeMs;
    state.mapped = mapped;
    state.lastAt = lastAt;
    state.running = running;
    if (!state.loaded || !continued) {
      state.loaded = true;
      state.sentUpTo = mapped.length;
      state.sentTailId = mapped.at(-1)?.nativeId;
      return { ...this.subagentSnapshot(state), running };
    }
    const delta = mapped.slice(state.sentUpTo);
    state.sentUpTo = mapped.length;
    state.sentTailId = mapped.at(-1)?.nativeId;
    if (!delta.length && !becameRunning) return undefined;
    return {
      type: 'subagent', toolCallId: state.toolCallId, agentId: state.agentId,
      ...(state.subagentType ? { subagentType: state.subagentType } : {}),
      reset: false, events: delta, running, ...liveSubagentTurn(state, running),
    };
  }

  /**
   * The tail of a child's transcript, cut to fit both an event and a byte budget.
   *
   * A subscriber's opening burst carries one of these per child, so a phone must not be handed a
   * megabyte per subagent; whatever is cut stays behind the history cursor. The newest event is
   * always kept, however large, so a panel never opens empty.
   */
  private subagentSnapshot(state: ClaudeSubagentState): ClaudeSubagentFrame {
    const generation = `claude-sub:${state.agentId}`;
    const start = snapshotStart(state.mapped, SNAPSHOT_EVENTS);
    const hasMore = start > 0;
    return {
      type: 'subagent', toolCallId: state.toolCallId, agentId: state.agentId,
      ...(state.subagentType ? { subagentType: state.subagentType } : {}),
      reset: true, events: state.mapped.slice(start),
      history: { generation, ...(hasMore ? { cursor: historyCursor(generation, start) } : {}), hasMore },
      running: state.running, ...liveSubagentTurn(state, state.running),
    };
  }

  /** Every loaded child's latest state, for a new subscriber's opening burst. */
  subagentFrames(): ClaudeSubagentFrame[] {
    return [...this.subagents.values()].filter(state => state.loaded).map(state => this.subagentSnapshot(state));
  }

  /**
   * Background work that is still going: agents from their metadata (launched with `requestShape:
   * background`, not marked finished or stopped, and once their file exists still owing a step), and
   * every other task (Bash, Monitor, Workflow) the transcript shows launched and not yet reported over.
   */
  backgroundAgents(): BackgroundAgent[] {
    const agents: BackgroundAgent[] = [...this.subagents.values()]
      .filter(state => state.background === true && state.finished !== true && state.stoppedByUser !== true && !this.agentsOver.has(state.agentId) && (!state.loaded || state.running))
      .map(state => ({
        toolUseId: state.toolCallId, agentId: state.agentId, kind: 'agent' as const,
        ...(state.subagentType ? { agentType: state.subagentType } : {}), ...(state.description ? { description: state.description } : {}),
      }));
    const metaIds = new Set([...this.subagents.values()].map(state => activityId('claude', state.agentId)));
    const known = new Set(agents.map(agent => agent.toolUseId));
    for (const activity of this.activities()) {
      // A child with metadata is judged by its metadata, which is fresher than the row that launched it.
      if (!stoppable(activity) || metaIds.has(activity.id)) continue;
      const toolUseId = activity.toolCallId ?? activity.id;
      if (known.has(toolUseId)) continue;
      known.add(toolUseId);
      agents.push({ toolUseId, taskId: activity.id.slice('claude:'.length), kind: (activity.task?.kind ?? 'shell') as ClaudeTaskKind, description: activity.title });
    }
    return agents;
  }

  /** Stores a text for the conversation to fetch later; the same text is stored once. */
  private blob(text: string): string | undefined {
    if (!this.hooks.putBlob) return undefined;
    const key = createHash('sha256').update(text).digest('hex');
    const known = this.blobRefs.get(key);
    if (known) return known;
    const reference = this.hooks.putBlob(text);
    if (reference) {
      this.blobRefs.set(key, reference);
      if (this.blobRefs.size > 64) this.blobRefs.delete(this.blobRefs.keys().next().value!);
    }
    return reference;
  }

  /**
   * The latest state of every system activity in the order they first appeared. The rows give the
   * states a transcript can show; states the runtime added (a stop in progress, a task's output) are
   * folded in the order they were numbered, under the same rules (an ended activity stays ended).
   */
  activities(): NativeActivity[] {
    if (this.activityCache?.version === this.mappedVersion) return this.activityCache.list;
    // Events are only appended between full mappings (which drop the ledger), so only the new ones are folded.
    const folded = this.activityLedger ??= { ledger: new ActivityLedger(() => undefined), applied: 0 };
    const ledger = folded.ledger;
    for (; folded.applied < this.mapped.length; folded.applied += 1) {
      const event = this.mapped[folded.applied]!;
      const activity = activityOfEvent(event);
      if (!activity) continue;
      if (event.data.restored === true) {
        if (!ledger.get(activity.id)) ledger.apply(activity, new Date(event.createdAt));
        ledger.stopFailed(activity.id);
      } else {
        const when = new Date(event.createdAt);
        ledger.apply(activity, Number.isFinite(when.getTime()) ? when : new Date());
      }
    }
    this.activityCache = { version: this.mappedVersion, list: ledger.list().filter(activity => activity.task?.kind !== 'agent' || !activity.toolCallId
      || !this.discovery.invalidates(activity.id.slice('claude:'.length), activity.toolCallId)) };
    return this.activityCache.list;
  }

  /**
   * Adds a state of an activity that the rows do not show (a stop requested, a task's output read) to the
   * stream, numbered with the events read from the file. `restored` is a stop that did not happen.
   */
  injectActivity(activity: NativeActivity, options: { restored?: boolean; at?: string } = {}): NativeWorkbenchEvent {
    const { sequence: _sequence, ...event } = activityEvent(this.session.id, activity, { createdAt: options.at ?? new Date().toISOString() });
    const injected: NativeWorkbenchEvent = { ...(options.restored ? { ...event, data: { ...event.data, restored: true } } : event), sequence: this.mapped.length + 1 };
    // Recorded as injected, so a rebuild of the rows from the file keeps it.
    this.injected.push({ after: this.fileEvents, event: injected });
    this.mapped.push(injected);
    this.mappedVersion += 2;
    return injected;
  }

  /** A compaction its PreCompact hook announced: running under `id` until the boundary row read later completes it. */
  compactionHooked(id: string, trigger: 'manual' | 'auto', at: string, promptId?: string): void {
    const state = this.progress?.state;
    if (!state?.activities?.compactionHooked(id, trigger, at, state.turnId, promptId).length) return;
    // Injected, so a full remap of the file keeps it.
    this.injectActivity(state.activities.get(id)!, { at });
  }

  /**
   * Brings activities in line with what the files show: a background agent its metadata marks stopped or
   * finished, and the output of a task that has ended. Returns the events it injected.
   */
  private async settleActivities(): Promise<NativeWorkbenchEvent[]> {
    const injected: NativeWorkbenchEvent[] = [];
    const now = () => new Date().toISOString();
    for (const state of this.subagents.values()) {
      const over = this.agentsOver.has(state.agentId);
      if (state.background !== true || (state.stoppedByUser !== true && state.finished !== true && !over)) continue;
      const activity = this.activities().find(candidate => candidate.id === activityId('claude', state.agentId));
      if (!activity || !isLiveActivity(activity)) continue;
      injected.push(this.injectActivity({ ...activity, status: state.stoppedByUser === true || (over && state.finished !== true) ? 'stopped' : 'completed', endedAt: now() }));
    }
    for (const activity of this.activities()) {
      if (activity.kind !== 'background_task' || isLiveActivity(activity) || activity.status === 'unknown' || this.tailed.has(activity.id)) continue;
      // An agent's output file is its whole transcript and a monitor's is every event it printed: neither is a result to show.
      if (activity.task?.kind !== 'shell' && activity.task?.kind !== 'workflow') continue;
      const path = this.outputFiles.get(activity.id);
      if (!path) continue;
      this.tailed.add(activity.id);
      const text = await readTaskOutputTail(path);
      if (!text?.trim()) continue;
      const blobRef = this.blob(text);
      injected.push(this.injectActivity({ ...activity, detail: outputPreview(text), ...(blobRef ? { blobRef } : {}) }));
    }
    return injected;
  }

  subagentHistory(toolCallId: string, cursor: string, generation: string): ClaudeHistoryPage {
    const state = this.subagents.get(toolCallId);
    if (!state?.loaded) throw new AppError('NATIVE_HISTORY_PENDING', 'The Claude subagent transcript is not ready', 503);
    const expected = `claude-sub:${state.agentId}`;
    if (generation !== expected) throw new AppError('NATIVE_HISTORY_STALE', 'This subagent transcript changed while loading older messages', 409);
    const decoded = readHistoryCursor(cursor);
    if (!decoded || decoded.generation !== generation || decoded.start > state.mapped.length) throw new AppError('INVALID_HISTORY_CURSOR', 'Claude subagent history cursor is invalid');
    const start = Math.max(0, decoded.start - HISTORY_PAGE_SIZE);
    const events = state.mapped.slice(start, decoded.start);
    const hasMore = start > 0;
    return { events, history: { generation, ...(hasMore ? { cursor: historyCursor(generation, start) } : {}), hasMore } };
  }

  /**
   * Calls the conversation's own thread has made and not had answered yet. Whatever the CLI draws that
   * waits on a person (a permission, a question, a plan) belongs to one of them.
   */
  openToolUses(): OpenToolUse[] {
    return [...(this.progress?.openCalls.values() ?? [])];
  }

  /**
   * The `runId` the rows of the latest turn carry when that turn is [promptId]'s and its rows carry no
   * `nativeTurnId` — a turn a task report opened. Clients find the live turn by either field.
   */
  rowTurnOf(promptId: string): string | undefined {
    const state = this.progress?.state;
    return state && state.turnPromptId === promptId && !state.nativeTurnId ? state.turnId : undefined;
  }

  /** A turn with model/tool output must stop through native end evidence, even after a cold replay. */
  hasTurnOutput(promptId: string | undefined): boolean {
    if (!promptId) return false;
    const rowTurn = this.rowTurnOf(promptId);
    for (let index = this.mapped.length - 1; index >= 0; index -= 1) {
      const event = this.mapped[index]!;
      if (event.nativeTurnId !== promptId && (!rowTurn || event.runId !== rowTurn)) continue;
      if (['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(event.type)) return true;
      if (event.type === 'user_message_chunk') return false;
    }
    return false;
  }

  /** Swaps in a newly mapped event list; whatever was derived from the old one starts over. */
  private replaceMapped(mapped: NativeWorkbenchEvent[]): void {
    this.mapped = mapped;
    this.mappedVersion += 1;
    this.activityLedger = undefined;
    this.firstHuman = { scanned: 0 };
  }

  allEvents(): NativeWorkbenchEvent[] { return [...this.mapped]; }

  /** The sequence of the newest event, without copying the list. */
  lastSequence(): number { return this.mapped.at(-1)?.sequence ?? 0; }

  /**
   * The first human message of the transcript (see `firstHumanMessage`). Events are only ever
   * added after it, so once found it holds until the events are mapped again from the start.
   */
  firstHumanMessage(): string | undefined {
    if (this.firstHuman.text === undefined && this.firstHuman.scanned < this.mapped.length) {
      const text = firstHumanMessage(this.mapped.slice(this.firstHuman.scanned));
      this.firstHuman = text === undefined ? { scanned: this.mapped.length } : { text, scanned: this.mapped.length };
    }
    return this.firstHuman.text;
  }

  /** Whether the transcript read so far holds the call `toolUseId` (its row is written after the hooks that precede it). */
  hasToolCall(toolUseId: string): boolean {
    for (let index = this.mapped.length - 1; index >= 0; index -= 1) {
      const event = this.mapped[index]!;
      if (event.type === 'tool_call' && event.data.toolCallId === toolUseId) return true;
    }
    return false;
  }
  measurements(): ClaudeStepMeasurement[] { return [...this.steps]; }
  userMessageIds(): Set<string> { return new Set(this.userIds); }
}

/**
 * The part of a transcript after `offset`. When the file is not the one read before (another inode,
 * shorter than the offset, or other bytes than `probe` just before the offset) the whole file is
 * returned from 0 instead.
 */
async function readTail(file: string, offset: number, probe: Buffer, size: number, ino: number, knownIno: number | undefined): Promise<{ from: number; bytes: Buffer }> {
  const handle = await open(file, 'r');
  try {
    const read = async (from: number, to: number): Promise<Buffer> => {
      const buffer = Buffer.alloc(Math.max(0, to - from));
      let filled = 0;
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, from + filled);
        if (!bytesRead) break;
        filled += bytesRead;
      }
      return buffer.subarray(0, filled);
    };
    if (offset > 0 && knownIno === ino && size >= offset) {
      const chunk = await read(offset - probe.length, size);
      if (chunk.subarray(0, probe.length).equals(probe)) return { from: offset, bytes: chunk.subarray(probe.length) };
    }
    return { from: 0, bytes: await read(0, size) };
  } finally { await handle.close(); }
}

/** Search only Claude's own project transcript directory for an exact native UUID. */
export async function findClaudeTranscript(configDir: string, nativeSessionId: string): Promise<string | undefined> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nativeSessionId)) return undefined;
  const projectRoot = join(configDir, 'projects');
  let directories: string[];
  try { directories = await readdir(projectRoot); } catch { return undefined; }
  for (const directory of directories) {
    if (directory.includes('/') || directory === '.' || directory === '..') continue;
    const candidate = join(projectRoot, directory, `${nativeSessionId}.jsonl`);
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch { /* exact transcript is not present in this project folder */ }
  }
  return undefined;
}
