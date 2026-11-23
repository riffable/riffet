import type { ComponentProps, ReactNode, Ref, UIEventHandler } from 'react';
import { useLingui } from '@lingui/react/macro';
import { IconArrowLeft, IconMenu } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { OverlayScopeContext, useOverlayState } from '@/lib/overlay-navigation';
import { cn } from '@/lib/utils';
import { ExpandSidebarButton } from './ExpandSidebarButton';

/** The content column's tiers (docs/design/system/patterns.md §1.2). `none` hands the scroller to the page. */
const COLUMNS = {
  /** Lists, forms, project home: 768. */
  document: 'max-w-3xl',
  /** Charts side by side: 1200. */
  board: 'max-w-300',
} as const;
export type PageColumn = keyof typeof COLUMNS | 'none';

interface HeaderProps {
  title: ReactNode;
  /** Beside the title, inside its line: a breadcrumb or a count. */
  meta?: ReactNode;
  /** Right-aligned: icon buttons first, the primary action last. */
  actions?: ReactNode;
  /** A rule under the header on desktop too; phones always draw it. */
  divided?: boolean;
  /** Replaces the phone sidebar button with a back button (e.g. a full-page section inside mobile Settings). */
  mobileBack?: { label: string; onBack: () => void };
  sidebarCollapsed: boolean;
  onOpenSidebar: () => void;
  onExpandSidebar: () => void;
}

/** A page header: 48 / 52 tall, the sidebar button (phones, or a collapsed sidebar), the title, then the page's actions. */
export function PageHeader({ title, meta, actions, divided, mobileBack, sidebarCollapsed, onOpenSidebar, onExpandSidebar, className }: HeaderProps & { className?: string }) {
  const { t } = useLingui();
  return (
    // A phone's bar matches the conversation header: 44 buttons 6 from the edges, the title 16 after the menu glyph (mobile.md §10.2).
    <header className={cn('flex h-12 shrink-0 items-center gap-2 px-1.5 max-md:edge-b md:h-13 md:px-3 md:pl-4', divided && 'edge-b', className)}>
      {mobileBack ? (
        <Button size="icon-sm" variant="quiet" className="-mr-2 size-11 md:hidden" aria-label={mobileBack.label} onClick={mobileBack.onBack}><IconArrowLeft /></Button>
      ) : (
        <Button size="icon-sm" variant="quiet" className="-mr-2 size-11 md:hidden" aria-label={t`打开侧边栏`} onClick={onOpenSidebar}><IconMenu /></Button>
      )}
      {sidebarCollapsed && <ExpandSidebarButton onClick={onExpandSidebar} />}
      <h1 className="min-w-0 truncate text-sm font-medium text-fg">{title}</h1>
      {meta}
      {actions && <div className="ml-auto flex min-w-0 items-center gap-1">{actions}</div>}
    </header>
  );
}

/**
 * A workbench page: a fixed header over one scroller holding a centred column. The page is a
 * Back-closable layer, so the browser's Back and Escape-to-close reach `onClose`.
 */
export function PageScaffold({ title, meta, actions, column = 'document', divided, mobileBack, sidebarCollapsed, onClose, onOpenSidebar, onExpandSidebar, scrollRef, onScroll, scrollerProps, columnClassName, pinned, aside, children }: HeaderProps & {
  column?: PageColumn;
  onClose: () => void;
  scrollRef?: Ref<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
  /** Extra attributes for the scroller: `aria-busy`, or a data hook descendants look up. */
  scrollerProps?: Omit<ComponentProps<'div'>, 'children' | 'className' | 'ref' | 'onScroll'> & Record<`data-${string}`, string | boolean | undefined>;
  columnClassName?: string;
  /** Drawn over the scroller and outside it, so it stays put while the page scrolls (positioned against the page root). */
  pinned?: ReactNode;
  /** A contents column left of the scroller, scrolling on its own (patterns.md §1.2, 目录加正文). */
  aside?: ReactNode;
  children: ReactNode;
}) {
  const overlay = useOverlayState({ open: true, onOpenChange: (next) => { if (!next) onClose(); } });
  return (
    <OverlayScopeContext.Provider value={overlay.scope}>
      <div className="relative flex h-full min-h-0 flex-col max-md:bg-bg md:bg-transparent">
        <PageHeader title={title} meta={meta} actions={actions} divided={divided} mobileBack={mobileBack} sidebarCollapsed={sidebarCollapsed} onOpenSidebar={onOpenSidebar} onExpandSidebar={onExpandSidebar} />
        <div className="flex min-h-0 flex-1">
          {aside}
          <div ref={scrollRef} onScroll={onScroll} className="min-h-0 min-w-0 flex-1 overflow-y-auto" {...scrollerProps}>
            {column === 'none' ? children : (
              <div className={cn('mx-auto box-content px-4 pb-16 pt-6 md:px-8 md:pt-10', COLUMNS[column], columnClassName)}>{children}</div>
            )}
          </div>
        </div>
        {pinned}
      </div>
    </OverlayScopeContext.Provider>
  );
}
