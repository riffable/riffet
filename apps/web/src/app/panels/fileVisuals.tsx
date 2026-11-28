import type { FileEntry } from '@contracts';
import { cn } from '@/lib/utils';
import { IdeFileIcon, type FileIconKind } from './fileIcons';

export type { FileIconKind };

export function FileIcon({ entry, open = false, kind, className }: {
  entry: Pick<FileEntry, 'kind' | 'name'>;
  open?: boolean;
  kind?: FileIconKind | undefined;
  className?: string;
}) {
  return <IdeFileIcon name={entry.name} directory={entry.kind === 'directory'} open={open} kind={kind} className={className} />;
}

export const splitPath = (path: string) => { const at = path.lastIndexOf('/'); return { name: path.slice(at + 1), dir: at < 0 ? '' : path.slice(0, at) }; };

/** `text` with the part that `query`'s name part names in it set apart, when it is one run. */
export function Matched({ text, query }: { text: string; query: string }) {
  const needle = query.trim().split('/').pop()?.toLowerCase() ?? '';
  const at = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<span className="font-medium text-fg">{text.slice(at, at + needle.length)}</span>{text.slice(at + needle.length)}</>;
}

/** A directory cut at its start: its last folders tell same-named files apart. */
export function DirectoryHint({ dir, className }: { dir: string; className?: string }) {
  return <span className={cn('min-w-0 truncate text-left font-mono text-2xs text-fg-3 [direction:rtl]', className)}><bdi>{dir}</bdi></span>;
}
