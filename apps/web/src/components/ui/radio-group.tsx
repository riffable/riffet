import * as React from 'react';
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

export interface RadioOption<T extends string> {
  value: T;
  label: React.ReactNode;
  /** One line under the label. */
  description?: React.ReactNode;
  /** Sits at the row's trailing edge, outside the selectable label (a value, an action button). */
  trailing?: React.ReactNode;
  disabled?: boolean;
}

/** A vertical list of 3 or more options where exactly one applies and the choices need reading. */
export function RadioGroup<T extends string>({ value, onValueChange, options, ariaLabel, disabled, busy, className }: {
  value: T;
  onValueChange: (value: T) => void;
  options: Array<RadioOption<T>>;
  ariaLabel: string;
  disabled?: boolean;
  /** A change is saving: announced, and the caller ignores changes; the group stays focusable. */
  busy?: boolean;
  className?: string;
}) {
  const id = React.useId();
  return (
    <RadioGroupPrimitive.Root value={value} onValueChange={next => onValueChange(next as T)} aria-label={ariaLabel} aria-busy={busy || undefined} disabled={disabled} className={cn('flex flex-col', className)}>
      {options.map(option => {
        const itemId = `${id}-${option.value}`;
        return (
          <div key={option.value} className="flex min-h-9 items-center gap-3 no-hover:min-h-11">
            <label htmlFor={itemId} className={cn('flex min-w-0 flex-1 items-start gap-3 py-1', (disabled || option.disabled) && 'opacity-50')}>
              <RadioGroupPrimitive.Item
                id={itemId}
                value={option.value}
                disabled={option.disabled}
                className="group/radio mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-line-strong bg-elevated outline-none transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)] hover:border-fg-4 focus-visible:ring-2 focus-visible:ring-focus data-[state=checked]:border-primary data-[state=checked]:bg-primary"
              >
                <RadioGroupPrimitive.Indicator className="size-1.5 rounded-full bg-primary-fg" />
              </RadioGroupPrimitive.Item>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm text-fg">{option.label}</span>
                {option.description && <span className="text-xs text-fg-3">{option.description}</span>}
              </span>
            </label>
            {option.trailing}
          </div>
        );
      })}
    </RadioGroupPrimitive.Root>
  );
}
