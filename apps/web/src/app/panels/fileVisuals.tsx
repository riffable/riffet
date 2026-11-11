import type { FileEntry } from '@contracts';
import { IconFile, IconFileCode2, IconFolder, IconImage } from '@/components/icons';
import { cn } from '@/lib/utils';

const codeExt = /\.(tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|kts|gradle|swift|c|cc|cpp|h|hpp|m|mm|rb|php|cs|dart|vue|svelte|json|ya?ml|toml|xml|sh|css|scss|html|sql|md|proto)$/i;
const imageExt = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i;

export function FileIcon({ entry, className }: { entry: Pick<FileEntry, 'kind' | 'name'>; className?: string }) {
  if (entry.kind === 'directory') return <IconFolder className={cn('size-4 shrink-0 text-fg-3', className)} />;
  if (imageExt.test(entry.name)) return <IconImage className={cn('size-4 shrink-0 text-fg-4', className)} />;
  if (codeExt.test(entry.name)) return <IconFileCode2 className={cn('size-4 shrink-0 text-fg-4', className)} />;
  return <IconFile className={cn('size-4 shrink-0 text-fg-4', className)} />;
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
