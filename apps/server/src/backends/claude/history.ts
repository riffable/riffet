import { createHash } from 'node:crypto';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { NativeActivity, NativeHistoryState, NativeWorkbenchEvent, Session, SessionGoal } from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import { INLINE_IMAGE_LIMIT, isImagePath, toolImageContent } from '../shared/tool-images.js';
import { activeTurnOf, initialState, reduce, type BackgroundAgent, type ClaudeSessionState, type ClaudeSignal, type ClaudeTurnOrigin } from './session-state.js';
import {
  ClaudeActivities, commandNameOf, compactedOutput, localCommandOutput, noticeRowKind, outputPreview, readTaskOutputTail, shellInputOf, shellOutputOf, stoppable, taskNotification,
  type ClaudeActivityHooks, type ClaudeTaskKind,
} from './activity.js';
import { ActivityLedger, activityEvent, activityId, activityOfEvent, isLiveActivity } from '../../journal/activity.js';
import { firstHumanMessage } from '../../session-title.js';
import { claudeGoalChange } from './goal.js';
import { ClaudeSubagentDiscovery } from './subagents.js';
/**
 * The largest transcript read. Rows are kept without the base64 no transcript shows (see
 * `parseRow`), so what stays in memory is far smaller than the file: a long session of screenshots
 * is mostly pictures, and its conversation must not vanish once the file outgrows a limit.
 */
const MAX_TRANSCRIPT_BYTES = 512 * 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** Bytes just before the read offset that must still match, or the file was rewritten in place. */
const TRANSCRIPT_PROBE_BYTES = 256;
const SNAPSHOT_EVENTS = 500;
const HISTORY_PAGE_SIZE = 100;
/** Subagent transcripts kept per session. */
const SUBAGENT_LIMIT = 64;
const FINAL_STOP_REASONS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal']);
/** Bytes one subagent's opening snapshot may spend; older events stay behind its history cursor. */
const SUBAGENT_SNAPSHOT_BYTES = 96 * 1024;
/** How often the subagents directory is listed; child files themselves are read only when they grow. */
const SUBAGENT_SCAN_MS = 1_000;
const clip = (value: string, limit = 24 * 1024) => value.length > limit ? `${value.slice(0, limit)}\n…` : value;
/** Edits are whole-file sized: `Write` sends the file's full text. Matches the other backends' limit. */
const EDIT_LIMIT = 256 * 1024;
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

/**
 * The user row Claude Code writes for itself when a turn is cut short (`… for tool use` for the
 * variant that lands where a tool result was due). It names the prompt it interrupted, so the
 * transcript reads it as the end of that turn — but nobody said it, and it is not a message.
 */
const INTERRUPTED_MARKER = '[Request interrupted by user';
/** How Claude Code words a Stop hook's blocking reason, as the meta row it hands the model (2.1.302: `Stop hook feedback:\n…`). */
const STOP_HOOK_FEEDBACK = 'Stop hook feedback:';

/** How a failed turn ends when the CLI gives no words of its own. */
export const CLAUDE_TURN_FAILED = 'Claude Code could not finish the response.';

/** A failure as a run's end shows it: one line, bounded. */
export function claudeFailureText(text: string | undefined): string {
  return text?.replace(/\s+/g, ' ').trim().slice(0, 500) || CLAUDE_TURN_FAILED;
}

/**
 * A terminal API error. The CLI also writes `isApiErrorMessage` on a cut stream
 * whose `stop_reason` is `tool_use`: those tools still return and the same turn continues. That row
 * stays in the transcript, but is not the failure a StopFailure hook / turn_duration would confirm.
 */
export function claudeApiFailure(row: ClaudeRow): string | undefined {
  if (row.type !== 'assistant' || row.isApiErrorMessage !== true) return undefined;
  if (record(row.message)?.stop_reason === 'tool_use') return undefined;
  return claudeFailureText(rowText(record(row.message)?.content));
}

/** A turn has exactly one end; the hook and the file record are two reports of the same one. */
const isTerminalType = (type: string): boolean => type === 'run_completed' || type === 'run_failed' || type === 'run_cancelled';

/** Some providers serialize replay-only reasoning state into Claude's thinking string. */
function readableThinking(text: string): string {
  if (!text.trimStart().startsWith('{')) return text;
  let envelope: Record<string, unknown> | undefined;
  try { envelope = record(JSON.parse(text)); } catch { return text; }
  if (!envelope || (envelope.type !== 'openai_responses_reasoning_item'
    && !(envelope.type === 'reasoning' && typeof envelope.encrypted_content === 'string' && Array.isArray(envelope.summary)))) return text;
  if (!Array.isArray(envelope.summary)) return '';
  return envelope.summary.flatMap(item => {
    const block = record(item);
    const summary = typeof item === 'string' ? item : block?.type === 'summary_text' ? string(block.text) : undefined;
    return summary?.trim() ? [summary] : [];
  }).join('\n');
}

export interface ClaudeRow {
  uuid?: string;
  type?: string;
  timestamp?: string;
  isSidechain?: boolean;
  agentId?: string;
  prompt_id?: string;
  promptId?: string;
  message?: Record<string, unknown>;
  [key: string]: unknown;
}

/** These rows record a notification without submitting it to the model. */
function isTranscriptOnly(row: ClaudeRow): boolean {
  return row.queueTranscriptOnly === true || row.isVisibleInTranscriptOnly === true;
}

function promptIdOf(row: ClaudeRow): string | undefined {
  return string(row.promptId) ?? string(row.prompt_id) ?? string(record(row.message)?.prompt_id);
}

/** A peer's hidden prompt can wake the main agent; ordinary meta context cannot open a turn. */
function hiddenPeerPrompt(row: ClaudeRow): string | undefined {
  if (row.type !== 'user' || row.isMeta !== true || row.isSidechain === true || row.agentId !== undefined
    || row.isCompactSummary === true || isTranscriptOnly(row) || record(row.origin)?.kind !== 'peer') return undefined;
  const content = record(row.message)?.content;
  if (Array.isArray(content) && content.some(block => record(block)?.type === 'tool_result')) return undefined;
  const promptId = promptIdOf(row);
  return promptId?.trim() ? promptId : undefined;
}

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

/**
 * A message written to a subagent by the agent that leads it (or a peer). It is guidance while the
 * child works; once the child has answered, it starts the child's next round.
 */
export function subagentWake(row: ClaudeRow): boolean {
  if (row.type !== 'user' || row.isMeta !== true) return false;
  const kind = string(record(row.origin)?.kind);
  if (kind !== 'coordinator' && kind !== 'peer') return false;
  const content = record(row.message)?.content;
  return !(Array.isArray(content) && content.some(block => record(block)?.type === 'tool_result'));
}

