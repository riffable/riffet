import { useCallback, useRef } from 'react';
import type { Session, SyncLane, TimelineRow, UserAttachment } from '@contracts';
import type { DiffLine, SessionService, TimelineService } from '@riffet/plugin-web';
import type { Messages } from './messages';
import { shellWrites, type ShellDir } from './shell-writes';

/*
 * What the canvases know about a turn, folded from its timeline rows: the steps it took in order,
 * the actors it started (subagents and background tasks, which outlive a single step), and which
 * earlier actors reported back in it.
 */

/** The tracks a tool call is drawn on, by what it does; writes go to the change tracks instead. */
export type Track = 'shell' | 'explore' | 'web' | 'ask' | 'other';

export type StepKind = 'thought' | 'tool' | 'subagent' | 'background' | 'answer' | 'commentary' | 'plan' | 'status' | 'compaction';
/** ACP tool kinds, folded to the few the inspector's timing bars colour apart. */
export type ToolKind = 'read' | 'search' | 'edit' | 'execute' | 'fetch' | 'other';

export interface Step {
  key: string;
  kind: StepKind;
  label: string;
  start: number;
  end: number;
  running: boolean;
  failed: boolean;
  tool?: ToolKind;
  /** The tool as the CLI names it (`execute`, `Bash`), what the call says it does, and what it acted on. */
  kindName?: string;
  toolName?: string;
  title?: string;
  arg?: string;
  /** The lines an edit added and removed. */
  added?: number;
  removed?: number;
  /** Which track the call is drawn on, its targets wherever they are, and what it printed (capped). */
  track?: Track;
  targets?: string[];
  output?: string;
  /** A plan's entries, as the CLI lists them. */
  entries?: Array<{ text: string; status: string }>;
  /** A subagent's own lane, which the step can open into. */
  lane?: SyncLane;
}

export interface Actor {
  key: string;
  kind: 'subagent' | 'background';
  label: string;
  /** The subagent type or the shell command. */
  note?: string;
  start: number;
  end: number;
  running: boolean;
  failed: boolean;
  lane?: SyncLane;
  /** Ids a later `task_notification` names this actor by. */
  refs: string[];
}

/** One file a turn wrote: every edit it made there, what they add up to, and the first lines changed. */
export interface FileChange {
  path: string;
  added: number;
  removed: number;
  created: boolean;
  deleted: boolean;
  edits: Array<{ before: string; after: string }>;
  /** The opening changed lines with a line of context, across the edits in order. */
  preview: DiffLine[];
  /** Shell commands that wrote the file without a diff, so their lines are not in the counts. */
  commands: string[];
  at: number;
}

/**
 * Something a turn showed or made: an image the agent read or viewed, or generated; a web page it
 * wrote. [key] tells it apart across turns; a page has no preview, only its [path].
 */
export interface Artifact { key: string; kind: 'image' | 'page'; name: string; src?: string; path?: string }

/** A message the reader sent into a turn already under way. */
export interface Steer { key: string; text: string; at: number }
/** A background actor reporting back, which is what started a turn that has no question of its own. */
export interface Arrival { id: string; title: string; status: string; at: number }

export interface TurnDetail {
  steps: Step[];
  actors: Actor[];
  userText?: string;
  attachments: UserAttachment[];
  artifacts: Artifact[];
  steers: Steer[];
  arrivals: Arrival[];
  /** The question's native id, for opening the transcript at a turn that has no run of its own. */
  userNativeId?: string;
  answer?: string;
  tools: number;
  /** Ids of actors whose completion this turn reports. */
  notifies: string[];
  /** The files the turn wrote, in the order it first wrote them. */
  changes: FileChange[];
  start: number;
  end: number;
}

export const turnKey = (sessionId: string, turn: string) => `${sessionId}|${turn}`;

