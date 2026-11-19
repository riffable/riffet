import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import type { NativeActivity, NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';
import { taskReportDetail } from '../../../../../packages/timeline/src/values.js';
import { forkedSkill } from './subagents.js';
import {
  ACTIVITY_BLOB_LIMIT, ACTIVITY_DETAIL_LIMIT, ActivityLedger, activityEvent, activityId, activityTitle, clipDetail, isLiveActivity,
} from '../../journal/activity.js';

/**
 * Claude Code's system activities: background tasks (Bash, Monitor, Agent, Workflow), context
 * compaction and local command output. See docs/SESSION-JOURNAL.md, 系统活动.
 *
 * Everything here is a pure function of the rows seen so far: {@link ClaudeActivities} lives for one
 * mapping pass (or is carried from one read to the next in a cursor, `state()`/`restore`), and every
 * state it reports becomes one `session/update` activity event.
 */

const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export type ClaudeTaskKind = 'shell' | 'monitor' | 'agent' | 'workflow';
type MappedEvent = Omit<NativeWorkbenchEvent, 'sequence'>;

export const COMPACTION_TITLE = '上下文压缩';
/** Tail of a task's output file kept as its full text. */
const OUTPUT_TAIL_BYTES = 256 * 1024;
/** Agents remembered as reported over; a conversation rarely has this many, and the oldest matter least. */
const MAX_AGENTS_OVER = 256;
/** Monitor events kept in the preview; older ones fall off the front. */
const MONITOR_EVENT_LINES = 40;

// ---- task notifications ------------------------------------------------------------------------------

/** A background task's report, which Claude Code stores as a user-role row the CLI injected. */
export interface ClaudeTaskNotice {
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  sourceStatus?: string;
  title: string;
  summary?: string;
  taskId?: string;
  toolUseId?: string;
  outputFile?: string;
  result?: string;
  /** A Monitor's `<event>`: one line it printed. */
  eventText?: string;
  /** The result is only a receipt: the agent's report arrived as its own hand-back row, which shows it. */
  handedBack?: true;
  taskType?: string;
  tokens?: number;
  durationMs?: number;
}

/** Decode the XML escaping the CLI uses when a task's answer contains markup. */
function decodeNotificationText(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, name: string) => {
    const normalized = name.toLowerCase();
    if (normalized === 'amp') return '&';
    if (normalized === 'lt') return '<';
    if (normalized === 'gt') return '>';
    if (normalized === 'quot') return '"';
    if (normalized === 'apos') return "'";
    const codePoint = normalized.startsWith('#x') ? Number.parseInt(normalized.slice(2), 16) : Number.parseInt(normalized.slice(1), 10);
    try { return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity; } catch { return entity; }
  });
}

