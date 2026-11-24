import type { SessionControlSnapshot } from './control.js';
import type { AgentMention, CapturedSessionReference, NativeActivity, NativeContext, NativeInteraction, NativeJob, NativeStatus, Run, RunMetrics, Session, StepMetrics } from './index.js';

/*
 * Sync protocol v3 (docs/SYNC-V3.md): the server folds each lane of a conversation into timeline
 * rows and streams their changes in lane `seq` order. A `generation` change invalidates every row
 * and seq a client holds for that lane.
 */

/** `main`, or a subagent's lane keyed by the tool call that started it. */
export type SyncLane = 'main' | `sub:${string}`;

/**
 * `id` is present for attachments uploaded through Riffet (`/api/attachments/:id`). `path` is the
 * native file a CLI recorded (for example a Cursor image), and `type` says what that file is.
 */
export interface UserAttachment { name: string; id?: string; path?: string; type?: 'image' | 'file'; mimeType?: string; size?: number; width?: number; height?: number }
/** `narration` is the summary the CLI itself shows; `thinking` is the model's raw reasoning. */
export type ReasoningChannel = 'thinking' | 'narration';
export type TaskNotificationStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export interface TaskNotificationResult { id: string; status: 'running' | 'succeeded' | 'failed'; exitCode?: number; runningMs?: number }

/** The event a row was folded from: `createdAt` of its first source event, `lastAt` of its latest; `sourceIds` are their native ids. */
export interface RowEvent { type: string; data: Record<string, unknown>; createdAt: string; lastAt: string; runId?: string; nativeId?: string; nativeTurnId?: string; sourceIds: string[] }
/**
 * `key` is stable within the lane, `pos` orders rows, `turn` is the turn key, `seq` is the lane seq
 * of the row's latest change and `rev` counts its content changes. `truncated` names the blob that
 * holds the full row when its text was cut to a preview.
 */
interface RowBase { key: string; pos: number; turn: string; seq: number; rev: number; runId?: string; event: RowEvent; truncated?: { blobRef: string; bytes: number } }
export type TimelineRow = RowBase & (
  /** `pending`: a Run the transcript has not echoed yet, keyed `user:<commandId>` at {@link PENDING_ROW_POS}. */
  | { kind: 'user'; text: string; attachments: UserAttachment[]; references?: CapturedSessionReference[]; agents?: AgentMention[]; pending?: 'queued' | 'preparing' | 'unconfirmed' | 'failed' }
  | { kind: 'assistant'; text: string; phase?: 'commentary' | 'final_answer' }
  | { kind: 'thought'; text: string; channel: ReasoningChannel }
  | { kind: 'tool'; job?: NativeJob; activity?: NativeActivity; subagent?: { lane: SyncLane; agentId: string; running: boolean; title?: string; subagentType?: string; model?: string; rows: number; turnId?: string; status?: TurnOutlineV3['status']; startedAt?: string; endedAt?: string; changes?: FileChange[] } }
  | { kind: 'plan'; entries: Record<string, unknown>[] }
  | { kind: 'image'; src: string }
  /** A failure's readable reason; `detail` keeps its already-redacted diagnostic for disclosure. */
  | { kind: 'status'; tone: 'danger' | 'muted'; text: string; detail?: string }
  | { kind: 'task_notification'; taskId?: string; taskKind: string; status: TaskNotificationStatus; sourceStatus?: string; title: string; command?: string; detail?: string; jobResult?: TaskNotificationResult; subagentToolCallId?: string; tokens?: number; durationMs?: number }
  | { kind: 'activity'; activity: NativeActivity });
