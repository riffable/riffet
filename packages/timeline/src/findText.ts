import type { TimelineRow } from '../../contracts/src/index.js';
import type { TimelineItem } from './model.js';
import { relaxUnderscoreEmphasis } from './cjkEmphasis.js';
import { visibleText } from './markdownSource.js';
import { commandHeadline, diffTargetSummary, stripRoot, toolDataKind, toolTitleOf } from './toolTitle.js';
import { isRecord, records, str } from './values.js';

/*
 * 会话内查找: what a row offers to a find, shared by the web (which counts the rows it holds) and the
 * server (which counts the whole lane, `GET /api/v3/sessions/:id/find`), so both report the same
 * occurrences and a hit the server names is one the page can show.
 */

/**
 * While reasoning streams, the preview follows it the way DSH's own UI does: the first line of the
 * latest paragraph that has been completed, so it advances without flickering on a half line.
 */
function streamingReasoningLine(text: string): string {
  const paragraphs = text.split(/\r?\n[\t ]*\r?\n/);
  for (let index = paragraphs.length - 1; index >= 0; index -= 1) {
    const paragraph = paragraphs[index]!;
    const newline = paragraph.indexOf('\n');
    // The last paragraph is still being written unless a line of it has already ended.
    if (index === paragraphs.length - 1 && newline < 0) continue;
    const line = (newline < 0 ? paragraph : paragraph.slice(0, newline)).trim();
    if (line) return line;
  }
  return '';
}

/** First sentence or line of the reasoning, as the one-line preview of a folded thinking row. */
export function reasoningPreview(text: string, running = false): string {
  const line = (running && streamingReasoningLine(text)) || (text.split('\n').map(part => part.trim()).find(Boolean) ?? '');
  const stop = line.search(/[.。!！?？]\s|[.。!！?？]$/);
  const sentence = (stop > 0 ? line.slice(0, stop + 1) : line).replaceAll('**', '');
  return sentence.length > 160 ? `${sentence.slice(0, 160)}…` : sentence;
}

/** Titles that only name the tool (`bash`, `Script`), which say nothing about the one call. */
const bareToolTitles = /^(?:bash|shell|sh|zsh|script|terminal|run command|command|execute)$/i;

/**
 * What a folded tool row shows beside its title. The executable text stays in the expanded body: a
 * folded row reads by its title (Claude's `description` for a shell call), and a truncated command
 * beside it is neither readable nor needed to tell rows apart. A file path is the exception — it
 * names the call's target — and so is a command whose title is only the tool's name. The project
 * root itself (`.`) says nothing.
 */
export function toolFoldedDetail(title: string, command: string | undefined, path: string | undefined, contents?: readonly Record<string, unknown>[], root?: string): string | undefined {
  if (path && path !== '.' && path !== './' && !title.includes(path.split('/').at(-1) ?? path)) return path;
  const diffFiles = contents?.length ? diffTargetSummary(title, contents, root) : undefined;
  if (diffFiles) return diffFiles;
  if (command && bareToolTitles.test(title.trim())) return commandHeadline(command);
  return undefined;
}

/** The text a Markdown body renders to, for counting what a reader can find on the page. */
export const markdownShown = (text: string) => visibleText(relaxUnderscoreEmphasis(text));

/**
 * The text a row shows folded, lower-cased: a Markdown body without its syntax, a tool's title (and
 * its command, last, since a folded row shows it only as the title), a thought's preview line, a
 * failure's detail, which opens itself. What only an expanded row shows (tool output, the whole of
 * a thought) is left out, so a hit never lands on text the reader cannot see. A row the server cut
 * to a preview offers its preview, which is what it shows until expanded. [root] is the project
 * root the page shortens paths under.
 */
export function findableText(item: TimelineItem | TimelineRow, root?: string): string {
  let parts: (string | undefined)[] = [];
  switch (item.kind) {
    case 'user': parts = [item.text]; break;
    case 'status': parts = [item.text, item.detail]; break;
    case 'assistant': parts = [markdownShown(item.text)]; break;
    case 'thought': parts = [item.channel === 'narration' ? markdownShown(item.text) : reasoningPreview(item.text)]; break;
    case 'tool': {
      const { job } = item;
      if (job) { parts = [job.title, job.title.trim() === job.command.trim() ? undefined : job.command]; break; }
      const data = isRecord(item.event.data) ? item.event.data : {};
      const { title, command } = toolTitleOf(data, '', root);
      const subagent = toolDataKind(data) === 'agent' && isRecord(data.subagent) ? data.subagent : undefined;
      const input = data.rawInput ?? data.input;
      const actions = isRecord(input) ? records(input.commandActions) : [];
      const locations = records(data.locations);
      const location = locations.length === 1 && actions.length <= 1 ? str(locations[0]?.path) : undefined;
      parts = [title, subagent ? str(subagent.type) : toolFoldedDetail(title, command, location && stripRoot(location, root), records(data.content), root)];
      break;
    }
    case 'plan': parts = item.entries.map((entry) => String(entry.content ?? entry.title ?? '')); break;
    case 'task_notification': {
      const detail = item.status === 'failed' ? item.detail : undefined;
      parts = [item.command && item.title.trim() === item.command.trim() ? undefined : item.title, item.command, detail && item.taskKind === 'subagent' ? markdownShown(detail) : detail];
      break;
    }
    case 'activity': {
      const { activity } = item;
      const command = activity.task?.command;
      const name = activity.command?.name;
      // A compaction shows its state and sizes, not its title.
      if (activity.kind === 'background_task') parts = [activity.title || command, command && activity.title.trim() !== command.trim() ? command : undefined];
      else if (activity.kind === 'local_command' && command) parts = [command, activity.detail];
      else if (activity.kind === 'local_command') parts = [name && `/${name}`, activity.detail || (name ? undefined : activity.title)];
      break;
    }
  }
  return parts.filter(Boolean).join('\n').toLowerCase();
}

/** What a find looks for in [findableText]: the query lower-cased, or nothing for a blank one. */
export function findNeedle(query: string): string | undefined {
  return query.trim() ? query.toLowerCase() : undefined;
}

/** How many times [needle] occurs in [text], without overlap, as a reader stepping through them meets them. */
export function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) count += 1;
  return count;
}
