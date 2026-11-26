import * as React from 'react';
import { Popover as Primitive } from 'radix-ui';
import { cn } from '@/lib/utils';
import { MOBILE_LAYOUT_QUERY } from '@/lib/use-media-query';
import { OverlayOpenContext, OverlayScopeContext, useClosingSnapshot, useOverlayState } from '@/lib/overlay-navigation';
import { ModalDialogContext } from './dialog';
import { menuSurface } from './dropdown-menu';
import { keepTypingFocus, useTypingFocusReturn } from './focus-return';

export function Popover({ open, defaultOpen, onOpenChange, modal, ...props }: React.ComponentProps<typeof Primitive.Root>) {
  const { scope, ...state } = useOverlayState({ open, defaultOpen, onOpenChange });
  // Inside a modal Dialog, RemoveScroll eats wheel/touch events on portalled non-modal popovers;
  // promoting to modal gives the popover its own RemoveScroll layer above the dialog's.
  const insideModalDialog = React.useContext(ModalDialogContext);
  return <OverlayScopeContext.Provider value={scope}><OverlayOpenContext.Provider value={state.open}><Primitive.Root modal={modal ?? insideModalDialog} {...props} {...state} /></OverlayOpenContext.Provider></OverlayScopeContext.Provider>;
}
export function PopoverTrigger({ onMouseDown, ...props }: React.ComponentProps<typeof Primitive.Trigger>) {
  return <Primitive.Trigger onMouseDown={(event) => { onMouseDown?.(event); keepTypingFocus(event); }} {...props} />;
}
export const PopoverAnchor = Primitive.Anchor;
export const PopoverClose = Primitive.Close;

/**
 * `mobileSheet` draws the popover as a bottom sheet on a phone: for a panel of filters or options.
 * A popover tied to a spot in the content (a selection, the caret, a chart point) stays anchored.
 */
export function PopoverContent({ className, children, sideOffset = 6, align = 'start', hideWhenDetached = true, mobileSheet = false, onOpenAutoFocus, onCloseAutoFocus, onFocusCapture, ref, ...props }: React.ComponentProps<typeof Primitive.Content> & { mobileSheet?: boolean }) {
  const contentRef = React.useRef<HTMLDivElement>(null);
  const focusReturn = useTypingFocusReturn();
  const shown = useClosingSnapshot(children);
  React.useImperativeHandle(ref, () => contentRef.current!);
  return (
    <Primitive.Portal>
      <Primitive.Content
        ref={contentRef} sideOffset={sideOffset} align={align} collisionPadding={8} hideWhenDetached={hideWhenDetached}
        className={cn(menuSurface, 'ui-popover-content max-h-[var(--radix-popover-content-available-height)] overflow-y-auto overscroll-contain p-0', className, 'max-w-[calc(100vw-16px)]', mobileSheet && 'ui-floating-sheet')}
        onOpenAutoFocus={(event) => {
          onOpenAutoFocus?.(event);
          if (!event.defaultPrevented && window.matchMedia(MOBILE_LAYOUT_QUERY).matches) {
            event.preventDefault();
            contentRef.current?.focus({ preventScroll: true });
          }
        }}
        onFocusCapture={(event) => { focusReturn.capture(event); onFocusCapture?.(event); }}
        onCloseAutoFocus={(event) => { onCloseAutoFocus?.(event); focusReturn.restore(event); }}
        {...props}
      >
        {shown}
      </Primitive.Content>
    </Primitive.Portal>
  );
}
