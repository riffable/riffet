import { createContext, useContext, type MouseEvent } from 'react';
import { localImagePath } from './imageSource';
import type { TimelineItem } from './model';
import { stripRoot, toolView } from './toolView';

/** What the transcript needs to open and download files the agent names; absent outside a project. */
export interface FileAccess {
  projectId: string;
  open?: (path: string, line?: number) => void;
  /** The file a mention by name or partial path means; see `resolveFileMention`. */
  resolve?: (path: string) => string;
}

export const FileAccessContext = createContext<FileAccess | undefined>(undefined);

export const useFileAccess = () => useContext(FileAccessContext);

/**
 * For a link whose href is the file itself: a plain click previews it on the right, while a modified
 * or middle click is left to the browser, which opens the file in a tab.
 */
export function previewOnPlainClick(open: (path: string, line?: number) => void, path: string, line?: number) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    open(path, line);
  };
}

/**
 * A Markdown link that names a local file rather than a web page, with the line from a `#L12`
 * anchor or a trailing `:12` as agents write them.
 */
export function localFileLink(href: string): { path: string; line?: number } | undefined {
  const value = href.trim();
  const anchor = /#L(\d+)(?:-L?\d+)?$/i.exec(value);
  const path = localImagePath(value.replace(/#.*$/, ''));
  if (!path || path.endsWith('/')) return undefined;
  const suffix = /^(.+?):(\d+)(?::\d+)?$/.exec(path);
  const line = Number(anchor?.[1] ?? suffix?.[2]) || undefined;
  return { path: suffix ? suffix[1]! : path, ...(line ? { line } : {}) };
}

const EXTENSIONLESS_FILES = /^(?:Makefile|Dockerfile|Containerfile|Justfile|Procfile|Gemfile|Rakefile|Brewfile|LICENSE|NOTICE|CODEOWNERS)$/;
/** Extensions a bare name (no folder) needs before it counts: `console.log` and `process.env` are code. */
const BARE_FILE_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonl', 'md', 'mdx', 'mdc', 'css', 'scss', 'html', 'vue', 'svelte',
  'yml', 'yaml', 'toml', 'ini', 'xml', 'kt', 'kts', 'gradle', 'swift', 'm', 'mm', 'h', 'c', 'cc', 'cpp', 'hpp', 'go', 'rs', 'py',
  'rb', 'java', 'sh', 'bash', 'zsh', 'sql', 'txt', 'csv', 'lock', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'proto',
]);

/**
 * Whether the last segment reads as a file rather than a folder, a slash command, a package or an
 * identifier. Inside a folder any extension counts; a bare name only with a common one, or a dotfile.
 */
function fileShaped(path: string): boolean {
  const name = path.split('/').pop() ?? '';
  if (EXTENSIONLESS_FILES.test(name)) return true;
  const extension = /\.([A-Za-z0-9]{1,10})$/.exec(name)?.[1]?.toLowerCase();
  if (!extension) return false;
  return path.includes('/') || name.startsWith('.') || BARE_FILE_EXTENSIONS.has(extension);
}

/**
 * What a Markdown link target is. Agents also link things that are neither a page nor a file — a
 * subagent id, a bare word — and handing those to the file preview only ends in "file does not
 * exist", so they render as plain text.
 */
export function markdownLinkTarget(href: string | undefined): { kind: 'web' } | { kind: 'file'; path: string; line?: number } | { kind: 'text' } {
  const value = href?.trim() ?? '';
  if (!value) return { kind: 'text' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^file:\/\//i.test(value)) return { kind: 'web' };
  if (/^(?:#|\?|\/\/|\/api\/)/.test(value)) return { kind: 'web' };
  const target = localFileLink(value);
  if (target && (fileShaped(target.path) || (target.line && target.path.includes('/')))) return { kind: 'file', ...target };
  return { kind: 'text' };
}

/** Inline code the agent writes as `path/to/file.ts:42`: a file it touched, never a command or an identifier. */
const CODE_FILE_PATH = /^[\w.@~/-]+(?::\d+(?::\d+)?)?$/;

export function codeFileMention(text: string): { path: string; line?: number } | undefined {
  if (text.length > 300 || !CODE_FILE_PATH.test(text)) return undefined;
  const target = localFileLink(text);
  return target && fileShaped(target.path) ? target : undefined;
}

/**
 * Every file this conversation's tools read or wrote, project-relative and newest first. A tool
 * row's event object is replaced whenever the row changes, so its paths are cached by event.
 */
export function conversationFiles(timeline: readonly TimelineItem[], root: string | undefined, cache: WeakMap<object, readonly string[]>): string[] {
  const files = new Set<string>();
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index]!;
    if (item.kind !== 'tool') continue;
    let paths = cache.get(item.event);
    if (!paths) {
      const view = toolView(item.event, root);
      paths = view.status === 'failed' ? [] : [
        ...view.contents.flatMap((content) => content.type === 'diff' && typeof content.path === 'string' ? [stripRoot(content.path, root)] : []),
        ...view.locations.map((location) => location.path),
      ];
      cache.set(item.event, paths);
    }
    for (const path of paths) files.add(path);
  }
  return [...files];
}

/**
 * Agents name a file they just handled by its name or the end of its path — `riffet2.png` after
 * reading `tmp/brand/riffet2.png` — so a mention means the newest such file the conversation
 * touched. One that matches none is sent as written, and the server reads a missing path as the
 * project's only file ending with it.
 */
export function resolveFileMention(path: string, files: readonly string[]): string {
  const mention = path.replace(/^\.\//, '');
  if (!mention || mention.startsWith('/') || mention.startsWith('~')) return path;
  return files.find((file) => file === mention || file.endsWith(`/${mention}`)) ?? path;
}
