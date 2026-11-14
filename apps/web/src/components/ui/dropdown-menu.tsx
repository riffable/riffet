import * as React from 'react';
import { DropdownMenu as Primitive } from 'radix-ui';
import { IconCheck, IconChevronRight } from '@/components/icons';
import { cn } from '@/lib/utils';
import { OverlayOpenContext, OverlayScopeContext, useClosingSnapshot, useOverlayState } from '@/lib/overlay-navigation';
import { useTypingFocusReturn } from './focus-return';

export function DropdownMenu({ open, defaultOpen, onOpenChange, ...props }: React.ComponentProps<typeof Primitive.Root>) {
  const { scope, ...state } = useOverlayState({ open, defaultOpen, onOpenChange });
  return <OverlayScopeContext.Provider value={scope}><OverlayOpenContext.Provider value={state.open}><Primitive.Root {...props} {...state} /></OverlayOpenContext.Provider></OverlayScopeContext.Provider>;
}
export const DropdownMenuTrigger = Primitive.Trigger;
export const DropdownMenuGroup = Primitive.Group;
export const DropdownMenuRadioGroup = Primitive.RadioGroup;

export const menuSurface = 'ui-floating-content z-(--z-menu) min-w-44 overflow-hidden rounded-xl bg-popover p-1 text-fg shadow-pop outline-none origin-(--radix-popper-transform-origin) animate-in fill-mode-both fade-in-0 zoom-in-[var(--enter-scale)] duration-[var(--duration-fast)] ease-[var(--ease-decelerate)] data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=bottom]:slide-out-to-top-1 data-[side=top]:slide-out-to-bottom-1 data-[side=left]:slide-out-to-right-1 data-[side=right]:slide-out-to-left-1 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[var(--enter-scale)] data-[state=closed]:duration-[var(--duration-exit-fast)] data-[state=closed]:ease-[var(--ease-accelerate)]';
export const menuItem = "relative flex min-h-11 cursor-default items-center gap-2 rounded-lg px-3 py-2 text-sm text-fg outline-none select-none md:min-h-8 md:px-2 md:py-0 data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[highlighted]:bg-hover [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-fg-3";

/**
 * Shared shell for every popover-like surface.
 *
 * `hideWhenDetached` is on by default: if a trigger loses its layout box (or scrolls out of its
 * clipping ancestor) while the surface is still mounted for its exit animation, Floating UI's
 * `hide()` middleware switches the surface to `visibility: hidden`. Without it the surface would be
 * re-anchored to a 0×0 rect and visibly flash in the viewport corner. Callers should still keep
 * trigger boxes layout-stable — this is the backstop, not the primary defence.
 *
 * On a phone the menu rises from the bottom edge as a sheet (`.ui-floating-sheet`). Pass
 * `mobileSheet={false}` only for a menu that must stay beside its anchor, such as one tied to the caret.
 */
export function DropdownMenuContent({ className, children, sideOffset = 6, align = 'start', hideWhenDetached = true, mobileSheet = true, onCloseAutoFocus, onPointerDownCapture, onPointerDownOutside, onKeyDownCapture, onFocusCapture, ...props }: React.ComponentProps<typeof Primitive.Content> & { mobileSheet?: boolean }) {
  const keyboardInteraction = React.useRef(true);
  const focusReturn = useTypingFocusReturn();
  const shown = useClosingSnapshot(children);
  return (
    <Primitive.Portal>
      <Primitive.Content
        sideOffset={sideOffset} align={align} collisionPadding={8} hideWhenDetached={hideWhenDetached} className={cn(menuSurface, 'ui-dropdown-content max-h-[var(--radix-dropdown-menu-content-available-height)] max-w-[calc(100vw-16px)] overflow-y-auto', className, mobileSheet && 'ui-floating-sheet')}
        onPointerDownCapture={(event) => { keyboardInteraction.current = false; onPointerDownCapture?.(event); }}
        onPointerDownOutside={(event) => { keyboardInteraction.current = false; onPointerDownOutside?.(event); }}
        onKeyDownCapture={(event) => { keyboardInteraction.current = true; onKeyDownCapture?.(event); }}
        onFocusCapture={(event) => { focusReturn.capture(event); onFocusCapture?.(event); }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          focusReturn.restore(event);
          // Otherwise restore keyboard focus, but do not leave a focus ring after a pointer selection.
          if (!keyboardInteraction.current) event.preventDefault();
          keyboardInteraction.current = true;
        }}
        {...props}
      >
        {shown}
      </Primitive.Content>
    </Primitive.Portal>
  );
}

export function DropdownMenuItem({ className, variant, ...props }: React.ComponentProps<typeof Primitive.Item> & { variant?: 'danger' }) {
  return <Primitive.Item className={cn(menuItem, variant === 'danger' && 'text-danger data-[highlighted]:bg-danger-soft [&_svg:not([class*=text-])]:text-danger', className)} {...props} />;
}

export function DropdownMenuRadioItem({ className, children, ...props }: React.ComponentProps<typeof Primitive.RadioItem>) {
  return (
    <Primitive.RadioItem className={cn(menuItem, 'pr-8 md:pr-8', className)} {...props}>
      {children}
      <Primitive.ItemIndicator className="absolute right-2 flex items-center"><IconCheck className="size-4 text-fg" /></Primitive.ItemIndicator>
    </Primitive.RadioItem>
  );
}

export function DropdownMenuCheckboxItem({ className, children, ...props }: React.ComponentProps<typeof Primitive.CheckboxItem>) {
  return (
    <Primitive.CheckboxItem className={cn(menuItem, 'pr-8 md:pr-8', className)} {...props}>
      {children}
      <Primitive.ItemIndicator className="absolute right-2 flex items-center"><IconCheck className="size-4 text-fg" /></Primitive.ItemIndicator>
    </Primitive.CheckboxItem>
  );
}

export function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof Primitive.Label>) {
  return <Primitive.Label className={cn('px-2 pb-1 pt-1.5 text-xs font-medium text-fg-3', className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof Primitive.Separator>) {
  return <Primitive.Separator className={cn('-mx-1 my-1 h-px bg-line', className)} {...props} />;
}

/**
 * A submenu row (`模式 ▸`, `更多 ▸`) inside a `DropdownMenuContent`, drawn with the menu's own row
 * and surface classes. `value` is the current choice, shown dimmed before the chevron.
 */
export function MenuSub({ icon, label, value, disabled, children, className, onOpenChange }: {
  icon?: React.ReactNode;
  label: React.ReactNode;
  value?: React.ReactNode;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Primitive.Sub onOpenChange={onOpenChange}>
      <Primitive.SubTrigger disabled={disabled} className={cn(menuItem, 'data-[state=open]:bg-hover')}>
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {value && <span className="max-w-32 shrink-0 truncate text-xs text-fg-3">{value}</span>}
        <IconChevronRight className="size-3.5 text-fg-4" />
      </Primitive.SubTrigger>
      <Primitive.Portal>
        <Primitive.SubContent sideOffset={4} collisionPadding={8} className={cn(menuSurface, 'max-h-[var(--radix-dropdown-menu-content-available-height)] max-w-[calc(100vw-16px)] overflow-y-auto', className, 'ui-floating-sheet')}>
          {children}
        </Primitive.SubContent>
      </Primitive.Portal>
    </Primitive.Sub>
  );
}