/**
 * Whether a child row ends its round (a final answer), reopens it (a call to any tool but the hand-back
 * that delivers that answer), or says nothing either way.
 */
export function subagentSettles(row: ClaudeRow): boolean | undefined {
  if (row.type !== 'assistant') return undefined;
  const message = record(row.message);
  if (FINAL_STOP_REASONS.has(string(message?.stop_reason) ?? '')) return true;
  const calls = Array.isArray(message?.content) ? message.content.map(record).filter(part => part?.type === 'tool_use') : [];
  return calls.some(part => string(part?.name) !== 'SubagentHandback') ? false : undefined;
}

/** The live turn a child's frame names: only while it runs, and only once a round is known. */
function liveSubagentTurn(state: ClaudeSubagentState, running: boolean): { activeTurnId?: string } {
  return running && state.turnId ? { activeTurnId: state.turnId } : {};
}

/**
 * Whether a child row leaves the child owing another step: its prompt or a tool result waiting on
 * the model, or a model step that called a tool or is still being written. A final answer or
 * Claude's own interruption marker ends it; rows that are not conversation say nothing.
 */
export function claudeRowOwesStep(row: ClaudeRow): boolean | undefined {
  const message = record(row.message);
  if (row.type === 'assistant') return !FINAL_STOP_REASONS.has(string(message?.stop_reason) ?? '');
  if (row.type !== 'user') return undefined;
  const content = message?.content;
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map(block => record(block)?.type === 'text' ? string(record(block)?.text) ?? '' : '').join('') : '';
  return !text.trimStart().startsWith(INTERRUPTED_MARKER);
}

/**
 * What one main-thread transcript row says about the conversation's state, in the vocabulary of
 * `session-state.ts`. Only rows that open or close something produce a signal; the order they appear in
 * the file is the order they are applied.
 *
 * A prompt is a `user` row that carries an `origin` (human, task-notification, peer) — or the bare
 * `/compact` the CLI writes for the command itself. A peer can open a turn while its message stays
 * hidden as meta context. Tool results, ordinary meta rows, the compaction summary and a local
 * command's output are the same turn's furniture, not prompts. Transcript-only task reports
 * still settle background work, but open no turn. A turn is closed by the summary of its Stop hooks, by
 * `turn_duration` or by the interruption marker (which names the prompt it interrupted) — unless a Stop hook
 * blocked first, which sends the model on (`stop_blocked`); `compact_boundary` closes a
 * compaction, and `agents_killed` ends every background agent at once.
 */
export function claudeRowSignals(row: ClaudeRow, parents?: Map<string, string>, activePromptId?: string): ClaudeSignal[] {
  if (row.isSidechain === true || row.agentId !== undefined) return [];
  // System end records carry their parent row rather than a prompt id. A delayed duration can
  // follow the next prompt in file order while still pointing to the previous Stop summary.
  const referenced = promptIdOf(row) ?? (typeof row.parentUuid === 'string' ? parents?.get(row.parentUuid) : undefined);
  const failure = claudeApiFailure(row);
  const terminal = row.type === 'system' && (row.subtype === 'turn_duration' || row.subtype === 'stop_hook_summary') || failure !== undefined;
  // Missing ancestry is not evidence about the current prompt: the parent may have been evicted
  // or be outside a tail read. In particular, omitting promptId would still close the active turn.
  if (terminal && parents && typeof row.parentUuid === 'string' && referenced === undefined) return [];
  const owner = referenced ?? activePromptId;
  if (parents && owner && row.uuid) {
    parents.set(row.uuid, owner);
    while (parents.size > 256) parents.delete(parents.keys().next().value!);
  }
  if (row.type === 'queue-operation') {
    const operation = string(row.operation);
    const text = string(row.content);
    const reason = string(row.reason);
    if (operation === 'enqueue' || operation === 'dequeue' || operation === 'remove') {
      return [{ type: 'queue', operation, ...(text ? { text } : {}), ...(reason ? { reason } : {}) }];
    }
    return operation === 'popAll' ? [{ type: 'queue', operation: 'clear' }] : [];
  }
  if (row.type === 'system') {
    if (row.subtype === 'turn_duration') return [{ type: 'turn_end', source: 'transcript', reason: 'duration', ...(owner ? { promptId: owner } : {}) }];
    // Written once every Stop hook has returned, which is when the CLI is done; `turn_duration` can be held back
    // past that while background work runs. Context a hook handed back sends the model on under the same prompt.
    if (row.subtype === 'stop_hook_summary') {
      return Array.isArray(row.hookAdditionalContext) && row.hookAdditionalContext.length ? [] : [{ type: 'turn_end', source: 'transcript', reason: 'stop', ...(owner ? { promptId: owner } : {}) }];
    }
    if (row.subtype === 'compact_boundary') return [{ type: 'compact_boundary' }];
    if (row.subtype === 'agents_killed') return [{ type: 'agents_killed' }];
    return [];
  }
  if (failure) return [{ type: 'turn_end', source: 'transcript', reason: 'stop_failure', error: failure, ...(owner ? { promptId: owner } : {}) }];
  if (row.type !== 'user') return [];
  const content = record(row.message)?.content;
  if (Array.isArray(content) && content.some(block => record(block)?.type === 'tool_result')) return [];
  const promptId = promptIdOf(row);
  if (hiddenPeerPrompt(row)) return [{
    type: 'prompt', source: 'transcript', origin: 'peer', promptId,
    ...(string(row.uuid) ? { uuid: string(row.uuid)! } : {}),
  }];
  const text = stripPastedContent(rowText(content)).trim();
  // A Stop hook that blocks hands the model its reason, before the summary of that round, and the model goes on.
  if (row.isMeta === true && text.startsWith(STOP_HOOK_FEEDBACK)) return [{ type: 'stop_blocked' }];
  if (text.startsWith(INTERRUPTED_MARKER)) return [{ type: 'turn_end', source: 'transcript', reason: 'interrupted', ...(promptId ? { promptId } : {}) }];
  const output = localCommandOutput(text);
  // 2.1.322 can persist the command after its compact_boundary. Its success output also closes
  // the command's journal turn, which did not exist yet when that boundary was read.
  if (output) return [{ type: compactedOutput(output) ? 'compact_boundary' : 'command_output' }];
  // A `!` command is a local command: its output ends it, unless the CLI hands that output to the model
  // (2.1.322's `respondToBashCommands`), when it marks the output row as the turn's input and the model answers.
  if (row.isMeta !== true && shellInputOf(text) !== undefined) {
    return [{ type: 'prompt', source: 'transcript', origin: 'human', ...(promptId ? { promptId } : {}), slash: true, ...(string(row.uuid) ? { uuid: string(row.uuid)! } : {}) }];
  }
  if (row.isMeta !== true && shellOutputOf(text) !== undefined) return row.turnOrigin === undefined ? [{ type: 'command_output' }] : [];
  const kind = string(record(row.origin)?.kind);
  const notice = kind === 'task-notification' ? taskNotification(content) : undefined;
  const signals: ClaudeSignal[] = notice?.toolUseId && notice.status !== 'running' ? [{ type: 'background_done', toolUseId: notice.toolUseId }] : [];
  if (row.isMeta === true || row.isCompactSummary === true || isTranscriptOnly(row)) return signals;
  const compact = /^\/compact(?:\s|$)/.test(text);
  if (kind === undefined && !compact) return signals;
  const origin: ClaudeTurnOrigin = kind === 'human' ? 'human' : kind === 'task-notification' ? 'task-notification' : kind === 'peer' ? 'peer' : compact ? 'human' : 'other';
  return [{
    type: 'prompt', source: 'transcript', origin, ...(promptId ? { promptId } : {}), ...(compact ? { compact } : {}),
    ...(text.startsWith('/') ? { slash: true } : {}), ...(string(row.uuid) ? { uuid: string(row.uuid)! } : {}),
  }, ...signals];
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

/** `runId` is the turn the call was issued in: its result keeps it, whatever turn the result row lands in. */
export interface ToolCall { name: string; input: Record<string, unknown>; runId?: string; nativeTurnId?: string; }
export interface ClaudeTask { id: string; content: string; status: 'pending' | 'in_progress' | 'completed'; }
/** `turnPromptId` is the CLI prompt id of the row that opened `turnId`, kept even when its rows carry no `nativeTurnId`. */
export interface MapperState { nativeTurnId?: string; turnId?: string; turnPromptId?: string; turnAt: string; calls: Map<string, ToolCall>; tasks: Map<string, ClaudeTask>; activities?: ClaudeActivities; }
export interface ClaudeTranscriptHooks {
  /** Complete static export; live/browser reads retain their existing payload bounds. */
  unbounded?: boolean;
  /** Reading-only shares do not need separate child transcripts. */
  skipSubagents?: boolean;
  /** Only genuine native hook attachments are eligible for delivery receipts. */
  additionalContext?: (text: string, sourceNativeId: string, createdAt: string) => NativeWorkbenchEvent[];
  commandForUserMessage?: (message: { uuid: string; promptId?: string; text: string }) => string | undefined;
  /** The user's own text for a prompt the workbench rewrote before typing it, given as read back. */
  promptText?: (prompt: string) => string | undefined;
  onToolUse?: (toolUseId: string, toolName: string, input: Record<string, unknown>) => void;
  onToolResult?: (toolUseId: string, failed: boolean) => void;
  /** What a command changed in the working tree, seen around it (`workspace-observer.ts`); appended to its result. */
  observedChanges?: (toolUseId: string) => readonly Record<string, unknown>[] | undefined;
  onModel?: (model: string) => void;
  /** Read-only exports associate the response model with its original message identity. */
  onMessageModel?: (nativeId: string, model: string) => void;
  /** Stores a full text (a compaction summary, a task's output) for the conversation to fetch later; returns its reference. */
  putBlob?: ClaudeActivityHooks['putBlob'];
  /**
   * Where to find the transcripts of `session.previousNativeSessionIds`. When set, their rows lead the
   * conversation, so a launch that had to start under a new id still shows what came before it.
   */
  precedingConfigDir?: string;
}

function rowText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((part) => {
    const item = record(part);
    return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
  }).join('\n');
}

