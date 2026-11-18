import type { NativeContext, NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';
import { describeCommandActions } from '../../../../../packages/timeline/src/toolTitle.js';
import { toolImageContent } from '../shared/tool-images.js';
import type { RpcTurn, RpcItem } from './types.js';
import { firstLine, str, finiteToken, asRecord, asArray } from './util.js';
import { splitUnifiedDiff, type DiffHunk } from '../shared/unified-diff.js';
import { withoutStandingContext } from './standing.js';

/** When an item began and ended (`item-spans.ts`). */
export interface ItemSpan { startedAt: string; completedAt: string }
/** The time of an event of the item: a tool's result is when it ended, every other row is when it began. */
export function spanTime(span: ItemSpan | undefined, type: string, fallback: string): string {
  return span ? (type === 'tool_call_update' ? span.completedAt : span.startedAt) : fallback;
}

/** Bytes one subagent's opening snapshot may spend; older events stay behind its history cursor. */
const SUBAGENT_SNAPSHOT_BYTES = 96 * 1024;
export function isCodexToolItem(item: RpcItem): boolean {
  return ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'functionCallOutput', 'webSearch', 'imageView'].includes(item.type)
    || isSubagentStart(item);
}

/**
 * A child the thread started, as a newer app-server reports it: `subAgentActivity` naming the
 * child's thread, in place of a `spawnAgent` collaboration call. Its later `interacted`,
 * `interrupted` and `completed` entries describe the same child and are not rows of their own.
 */
export function isSubagentStart(item: RpcItem): boolean {
  return item.type === 'subAgentActivity' && item.kind === 'started' && Boolean(str(item.agentThreadId));
}

/** TRAE's activity is a second representation of the collaboration call, with its id prefixed. */
export function subagentToolCallId(item: RpcItem): string | undefined {
  const id = str(item.id);
  return isSubagentStart(item) && id?.startsWith('subagent-activity:') ? str(id.slice('subagent-activity:'.length)) : id;
}

/** The task name a child was started under: the last segment of its `agentPath` (`/root/repo_ui`). */
export function subagentName(item: RpcItem): string {
  return str(item.agentPath)?.split('/').filter(Boolean).at(-1) ?? 'Subagent';
}

/**
 * Whether an item id is the positional stand-in TRAE CLI gives a turn it has not written yet.
 *
 * A running turn's items are served as `item-1`, `item-2`, … counting its items after the message
 * that opened it; once the turn is written they carry the ids they keep — `msg_…` for an answer,
 * `rs_…` for its reasoning, `fc_`/`fco_`/`tei_`/`ctc_` for the rest, and the `riffet-…` id we
 * submitted for our own input. So this shape names the same items twice, never a third one.
 */
export function isProvisionalItemId(value: string | undefined): boolean {
  return value !== undefined && /^item-\d+$/.test(value);
}

/** MCP results are content blocks; images arrive as base64 with no file behind them. */
function mcpResultContent(result: unknown): Array<Record<string, unknown>> {
  const blocks = asArray<unknown>(asRecord(result)?.content).map(asRecord).filter((block): block is Record<string, unknown> => Boolean(block));
  const text = blocks.flatMap(block => block.type === 'text' && str(block.text) ? [str(block.text)!] : []).join('\n').trim();
  const images = blocks.filter(block => block.type === 'image').slice(0, 4).map(block => toolImageContent({
    ...(str(block.data) ? { data: str(block.data) } : {}), ...(str(block.mimeType) ? { mimeType: str(block.mimeType) } : {}),
  }));
  return [...(text ? [{ type: 'content', content: { type: 'text', text } }] : []), ...images];
}

/**
 * A built-in tool the provider runs itself — TRAE CLI's Claude-style `Read`, `Grep`, `LS` — which it
 * reports as a `commandExecution` whose `command` is just the tool's name. The real call is in
 * `commandActions`; read from there it renders as the read or search it is, not a shell command.
 */
