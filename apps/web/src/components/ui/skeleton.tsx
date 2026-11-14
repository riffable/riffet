import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A block placeholder as tall and wide as the content that replaces it, so nothing moves when data
 * arrives. Size and radius come from `className`. The sheen stops under reduced motion (index.css).
 */
export function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return <div aria-hidden className={cn('ui-skeleton', className)} {...props} />;
}
