import { useEffect, useId, type ReactNode } from 'react';
import { Trans } from '@lingui/react/macro';
import { IconChevronRight } from '@/components/icons';
import { Collapse } from '@/components/ui/collapse';
import { cn } from '@/lib/utils';
import { describeFailure } from '../../../../../packages/timeline/src/failures';
import { CopyButton } from './Markdown';
import { useRemembered } from './rememberedState';

/** A readable reason stays visible; provider diagnostics are available without filling the page. */
export function FailureDetails({ text, detail, leading, className, reveal }: { text: string; detail?: string; leading?: ReactNode; className?: string; reveal?: number }) {
  const description = detail ? { message: text, detail } : describeFailure(text);
  const [open, setOpen] = useRemembered(`failure:${text}`, false);
  const id = useId();
  useEffect(() => { if (reveal !== undefined) setOpen(true); }, [reveal, setOpen]);
  return <div className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)] [overflow-wrap:anywhere]', leading && 'grid-cols-[auto_minmax(0,1fr)] gap-x-2', className)}>
    {leading && <span className="col-start-1 row-start-1 grid place-items-center">{leading}</span>}
    <div className={cn('flex min-h-6 min-w-0 items-center gap-1 no-hover:min-h-11', leading && 'col-start-2 row-start-1')}>
      <span className="min-w-0 select-text whitespace-pre-wrap">{description.message}</span>
      {description.detail && <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} className="inline-flex min-h-6 shrink-0 items-center gap-0.5 rounded-md px-1 text-xs text-fg-3 hover:bg-hover hover:text-fg no-hover:min-h-11">
          <IconChevronRight aria-hidden className={cn('size-3 transition-transform', open && 'rotate-90')} /><Trans>详情</Trans>
        </button>}
    </div>
    {description.detail && <Collapse open={open} className={leading ? 'col-start-2 row-start-2' : undefined}>
        <span id={id} className="relative mt-1 block rounded-lg bg-subtle text-xs text-fg-3">
          <span className="block max-h-48 select-text overflow-auto whitespace-pre-wrap break-words p-3 pr-10 font-mono no-hover:pr-12">{description.detail}</span>
          <CopyButton text={description.detail} className="absolute right-1 top-1 no-hover:right-0 no-hover:top-0" />
        </span>
      </Collapse>}
  </div>;
}