function builtinToolCall(item: RpcItem): { name: string; kind: string; title: string; path?: string; input: Record<string, unknown> } | undefined {
  if (item.type !== 'commandExecution') return undefined;
  const actions = asArray<unknown>(item.commandActions);
  // A compound call must use every parsed action, even when its first action is a built-in read.
  if (actions.length !== 1) return undefined;
  const action = asRecord(actions[0]);
  const input = asRecord(action?.input);
  if (!action) return undefined;
  // Live items say `input.type: 'builtin'`; history keeps only `{ type: 'shell', command: ['Read'] }`,
  // so a bare tool name echoed by its own action is read the same way. No shell command looks like that.
  const command = str(item.command);
  const historyBuiltin = Boolean(command && /^[A-Z][A-Za-z]+$/.test(command) && str(action.command) === command);
  if (input?.type !== 'builtin' && !historyBuiltin) return undefined;
  const name = str(input?.name) ?? command ?? 'Tool';
  const type = str(action.type);
  const path = str(action.path);
  const query = str(action.query);
  const kind = type === 'read' ? 'read' : type === 'listFiles' || type === 'search' ? 'search' : 'other';
  return {
    name, kind,
    title: [name, query ?? path].filter(Boolean).join(' '),
    ...(path ? { path } : {}),
    input: asRecord(input?.arguments) ?? (path ? { file_path: path } : query ? { pattern: query } : {}),
  };
}

/** Only unwrap an argv supplied by the provider; never tokenize its printable shell command. */
function shellPayload(action: Record<string, unknown>): string | undefined {
  const input = asRecord(action.input);
  if (input?.type !== 'shell') return undefined;
  const argv = asArray<unknown>(input.command);
  if (!argv.length || !argv.every(value => typeof value === 'string')) return undefined;
  const shell = (argv[0] as string).split('/').at(-1);
  if (!shell || !['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'].includes(shell)) return undefined;
  const flag = argv.findIndex(value => value === '-c' || value === '-lc' || value === '-cl');
  // A positional script before -c is not a shell wrapper (its arguments can themselves be -c).
  if (flag < 1 || !argv.slice(1, flag).every(value => /^-[ilfrxevu]+$/.test(value as string)
    || ['--login', '--noprofile', '--norc'].includes(value as string))) return undefined;
  return str(argv[flag + 1]);
}

function commandForActions(item: RpcItem, actions: Record<string, unknown>[]): string | undefined {
  const payloads = actions.map(shellPayload);
  if (payloads.length && payloads.every(payload => payload !== undefined && payload === payloads[0])) return payloads[0];
  // Standard CommandAction.command is already parsed by Codex. In a compound call it can name
  // only one segment, so use it for the whole command only when every action agrees.
  const commands = actions.map(action => str(action.command));
  if (commands.length && commands.every(command => command !== undefined && command === commands[0])) return commands[0];
  return str(item.command);
}

/** Codex parses reads/searches even when their execution happens through a shell. */
function commandToolCall(item: RpcItem): { name: string; kind: string; title: string; input: Record<string, unknown>; locations: Array<{ path: string }> } | undefined {
  if (item.type !== 'commandExecution') return undefined;
  const actions = asArray<unknown>(item.commandActions).map(action => asRecord(action) ?? {});
  const command = commandForActions(item, actions);
  const described = describeCommandActions(actions);
  const kind = described?.kind ?? 'execute';
  const name = described?.name ?? 'Command';
  const title = described?.title ?? command ?? 'Command';
  const paths = new Set(actions.flatMap(action => {
    const path = str(action.path);
    return path ? [path] : [];
  }));
  return {
    name, kind, title,
    input: {
      ...(command ? { command } : {}),
      ...(str(item.command) && item.command !== command ? { originalCommand: item.command } : {}),
      ...(str(item.cwd) ? { cwd: item.cwd } : {}),
      ...(actions.length ? { commandActions: item.commandActions } : {}),
    },
    locations: [...paths].map(path => ({ path })),
  };
}

/** What a command changed in the working tree, seen around it by the hooks (`observation.ts`); appended to its result. */
export type ObservedChanges = (toolCallId: string) => readonly Record<string, unknown>[] | undefined;

