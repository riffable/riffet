import { isAbsolute } from 'node:path';
import type { NativeWorkbenchEvent, Session } from '../../../../../packages/contracts/src/index.js';
import { describeCommandActions } from '../../../../../packages/timeline/src/toolTitle.js';
import { commandActions } from '../shared/command-actions.js';
import { isImagePath, toolImageContent } from '../shared/tool-images.js';
import { ClaudeActivities, commandNameOf, exitCodeOf, localCommandOutput, noticeRowKind, shellInputOf, shellOutputOf, taskNotification, type ClaudeActivityHooks } from './activity.js';
import { clip, record, string, INTERRUPTED_MARKER, claudeApiFailure, isClaudeSyntheticPlaceholder, readableThinking, isNarration, type ClaudeRow, isTranscriptOnly, promptIdOf, hiddenTurnPrompt, subagentWake, rowText, stripPastedContent, commandPrompt } from './rows.js';

/** Edits are whole-file sized: `Write` sends the file's full text. Matches the other backends' limit. */
export const EDIT_LIMIT = 256 * 1024;

/**
 * A subagent's report delivered to the agent that launched it (`SubagentHandback`), with the report itself beside
 * the framing it is wrapped in. Claude Code writes it as a hidden peer row when it opens a turn, and as a
 * `queued_command` attachment when it reaches a turn already running.
 */
export function handbackOf(row: ClaudeRow): { taskId: string; report: string } | undefined {
  const attachment = row.type === 'attachment' ? record(row.attachment) : undefined;
  const origin = row.type === 'user' ? record(row.origin) : attachment?.type === 'queued_command' ? record(attachment.origin) : undefined;
  if (origin?.kind !== 'peer' || origin.handback !== true) return undefined;
  const taskId = string(origin.senderTaskId) ?? string(origin.from), report = string(origin.handbackReportText);
  return taskId && report?.trim() ? { taskId, report } : undefined;
}

/** A subagent's report is the notice of its end, in the turn that reads it. */
export function handbackNotice(handback: { taskId: string; report: string }, state: MapperState, hooks: ClaudeTranscriptHooks): Record<string, unknown> {
  const agent = state.activities?.agentOf(handback.taskId);
  return {
    sessionUpdate: 'task_notification', kind: 'subagent', status: 'completed', title: agent?.title ?? '子 Agent', taskId: handback.taskId,
    ...(agent?.toolCallId ? { subagentToolCallId: agent.toolCallId } : {}),
    detail: hooks.unbounded ? handback.report : clip(handback.report),
  };
}

/**
 * What another agent wrote to this one: the conversation leading a subagent (`coordinator`), or another agent
 * (`peer`) — a subagent writing to the conversation that launched it, say. A hidden row when it starts a round,
 * a `queued_command` attachment when it reaches one already running. A report is not a message
 * (`handbackOf`), and the CLI's framing around a message is addressed to the model, not part of it.
 */
export function agentMessageOf(row: ClaudeRow): { text: string; from: 'coordinator' | 'peer' } | undefined {
  const attachment = row.type === 'attachment' ? record(row.attachment) : undefined;
  const origin = attachment?.type === 'queued_command' ? record(attachment.origin) : subagentWake(row) ? record(row.origin) : undefined;
  if (origin?.kind !== 'coordinator' && origin?.kind !== 'peer' || origin.handback === true) return undefined;
  const raw = attachment ? string(attachment.prompt) ?? '' : rowText(record(row.message)?.content);
  const text = origin.kind === 'coordinator'
    ? raw.replace(/^The coordinator sent a message while you were working:\n/, '').replace(/\s*Address this before completing your current task\.\s*$/, '')
    : string(origin.body) ?? /<agent-message(?:\s[^>]*)?>\n?([\s\S]*?)\n?<\/agent-message>/.exec(raw)?.[1] ?? '';
  return text.trim() ? { text: text.trim(), from: origin.kind === 'coordinator' ? 'coordinator' : 'peer' } : undefined;
}

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

