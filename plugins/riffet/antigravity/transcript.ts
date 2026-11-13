import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { NativeJob, NativeWorkbenchEvent } from '@riffet/contracts';
import { activityEvent, clipDetail, toolImageContent } from '@riffet/plugin-api/kit';
import {
  type AgentHistory, type AgentHost, type AgentLaneWriter, type AgentTranscriptSource, type AgentTurnStatus, type AgentUsageRecord,
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
function resultText(step: AgyRecord): string {
  const e = record(step.error);
  const failure = text(e.userErrorMessage) ?? text(e.shortError) ?? text(e.fullError) ?? text(e.modelErrorMessage);
  if (failure) return failure;
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
  const out: MappedAgyTranscript = { events: [], drafts: [], turns: [], children: [], usage: [], jobs: [], warnings: [] };
  const turns = new Map<string, MappedTurn>(),
    calls = new Set<string>();
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
      if (final) out.events.push(value);
      else out.drafts.push({ finalId: nativeId, event: value });
    };
    const call = (raw: AgyRecord) => {
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
        true,
        `agy:tool:${id}:call`,
      );
    };
    if (agyRecord(step.userInput)) {
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
        prefix = messageId ? `agy:message:${turnId ?? baseId}:${messageId}` : `agy:${baseId}`;
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
      if (Array.isArray(response.toolCalls)) response.toolCalls.forEach(c => call(record(c)));
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
            // Cache inclusion differs by gateway. Keep input unreported when cached
            // tokens exist until that gateway's native accounting has been verified.
            ...(input !== undefined && !cache ? { inputTokens: input } : {}),
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
          !!step.error ||
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
        if (results.length === 1) {
          const childId = text(record(results[0]).conversationId),
            spec = record(specs[0]);
          if (childId && AGY_ID.test(childId) && childId !== snapshot.conversationId) {
            const child = {
              toolCallId: id,
              agentId: childId,
              ...(text(spec.role) ? { title: spec.role } : {}),
              ...(text(spec.initialPrompt) ? { prompt: spec.initialPrompt } : {}),
              ...(text(spec.typeName) ? { subagentType: spec.typeName } : {}),
              ...(text(spec.modelOption) ? { model: spec.modelOption } : {}),
            };
            out.children.push(child);
            const ev =
              out.events.findLast(e => e.nativeId === `agy:tool:${id}:result`) ??
              out.drafts.findLast(e => e.finalId === `agy:tool:${id}:result`)?.event;
            if (ev) ev.data.subagentResult = { agentId: childId };
          }
        } else if (results.length > 1)
          out.warnings.push('Antigravity returned multiple subagents for one tool call; nested history is unavailable.');
        const command = record(step.runCommand),
          commandLine = text(command.commandLine);
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
        if (settled(step)) out.events.push(activity);
        else out.drafts.push({ finalId: activity.nativeId, event: activity });
      } else {
        const system = text(record(step.systemMessage).message) ?? text(record(step.ephemeralMessage).content);
        const err = record(record(step.errorMessage).error ?? step.error);
        const message = system ?? text(err.userErrorMessage) ?? text(err.shortError) ?? text(err.fullError);
        if (message) {
          // Local native notices are visible activities and never masquerade as model responses.
          const activity = activityEvent(
            sessionId,
            {
              id: `antigravity:${baseId}:notice`,
              kind: 'local_command',
              status: step.errorMessage || step.error ? 'failed' : 'completed',
              title: clipDetail(message, 120),
              detail: clipDetail(message),
              startedAt: createdAt,
            },
            { createdAt, ...(turnId ? { runId: turnId, nativeTurnId: turnId } : {}) },
          );
          out.events.push(activity);
        } else {
          const kind = text(step.type) ?? String(index);
          out.warnings.push(`Unmapped Antigravity step ${kind}.`);
          // Keep a visible placeholder when a native format grows a new non-tool payload.
          out.events.push(
            activityEvent(
              sessionId,
              {
                id: `antigravity:${baseId}:notice`,
                kind: 'local_command',
                status: settled(step)
                  ? /_(?:ERROR|CANCELED|INTERRUPTED)$/.test(text(step.status) ?? '')
                    ? 'failed'
                    : 'completed'
                  : 'unknown',
                title: kind.replace(/^CORTEX_STEP_TYPE_/, ''),
                startedAt: createdAt,
              },
              { createdAt, ...(turnId ? { runId: turnId, nativeTurnId: turnId } : {}) },
            ),
          );
        }
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
    !['events', 'drafts', 'turns', 'children'].every(
      key =>
        Array.isArray(c[key]) &&
        c[key].length <= 400_000 &&
        c[key].every((entry: unknown) => Array.isArray(entry) && entry.length === 2 && entry.every(i => typeof i === 'string')),
    )
  )
    throw new Error('Invalid Antigravity transcript cursor');
  return c as Cursor;
}
function apply(w: AgentLaneWriter, snapshot: AgySnapshot, mapped: MappedAgyTranscript): void {
  const previous = cursor(w.cursor);
  if (previous && previous.conversationId !== snapshot.conversationId) {
    w.rebuild('identity-changed');
    return;
  }
  const events = mapped.events.map(e => [e.nativeId, digest(e)] as [string, string]),
    drafts = mapped.drafts.map(e => [e.finalId, digest(e.event)] as [string, string]),
    turns = mapped.turns.map(t => [t.id, digest(t)] as [string, string]),
    children = mapped.children.map(c => [c.toolCallId, c.agentId] as [string, string]);
  const next: Cursor = { version: 1, conversationId: snapshot.conversationId, events, drafts, turns, children },
    encoded = JSON.stringify(next);
  if (encoded === w.cursor) return;
  const oldEvents = new Map(previous?.events),
    oldDrafts = new Map(previous?.drafts),
    oldTurns = new Map(previous?.turns),
    currentIds = new Set([...events, ...drafts].map(([id]) => id)),
    turnIds = new Set(turns.map(([id]) => id));
  const retire: string[] = [];
  for (const [id] of previous?.turns ?? []) if (!turnIds.has(id)) retire.push(`meta:turn:${id}:ended`, `meta:turn:${id}:started`);
  for (const [id] of [...(previous?.events ?? []), ...(previous?.drafts ?? [])]) if (!currentIds.has(id)) retire.push(id);
  for (const [id, child] of previous?.children ?? [])
    if (!children.some(([call, agent]) => call === id && agent === child)) w.retireSubagent(id);
  // Retire first; retain end-before-start ordering for wholly removed turns.
  if (retire.length) w.commit({ events: [], retire: [...new Set(retire)], cursor: w.cursor });
  const changedEvents = mapped.events.filter(e => oldEvents.get(e.nativeId) !== digest(e));
  const changedDrafts = mapped.drafts.filter(e => oldDrafts.get(e.finalId) !== digest(e.event));
  const turnSet = new Set(mapped.turns.map(t => t.id));
  const orphanEvents = changedEvents.filter(e => !e.nativeTurnId || !turnSet.has(e.nativeTurnId));
  const orphanDrafts = changedDrafts.filter(e => !e.event.nativeTurnId || !turnSet.has(e.event.nativeTurnId));
  if (orphanEvents.length || orphanDrafts.length) w.commit({ events: orphanEvents, drafts: orphanDrafts, cursor: w.cursor });
  const byTurn = new Map<string, NativeWorkbenchEvent[]>(),
    draftsByTurn = new Map<string, MappedAgyTranscript['drafts']>();
  for (const e of changedEvents)
    if (e.nativeTurnId) {
      const rows = byTurn.get(e.nativeTurnId) ?? [];
      rows.push(e);
      byTurn.set(e.nativeTurnId, rows);
    }
  for (const d of changedDrafts)
    if (d.event.nativeTurnId) {
      const rows = draftsByTurn.get(d.event.nativeTurnId) ?? [];
      rows.push(d);
      draftsByTurn.set(d.event.nativeTurnId, rows);
    }
  for (const t of mapped.turns) {
    const changed = oldTurns.get(t.id) !== digest(t);
    if (changed) {
      if (!t.status && w.turnEndStatus(t.id)) w.turnReopened(t.id, t.at);
      w.turnStarted(t.id, t.at);
    }
    const events = byTurn.get(t.id) ?? [],
      drafts = draftsByTurn.get(t.id) ?? [];
    if (events.length || drafts.length) w.commit({ events, drafts, cursor: w.cursor });
    if (changed && t.status) w.turnEnded(t.id, t.status, t.endedAt ?? t.at, t.error);
  }
  // Persist the cursor after lifecycle marks; a crash before this point replays idempotently.
  w.commit({ events: [], cursor: encoded });
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
/** The TUI and the conversation view share one native store and one journal lane. */
export class AntigravityTranscriptSource implements AgentTranscriptSource {
  constructor(private readonly options: AntigravityTranscriptOptions) {}
  identity(): string | undefined {
    const id = this.options.nativeId();
    return id ? `antigravity:${id}` : undefined;
  }
  async pull(w: AgentLaneWriter, signal: AbortSignal): Promise<{ caughtUp: boolean }> {
    if (signal.aborted) return { caughtUp: false };
    const id = this.options.nativeId();
    // Nothing on disk yet (no native conversation before the first message) is all of it: `caughtUp: false`
    // has the host pull again at once, which spins the event loop for as long as agy takes to start.
    if (!id) return { caughtUp: true };
    const live = this.options.live();
    if (live && live.conversationId !== id) throw new Error('Antigravity live snapshot belongs to another conversation');
    const persisted = this.stored(id, Boolean(live));
    let snapshot = live ?? persisted;
    if (!snapshot) return { caughtUp: true };
    if (live && persisted) {
      // Stream projection sometimes removes signature-bearing tool-call envelopes.
      // Hydrate only steps whose original source coordinates still match the active branch.
      const stored = new Map(persisted.steps.map((s, i) => [agyStepIdentity(persisted, s, i), s]));
      // The store decoder pins agy's field numbers. A step whose copies disagree on type means a newer agy moved
      // fields, so none of the store is trusted for this read; the live copy alone is still correct.
      const agrees = live.steps.every((s, i) => {
        const p = stored.get(agyStepIdentity(live, s, i));
        return !p || !s.type || p.type === s.type;
      });
      if (agrees) snapshot = {
        ...live,
        steps: live.steps.map((s, i) => {
          const p = stored.get(agyStepIdentity(live, s, i));
          if (!p) return s;
          const md = { ...record(p.metadata), ...record(s.metadata) };
          return {
            ...p,
            ...s,
            metadata: md,
            ...(agyRecord(s.plannerResponse) ? { plannerResponse: { ...record(p.plannerResponse), ...s.plannerResponse } } : {}),
          };
        }),
      };
    }
    const mapped = mapAgySnapshot(snapshot, this.options.sessionId);
    apply(w, snapshot, mapped);
    this.stats(mapped);
    const seen = new Set<string>([id]);
    await this.children(w, mapped, seen, signal);
    return { caughtUp: !signal.aborted };
  }
  /**
   * The stored conversation, decoded again only when its database files change: while agy streams a step the
   * store is untouched, and every stream frame wakes a pull. With a live snapshot the store only fills in
   * signature envelopes, so a record it refuses must not take the live view down with it.
   */
  private stored(id: string, hasLive: boolean): AgySnapshot | undefined {
    const signature = storeSignature(this.options.geminiDir(), id);
    const cached = this.cache.get(id);
    if (cached?.signature === signature) return cached.snapshot;
    let snapshot: AgySnapshot | undefined;
    try {
      snapshot = readAgySnapshot(this.options.geminiDir(), id);
    } catch (error) {
      this.cache.delete(id);
      if (!hasLive) throw error;
      return undefined;
    }
    this.cache.set(id, { signature, snapshot });
    return snapshot;
  }
  private readonly cache = new Map<string, { signature: string; snapshot: AgySnapshot | undefined }>();
  private stats(mapped: MappedAgyTranscript): void {
    const host = this.options.host;
    if (!host) return;
    host.stats.observeEvents(this.options.sessionId, mapped.events);
    for (const item of mapped.usage) host.stats.recordUsage(this.options.sessionId, item.runId, item.usage);
    for (const job of mapped.jobs) host.emit(this.options.sessionId, { type: 'job', job });
  }
  private async children(w: AgentLaneWriter, mapped: MappedAgyTranscript, seen: Set<string>, signal: AbortSignal): Promise<void> {
    for (const child of mapped.children) {
      if (signal.aborted || seen.has(child.agentId) || seen.size >= 128) continue;
      seen.add(child.agentId);
      const snapshot = this.stored(child.agentId, false);
      if (!snapshot) continue;
      // Child IDs alone are not authority: verify the native parent linkage in this private root.
      if (snapshot.metadata?.parentConversationId !== mappedParent(w)) continue;
      const lane = w.child(child.toolCallId, child.agentId, child),
        data = mapAgySnapshot(snapshot, this.options.sessionId);
      apply(lane, snapshot, data);
      this.stats({ ...data, usage: data.usage.map(u => ({ ...u, usage: { ...u.usage, agentKind: 'subagent' } })) });
      await this.children(lane, data, seen, signal);
    }
  }
  watch(_w: AgentLaneWriter, wake: () => void): () => void {
    const stop = this.options.watch(wake),
      timer = setInterval(wake, 750);
    timer.unref();
    return () => {
      clearInterval(timer);
      stop();
    };
  }
  async drain(w: AgentLaneWriter): Promise<void> {
    await this.pull(w, new AbortController().signal);
  }
}
function mappedParent(w: AgentLaneWriter): string | undefined {
  return cursor(w.cursor)?.conversationId;
}
/** Stored history for search/shares. This path never launches a native runtime. */
export function readAgyHistory(geminiDir: string, conversationId: string, sessionId = ''): AgentHistory {
  const snapshot = readAgySnapshot(geminiDir, conversationId);
  if (!snapshot) throw new Error('Antigravity history is unavailable');
  const mapped = mapAgySnapshot(snapshot, sessionId),
    seen = new Set([conversationId]);
  const subagents: AgentHistory['subagents'] = [];
  const visit = (data: MappedAgyTranscript, parent: string) => {
    for (const child of data.children) {
      if (seen.has(child.agentId) || seen.size >= 128) continue;
      seen.add(child.agentId);
      const s = readAgySnapshot(geminiDir, child.agentId);
      if (!s || s.metadata?.parentConversationId !== parent) continue;
      const m = mapAgySnapshot(s, sessionId);
      subagents.push({ ...child, events: m.events.map(({ sequence: _sequence, sessionId: _session, raw: _raw, ...event }) => event) });
      visit(m, child.agentId);
    }
  };
  visit(mapped, conversationId);
  return {
    events: mapped.events.map(({ sequence: _sequence, sessionId: _session, raw: _raw, ...event }) => event),
    subagents,
    ...(mapped.jobs.length ? { jobs: mapped.jobs } : {}),
    ...(mapped.warnings.length ? { warnings: [...new Set(mapped.warnings)] } : {}),
    turns: mapped.turns.filter(t => t.text !== undefined).map(t => ({ id: t.id, text: t.text!, createdAt: t.at })),
  };
}