export function projectToolItem(item: RpcItem, event: (id: string, type: string, data: Record<string, unknown>) => NativeWorkbenchEvent, base: string, observedChanges?: ObservedChanges): NativeWorkbenchEvent[] {
  const toolCallId = subagentToolCallId(item) ?? base;
  const status = toolStatus(item.status);
  if (isSubagentStart(item)) {
    const name = subagentName(item);
    const call = event(`${base}:call`, 'tool_call', {
      toolCallId, toolName: 'Subagent', kind: 'agent', title: name, status: 'in_progress',
      rawInput: { description: name }, subagent: { description: name, background: true },
    });
    return status === 'in_progress' ? [call] : [call, event(`${base}:result`, 'tool_call_update', { toolCallId, status })];
  }
  const builtin = builtinToolCall(item);
  if (builtin) {
    const call = event(`${base}:call`, 'tool_call', {
      toolCallId, toolName: builtin.name, kind: builtin.kind, title: builtin.title, status: 'in_progress', rawInput: builtin.input,
      ...(builtin.path ? { locations: [{ path: builtin.path }] } : {}),
    });
    if (status === 'in_progress') return [call];
    return [call, event(`${base}:result`, 'tool_call_update', {
      toolCallId, status,
      ...(str(item.aggregatedOutput) ? { content: [{ type: 'content', content: { type: 'text', text: item.aggregatedOutput } }] } : {}),
      ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}),
    })];
  }
  const parsedCommand = commandToolCall(item);
  const command = str(parsedCommand?.input.command) ?? str(item.command);
  const changes = asArray<Record<string, unknown>>(item.changes);
  const fileLocations = changes.map(change => str(change.path)).filter((path): path is string => Boolean(path)).map(path => ({ path }));
  // A spawn names the thread it created in `receiverThreadIds`; that id is what the subagent's own
  // transcript is read by, so the row carries it as the same `subagent` shape Cursor and DSH use.
  const spawnsAgent = item.type === 'collabAgentToolCall' && isSpawnAgentItem(item);
  const subagentPrompt = spawnsAgent ? str(item.prompt) ?? '' : undefined;
  const subagentDescription = subagentPrompt === undefined ? undefined : firstLine(subagentPrompt) || undefined;
  // The other collaboration calls — message, follow-up, wait, list — move a subagent along but do
  // not create one. Reading them as `agent` rows made each coordination step look like another
  // child in the transcript, and a pile of rows named "Subagent".
  const collaborationLabel = collabCallLabel(item.type === 'collabAgentToolCall' ? str(item.tool) : undefined);
  const toolName = parsedCommand?.name ?? (item.type === 'fileChange' ? 'File changes'
    : item.type === 'mcpToolCall' ? `${str(item.server) ?? 'MCP'} · ${str(item.tool) ?? 'tool'}`
      : item.type === 'dynamicToolCall' ? [str(item.namespace), str(item.tool)].filter(Boolean).join(' · ')
        : item.type === 'collabAgentToolCall' ? (spawnsAgent ? 'Subagent' : collaborationLabel) : item.type === 'webSearch' ? 'Web search'
          : item.type === 'imageView' ? 'View image' : str(item.name) ?? 'Tool');
  const kind = parsedCommand?.kind ?? (item.type === 'fileChange' ? 'edit'
    : item.type === 'webSearch' ? 'fetch' : item.type === 'collabAgentToolCall' ? (spawnsAgent ? 'agent' : 'other') : item.type === 'imageView' ? 'read' : 'other');
  const imagePath = item.type === 'imageView' ? str(item.path) : undefined;
  const webQuery = item.type === 'webSearch' ? webSearchQuery(item) : undefined;
  const title = parsedCommand?.title ?? command ?? imagePath ?? (subagentDescription || undefined) ?? webQuery ?? toolName;
  const call = event(`${base}:call`, 'tool_call', {
    toolCallId, toolName, kind, title, status: 'in_progress',
    ...(parsedCommand ? { rawInput: parsedCommand.input, ...(parsedCommand.locations.length ? { locations: parsedCommand.locations } : {}) }
      : command ? { rawInput: { command, ...(str(item.cwd) ? { cwd: item.cwd } : {}) } }
      : imagePath ? { rawInput: { path: imagePath }, locations: [{ path: imagePath }] }
        : subagentPrompt !== undefined ? { rawInput: { ...(subagentDescription ? { description: subagentDescription } : {}), prompt: subagentPrompt } }
          // A coordination call's arguments are an opaque payload, not something to show as detail.
          : item.type === 'collabAgentToolCall' ? { rawInput: {} }
            : webQuery ? { rawInput: { query: webQuery } }
              : { rawInput: item.arguments ?? changes }),
    ...(fileLocations.length ? { locations: fileLocations } : {}),
    ...(subagentPrompt !== undefined ? { subagent: {
      ...(subagentDescription ? { description: subagentDescription } : {}),
      prompt: subagentPrompt,
      ...(str(item.model) ? { model: str(item.model) } : {}),
      background: true,
    } } : {}),
  });
  if (status === 'in_progress') return [call];
  const mcpContent = item.type === 'mcpToolCall' ? mcpResultContent(item.result) : [];
  // POSIX grep/rg exit code 1 means "no lines matched", not a failed tool invocation.
  const finalStatus = status === 'failed' && kind === 'search' && item.exitCode === 1 ? 'completed' : status;
  const resultData: Record<string, unknown> = {
    toolCallId, status: finalStatus,
    ...(imagePath ? { content: [toolImageContent({ path: imagePath })] } : {}),
    ...(mcpContent.length ? { content: mcpContent } : {}),
    ...(item.type === 'commandExecution' && str(item.aggregatedOutput) ? { content: [{ type: 'content', content: { type: 'text', text: item.aggregatedOutput } }] } : {}),
    ...(item.type === 'commandExecution' && typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}),
    ...(item.type === 'fileChange' && changes.length ? { content: changes.flatMap(change => changeHunks(change).map(hunk => ({ type: 'diff', path: change.path, ...hunk }))) } : {}),
    ...(str(item.error) ? { content: [{ type: 'content', content: { type: 'text', text: item.error } }] } : {}),
  };
  // A shell command reports no edits of its own; the diffs seen around it ride along with its output, as Claude's do.
  const observed = item.type === 'commandExecution' ? observedChanges?.(toolCallId) : undefined;
  if (observed?.length) resultData.content = [...asArray<unknown>(resultData.content), ...observed];
  return [call, event(`${base}:result`, 'tool_call_update', resultData)];
}

