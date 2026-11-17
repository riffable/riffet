import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A card of two to four equal cells, an icon over one word: a phone panel's places (变更, 文件,
 * 终端) or its small actions (置顶, 重命名…). Android's `PaneActionBar` and
 * iOS's panel bar are the same part, so the panels read alike on every phone.
 */
export function ActionBar({ className, ...props }: React.ComponentProps<'div'>) {
  return <div role="group" className={cn('grid shrink-0 auto-cols-fr grid-flow-col overflow-hidden rounded-xl border border-line bg-elevated', className)} {...props} />;
}

export interface ActionBarButtonProps extends React.ComponentProps<'button'> {
  icon: React.ReactNode;
  /** One word; the cell truncates rather than wraps. */
  label: string;
  /** The panel this cell opens is showing. Pass `aria-pressed` with it. */
  active?: boolean;
}

/** One cell of an `ActionBar`. Spreads its props, so it can be a menu trigger with `asChild`. */
export function ActionBarButton({ icon, label, active, className, ...props }: ActionBarButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        'flex min-h-16 min-w-0 flex-col items-center justify-center gap-1.5 px-1 py-2 text-sm text-fg outline-none transition-colors',
        'hover:bg-hover active:bg-active data-[state=open]:bg-active focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus disabled:pointer-events-none disabled:opacity-50',
        "[&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-5",
        active && 'bg-active',
        className,
      )}
      {...props}
    >
      {icon}
      <span className="max-w-full truncate">{label}</span>
    </button>
  );
}
