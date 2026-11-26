import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Trans } from '@lingui/react/macro';
import { MOTION_DURATION, MOTION_EASING } from '@contracts';
import { IconEllipsis, IconSettings2 } from '@/components/icons';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cancelAnimations, exit } from '@/lib/motion';
import { useMediaQuery } from '@/lib/use-media-query';
import { cn } from '@/lib/utils';
import { moveSidebarPinned, reorderSidebarPinned, splitSidebarDestinations, toggleSidebarPinned } from './sidebarDestinations';

const EASE = `cubic-bezier(${MOTION_EASING.standard.join(', ')})`;
const DRAG_THRESHOLD = 5;

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

interface FloatingDrag {
  id: string;
  width: number;
  dimmed: boolean;
}

function suppressImmediateClick(): () => void {
  const stop = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener('click', stop, { capture: true, once: true });
  const timer = window.setTimeout(() => window.removeEventListener('click', stop, true), 0);
  return () => {
    window.clearTimeout(timer);
    window.removeEventListener('click', stop, true);
  };
}

function suppressClickAfterEscape(pointerId: number): () => void {
  let cleanupClick: (() => void) | undefined;
  const detach = () => {
    window.removeEventListener('pointerup', onRelease, true);
    window.removeEventListener('pointercancel', onRelease, true);
    window.removeEventListener('blur', onBlur);
  };
  const onRelease = (event: globalThis.PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    detach();
    cleanupClick = suppressImmediateClick();
  };
  const onBlur = () => { detach(); };
  window.addEventListener('pointerup', onRelease, true);
  window.addEventListener('pointercancel', onRelease, true);
  window.addEventListener('blur', onBlur);
  return () => {
    detach();
    cleanupClick?.();
  };
}

