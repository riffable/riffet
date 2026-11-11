import type { NativeActivity, NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';
import { activityId, activityTitle, clipDetail } from '../../journal/activity.js';
import { toolImageContent } from '../shared/tool-images.js';

/** Diffs are shown inline, so a pathological edit is clipped rather than shipped whole. */
const EDIT_LIMIT = 256 * 1024;
/** A tool's output is a preview; the agent keeps the whole text. */
const RESULT_LIMIT = 48 * 1024;
const SUBAGENT_PROMPT_LIMIT = 8 * 1024;

type RecordValue = Record<string, unknown>;

/** One Droid message, from either a `create_message` notification or a JSONL `message` record. */
export interface DroidMessage {
  id: string;
  parentId?: string;
  seq?: number;
  role: string;
  content: unknown[];
  visibility?: string;
  createdAt: string;
}

export interface DroidAttachmentInfo { id: string; name: string; mimeType: string; width?: number; height?: number }

export interface DroidProjectionOptions {
  /** Preserve full payloads for a frozen export. */
  unbounded?: boolean;
  sessionId: string;
  runId?: string;
  commandId?: string;
  attachments?: DroidAttachmentInfo[];
}

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function seqOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isoTime(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return new Date().toISOString();
}

function clip(value: string | undefined, limit: number): string {
  const body = value ?? '';
  return body.length > limit ? `${body.slice(0, limit)}…` : body;
}

/** The `message` of a `create_message` notification. */
export function messageFromProtocol(value: unknown): DroidMessage | undefined {
  const message = record(value);
  const id = text(message?.id);
  const role = text(message?.role);
  if (!message || !id || !role) return undefined;
  const seq = seqOf(message.seq);
  return {
    id,
    role,
    content: Array.isArray(message.content) ? message.content : [],
    createdAt: isoTime(message.createdAt),
    ...(text(message.parentId) ? { parentId: text(message.parentId) } : {}),
    ...(seq !== undefined ? { seq } : {}),
    ...(text(message.visibility) ? { visibility: text(message.visibility) } : {}),
  };
}

/** A `{"type":"message"}` line of a session's JSONL file. */
export function messageFromJsonl(value: unknown): DroidMessage | undefined {
  const line = record(value);
  if (line?.type !== 'message') return undefined;
  const message = record(line.message);
  const id = text(line.id);
  const role = text(message?.role);
  if (!message || !id || !role) return undefined;
  const seq = seqOf(line.seq);
  return {
    id,
    role,
    content: Array.isArray(message.content) ? message.content : [],
    createdAt: isoTime(line.timestamp),
    ...(text(line.parentId) ? { parentId: text(line.parentId) } : {}),
    ...(seq !== undefined ? { seq } : {}),
    ...(text(message.visibility) ? { visibility: text(message.visibility) } : {}),
  };
}

/**
 * Messages only the model sees: the per-turn context message (`context-<turn>`, the system
 * reminders) and the "request cancelled" notes an interrupt leaves behind.
 */
export function isHiddenMessage(message: DroidMessage): boolean {
  return message.id.startsWith('context-') || message.visibility === 'llm_only' || message.role === 'system';
}

/** A message that starts a turn (its id is Droid's turn id): asked by someone, not a tool result, notice or hidden context. */
export function isDroidPrompt(message: DroidMessage): boolean {
  return message.role === 'user' && !isHiddenMessage(message) && message.visibility !== 'user_only'
    && !message.content.some(block => record(block)?.type === 'tool_result');
}

/** Native notices are user-visible, but are not prompts and must not start another workbench turn. */
export function droidProviderNotice(message: DroidMessage): string | undefined {
  if (message.role !== 'user' || message.visibility !== 'user_only') return undefined;
  const body = message.content.flatMap(value => {
    const block = record(value);
    return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
  }).join('\n').trim();
  return body ? clip(body, RESULT_LIMIT) : undefined;
}

/**
 * One event of a message Droid has numbered (`seq`, live and in its JSONL file alike); a message without
 * one is not part of the conversation yet. The event's `nativeId` comes from Droid's own ids, so a replay
 * reproduces it; the log numbers it.
 */
function makeEvent(
  message: Pick<DroidMessage, 'seq' | 'createdAt'>,
  options: DroidProjectionOptions,
  type: string,
  data: RecordValue,
  nativeId: string,
  raw: unknown,
): NativeWorkbenchEvent | undefined {
  if (message.seq === undefined) return undefined;
  return {
    sequence: 0,
    sessionId: options.sessionId,
    ...(options.runId ? { runId: options.runId } : {}),
    type,
    data: { sessionUpdate: type, ...data },
    raw,
    createdAt: message.createdAt,
    nativeId,
    ...(options.commandId ? { nativeAliases: [options.commandId] } : {}),
  };
}

/** Identity of a user message's row; also the run's `nativeMessageId` once dispatch observes it. */
export function droidUserEventId(messageId: string): string {
  return `msg:${messageId}`;
}

/** Identity of one committed assistant block. */
export function droidBlockEventId(messageId: string, blockIndex: number): string {
  return `msg:${messageId}:${blockIndex}`;
}

function toolResultBlocks(message: DroidMessage): RecordValue[] {
  return message.content.flatMap(value => {
    const block = record(value);
    return block?.type === 'tool_result' ? [block] : [];
  });
}

function userAttachments(message: DroidMessage, options: DroidProjectionOptions): Array<{ id?: string; name: string; mimeType?: string }> {
  if (options.attachments?.length) return options.attachments;
  return message.content.flatMap(value => {
    const block = record(value);
    if (block?.type !== 'image') return [];
    const source = record(block.source);
    const mimeType = text(source?.media_type) ?? text(block.mediaType) ?? text(block.mimeType);
    return [{ name: 'image', ...(mimeType ? { mimeType } : {}) }];
  });
}

/**
 * Droid appends what it injects for a `/skill` the user typed — the whole skill body — to the
 * stored user message as trailing `<system-notification>` blocks. Only a block that runs to the
 * end of the message is cut, so a prompt quoting the tag mid-text stays as written.
 */
export function stripDroidSystemNotifications(body: string): string {
  let result = body;
  for (;;) {
    const start = result.lastIndexOf('<system-notification>');
    if (start < 0 || !result.trimEnd().endsWith('</system-notification>')) return result;
    result = result.slice(0, start).trimEnd();
  }
}

function projectUser(message: DroidMessage, options: DroidProjectionOptions): NativeWorkbenchEvent[] {
  const body = stripDroidSystemNotifications(message.content.flatMap(value => {
    const block = record(value);
    return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
  }).join('\n'));
  const attachments = userAttachments(message, options);
  if (!body.trim() && !attachments.length) return [];
  const event = makeEvent(message, options, 'user_message_chunk', {
    content: { type: 'text', text: body },
    ...(options.commandId ? { commandId: options.commandId } : {}),
    ...(attachments.length ? { attachments } : {}),
  }, droidUserEventId(message.id), { id: message.id, role: message.role, seq: message.seq });
  return event ? [event] : [];
}

function resultText(content: unknown, unbounded = false): { body: string; images: RecordValue[] } {
  if (typeof content === 'string') return { body: content, images: [] };
  if (!Array.isArray(content)) return { body: '', images: [] };
  const parts: string[] = [];
  const images: RecordValue[] = [];
  for (const value of content) {
    const block = record(value);
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block?.type === 'image' && (unbounded || images.length < 4)) {
      const source = record(block.source);
      const data = text(source?.data) ?? text(block.data);
      const mimeType = text(source?.media_type) ?? text(block.mediaType) ?? text(block.mimeType);
      images.push(toolImageContent({ ...(data ? { data } : {}), ...(mimeType ? { mimeType } : {}) }, { unbounded }));
    }
  }
  return { body: parts.join('\n'), images };
}

