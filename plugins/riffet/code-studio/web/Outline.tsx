import { useEffect, useMemo, useRef, useState } from 'react';
import type { CodeOutlineItem } from '@contracts';
import { usePluginHost } from '@riffet/plugin-web';
import { cn } from './cn';
import { KindMark } from './Kind';
import type { Messages } from './messages';

const ROW = 26;
const INDENT = 14;

interface Row { item: CodeOutlineItem; depth: number; id: string; parent?: string; open: boolean; branch: boolean; chain: CodeOutlineItem[] }

const idOf = (item: CodeOutlineItem, parent: string | undefined) => `${parent ?? ''}/${item.name}:${item.line}`;

/**
 * The declarations `line` falls in, outermost first: the types and functions whose span holds it, and
 * a declaration without a recorded end (a property, an older server) only when it starts on that line.
 */
export function scopeAt(items: readonly CodeOutlineItem[] | undefined, line: number): CodeOutlineItem[] {
  const chain: CodeOutlineItem[] = [];
  let level = items;
  while (level?.length) {
    const found: CodeOutlineItem | undefined = level.find((item) => (item.endLine !== undefined ? item.line <= line && line <= item.endLine : item.line === line));
    if (!found) break;
    chain.push(found);
    level = found.children;
  }
  return chain;
}

/**
 * The open file's declarations as a tree, as the IDE's structure tool window shows them: types open,
 * the declaration the caret is in marked and kept in view. A type's members fold under its chevron.
 */
export function Outline({ items, loading, line, messages: m, onJump, onMenu }: {
  items: readonly CodeOutlineItem[] | undefined;
  loading: boolean;
  /** The caret's line, or the first line in view before there is a caret. */
  line: number;
  messages: Messages;
  onJump(line: number, column: number): void;
  /** A declaration was right-clicked; `chain` is it and the declarations it is inside, outermost first. */
  onMenu(item: CodeOutlineItem, chain: readonly CodeOutlineItem[], point: { x: number; y: number }): void;
}) {
  const { ui } = usePluginHost();
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setClosed(new Set()), [items]);
  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (list: readonly CodeOutlineItem[], depth: number, parent: string | undefined, above: CodeOutlineItem[]) => {
      for (const item of list) {
        const id = idOf(item, parent);
        const branch = Boolean(item.children?.length);
        const open = branch && !closed.has(id);
        const chain = [...above, item];
        out.push({ item, depth, id, ...(parent ? { parent } : {}), open, branch, chain });
        if (open) walk(item.children!, depth + 1, id, chain);
      }
    };
    walk(items ?? [], 0, undefined, []);
    return out;
  }, [items, closed]);

  // The innermost declaration the line is in; before the first one, nothing.
  const chain = scopeAt(items, line);
  const deepest = chain.at(-1);
  let current = deepest ? rows.findIndex((row) => row.item === deepest) : -1;
  // Folded away: its nearest shown container.
  for (let at = chain.length - 2; current < 0 && at >= 0; at--) current = rows.findIndex((row) => row.item === chain[at]);

  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = scroller.current;
    if (!element || current < 0) return;
    const y = current * ROW;
    if (y < element.scrollTop || y + ROW > element.scrollTop + element.clientHeight) element.scrollTop = Math.max(0, y - element.clientHeight / 3);
  }, [current]);

  const toggle = (id: string) => setClosed((previous) => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const Chevron = ui.icon('chevron-right');

  return (
    <div ref={scroller} role="tree" aria-label={m.outline} className="group/outline min-h-0 flex-1 overflow-auto px-2 py-1.5">
      {!loading && !rows.length && <p className="px-2 py-1.5 text-xs text-fg-3">{m.noOutline}</p>}
      {rows.map(({ item, depth, id, open, branch, chain: itemChain }, index) => {
        const selected = index === current;
        const subtle = item.kind === 'property';
        return (
          <div
            key={id} role="treeitem" aria-selected={selected} aria-expanded={branch ? open : undefined}
            onContextMenu={(event) => { event.preventDefault(); onMenu(item, itemChain, { x: event.clientX, y: event.clientY }); }}
            style={{ paddingLeft: 4 + depth * INDENT, height: ROW }}
            className={cn(
              'group/row relative flex items-center rounded-md text-sm transition-colors',
              selected ? 'bg-active font-medium text-fg' : subtle ? 'text-fg-3 hover:bg-hover hover:text-fg-2' : 'text-fg-2 hover:bg-hover hover:text-fg',
            )}
          >
            {Array.from({ length: depth }, (_, level) => (
              <span
                key={level}
                aria-hidden
                className="pointer-events-none absolute inset-y-0 w-px bg-line-soft opacity-0 transition-opacity group-hover/outline:opacity-100"
                style={{ left: 4 + level * INDENT + 7 }}
              />
            ))}
            {branch ? (
              <button type="button" tabIndex={-1} aria-label={open ? m.collapse : m.expand} onClick={() => toggle(id)} className="grid size-4 shrink-0 place-items-center rounded text-fg-4 hover:text-fg">
                <Chevron className={cn('size-3 transition-transform', open && 'rotate-90')} />
              </button>
            ) : <span className="w-4 shrink-0" />}
            <button type="button" onClick={() => onJump(item.line, item.column)} className="flex h-full min-w-0 flex-1 items-center gap-1.5 whitespace-nowrap rounded pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus">
              <KindMark kind={item.kind} />
              <span className="truncate">{item.name}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