/**
 * A subagent call carries the title the CLI itself shows for it. Claude Code called this tool
 * `Task` through 2.1.x and `Agent` after, so both names are the same thing here.
 */
export function describeTool(name: string, input: Record<string, unknown>, unbounded = false): Record<string, unknown> {
  const path = string(input.file_path) ?? string(input.path) ?? string(input.target_file);
  const subagent = name === 'Task' || name === 'Agent';
  /**
   * `Bash` sends only a command string, where Codex reports what its commands do (`commandActions`).
   * A command that only reads and searches gets the same actions, so it renders as Codex's do:
   * `Read a.ts, b.ts` with the read icon, not the command line. Anything else keeps its description.
   */
  const actions = name === 'Bash' && string(input.command) ? commandActions(string(input.command)!) : undefined;
  const described = actions && describeCommandActions(actions);
  const pattern = string(input.pattern);
  const title = described?.title ? described.title
    : name === 'Bash' ? string(input.description) ?? string(input.command) ?? 'Run command'
    : (name === 'Grep' || name === 'Glob') && pattern ? `Search ${pattern}${path ? ` in ${path}` : ''}`
    : name === 'Monitor' ? string(input.description) ?? string(input.command) ?? 'Monitor'
    : name === 'Read' ? `Read ${path?.split(/[\\/]/).at(-1) ?? 'file'}`
      : ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name) ? `${name} ${path?.split(/[\\/]/).at(-1) ?? 'file'}`
        : name === 'AskUserQuestion' ? questionLabel(input) ?? 'Ask a question'
          : name === 'ExitPlanMode' ? 'Review plan'
            : subagent ? string(input.description) ?? 'Subagent'
              : name === 'SendMessage' ? string(input.summary)?.trim() || name : name;
  const kind = described && described.kind !== 'execute' ? described.kind
    : name === 'Bash' || name === 'Monitor' ? 'execute'
    : name === 'Read' ? 'read'
      : ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name) ? 'edit'
        : name === 'AskUserQuestion' ? 'question'
          : name === 'ExitPlanMode' ? 'plan'
            : subagent ? 'agent'
              : name === 'SendMessage' ? 'message'
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
  const actionPaths = [...new Set((actions ?? []).flatMap(action => action.path && !/[*?[$~]/.test(action.path) ? [action.path] : []))];
  return {
    kind, title,
    ...(path ? { locations: [{ path }] } : actionPaths.length ? { locations: actionPaths.map(item => ({ path: item })) } : {}),
    rawInput: described ? { ...input, commandActions: actions } : input,
    ...(edited ? { content: [{ type: 'diff', path, oldText: clip(oldText ?? '', unbounded ? Infinity : EDIT_LIMIT), newText: clip(newText ?? '', unbounded ? Infinity : EDIT_LIMIT) }] } : {}),
    // The plan is prose the model wrote for the reader to approve, so it rides the call as Markdown
    // rather than as a `plan` event: that channel carries todo entries, and a client reading it for
    // `entries` drops a body it finds there.
    ...(name === 'ExitPlanMode' && string(input.plan) ? { content: [{ type: 'markdown', text: unbounded ? string(input.plan)! : clip(string(input.plan)!) }] } : {}),
    // A message to another agent is prose for that agent; its result only says it was delivered.
    ...(name === 'SendMessage' && string(input.message)?.trim() ? { content: [{ type: 'markdown', text: unbounded ? string(input.message)! : clip(string(input.message)!) }] } : {}),
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

/** The absolute `screenshot` path in a `browser_screenshot` result's JSON text, if it named one. */
export function savedScreenshot(text: string): string | undefined {
  try {
    const value = string(record(JSON.parse(text))?.screenshot);
    return value && isAbsolute(value) && !/[\r\n]/.test(value) ? value : undefined;
  } catch { return undefined; }
}

/** What an `AskUserQuestion` call asks, the way Codex titles its question rows: the first question's header, else its first line. */
function questionLabel(input: Record<string, unknown>): string | undefined {
  const first = Array.isArray(input.questions) ? record(input.questions[0]) : undefined;
  return string(first?.header)?.trim() || string(first?.question)?.split('\n')[0]?.trim().slice(0, 80) || undefined;
}

/**
 * An answered `AskUserQuestion` as the `question_answer` blocks Codex and Cursor rows carry, read
 * from the result's `answers` (question text → answer, several choices joined by ", ") and the note
 * the user may add beside a choice (`annotations[question].notes`). A question without an answer
 * reads as skipped.
 */
function questionAnswers(call: ToolCall, result: Record<string, unknown>): Array<Record<string, unknown>> | undefined {
  const answers = record(result.answers);
  const annotations = record(result.annotations);
  const questions = Array.isArray(call.input.questions) ? call.input.questions.map(record) : [];
  if (!answers || !questions.length || questions.some(question => !string(question?.question))) return undefined;
  return questions.map(question => {
    const text = string(question!.question)!;
    const given = [string(answers[text])?.trim(), string(record(annotations?.[text])?.notes)?.trim()].filter((value): value is string => Boolean(value));
    const options = Array.isArray(question!.options) ? question!.options.flatMap(option => string(record(option)?.label) ?? []) : [];
    return { type: 'question_answer', question: text, answers: given, ...(options.length ? { options } : {}) };
  });
}

/** A tool_result is either a string or text/image blocks; Read of an image file answers with the latter. */
export function toolResultContent(value: unknown, call: ToolCall | undefined, failed: boolean, unbounded = false): Array<Record<string, unknown>> {
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
export function updateClaudeTasks(state: MapperState, call: ToolCall, result: Record<string, unknown>, resultText: string): boolean {
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

export function taskPlan(state: MapperState): Array<{ id: string; content: string; status: string }> {
  return [...state.tasks.values()].map(({ id, content, status }) => ({ id, content, status }));
}

export function mapRow(row: ClaudeRow, line: number, session: Session, state: MapperState, hooks: ClaudeTranscriptHooks, allowSidechain = false): Array<Omit<NativeWorkbenchEvent, 'sequence'>> {
  const uuid = string(row.uuid) ?? `line-${line}`;
  const message = record(row.message);
  const createdAt = string(row.timestamp) ?? session.updatedAt;
  const type = row.type;
  // A subagent's own file is entirely sidechain rows; only the parent file has to drop them.
  if (!allowSidechain && row.isSidechain === true) return [];
  // What reaches a turn already running: a subagent's report, or a message from another agent.
  const handback = type === 'attachment' ? handbackOf(row) : undefined;
  const delivered = type === 'attachment' && !handback ? agentMessageOf(row) : undefined;
  if (handback || delivered) return [{
    sessionId: session.id, nativeId: `claude:${session.nativeSessionId ?? session.id}:${uuid}:0`, nativeAliases: [uuid],
    ...(state.turnId ? { runId: state.turnId } : {}), ...(state.nativeTurnId ? { nativeTurnId: state.nativeTurnId } : {}), createdAt,
    ...(handback
      ? { type: 'task_notification', data: handbackNotice(handback, state, hooks) }
      : { type: 'user_message_chunk', data: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: delivered!.text }, from: delivered!.from } }),
  }];
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
      // The hand-back already shows as the subagent's answer; its result only says it was delivered.
      if (call?.name === 'SubagentHandback' && !failed) { state.calls.delete(toolUseId); continue; }
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
      const receipt = call?.name === 'SendMessage' && !failed;
      const answered = call?.name === 'AskUserQuestion' && !failed && toolResults.length === 1 ? questionAnswers(call, rowResult) : undefined;
      const resultContent = [...(receipt ? [] : answered ?? toolResultContent(part.content, call, failed, hooks.unbounded)), ...observed];
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
      const hiddenPromptId = hiddenTurnPrompt(row);
      if (hiddenPromptId && state.nativeTurnId !== hiddenPromptId) {
        state.nativeTurnId = hiddenPromptId;
        state.turnId = `claude-turn:${uuid}`;
        state.turnAt = createdAt;
      }
      // In the turn it opens for the agent that launched the subagent.
      const handback = handbackOf(row);
      if (handback) {
        events.push({ ...base(0), type: 'task_notification', data: handbackNotice(handback, state, hooks) });
        return events;
      }
      // A message from another agent reads as that agent's prompt.
      const message = agentMessageOf(row);
      if (message) {
        events.push({ ...base(0), type: 'user_message_chunk', data: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: message.text }, from: message.from } });
        return events;
      }
      if (hiddenPromptId) return events;
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
        // A command's exit code is only in the summary's words; clients read it from the result they already know.
        const exitCode = exitCodeOf(notice.summary);
        const jobResult = exitCode !== undefined && notice.taskId && (notice.status === 'completed' || notice.status === 'failed')
          ? { id: notice.taskId, status: notice.status === 'completed' ? 'succeeded' : 'failed', exitCode } : undefined;
        // A receipt for a report its hand-back row already showed.
        if (!notice.handedBack) events.push({ ...base(0), runId: state.turnId, type: 'task_notification', data: {
          sessionUpdate: 'task_notification', kind: noticeRowKind(info?.kind), status: monitorEvent ? 'running' : notice.status,
          ...(notice.sourceStatus ? { sourceStatus: notice.sourceStatus } : {}),
          title: info?.title || notice.title,
          ...(notice.taskId ? { taskId: notice.taskId } : {}),
          ...(notice.toolUseId ? { subagentToolCallId: notice.toolUseId } : {}),
          ...(info?.command ? { command: info.command } : {}),
          ...(notice.outputFile ? { outputFile: notice.outputFile } : {}),
          ...(notice.result || notice.eventText ? { detail: notice.result ?? notice.eventText } : {}),
          ...(notice.tokens !== undefined ? { tokens: notice.tokens } : {}),
          ...(notice.durationMs !== undefined ? { durationMs: notice.durationMs } : {}),
          ...(jobResult ? { jobResult } : {}),
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
  // Claude Code writes a non-error synthetic placeholder ("No response requested.") to close an
  // unanswered or interrupted user turn in its history; it is neither model output nor a turn.
  if (isClaudeSyntheticPlaceholder(row)) return [];
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
      if (text.trim()) events.push({ ...base(ordinal++), type: 'agent_thought_chunk', data: { sessionUpdate: 'agent_thought_chunk', channel: isNarration(part.signature) ? 'narration' : 'thinking', content: { type: 'text', text: hooks.unbounded ? text : clip(text) } } });
      continue;
    }
    if (part.type === 'tool_use' && typeof part.id === 'string' && typeof part.name === 'string') {
      const input = record(part.input) ?? {};
      state.calls.set(part.id, { name: part.name, input, ...(state.turnId ? { runId: state.turnId } : {}), ...(state.nativeTurnId ? { nativeTurnId: state.nativeTurnId } : {}) });
      hooks.onToolUse?.(part.id, part.name, input);
      // A subagent ends a round by handing its report back: that report is its answer.
      const report = part.name === 'SubagentHandback' ? string(input.message) : undefined;
      if (report?.trim()) {
        if (model && model !== '<synthetic>') hooks.onMessageModel?.(base(ordinal).nativeId, model);
        events.push({ ...base(ordinal++), type: 'agent_message_chunk', data: { sessionUpdate: 'agent_message_chunk', phase: 'final_answer', content: { type: 'text', text: hooks.unbounded ? report : clip(report) } } });
        continue;
      }
      events.push({ ...base(ordinal++), type: 'tool_call', data: { sessionUpdate: 'tool_call', toolCallId: part.id, toolName: part.name, status: 'in_progress', ...describeTool(part.name, input, hooks.unbounded) } });
    }
  }
  return events;
}
