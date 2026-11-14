import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * The standard list row: 32 high (44 on a touch screen), 10 side padding, radius `lg`. Rows that
 * carry their own buttons cannot nest them in a `<button>`, so they render as `role="button"`.
 */
export const listRowClass = 'group/row flex min-h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2.5 text-left text-sm outline-none transition-colors hover:bg-hover [&:active:not(:has(button:active))]:bg-active focus-visible:ring-2 focus-visible:ring-focus no-hover:min-h-11 [&_svg]:shrink-0';

/**
 * Trailing actions that wait for the row: shown while the pointer is on it, the keyboard is inside
 * it or one of their menus is open, and always on a touch screen. Hidden, they keep their place and
 * take no clicks. Put it on an element inside a `ListRow` (or any `group/row`).
 */
export const rowReveal = 'opacity-0 pointer-events-none transition-opacity group-hover/row:opacity-100 group-hover/row:pointer-events-auto group-focus-visible/row:opacity-100 group-focus-visible/row:pointer-events-auto group-has-[:focus-visible]/row:opacity-100 group-has-[:focus-visible]/row:pointer-events-auto group-has-[[data-state=open]]/row:opacity-100 group-has-[[data-state=open]]/row:pointer-events-auto no-hover:opacity-100 no-hover:pointer-events-auto';

/** The opposite half: something that gives its place to the revealed actions, e.g. a timestamp in the same grid cell. */
export const rowConceal = 'transition-opacity group-hover/row:pointer-events-none group-hover/row:opacity-0 group-focus-visible/row:pointer-events-none group-focus-visible/row:opacity-0 group-has-[:focus-visible]/row:pointer-events-none group-has-[:focus-visible]/row:opacity-0 group-has-[[data-state=open]]/row:pointer-events-none group-has-[[data-state=open]]/row:opacity-0 no-hover:pointer-events-none no-hover:opacity-0';

export function RowActions({ className, ...props }: React.ComponentProps<'span'>) {
  return <span className={cn('flex shrink-0 items-center', rowReveal, className)} {...props} />;
}

export interface ListRowProps extends React.ComponentProps<'button'> {
  /** The icon or indicator before the title, 16 wide. */
  leading?: React.ReactNode;
  /** The title, one line. */
  children: React.ReactNode;
  /** A short fact after the title: a count, a time. */
  meta?: React.ReactNode;
  /** Decoration at the end of a row, such as a chevron. Not interactive. */
  trailing?: React.ReactNode;
  /** Interactive controls at the end (usually a `RowActions`). Makes the row a `role="button"` div. */
  actions?: React.ReactNode;
  /** The current row. The caller passes the matching ARIA (`aria-current`, `aria-pressed`, `aria-selected`). */
  selected?: boolean;
}

/** Clicks on the row's own controls (and the click Enter fires on a focused button) stay theirs. */
const keepInside = (event: React.MouseEvent) => event.stopPropagation();

export function ListRow({ leading, children, meta, trailing, actions, selected, disabled, className, onKeyDown, onClick, ...props }: ListRowProps) {
  const classes = cn(listRowClass, selected ? 'bg-active text-fg' : 'text-fg-2 hover:text-fg', disabled && 'pointer-events-none opacity-50', className);
  const content = <>
    {leading && <span className="grid size-4 shrink-0 place-items-center text-fg-3 [&_svg:not([class*='size-'])]:size-4">{leading}</span>}
    <span className="min-w-0 flex-1 truncate">{children}</span>
    {meta && <span className="shrink-0 text-xs tabular-nums text-fg-3">{meta}</span>}
    {trailing}
    {actions && <span className="contents" onClick={keepInside}>{actions}</span>}
  </>;
  if (!actions) return <button type="button" disabled={disabled} className={classes} onKeyDown={onKeyDown} onClick={onClick} {...props}>{content}</button>;
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      className={classes}
      {...(props as React.ComponentProps<'div'>)}
      onClick={(event) => { if (!disabled) onClick?.(event as unknown as React.MouseEvent<HTMLButtonElement>); }}
      onKeyDown={(event) => {
        if (disabled) return;
        onKeyDown?.(event as unknown as React.KeyboardEvent<HTMLButtonElement>);
        // Keys pressed on the controls inside the row stay theirs.
        if (event.defaultPrevented || event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        event.currentTarget.click();
      }}
    >
      {content}
    </div>
  );
}
