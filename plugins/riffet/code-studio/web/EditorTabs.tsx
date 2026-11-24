import { useEffect, useRef, type KeyboardEvent } from 'react';
import { usePluginHost } from '@riffet/plugin-web';
import { cn } from './cn';
import { dirName, fileName } from './data';
import type { Messages } from './messages';

/**
 * The open files, as the IDE's editor tabs: the current one underlined (the app's `UnderlineTabs` look),
 * the preview tab's name in italics until it is kept. Middle click closes, right click opens the tab's
 * menu, double click is the page's (keep a preview tab, else maximize the editor); two files of one name show their folders. The current tab is kept in view.
 */
export function EditorTabs({ tabs, active, preview, messages: m, onSelect, onClose, onDoubleClick, onMenu }: {
  tabs: readonly string[];
  active: string | undefined;
  preview: string | undefined;
  messages: Messages;
  onSelect(path: string): void;
  onClose(path: string): void;
  onDoubleClick(path: string): void;
  /** A tab was right-clicked, or the empty part of the row (`undefined`). */
  onMenu(path: string | undefined, point: { x: number; y: number }): void;
}) {
  const { ui } = usePluginHost();
  const X = ui.icon('x');
  const strip = useRef<HTMLDivElement>(null);
  const names = new Map<string, number>();
  for (const tab of tabs) names.set(fileName(tab), (names.get(fileName(tab)) ?? 0) + 1);

  useEffect(() => {
    const element = strip.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    element?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, tabs.length]);

  // Arrows move between tabs and show each, as a tab list does; Delete closes.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = active ? tabs.indexOf(active) : -1;
    const to = event.key === 'ArrowRight' ? at + 1 : event.key === 'ArrowLeft' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined;
    if (to !== undefined && tabs[to]) { event.preventDefault(); onSelect(tabs[to]!); requestAnimationFrame(() => strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()); return; }
    if ((event.key === 'Delete' || event.key === 'Backspace') && active) { event.preventDefault(); onClose(active); }
  };

  return (
    <div
      ref={strip} role="tablist" aria-label={m.openFiles} onKeyDown={onKeyDown}
      // A vertical wheel scrolls the row sideways, as an IDE's tab row does.
      onContextMenu={(event) => { event.preventDefault(); onMenu(undefined, { x: event.clientX, y: event.clientY }); }}
      onWheel={(event) => { const element = strip.current; if (element && event.deltaY && !event.deltaX) element.scrollLeft += event.deltaY; }}
      className="flex h-full min-w-0 flex-1 items-stretch overflow-x-auto scrollbar-none"
    >
      {tabs.map((tab) => {
        const selected = tab === active;
        const name = fileName(tab);
        const twin = (names.get(name) ?? 0) > 1;
        return (
          <div
            key={tab} role="tab" aria-selected={selected} tabIndex={selected ? 0 : -1} title={tab}
            onClick={() => onSelect(tab)}
            onDoubleClick={() => onDoubleClick(tab)}
            onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
            onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); onClose(tab); } }}
            onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onMenu(tab, { x: event.clientX, y: event.clientY }); }}
            className={cn(
              'group/tab relative flex max-w-60 shrink-0 cursor-default select-none items-center gap-1.5 pl-3 pr-1.5 text-sm outline-none transition-colors',
              'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus',
              'after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:transition-colors',
              selected ? 'text-fg after:bg-fg' : 'text-fg-3 after:bg-transparent hover:bg-hover hover:text-fg',
            )}
          >
            {ui.FileIcon && <ui.FileIcon name={name} className="size-4 shrink-0" />}
            <span className={cn('truncate', tab === preview && 'italic')}>{name}</span>
            {twin && <span className="truncate text-xs text-fg-4">{fileName(dirName(tab))}</span>}
            <button
              type="button" tabIndex={-1} aria-label={m.closeTab} onClick={(event) => { event.stopPropagation(); onClose(tab); }}
              className={cn('grid size-4 shrink-0 place-items-center rounded text-fg-4 hover:bg-active hover:text-fg', !selected && 'opacity-0 group-hover/tab:opacity-100')}
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