/**
 * Whether a successful result is Droid's file-change receipt (`{"success":true,"file_path":…}`).
 * An update's `content` replaces the call's, and the call already carries the diff.
 */
function isFileChangeReceipt(body: string): boolean {
  if (!body.startsWith('{') || !body.includes('"success"')) return false;
  try {
    const parsed = record(JSON.parse(body));
    return parsed?.success === true && typeof parsed.file_path === 'string';
  } catch {
    return false;
  }
}

/**
 * A `Task` result: `session_id: <child>`, a note addressed to the parent model, then `## Report`.
 * Only the report is the subagent's answer; the child id links the call to its transcript.
 */
export function droidSubagentReport(body: string): { childId: string; report: string } | undefined {
  const match = /^session_id: ([A-Za-z0-9][A-Za-z0-9._-]{0,127})\n/.exec(body);
  if (!match) return undefined;
  const rest = body.slice(match[0].length);
  const heading = rest.indexOf('## Report\n');
  return { childId: match[1]!, report: (heading >= 0 ? rest.slice(heading + '## Report\n'.length) : rest).trim() };
}

/**
 * Whether a `Task` / `Execute` call runs in the background, as the Droid CLI decides it:
 * `run_in_background` wins either way; without it the call is foreground only if `await` is true.
 */
