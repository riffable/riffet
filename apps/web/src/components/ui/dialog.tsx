import * as React from 'react';
import { useLingui } from '@lingui/react/macro';
import { Dialog as Primitive } from 'radix-ui';
import { IconX } from '@/components/icons';
import { cn } from '@/lib/utils';
import { MOBILE_LAYOUT_QUERY } from '@/lib/use-media-query';
import { OverlayOpenContext, OverlayScopeContext, useClosingSnapshot, useOverlayState } from '@/lib/overlay-navigation';
import { keepTypingFocus } from './focus-return';

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex], [role="button"], [role="menuitem"], [role="option"], [role="radio"], [role="checkbox"], [role="switch"], [role="tab"]';

function firstFocusable(root: HTMLElement): HTMLElement | undefined {
  for (const element of root.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (element.tabIndex < 0) continue;
    if (element instanceof HTMLInputElement && element.type === 'hidden') continue;
    if ((element as HTMLButtonElement).disabled) continue;
    if (!element.getClientRects().length) continue;
    return element;
  }
  return undefined;
}

function isTextField(element: HTMLElement): boolean {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || element.getAttribute('contenteditable') === 'true';
}

export function Dialog({ open, defaultOpen, onOpenChange, onBack, ...props }: React.ComponentProps<typeof Primitive.Root> & { onBack?: () => void }) {
  const { scope, ...state } = useOverlayState({ open, defaultOpen, onOpenChange, onBack });
  return <OverlayScopeContext.Provider value={scope}><OverlayOpenContext.Provider value={state.open}><Primitive.Root {...props} {...state} /></OverlayOpenContext.Provider></OverlayScopeContext.Provider>;
}
/** Leaves the caret where it is on a pointer press, so `previousFocus` below is the field being typed in. */
export function DialogTrigger({ onMouseDown, ...props }: React.ComponentProps<typeof Primitive.Trigger>) {
  return <Primitive.Trigger onMouseDown={(event) => { onMouseDown?.(event); keepTypingFocus(event); }} {...props} />;
}
export const DialogClose = Primitive.Close;

/** The four dialog widths (docs/design/system/patterns.md §2.2); pick by content, not by eye. */
const SIZES = {
  /** confirmDialog, promptDialog and confirmations that wait on their own request. */
  confirm: 'max-w-[420px]',
  /** Create, rename, one form. */
  form: 'max-w-md',
  /** Previews, diffs, choices from a list. */
  content: 'max-w-3xl',
  /** Its own navigation or a large canvas: settings, full previews. */
  workspace: 'max-w-[1080px]',
} as const;
export type DialogSize = keyof typeof SIZES;

