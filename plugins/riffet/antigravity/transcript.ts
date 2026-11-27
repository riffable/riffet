import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { NativeJob, NativeWorkbenchEvent, ShareModelInfo, ShareSelection, ShareTurn, TaskNotificationStatus } from '@riffet/contracts';
import { AppError, activityEvent, clipDetail, toolImageContent } from '@riffet/plugin-api/kit';
import {
  type AgentHistory, type AgentHistoryOptions, type AgentHost, type AgentLaneWriter, type AgentTranscriptSource, type AgentTurnStatus, type AgentUsageRecord,
} from '@riffet/plugin-api/experimental/agent';
import { AGY_ID, agyRecord, type AgyRecord, type AgySnapshot } from './protocol.js';
import { readAgySnapshot } from './storage.js';

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const record = (value: unknown): AgyRecord => (agyRecord(value) ? value : {});
const number = (value: unknown): number | undefined => {
  const n = typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
};
const settled = (step: AgyRecord) => /_(?:DONE|ERROR|CANCELED|INTERRUPTED|CLEARED|INVALID)$/.test(text(step.status) ?? '');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Keep ordinary journal rows below its event limit. The native store retains full output.
function display(value: string): string {
  return Buffer.byteLength(value) <= 40_000
    ? value
    : Buffer.from(value)
        .subarray(0, 39_900)
        .toString('utf8')
        .replace(/\uFFFD$/, '') + '\n…';
}
function at(value: unknown, fallback = '1970-01-01T00:00:00.000Z'): string {
  const raw = text(value),
    ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback;
}
export function agyStepIdentity(snapshot: AgySnapshot, step: AgyRecord, index: number): string {
  const md = record(step.metadata),
    source = record(md.sourceTrajectoryStepInfo);
  const trajectory = text(source.trajectoryId),
    slot = number(source.stepIndex) ?? 0;
  if (trajectory && AGY_ID.test(trajectory)) return `${text(md.executionId) ?? 'system'}:${trajectory}:${slot}`;
  // Older injected system records omit source coordinates; execution and position still separate turns.
  return `${text(md.executionId) ?? snapshot.trajectoryId}:${index}`;
}
function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return {};
  try {
    return JSON.parse(value);
  } catch {
    return { arguments: value };
  }
}
function toolKind(name: string): string {
  if (/command|shell|terminal/.test(name)) return 'execute';
  if (/read|view|search|list|grep/.test(name)) return 'read';
  if (/write|edit|create|delete|move/.test(name)) return 'edit';
  return 'other';
}
function hiddenSystemMessage(system: AgyRecord | undefined): boolean {
  return system?.renderInfo?.hidden === true || system?.agentMessage?.hideFromUser === true;
}
function hiddenError(message: AgyRecord | undefined): boolean {
  return message?.shouldShowUser === false || (message?.shouldShowModel === true && message.shouldShowUser !== true);
}
function noticeStatus(step: AgyRecord): TaskNotificationStatus {
  const status = text(step.status) ?? '';
  if (/_(?:CANCELED|INTERRUPTED)$/.test(status)) return 'cancelled';
  if (step.errorMessage || step.error || /_(?:ERROR|INVALID)$/.test(status)) return 'failed';
  if (status.endsWith('_DONE')) return 'completed';
  if (/_(?:PENDING|RUNNING|GENERATING|WAITING|QUEUED)$/.test(status)) return 'running';
  return 'unknown';
}
function userError(step: AgyRecord): string | undefined {
  const message = step.errorMessage;
  if (hiddenError(message)) return;
  const nested = record(message?.error), top = record(step.error);
  const user = text(nested.userErrorMessage) || text(top.userErrorMessage);
  if (user) return user;
  if (agyRecord(message) && message.shouldShowUser !== true) return undefined;
  return text(nested.shortError) || text(top.shortError) || text(nested.fullError) || text(top.fullError);
}
function resultText(step: AgyRecord): string {
  if (agyRecord(step.errorMessage)) return userError(step) ?? '';
  const e = record(step.error);
  const failure = text(e.userErrorMessage) || text(e.shortError) || text(e.fullError);
  if (failure) return failure;
  if (agyRecord(step.notifyUser)) return text(step.notifyUser.notificationContent) ?? '';
  const generic = record(record(step.generic).result),
    command = record(step.runCommand),
    output = command.combinedOutput;
  if (typeof output === 'string') return output;
  if (agyRecord(output)) return text(output.full) ?? text(output.truncated) ?? '';
  if (text(generic.result) !== undefined) return generic.result;
  if (agyRecord(step.viewFile)) return text(step.viewFile.content) ?? text(step.viewFile.rawContent) ?? '';
  if (agyRecord(step.grepSearch)) return text(step.grepSearch.grepError) ?? text(step.grepSearch.rawOutput) ?? '';
  if (agyRecord(step.mcpTool)) return text(step.mcpTool.resultString) ?? '';
  const payload = Object.entries(step).find(
    ([key, value]) =>
      !['type', 'status', 'metadata', 'error', 'generic', 'permissions', 'completedInteractions'].includes(key) && agyRecord(value),
  );
  return payload ? JSON.stringify(payload[1], null, 2) : '';
}
interface MappedTurn {
  id: string;
  at: string;
  endedAt?: string;
  status?: AgentTurnStatus;
  error?: string;
  text?: string;
}
export interface MappedAgyTranscript {
  events: NativeWorkbenchEvent[];
  drafts: Array<{ finalId: string; event: NativeWorkbenchEvent }>;
  /** Unique `nativeId`s of `events` and `drafts` in snapshot step order. */
  order: string[];
  turns: MappedTurn[];
  children: Array<{ toolCallId: string; agentId: string; title?: string; prompt?: string; subagentType?: string; model?: string }>;
  usage: Array<{ runId?: string; usage: AgentUsageRecord }>;
  jobs: NativeJob[];
  warnings: string[];
}
/** Pure projection of one complete active branch. Client message IDs are associations, never dedupe keys. */
const mappedLive = new WeakMap<AgySnapshot, { sessionId: string; mapped: MappedAgyTranscript }>();
/**
 * `mapAgySnapshot` for the runtime's snapshot, mapped once however many readers a poll has. Only for snapshots
 * that are replaced and never edited in place, which holds for every stream frame and unary read.
 */
