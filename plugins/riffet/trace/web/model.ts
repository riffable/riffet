import type { Run, SyncLane, TraceLane, TracePrompt, TraceRequest, TraceRequests, TraceRow, TraceUsageStep } from '@contracts';

/*
 * The trace's two readings of one lane (docs/TRACE.md):
 * - spans: rows grouped into what they are versions of (a tool call with its updates, a message, an activity),
 *   placed in their turn, with the model requests of that turn beside them;
 * - log: the rows themselves in seq order, every revision.
 * Both are folded here from the index alone; a row's payload is read only when it is opened.
 */

export type Category = 'message' | 'thinking' | 'tool' | 'model' | 'system' | 'draft';
export const CATEGORIES: readonly Category[] = ['message', 'thinking', 'tool', 'model', 'system', 'draft'];

/** An entity: every row that is a version of the same thing. */
export interface Span {
  type: 'span';
  id: string;
  category: Category;
  /** `tool_call`, `agent_message_chunk`, `meta.subagent`... as the first row names it. */
  kind: string;
  turnId?: string;
  /** The rows, oldest first; the last is the latest version. */
  rows: TraceRow[];
  start: number;
  /** When the last version was written; equal to `start` for a single row. */
  end: number;
  /** The span ran from `start` to `end` (a finished tool call); otherwise it is an instant. */
  timed: boolean;
  title: string;
  name?: string;
  toolKind?: string;
  toolCallId?: string;
  status?: string;
  error: boolean;
  /** The lane a subagent's call opened. */
  lane?: SyncLane;
  bytes: number;
}

/** One model request of the statistics ledger. */
export interface Step {
  type: 'step';
  id: string;
  category: 'model';
  turnId?: string;
  step: TraceUsageStep;
  start: number;
  end: number;
  timed: boolean;
  error: false;
}

export interface Turn {
  type: 'turn';
  id: string;
  turnId?: string;
  index: number;
  start: number;
  end: number;
  /** The turn has an end marker. */
  ended: boolean;
  status?: string;
  error?: string;
  runId?: string;
  run?: Run;
  prompt?: string;
  children: Array<Span | Step>;
  /** The turn's own meta rows (start and end markers). */
  markers: TraceRow[];
  tokens: Tokens;
  tools: number;
  failures: number;
}

export type Item = Span | Step;
export type Node = Turn | Item;

export interface Tokens { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number; estimated: boolean; measured: boolean }
export const emptyTokens = (): Tokens => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, estimated: false, measured: false });

export function addStep(into: Tokens, step: TraceUsageStep): void {
  const add = (value: number | undefined) => { if (value !== undefined) into.measured = true; return value ?? 0; };
  into.input += add(step.inputTokens);
  into.cacheRead += add(step.cacheReadTokens);
  into.cacheWrite += add(step.cacheWriteTokens);
  into.output += add(step.outputTokens);
  into.reasoning += add(step.reasoningTokens);
  if (step.tokens === 'estimated') into.estimated = true;
}

export const timeOf = (row: TraceRow): number => Date.parse(row.at);

export function categoryOf(row: TraceRow): Category {
  if (row.kind === 'draft') return 'draft';
  const kind = row.kind;
  if (kind === 'user_message_chunk' || kind === 'agent_message_chunk' || kind === 'native_input_receipt') return 'message';
  if (kind === 'agent_thought_chunk') return 'thinking';
  if (kind === 'tool_call' || kind === 'tool_call_update') return 'tool';
  return 'system';
}

/** What groups rows into one span: a tool call by its id, anything else by the entity it is a version of. */
function spanKey(row: TraceRow, toolOf: ReadonlyMap<string, string>): string {
  const toolCallId = row.kind === 'tool_call' || row.kind === 'tool_call_update' ? row.toolCallId ?? toolOf.get(row.nativeId) : undefined;
  return toolCallId ? `tool:${toolCallId}` : `id:${row.nativeId}`;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'canceled', 'interrupted', 'error']);

