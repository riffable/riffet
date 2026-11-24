import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { CodeLocation } from '@contracts';
import { usePluginHost } from '@riffet/plugin-web';
import { cn } from './cn';
import { dirName, fileName } from './data';
import type { Messages } from './messages';
import type { Place } from './SearchDialog';

/** What the bottom panel lists: the declarations a ⌘-click could mean, a symbol's usages, or text hits. */
export interface Results {
  title: string;
  locations: CodeLocation[];
  loading: boolean;
  complete: boolean;
  /** Set for usages, whose scope can be widened. */
  scope?: 'module' | 'project';
  error?: string;
  /**
   * What each line matched, to mark it: a symbol's name sits at the location's column; a text search's
   * query is looked for in the line (not for a regex).
   */
  match?: { text: string; atColumn?: boolean; matchCase?: boolean; regex?: boolean };
}

type Item = { type: 'file'; path: string; count: number; open: boolean } | { type: 'line'; location: CodeLocation };

const itemId = (index: number) => `studio-result-${index}`;

/** The line with the match marked; leading space is dropped and the column moves with it. */
function lineText(location: CodeLocation, match: Results['match']): ReactNode {
  const raw = location.text;
  const indent = raw.length - raw.trimStart().length;
  const text = raw.trim();
  if (!match?.text || match.regex) return text;
  let at = -1;
  if (match.atColumn && location.column > 0) {
    const column = location.column - 1 - indent;
    if (text.slice(column, column + match.text.length) === match.text) at = column;
  }
  if (at < 0) at = match.matchCase ? text.indexOf(match.text) : text.toLowerCase().indexOf(match.text.toLowerCase());
  if (at < 0) return text;
  return <>{text.slice(0, at)}<mark className="rounded-sm bg-accent-soft text-fg">{text.slice(at, at + match.text.length)}</mark>{text.slice(at + match.text.length)}</>;
}

/**
 * The find tool window: results grouped by file, the file's row then one row per line, as Studio's usages
 * view lists them. A click opens the place (in the preview tab); the arrows walk the lines and open each,
 * as the IDE's "navigate with single click" does; ← and → fold a file's lines.
 */