/**
 * Claude Code 2.1.302 wraps a multi-line bracketed paste, once submitted, in
 * `<pasted_content id="x">\n…\n</pasted_content id="x">` (the closing tag repeats the attribute, each
 * tag sits on its own line, and the wrapper may be preceded by newlines). The wrapper is transport,
 * not something the reader typed: it is removed wherever the text is shown or compared against what
 * was sent. Any number of spans may sit among ordinary text; an unpaired tag is left as written.
 */
export function stripPastedContent(text: string): string {
  return text.replace(/<pasted_content\b[^>]*>\n?([\s\S]*?)\n?<\/pasted_content\b[^>]*>/g, '$1');
}

/**
 * A prompt as compared between what was sent and what the CLI recorded (its queue, its transcript,
 * its hook): no paste wrapper, one run of whitespace. Every such comparison goes through this one key.
 */
export function claudePromptKey(text: string): string {
  return stripPastedContent(text).replace(/\r\n/g, '\n').trim().replace(/\s+/g, ' ');
}

/**
 * A slash command or skill is stored as `<command-message>`/`<command-name>`/`<command-args>` markup;
 * it reads back as what was typed. Recognized only when the row opens with the markup, so a prompt
 * quoting the tags stays as written.
 */
export function commandPrompt(text: string): string {
  if (!/^<command-(?:message|name)>/.test(text)) return text;
  const name = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/.exec(text)?.[1];
  if (!name) return text;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? '';
  return args ? `/${name} ${args}` : `/${name}`;
}

/**
 * A subagent call carries the title the CLI itself shows for it. Claude Code called this tool
 * `Task` through 2.1.x and `Agent` after, so both names are the same thing here.
 */
