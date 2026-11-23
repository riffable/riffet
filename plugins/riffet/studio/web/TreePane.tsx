import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePluginHost } from '@riffet/plugin-web';
import { cn } from './cn';
import type { TreeNode, TreeRow } from './tree';

const ROW = 24;
const INDENT = 10;
/** Rows drawn above and below the visible ones, so a quick scroll does not show blank rows. */
const OVERSCAN = 12;

/**
 * The tree's rows, drawn only where they can be seen: a module list of a large repository runs into the
 * thousands of rows once a few groups are open. Rows are as wide as the longest name and the pane scrolls
 * sideways, as Studio's project view does, so deep packages keep their whole names.
 */
export function TreePane({ rows, active, focus, label, onToggle, onOpen }: {
  rows: readonly TreeRow[];
  active: string | undefined;
  /** A file to scroll to, again for each new token. */
  focus?: { path: string; token: number } | undefined;
  label: string;
  onToggle(node: TreeNode): void;
  onOpen(path: string): void;
}) {
  const { ui } = usePluginHost();
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setView({ top: element.scrollTop, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // A row asked for (`focus`) is brought into view once it is drawn: opening the way to it takes reads first.
  const handled = useRef(0);
  useEffect(() => {
    const element = scroller.current;
    if (!element || !focus || handled.current === focus.token) return;
    const index = rows.findIndex((row) => row.node.path === focus.path && row.leaf);
    if (index < 0) return;
    handled.current = focus.token;
    const y = index * ROW;
    if (y < element.scrollTop || y + ROW > element.scrollTop + element.clientHeight) element.scrollTop = Math.max(0, y - element.clientHeight / 2);
  }, [focus, rows]);

  const first = Math.max(0, Math.floor(view.top / ROW) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((view.top + view.height) / ROW) + OVERSCAN);
  const Chevron = ui.icon('chevron-right');
  const FileIcon = ui.FileIcon;

  return (
    <div
      ref={scroller} role="tree" aria-label={label}
      onScroll={(event) => { const top = event.currentTarget.scrollTop; setView((previous) => (previous.top === top ? previous : { ...previous, top })); }}
      className="min-h-0 flex-1 overflow-auto px-1.5 py-1"
    >
      <div className="relative w-max min-w-full" style={{ height: rows.length * ROW }}>
        <div className="absolute inset-x-0" style={{ top: first * ROW }}>
          {rows.slice(first, last).map(({ node, depth, open, loading, leaf }) => {
            const selected = leaf && node.path === active;
            return (
              <button
                key={node.id} type="button" role="treeitem" aria-expanded={leaf ? undefined : open} aria-selected={selected}
                onClick={() => (leaf ? node.path !== undefined && onOpen(node.path) : onToggle(node))}
                style={{ paddingLeft: 6 + depth * INDENT }}
                className={cn('flex h-6 w-full items-center gap-1 whitespace-nowrap rounded pr-2 text-left text-sm', selected ? 'bg-active text-fg' : 'text-fg hover:bg-hover')}
              >
                {leaf ? <span className="w-3.5 shrink-0" /> : loading ? <ui.Spinner className="size-3.5" /> : <Chevron className={cn('size-3.5 shrink-0 text-fg-4 transition-transform', open && 'rotate-90')} />}
                {FileIcon ? <FileIcon name={node.label} directory={!leaf} /> : null}
                <span className={cn(node.kind === 'module' && 'font-medium', node.kind === 'section' && 'text-fg-2')}>{node.label}</span>
                {node.hint && <span className="text-fg-4">{node.hint}</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