export function projectStartedTool(item: RpcItem, sessionId: string, threadId: string, turnId: string, runId?: string, createdAt?: string, span?: ItemSpan): NativeWorkbenchEvent[] {
  if (!isCodexToolItem(item)) return [];
  const base = `${threadId}:${turnId}:${subagentToolCallId(item) ?? item.type}`;
  return projectToolItem({ ...item, status: 'inProgress' }, (id, type, data) => makeStaticEvent(sessionId, runId ?? turnId, id, type, data, span ? spanTime(span, type, createdAt ?? new Date().toISOString()) : createdAt, item), base).slice(0, 1);
}

export function projectCompletedTool(item: RpcItem, sessionId: string, threadId: string, turnId: string, runId?: string, createdAt?: string, span?: ItemSpan, observedChanges?: ObservedChanges): NativeWorkbenchEvent[] {
  if (!isCodexToolItem(item)) return [];
  const base = `${threadId}:${turnId}:${subagentToolCallId(item) ?? item.type}`;
  const all = projectToolItem(item, (id, type, data) => makeStaticEvent(sessionId, runId ?? turnId, id, type, data, span ? spanTime(span, type, createdAt ?? new Date().toISOString()) : createdAt, item), base, observedChanges);
  // A child's start may be announced only once it has happened, so its row comes with it.
  if (isSubagentStart(item)) return all;
  const updates = all.filter(event => event.type === 'tool_call_update');
  if (item.type !== 'commandExecution') return updates;
  // Providers can finish parsing the actions only after item/started. Correct that first shell
  // header via the usual update, so the live row and a later history projection agree.
  const call = all.find(event => event.type === 'tool_call');
  if (!call) return updates;
  const { toolName, kind, title, rawInput, locations } = call.data;
  return updates.map(event => ({ ...event, data: { toolName, kind, title, rawInput, locations: locations ?? [], ...event.data } }));
}

