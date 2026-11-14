import * as React from 'react';
import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import { IconCheck, IconMinus } from '@/components/icons';
import { cn } from '@/lib/utils';

/**
 * A boolean that takes effect with the form's confirm, or one of several selections.
 * Drawn 16 square; the hit area grows to 44 on touch. `checked="indeterminate"` marks a select-all
 * over a partly selected set. Pair with a `<label>` around it, or give it an `aria-label`.
 */
export function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn('group/checkbox inline-flex size-4 shrink-0 items-center justify-center outline-none disabled:opacity-50 no-hover:size-11', className)}
      {...props}
    >
      <span className="flex size-4 items-center justify-center rounded-xs border border-line-strong bg-elevated text-primary-fg transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)] group-hover/checkbox:border-fg-4 group-focus-visible/checkbox:ring-2 group-focus-visible/checkbox:ring-focus group-data-[state=checked]/checkbox:border-primary group-data-[state=checked]/checkbox:bg-primary group-data-[state=indeterminate]/checkbox:border-primary group-data-[state=indeterminate]/checkbox:bg-primary">
        <CheckboxPrimitive.Indicator>
          {props.checked === 'indeterminate' ? <IconMinus aria-hidden className="size-3" /> : <IconCheck aria-hidden className="size-3" />}
        </CheckboxPrimitive.Indicator>
      </span>
    </CheckboxPrimitive.Root>
  );
}
