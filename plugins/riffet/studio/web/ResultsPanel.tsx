import { useMemo } from 'react';
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
}

/**
 * The find tool window: results grouped by file, the file's row then one row per line, as Studio's usages
 * view lists them. A row opens its place in a tab.
 */
export function ResultsPanel({ results, messages: m, current, onOpen, onScope, onClose }: {
  results: Results;
  messages: Messages;
  current: Place | undefined;
  onOpen(place: Place): void;
  onScope?(scope: 'module' | 'project'): void;
  onClose(): void;
}) {
  const { ui } = usePluginHost();
  const X = ui.icon('x');
  const groups = useMemo(() => {
    const byPath = new Map<string, CodeLocation[]>();
    for (const location of results.locations) {
      const list = byPath.get(location.path);
      if (list) list.push(location); else byPath.set(location.path, [location]);
    }
    return [...byPath];
  }, [results.locations]);

  return (
    <section aria-label={results.title} className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 edge-b px-2 text-xs">
        <span className="min-w-0 truncate font-medium text-fg">{results.title}</span>
        {!results.loading && <span className="shrink-0 text-fg-3">{m.results(results.locations.length)}</span>}
        {results.loading && <ui.Spinner className="size-3" />}
        <span className="flex-1" />
        {results.scope && onScope && ui.Segmented && (
          <ui.Segmented size="xs" value={results.scope} ariaLabel={m.scope.project} onChange={(value) => onScope(value as 'module' | 'project')} options={[{ value: 'module', label: m.scope.module }, { value: 'project', label: m.scope.project }]} />
        )}
        <ui.Tip label={m.closePanel}><ui.Button size="icon-xs" variant="quiet" aria-label={m.closePanel} onClick={onClose}><X /></ui.Button></ui.Tip>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1 text-sm">
        {results.error && <p className="px-3 py-2 text-xs text-danger" role="alert">{results.error}</p>}
        {!results.loading && !results.complete && results.locations.length > 0 && <p className="px-3 py-1 text-xs text-fg-3">{m.incomplete}</p>}
        {groups.map(([path, lines]) => (
          <div key={path}>
            <button type="button" onClick={() => onOpen({ path, line: lines[0]!.line, column: lines[0]!.column })} className="flex h-6 w-full items-center gap-1.5 px-2 text-left hover:bg-hover">
              {ui.FileIcon && <ui.FileIcon name={fileName(path)} className="size-3.5" />}
              <span className="shrink-0 text-fg">{fileName(path)}</span>
              <span className="min-w-0 truncate text-xs text-fg-4">{dirName(path)}</span>
              <span className="ml-auto shrink-0 pl-2 text-xs text-fg-4">{lines.length}</span>
            </button>
            {lines.map((location) => {
              const here = current?.path === location.path && current.line === location.line;
              return (
                <button
                  key={`${location.line}:${location.column}`} type="button" onClick={() => onOpen({ path: location.path, line: location.line, column: location.column })}
                  className={cn('flex h-6 w-full items-center gap-3 pl-8 pr-2 text-left hover:bg-hover', here && 'bg-active')}
                >
                  <span className="w-10 shrink-0 text-right font-mono text-2xs tabular-nums text-fg-4">{location.line}</span>
                  <span className="min-w-0 truncate whitespace-pre font-mono text-xs text-fg-2">{location.text.trim()}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
