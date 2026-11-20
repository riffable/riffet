import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function useRovingIndex(length: number) {
  const [index, setIndex] = useState(-1);
  const safe = index < 0 || length <= 0 ? -1 : Math.min(index, length - 1);
  const onKeyDown = (event: KeyboardEvent) => {
    if (!length) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      setIndex((current) => Math.min(length - 1, (current < 0 ? -1 : current) + 1));
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      setIndex((current) => Math.max(-1, (current < 0 ? 0 : current) - 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setIndex(length - 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setIndex(-1);
    }
  };
  return { index: safe, setIndex, onKeyDown };
}

export function ChartCard({ title, actions, children, className }: { title: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('flex h-full min-w-0 flex-col gap-3 rounded-xl border border-line bg-elevated p-4 max-md:p-3.5', className)}>
      <div className="flex min-h-6 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 className="text-sm font-medium leading-5 text-fg">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}
