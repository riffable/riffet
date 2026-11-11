import type { ReactNode } from 'react';
import { IconCircleAlert, IconInfo, IconTriangleAlert } from '@/components/icons';
import { cn } from '@/lib/utils';

/**
 * A standing notice beside a page — a degraded backend, an unconfirmed send, a stale history.
 *
 * This used to be pasted at every call site with its own hand-picked border and tint opacity, which
 * is how the same warning ended up drawn three slightly different ways. One component now owns the
 * shape, and the tint is the boundary: no frame, no divider.
 */
const tones = {
  warning: { surface: 'bg-warning/10', icon: 'text-warning' },
  danger: { surface: 'bg-danger/10', icon: 'text-danger' },
  accent: { surface: 'bg-accent/10', icon: 'text-accent' },
  neutral: { surface: 'bg-subtle', icon: 'text-fg-3' },
} as const;

export function Notice({ tone = 'neutral', icon, action, children, className, role }: {
  tone?: keyof typeof tones;
  /** Pass `null` for copy that carries its own meaning, or a glyph to override the tone's default. */
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  role?: 'status' | 'alert';
}) {
  const Glyph = tone === 'warning' ? IconTriangleAlert : tone === 'danger' ? IconCircleAlert : IconInfo;
  const glyph = icon === undefined ? <Glyph className={cn('size-4 shrink-0', tones[tone].icon)} /> : icon;
  return (
    <div role={role ?? (tone === 'danger' ? 'alert' : 'status')} className={cn('flex items-start gap-2.5 rounded-xl px-3.5 py-2.5 text-sm text-fg-2', tones[tone].surface, className)}>
      {glyph}
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}