function describeTool(name: string, input: Record<string, unknown>, unbounded = false): Record<string, unknown> {
  const path = string(input.file_path) ?? string(input.path) ?? string(input.target_file);
  const subagent = name === 'Task' || name === 'Agent';
  const title = name === 'Bash' ? string(input.description) ?? string(input.command) ?? 'Run command'
    : name === 'Monitor' ? string(input.description) ?? string(input.command) ?? 'Monitor'
    : name === 'Read' ? `Read ${path?.split(/[\\/]/).at(-1) ?? 'file'}`
      : ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name) ? `${name} ${path?.split(/[\\/]/).at(-1) ?? 'file'}`
        : name === 'AskUserQuestion' ? 'Ask a question'
          : name === 'ExitPlanMode' ? 'Review plan'
            : subagent ? string(input.description) ?? 'Subagent' : name;
  const kind = name === 'Bash' || name === 'Monitor' ? 'execute'
    : name === 'Read' ? 'read'
      : ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name) ? 'edit'
        : name === 'AskUserQuestion' ? 'question'
          : name === 'ExitPlanMode' ? 'plan'
            : subagent ? 'agent'
              : ['Grep', 'Glob', 'WebSearch'].includes(name) ? 'search' : 'other';
  /**
   * The reader asked to see what a file edit did, and the CLI's own input carries both sides of it:
   * `Edit` sends the replaced and the replacement text, `Write` sends the new file whole. Every
   * other backend turns that into a `diff` block here (`chat-store.ts`, `droid/events.ts`); without
   * it the UI has nothing to draw and an edit renders as its title alone — three `Edit a.ts` rows
   * with no visible change. The transcript's `toolUseResult.structuredPatch` would give hunk line
   * numbers too, but it is not reachable from here and is absent on some rows, so the input is what
   * this reads.
   */
  const oldText = string(input.old_string) ?? string(input.old_str);
  const newText = string(input.new_string) ?? string(input.new_str) ?? string(input.content);
  const edited = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name) && (oldText !== undefined || newText !== undefined);
  return {
    kind, title,
    ...(path ? { locations: [{ path }] } : {}),
    rawInput: input,
    ...(edited ? { content: [{ type: 'diff', path, oldText: clip(oldText ?? '', unbounded ? Infinity : EDIT_LIMIT), newText: clip(newText ?? '', unbounded ? Infinity : EDIT_LIMIT) }] } : {}),
    // The plan is prose the model wrote for the reader to approve, so it rides the call as Markdown
    // rather than as a `plan` event: that channel carries todo entries, and a client reading it for
    // `entries` drops a body it finds there.
    ...(name === 'ExitPlanMode' && string(input.plan) ? { content: [{ type: 'markdown', text: unbounded ? string(input.plan)! : clip(string(input.plan)!) }] } : {}),
    ...((name === 'Bash' || name === 'Monitor') && string(input.command) ? { command: input.command } : {}),
    // A call that returns at once and keeps running: the row says so before the result shows the task id.
    ...(!subagent && input.run_in_background === true ? { background: true } : {}),
    ...(subagent ? { subagent: {
      ...(string(input.description) ? { description: string(input.description) } : {}),
      prompt: string(input.prompt) ?? '',
      ...(string(input.subagent_type) ? { type: string(input.subagent_type) } : {}),
      ...(input.run_in_background === true ? { background: true } : {}),
    } } : {}),
  };
}

/**
 * Drops base64 too long for any row to show inline (`INLINE_IMAGE_LIMIT`) from a parsed row, keeping
 * its decoded size as `omittedBytes` beside it. Claude Code writes every screenshot into its
 * transcript, under the tool result and again inside its own request records; a session that takes
 * many of them is mostly these strings, which the workbench would only ever describe as left out.
 */
function slim(value: unknown, depth = 0): void {
  if (depth > 16 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value) slim(item, depth + 1); return; }
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    const item = object[key];
    if (typeof item !== 'string') { slim(item, depth + 1); continue; }
    if (item.length <= INLINE_IMAGE_LIMIT || !BASE64.test(item)) continue;
    delete object[key];
    object.omittedBytes = Buffer.byteLength(item, 'base64');
  }
}

/** One transcript line as a row; only a line long enough to carry an oversized picture is walked. */
export function parseRow(line: string, unbounded = false): ClaudeRow | undefined {
  const row = record(JSON.parse(line)) as ClaudeRow | undefined;
  if (!unbounded && row && line.length > INLINE_IMAGE_LIMIT) slim(row);
  return row;
}

/** The complete lines of [bytes], decoded one at a time rather than as one string the size of the file. */
function* transcriptLines(bytes: Buffer): Generator<string> {
  for (let start = 0; start < bytes.length;) {
    let end = bytes.indexOf(0x0a, start);
    if (end < 0) end = bytes.length;
    if (end > start) yield bytes.toString('utf8', start, end);
    start = end + 1;
  }
}

/** The absolute `screenshot` path in a `browser_screenshot` result's JSON text, if it named one. */
function savedScreenshot(text: string): string | undefined {
  try {
    const value = string(record(JSON.parse(text))?.screenshot);
    return value && isAbsolute(value) && !/[\r\n]/.test(value) ? value : undefined;
  } catch { return undefined; }
}

/** A tool_result is either a string or text/image blocks; Read of an image file answers with the latter. */
function toolResultContent(value: unknown, call: ToolCall | undefined, failed: boolean, unbounded = false): Array<Record<string, unknown>> {
  const single = string(value);
  if (single) return [{ type: 'content', content: { type: 'text', text: unbounded ? single : clip(single) } }];
  if (!Array.isArray(value)) return [];
  const blocks = value.map(record).filter((item): item is Record<string, unknown> => Boolean(item));
  const text = rowText(blocks);
  // The browser's screenshot saves the picture as an attachment and names its path in the JSON text; the row then loads it by that path.
  const savedPath = call && /(?:^|__)browser_screenshot$/.test(call.name) ? savedScreenshot(text) : undefined;
  const sourcePath = string(call?.input.file_path);
  const images = failed ? [] : blocks.filter(block => block.type === 'image').slice(0, unbounded ? undefined : 4).map((block, index) => {
    const source = record(block.source);
    const data = source?.type === 'base64' ? string(source.data) : undefined;
    const mimeType = string(source?.media_type);
    const path = index === 0 ? savedPath ?? (isImagePath(sourcePath) ? sourcePath : undefined) : undefined;
    // A picture slimmed out of its row (`slim`) still says how big it was, as its data would have.
    const omitted = !path && typeof source?.omittedBytes === 'number' ? source.omittedBytes : undefined;
    // A saved screenshot's path is an attachment object (`<id>.bin`); the row names the picture instead.
    return toolImageContent({ ...(path ? { path } : {}), ...(path && path === savedPath ? { name: 'screenshot.jpg' } : {}), ...(data ? { data } : {}), ...(omitted ? { bytes: omitted } : {}), ...(mimeType ? { mimeType } : {}) }, { unbounded });
  });
  return [...(text ? [{ type: 'content', content: { type: 'text', text: unbounded ? text : clip(text) } }] : []), ...images];
}