/**
 * When a tool call ran. A journal row's `at` is when that revision was written, and a log imported again
 * holds revisions stamped with the provider's coarser times beside the live ones, so the first and last
 * `at` of a span can be an hour apart for a call that took 100 ms. Each result row is paired with the call
 * row written just before it (the same pass), and the longest such pair is the call.
 */
function toolTiming(rows: readonly TraceRow[]): { start: number; end: number } | undefined {
  let best: { start: number; end: number } | undefined;
  let call: TraceRow | undefined;
  for (const row of rows) {
    if (row.kind === 'tool_call') { call = row; continue; }
    if (row.kind !== 'tool_call_update' || !call) continue;
    const start = timeOf(call), end = timeOf(row);
    if (end >= start && (!best || end - start > best.end - best.start)) best = { start, end };
  }
  return best;
}

function spanOf(key: string, rows: TraceRow[]): Span {
  // An emptied revision has lost its type, turn and ids; the rows that kept them name the span.
  const first = rows.find((row) => row.kind !== 'draft' && !row.cleared) ?? rows.find((row) => !row.cleared) ?? rows[0]!;
  const last = rows[rows.length - 1]!;
  let bytes = 0, error = false;
  let name: string | undefined, toolKind: string | undefined, status: string | undefined, lane: SyncLane | undefined;
  for (const row of rows) {
    bytes += row.bytes;
    if (row.error) error = true;
    name ??= row.name;
    toolKind ??= row.toolKind;
    if (row.status) status = row.status;
    lane ??= row.lane;
  }
  // A call row names a tool; its updates carry output, not a better title.
  const title = rows.find((row) => row.kind === 'tool_call' && row.text)?.text ?? rows.find((row) => row.text)?.text;
  const category = categoryOf(first);
  const turnId = first.turnId ?? rows.find((row) => row.turnId)?.turnId;
  const toolCallId = first.toolCallId ?? rows.find((row) => row.toolCallId)?.toolCallId;
  const ran = category === 'tool' && status !== undefined && TERMINAL.has(status) ? toolTiming(rows) : undefined;
  const at = timeOf(first);
  const timed = ran !== undefined && ran.end > ran.start;
  return {
    type: 'span', id: key, category, kind: rows.some((row) => row.kind === 'tool_call') ? 'tool_call' : first.kind,
    ...(turnId ? { turnId } : {}), rows, start: ran?.start ?? at, end: timed ? ran!.end : ran?.start ?? at, timed,
    title: title ?? name ?? last.kind, ...(name ? { name } : {}), ...(toolKind ? { toolKind } : {}),
    ...(toolCallId ? { toolCallId } : {}), ...(status ? { status } : {}), error: error || status === 'failed',
    ...(lane ? { lane } : {}), bytes,
  };
}

export interface Folded {
  turns: Turn[];
  /** Spans outside any turn, in seq order, as one turn-less group. */
  loose: Turn | undefined;
  /** Every span and step by id. */
  byId: Map<string, Node>;
  /** The span each row belongs to, by seq. */
  spanOfSeq: Map<number, string>;
  start: number;
  end: number;
  totals: Totals;
}

export interface Totals { turns: number; tools: number; failures: number; messages: number; tokens: Tokens; activeMs: number; requests: number }