export function mapLiveSnapshot(snapshot: AgySnapshot, sessionId: string): MappedAgyTranscript {
  const cached = mappedLive.get(snapshot);
  if (cached?.sessionId === sessionId) return cached.mapped;
  const mapped = mapAgySnapshot(snapshot, sessionId);
  mappedLive.set(snapshot, { sessionId, mapped });
  return mapped;
}
export function mapAgySnapshot(snapshot: AgySnapshot, sessionId = ''): MappedAgyTranscript {
  const out: MappedAgyTranscript = { events: [], drafts: [], order: [], turns: [], children: [], usage: [], jobs: [], warnings: [] };
  const turns = new Map<string, MappedTurn>(),
    calls = new Set<string>(),
    ordered = new Set<string>();
  const noteOrder = (id: string) => {
    if (ordered.has(id)) return;
    ordered.add(id);
    out.order.push(id);
  };
  snapshot.steps.forEach((step, index) => {
    const md = record(step.metadata),
      baseId = agyStepIdentity(snapshot, step, index),
      turnId = text(md.executionId),
      createdAt = at(md.createdAt, at(snapshot.metadata?.createdAt));
    if (turnId && !turns.has(turnId)) turns.set(turnId, { id: turnId, at: createdAt });
    const turn = turnId ? turns.get(turnId) : undefined;
    const event = (
      part: string,
      type: string,
      data: Record<string, unknown>,
      final = settled(step),
      nativeId = `agy:${baseId}:${part}`,
    ) => {
      const value: NativeWorkbenchEvent = {
        sequence: 0,
        sessionId,
        type,
        data: { sessionUpdate: type, ...data },
        createdAt,
        nativeId,
        nativeAliases: [`agy:${baseId}`],
        ...(turnId ? { runId: turnId, nativeTurnId: turnId } : {}),
      };
      noteOrder(nativeId);
      if (final) out.events.push(value);
      else out.drafts.push({ finalId: nativeId, event: value });
    };
    const call = (raw: AgyRecord, final = true) => {
      const id = text(raw.id),
        name = text(raw.name);
      if (!id || !name || calls.has(id)) return;
      calls.add(id);
      const args = parseArguments(raw.argumentsJson),
        input = record(args);
      const description = text(input.toolSummary) ?? text(input.description);
      const rawInput =
        Buffer.byteLength(JSON.stringify(args)) > 40_000 ? { arguments: display(JSON.stringify(args)), truncated: true } : args;
      const subagent =
        name === 'invoke_subagent'
          ? {
              ...(description ? { description } : {}),
              ...(text(input.prompt) ? { prompt: input.prompt } : {}),
              ...(text(input.type_name) ? { type: input.type_name } : {}),
            }
          : undefined;
      event(
        'call',
        'tool_call',
        {
          toolCallId: id,
          toolName: name,
          title: display(description ?? name).slice(0, 240),
          kind: toolKind(name),
          status: 'in_progress',
          rawInput,
          ...(subagent ? { subagent } : {}),
        },
        final,
        `agy:tool:${id}:call`,
      );
    };
    const notice = (title: string | undefined, detail: string | undefined) => {
      const label = title?.trim() || detail?.trim();
      if (!label) return;
      const heading = clipDetail(label, 120);
      event('notice', 'task_notification', {
        kind: 'provider', status: noticeStatus(step), title: heading,
        ...(detail && detail !== heading ? { detail: clipDetail(detail) } : {}),
      }, settled(step), `antigravity:${baseId}:notice`);
    };
    if (agyRecord(step.systemMessage)) {
      // Only agy's presentation fields are for the reader. The message itself is a model-context envelope.
      const render = record(step.systemMessage.renderInfo);
      if (hiddenSystemMessage(step.systemMessage)) return;
      const blocks = Array.isArray(render.contentBlocks) ? render.contentBlocks.map(b => text(record(b).markdown)).filter(Boolean) : [];
      notice(text(render.title), blocks.length ? blocks.join('\n\n') : text(render.markdown));
    } else if (agyRecord(step.ephemeralMessage)) {
      return;
    } else if (agyRecord(step.userInput)) {
      const user = step.userInput,
        body = text(user.userResponse) ?? (Array.isArray(user.items) ? user.items.map(i => text(record(i).text) ?? '').join('\n') : '');
      if (turn && body) turn.text = body;
      const images = Array.isArray(user.images)
        ? user.images.slice(0, 4).map((i, n) => {
            const image = record(i),
              uri = text(image.uri),
              data = text(image.base64Data);
            return {
              name: text(image.caption) ?? `Image ${n + 1}`,
              type: 'image',
              ...(uri?.startsWith('file://') ? { path: uri.slice(7) } : {}),
              ...(text(image.mimeType) ? { mimeType: image.mimeType } : {}),
              ...(data ? { size: Buffer.byteLength(data, 'base64') } : {}),
            };
          })
        : [];
      const media = Array.isArray(user.media)
        ? user.media.slice(0, 4).map((i, n) => {
            const item = record(i),
              mimeType = text(item.mimeType),
              data = text(item.data);
            return {
              name: `Attachment ${n + 1}`,
              type: mimeType?.startsWith('image/') ? 'image' : 'file',
              ...(mimeType ? { mimeType } : {}),
              ...(data ? { size: Buffer.byteLength(data, 'base64') } : {}),
            };
          })
        : [];
      if (body || images.length || media.length)
        event('user', 'user_message_chunk', {
          content: { type: 'text', text: display(body) },
          ...(images.length || media.length ? { attachments: [...images, ...media] } : {}),
          ...(text(user.clientMessageId) ? { nativeMessageId: user.clientMessageId } : {}),
        });
    } else if (agyRecord(step.plannerResponse)) {
      const response = step.plannerResponse,
        messageId = text(response.messageId),
        prefix = `agy:${baseId}`;
      if (text(response.thinking)?.trim())
        event(
          'thinking',
          'agent_thought_chunk',
          { content: { type: 'text', text: display(response.thinking) }, channel: 'thinking' },
          settled(step),
          `${prefix}:thinking`,
        );
      const body = text(response.modifiedResponse) ?? text(response.response);
      if (body?.trim())
        event('answer', 'agent_message_chunk', { content: { type: 'text', text: display(body) } }, settled(step), `${prefix}:answer`);
      if (Array.isArray(response.toolCalls)) response.toolCalls.forEach(c => call(record(c), settled(step)));
      const u = record(md.modelUsage),
        input = number(u.inputTokens),
        cache = number(u.cacheReadTokens),
        output = number(u.outputTokens);
      if (settled(step) && (input !== undefined || output !== undefined))
        out.usage.push({
          ...(turnId ? { runId: turnId } : {}),
          usage: {
            stepId: `agy:${baseId}`,
            ...(text(record(md.modelInfo).chatModelName) ?? text(record(md.modelInfo).modelName)
              ? { model: text(record(md.modelInfo).chatModelName) ?? text(record(md.modelInfo).modelName) }
              : {}),
            nativeMessageId: messageId,
            startedAt: Date.parse(at(md.startedAt, createdAt)),
            ...(md.finishedGeneratingAt || md.completedAt ? { endedAt: Date.parse(at(md.finishedGeneratingAt ?? md.completedAt)) } : {}),
            ...(input !== undefined ? { inputTokens: input } : {}),
            ...(cache !== undefined ? { cacheReadTokens: cache } : {}),
            ...(number(u.cacheWriteTokens) !== undefined ? { cacheWriteTokens: number(u.cacheWriteTokens) } : {}),
            ...(output !== undefined ? { outputTokens: output } : {}),
            ...(number(u.thinkingOutputTokens) !== undefined ? { reasoningTokens: number(u.thinkingOutputTokens) } : {}),
            tokenSource: 'provider',
            window: 'transcript',
          },
        });
    } else {
      const rawCall = record(md.modifiedToolCall ?? md.toolCall ?? record(step.mcpTool).toolCall),
        id = text(rawCall.id);
      if (id) {
        call(rawCall);
        const exitCode = record(step.runCommand).exitCode;
        const failed =
          /_(?:ERROR|CANCELED|INTERRUPTED)$/.test(text(step.status) ?? '') ||
          !!step.error || !!step.errorMessage ||
          (typeof exitCode === 'number' && exitCode !== 0);
        const result = resultText(step),
          images = record(step.mcpTool).images ?? record(record(step.generic).result).media;
        const content: unknown[] = result ? [{ type: 'content', content: { type: 'text', text: display(result) } }] : [];
        if (Array.isArray(images))
          for (const i of images.slice(0, 4)) {
            const data = text(record(i).base64Data ?? record(i).data),
              mimeType = text(record(i).mimeType);
            // Output text and all inline images share the journal's 64KB row budget.
            const fits = data && Buffer.byteLength(JSON.stringify(content)) + data.length < 48_000;
            content.push(
              toolImageContent({ ...(fits ? { data } : {}), ...(data ? { bytes: Buffer.byteLength(data, 'base64') } : {}), mimeType }),
            );
          }
        event(
          'result',
          'tool_call_update',
          { toolCallId: id, status: settled(step) ? (failed ? 'failed' : 'completed') : 'in_progress', content },
          settled(step),
          `agy:tool:${id}:result`,
        );
        const invoke = record(step.invokeSubagent),
          results = Array.isArray(invoke.results)
            ? invoke.results
            : text(invoke.conversationId)
            ? [{ conversationId: invoke.conversationId }]
            : [];
        const specs = Array.isArray(invoke.subagents) ? invoke.subagents : [];
        if (results.length >= 1) {
          const ev =
            out.events.findLast(e => e.nativeId === `agy:tool:${id}:result`) ??
            out.drafts.findLast(e => e.finalId === `agy:tool:${id}:result`)?.event;
          results.forEach((rawResult, idx) => {
            const childId = text(record(rawResult).conversationId),
              spec = record(specs[idx]);
            if (!childId || !AGY_ID.test(childId) || childId === snapshot.conversationId) return;
            const child = {
              toolCallId: idx === 0 ? id : `${id}:${idx}`,
              agentId: childId,
              ...(text(spec.role) ? { title: spec.role } : {}),
              ...(text(spec.initialPrompt) ? { prompt: spec.initialPrompt } : {}),
              ...(text(spec.typeName) ? { subagentType: spec.typeName } : {}),
              ...(text(spec.modelOption) ? { model: spec.modelOption } : {}),
            };
            out.children.push(child);
            if (ev && !ev.data.subagentResult) ev.data.subagentResult = { agentId: childId };
          });
        }
        const command = record(step.runCommand),
          genericArgs = record(record(step.generic).args),
          commandLine =
            text(command.commandLine) ??
            (text(rawCall.name) === 'run_command' ? text(genericArgs.CommandLine ?? genericArgs.command) : undefined);
        if (commandLine && (!settled(step) || command.blocking === false || text(command.commandId)))
          out.jobs.push({
            toolCallId: id,
            ...(text(command.commandId) ? { id: command.commandId } : {}),
            title: commandLine.slice(0, 120),
            command: commandLine,
            status: !settled(step)
              ? 'running'
              : command.blocking === false && command.exitCode === undefined
              ? 'unknown'
              : failed
              ? 'failed'
              : 'succeeded',
            startedAt: at(md.startedAt, createdAt),
            ...(typeof command.exitCode === 'number' ? { exitCode: command.exitCode } : {}),
            ...(result ? { output: display(result) } : {}),
          });
      } else if (agyRecord(step.checkpoint)) {
        const summary = text(step.checkpoint.sessionSummary) ?? '';
        const activity = activityEvent(
          sessionId,
          {
            id: `antigravity:${baseId}:compaction`,
            kind: 'compaction',
            status: settled(step) ? (step.checkpoint.modelSummarizationFailed ? 'failed' : 'completed') : 'running',
            title: 'Compaction',
            ...(summary ? { detail: clipDetail(summary) } : {}),
            startedAt: createdAt,
            ...(settled(step) ? { endedAt: at(md.completedAt, createdAt) } : {}),
          },
          { createdAt, ...(turnId ? { runId: turnId, nativeTurnId: turnId } : {}) },
        );
        noteOrder(activity.nativeId);
        if (settled(step)) out.events.push(activity);
        else out.drafts.push({ finalId: activity.nativeId, event: activity });
      } else if (step.errorMessage || step.error) {
        notice(undefined, userError(step));
      } else if (agyRecord(step.notifyUser)) {
        notice(undefined, text(step.notifyUser.notificationContent));
      } else {
        out.warnings.push(`Unmapped Antigravity step ${text(step.type) ?? index}.`);
      }
    }
  });
  for (const executor of snapshot.executors) {
    const id = text(executor.executionId),
      turn = id ? turns.get(id) : undefined;
    if (!turn) continue;
    const reason = text(executor.terminationReason) ?? '';
    // An executor carries a reason only once it has ended; every reason other than UNSPECIFIED ends its turn.
    // CHAINED and EARLY_CONTINUE hand on to a new execution, which maps as its own turn. A reason this
    // mapping does not know still ends the turn, as interrupted, rather than leaving a run that never settles.
    if (!reason || reason.endsWith('_UNSPECIFIED')) continue;
    const state: AgentTurnStatus = reason.endsWith('_ERROR')
      ? 'failed'
      : reason.endsWith('_USER_CANCELED')
      ? 'cancelled'
      : /_(?:NO_TOOL_CALL|TERMINAL_STEP_TYPE|TERMINAL_CUSTOM_HOOK|INJECTED_RESPONSE|CHAINED|EARLY_CONTINUE)$/.test(reason)
      ? 'completed'
      : 'interrupted';
    const last = number(executor.lastStepIdx) ?? 0,
      step = snapshot.steps[last],
      md = record(step?.metadata);
    // Frames can carry the executor before its last step; the end time then waits for a later frame, the end does not.
    const own = step && text(md.executionId) === id;
    turn.status = state;
    turn.endedAt = own ? at(md.completedAt ?? md.finishedGeneratingAt ?? md.createdAt, turn.at) : turn.at;
    if (text(executor.executionError)) turn.error = executor.executionError;
  }
  out.turns = [...turns.values()];
  return out;
}

