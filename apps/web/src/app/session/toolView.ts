import type { NativeActivity, WorkbenchEvent } from '@contracts';
import { msg } from '@lingui/core/macro';
import { i18n } from '@lingui/core';
import { records, str } from '@/lib/utils';
import { commandLabel, isCommandTitle, stripRoot, toolDataKind, toolTitleOf } from '../../../../../packages/timeline/src/toolTitle';
import { describeJobRow, describeToolRow, type ToolRowPresentation } from '../../../../../packages/timeline/src/toolPresentation';
import { lineDiff } from './lineDiff';
import { contentDiffStats } from '../../../../../packages/timeline/src/lineDiff';
import type { TimelineItem } from './model';

/** The raw link stays for deduplication; only a matching activity supplies the current turn's clock and controls. */
export function currentToolActivity(item: Extract<TimelineItem, { kind: 'tool' }>): NativeActivity | undefined {
  const activity = item.activity;
  const child = item.subagent;
  if (!activity || !child) return activity;
  if (activity.endedAt && child.startedAt && Date.parse(activity.endedAt) < Date.parse(child.startedAt)) return undefined;
  if (child.status === 'running') return activity.status === 'running' || activity.status === 'stopping' ? activity : undefined;
  if (child.status && activity.status !== (child.status === 'cancelled' ? 'stopped' : child.status)) return undefined;
  return activity;
}