/** Folds a lane's rows, and the model requests that fall in it, into turns of spans. */
export function fold(rows: readonly TraceRow[], steps: readonly TraceUsageStep[], runs: readonly Run[], laneInfo: Pick<TraceLane, 'lane' | 'toolCallId' | 'subagentType'>): Folded {
  const lane = laneInfo.lane;
  const groups = new Map<string, TraceRow[]>();
  const turnRows = new Map<string, TraceRow[]>();
  const turnOrder: string[] = [];
  const looseKey = '\u0000loose';
  const toolOf = new Map<string, string>();
  for (const row of rows) if (row.toolCallId && (row.kind === 'tool_call' || row.kind === 'tool_call_update')) toolOf.set(row.nativeId, row.toolCallId);
  for (const row of rows) {
    if (row.kind === 'meta.turn_started' || row.kind === 'meta.turn_ended') {
      const turn = row.turnId ?? looseKey;
      if (!turnRows.has(turn)) { turnRows.set(turn, []); turnOrder.push(turn); }
      turnRows.get(turn)!.push(row);
      continue;
    }
    const key = spanKey(row, toolOf);
    const group = groups.get(key);
    if (group) group.push(row); else groups.set(key, [row]);
  }

  const byId = new Map<string, Node>();
  const spanOfSeq = new Map<number, string>();
  const childrenOf = new Map<string, Array<Span | Step>>();
  for (const [key, group] of groups) {
    const span = spanOf(key, group);
    byId.set(span.id, span);
    for (const row of group) spanOfSeq.set(row.seq, span.id);
    const turn = span.turnId ?? looseKey;
    if (!turnRows.has(turn)) { turnRows.set(turn, []); turnOrder.push(turn); }
    const list = childrenOf.get(turn);
    if (list) list.push(span); else childrenOf.set(turn, [span]);
  }

  const runById = new Map(runs.map((run) => [run.id, run]));
  const runByTurn = new Map<string, Run>();
  for (const run of runs) if (run.native?.nativeTurnId) runByTurn.set(run.native.nativeTurnId, run);

  const turns: Turn[] = [];
  let loose: Turn | undefined;
  for (const turnId of turnOrder) {
    const markers = turnRows.get(turnId) ?? [];
    const children = childrenOf.get(turnId) ?? [];
    const started = markers.find((row) => row.kind === 'meta.turn_started');
    const ended = [...markers].reverse().find((row) => row.kind === 'meta.turn_ended');
    let start = Infinity, end = -Infinity;
    for (const row of markers) { const at = timeOf(row); start = Math.min(start, at); end = Math.max(end, at); }
    for (const child of children) { start = Math.min(start, child.start); end = Math.max(end, child.end); }
    if (started) start = timeOf(started);
    if (ended) end = Math.max(timeOf(ended), end);
    const runId = markers.map((row) => row.runId).find(Boolean);
    const run = (runId ? runById.get(runId) : undefined) ?? (turnId !== looseKey ? runByTurn.get(turnId) : undefined);
    const prompt = children.find((child): child is Span => child.type === 'span' && child.kind === 'user_message_chunk')?.title ?? run?.prompt;
    const turn: Turn = {
      type: 'turn', id: turnId === looseKey ? 'turn:loose' : `turn:${turnId}`, ...(turnId !== looseKey ? { turnId } : {}), index: 0,
      start: Number.isFinite(start) ? start : 0, end: Number.isFinite(end) ? end : 0, ended: Boolean(ended),
      ...(ended?.status ? { status: ended.status } : {}), ...(ended?.error && ended.text ? { error: ended.text } : {}),
      ...(runId ?? run?.id ? { runId: runId ?? run!.id } : {}), ...(run ? { run } : {}), ...(prompt ? { prompt } : {}),
      children, markers, tokens: emptyTokens(), tools: 0, failures: 0,
    };
    if (turnId === looseKey) loose = turn; else turns.push(turn);
    byId.set(turn.id, turn);
  }
  // Turns met first through their spans are appended after the ones met through markers: order by time.
  turns.sort((a, b) => a.start - b.start);
  turns.forEach((turn, index) => { turn.index = index + 1; });

  // Model requests: by run when the ledger names one, else by time. A subagent lane takes its own subagent's requests:
  // by the tool call when the ledger keys them by it (Claude Code), else those of its subagent type within its span,
  // which still mixes two subagents of one type that ran at once.
  const own = laneInfo.toolCallId ? `:subagent:${laneInfo.toolCallId}` : undefined;
  const keyed = steps.some((step) => step.agent === 'subagent' && step.key.includes(':subagent:'));
  const wanted = steps.filter((step) => {
    if (lane === 'main') return step.agent === 'main';
    if (step.agent !== 'subagent') return false;
    if (keyed && own) return step.key.includes(own);
    return !laneInfo.subagentType || !step.subagentType || step.subagentType === laneInfo.subagentType;
  });
  const turnByRun = new Map<string, Turn>();
  for (const turn of turns) if (turn.runId) turnByRun.set(turn.runId, turn);
  const sorted = [...turns].sort((a, b) => a.start - b.start);
  const laneStart = sorted[0]?.start ?? Infinity, laneEnd = sorted.reduce((max, turn) => Math.max(max, turn.end), -Infinity);
  for (const step of wanted) {
    const at = step.startedAt ?? step.endedAt ?? step.at;
    if (lane !== 'main' && (at < laneStart - 1000 || at > laneEnd + 1000)) continue;
    let home = step.runId && lane === 'main' ? turnByRun.get(step.runId) : undefined;
    if (!home) home = sorted.find((turn) => at >= turn.start - 1000 && at <= turn.end + 1000);
    if (!home) continue;
    const end = step.endedAt ?? at;
    const start = step.startedAt ?? (step.durationMs !== undefined ? end - step.durationMs : end);
    const item: Step = { type: 'step', id: `step:${step.key}`, category: 'model', ...(home.turnId ? { turnId: home.turnId } : {}), step, start, end, timed: end > start, error: false };
    home.children.push(item);
    byId.set(item.id, item);
  }

  const totals: Totals = { turns: turns.length, tools: 0, failures: 0, messages: 0, tokens: emptyTokens(), activeMs: 0, requests: 0 };
  for (const turn of loose ? [...turns, loose] : turns) {
    turn.children = ordered(turn.children);
    for (const child of turn.children) {
      if (child.type === 'step') { addStep(turn.tokens, child.step); addStep(totals.tokens, child.step); totals.requests += 1; continue; }
      if (child.category === 'tool') { turn.tools += 1; totals.tools += 1; }
      if (child.category === 'message') totals.messages += 1;
      if (child.error) { turn.failures += 1; totals.failures += 1; }
    }
    if (turn.error || turn.status === 'failed') totals.failures += 1;
    if (turn !== loose) totals.activeMs += Math.max(0, turn.end - turn.start);
  }
  let start = Infinity, end = -Infinity;
  for (const turn of turns) { start = Math.min(start, turn.start); end = Math.max(end, turn.end); }
  if (loose) { start = Math.min(start, loose.start); end = Math.max(end, loose.end); }
  return { turns, loose, byId, spanOfSeq, start: Number.isFinite(start) ? start : 0, end: Number.isFinite(end) ? end : 0, totals };
}

