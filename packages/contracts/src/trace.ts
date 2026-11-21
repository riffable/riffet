import type { SyncLane } from './sync.js';

/*
 * The session trace (docs/TRACE.md): a conversation's journal (docs/SESSION-JOURNAL.md) as it was
 * written, row by row, with every revision, the rows a transcript hides (`meta.*`, drafts,
 * tombstones) and the model requests the statistics ledger counted. Read-only; nothing here is folded.
 */

/** One lane of a conversation: `main`, or a subagent's `sub:<toolCallId>`. */
export interface TraceLane {
  lane: SyncLane;
  /** The log being served; a row read under another generation is refused (409 `TRACE_GENERATION_CHANGED`). */
  generation: string;
  lastSeq: number;
  /** Rows in the log, counting emptied revisions. */
  rows: number;
  /** The lane is a scratch window over a history still being imported. */
  importing?: true;
  /** For a subagent lane, as its `meta.subagent` row names it. */
  toolCallId?: string;
  title?: string;
  subagentType?: string;
  model?: string;
}

/** One model request, from the statistics ledger (docs/STATS.md). Times are epoch milliseconds; an absent count was not measured. */
export interface TraceUsageStep {
  key: string;
  runId?: string;
  model?: string;
  requestedModel?: string;
  agent: 'main' | 'subagent';
  subagentType?: string;
  parentKey?: string;
  at: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  nativeMessageId?: string;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  /** `estimated` counts are the server's own estimate; the view labels them. */
  tokens: 'provider' | 'estimated';
  window?: string;
}

export interface TraceSummary {
  sessionId: string;
  lanes: TraceLane[];
  /** Oldest first; the newest `TRACE_BUDGET.usageSteps` when `stepsTruncated`. */
  steps: TraceUsageStep[];
  stepsTruncated?: true;
}

/**
 * A journal row without its payload. The fields after `bytes` are read from the row's inline payload
 * (the whole payload, or the preview a spilled one keeps), so they never cost a blob read.
 */
export interface TraceRow {
  seq: number;
  kind: string;
  nativeId: string;
  rev: number;
  turnId?: string;
  at: string;
  /** Size of the payload as written, in bytes of JSON. */
  bytes: number;
  /** The payload lives in a blob; the row read resolves it. */
  blob?: true;
  /** Background maintenance emptied this superseded revision; its time and digest remain. */
  cleared?: true;
  /** The payload's own `type` when it differs from `kind` (a draft carries the chunk type it stands for). */
  type?: string;
  runId?: string;
  toolCallId?: string;
  /** A tool's or activity's status, or a turn end's. */
  status?: string;
  /** A tool's name, a subagent's type, an activity's kind. */
  name?: string;
  /** A tool call's category (`read`, `execute`...). */
  toolKind?: string;
  /** One line of what the row says, at most `TRACE_BUDGET.previewChars`. */
  text?: string;
  /** For `meta.subagent`, the lane it opens. */
  lane?: SyncLane;
  /** The row reports a failure. */
  error?: true;
}

export interface TracePage {
  lane: SyncLane;
  generation: string;
  lastSeq: number;
  rows: TraceRow[];
  /** Read again with `after=next` for more; absent at the end of the log. */
  next?: number;
}

/** One row with its whole payload. */
export interface TraceRowDetail extends TraceRow {
  digest: string;
  blobRef?: string;
  /** Absent when `truncated`; `payloadText` then holds the head of its JSON. */
  payload?: unknown;
  payloadText?: string;
  truncated?: true;
  /** The blob is gone from storage; `payloadText` is the inline preview the row kept. */
  missing?: true;
}

/*
 * What a lane's model requests were sent with, as the agent recorded it in its own stored transcript: the system
 * prompt and tool definitions, the request parameters, and the messages the agent added that are not conversation
 * rows (reminders, instruction files, environment). Read from the agent's files on demand; nothing of it is kept
 * in the journal. The records are the agent's private format, so `status` says why a read has nothing.
 */
export interface TraceRequests {
  lane: SyncLane;
  /**
   * `ok`, or why there is nothing: `unsupported` (the agent keeps no such record), `missing` (no stored
   * transcript for the lane), `unrecognized` (a transcript without any record this server understands), or
   * `tooLarge` (past `TRACE_BUDGET.requestFileBytes`).
   */
  status: 'ok' | 'unsupported' | 'missing' | 'unrecognized' | 'tooLarge';
  backendId?: string;
  /** The CLI version that wrote the records. */
  version?: string;
  /** `request`: one record per model request (Claude Code); `turn`: one per turn, the requests in it sharing it (Codex). */
  granularity?: 'request' | 'turn';
  /** Distinct prompts, oldest first: one holds until a request is sent with another. */
  prompts: TracePrompt[];
  requests: TraceRequest[];
  /** Request parameters by id; most requests share one set. */
  params: Record<string, Record<string, unknown>>;
  /** Messages the agent added, by id; a request lists the ones it carried first. */
  context: Record<string, TraceContextMessage>;
  /** Older requests or prompts were left out at the budget. */
  truncated?: true;
}

export interface TracePrompt {
  id: string;
  /** The first request sent with it. */
  at: string;
  system: TracePromptBlock[];
  tools: TraceToolDefinition[];
}

export interface TracePromptBlock {
  /** `system` for the system prompt; `developer` for an instruction message the agent sends in the developer role. */
  role: 'system' | 'developer';
  text: string;
  /** Characters of the whole text when `text` was cut at `TRACE_BUDGET.requestTextChars`. */
  chars?: number;
}

export interface TraceToolDefinition {
  name: string;
  description?: string;
  /** The input schema as sent. */
  schema?: unknown;
  /** A group the tool is listed under (a namespace or an MCP server). */
  group?: string;
}

export interface TraceRequest {
  id: string;
  at: string;
  turnId?: string;
  /** Prompt id. */
  prompt?: string;
  /** Parameter set id. */
  params?: string;
  model?: string;
  /** Which part of the agent sent it (`repl_main_thread`, `compact`...). */
  source?: string;
  /** Messages the request carried, when recorded. */
  messages?: number;
  /** The messages added since the request it builds on, in order: an id in `context`, or `null` for a conversation message. */
  added?: Array<string | null>;
}

export interface TraceContextMessage {
  role: string;
  text: string;
  /** Characters of the whole text when `text` was cut. */
  chars?: number;
  /** A short name of what it is (`system-reminder`, `environment_context`, `AGENTS.md`...), when the text says. */
  label?: string;
  /** The text was left out at `TRACE_BUDGET.requestContextChars`, older messages first; `chars` is its length. */
  omitted?: true;
}
