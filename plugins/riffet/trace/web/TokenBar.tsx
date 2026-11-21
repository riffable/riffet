import { cn } from './cn';
import type { Tokens } from './model';
import { TOKEN_COLOR } from './palette';

/** The series of a token stack, in reading order: what was read from cache, read fresh, cached, then written. */
export const TOKEN_SERIES = ['cacheRead', 'input', 'cacheWrite', 'output'] as const;
export type TokenSeries = (typeof TOKEN_SERIES)[number];

/** Tokens as one stacked bar, so how much of a request was served from cache reads at a glance. */
export function TokenBar({ tokens, className }: { tokens: Pick<Tokens, TokenSeries>; className?: string }) {
  const total = TOKEN_SERIES.reduce((sum, key) => sum + tokens[key], 0);
  if (total <= 0) return null;
  return (
    <span className={cn('flex overflow-hidden rounded-full bg-line-soft', className)} aria-hidden>
      {TOKEN_SERIES.map((key) => tokens[key] > 0 && (
        <span key={key} className="h-full shrink-0 transition-[width] duration-[var(--duration-medium)] ease-[var(--ease-standard)]" style={{ width: `${(tokens[key] / total) * 100}%`, background: TOKEN_COLOR[key] }} />
      ))}
    </span>
  );
}