export function ResultsPanel({ results, messages: m, current, onOpen, onKeep, onMenu, onScope, onClose }: {
  results: Results;
  messages: Messages;
  current: Place | undefined;
  onOpen(place: Place): void;
  /** A line was double-clicked: its file opens in a tab that stays. */
  onKeep(place: Place): void;
  /** A row (a file's, or a line's) or the empty list was right-clicked; `groups` folds or unfolds every file. */
  onMenu(target: { path: string; location?: CodeLocation } | undefined, point: { x: number; y: number }, groups: { collapse(): void; expand(): void }): void;
  onScope?(scope: 'module' | 'project'): void;
  onClose(): void;
}) {
  const { ui } = usePluginHost();
  const X = ui.icon('x');
  const Chevron = ui.icon('chevron-right');
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setClosed(new Set()), [results.title]);
  const items = useMemo(() => {
    const byPath = new Map<string, CodeLocation[]>();
    for (const location of results.locations) {
      const list = byPath.get(location.path);
      if (list) list.push(location); else byPath.set(location.path, [location]);
    }
    const out: Item[] = [];
    for (const [path, lines] of byPath) {
      const open = !closed.has(path);
      out.push({ type: 'file', path, count: lines.length, open });
      if (open) for (const location of lines) out.push({ type: 'line', location });
    }
    return out;
  }, [results.locations, closed]);
  const files = useMemo(() => new Set(results.locations.map((location) => location.path)).size, [results.locations]);

  const [cursor, setCursor] = useState(-1);
  useEffect(() => setCursor(-1), [results.title]);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { if (cursor >= 0) document.getElementById(itemId(cursor))?.scrollIntoView({ block: 'nearest' }); }, [cursor]);

  const groups = { collapse: () => setClosed(new Set(results.locations.map((location) => location.path))), expand: () => setClosed(new Set()) };
  const menuAt = (event: { preventDefault(): void; stopPropagation(): void; clientX: number; clientY: number }, target: { path: string; location?: CodeLocation } | undefined) => {
    event.preventDefault();
    event.stopPropagation();
    onMenu(target, { x: event.clientX, y: event.clientY }, groups);
  };
  const toggle = (path: string) => setClosed((previous) => { const next = new Set(previous); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  const choose = (index: number) => {
    const item = items[index];
    setCursor(index);
    if (item?.type === 'line') onOpen({ path: item.location.path, line: item.location.line, column: item.location.column });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!items.length || event.metaKey || event.ctrlKey || event.altKey) return;
    const item = items[cursor];
    const step = (by: number) => {
      // Lines only: a file's row is passed over, as the IDE's next and previous occurrence do.
      for (let index = cursor + by; index >= 0 && index < items.length; index += by) if (items[index]!.type === 'line') return choose(index);
    };
    switch (event.key) {
      case 'ArrowDown': step(1); break;
      case 'ArrowUp': step(-1); break;
      case 'ArrowLeft': if (item?.type === 'file' && item.open) toggle(item.path); else if (item?.type === 'line') { const at = items.findLastIndex((entry, index) => index < cursor && entry.type === 'file'); if (at >= 0) setCursor(at); } break;
      case 'ArrowRight': if (item?.type === 'file' && !item.open) toggle(item.path); break;
      case 'Enter': if (item?.type === 'file') toggle(item.path); else if (cursor >= 0) choose(cursor); break;
      case 'Escape': onClose(); break;
      default: return;
    }
    event.preventDefault();
  };

  return (
    <section aria-label={results.title} className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 edge-b pl-3 pr-1.5 text-xs">
        <span className="min-w-0 truncate font-medium text-fg">{results.title}</span>
        {!results.loading && results.locations.length > 0 && <span className="shrink-0 text-fg-3">{m.resultsIn(results.locations.length, files)}</span>}
        {!results.loading && !results.locations.length && !results.error && <span className="shrink-0 text-fg-3">{m.noResults}</span>}
        {results.loading && <ui.Spinner className="size-3" />}
        <span className="flex-1" />
        {results.scope && onScope && ui.Segmented && (
          <ui.Segmented size="xs" value={results.scope} ariaLabel={m.scope.project} onChange={(value) => onScope(value as 'module' | 'project')} options={[{ value: 'module', label: m.scope.module }, { value: 'project', label: m.scope.project }]} />
        )}
        <ui.Tip label={m.closePanel} kbd="Esc"><ui.Button size="icon-xs" variant="quiet" aria-label={m.closePanel} onClick={onClose}><X /></ui.Button></ui.Tip>
      </div>
      <div
        ref={list} role="tree" tabIndex={0} aria-label={results.title} aria-activedescendant={cursor >= 0 ? itemId(cursor) : undefined} onKeyDown={onKeyDown}
        onFocus={() => { if (cursor < 0) { const first = items.findIndex((item) => item.type === 'line'); if (first >= 0) setCursor(first); } }}
        onContextMenu={(event) => menuAt(event, undefined)}
        className="group/results min-h-0 flex-1 overflow-auto px-1.5 py-1 text-sm outline-none"
      >
        {results.error && <p className="px-2 py-2 text-xs text-danger" role="alert">{results.error}</p>}
        {!results.loading && !results.complete && results.locations.length > 0 && <p className="px-2 py-1 text-xs text-fg-3">{m.incomplete}</p>}
        {items.map((item, index) => {
          const focused = index === cursor && 'group-focus-visible/results:ring-2 group-focus-visible/results:ring-inset group-focus-visible/results:ring-focus';
          if (item.type === 'file') {
            return (
              <div
                key={`f:${item.path}`} id={itemId(index)} role="treeitem" aria-level={1} aria-expanded={item.open} aria-selected={index === cursor}
                onClick={() => { setCursor(index); toggle(item.path); }}
                onContextMenu={(event) => { setCursor(index); menuAt(event, { path: item.path }); }}
                className={cn('flex h-6 cursor-default select-none items-center gap-1.5 rounded px-1 hover:bg-hover', index === cursor && 'bg-hover', focused)}
              >
                <Chevron className={cn('size-3.5 shrink-0 text-fg-4 transition-transform', item.open && 'rotate-90')} />
                {ui.FileIcon && <ui.FileIcon name={fileName(item.path)} className="size-4 shrink-0" />}
                <span className="shrink-0 text-fg">{fileName(item.path)}</span>
                <span className="min-w-0 truncate text-xs text-fg-4">{dirName(item.path)}</span>
                <span className="ml-auto shrink-0 pl-2 text-xs tabular-nums text-fg-4">{item.count}</span>
              </div>
            );
          }
          const { location } = item;
          const here = current?.path === location.path && current.line === location.line;
          return (
            <div
              key={`l:${location.path}:${location.line}:${location.column}`} id={itemId(index)} role="treeitem" aria-level={2} aria-selected={index === cursor}
              onClick={() => choose(index)}
              onDoubleClick={() => onKeep({ path: location.path, line: location.line, column: location.column })}
              onContextMenu={(event) => { setCursor(index); menuAt(event, { path: location.path, location }); }}
              className={cn('flex h-6 cursor-default select-none items-center gap-3 rounded pl-7 pr-2 hover:bg-hover', (here || index === cursor) && 'bg-active', focused)}
            >
              <span className="w-10 shrink-0 text-right font-mono text-2xs tabular-nums text-fg-4">{location.line}</span>
              <span className="min-w-0 truncate whitespace-pre font-mono text-xs text-fg-2">{lineText(location, results.match)}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
