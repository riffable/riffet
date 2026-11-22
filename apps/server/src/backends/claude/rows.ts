import { INLINE_IMAGE_LIMIT } from '../shared/tool-images.js';
import { type ClaudeSignal, type ClaudeTurnOrigin } from './session-state.js';
import { compactedOutput, localCommandOutput, shellInputOf, shellOutputOf, taskNotification } from './activity.js';

/**
 * The largest transcript read. Rows are kept without the base64 no transcript shows (see
 * `parseRow`), so what stays in memory is far smaller than the file: a long session of screenshots
 * is mostly pictures, and its conversation must not vanish once the file outgrows a limit.
 */
export const MAX_TRANSCRIPT_BYTES = 512 * 1024 * 1024;

export const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export const FINAL_STOP_REASONS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal']);

export const clip = (value: string, limit = 24 * 1024) => value.length > limit ? `${value.slice(0, limit)}\n…` : value;

export const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

/**
 * The user row Claude Code writes for itself when a turn is cut short (`… for tool use` for the
 * variant that lands where a tool result was due). It names the prompt it interrupted, so the
 * transcript reads it as the end of that turn — but nobody said it, and it is not a message.
 */
export const INTERRUPTED_MARKER = '[Request interrupted by user';

/** How Claude Code words a Stop hook's blocking reason, as the meta row it hands the model (2.1.302: `Stop hook feedback:\n…`). */
export const STOP_HOOK_FEEDBACK = 'Stop hook feedback:';

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

/**
 * A non-error synthetic assistant row Claude Code writes to close an unanswered or interrupted user
 * turn in its history (e.g. on `--resume`: `model: "<synthetic>"`, `isApiErrorMessage: false`,
 * text `"No response requested."`). Neither the user nor the model produced it, so it must not open
 * a turn, render as an answer, or count as a metered model step.
 */
export function isClaudeSyntheticPlaceholder(row: ClaudeRow): boolean {
  if (row.type !== 'assistant' || row.isApiErrorMessage === true) return false;
  const message = record(row.message);
  if (string(message?.model) !== '<synthetic>') return false;
  const content = message?.content;
  return !(Array.isArray(content) && content.some(part => record(part)?.type === 'tool_use'));
}

/** A turn has exactly one end; the hook and the file record are two reports of the same one. */
export const isTerminalType = (type: string): boolean => type === 'run_completed' || type === 'run_failed' || type === 'run_cancelled';

/** Some providers serialize replay-only reasoning state into Claude's thinking string. */
export function readableThinking(text: string): string {
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

/**
 * Whether a thinking block is the progress note the CLI shows as prose (`· summary`) rather than reasoning.
 * Under `thinking.display: "updates"` the API returns reasoning empty and only progress notes with text;
 * a block without a signature did not come from that API (a proxy relaying another model's raw reasoning).
 * CLI versions that did not record the display still mark the note in its signature's header.
 */
export function isNarration(row: ClaudeRow, signature: unknown): boolean {
  if (typeof signature !== 'string' || !signature) return false;
  return row.thinkingDisplay === 'updates' || Buffer.from(signature.slice(0, 64), 'base64').includes('narration');
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
export function isTranscriptOnly(row: ClaudeRow): boolean {
  return row.queueTranscriptOnly === true || row.isVisibleInTranscriptOnly === true;
}

export function promptIdOf(row: ClaudeRow): string | undefined {
  return string(row.promptId) ?? string(row.prompt_id) ?? string(record(row.message)?.prompt_id);
}

/**
 * A hidden prompt that wakes the main agent — a peer's message, or a wake-up the agent scheduled for
 * itself (`/loop`, ScheduleWakeup) — opens a turn of its own; ordinary meta context cannot open one.
 */
export function hiddenTurnPrompt(row: ClaudeRow): string | undefined {
  if (row.type !== 'user' || row.isMeta !== true || row.isSidechain === true || row.agentId !== undefined
    || row.isCompactSummary === true || isTranscriptOnly(row) || hiddenTurnOrigin(row) === undefined) return undefined;
  const content = record(row.message)?.content;
  if (Array.isArray(content) && content.some(block => record(block)?.type === 'tool_result')) return undefined;
  const promptId = promptIdOf(row);
  return promptId?.trim() ? promptId : undefined;
}

export function hiddenTurnOrigin(row: ClaudeRow): ClaudeTurnOrigin | undefined {
  if (record(row.origin)?.kind === 'peer') return 'peer';
  return row.turnOrigin === 'scheduled' ? 'other' : undefined;
}

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
  if (row.type !== 'assistant' || isClaudeSyntheticPlaceholder(row)) return undefined;
  const message = record(row.message);
  if (FINAL_STOP_REASONS.has(string(message?.stop_reason) ?? '')) return true;
  const calls = Array.isArray(message?.content) ? message.content.map(record).filter(part => part?.type === 'tool_use') : [];
  return calls.some(part => string(part?.name) !== 'SubagentHandback') ? false : undefined;
}

/**
 * Whether a child row leaves the child owing another step: its prompt or a tool result waiting on
 * the model, or a model step that called a tool or is still being written. A final answer or
 * Claude's own interruption marker ends it; rows that are not conversation say nothing.
 */
export function claudeRowOwesStep(row: ClaudeRow): boolean | undefined {
  const message = record(row.message);
  if (row.type === 'assistant') return isClaudeSyntheticPlaceholder(row) ? undefined : !FINAL_STOP_REASONS.has(string(message?.stop_reason) ?? '');
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
  if (hiddenTurnPrompt(row)) return [{
    type: 'prompt', source: 'transcript', origin: hiddenTurnOrigin(row)!, promptId,
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

export function rowText(content: unknown): string {
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
 * Drops base64 too long for any row to show inline (`INLINE_IMAGE_LIMIT`) from a parsed row, keeping
 * its decoded size as `omittedBytes` beside it. Claude Code writes every screenshot into its
 * transcript, under the tool result and again inside its own request records; a session that takes
 * many of them is mostly these strings, which the workbench would only ever describe as left out.
 */
export function slim(value: unknown, depth = 0): void {
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
export function* transcriptLines(bytes: Buffer): Generator<string> {
  for (let start = 0; start < bytes.length;) {
    let end = bytes.indexOf(0x0a, start);
    if (end < 0) end = bytes.length;
    if (end > start) yield bytes.toString('utf8', start, end);
    start = end + 1;
  }
}
