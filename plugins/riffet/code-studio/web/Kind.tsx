import { cn } from './cn';
import { KIND_MARK } from './data';

/**
 * A declaration's kind as one letter, as the IDE's structure and search lists mark them, coloured as the
 * same kind of name is in the code (`--code-*`): types as keywords, functions as declarations, properties
 * as properties. The letter tells the kinds apart without the colour.
 */
const KIND_COLOR: Record<string, string> = {
  class: 'text-(--code-keyword)', interface: 'text-(--code-keyword)', object: 'text-(--code-keyword)', enum: 'text-(--code-keyword)', typealias: 'text-(--code-keyword)',
  annotation: 'text-(--code-annotation)', function: 'text-(--code-declaration)', constructor: 'text-(--code-declaration)', property: 'text-(--code-property)',
};

export function KindMark({ kind, className }: { kind: string; className?: string }) {
  return <span aria-hidden className={cn('w-4 shrink-0 text-center font-mono text-2xs font-semibold', KIND_COLOR[kind] ?? 'text-fg-3', className)}>{KIND_MARK[kind] ?? '·'}</span>;
}
