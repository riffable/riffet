/*
 * The native process message (COT): not a card, so it has no element budget and the client brings
 * its own fold / expand / stop. Three calls: create, append AG-UI events, complete. A run opened
 * with RUN_STARTED must end with RUN_FINISHED or RUN_ERROR and then be completed, otherwise the
 * client shows a spinner forever; that is why `finish` always runs, even after the circuit breaks.
 */
import type { TurnStep } from '../types.js';
import { FeishuApiError, type FeishuApi } from './openapi.js';

/** The endpoint counts UTF-8 bytes, not characters, and a CJK character is three. */
const MAX_CONTENT_BYTES = 4096;
/** Deltas are cut well below the cap to leave room for the JSON envelope. */
const DELTA_BUDGET_BYTES = 3000;
const MAX_EVENTS_PER_REQUEST = 50;
const FLUSH_INTERVAL_MS = 300;
const FLUSH_EVENT_COUNT = 40;
const BREAK_AFTER_FAILURES = 3;
const PROCESSING_RETRY_MS = 600;
const RESULT_MAX_CHARS = 800;
/** Escaped size cap for a result's text, so control-heavy output still fits one event. */
const RESULT_MAX_BYTES = 2400;
const TITLE_MAX_CHARS = 120;

export interface CotEvent { event_type: string; content: string; timestamp: number }
export interface CotHandle { cotId: string; messageId: string }

type ToolIcon = 'search' | 'bash' | 'read' | 'write' | 'edit' | 'doc' | 'task' | 'default';

const STATUS_TEXT = {
  thinking: { zh_cn: '正在思考', en_us: 'Thinking' },
  running: { zh_cn: '正在执行', en_us: 'Working on it' },
  done: { zh_cn: '已完成', en_us: 'Done' },
  error: { zh_cn: '执行失败', en_us: 'Failed' },
  paused: { zh_cn: '已暂停', en_us: 'Paused' },
  interrupted: { zh_cn: '已中断', en_us: 'Interrupted' },
};

const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');
/** Bytes a string takes inside a JSON string value: quotes, backslashes, newlines and control characters grow. */
const jsonBytes = (text: string): number => byteLength(JSON.stringify(text)) - 2;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
export const stripAnsi = (text: string): string => text.replace(ANSI, '');

/** Cuts at code point boundaries so a surrogate pair is never split; sizes are measured as escaped JSON. */
export function chunkByBytes(text: string, budget = DELTA_BUDGET_BYTES): string[] {
  const chunks: string[] = [];
  let current = '';
  let bytes = 0;
  for (const char of text) {
    const size = jsonBytes(char);
    if (bytes + size > budget) { chunks.push(current); current = ''; bytes = 0; }
    current += char;
    bytes += size;
  }
  if (current) chunks.push(current);
  return chunks;
}

/** The longest prefix of `text` (whole code points) whose escaped JSON form fits `budget` bytes. */
function fitJsonBytes(text: string, budget: number): string {
  let bytes = 0;
  let out = '';
  for (const char of text) {
    bytes += jsonBytes(char);
    if (bytes > budget) return `${out}…`;
    out += char;
  }
  return out;
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

function toolIcon(name: string): ToolIcon {
  switch (name.toLowerCase()) {
    case 'bash': case 'shell': case 'run': case 'exec': case 'command': return 'bash';
    case 'read': case 'ls': case 'cat': return 'read';
    case 'write': return 'write';
    case 'edit': case 'multiedit': case 'patch': case 'apply_patch': return 'edit';
    case 'grep': case 'glob': case 'find': case 'search': case 'websearch': case 'webfetch': case 'fetch': return 'search';
    case 'task': case 'agent': return 'task';
    default: return 'default';
  }
}

function resultContent(output: string): unknown {
  const text = fitJsonBytes(truncate(stripAnsi(output).trim(), RESULT_MAX_CHARS), RESULT_MAX_BYTES);
  if (/^[[{]/.test(text)) {
    try { JSON.parse(text); return { type: 'code', language: 'json', code: text }; } catch { /* plain text below */ }
  }
  return text.split('\n').length > 3 ? { type: 'code', language: 'text', code: text } : { type: 'text', text };
}

const event = (type: string, payload: unknown): CotEvent => ({ event_type: type, content: JSON.stringify(payload), timestamp: Date.now() });

// ── The three calls. None of them throws: a failing process surface must never cost the turn. ──

export interface CotTarget { chatId: string; originMessageId?: string }

export async function createCot(api: FeishuApi, target: CotTarget): Promise<CotHandle | undefined> {
  try {
    const data = await api.call('POST', '/open-apis/im/v1/message_cot', {
      query: { receive_id_type: 'chat_id' },
      // `reply_in_thread` requires a real origin message; without one the COT is a plain chat message.
      body: { receive_id: target.chatId, ...(target.originMessageId ? { origin_message_id: target.originMessageId, reply_in_thread: true } : {}) },
      label: 'cot-create',
    });
    return typeof data.cot_id === 'string' && typeof data.message_id === 'string' && data.cot_id && data.message_id
      ? { cotId: data.cot_id, messageId: data.message_id }
      : undefined;
  } catch {
    return undefined;
  }
}

/** 10001 "content too long" (or a malformed event): the rejection that a smaller request can fix. */
const isOversized = (error: unknown): boolean => error instanceof FeishuApiError && error.code === 10001;

/** Cuts the longest string of an event's payload in half; undefined when nothing is left to cut. */
function shrinkEvent(item: CotEvent): CotEvent | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(item.content); } catch { return undefined; }
  let best: { holder: Record<string, unknown>; key: string; length: number } | undefined;
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (typeof child === 'string') { if (!best || child.length > best.length) best = { holder: node as Record<string, unknown>, key, length: child.length }; }
      else visit(child);
    }
  };
  visit(parsed);
  if (!best || best.length <= 16) return undefined;
  const chars = Array.from(String(best.holder[best.key]));
  best.holder[best.key] = `${chars.slice(0, Math.floor(chars.length / 2)).join('')}…`;
  return { ...item, content: JSON.stringify(parsed) };
}