/**
 * A turn's items in the order they happened: spans in journal order (the order rows were written, which
 * timestamps do not always keep), and each model request before the first span that started after it.
 */
function ordered(items: Array<Span | Step>): Array<Span | Step> {
  const spans = items.filter((item): item is Span => item.type === 'span').sort((a, b) => a.rows[0]!.seq - b.rows[0]!.seq);
  const steps = items.filter((item): item is Step => item.type === 'step').sort((a, b) => a.start - b.start);
  const out: Array<Span | Step> = [];
  let next = 0;
  for (const span of spans) {
    while (next < steps.length && steps[next]!.start <= span.start) out.push(steps[next++]!);
    out.push(span);
  }
  while (next < steps.length) out.push(steps[next++]!);
  return out;
}

/* ------------------------------------------------------------------ filtering */

export interface Filter {
  categories: ReadonlySet<Category>;
  query: string;
  errorsOnly: boolean;
  /** Epoch-ms range from the overview, inclusive. */
  range?: readonly [number, number];
}

function haystackOf(item: Item | TraceRow): Array<string | undefined> {
  if ('seq' in item) return [item.kind, item.type, item.nativeId, item.text, item.name, item.toolCallId, item.status, String(item.seq)];
  if (item.type === 'step') return [item.step.model, item.step.requestedModel, item.step.key, item.step.nativeMessageId, item.step.runId];
  return [item.title, item.name, item.kind, item.toolCallId, item.status, item.toolKind, ...item.rows.flatMap((row) => [row.nativeId, row.text])];
}

