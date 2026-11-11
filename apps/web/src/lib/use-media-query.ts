import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { pointersAfter, shouldHoldKeyboardHeight, type PointerPhase } from './tap-focus';

// Keep in sync with the md/max-md variants in styles/index.css. A landscape phone still needs
// single-column navigation even when its width crosses the tablet breakpoint.
export const MOBILE_LAYOUT_QUERY = '(max-width: 767px), (pointer: coarse) and (max-height: 500px)';

/** Read during render, so a query that changes with other state answers in the same frame. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const media = window.matchMedia(query);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}

/** Use the visible viewport for keyboard layout, without treating pinch zoom as a resize. */
export function useMobileViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    const media = window.matchMedia(MOBILE_LAYOUT_QUERY);
    const root = document.documentElement;
    let pointers: number[] = [];
    let frame = 0;
    const apply = () => {
      if (!media.matches) {
        root.style.removeProperty('--app-height');
        root.style.removeProperty('--app-top');
        return;
      }
      if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
      root.style.setProperty('--app-height', `${viewport?.height ?? window.innerHeight}px`);
      root.style.setProperty('--app-top', `${viewport?.offsetTop ?? 0}px`);
    };
    const update = () => {
      // A finger down is a long press in progress: the keyboard collapsing under it is not a layout
      // change the reader asked for, so the height stays until the hold lifts.
      if (shouldHoldKeyboardHeight(pointers)) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(apply);
    };
    const onPointerDown = (event: PointerEvent) => {
      pointers = pointersAfter(pointers, event.pointerId, 'down');
      // Drop a frame already in flight from just before the press; the hold wins over it.
      cancelAnimationFrame(frame);
    };
    const onPointerEnd = (event: PointerEvent) => {
      const phase: PointerPhase = event.type === 'pointercancel' ? 'cancel' : 'up';
      pointers = pointersAfter(pointers, event.pointerId, phase);
      // Only the last finger lifting resumes layout, and it applies the now-current height once.
      if (!shouldHoldKeyboardHeight(pointers)) update();
    };
    // A release outside the page never reaches us, so losing the window ends the hold rather than
    // freezing the height until the next press.
    const onWindowBlur = () => {
      if (!pointers.length) return;
      pointers = [];
      update();
    };
    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    media.addEventListener('change', update);
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerEnd);
    window.addEventListener('pointercancel', onPointerEnd);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      media.removeEventListener('change', update);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerEnd);
      window.removeEventListener('pointercancel', onPointerEnd);
      window.removeEventListener('blur', onWindowBlur);
      root.style.removeProperty('--app-height');
      root.style.removeProperty('--app-top');
    };
  }, []);
}
