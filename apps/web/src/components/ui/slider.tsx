import * as React from 'react';
import { Slider as SliderPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

/**
 * One value on a continuous or stepped range. Show the current value beside it as text;
 * the slider itself carries no number.
 */
export function Slider({ value, onValueChange, onValueCommit, className, 'aria-label': ariaLabel, ...props }: Omit<React.ComponentProps<typeof SliderPrimitive.Root>, 'value' | 'defaultValue' | 'onValueChange' | 'onValueCommit'> & {
  value: number;
  onValueChange: (value: number) => void;
  onValueCommit?: (value: number) => void;
  'aria-label': string;
}) {
  return (
    <SliderPrimitive.Root
      value={[value]}
      onValueChange={([next]) => { if (next !== undefined) onValueChange(next); }}
      {...(onValueCommit ? { onValueCommit: ([next]: number[]) => { if (next !== undefined) onValueCommit(next); } } : {})}
      className={cn('relative flex h-5 w-full touch-none select-none items-center no-hover:h-11', className)}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1 grow overflow-hidden rounded-full bg-fg/[0.16]">
        <SliderPrimitive.Range className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb aria-label={ariaLabel} className="block size-4 rounded-full bg-primary shadow-soft outline-none transition-[box-shadow] hover:shadow-pop focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:opacity-50" />
    </SliderPrimitive.Root>
  );
}
