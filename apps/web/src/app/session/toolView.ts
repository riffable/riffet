import type { NativeActivity, WorkbenchEvent } from '@contracts';
import { msg } from '@lingui/core/macro';
import { i18n } from '@lingui/core';
import { isRecord, records, str } from '@/lib/utils';
import { stripRoot, toolDataKind, toolTitleOf } from '../../../../../packages/timeline/src/toolTitle';
import { toolFoldedDetail } from '../../../../../packages/timeline/src/findText';
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

export { stripRoot };

/** A display category, including the child metadata retained by older Task rows. */
export function toolKind(event: WorkbenchEvent): string {
  return toolDataKind(event.data);
}

export function toolView(event: WorkbenchEvent, root?: string): ToolView {
  const data = event.data;
  const rawInput = data.rawInput ?? data.input;
  const { title, command } = toolTitleOf(data, i18n._(msg`工具调用`), root);
  return {
    id: str(data.toolCallId) ?? String(event.sequence),
    title,
    kind: toolKind(event),
    status: str(data.status) ?? str(data.state) ?? 'completed',
    locations: records(data.locations).flatMap((location) => str(location.path) ? [{ path: stripRoot(str(location.path)!, root), ...(typeof location.line === 'number' ? { line: location.line } : {}) }] : []),
    ...(command ? { command } : {}),
    contents: records(data.content),
    rawInput,
    rawOutput: data.rawOutput ?? data.output,
  };
}

export const activeToolStates = new Set(['pending', 'in_progress', 'running', 'queued']);

/** Action wording for a tool run. Only provider-supplied categories are used, never guessed from shell text. */
export function toolRunSummary(items: Extract<TimelineItem, { kind: 'tool' }>[]): { label: string; kind: string } {
  const labels = {
    read: msg`读取文件`, search: msg`搜索内容`, execute: msg({ message: '运行命令', context: 'tool-action' }),
    edit: msg`修改文件`, delete: msg`删除文件`, move: msg`移动文件`, fetch: msg`访问网页`,
    agent: msg`委派任务`, message: msg`发送消息`, think: msg`思考`, switch_mode: msg`切换模式`, question: msg`询问用户`, plan: msg`更新计划`,
    other: msg`调用工具`,
  };
  const kinds = new Set<keyof typeof labels>();
  for (const { event } of items) {
    const input = event.data.rawInput ?? event.data.input;
    const actions = isRecord(input) ? records(input.commandActions) : [];
    // A single Codex call can contain reads, searches and commands; its top-level kind is `other`.
    const reported = actions.length
      ? actions.map(action => action.type === 'read' ? 'read' : action.type === 'search' || action.type === 'listFiles' ? 'search' : 'execute')
      : [str(event.data.kind) ?? 'other'];
    for (const kind of reported) kinds.add(Object.hasOwn(labels, kind) ? kind as keyof typeof labels : 'other');
  }
  const categories = [...kinds];
  const summary = categories.slice(0, 2).map(kind => i18n._(labels[kind])).join(i18n._(msg`、`));
  return { label: categories.length > 2 ? i18n._(msg`${summary}等`) : summary, kind: categories[0] ?? 'other' };
}

/** Single-action titles the backends compose (`Read a/b.ts`, `Search q in dir`, `List files dir`). */
const actionTitle = /^(Read|Search|List files|Edit|Write|MultiEdit|NotebookEdit)\s+(.+)$/;
const pathActions = new Set(['Read', 'List files', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * A one-action title split into its verb and its object, so the row reads `Read` then the path.
 * A title naming the file by basename takes the location's path, which says where it lives.
 * Compound titles (`Read a · Search b`) stay whole.
 */
export function toolAction(view: ToolView): { verb: string; object: string; path: boolean } | undefined {
  if (view.title.includes(' · ')) return undefined;
  const match = actionTitle.exec(view.title);
  if (!match) return undefined;
  const verb = match[1]!;
  const named = match[2]!;
  const location = view.locations[0]?.path;
  const path = pathActions.has(verb);
  return { verb, object: path && location && location.split('/').at(-1) === named ? location : named, path };
}

/** What a folded tool row shows beside its title; see `toolFoldedDetail`. */
export function toolDetail(view: ToolView): string | undefined {
  return toolFoldedDetail(view.title, view.command, view.locations[0]?.path);
}
