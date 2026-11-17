import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A card in a grid of things to pick from (components/navigation.md「Tile」), under an `h3` group heading: a mark, a title that opens
 * the thing, two lines about it, and a footer of facts and its own controls. The title's button is
 * stretched over the card, so the whole card opens it; the footer sits above that layer.
 */
export function Tile({ media, title, badge, meta, description, facts, actions, onOpen, disabled, className }: {
  /** 40 square, before the title. */
  media?: ReactNode;
  title: ReactNode;
  /** A short label after the title. */
  badge?: ReactNode;
  /** One line under the title: who made it, the version, where it is from. */
  meta?: ReactNode;
  /** Clamped to two lines. */
  description?: ReactNode;
  /** Small icons or words at the start of the footer; give each its own tooltip. */
  facts?: ReactNode;
  /** The card's controls at the end of the footer. */
  actions?: ReactNode;
  onOpen(): void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <article className={cn('relative flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-elevated p-4 transition-colors hover:border-line-strong has-[[data-tile-open]:focus-visible]:ring-2 has-[[data-tile-open]:focus-visible]:ring-focus', className)}>
      <div className="flex min-w-0 items-start gap-3">
        {media}
        <div className="min-w-0 flex-1">
          <h4 className="flex min-w-0 items-center gap-2">
            <button type="button" data-tile-open disabled={disabled} aria-haspopup="dialog" onClick={onOpen} className="min-w-0 truncate text-left text-sm font-medium text-fg outline-none after:absolute after:inset-0 after:rounded-xl disabled:cursor-default">{title}</button>
            {badge}
          </h4>
          {meta && <p className="mt-0.5 truncate text-xs text-fg-3">{meta}</p>}
        </div>
      </div>
      {description && <p className="line-clamp-2 break-words text-xs text-fg-2">{description}</p>}
      {(facts || actions) && <div className="mt-auto flex min-h-7 items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-fg-4 *:relative [&_svg]:size-3.5">{facts}</div>
        {actions && <div className="relative flex shrink-0 items-center gap-1">{actions}</div>}
      </div>}
    </article>
  );
}

/** The grid tiles sit in, sized by its own width: one column, two from 512, three from 768. */
export function TileGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('@container', className)}><div className="grid grid-cols-1 gap-3 @lg:grid-cols-2 @3xl:grid-cols-3">{children}</div></div>;
}
