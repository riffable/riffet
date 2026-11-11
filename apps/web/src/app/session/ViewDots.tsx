import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Tip } from '@/components/ui/tooltip';
import { isApplePlatform } from '@/lib/platform';
import { cn } from '@/lib/utils';
import type { ViewEntry } from '@/plugins/catalog';
import { isComposingKey } from './composerKeyboard';
import type { SessionView } from '../state/navStore';

/** `⌥⇧1` on Apple platforms, `Alt+Shift+1` elsewhere; the n-th visible view. */
export const viewShortcut = (index: number): string => isApplePlatform ? `⌥⇧${index + 1}` : `Alt+Shift+${index + 1}`;

const editable = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');

/** ⌥⇧1–3 pick the 1st–3rd visible view, by physical key so the layout's ⌥⇧ characters do not matter. */
export function useViewShortcuts(views: SessionView[], onSelect: (view: SessionView) => void, enabled: boolean) {
  const latest = useRef({ views, onSelect });
  latest.current = { views, onSelect };
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || !event.shiftKey || event.metaKey || event.ctrlKey || isComposingKey(event)) return;
      const digit = /^Digit([1-3])$/.exec(event.code);
      if (!digit) return;
      // The terminal keeps ⌥ for itself.
      if ((event.target as Element | null)?.closest?.('.xterm')) return;
      // In a text field a Mac layout that types with ⌥ keeps its characters.
      if (isApplePlatform && /^[\x20-\x7e]$/.test(event.key) && editable(event.target)) return;
      const view = latest.current.views[Number(digit[1]) - 1];
      if (!view) return;
      event.preventDefault();
      if (!event.repeat) latest.current.onSelect(view);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}

/**
 * A page indicator for the session's views: 6px dots and a capsule for the current one. Hovering or
 * focusing the group opens it into a pill with the names, each name inset 2px on every side so its
 * capsule stays concentric with the pill's. The caller places it.
 */
export function ViewDots({ views, value, onChange, className }: { views: ViewEntry[]; value: SessionView; onChange: (view: SessionView) => void; className?: string }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const groupRef = useRef<HTMLDivElement>(null);

  // Arrow keys switch the view: the focus follows the selection, but only while it is already here.
  useEffect(() => {
    const group = groupRef.current;
    if (group?.contains(document.activeElement)) group.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, [value]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const index = views.findIndex((view) => view.id === value);
    const next = views[(index + (event.key === 'ArrowRight' ? 1 : -1) + views.length) % views.length];
    if (!next || next.id === value) return;
    event.preventDefault();
    onChange(next.id);
  }, [views, value, onChange]);

  return (
    <div
      ref={groupRef}
      aria-label={t`会话视图`}
      data-open={open || undefined}
      onPointerEnter={(event) => { if (event.pointerType === 'mouse') setOpen(true); }}
      onPointerLeave={() => { if (!groupRef.current?.querySelector(':focus-visible')) setOpen(false); }}
      onFocus={(event) => { if (event.target.matches(':focus-visible')) setOpen(true); }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}
      className={cn(
        'group/dots pointer-events-auto flex h-5 items-center rounded-full px-0.5 transition-[background-color,box-shadow,padding] duration-[var(--duration-base)] ease-out-soft motion-reduce:transition-none',
        'data-open:bg-popover data-open:px-px data-open:shadow-pop',
        className,
      )}
    >
      <div className="flex items-center" role="tablist" aria-label={t({ message: "会话视图" })} onKeyDown={onKeyDown}>
      {views.map((view, index) => {
        const current = view.id === value;
        return (
          <Tip key={view.id} label={view.title} kbd={viewShortcut(index)} side="top">
            <button
              type="button"
              role="tab"
              aria-selected={current}
              aria-label={view.title}
              tabIndex={current ? 0 : -1}
              onClick={() => onChange(view.id)}
              className="group/dot flex h-5 items-center justify-center rounded-full px-[3px] outline-none transition-[padding] duration-[var(--duration-base)] ease-out-soft group-data-open/dots:px-px motion-reduce:transition-none"
            >
              <span
                className={cn(
                  'grid h-1.5 grid-cols-[0fr] items-center overflow-hidden rounded-full transition-[min-width,height,padding,background-color,color,grid-template-columns,box-shadow] duration-[var(--duration-base)] ease-out-soft motion-reduce:transition-none',
                  'group-focus-visible/dot:ring-2 group-focus-visible/dot:ring-focus',
                  'group-data-open/dots:h-4 group-data-open/dots:min-w-0 group-data-open/dots:grid-cols-[1fr] group-data-open/dots:px-2',
                  current
                    ? 'min-w-[18px] bg-accent text-accent-fg'
                    : 'min-w-1.5 bg-fg-4 text-fg-3 group-data-open/dots:bg-transparent group-data-open/dots:group-hover/dot:text-fg group-data-open/dots:group-hover/dot:bg-hover',
                )}
              >
                <span className="min-w-0 overflow-hidden whitespace-nowrap text-xs leading-4 opacity-0 transition-opacity duration-[var(--duration-base)] ease-out-soft group-data-open/dots:opacity-100 motion-reduce:transition-none">{view.title}</span>
              </span>
            </button>
          </Tip>
        );
      })}
      </div>
    </div>
  );
}
