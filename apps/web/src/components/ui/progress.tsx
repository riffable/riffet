import { cn } from '@/lib/utils';

/** `neutral` for a figure that is only read, not a state: the context a conversation has used. */
export type ProgressTone = 'accent' | 'neutral' | 'success' | 'warning' | 'danger';
const FILL: Record<ProgressTone, string> = { accent: 'bg-primary', neutral: 'bg-fg-3', success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger' };

/**
 * A determinate bar (docs/design/system/components/feedback.md「Progress」): how much of something is done, or how much of a bound is left. `value`
 * is 0–1. `role` is `progressbar` for work under way (a download) and `meter` for a bounded amount (memory, a quota).
 */
export function Progress({ value, label, tone = 'accent', role = 'progressbar', className }: { value: number; label: string; tone?: ProgressTone; role?: 'progressbar' | 'meter'; className?: string }) {
  const share = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  return (
    <span className={cn('block h-1.5 overflow-hidden rounded-full bg-muted', className)} role={role} aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
      <span className={cn('block h-full rounded-full transition-[width] duration-[var(--duration-medium)] ease-[var(--ease-out-soft)]', FILL[tone])} style={{ width: `${share * 100}%` }} />
    </span>
  );
}