export function droidTaskInBackground(input: RecordValue): boolean {
  if (typeof input.run_in_background === 'boolean') return input.run_in_background;
  return input.await !== true;
}

/**
 * The result of an `Execute` with `fireAndForget`:
 * `Background process started (PID: 79218)\nCommand: …\nOutput: /tmp/droid-bg-1790875565206.out\nStatus: Running in background`.
 * Undefined for any other result, including the error Droid returns for a command it refuses to background.
 */
export function droidFireAndForgetResult(content: unknown, isError: boolean): { pid?: string; outputPath?: string; body: string } | undefined {
  if (isError) return undefined;
  const { body } = resultText(content);
  const pid = /\(PID:\s*(\d+)\)/.exec(body)?.[1];
  const outputPath = /^Output:\s*(\S.*?\.out)\s*$/m.exec(body)?.[1];
  if (!pid && !outputPath) return undefined;
  return { ...(pid ? { pid } : {}), ...(outputPath ? { outputPath } : {}), body };
}

/** A started `fireAndForget` command as a running background task; Droid gives no way to stop it. */
export function droidBackgroundActivity(toolUseId: string, input: { command?: string; summary?: string }, started: { pid?: string; body: string }, startedAt: string): NativeActivity {
  return {
    id: activityId('droid', `bg:${started.pid ?? toolUseId}`), kind: 'background_task', status: 'running',
    title: activityTitle(input.command ?? input.summary ?? '', '后台命令'),
    detail: clipDetail(started.body),
    toolCallId: toolUseId,
    startedAt,
    task: { kind: 'shell', ...(input.command ? { command: input.command } : {}) },
  };
}

/** How long a background command's pid may answer "not permitted" before it is no longer believed to be the command. */
const BACKGROUND_FOREIGN_PID_MS = 6 * 3600_000;

/**
 * Droid never reports the end of a `fireAndForget` command, so its process id is the evidence: once the
 * operating system has no such process, the command is over (its exit code is not known). Undefined while
 * it may still run, and for an activity that is not such a command.
 */
export function droidBackgroundEnd(activity: Pick<NativeActivity, 'id' | 'startedAt'>, now = Date.now()): 'completed' | 'unknown' | undefined {
  const pid = /^droid:bg:(\d+)$/.exec(activity.id)?.[1];
  if (!pid) return undefined;
  try {
    process.kill(Number(pid), 0);
    return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'completed';
    // EPERM: the pid exists but belongs to someone else. Our command ran as this user, so after a long
    // while this is a reused pid rather than the command; stop vouching for it. (A same-user reuse cannot be told apart.)
    return code === 'EPERM' && now - Date.parse(activity.startedAt ?? '') > BACKGROUND_FOREIGN_PID_MS ? 'unknown' : undefined;
  }
}

