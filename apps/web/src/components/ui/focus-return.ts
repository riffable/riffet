import * as React from 'react';
import { isTextField } from '@/lib/tap-focus';
import { MOBILE_LAYOUT_QUERY } from '@/lib/use-media-query';

/*
 * Focus return for the floating surfaces (menus, popovers, dialogs). A surface opened while the
 * reader was typing hands the caret back to that field when it closes: Radix's own return goes to
 * the trigger, where the next Space reopens the surface, and a pointer selection leaves `<body>`.
 * A phone keeps each surface's existing return — focusing a field there raises the keyboard.
 */
const desktop = () => !window.matchMedia(MOBILE_LAYOUT_QUERY).matches;
const typingIn = (element: Element | null): element is HTMLElement => element instanceof HTMLElement && isTextField(element) && !element.matches(':disabled');

/**
 * A primary press on a trigger leaves the caret in the field it is in, as Radix's menu trigger already
 * does on its own; the surface then knows which field to give focus back to.
 */
export function keepTypingFocus(event: React.MouseEvent<HTMLElement>): void {
  if (event.button === 0 && desktop() && typingIn(document.activeElement) && !event.currentTarget.contains(document.activeElement)) event.preventDefault();
}

/** The field to give focus back to: captured as focus first enters the surface, given back as it closes. */
export function useTypingFocusReturn() {
  const field = React.useRef<HTMLElement | null | undefined>(undefined);
  return React.useMemo(() => ({
    /** From the surface's `focusin`; only the first one of an opening counts, later ones move within it. */
    capture(event: React.FocusEvent<HTMLElement>) {
      if (field.current !== undefined || event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      field.current = typingIn(event.relatedTarget as Element | null) && desktop() ? event.relatedTarget as HTMLElement : null;
    },
    /** From `onCloseAutoFocus`, after the caller's own handler; cancels the surface's return when it takes over. */
    restore(event: Event) {
      const target = field.current;
      field.current = undefined;
      const active = document.activeElement;
      // A caller that placed focus itself, or a reader who already clicked somewhere real, wins.
      if (event.defaultPrevented || !target?.isConnected || !typingIn(target) || (active && active !== document.body && active !== target)) return;
      event.preventDefault();
      target.focus({ preventScroll: true });
    },
  }), []);
}
