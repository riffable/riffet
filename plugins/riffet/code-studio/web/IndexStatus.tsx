import { useEffect, useRef } from 'react';
import type { CodeIndexStatus } from '@contracts';
import { usePluginHost } from '@riffet/plugin-web';
import type { Messages } from './messages';

/** Samples of progress kept for the rate: the last minute of them. */
const RATE_WINDOW_MS = 60_000;
/** Too short a span gives a rate that jumps about: no estimate below it. */
const RATE_MIN_SPAN_MS = 8_000;

/**
 * The index in the status bar, and on click how far it has got: the step it is on, files done of all,
 * symbols so far, when it was last built and about how long is left (from the rate over the last minute),
 * with Rebuild. `onOpenChange` lets the page ask for the status more often while this is open.
 */
export function IndexStatus({ index, building, messages: m, onRebuild, onOpenChange }: {
  index: CodeIndexStatus; building: boolean; messages: Messages; onRebuild(): void; onOpenChange(open: boolean): void;
}) {
  const { ui } = usePluginHost();
  const running = index.phase !== undefined || building;
  const remaining = useRemaining(index, running);
  const label = index.state === 'failed' ? m.index.failed : index.state === 'idle' ? m.index.idle
    : building ? m.index.building(index.done, index.files)
      : index.phase ? m.index.checking(index.done, index.files) : m.index.ready(index.symbols);
  const trigger = (
    <button type="button" className="flex items-center gap-1.5 rounded px-1 hover:bg-hover hover:text-fg">
      {running && <ui.Spinner className="size-3" />}
      <span className="tabular-nums">{label}</span>
    </button>
  );
  if (!ui.Popover) return trigger;
  const share = index.files ? index.done / index.files : 0;
  const rows: Array<[string, string]> = [];
  if (index.phase) rows.push([m.index.step, m.index.phase[index.phase]]);
  if (index.files) rows.push([m.index.files, running && index.phase !== 'listing' ? m.index.ofFiles(index.done, index.files) : m.index.number(index.files)]);
  rows.push([m.index.symbols, m.index.number(index.symbols)]);
  if (remaining !== undefined) rows.push([m.index.left, m.index.minutes(remaining)]);
  if (index.builtAt) rows.push([m.index.built, new Date(index.builtAt).toLocaleString()]);
  return (
    <ui.Popover trigger={trigger} side="top" align="start" className="w-72 p-3" onOpenChange={onOpenChange}>
      <div className="grid gap-3 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-fg">{m.index.title}</span>
          <span className="text-fg-3">{index.state === 'ready' && !running ? m.index.upToDate : label}</span>
        </div>
        {running && index.phase !== 'listing' && ui.Progress && <ui.Progress value={share} label={label} />}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          {rows.map(([name, value]) => (
            <div key={name} className="contents">
              <dt className="text-fg-3">{name}</dt>
              <dd className="text-right tabular-nums text-fg-2">{value}</dd>
            </div>
          ))}
        </dl>
        {index.error && <p className={index.state === 'failed' ? 'text-danger' : 'text-fg-3'}>{index.error}</p>}
        {running && <p className="text-fg-4">{m.index.paused}</p>}
        <ui.Button size="sm" variant="secondary" disabled={running} onClick={onRebuild}>{m.index.rebuild}</ui.Button>
      </div>
    </ui.Popover>
  );
}

/** Minutes left at the rate files went by over the last minute; `undefined` until that is known. */
function useRemaining(index: CodeIndexStatus, running: boolean): number | undefined {
  const samples = useRef<Array<{ at: number; done: number; files: number }>>([]);
  useEffect(() => {
    if (!running || index.phase !== 'parsing') { samples.current = []; return; }
    const now = Date.now();
    const last = samples.current.at(-1);
    // A new run (fewer done, or another count of files) starts the samples over.
    if (last && (index.done < last.done || index.files !== last.files)) samples.current = [];
    samples.current.push({ at: now, done: index.done, files: index.files });
    samples.current = samples.current.filter((sample) => now - sample.at <= RATE_WINDOW_MS);
  }, [index, running]);
  const first = samples.current[0], last = samples.current.at(-1);
  if (!first || !last || last.at - first.at < RATE_MIN_SPAN_MS || last.done <= first.done) return undefined;
  const perMs = (last.done - first.done) / (last.at - first.at);
  return (index.files - index.done) / perMs / 60_000;
}