/** Builds the update for one tool result; shared by committed messages and live `tool_result` frames. */
export function droidToolResultEvent(
  message: Pick<DroidMessage, 'seq' | 'createdAt'>,
  result: { toolUseId: string; content: unknown; isError: boolean },
  options: DroidProjectionOptions,
): NativeWorkbenchEvent | undefined {
  const { body: raw, images } = resultText(result.content, options.unbounded);
  const subagent = result.isError ? undefined : droidSubagentReport(raw);
  const body = subagent ? subagent.report : raw;
  const keepCallContent = !result.isError && isFileChangeReceipt(body);
  const items = keepCallContent ? [] : [
    ...(body ? [{ type: 'content', content: { type: 'text', text: options.unbounded ? body : clip(body, RESULT_LIMIT) } }] : []),
    ...images,
  ];
  return makeEvent(message, options, 'tool_call_update', {
    toolCallId: result.toolUseId,
    status: result.isError ? 'failed' : 'completed',
    ...(items.length ? { content: items } : {}),
    ...(subagent ? { subagentResult: { agentId: subagent.childId } } : {}),
  }, `tool:${result.toolUseId}:result`, { toolUseId: result.toolUseId, isError: result.isError });
}

/** Tool results arrive as `role: "user"` in JSONL and `role: "tool"` over the protocol. */
function projectToolResults(message: DroidMessage, options: DroidProjectionOptions): NativeWorkbenchEvent[] {
  return toolResultBlocks(message).flatMap(block => {
    const toolUseId = text(block.tool_use_id) ?? text(block.toolUseId);
    if (!toolUseId) return [];
    const event = droidToolResultEvent(message, {
      toolUseId,
      content: block.content,
      isError: block.is_error === true || block.isError === true,
    }, options);
    return event ? [event] : [];
  });
}

function projectAssistant(message: DroidMessage, options: DroidProjectionOptions): NativeWorkbenchEvent[] {
  const result: NativeWorkbenchEvent[] = [];
  const raw = { id: message.id, role: message.role, seq: message.seq };
  message.content.forEach((value, blockIndex) => {
    const block = record(value);
    if (!block) return;
    const nativeId = droidBlockEventId(message.id, blockIndex);
    let event: NativeWorkbenchEvent | undefined;
    if (block.type === 'text' && typeof block.text === 'string' && block.text) {
      event = makeEvent(message, options, 'agent_message_chunk', { content: { type: 'text', text: block.text } }, nativeId, raw);
    } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
      event = makeEvent(message, options, 'agent_thought_chunk', { content: { type: 'text', text: block.thinking }, channel: 'thinking' }, nativeId, raw);
    } else if (block.type === 'tool_use') {
      const id = text(block.id);
      const name = text(block.name);
      if (!id || !name) return;
      const input = record(block.input) ?? {};
      event = makeEvent(message, options, 'tool_call', {
        toolCallId: id,
        toolName: name,
        status: 'in_progress',
        rawInput: input,
        ...describeDroidToolCall(name, input, options.unbounded),
      }, `tool:${id}`, raw);
      if (name === 'TodoWrite') {
        const entries = parseDroidTodos(input.todos);
        const plan = entries ? makeEvent(message, options, 'plan', { entries }, `todo:${id}`, raw) : undefined;
        if (event) result.push(event);
        if (plan) result.push(plan);
        return;
      }
    }
    if (event) result.push(event);
  });
  return result;
}

/** Project one committed Droid message into workbench transcript events. */
export function projectDroidMessage(message: DroidMessage, options: DroidProjectionOptions): NativeWorkbenchEvent[] {
  if (isHiddenMessage(message)) return [];
  const notice = droidProviderNotice(message);
  if (notice) {
    const event = makeEvent(message, options, 'task_notification', {
      kind: 'provider', status: 'unknown', title: 'Droid 通知', detail: notice,
    }, `notice:${message.id}`, { id: message.id, role: message.role, visibility: message.visibility, seq: message.seq });
    return event ? [event] : [];
  }
  if (message.role === 'assistant') return projectAssistant(message, options);
  if (message.role === 'tool') return projectToolResults(message, options);
  if (message.role === 'user') {
    return toolResultBlocks(message).length ? projectToolResults(message, options) : projectUser(message, options);
  }
  return [];
}

/** Identity of a turn's outcome row. */
export function droidTurnEndId(turnId: string): string {
  return `turn:${turnId}:end`;
}

