import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { isTextField } from '@/lib/tap-focus';

const EDGE_GUARD = 24;
const TOUCH_SLOP = 10;
const SETTLE_VELOCITY = 0.4; // px/ms, matching the native drawer's 400 dp/s.

interface Swipe {
  id: number;
  x: number;
  y: number;
  started: number;
  width: number;
  offset: number;
  viewportWidth: number;
  initiallyOpen: boolean;
  dragging: boolean;
  samples: { x: number; time: number }[];
}

interface Position { offset: number; dragging: boolean }

/** Radix owns modality, focus and Back; only the two title bars opt into horizontal dragging. */
export function MobileSidebar({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  const { t } = useLingui();
  const drawer = useRef<HTMLDivElement>(null);
  const swipe = useRef<Swipe | undefined>(undefined);
  const releaseListeners = useRef<(() => void) | undefined>(undefined);
  const gestureOpen = useRef(false);
  const latest = useRef({ open, onOpenChange });
  latest.current = { open, onOpenChange };
  const [position, setPosition] = useState<Position>();
  const positionRef = useRef(position);
  const paint = (next: Position | undefined) => { positionRef.current = next; setPosition(next); };
  const [surface, setSurface] = useState<{ open: boolean; enterFrom?: number; exitFrom?: number }>({ open });

  useLayoutEffect(() => {
    // The dialog still has its previous open state in this commit. Sample its visible position
    // before switching animations, including closes from navigation and interrupted swipe rebounds.
    // The second commit completes before paint; Radix continues to own the actual exit/unmount.
    if (surface.open !== open) {
      const bounds = drawer.current?.getBoundingClientRect();
      const offset = bounds ? Math.max(-bounds.width, Math.min(0, bounds.left)) : undefined;
      setSurface({ open, ...(offset === undefined ? {} : open ? { enterFrom: offset } : { exitFrom: offset }) });
    }
    if (open) {
      // A button-open gets the regular entrance; a drag-open already has a finger position.
      if (!gestureOpen.current) paint(undefined);
      gestureOpen.current = false;
    } else {
      swipe.current = undefined;
      releaseListeners.current?.();
      gestureOpen.current = false;
      if (positionRef.current?.dragging) paint({ ...positionRef.current, dragging: false });
    }
  }, [open]);

  useEffect(() => {
    let suppressClickUntil = 0;
    const selectionActive = () => document.getSelection()?.isCollapsed === false;
    const unlisten = () => {
      document.removeEventListener('touchmove', move, true);
      document.removeEventListener('touchend', end, true);
      document.removeEventListener('touchcancel', cancel, true);
    };
    releaseListeners.current = unlisten;
    const finish = (nextOpen: boolean) => {
      const current = swipe.current;
      swipe.current = undefined;
      unlisten();
      if (!current?.dragging) return;
      suppressClickUntil = performance.now() + 500;
      // Keep the last offset for Radix's exit animation; a cancelled close settles back to zero.
      paint({ offset: nextOpen ? 0 : positionRef.current?.offset ?? 0, dragging: false });
      latest.current.onOpenChange(nextOpen);
    };
    const cancel = () => finish(swipe.current?.initiallyOpen ?? latest.current.open);
    const start = (event: TouchEvent) => {
      suppressClickUntil = 0;
      if (event.touches.length !== 1) { cancel(); return; }
      const touch = event.touches[0]!;
      const target = event.target instanceof Element ? event.target : null;
      // Leave the browser's edge Back, pinch zoom, editing and native selection untouched.
      if (!target || isTextField(target) || target.closest('select, [role="slider"]') || selectionActive()
        || touch.clientX < EDGE_GUARD || touch.clientX > window.innerWidth - EDGE_GUARD
        || Math.abs((window.visualViewport?.scale ?? 1) - 1) > 0.01) return;
      const initiallyOpen = latest.current.open;
      const header = target.closest('.workbench-viewport header');
      // Page headers share the same navigation entrance, including tasks, marks and statistics;
      // transcript/card headers do not. Buttons in the title bar keep their ordinary tap behavior.
      const bar = initiallyOpen
        ? target.closest('.mobile-navigation-dialog .mobile-sidebar > [data-touch-bar]')
        : [...(header?.querySelectorAll('button') ?? [])].some((button) => button.getAttribute('aria-label') === t`打开侧边栏`) ? header : null;
      if (!bar || (initiallyOpen && !drawer.current?.contains(bar))) return;
      // A nested menu or another modal has priority over its parent's navigation gesture.
      const overlays = document.querySelectorAll('[role="dialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]');
      if ([...overlays].some((element) => element !== drawer.current)) return;
      const now = performance.now();
      const width = drawer.current?.getBoundingClientRect().width ?? Math.min(360, window.innerWidth * 0.9);
      swipe.current = {
        id: touch.identifier, x: touch.clientX, y: touch.clientY, started: now,
        width, offset: -width,
        viewportWidth: window.innerWidth, initiallyOpen, dragging: false,
        samples: [{ x: touch.clientX, time: now }],
      };
      // Only an eligible title-bar touch installs a blocking listener. Normal page/list scrolling
      // never goes through it; unlike touch-action:none, this also preserves the browser edges.
      document.addEventListener('touchmove', move, { capture: true, passive: false });
      document.addEventListener('touchend', end, { capture: true, passive: false });
      document.addEventListener('touchcancel', cancel, { capture: true, passive: true });
    };
    const move = (event: TouchEvent) => {
      const current = swipe.current;
      if (!current) { unlisten(); return; }
      if (event.touches.length !== 1 || selectionActive() || !event.cancelable) { cancel(); return; }
      const touch = Array.from(event.touches).find((item) => item.identifier === current.id);
      if (!touch) { cancel(); return; }
      const dx = touch.clientX - current.x;
      const dy = touch.clientY - current.y;
      const now = performance.now();
      if (!current.dragging) {
        // A long press belongs to the browser. Once vertical intent wins, do not reconsider it.
        if (now - current.started > 350 || (Math.abs(dy) > TOUCH_SLOP && Math.abs(dy) >= Math.abs(dx))) { cancel(); return; }
        if (Math.abs(dx) < TOUCH_SLOP || Math.abs(dx) < Math.abs(dy) * 1.35) return;
        if (current.initiallyOpen ? dx > 0 : dx < 0) { cancel(); return; }
        current.dragging = true;
        // The entrance or a cancelled close can still be moving while intent is undecided.
        // Take over from its visible position when dragging begins, without a jump to zero.
        const bounds = drawer.current?.getBoundingClientRect();
        if (bounds) current.offset = Math.max(-current.width, Math.min(0, bounds.left)) - dx;
        if (!current.initiallyOpen) {
          gestureOpen.current = true;
          latest.current.onOpenChange(true);
        }
      }
      event.preventDefault();
      current.samples = [...current.samples.filter((sample) => now - sample.time <= 100), { x: touch.clientX, time: now }];
      paint({ offset: Math.max(-current.width, Math.min(0, current.offset + dx)), dragging: true });
    };
    const end = (event: TouchEvent) => {
      const current = swipe.current;
      if (!current) { unlisten(); return; }
      if (event.touches.length || selectionActive()) { cancel(); return; }
      const touch = Array.from(event.changedTouches).find((item) => item.identifier === current.id);
      if (!touch || !current.dragging) { cancel(); return; }
      if (event.cancelable) event.preventDefault();
      const now = performance.now();
      const recent = current.samples.find((sample) => now - sample.time <= 100);
      const velocity = recent && now > recent.time ? (touch.clientX - recent.x) / (now - recent.time) : 0;
      const offset = Math.max(-current.width, Math.min(0, current.offset + touch.clientX - current.x));
      paint({ offset, dragging: true });
      const progress = 1 + offset / current.width;
      finish(Math.abs(velocity) >= SETTLE_VELOCITY ? velocity > 0 : progress > 0.5);
    };
    const click = (event: MouseEvent) => {
      // Some WebViews still synthesize a click on the title button after a consumed drag.
      // A fresh touch clears this guard, so a deliberate next tap is never swallowed.
      if (event.detail && performance.now() < suppressClickUntil) {
        suppressClickUntil = 0;
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const selectionChanged = () => { if (selectionActive()) cancel(); };
    const resized = () => { if (swipe.current && window.innerWidth !== swipe.current.viewportWidth) cancel(); };
    const visibilityChanged = () => { if (document.hidden) cancel(); };
    document.addEventListener('touchstart', start, { capture: true, passive: true });
    document.addEventListener('click', click, true);
    document.addEventListener('selectionchange', selectionChanged);
    document.addEventListener('contextmenu', cancel, true);
    document.addEventListener('visibilitychange', visibilityChanged);
    window.addEventListener('blur', cancel);
    window.addEventListener('resize', resized);
    return () => {
      swipe.current = undefined;
      unlisten();
      releaseListeners.current = undefined;
      document.removeEventListener('touchstart', start, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('selectionchange', selectionChanged);
      document.removeEventListener('contextmenu', cancel, true);
      document.removeEventListener('visibilitychange', visibilityChanged);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('resize', resized);
    };
  }, []);

  return (
    <Dialog open={surface.open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={drawer}
        hideClose
        className="mobile-navigation-dialog"
        overlayClassName="mobile-navigation-overlay"
        aria-describedby={undefined}
        data-sidebar-swipe={position ? position.dragging ? 'dragging' : 'settled' : undefined}
        style={{
          ...(position ? { '--sidebar-offset': `${position.offset}px` } : {}),
          ...(surface.enterFrom === undefined ? {} : { '--sidebar-enter-from': `${surface.enterFrom}px` }),
          ...(surface.exitFrom === undefined ? {} : { '--sidebar-exit-from': `${surface.exitFrom}px` }),
        } as CSSProperties}
      >
        <DialogTitle className="sr-only"><Trans>项目与会话</Trans></DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  );
}