export function SidebarDestinationRows({ offered, saved, save, destinationOf, onCustomize, mobile }: Props) {
  const { pinned, more } = splitSidebarDestinations(saved, offered);
  const [open, setOpen] = useState(false);
  const [overMore, setOverMore] = useState(false);
  const [floating, setFloating] = useState<FloatingDrag>();
  const zoneRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const floatingRef = useRef<HTMLDivElement | null>(null);
  const floatingPosRef = useRef({ x: 0, y: 0 });
  const dragging = useRef(false);
  const settle = useRef<(() => void) | undefined>(undefined);
  const activeCleanup = useRef<(() => void) | undefined>(undefined);
  const clickCleanup = useRef<(() => void) | undefined>(undefined);
  const fine = useMediaQuery('(any-pointer: fine)');
  const draggable = !mobile && fine && save !== undefined;
  const moreActive = more.some((id) => destinationOf(id).active);
  const row = sidebarNavRow(mobile);
  const icon = cn('shrink-0', mobile ? 'size-4 text-fg-2' : 'size-[15px]');
  const orderKey = pinned.join('\u0000');
  const offeredKey = offered.join('\u0000');

  // Drop temporary transform offsets on the same frame the new pinned order renders.
  useLayoutEffect(() => {
    settle.current?.();
    settle.current = undefined;
  }, [orderKey]);

  // Cancel any live gesture if destinations change externally (plugin unload, viewport switch).
  useEffect(() => {
    if (dragging.current || !draggable) activeCleanup.current?.();
  }, [draggable, offeredKey, orderKey]);

  // Ensure window listeners, animations, and body styles never leak on unmount.
  useEffect(() => () => {
    activeCleanup.current?.();
    clickCleanup.current?.();
    settle.current?.();
    settle.current = undefined;
  }, []);

  const commit = (update: (current: readonly string[]) => readonly string[], reset: () => void) => {
    if (!save) { reset(); return; }
    settle.current = reset;
    save(update);
    requestAnimationFrame(() => {
      if (settle.current === reset) {
        settle.current = undefined;
        reset();
      }
    });
  };

  /** Dragging a pinned row inside the sidebar: siblings glide out of the way; pulling onto 更多 stows it. */
  const startPinnedDrag = (id: string, event: PointerEvent<HTMLButtonElement>) => {
    if (!draggable || event.button !== 0 || event.pointerType === 'touch' || dragging.current || settle.current) return;
    activeCleanup.current?.();
    const pointer = event.pointerId;
    const originX = event.clientX;
    const originY = event.clientY;
    const button = event.currentTarget;

    const detachPending = () => {
      if (activeCleanup.current === detachPending) activeCleanup.current = undefined;
      window.removeEventListener('pointermove', onPendingMove);
      window.removeEventListener('pointerup', onPendingEnd);
      window.removeEventListener('pointercancel', onPendingEnd);
      window.removeEventListener('blur', detachPending);
    };
    const onPendingEnd = (e: globalThis.PointerEvent) => { if (e.pointerId === pointer) detachPending(); };
    const onPendingMove = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== pointer) return;
      if ((e.buttons & 1) === 0) { detachPending(); return; }
      if (Math.hypot(e.clientX - originX, e.clientY - originY) < DRAG_THRESHOLD) return;
      detachPending();
      beginPinnedDrag(id, pointer, button, originY, e.clientX, e.clientY);
    };
    activeCleanup.current = detachPending;
    window.addEventListener('pointermove', onPendingMove);
    window.addEventListener('pointerup', onPendingEnd);
    window.addEventListener('pointercancel', onPendingEnd);
    window.addEventListener('blur', detachPending);
  };

  const beginPinnedDrag = (id: string, pointer: number, captureEl: HTMLButtonElement, originY: number, startX: number, startY: number) => {
    const from = pinned.indexOf(id);
    const items = pinned.map((item) => rowRefs.current.get(item));
    const moreEl = moreRef.current;
    const zoneEl = zoneRef.current;
    const listEl = listRef.current;
    if (from < 0 || !moreEl || !zoneEl || items.some((item) => !item)) return;
    const nodes = items as HTMLButtonElement[];
    const rects = nodes.map((item) => item.getBoundingClientRect());
    const moreRect = moreEl.getBoundingClientRect();
    const zoneRect = zoneEl.getBoundingClientRect();
    const listRect = listEl?.getBoundingClientRect();
    const scrollable = Boolean(listEl && listEl.scrollHeight > listEl.clientHeight);
    const node = nodes[from]!;
    const own = rects[from]!;
    const shiftUp = from + 1 < rects.length ? -(rects[from + 1]!.top - own.top) : -own.height;
    const shiftDown = from > 0 ? own.bottom - rects[from - 1]!.bottom : own.height;

    try { captureEl.setPointerCapture(pointer); } catch { /* ignore synthetic pointers */ }
    dragging.current = true;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    window.getSelection()?.removeAllRanges();
    if (listEl && !scrollable) listEl.style.overflow = 'visible';

    // When the pinned list is scrollable, lift the dragged item into a viewport portal so it is
    // never clipped when dragged across the scroll edge toward 更多.
    if (scrollable) {
      node.style.opacity = '0';
      floatingPosRef.current = { x: own.left, y: own.top };
      setFloating({ id, width: own.width, dimmed: false });
    } else {
      node.dataset.dragging = '';
    }
    for (const other of nodes) {
      if (other !== node) {
        other.style.transition = `transform ${MOTION_DURATION.fast}ms ${EASE}`;
        other.style.pointerEvents = 'none';
      }
    }
    moreEl.style.pointerEvents = 'none';

    let dy = 0;
    let to = from;
    let stowing = false;
    let finished = false;
    let stopExit: (() => void) | undefined;

    const reset = () => {
      document.body.style.userSelect = prevUserSelect;
      setOverMore(false);
      if (scrollable) setFloating(undefined);
      if (listEl) listEl.style.overflow = '';
      moreEl.style.pointerEvents = '';
      for (const item of nodes) {
        cancelAnimations(item);
        item.style.transform = '';
        item.style.transition = '';
        item.style.pointerEvents = '';
        item.style.opacity = '';
        delete item.dataset.dragging;
      }
    };

    const detachListeners = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', onKey, true);
      captureEl.removeEventListener('lostpointercapture', onLostCapture);
      if (captureEl.hasPointerCapture?.(pointer)) captureEl.releasePointerCapture(pointer);
    };

    const abortNow = () => {
      if (activeCleanup.current === abortNow) activeCleanup.current = undefined;
      finished = true;
      detachListeners();
      stopExit?.();
      stopExit = undefined;
      dragging.current = false;
      reset();
    };
    activeCleanup.current = abortNow;

    const minY = listRect ? Math.max(listRect.top, rects[0]!.top) : rects[0]!.top;
    const minDy = minY - own.top;
    const maxDy = moreRect.bottom - own.bottom;

    const apply = (clientX: number, clientY: number) => {
      const withinHorizontal = clientX >= zoneRect.left - 48 && clientX <= zoneRect.right + 48;
      const inMore = withinHorizontal && clientY >= moreRect.top + moreRect.height / 4 && clientY <= moreRect.bottom + 24;
      if (inMore !== stowing) {
        stowing = inMore;
        setOverMore(inMore);
        if (scrollable) setFloating((current) => current ? { ...current, dimmed: inMore } : current);
      }
      dy = Math.min(maxDy, Math.max(minDy, clientY - originY));
      if (scrollable) {
        floatingPosRef.current = { x: own.left, y: own.top + dy };
        if (floatingRef.current) {
          floatingRef.current.style.transform = `translate3d(${own.left}px, ${own.top + dy}px, 0)`;
        }
      } else {
        node.style.transform = `translateY(${dy}px)`;
        node.style.opacity = stowing ? '0.8' : '';
      }

      if (stowing) {
        nodes.forEach((other, index) => {
          if (other === node) return;
          other.style.transform = index > from ? `translateY(${shiftUp}px)` : '';
        });
        return;
      }

      const center = (own.top + own.bottom) / 2 + dy;
      to = from;
      for (let index = from + 1; index < rects.length; index += 1) {
        if (listRect && rects[index]!.top >= listRect.bottom) break;
        if (center > (rects[index]!.top + rects[index]!.bottom) / 2) to = index;
      }
      for (let index = from - 1; index >= 0; index -= 1) {
        if (listRect && rects[index]!.bottom <= listRect.top) break;
        if (center < (rects[index]!.top + rects[index]!.bottom) / 2) to = index;
      }
      nodes.forEach((other, index) => {
        if (other === node) return;
        const shift = from < to && index > from && index <= to ? shiftUp : to < from && index >= to && index < from ? shiftDown : 0;
        other.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };

    apply(startX, startY);

    const finish = (cancelled: boolean, viaEscape = false) => {
      if (finished) return;
      finished = true;
      detachListeners();
      dragging.current = false;
      clickCleanup.current?.();
      clickCleanup.current = viaEscape ? suppressClickAfterEscape(pointer) : suppressImmediateClick();

      const animatedEl = scrollable ? floatingRef.current : node;
      if (!cancelled && stowing) {
        const intoMore = moreRect.top - own.top;
        if (animatedEl) {
          const fromTransform = scrollable ? `translate3d(${own.left}px, ${own.top + dy}px, 0) scale(1)` : `translateY(${dy}px) scale(1)`;
          const toTransform = scrollable ? `translate3d(${own.left}px, ${moreRect.top}px, 0) scale(0.96)` : `translateY(${intoMore}px) scale(0.96)`;
          stopExit = exit(
            animatedEl,
            [{ transform: fromTransform, opacity: 0.8 }, { transform: toTransform, opacity: 0 }],
            { duration: MOTION_DURATION.fast, easing: EASE },
            () => {
              stopExit = undefined;
              if (activeCleanup.current === abortNow) activeCleanup.current = undefined;
              commit((current) => toggleSidebarPinned(current, id, false), reset);
            },
          );
        } else {
          if (activeCleanup.current === abortNow) activeCleanup.current = undefined;
          commit((current) => toggleSidebarPinned(current, id, false), reset);
        }
        return;
      }

      const final = cancelled ? from : to;
      if (final === from) {
        setOverMore(false);
        if (scrollable) setFloating((current) => current ? { ...current, dimmed: false } : current);
        else node.style.opacity = '';
        for (const other of nodes) if (other !== node) other.style.transform = '';
      }
      const target = final === from ? 0 : final > from ? rects[final]!.bottom - own.bottom : rects[final]!.top - own.top;
      if (animatedEl) {
        const fromTransform = scrollable ? `translate3d(${own.left}px, ${own.top + dy}px, 0)` : `translateY(${dy}px)`;
        const toTransform = scrollable ? `translate3d(${own.left}px, ${own.top + target}px, 0)` : `translateY(${target}px)`;
        stopExit = exit(
          animatedEl,
          [{ transform: fromTransform }, { transform: toTransform }],
          { duration: MOTION_DURATION.fast, easing: EASE },
          () => {
            stopExit = undefined;
            if (activeCleanup.current === abortNow) activeCleanup.current = undefined;
            if (final === from) { reset(); return; }
            const next = [...pinned];
            next.splice(final, 0, next.splice(from, 1)[0]!);
            commit((current) => reorderSidebarPinned(current, next), reset);
          },
        );
      } else {
        if (activeCleanup.current === abortNow) activeCleanup.current = undefined;
        if (final === from) { reset(); return; }
        const next = [...pinned];
        next.splice(final, 0, next.splice(from, 1)[0]!);
        commit((current) => reorderSidebarPinned(current, next), reset);
      }
    };
    const onMove = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== pointer) return;
      if ((e.buttons & 1) === 0) { finish(true); return; }
      apply(e.clientX, e.clientY);
    };
    const onUp = (e: globalThis.PointerEvent) => { if (e.pointerId === pointer) finish(false); };
    const onCancel = (e: globalThis.PointerEvent) => { if (e.pointerId === pointer) finish(true); };
    const onBlur = () => finish(true);
    const onLostCapture = () => { if (!finished) finish(true); };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      finish(true, true);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onBlur);
    window.addEventListener('keydown', onKey, true);
    captureEl.addEventListener('lostpointercapture', onLostCapture);
  };

  /** Dragging an item out of the 更多 menu into the sidebar: pinned rows open a live slot under the pointer. */
  const startMoreDrag = (id: string, event: PointerEvent<HTMLDivElement>) => {
    if (!draggable || event.button !== 0 || event.pointerType === 'touch' || dragging.current || settle.current) return;
    activeCleanup.current?.();
    const pointer = event.pointerId;
    const originX = event.clientX;
    const originY = event.clientY;
    const itemRect = event.currentTarget.getBoundingClientRect();
    const offsetX = originX - itemRect.left;
    const offsetY = originY - itemRect.top;

    const detachPending = () => {
      if (activeCleanup.current === detachPending) activeCleanup.current = undefined;
      window.removeEventListener('pointermove', onPendingMove);
      window.removeEventListener('pointerup', onPendingEnd);
      window.removeEventListener('pointercancel', onPendingEnd);
      window.removeEventListener('blur', detachPending);
    };
    const onPendingEnd = (e: globalThis.PointerEvent) => { if (e.pointerId === pointer) detachPending(); };
    const onPendingMove = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== pointer) return;
      if ((e.buttons & 1) === 0) { detachPending(); return; }
      if (Math.hypot(e.clientX - originX, e.clientY - originY) < DRAG_THRESHOLD) return;
      detachPending();
      beginMoreDrag(id, pointer, offsetX, offsetY, e.clientX, e.clientY);
    };
    activeCleanup.current = detachPending;
    window.addEventListener('pointermove', onPendingMove);
    window.addEventListener('pointerup', onPendingEnd);
    window.addEventListener('pointercancel', onPendingEnd);
    window.addEventListener('blur', detachPending);
  };

  const beginMoreDrag = (id: string, pointer: number, offsetX: number, offsetY: number, startX: number, startY: number) => {
    const moreEl = moreRef.current;
    const zoneEl = zoneRef.current;
    const listEl = listRef.current;
    if (!moreEl || !zoneEl) return;
    const nodes = pinned.map((item) => rowRefs.current.get(item)).filter((item): item is HTMLButtonElement => Boolean(item));
    const rects = nodes.map((item) => item.getBoundingClientRect());
    const moreRect = moreEl.getBoundingClientRect();
    const zoneRect = zoneEl.getBoundingClientRect();
    const listRect = listEl?.getBoundingClientRect();
    const scrollable = Boolean(listEl && listEl.scrollHeight > listEl.clientHeight);
    const stride = rects.length > 1
      ? rects[1]!.top - rects[0]!.top
      : (rects[0]?.height ?? moreRect.height) + 1;

    try { zoneEl.setPointerCapture(pointer); } catch { /* ignore synthetic pointers */ }
    dragging.current = true;
    setOpen(false);
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    window.getSelection()?.removeAllRanges();
    if (listEl && !scrollable) listEl.style.overflow = 'visible';

    const movable = [...nodes, moreEl];
    for (const item of movable) {
      item.style.transition = `transform ${MOTION_DURATION.fast}ms ${EASE}`;
      item.style.pointerEvents = 'none';
    }

    let insertAt: number | undefined;
    let lastX = startX - offsetX;
    let lastY = startY - offsetY;
    let wasOutside = true;
    let finished = false;
    let stopExit: (() => void) | undefined;

    const reset = () => {
      document.body.style.userSelect = prevUserSelect;
      if (listEl) listEl.style.overflow = '';
      setFloating(undefined);
      for (const item of movable) {
        cancelAnimations(item);
        item.style.transform = '';
        item.style.transition = '';
        item.style.pointerEvents = '';
      }
    };

    const detachListeners = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', onKey, true);
      zoneEl.removeEventListener('lostpointercapture', onLostCapture);
      if (zoneEl.hasPointerCapture?.(pointer)) zoneEl.releasePointerCapture(pointer);
    };

    const abortNow = () => {
      if (activeCleanup.current === abortNow) activeCleanup.current = undefined;
      finished = true;
      detachListeners();
      stopExit?.();
      stopExit = undefined;
      dragging.current = false;
      reset();
    };
    activeCleanup.current = abortNow;

    const visibleTop = listRect ? listRect.top : moreRect.top;
    const visibleBottom = listRect ? listRect.bottom : moreRect.top;

    const locateInsert = (clientX: number, clientY: number): number | undefined => {
      if (clientX < zoneRect.left - 24 || clientX > zoneRect.right + 24) return undefined;
      const topBound = visibleTop - 12;
      const bottomBound = pinned.length === 0 ? moreRect.bottom + 8 : moreRect.top + moreRect.height / 2;
      if (clientY < topBound || clientY > bottomBound) return undefined;
      let firstVisible = 0;
      let lastVisible = rects.length;
      for (let index = 0; index < rects.length; index += 1) {
        const rect = rects[index]!;
        if (listRect && rect.bottom <= visibleTop) { firstVisible = index + 1; continue; }
        if (listRect && rect.top >= visibleBottom) { lastVisible = index; break; }
        if (clientY < rect.top + rect.height / 2) return index;
      }
      return Math.max(firstVisible, lastVisible);
    };

    const apply = (clientX: number, clientY: number) => {
      lastX = clientX - offsetX;
      lastY = clientY - offsetY;
      floatingPosRef.current = { x: lastX, y: lastY };
      if (floatingRef.current) {
        floatingRef.current.style.transform = `translate3d(${lastX}px, ${lastY}px, 0)`;
      }
      insertAt = locateInsert(clientX, clientY);
      const outside = insertAt === undefined;
      if (outside !== wasOutside) {
        wasOutside = outside;
        setFloating((current) => current ? { ...current, dimmed: outside } : current);
      }
      nodes.forEach((item, index) => {
        item.style.transform = insertAt !== undefined && index >= insertAt ? `translateY(${stride}px)` : '';
      });
      moreEl.style.transform = !scrollable && insertAt !== undefined ? `translateY(${stride}px)` : '';
    };

    const initialInsert = locateInsert(startX, startY);
    wasOutside = initialInsert === undefined;
    floatingPosRef.current = { x: lastX, y: lastY };
    setFloating({ id, width: zoneRect.width, dimmed: wasOutside });
    apply(startX, startY);

    const finish = (cancelled: boolean, viaEscape = false) => {
      if (finished) return;
      finished = true;
      detachListeners();
      dragging.current = false;
      clickCleanup.current?.();
      clickCleanup.current = viaEscape ? suppressClickAfterEscape(pointer) : suppressImmediateClick();

      const ghostEl = floatingRef.current;
      if (cancelled || insertAt === undefined) {
        for (const item of movable) item.style.transform = '';
        if (ghostEl) {
          stopExit = exit(
            ghostEl,
            [{ transform: `translate3d(${lastX}px, ${lastY}px, 0)`, opacity: wasOutside ? 0.65 : 1 }, { transform: `translate3d(${lastX}px, ${lastY}px, 0) scale(0.96)`, opacity: 0 }],
            { duration: MOTION_DURATION.fast, easing: EASE },
            () => {
              stopExit = undefined;
              if (activeCleanup.current === abortNow) activeCleanup.current = undefined;
              reset();
            },
          );
        } else {
          if (activeCleanup.current === abortNow) activeCleanup.current = undefined;
          reset();
        }
        return;
      }

      const slotIndex = insertAt;
      const targetX = zoneRect.left;
      const rawTargetY = slotIndex < rects.length
        ? rects[slotIndex]!.top
        : (rects.length > 0 ? rects.at(-1)!.top + stride : moreRect.top);
      const targetY = Math.max(visibleTop, Math.min(moreRect.top, rawTargetY));
      const beforeId = pinned[slotIndex] ?? null;

      if (ghostEl) {
        stopExit = exit(
          ghostEl,
          [{ transform: `translate3d(${lastX}px, ${lastY}px, 0)` }, { transform: `translate3d(${targetX}px, ${targetY}px, 0)` }],
          { duration: MOTION_DURATION.fast, easing: EASE },
          () => {
            stopExit = undefined;
            if (activeCleanup.current === abortNow) activeCleanup.current = undefined;
            commit((current) => moveSidebarPinned(current, offered, id, beforeId), reset);
          },
        );
      } else {
        if (activeCleanup.current === abortNow) activeCleanup.current = undefined;
        commit((current) => moveSidebarPinned(current, offered, id, beforeId), reset);
      }
    };
    const onMove = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== pointer) return;
      if ((e.buttons & 1) === 0) { finish(true); return; }
      apply(e.clientX, e.clientY);
    };
    const onUp = (e: globalThis.PointerEvent) => { if (e.pointerId === pointer) finish(false); };
    const onCancel = (e: globalThis.PointerEvent) => { if (e.pointerId === pointer) finish(true); };
    const onBlur = () => finish(true);
    const onLostCapture = () => { if (!finished) finish(true); };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      finish(true, true);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onBlur);
    window.addEventListener('keydown', onKey, true);
    zoneEl.addEventListener('lostpointercapture', onLostCapture);
  };

  const pinnedRows = pinned.map((id) => {
    const { icon: Icon, label, open: navigate, active, trailing } = destinationOf(id);
    return (
      <button
        key={id}
        ref={(node) => { if (node) rowRefs.current.set(id, node); else rowRefs.current.delete(id); }}
        type="button"
        data-sidebar-destination={id}
        aria-current={active ? 'page' : undefined}
        onClick={navigate}
        onPointerDown={draggable ? (event) => startPinnedDrag(id, event) : undefined}
        className={cn(
          row,
          'relative shrink-0 select-none',
          !mobile && 'focus-visible:-outline-offset-2',
          active && 'bg-active text-fg',
          'data-[dragging]:z-20 data-[dragging]:cursor-grabbing data-[dragging]:bg-elevated data-[dragging]:text-fg data-[dragging]:shadow-pop',
        )}
      >
        <Icon className={icon} />{label}{trailing}
      </button>
    );
  });

  const menu = (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          ref={moreRef}
          type="button"
          data-sidebar-more
          className={cn(
            row,
            'relative shrink-0',
            moreActive && 'bg-active text-fg',
            overMore && 'bg-active text-fg ring-2 ring-inset ring-focus',
          )}
        >
          <IconEllipsis className={icon} /><Trans context="workbench-sidebar-more">更多</Trans>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start" className="w-56">
        {more.map((id) => {
          const { icon: Icon, label, open: navigate, active, trailing } = destinationOf(id);
          return (
            <DropdownMenuItem
              key={id}
              aria-current={active ? 'page' : undefined}
              onSelect={navigate}
              onPointerDown={draggable ? (event) => startMoreDrag(id, event) : undefined}
              className="select-none"
            >
              <Icon />{label}{trailing}
            </DropdownMenuItem>
          );
        })}
        {more.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={onCustomize}><IconSettings2 /><Trans>自定义侧栏</Trans></DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const floatingOverlay = floating && offered.includes(floating.id) && (() => {
    const { icon: Icon, label, trailing } = destinationOf(floating.id);
    const { x, y } = floatingPosRef.current;
    return createPortal(
      <div
        ref={(node) => {
          floatingRef.current = node;
          if (node) {
            const pos = floatingPosRef.current;
            node.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
          }
        }}
        aria-hidden
        style={{ width: floating.width, transform: `translate3d(${x}px, ${y}px, 0)` }}
        className={cn(
          'pointer-events-none fixed left-0 top-0 z-(--z-drop) flex h-8 items-center gap-[9px] rounded-lg bg-elevated px-2 text-sm text-fg shadow-pop transition-opacity',
          floating.dimmed && 'opacity-75',
        )}
      >
        <Icon className="size-[15px] shrink-0" />
        <span className="truncate">{label}</span>
        {trailing}
      </div>,
      document.body,
    );
  })();

  if (mobile) return <>{pinnedRows}{menu}</>;
  return (
    <div ref={zoneRef} className="relative flex min-h-0 flex-col gap-px">
      {pinned.length > 0 && <div ref={listRef} className="flex min-h-0 flex-col gap-px overflow-y-auto">{pinnedRows}</div>}
      {menu}
      {floatingOverlay}
    </div>
  );
}
