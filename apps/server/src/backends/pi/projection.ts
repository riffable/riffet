import type { NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';
import type { TurnEndStatus } from '../../journal/ingest.js';
import { toolImageContent } from '../shared/tool-images.js';
import type { PiEntry, PiTranscript } from './history.js';

/*
 * What one entry of pi's session tree reads as in the workbench timeline. An entry keeps pi's own id:
 * a user row is its entry, an assistant block is its entry plus the content index, and a tool call is
 * the provider's tool-call id. Reading the same file again therefore writes the same rows.
 */

/** Diffs are shown inline, so a pathological edit is clipped rather than shipped whole. */
const EDIT_LIMIT = 256 * 1024;
/** A tool's output is a preview; the agent keeps the whole text. */
const RESULT_LIMIT = 48 * 1024;

type RecordValue = Record<string, unknown>;

export interface PiAttachmentInfo { id?: string; name: string; mimeType?: string; width?: number; height?: number }

export interface PiProjectionOptions {
  /** Preserve full payloads for a frozen export. */
  unbounded?: boolean;
  sessionId: string;
  /** The user entry that owns this row; absent for an entry that starts no workbench turn. */
  turnId?: string;
  runId?: string;
  commandId?: string;
  attachments?: PiAttachmentInfo[];
}

export interface PiTurnOutcome {
  turnId: string;
  status: TurnEndStatus;
  at: string;
  error?: string;
  commandId?: string;
  runId?: string;
}

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function clip(value: string | undefined, limit: number): string {
  const body = value ?? '';
  return body.length > limit ? `${body.slice(0, limit)}…` : body;
}

function baseName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function makeEvent(
  entry: PiEntry,
  options: PiProjectionOptions,
  type: string,
  data: RecordValue,
  nativeId: string,
): NativeWorkbenchEvent {
  return {
    sequence: 0,
    sessionId: options.sessionId,
    ...(options.runId ? { runId: options.runId } : {}),
    type,
    data: { sessionUpdate: type, ...data },
    createdAt: entry.timestamp,
    nativeId,
    ...(options.turnId ? { nativeTurnId: options.turnId } : {}),
    ...(options.commandId ? { nativeAliases: [options.commandId] } : {}),
  };
}

/** Identity of a user entry's row; also the run's `nativeMessageId` once dispatch observes it. */
export function piUserEventId(entryId: string): string {
  return `msg:${entryId}`;
}

/** Identity of one committed assistant block. */
export function piBlockEventId(entryId: string, index: number): string {
  return `msg:${entryId}:${index}`;
}

/** Identity of a tool call's row, from the provider's own call id. */
export function piToolEventId(toolCallId: string): string {
  return `tool:${toolCallId}`;
}

/** Identity of the result that settles a tool call. */
export function piToolResultEventId(toolCallId: string): string {
  return `tool:${toolCallId}:result`;
}

/** Identity of a turn's outcome row. */
export function piTurnEndId(turnId: string): string {
  return `turn:${turnId}:end`;
}

/** A user message that starts a turn: pi keeps tool results under their own role, so any user entry is one. */
export function isPiPrompt(entry: PiEntry): boolean {
  return entry.type === 'message' && text(record(entry.message)?.role) === 'user';
}

/** A custom message an extension injected for display; it joins the current turn but starts none. */
function isVisibleCustomMessage(entry: PiEntry): boolean {
  return entry.type === 'custom_message' && entry.display === true;
}

/** The last assistant message's stop reason, when it is a final state. A cold read may infer an abandoned turn. */
export function piAssistantStatus(message: RecordValue | undefined, cold: boolean): TurnEndStatus | undefined {
  const reason = text(message?.stopReason);
  if (reason === 'stop' || reason === 'length') return 'completed';
  if (reason === 'error') return 'failed';
  if (reason === 'aborted') return 'cancelled';
  // `toolUse`, `pending` and `deferred` mean the turn was still going; only a cold read knows it never resumed.
  return cold ? 'interrupted' : undefined;
}

/** The outcome of one user turn on a chain, inferred from its last assistant message. */
export function piTurnOutcome(chain: readonly PiEntry[], turnId: string, cold: boolean): PiTurnOutcome | undefined {
  const start = chain.findIndex(entry => entry.id === turnId && isPiPrompt(entry));
  if (start < 0) return undefined;
  let last: PiEntry | undefined;
  let lastAssistant: RecordValue | undefined;
  for (let index = start + 1; index < chain.length; index += 1) {
    const entry = chain[index]!;
    if (isPiPrompt(entry)) break;
    last = entry;
    if (entry.type === 'message') {
      const message = record(entry.message);
      if (message?.role === 'assistant') lastAssistant = message;
    }
  }
  const status = piAssistantStatus(lastAssistant, cold);
  if (!status) return undefined;
  const error = text(lastAssistant?.errorMessage);
  return {
    turnId,
    status,
    at: (last ?? chain[start]!).timestamp,
    ...(error ? { error } : {}),
  };
}

function userAttachments(entry: PiEntry, options: PiProjectionOptions): PiAttachmentInfo[] {
  if (options.attachments?.length) return options.attachments;
  const content = entry.type === 'custom_message' ? entry.content : record(entry.message)?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap(value => {
    const block = record(value);
    if (block?.type !== 'image') return [];
    const mimeType = text(block.mimeType);
    return [{ name: 'image', ...(mimeType ? { mimeType } : {}) }];
  });
}

function projectUser(entry: PiEntry, options: PiProjectionOptions): NativeWorkbenchEvent[] {
  const content = entry.type === 'custom_message' ? entry.content : record(entry.message)?.content;
  const body = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.flatMap(value => {
        const block = record(value);
        return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
      }).join('\n')
      : '';
  const attachments = userAttachments(entry, options);
  if (!body.trim() && !attachments.length) return [];
  const data: RecordValue = {
    content: { type: 'text', text: body },
    ...(options.commandId ? { commandId: options.commandId } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(entry.type === 'custom_message' ? { customType: text(entry.customType) ?? 'custom' } : {}),
  };
  return [makeEvent(entry, options, 'user_message_chunk', data, piUserEventId(entry.id))];
}

function resultContent(content: unknown, unbounded = false): { body: string; images: RecordValue[] } {
  if (typeof content === 'string') return { body: content, images: [] };
  if (!Array.isArray(content)) return { body: '', images: [] };
  const parts: string[] = [];
  const images: RecordValue[] = [];
  for (const value of content) {
    const block = record(value);
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block?.type === 'image' && (unbounded || images.length < 4)) {
      images.push(toolImageContent({
        ...(text(block.data) ? { data: text(block.data) } : {}),
        ...(text(block.mimeType) ? { mimeType: text(block.mimeType) } : {}),
      }, { unbounded }));
    }
  }
  return { body: parts.join('\n'), images };
}

function projectToolResult(entry: PiEntry, options: PiProjectionOptions): NativeWorkbenchEvent[] {
  const message = record(entry.message);
  const toolCallId = text(message?.toolCallId);
  if (!toolCallId) return [];
  const { body, images } = resultContent(message?.content, options.unbounded);
  const isError = message?.isError === true;
  const items = [
    ...(body ? [{ type: 'content', content: { type: 'text', text: options.unbounded ? body : clip(body, RESULT_LIMIT) } }] : []),
    ...images,
  ];
  return [makeEvent(entry, options, 'tool_call_update', {
    toolCallId,
    ...(text(message?.toolName) ? { toolName: text(message?.toolName) } : {}),
    status: isError ? 'failed' : 'completed',
    ...(items.length ? { content: items } : {}),
  }, piToolResultEventId(toolCallId))];
}

function projectAssistant(entry: PiEntry, options: PiProjectionOptions): NativeWorkbenchEvent[] {
  const message = record(entry.message);
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  const events: NativeWorkbenchEvent[] = [];
  content.forEach((value, index) => {
    const block = record(value);
    if (!block) return;
    if (block.type === 'text' && typeof block.text === 'string' && block.text) {
      events.push(makeEvent(entry, options, 'agent_message_chunk', { content: { type: 'text', text: block.text } }, piBlockEventId(entry.id, index)));
    } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
      events.push(makeEvent(entry, options, 'agent_thought_chunk', { content: { type: 'text', text: block.thinking }, channel: 'thinking' }, piBlockEventId(entry.id, index)));
    } else if (block.type === 'toolCall') {
      const toolCallId = text(block.id), name = text(block.name);
      if (!toolCallId || !name) return;
      const input = record(block.arguments) ?? {};
      events.push(makeEvent(entry, options, 'tool_call', {
        toolCallId,
        toolName: name,
        status: 'in_progress',
        rawInput: input,
        ...(text(block.argumentsError) ? { error: text(block.argumentsError) } : {}),
        ...describePiToolCall(name, input, options.unbounded),
      }, piToolEventId(toolCallId)));
    }
  });
  return events;
}

