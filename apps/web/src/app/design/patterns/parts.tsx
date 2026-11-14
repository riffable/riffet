import type { ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { cn } from '@/lib/utils';
import { Frame } from '../specimen';

/** A line of placeholder text in a wireframe. */
export function Bar({ w = 60, className }: { w?: number; className?: string }) {
  return <span className={cn('block h-1.5 rounded-full bg-fg/[0.12]', className)} style={{ width: `${w}%` }} />;
}

/** A small annotation set in the figure's margin. */
export function Mark({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono text-2xs text-fg-3', className)}>{children}</span>;
}

/** A rule drawn twice: the way it is written and the way it is avoided, side by side. */
export function Pair({ good, bad, goodNote, badNote }: { good: ReactNode; bad: ReactNode; goodNote?: ReactNode; badNote?: ReactNode }) {
  const { t } = useLingui();
  const cell = (tag: string, tone: string, body: ReactNode, note?: ReactNode) => (
    <div className="flex min-w-0 flex-col gap-3">
      <span className={cn('text-xs font-medium', tone)}>{tag}</span>
      <div className="flex min-h-16 flex-col items-start justify-center gap-2 rounded-xl bg-bg p-4 shadow-[0_0_0_1px_var(--line)]">{body}</div>
      {note && <span className="text-xs text-fg-3">{note}</span>}
    </div>
  );
  return (
    <Frame className="grid grid-cols-2 gap-6 p-8 max-md:grid-cols-1 max-md:p-4">
      {cell(t`写法`, 'text-fg', good, goodNote)}
      {cell(t`避免`, 'text-fg-3', bad, badNote)}
    </Frame>
  );
}

/** A page's window, drawn at the proportions of a 1440 window's main area. */
export function Sketch({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('relative flex aspect-[1176/760] w-full flex-col overflow-hidden rounded-md bg-bg shadow-[0_0_0_1px_var(--line-strong)]', className)}>{children}</div>;
}

/** The header strip of a sketch, 52 of 760 tall. */
export function SketchHeader({ title = 22 }: { title?: number }) {
  return (
    <div className="flex shrink-0 items-center gap-[2%] px-[2%] edge-b" style={{ height: `${(52 / 760) * 100}%` }}>
      <span className="size-2 rounded-sm bg-fg/[0.12]" />
      <Bar w={title} />
    </div>
  );
}
