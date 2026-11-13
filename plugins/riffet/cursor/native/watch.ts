import type {
  NativeContext, NativeJob, NativeStatus, NativeStreamMessage, NativeWorkbenchEvent, RunMetrics, Session, SessionState,
} from '@contracts';
import type { StatsSink } from '@riffet/plugin-api';
import { CursorTranscriptMeter } from './cursor-metrics.js';
import type { ChatMeta } from './chat-store.js';
import type { Transcript } from './transcript.js';

export const noopStats: StatsSink = {
  recordUsage() {},
  observeEvents() {},
};

/**
 * What a watch tells its listeners: what it just read of the chat store (`reset` when the conversation's
 * chat was replaced or read again from its tail, `append` otherwise; a subagent's under its tool call),
 * and the conversation's status, context, output speed, jobs and session record. The transcript itself
 * reaches clients through the session journal; these events are the watcher's evidence.
 *
 * `draft` carries no events: it says the CLI rewrote the step it has not committed yet, which only a
 * reader of the store (the journal's ingest) has anything to do with.
 */
export type WatchMessage =
  | { type: 'reset' | 'append'; chatId?: string; events: NativeWorkbenchEvent[] }
  | { type: 'draft' }
  | { type: 'subagent'; toolCallId: string; agentId: string; subagentType?: string; running?: boolean; events: NativeWorkbenchEvent[] }
  | Extract<NativeStreamMessage, { type: 'status' | 'context' | 'metrics' | 'job' }>
  | { type: 'session'; session: Session };

export type Listener = (message: WatchMessage) => void;

export interface SubagentWatch {
  toolCallId: string;
  subagentType?: string;
  /** Whether the last event sent said it was still working, so only changes are emitted. */
  running?: boolean;
  transcript: Transcript;
  /** When this subagent's store last grew, so idle readers can be released. */
  lastChangeAt: number;
  lastCheckedAt?: number;
  /** Set when its SQLite reader handle was released; its decoded events remain. */
  closed?: boolean;
}

/** A subagent whose reader was let go, remembered so it can be followed again. */
interface SubagentDescriptor {
  toolCallId: string;
  agentId: string;
  subagentType?: string;
  lastUsedAt: number;
}

export interface ParentTranscriptBatch {
  chatId: string;
  generation: string;
  events: NativeWorkbenchEvent[];
}

/** A background shell job, assembled from the transcript and (while it runs) from its own log. */
export interface JobWatch {
  toolCallId: string;
  id?: string;
  title: string;
  command: string;
  status: NativeJob['status'];
  startedAt?: string;
  runningMs?: number;
  exitCode?: number;
  matched?: string;
  output?: string;
  truncated?: boolean;
  outputPath?: string;
  /** When the log was last read, so a running job is not re-read on every tick. */
  readAt: number;
  /** Set once a finished job's log has been read again for its exit block. */
  finalRead?: boolean;
  /** The last payload sent, so only real changes reach the browser. */
  signature?: string;
}

export class Watch {
  readonly listeners = new Set<Listener>();
  chat: Transcript | undefined;
  context: NativeContext | undefined;
  status: NativeStatus = { phase: 'offline' };
  /** Last moment the pane itself accounted for the CLI's work: it showed busy, or a stop settled. */
  paneBusyAt = 0;
  /**
   * The CLI error under the footer, with [paneBusyAt] when it was first seen: the CLI may leave the
   * line on screen through later turns, and once one has run the error is no longer news.
   */
  cliError: { text: string; paneBusyAt: number } | undefined;
  /** Terminal whose CLI has drawn its footer at least once; before that it is still booting. */
  booted: string | undefined;
  booting: { terminalId: string; since: number } | undefined;
  /**
   * Since when the booted pane has shown neither its prompt bar nor a dialog we know, and whether
   * that pane was logged. A redraw passes through such frames, so only a lasting one is attention.
   */
  unrecognized: { since: number; logged: boolean } | undefined;
  /** Whether the followed chat store decoded, and a notice the workbench wants to surface. */
  transcript: 'ok' | 'unavailable' | 'unparsed' | undefined;
  notice: string | undefined;
  readonly subagents = new Map<string, SubagentWatch>();
  /** Background jobs keyed by the tool call that started them, i.e. by their timeline row. */
  readonly jobs = new Map<string, JobWatch>();
  readonly metas = new Map<string, ChatMeta>();
  readonly subagentByToolCallId = new Map<string, string>();
  readonly agentCalls = new Map<string, string | undefined>();
  readonly subagentDescriptors = new Map<string, SubagentDescriptor>();
  /** Tool calls whose subagent store the CLI holds open, i.e. subagents working right now. */
  openSubagentCalls: string[] = [];
  /** Whether the last scan read the CLI's open stores at all, so an absent subagent means "done". */
  openStoresKnown = false;
  /** When the open stores were last read successfully. */
  openStoresAt = 0;
  timer: NodeJS.Timeout | undefined;
  idleTimer: NodeJS.Timeout | undefined;
  passiveUntil = 0;
  lastAccessAt = Date.now();
  lastTickAt = 0;
  ticking = false;
  tickPromise: Promise<void> | undefined;
  resolveTick: (() => void) | undefined;
  closed = false;
  lastScan = 0;
  primed = false;
  /** Output-speed measurements for this conversation, fed by every batch of committed records. */
  readonly metrics: CursorTranscriptMeter;
  readonly startedAt = Date.now();