/**
 * The run outcome for a finished turn. `turnId` is the id of the user message that started it, both
 * in the live `agent_turn_completed` frame and in the JSONL `agent_turn_outcome` record.
 */
export function projectDroidTurnEnd(
  outcome: { turnId: string; reason: string },
  lastSeq: number | undefined,
  createdAt: string,
  options: DroidProjectionOptions,
): NativeWorkbenchEvent | undefined {
  if (lastSeq === undefined) return undefined;
  const command = options.commandId ? { commandId: options.commandId } : {};
  const { type, data } = outcome.reason === 'completed'
    ? { type: 'run_completed', data: { ...command, reason: 'completed' } }
    : outcome.reason === 'cancelled'
      ? { type: 'run_cancelled', data: { ...command, reason: 'Droid stopped this turn.' } }
      : { type: 'run_failed', data: { ...command, error: droidTurnFailure(outcome.reason) } };
  return makeEvent({ seq: lastSeq, createdAt }, options, type, data, droidTurnEndId(outcome.turnId), { type: 'agent_turn_outcome', turnId: outcome.turnId, reason: outcome.reason });
}

function droidTurnFailure(reason: string): string {
  if (reason === 'permission_rejected') return 'Droid stopped because a tool permission was rejected.';
  if (reason === 'process_exit') return 'Droid exited before the turn finished.';
  if (reason.startsWith('model_')) return `The model ended this turn (${reason}).`;
  return `Droid ended this turn without completing it (${reason}).`;
}

/** `TodoWrite` writes the whole list as text: `1. [in_progress] Read notes.md`. */
export function parseDroidTodos(value: unknown): Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }> | undefined {
  const lines = typeof value === 'string'
    ? value.split('\n').map(line => line.trim()).filter(Boolean)
    : undefined;
  if (Array.isArray(value)) {
    const entries = value.flatMap(item => {
      const todo = record(item);
      const content = text(todo?.content);
      return content ? [{ content, status: todoStatus(text(todo?.status)) }] : [];
    });
    return entries.length === value.length ? entries : undefined;
  }
  if (!lines?.length) return undefined;
  const entries = lines.flatMap(line => {
    const match = /^(?:\d+[.)]\s*)?\[([a-z_ -]+)\]\s*(.+)$/i.exec(line);
    return match ? [{ content: match[2]!.trim(), status: todoStatus(match[1]!.trim().toLowerCase()) }] : [];
  });
  // A snapshot is atomic: an unexpected line would otherwise silently drop an item from the plan.
  return entries.length === lines.length ? entries : undefined;
}

function todoStatus(value: string | undefined): 'pending' | 'in_progress' | 'completed' {
  if (value === 'in_progress' || value === 'in progress') return 'in_progress';
  if (value === 'completed' || value === 'done' || value === 'cancelled') return 'completed';
  return 'pending';
}

/** `AskUser` takes its questions as one `[question] … [topic] … [option] …` document. */
export function parseDroidQuestionnaire(value: unknown): Array<{ question: string; topic?: string; options: string[] }> {
  if (typeof value !== 'string') return [];
  const questions: Array<{ question: string; topic?: string; options: string[] }> = [];
  for (const raw of value.split('\n')) {
    const line = raw.trim();
    const question = /^(?:\d+[.)]\s*)?\[question\]\s*(.*)$/i.exec(line);
    if (question) { questions.push({ question: question[1]!.trim(), options: [] }); continue; }
    const current = questions.at(-1);
    if (!current) continue;
    const topic = /^\[topic\]\s*(.*)$/i.exec(line);
    if (topic) { current.topic = topic[1]!.trim(); continue; }
    const option = /^\[option\]\s*(.*)$/i.exec(line);
    if (option) current.options.push(option[1]!.trim());
  }
  return questions;
}

function baseName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/** Files an `ApplyPatch` envelope touches, from its `*** Add/Update/Delete File:` headers. */
function patchPaths(patch: string | undefined): string[] {
  if (!patch) return [];
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)].map(match => match[1]!.trim()).slice(0, 20);
}