function notificationField(body: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}\\s*>`, 'i').exec(body);
  if (!match) return undefined;
  const value = decodeNotificationText(match[1]!).trim();
  return value || undefined;
}

function notificationStatus(source: string | undefined): ClaudeTaskNotice['status'] {
  switch (source?.trim().toLowerCase()) {
    case 'running': case 'in_progress': case 'in-progress': case 'pending': return 'running';
    case 'success': case 'succeeded': case 'completed': case 'complete': return 'completed';
    case 'error': case 'failed': case 'failure': return 'failed';
    case 'cancelled': case 'canceled': case 'aborted': case 'interrupted': case 'stopped': case 'killed': return 'cancelled';
    default: return 'unknown';
  }
}

/**
 * Recognize `<task-notification>` only as the whole row, so a human quoting the same tag in a prompt
 * stays an ordinary user turn. A task's report may be led by the CLI's own "[SYSTEM NOTIFICATION"
 * disclaimer (Monitor events are); the disclaimer is not part of the report.
 */
export function taskNotification(content: unknown): ClaudeTaskNotice | undefined {
  const text = string(content);
  if (!text) return undefined;
  const open = /^\s*<task-notification(?:\s[^>]*)?>/i.exec(text)
    ?? (/^\s*\[SYSTEM NOTIFICATION/.test(text) ? /<task-notification(?:\s[^>]*)?>/i.exec(text) : null);
  if (!open) return undefined;
  const body = text.slice(open.index + open[0].length);
  const close = /<\/task-notification\s*>/i.exec(body);
  const inner = close ? body.slice(0, close.index) : body;
  const summary = notificationField(inner, 'summary');
  // `Agent "生成随机成语" finished` — the quoted name is what the subagent list labels the row with
  // too, and it beats the whole sentence, which repeats the status as prose.
  const quoted = summary ? /[“"]([^”"]+)[”"]/.exec(summary) : undefined;
  const usage = /<usage(?:\s[^>]*)?>([\s\S]*?)<\/usage\s*>/i.exec(inner);
  const tokens = Number(usage ? notificationField(usage[1]!, 'subagent_tokens') : undefined);
  const durationMs = Number(usage ? notificationField(usage[1]!, 'duration_ms') : undefined);
  const sourceStatus = notificationField(inner, 'status');
  const taskId = notificationField(inner, 'task-id');
  const toolUseId = notificationField(inner, 'tool-use-id');
  const outputFile = notificationField(inner, 'output-file');
  const reported = notificationField(inner, 'result');
  const result = taskReportDetail(reported, taskId);
  const eventText = notificationField(inner, 'event');
  const taskType = notificationField(inner, 'task-type');
  return {
    status: notificationStatus(sourceStatus),
    ...(sourceStatus ? { sourceStatus } : {}),
    title: quoted?.[1]?.trim() || summary || '子 Agent',
    ...(summary ? { summary } : {}),
    ...(taskId ? { taskId } : {}),
    ...(toolUseId ? { toolUseId } : {}),
    ...(outputFile ? { outputFile } : {}),
    ...(result ? { result } : {}),
    ...(reported && !result ? { handedBack: true as const } : {}),
    ...(eventText ? { eventText } : {}),
    ...(taskType ? { taskType } : {}),
    ...(Number.isFinite(tokens) ? { tokens } : {}),
    ...(Number.isFinite(durationMs) ? { durationMs } : {}),
  };
}

/**
 * The digest of a text's `<task-notification>` block, whitespace-normalised: how the same report is
 * recognised in the queue and in the row that later carries it, without keeping the report itself.
 */
export function noticeKey(text: string | undefined): string | undefined {
  const block = text ? /<task-notification[\s\S]*?<\/task-notification\s*>/i.exec(text)?.[0] : undefined;
  return block === undefined ? undefined : createHash('sha1').update(block.replace(/\s+/g, ' ').trim()).digest('base64');
}

/** What the summary line of a report says the task was, when nothing else identifies it. */
function kindFromSummary(notice: ClaudeTaskNotice): ClaudeTaskKind | undefined {
  const summary = notice.summary ?? '';
  if (/^Monitor\b/i.test(summary)) return 'monitor';
  if (/^Dynamic workflow\b|^Workflow\b/i.test(summary)) return 'workflow';
  if (/^(?:Agent|Background agent)\b/i.test(summary) || notice.tokens !== undefined) return 'agent';
  if (/^(?:Background command|Task)\b/i.test(summary)) return 'shell';
  return undefined;
}

/** The `kind` of the `task_notification` row for a report: the identified task's kind, else a subagent as before. */
export function noticeRowKind(kind: ClaudeTaskKind | undefined): string {
  return kind === 'agent' || kind === undefined ? 'subagent' : kind;
}

/** `Background command "X" failed with exit code 2` / `… completed (exit code 0)`. */
export function exitCodeOf(summary: string | undefined): number | undefined {
  const match = summary ? /\bexit code (-?\d+)/i.exec(summary) : null;
  return match ? Number(match[1]) : undefined;
}

// ---- task output files -------------------------------------------------------------------------------

/** Where Claude Code keeps a background task's output: `…/tmp/claude-<uid>/<project>/<session>/tasks/<id>.output`. */
const TASK_OUTPUT_PATH = /^\/(?:private\/)?tmp\/claude-[^/]+\/(?:[^/]+\/)+tasks\/[A-Za-z0-9._-]+$/;

/** The path when it is a task output file under the CLI's own temporary directory; anything else is not ours to read. */
export function taskOutputPath(path: string | undefined): string | undefined {
  if (!path || path.length > 1024 || path.includes('\0') || path.split('/').includes('..')) return undefined;
  return TASK_OUTPUT_PATH.test(path) ? path : undefined;
}

/** The last bytes of a task's output file, or `undefined` when the path is not a task output file or cannot be read. */
export async function readTaskOutputTail(path: string, limit = OUTPUT_TAIL_BYTES): Promise<string | undefined> {
  const safe = taskOutputPath(path);
  if (!safe) return undefined;
  try {
    // A link inside the directory must not lead the read somewhere else.
    const real = await realpath(safe);
    if (!TASK_OUTPUT_PATH.test(real)) return undefined;
    const handle = await open(real, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile()) return undefined;
      const start = Math.max(0, info.size - limit);
      const buffer = Buffer.alloc(info.size - start);
      let filled = 0;
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, start + filled);
        if (!bytesRead) break;
        filled += bytesRead;
      }
      return buffer.subarray(0, filled).toString('utf8');
    } finally { await handle.close(); }
  } catch { return undefined; }
}

/** The preview of a task's output: its last lines, within the detail limit. */
export function outputPreview(text: string): string {
  const plain = clipDetail(text, ACTIVITY_BLOB_LIMIT);
  return plain.length > ACTIVITY_DETAIL_LIMIT ? clipDetail(`…${plain.slice(-(ACTIVITY_DETAIL_LIMIT - 2))}`) : plain;
}

// ---- local commands ----------------------------------------------------------------------------------

const LOCAL_OUTPUT = /^\s*<local-command-(stdout|stderr)>([\s\S]*?)(?:<\/local-command-\1>\s*)?$/;

/** The output a local command printed, without the CLI's tag. */
export function localCommandOutput(text: string): { stream: 'stdout' | 'stderr'; text: string } | undefined {
  const match = LOCAL_OUTPUT.exec(text);
  return match ? { stream: match[1] as 'stdout' | 'stderr', text: match[2]! } : undefined;
}

/**
 * `/compact`'s success output. 2.1.322 dims it and, with a PreCompact hook registered, adds that hook's status line:
 * `\x1b[2mCompacted (ctrl+o to see full summary)\x1b[22m\n\x1b[2mPreCompact […] completed successfully\x1b[22m`.
 */
export function compactedOutput(output: { stream: 'stdout' | 'stderr'; text: string }): boolean {
  return output.stream === 'stdout' && /^Compacted\b/.test(clipDetail(output.text));
}

/** `<command-name>/compact</command-name>` → `compact`. */
export function commandNameOf(text: string): string | undefined {
  return /^\s*<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/.exec(text)?.[1];
}

/** A shell command the reader ran with `!`, as the CLI records it when it starts: `<bash-input>ls</bash-input>`. */
export function shellInputOf(text: string): string | undefined {
  const command = /^\s*<bash-input>([\s\S]*?)<\/bash-input>\s*$/.exec(text)?.[1]?.trim();
  return command || undefined;
}

/**
 * What that command printed, written when it ends: `<bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>`.
 * The CLI keeps no exit code and no interleaving, so both streams read as one output, stdout first.
 */
export function shellOutputOf(text: string): string | undefined {
  const match = /^\s*<bash-stdout>([\s\S]*?)<\/bash-stdout>\s*(?:<bash-stderr>([\s\S]*?)<\/bash-stderr>)?\s*$/.exec(text)
    ?? /^\s*()<bash-stderr>([\s\S]*?)<\/bash-stderr>\s*$/.exec(text);
  if (!match) return undefined;
  return [match[1], match[2]].map(part => part?.replace(/\s+$/, '') ?? '').filter(Boolean).join('\n');
}

// ---- the activities of one mapping pass --------------------------------------------------------------

export interface ClaudeActivityHooks {
  /** Stores a full text for the conversation to fetch later; returns the reference clients ask for. */
  putBlob?: (text: string) => string | undefined;
}

interface Launch { taskId: string; kind: ClaudeTaskKind; title: string; command?: string; outputFile?: string }

/** Tool calls by id, as the mapping holds the ones still waiting for their result. */
type OpenCalls = ReadonlyMap<string, { name: string; input: Record<string, unknown> }>;

/**
 * The Monitor call a report of a task not seen yet comes from: the one still waiting for its result whose description the
 * report names. A Monitor's first event can reach the CLI's queue before the result that says it started, and names no call.
 */
function launchingMonitor(calls: OpenCalls | undefined, title: string): string | undefined {
  let found: string | undefined;
  for (const [id, call] of calls ?? []) if (call.name === 'Monitor' && string(call.input.description)?.trim() === title) found = id;
  return found;
}

function launchOf(call: { name: string; input: Record<string, unknown> }, result: Record<string, unknown>, text: string): Launch | undefined {
  const description = string(call.input.description)?.trim();
  const command = string(call.input.command);
  const outputFile = /(?:Output is being written to|output_file):\s*(\/\S+?\.output)/.exec(text)?.[1];
  const bashId = string(result.backgroundTaskId);
  if (bashId) return { taskId: bashId, kind: 'shell', title: description || activityTitle(command ?? '', '后台命令'), ...(command ? { command } : {}), ...(outputFile ? { outputFile } : {}) };
  if (call.name === 'Monitor' && string(result.taskId)) {
    return { taskId: string(result.taskId)!, kind: 'monitor', title: description || activityTitle(command ?? '', 'Monitor'), ...(command ? { command } : {}) };
  }
  const agentId = string(result.agentId);
  const fork = forkedSkill(call, result);
  if (fork?.background === true) return { taskId: fork.agentId, kind: 'agent', title: fork.title };
  if (result.isAsync === true && result.status === 'async_launched' && agentId) {
    return { taskId: agentId, kind: 'agent', title: description || string(result.description) || 'Subagent', ...(outputFile ? { outputFile } : {}) };
  }
  const workflowId = string(result.taskId);
  if (result.status === 'async_launched' && result.taskType === 'local_workflow' && workflowId) {
    return { taskId: workflowId, kind: 'workflow', title: string(result.workflowName) || string(result.summary) || 'Workflow', ...(outputFile ? { outputFile } : {}) };
  }
  return undefined;
}

/** An automatic compaction its hook announced for a prompt whose row has not been read yet. */
interface HeldCompaction { id: string; promptId: string; at: string }

/** Everything a {@link ClaudeActivities} holds, as JSON: one restored from it carries on exactly where this one stood. */
export interface ClaudeActivitiesState {
  items: NativeActivity[];
  runs?: Array<[string, string | null]>;
  byToolCall?: Array<[string, string]>;
  outputs?: Array<[string, string]>;
  monitorLines?: Array<[string, string[]]>;
  queued?: Array<[string, number]>;
  agentsOver?: string[];
  compaction?: string;
  heldCompaction?: HeldCompaction;
  prompt?: string;
  awaitingSummary?: string;
  bareCommand?: { name: string; promptId?: string };
  lastCommand?: { name: string; promptId?: string };
  shell?: string;
}

export interface ClaudeActivitiesOptions {
  /**
   * How many ended activities are remembered; older ones are forgotten as soon as there are more, with
   * what pointed at them. A reader that carries its mapping in a cursor (`transcript-source.ts`) keeps it
   * small this way; without a limit one pass over a file remembers them all.
   */
  retainEnded?: number;
}

/** Reports queued and not yet shown that a bounded mapping remembers. */
const QUEUED_RETAINED = 32;

/**
 * The activities one pass over a transcript produces. Each method returns the transcript events for the
 * states that changed; the ledger applies the rules every backend shares (an ended activity stays
 * ended, the first start stays, duration is derived).
 */
export class ClaudeActivities {
  private readonly states: ActivityLedger;
  private readonly changed: NativeActivity[] = [];
  /** The run each execution's first state belonged to; a proven relaunch names its new run. */
  private readonly runs = new Map<string, string | undefined>();
  private readonly byToolCall = new Map<string, string>();
  private readonly outputs = new Map<string, string>();
  private readonly monitorLines = new Map<string, string[]>();
  /**
   * Reports the CLI queued and has not yet shown as a row, by text. A report is queued the moment it exists
   * (a stop's report may never become a row at all), so the queue is where an activity first hears of it.
   */
  private readonly queued = new Map<string, number>();
  /** Agents whose end the transcript reported (a TaskStop result, a terminal report) and that were not launched or resumed since. */
  private readonly over = new Set<string>();
  /** The compaction a `/compact` is running, until its boundary arrives. */
  private compaction?: { id: string };
  /**
   * An automatic compaction the CLI started on a prompt whose row is not on disk yet. It waits for that row,
   * so it lands in the prompt's turn rather than at the end of the one before.
   */
  private heldCompaction?: HeldCompaction;
  /** The `promptId` of the last prompt row read. */
  private prompt?: string;
  /** The compaction whose summary row has not been seen yet. */
  private awaitingSummary?: string;
  /** The bare `/compact` row that stands for the user's command; its `<command-name>` twin adds nothing. */
  private bareCommand?: { name: string; promptId?: string };
  private lastCommand?: { name: string; promptId?: string };
  /** The `!` command whose output has not been written yet. */
  private shell?: string;

  constructor(private readonly sessionId: string, private readonly hooks: ClaudeActivityHooks = {}, private readonly options: ClaudeActivitiesOptions = {}) {
    this.states = new ActivityLedger(activity => { this.changed.push(activity); });
  }

  static restore(sessionId: string, hooks: ClaudeActivityHooks, state: ClaudeActivitiesState, options: ClaudeActivitiesOptions = {}): ClaudeActivities {
    const restored = new ClaudeActivities(sessionId, hooks, options);
    restored.load(state.items);
    for (const [id, run] of state.runs ?? []) restored.runs.set(id, run ?? undefined);
    for (const [call, id] of state.byToolCall ?? []) restored.byToolCall.set(call, id);
    for (const [id, path] of state.outputs ?? []) restored.outputs.set(id, path);
    for (const [id, lines] of state.monitorLines ?? []) restored.monitorLines.set(id, lines);
    for (const [key, count] of state.queued ?? []) restored.queued.set(key, count);
    for (const id of state.agentsOver ?? []) restored.over.add(id);
    if (state.compaction) restored.compaction = { id: state.compaction };
    restored.heldCompaction = state.heldCompaction;
    restored.prompt = state.prompt;
    restored.awaitingSummary = state.awaitingSummary;
    restored.bareCommand = state.bareCommand;
    restored.lastCommand = state.lastCommand;
    restored.shell = state.shell;
    return restored;
  }

  state(): ClaudeActivitiesState {
    return {
      items: this.states.list(),
      ...(this.runs.size ? { runs: [...this.runs].map(([id, run]): [string, string | null] => [id, run ?? null]) } : {}),
      ...(this.byToolCall.size ? { byToolCall: [...this.byToolCall] } : {}),
      ...(this.outputs.size ? { outputs: [...this.outputs] } : {}),
      ...(this.monitorLines.size ? { monitorLines: [...this.monitorLines] } : {}),
      ...(this.queued.size ? { queued: [...this.queued] } : {}),
      ...(this.over.size ? { agentsOver: [...this.over] } : {}),
      ...(this.compaction ? { compaction: this.compaction.id } : {}),
      ...(this.heldCompaction ? { heldCompaction: this.heldCompaction } : {}),
      ...(this.prompt ? { prompt: this.prompt } : {}),
      ...(this.awaitingSummary ? { awaitingSummary: this.awaitingSummary } : {}),
      ...(this.bareCommand ? { bareCommand: this.bareCommand } : {}),
      ...(this.lastCommand ? { lastCommand: this.lastCommand } : {}),
      ...(this.shell ? { shell: this.shell } : {}),
    };
  }

  /** The ledger holding exactly `items`, in this order: states it already applied once, so applying them again changes none. */
  private load(items: readonly NativeActivity[]): void {
    this.states.clear();
    for (const item of items) this.states.apply(item);
    this.changed.length = 0;
  }

  /**
   * Forgets the activities that ended longest ago past `retainEnded`, keeping the one whose compaction summary is still
   * due. By end, not by start: a task launched early that ends now is the state its reader is about to write.
   */
  private prune(): void {
    const limit = this.options.retainEnded;
    if (limit === undefined) return;
    while (this.queued.size > QUEUED_RETAINED) this.queued.delete(this.queued.keys().next().value!);
    const ended = this.states.list().filter(item => !isLiveActivity(item) && item.id !== this.awaitingSummary);
    if (ended.length <= limit) return;
    const endOf = (item: NativeActivity) => Date.parse(item.endedAt ?? '') || 0;
    ended.sort((left, right) => endOf(left) - endOf(right));
    const gone = new Set(ended.slice(0, ended.length - limit).map(item => item.id));
    this.load(this.states.list().filter(item => !gone.has(item.id)));
    for (const id of gone) { this.runs.delete(id); this.outputs.delete(id); this.monitorLines.delete(id); }
    for (const [call, id] of this.byToolCall) if (gone.has(id)) this.byToolCall.delete(call);
  }

  /** The latest state of every activity, in the order they first appeared. */
  list(): NativeActivity[] { return this.states.list(); }
  get(id: string): NativeActivity | undefined { return this.states.get(id); }
  /** The transcript no longer proves this agent launch. Its original tool rows remain history. */
  forgetAgent(id: string): void {
    if (this.states.get(id)?.task?.kind !== 'agent') return;
    this.load(this.states.list().filter(item => item.id !== id));
    this.runs.delete(id);
    this.outputs.delete(id);
    this.over.delete(id.slice('claude:'.length));
    for (const [call, activity] of this.byToolCall) if (activity === id) this.byToolCall.delete(call);
  }
  /** Output files of the tasks seen, by activity id. */
  outputFiles(): ReadonlyMap<string, string> { return this.outputs; }
  /** Remembers an agent the rows reported over; the oldest are let go past `MAX_AGENTS_OVER`. */
  private markOver(agentId: string): void {
    this.over.delete(agentId);
    this.over.add(agentId);
    while (this.over.size > MAX_AGENTS_OVER) this.over.delete(this.over.values().next().value!);
  }

  /** Agent ids (not activity ids) the rows reported over, and nothing launched or resumed again. */
  agentsOver(): ReadonlySet<string> { return this.over; }

  /**
   * An end no row shows, learned beside the transcript (a subagent's metadata) or from the CLI being gone. Only a live
   * activity takes it; false when there was none to end.
   */
  ended(id: string, status: 'completed' | 'stopped' | 'unknown', at: string): boolean {
    const known = this.states.get(id);
    if (!known || !isLiveActivity(known)) return false;
    if (this.compaction?.id === id) this.compaction = undefined;
    this.put({ ...known, status, endedAt: at }, at, this.runs.get(id));
    return true;
  }

  /** Ended shells and workflows whose output file is still to be read into their state, by activity id. */
  owedOutputs(): Array<[string, string]> {
    return [...this.outputs].filter(([id]) => {
      const known = this.states.get(id);
      // An agent's output file is its whole transcript and a monitor's is every event it printed: neither is a result to show.
      return known?.kind === 'background_task' && !isLiveActivity(known) && known.status !== 'unknown' && (known.task?.kind === 'shell' || known.task?.kind === 'workflow');
    });
  }

  /** The tail of task `id`'s output file was read (`text`, if it had any): it becomes the detail, and the file is not read again. */
  outputRead(id: string, text: string | undefined, at: string): boolean {
    this.outputs.delete(id);
    const known = this.states.get(id);
    if (!known || !text?.trim()) return false;
    const blobRef = this.hooks.putBlob?.(text);
    this.put({ ...known, detail: outputPreview(text), ...(blobRef ? { blobRef } : {}) }, at, this.runs.get(id));
    return true;
  }
  /** What a report is about: the task it names, else what its summary says. */
  noticeInfo(notice: ClaudeTaskNotice): { kind?: ClaudeTaskKind; command?: string; title?: string } {
    const id = notice.taskId ? activityId('claude', notice.taskId) : notice.toolUseId ? this.byToolCall.get(notice.toolUseId) : undefined;
    const known = id ? this.states.get(id) : undefined;
    const kind = (known?.task?.kind as ClaudeTaskKind | undefined) ?? kindFromSummary(notice);
    // The launch's title is the call's own description; the report's summary only quotes the command.
    return { ...(kind ? { kind } : {}), ...(known?.task?.command ? { command: known.task.command } : {}), ...(known?.title ? { title: known.title } : {}) };
  }

  /** The agent a task id names, as its launch titled it. */
  agentOf(taskId: string): { title: string; toolCallId?: string } | undefined {
    const known = this.states.get(activityId('claude', taskId));
    return known?.task?.kind === 'agent' ? { title: known.title, ...(known.toolCallId ? { toolCallId: known.toolCallId } : {}) } : undefined;
  }

  private put(next: NativeActivity, at: string, runId: string | undefined): MappedEvent[] {
    const previous = this.states.get(next.id);
    const when = new Date(at);
    const applied = this.states.apply(next, Number.isFinite(when.getTime()) ? when : new Date());
    if (!this.runs.has(next.id) || previous && applied !== previous && applied.toolCallId !== previous.toolCallId && applied.startedAt !== previous.startedAt) {
      this.runs.set(next.id, runId);
    }
    const events = this.changed.splice(0).map(activity => {
      const { sequence: _sequence, ...event } = activityEvent(this.sessionId, activity, { createdAt: at, ...(this.runs.get(activity.id) ? { runId: this.runs.get(activity.id)! } : {}) });
      return event;
    });
    this.prune();
    return events;
  }

  // ---- background tasks ----

  /** A tool result that started a task which keeps running after the call returned. */
  launched(call: { name: string; input: Record<string, unknown> }, toolUseId: string, result: Record<string, unknown>, text: string, at: string, runId: string | undefined): MappedEvent[] {
    const launch = launchOf(call, result, text);
    if (!launch) return [];
    const id = activityId('claude', launch.taskId);
    const previous = this.states.get(id);
    if (launch.kind === 'agent') this.over.delete(launch.taskId);
    const outputFile = taskOutputPath(launch.outputFile);
    const events = this.put({
      id, kind: 'background_task', status: 'running', title: launch.title, toolCallId: toolUseId, startedAt: at, stop: { via: 'session' },
      task: { kind: launch.kind, ...(launch.command ? { command: clipDetail(launch.command, 500) } : {}) },
      ...(outputFile ? { detail: `Output file: ${outputFile}` } : {}),
    }, at, runId);
    const applied = this.states.get(id);
    if (applied?.toolCallId === toolUseId) {
      this.byToolCall.set(toolUseId, id);
      if (previous && applied.startedAt !== previous.startedAt) this.outputs.delete(id);
      if (outputFile) this.outputs.set(id, outputFile);
    }
    return events;
  }

  /** A `TaskStop` (formerly `KillShell`) that returned: the task it names is over, and no report of its end follows. */
  stoppedByCall(call: { name: string; input: Record<string, unknown> }, result: Record<string, unknown>, at: string, runId: string | undefined): MappedEvent[] {
    if (call.name !== 'TaskStop' && call.name !== 'KillShell') return [];
    const taskId = string(result.task_id) ?? string(call.input.task_id) ?? string(call.input.shell_id);
    const known = taskId ? this.states.get(activityId('claude', taskId)) : undefined;
    if (taskId && (known?.task?.kind ?? 'agent') === 'agent') this.markOver(taskId);
    if (!known || !isLiveActivity(known)) return [];
    return this.put({ ...known, status: 'stopped', endedAt: at }, at, runId);
  }

  /**
   * A `SendMessage` that woke a finished agent: the same agent runs again, as a new execution launched by this call.
   * Its report carries this call's id, and a report of the launch before it is stale.
   */
  resumed(call: { name: string; input: Record<string, unknown> }, toolUseId: string, result: Record<string, unknown>, at: string, runId: string | undefined): MappedEvent[] {
    if (call.name !== 'SendMessage') return [];
    const events: MappedEvent[] = [];
    for (const agentId of new Set([string(result.resumedAgentId), string(result.revivedAgentId)])) {
      if (!agentId) continue;
      this.over.delete(agentId);
      const id = activityId('claude', agentId);
      const known = this.states.get(id);
      // A message to an agent that is still running is not a new execution of it; only a finished one is woken.
      if (known?.task?.kind !== 'agent' || known.toolCallId === toolUseId || isLiveActivity(known)) continue;
      const { endedAt: _endedAt, durationMs: _durationMs, ...rest } = known;
      events.push(...this.put({ ...rest, status: 'running', toolCallId: toolUseId, startedAt: at }, at, runId));
      if (this.states.get(id)?.toolCallId === toolUseId) this.byToolCall.set(toolUseId, id);
    }
    return events;
  }

  /**
   * A task's report: its end, or (for a Monitor) one more event on a task that keeps running. `calls`: the tool calls
   * still waiting for their result, for a report that comes before the result that launched its task.
   */
  notified(notice: ClaudeTaskNotice, at: string, runId: string | undefined, calls?: OpenCalls): MappedEvent[] {
    const knownByCall = notice.toolUseId ? this.byToolCall.get(notice.toolUseId) : undefined;
    const taskId = notice.taskId ?? (knownByCall ? knownByCall.slice('claude:'.length) : undefined);
    if (!taskId) return [];
    const id = activityId('claude', taskId);
    const previous = this.states.get(id);
    // A report naming a call this conversation neither launched nor has open belongs to a subagent: the CLI
    // queues a subagent's task reports on the session too (a Bash that timed out into the background, say),
    // and the subagent takes them. Its own transcript shows that call; the conversation gets no row of it.
    if (!previous && notice.toolUseId && !knownByCall && !calls?.has(notice.toolUseId)) return [];
    // A reused agent id still receives reports for its old launch. Never restate one of those with
    // the current launch's identity, which would let its terminal state end the new execution.
    if (previous?.task?.kind === 'agent') {
      if (notice.toolUseId && previous.toolCallId && notice.toolUseId !== previous.toolCallId) return [];
      const reportedAt = Date.parse(at), startedAt = Date.parse(previous.startedAt ?? '');
      if (Number.isFinite(reportedAt) && Number.isFinite(startedAt) && reportedAt < startedAt) return [];
    }
    const kind = (previous?.task?.kind as ClaudeTaskKind | undefined) ?? kindFromSummary(notice);
    const sourceStatus = notice.sourceStatus?.toLowerCase();
    const expired = kind === 'monitor' && notice.eventText !== undefined && /^\[?\s*Monitor (?:expired|timed out)/i.test(notice.eventText);
    const ended = notice.status !== 'running' && sourceStatus !== undefined || expired;
    if (ended && kind === 'agent') this.markOver(taskId);
    // A report that says neither "ended" nor "an event" is not about a task (an auto-reply notice, say).
    if (!ended && !(kind === 'monitor' && notice.eventText !== undefined)) return [];
    const outputFile = taskOutputPath(notice.outputFile);
    if (outputFile) this.outputs.set(id, outputFile);
    const toolUseId = notice.toolUseId ?? (!previous && kind === 'monitor' ? launchingMonitor(calls, notice.title) : undefined);
    const base: NativeActivity = previous ?? {
      id, kind: 'background_task', status: 'running', title: notice.title, startedAt: at, stop: { via: 'session' },
      task: { kind: kind ?? 'shell' },
      ...(toolUseId ? { toolCallId: toolUseId } : {}),
    };
    if (!previous && toolUseId) this.byToolCall.set(toolUseId, id);
    if (kind === 'monitor' && notice.eventText !== undefined && !ended) {
      const lines = [...(this.monitorLines.get(id) ?? []), notice.eventText].slice(-MONITOR_EVENT_LINES);
      this.monitorLines.set(id, lines);
      return this.put({ ...base, status: 'running', detail: outputPreview(lines.join('\n')) }, at, runId);
    }
    const status: NativeActivity['status'] = expired ? 'completed' : notice.status === 'completed' ? 'completed' : notice.status === 'failed' ? 'failed' : notice.status === 'cancelled' ? 'stopped' : 'unknown';
    const exitCode = exitCodeOf(notice.summary);
    const lines = this.monitorLines.get(id);
    if (expired && notice.eventText) this.monitorLines.set(id, [...(lines ?? []), notice.eventText].slice(-MONITOR_EVENT_LINES));
    const events = this.monitorLines.get(id);
    const detail = events?.length ? outputPreview(events.join('\n'))
      : notice.result ? clipDetail(notice.result)
        : [notice.summary, outputFile ?? this.outputs.get(id) ? `Output file: ${outputFile ?? this.outputs.get(id)}` : undefined].filter(Boolean).join('\n');
    return this.put({
      ...base, status, endedAt: at,
      ...(detail ? { detail } : {}),
      ...(notice.durationMs !== undefined ? { durationMs: notice.durationMs } : {}),
      task: { ...base.task!, ...(exitCode !== undefined ? { exitCode } : {}) },
    }, at, runId);
  }

  /** A report entered the CLI's queue (`queue-operation`, `enqueue`). */
  enqueued(text: string, at: string, runId: string | undefined, calls?: OpenCalls): MappedEvent[] {
    const notice = taskNotification(text), key = noticeKey(text);
    if (!notice || !key) return [];
    this.queued.set(key, (this.queued.get(key) ?? 0) + 1);
    return this.notified(notice, at, runId, calls);
  }

  /** The CLI took a queued report into the running turn, without a row of its own. */
  dequeuedWithoutRow(text: string): void { this.claimed(text); }

  /** Whether the report carried by a row was already heard of in the queue; counts it off if so. */
  claimed(text: string): boolean {
    const key = noticeKey(text);
    const count = key ? this.queued.get(key) : undefined;
    if (!key || !count) return false;
    if (count > 1) this.queued.set(key, count - 1); else this.queued.delete(key);
    return true;
  }

  /**
   * `agents_killed`: the CLI stopped every background agent at once. It names none of them, and it
   * does not touch shells or monitors, which are stopped one at a time.
   */
  agentsKilled(at: string, runId: string | undefined): MappedEvent[] {
    return this.states.live().filter(activity => activity.task?.kind === 'agent')
      .flatMap(activity => { this.markOver(activity.id.slice('claude:'.length)); return this.put({ ...activity, status: 'stopped', endedAt: at }, at, runId); });
  }

  // ---- compaction ----

  /** The bare `/compact` row: the command was submitted and the context is being compacted. */
  compactionStarted(uuid: string, promptId: string | undefined, at: string, runId: string | undefined): MappedEvent[] {
    this.bareCommand = { name: 'compact', ...(promptId ? { promptId } : {}) };
    this.promptRead(promptId);
    // Its PreCompact hook may have been heard first: the row names that compaction, not another one.
    if (this.compaction) return [];
    const id = activityId('claude', `compaction:${promptId ?? uuid}`);
    this.compaction = { id };
    return this.put({ id, kind: 'compaction', status: 'running', title: COMPACTION_TITLE, startedAt: at, compaction: { trigger: 'manual' } }, at, runId);
  }

  /**
   * The CLI's PreCompact hook, heard beside the rows: a compaction runs under `id` until its boundary. Since 2.1.322 a
   * `/compact` writes no row before that boundary, so this is the only sign of one in progress.
   *
   * `promptId` is the prompt the CLI is answering. An automatic compaction on a prompt just submitted can be heard
   * before that prompt's row is on disk; it is held until the row is read. A `/compact` is not held: its row only
   * comes at the boundary.
   */
  compactionHooked(id: string, trigger: 'manual' | 'auto', at: string, runId: string | undefined, promptId?: string): MappedEvent[] {
    if (this.compaction || this.heldCompaction) return [];
    if (trigger === 'auto' && promptId && this.prompt && promptId !== this.prompt) {
      this.heldCompaction = { id, promptId, at };
      return [];
    }
    return this.openCompaction(id, trigger, at, runId);
  }

  private openCompaction(id: string, trigger: 'manual' | 'auto', at: string, runId: string | undefined): MappedEvent[] {
    this.compaction = { id };
    return this.put({ id, kind: 'compaction', status: 'running', title: COMPACTION_TITLE, startedAt: at, compaction: { trigger } }, at, runId);
  }

  /** A prompt row was read: the compaction held for it opens in its turn; one held for another prompt will not. */
  private promptRead(promptId: string | undefined): HeldCompaction | undefined {
    if (promptId) this.prompt = promptId;
    const held = this.heldCompaction;
    this.heldCompaction = undefined;
    return held && held.promptId === promptId ? held : undefined;
  }

  /** `system/compact_boundary`: the compaction is over (manual, or one the CLI started by itself). */
  compactionBoundary(uuid: string, metadata: Record<string, unknown> | undefined, at: string, runId: string | undefined): MappedEvent[] {
    const durationMs = number(metadata?.durationMs);
    const hooked = this.compaction ? this.states.get(this.compaction.id)?.compaction?.trigger : undefined;
    const trigger = metadata?.trigger === 'auto' ? 'auto' : hooked ?? (this.compaction ? 'manual' : metadata?.trigger === 'manual' ? 'manual' : 'auto');
    const id = this.compaction?.id ?? this.heldCompaction?.id ?? activityId('claude', `compaction:${uuid}`);
    this.compaction = undefined;
    this.heldCompaction = undefined;
    this.awaitingSummary = id;
    const preTokens = number(metadata?.preTokens), postTokens = number(metadata?.postTokens);
    const started = Date.parse(at);
    return this.put({
      id, kind: 'compaction', status: 'completed', title: COMPACTION_TITLE, endedAt: at,
      ...(durationMs !== undefined && Number.isFinite(started) ? { startedAt: new Date(started - durationMs).toISOString() } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      compaction: { trigger, ...(preTokens !== undefined ? { preTokens } : {}), ...(postTokens !== undefined ? { postTokens } : {}) },
    }, at, runId);
  }

  /** The summary the compaction left in the conversation: preview in the activity, the whole text as a blob. */
  compactionSummary(uuid: string, text: string, at: string, runId: string | undefined): MappedEvent[] {
    const id = this.awaitingSummary ?? activityId('claude', `compaction:${uuid}`);
    this.awaitingSummary = undefined;
    const blobRef = text.trim() ? this.hooks.putBlob?.(text.slice(0, ACTIVITY_BLOB_LIMIT)) : undefined;
    const known = this.states.get(id);
    return this.put({
      ...(known ?? { id, kind: 'compaction', status: 'completed', title: COMPACTION_TITLE, startedAt: at, endedAt: at, compaction: { trigger: 'auto' } } as NativeActivity),
      detail: clipDetail(text), ...(blobRef ? { blobRef } : {}),
    }, at, runId);
  }

  /** Something interrupted the CLI: a compaction that was running will not finish. */
  interrupted(at: string, runId: string | undefined): MappedEvent[] {
    const open = this.compaction;
    if (!open) return [];
    this.compaction = undefined;
    const known = this.states.get(open.id);
    return known ? this.put({ ...known, status: 'stopped', endedAt: at }, at, runId) : [];
  }

  /**
   * A person typed another prompt: a compaction that never reported its end is lost. One held for this very
   * prompt starts now, in its turn.
   */
  promptSubmitted(promptId: string | undefined, at: string, runId: string | undefined): MappedEvent[] {
    const events: MappedEvent[] = [];
    const open = this.compaction;
    this.compaction = undefined;
    const known = open && this.states.get(open.id);
    if (known) events.push(...this.put({ ...known, status: 'unknown', endedAt: at }, at, runId));
    const held = this.promptRead(promptId);
    if (held) events.push(...this.openCompaction(held.id, 'auto', held.at, runId));
    return events;
  }

  // ---- local commands ----

  /**
   * A `<command-name>` row. True when it only repeats a command the bare row already showed (`/compact`),
   * so it must not become a second bubble; the name still labels the output that follows.
   */
  commandRow(name: string, promptId: string | undefined): boolean {
    // The two rows do not always share a prompt id (the CLI gave them different ones in 2.1.302), so the name and the order decide.
    const repeated = this.bareCommand !== undefined && this.bareCommand.name === name;
    this.lastCommand = { name, ...(promptId ? { promptId } : {}) };
    if (repeated) this.bareCommand = undefined;
    return repeated;
  }

  /** Output a local command printed. `Compacted…` belongs to the compaction and adds no row of its own. */
  localOutput(output: { stream: 'stdout' | 'stderr'; text: string }, uuid: string, promptId: string | undefined, at: string, runId: string | undefined): MappedEvent[] {
    const plain = clipDetail(output.text, ACTIVITY_BLOB_LIMIT);
    const command = this.lastCommand;
    this.lastCommand = undefined;
    if (!plain) return [];
    // `/compact` that printed something other than "Compacted…" before any boundary did not compact.
    if (this.compaction && !/^Compacted\b/.test(plain)) {
      const open = this.compaction;
      this.compaction = undefined;
      const known = this.states.get(open.id);
      if (known) return this.put({ ...known, status: 'failed', endedAt: at, detail: clipDetail(plain) }, at, runId);
    }
    if (command?.name === 'compact' || /^Compacted\b/.test(plain)) return [];
    const blobRef = plain.length > ACTIVITY_DETAIL_LIMIT ? this.hooks.putBlob?.(plain) : undefined;
    return this.put({
      id: activityId('claude', `local:${uuid}`), kind: 'local_command', status: output.stream === 'stderr' ? 'failed' : 'completed',
      title: command ? `/${command.name}` : activityTitle(plain, '本地命令'), detail: clipDetail(plain),
      ...(blobRef ? { blobRef } : {}), startedAt: at, endedAt: at, durationMs: 0,
      ...(command ? { command: { name: command.name } } : {}),
    }, at, runId);
  }

  // ---- `!` shell commands ----

  /**
   * A shell command the reader ran with `!`. It is not something they said to the model and not a turn of
   * its own, so it becomes one `local_command` that carries the command (`task`) and later its output.
   */
  shellInput(command: string, uuid: string, at: string, runId: string | undefined): MappedEvent[] {
    const settled = this.shellLost(at, runId);
    const id = activityId('claude', `shell:${uuid}`);
    this.shell = id;
    return [...settled, ...this.put({
      id, kind: 'local_command', status: 'running', title: activityTitle(command, command),
      task: { kind: 'shell', command: command.slice(0, ACTIVITY_DETAIL_LIMIT) }, startedAt: at,
    }, at, runId)];
  }

  /**
   * What the open `!` command printed. With no exit code recorded, stderr is not failure (xcodebuild,
   * git and npm all write progress there), so the command only ever completes. Its preview is the
   * output's tail, where a build or a test run states its result.
   */
  shellOutput(output: string, uuid: string, at: string, runId: string | undefined): MappedEvent[] {
    const known = this.shell ? this.states.get(this.shell) : undefined;
    this.shell = undefined;
    const plain = clipDetail(output, ACTIVITY_BLOB_LIMIT);
    const blobRef = plain.length > ACTIVITY_DETAIL_LIMIT ? this.hooks.putBlob?.(plain) : undefined;
    const printed = { ...(plain ? { detail: outputPreview(plain) } : {}), ...(blobRef ? { blobRef } : {}) };
    if (known) {
      const span = known.startedAt ? Date.parse(at) - Date.parse(known.startedAt) : Number.NaN;
      return this.put({ ...known, status: 'completed', endedAt: at, ...(Number.isFinite(span) && span >= 0 ? { durationMs: span } : {}), ...printed }, at, runId);
    }
    // Its command was read before this mapping began: the output stands alone, as any local command's does.
    if (!plain) return [];
    return this.put({
      id: activityId('claude', `shell:${uuid}`), kind: 'local_command', status: 'completed', title: activityTitle(plain, '本地命令'),
      startedAt: at, endedAt: at, durationMs: 0, ...printed,
    }, at, runId);
  }

  /** A prompt or another `!` command came first: the open command's end was never written. Its output may still follow. */
  shellLost(at: string, runId: string | undefined): MappedEvent[] {
    const known = this.shell ? this.states.get(this.shell) : undefined;
    if (!known || !isLiveActivity(known)) return [];
    return this.put({ ...known, status: 'unknown', endedAt: at }, at, runId);
  }
}

/** Whether a state is one a person could still stop. */
export const stoppable = (activity: NativeActivity): boolean => activity.kind === 'background_task' && activity.stop !== undefined && isLiveActivity(activity);
