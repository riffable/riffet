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
 *   older CLIs). A new prompt bounds the preceding turn. The last turn of an attached CLI waits
 *   for a hook or a settled idle prompt; the store may checkpoint several answers in one turn.
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
  /** Earlier chats of this conversation, oldest first (e.g. archived by `/new` in the personal assistant). */
  previousChatIds?(): readonly string[];
  /** A live CLI owns its last turn. After exit, a recorded outcome takes precedence over the lost connection. */
  tailState?(chatId: string, turnId: string): 'live' | 'exited' | CursorTurnResult | undefined;
  /** Where change signals come from; without it `watch` never wakes. */
  signals?(listener: CursorTranscriptSignals): () => void;
  /** Stamped on events; the journal does not keep it. */
  sessionId?: string;
  /** What a shell call changed in the working tree, seen around it (`AgentHost.workspaceChanges`); merged into its result. */
  observedChanges?(toolCallId: string): readonly Record<string, unknown>[] | undefined;
  /** Turns a persisted `<riffet-steer>` tool-result carrier into its verified `native_input_receipt` events. */
  additionalContext?(text: string, sourceNativeId: string, createdAt: string): NativeWorkbenchEvent[];
  /** The step each chat's CLI is streaming, ahead of its checkpoint in the store. */
  live?: Pick<CursorLive, 'read' | 'watch'>;
  limits?: Partial<CursorTranscriptLimits>;
}

const DEFAULT_LIMITS: CursorTranscriptLimits = { stepMessages: 512, stepBytes: 4 * 1024 * 1024, tailTurns: 8, tailMessages: 512, sliceMs: 40 };
const STATE_VERSION = 1;
/** Normalized events can be upgraded without clearing turn ends or changing lane generations. */
const MAPPING_VERSION = 4;
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
  /** This open turn was observed in a running CLI, including before a server restart. */
  attached?: true;
  /** Its newest message left a tool call or result unanswered: cut short there, it was interrupted. */
  owes?: true;
}

/**
 * Promoted draft of an interrupted/cancelled/failed turn whose step had not flushed to `store.db`
 * yet. Promoted in-place under `${at}:${part}` before `meta.turn_ended` so row keys stay stable;
 * once the store commits `at`, the canonical message updates those slots in place (and trailing
 * `role: 'tool'` abort results settle into `turnId`), or if the store discarded the step and
 * reused `at` for another turn, the lane rebuilds to avoid identity inversion.
 */
interface KeptDraft {
  turnId: string;
  run?: string;
  at?: number;
  count?: number;
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
  /** See {@link KeptDraft}. */
  kept?: KeptDraft;
  /** Turns a live step opened that were ended without the store recording them, so a late record reopens them. */
  liveEnded?: string[];
  /** Subagents (tool call id, agent id) still being read. */
  children: Array<[string, string]>;
  /** What the `Task` calls of the subagents not done yet asked for (`AgentSubagentInfo`), by tool call id: the store of a subagent does not say. */
  tasks?: Array<[string, AgentSubagentInfo]>;
  /** Tool call ids of foreground `Task` calls that failed (interrupted, errored): their subagents stop where their stores end. */
  stopped?: string[];
  /** Compactions the CLI reported that no archive has completed, so a restarted ledger knows them. */
  compacting?: NativeActivity[];
  /** Ids a rewound history held past the point it changed and no read has written again yet; retired at the end. */
  stale?: string[];
  /** Positions whose `<pos>:<part>` slots were retired in this generation (`[position, partCount]`). */
  retired?: Array<[number, number]>;
  /** True when a newer entity (e.g. compaction activity or abandoned live turn end) landed after a slot was retired. */
  retiredBarrier?: true;
  /** How many chats from `previousChatIds` have already been imported into this lane ahead of the active chat. */
  earlierDone?: number;
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
  /** A subagent's lane whose foreground `Task` call failed: the CLI stopped it and writes nothing more to its store. */
  stopped?: boolean;
}

export interface CursorTurnResult { status: AgentTurnStatus; at?: string; error?: string }

/** `endTurn`: how the turn the store leaves open ends, and which one it is when the caller knows. */
interface TurnEnd extends CursorTurnResult { at: string; turnId?: string; expectedRoot?: string; stillCurrent?: () => boolean }

function turnResult(w: AgentLaneWriter | undefined, id: string): CursorTurnResult | undefined {
  if (w?.turnEnd) return w.turnEnd(id);
  const status = w?.turnEndStatus(id);
  return status ? { status } : undefined;
}

/** A stop hook may arrive after the next prompt already bounded this exact turn. */
function correctInferredEnd(w: AgentLaneWriter, id: string, end: TurnEnd): boolean {
  const previous = turnResult(w, id);
  if (previous?.status === end.status) {
    // A stop hook can confirm failure before the pane shows its reason.
    if (previous.status === 'failed' && previous.at && !previous.error && end.error) w.turnEnded(id, 'failed', previous.at, end.error);
    return true;
  }
  if (end.expectedRoot || (previous?.status !== 'completed' && previous?.status !== 'interrupted')) return false;
  w.turnReopened(id, end.at);
  w.turnEnded(id, end.status, end.at, end.error);
  return true;
}

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

interface MappedPart {
  event: TranscriptEvent;
  /** Occurrence alias suffix (`${rawPart}` or `${rawPart}:${receiptIndex}`) so multi-steer carriers stay distinct. */
  aliasPart: string;
  /** Canonical steer receipt alias (`steer:<sha256>`) preserved alongside the positional journal id. */
  extraAlias?: string;
}

/**
 * Maps one stored message and expands any verified `<riffet-steer>` tool-result context into
 * `native_input_receipt` rows at the exact tool-result position, so steering stays causally ordered
 * instead of falling back to timestamp placement.
 */
