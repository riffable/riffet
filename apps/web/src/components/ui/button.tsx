import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import { cn } from '@/lib/utils';

export const buttonVariants = cva(
    "ui-button inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-[color,background-color,scale] duration-[var(--duration-fast)] ease-[var(--ease-standard)] outline-none active:scale-[0.97] select-none focus-visible:ring-2 focus-visible:ring-focus disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-fg hover:bg-primary-hover',
        /** Kept for the plugin SDK's `ButtonProps`; accent colour is reserved for focus, selection and links, so it draws as primary. */
        accent: 'bg-primary text-primary-fg hover:bg-primary-hover',
        secondary: 'bg-fg/[0.07] text-fg hover:bg-fg/[0.11] data-[state=open]:bg-fg/[0.11]',
        ghost: 'text-fg-2 hover:bg-hover hover:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg',
        quiet: 'text-fg-3 hover:bg-hover hover:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg',
        danger: 'bg-danger/[0.12] text-danger hover:bg-danger/[0.18]',
        'danger-ghost': 'text-danger hover:bg-danger/[0.1]',
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