/** Claude Code exposes task state only after the matching Task tool result commits. */
function updateClaudeTasks(state: MapperState, call: ToolCall, result: Record<string, unknown>, resultText: string): boolean {
  if (result.success === false) return false;
  if (call.name === 'TaskCreate') {
    const taskResult = record(result.task);
    // The current CLI emits the structured id and subject here; the result text is retained as a
    // fallback for older transcripts that only recorded the human-readable tool result.
    const resultId = /^Task #([\w.-]+) created successfully\b/.exec(resultText)?.[1];
    const structuredId = string(taskResult?.id);
    if (structuredId && resultId && structuredId !== resultId) return false;
    const id = structuredId ?? resultId;
    const content = string(taskResult?.subject) ?? string(call.input.subject);
    if (!id || !content) return false;
    state.tasks.set(id, { id, content, status: 'pending' });
    return true;
  }
  if (call.name !== 'TaskUpdate') return false;
  const id = string(call.input.taskId);
  if (!id) return false;
  const resultTaskId = string(result.taskId) ?? string(record(result.task)?.id);
  const resultIdFromText = /^Updated task #([\w.-]+) status(?:\s|$)/.exec(resultText)?.[1];
  const confirmedSuccess = (result.success === true && resultTaskId === id) || resultIdFromText === id;
  if (!confirmedSuccess) return false;
  const current = state.tasks.get(id);
  const subject = string(call.input.subject);
  const statusChange = record(result.statusChange);
  const status = string(statusChange?.to) ?? string(call.input.status);
  if (status === 'deleted') {
    if (!current) return false;
    state.tasks.delete(id);
    return true;
  }
  const nextStatus = status === 'pending' || status === 'in_progress' || status === 'completed'
    ? status : current?.status ?? 'pending';
  if (!current && !subject) return false;
  state.tasks.set(id, { id, content: subject ?? current!.content, status: nextStatus });
  return true;
}

function taskPlan(state: MapperState): Array<{ id: string; content: string; status: string }> {
  return [...state.tasks.values()].map(({ id, content, status }) => ({ id, content, status }));
}