export function codexPlanNativeId(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}:plan`;
}

export function timestampOf(value: string): number {
  return Date.parse(value);
}

export function turnIdAt(timestamp: number, turns: readonly RpcTurn[]): string | undefined {
  if (!Number.isFinite(timestamp)) return undefined;
  let match: RpcTurn | undefined;
  for (const turn of turns) {
    if (typeof turn.startedAt !== 'number' || turn.startedAt * 1000 > timestamp) continue;
    if (!match || (typeof match.startedAt === 'number' && turn.startedAt > match.startedAt)) match = turn;
  }
  return match?.id;
}

function makeStaticEvent(sessionId: string, runId: string | undefined, nativeId: string, type: string, data: Record<string, unknown>, createdAt: string | undefined, raw: unknown): NativeWorkbenchEvent {
  return { sequence: 0, sessionId, ...(runId ? { runId } : {}), type, data: { sessionUpdate: type, ...data }, raw, createdAt: createdAt ?? new Date().toISOString(), nativeId };
}

function webSearchQuery(item: RpcItem): string | undefined {
  const action = asRecord(item.action);
  const queries = asArray<unknown>(action?.queries);
  return str(item.query) ?? str(action?.query) ?? str(queries[0]);
}

/**
 * A file change as diffs to show. An added or deleted file arrives as its raw content, without
 * `+`/`-` prefixes (the rollout reader adds them, so both shapes occur); anything else is a
 * unified diff.
 */
function changeHunks(change: Record<string, unknown>): DiffHunk[] {
  const diff = str(change.diff) ?? '';
  const kind = typeof change.kind === 'string' ? change.kind : str(asRecord(change.kind)?.type);
  if ((kind === 'add' || kind === 'delete') && !/^@@ /m.test(diff)) {
    const marker = kind === 'add' ? '+' : '-';
    const lines = diff.split(/\r?\n/);
    const text = lines.every(line => line === '' || line.startsWith(marker)) ? lines.map(line => line.slice(1)).join('\n') : diff;
    return [kind === 'add' ? { oldText: '', newText: text } : { oldText: text, newText: '' }];
  }
  return splitUnifiedDiff(diff);
}

export function decodeHistoryCursor(value: string, generation: string): number | undefined {
  try {
    const data = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { generation?: unknown; end?: unknown };
    if (data.generation !== generation || !Number.isSafeInteger(data.end) || (data.end as number) < 0) return undefined;
    return data.end as number;
  } catch { return undefined; }
}

export function encodeHistoryCursor(generation: string, end: number): string {
  return Buffer.from(JSON.stringify({ generation, end })).toString('base64url');
}

/** Serialized size of one child event, the unit the snapshot budget is spent in. */
function eventByteSize(event: NativeWorkbenchEvent): number {
  return Buffer.byteLength(JSON.stringify(event));
}

/**
 * Where a subagent snapshot's window starts: at most [count] events, at most
 * [SUBAGENT_SNAPSHOT_BYTES] bytes. The newest event is always kept so the window is never empty.
 */
export function subagentSnapshotStart(events: readonly NativeWorkbenchEvent[], count: number): number {
  if (!events.length) return 0;
  let start = Math.max(0, events.length - 1);
  let bytes = eventByteSize(events[start]!);
  while (start > 0 && events.length - start < count && bytes + eventByteSize(events[start - 1]!) <= SUBAGENT_SNAPSHOT_BYTES) {
    start -= 1;
    bytes += eventByteSize(events[start]!);
  }
  return start;
}

export function turnStatus(value: RpcTurn['status']): string {
  const raw = typeof value === 'string' ? value : value?.type ?? '';
  const normalized = raw.replace(/[-_]/g, '').toLowerCase();
  if (normalized === 'inprogress') return 'inProgress';
  if (normalized === 'completed' || normalized === 'complete') return 'completed';
  if (normalized === 'failed' || normalized === 'error') return 'failed';
  if (normalized === 'interrupted' || normalized === 'cancelled' || normalized === 'canceled') return 'interrupted';
  return raw;
}
export function isFinalTurnStatus(value: RpcTurn['status']): boolean {
  return ['completed', 'failed', 'interrupted'].includes(turnStatus(value));
}
function toolStatus(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'object') return 'completed';
  const status = typeof value === 'string' ? value : str(asRecord(value)?.type) ?? '';
  return /progress|running|inProgress/i.test(status) ? 'in_progress' : /fail|error/i.test(status) ? 'failed' : 'completed';
}
/** A background-task notice, read from `<task-notification>` markup when the text carries it. */
export function taskNotice(text: string): Record<string, unknown> | undefined {
  if (!text.trim()) return undefined;
  const field = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}\\s*>`, 'i').exec(text)?.[1]?.trim() || undefined;
  const sourceStatus = field('status');
  const normalized = sourceStatus?.toLowerCase();
  const status = normalized === 'completed' || normalized === 'failed' || normalized === 'running' ? normalized
    : normalized === 'killed' || normalized === 'stopped' || normalized === 'cancelled' ? 'cancelled' : 'unknown';
  const taskId = field('task-id');
  const result = field('result');
  return {
    kind: 'task', status,
    ...(sourceStatus ? { sourceStatus } : {}),
    title: field('summary') ?? (firstLine(text.replace(/<[^>]+>/g, ' ')) || 'Background task'),
    ...(taskId ? { taskId } : {}),
    ...(result ? { detail: result } : {}),
  };
}
/** What the user wrote: the context Riffet sends the 助理 ahead of it (`standing.ts`) is not theirs. */
export function userItemText(item: RpcItem): string {
  return withoutStandingContext(asArray<Record<string, unknown>>(item.content).filter(part => part.type === 'text').map(part => str(part.text) ?? '').join(''));
}

