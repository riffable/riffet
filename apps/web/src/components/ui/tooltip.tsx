import { useRef, useState, type ReactNode } from 'react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';

export const TooltipProvider = TooltipPrimitive.Provider;

/** Whether the browser draws a focus ring for `element`, i.e. the focus came from the keyboard. */
function focusVisible(element: Element): boolean {
  try { return element.matches(':focus-visible'); } catch { return true; }
}

export function Tip({ label, kbd, side = 'bottom', children, disabled }: { label: ReactNode; kbd?: string | undefined; side?: 'top' | 'bottom' | 'left' | 'right'; children: ReactNode; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  /**
   * Radix opens on any focus it did not see a press for, a script's included: a page that hands
   * focus to its first button after a click would pop that button's tooltip, and the next Escape
   * would close the tooltip instead of the page. A focus opens it only with a focus ring.
   */
  const quietFocus = useRef(false);
  if (disabled || !label) {
    // The root unmounts here; an open left behind would show the tip unasked when it comes back.
    if (open) setOpen(false);
    return <>{children}</>;
  }
  return (
    <TooltipPrimitive.Root open={open} onOpenChange={(next) => { if (!next || !quietFocus.current) setOpen(next); quietFocus.current = false; }}>
      <TooltipPrimitive.Trigger
        asChild
        onFocus={(event) => {
          // Runs just before Radix's own focus handler, which decides synchronously.
          quietFocus.current = !focusVisible(event.currentTarget);
          queueMicrotask(() => { quietFocus.current = false; });
        }}
      >
        {children}
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          // A tooltip whose trigger is hidden (hover-revealed rows) or scrolled out of view would
          // otherwise be re-anchored to a 0×0 rect and flash in the viewport corner while it fades out.
          hideWhenDetached
          className="ui-floating-content z-(--z-tooltip) flex max-w-72 items-center gap-2 rounded-md bg-toast px-2 py-1 text-xs text-white shadow-pop origin-(--radix-popper-transform-origin) animate-in fill-mode-both fade-in-0 zoom-in-[var(--enter-scale)] duration-[var(--duration-fast)] ease-[var(--ease-decelerate)] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[var(--enter-scale)] data-[state=closed]:duration-[var(--duration-exit-fast)] data-[state=closed]:ease-[var(--ease-accelerate)]"
        >
          <span>{label}</span>
          {kbd && <span className="rounded bg-white/15 px-1 font-sans text-2xs text-white/80">{kbd}</span>}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