/** Project one committed entry into workbench transcript events. */
export function projectPiEntry(entry: PiEntry, options: PiProjectionOptions): NativeWorkbenchEvent[] {
  if (entry.type === 'message') {
    const role = text(record(entry.message)?.role);
    if (role === 'user') return projectUser(entry, options);
    if (role === 'assistant') return projectAssistant(entry, options);
    if (role === 'toolResult') return projectToolResult(entry, options);
    return [];
  }
  if (isVisibleCustomMessage(entry)) return projectUser(entry, options);
  return [];
}

/** The run outcome for a finished turn. `turnId` is the id of the user entry that started it. */
export function projectPiTurnEnd(outcome: PiTurnOutcome, options: PiProjectionOptions): NativeWorkbenchEvent {
  const command = options.commandId ? { commandId: options.commandId } : {};
  const { type, data } = outcome.status === 'completed'
    ? { type: 'run_completed', data: { ...command, reason: 'completed' } }
    : outcome.status === 'cancelled'
      ? { type: 'run_cancelled', data: { ...command, reason: outcome.error ?? 'pi stopped this turn.' } }
      : outcome.status === 'interrupted'
      // The dispatcher accepts run_cancelled only; `status` keeps the exact native reason.
      ? { type: 'run_cancelled', data: { ...command, reason: outcome.error ?? 'pi ended before this turn finished.', status: 'interrupted' } }
      : { type: 'run_failed', data: { ...command, error: outcome.error ?? 'pi ended this turn without completing it.' } };
  return {
    sequence: 0,
    sessionId: options.sessionId,
    ...(options.runId ? { runId: options.runId } : {}),
    type,
    data: { sessionUpdate: type, ...data },
    createdAt: outcome.at,
    nativeId: piTurnEndId(outcome.turnId),
    nativeTurnId: outcome.turnId,
  };
}