/**
 * Whether a collaboration call created the thread it names.
 *
 * The app-server spells this `spawnAgent`; an item that still names a receiver thread and carries
 * the prompt it handed over is the same thing, which keeps an older protocol working.
 */
export function isSpawnAgentItem(item: RpcItem): boolean {
  const tool = str(item.tool);
  if (tool) return tool === 'spawnAgent';
  return Boolean(str(item.prompt)) && asArray<unknown>(item.receiverThreadIds).some(value => Boolean(str(value)));
}

/** How a collaboration call that does not create a child reads in the transcript. */
function collabCallLabel(tool: string | undefined): string {
  switch (tool?.toLowerCase()) {
    case 'sendmessage': return 'Message a subagent';
    case 'followuptask': return 'Follow-up task';
    case 'wait': case 'waitagent': return 'Wait for subagents';
    case 'listagents': return 'Subagent list';
    case 'interruptagent': return 'Interrupt subagent';
    default: return 'Agent coordination';
  }
}
/**
 * The context meter's numbers out of a `thread/tokenUsage/updated` payload.
 *
 * The window's key is the one part of this protocol that has moved between Codex versions, so it is
 * read from the breakdown or its parent, in both spellings, and the frame is dropped when none of
 * them is a positive number: a window invented from the model's name would be a worse lie than no
 * meter at all. `used` is the last request's whole prompt plus its output, which is what the next
 * request will carry.
 */