function matchesQuery(item: Item | TraceRow, query: string): boolean {
  if (!query) return true;
  return haystackOf(item).some((value) => value !== undefined && value.toLowerCase().includes(query));
}

const inRange = (start: number, end: number, range: readonly [number, number] | undefined) => !range || (end >= range[0] && start <= range[1]);

export function itemVisible(item: Item, filter: Filter): boolean {
  if (!filter.categories.has(item.category)) return false;
  if (filter.errorsOnly && !item.error) return false;
  if (!inRange(item.start, item.end, filter.range)) return false;
  return matchesQuery(item, filter.query);
}

export function rowVisible(row: TraceRow, filter: Filter): boolean {
  const category = categoryOf(row);
  // In the log, the turn markers are system rows.
  if (!filter.categories.has(category)) return false;
  if (filter.errorsOnly && !row.error) return false;
  const at = timeOf(row);
  if (!inRange(at, at, filter.range)) return false;
  return matchesQuery(row, filter.query);
}

/* ------------------------------------------------------------------ the list */

export type Line =
  | { type: 'turn'; turn: Turn; expanded: boolean; shown: number }
  | {
    type: 'item'; item: Item; turn: Turn;
    /** The model request whose output this is, when that request is listed too: drawn one level in under it. */
    parent?: string;
    /** A model request's place in its turn, from 1, and whether it names its model (the first, and where the model changes). */
    request?: number; namesModel?: boolean;
  }
  | { type: 'row'; row: TraceRow };

/** The rows the span list draws: each turn, then its visible items when it is open. A turn with no visible item is left out while filtering. */
export function spanLines(folded: Folded, filter: Filter, collapsed: ReadonlySet<string>): Line[] {
  const lines: Line[] = [];
  // Turning a category off thins the turns out; only a search, failures-only or a time range drops whole turns.
  const filtering = filter.query !== '' || filter.errorsOnly || filter.range !== undefined;
  const all = folded.loose ? [folded.loose, ...folded.turns] : folded.turns;
  for (const turn of all) {
    const items: Array<Extract<Line, { type: 'item' }>> = [];
    let request = 0, model: string | undefined, parent: string | undefined;
    for (const item of turn.children) {
      const visible = itemVisible(item, filter);
      if (item.type === 'step') {
        request += 1;
        const name = item.step.model ?? item.step.requestedModel;
        const namesModel = request === 1 || name !== model;
        model = name;
        parent = visible ? item.id : undefined;
        if (visible) items.push({ type: 'item', item, turn, request, namesModel });
        continue;
      }
      if (!visible) continue;
      items.push({ type: 'item', item, turn, ...(parent && isOutput(item) ? { parent } : {}) });
    }
    const turnMatches = filter.errorsOnly ? Boolean(turn.error || turn.status === 'failed') : false;
    if (filtering && items.length === 0 && !turnMatches) continue;
    const expanded = !collapsed.has(turn.id);
    lines.push({ type: 'turn', turn, expanded, shown: items.length });
    if (expanded) lines.push(...items);
  }
  return lines;
}

/** What a model request produces, and so follows it in the list: its tool calls, thinking and text. */
function isOutput(span: Span): boolean {
  return span.category === 'tool' || span.category === 'thinking' || span.category === 'draft' || span.kind === 'agent_message_chunk';
}