export function mapRow(row: ClaudeRow, line: number, session: Session, state: MapperState, hooks: ClaudeTranscriptHooks, allowSidechain = false): Array<Omit<NativeWorkbenchEvent, 'sequence'>> {
  const uuid = string(row.uuid) ?? `line-${line}`;
  const message = record(row.message);
  const createdAt = string(row.timestamp) ?? session.updatedAt;
  const type = row.type;
  // A subagent's own file is entirely sidechain rows; only the parent file has to drop them.
  if (!allowSidechain && row.isSidechain === true) return [];
  if (type === 'attachment' && !allowSidechain && row.agentId === undefined) {
    const attachment = record(row.attachment);
    if (attachment?.type !== 'hook_additional_context' || !string(attachment.toolUseID)
      || !['PostToolUse', 'PostToolUseFailure'].includes(string(attachment.hookEvent) ?? '')) return [];
    const content = attachment.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) && content.every(part => typeof part === 'string') ? content.join('\n') : '';
    return hooks.additionalContext?.(text, `claude:${session.nativeSessionId ?? session.id}:${uuid}:hook-context`, createdAt) ?? [];
  }
  if (type === 'queue-operation' && state.activities && !allowSidechain && row.agentId === undefined) {
    // A task's report reaches the queue before any row, and a stop's report may never reach one.
    const queued = string(row.content);
    if (queued && row.operation === 'enqueue') return state.activities.enqueued(queued, createdAt, state.turnId, state.calls);
    if (queued && row.operation === 'remove') state.activities.dequeuedWithoutRow(queued);
    return [];
  }
  if (type === 'system' && state.activities && !allowSidechain && row.agentId === undefined) {
    if (row.subtype === 'compact_boundary') return state.activities.compactionBoundary(uuid, record(row.compactMetadata), createdAt, state.turnId);
    if (row.subtype === 'agents_killed') return state.activities.agentsKilled(createdAt, state.turnId);
  }
  if (!message) return [];
  const content = message.content;
  const events: Array<Omit<NativeWorkbenchEvent, 'sequence'>> = [];
  const base = (part: number) => ({ sessionId: session.id, nativeId: `claude:${session.nativeSessionId ?? session.id}:${uuid}:${part}`, nativeAliases: [uuid], ...(state.turnId ? { runId: state.turnId } : {}), ...(state.nativeTurnId ? { nativeTurnId: state.nativeTurnId } : {}), createdAt });

  /**
   * A result carries the `runId` its call was issued with, so the pair always merges into one card:
   * a result row can land after a later prompt or notification has opened another turn, and a call
   * issued before any turn was known has none to give. A result whose call is out of view has only
   * the turn it was read in.
   */
  const resultBase = (part: number, call: ToolCall | undefined) => {
    const { runId: _turn, nativeTurnId: _nativeTurn, ...rest } = base(part);
    const runId = call ? call.runId : state.turnId;
    const nativeTurnId = call ? call.nativeTurnId : state.nativeTurnId;
    return { ...rest, ...(runId ? { runId } : {}), ...(nativeTurnId ? { nativeTurnId } : {}) };
  };

  if (type === 'user') {
    const parts = Array.isArray(content) ? content.map(record).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
    const toolResults = parts.filter(part => part.type === 'tool_result');
    for (const [index, part] of toolResults.entries()) {
      const toolUseId = string(part.tool_use_id);
      if (!toolUseId) continue;
      const call = state.calls.get(toolUseId);
      const rowResult = record(row.toolUseResult) ?? {};
      const resultTaskId = string(rowResult.taskId);
      const callTaskId = string(call?.input.taskId);
      const resultMatchesCall = toolResults.length === 1
        ? call?.name !== 'TaskUpdate' || resultTaskId === undefined || resultTaskId === callTaskId
        : call?.name === 'TaskUpdate' && resultTaskId !== undefined && resultTaskId === callTaskId;
      const failed = part.is_error === true
        || (toolResults.length === 1 && (call?.name === 'TaskCreate' || call?.name === 'TaskUpdate') && rowResult.success === false)
        || (call?.name === 'TaskUpdate' && resultTaskId !== undefined && resultTaskId === callTaskId && rowResult.success === false);
      hooks.onToolResult?.(toolUseId, failed);
      if (call?.name === 'TaskCreate' || call?.name === 'TaskUpdate') {
        const resultText = typeof part.content === 'string' ? part.content : rowText(part.content);
        const result = resultMatchesCall ? rowResult : {};
        const changedPlan = !failed && updateClaudeTasks(state, call, result, resultText);
        const resultContent = toolResultContent(part.content, call, failed, hooks.unbounded);
        events.push({ ...resultBase(index, call), type: 'tool_call_update', data: {
          sessionUpdate: 'tool_call_update', toolCallId: toolUseId, status: failed ? 'failed' : 'completed', toolName: call.name,
          ...(resultContent.length ? { content: resultContent } : {}),
        } });
        if (changedPlan) events.push({ ...base(toolResults.length + index), type: 'plan', data: { sessionUpdate: 'plan', entries: taskPlan(state) } });
        state.calls.delete(toolUseId);
        continue;
      }
      const observed = hooks.observedChanges?.(toolUseId) ?? [];
      const resultContent = [...toolResultContent(part.content, call, failed, hooks.unbounded), ...observed];
      events.push({ ...resultBase(index, call), type: 'tool_call_update', data: {
        sessionUpdate: 'tool_call_update', toolCallId: toolUseId, status: failed ? 'failed' : 'completed',
        ...(call ? { toolName: call.name } : { contextMissing: true }),
        ...(resultContent.length ? { content: resultContent } : {}),
      } });
      // A call that returned at once and left a task running (a background Bash, a Monitor, an Agent, a Workflow).
      if (call && !failed && state.activities && toolResults.length === 1) {
        events.push(...state.activities.launched(call, toolUseId, rowResult, typeof part.content === 'string' ? part.content : rowText(part.content), createdAt, call.runId));
        events.push(...state.activities.stoppedByCall(call, rowResult, createdAt, call.runId));
        events.push(...state.activities.resumed(call, toolUseId, rowResult, createdAt, call.runId));
      }
      state.calls.delete(toolUseId);
    }
    const raw = stripPastedContent(rowText(content)).trim();
    const typed = commandPrompt(raw);
    const text = hooks.promptText?.(typed) ?? typed;
    if (text && !toolResults.length) {
      // A task's report is stored as a user-role row the CLI injected. Unless it is transcript-only,
      // it opens the turn the reply belongs to, but it is not a human prompt: rendering its XML as one buries
      // the conversation under raw markup, so it becomes the same notice row the Cursor backend
      // emits for its own task notifications.
      const notice = taskNotification(content);
      const peerPromptId = hiddenPeerPrompt(row);
      if (peerPromptId) {
        if (state.nativeTurnId !== peerPromptId) {
          state.nativeTurnId = peerPromptId;
          state.turnId = `claude-turn:${uuid}`;
          state.turnAt = createdAt;
        }
        return events;
      }
      // Other injected rows ride along with a prompt — a loaded skill's whole body, the caveat in
      // front of a local command's output — and are neither prompts nor turns of their own.
      if (!notice && row.isMeta === true) return events;
      const activities = state.activities;
      const promptId = promptIdOf(row);
      if (activities && !notice) {
        // The summary a compaction left behind, and what a local command printed, are system activities: they
        // are neither something the reader said nor a turn, and must not move the turn the next reply belongs to.
        if (row.isCompactSummary === true) return [...events, ...activities.compactionSummary(uuid, raw, createdAt, state.turnId)];
        const output = localCommandOutput(raw);
        if (output) return [...events, ...activities.localOutput(output, uuid, promptId, createdAt, state.turnId)];
        // A `!` command is typed the way `/cost` is: the reader's message, and one command row for it and what it
        // printed (two user rows), in a turn of its own that the output ends or the model's answer goes on (`claudeRowSignals`).
        // As a message it is also what a run sent from here is claimed by, like any prompt.
        const shell = shellInputOf(raw);
        if (shell !== undefined) {
          state.nativeTurnId = promptId;
          state.turnId = `claude-turn:${uuid}`;
          state.turnPromptId = promptId;
          state.turnAt = createdAt;
          const typed = `!${/<bash-input>([\s\S]*?)<\/bash-input>/.exec(raw)![1]}`;
          const commandId = hooks.commandForUserMessage?.({ uuid, ...(promptId ? { promptId } : {}), text: typed });
          events.push({ ...base(0), type: 'user_message_chunk', data: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: typed }, ...(commandId ? { commandId } : {}) } });
          return [...events, ...activities.promptSubmitted(promptId, createdAt, state.turnId), ...activities.shellInput(shell, uuid, createdAt, state.turnId)];
        }
        const printed = shellOutputOf(raw);
        if (printed !== undefined) return [...events, ...activities.shellOutput(printed, uuid, createdAt, state.turnId)];
        // `/compact` is written twice (bare, then as `<command-name>` markup): one bubble is the reader's command.
        const commandName = commandNameOf(raw);
        if (commandName && activities.commandRow(commandName, promptId)) return events;
      }
      if (!notice || !isTranscriptOnly(row)) {
        state.nativeTurnId = notice ? undefined : promptId;
        state.turnId = `claude-turn:${uuid}`;
        state.turnPromptId = promptId;
        state.turnAt = createdAt;
      }
      if (notice) {
        const info = activities?.noticeInfo(notice);
        const monitorEvent = info?.kind === 'monitor' && notice.eventText !== undefined && notice.sourceStatus === undefined;
        events.push({ ...base(0), runId: state.turnId, type: 'task_notification', data: {
          sessionUpdate: 'task_notification', kind: noticeRowKind(info?.kind), status: monitorEvent ? 'running' : notice.status,
          ...(notice.sourceStatus ? { sourceStatus: notice.sourceStatus } : {}),
          title: notice.title,
          ...(notice.taskId ? { taskId: notice.taskId } : {}),
          ...(notice.toolUseId ? { subagentToolCallId: notice.toolUseId } : {}),
          ...(info?.command ? { command: info.command } : {}),
          ...(notice.outputFile ? { outputFile: notice.outputFile } : {}),
          ...(notice.result || notice.eventText ? { detail: notice.result ?? notice.eventText } : {}),
          ...(notice.tokens !== undefined ? { tokens: notice.tokens } : {}),
          ...(notice.durationMs !== undefined ? { durationMs: notice.durationMs } : {}),
        } });
        // Heard of already when it was queued: the row adds the notice, not a second change of state.
        if (activities && !activities.claimed(raw)) events.push(...activities.notified(notice, createdAt, state.turnId, state.calls));
        return events;
      }
      // Claude Code records its own interruption as a user row. Nobody said it and the turn already
      // ends as interrupted (`claudeRowSignals`), so it is not a message: the clients show the run's
      // stopped state instead, the way Droid hides its CLI's equivalent notice. It still opens a
      // turn boundary, and a compaction it cut short is still reported.
      const interrupted = raw.startsWith(INTERRUPTED_MARKER);
      if (!interrupted) {
        const commandId = hooks.commandForUserMessage?.({ uuid, ...(promptId ? { promptId } : {}), text });
        events.push({ ...base(0), runId: state.turnId, type: 'user_message_chunk', data: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text }, ...(commandId ? { commandId } : {}) } });
      }
      if (activities) {
        events.push(...activities.shellLost(createdAt, state.turnId));
        if (/^\/compact(?:\s|$)/.test(raw) && row.isMeta !== true) events.push(...activities.compactionStarted(uuid, promptId, createdAt, state.turnId));
        else if (interrupted) events.push(...activities.interrupted(createdAt, state.turnId));
        else events.push(...activities.promptSubmitted(promptId, createdAt, state.turnId));
      }
    }
    return events;
  }

  if (type !== 'assistant') return [];
  // The run's failure carries the text (`claudeRowSignals`).
  if (claudeApiFailure(row)) return [];
  const model = string(message.model);
  if (model && model !== '<synthetic>') hooks.onModel?.(model);
  if (!state.turnId) {
    state.turnId = `claude-turn:${uuid}`;
    state.turnAt = createdAt;
  }
  const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content.map(record).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
  // Every line of a message carries the message's final stop reason, so prose that a tool call
  // follows is known as commentary when it lands, not only once that call is written seconds later.
  const stop = string(message.stop_reason);
  const phase = stop === 'tool_use' ? 'commentary' : stop === 'end_turn' ? 'final_answer' : undefined;
  let ordinal = 0;
  for (const part of parts) {
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      if (model && model !== '<synthetic>') hooks.onMessageModel?.(base(ordinal).nativeId, model);
      events.push({ ...base(ordinal++), type: 'agent_message_chunk', data: { sessionUpdate: 'agent_message_chunk', ...(phase ? { phase } : {}), content: { type: 'text', text: hooks.unbounded ? part.text : clip(part.text) } } });
      continue;
    }
    if ((part.type === 'thinking' || part.type === 'reasoning') && typeof (part.thinking ?? part.text) === 'string') {
      const text = readableThinking(string(part.thinking) ?? string(part.text)!);
      if (text.trim()) events.push({ ...base(ordinal++), type: 'agent_thought_chunk', data: { sessionUpdate: 'agent_thought_chunk', channel: 'thinking', content: { type: 'text', text: hooks.unbounded ? text : clip(text) } } });
      continue;
    }
    if (part.type === 'tool_use' && typeof part.id === 'string' && typeof part.name === 'string') {
      const input = record(part.input) ?? {};
      state.calls.set(part.id, { name: part.name, input, ...(state.turnId ? { runId: state.turnId } : {}), ...(state.nativeTurnId ? { nativeTurnId: state.nativeTurnId } : {}) });
      hooks.onToolUse?.(part.id, part.name, input);
      events.push({ ...base(ordinal++), type: 'tool_call', data: { sessionUpdate: 'tool_call', toolCallId: part.id, toolName: part.name, status: 'in_progress', ...describeTool(part.name, input, hooks.unbounded) } });
    }
  }
  return events;
}

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