export interface ToolView {
  id: string;
  title: string;
  kind: string;
  status: string;
  locations: { path: string; line?: number }[];
  command?: string;
  contents: Record<string, unknown>[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

/** Lines added and removed across every diff a tool returned, whatever the tool. */
export const toolDiffStats = (view: ToolView) => contentDiffStats(view.contents, (before, after) => lineDiff(before, after, 0));

export { describeJobRow, isCommandTitle, stripRoot, type ToolRowPresentation };

/** Unified 4-slot presentation for a single tool event. */
export function toolRowPresentation(event: WorkbenchEvent, root?: string): ToolRowPresentation {
  return describeToolRow(event.data, i18n._(msg`工具调用`), root);
}

/**
 * A background task's one-line name: what its launch said it does, else its command as a label
 * (`mono`). A title that only restates the command is the command, not a description.
 */
export function taskLabel(title: string | undefined, command: string | undefined, root?: string): { text: string; mono: boolean } | undefined {
  // Either side may be raw or already project-relative (a tool view's command is); compare both relative.
  if (title?.trim() && !isCommandTitle(stripRoot(title, root), command && stripRoot(command, root))) return { text: title.trim(), mono: false };
  if (command?.trim()) return { text: commandLabel(command, root), mono: true };
  return undefined;
}

/** A display category, including the child metadata retained by older Task rows. */
export function toolKind(event: WorkbenchEvent): string {
  return toolDataKind(event.data);
}

export function toolView(event: WorkbenchEvent, root?: string): ToolView {
  const data = event.data;
  const rawInput = data.rawInput ?? data.input;
  const { title, command } = toolTitleOf(data, i18n._(msg`工具调用`), root);
  const kind = toolKind(event);
  const rawStatus = str(data.status) ?? str(data.state) ?? 'completed';
  // POSIX grep/rg exit code 1 means "no lines matched", not an execution error.
  const status = rawStatus === 'failed' && kind === 'search' && data.exitCode === 1 ? 'completed' : rawStatus;
  return {
    id: str(data.toolCallId) ?? String(event.sequence),
    title,
    kind,
    status,
    locations: records(data.locations).flatMap((location) => str(location.path) ? [{ path: stripRoot(str(location.path)!, root), ...(typeof location.line === 'number' ? { line: location.line } : {}) }] : []),
    ...(command ? { command } : {}),
    contents: records(data.content),
    rawInput,
    rawOutput: data.rawOutput ?? data.output,
  };
}

export const activeToolStates = new Set(['pending', 'in_progress', 'running', 'queued']);

type RunBucket = 'execute' | 'read' | 'edit' | 'search' | 'fetch' | 'other';

function bucketForPresentation(presentation: ToolRowPresentation): RunBucket {
  if (presentation.verb === 'List') return 'search';
  switch (presentation.icon) {
    case 'read': return 'read';
    case 'edit':
    case 'delete':
    case 'move': return 'edit';
    case 'search': return 'search';
    case 'fetch': return 'fetch';
    case 'execute':
    case 'git': return 'execute';
    default: return 'other';
  }
}

/** The rows' own verbs, so the run's header reads like its rows: `Read 3 · Search 2`. */
const RUN_VERB: Record<RunBucket, string> = { execute: 'Run', read: 'Read', edit: 'Edit', search: 'Search', fetch: 'Fetch', other: 'Tool' };

/**
 * Verbs and counts for a tool run, derived from the same unified row presentation
 * (`describeToolRow`) so a shell `rg` counts as a search and a file-editing `python3` counts as an edit.
 */
export function toolRunSummary(items: Extract<TimelineItem, { kind: 'tool' }>[], root?: string): { label: string; kind: string } {
  const counts = new Map<RunBucket, number>();
  const readFiles = new Set<string>();
  const editedFiles = new Set<string>();
  let unkeyedReads = 0;
  let unkeyedEdits = 0;
  for (const item of items) {
    const presentation = toolRowPresentation(item.event, root);
    const bucket = bucketForPresentation(presentation);
    if (bucket === 'edit') {
      const view = toolView(item.event, root);
      const diffPaths = view.contents.flatMap(entry => entry.type === 'diff' && str(entry.path) ? [stripRoot(str(entry.path)!, root)] : []);
      const targetPaths = diffPaths.length ? diffPaths
        : view.locations.length ? view.locations.map(loc => loc.path)
        : presentation.primaryKind === 'path' ? [presentation.primary] : [];
      if (targetPaths.length) for (const path of targetPaths) editedFiles.add(path);
      else unkeyedEdits += 1;
      continue;
    }
    if (bucket === 'read') {
      const view = toolView(item.event, root);
      const targetPaths = view.locations.length ? view.locations.map(loc => loc.path)
        : presentation.primaryKind === 'path' ? [presentation.primary] : [];
      if (targetPaths.length) for (const path of targetPaths) readFiles.add(path);
      else unkeyedReads += 1;
      continue;
    }
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  const editTotal = editedFiles.size + unkeyedEdits;
  const readTotal = readFiles.size + unkeyedReads;
  if (editTotal > 0) counts.set('edit', editTotal);
  if (readTotal > 0) counts.set('read', readTotal);
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const label = ordered.map(([bucket, count]) => `${RUN_VERB[bucket]} ${count}`).join(' · ') || 'Tool';
  const top = ordered[0]?.[0] ?? 'other';
  return { label, kind: top };
}

export type ToolRunGroupedEntry =
  | { kind: 'single'; item: TimelineItem; index: number }
  | { kind: 'merged'; key: string; items: Extract<TimelineItem, { kind: 'tool' }>[]; presentation: ToolRowPresentation; indices: number[] };

function isMergeableToolItem(item: TimelineItem, root?: string): ToolRowPresentation | undefined {
  if (item.kind !== 'tool' || item.job) return undefined;
  const activity = currentToolActivity(item);
  if (activity?.kind === 'background_task') return undefined;
  const kind = toolKind(item.event);
  if (kind === 'agent') return undefined;
  const rawStatus = str(item.event.data.status) ?? str(item.event.data.state) ?? 'completed';
  if (activeToolStates.has(rawStatus)) return undefined;
  const presentation = toolRowPresentation(item.event, root);
  return presentation.mergeKey ? presentation : undefined;
}

/**
 * Collapse adjacent completed tool calls inside a `ToolRun` that share the same `mergeKey`
 * (e.g. repeated `gh api actions/runs/…/jobs` polls or repeated edits to the same file).
 * Never merges across thoughts, incomplete calls, jobs, or different targets.
 */
export function groupAdjacentToolRunEntries(entries: readonly TimelineItem[], root?: string): ToolRunGroupedEntry[] {
  const out: ToolRunGroupedEntry[] = [];
  let index = 0;
  while (index < entries.length) {
    const entry = entries[index]!;
    const presentation = isMergeableToolItem(entry, root);
    if (!presentation?.mergeKey || entry.kind !== 'tool') {
      out.push({ kind: 'single', item: entry, index });
      index += 1;
      continue;
    }
    const items: Extract<TimelineItem, { kind: 'tool' }>[] = [entry];
    const indices: number[] = [index];
    let next = index + 1;
    while (next < entries.length) {
      const candidate = entries[next]!;
      const nextPres = isMergeableToolItem(candidate, root);
      if (candidate.kind !== 'tool' || !nextPres || nextPres.mergeKey !== presentation.mergeKey) break;
      items.push(candidate);
      indices.push(next);
      next += 1;
    }
    if (items.length === 1) {
      out.push({ kind: 'single', item: entry, index });
    } else {
      out.push({ kind: 'merged', key: entry.key, items, presentation, indices });
    }
    index = next;
  }
  return out;
}
