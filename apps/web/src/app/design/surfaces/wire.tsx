import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Token, Value } from '../specimen';

/** The key between a mark on a drawing and its line in the legend. */
export function Callout({ n, className }: { n: number | string; className?: string }) {
  return <span aria-hidden className={cn('grid size-4 shrink-0 place-items-center rounded-full border border-fg-4 bg-bg font-mono text-2xs leading-none text-fg-3', className)}>{n}</span>;
}

/** A mark placed on a drawing; `className` positions it. */
export function Mark({ n, className }: { n: number; className?: string }) {
  return <Callout n={n} className={cn('absolute z-10', className)} />;
}

export interface LegendItem {
  n: number;
  name: ReactNode;
  value: ReactNode;
  /** Where the number is set in code. */
  source?: string;
}

/** The numbered legend for a drawing: name, value, and where the value lives. */
export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <ol className="flex flex-col edge-t">
      {items.map((item) => (
        <li key={item.n} className="grid grid-cols-[1rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-0.5 py-3 edge-b md:grid-cols-[1rem_8rem_minmax(0,1fr)_minmax(0,0.9fr)]">
          <Callout n={item.n} className="self-start max-md:mt-0.5 md:self-center" />
          <span className="text-sm text-fg max-md:col-start-2">{item.name}</span>
          <Value className="text-left text-fg-2 max-md:col-start-2">{item.value}</Value>
          {item.source && <Token className="truncate text-fg-4 max-md:col-start-2 md:text-right">{item.source}</Token>}
        </li>
      ))}
    </ol>
  );
}

/** A skeleton line of text in a wireframe. */
export function Line({ w = 'w-full', className }: { w?: string; className?: string }) {
  return <span aria-hidden className={cn('block h-1.5 rounded-full bg-line-strong', w, className)} />;
}

/** A labelled bracket under a figure: a dimension, in the figure's own units. */
export function Dim({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('flex items-center gap-2 font-mono text-2xs tabular-nums text-fg-3', className)}>
      <span aria-hidden className="h-px min-w-3 flex-1 bg-fg-4" />
      {children}
      <span aria-hidden className="h-px min-w-3 flex-1 bg-fg-4" />
    </span>
  );
}