function expandMessage(
  mapper: TranscriptMapper,
  position: number,
  blob: string,
  message: ChatMessage,
  seenAt: string | undefined,
  additionalContext: CursorTranscriptOptions['additionalContext'],
): MappedPart[] {
  const raw = mapper.map({ id: `${position}:${blob}`, message, ...(seenAt ? { seenAt } : {}) });
  if (!additionalContext) return raw.map((event, rawPart) => ({ event, aliasPart: String(rawPart) }));
  const expanded: MappedPart[] = [];
  raw.forEach((event, rawPart) => {
    if (event.type !== 'cursor_tool_context') {
      expanded.push({ event, aliasPart: String(rawPart) });
      return;
    }
    const context = typeof event.data.text === 'string' ? event.data.text : '';
    if (!context) return;
    const sourceNativeId = `${position}:${blob}:${rawPart}`;
    let receiptIndex = 0;
    for (const receipt of additionalContext(context, sourceNativeId, event.createdAt)) {
      if (receipt.type !== 'native_input_receipt') continue;
      expanded.push({
        event: {
          type: 'native_input_receipt',
          ...(receipt.runId ? { runId: receipt.runId } : {}),
          ...(receipt.nativeTurnId ? { nativeTurnId: receipt.nativeTurnId } : {}),
          createdAt: receipt.createdAt || event.createdAt,
          data: receipt.data,
        },
        aliasPart: receiptIndex === 0 ? String(rawPart) : `${rawPart}:${receiptIndex}`,
        ...(receipt.nativeId ? { extraAlias: receipt.nativeId } : {}),
      });
      receiptIndex += 1;
    }
  });
  return expanded;
}

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
    const current = this.options.chatId();
    this.bound = current;
    if (!current) return undefined;
    const previous = (this.options.previousChatIds?.() ?? []).filter(id => id && id !== current && CHAT_ID.test(id));
    return previous.length ? [...previous, current].join(' ') : current;
  }

  async pull(w: AgentLaneWriter, signal: AbortSignal): Promise<{ caughtUp: boolean }> {
    const view = this.open();
    if (!view) return { caughtUp: view === undefined };
    try {
      if (signal.aborted) return { caughtUp: false };
      const slice = new Slice(this.limits.sliceMs, signal);
      if (!await this.importEarlierChats(w, view.chatId, slice)) return { caughtUp: false };
      return { caughtUp: await this.readWithTail(w, view, 0, true, slice) };
    } finally { view.close(); }
  }

  /**
   * Imports archived chats from `previousChatIds` ahead of the active chat so `/new` keeps the full
   * conversation history readable in one lane without conflicting positional ids.
   */
  private async importEarlierChats(w: AgentLaneWriter, currentChatId: string, slice: Slice): Promise<boolean> {
    const previous = (this.options.previousChatIds?.() ?? []).filter(id => id && id !== currentChatId && CHAT_ID.test(id));
    if (!previous.length) return true;
    const saved = w.cursor === null ? undefined : parseState(w.cursor);
    const alreadyDone = saved?.earlierDone ?? 0;
    if (alreadyDone >= previous.length) return true;
    let state = saved ?? emptyState(0, '');
    for (let index = alreadyDone; index < previous.length; index += 1) {
      if (slice.stopped) return false;
      const prevId = previous[index]!;
      const view = new ChatView(this.storePath(prevId), prevId);
      try {
        const snapshot = view.snapshot();
        if (snapshot?.rootAvailable) {
          const mapper = new TranscriptMapper();
          mapper.observedChanges = this.options.observedChanges;
          const prefix = `prev:${prevId}:`;
          let batch: NativeWorkbenchEvent[] = [];
          let activeTurn: { id: string; run?: string; at: string } | undefined;
          const flushBatch = () => {
            if (!batch.length) return;
            w.commit({ events: batch, cursor: JSON.stringify(state) });
            batch = [];
          };
          for (let pos = 0; pos < snapshot.messageIds.length; pos += 1) {
            const blob = snapshot.messageIds[pos]!;
            const read = view.reader.readMessage(blob);
            if (read.status !== 'ok') continue;
            const mapped = expandMessage(mapper, pos, blob, read.message, undefined, this.options.additionalContext);
            mapped.forEach(({ event, aliasPart, extraAlias }, part) => {
              const opens = event.type === 'user_message_chunk' || event.type === 'task_notification';
              if (opens && event.runId !== activeTurn?.run) {
                if (activeTurn) { flushBatch(); w.turnEnded(activeTurn.id, 'completed', activeTurn.at || new Date().toISOString()); }
                const rawTurn = event.nativeTurnId ?? event.runId ?? `turn:${pos}:${blob}`;
                activeTurn = { id: `${prefix}${rawTurn}`, ...(event.runId ? { run: event.runId } : {}), at: event.createdAt };
              } else if (!activeTurn) {
                activeTurn = { id: `${prefix}turn:${pos}:${blob}`, ...(event.runId ? { run: event.runId } : {}), at: event.createdAt };
              }
              if (event.createdAt) activeTurn.at = event.createdAt;
              const aliases = [`${prefix}${pos}:${blob}:${aliasPart}`, ...(extraAlias ? [extraAlias] : [])];
              batch.push({
                sequence: 0, sessionId: this.sessionId, nativeId: `${prefix}${pos}:${part}`,
                nativeAliases: aliases,
                ...(event.runId ? { runId: event.runId } : {}), nativeTurnId: activeTurn.id,
                type: event.type, data: event.data, createdAt: event.createdAt,
              });
            });
            if (batch.length >= COMMIT_EVENTS) flushBatch();
            if (slice.due && await slice.yield()) return false;
          }
          flushBatch();
          if (activeTurn) w.turnEnded(activeTurn.id, 'completed', activeTurn.at || new Date().toISOString());
        }
      } finally { view.close(); }
      state = { ...state, earlierDone: index + 1 };
      w.commit({ events: [], cursor: JSON.stringify(state) });
    }
    return true;
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

  tailState(chatId: string, turnId: string) { return this.options.tailState?.(chatId, turnId); }

  async drain(w: AgentLaneWriter): Promise<void> { await this.readServing(w); }

  /**
   * Read-only check for recovery (`canReleaseInput` / `canReleaseAfterLaterTurn`): true only while
   * the serving lane has no open turn or active draft. When `later` is supplied, also proves that
   * the later turn ended as `completed` in the serving journal and the store root has not advanced.
   */
  canReleaseInput(w: AgentLaneWriter, later?: { chatId: string; turnId: string }): boolean {
    const serving = w.scratch ?? w;
    const cursor = serving.cursor;
    if (!cursor) {
      if (later) return false;
      const view = this.open();
      if (!view) return view === undefined;
      try { return !view.meta(); } finally { view.close(); }
    }
    const state = parseState(cursor);
    if (!state || (state.turn && !state.turn.ended) || state.draft) return false;
    if (!later) return true;
    if (serving.turnEndStatus(later.turnId) !== 'completed') return false;
    const view = this.open();
    if (!view || view.chatId !== later.chatId) { view?.close(); return false; }
    try {
      const meta = view.meta();
      return Boolean(meta && state.root === meta.latestRootBlobId);
    } finally { view.close(); }
  }

  settleTurnEnd(w: AgentLaneWriter, end: { turnId: string; status: AgentTurnStatus; at: string; error?: string }): Promise<boolean> {
    return this.endTurn(w, end);
  }

  /** Drain the CLI's checkpoint before the hook or settled idle observation ends its turn (G6). */
  endTurn(w: AgentLaneWriter, end: TurnEnd): Promise<boolean> {
    return this.readServing(w, end);
  }

  /** Reads everything on disk into the log that serves the lane (G6), then ends its open turn if asked to. */
  private async readServing(w: AgentLaneWriter, end?: TurnEnd): Promise<boolean> {
    const view = this.open();
    if (!view) return false;
    try {
      const target = w.scratch ?? w;
      const options: ReadOptions = { bounded: false, origin: target === w ? 'start' : 'tail', serving: true, behind: false, depth: 0, slice: new Slice(this.limits.sliceMs) };
      const accepted = await this.read(target, view, options, end);
      if (accepted && target !== w && end?.turnId && target.turnEndStatus(end.turnId) === end.status) {
        correctInferredEnd(w, end.turnId, end);
      }
      return accepted;
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
  private async readWithTail(w: AgentLaneWriter, view: ChatView, depth: number, serving: boolean, slice: Slice, stopped = false): Promise<boolean> {
    const tail = (target: AgentLaneWriter) => this.read(target, view, { bounded: false, origin: 'tail', serving, behind: false, depth, slice, stopped });
    if (w.cursor === null && !w.scratch) {
      const ids = view.snapshot()?.messageIds;
      if (ids && ids.length > this.limits.stepMessages) await tail(w.openScratch());
    } else if (w.scratch) await tail(w.scratch);
    if (slice.stopped) return false;
    const behind = Boolean(w.scratch);
    return this.read(w, view, { bounded: true, origin: 'start', serving: serving && !behind, behind, depth, slice, stopped });
  }

  /** Reads `view` into `w` from its cursor on, then the subagents it follows; true once nothing readable is left. */
  private async read(w: AgentLaneWriter, view: ChatView, options: ReadOptions, end?: TurnEnd): Promise<boolean> {
    if (!view.meta()) return !end;
    const saved = w.cursor === null ? undefined : parseState(w.cursor);
    if (w.cursor !== null && !saved) {
      // Only this reader writes this cursor; one it cannot read was written by another version of it.
      w.rebuild('identity-changed');
      return false;
    }
    const lane = new LaneRead(this, w, view, saved, options);
    return lane.run(end);
  }

  /** Reads each subagent of a lane into a lane of its own (G9), dropping the ones that are done; true once all are caught up. */
  async readChildren(w: AgentLaneWriter, children: Map<string, string>, tasks: ReadonlyMap<string, AgentSubagentInfo>, stopped: Set<string>, options: ReadOptions): Promise<boolean> {
    let done = true;
    if (options.depth >= CHILD_DEPTH) return done;
    for (const [toolCallId, agentId] of [...children]) {
      if (options.slice.due && await options.slice.yield()) return false;
      const path = this.storePath(agentId);
      // A store the CLI has not created yet: nothing to read, kept for when it appears.
      if (!existsSync(path)) continue;
      const view = new ChatView(path, agentId);
      const depth = options.depth + 1, halted = stopped.has(toolCallId);
      let child: AgentLaneWriter;
      try {
        child = w.child(toolCallId, agentId, subagentInfo(tasks.get(toolCallId), view.meta()));
        done = (options.bounded
          ? await this.readWithTail(child, view, depth, false, options.slice, halted)
          : await this.read(child.scratch ?? child, view, { bounded: false, origin: child.scratch ? 'tail' : 'start', serving: false, behind: false, depth, slice: options.slice, stopped: halted })) && done;
      } finally { view.close(); }
      if (finished(child)) { children.delete(toolCallId); stopped.delete(toolCallId); }
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

  get additionalContext(): CursorTranscriptOptions['additionalContext'] { return this.options.additionalContext; }
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
  /** See `LaneState.retired`. */
  private readonly retired: Map<number, number>;
  /** See `LaneState.retiredBarrier`. */
  private retiredBarrier: boolean;
  /** See `LaneState.tasks`. */
  private readonly tasks: Map<string, AgentSubagentInfo>;
  /** See `LaneState.stopped`. */
  private readonly stopped: Set<string>;
  private seenAt: string | undefined;
  /** This read reached a stored assistant checkpoint with no pending step. */
  private historyAnswered = false;
  /** What this read holds in memory is not to be committed: the lane was rebuilt, or the read stopped mid-rewind. */
  private abandoned = false;

  constructor(private readonly source: CursorTranscriptSource, private readonly w: AgentLaneWriter, private readonly view: ChatView, saved: LaneState | undefined, private readonly options: ReadOptions) {
    this.fresh = !saved || (saved.root === undefined && saved.n === 0);
    this.state = saved ?? emptyState(0, '');
    this.mapper = this.source.restoreMapper(this.state.mapper);
    this.children = new Map(this.state.children);
    this.stale = new Set(this.state.stale);
    this.retired = new Map(this.state.retired);
    this.retiredBarrier = this.state.retiredBarrier === true;
    this.tasks = new Map(this.state.tasks);
    this.stopped = new Set(this.state.stopped);
  }

  private runAtomically(task: () => void): void {
    if (this.w.transaction) this.w.transaction(task);
    else task();
  }

  /** Retires a positional entity and remembers its slot so a later message never reuses a tombstoned identity out of order. */
  private retireId(id: string): void {
    this.retire.push(id);
    const match = /^(\d+):(\d+)$/.exec(id);
    if (match) {
      const pos = Number(match[1]), part = Number(match[2]);
      this.retired.set(pos, Math.max(this.retired.get(pos) ?? 0, part + 1));
    }
  }

  /** Whether writing `count` parts at `position` would invert journal `identity` order against retired slots. */
  private conflictsRetired(position: number, count: number): boolean {
    if (count <= 0) return false;
    const oldParts = this.retired.get(position);
    if (oldParts === undefined) return false;
    if (this.retiredBarrier) return true;
    let maxRetired = -1;
    for (const pos of this.retired.keys()) if (pos > maxRetired) maxRetired = pos;
    return count > oldParts && maxRetired > position;
  }

  async run(end?: TurnEnd): Promise<boolean> {
    this.restoreCompactions();
    if (!await this.reprojectHistory()) return false;
    const meta = this.view.meta()!;
    let done = true;
    if (this.fresh || this.state.mapping !== MAPPING_VERSION || this.state.root !== meta.latestRootBlobId || this.state.n < this.state.len || this.stale.size) done = await this.readStore();
    // The store is where the last read left it; only the live step can have moved, unless the store has a step of its own.
    else if (this.state.live && (!this.state.draft || this.state.draft.live)) done = this.draft(this.state.len, undefined);
    if (this.abandoned) return !end && done;
    this.settleTail(end);
    if (this.options.serving) {
      if (this.state.turn) for (const signal of this.source.takeCompactions()) this.compactionStarted(signal);
      for (const [toolCallId, agentId] of this.source.takeHints()) this.follow(toolCallId, agentId);
    }
    this.flush();
    const childrenDone = await this.source.readChildren(this.w, this.children, this.tasks, this.stopped, this.options);
    this.flush();
    // A child still importing history does not hold the parent's Stop hook open.
    return end ? done && this.end(end) : done && childrenDone;
  }

  private settleTail(ending?: TurnEnd): void {
    const turn = this.state.turn;
    if (!turn || turn.ended || !this.state.live || this.state.n !== this.state.len) return;
    // Promotion drops the scratch log. Carry the outcome it served into the full history first.
    let outcome = turnResult(this.w.scratch, turn.id);
    if (!outcome) {
      if (ending && (!ending.turnId || ending.turnId === turn.id || ending.turnId === this.mapper.turnId)) return;
      const state = this.options.depth === 0 ? this.source.tailState(this.view.chatId, this.mapper.turnId ?? turn.id) : undefined;
      if (state === 'live') {
        turn.attached = true;
        return;
      }
      if (state === 'exited' && turn.attached) outcome = { status: 'interrupted' };
      else if (state && state !== 'exited') outcome = state;
      else if (this.historyAnswered && !this.state.draft && !turn.attached) outcome = { status: 'completed' };
      // The CLI writes no end to the store of a subagent it stopped: the parent's failed `Task` result is that end.
      else if (this.options.stopped && !this.state.draft?.prompt) outcome = { status: 'interrupted' };
    }
    if (!outcome) return;
    this.finishTurn(turn, outcome);
  }

  private get additionalContext(): CursorTranscriptOptions['additionalContext'] {
    return this.options.depth === 0 ? this.source.additionalContext : undefined;
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
        let rebuild = false;
        expandMessage(mapper, position, blob, read.message, undefined, this.additionalContext).forEach(({ event, aliasPart, extraAlias }, part) => {
          this.noteTask(event, tasks);
          const result = event.type === 'tool_call_update' && isRecord(event.data.subagentResult) ? event.data.subagentResult : undefined;
          const toolCallId = text(event.data.toolCallId), agentId = text(result?.agentId);
          const repaired = this.eventOf(event, position, blob, part, event.nativeTurnId ?? event.runId ?? '', false, aliasPart, extraAlias);
          if ((event.type === 'tool_call' && (event.data.kind === 'agent' || event.data.toolName === 'Glob')) || result ||
            (event.type === 'user_message_chunk' && Array.isArray(event.data.attachments)) ||
            event.type === 'native_input_receipt') {
            if (event.type === 'native_input_receipt' && !this.w.canReproject(repaired)) rebuild = true;
            else events.push(repaired);
          }
          if (toolCallId && agentId && AGENT_ID.test(agentId) && this.w.canReproject(repaired)) children.push([toolCallId, agentId]);
        });
        if (rebuild) {
          this.w.rebuild('identity-changed');
          return this.abandon();
        }
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
  end(end: TurnEnd): boolean {
    const { status, turnId, expectedRoot, stillCurrent } = end;
    if (this.abandoned || (stillCurrent && !stillCurrent())) return false;
    const turn = this.state.turn;
    if (expectedRoot) {
      if (this.state.root !== expectedRoot || this.state.n !== this.state.len || this.view.reader.meta()?.latestRootBlobId !== expectedRoot) return false;
      // A new step can start during the drain without changing the store root yet.
      const live = this.source.liveStep(this.view.chatId, expectedRoot);
      if (live && !live.sealed && !this.state.recent.includes(live.turn)) return false;
      if (status === 'completed' && (this.state.draft || (live && !live.sealed && live.turn === this.mapper.turnId))) return false;
    }
    // The turn a live step opened is the open one while the store has not recorded it.
    const prompt = this.state.draft?.prompt;
    if (prompt && (turnId ? turnId === prompt : !turn || turn.ended)) {
      this.source.dismissLive(this.view.chatId);
      this.dropDraft(end);
      this.flush();
      return true;
    }
    // A continuation after an older end has its own journal id and the same CLI request id.
    // Settle the continuation before considering a correction to the earlier end.
    if (!turn || turn.ended || (turnId && turn.id !== turnId && this.mapper.turnId !== turnId)) {
      if (turn?.ended && (!turnId || turnId === turn.id || turnId === this.mapper.turnId)) {
        return correctInferredEnd(this.w, turn.id, end);
      }
      return !!turnId && correctInferredEnd(this.w, turnId, end);
    }
    this.finishTurn(turn, end);
    return true;
  }

  /**
   * Ends `turn`, promoting any uncommitted non-prompt draft of an interrupted/cancelled/failed turn
   * in-place under `${draft.at}:${part}` before `meta.turn_ended` so visible in-flight work and
   * row keys stay intact while waiting for `store.db` to flush.
   */
  private finishTurn(turn: TurnState, outcome: CursorTurnResult): void {
    const endAt = outcome.at || turn.at || new Date().toISOString();
    const end = { status: outcome.status, at: endAt, ...(outcome.error ? { error: outcome.error } : {}) };
    if (this.state.draft && !this.state.draft.prompt) {
      if (outcome.status !== 'completed') this.keepDraft(turn, endAt);
      else {
        this.source.dismissLive(this.view.chatId);
        this.dropDraft();
      }
    }
    this.runAtomically(() => {
      this.flush();
      turn.ended = true;
      this.writeEnd(turn, end);
      this.flush();
    });
  }

  private currentDraftMessage(draft: NonNullable<LaneState['draft']>): ChatMessage | undefined {
    if (draft.live) {
      const step = this.source.liveStep(this.view.chatId, this.state.root);
      return step ? liveMessage(step) : undefined;
    }
    const snapshot = this.view.snapshot();
    if (!snapshot?.pending) return undefined;
    const ids = snapshot.messageIds;
    return sameStep(snapshot.pending, ids.length ? this.view.reader.message(ids.at(-1)!) : undefined) ? undefined : snapshot.pending;
  }

  private keepDraft(turn: TurnState, endAt: string): void {
    const draft = this.state.draft;
    if (!draft || draft.prompt) return;
    const message = this.currentDraftMessage(draft);
    const mapped = message ? this.mapper.fork().map({ id: `${draft.at}:draft`, message }) : [];
    this.source.dismissLive(this.view.chatId);
    if (!mapped.length) {
      this.dropDraft();
      if (this.retired.size) this.retiredBarrier = true;
      return;
    }
    mapped.forEach((event, part) => {
      this.noteTask(event);
      const promoted = this.eventOf(event, draft.at, '', part, turn.id);
      this.events.push({
        ...promoted,
        ...(promoted.runId ? {} : turn.run ? { runId: turn.run } : {}),
        createdAt: promoted.createdAt || turn.at || endAt,
      });
    });
    for (let part = mapped.length; part < draft.count; part += 1) this.retireId(`${draft.at}:${part}`);
    this.state.kept = {
      turnId: turn.id,
      ...(turn.run ? { run: turn.run } : {}),
      at: draft.at,
      count: mapped.length,
    };
    this.drafts = [];
    delete this.state.draft;
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
      const earlierDone = this.state.earlierDone;
      this.state = { ...emptyState(from, this.hash.copy().digest('hex')), ...(earlierDone !== undefined ? { earlierDone } : {}) };
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
      const kept = this.state.kept;
      if (kept && kept.at === position) {
        const preview = result.status === 'ok' ? expandMessage(this.mapper.fork(), position, blob, result.message, undefined, this.additionalContext) : [];
        const opensNext = preview.length > 0 && (preview[0]!.event.type === 'user_message_chunk' || preview[0]!.event.type === 'task_notification');
        if (opensNext) {
          this.w.rebuild('identity-changed');
          return this.abandon();
        }
        if (preview.length === 0 || result.status !== 'ok') {
          for (let part = 0; part < (kept.count ?? 0); part += 1) this.retireId(`${position}:${part}`);
          this.retiredBarrier = true;
          delete this.state.kept;
          this.state.n = position + 1;
          this.hash.update(blob).update('\0');
          if (await this.pause()) break;
          continue;
        }
        const hadRetired = this.retired.has(position);
        if (hadRetired) {
          if (this.conflictsRetired(position, preview.length)) { this.w.rebuild('identity-changed'); return this.abandon(); }
          if (preview.length >= (this.retired.get(position) ?? 0)) {
            this.retired.delete(position);
            if (!this.retired.size) this.retiredBarrier = false;
          }
        }
        const absorbed = this.absorbKept(kept, position, blob, result.message, result.bytes, preview.length, ids, stop, compactions);
        if (absorbed === undefined) return false;
        bytes += absorbed;
        if (!hadRetired && this.retired.size && (this.produced.get(position) ?? 0) > 0) this.retiredBarrier = true;
        if (bounded && bytes >= this.source.limits.stepBytes) break;
        if (await this.pause()) break;
        continue;
      }
      if (kept && kept.at === undefined) {
        if (result.status === 'ok' && result.message.role === 'tool') {
          const previewCount = expandMessage(this.mapper.fork(), position, blob, result.message, undefined, this.additionalContext).length;
          const hadRetired = this.retired.has(position);
          if (hadRetired) {
            if (this.conflictsRetired(position, previewCount)) { this.w.rebuild('identity-changed'); return this.abandon(); }
            if (previewCount >= (this.retired.get(position) ?? 0)) {
              this.retired.delete(position);
              if (!this.retired.size) this.retiredBarrier = false;
            }
          }
          const absorbed = this.absorbKept(kept, position, blob, result.message, result.bytes, previewCount, ids, stop, compactions);
          if (absorbed === undefined) return false;
          bytes += absorbed;
          if (!hadRetired && this.retired.size && (this.produced.get(position) ?? 0) > 0) this.retiredBarrier = true;
          if (bounded && bytes >= this.source.limits.stepBytes) break;
          if (await this.pause()) break;
          continue;
        }
        delete this.state.kept;
      }
      // A positional slot retired by an earlier rewind or dropped draft keeps its old rev=1
      // identity in the journal; rebuild if writing this message would invert identity order.
      const hadRetired = this.retired.has(position);
      if (result.status === 'ok' && hadRetired) {
        const previewCount = expandMessage(this.mapper.fork(), position, blob, result.message, undefined, this.additionalContext).length;
        if (this.conflictsRetired(position, previewCount)) { this.w.rebuild('identity-changed'); return this.abandon(); }
        if (previewCount >= (this.retired.get(position) ?? 0)) {
          this.retired.delete(position);
          if (!this.retired.size) this.retiredBarrier = false;
        }
      }
      // A committed blob that is not a message never becomes one; it is passed over, as the in-memory transcript does.
      if (result.status === 'ok') {
        this.message(position, blob, result.message);
        bytes += result.bytes;
        if (!hadRetired && this.retired.size && (this.produced.get(position) ?? 0) > 0) this.retiredBarrier = true;
      }
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
      if (!this.draft(ids.length, pending)) return false;
      const drafted = new Set(this.drafts.map(draft => draft.finalId));
      for (const id of this.stale) if (!drafted.has(id)) this.retireId(id);
      this.stale.clear();
      this.historyAnswered = !pending && !this.mapper.awaitingReply;
    }
    return end || (blocked && !this.options.behind);
  }

  /**
   * Reconciles delayed `store.db` rows for a turn whose draft was promoted in place, plus any
   * immediately trailing `role: 'tool'` abort results. Keeps `meta.turn_ended` intact (never
   * emitting fake `turnReopened` corrections on normal delayed flushes or failed/cancelled turns);
   * only re-anchors an `interrupted` end per G6 if the flushed step genuinely gained extra parts
   * beyond what was promoted.
   */
  private absorbKept(kept: KeptDraft, position: number, blob: string, message: ChatMessage, firstBytes: number, previewCount: number, ids: readonly string[], stop: number, compactions: readonly ChatCompaction[]): number | undefined {
    this.flush();
    let bytes = firstBytes;
    const grew = kept.at === position && previewCount > (kept.count ?? 0);
    const currentEnd = grew ? this.w.turnEnd?.(kept.turnId) : undefined;
    const reanchor = grew && currentEnd?.status === 'interrupted';
    let aborted = false;
    this.runAtomically(() => {
      if (reanchor) this.w.turnReopened(kept.turnId, currentEnd.at);
      this.state.turn = { id: kept.turnId, ...(kept.run ? { run: kept.run } : {}), at: this.state.turn?.at ?? '' };
      this.message(position, blob, message);
      if (kept.at === position) {
        for (let part = this.produced.get(position) ?? 0; part < (kept.count ?? 0); part += 1) this.retireId(`${position}:${part}`);
      }
      this.state.n = position + 1;
      this.hash!.update(blob).update('\0');
      while (this.mapper.awaitingReply && this.state.n < stop) {
        if (compactions.some(compaction => compaction.boundary === this.state.n && this.state.n > this.state.from)) break;
        const nextBlob = ids[this.state.n]!;
        const nextRead = this.view.reader.readMessage(nextBlob);
        if (nextRead.status !== 'ok' || nextRead.message.role !== 'tool') break;
        if (this.retired.has(this.state.n)) {
          const nextCount = expandMessage(this.mapper.fork(), this.state.n, nextBlob, nextRead.message, undefined, this.additionalContext).length;
          if (this.conflictsRetired(this.state.n, nextCount)) {
            this.events = []; this.drafts = []; this.retire = [];
            this.w.rebuild('identity-changed');
            this.abandon();
            aborted = true;
            return;
          }
          if (nextCount >= (this.retired.get(this.state.n) ?? 0)) {
            this.retired.delete(this.state.n);
            if (!this.retired.size) this.retiredBarrier = false;
          }
        }
        this.message(this.state.n, nextBlob, nextRead.message);
        bytes += nextRead.bytes;
        this.state.n += 1;
        this.hash!.update(nextBlob).update('\0');
      }
      if (this.mapper.awaitingReply) {
        this.state.kept = { turnId: kept.turnId, ...(kept.run ? { run: kept.run } : {}) };
      } else {
        delete this.state.kept;
      }
      this.state.turn.ended = true;
      this.flush(this.encode(), { ended: !reanchor });
      if (reanchor) this.w.turnEnded(kept.turnId, currentEnd.status, currentEnd.at, currentEnd.error);
    });
    return aborted ? undefined : bytes;
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
    if (before.kept?.at !== undefined && at <= before.kept.at) {
      this.w.rebuild('identity-changed');
      return this.abandon();
    }
    this.state = {
      ...emptyState(before.from, ''), placed: before.placed, children: before.children,
      ...(before.live ? { live: true as const } : {}), ...(before.compacting ? { compacting: before.compacting } : {}),
      ...(before.earlierDone !== undefined ? { earlierDone: before.earlierDone } : {}),
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
    const oldCounts = new Map<number, number>();
    for (let position = at; position < Math.min(before.n, oldIds.length); position += 1) {
      const message = this.view.reader.message(oldIds[position]!);
      const count = message ? expandMessage(replay, position, oldIds[position]!, message, undefined, this.additionalContext).length : 0;
      if (count > 0) oldCounts.set(position, count);
      for (let part = 0; part < count; part += 1) this.stale.add(`${position}:${part}`);
      if (slice.due && await slice.yield()) return this.abandon();
    }
    if (before.draft) {
      if (before.draft.at >= at) oldCounts.set(before.draft.at, Math.max(oldCounts.get(before.draft.at) ?? 0, before.draft.count));
      if (before.draft.prompt && before.draft.at - 1 >= at) oldCounts.set(before.draft.at - 1, Math.max(oldCounts.get(before.draft.at - 1) ?? 0, 1));
      for (let part = 0; part < before.draft.count; part += 1) this.stale.add(`${before.draft.at}:${part}`);
      if (before.draft.prompt) this.stale.add(`${before.draft.at - 1}:0`);
    }
    // Check whether rewriting `<position>:<part>` in place preserves journal identity order:
    // a new part (`rev=1`) before a higher already-occupied slot, a new part before an already-placed
    // compaction activity, or reusing a previously retired slot would invert timeline ordering.
    const preview = this.mapper.fork();
    let maxExisting = -1;
    for (const pos of oldCounts.keys()) if (pos > maxExisting) maxExisting = pos;
    for (const pos of this.retired.keys()) if (pos >= at && pos > maxExisting) maxExisting = pos;
    const maxCompactionBound = (snapshot.compactions ?? [])
      .filter(c => before.placed[c.summaryId] && c.boundary > before.from)
      .reduce((max, c) => Math.max(max, c.boundary), -1);
    for (let position = at; position < ids.length; position += 1) {
      const message = this.view.reader.message(ids[position]!);
      const count = message ? expandMessage(preview, position, ids[position]!, message, undefined, this.additionalContext).length : 0;
      const oldCount = Math.max(oldCounts.get(position) ?? 0, this.retired.get(position) ?? 0);
      if (count > 0 && (this.conflictsRetired(position, count) || (count > oldCount && (maxExisting > position || maxCompactionBound > position)))) {
        this.w.rebuild('identity-changed');
        return this.abandon();
      }
      if (slice.due && await slice.yield()) return this.abandon();
    }
    // A rewind that cut back before `before.turn` started leaves that turn behind and ends the
    // earlier turn where the history now breaks off; an in-place rewrite of a tool/assistant blob
    // inside the current turn keeps `this.state.turn`'s open/ended state intact.
    if (this.state.turn?.id !== before.turn?.id) {
      if (before.turn && !before.turn.ended) this.writeEnd({ ...before.turn });
      const turn = this.state.turn;
      if (turn && !turn.ended) {
        turn.ended = true;
        if (!this.w.turnEndStatus(turn.id)) this.writeEnd({ ...turn });
      }
    } else if (this.state.turn && before.turn?.ended) {
      this.state.turn.ended = true;
    }
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
    const mapped = expandMessage(this.mapper, position, blob, message, this.seenAt, this.additionalContext);
    mapped.forEach(({ event, aliasPart, extraAlias }, part) => {
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
      steps.push({ op: 'event', event: this.eventOf(event, position, blob, part, turn.id, claims, aliasPart, extraAlias) });
      const result = event.type === 'tool_call_update' && isRecord(event.data.subagentResult) ? event.data.subagentResult : undefined;
      const toolCallId = typeof event.data.toolCallId === 'string' ? event.data.toolCallId : undefined;
      if (toolCallId && typeof result?.agentId === 'string' && AGENT_ID.test(result.agentId)) steps.push({ op: 'child', toolCallId, agentId: result.agentId });
      // A background `Task` returns once its subagent starts, so only a foreground one failing means the subagent stopped.
      if (toolCallId && result && event.data.status === 'failed' && result.background !== true) this.noteStopped(toolCallId);
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
  private eventOf(event: TranscriptEvent, position: number, blob: string, part: number, turnId: string, claims = false, aliasPart: string = String(part), extraAlias?: string): NativeWorkbenchEvent {
    const aliases = [...(blob ? [`${position}:${blob}:${aliasPart}`] : []), ...(claims ? [cursorPromptAlias(turnId)] : []), ...(extraAlias ? [extraAlias] : [])];
    return {
      sequence: 0, sessionId: this.source.sessionId, nativeId: `${position}:${part}`, ...(aliases.length ? { nativeAliases: aliases } : {}),
      ...(event.runId ? { runId: event.runId } : {}), nativeTurnId: turnId, type: event.type, data: event.data, createdAt: event.createdAt,
    };
  }

  private writeEnd(turn: TurnState, result = turnResult(this.w.scratch, turn.id)): void {
    const at = result?.at || turn.at || new Date().toISOString();
    this.w.turnEnded(turn.id, result?.status ?? (turn.owes ? 'interrupted' : 'completed'), at, result?.error);
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
      if (!this.produced.get(position)) this.retireId(`${position}:0`);
      delete draft.prompt;
    }
    if (draft.at !== position) return;
    for (let part = this.produced.get(position) ?? 0; part < draft.count; part += 1) this.retireId(`${position}:${part}`);
    delete this.state.draft;
  }

  /**
   * The step in flight as drafts under the ids its message will have: the store's (root field 4) at
   * `length`, else the step the CLI is streaming (`CursorTranscriptSource.liveStep`). A store step stays in
   * the turn the transcript is in, so it never opens a turn that would not end. A live step of a turn the
   * store has not recorded yet brings that turn's prompt, drafted first where the store will record it with the step after it,
   * under the request id the store will file both under; the turn ends here if the store never does.
   */
  private draft(length: number, pending: ChatMessage | undefined): boolean {
    const turn = this.state.turn;
    const mapper = this.mapper.fork();
    const openTurn = turn && !turn.ended ? turn : undefined;
    let at = length, turnId = openTurn?.id, message = openTurn ? pending : undefined, prompt: NativeWorkbenchEvent | undefined, live = false;
    const step = pending || !this.state.live ? undefined : this.source.liveStep(this.view.chatId, this.state.root);
    if (step && openTurn && (openTurn.id === step.turn || this.mapper.turnId === step.turn)) {
      message = liveMessage(step);
      live = true;
    } else if (step?.prompt && this.state.kept?.at === undefined && !this.state.recent.includes(step.turn) && !this.state.liveEnded?.includes(step.turn)) {
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
    if (mapped.length && (this.conflictsRetired(at, mapped.length) || (prompt && this.conflictsRetired(at - 1, 1)))) {
      this.w.rebuild('identity-changed');
      return this.abandon();
    }
    // The prompt goes first: a draft keeps the place its first version took.
    if (mapped.length && prompt) this.drafts.push({ finalId: prompt.nativeId, event: prompt });
    mapped.forEach((event, part) => {
      // A `Task` call stays in the step in flight for as long as its subagent runs.
      this.noteTask(event);
      this.drafts.push({ finalId: `${at}:${part}`, event: this.eventOf(event, at, '', part, turnId!) });
    });
    for (let part = mapped.length; part < previous; part += 1) this.retireId(`${at}:${part}`);
    if (!mapped.length) { this.endLivePrompt(); delete this.state.draft; return true; }
    this.state.draft = { at, count: mapped.length, ...(live ? { live: true as const } : {}), ...(prompt ? { prompt: turnId! } : {}) };
    return true;
  }

  /** The drafts of the step in flight go. */
  private dropDraft(result?: CursorTurnResult): void {
    const draft = this.state.draft;
    if (!draft) return;
    for (let part = 0; part < draft.count; part += 1) this.retireId(`${draft.at}:${part}`);
    this.endLivePrompt(result);
    delete this.state.draft;
  }

  /** A turn only a live step's prompt opened ends with its drafts: the store never recorded it. */
  private endLivePrompt(result?: CursorTurnResult): void {
    const turnId = this.state.draft?.prompt;
    if (!turnId) return;
    this.retireId(`${this.state.draft!.at - 1}:0`);
    delete this.state.draft!.prompt;
    this.state.liveEnded = [...(this.state.liveEnded ?? []).filter(id => id !== turnId), turnId].slice(-RECENT_TURNS);
    this.retiredBarrier = true;
    this.w.turnEnded(turnId, result?.status ?? 'interrupted', result?.at ?? new Date().toISOString(), result?.error);
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
    if (this.retired.size) this.retiredBarrier = true;
    this.state.placed = { ...this.state.placed, [compaction.summaryId]: id };
  }

  private compactionStarted(signal: CompactionSignal): void {
    this.flush();
    this.w.activities.apply({
      id: this.compactionId(signal.generationId ?? this.state.turn?.id), kind: 'compaction', status: 'running', title: '上下文压缩', startedAt: signal.at,
      compaction: { trigger: signal.trigger ?? 'auto', ...(signal.preTokens !== undefined ? { preTokens: signal.preTokens } : {}) },
    });
    if (this.retired.size) this.retiredBarrier = true;
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

  private noteStopped(toolCallId: string): void {
    this.stopped.delete(toolCallId);
    this.stopped.add(toolCallId);
    while (this.stopped.size > CHILD_LIMIT) this.stopped.delete(this.stopped.values().next().value!);
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
    const { v, mapping, reproject, from, root, n, len, live, placed, draft, kept, liveEnded, earlierDone } = this.state;
    const turn = before ? before.turn : this.state.turn;
    const taken = new Set(Object.values(placed));
    const compacting = this.w.activities.list().filter(activity => isOpenCompaction(activity) && !taken.has(activity.id)).slice(-4);
    const state: LaneState = {
      v, ...(mapping ? { mapping } : {}), ...(reproject ? { reproject } : {}), from, ...(root ? { root } : {}), n, len, digest: this.hash ? this.hash.copy().digest('hex') : this.state.digest, ...(live ? { live } : {}),
      mapper: before?.mapper ?? this.mapper.state(), ...(turn ? { turn } : {}), recent: before?.recent ?? this.state.recent, placed,
      ...(draft ? { draft } : {}), ...(kept ? { kept } : {}), ...(liveEnded?.length ? { liveEnded } : {}), children: [...this.children], ...(this.tasks.size ? { tasks: [...this.tasks] } : {}),
      ...(this.stopped.size ? { stopped: [...this.stopped] } : {}),
      ...(compacting.length ? { compacting } : {}), ...(this.stale.size ? { stale: [...this.stale] } : {}),
      ...(this.retired.size ? { retired: [...this.retired.entries()].sort((a, b) => a[0] - b[0]) } : {}),
      ...(this.retired.size && this.retiredBarrier ? { retiredBarrier: true as const } : {}),
      ...(earlierDone !== undefined ? { earlierDone } : {}),
    };
    return JSON.stringify(state);
  }

  /** Commits what was read with the state to resume from: by default the one after everything read so far (G7). */
  private flush(cursor = this.encode(), options?: { ended?: boolean }): void {
    if (!this.events.length && !this.drafts.length && !this.retire.length && cursor === this.w.cursor) return;
    const batch = { events: this.events, drafts: this.drafts, retire: this.retire, cursor, ...(options?.ended ? { ended: true as const } : {}) };
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
