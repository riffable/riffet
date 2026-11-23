import { useCallback, useEffect, useState, type ComponentType, type DragEvent, type ReactNode } from 'react';
import { Trans } from '@lingui/react/macro';
import { IconEllipsis, IconSettings2 } from '@/components/icons';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useMediaQuery } from '@/lib/use-media-query';
import { cn } from '@/lib/utils';
import { moveSidebarPinned, splitSidebarDestinations, toggleSidebarPinned } from './sidebarDestinations';

const DRAG_TYPE = 'application/x-riffet-sidebar-destination';

export function sidebarNavRow(mobile: boolean) {
  return mobile
    ? 'flex h-10 items-center gap-2 rounded-lg px-2.5 text-sm font-medium text-fg transition-colors hover:bg-hover'
    : 'flex h-8 w-full items-center gap-[9px] rounded-lg px-2 text-sm text-fg-2 transition-colors hover:bg-hover hover:text-fg';
}

interface Destination {
  icon: ComponentType<{ className?: string }>;
  label: string;
  open: () => void;
  active?: boolean | undefined;
  trailing?: ReactNode;
}

interface Props {
  offered: readonly string[];
  saved: readonly string[] | undefined;
  save: ((update: (current: readonly string[]) => readonly string[]) => void) | undefined;
  destinationOf: (id: string) => Destination;
  onCustomize: () => void;
  mobile: boolean;
}

type DropTarget = { before: string | null; offset: number } | 'more' | undefined;

export function SidebarDestinationRows({ offered, saved, save, destinationOf, onCustomize, mobile }: Props) {
  const { pinned, more } = splitSidebarDestinations(saved, offered);
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<string>();
  const [indicator, setIndicator] = useState<number | 'more'>();
  const fine = useMediaQuery('(any-pointer: fine)');
  const draggable = !mobile && fine && save !== undefined;
  const moreActive = more.some((id) => destinationOf(id).active);
  const row = sidebarNavRow(mobile);
  const icon = cn('shrink-0', mobile ? 'size-4 text-fg-2' : 'size-[15px]');

  const clear = useCallback(() => { setSource(undefined); setIndicator(undefined); }, []);
  const sourceAvailable = source !== undefined && draggable && offered.includes(source);
  useEffect(() => {
    if (!source) return;
    if (!sourceAvailable) { clear(); return; }
    // The source can disappear when a plugin unloads or a menu closes during the gesture.
    window.addEventListener('dragend', clear, true);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('dragend', clear, true);
      window.removeEventListener('blur', clear);
    };
  }, [source, sourceAvailable, clear]);

  const dragProps = (id: string) => draggable ? {
    draggable: true,
    onDragStart: (event: DragEvent) => {
      // A private type keeps labels out of editors and limits drops to this navigation.
      event.dataTransfer.setData(DRAG_TYPE, id);
      event.dataTransfer.effectAllowed = 'move';
      setSource(id);
    },
  } : {};

  const locate = (event: DragEvent<HTMLDivElement>): DropTarget => {
    // React delivers the menu portal's events here as well. Only the actual sidebar is a target.
    if (!sourceAvailable || !event.dataTransfer.types.includes(DRAG_TYPE)
      || !(event.target instanceof Element) || !event.currentTarget.contains(event.target)) return;
    const moreRow = event.currentTarget.querySelector<HTMLElement>('[data-sidebar-more]')!;
    const end = moreRow.getBoundingClientRect();
    const top = event.currentTarget.getBoundingClientRect().top;
    // Even a partially visible row offers both halves. Keep its insertion line inside the viewport.
    const slot = (index: number, edge: number) => ({
      before: pinned[index] ?? null,
      offset: Math.max(0, Math.min(end.top, edge) - top),
    });
    if (event.clientY >= end.top) {
      // The upper quarter adjoins the last insertion slot. With no pins the whole row accepts the first.
      if (!pinned.length || event.clientY < end.top + end.height / 4) return slot(pinned.length, end.top);
      return pinned.includes(source) ? 'more' : undefined;
    }
    const rows = event.currentTarget.querySelectorAll<HTMLElement>('[data-sidebar-destination]');
    for (let index = 0; index < rows.length; index++) {
      const rect = rows[index]!.getBoundingClientRect();
      if (event.clientY < rect.top + rect.height / 2) return slot(index, rect.top);
    }
    return slot(pinned.length, end.top);
  };

  const over = (event: DragEvent<HTMLDivElement>) => {
    const next = locate(event);
    setIndicator(typeof next === 'object' ? next.offset : next);
    if (next === undefined) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  };
  const drop = (event: DragEvent<HTMLDivElement>) => {
    const at = locate(event);
    const id = source;
    clear();
    if (at === undefined || !save || !id || event.dataTransfer.getData(DRAG_TYPE) !== id) return;
    event.preventDefault();
    event.stopPropagation();
    save(current => at === 'more' ? toggleSidebarPinned(current, id, false) : moveSidebarPinned(current, offered, id, at.before));
    setOpen(false);
  };

  const pinnedRows = pinned.map((id) => {
    const { icon: Icon, label, open: navigate, active, trailing } = destinationOf(id);
    return (
      <button
        key={id}
        type="button"
        data-sidebar-destination={id}
        {...dragProps(id)}
        aria-current={active ? 'page' : undefined}
        onClick={navigate}
        className={cn(row, 'relative shrink-0', !mobile && 'focus-visible:-outline-offset-2', active && 'bg-active text-fg',
          draggable && 'cursor-grab select-none active:cursor-grabbing', source === id && 'opacity-50')}
      >
        <Icon className={icon} />{label}{trailing}
      </button>
    );
  });

  const menu = (
    <DropdownMenu open={open} onOpenChange={next => { setOpen(next); if (!next) clear(); }}>
      <DropdownMenuTrigger asChild>
        <button type="button" data-sidebar-more className={cn(row, 'relative shrink-0', moreActive && 'bg-active text-fg',
          indicator === 'more' && 'bg-active text-fg ring-2 ring-inset ring-focus')}>
          <IconEllipsis className={icon} /><Trans context="workbench-sidebar-more">更多</Trans>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start" className="w-56">
        {more.map((id) => {
          const { icon: Icon, label, open: navigate, active, trailing } = destinationOf(id);
          return (
            <DropdownMenuItem key={id} {...dragProps(id)} aria-current={active ? 'page' : undefined} onSelect={navigate}
              className={cn(draggable && 'cursor-grab active:cursor-grabbing', source === id && 'opacity-50')}>
              <Icon />{label}{trailing}
            </DropdownMenuItem>
          );
        })}
        {more.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={onCustomize}><IconSettings2 /><Trans>自定义侧栏</Trans></DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  if (mobile) return <>{pinnedRows}{menu}</>;
  return (
    <div
      data-sidebar-dragging={source ? '' : undefined}
      // Radix's modal menu blocks outside pointer events. Re-enable only the drop zone during a drag.
      className={cn('relative flex min-h-0 flex-col gap-px', source && 'pointer-events-auto')}
      onDragOver={source ? over : undefined}
      onDrop={source ? drop : undefined}
      onDragLeave={source ? event => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setIndicator(undefined);
      } : undefined}
    >
      {pinned.length > 0 && <div className="flex min-h-0 flex-col gap-px overflow-y-auto">{pinnedRows}</div>}
      {menu}
      {typeof indicator === 'number' && <span aria-hidden className="pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-focus" style={{ top: indicator }} />}
    </div>
  );
}
