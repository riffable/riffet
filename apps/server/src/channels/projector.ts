import { catalogEntry, catalogParams, paramKind, parseSelection, resolveCatalogSelection, type ModelInfo, type ModelParam, type Run, type Session } from '../../../../packages/contracts/src/index.js';
import type { TimelineRow } from '../../../../packages/contracts/src/sync.js';
import { contentDiffStats } from '../../../../packages/timeline/src/lineDiff.js';
import { stripRoot, toolDataKind, toolTitleOf } from '../../../../packages/timeline/src/toolTitle.js';
import { isRecord, str } from '../../../../packages/timeline/src/values.js';
import { redactSensitiveText } from '../settings/config-documents.js';
import type { ChannelCardOptions } from '../../../../packages/contracts/src/channels.js';
import type { ModelPickerView, TurnFooter, TurnStep, TurnView } from './types.js';

/*
 * Folds the timeline rows of one turn into the platform-free `TurnView` every provider draws
 * (docs/design/channels.md, 投影). Pure: the caller reads rows, runs and status.
 */

const OUTPUT_LIMIT = 800;
const PROMPT_LIMIT = 500;
const TERMINAL: ReadonlySet<Run['state']> = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

export const isTerminalRun = (run: Run): boolean => TERMINAL.has(run.state);