interface Cursor {
  version: 1;
  conversationId: string;
  events: Array<[string, string]>;
  drafts: Array<[string, string]>;
  turns: Array<[string, string]>;
  children: Array<[string, string]>;
  order?: string[];
  retired?: string[];
  settled?: Array<[string, string]>;
}
interface ExternalTurnEnd {
  turnId: string;
  status: AgentTurnStatus;
  at: string;
  error?: string;
}
function stringList(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length <= 400_000 && value.every(i => typeof i === 'string'));
}
function pairList(value: unknown, optional = false): boolean {
  if (optional && value === undefined) return true;
  return (
    Array.isArray(value) &&
    value.length <= 400_000 &&
    value.every((entry: unknown) => Array.isArray(entry) && entry.length === 2 && entry.every(i => typeof i === 'string'))
  );
}
function cursor(raw: string | null): Cursor | undefined {
  if (!raw) return undefined;
  if (raw.length > 32 * 1024 * 1024) throw new Error('Antigravity transcript cursor exceeds limit');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Invalid Antigravity transcript cursor');
  }
  const c = record(value);
  if (
    c.version !== 1 ||
    !AGY_ID.test(c.conversationId) ||
    !['events', 'drafts', 'turns', 'children'].every(key => pairList(c[key])) ||
    !pairList(c.settled, true) ||
    !stringList(c.order) ||
    !stringList(c.retired)
  )
    throw new Error('Invalid Antigravity transcript cursor');
  return c as Cursor;
}
function turnFingerprint(turnId: string, mapped: MappedAgyTranscript): string {
  const turn = mapped.turns.find(t => t.id === turnId);
  const events = mapped.events.filter(e => e.nativeTurnId === turnId);
  const drafts = mapped.drafts.filter(d => d.event.nativeTurnId === turnId);
  return digest({ turn, events, drafts });
}
function needsIdentityRebuild(
  previous: Cursor,
  order: readonly string[],
  effectiveEventIds: ReadonlySet<string>,
): boolean {
  const prevCommittedOrder = (previous.order ?? previous.events.map(([id]) => id)).filter(id =>
    previous.events.some(([evId]) => evId === id),
  );
  const prevCommittedIndex = new Map(prevCommittedOrder.map((id, index) => [id, index]));
  const prevRetired = new Set(previous.retired);
  let lastCommitted = -1;
  let seenNewCommitted = false;
  for (const id of order) {
    if (prevRetired.has(id)) return true;
    if (!effectiveEventIds.has(id)) continue;
    const idx = prevCommittedIndex.get(id);
    if (idx === undefined) {
      // A newly committed row (including a former draft or late-arriving sibling) is safe at the tail;
      // if an already-committed row follows it, Journal rev=1 order would diverge without a rebuild.
      seenNewCommitted = true;
    } else {
      if (seenNewCommitted || idx < lastCommitted) return true;
      lastCommitted = idx;
    }
  }
  return false;
}
function apply(w: AgentLaneWriter, snapshot: AgySnapshot, mapped: MappedAgyTranscript, externalEnd?: ExternalTurnEnd): boolean {
  let previous = cursor(w.cursor);
  if (previous && previous.conversationId !== snapshot.conversationId) {
    w.rebuild('identity-changed');
    previous = undefined;
  }
  const buildEffective = (prev: Cursor | undefined) => {
    const oldTurns = new Map(prev?.turns),
      oldSettled = new Map(prev?.settled);
    const retainedSettled = new Map<string, string>();
    const nextSettled: Array<[string, string]> = [];
    const effectiveTurns: MappedTurn[] = mapped.turns.map(t => {
      if (externalEnd && externalEnd.turnId === t.id && !t.status) {
        nextSettled.push([t.id, turnFingerprint(t.id, mapped)]);
        return {
          ...t,
          status: externalEnd.status,
          endedAt: externalEnd.at,
          ...(externalEnd.error ? { error: externalEnd.error } : {}),
        };
      }
      if (!t.status && oldSettled.has(t.id) && oldTurns.has(t.id)) {
        const savedFp = oldSettled.get(t.id)!;
        if (turnFingerprint(t.id, mapped) === savedFp) {
          retainedSettled.set(t.id, savedFp);
          nextSettled.push([t.id, savedFp]);
        }
      }
      return t;
    });
    // D1: promote any remaining drafts of an ending turn before turnEnded so partial output is never dropped.
    const endedTurnIds = new Set<string>(retainedSettled.keys());
    for (const t of effectiveTurns) if (t.status !== undefined) endedTurnIds.add(t.id);
    const effectiveEvents: NativeWorkbenchEvent[] = [...mapped.events];
    const effectiveDrafts: MappedAgyTranscript['drafts'] = [];
    for (const d of mapped.drafts) {
      if (d.event.nativeTurnId && endedTurnIds.has(d.event.nativeTurnId)) effectiveEvents.push(d.event);
      else effectiveDrafts.push(d);
    }
    return { oldTurns, retainedSettled, nextSettled, effectiveTurns, effectiveEvents, effectiveDrafts };
  };
  let state = buildEffective(previous);
  if (previous && needsIdentityRebuild(previous, mapped.order, new Set(state.effectiveEvents.map(e => e.nativeId)))) {
    w.rebuild('identity-changed');
    previous = undefined;
    state = buildEffective(undefined);
  }
  const oldEvents = new Map(previous?.events),
    oldDrafts = new Map(previous?.drafts);
  const { oldTurns, retainedSettled, nextSettled, effectiveTurns, effectiveEvents, effectiveDrafts } = state;
  const eventDigests = new Map<string, string>();
  const events: Array<[string, string]> = effectiveEvents.map(e => {
    const hash = digest(e);
    eventDigests.set(e.nativeId, hash);
    return [e.nativeId, hash];
  });
  const draftDigests = new Map<string, string>();
  const drafts: Array<[string, string]> = effectiveDrafts.map(d => {
    const hash = digest(d.event);
    draftDigests.set(d.finalId, hash);
    return [d.finalId, hash];
  });
  const turnDigests = new Map<string, string>();
  const turns: Array<[string, string]> = effectiveTurns.map(t => {
    const hash = retainedSettled.has(t.id) ? oldTurns.get(t.id)! : digest(t);
    turnDigests.set(t.id, hash);
    return [t.id, hash];
  });
  const children = mapped.children.map(c => [c.toolCallId, c.agentId] as [string, string]);
  const currentIds = new Set([...events, ...drafts].map(([id]) => id)),
    turnIds = new Set(turns.map(([id]) => id));
  const retire: string[] = [];
  const retiredContent = new Set(previous?.retired);
  for (const [id] of previous?.turns ?? []) if (!turnIds.has(id)) retire.push(`meta:turn:${id}:ended`, `meta:turn:${id}:started`);
  for (const [id] of [...(previous?.events ?? []), ...(previous?.drafts ?? [])]) {
    if (!currentIds.has(id)) {
      retire.push(id);
      retiredContent.add(id);
    }
  }
  const next: Cursor = {
      version: 1,
      conversationId: snapshot.conversationId,
      events,
      drafts,
      turns,
      children,
      order: mapped.order,
      ...(retiredContent.size ? { retired: [...retiredContent] } : {}),
      ...(nextSettled.length ? { settled: nextSettled } : {}),
    },
    encoded = JSON.stringify(next);
  if (previous && encoded === w.cursor) return false;
  const changedEvents = new Map(effectiveEvents.filter(e => oldEvents.get(e.nativeId) !== eventDigests.get(e.nativeId)).map(e => [e.nativeId, e]));
  const changedDrafts = new Map(effectiveDrafts.filter(d => oldDrafts.get(d.finalId) !== draftDigests.get(d.finalId)).map(d => [d.finalId, d]));
  const turnById = new Map(effectiveTurns.map(t => [t.id, t]));
  const lastIndexByTurn = new Map<string, number>();
  mapped.order.forEach((id, index) => {
    const turnId = (changedEvents.get(id) ?? changedDrafts.get(id)?.event)?.nativeTurnId;
    if (turnId && turnById.has(turnId)) lastIndexByTurn.set(turnId, index);
  });
  const run = () => {
    for (const [id, child] of previous?.children ?? [])
      if (!children.some(([call, agent]) => call === id && agent === child)) w.retireSubagent(id);
    // Retire first; retain end-before-start ordering for wholly removed turns.
    if (retire.length) w.commit({ events: [], retire: [...new Set(retire)], cursor: w.cursor });
    const startedTurns = new Set<string>(),
      endedTurns = new Set<string>();
    let pendingEvents: NativeWorkbenchEvent[] = [],
      pendingDrafts: MappedAgyTranscript['drafts'] = [];
    const flushPending = () => {
      if (!pendingEvents.length && !pendingDrafts.length) return;
      w.commit({ events: pendingEvents, drafts: pendingDrafts, cursor: w.cursor });
      pendingEvents = [];
      pendingDrafts = [];
    };
    const openTurn = (t: MappedTurn) => {
      if (startedTurns.has(t.id)) return;
      startedTurns.add(t.id);
      if (oldTurns.get(t.id) === turnDigests.get(t.id)) return;
      flushPending();
      if (!t.status && w.turnEndStatus(t.id)) w.turnReopened(t.id, t.at);
      w.turnStarted(t.id, t.at);
    };
    mapped.order.forEach((id, index) => {
      const ev = changedEvents.get(id),
        dr = changedDrafts.get(id);
      if (!ev && !dr) return;
      const turnId = (ev ?? dr!.event).nativeTurnId,
        turn = turnId ? turnById.get(turnId) : undefined;
      if (turn) openTurn(turn);
      // Keep events and drafts strictly in snapshot order since commit() appends events before drafts.
      if (ev) {
        if (pendingDrafts.length) flushPending();
        pendingEvents.push(ev);
      } else if (dr) {
        if (pendingEvents.length) flushPending();
        pendingDrafts.push(dr);
      }
      if (turn && lastIndexByTurn.get(turn.id) === index && oldTurns.get(turn.id) !== turnDigests.get(turn.id) && turn.status) {
        flushPending();
        w.turnEnded(turn.id, turn.status, turn.endedAt ?? turn.at, turn.error);
        endedTurns.add(turn.id);
      }
    });
    flushPending();
    for (const t of effectiveTurns) {
      if (oldTurns.get(t.id) === turnDigests.get(t.id)) continue;
      openTurn(t);
      if (!endedTurns.has(t.id) && t.status) w.turnEnded(t.id, t.status, t.endedAt ?? t.at, t.error);
    }
    // Persist the cursor after lifecycle marks; a crash before this point replays idempotently.
    w.commit({ events: [], cursor: encoded });
  };
  if (w.transaction) w.transaction(run);
  else run();
  return true;
}
/** Size and change time of a conversation's database and its WAL: agy writes go through the WAL first. */
function storeSignature(geminiDir: string, id: string): string {
  const base = join(geminiDir, 'antigravity-cli', 'conversations', `${id}.db`);
  return ['', '-wal']
    .map(suffix => {
      const info = statSync(base + suffix, { throwIfNoEntry: false, bigint: true });
      return info ? `${info.size}:${info.mtimeNs}:${info.ino}` : '-';
    })
    .join('|');
}
export interface AntigravityTranscriptOptions {
  sessionId: string;
  nativeId: () => string | undefined;
  geminiDir: () => string;
  live: () => AgySnapshot | undefined;
  watch: (wake: () => void) => () => void;
  host?: AgentHost;
}
const GENERIC_COMPATIBLE_TYPES = new Set([
  'CORTEX_STEP_TYPE_RUN_COMMAND',
  'CORTEX_STEP_TYPE_ASK_QUESTION',
  'CORTEX_STEP_TYPE_INVOKE_SUBAGENT',
  'CORTEX_STEP_TYPE_CODE_ACTION',
  'CORTEX_STEP_TYPE_VIEW_FILE',
]);

