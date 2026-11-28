import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { usePluginHost, type FileIconKind } from '@riffet/plugin-web';
import { cn } from './cn';
import type { TreeNode, TreeRow } from './tree';

const ROW = 26;
const INDENT = 16;
/** Rows drawn above and below the visible ones, so a quick scroll does not show blank rows. */
const OVERSCAN = 12;
/** Rows Page Up and Page Down move. */
const PAGE = 10;
const rowId = (index: number) => `studio-tree-${index}`;
const LOW_PRIORITY_DIRS = new Set(['build', 'dist', 'log', 'logs', 'node_modules', 'out', 'target', '.gradle', '.idea']);

/** Maps a tree node to its semantic duotone icon kind (`UiKit.FileIcon`). */
function iconKind(node: TreeNode): FileIconKind {
  if (node.kind === 'module') return 'module';
  if (node.kind === 'section') return node.label === 'manifests' ? 'manifest' : node.label === 'res' ? 'resources' : 'source';
  if (node.kind === 'group') return 'group';
  if (node.kind === 'dir' && node.packages) return 'package';
  if (node.kind === 'dir' && node.label === 'assets' && /(^|\/)src\/[^/]+\/assets$/.test(node.path ?? '')) return 'assets';
  if (node.kind === 'dir') return 'folder';
  return 'file';
}

const isDimmed = (node: TreeNode): boolean => {
  const name = node.label.split('/')[0] ?? node.label;
  return name.startsWith('.') || (node.kind !== 'file' && LOW_PRIORITY_DIRS.has(name));
};

/**
 * Computes the active indent-guide span for the currently opened file's direct parent folder,
 * matching VS Code / Zed's active indent guide highlight.
 */
