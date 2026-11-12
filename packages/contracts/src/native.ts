import type { NativeTurnTarget, OutputRate, RunMetrics, StepMetrics, WorkbenchEvent } from './run.js';
import type { Session } from './session.js';
import type { TextRef } from './settings.js';

/** A provider-reported context meter. `size` is a window unless `limitKind` identifies a budget. */
export interface NativeContext {
  used: number;
  size: number;
  breakdown: Array<{ id: string; label: string; tokens: number }>;
  /** Compaction usage from the latest model response, against the automatic compaction threshold. */
  limitKind?: 'compaction';
  /** Estimated category counts have their own total and must not be added to the measured usage. */
  breakdownEstimated?: boolean;
}
/**
 * A shell task of a native conversation. It may be a foreground tool call, a background shell,
 * or a task whose final result is not yet confirmed in the CLI store.
 */
export interface NativeJob {
  /** The tool call that started it: the timeline row this job belongs to. */
  toolCallId: string;
  /** The CLI's own shell id, once its launch result has been read. */
  id?: string;
  title: string;
  command: string;
  status: 'running' | 'succeeded' | 'failed' | 'unknown';
  startedAt?: string;
  runningMs?: number;
  exitCode?: number;
  /** What the agent waited for, when it awaited this job with a pattern. */
  matched?: string;
  output?: string;
  truncated?: boolean;
  outputPath?: string;
}
/**
 * Something the CLI does on its own inside a conversation: compacting the context, running a background
 * task, printing the output of a local command. It travels as a `session/update` event with
 * `sessionUpdate: 'activity'`; later states of the same `id` arrive as further events, which a client
 * applies in place at the position of the first one. See docs/SESSION-JOURNAL.md, 系统活动.
 */
export interface NativeActivity {
  /** Stable across states and restarts: `${backend}:${nativeId}`. */
  id: string;
  kind: 'compaction' | 'background_task' | 'local_command';
  status: 'running' | 'stopping' | 'completed' | 'failed' | 'stopped' | 'unknown';
  title: string;
  /** A preview of at most 2KB, without ANSI escapes or CLI tags. */
  detail?: string;
  /** The full text, fetched on demand from `GET /api/sessions/:id/blobs/:blobRef`. */
  blobRef?: string;
  /** The tool row that started it, to place it on the timeline. */
  toolCallId?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  /** Absent when it cannot be stopped. `session` stops every background task of the conversation. */
  stop?: { via: 'protocol' | 'session' };
  compaction?: { trigger: 'manual' | 'auto'; preTokens?: number; postTokens?: number };
  /** A `background_task`'s process; on a `local_command`, the shell command the reader ran with `!` (its output is `detail`). */
  task?: { kind: 'shell' | 'monitor' | 'agent' | 'workflow' | 'terminal'; command?: string; exitCode?: number };
  /** For `local_command`: the command it printed for, without the slash. */
  command?: { name: string };
}
/**
 * What a runtime hook's sidecar shows on its conversation (docs/PLUGIN_ARCHITECTURE.md). The plugin
 * decides every word and state; clients render it as given and send an action back with `revision`.
 */
export interface NativeRuntimeControl {
  /** The plugin that owns the sidecar. */
  owner: string;
  /** Changes whenever what an action acts on changes; an action carrying an older one is refused. */
  revision: string;
  /** Shown beside the conversation's status; absent shows nothing there. */
  notice?: NativeRuntimeNotice;
  /** Entries in the conversation's more menu. */
  actions?: NativeRuntimeAction[];
}
export interface NativeRuntimeNotice {
  /** `progress` puts a spinner before the label; `danger` shows it as an error. */
  tone: 'neutral' | 'progress' | 'danger';
  label?: Record<string, string>;
  /** The full text behind the label, such as an error message. */
  detail?: string;
  action?: NativeRuntimeAction;
}
export interface NativeRuntimeAction {
  id: string;
  label: Record<string, string>;
  /** A short qualifier beside a menu entry. */
  hint?: Record<string, string>;
  disabled?: boolean;
}
export interface NativeRuntimeActionRequest { action: string; revision: string; }