/**
 * The whole chain as events, in order, each turn's outcome right after the last entry it wrote.
 *
 * @param commandFor - the workbench command a user entry answered, when it is known; `false` for a
 *   subagent, whose turns are not workbench runs and so have no outcomes to show.
 */
export function projectPiChain(
  transcript: PiTranscript,
  options: Omit<PiProjectionOptions, 'turnId' | 'runId' | 'commandId'>,
  commandFor: ((entryId: string) => { commandId?: string; runId?: string } | undefined) | false = () => undefined,
): NativeWorkbenchEvent[] {
  const commands = new Map<string, { commandId?: string; runId?: string }>();
  if (commandFor) {
    for (const entry of transcript.chain) {
      if (!isPiPrompt(entry)) continue;
      const command = commandFor(entry.id);
      if (command) commands.set(entry.id, command);
    }
  }
  const lastOfTurn = new Map<string, number>();
  let turn: string | undefined;
  transcript.chain.forEach((entry, index) => {
    if (isPiPrompt(entry)) turn = entry.id;
    if (turn) lastOfTurn.set(turn, index);
  });

  const events: NativeWorkbenchEvent[] = [];
  turn = undefined;
  transcript.chain.forEach((entry, index) => {
    if (isPiPrompt(entry)) turn = entry.id;
    const command = turn ? commands.get(turn) : undefined;
    const projected = projectPiEntry(entry, {
      ...options,
      ...(turn ? { turnId: turn } : {}),
      ...(command?.runId ? { runId: command.runId } : {}),
      ...(command?.commandId ? { commandId: command.commandId } : {}),
    });
    events.push(...projected);
    if (!commandFor || !turn || !command || lastOfTurn.get(turn) !== index) return;
    const outcome = piTurnOutcome(transcript.chain, turn, true);
    if (outcome) events.push(projectPiTurnEnd({ ...outcome, ...(command.commandId ? { commandId: command.commandId } : {}), ...(command.runId ? { runId: command.runId } : {}) }, {
      ...options,
      turnId: turn,
      ...(command.commandId ? { commandId: command.commandId } : {}),
      ...(command.runId ? { runId: command.runId } : {}),
    }));
  });
  return events;
}