function compatibleStepType(persistedType: unknown, liveType: unknown): boolean {
  if (!liveType || persistedType === liveType) return true;
  if (persistedType === 'CORTEX_STEP_TYPE_GENERIC' && typeof liveType === 'string' && GENERIC_COMPATIBLE_TYPES.has(liveType)) {
    return true;
  }
  if (liveType === 'CORTEX_STEP_TYPE_GENERIC' && typeof persistedType === 'string' && GENERIC_COMPATIBLE_TYPES.has(persistedType)) {
    return true;
  }
  return false;
}

/** The TUI and the conversation view share one native store and one journal lane. */
export class AntigravityTranscriptSource implements AgentTranscriptSource {
  private static readonly CACHE_LIMIT = 64;
  private static readonly CHILD_SIG_LIMIT = 128;
  private lastStatsId?: string;
  private readonly cache = new Map<string, { signature: string; snapshot: AgySnapshot | undefined }>();
  private readonly childSignatures = new Map<
    string,
    { signature: string; laneGeneration: string; children: MappedAgyTranscript['children'] }
  >();
  constructor(private readonly options: AntigravityTranscriptOptions) {}
  identity(): string | undefined {
    const id = this.options.nativeId();
    return id ? `antigravity:${id}` : undefined;
  }
  private readSnapshot(id: string): AgySnapshot | undefined {
    const live = this.options.live();
    if (live && live.conversationId !== id) throw new Error('Antigravity live snapshot belongs to another conversation');
    const persisted = this.stored(id, Boolean(live));
    let snapshot = live ?? persisted;
    if (!snapshot) return undefined;
    if (live && persisted) {
      // Stream projection sometimes removes signature-bearing tool-call envelopes.
      // Hydrate only steps whose original source coordinates still match the active branch.
      const stored = new Map(persisted.steps.map((s, i) => [agyStepIdentity(persisted, s, i), s]));
      // The store decoder pins agy's field numbers. A step whose copies disagree on type means a newer agy moved
      // fields, so none of the store is trusted for this read; the live copy alone is still correct.
      const agrees = live.steps.every((s, i) => {
        const p = stored.get(agyStepIdentity(live, s, i));
        return !p || compatibleStepType(p.type, s.type);
      });
      if (agrees) {
        snapshot = {
          ...live,
          steps: live.steps.map((s, i) => {
            const p = stored.get(agyStepIdentity(live, s, i));
            if (!p) return s;
            const md = { ...record(p.metadata), ...record(s.metadata) };
            return {
              ...p,
              ...s,
              metadata: md,
              // A partial stream frame must not publish a hidden message or drop persisted renderInfo.
              ...(agyRecord(p.systemMessage) && agyRecord(s.systemMessage)
                ? { systemMessage: hiddenSystemMessage(p.systemMessage) ? p.systemMessage : { ...p.systemMessage, ...s.systemMessage } }
                : hiddenSystemMessage(p.systemMessage)
                ? { systemMessage: p.systemMessage }
                : {}),
              ...(hiddenError(p.errorMessage) ? { errorMessage: p.errorMessage } : {}),
              ...(agyRecord(s.plannerResponse) ? { plannerResponse: { ...record(p.plannerResponse), ...s.plannerResponse } } : {}),
            };
          }),
        };
      }
    }
    return snapshot;
  }
  async pull(w: AgentLaneWriter, signal: AbortSignal): Promise<{ caughtUp: boolean }> {
    if (signal.aborted) return { caughtUp: false };
    const id = this.options.nativeId();
    // Nothing on disk yet (no native conversation before the first message) is all of it: `caughtUp: false`
    // has the host pull again at once, which spins the event loop for as long as agy takes to start.
    if (!id) return { caughtUp: true };
    const snapshot = this.readSnapshot(id);
    if (!snapshot) return { caughtUp: true };
    const mapped = mapAgySnapshot(snapshot, this.options.sessionId);
    const firstPull = this.lastStatsId !== id;
    const changed = apply(w, snapshot, mapped);
    if (changed || firstPull) {
      this.lastStatsId = id;
      this.stats(mapped);
    }
    const seen = new Set<string>([id]);
    await this.children(w, mapped, seen, signal);
    return { caughtUp: !signal.aborted };
  }
  async settleTurnEnd(w: AgentLaneWriter, end: ExternalTurnEnd): Promise<boolean> {
    const id = this.options.nativeId();
    if (!id) return false;
    const snapshot = this.readSnapshot(id);
    if (!snapshot) return false;
    const target = w.scratch ?? w;
    const mapped = mapAgySnapshot(snapshot, this.options.sessionId);
    if (!mapped.turns.some(t => t.id === end.turnId)) return false;
    const changed = apply(target, snapshot, mapped, end);
    if (changed) {
      this.lastStatsId = id;
      this.stats(mapped);
    }
    return true;
  }
  /**
   * The stored conversation, decoded again only when its database files change: while agy streams a step the
   * store is untouched, and every stream frame wakes a pull. With a live snapshot the store only fills in
   * signature envelopes, so a record it refuses must not take the live view down with it.
   */
  private stored(id: string, hasLive: boolean): AgySnapshot | undefined {
    const signature = storeSignature(this.options.geminiDir(), id);
    const cached = this.cache.get(id);
    if (cached?.signature === signature) {
      this.cache.delete(id);
      this.cache.set(id, cached);
      return cached.snapshot;
    }
    let snapshot: AgySnapshot | undefined;
    try {
      snapshot = readAgySnapshot(this.options.geminiDir(), id);
    } catch (error) {
      this.cache.delete(id);
      if (!hasLive) throw error;
      return undefined;
    }
    this.cache.delete(id);
    if (this.cache.size >= AntigravityTranscriptSource.CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(id, { signature, snapshot });
    return snapshot;
  }
  private stats(mapped: MappedAgyTranscript): void {
    const host = this.options.host;
    if (!host) return;
    host.stats.observeEvents(this.options.sessionId, mapped.events);
    for (const item of mapped.usage) host.stats.recordUsage(this.options.sessionId, item.runId, item.usage);
    for (const job of mapped.jobs) host.emit(this.options.sessionId, { type: 'job', job });
  }
  private hasChangedDescendant(generation: string, children: MappedAgyTranscript['children'], seen: Set<string>): boolean {
    const geminiDir = this.options.geminiDir();
    for (const child of children) {
      if (seen.has(child.agentId) || seen.size >= 128) continue;
      seen.add(child.agentId);
      const key = `${generation}:${child.toolCallId}:${child.agentId}`;
      const prev = this.childSignatures.get(key);
      const sig = storeSignature(geminiDir, child.agentId);
      if (!prev || prev.signature !== sig) return true;
      if (prev.children.length && this.hasChangedDescendant(prev.laneGeneration, prev.children, seen)) return true;
    }
    return false;
  }
  private recordChildSignature(
    key: string,
    value: { signature: string; laneGeneration: string; children: MappedAgyTranscript['children'] },
  ): void {
    this.childSignatures.delete(key);
    if (this.childSignatures.size >= AntigravityTranscriptSource.CHILD_SIG_LIMIT) {
      const oldest = this.childSignatures.keys().next().value;
      if (oldest !== undefined) this.childSignatures.delete(oldest);
    }
    this.childSignatures.set(key, value);
  }
  private async children(w: AgentLaneWriter, mapped: MappedAgyTranscript, seen: Set<string>, signal: AbortSignal): Promise<void> {
    const geminiDir = this.options.geminiDir();
    const parentId = mappedParent(w);
    for (const child of mapped.children) {
      if (signal.aborted || seen.has(child.agentId) || seen.size >= 128) continue;
      seen.add(child.agentId);
      const sigKey = `${w.generation}:${child.toolCallId}:${child.agentId}`;
      const sig = storeSignature(geminiDir, child.agentId);
      const prev = this.childSignatures.get(sigKey);
      if (prev && prev.signature === sig) {
        if (!prev.children.length || !this.hasChangedDescendant(prev.laneGeneration, prev.children, new Set(seen))) continue;
      }
      let snapshot: AgySnapshot | undefined;
      try {
        snapshot = this.stored(child.agentId, false);
      } catch {
        continue;
      }
      if (!snapshot) continue;
      // Child IDs alone are not authority: verify the native parent linkage in this private root.
      if (snapshot.metadata?.parentConversationId !== parentId) continue;
      const lane = w.child(child.toolCallId, child.agentId, child),
        data = mapAgySnapshot(snapshot, this.options.sessionId);
      const changed = apply(lane, snapshot, data);
      this.recordChildSignature(sigKey, { signature: sig, laneGeneration: lane.generation, children: data.children });
      if (changed || !prev) {
        this.stats({ ...data, usage: data.usage.map(u => ({ ...u, usage: { ...u.usage, agentKind: 'subagent' } })) });
      }
      await this.children(lane, data, seen, signal);
    }
  }
  watch(_w: AgentLaneWriter, wake: () => void): () => void {
    return this.options.watch(wake);
  }
  async drain(w: AgentLaneWriter): Promise<void> {
    await this.pull(w, new AbortController().signal);
  }
}
function mappedParent(w: AgentLaneWriter): string | undefined {
  return cursor(w.cursor)?.conversationId;
}
function chooseTurns(turns: ShareTurn[], selection?: ShareSelection): string[] {
  if (!selection || selection.mode === 'all') return turns.map(turn => turn.id);
  if (selection.mode === 'recent') {
    if (!Number.isSafeInteger(selection.count) || selection.count < 1) {
      throw new AppError('SHARE_SELECTION_INVALID', 'The number of shared turns is invalid', 400, undefined, { reason: 'count' });
    }
    return turns.slice(-selection.count).map(turn => turn.id);
  }
  const ids = new Set(selection.turnIds),
    known = new Set(turns.map(turn => turn.id));
  if (!ids.size || [...ids].some(id => !known.has(id))) {
    throw new AppError('SHARE_SELECTION_INVALID', 'The selected messages changed; select them again', 409, undefined, { reason: 'changed' });
  }
  return turns.filter(turn => ids.has(turn.id)).map(turn => turn.id);
}
/** Stored history for search/shares. This path never launches a native runtime. */
export function readAgyHistory(
  geminiDir: string,
  conversationId: string,
  sessionId = '',
  options?: AgentHistoryOptions,
): AgentHistory {
  options?.signal?.throwIfAborted();
  const snapshot = readAgySnapshot(geminiDir, conversationId);
  options?.signal?.throwIfAborted();
  if (!snapshot) throw new Error('Antigravity history is unavailable');
  const mapped = mapAgySnapshot(snapshot, sessionId);
  const turns: ShareTurn[] = mapped.turns.filter(t => t.text !== undefined).map(t => ({ id: t.id, text: t.text!, createdAt: t.at }));
  const selectedTurnIds = chooseTurns(turns, options?.selection);
  if (options?.catalogOnly) return { events: [], subagents: [], turns, selectedTurnIds };
  const selectedSet = options?.selection && options.selection.mode !== 'all' ? new Set(selectedTurnIds) : undefined;
  const filteredEvents = selectedSet
    ? mapped.events.filter(e => e.nativeTurnId !== undefined && selectedSet.has(e.nativeTurnId))
    : mapped.events;
  const keptCalls = selectedSet
    ? new Set(filteredEvents.map(e => text(e.data.toolCallId)).filter((callId): callId is string => Boolean(callId)))
    : undefined;
  const rootChildren = keptCalls
    ? mapped.children.filter(child => {
        const baseCallId = child.toolCallId.includes(':') ? child.toolCallId.slice(0, child.toolCallId.lastIndexOf(':')) : child.toolCallId;
        return keptCalls.has(child.toolCallId) || keptCalls.has(baseCallId);
      })
    : mapped.children;
  const filteredJobs = keptCalls ? mapped.jobs.filter(job => Boolean(job.toolCallId && keptCalls.has(job.toolCallId))) : mapped.jobs;
  const answerIds = new Set(filteredEvents.filter(e => e.type === 'agent_message_chunk').map(e => e.nativeId));
  const modelInfo: Record<string, ShareModelInfo> = Object.create(null);
  const turnModels: Record<string, ShareModelInfo> = Object.create(null);
  const ambiguousModelTurns = new Set<string>();
  const noteModel = (stepId: string, turnId: string | undefined, model: string | undefined) => {
    if (!model) return;
    if (selectedSet && (!turnId || !selectedSet.has(turnId))) return;
    const info: ShareModelInfo = { model, source: 'history' };
    const answerId = `${stepId}:answer`;
    if (answerIds.has(answerId)) modelInfo[answerId] = info;
    if (turnId && !ambiguousModelTurns.has(turnId)) {
      if (turnModels[turnId] && turnModels[turnId].model !== model) {
        delete turnModels[turnId];
        ambiguousModelTurns.add(turnId);
      } else {
        turnModels[turnId] = info;
      }
    }
  };
  for (const item of mapped.usage) noteModel(item.usage.stepId, item.runId, item.usage.model);
  snapshot.steps.forEach((step, index) => {
    if (!agyRecord(step.plannerResponse) || !settled(step)) return;
    const md = record(step.metadata);
    const model = text(record(md.modelInfo).chatModelName) ?? text(record(md.modelInfo).modelName);
    noteModel(`agy:${agyStepIdentity(snapshot, step, index)}`, text(md.executionId), model);
  });
  const subagents: AgentHistory['subagents'] = [];
  const warnings = [...mapped.warnings];
  if (!options?.messagesOnly) {
    const seen = new Set([conversationId]);
    const visit = (children: MappedAgyTranscript['children'], parent: string) => {
      for (const child of children) {
        options?.signal?.throwIfAborted();
        if (seen.has(child.agentId) || seen.size >= 128) continue;
        seen.add(child.agentId);
        let s: AgySnapshot | undefined;
        try {
          s = readAgySnapshot(geminiDir, child.agentId);
        } catch {
          options?.signal?.throwIfAborted();
          warnings.push(`Subagent ${child.agentId} history is unavailable.`);
          continue;
        }
        if (!s || s.metadata?.parentConversationId !== parent) continue;
        const m = mapAgySnapshot(s, sessionId);
        subagents.push({ ...child, events: m.events.map(({ sequence: _sequence, sessionId: _session, raw: _raw, ...event }) => event) });
        visit(m.children, child.agentId);
      }
    };
    visit(rootChildren, conversationId);
  }
  return {
    events: filteredEvents.map(({ sequence: _sequence, sessionId: _session, raw: _raw, ...event }) => event),
    ...(Object.keys(modelInfo).length ? { modelInfo } : {}),
    ...(Object.keys(turnModels).length ? { turnModels } : {}),
    ...(ambiguousModelTurns.size ? { ambiguousModelTurns: [...ambiguousModelTurns] } : {}),
    subagents,
    ...(filteredJobs.length ? { jobs: filteredJobs } : {}),
    ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}),
    turns,
    selectedTurnIds,
  };
}
