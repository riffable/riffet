import { useMemo } from 'react';
import type { CodeOutlineItem } from '@contracts';
import { cn } from './cn';
import { KIND_MARK } from './data';
import type { Messages } from './messages';

interface Row { item: CodeOutlineItem; depth: number }

/** The open file's declarations, nested; the one the reader has scrolled into is marked. */
export function Outline({ items, loading, topLine, messages: m, onJump }: {
  items: readonly CodeOutlineItem[] | undefined;
  loading: boolean;
  topLine: number;
  messages: Messages;
  onJump(line: number, column: number): void;
}) {
  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (list: readonly CodeOutlineItem[], depth: number) => { for (const item of list) { out.push({ item, depth }); if (item.children) walk(item.children, depth + 1); } };
    walk(items ?? [], 0);
    return out;
  }, [items]);
  // The last declaration that starts at or above the first line in view.
  let current = -1;
  for (let index = 0; index < rows.length; index++) if (rows[index]!.item.line <= topLine + 1) current = index;

  return (
    <div className="min-h-0 flex-1 overflow-auto px-1.5 py-1">
      {!loading && !rows.length && <p className="px-2 py-1.5 text-xs text-fg-3">{m.noOutline}</p>}
      {rows.map(({ item, depth }, index) => (
        <button
          key={`${item.line}:${item.column}:${item.name}`} type="button" onClick={() => onJump(item.line, item.column)}
          style={{ paddingLeft: 6 + depth * 10 }}
          className={cn('flex h-6 w-full items-center gap-1.5 whitespace-nowrap rounded pr-2 text-left text-sm', index === current ? 'bg-active text-fg' : 'text-fg hover:bg-hover')}
        >
          <span className="w-3.5 shrink-0 text-center font-mono text-2xs text-fg-3">{KIND_MARK[item.kind] ?? ''}</span>
          <span className="truncate">{item.name}</span>
        </button>
      ))}
    </div>
  );
}
