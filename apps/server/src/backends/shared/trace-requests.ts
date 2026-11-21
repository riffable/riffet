import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { TRACE_BUDGET } from '../../../../../packages/contracts/src/budgets.js';
import type { SyncLane } from '../../../../../packages/contracts/src/sync.js';
import type { TraceContextMessage, TracePrompt, TracePromptBlock, TraceRequest, TraceRequests, TraceToolDefinition } from '../../../../../packages/contracts/src/trace.js';

/*
 * The parts both drivers' request reads share (docs/TRACE.md §2.1): prompts and parameter sets kept once by
 * content, injected messages kept once by id, long texts cut at the budget, and the oldest requests and prompts
 * dropped past it. A driver parses its own records and hands them here; the answer is built once at the end.
 */

const digest = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex').slice(0, 16);

/** A text cut at the budget, with the whole length when it was cut. */
export function boundedText(text: string): { text: string; chars?: number } {
  return text.length > TRACE_BUDGET.requestTextChars ? { text: text.slice(0, TRACE_BUDGET.requestTextChars), chars: text.length } : { text };
}

/** What an injected message says it is: its leading tag, or a heading line. */
export function contextLabel(text: string): string | undefined {
  const head = text.trimStart();
  const tag = /^<([a-zA-Z][\w-]{0,40})[\s>]/.exec(head)?.[1];
  if (tag) return tag;
  const heading = /^#{1,3}\s+(.{1,60})/.exec(head)?.[1];
  return heading?.trim();
}

export class TraceRequestsBuilder {
  private readonly prompts = new Map<string, TracePrompt>();
  private readonly params = new Map<string, Record<string, unknown>>();
  private readonly context = new Map<string, TraceContextMessage>();
  private readonly requests: TraceRequest[] = [];
  version?: string;

  constructor(private readonly lane: SyncLane, private readonly backendId: string, private readonly granularity: 'request' | 'turn') {}

  /** The id of a prompt with these blocks and tools, kept on first sight. */
  prompt(at: string, system: TracePromptBlock[], tools: TraceToolDefinition[], id = digest({ system, tools })): string {
    if (!this.prompts.has(id)) this.prompts.set(id, { id, at, system: system.map((block) => ({ ...block, ...boundedText(block.text) })), tools });
    return id;
  }

  /** The id of a parameter set, kept on first sight. */
  paramSet(params: Record<string, unknown>): string {
    const id = digest(params);
    if (!this.params.has(id)) this.params.set(id, params);
    return id;
  }

  /** Keeps an injected message under `id` (a content hash of the agent's, or one made from the text). */
  contextMessage(role: string, text: string, id = digest(`${role}\n${text}`)): string {
    if (!this.context.has(id)) {
      const label = contextLabel(text);
      this.context.set(id, { role, ...boundedText(text), ...(label ? { label } : {}) });
    }
    return id;
  }

  hasContext(id: string): boolean { return this.context.has(id); }

  request(request: TraceRequest): void { this.requests.push(request); }

  get last(): TraceRequest | undefined { return this.requests.at(-1); }

  build(): TraceRequests {
    // The newest requests, as many as the budget takes, stopping before one whose prompt would be past the prompt budget:
    // every kept request finds its prompt.
    const promptIds = new Set<string>();
    let first = this.requests.length;
    while (first > 0 && this.requests.length - first < TRACE_BUDGET.requestRecords) {
      const prompt = this.requests[first - 1]!.prompt;
      if (prompt && !promptIds.has(prompt) && promptIds.size >= TRACE_BUDGET.requestPrompts) break;
      if (prompt) promptIds.add(prompt);
      first -= 1;
    }
    const requests = this.requests.slice(first);
    const truncated = first > 0;
    // Only what the kept requests point at, so dropped history does not ride along.
    const prompts = [...this.prompts.values()].filter((prompt) => promptIds.has(prompt.id) || !requests.length);
    const paramIds = new Set(requests.flatMap((request) => request.params ? [request.params] : []));
    const contextIds = new Set(requests.flatMap((request) => (request.added ?? []).filter((id): id is string => id !== null)));
    // Injected texts in all, newest first: past the budget an older message keeps its label and length, not its text.
    let room = TRACE_BUDGET.requestContextChars;
    const context = new Map<string, TraceContextMessage>();
    for (const id of [...contextIds].reverse()) {
      const message = this.context.get(id);
      if (!message) continue;
      if (message.text.length <= room) { room -= message.text.length; context.set(id, message); continue; }
      room = 0;
      context.set(id, { role: message.role, text: '', chars: message.chars ?? message.text.length, omitted: true, ...(message.label ? { label: message.label } : {}) });
    }
    return {
      lane: this.lane,
      status: requests.length || prompts.length ? 'ok' : 'unrecognized',
      backendId: this.backendId,
      ...(this.version ? { version: this.version } : {}),
      granularity: this.granularity,
      prompts,
      requests,
      params: Object.fromEntries([...this.params].filter(([id]) => paramIds.has(id))),
      context: Object.fromEntries(context),
      ...(truncated ? { truncated: true as const } : {}),
    };
  }
}

/** An answer with nothing in it, saying why. */
export function noRequests(lane: SyncLane, status: Exclude<TraceRequests['status'], 'ok'>, backendId?: string): TraceRequests {
  return { lane, status, ...(backendId ? { backendId } : {}), prompts: [], requests: [], params: {}, context: {} };
}

/**
 * Streams the files' lines in order to `line`, skipping lines without any of `needles` unparsed: a transcript runs
 * to hundreds of megabytes and only a few kinds of line matter (docs/guide/performance.md §3.8). `missing` when a file
 * is gone, `tooLarge` when the files together are past the budget.
 */
export async function readRecordLines(files: readonly string[], needles: readonly string[], line: (record: Record<string, unknown>) => void, signal: AbortSignal): Promise<'read' | 'missing' | 'tooLarge'> {
  let bytes = 0;
  for (const file of files) {
    // Gone since it was found (a moved or removed transcript): the lane has none to read.
    const info = await stat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!info) return 'missing';
    bytes += info.size;
  }
  if (bytes > TRACE_BUDGET.requestFileBytes) return 'tooLarge';
  for (const file of files) {
    signal.throwIfAborted();
    const input = createReadStream(file, { encoding: 'utf8' });
    const abort = () => input.destroy();
    signal.addEventListener('abort', abort, { once: true });
    try {
      for await (const text of createInterface({ input, crlfDelay: Infinity })) {
        if (!needles.some((needle) => text.includes(needle))) continue;
        let value: unknown;
        try { value = JSON.parse(text); } catch { continue; }
        if (value && typeof value === 'object' && !Array.isArray(value)) line(value as Record<string, unknown>);
      }
    } finally {
      signal.removeEventListener('abort', abort);
    }
    signal.throwIfAborted();
  }
  return 'read';
}

export const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export const stringOf = (value: unknown): string | undefined => typeof value === 'string' && value !== '' ? value : undefined;

/** The text of a message's content: a string, or the text parts of a block list (other parts named by type). */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content === undefined ? '' : JSON.stringify(content);
  return content.map((part) => {
    if (!isRecord(part)) return '';
    const text = stringOf(part.text);
    if (text !== undefined) return text;
    return `[${stringOf(part.type) ?? 'part'}]`;
  }).filter(Boolean).join('\n\n');
}
