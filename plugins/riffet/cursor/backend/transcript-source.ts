import { createHash, type Hash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { NativeActivity, NativeWorkbenchEvent } from '@contracts';
import { activityId, clipDetail, isLiveActivity } from '@riffet/plugin-api/kit';
import { type AgentLaneWriter, type AgentSubagentInfo, type AgentTranscriptSource, type AgentTurnStatus } from '@riffet/plugin-api/experimental/agent';
import { ChatReader, TranscriptMapper, type ChatCompaction, type ChatMessage, type ChatMeta, type ChatSnapshot, type TranscriptEvent, type TranscriptMapperState } from '../native/chat-store.js';
import { cursorPromptAlias, type CursorLive, type CursorLiveStep } from '../native/live.js';
import { historyStartSteps, sameStep } from '../native/transcript.js';

/**
 * Cursor's transcript as the session journal reads it (sync v3, docs/SYNC-V3.md 写入契约). The CLI's
 * chat store (`native/chat-store.ts`) is read only, from where each lane's cursor stands.
 *
 * - An event is `<position>:<part>`: its message's place in the root's expanded message list (archived
 *   messages included, so a compaction moves nothing) and its place among that message's events (G2).
 *   A message is a content-addressed blob, so a new message at a place already read (a `/rewind` and
 *   a new prompt) is a new version of what stood there; the blob id stays on as `nativeAliases`
 *   (`<position>:<blob>:<part>`, the id the in-memory transcript gives the same event).
 * - A turn is the CLI's request id, or `turn:<position>…` for one it gave none (a task notification,
 *   older CLIs). It ends when the next one begins, or once the store ends on an answer with no step
 *   in flight, the CLI's own record of a finished turn (G3); a hook that ends it first goes through
 *   `drain` (G6).
 * - The cursor is the reader's whole state: the root read, how much of it and the digest of that
 *   prefix (a rewound history no longer matches it), and the mapper's state, so a read resumes
 *   exactly where the last commit left it (G7).
 * - Reading is synchronous (SQLite, JSON, the mapper), so a read runs in slices of `sliceMs` and lets
 *   the event loop turn in between; a first import of a large store takes seconds on a cold cache.
 */

/** What the service already learns about a conversation, handed on to the reader of its transcript. */
export interface CursorTranscriptSignals {
  /** The chat store may have changed: the service's own store check saw it move, or a hook fired. */
  changed(): void;
  /** The service follows a subagent the transcript does not name yet: the CLI holds its store open. */
  subagent(toolCallId: string, agentId: string): void;
  /** The CLI began compacting (`preCompact` hook) during turn `generationId`. */
  preCompact(info: { generationId?: string; trigger?: 'manual' | 'auto'; preTokens?: number }): void;
}

export interface CursorTranscriptLimits {
  /** Messages one pull reads into a lane that is behind; a longer store opens with a tail window first (G4). */
  stepMessages: number;
  /** Message bytes one such pull reads. */
  stepBytes: number;
  /** The tail window: this many turns, looking back at most `tailMessages` messages (`selectHistoryStart`). */
  tailTurns: number;
  tailMessages: number;
  /** How long a read holds the event loop before it lets it turn; it commits what it read first, unless it is mid-rewind. */
  sliceMs: number;
}

export interface CursorTranscriptOptions {
  /** The workspace's chat stores (`workspaceChatsDir`): the conversation's and its subagents'. */
  chatsDir(): string;
  /** The chat the session follows now; undefined until the CLI has made one. */
  chatId(): string | undefined;
  /** Where change signals come from; without it `watch` never wakes. */
  signals?(listener: CursorTranscriptSignals): () => void;
  /** Stamped on events; the journal does not keep it. */
  sessionId?: string;
  /** What a shell call changed in the working tree, seen around it (`AgentHost.workspaceChanges`); merged into its result. */
  observedChanges?(toolCallId: string): readonly Record<string, unknown>[] | undefined;
  /** The step each chat's CLI is streaming, ahead of its checkpoint in the store. */
  live?: Pick<CursorLive, 'read' | 'watch'>;
  limits?: Partial<CursorTranscriptLimits>;
}

const DEFAULT_LIMITS: CursorTranscriptLimits = { stepMessages: 512, stepBytes: 4 * 1024 * 1024, tailTurns: 8, tailMessages: 512, sliceMs: 40 };
const STATE_VERSION = 1;
/** Normalized events can be upgraded without clearing turn ends or changing lane generations. */
const MAPPING_VERSION = 3;
/** Events per commit while a lane reads on. */
const COMMIT_EVENTS = 256;
/** Turn ids opened lately; a request id seen among them again opens a turn of its own instead. */
const RECENT_TURNS = 16;
/** Subagents a lane keeps reading at once, and how deep subagents of subagents are followed. */
const CHILD_LIMIT = 32;
const CHILD_DEPTH = 4;
const SIGNAL_LIMIT = 8;
/**
 * How long a live step stays after its checkpoint arrived while the store has not moved: the CLI writes
 * the checkpoint right after, so past this the step was never written (the CLI was stopped in it).
 */
const SEALED_LIVE_MS = 5000;
/** A chat's first prompt follows the system prompt and `<user_info>`, which its store records along with it. */
const FIRST_PROMPT_AT = 2;
const LIVE_CHATS = 64;
const AGENT_ID = /^[0-9a-f-]{36}$/i;
const CHAT_ID = /^[A-Za-z0-9._-]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const isOpenCompaction = (activity: NativeActivity) => activity.kind === 'compaction' && (isLiveActivity(activity) || activity.status === 'unknown');

interface TurnState {
  /** The turn id the journal files the turn under. */
  id: string;
  /** The mapper's turn (`runId`) it follows. */
  run?: string;
  /** When its newest event happened. */
  at: string;
  /** Its turn_ended is written: a later message of the same CLI turn opens a turn of its own. */
  ended?: true;
  /** Its newest message left a tool call or result unanswered: cut short there, it was interrupted. */
  owes?: true;
}

/** A lane's reading of one chat store, stored as the lane's journal cursor. */
interface LaneState {
  v: typeof STATE_VERSION;
  mapping?: typeof MAPPING_VERSION;
  /** Adapter upgrade progress, independent of the live transcript cursor. */
  reproject?: { n: number; mapper: TranscriptMapperState; tasks?: Array<[string, AgentSubagentInfo]> };
  /** Where the lane begins in the store: 0, or a tail window's first message. */
  from: number;
  /** The root last read, how many messages of its expanded list the log holds, and how long that list was. */
  root?: string;
  n: number;
  len: number;
  /** `digestIds` of the first `n` messages: a rewritten history no longer matches it. */
  digest: string;
  /** The lane has read to the end of the store: what it reads from now on happens now. */
  live?: true;
  mapper: TranscriptMapperState;
  turn?: TurnState;
  recent: string[];
  /** Compaction archives placed, summary id → activity id. */
  placed: Record<string, string>;
  /**
   * Drafts of the step in flight, written under the ids of message `at`. `live` when they are the live
   * tap's rather than the store's; `prompt` when the store has not recorded the turn yet, so the turn's
   * prompt is drafted too, under `${at - 1}:0`, and this is the turn it opens.
   */
  draft?: { at: number; count: number; live?: true; prompt?: string };
  /** Turns a live step opened that were ended without the store recording them, so a late record reopens them. */
  liveEnded?: string[];
  /** Subagents (tool call id, agent id) still being read. */
  children: Array<[string, string]>;
  /** What the `Task` calls of the subagents not done yet asked for (`AgentSubagentInfo`), by tool call id: the store of a subagent does not say. */
  tasks?: Array<[string, AgentSubagentInfo]>;
  /** Compactions the CLI reported that no archive has completed, so a restarted ledger knows them. */
  compacting?: NativeActivity[];
  /** Ids a rewound history held past the point it changed and no read has written again yet; retired at the end. */
  stale?: string[];
}

function parseState(cursor: string): LaneState | undefined {
  try {
    const state = JSON.parse(cursor) as LaneState;
    return state?.v === STATE_VERSION && Number.isSafeInteger(state.n) && isRecord(state.mapper) ? state : undefined;
  } catch { return undefined; }
}

function emptyState(from: number, digest: string): LaneState {
  return { v: STATE_VERSION, mapping: MAPPING_VERSION, from, n: from, len: 0, digest, mapper: new TranscriptMapper().state(), recent: [], placed: {}, children: [] };
}

/** `digestIds` (native/transcript.ts), kept open so it can go on as a lane reads. */
function digestOf(ids: readonly string[], count: number): Hash {
  const hash = createHash('sha256');
  for (let index = 0; index < count; index += 1) hash.update(ids[index]!).update('\0');
  return hash;
}

/** One chat store for the length of a pull: opened once, its root decoded at most once. */
class ChatView {
  readonly reader: ChatReader;
  private loadedMeta: { value: ChatMeta | undefined } | undefined;
  private loadedSnapshot: { value: ChatSnapshot | undefined } | undefined;

  constructor(readonly path: string, readonly chatId: string) { this.reader = new ChatReader(path); }

  meta(): ChatMeta | undefined {
    this.loadedMeta ??= { value: this.reader.available() ? this.reader.meta() : undefined };
    return this.loadedMeta.value;
  }

  snapshot(): ChatSnapshot | undefined {
    this.loadedSnapshot ??= { value: this.meta() ? this.reader.snapshot(this.meta()) : undefined };
    return this.loadedSnapshot.value;
  }

  close(): void { this.reader.close(); }
}

interface ReadOptions {
  /** Read at most a step (a lane being imported), not to the end. */
  bounded: boolean;
  /** Where a lane with no cursor begins. */
  origin: 'start' | 'tail';
  /** The lane serves its readers now: CLI signals land here. */
  serving: boolean;
  /** A scratch window serves the lane meanwhile, so stopping short of the end is not caught up. */
  behind: boolean;
  depth: number;
  slice: Slice;
}

/** `endTurn`: how the turn the store leaves open ends, and which one it is when the caller knows. */
interface TurnEnd { status: AgentTurnStatus; at: string; turnId?: string }

/**
 * One read's hold on the event loop: `ms` at a time, a turn of the loop in between. No single step of
 * a read (a message, a root, a commit) takes long; it is their number that does.
 */
class Slice {
  private until: number;

  constructor(private readonly ms: number, private readonly signal?: AbortSignal) { this.until = performance.now() + ms; }

  get due(): boolean { return performance.now() >= this.until; }

  /** Lets the loop turn; true when the read is to stop instead of going on. */
  async yield(): Promise<boolean> {
    await new Promise(resolve => setImmediate(resolve));
    this.until = performance.now() + this.ms;
    return this.stopped;
  }

  get stopped(): boolean { return Boolean(this.signal?.aborted); }
}

type Step = { op: 'event'; event: NativeWorkbenchEvent } | { op: 'end'; turn: TurnState } | { op: 'child'; toolCallId: string; agentId: string };

interface CompactionSignal { generationId?: string; trigger?: 'manual' | 'auto'; preTokens?: number; at: string }

export class CursorTranscriptSource implements AgentTranscriptSource {
  readonly limits: CursorTranscriptLimits;
  private bound: string | undefined;
  /** Subagents the service named (toolCallId → agentId), not yet taken into a lane's reading. */
  private readonly hinted = new Map<string, string>();
  private compactions: CompactionSignal[] = [];
  /**
   * Per chat, the live step last drafted and the store root it was drafted over: a step whose checkpoint
   * arrived is drafted only until the store moves on from that root, and only for so long.
   */
  private readonly liveBases = new Map<string, { step: string; root: string | undefined; sealedAt?: number; dismissed?: true }>();
  /** Chats whose live steps this source reads: the conversation's and its subagents'. */
  private readonly liveChats = new Set<string>();
  private wake: (() => void) | undefined;

  constructor(private readonly options: CursorTranscriptOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  restoreMapper(state: TranscriptMapperState): TranscriptMapper {
    const mapper = TranscriptMapper.restore(state);
    mapper.observedChanges = this.options.observedChanges;
    return mapper;
  }

  identity(): string | undefined {
    this.bound = this.options.chatId();
    return this.bound;
  }

  async pull(w: AgentLaneWriter, signal: AbortSignal): Promise<{ caughtUp: boolean }> {
    const view = this.open();
    if (!view) return { caughtUp: view === undefined };
    try {
      if (signal.aborted) return { caughtUp: false };
      return { caughtUp: await this.readWithTail(w, view, 0, true, new Slice(this.limits.sliceMs, signal)) };
    } finally { view.close(); }
  }

  watch(_w: AgentLaneWriter, wake: () => void): () => void {
    this.wake = wake;
    const live = this.options.live?.watch(chatId => { if (chatId === this.bound || this.liveChats.has(chatId)) wake(); });
    if (!this.options.signals) return () => { live?.(); };
    const signals = this.options.signals({
      changed: wake,
      subagent: (toolCallId, agentId) => {
        if (!toolCallId || !AGENT_ID.test(agentId) || this.hinted.get(toolCallId) === agentId) return;
        this.hinted.set(toolCallId, agentId);
        wake();
      },
      preCompact: info => {
        this.compactions = [...this.compactions, { ...info, at: new Date().toISOString() }].slice(-SIGNAL_LIMIT);
        wake();
      },
    });
    return () => { live?.(); signals(); };
  }

  /**
   * The step chat `chatId` streams over store root `root`, while it still says something the store does
   * not: until its checkpoint, then until the store moves on from the root it was first drafted over.
   */
  liveStep(chatId: string, root: string | undefined): CursorLiveStep | undefined {
    if (!this.options.live) return undefined;
    this.liveChats.delete(chatId);
    this.liveChats.add(chatId);
    while (this.liveChats.size > LIVE_CHATS) this.liveChats.delete(this.liveChats.values().next().value!);
    const step = this.options.live.read(chatId);
    const base = this.liveBases.get(chatId);
    if (!step) { this.liveBases.delete(chatId); return undefined; }
    if (base?.step === step.step && base.dismissed) return undefined;
    if (!step.sealed) {
      // A root that moves while the step streams is an earlier step's checkpoint landing late.
      if (base?.step !== step.step || base.root !== root) this.liveBases.set(chatId, { step: step.step, root });
      return step;
    }
    // A step first seen with its checkpoint in is already in the store, or about to be.
    if (base?.step !== step.step || base.root !== root) return undefined;
    const now = Date.now();
    if (base.sealedAt === undefined) {
      base.sealedAt = now;
      setTimeout(() => this.wake?.(), SEALED_LIVE_MS + 50).unref();
    }
    return now - base.sealedAt <= SEALED_LIVE_MS ? step : undefined;
  }

  /** The live step of `chatId` is not to be drafted again: its turn was ended. */
  dismissLive(chatId: string): void {
    const base = this.liveBases.get(chatId);
    if (base) base.dismissed = true;
  }

  drain(w: AgentLaneWriter): Promise<void> { return this.readServing(w); }

  /**
   * A turn the store leaves open because its last step never returned: the CLI was interrupted, failed
   * or exited in it, and a hook or the settled store says so. What is on disk is read first (G6); then
   * the turn the reading has open ends, `turnId`'s only (the CLI's request id) when given, and the
   * cursor records it, so whatever the CLI still writes of it opens a turn of its own. A turn the read
   * ended already is left as it was.
   */
  endTurn(w: AgentLaneWriter, status: AgentTurnStatus, at: string, turnId?: string): Promise<void> {
    return this.readServing(w, { status, at, ...(turnId ? { turnId } : {}) });
  }

  /** Reads everything on disk into the log that serves the lane (G6), then ends its open turn if asked to. */
  private async readServing(w: AgentLaneWriter, end?: TurnEnd): Promise<void> {
    const view = this.open();
    if (!view) return;
    try {
      const target = w.scratch ?? w;
      const options: ReadOptions = { bounded: false, origin: target === w ? 'start' : 'tail', serving: true, behind: false, depth: 0, slice: new Slice(this.limits.sliceMs) };
      await this.read(target, view, options, end);
    } finally { view.close(); }
  }

  /**
   * The store of the chat `identity()` named last; `null` when the session follows another chat by
   * now, so nothing of it is read into the lane bound to the old one (the next `pullLane` rebinds).
   */
  private open(): ChatView | undefined | null {
    const chatId = this.bound ?? this.identity();
    if (this.options.chatId() !== chatId) return null;
    if (!chatId || !CHAT_ID.test(chatId)) return undefined;
    return new ChatView(this.storePath(chatId), chatId);
  }

  private storePath(chatId: string): string { return join(this.options.chatsDir(), chatId, 'store.db'); }

  /**
   * G4: a long store read for the first time opens with its tail in a scratch window, which serves
   * while the lane imports from the start a step per pull. `serving` is false for a subagent's lane.
   */
  private async readWithTail(w: AgentLaneWriter, view: ChatView, depth: number, serving: boolean, slice: Slice): Promise<boolean> {
    const tail = (target: AgentLaneWriter) => this.read(target, view, { bounded: false, origin: 'tail', serving, behind: false, depth, slice });
    if (w.cursor === null && !w.scratch) {
      const ids = view.snapshot()?.messageIds;
      if (ids && ids.length > this.limits.stepMessages) await tail(w.openScratch());
    } else if (w.scratch) await tail(w.scratch);
    if (slice.stopped) return false;
    const behind = Boolean(w.scratch);
    return this.read(w, view, { bounded: true, origin: 'start', serving: serving && !behind, behind, depth, slice });
  }

  /** Reads `view` into `w` from its cursor on, then the subagents it follows; true once nothing readable is left. */
  private async read(w: AgentLaneWriter, view: ChatView, options: ReadOptions, end?: TurnEnd): Promise<boolean> {
    if (!view.meta()) return true;
    const saved = w.cursor === null ? undefined : parseState(w.cursor);
    if (w.cursor !== null && !saved) {
      // Only this reader writes this cursor; one it cannot read was written by another version of it.
      w.rebuild('identity-changed');
      return false;
    }
    const lane = new LaneRead(this, w, view, saved, options);
    const done = await lane.run();
    if (end) lane.end(end);
    return done;
  }

  /** Reads each subagent of a lane into a lane of its own (G9), dropping the ones that are done; true once all are caught up. */
  async readChildren(w: AgentLaneWriter, children: Map<string, string>, tasks: ReadonlyMap<string, AgentSubagentInfo>, options: ReadOptions): Promise<boolean> {
    let done = true;
    if (options.depth >= CHILD_DEPTH) return done;
    for (const [toolCallId, agentId] of [...children]) {
      if (options.slice.due && await options.slice.yield()) return false;
      const path = this.storePath(agentId);
      // A store the CLI has not created yet: nothing to read, kept for when it appears.
      if (!existsSync(path)) continue;
      const view = new ChatView(path, agentId);
      const depth = options.depth + 1;
      let child: AgentLaneWriter;
      try {
        child = w.child(toolCallId, agentId, subagentInfo(tasks.get(toolCallId), view.meta()));
        done = (options.bounded
          ? await this.readWithTail(child, view, depth, false, options.slice)
          : await this.read(child.scratch ?? child, view, { bounded: false, origin: child.scratch ? 'tail' : 'start', serving: false, behind: false, depth, slice: options.slice })) && done;
      } finally { view.close(); }
      if (finished(child)) children.delete(toolCallId);
    }
    return done;
  }

  /** CLI signals for the lane that serves: subagents it names and compactions it began. */
  takeHints(): Map<string, string> {
    const hints = new Map(this.hinted);
    this.hinted.clear();
    return hints;
  }

  takeCompactions(): CompactionSignal[] {
    const taken = this.compactions;
    this.compactions = [];
    return taken;
  }

  get sessionId(): string { return this.options.sessionId ?? ''; }
}

/** What a subagent's row shows of it: what its `Task` call asked for, else what its own store records. */
function subagentInfo(task: AgentSubagentInfo | undefined, meta: ChatMeta | undefined): AgentSubagentInfo {
  const subagentType = task?.subagentType ?? text(meta?.subagentInfo?.typeName), model = task?.model ?? text(meta?.lastUsedModel);
  return { ...(task?.title ? { title: task.title } : {}), ...(subagentType ? { subagentType } : {}), ...(model ? { model } : {}) };
}

/** A subagent lane needs no more reading: it has read its store to the end, its last turn ended, and so have its own subagents. */
function finished(w: AgentLaneWriter): boolean {
  const state = w.scratch || w.cursor === null ? undefined : parseState(w.cursor);
  return Boolean(state?.live && state.turn?.ended && !state.draft && !state.stale && state.n >= state.len && !state.children.length);
}

/** What a commit made in the middle of a message resumes from: the state before that message. */
interface Before { mapper: TranscriptMapperState; turn: TurnState | undefined; recent: string[] }

/** One read of one store into one lane. */
class LaneRead {
  private state: LaneState;
  private mapper: TranscriptMapper;
  private readonly fresh: boolean;
  private readonly children: Map<string, string>;
  /** Over the ids of the first `state.n` messages; undefined until the root is decoded. */
  private hash: Hash | undefined;
  private events: NativeWorkbenchEvent[] = [];
  private drafts: { finalId: string; event: NativeWorkbenchEvent }[] = [];
  private retire: string[] = [];
  /** Events each message read now produced, by position, for the drafts it replaces. */
  private readonly produced = new Map<number, number>();
  /** See `LaneState.stale`. */
  private stale: Set<string>;
  /** See `LaneState.tasks`. */
  private readonly tasks: Map<string, AgentSubagentInfo>;
  private seenAt: string | undefined;
  /** What this read holds in memory is not to be committed: the lane was rebuilt, or the read stopped mid-rewind. */
  private abandoned = false;

  constructor(private readonly source: CursorTranscriptSource, private readonly w: AgentLaneWriter, private readonly view: ChatView, saved: LaneState | undefined, private readonly options: ReadOptions) {
    this.fresh = !saved;
    this.state = saved ?? emptyState(0, '');
    this.mapper = this.source.restoreMapper(this.state.mapper);
    this.children = new Map(this.state.children);
    this.stale = new Set(this.state.stale);
    this.tasks = new Map(this.state.tasks);
  }

  async run(): Promise<boolean> {
    this.restoreCompactions();
    if (!await this.reprojectHistory()) return false;
    const meta = this.view.meta()!;
    let done = true;
    if (this.fresh || this.state.mapping !== MAPPING_VERSION || this.state.root !== meta.latestRootBlobId || this.state.n < this.state.len || this.stale.size) done = await this.readStore();
    // The store is where the last read left it; only the live step can have moved, unless the store has a step of its own.
    else if (this.state.live && (!this.state.draft || this.state.draft.live)) this.draft(this.state.len, undefined);
    if (this.abandoned) return done;
    if (this.options.serving) {
      if (this.state.turn) for (const signal of this.source.takeCompactions()) this.compactionStarted(signal);
      for (const [toolCallId, agentId] of this.source.takeHints()) this.follow(toolCallId, agentId);
    }
    this.flush();
    done = (await this.source.readChildren(this.w, this.children, this.tasks, this.options)) && done;
    this.flush();
    return done;
  }

  /** Repair old normalized payloads in place; CLI reads, receipts and terminal turn marks stay intact. */
  private async reprojectHistory(): Promise<boolean> {
    if (this.fresh || this.state.mapping === MAPPING_VERSION) return true;
    const meta = this.view.meta()!;
    let snapshot = this.state.root ? this.view.reader.snapshot({ ...meta, latestRootBlobId: this.state.root }) : this.view.snapshot();
    if (!snapshot?.rootAvailable) {
      const current = this.view.snapshot();
      // A CLI may discard the old root while keeping its messages. The cursor's prefix digest
      // proves those exact occurrences still stand at the same positions in the current root.
      if (current?.rootAvailable && this.state.n <= current.messageIds.length
        && digestOf(current.messageIds, this.state.n).digest('hex') === this.state.digest) snapshot = current;
    }
    // Leave unavailable storage to the ordinary live/import recovery path. Returning false here
    // would make sync immediately pull again instead of waiting for a store change.
    if (!snapshot?.rootAvailable) return true;
    const ids = snapshot.messageIds;
    const end = Math.min(this.state.n, ids.length);
    const saved = this.state.reproject;
    const progress = saved && saved.n <= end && saved.n >= Math.min(this.state.from, end)
      ? saved : { n: Math.min(this.state.from, end), mapper: new TranscriptMapper().state() };
    const mapper = this.source.restoreMapper(progress.mapper);
    const tasks = new Map(progress.tasks);
    const stop = this.options.bounded ? Math.min(end, progress.n + this.source.limits.stepMessages) : end;
    let events: NativeWorkbenchEvent[] = [], bytes = 0;
    const flush = () => {
      this.state.reproject = { n: progress.n, mapper: mapper.state(), tasks: [...tasks] };
      this.w.commit({ events, cursor: this.encode(), reproject: true });
      events = [];
    };
    while (progress.n < stop) {
      const position = progress.n, blob = ids[position]!;
      const read = this.view.reader.readMessage(blob);
      if (read.status === 'missing') { flush(); return true; }
      const children: Array<[string, string]> = [];
      if (read.status === 'ok') {
        bytes += read.bytes;
        mapper.map({ id: `${position}:${blob}`, message: read.message }).forEach((event, part) => {
          this.noteTask(event, tasks);
          const result = event.type === 'tool_call_update' && isRecord(event.data.subagentResult) ? event.data.subagentResult : undefined;
          const toolCallId = text(event.data.toolCallId), agentId = text(result?.agentId);
          const repaired = this.eventOf(event, position, blob, part, event.nativeTurnId ?? event.runId ?? '');
          if ((event.type === 'tool_call' && (event.data.kind === 'agent' || event.data.toolName === 'Glob')) || result ||
            (event.type === 'user_message_chunk' && Array.isArray(event.data.attachments))) {
            events.push(repaired);
          }
          if (toolCallId && agentId && AGENT_ID.test(agentId) && this.w.canReproject(repaired)) children.push([toolCallId, agentId]);
        });
      }
      progress.n = position + 1;
      if (children.length) {
        for (const [toolCallId, agentId] of children) {
          // Bind first: if the process stops before the cursor commit, this message is replayed
          // and the idempotent binding is found again. Never checkpoint past an unbound child.
          this.w.child(toolCallId, agentId, tasks.get(toolCallId));
          this.follow(toolCallId, agentId);
        }
        flush();
      }
      if (events.length >= COMMIT_EVENTS || this.options.slice.due) flush();
      if (this.options.bounded && bytes >= this.source.limits.stepBytes) break;
      if (this.options.slice.due && await this.options.slice.yield()) return false;
    }
    if (progress.n === end) {
      if (end === ids.length) {
        const pending = snapshot.pending && !sameStep(snapshot.pending, ids.length ? this.view.reader.message(ids.at(-1)!) : undefined) ? snapshot.pending : undefined;
        this.draft(ids.length, pending);
      }
      this.state.mapping = MAPPING_VERSION;
      delete this.state.reproject;
    }
    else this.state.reproject = { n: progress.n, mapper: mapper.state(), tasks: [...tasks] };
    this.w.commit({ events, drafts: this.drafts, retire: this.retire, cursor: this.encode(), reproject: true });
    this.drafts = []; this.retire = [];
    return progress.n === end;
  }

  /** {@link CursorTranscriptSource.endTurn}, once the store has been read. */
  end({ status, at, turnId }: TurnEnd): void {
    const turn = this.state.turn;
    // The turn a live step opened is the open one while the store has not recorded it.
    const prompt = this.state.draft?.prompt;
    if (!this.abandoned && prompt && (turnId ? turnId === prompt : !turn || turn.ended)) {
      this.source.dismissLive(this.view.chatId);
      this.dropDraft(status, at);
      this.flush();
      return;
    }
    if (this.abandoned || !turn || turn.ended || (turnId && turn.id !== turnId && this.mapper.turnId !== turnId)) return;
    turn.ended = true;
    this.writeEnd({ ...turn, at }, status);
    this.flush();
  }

  private abandon(): false {
    this.abandoned = true;
    return false;
  }

  /** Lets the event loop turn once the slice is spent, committing what was read first; true when the read is to stop. */
  private async pause(): Promise<boolean> {
    if (!this.options.slice.due) return false;
    this.flush();
    return this.options.slice.yield();
  }

  // ---- the store -----------------------------------------------------------------------------

  /** Reads the store's messages from the lane's place on; true once nothing readable is left. */
  private async readStore(): Promise<boolean> {
    const snapshot = this.view.snapshot();
    // A root can be committed before the blobs it names; the next change brings them. A lane not begun yet has nothing to record.
    if (!snapshot?.rootAvailable) {
      if (this.fresh) this.abandon();
      return !this.options.behind;
    }
    const ids = snapshot.messageIds;
    const root = snapshot.meta.latestRootBlobId;
    if (this.fresh) {
      const from = this.options.origin === 'tail' ? await this.tailStart(ids) : 0;
      if (from === undefined) return this.abandon();
      this.hash = digestOf(ids, from);
      this.state = emptyState(from, this.hash.copy().digest('hex'));
      this.mapper = this.source.restoreMapper(this.state.mapper);
    } else {
      this.hash = digestOf(ids, Math.min(this.state.n, ids.length));
      const moved = this.state.root !== root && (ids.length < this.state.n || this.hash.copy().digest('hex') !== this.state.digest);
      if (moved && !await this.rewind(snapshot, ids)) return false;
    }
    this.seenAt = this.state.live ? new Date().toISOString() : undefined;
    const compactions = snapshot.compactions ?? [];
    // An archive that lands after the messages it archived were read is placed where the read is now.
    for (const compaction of compactions) if (compaction.boundary > this.state.from && compaction.boundary < this.state.n) this.placeCompaction(compaction);
    const bounded = this.options.bounded && !this.stale.size;
    const stop = bounded ? Math.min(ids.length, this.state.n + this.source.limits.stepMessages) : ids.length;
    let bytes = 0, blocked = false;
    while (this.state.n < stop) {
      const position = this.state.n;
      for (const compaction of compactions) if (compaction.boundary === position && position > this.state.from) this.placeCompaction(compaction);
      const blob = ids[position]!;
      const result = this.view.reader.readMessage(blob);
      if (result.status === 'missing') { blocked = true; break; }
      // A committed blob that is not a message never becomes one; it is passed over, as the in-memory transcript does.
      if (result.status === 'ok') { this.message(position, blob, result.message); bytes += result.bytes; }
      this.settleDraftAt(position);
      this.state.n = position + 1;
      this.hash.update(blob).update('\0');
      if (this.events.length >= COMMIT_EVENTS) this.flush();
      if (bounded && bytes >= this.source.limits.stepBytes) break;
      if (await this.pause()) break;
    }
    this.state.root = root;
    this.state.len = ids.length;
    const end = !blocked && this.state.n === ids.length;
    if (end) {
      for (const compaction of compactions) if (compaction.boundary === ids.length && ids.length > this.state.from) this.placeCompaction(compaction);
      const pending = snapshot.pending && !sameStep(snapshot.pending, ids.length ? this.view.reader.message(ids.at(-1)!) : undefined) ? snapshot.pending : undefined;
      // Caught up: a step the CLI is already streaming is drafted by this read, not the next one.
      this.state.live = true;
      this.draft(ids.length, pending);
      const drafted = new Set(this.drafts.map(draft => draft.finalId));
      for (const id of this.stale) if (!drafted.has(id)) this.retire.push(id);
      this.stale.clear();
      if (!pending && !this.mapper.awaitingReply && this.state.turn && !this.state.turn.ended) {
        this.flush();
        this.state.turn.ended = true;
        this.writeEnd({ ...this.state.turn }, 'completed');
      }
    }
    return end || (blocked && !this.options.behind);
  }

  /**
   * Where a tail window begins (`selectHistoryStart`), its messages read a slice at a time; undefined
   * when the read is to stop first.
   */
  private async tailStart(ids: readonly string[]): Promise<number | undefined> {
    const steps = historyStartSteps(ids, ids.length, { turns: this.source.limits.tailTurns, messages: this.source.limits.tailMessages });
    for (let step = steps.next(); ;) {
      if (step.done) return step.value.start;
      const message = this.view.reader.message(step.value);
      if (this.options.slice.due && await this.options.slice.yield()) return undefined;
      step = steps.next(message);
    }
  }

  /**
   * The history the lane was read from changed under it (a `/rewind`, or archives laid out anew). The
   * lane reads on from the first message that differs, in the state reading it from its start reaches
   * there; what the old history held from there on is retired unless read again. The old root is still
   * in the store (its blobs are not removed); without it the lane cannot tell what it holds and starts over.
   * Nothing is committed until the state is rebuilt: a read stopped meanwhile starts the rewind over.
   */
  private async rewind(snapshot: ChatSnapshot, ids: readonly string[]): Promise<boolean> {
    const old = this.state.root ? this.view.reader.snapshot({ ...snapshot.meta, latestRootBlobId: this.state.root }) : undefined;
    if (!old?.rootAvailable) { this.w.rebuild('identity-changed'); return this.abandon(); }
    const slice = this.options.slice;
    const before = this.state;
    const oldIds = old.messageIds;
    let at = 0;
    while (at < before.n && at < ids.length && at < oldIds.length && ids[at] === oldIds[at]) at += 1;
    at = Math.max(at, before.from);
    this.state = {
      ...emptyState(before.from, ''), placed: before.placed, children: before.children,
      ...(before.live ? { live: true as const } : {}), ...(before.compacting ? { compacting: before.compacting } : {}),
    };
    this.mapper = this.source.restoreMapper(this.state.mapper);
    this.hash = digestOf(ids, before.from);
    for (let position = before.from; position < at; position += 1) {
      const message = this.view.reader.message(ids[position]!);
      if (message) this.step(position, ids[position]!, message);
      this.hash.update(ids[position]!).update('\0');
      if (slice.due && await slice.yield()) return this.abandon();
    }
    this.state.n = at;
    const replay = this.mapper.fork();
    for (let position = at; position < Math.min(before.n, oldIds.length); position += 1) {
      const message = this.view.reader.message(oldIds[position]!);
      const count = message ? replay.map({ id: `${position}:${oldIds[position]}`, message }).length : 0;
      for (let part = 0; part < count; part += 1) this.stale.add(`${position}:${part}`);
      if (slice.due && await slice.yield()) return this.abandon();
    }
    if (before.draft) for (let part = 0; part < before.draft.count; part += 1) this.stale.add(`${before.draft.at}:${part}`);
    // The turn the history now breaks off in ended there (its rows are in the log already); what follows is a turn of its own.
    const turn = this.state.turn;
    if (turn && !turn.ended) { turn.ended = true; this.writeEnd({ ...turn }); }
    return true;
  }

  /** Maps one committed message and writes what it says. */
  private message(position: number, blob: string, message: ChatMessage): void {
    const before: Before = { mapper: this.mapper.state(), turn: this.state.turn && { ...this.state.turn }, recent: this.state.recent };
    let count = 0;
    for (const step of this.step(position, blob, message)) {
      if (step.op === 'event') { this.events.push(step.event); count += 1; }
      else if (step.op === 'child') this.follow(step.toolCallId, step.agentId);
      else {
        // A turn mark comes after what precedes it, committed first; a replay from here maps this message again.
        this.flush(this.encode(before));
        this.writeEnd(step.turn);
      }
    }
    this.produced.set(position, count);
    for (let part = 0; part < count; part += 1) this.stale.delete(`${position}:${part}`);
  }

  /** What one message means for the lane: its events under their ids and turn, the turns it ends, the subagents it names. */
  private step(position: number, blob: string, message: ChatMessage): Step[] {
    const steps: Step[] = [];
    const mapped = this.mapper.map({ id: `${position}:${blob}`, message, ...(this.seenAt ? { seenAt: this.seenAt } : {}) });
    mapped.forEach((event, part) => {
      let turn = this.state.turn;
      const opens = event.type === 'user_message_chunk' || event.type === 'task_notification';
      if (opens && event.runId !== turn?.run) {
        if (turn && !turn.ended) { steps.push({ op: 'end', turn: { ...turn } }); turn.ended = true; }
        const requestId = event.nativeTurnId;
        turn = this.openTurn(requestId && !this.state.recent.includes(requestId) ? requestId : event.runId ?? `turn:${position}:${blob}`, event.runId);
        if (this.state.liveEnded?.includes(turn.id)) {
          // Ended as never recorded; the CLI recorded it after all.
          this.state.liveEnded = this.state.liveEnded.filter(id => id !== turn!.id);
          this.w.turnReopened(turn.id, event.createdAt || new Date().toISOString());
        }
      } else if (!turn || turn.ended) {
        // Rows before any prompt, or a CLI turn that went on after it was ended: a turn of their own.
        turn = this.openTurn(`turn:${position}:${blob}`, turn?.run ?? this.mapper.run);
      }
      if (event.createdAt) turn.at = event.createdAt;
      this.noteTask(event);
      const claims = event.type === 'user_message_chunk' && Boolean(event.nativeTurnId) && turn.id === event.nativeTurnId;
      steps.push({ op: 'event', event: this.eventOf(event, position, blob, part, turn.id, claims) });
      const result = event.type === 'tool_call_update' && isRecord(event.data.subagentResult) ? event.data.subagentResult : undefined;
      const toolCallId = typeof event.data.toolCallId === 'string' ? event.data.toolCallId : undefined;
      if (toolCallId && typeof result?.agentId === 'string' && AGENT_ID.test(result.agentId)) steps.push({ op: 'child', toolCallId, agentId: result.agentId });
    });
    const turn = this.state.turn;
    if (turn) {
      if (this.mapper.awaitingReply && message.role !== 'user') turn.owes = true;
      else delete turn.owes;
    }
    return steps;
  }

  private openTurn(id: string, run: string | undefined): TurnState {
    const turn: TurnState = { id, ...(run ? { run } : {}), at: this.state.turn?.at ?? '' };
    this.state.turn = turn;
    this.state.recent = [...this.state.recent.filter(known => known !== id), id].slice(-RECENT_TURNS);
    return turn;
  }

  /** `claims`: the prompt a turn under its request id opens, also known by `cursorPromptAlias`. */
  private eventOf(event: TranscriptEvent, position: number, blob: string, part: number, turnId: string, claims = false): NativeWorkbenchEvent {
    const aliases = [...(blob ? [`${position}:${blob}:${part}`] : []), ...(claims ? [cursorPromptAlias(turnId)] : [])];
    return {
      sequence: 0, sessionId: this.source.sessionId, nativeId: `${position}:${part}`, ...(aliases.length ? { nativeAliases: aliases } : {}),
      ...(event.runId ? { runId: event.runId } : {}), nativeTurnId: turnId, type: event.type, data: event.data, createdAt: event.createdAt,
    };
  }

  private writeEnd(turn: TurnState, status: AgentTurnStatus = turn.owes ? 'interrupted' : 'completed'): void {
    const at = turn.at || new Date().toISOString();
    this.w.turnEnded(turn.id, status, at);
    // A compaction the CLI reported that no archive completed will not finish now; a late archive still can.
    const parsed = Date.parse(at);
    this.w.activities.settleWhere(activity => activity.kind === 'compaction', 'unknown', new Date(Number.isNaN(parsed) ? Date.now() : parsed));
  }

  // ---- the step in flight --------------------------------------------------------------------

  /** Once the message at a draft's place is read, the drafts it did not replace go. */
  private settleDraftAt(position: number): void {
    const draft = this.state.draft;
    if (!draft) return;
    // The store records the turn a live step opened: its prompt is the store's from here on.
    if (draft.prompt && position === draft.at - 1) {
      if (!this.produced.get(position)) this.retire.push(`${position}:0`);
      delete draft.prompt;
    }
    if (draft.at !== position) return;
    for (let part = this.produced.get(position) ?? 0; part < draft.count; part += 1) this.retire.push(`${position}:${part}`);
    delete this.state.draft;
  }

  /**
   * The step in flight as drafts under the ids its message will have: the store's (root field 4) at
   * `length`, else the step the CLI is streaming (`CursorTranscriptSource.liveStep`). A store step stays in
   * the turn the transcript is in, so it never opens a turn that would not end. A live step of a turn the
   * store has not recorded yet brings that turn's prompt, drafted first where the store will record it with the step after it,
   * under the request id the store will file both under; the turn ends here if the store never does.
   */
  private draft(length: number, pending: ChatMessage | undefined): void {
    const turn = this.state.turn;
    const mapper = this.mapper.fork();
    let at = length, turnId = turn?.id, message = pending, prompt: NativeWorkbenchEvent | undefined, live = false;
    const step = pending || !this.state.live ? undefined : this.source.liveStep(this.view.chatId, this.state.root);
    if (step && turn && !turn.ended && (turn.id === step.turn || this.mapper.turnId === step.turn)) {
      message = liveMessage(step);
      live = true;
    } else if (step?.prompt && !this.state.recent.includes(step.turn) && !this.state.liveEnded?.includes(step.turn)) {
      const promptAt = length || FIRST_PROMPT_AT;
      // The turn's time is the run's, so the same step read again is the same draft.
      const [event] = mapper.map({ id: `${promptAt}:draft`, message: livePrompt(step), seenAt: step.at });
      if (event?.type === 'user_message_chunk') {
        at = promptAt + 1;
        turnId = step.turn;
        prompt = this.eventOf(event, promptAt, '', 0, turnId, true);
        message = liveMessage(step);
        live = true;
      }
    }
    // A draft left at another place is not going to be written there: the store moved past it, or the live step went.
    if (this.state.draft && this.state.draft.at !== at) this.dropDraft();
    const previous = this.state.draft?.count ?? 0;
    const mapped = message && turnId ? mapper.map({ id: `${at}:draft`, message }) : [];
    // The prompt goes first: a draft keeps the place its first version took.
    if (mapped.length && prompt) this.drafts.push({ finalId: prompt.nativeId, event: prompt });
    mapped.forEach((event, part) => {
      // A `Task` call stays in the step in flight for as long as its subagent runs.
      this.noteTask(event);
      this.drafts.push({ finalId: `${at}:${part}`, event: this.eventOf(event, at, '', part, turnId!) });
    });
    for (let part = mapped.length; part < previous; part += 1) this.retire.push(`${at}:${part}`);
    if (!mapped.length) { this.endLivePrompt(); delete this.state.draft; return; }
    this.state.draft = { at, count: mapped.length, ...(live ? { live: true as const } : {}), ...(prompt ? { prompt: turnId! } : {}) };
  }

  /** The drafts of the step in flight go. */
  private dropDraft(status?: AgentTurnStatus, at?: string): void {
    const draft = this.state.draft;
    if (!draft) return;
    for (let part = 0; part < draft.count; part += 1) this.retire.push(`${draft.at}:${part}`);
    this.endLivePrompt(status, at);
    delete this.state.draft;
  }

  /** A turn only a live step's prompt opened ends with its drafts: the store never recorded it. */
  private endLivePrompt(status: AgentTurnStatus = 'interrupted', at = new Date().toISOString()): void {
    const turnId = this.state.draft?.prompt;
    if (!turnId) return;
    this.retire.push(`${this.state.draft!.at - 1}:0`);
    delete this.state.draft!.prompt;
    this.state.liveEnded = [...(this.state.liveEnded ?? []).filter(id => id !== turnId), turnId].slice(-RECENT_TURNS);
    this.w.turnEnded(turnId, status, at);
  }

  // ---- activities and subagents --------------------------------------------------------------

  /** A ledger that started empty (a restart) learns the compactions the lane still has open; that writes nothing new. */
  private restoreCompactions(): void {
    for (const activity of this.state.compacting ?? []) if (!this.w.activities.get(activity.id)) this.w.activities.apply(activity);
  }

  /** A compaction is filed under its turn, `#2` on for the next ones in the same turn, as the hook and the archive both can name it. */
  private compactionId(turnId: string | undefined): string {
    const base = activityId('cursor', `compaction:${turnId ?? 'chat'}`);
    const taken = new Set(Object.values(this.state.placed));
    let id = base;
    for (let index = 2; taken.has(id) || this.w.activities.get(id); index += 1) id = `${base}#${index}`;
    return id;
  }

  /**
   * G10: an archive is a completed compaction, placed after the last message it archived. A compaction
   * the CLI reported running (`preCompact`) that no archive has completed yet is this one.
   */
  private placeCompaction(compaction: ChatCompaction): void {
    if (this.state.placed[compaction.summaryId] || !this.state.turn) return;
    this.flush();
    const taken = new Set(Object.values(this.state.placed));
    const open = this.w.activities.list().filter(activity => isOpenCompaction(activity) && !taken.has(activity.id));
    const id = open.length === 1 ? open[0]!.id : this.compactionId(this.state.turn.id);
    const at = this.state.turn.at || new Date().toISOString();
    this.w.activities.apply({ id, kind: 'compaction', status: 'completed', title: '上下文压缩', ...(compaction.summary ? { detail: clipDetail(compaction.summary) } : {}), endedAt: at });
    this.state.placed = { ...this.state.placed, [compaction.summaryId]: id };
  }

  private compactionStarted(signal: CompactionSignal): void {
    this.flush();
    this.w.activities.apply({
      id: this.compactionId(signal.generationId ?? this.state.turn?.id), kind: 'compaction', status: 'running', title: '上下文压缩', startedAt: signal.at,
      compaction: { trigger: signal.trigger ?? 'auto', ...(signal.preTokens !== undefined ? { preTokens: signal.preTokens } : {}) },
    });
  }

  /** What a `Task` call asks of the subagent it starts, kept for that subagent's row (`child`). */
  private noteTask(event: TranscriptEvent, tasks = this.tasks): void {
    const toolCallId = text(event.data.toolCallId), task = event.type === 'tool_call' && isRecord(event.data.subagent) ? event.data.subagent : undefined;
    if (!toolCallId || !task) return;
    const title = text(task.description), subagentType = text(task.type), model = text(task.model);
    tasks.delete(toolCallId);
    tasks.set(toolCallId, { ...(title ? { title } : {}), ...(subagentType ? { subagentType } : {}), ...(model ? { model } : {}) });
    while (tasks.size > CHILD_LIMIT) tasks.delete(tasks.keys().next().value!);
  }

  /** A subagent the lane follows from now on; its lane is named once its store exists. */
  private follow(toolCallId: string, agentId: string): void {
    if (this.children.get(toolCallId) === agentId) return;
    this.children.delete(toolCallId);
    this.children.set(toolCallId, agentId);
    while (this.children.size > CHILD_LIMIT) this.children.delete(this.children.keys().next().value!);
  }

  // ---- commits -------------------------------------------------------------------------------

  private encode(before?: Before): string {
    const { v, mapping, reproject, from, root, n, len, live, placed, draft, liveEnded } = this.state;
    const turn = before ? before.turn : this.state.turn;
    const taken = new Set(Object.values(placed));
    const compacting = this.w.activities.list().filter(activity => isOpenCompaction(activity) && !taken.has(activity.id)).slice(-4);
    const state: LaneState = {
      v, ...(mapping ? { mapping } : {}), ...(reproject ? { reproject } : {}), from, ...(root ? { root } : {}), n, len, digest: this.hash ? this.hash.copy().digest('hex') : this.state.digest, ...(live ? { live } : {}),
      mapper: before?.mapper ?? this.mapper.state(), ...(turn ? { turn } : {}), recent: before?.recent ?? this.state.recent, placed,
      ...(draft ? { draft } : {}), ...(liveEnded?.length ? { liveEnded } : {}), children: [...this.children], ...(this.tasks.size ? { tasks: [...this.tasks] } : {}),
      ...(compacting.length ? { compacting } : {}), ...(this.stale.size ? { stale: [...this.stale] } : {}),
    };
    return JSON.stringify(state);
  }

  /** Commits what was read with the state to resume from: by default the one after everything read so far (G7). */
  private flush(cursor = this.encode()): void {
    if (!this.events.length && !this.drafts.length && !this.retire.length && cursor === this.w.cursor) return;
    const batch = { events: this.events, drafts: this.drafts, retire: this.retire, cursor };
    this.events = []; this.drafts = []; this.retire = [];
    this.w.commit(batch);
  }
}

/** A live step as the message its checkpoint will commit. */
function liveMessage(step: CursorLiveStep): ChatMessage {
  return { role: 'assistant', content: step.parts.map(part => (part.type === 'text' ? { type: 'text', text: part.text } : { type: 'reasoning', text: part.text })) };
}

/** A live step's prompt as the store records it: inside `<user_query>`, under the run's request id. */
function livePrompt(step: CursorLiveStep): ChatMessage {
  return { role: 'user', content: [{ type: 'text', text: `<user_query>\n${step.prompt}\n</user_query>` }], providerOptions: { cursor: { requestId: step.turn } } };
}
