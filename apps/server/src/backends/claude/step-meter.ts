import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import type { NativeWorkbenchEvent, Session } from '../../../../../packages/contracts/src/index.js';
import { ClaudeActivities } from './activity.js';
import { MAX_TRANSCRIPT_BYTES, record, string, readableThinking, isClaudeSyntheticPlaceholder, type ClaudeRow, isTranscriptOnly, hiddenTurnPrompt, parseRow } from './rows.js';
import { type MapperState, type ClaudeTranscriptHooks, mapRow } from './row-mapper.js';

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

export const finiteToken = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export const maxToken = (current: number | undefined, next: number | undefined) => {
  if (next === undefined) return current;
  if (current === undefined) return next;
  return Math.max(current, next);
};

export const usageOf = (message: Record<string, unknown> | undefined) => {
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
export class ClaudeStepMeter {
  /** Without `keepText` a step's `text` stays empty and only whether it had any visible text is kept. */
  constructor(private readonly keepText = true) {}
  private readonly open = new Map<string, { step: ClaudeStepMeasurement; text: string[]; visible?: boolean; built?: ClaudeStepMeasurement; kept?: boolean }>();
  private readonly order: string[] = [];
  private readonly subagents: ClaudeStepMeasurement[] = [];
  private readonly toolParents = new Map<string, { stepId: string; subagentType?: string; nativeMessageId?: string; commandId?: string }>();
  /** Timestamp of the explicit `api-request` preceding the next assistant response, if any. */
  private apiRequestAt: number | undefined;
  /** Timestamp of the last conversation-flow boundary (`user`, `assistant`, or `api-request`). */
  private boundaryAt: number | undefined;
  private turnId: string | undefined;
  private nativeTurnId: string | undefined;
  private commandId: string | undefined;
  private nativeMessageId: string | undefined;
  private cache?: ClaudeStepMeasurement[];

  add(row: ClaudeRow, events: ReadonlyArray<Omit<NativeWorkbenchEvent, 'sequence'>>): void {
    if (row.isSidechain === true || isClaudeSyntheticPlaceholder(row)) return;
    const at = row.timestamp ? Date.parse(row.timestamp) : Number.NaN;
    const stamp = Number.isFinite(at) ? at : undefined;
    const hiddenPromptId = hiddenTurnPrompt(row);
    if (hiddenPromptId && hiddenPromptId !== this.nativeTurnId) {
      this.nativeTurnId = hiddenPromptId;
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
        // Prefer the explicit `api-request` row when present and non-inverted; otherwise fall back
        // to the previous conversation boundary (`user`/`assistant`). Asynchronous side records
        // (`attachment`, `queue-operation`, `file-history-delta`, …) never move these markers.
        const startedAt = this.apiRequestAt !== undefined && this.apiRequestAt <= stamp
          ? this.apiRequestAt
          : this.boundaryAt !== undefined && this.boundaryAt <= stamp
            ? this.boundaryAt
            : stamp;
        this.apiRequestAt = undefined;
        entry = {
          step: {
            stepId: messageId,
            ...(this.turnId ? { runId: this.turnId } : {}),
            ...(this.commandId ? { commandId: this.commandId } : {}),
            ...(this.nativeMessageId ? { nativeMessageId: this.nativeMessageId } : {}),
            text: '',
            outputTokens: 0,
            startedAt,
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
        let piece: string | undefined;
        if (block.type === 'text' && typeof block.text === 'string') piece = block.text;
        else if ((block.type === 'thinking' || block.type === 'reasoning') && typeof (block.thinking ?? block.text) === 'string') piece = readableThinking(String(block.thinking ?? block.text));
        else if (block.type === 'tool_use') piece = JSON.stringify(block.input ?? {});
        if (piece === undefined) continue;
        if (this.keepText) entry.text.push(piece);
        else if (!entry.visible && /\S/.test(piece)) entry.visible = true;
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
        startedAt: durationMs !== undefined
          ? stamp - durationMs
          : (this.boundaryAt !== undefined && this.boundaryAt <= stamp ? this.boundaryAt : stamp),
        endedAt: stamp,
        live: false,
        agentKind: 'subagent',
        ...(parent?.subagentType ? { subagentType: parent.subagentType } : {}),
        ...(parent ? { parentStepId: parent.stepId } : {}),
      });
      this.cache = undefined;
    }
    if (stamp !== undefined) {
      if (row.type === 'api-request') {
        this.apiRequestAt = stamp;
        this.boundaryAt = this.boundaryAt === undefined ? stamp : Math.max(this.boundaryAt, stamp);
      } else if (row.type === 'user') {
        this.apiRequestAt = undefined;
        this.boundaryAt = stamp;
      } else if (row.type === 'assistant') {
        this.boundaryAt = this.boundaryAt === undefined ? stamp : Math.max(this.boundaryAt, stamp);
      }
    }
  }

  /** The same array until a row changes a measurement, so a caller can tell nothing moved. */
  steps(): ClaudeStepMeasurement[] {
    if (this.cache) return this.cache;
    const steps: ClaudeStepMeasurement[] = [];
    for (const [index, id] of this.order.entries()) {
      const entry = this.open.get(id)!;
      if (!entry.built) {
        entry.built = { ...entry.step, text: entry.text.join('') };
        entry.kept = entry.built.outputTokens > 0 || (this.keepText ? /\S/.test(entry.built.text) : entry.visible === true);
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

/**
 * The step measurements of a whole transcript, read as a stream (docs/guide/performance.md §3.8). Each row
 * is mapped only so the meter can attribute it to its run; rows, events and response text are not kept,
 * and children's JSONL is not read (the meter does not measure them). Bytes after the last newline wait
 * for a later read, as in `ClaudeTranscript`. Throws `Claude transcript is unparsed` where a full read
 * would leave the transcript unparsed, and `… is unavailable` when the file is gone.
 */
export async function readClaudeMeasurements(file: string, session: Session, hooks: ClaudeTranscriptHooks = {}): Promise<ClaudeStepMeasurement[]> {
  const meter = new ClaudeStepMeter(false);
  const state: MapperState = { turnAt: '', calls: new Map(), tasks: new Map(), activities: new ClaudeActivities(session.id, { putBlob: () => undefined }) };
  let index = 0;
  const take = (bytes: Buffer, start: number, end: number) => {
    if (end <= start) return;
    index += 1;
    const row = parseRow(bytes.toString('utf8', start, end), hooks.unbounded);
    if (row) meter.add(row, mapRow(row, index, session, state, hooks));
  };
  try {
    const info = await stat(file);
    if (info.size > MAX_TRANSCRIPT_BYTES) throw new Error('transcript exceeds read limit');
    if (info.size === 0) return [];
    // A line longer than a chunk waits as a list and is joined once its newline arrives, not re-copied per chunk.
    let pending: Buffer[] = [];
    for await (const read of createReadStream(file, { start: 0, end: info.size - 1 })) {
      const chunk = read as Buffer;
      if (chunk.indexOf(0x0a) < 0) { pending.push(chunk); continue; }
      const bytes = pending.length ? Buffer.concat([...pending, chunk]) : chunk;
      let start = 0;
      for (let end = bytes.indexOf(0x0a); end >= 0; end = bytes.indexOf(0x0a, start)) {
        take(bytes, start, end);
        start = end + 1;
      }
      pending = start < bytes.length ? [bytes.subarray(start)] : [];
    }
  } catch (error) {
    throw new Error(`Claude transcript is ${(error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unavailable' : 'unparsed'}`);
  }
  return meter.steps();
}
