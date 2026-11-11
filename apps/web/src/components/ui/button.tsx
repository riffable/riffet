import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import { cn } from '@/lib/utils';

export const buttonVariants = cva(
    "ui-button inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-colors outline-none select-none focus-visible:ring-2 focus-visible:ring-focus disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-fg hover:bg-primary-hover',
        accent: 'bg-accent text-accent-fg hover:bg-accent-hover',
        secondary: 'border border-line-strong bg-elevated text-fg shadow-xs hover:bg-subtle data-[state=open]:bg-subtle',
        ghost: 'text-fg-2 hover:bg-hover hover:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg',
        quiet: 'text-fg-3 hover:bg-hover hover:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg',
        danger: 'bg-danger text-danger-fg hover:bg-danger/90',
        'danger-ghost': 'text-danger hover:bg-danger-soft',
        link: 'h-auto px-0 text-accent hover:underline underline-offset-4',
      },
      size: {
        xs: "h-6 rounded-md px-2 text-xs [&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-7 rounded-lg px-2.5 text-sm [&_svg:not([class*='size-'])]:size-3.5",
        md: 'h-8 rounded-lg px-3 text-sm',
        lg: 'h-9 rounded-lg px-4 text-base',
        'icon-xs': "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3.5",
        'icon-sm': 'size-7 rounded-lg',
        icon: 'size-8 rounded-lg',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps extends React.ComponentProps<'button'>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  return <Comp type={asChild ? undefined : type ?? 'button'} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