/** What the CLI screen currently shows: working, waiting at its prompt, or a dialog that needs the terminal. */
export interface NativeStatus {
  /** The connected process keeps its launch settings until explicitly restarted or it exits. */
  profilePending?: boolean;
  runtimeControl?: NativeRuntimeControl;
  /** Activities in progress, independent of the main turn: whether it is compacting, and how many background tasks run. */
  activity?: { compacting: boolean; background: number };
  phase: 'offline' | 'starting' | 'busy' | 'idle' | 'attention';
  /** The active turn's event runId: an app Run id, or a provider turn id for autonomous work. */
  activeTurnId?: string;
  /** Exact provider identity for steering; absent when an active turn cannot be verified. */
  activeTurn?: NativeTurnTarget & { ownerRunId?: string };
  /** Server-sampled throughput; distinct from the persisted average of an individual turn. */
  outputRate?: OutputRate;
  /** Whether Riffet can currently use the provider session. This is separate from the CLI phase. */
  connection?: { state: 'connected' | 'disconnected' | 'reconnecting' | 'conflict' | 'failed'; message?: string; messageRef?: TextRef };
  /** Result of loading the conversation transcript, independent of the provider's execution phase. */
  history?: { state: 'loading' | 'ready' | 'error'; message?: string; messageRef?: TextRef };
  model?: string;
  permission?: string;
  /** The approval mode the CLI's footer reports, when it is one we recognise. */
  /** The provider's own permission setting, when it reports one we recognise. */
  approval?: string;
  /**
   * Whether the CLI chat store could be read. `unavailable` means the store file is missing;
   * `unparsed` that it exists but no longer decodes. Surfacing this turns a CLI format change
   * into an actionable message instead of a silently empty transcript.
   */
  transcript?: 'ok' | 'unavailable' | 'unparsed';
  /**
   * A current session-scoped explanation, cleared by its producer when its condition ends.
   * Connection/history diagnostics belong to their structured status above; completed turn
   * failures belong to the durable timeline, rather than being mirrored here.
   */
  notice?: string;
  /** Omitted by older servers; clients treat an unclassified notice as a warning. */
  noticeLevel?: 'info' | 'warning' | 'error';
  interaction?: NativeInteraction;
  /** Where the conversation's queued messages stand. Sent on the sync stream only; absent from older servers. */
  queue?: NativeQueue;
}
/**
 * Why queued messages wait: the CLI is working or showing a dialog, a stop is in progress, an earlier
 * message is still on its way in (`sending`, `steering`) or has an unconfirmed delivery (`unconfirmed`),
 * the workspace is reserved, a recovery action is running, or the next one is retrying shortly.
 */
export type NativeQueueHoldReason = 'turn_running' | 'attention' | 'stopping' | 'sending' | 'steering' | 'unconfirmed' | 'workspace' | 'recovering' | 'retrying';
/**
 * The server's own answer to "what starts next, and why not yet", so clients place a message without
 * inferring it from delivery fields: `next` is the queued run that starts first; without `held` it is
 * starting now. `held.runId` names the earlier message holding the queue, when one does.
 */
export interface NativeQueue { next?: string; held?: { reason: NativeQueueHoldReason; runId?: string } }
/** A verified, currently visible dialog belonging to one native terminal instance. */
export interface NativeInteraction {
  id: string; revision: string;
  /** `terminal` preserves Cursor's epoch/revision guard; `protocol` identifies server-mediated requests. */
  transport?: 'terminal' | 'protocol'; terminalId?: string; epoch?: number;
  requestId?: string; request?: Record<string, unknown>;
  kind: 'question' | 'permission' | 'plan' | 'confirmation' | 'choice';
  title: string; message?: string;
  options: Array<{ id: string; label: string; selected: boolean }>;
  multiple?: boolean; allowOther?: boolean; otherValue?: string; otherSelected?: boolean;
  /** Position of this question in its group, **1-based** like the counter both clients render. */
  questionIndex?: number; questionCount?: number;
  actions: Array<{ id: string; label: string; tone?: 'primary' | 'danger' }>;
  /** ISO time after which the backend stops waiting and denies the request on its own. Claude no longer sets it: its requests wait as long as the CLI does. */
  expiresAt?: string;
  /** The latest `expiresAt` that 延长 can reach; absent when the deadline cannot be moved (always, for Claude). */
  extendableUntil?: string;
}
export interface NativeInteractionResponse {
  interactionId: string; revision: string; requestId: string; action: string;
  selectedIds?: string[]; otherText?: string;
}
export interface NativeInteractionResult {
  status: 'advanced' | 'completed' | 'uncertain';
  interaction?: NativeInteraction; message?: string;
}
/** Where a client holds a transcript: its generation, and whether older rows are still to load. */
export interface NativeHistoryState { generation: string; cursor?: string; hasMore: boolean; contextIncomplete?: boolean; }
/** Native event identity includes the absolute message position, blob id, and mapped part. */
export type NativeWorkbenchEvent = WorkbenchEvent & { nativeId: string; nativeAliases?: string[]; nativeTurnId?: string };
/**
 * What a provider reports of a conversation outside its transcript, on the control path (docs/SYNC-V3.md):
 * the transcript itself reaches clients as timeline rows of `/api/v3/sessions/:id/sync`.
 */
export type NativeStreamMessage =
  | { type: 'context'; context?: NativeContext }
  /**
   * Live output-speed reporting. `runId` is the workbench Run the step belongs to, which is also
   * the identity the browser derives its turn keys from; `run` is the turn's aggregate so a client
   * never has to re-add the steps itself. Settled aggregates are also stored on the Run, which is
   * what a reload reads instead of waiting for a number that can no longer be measured.
   */
  | { type: 'metrics'; metrics: StepMetrics; run?: RunMetrics; runId?: string; nativeMessageId?: string }
  | { type: 'status'; status: NativeStatus }
  | { type: 'session'; session: Session }
  | { type: 'job'; job: NativeJob };