const time = (value: string | undefined) => value ? Date.parse(value) || 0 : 0;
const IMAGE_FILE = /\.(?:png|jpe?g|webp|gif)$/i;
const HTML_FILE = /\.html?$/i;
/** Where Riffet keeps a message's uploaded attachments for the agent to read. */
const ATTACHMENT_FILE = /\/riffet-attachments\//;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

function toolKind(kind: string): ToolKind {
  if (kind === 'read') return 'read';
  if (kind === 'search') return 'search';
  if (kind === 'edit' || kind === 'delete' || kind === 'move') return 'edit';
  if (kind === 'execute') return 'execute';
  if (kind === 'fetch') return 'fetch';
  return 'other';
}

/** What folding rows takes from the host (how a tool call reads, how an edit diffs) and from the language (the labels it gives steps). */
export interface FoldContext {
  timeline: TimelineService;
  /** A URL for an image file a tool call named in [sessionId]. */
  media: (sessionId: string, path: string) => string;
  words: Pick<Messages, 'think' | 'plan' | 'subagent' | 'backgroundTask' | 'toolCall'>;
}

/** Folds one turn's rows (or a whole subagent lane) into what the canvases draw. */
export function turnDetail(sessionId: string, rows: readonly TimelineRow[], root: string | undefined, now: number, { timeline, media, words }: FoldContext): TurnDetail {
  const steps: Step[] = [];
  const actors: Actor[] = [];
  const notifies: string[] = [];
  let tools = 0;
  let answer: string | undefined, userText: string | undefined, userNativeId: string | undefined;
  let attachments: UserAttachment[] = [];
  // Per turn, by file or by source, in the order they came.
  const artifacts = new Map<string, Artifact>();
  const steers: Steer[] = [];
  const arrivals: Arrival[] = [];
  const changes = new Map<string, FileChange>();
  let start = Infinity, end = 0;
  // Where a shell that keeps its directory between calls stands; until a `cd` says so, only assumed.
  let shell: ShellDir | undefined = root ? { cwd: root, known: false } : undefined;
  for (const row of rows) {
    const at = time(row.event.createdAt), last = Math.max(at, time(row.event.lastAt));
    start = Math.min(start, at);
    end = Math.max(end, last);
    const base = { key: row.key, start: at, end: last, running: false, failed: false };
    switch (row.kind) {
      case 'user':
        if (userText === undefined) {
          userText = row.text;
          userNativeId = row.event.nativeId;
          attachments = row.attachments;
        } else steers.push({ key: row.key, text: row.text, at });
        break;
      case 'thought':
        steps.push({ ...base, kind: 'thought', label: firstLine(row.text) || words.think });
        break;
      case 'assistant':
        if (row.phase === 'commentary') steps.push({ ...base, kind: 'commentary', label: firstLine(row.text) });
        else { answer = row.text; steps.push({ ...base, kind: 'answer', label: firstLine(row.text) }); }
        break;
      case 'image': {
        // An image the agent made; its source is usually a data URL, which would make a poor key.
        const mime = /^data:image\/([\w.+-]+)/i.exec(row.src)?.[1];
        if (!artifacts.has(row.src)) artifacts.set(row.src, { key: row.key, kind: 'image', name: mime ? `image.${mime.replace(/\+.*/, '')}` : baseName(row.src), src: row.src });
        break;
      }
      case 'plan': {
        const entries = row.entries.map((entry) => ({ text: String(entry.content ?? entry.title ?? ''), status: String(entry.status ?? 'pending') })).filter((entry) => entry.text);
        // A plan is restated as it progresses: the latest statement replaces the earlier one.
        const earlier = steps.findIndex((step) => step.kind === 'plan');
        if (earlier >= 0) steps.splice(earlier, 1);
        steps.push({ ...base, kind: 'plan', label: words.plan, entries });
        break;
      }
      case 'activity':
        if (row.activity.kind === 'compaction') {
          const { preTokens, postTokens } = row.activity.compaction ?? {};
          steps.push({ ...base, kind: 'compaction', label: preTokens && postTokens ? `${Math.round(preTokens / 1000)}k → ${Math.round(postTokens / 1000)}k` : '' });
        }
        break;
      case 'status':
        steps.push({ ...base, kind: 'status', label: row.text, failed: row.tone === 'danger' });
        break;
      case 'task_notification':
        if (row.taskId) notifies.push(row.taskId);
        if (row.subagentToolCallId) notifies.push(row.subagentToolCallId);
        arrivals.push({ id: row.subagentToolCallId ?? row.taskId ?? row.key, title: row.title, status: row.status, at });
        break;
      case 'tool': {
        const view = timeline.toolCall(row, sessionId, root);
        const refs = [view?.id, row.job?.id, row.activity?.id].filter((id): id is string => Boolean(id));
        if (row.subagent) {
          const s = row.subagent;
          const running = s.running || s.status === 'running';
          const actor: Actor = {
            key: row.key, kind: 'subagent', label: s.title || view?.title || words.subagent,
            ...(s.subagentType ? { note: s.subagentType } : {}),
            start: time(s.startedAt) || at, end: running ? now : time(s.endedAt) || last, running, failed: s.status === 'failed', lane: s.lane, refs,
          };
          actors.push(actor);
          steps.push({ ...base, key: actor.key, kind: 'subagent', label: actor.label, start: actor.start, end: actor.end, running, failed: actor.failed, lane: s.lane });
        } else if (row.job || row.activity?.kind === 'background_task') {
          const job = row.job, activity = row.activity;
          const began = time(job?.startedAt ?? activity?.startedAt) || at;
          const running = job?.status === 'running' || activity?.status === 'running';
          const finished = activity?.endedAt ? time(activity.endedAt) : job?.runningMs ? began + job.runningMs : activity?.durationMs ? began + activity.durationMs : last;
          const command = job?.command || activity?.task?.command;
          const actor: Actor = {
            key: row.key, kind: 'background', label: activity?.title || view?.title || command || words.backgroundTask,
            ...(command ? { note: command } : {}),
            start: began, end: running ? now : finished, running, failed: job?.status === 'failed' || activity?.status === 'failed', refs,
          };
          actors.push(actor);
          steps.push({ ...base, key: actor.key, kind: 'background', label: actor.label, start: began, end: actor.end, running, failed: actor.failed });
        } else {
          tools += 1;
          const status = view?.status ?? 'completed';
          // What the call acted on: its command or file, else the one input that names its target.
          const input = view?.rawInput;
          const named = ['query', 'url', 'pattern', 'file_path', 'path', 'prompt'].map((field) => input?.[field]).find((value): value is string => typeof value === 'string' && value.length > 0);
          const arg = view?.command ?? view?.locations[0]?.path ?? named;
          const diff = view?.diff;
          if (view && status !== 'failed' && status !== 'error') {
            // Images it read or viewed: a read of an image file, or an image among what the call returned.
            // The file as the call itself named it, which is what the server finds it by.
            const located = Array.isArray(row.event.data.locations) ? row.event.data.locations.flatMap((location) => isRecord(location) && typeof location.path === 'string' ? [location.path] : []) : view.locations.map((location) => location.path);
            const files = [...(view.kind === 'read' ? located.filter((path) => IMAGE_FILE.test(path)) : []), ...view.contents.flatMap((content) => {
              const image = content.type === 'image' ? content : isRecord(content.content) && content.content.type === 'image' ? content.content : undefined;
              return typeof image?.path === 'string' ? [image.path] : [];
            })];
            // An attachment the agent opens is the reader's own image, already on the question.
            for (const path of files) if (!ATTACHMENT_FILE.test(path) && !artifacts.has(path)) artifacts.set(path, { key: path, kind: 'image', name: baseName(path), src: `${media(sessionId, path)}&v=${row.pos}`, path });
            for (const content of view.contents) {
              if (content.type !== 'diff' || typeof content.path !== 'string') continue;
              const before = typeof content.oldText === 'string' ? content.oldText : '';
              const after = String(content.newText ?? '');
              noteChange(timeline, changes, timeline.relativePath(content.path, root).replace(/^\.\//, ''), before, after, view.kind === 'delete', at);
            }
            const command = view.kind === 'execute' ? view.command ?? (typeof input?.command === 'string' ? input.command : undefined) : undefined;
            const from: ShellDir | undefined = typeof input?.cwd === 'string' ? { cwd: input.cwd, known: true } : shell;
            if (command && from) {
              const home = from.cwd.match(/^\/(?:Users|home)\/[^/]+/)?.[0];
              const written = shellWrites(command, from, home);
              for (const path of written.files) noteCommandWrite(changes, timeline.relativePath(path, root).replace(/^\.\//, ''), command, at);
              if (typeof input?.cwd !== 'string') shell = written.end;
            }
          }
          const toolName = view?.toolName;
          const track = trackOf(view?.kind ?? 'other', input);
          const targets = [...new Set(view?.locations.map((location) => location.path.replace(/^\.\//, '')).filter((path) => path && path !== '.') ?? [])];
          const output = view ? outputOf(view.contents) : undefined;
          steps.push({
            ...(track ? { track } : {}), ...(targets.length ? { targets } : {}), ...(output ? { output } : {}),
            ...base, kind: 'tool', label: view?.command || view?.title || words.toolCall, tool: toolKind(view?.kind ?? 'other'),
            kindName: view?.kind ?? 'other', ...(toolName ? { toolName } : {}), ...(view?.title ? { title: view.title } : {}), ...(arg ? { arg } : {}),
            ...(diff ? { added: diff.added, removed: diff.removed } : {}),
            running: ['pending', 'in_progress', 'running', 'queued'].includes(status), failed: status === 'failed' || status === 'error',
          });
        }
        break;
      }
      default:
        break;
    }
  }
  if (start === Infinity) start = end = now;
  for (const step of steps) end = Math.max(end, step.running ? now : step.end);
  // Pages it wrote: shown by name, as there is nothing to preview.
  for (const change of changes.values()) if (HTML_FILE.test(change.path) && !change.deleted && !artifacts.has(change.path)) artifacts.set(change.path, { key: change.path, kind: 'page', name: baseName(change.path), path: change.path });
  return {
    steps, actors, tools, notifies, start, end, attachments, artifacts: [...artifacts.values()], steers, arrivals, changes: [...changes.values()],
    ...(answer ? { answer } : {}), ...(userText ? { userText } : {}), ...(userNativeId ? { userNativeId } : {}),
  };
}

const PREVIEW_LINES = 12;
const OUTPUT_CHARS = 4000;

/** What a call is, for its track: provider kinds only, and Codex's mixed command batches by what they hold. */
function trackOf(kind: string, input: Record<string, unknown> | undefined): Track | undefined {
  if (kind === 'execute') return 'shell';
  if (kind === 'read' || kind === 'search') return 'explore';
  if (kind === 'fetch') return 'web';
  if (kind === 'question') return 'ask';
  if (['edit', 'delete', 'move', 'agent', 'think', 'plan', 'switch_mode'].includes(kind)) return undefined;
  const actions = Array.isArray(input?.commandActions) ? input.commandActions as Array<{ type?: unknown }> : [];
  if (actions.length) return actions.every((action) => action.type === 'read' || action.type === 'search' || action.type === 'listFiles') ? 'explore' : 'shell';
  return 'other';
}

/** The text a call returned, as one string: its first part and its tail, where results usually end. */
function outputOf(contents: readonly Record<string, unknown>[]): string | undefined {
  const text = contents.flatMap((item) => {
    const inner = item.type === 'content' && typeof item.content === 'object' && item.content ? item.content as Record<string, unknown> : undefined;
    if (inner?.type === 'text' && typeof inner.text === 'string') return [inner.text];
    if (typeof item.output === 'string') return [item.output];
    return [];
  }).join('\n').trim();
  if (!text) return undefined;
  return text.length > OUTPUT_CHARS ? `${text.slice(0, OUTPUT_CHARS / 2)}\n…\n${text.slice(-OUTPUT_CHARS / 2)}` : text;
}

function noteChange(timeline: TimelineService, changes: Map<string, FileChange>, path: string, before: string, after: string, deleting: boolean, at: number) {
  const diff = timeline.lineDiff(before, after, 1);
  const added = diff?.added ?? (after ? after.split('\n').length : 0);
  const removed = diff?.removed ?? (before ? before.split('\n').length : 0);
  const change = changes.get(path) ?? { path, added: 0, removed: 0, created: !before, deleted: false, edits: [], preview: [], commands: [], at };
  change.added += added;
  change.removed += removed;
  change.deleted = deleting || (Boolean(before) && !after);
  change.edits.push({ before, after });
  if (change.preview.length < PREVIEW_LINES) {
    // Hunks stay apart by a blank gap; the count of unchanged lines between them is the inspector's to say.
    const lines = (diff?.lines ?? after.split('\n').map((text) => ({ type: 'add' as const, text }))).map((line) => line.type === 'gap' ? { type: 'gap' as const, text: '' } : line);
    while (lines[0]?.type === 'gap') lines.shift();
    if (change.preview.length && lines.length) change.preview.push({ type: 'gap', text: '' });
    change.preview.push(...lines.slice(0, PREVIEW_LINES - change.preview.length));
  }
  changes.set(path, change);
}

/** A write the shell made: the file and the command, with no lines to count. */
function noteCommandWrite(changes: Map<string, FileChange>, path: string, command: string, at: number) {
  const change = changes.get(path) ?? { path, added: 0, removed: 0, created: false, deleted: false, edits: [], preview: [], commands: [], at };
  change.commands.push(command);
  changes.set(path, change);
}

/** A lane's rows from [from] on, a page at a time; with [turns], only rows of those turns, stopping past [until]. [signal] cancels the read between and within pages. */
export async function laneRows(sessions: SessionService, sessionId: string, lane: SyncLane, from: number, options: { turns?: ReadonlySet<string>; until?: number; pages?: number; signal?: AbortSignal } = {}): Promise<TimelineRow[]> {
  const rows: TimelineRow[] = [];
  let pos = from;
  for (let page = 0; page < (options.pages ?? 40); page += 1) {
    const result = await sessions.timeline(sessionId, { lane, from: pos, rows: 500, budget: 1024 * 1024 }, { ...(options.signal ? { signal: options.signal } : {}) });
    for (const row of result.rows) {
      if (options.until !== undefined && row.pos > options.until) return rows;
      if (!options.turns || options.turns.has(row.turn)) rows.push(row);
    }
    if (!result.hasAfter || !result.rows.length) break;
    pos = result.rows.at(-1)!.pos + 1;
  }
  return rows;
}

/** Rows grouped by the lane turn the server folded them into. */
export function byTurn(rows: readonly TimelineRow[]): Map<string, TimelineRow[]> {
  const groups = new Map<string, TimelineRow[]>();
  for (const row of rows) {
    const group = groups.get(row.turn);
    if (group) group.push(row); else groups.set(row.turn, [row]);
  }
  return groups;
}

function firstLine(text: string): string {
  return plainText(text).split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 160) ?? '';
}

/** Markdown reduced to what a one- or two-line preview can show. */
export function plainText(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/[#>*`_|]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ''}`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The output lines worth showing under a call: its last non-empty ones. */
export function outputTail(output: string | undefined, count: number): string[] {
  if (!output || !count) return [];
  return output.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim()).slice(-count);
}

/** How many results a search returned, when its output says or can be counted. */
export function resultCount(step: Step): number | undefined {
  if (step.kindName !== 'search' || !step.output) return undefined;
  const total = /total (\d+)/.exec(step.output);
  return total ? Number(total[1]) : step.output.split('\n').filter((line) => line.trim()).length;
}

/** The host and path of a fetched address, without the scheme. */
export function shortUrl(text: string): string {
  try { const url = new URL(text); return `${url.host}${url.pathname === '/' ? '' : url.pathname}`; } catch { return text; }
}

/**
 * A call as its track names it: its words, whether they are code, and a short aside — how long a
 * command took, how many results a search found, what the reader answered, what a tool was given.
 */
export function callLabel(step: Step, track: Track): { text: string; mono: boolean; aside?: string } {
  const described = step.title && step.title !== step.arg && step.title !== step.toolName ? step.title : undefined;
  if (step.arg) step = { ...step, arg: unwrapShell(step.arg) };
  switch (track) {
    case 'shell': {
      const ms = step.end - step.start;
      const aside = !step.running && ms >= 1000 ? { aside: formatDuration(ms) } : {};
      return described ? { text: described, mono: false, ...aside } : { text: step.arg ?? step.label, mono: true, ...aside };
    }
    case 'explore': {
      const target = step.targets?.[0];
      if (step.kindName === 'read' && target) return { text: target.slice(target.lastIndexOf('/') + 1), mono: true };
      const count = resultCount(step);
      return { text: step.arg ?? described ?? step.label, mono: Boolean(step.arg), ...(count !== undefined ? { aside: String(count) } : {}) };
    }
    case 'web':
      return step.arg && /^https?:/.test(step.arg) ? { text: shortUrl(step.arg), mono: true } : { text: step.arg ?? described ?? step.label, mono: false };
    case 'ask': {
      const answer = outputTail(step.output, 1)[0];
      return { text: described ?? step.arg ?? step.label, mono: false, ...(answer ? { aside: `→ ${answer}` } : {}) };
    }
    case 'other': {
      const aside = described ?? step.arg;
      return { text: step.toolName ?? step.kindName ?? step.label, mono: false, ...(aside ? { aside } : {}) };
    }
  }
}

/** The attachments a thumbnail can stand for (images uploaded through Riffet), and how many others there are. */
export function attachmentsOf(list: readonly UserAttachment[]): { images: Array<UserAttachment & { id: string }>; others: number } {
  const images = list.filter((item): item is UserAttachment & { id: string } => Boolean(item.id) && (item.type === 'image' || Boolean(item.mimeType?.startsWith('image/'))));
  return { images, others: list.length - images.length };
}

/** A command without the login shell it was handed to (`/bin/zsh -lc "…"`). */
export function unwrapShell(command: string): string {
  const match = /^(?:\/\S+\/)?(?:ba|z)?sh\s+-l?c\s+(["'])([\s\S]*)\1$/.exec(command.trim());
  return match ? match[2]! : command;
}

/** The states in which a conversation is at work. */
export const LIVE_STATES: ReadonlySet<Session['state']> = new Set<Session['state']>(['starting', 'running', 'waiting', 'cancelling']);

/** A few requests at a time; one with a [key] already waiting or running is not queued again. Nothing starts once [signal] aborts. */
export function useQueue(signal: AbortSignal, concurrency = 3) {
  const running = useRef(0);
  const waiting = useRef<Array<() => Promise<void>>>([]);
  const pending = useRef(new Set<string>());
  return useCallback((task: () => Promise<void>, key?: string) => {
    if (key !== undefined) {
      if (pending.current.has(key)) return;
      pending.current.add(key);
    }
    const next = () => {
      const job = waiting.current.shift();
      if (!job) return;
      running.current += 1;
      void job().finally(() => { running.current -= 1; next(); });
    };
    const run = async () => { if (!signal.aborted) await task(); };
    waiting.current.push(key === undefined ? run : () => run().finally(() => pending.current.delete(key)));
    if (running.current < concurrency) next();
  }, [signal]);
}