export function logLines(rows: readonly TraceRow[], filter: Filter): Line[] {
  const lines: Line[] = [];
  for (const row of rows) if (rowVisible(row, filter)) lines.push({ type: 'row', row });
  return lines;
}

export const lineId = (line: Line): string => line.type === 'turn' ? line.turn.id : line.type === 'item' ? line.item.id : `row:${line.row.seq}`;

/* ------------------------------------------------------------------ request context (docs/TRACE.md §2.1) */

export interface RequestIndex {
  data: TraceRequests;
  /** Requests by time sent, oldest first. */
  sorted: Array<{ at: number; request: TraceRequest }>;
  byTurn: Map<string, TraceRequest>;
  prompts: Map<string, TracePrompt>;
  /** How many requests were sent with each prompt. */
  uses: Map<string, number>;
}

export function indexRequests(data: TraceRequests): RequestIndex {
  const sorted = data.requests.map((request) => ({ at: Date.parse(request.at), request })).filter((entry) => Number.isFinite(entry.at)).sort((a, b) => a.at - b.at);
  const byTurn = new Map<string, TraceRequest>();
  const uses = new Map<string, number>();
  for (const request of data.requests) {
    if (request.turnId && !byTurn.has(request.turnId)) byTurn.set(request.turnId, request);
    if (request.prompt) uses.set(request.prompt, (uses.get(request.prompt) ?? 0) + 1);
  }
  return { data, sorted, byTurn, prompts: new Map(data.prompts.map((prompt) => [prompt.id, prompt])), uses };
}

/** Index of the last request sent at or before `t`, or -1. */
function lastAtOrBefore(index: RequestIndex, t: number): number {
  let lo = 0, hi = index.sorted.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (index.sorted[mid]!.at <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/** How far a step's start may be from its recorded request: both are stamped as the request is sent. */
const REQUEST_MATCH_MS = 5_000;

/**
 * The recorded request a model step was sent as. Per-request records (Claude Code) are matched by time, the
 * nearest within a few seconds; per-turn records (Codex) by the step's turn, else the last turn begun before it.
 */
export function requestOfStep(index: RequestIndex, step: Step): TraceRequest | undefined {
  if (index.data.granularity === 'turn') {
    const byTurn = step.turnId ? index.byTurn.get(step.turnId) : undefined;
    if (byTurn) return byTurn;
    const at = lastAtOrBefore(index, step.start);
    return at >= 0 ? index.sorted[at]!.request : undefined;
  }
  // The nearest is the last sent at or before the step's start, or the first after it.
  const at = lastAtOrBefore(index, step.start);
  let best: { at: number; request: TraceRequest } | undefined;
  for (const candidate of [index.sorted[at], index.sorted[at + 1]]) {
    if (!candidate || Math.abs(candidate.at - step.start) > REQUEST_MATCH_MS) continue;
    if (!best || Math.abs(candidate.at - step.start) < Math.abs(best.at - step.start)) best = candidate;
  }
  return best?.request;
}

/** The requests sent during a turn, oldest first. */
export function requestsOfTurn(index: RequestIndex, turn: Turn): TraceRequest[] {
  if (index.data.granularity === 'turn') {
    const byTurn = turn.turnId ? index.byTurn.get(turn.turnId) : undefined;
    if (byTurn) return [byTurn];
  }
  const from = lastAtOrBefore(index, turn.start - 1) + 1;
  const out: TraceRequest[] = [];
  for (let i = from; i < index.sorted.length && index.sorted[i]!.at <= turn.end + 1000; i++) out.push(index.sorted[i]!.request);
  return out;
}

/** Where the prompt changed: each prompt after the first, at the first request sent with it. */
export function promptChanges(index: RequestIndex): Array<{ id: string; at: number }> {
  return index.data.prompts.slice(1).map((prompt) => ({ id: `prompt:${prompt.id}`, at: Date.parse(prompt.at) })).filter((mark) => Number.isFinite(mark.at));
}