/** One assistant response of a Claude turn, measured from the transcript's own records. */
export interface ClaudeStepMeasurement {
  /** Native human receipt this response belongs to, retained through full transcript replays. */
  nativeMessageId?: string;
  /** The provider's message id: every content block of one response shares it. */
  stepId: string;
  runId?: string;
  commandId?: string;
  text: string;
  outputTokens: number;
  reasoningTokens?: number;
  /** Uncached input. Claude's `input_tokens` already excludes cache reads and writes. */
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** `message.model` on the response, when the row named one. */
  model?: string;
  /** The record written immediately before this response, which is when the request began. */
  startedAt: number;
  endedAt: number;
  /** True while this response is still the last thing in the transcript. */
  live: boolean;
  /**
   * `subagent` for a `<task-notification>` total. Parent `message.usage` is a different request
   * and does not include that total.
   */
  agentKind?: 'main' | 'subagent';
  subagentType?: string;
  parentStepId?: string;
}

const finiteToken = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const maxToken = (current: number | undefined, next: number | undefined) => {
  if (next === undefined) return current;
  if (current === undefined) return next;
  return Math.max(current, next);
};

const usageOf = (message: Record<string, unknown> | undefined) => {
  const usage = record(message?.usage);
  if (!usage) return undefined;
  const outputTokens = finiteToken(usage.output_tokens);
  const details = record(usage.output_tokens_details);
  const reasoningTokens = finiteToken(details?.thinking_tokens);
  // `input_tokens` is the cache miss. Cache creation and cache read are separate fields and are
  // not subtracted from it.
  const inputTokens = finiteToken(usage.input_tokens);
  const cacheWriteTokens = finiteToken(usage.cache_creation_input_tokens);
  const cacheReadTokens = finiteToken(usage.cache_read_input_tokens);
  const model = string(message?.model);
  if (outputTokens === undefined && inputTokens === undefined && cacheWriteTokens === undefined && cacheReadTokens === undefined) return undefined;
  return {
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(model ? { model } : {}),
  };
};

/**
 * Derive one speed measurement per Claude response.
 *
 * Claude reports exact `output_tokens` but only ever stamps the *end* of a response, so the start
 * has to come from the record written before it — the user turn or the tool result that triggered
 * the request. That bracket therefore contains the provider's time-to-first-token as well, which
 * is why these measurements are published with the `transcript` window rather than `stream`.
 *
 * A `<task-notification>` `<usage>` is the child's own total (`subagent_tokens`), kept as a
 * separate `subagent` step. The parent's `message.usage` is only the parent API request that
 * asked for the child (and, on the following request, the child's answer as ordinary input). It
 * does not include the child's generation, so the two records are not subtracted from each other.
 * The child JSONL is not measured here; folding it in as well would count the same child twice.
 *
 * Fed one row at a time, in file order, alongside the mapping: a growing transcript is measured
 * from its new rows only, and a response no row touched keeps the object it was last reported as.
 */
class ClaudeStepMeter {
  private readonly open = new Map<string, { step: ClaudeStepMeasurement; text: string[]; built?: ClaudeStepMeasurement; kept?: boolean }>();
  private readonly order: string[] = [];
  private readonly subagents: ClaudeStepMeasurement[] = [];
  private readonly toolParents = new Map<string, { stepId: string; subagentType?: string; nativeMessageId?: string; commandId?: string }>();
  private previousAt: number | undefined;
  private turnId: string | undefined;
  private nativeTurnId: string | undefined;
  private commandId: string | undefined;
  private nativeMessageId: string | undefined;
  private cache?: ClaudeStepMeasurement[];

