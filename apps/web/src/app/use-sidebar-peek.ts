import { createContext, useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';

/** Long enough to cross the gap between the edge and the panel, short enough to feel attached. */
const OPEN_DELAY_MS = 90;
/** The expand button opens the sidebar on a click, so a pointer passing on its way to click it must not peek. */
const TRIGGER_DELAY_MS = 260;
const CLOSE_DELAY_MS = 220;
/**
 * A menu or popover opened from inside the panel. A trigger that also shows a tooltip carries the
 * tooltip's `data-state` (Radix spreads it over the menu's), so its `aria-expanded` is read too.
 */
const OPEN_MENU = '[data-state="open"], [aria-haspopup][aria-expanded="true"]';

export interface SidebarPeekTriggerProps {
  onPointerEnter: (event: PointerEvent) => void;
  onPointerLeave: () => void;
  onPointerDown: () => void;
}

/** Provided by the workbench while a collapsed desktop sidebar can peek; spread on its expand button. */
export const SidebarPeekTrigger = createContext<SidebarPeekTriggerProps | null>(null);

/**
 * A collapsed sidebar slides back over the conversation while the pointer rests on the window's left
 * edge or on the expand button, and leaves once the pointer does. A menu opened from a row renders in a portal outside the
 * panel, so leaving for it must not take the panel — and the menu's anchor — away.
 */
export function useSidebarPeek(enabled: boolean) {
  const [peek, setPeek] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const hovering = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  const clear = () => { window.clearTimeout(timer.current); timer.current = undefined; };
  const close = useCallback(() => { clear(); hovering.current = false; setPeek(false); }, []);

  useEffect(() => { if (!enabled) close(); }, [enabled, close]);
  useEffect(() => clear, []);
  useEffect(() => {
    if (!peek) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !panelRef.current?.querySelector(OPEN_MENU)) close(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [peek, close]);

  const settle = () => {
    clear();
    timer.current = window.setTimeout(function check() {
      if (hovering.current) return;
      if (panelRef.current?.querySelector(OPEN_MENU)) { timer.current = window.setTimeout(check, CLOSE_DELAY_MS); return; }
      setPeek(false);
    }, CLOSE_DELAY_MS);
  };

  const enter = (delay: number) => (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') return;
    clear();
    hovering.current = true;
    timer.current = window.setTimeout(() => setPeek(true), delay);
  };
  const leave = () => {
    hovering.current = false;
    if (peek) settle(); else clear();
  };

  return {
    peek: enabled && peek,
    panelRef,
    edgeProps: { onPointerEnter: enter(OPEN_DELAY_MS), onPointerLeave: leave },
    triggerProps: { onPointerEnter: enter(TRIGGER_DELAY_MS), onPointerLeave: leave, onPointerDown: clear } satisfies SidebarPeekTriggerProps,
    panelProps: {
      onPointerEnter: () => { clear(); hovering.current = true; },
      onPointerLeave: () => { hovering.current = false; settle(); },
    },
    close,
  };
}