export interface ProjectInput {
  session: Session;
  run: Run;
  /** The turn's rows in order; empty while the run is still queued. */
  rows: TimelineRow[];
  source: TurnView['source'];
  /** The project directory, stripped from paths in tool titles and output. */
  root?: string;
  /** The conversation waits for an answer to a question or approval. */
  waiting?: boolean;
  /** `timeline.turnText()` answer of a completed turn; preferred over the streamed one. */
  finalAnswer?: string;
  stopRef?: string;
  /** The bot's merged card options, read when the view is built. */
  card: ChannelCardOptions;
  /** The selection's display name from the model catalog, when it is known. */
  modelName?: string;
  /** The cached catalog, so a native variant id in the session's model shows its effort. */
  models?: ModelInfo[];
  /** Latest `used / size` of the context meter, in percent. */
  contextPercent?: number;
  now?: number;
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Text a tool call produced: a job's or activity's output, else the call's own content. */
function toolOutput(row: Extract<TimelineRow, { kind: 'tool' }>): string | undefined {
  const data = row.event.data;
  const direct = row.job?.output ?? row.activity?.detail;
  if (direct) return direct;
  const raw = data.rawOutput ?? data.output;
  if (typeof raw === 'string') return raw;
  const content = Array.isArray(data.content) ? data.content : [];
  const parts = content.flatMap(item => {
    if (!isRecord(item)) return [];
    const inner = isRecord(item.content) ? item.content : item;
    return inner.type === 'text' && str(inner.text) ? [str(inner.text)!] : [];
  });
  return parts.length ? parts.join('\n') : undefined;
}

function toolState(row: Extract<TimelineRow, { kind: 'tool' }>): TurnStep['state'] {
  if (row.job) return row.job.status === 'running' ? 'running' : row.job.status === 'failed' ? 'failed' : 'done';
  if (row.activity) return row.activity.status === 'running' || row.activity.status === 'stopping' ? 'running' : row.activity.status === 'failed' ? 'failed' : 'done';
  const status = str(row.event.data.status) ?? str(row.event.data.state) ?? 'completed';
  if (status === 'failed' || status === 'error') return 'failed';
  return ['pending', 'in_progress', 'running', 'queued'].includes(status) ? 'running' : 'done';
}

function planText(entries: Record<string, unknown>[]): string {
  return entries.map(entry => `${entry.status === 'completed' ? '[x]' : '[ ]'} ${str(entry.content) ?? str(entry.step) ?? ''}`.trimEnd()).join('\n');
}

/** A stored selection read through the catalog, so a flat native variant id keeps its effort and fast. */
function readSelection(models: ModelInfo[] | undefined, selection: string | undefined): string | undefined {
  return models?.length ? resolveCatalogSelection(models, selection) ?? selection : selection;
}

/** The marks of a selection worth showing beside the model name: "fast", an effort, "1M". */
export function modelMarks(params: Record<string, string>): string[] {
  const marks: string[] = [];
  if (params.fast === 'true') marks.push('fast');
  if (params.effort && params.effort !== 'default') marks.push(params.effort);
  if (params.context?.toLowerCase() === '1m') marks.push('1M');
  return marks;
}

const MODEL_LIMIT = 100;
const PARAM_TITLES: Record<string, string> = { effort: '推理强度', reasoning: '推理强度', reasoning_effort: '推理强度', context: '上下文窗口', fast: '速度', thinking: '思考' };

function paramTitle(param: ModelParam): string {
  return PARAM_TITLES[param.id] ?? param.name;
}

const EFFORT_LABELS: Record<string, string> = {
  default: '默认',
  none: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'xhigh',
  'extra-high': 'xhigh',
  max: 'Max',
};

function optionTitle(param: ModelParam, option: { value: string; label: string }): string {
  const kind = paramKind(param);
  if (kind === 'effort') {
    const key = option.value.toLowerCase();
    return EFFORT_LABELS[key] ?? (option.label.length > 16 && option.value ? option.value : option.label);
  }
  if (kind === 'fast') return option.value === 'true' ? '快速' : option.value === 'false' ? '标准' : option.label;
  if (kind === 'toggle') return option.value === 'true' ? '开' : '关';
  return option.label;
}

export interface ModelViewInput {
  ref: string;
  scope: ModelPickerView['scope'];
  backend: ModelPickerView['backend'];
  backends?: ModelPickerView['backends'];
  models: ModelInfo[];
  /** The full selection string (`model[k=v,…]`); empty means the backend's default, passed as `defaultModel`. */
  selection: string;
  defaultModel?: string;
  note?: string;
  error?: string;
}

/** The `/model` card: the model list, and the selected model's parameters with their current values. */
export function buildModelView(input: ModelViewInput): ModelPickerView {
  const { model, params: overrides } = parseSelection(readSelection(input.models, input.selection || input.defaultModel));
  const info = catalogEntry(input.models, model);
  const modelId = info?.value ?? model;
  const params = catalogParams(input.models, modelId, overrides);
  const marks = modelMarks(Object.fromEntries(params.map(param => [param.id, param.value])));
  const summary = [info?.name ?? (modelId || '默认'), ...marks].join(' · ');
  const choices = input.models.map(item => ({ id: item.value, name: item.name }));
  const models = choices.length > MODEL_LIMIT ? [...choices.slice(0, MODEL_LIMIT - 1), ...choices.filter(item => item.id === modelId)].slice(0, MODEL_LIMIT) : choices;
  return {
    kind: 'model-picker', ref: input.ref, scope: input.scope, backend: input.backend,
    ...(input.backends ? { backends: input.backends } : {}),
    models, modelId,
    params: params.map(param => ({ id: param.id, label: paramTitle(param), value: param.value, options: param.options.map(option => ({ value: option.value, label: optionTitle(param, option) })) })),
    summary,
    ...(input.note ? { note: input.note } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
}

const DIFF_CACHE_LIMIT = 1000;
const diffCache = new Map<string, { added: number; removed: number } | undefined>();

/** Line counts of a tool row's edits. A finished row no longer changes, so its LCS runs once, not on every push. */
function toolDiffStats(sessionId: string, row: Extract<TimelineRow, { kind: 'tool' }>): { added: number; removed: number } | undefined {
  const compute = () => contentDiffStats(Array.isArray(row.event.data.content) ? row.event.data.content.filter(isRecord) : []);
  if (toolState(row) === 'running') return compute();
  const key = `${sessionId}:${row.key}`;
  if (diffCache.has(key)) return diffCache.get(key);
  const stats = compute();
  diffCache.set(key, stats);
  while (diffCache.size > DIFF_CACHE_LIMIT) diffCache.delete(diffCache.keys().next().value!);
  return stats;
}

export function projectTurn(input: ProjectInput): TurnView {
  const { session, run, rows, root } = input;
  const terminal = isTerminalRun(run);
  const steps: TurnStep[] = [];
  const answers: Array<Extract<TimelineRow, { kind: 'assistant' }>> = [];
  const failures: string[] = [];
  let added = 0;
  let removed = 0;
  let edits = 0;
  for (const row of rows) {
    switch (row.kind) {
      case 'thought':
        if (row.text.trim()) steps.push({ id: row.key, kind: 'thought', text: row.text, state: 'done' });
        break;
      case 'assistant':
        if (!row.text.trim()) break;
        if (row.phase === 'commentary') steps.push({ id: row.key, kind: 'narration', text: row.text, state: 'done' });
        else answers.push(row);
        break;
      case 'tool': {
        const stats = toolDiffStats(session.id, row);
        if (stats) { added += stats.added; removed += stats.removed; edits += 1; }
        const { title } = toolTitleOf(row.event.data, '工具调用', root);
        const output = toolOutput(row);
        const kind = toolDataKind(row.event.data);
        const label = redactSensitiveText(kind === 'agent' ? `子任务 · ${title}` : title);
        // Clipped before redaction so a huge output is not scanned whole on every push.
        steps.push({ id: row.key, kind: 'tool', title: label, text: '', state: toolState(row), ...(output ? { output: redactSensitiveText(clip(stripRoot(output, root), OUTPUT_LIMIT)) } : {}) });
        break;
      }
      case 'plan':
        steps.push({ id: row.key, kind: 'plan', title: '计划', text: planText(row.entries), state: 'done' });
        break;
      case 'status':
        if (row.tone === 'danger') failures.push(row.text);
        break;
      default: break;
    }
  }
  // Text that ended up before a later row is no longer the live edge; only the newest step of an open turn is still running.
  const last = steps.at(-1);
  if (!terminal && last && last.kind !== 'tool' && last.kind !== 'plan') last.state = 'running';
  if (terminal) for (const step of steps) if (step.state === 'running') step.state = 'done';

  // Mid-turn, a phase-less assistant row followed by more rows is interim narration, not the answer yet.
  const plain = answers.findLast(row => row.phase === undefined);
  const streamed = (answers.findLast(row => row.phase === 'final_answer') ?? (terminal || plain === rows.at(-1) ? plain : undefined))?.text ?? '';
  // Only a finished turn has a settled answer; an interrupted one keeps what was streamed, never the thoughts.
  const answer = run.state === 'completed' && input.finalAnswer?.trim() ? input.finalAnswer : streamed;
  const error = run.state === 'completed' ? undefined : redactSensitiveText(run.error ?? failures.at(-1) ?? '').trim() || undefined;
  const status: TurnView['status'] = run.state === 'queued' ? 'queued' : run.state === 'running' ? (input.waiting ? 'waiting' : 'running') : run.state;
  const end = terminal ? Date.parse(run.updatedAt) : (input.now ?? Date.now());
  const elapsedMs = Math.max(0, end - Date.parse(run.createdAt));
  const selection = session.model ? parseSelection(readSelection(input.models, session.model)) : undefined;
  const marks = selection ? modelMarks(selection.params) : [];
  const footer: TurnFooter = {
    ...(selection?.model ? { model: input.modelName ?? selection.model } : {}),
    ...(marks.length ? { modelMarks: marks } : {}),
    ...(Number.isFinite(elapsedMs) ? { elapsedMs } : {}),
    ...(input.contextPercent !== undefined ? { contextPercent: input.contextPercent } : {}),
    ...(edits ? { changes: { added, removed } } : {}),
  };
  return {
    sessionId: session.id, runId: run.id, title: session.displayTitle ?? session.title, status, source: input.source,
    ...(input.source === 'other-client' ? { prompt: clip(run.prompt, PROMPT_LIMIT) } : {}),
    steps, answer, ...(error ? { error } : {}),
    card: input.card, footer,
    ...(!terminal && input.stopRef ? { stopRef: input.stopRef } : {}),
  };
}