  add(row: ClaudeRow, events: ReadonlyArray<Omit<NativeWorkbenchEvent, 'sequence'>>): void {
    if (row.isSidechain === true) return;
    const at = row.timestamp ? Date.parse(row.timestamp) : Number.NaN;
    const stamp = Number.isFinite(at) ? at : undefined;
    const peerPromptId = hiddenPeerPrompt(row);
    if (peerPromptId && peerPromptId !== this.nativeTurnId) {
      this.nativeTurnId = peerPromptId;
      this.turnId = undefined;
      this.commandId = undefined;
      this.nativeMessageId = undefined;
    }
    const userEvent = events.find(event => event.type === 'user_message_chunk');
    if (userEvent) {
      this.turnId = userEvent.runId ?? this.turnId;
      this.nativeTurnId = userEvent.nativeTurnId;
      this.commandId = typeof userEvent.data.commandId === 'string' ? userEvent.data.commandId : undefined;
      this.nativeMessageId = userEvent.nativeId;
    }
    const notice = events.find(event => event.type === 'task_notification' && event.data.kind === 'subagent');
    if (notice && !isTranscriptOnly(row)) {
      this.turnId = notice.runId;
      this.nativeTurnId = notice.nativeTurnId;
      this.commandId = undefined;
      this.nativeMessageId = notice.nativeId;
    }
    const usage = usageOf(record(row.message));
    const messageId = row.type === 'assistant' ? string(record(row.message)?.id) : undefined;
    if (messageId && stamp !== undefined) {
      let entry = this.open.get(messageId);
      if (!entry) {
        const assistant = events.find(event => event.runId);
        entry = {
          step: {
            stepId: messageId,
            ...(this.turnId ? { runId: this.turnId } : {}),
            ...(this.commandId ? { commandId: this.commandId } : {}),
            ...(this.nativeMessageId ? { nativeMessageId: this.nativeMessageId } : {}),
            text: '',
            outputTokens: 0,
            startedAt: this.previousAt ?? stamp,
            endedAt: stamp,
            live: false,
          },
          text: [],
        };
        // `apiBlockIndex` splits one response across several records; they share the message id,
        // so the response starts where its first block does, not where the last one does.
        this.open.set(messageId, entry);
        this.order.push(messageId);
        if (assistant?.runId) entry.step.runId = assistant.runId;
        if (assistant && typeof assistant.data.commandId === 'string') entry.step.commandId = assistant.data.commandId;
      }
      entry.built = undefined;
      this.cache = undefined;
      const parts = Array.isArray(record(row.message)?.content) ? record(row.message)!.content as unknown[] : [];
      for (const part of parts) {
        const block = record(part);
        if (!block) continue;
        if (block.type === 'text' && typeof block.text === 'string') entry.text.push(block.text);
        else if ((block.type === 'thinking' || block.type === 'reasoning') && typeof (block.thinking ?? block.text) === 'string') entry.text.push(readableThinking(String(block.thinking ?? block.text)));
        else if (block.type === 'tool_use') entry.text.push(JSON.stringify(block.input ?? {}));
      }
      entry.step.endedAt = Math.max(entry.step.endedAt, stamp);
      // Usage on the parts is cumulative for the response, so the largest reading is the total.
      if (usage) {
        if (usage.outputTokens !== undefined) entry.step.outputTokens = Math.max(entry.step.outputTokens, usage.outputTokens);
        if (usage.reasoningTokens !== undefined) entry.step.reasoningTokens = Math.max(entry.step.reasoningTokens ?? 0, usage.reasoningTokens);
        entry.step.inputTokens = maxToken(entry.step.inputTokens, usage.inputTokens);
        entry.step.cacheReadTokens = maxToken(entry.step.cacheReadTokens, usage.cacheReadTokens);
        entry.step.cacheWriteTokens = maxToken(entry.step.cacheWriteTokens, usage.cacheWriteTokens);
        if (usage.model) entry.step.model = usage.model;
      }
      for (const part of parts) {
        const block = record(part);
        if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue;
        const input = record(block.input);
        const subagentType = typeof input?.subagent_type === 'string' ? input.subagent_type : undefined;
        this.toolParents.set(block.id, { stepId: messageId, nativeMessageId: entry.step.nativeMessageId,
          commandId: entry.step.commandId, ...(subagentType ? { subagentType } : {}) });
      }
    }
    const noticeTokens = finiteToken(notice?.data.tokens);
    if (notice && noticeTokens !== undefined && stamp !== undefined) {
      const toolUseId = typeof notice.data.subagentToolCallId === 'string' ? notice.data.subagentToolCallId : undefined;
      const taskId = typeof notice.data.taskId === 'string' ? notice.data.taskId : undefined;
      const parent = toolUseId ? this.toolParents.get(toolUseId) : undefined;
      const durationMs = finiteToken(notice.data.durationMs);
      this.subagents.push({
        // tool-use-id, then task-id, then the row uuid: each is in the JSONL and stable across re-reads.
        stepId: `subagent:${toolUseId ?? taskId ?? string(row.uuid) ?? 'notice'}`,
        ...(parent?.commandId ? { commandId: parent.commandId } : {}),
        ...(parent?.nativeMessageId ? { nativeMessageId: parent.nativeMessageId } : {}),
        text: '',
        // One number only. The CLI does not split this total into input, cache, or output.
        outputTokens: noticeTokens,
        startedAt: durationMs !== undefined ? stamp - durationMs : (this.previousAt ?? stamp),
        endedAt: stamp,
        live: false,
        agentKind: 'subagent',
        ...(parent?.subagentType ? { subagentType: parent.subagentType } : {}),
        ...(parent ? { parentStepId: parent.stepId } : {}),
      });
      this.cache = undefined;
    }
    if (stamp !== undefined) this.previousAt = stamp;
  }

  /** The same array until a row changes a measurement, so a caller can tell nothing moved. */
  steps(): ClaudeStepMeasurement[] {
    if (this.cache) return this.cache;
    const steps: ClaudeStepMeasurement[] = [];
    for (const [index, id] of this.order.entries()) {
      const entry = this.open.get(id)!;
      if (!entry.built) {
        entry.built = { ...entry.step, text: entry.text.join('') };
        entry.kept = entry.built.outputTokens > 0 || /\S/.test(entry.built.text);
      }
      // The last response in the transcript is the one still being written; every earlier one was
      // superseded by a later record, which is exactly when Claude stopped streaming into it.
      if (index === this.order.length - 1) { if (entry.kept) steps.push({ ...entry.built, live: true }); }
      else if (entry.kept) steps.push(entry.built);
    }
    for (const step of this.subagents) if (step.outputTokens > 0) steps.push(step);
    this.cache = steps;
    return steps;
  }
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
