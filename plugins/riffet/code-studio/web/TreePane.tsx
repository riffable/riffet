import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { usePluginHost, type PluginIconName } from '@riffet/plugin-web';
import { cn } from './cn';
import type { TreeNode, TreeRow } from './tree';

const ROW = 24;
const INDENT = 12;
/** Rows drawn above and below the visible ones, so a quick scroll does not show blank rows. */
const OVERSCAN = 12;
/** Rows Page Up and Page Down move. */
const PAGE = 10;
const rowId = (index: number) => `studio-tree-${index}`;

/**
 * What a row is drawn with: the module view's own kinds get the IDE's distinct glyphs (a module, source
 * and resource roots, packages), everything else the files panel's icon for its name.
 */
function glyph(node: TreeNode): PluginIconName | undefined {
  if (node.kind === 'module') return 'package';
  if (node.kind === 'section') return node.label === 'manifests' ? 'folder-cog' : node.label === 'res' ? 'folder-kanban' : 'folder-code';
  if (node.kind === 'dir' && node.packages) return 'folder-dot';
  if (node.kind === 'dir' && node.label === 'assets' && /(^|\/)src\/[^/]+\/assets$/.test(node.path ?? '')) return 'folder-archive';
  return undefined;
}

/**
 * The tree's rows, drawn only where they can be seen: a module list of a large repository runs into the
 * thousands of rows once a few groups are open. Rows are as wide as the longest name and the pane scrolls
 * sideways, as Studio's project view does, so deep packages keep their whole names.
 *
 * Keyboard as in the IDE: arrows move, → opens or steps in, ← closes or steps out, Enter opens a file
 * (and keeps its tab), Home/End and Page Up/Down jump. A single click opens a file in the preview tab, a
 * double click keeps it.
 */