export function DialogContent({ className, overlayClassName, children, size = 'form', hideClose, mobileFullscreen, mobileSheet, onOpenAutoFocus, onCloseAutoFocus, ref, ...props }: React.ComponentProps<typeof Primitive.Content> & { overlayClassName?: string; size?: DialogSize; hideClose?: boolean; mobileFullscreen?: boolean; mobileSheet?: boolean }) {
  const { t } = useLingui();
  const shown = useClosingSnapshot(children);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const previousFocus = React.useRef<HTMLElement | null>(null);
  // The portal mounts after this wrapper's layout effects. Forward the actual DOM attachment,
  // otherwise an external drawer ref can stay null throughout its entrance and exit.
  const attachContent = React.useCallback((node: HTMLDivElement | null) => {
    contentRef.current = node;
    const cleanup = typeof ref === 'function' ? ref(node) : undefined;
    if (ref && typeof ref !== 'function') ref.current = node;
    return () => {
      contentRef.current = null;
      if (typeof cleanup === 'function') cleanup();
      else if (typeof ref === 'function') ref(null);
      else if (ref) ref.current = null;
    };
  }, [ref]);
  return (
    <Primitive.Portal>
      <Primitive.Overlay className={cn('ui-dialog-overlay fixed inset-0 z-(--z-scrim) bg-black/25 backdrop-blur-[1.5px] animate-in fill-mode-both fade-in-0 duration-[var(--duration-fast)] ease-[var(--ease-decelerate)] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-[var(--duration-exit-fast)] data-[state=closed]:ease-[var(--ease-accelerate)] dark:bg-black/50', mobileSheet && 'mobile-dialog-sheet-overlay', overlayClassName)} />
      <Primitive.Content
        ref={attachContent}
        className={cn(
          'ui-dialog-content fixed left-1/2 top-[calc(var(--app-top,0px)+var(--app-height,100dvh)/2)] z-(--z-dialog) flex max-h-[calc(var(--app-height,100dvh)-32px)] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl bg-elevated text-fg shadow-pop outline-none animate-in fill-mode-both fade-in-0 zoom-in-[var(--enter-scale)] duration-[var(--duration-fast)] ease-[var(--ease-decelerate)] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[var(--enter-scale)] data-[state=closed]:duration-[var(--duration-exit-fast)] data-[state=closed]:ease-[var(--ease-accelerate)]',
          SIZES[size],
          className,
          mobileFullscreen && 'mobile-dialog-fullscreen',
          mobileSheet && 'mobile-dialog-sheet',
        )}
        onOpenAutoFocus={(event) => {
          previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          onOpenAutoFocus?.(event);
          if (event.defaultPrevented) return;
          const content = contentRef.current;
          if (!content) return;
          // Opening a picker on a phone must not summon the keyboard before the user asks to type.
          if (window.matchMedia(MOBILE_LAYOUT_QUERY).matches) {
            event.preventDefault();
            content.focus({ preventScroll: true });
            return;
          }
          // Radix would focus the first focusable descendant. When that is a button or a card,
          // its :focus-visible ring reads as a selection the user never made (the pointer-opened
          // handoff dialog "highlighting" its first Agent). Focus the dialog itself instead —
          // Tab still walks in and earns the ring. A field the caller auto-focused, or a dialog
          // that simply starts with a text field, keeps the focus it already has.
          const active = document.activeElement;
          if (active instanceof HTMLElement && active !== content && content.contains(active)) {
            // Keep the focus a field already took (autoFocus): Radix would otherwise move it
            // to the first focusable descendant, which may be a button in front of the field.
            event.preventDefault();
            return;
          }
          const first = firstFocusable(content);
          if (!first || isTextField(first)) return;
          event.preventDefault();
          content.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (event.defaultPrevented) return;
          const mobile = window.matchMedia(MOBILE_LAYOUT_QUERY).matches;
          const previous = previousFocus.current;
          // Imperative confirmations have no DialogTrigger. Return to the underlying editor
          // after cancelling, while still avoiding the mobile keyboard on dismissal.
          if (previous?.isConnected && previous !== document.body && !contentRef.current?.contains(previous)
            && (!mobile || !previous.matches('input, textarea, [contenteditable="true"]'))) {
            event.preventDefault();
            previous.focus({ preventScroll: true });
          } else if (mobile) event.preventDefault();
        }}
        {...props}
      >
        {shown}
        {!hideClose && (
          <Primitive.Close className="ui-dialog-close absolute right-2 top-2 grid size-11 place-items-center rounded-lg text-fg-3 transition-colors hover:bg-hover hover:text-fg md:right-3 md:top-3 md:size-7" aria-label={t`关闭`}>
            <IconX className="size-4" />
          </Primitive.Close>
        )}
      </Primitive.Content>
    </Primitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex shrink-0 flex-col gap-1 px-5 pb-3 pt-5 pr-12', className)} {...props} />;
}

export function DialogBody({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('min-h-0 overflow-y-auto overscroll-contain px-5 pb-2', className)} {...props} />;
}

/** Cancel (`ghost`) sits left of the primary action, both at the default size; a bottom sheet stretches them across the row. */
export function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('ui-dialog-footer flex shrink-0 flex-wrap items-center justify-end gap-2 px-5 pb-5 pt-4', className)} {...props} />;
}

export function DialogTitle({ className, ...props }: React.ComponentProps<typeof Primitive.Title>) {
  return <Primitive.Title className={cn('break-words text-lg font-semibold text-fg', className)} {...props} />;
}

export function DialogDescription({ className, ...props }: React.ComponentProps<typeof Primitive.Description>) {
  return <Primitive.Description className={cn('break-words text-sm text-fg-3', className)} {...props} />;
}
