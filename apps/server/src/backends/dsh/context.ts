/**
 * The context-window facts a DeepSeek Harness log already carries.
 *
 * DSH commits the provider's own prompt accounting on every `assistant/message` and the resolved
 * route (including its window) on `request/context`. Reading those two records gives an exact
 * occupancy without a second provider call and without estimating anything, which is the same rule
 * the Cursor meter follows: report a measurement or report nothing.
 *
 * What the prompt is *made of* is not in the log. DSH folds that separately (`contextBreakdown`
 * over the live session, priced with its fixed-density estimator) and the bridge reads it off the
 * projection registry; it is published as three labelled parts beside the measured occupancy, never
 * summed into it. See {@link DshContextBreakdown}.
 */
import type { NativeContext } from '../../../../../packages/contracts/src/index.js';

type RecordValue = Record<string, unknown>;

/** Latest window facts, each remembering the durable sequence that reported it. */
export interface DshContextFacts {
  /** Prompt-side tokens of the newest committed step. */
  used?: number;
  usedSequence?: number;
  /** Context window advertised by the newest resolved route. */
  window?: number;
  windowSequence?: number;
}

/**
 * What the next request is made of, folded by DSH's own `contextBreakdown` projection and read off
 * the live session by the bridge (the durable log does not carry it).
 *
 * These are the token meter's fixed-density *heuristic*, and the projection's own documentation is
 * explicit that they are a composition, not a total: the estimator underprices CJK text and JSON
 * schemas, so
 * the three never add up to {@link DshContextFacts.used}. They are reported as three parts beside
 * the measured occupancy, never summed into it.
 */
export interface DshContextBreakdown {
  systemTokens: number;
  toolsTokens: number;
  messageTokens: number;
}

/** The three composition parts, in the order the popover lists them, under the web's own labels. */
const BREAKDOWN_PARTS: ReadonlyArray<{ id: string; label: string; key: keyof DshContextBreakdown }> = [
  { id: 'system_prompt', label: '系统提示词', key: 'systemTokens' },
  { id: 'tools', label: '工具定义', key: 'toolsTokens' },
  { id: 'conversation', label: '对话', key: 'messageTokens' },
];

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue
    : undefined;
}

/**
 * Prompt-side context pressure of one committed step: the input the next request resends plus the
 * cache traffic the provider billed for it. Output tokens are excluded on purpose — DSH's own
 * `pressureFrom` fold does the same — and `undefined` means the record carried no accounting, so a
 * missing number is never published as a measurement.
 */
export function dshPromptTokens(usage: unknown): number | undefined {
  const buckets = record(usage);
  if (!buckets) return undefined;
  let total = 0;
  let reported = false;
  for (const key of ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    const value = buckets[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
    total += value;
    reported = true;
  }
  return reported ? Math.round(total) : undefined;
}

/**
 * Fold one page of committed DSH records into the facts, newest sequence wins.
 *
 * The sequence guard matters because the same records are replayed: a poll re-reads the tail, an
 * older history page is fetched later, and a reset rebuilds the window. A record that is not newer
 * than what is already known can never regress the meter.
 * @param facts - mutable facts to update.
 * @param rawEvents - committed DSH records, each with its durable `seq`.
 * @returns whether any fact changed.
 */
export function foldDshContext(facts: DshContextFacts, rawEvents: readonly unknown[]): boolean {
  let changed = false;
  for (const raw of rawEvents) {
    const event = record(raw);
    if (!event) continue;
    const sequence = event.seq;
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) continue;
    const data = record(event.data) ?? {};
    if (event.type === 'request/context') {
      const window = data.contextWindow;
      if (typeof window !== 'number' || !Number.isInteger(window) || window <= 0) continue;
      if ((facts.windowSequence ?? -1) >= sequence) continue;
      facts.window = window;
      facts.windowSequence = sequence;
      changed = true;
    } else if (event.type === 'assistant/message') {
      const used = dshPromptTokens(data.usage);
      if (used === undefined || (facts.usedSequence ?? -1) >= sequence) continue;
      facts.used = used;
      facts.usedSequence = sequence;
      changed = true;
    }
  }
  return changed;
}

/**
 * The measured occupancy, or nothing at all. Half a measurement (tokens without a window, or a
 * window without tokens) is not published, because a ring needs both to mean anything.
 * @param facts - folded facts.
 * @param breakdown - composition of the current surface, when a live session could be projected.
 * @returns the context frame payload, or `undefined` while either fact is missing.
 */
export function dshNativeContext(facts: DshContextFacts, breakdown?: DshContextBreakdown): NativeContext | undefined {
  if (facts.used === undefined || facts.window === undefined) return undefined;
  // Without a breakdown the popover draws the ratio as one bar. It never invents shares, and it
  // never folds the composition into `used`: the three parts are an estimate of what the prompt is
  // made of, while `used` is what the provider billed for it.
  return {
    used: facts.used,
    size: facts.window,
    breakdown: breakdown
      ? BREAKDOWN_PARTS.map(part => ({ id: part.id, label: part.label, tokens: breakdown[part.key] })).filter(part => part.tokens > 0)
      : [],
  };
}
