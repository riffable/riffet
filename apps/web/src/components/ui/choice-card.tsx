import * as React from 'react';
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

export interface ChoiceCardOption<T extends string> {
  value: T;
  label: React.ReactNode;
  /** One line under the label: the state or the difference, not the name again. */
  description?: React.ReactNode;
  /** The tile at the leading edge: an icon or a mark. */
  tile?: React.ReactNode;
  disabled?: boolean;
}

/**
 * Cards to pick one of, each a tile, a name with a line under it and a radio mark; the chosen card
 * has a strong outline. For a decision a whole page is about (the first-launch guide), where the
 * options carry a mark worth seeing; settings use `RadioGroup`.
 */
export function ChoiceCards<T extends string>({ value, onValueChange, options, ariaLabel, className }: {
  value: T;
  onValueChange: (value: T) => void;
  options: Array<ChoiceCardOption<T>>;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <RadioGroupPrimitive.Root value={value} onValueChange={next => onValueChange(next as T)} aria-label={ariaLabel} className={cn('flex flex-col gap-2', className)}>
      {options.map(option => (
        <RadioGroupPrimitive.Item
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          className="group/choice flex min-h-16 w-full items-center gap-3 rounded-xl py-2 pl-3 pr-4 text-left outline-none ring-1 ring-line transition-[background-color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-standard)] ring-inset hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus disabled:pointer-events-none disabled:opacity-50 data-[state=checked]:ring-[1.5px] data-[state=checked]:ring-accent"
        >
          {option.tile && <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-subtle text-fg-2">{option.tile}</span>}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium text-fg">{option.label}</span>
            {option.description && <span className="truncate text-xs text-fg-3">{option.description}</span>}
          </span>
          <span aria-hidden className="grid size-4 shrink-0 place-items-center rounded-full border border-fg-4 transition-colors duration-[var(--duration-fast)] group-data-[state=checked]/choice:border-primary">
            <span className="size-2 scale-0 rounded-full bg-primary transition-transform duration-[var(--duration-fast)] ease-[var(--ease-decelerate)] group-data-[state=checked]/choice:scale-100" />
          </span>
        </RadioGroupPrimitive.Item>
      ))}
    </RadioGroupPrimitive.Root>
  );
}