/**
 * One PUT. A rejection for size halves the batch and retries; a single event that is still too big
 * is truncated and retried. Only when that bottoms out does it count as a failure.
 */
async function appendEvents(api: FeishuApi, handle: CotHandle, events: CotEvent[]): Promise<boolean> {
  const put = () => api.call('PUT', '/open-apis/im/v1/message_cot', { body: { message_id: handle.messageId, cot_id: handle.cotId, events }, label: 'cot-update' });
  try {
    try {
      await put();
    } catch (error) {
      // 10020: the previous update is still being applied. A single short wait outlasts it.
      if (!(error instanceof FeishuApiError) || error.code !== 10020) throw error;
      await new Promise(resolve => setTimeout(resolve, PROCESSING_RETRY_MS));
      await put();
    }
    return true;
  } catch (error) {
    if (!isOversized(error)) return false;
    if (events.length > 1) {
      const mid = Math.ceil(events.length / 2);
      const first = await appendEvents(api, handle, events.slice(0, mid));
      const second = await appendEvents(api, handle, events.slice(mid));
      return first && second;
    }
    const shrunk = shrinkEvent(events[0]!);
    return shrunk ? appendEvents(api, handle, [shrunk]) : false;
  }
}

export async function completeCot(api: FeishuApi, handle: CotHandle, reason: 'done' | 'error'): Promise<boolean> {
  try {
    await api.call('POST', `/open-apis/im/v1/message_cot/complete/${encodeURIComponent(handle.cotId)}`, { query: { message_id: handle.messageId, reason }, label: 'cot-complete' });
    return true;
  } catch {
    return false;
  }
}

// ── One turn's process ──

interface StepProgress {
  kind: TurnStep['kind'];
  /** Text sent so far (UTF-16 length) / for a tool: whether its end was sent. */
  sent: number;
  /** Which group of this step is open or last used; a step re-opens under a new id after a tool cut it. */
  generation: number;
  open: boolean;
  /** Tool: START sent. */
  started: boolean;
  ended: boolean;
}

export interface CotRunState {
  cotId: string;
  messageId: string;
  runId: string;
  threadId: string;
  steps: Record<string, StepProgress>;
  /** Step whose text group is open right now. */
  openGroup?: string;
  finished?: boolean;
}

export type CotOutcome = 'done' | 'interrupted' | 'failed';

export class CotRun {
  private readonly progress = new Map<string, StepProgress>();
  private openGroup?: string;
  private queue: CotEvent[] = [];
  private chain: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private failures = 0;
  private finished = false;
  private finishing?: Promise<void>;

  private constructor(private readonly api: FeishuApi, private readonly handle: CotHandle, private readonly runId: string, private readonly threadId: string) {}

  static async open(api: FeishuApi, target: CotTarget, runId: string, threadId: string): Promise<CotRun | undefined> {
    const handle = await createCot(api, target);
    if (!handle) return undefined;
    const run = new CotRun(api, handle, runId, threadId);
    run.push(event('RUN_STARTED', { threadId, runId, input: { statusText: STATUS_TEXT } }));
    return run;
  }

  static resume(api: FeishuApi, state: CotRunState): CotRun | undefined {
    if (state.finished) return undefined;
    const run = new CotRun(api, { cotId: state.cotId, messageId: state.messageId }, state.runId, state.threadId);
    for (const [id, step] of Object.entries(state.steps)) run.progress.set(id, { ...step });
    run.openGroup = state.openGroup;
    return run;
  }

  state(): CotRunState {
    return {
      cotId: this.handle.cotId,
      messageId: this.handle.messageId,
      runId: this.runId,
      threadId: this.threadId,
      steps: Object.fromEntries([...this.progress].map(([id, step]) => [id, { ...step }])),
      ...(this.openGroup ? { openGroup: this.openGroup } : {}),
      ...(this.finished ? { finished: true } : {}),
    };
  }