function activeGuideSpan(rows: readonly TreeRow[], active: string | undefined): { depth: number; start: number; end: number } | undefined {
  if (!active) return undefined;
  const activeIdx = rows.findIndex((row) => row.leaf && row.node.path === active);
  if (activeIdx < 0) return undefined;
  const targetDepth = rows[activeIdx]!.depth;
  if (targetDepth <= 0) return undefined;
  const parentDepth = targetDepth - 1;
  let start = activeIdx;
  while (start > 0 && rows[start - 1]!.depth > parentDepth) start--;
  let end = activeIdx;
  while (end + 1 < rows.length && rows[end + 1]!.depth > parentDepth) end++;
  return { depth: parentDepth, start, end };
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
export function TreePane({ rows, active, dirty, focus, label, newFileLabel, onToggle, onOpen, onKeep, onMenu, onNewFile }: {
  rows: readonly TreeRow[];
  active: string | undefined;
  /** Relative paths currently holding unsaved edits, shown as subtle accent dots in the tree. */
  dirty?: ReadonlySet<string>;
  /** A file to scroll to, again for each new token. */
  focus?: { path: string; token: number } | undefined;
  label: string;
  newFileLabel?: string;
  onToggle(node: TreeNode): void;
  onOpen(path: string): void;
  /** A file was double-clicked or opened with Enter: its tab stays. */
  onKeep(path: string): void;
  /** A row was right-clicked, or the empty pane (`undefined`). */
  onMenu(node: TreeNode | undefined, point: { x: number; y: number }): void;
  /** Optional hover action on folders/modules to create a new file inside. */
  onNewFile?: (folder: string) => void;
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

  const guide = useMemo(() => activeGuideSpan(rows, active), [rows, active]);
  const dirtyList = useMemo(() => (dirty && dirty.size ? [...dirty] : undefined), [dirty]);

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
  const Plus = ui.icon('plus');
  const FileIcon = ui.FileIcon;

  return (
    <div
      ref={scroller} role="tree" tabIndex={0} aria-label={label} aria-activedescendant={at >= 0 ? rowId(at) : undefined}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => { event.preventDefault(); onMenu(undefined, { x: event.clientX, y: event.clientY }); }}
      onFocus={() => { if (at < 0 && rows.length) setCursor((rows.find((row) => row.leaf && row.node.path === active) ?? rows[0]!).node.id); }}
      onScroll={(event) => { const top = event.currentTarget.scrollTop; setView((previous) => (previous.top === top ? previous : { ...previous, top })); }}
      className="group/tree min-h-0 flex-1 overflow-auto px-2 py-1.5 outline-none"
    >
      {/* Normal-flow spacer (`paddingTop` instead of `position: absolute`) so visible rows expand `w-max`
          and row selection fills (`bg-active`) cover the full width of long file names without clipping. */}
      <div className="box-border w-max min-w-full" style={{ height: rows.length * ROW, paddingTop: first * ROW }}>
        <div>
          {rows.slice(first, last).map((row, offset) => {
            const { node, depth, open, loading, leaf } = row;
            const index = first + offset;
            const selected = leaf && node.path === active;
            const kind = iconKind(node);
            const dimmed = !selected && isDimmed(node);
            const isDirtyFile = Boolean(leaf && node.path && dirty?.has(node.path));
            const hasDirtyChild = Boolean(!leaf && !open && node.path !== undefined && dirtyList?.some((path) => (node.path ? path.startsWith(`${node.path}/`) : true)));
            const canQuickCreate = Boolean(onNewFile && !leaf && node.path !== undefined);
            return (
              <div
                key={node.id} id={rowId(index)} role="treeitem" aria-level={depth + 1} aria-expanded={leaf ? undefined : open} aria-selected={selected}
                onClick={() => { setCursor(node.id); activate(row, false); }}
                onDoubleClick={() => { if (leaf && node.path !== undefined) onKeep(node.path); }}
                onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setCursor(node.id); onMenu(node, { x: event.clientX, y: event.clientY }); }}
                style={{ paddingLeft: 6 + depth * INDENT, height: ROW }}
                className={cn(
                  'group/row relative flex cursor-default select-none items-center gap-1.5 whitespace-nowrap rounded-md pr-2 text-sm transition-colors',
                  selected ? 'bg-active font-medium text-fg' : node.kind === 'module' ? 'font-medium text-fg hover:bg-hover' : dimmed ? 'text-fg-3 hover:bg-hover hover:text-fg-2' : 'text-fg-2 hover:bg-hover hover:text-fg',
                  index === at && 'group-focus-visible/tree:ring-2 group-focus-visible/tree:ring-inset group-focus-visible/tree:ring-focus',
                )}
              >
                {Array.from({ length: depth }, (_, level) => {
                  const isActiveGuide = guide !== undefined && level === guide.depth && index >= guide.start && index <= guide.end;
                  return (
                    <span
                      key={level}
                      aria-hidden
                      className={cn(
                        'pointer-events-none absolute inset-y-0 w-px transition-opacity',
                        isActiveGuide ? 'bg-line-strong opacity-100' : 'bg-line-soft opacity-0 group-hover/tree:opacity-100',
                      )}
                      style={{ left: 6 + level * INDENT + 6 }}
                    />
                  );
                })}
                {leaf ? <span className="w-3 shrink-0" /> : loading ? <ui.Spinner className="size-3 shrink-0" /> : <Chevron className={cn('size-3 shrink-0 text-fg-4 transition-transform group-hover/row:text-fg-2', open && 'rotate-90')} />}
                {FileIcon && <FileIcon name={node.label} directory={!leaf} open={open} kind={kind} />}
                <span className={cn(node.kind === 'section' && 'text-fg-2')}>{node.label}</span>
                {node.hint && <span className="text-xs text-fg-4">{node.hint}</span>}
                {(isDirtyFile || hasDirtyChild || canQuickCreate) && (
                  <span className="ml-auto flex shrink-0 items-center gap-1 pl-2">
                    {canQuickCreate && (
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-label={newFileLabel ?? 'New File'}
                        onClick={(event) => { event.stopPropagation(); onNewFile!(node.path!); }}
                        className="grid size-4 place-items-center rounded text-fg-4 opacity-0 hover:bg-active hover:text-fg group-hover/row:opacity-100 focus-visible:opacity-100"
                      >
                        <Plus className="size-3" />
                      </button>
                    )}
                    {isDirtyFile && <span className="size-1.5 rounded-full bg-accent" />}
                    {!isDirtyFile && hasDirtyChild && <span className="size-1.5 rounded-full bg-accent/50" />}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
