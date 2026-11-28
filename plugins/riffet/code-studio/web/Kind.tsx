import { cn } from './cn';
import { KIND_MARK } from './data';

/**
 * A declaration's kind as a subtle rounded monogram badge, toned softly from theme semantic hues
 * so dense symbol lists stay calm and readable rather than flashing loud red letters.
 */
const KIND_STYLE: Record<string, string> = {
  class: 'bg-(--chart-1)/12 text-(--chart-1)',
  interface: 'bg-(--chart-2)/12 text-(--chart-2)',
  object: 'bg-(--chart-4)/12 text-(--chart-4)',
  enum: 'bg-(--chart-3)/12 text-(--chart-3)',
  typealias: 'bg-(--chart-4)/12 text-(--chart-4)',
  annotation: 'bg-(--chart-7)/14 text-(--chart-7)',
  function: 'bg-(--chart-1)/10 text-(--chart-1)',
  constructor: 'bg-(--chart-2)/10 text-(--chart-2)',
  property: 'bg-muted text-fg-3',
};

export function KindMark({ kind, className }: { kind: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-4 shrink-0 place-items-center rounded font-mono text-2xs font-medium leading-none',
        KIND_STYLE[kind] ?? 'bg-muted text-fg-3',
        className,
      )}
    >
      {KIND_MARK[kind] ?? '·'}
    </span>
  );
}