/** A file a subagent's tools wrote or its commands were seen to change, with the lines it gained and lost; edits to one path add up. */
export interface FileChange { path: string; added: number; removed: number; created: boolean }
export interface TurnOutlineV3 { turn: string; turnId: string; startPos: number; endPos?: number; status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'outcome_unknown'; at: string; endedAt?: string; preview?: string; hasUserMessage?: boolean; hasAttachments?: boolean; rows: number; runId?: string }
/** One SSE event of `GET /api/v3/sessions/:id/sync`; the SSE `event:` is `type`. */
export type SyncFrame =
  | { type: 'hello'; protocol: 3; lane: SyncLane; generation: string; headSeq: number; mode: 'delta' | 'snapshot'; session: Session; status: NativeStatus;
      interaction: NativeInteraction | null; runs: Run[]; activities: NativeActivity[]; context?: NativeContext; outline: { turnCount: number; turns: TurnOutlineV3[] };
      /** The transcript is still being read: rows up to a later `caughtUp` are history the reader missed, not live. */
      catchingUp?: boolean; control?: SessionControlSnapshot }
  | { type: 'caughtUp'; generation: string; headSeq: number }
  | { type: 'snapshot'; generation: string; asOfSeq: number; part: number; final: boolean; rows: TimelineRow[]; hasBefore: boolean }
  | { type: 'rows'; generation: string; from: number; to: number; upserts: TimelineRow[]; deletes?: string[] }
  | { type: 'reset'; generation: string; reason: 'rebuilt' | 'promoted' | 'fold' }
  | { type: 'status'; status: NativeStatus } | { type: 'interaction'; interaction: NativeInteraction | null }
  | { type: 'runs'; runs: Run[] } | { type: 'run'; run: Run } | { type: 'activities'; live: NativeActivity[] }
  | { type: 'outline'; turnCount: number; turns: TurnOutlineV3[] } | { type: 'context'; context?: NativeContext }
  | { type: 'metrics'; metrics: StepMetrics; run?: RunMetrics; runId?: string; nativeMessageId?: string } | { type: 'session'; session: Session }
  | { type: 'control'; control: SessionControlSnapshot }
  | { type: 'error'; code: string; message: string; retryable: boolean };
export interface TimelinePage { generation: string; rows: TimelineRow[]; hasBefore: boolean; hasAfter: boolean }
export interface TimelineChanges { generation: string; headSeq: number; mode: 'delta' | 'snapshot'; from?: number; to?: number; rows: TimelineRow[]; deletes?: string[]; hasBefore?: boolean }
/** A row of the lane that holds the query `count` times, for `GET /api/v3/sessions/:id/find`. */
export interface LaneFindHit { key: string; pos: number; turn: string; count: number }
/**
 * The lane's rows that hold a query, in place order, as of `headSeq`. The text matched is what a row
 * shows folded (`findableText`), case-insensitively. `total` counts every occurrence; `truncated` says
 * more rows held the query than `hits` lists ({@link FIND_MAX_ROWS}).
 */
export interface LaneFind { generation: string; headSeq: number; total: number; hits: LaneFindHit[]; truncated?: boolean }
/** The most rows one find lists. */
export const FIND_MAX_ROWS = 2000;

/** Where a pending user row sits until its echo arrives: after every real row. */
export const PENDING_ROW_POS = 2 ** 52;

const KB = 1024;
/** docs/SYNC-V3.md 预算. `snapshot` and `page` hold the defaults and the bounds a request may ask for. */
export const SYNC_BUDGET = {
  snapshot: { bytes: 512 * KB, rows: 300, minBytes: 128 * KB, maxBytes: 2048 * KB, minRows: 50, maxRows: 1000 },
  page: { bytes: 256 * KB, rows: 100, maxBytes: 1024 * KB, maxRows: 500 },
  frameBytes: 256 * KB,
  /** Every row but the model's output (assistant, thought), which is always sent whole. */
  rowBytes: 64 * KB,
  /** Text over `textBytes` becomes a `previewBytes` preview plus `truncated.blobRef`; the model's output is exempt. */
  textBytes: 32 * KB,
  previewBytes: 16 * KB,
  toolOutputBytes: 16 * KB,
  diffBytes: 16 * KB,
  /** hello's `outline.turns` holds the latest turns; `activities.live` is capped. */
  outlineTurns: 50,
  liveActivities: 200,
  pingMs: 15_000,
} as const;
