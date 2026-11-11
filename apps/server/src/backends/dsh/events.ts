import type { NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';
import { toolImageContent } from '../shared/tool-images.js';

const SUBAGENT_PROMPT_LIMIT = 8 * 1024;
/**
 * DSH keeps the `subagent` tool's structured value out of durable records, so a continuable child
 * is known only from the rendered result text; DSH's own UI matches the same line.
 */
const SUBAGENT_STARTED = /^started subagent ([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;

/** The child session a `subagent` tool result started, if it started a continuable child. */
export function dshSubagentChildId(content: string): string | undefined {
  return SUBAGENT_STARTED.exec(content.trim())?.[1];
}

/** The `subagent` call and the child session a committed `tool/result` record names, if it started one. */
export function dshSubagentLink(eventValue: unknown): { toolCallId: string; childId: string } | undefined {
  const event = record(eventValue);
  if (event?.type !== 'tool/result') return undefined;
  const data = record(event.data);
  const message = record(data?.message);
  const toolCallId = text(message?.toolCallId);
  if (!data || !message || !toolCallId || message.isError === true || record(data.error) !== undefined) return undefined;
  const childId = dshSubagentChildId(visibleText(messageBlocks(message)));
  return childId ? { toolCallId, childId } : undefined;
}

export interface DshEventProjectionOptions {
  /** Preserve full payloads for a frozen export. */
  unbounded?: boolean;
  sessionId: string;
  runId?: string;
  commandId?: string;
  attachments?: Array<{ id: string; name: string; mimeType: string; width?: number; height?: number }>;
  failureMessage?: string;
}

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Whether DSH numbered the record (`seq`); one it did not is not part of the conversation yet. */
function numbered(event: RecordValue): boolean {
  const seq = event.seq;
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0;
}

function timeOf(event: RecordValue): string {
  const time = event.time;
  return typeof time === 'number' && Number.isFinite(time)
    ? new Date(time).toISOString()
    : new Date().toISOString();
}

function stableMessageId(data: RecordValue, type: string): string {
  const message = record(data.message);
  const source = record(data.source);
  return text(message?.id) ?? text(source?.rpcId) ?? type;
}

function makeEvent(
  event: RecordValue,
  options: DshEventProjectionOptions,
  type: string,
  data: RecordValue,
  part: number,
  identity?: string,
  rawOverride?: unknown,
): NativeWorkbenchEvent | undefined {
  if (!numbered(event) || part < 0) return undefined;
  // The record's own number and the event's part of it: a replay reproduces it; the log numbers the event.
  const nativeId = `${String(event.seq)}:${identity ?? text(event.type) ?? 'event'}:${part}`;
  return {
    sequence: 0,
    sessionId: options.sessionId,
    ...(options.runId ? { runId: options.runId } : {}),
    type,
    data: { sessionUpdate: type, ...data },
    raw: rawOverride ?? event,
    createdAt: timeOf(event),
    nativeId,
    ...(options.commandId ? { nativeAliases: [options.commandId] } : {}),
  };
}

function messageBlocks(message: unknown): unknown[] {
  const content = record(message)?.content;
  return Array.isArray(content) ? content : [];
}

function visibleText(blocks: readonly unknown[]): string {
  return blocks.flatMap(blockValue => {
    const block = record(blockValue);
    return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
  }).join('');
}

function attachmentDisplay(options: DshEventProjectionOptions, message: unknown): Array<{ id?: string; name: string; mimeType?: string; width?: number; height?: number }> {
  if (options.attachments?.length) return options.attachments;
  return messageBlocks(message).flatMap((blockValue) => {
    const block = record(blockValue);
    const attachment = record(block?.attachment);
    if (block?.type !== 'image' && block?.type !== 'file') return [];
    const name = text(attachment?.name) ?? 'attachment';
    const id = text(attachment?.attachmentId);
    const mimeType = text(attachment?.mediaType);
    const width = typeof attachment?.width === 'number' ? attachment.width : undefined;
    const height = typeof attachment?.height === 'number' ? attachment.height : undefined;
    return [{ ...(id ? { id } : {}), name, ...(mimeType ? { mimeType } : {}), ...(width ? { width } : {}), ...(height ? { height } : {}) }];
  });
}

function projectUserMessage(event: RecordValue, data: RecordValue, options: DshEventProjectionOptions): NativeWorkbenchEvent[] {
  const message = data;
  if (record(message.source)?.kind !== 'user') return [];
  const body = visibleText(messageBlocks(message));
  const attachments = attachmentDisplay(options, message);
  const commandId = options.commandId ?? text(record(message.source)?.rpcId);
  const projected = makeEvent(event, { ...options, ...(commandId ? { commandId } : {}) }, 'user_message_chunk', {
    content: { type: 'text', text: body },
    ...(commandId ? { commandId } : {}),
    ...(attachments.length ? { attachments } : {}),
  }, 0, stableMessageId({ message }, 'user'));
  return projected ? [projected] : [];
}

function projectAssistantMessage(event: RecordValue, data: RecordValue, options: DshEventProjectionOptions): NativeWorkbenchEvent[] {
  const message = data.message;
  const messageId = stableMessageId(data, 'assistant');
  const result: NativeWorkbenchEvent[] = [];
  let part = 0;
  for (const blockValue of messageBlocks(message)) {
    const block = record(blockValue);
    if (!block) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      const projected = makeEvent(event, options, 'agent_message_chunk', { content: { type: 'text', text: block.text } }, part++, messageId);
      if (projected) result.push(projected);
    } else if (block.type === 'reasoning' && typeof block.text === 'string') {
      // DeepSeek's reasoning is the model's raw chain of thought; DSH has no narration summary.
      const projected = makeEvent(event, options, 'agent_thought_chunk', { content: { type: 'text', text: block.text }, channel: 'thinking' }, part++, messageId);
      if (projected) result.push(projected);
    }
  }
  return result;
}

function projectToolCall(event: RecordValue, data: RecordValue, options: DshEventProjectionOptions): NativeWorkbenchEvent[] {
  const callId = text(data.callId);
  const toolName = text(data.name);
  if (!callId || !toolName) return [];
  const parsed = (() => {
    try { return JSON.parse(text(data.arguments) ?? '') as unknown } catch { return text(data.arguments) ?? '' }
  })();
  // `subagent_fork` starts a child the same way `subagent` does — same prompt/model/background
  // arguments, same "started subagent <id>" result — so it gets the same card.
  if (toolName === 'subagent' || toolName === 'subagent_fork') {
    const input = record(parsed) ?? {};
    const description = text(input.description);
    const prompt = text(input.prompt) ?? '';
    const projected = makeEvent(event, options, 'tool_call', {
      toolCallId: callId,
      toolName,
      kind: 'agent',
      title: description ?? 'Subagent',
      status: 'in_progress',
      rawInput: parsed,
      subagent: {
        ...(description ? { description } : {}),
        prompt: !options.unbounded && prompt.length > SUBAGENT_PROMPT_LIMIT ? `${prompt.slice(0, SUBAGENT_PROMPT_LIMIT)}…` : prompt,
        ...(text(input.model) ? { model: text(input.model) } : {}),
        background: input.run_in_background === true,
      },
    }, 0, callId);
    return projected ? [projected] : [];
  }
  const described = describeDshToolCall(toolName, record(parsed), options.unbounded);
  const projected = makeEvent(event, options, 'tool_call', {
    toolCallId: callId,
    toolName,
    status: 'in_progress',
    rawInput: parsed,
    ...described,
  }, 0, callId);
  return projected ? [projected] : [];
}

/** The path a file-bearing tool was pointed at. DSH names it `path`; the aliases cost one lookup. */
const PATH_KEYS = ['path', 'file_path', 'target_file', 'notebook_path'] as const;
/** Diffs are shown inline, so a pathological edit is clipped rather than shipped whole. */
const EDIT_LIMIT = 256 * 1024;

function dshToolPath(input: RecordValue | undefined): string | undefined {
  if (!input) return undefined;
  for (const key of PATH_KEYS) {
    const value = text(input[key]);
    if (value) return value;
  }
  return undefined;
}

function baseName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/**
 * The goal state a `create_goal` / `update_goal` / `get_goal` call reports.
 *
 * DSH keeps the goal on the harness side; the call arguments are the only place a client can read it
 * from. `objective` is present on `create` and on an `edit`, and absent on `pause` / `resume` /
 * `complete` — the reader still wants the objective then, which is why the dock carries the last one
 * it saw forward instead of showing a bare verb.
 */
const GOAL_ACTIONS: Record<string, string> = {
  edit: '已更新', pause: '已暂停', resume: '继续中', complete: '已完成', blocked: '受阻',
};

function goalActionLabel(action: string | undefined): string {
  return (action && GOAL_ACTIONS[action]) || '目标';
}

/**
 * Tools whose row label is a fixed phrase instead of one derived from the arguments.
 *
 * Looked up before the generic patterns below, which are substring matches and would otherwise
 * mislabel the agent-loop tools: `todo_write` contains "write" (it became "Write"), `job_list` and
 * `list_agents` contain "list" (they became "glob"), and `web_search` contains "search" (it became
 * "grep " with the query argument it does not have).
 */
const DSH_TOOL_LABELS: Record<string, { kind: string; title: string }> = {
  job_list: { kind: 'execute', title: '后台任务列表' },
  job_output: { kind: 'execute', title: '读取后台任务输出' },
  job_kill: { kind: 'execute', title: '停止后台任务' },
  todo_write: { kind: 'other', title: '更新任务清单' },
  skill: { kind: 'other', title: '加载技能' },
  workflow: { kind: 'other', title: '工作流' },
  present: { kind: 'other', title: '交付文件' },
  exit_plan_mode: { kind: 'other', title: '退出计划模式' },
  load_workspace_dependencies: { kind: 'other', title: '加载工作区依赖' },
  ask_user_question: { kind: 'question', title: '向你确认' },
  subagent: { kind: 'agent', title: '子代理' },
  subagent_fork: { kind: 'agent', title: '子代理（继承上下文）' },
  // These move an existing child along; they do not create one, so they must not read as another
  // subagent row (or open a child transcript page).
  send_message: { kind: 'other', title: '给子代理发消息' },
  interrupt_agent: { kind: 'other', title: '中断子代理' },
  list_agents: { kind: 'other', title: '子代理列表' },
  web_search: { kind: 'search', title: '网页搜索' },
};

/**
 * What a DSH tool call should read as.
 *
 * The generic mapping here used to be `title: toolName`, which is how a `read` or an `edit` row
 * ended up with no file name at all: the arguments were carried in `rawInput` but never read. The
 * Cursor path (`plugins/riffet/cursor/native/chat-store.ts:describeToolCall`) has always derived a path, a title and an
 * inline diff from those arguments, so the two backends disagreed about the same shape of call.
 */
function describeDshToolCall(toolName: string, input: RecordValue | undefined, unbounded = false): RecordValue {
  const name = toolName.toLowerCase();
  const path = dshToolPath(input);
  const location = path ? [{ path, ...(typeof input?.offset === 'number' && input.offset > 0 ? { line: input.offset } : {}) }] : [];
  const diff = (oldText: unknown, newText: unknown) => (typeof oldText === 'string' || typeof newText === 'string')
    ? [{ type: 'diff', path, oldText: clip(str(oldText), unbounded ? Infinity : EDIT_LIMIT), newText: clip(str(newText), unbounded ? Infinity : EDIT_LIMIT) }]
    : undefined;

  const fixed = DSH_TOOL_LABELS[name];
  if (fixed) {
    if (name === 'web_search') {
      const queries = Array.isArray(input?.queries)
        ? (input!.queries as unknown[]).flatMap(query => text(query) ?? []).join(' · ')
        : text(input?.query);
      return { ...fixed, ...(queries ? { title: `${fixed.title} ${queries}` } : {}) };
    }
    // `skill` and `workflow` both name their subject; a bare verb would hide which one ran.
    if (name === 'skill' || name === 'workflow') {
      const label = text(input?.name) ?? text(input?.skill);
      return { ...fixed, ...(label ? { title: `${fixed.title} ${label}` } : {}) };
    }
    // The header of the first question is the only part short enough to sit on one row.
    if (name === 'ask_user_question') {
      const first = Array.isArray(input?.questions) ? record((input!.questions as unknown[])[0]) : undefined;
      const header = text(first?.header) ?? text(first?.question);
      return { ...fixed, ...(header ? { title: `${fixed.title} · ${header}` } : {}) };
    }
    return { ...fixed };
  }
  if (/goal/.test(name)) {
    const objective = text(input?.objective);
    const action = text(input?.action);
    return { kind: 'goal', title: objective ?? goalActionLabel(action) };
  }
  if (/bash|shell|pwsh|terminal/.test(name)) return { kind: 'execute', title: toolName };
  if (/read_image/.test(name)) return { kind: 'read', title: `Read image${path ? ` ${baseName(path)}` : ''}`, ...(location.length ? { locations: location } : {}) };
  if (/read/.test(name)) return { kind: 'read', title: `Read${path ? ` ${baseName(path)}` : ''}`, ...(location.length ? { locations: location } : {}) };
  if (/write/.test(name)) {
    const contents = input?.contents ?? input?.content;
    const content = diff('', contents);
    return { kind: 'edit', title: `Write${path ? ` ${baseName(path)}` : ''}`, ...(location.length ? { locations: location } : {}), ...(content ? { content } : {}) };
  }
  if (/edit|str_replace|apply.?patch/.test(name)) {
    const content = diff(input?.old_string ?? input?.oldText, input?.new_string ?? input?.newText);
    return { kind: 'edit', title: `Edit${path ? ` ${baseName(path)}` : ''}`, ...(location.length ? { locations: location } : {}), ...(content ? { content } : {}) };
  }
  if (/grep|search/.test(name)) {
    return { kind: 'search', title: `grep ${str(input?.pattern) ?? str(input?.query) ?? ''}`.trim(), ...(location.length ? { locations: location } : {}) };
  }
  if (/glob|list|ls\b/.test(name)) {
    return { kind: 'search', title: `glob ${str(input?.glob_pattern) ?? str(input?.pattern) ?? ''}`.trim(), ...(location.length ? { locations: location } : {}) };
  }
  if (/fetch|http/.test(name)) {
    const url = str(input?.url) ?? str(input?.uri);
    return { kind: 'fetch', title: url ? `抓取 ${url}` : toolName };
  }
  return { kind: 'other', title: toolName };
}

/** `String(x)` for the text-ish JSON values a tool argument can hold. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Clip a long string with an ellipsis, so one enormous edit cannot dominate an event. */
function clip(value: string | undefined, limit: number): string {
  const text = value ?? '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Image blocks of a tool result. DSH stores them as durable attachment references, not bytes: the
 * bridge resolves each reference to its readable object (`hostPath`), and `read_image` additionally
 * names the file it read in a `<path>` envelope beside the image. The reference also carries what the
 * image is — name, byte count, pixel size — which is all a row can report when neither source exists.
 */
function toolImages(blocks: readonly unknown[], content: string): Record<string, unknown>[] {
  const images = blocks.map(record).filter((block): block is RecordValue => block?.type === 'image');
  const envelope = /<path>([^<\r\n]+)<\/path>/.exec(content)?.[1]?.trim();
  return images.slice(0, 4).map((block, index) => {
    const attachment = record(block.attachment);
    const mimeType = text(attachment?.mediaType) ?? text(block.mediaType) ?? text(block.mimeType);
    const data = text(block.data);
    const name = text(attachment?.name)?.trim();
    const bytes = typeof attachment?.bytes === 'number' ? attachment.bytes : undefined;
    const width = typeof attachment?.width === 'number' ? attachment.width : undefined;
    const height = typeof attachment?.height === 'number' ? attachment.height : undefined;
    // Every block names its own stored object; only the envelope is shared by the whole result.
    const path = text(block.hostPath)?.trim() || (index === 0 ? envelope : undefined);
    return toolImageContent({
      ...(path ? { path } : {}),
      ...(data ? { data } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(name ? { name } : {}),
      ...(bytes !== undefined ? { bytes } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    });
  });
}

/**
 * The applied hunks DSH's `edit` / `write` attach to their result as `meta.diffs`, or `undefined`
 * when the result is not a file-changing one. An empty array means the change produced no hunk.
 */
function resultDiffs(meta: unknown, unbounded = false): RecordValue[] | undefined {
  const diffs = record(meta)?.diffs;
  if (!Array.isArray(diffs)) return undefined;
  return diffs.flatMap((value) => {
    const diff = record(value);
    const path = text(diff?.path);
    const newText = text(diff?.newText);
    if (!path || newText === undefined) return [];
    return [{ type: 'diff', path, oldText: clip(text(diff?.oldText), unbounded ? Infinity : EDIT_LIMIT), newText: clip(newText, unbounded ? Infinity : EDIT_LIMIT) }];
  });
}

function projectToolResult(event: RecordValue, data: RecordValue, options: DshEventProjectionOptions): NativeWorkbenchEvent[] {
  const message = record(data.message);
  const callId = text(message?.toolCallId);
  if (!message || !callId) return [];
  const content = visibleText(messageBlocks(message));
  const failed = message.isError === true || record(data.error) !== undefined;
  const childId = dshSubagentLink(event)?.childId;
  const images = failed ? [] : toolImages(messageBlocks(message), content);
  // An update's `content` replaces the call's, so a file change's "has been updated successfully"
  // would erase the diff the call carried: send the applied hunks, or nothing when there are none.
  const diffs = failed ? undefined : resultDiffs(data.meta, options.unbounded);
  const items = diffs ?? [...(content ? [{ type: 'content', content: { type: 'text', text: content } }] : []), ...images];
  const projected = makeEvent(event, options, 'tool_call_update', {
    toolCallId: callId,
    status: failed ? 'failed' : 'completed',
    ...(items.length ? { content: items } : {}),
    ...(childId ? { subagentResult: { agentId: childId, background: true } } : {}),
    ...(record(data.error) ? { error: record(data.error) } : {}),
  }, 0, callId);
  return projected ? [projected] : [];
}

/** DSH persists successful todo_write calls as whole-list `todo/write` session snapshots. */
function projectTodoWrite(event: RecordValue, data: RecordValue, options: DshEventProjectionOptions): NativeWorkbenchEvent[] {
  if (!Array.isArray(data.todos)) return [];
  const entries = data.todos.flatMap((value) => {
    const todo = record(value);
    const content = text(todo?.content);
    const status = text(todo?.status);
    if (content === undefined || (status !== 'pending' && status !== 'in_progress' && status !== 'completed')) return [];
    return [{ content, status }];
  });
  // A source snapshot is atomic. Ignore an unexpected shape rather than turning a parse failure
  // into a false empty list that would clear a previously valid plan.
  if (entries.length !== data.todos.length) return [];
  const projected = makeEvent(event, options, 'plan', { entries }, 0, 'todo/write');
  return projected ? [projected] : [];
}

function projectTurnEnd(event: RecordValue, data: RecordValue, options: DshEventProjectionOptions): NativeWorkbenchEvent[] {
  const reason = record(data.reason);
  const kind = text(reason?.kind);
  const command = options.commandId ? { commandId: options.commandId } : {};
  let type: 'run_failed' | 'run_cancelled' | 'run_completed' | undefined;
  let outcome: RecordValue | undefined;
  if (kind === 'completed' || kind === 'max-tokens') {
    type = 'run_completed';
    outcome = { ...command, reason: kind };
  } else if (kind === 'error') {
    type = 'run_failed';
    outcome = { ...command, error: options.failureMessage ?? 'DeepSeek Harness turn failed.' };
  } else if (kind === 'blocked') {
    type = 'run_failed';
    outcome = { ...command, error: 'DeepSeek Harness blocked this turn before completion.' };
  } else if (kind === 'aborted' || kind === 'interrupted') {
    type = 'run_cancelled';
    outcome = { ...command, reason: kind === 'interrupted' ? 'DeepSeek Harness interrupted this turn.' : 'DeepSeek Harness aborted this turn.' };
  }
  if (!type || !outcome) return [];
  const safeRaw = { type: 'turn/end', ...(event.seq !== undefined ? { seq: event.seq } : {}), ...(event.time !== undefined ? { time: event.time } : {}), reason: { kind } };
  const projected = makeEvent(event, options, type, outcome, 0, `turn:${String(data.turn ?? '')}`, safeRaw);
  return projected ? [projected] : [];
}

/** Project committed DSH session records into the workbench transcript event vocabulary. */
export function projectDshEvent(eventValue: unknown, options: DshEventProjectionOptions): NativeWorkbenchEvent[] {
  const event = record(eventValue);
  if (!event) return [];
  const data = record(event.data);
  if (!data) return [];
  switch (event.type) {
    case 'user/message':
      return projectUserMessage(event, data, options);
    case 'assistant/message':
      return projectAssistantMessage(event, data, options);
    case 'tool/call':
      return projectToolCall(event, data, options);
    case 'tool/result':
      return projectToolResult(event, data, options);
    case 'todo/write':
      return projectTodoWrite(event, data, options);
    case 'turn/end':
      return projectTurnEnd(event, data, options);
    default:
      return [];
  }
}