  private groupId(stepId: string, generation: number): string { return `${stepId}#${generation}`; }

  /** Turns the difference between the steps already sent and these into events; `final` ends tools still open. */
  sync(steps: readonly TurnStep[], final = false): void {
    if (this.finished || this.finishing) return;
    const events: CotEvent[] = [];
    for (const step of steps) {
      let progress = this.progress.get(step.id);
      if (step.kind === 'tool') {
        if (!progress) {
          this.closeGroup(events);
          progress = { kind: 'tool', sent: 0, generation: 0, open: false, started: true, ended: false };
          this.progress.set(step.id, progress);
          const label = (step.title ?? '').trim();
          const name = label.split(/\s+/)[0] || 'tool';
          events.push(event('TOOL_CALL_START', { toolCallId: step.id, icon: toolIcon(name), toolCallName: truncate(name, 80), title: truncate(label || name, TITLE_MAX_CHARS) }));
        }
        if (!progress.ended && (final || step.state !== 'running')) {
          this.closeGroup(events);
          progress.ended = true;
          events.push(event('TOOL_CALL_END', { toolCallId: step.id }));
          // A result without displayable content is drawn as raw event JSON, so a clean finish sends none.
          const shown = step.output?.trim() ? step.output : step.state === 'failed' ? '失败' : '';
          if (shown) {
            events.push(event('TOOL_CALL_RESULT', {
              messageId: `${step.id}-result`, toolCallId: step.id, role: 'tool',
              status: step.state === 'failed' ? 'error' : 'completed', ...(step.state === 'failed' ? { isError: true } : {}),
              content: resultContent(shown),
            }));
          }
        }
        continue;
      }
      if (!progress) {
        progress = { kind: step.kind, sent: 0, generation: 0, open: false, started: false, ended: false };
        this.progress.set(step.id, progress);
      }
      if (step.text.length <= progress.sent) continue;
      const reasoning = step.kind !== 'narration';
      if (this.openGroup !== step.id) {
        this.closeGroup(events);
        // A step cut by a tool continues under a new id, so the client does not hoist it above the tool.
        if (progress.sent > 0) progress.generation += 1;
        events.push(event(reasoning ? 'REASONING_MESSAGE_START' : 'TEXT_MESSAGE_START', { messageId: this.groupId(step.id, progress.generation), role: reasoning ? 'reasoning' : 'assistant' }));
        progress.open = true;
        this.openGroup = step.id;
      }
      for (const delta of chunkByBytes(step.text.slice(progress.sent))) {
        events.push(event(reasoning ? 'REASONING_MESSAGE_CHUNK' : 'TEXT_MESSAGE_CONTENT', { messageId: this.groupId(step.id, progress.generation), delta }));
      }
      progress.sent = step.text.length;
    }
    this.push(...events);
  }

  private closeGroup(events: CotEvent[]): void {
    const id = this.openGroup;
    if (!id) return;
    const progress = this.progress.get(id);
    this.openGroup = undefined;
    if (!progress) return;
    progress.open = false;
    events.push(event(progress.kind === 'narration' ? 'TEXT_MESSAGE_END' : 'REASONING_MESSAGE_END', { messageId: this.groupId(id, progress.generation) }));
  }

  private push(...events: CotEvent[]): void {
    if (!events.length) return;
    this.queue.push(...events);
    if (this.queue.length >= FLUSH_EVENT_COUNT) void this.flush();
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), FLUSH_INTERVAL_MS);
  }

  /** Sends everything queued, in order, in requests of at most 50 events. */
  private flush(force = false): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.chain = this.chain.then(async () => {
      while (this.queue.length) {
        // After repeated failures only the closing batch still goes out: the surface stops, the run still ends.
        if (this.failures >= BREAK_AFTER_FAILURES && !force) { this.queue = []; return; }
        const batch = this.queue.splice(0, MAX_EVENTS_PER_REQUEST);
        if (await appendEvents(this.api, this.handle, batch)) this.failures = 0;
        else this.failures += 1;
      }
    });
    return this.chain;
  }

  /** Ends the run on the wire and completes the COT. Safe to call more than once. */
  finish(outcome: CotOutcome, message?: string): Promise<void> {
    this.finishing ??= (async () => {
      const events: CotEvent[] = [];
      this.closeGroup(events);
      for (const [id, progress] of this.progress) {
        if (progress.kind === 'tool' && !progress.ended) { progress.ended = true; events.push(event('TOOL_CALL_END', { toolCallId: id })); }
      }
      events.push(outcome === 'failed'
        ? event('RUN_ERROR', { threadId: this.threadId, runId: this.runId, message: truncate(message || '执行失败', 400) })
        : event('RUN_FINISHED', { threadId: this.threadId, runId: this.runId, status: outcome === 'interrupted' ? 'interrupted' : 'done' }));
      this.queue.push(...events);
      await this.flush(true);
      await completeCot(this.api, this.handle, outcome === 'failed' ? 'error' : 'done');
      this.finished = true;
    })();
    return this.finishing;
  }
}