export function codexTokenBreakdown(last: Record<string, unknown> | undefined): NativeContext['breakdown'] {
  if (!last) return [];
  const input = finiteToken(last.inputTokens) ?? finiteToken(last.input_tokens) ?? 0;
  const cached = finiteToken(last.cachedInputTokens) ?? finiteToken(last.cached_input_tokens) ?? 0;
  const cacheWrite = finiteToken(last.cacheCreationInputTokens)
    ?? finiteToken(last.cacheWriteInputTokens)
    ?? finiteToken(last.cache_write_input_tokens) ?? 0;
  const output = finiteToken(last.outputTokens) ?? finiteToken(last.output_tokens) ?? 0;
  const reasoning = finiteToken(last.reasoningOutputTokens) ?? finiteToken(last.reasoning_output_tokens) ?? 0;
  const uncachedInput = Math.max(0, input - cached);
  const visibleOutput = Math.max(0, output - reasoning);
  return [
    ...(cached > 0 ? [{ id: 'cached_input', label: '缓存输入', tokens: cached }] : []),
    ...(cacheWrite > 0 ? [{ id: 'cache_write', label: '缓存写入', tokens: cacheWrite }] : []),
    ...(uncachedInput > 0 ? [{ id: 'input', label: cached > 0 ? '未缓存输入' : '输入', tokens: uncachedInput }] : []),
    ...(visibleOutput > 0 ? [{ id: 'output', label: reasoning > 0 ? '回复输出' : '输出', tokens: visibleOutput }] : []),
    ...(reasoning > 0 ? [{ id: 'reasoning_output', label: '思考输出', tokens: reasoning }] : []),
  ];
}

export function codexNativeContext(tokenUsage: Record<string, unknown> | undefined, params: Record<string, unknown>, fallbackWindow?: number): NativeContext | undefined {
  if (!tokenUsage) return undefined;
  const last = asRecord(tokenUsage.last) ?? asRecord(tokenUsage.last_token_usage);
  // The app-server spells these in camelCase; the rollout the seed reads is snake_case.
  const input = finiteToken(last?.inputTokens) ?? finiteToken(last?.input_tokens) ?? 0;
  const output = finiteToken(last?.outputTokens) ?? finiteToken(last?.output_tokens) ?? 0;
  const used = finiteToken(last?.totalTokens) ?? finiteToken(last?.total_tokens) ?? (input + output);
  const window = [
    tokenUsage.modelContextWindow, tokenUsage.model_context_window,
    params.modelContextWindow, params.model_context_window,
    fallbackWindow,
  ]
    .map(finiteToken)
    .find(value => value !== undefined && value > 0);
  if (!used || window === undefined) return undefined;
  return { used, size: window, breakdown: codexTokenBreakdown(last) };
}

/** A workbench event for a turn; `turnCreatedAt` is when the turn's run began, if a run is known. */
export function buildEvent(
  sessionId: string, turnCreatedAt: string | undefined, nativeId: string, turnId: string, runId: string | undefined,
  type: string, data: Record<string, unknown>, raw?: unknown,
): NativeWorkbenchEvent {
  return {
    sequence: 0,
    sessionId,
    ...(runId || turnId ? { runId: runId || turnId } : {}),
    type,
    data: { sessionUpdate: type, ...data },
    ...(raw ? { raw } : {}),
    createdAt: turnCreatedAt ?? new Date().toISOString(),
    nativeId,
    nativeTurnId: turnId,
  };
}

/** The id of a plan row read from a rollout: by turn when it names one, else by its position in the log. */
export function rolloutPlanNativeId(threadId: string, snapshot: { turnId?: string; ordinal?: number; timestamp: string }): string {
  const turnId = snapshot.turnId;
  return turnId
    ? codexPlanNativeId(threadId, turnId)
    : `${threadId}:rollout:${snapshot.ordinal ?? Date.parse(snapshot.timestamp)}:plan`;
}

/** The turn id an event belongs to: the one it states, or the one its native id carries. */
export function nativeTurnIdOf(event: NativeWorkbenchEvent, threadId: string | undefined): string | undefined {
  const prefix = `${threadId ?? 'unknown'}:`;
  return event.nativeTurnId ?? (event.nativeId.startsWith(prefix) ? event.nativeId.slice(prefix.length).split(':')[0] : undefined);
}
