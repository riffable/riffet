import * as React from 'react';
import { Popover as Primitive } from 'radix-ui';
import { cn } from '@/lib/utils';
import { MOBILE_LAYOUT_QUERY } from '@/lib/use-media-query';
import { OverlayOpenContext, OverlayScopeContext, useClosingSnapshot, useOverlayState } from '@/lib/overlay-navigation';
import { menuSurface } from './dropdown-menu';
import { keepTypingFocus, useTypingFocusReturn } from './focus-return';

export function Popover({ open, defaultOpen, onOpenChange, ...props }: React.ComponentProps<typeof Primitive.Root>) {
  const { scope, ...state } = useOverlayState({ open, defaultOpen, onOpenChange });
  return <OverlayScopeContext.Provider value={scope}><OverlayOpenContext.Provider value={state.open}><Primitive.Root {...props} {...state} /></OverlayOpenContext.Provider></OverlayScopeContext.Provider>;
}
export function PopoverTrigger({ onMouseDown, ...props }: React.ComponentProps<typeof Primitive.Trigger>) {
  return <Primitive.Trigger onMouseDown={(event) => { onMouseDown?.(event); keepTypingFocus(event); }} {...props} />;
}
export const PopoverAnchor = Primitive.Anchor;
export const PopoverClose = Primitive.Close;

export function PopoverContent({ className, children, sideOffset = 6, align = 'start', hideWhenDetached = true, onOpenAutoFocus, onCloseAutoFocus, onFocusCapture, ref, ...props }: React.ComponentProps<typeof Primitive.Content>) {
  const contentRef = React.useRef<HTMLDivElement>(null);
  const focusReturn = useTypingFocusReturn();
  const shown = useClosingSnapshot(children);
  React.useImperativeHandle(ref, () => contentRef.current!);
  return (
    <Primitive.Portal>
      <Primitive.Content
        ref={contentRef} sideOffset={sideOffset} align={align} collisionPadding={8} hideWhenDetached={hideWhenDetached}
        className={cn(menuSurface, 'ui-popover-content p-0', className, 'max-w-[calc(100vw-16px)]')}
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