export function TreePane({ rows, active, focus, label, onToggle, onOpen, onKeep, onMenu }: {
  rows: readonly TreeRow[];
  active: string | undefined;
  /** A file to scroll to, again for each new token. */
  focus?: { path: string; token: number } | undefined;
  label: string;
  onToggle(node: TreeNode): void;
  onOpen(path: string): void;
  /** A file was double-clicked or opened with Enter: its tab stays. */
  onKeep(path: string): void;
  /** A row was right-clicked, or the empty pane (`undefined`). */
  onMenu(node: TreeNode | undefined, point: { x: number; y: number }): void;
}) {
  const { ui } = usePluginHost();
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  const [cursor, setCursor] = useState<string>();

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setView({ top: element.scrollTop, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const reveal = (index: number, center = false) => {
    const element = scroller.current;
    if (!element) return;
    const y = index * ROW;
    if (y < element.scrollTop || y + ROW > element.scrollTop + element.clientHeight) element.scrollTop = Math.max(0, center ? y - element.clientHeight / 2 : y < element.scrollTop ? y : y + ROW - element.clientHeight);
  };

  // A row asked for (`focus`) is brought into view once it is drawn: opening the way to it takes reads first.
  const handled = useRef(0);
  useEffect(() => {
    if (!focus || handled.current === focus.token) return;
    const index = rows.findIndex((row) => row.node.path === focus.path && row.leaf);
    if (index < 0) return;
    handled.current = focus.token;
    setCursor(rows[index]!.node.id);
    reveal(index, true);
  }, [focus, rows]);

  const at = cursor === undefined ? -1 : rows.findIndex((row) => row.node.id === cursor);
  const activate = (row: TreeRow, keep: boolean) => {
    if (!row.leaf) { onToggle(row.node); return; }
    if (row.node.path === undefined) return;
    if (keep) onKeep(row.node.path); else onOpen(row.node.path);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!rows.length || event.metaKey || event.ctrlKey || event.altKey) return;
    const from = at < 0 ? 0 : at;
    const row = rows[from]!;
    let to: number | undefined;
    switch (event.key) {
      case 'ArrowDown': to = at < 0 ? 0 : Math.min(rows.length - 1, from + 1); break;
      case 'ArrowUp': to = Math.max(0, from - 1); break;
      case 'Home': to = 0; break;
      case 'End': to = rows.length - 1; break;
      case 'PageDown': to = Math.min(rows.length - 1, from + PAGE); break;
      case 'PageUp': to = Math.max(0, from - PAGE); break;
      case 'ArrowRight':
        if (!row.leaf && !row.open) onToggle(row.node);
        else if (!row.leaf && rows[from + 1]?.depth === row.depth + 1) to = from + 1;
        break;
      case 'ArrowLeft':
        if (!row.leaf && row.open) onToggle(row.node);
        else for (let index = from - 1; index >= 0; index--) if (rows[index]!.depth < row.depth) { to = index; break; }
        break;
      case 'Enter': activate(row, true); break;
      case ' ': activate(row, false); break;
      case 'ContextMenu': {
        const element = document.getElementById(rowId(from));
        const box = element?.getBoundingClientRect();
        if (box) onMenu(row.node, { x: box.left + 24, y: box.bottom });
        break;
      }
      default: return;
    }
    event.preventDefault();
    if (to !== undefined) { setCursor(rows[to]!.node.id); reveal(to); }
  };

  const first = Math.max(0, Math.floor(view.top / ROW) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((view.top + view.height) / ROW) + OVERSCAN);
  const Chevron = ui.icon('chevron-right');
  const FileIcon = ui.FileIcon;

  return (
    <div
      ref={scroller} role="tree" tabIndex={0} aria-label={label} aria-activedescendant={at >= 0 ? rowId(at) : undefined}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => { event.preventDefault(); onMenu(undefined, { x: event.clientX, y: event.clientY }); }}
      onFocus={() => { if (at < 0 && rows.length) setCursor((rows.find((row) => row.leaf && row.node.path === active) ?? rows[0]!).node.id); }}
      onScroll={(event) => { const top = event.currentTarget.scrollTop; setView((previous) => (previous.top === top ? previous : { ...previous, top })); }}
      className="group/tree min-h-0 flex-1 overflow-auto px-1.5 py-1 outline-none"
    >
      <div className="relative w-max min-w-full" style={{ height: rows.length * ROW }}>
        <div className="absolute inset-x-0" style={{ top: first * ROW }}>
          {rows.slice(first, last).map((row, offset) => {
            const { node, depth, open, loading, leaf } = row;
            const index = first + offset;
            const selected = leaf && node.path === active;
            const name = glyph(node);
            const Icon = name ? ui.icon(name) : undefined;
            return (
              <div
                key={node.id} id={rowId(index)} role="treeitem" aria-level={depth + 1} aria-expanded={leaf ? undefined : open} aria-selected={selected}
                onClick={() => { setCursor(node.id); activate(row, false); }}
                onDoubleClick={() => { if (leaf && node.path !== undefined) onKeep(node.path); }}
                onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setCursor(node.id); onMenu(node, { x: event.clientX, y: event.clientY }); }}
                style={{ paddingLeft: 4 + depth * INDENT }}
                className={cn(
                  'relative flex h-6 cursor-default select-none items-center gap-1 whitespace-nowrap rounded pr-2 text-sm',
                  selected ? 'bg-active text-fg' : 'text-fg hover:bg-hover',
                  index === at && 'group-focus-visible/tree:ring-2 group-focus-visible/tree:ring-inset group-focus-visible/tree:ring-focus',
                )}
              >
                {Array.from({ length: depth }, (_, level) => <span key={level} aria-hidden className="absolute inset-y-0 w-px bg-line-soft" style={{ left: 4 + level * INDENT + 7 }} />)}
                {leaf ? <span className="w-3.5 shrink-0" /> : loading ? <ui.Spinner className="size-3.5" /> : <Chevron className={cn('size-3.5 shrink-0 text-fg-4 transition-transform', open && 'rotate-90')} />}
                {Icon ? <Icon className="size-4 shrink-0 text-fg-2" /> : FileIcon ? <FileIcon name={node.label} directory={!leaf} /> : null}
                <span className={cn(node.kind === 'module' && 'font-medium', node.kind === 'section' && 'text-fg-2')}>{node.label}</span>
                {node.hint && <span className="text-fg-4">{node.hint}</span>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