  constructor(readonly sessionId: string, private readonly stats: StatsSink = noopStats) {
    this.metrics = new CursorTranscriptMeter(
      message => this.emit(message),
      (runId, runMetrics) => this.saveRunMetrics(runId, runMetrics),
      nativeMessageId => this.runForUserMessage(nativeMessageId),
      runId => this.onPromptSentAt?.(runId),
      stats,
      sessionId,
      () => this.chat?.chatId,
    );
  }

  saveRunMetrics(runId: string, runMetrics: RunMetrics): void {
    this.onSaveMetrics?.(runId, runMetrics);
  }

  runForUserMessage(nativeMessageId: string): string | undefined {
    return this.onResolveRun?.(nativeMessageId);
  }

  /** Installed by the service so a watch can reach the store without owning it. */
  onSaveMetrics: ((runId: string, runMetrics: RunMetrics) => void) | undefined;
  onResolveRun: ((nativeMessageId: string) => string | undefined) | undefined;
  onPromptSentAt: ((runId: string) => number | undefined) | undefined;

  emit(message: WatchMessage): void {
    if (this.closed) return;
    if ((message.type === 'append' || message.type === 'reset' || message.type === 'subagent') && message.events.length) {
      try { this.stats.observeEvents(this.sessionId, message.events); }
      catch { /* statistics must never affect the stream */ }
    }
    for (const listener of this.listeners) {
      try { listener(message); } catch { /* A closed stream must not stop the others. */ }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.chat?.close();
    for (const item of this.subagents.values()) item.transcript.close();
    this.subagents.clear();
    this.jobs.clear();
    this.metas.clear();
    this.subagentByToolCallId.clear();
    this.agentCalls.clear();
    this.subagentDescriptors.clear();
    this.resolveTick?.();
    this.resolveTick = undefined;
    this.tickPromise = undefined;
  }
}

export const SCAN_INTERVAL_MS = 2500;
/** How long a conversation's watch outlives its last browser stream. */
export const LEFT_WATCH_MS = 30 * 60_000;
/** Nobody is reading a passive watch; poll just often enough that a returning reader catches up quickly. */
export const PASSIVE_POLL_MS = 15_000;
/** Child stores are quieter than the parent; poll their root less often and release handles when idle. */
export const SUBAGENT_POLL_MS = 2500;
/** How long a subagent's store must stay quiet before its reader is released. */
export const SUBAGENT_IDLE_MS = 60_000;
/** How long a quiet store still counts as "working". A backgrounded Task answers at once and keeps
 *  running, so the finished tool result cannot be the answer to whether the subagent is done. */
const SUBAGENT_ACTIVE_MS = 15_000;
/** How long the last read of the CLI's open stores stands in for reads that come back empty. */
export const OPEN_STORES_GRACE_MS = 10_000;

/**
 * Whether a subagent is still working. The CLI keeps a working subagent's store open, and that
 * holds through a long shell command or a slow generation that writes nothing for minutes; a
 * recently written store only stands in when the open stores could not be read.
 */
export function subagentWorking(toolCallId: string, lastChangeAt: number, openCalls: readonly string[] | undefined, now = Date.now()): boolean {
  if (openCalls) return openCalls.includes(toolCallId);
  return now - lastChangeAt < SUBAGENT_ACTIVE_MS;
}

/** How often unwatched conversations are checked, so a finished turn stops looking busy. */
export const STATE_SWEEP_MS = 3000;
/** How long after its last write an unfinished transcript still counts as a turn in progress. */
const TRANSCRIPT_ACTIVE_MS = 60_000;
/** Writes this close to the pane's last busy frame are the tail of that turn, not a new one. */
const TRANSCRIPT_SETTLE_MS = 3000;

/**
 * Whether the CLI is working on a turn its pane does not show.
 *
 * The CLI can continue a conversation on its own — after a background task, or by injecting
 * "Your previous response was interrupted" — without painting it: the pane keeps an idle prompt
 * and never shows `ctrl+c to stop`, while the chat store keeps growing. A store that grew after
 * the pane last showed work, and whose last message still owes a step, is that hidden turn.
 */
export function transcriptWorking(input: { awaitingReply: boolean; lastActivityAt: number; paneBusyAt: number }, now = Date.now()): boolean {
  return input.awaitingReply
    && input.lastActivityAt > input.paneBusyAt + TRANSCRIPT_SETTLE_MS
    && now - input.lastActivityAt < TRANSCRIPT_ACTIVE_MS;
}

/** How long a transcript that ended on a final answer must stay quiet before the turn counts as over. */
const SUBVIEW_SETTLE_MS = 10_000;

/**
 * The phase behind the TUI's subagent view, which covers the prompt bar and the busy hint.
 *
 * The view is opened from inside the terminal and says nothing about the conversation's turn, so
 * the transcript decides: a tail that still owes the model a step (a Task call waiting on its
 * subagent, say) is busy, and one that ended on a final answer and stayed quiet is idle. Without a
 * transcript the phase seen before the view opened is kept, and an unknown one counts as busy so a
 * turn is never reported finished early.
 */
export function subviewPhase(input: { working: boolean; previous: NativeStatus['phase']; transcript?: { awaitingReply: boolean; lastActivityAt: number } }, now = Date.now()): 'busy' | 'idle' {
  if (input.working) return 'busy';
  if (!input.transcript) return input.previous === 'idle' ? 'idle' : 'busy';
  if (input.transcript.awaitingReply) return 'busy';
  return input.previous === 'idle' || now - input.transcript.lastActivityAt >= SUBVIEW_SETTLE_MS ? 'idle' : 'busy';
}

/** The session state a CLI phase means, or `undefined` when the terminal service owns the state. */
export function stateForPhase(phase: NativeStatus['phase'], subagentsRunning = false): SessionState | undefined {
  if (phase === 'offline') return undefined;
  if (phase === 'attention') return 'waiting';
  if (phase === 'busy' || subagentsRunning) return 'running';
  return phase === 'starting' ? 'starting' : 'idle';
}

/** How often a running job's log is re-read: often enough to look live, cheap enough to be free. */
export const JOB_LOG_MS = 1000;

/** The contract shape of a job, with nothing internal (`readAt`, `signature`) leaking into it. */
export function jobPayload(job: JobWatch): NativeJob {
  return {
    toolCallId: job.toolCallId,
    title: job.title || job.command || '后台任务',
    command: job.command,
    status: job.status,
    ...(job.id ? { id: job.id } : {}),
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.runningMs ? { runningMs: job.runningMs } : {}),
    ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
    ...(job.matched ? { matched: job.matched } : {}),
    ...(job.output ? { output: job.output } : {}),
    ...(job.truncated ? { truncated: true } : {}),
    ...(job.outputPath ? { outputPath: job.outputPath } : {}),
  };
}

export function latestTranscriptActivity(events: NativeWorkbenchEvent[]): string | undefined {
  let latest: string | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    const stamp = event.createdAt;
    const timestamp = Date.parse(stamp);
    if (!Number.isFinite(timestamp) || timestamp <= latestMs) continue;
    latest = new Date(timestamp).toISOString();
    latestMs = timestamp;
  }
  return latest;
}