/** What one of Droid's built-in tool calls should read as in the timeline. */
export function describeDroidToolCall(name: string, input: RecordValue, unbounded = false): RecordValue {
  const path = text(input.file_path) ?? text(input.path);
  const locations = path ? [{ path, ...(typeof input.offset === 'number' && input.offset > 0 ? { line: input.offset } : {}) }] : [];
  const located = locations.length ? { locations } : {};
  switch (name) {
    case 'Read':
      return { kind: 'read', title: `Read${path ? ` ${baseName(path)}` : ''}`, ...located };
    case 'LS': {
      const directory = text(input.directory_path) ?? path;
      return { kind: 'search', title: `ls ${directory ?? ''}`.trim(), ...(directory ? { locations: [{ path: directory }] } : {}) };
    }
    case 'Glob': {
      const patterns = Array.isArray(input.patterns) ? input.patterns.flatMap(item => text(item) ?? []).join(' ') : text(input.pattern);
      return { kind: 'search', title: `glob ${patterns ?? ''}`.trim() };
    }
    case 'Grep':
      return { kind: 'search', title: `grep ${text(input.pattern) ?? ''}`.trim(), ...located };
    case 'Create': {
      const content = text(input.content);
      return {
        kind: 'edit', title: `Write${path ? ` ${baseName(path)}` : ''}`, ...located,
        ...(content !== undefined ? { content: [{ type: 'diff', path, oldText: '', newText: clip(content, unbounded ? Infinity : EDIT_LIMIT) }] } : {}),
      };
    }
    case 'Edit':
    case 'MultiEdit': {
      const oldText = text(input.old_str) ?? text(input.old_string);
      const newText = text(input.new_str) ?? text(input.new_string);
      return {
        kind: 'edit', title: `Edit${path ? ` ${baseName(path)}` : ''}`, ...located,
        ...(oldText !== undefined || newText !== undefined ? { content: [{ type: 'diff', path, oldText: clip(oldText, unbounded ? Infinity : EDIT_LIMIT), newText: clip(newText, unbounded ? Infinity : EDIT_LIMIT) }] } : {}),
      };
    }
    case 'ApplyPatch': {
      const paths = patchPaths(text(input.input) ?? text(input.patch));
      return {
        kind: 'edit',
        title: paths.length === 1 ? `Edit ${baseName(paths[0]!)}` : paths.length ? `Edit ${paths.length} files` : 'Apply patch',
        ...(paths.length ? { locations: paths.map(item => ({ path: item })) } : {}),
      };
    }
    case 'Execute':
      return { kind: 'execute', title: text(input.command) ?? text(input.summary) ?? name };
    case 'TodoWrite':
      return { kind: 'other', title: '更新任务清单' };
    case 'AskUser': {
      const first = parseDroidQuestionnaire(input.questionnaire)[0];
      const label = first?.topic ?? first?.question;
      return { kind: 'question', title: label ? `向你确认 · ${label}` : '向你确认' };
    }
    case 'WebSearch': {
      const query = text(input.query);
      return { kind: 'search', title: query ? `网页搜索 ${query}` : '网页搜索' };
    }
    case 'FetchUrl': {
      const url = text(input.url);
      return { kind: 'fetch', title: url ? `抓取 ${url}` : name };
    }
    case 'Task': {
      const description = text(input.description);
      const prompt = text(input.prompt);
      const type = text(input.subagent_type);
      return {
        kind: 'agent',
        title: description ?? (type ? `子代理 ${type}` : '子代理'),
        subagent: {
          ...(description ? { description } : {}),
          ...(prompt ? { prompt: clip(prompt, unbounded ? Infinity : SUBAGENT_PROMPT_LIMIT) } : {}),
          ...(type ? { type } : {}),
          background: droidTaskInBackground(input),
        },
      };
    }
    case 'ExitSpecMode': {
      const title = text(input.title);
      const plan = text(input.plan);
      return {
        kind: 'other',
        title: title ? `规格 · ${title}` : '规格',
        ...(plan ? { content: [{ type: 'content', content: { type: 'text', text: clip(plan, unbounded ? Infinity : RESULT_LIMIT) } }] } : {}),
      };
    }
    default:
      return { kind: 'other', title: name };
  }
}