/** What one of pi's built-in tool calls should read as in the timeline. */
export function describePiToolCall(name: string, input: RecordValue, unbounded = false): RecordValue {
  const path = text(input.path) ?? text(input.file_path);
  const locations = path ? [{ path, ...(typeof input.offset === 'number' && input.offset > 0 ? { line: input.offset } : {}) }] : [];
  const located = locations.length ? { locations } : {};
  switch (name) {
    case 'read':
      return { kind: 'read', title: `Read${path ? ` ${baseName(path)}` : ''}`, ...located };
    case 'write': {
      const content = text(input.content);
      return {
        kind: 'edit', title: `Write${path ? ` ${baseName(path)}` : ''}`, ...located,
        ...(content !== undefined ? { content: [{ type: 'diff', path, oldText: '', newText: clip(content, unbounded ? Infinity : EDIT_LIMIT) }] } : {}),
      };
    }
    case 'edit': {
      // pi accepts one edit inline (`path`, `oldText`, `newText`) or a list under `edits`.
      const values: unknown[] = Array.isArray(input.edits) ? input.edits : [input];
      const edits = values.flatMap(value => {
        const edit = record(value);
        const oldText = text(edit?.oldText), newText = text(edit?.newText);
        return oldText !== undefined || newText !== undefined ? [{ type: 'diff', path, oldText: clip(oldText, unbounded ? Infinity : EDIT_LIMIT), newText: clip(newText, unbounded ? Infinity : EDIT_LIMIT) }] : [];
      });
      return { kind: 'edit', title: `Edit${path ? ` ${baseName(path)}` : ''}`, ...located, ...(edits.length ? { content: edits } : {}) };
    }
    case 'bash': {
      const command = text(input.command);
      return { kind: 'execute', title: command ?? 'bash' };
    }
    case 'grep': {
      const pattern = text(input.pattern);
      return { kind: 'search', title: `grep ${pattern ?? ''}`.trim(), ...(path ? { locations: [{ path }] } : {}) };
    }
    case 'find': {
      const pattern = text(input.pattern);
      return { kind: 'search', title: `find ${pattern ?? ''}`.trim(), ...(path ? { locations: [{ path }] } : {}) };
    }
    case 'ls': {
      const directory = path ?? text(input.directory);
      return { kind: 'search', title: `ls ${directory ?? ''}`.trim(), ...(directory ? { locations: [{ path: directory }] } : {}) };
    }
    default:
      return { kind: 'other', title: name };
  }
}
