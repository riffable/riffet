import type { ReactNode } from 'react';
import { AgentMark } from '@/components/agent-marks';
import { IconArrowUp, IconAtSign, IconChevronRight, IconFile, IconPlus, IconSlash, IconSquare } from '@/components/icons';
import { ApprovalPicker } from '@/app/session/ApprovalPicker';
import { menuSurface } from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/controls';
import { cn } from '@/lib/utils';
import type { NativeBackendOption } from '@contracts';

export type ComposerShape = 'dock' | 'hero' | 'compact' | 'embedded';

/** The four ways the card is drawn: the textarea's floor, the toolbar's presence and the surface. */
const TEXT: Record<ComposerShape, string> = {
  dock: 'min-h-[52px] pt-3.5 pb-1',
  hero: 'min-h-[76px] pt-4 pb-1',
  compact: 'min-h-[44px] min-w-0 flex-1 py-2.5',
  embedded: 'min-h-[52px] pt-3.5 pb-1',
};

const MODES: NativeBackendOption[] = [
  { id: 'default', label: 'Ask before changes', shortLabel: 'Ask' },
  { id: 'acceptEdits', label: 'Accept edits', shortLabel: 'Edits' },
];

/** The model button as the toolbar draws it: mark, name, effort. */
export function ModelPill({ agent = 'claude', label, className }: { agent?: string; label: string; className?: string }) {
  return (
    <span className={cn('inline-flex h-7 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-sm text-fg-3', className)}>
      <AgentMark backend={agent} size={14} className="shrink-0" />
      <span className="max-w-44 truncate">{label}</span>
    </span>
  );
}

/**
 * The composer as drawn at rest, from `Composer.tsx`'s own classes: the card, the textarea floor,
 * the toolbar row. The toolbar's permission control is the real `ApprovalPicker`; the rest is
 * static, so nothing here needs a draft store, a model catalogue or a session.
 */
export function ComposerCard({ shape = 'dock', placeholder, model = 'Opus 5.5 · high', agent, draft, className, running = false, rail }: {
  shape?: ComposerShape;
  placeholder: string;
  model?: string;
  agent?: string;
  /** Text typed so far; replaces the placeholder. */
  draft?: string;
  className?: string;
  running?: boolean;
  /** Attachment chips above the textarea. */
  rail?: ReactNode;
}) {
  const compact = shape === 'compact';
  const send = running
    ? <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-primary-fg"><IconSquare className="size-3 fill-current" /></span>
    : <span className={cn('grid size-8 shrink-0 place-items-center rounded-full', draft ? 'bg-primary text-primary-fg' : 'bg-fg/[0.08] text-fg-4')}><IconArrowUp className="size-4" strokeWidth={2.4} /></span>;
  return (
    <div className={cn(
      'relative flex bg-elevated',
      shape === 'embedded' ? 'rounded-xl border border-line bg-subtle' : 'rounded-2xl shadow-composer',
      compact ? 'flex-row items-center' : 'flex-col',
      className,
    )}>
      {rail}
      <div className={cn('w-full px-4 text-base leading-6', draft ? 'text-fg' : 'text-fg-4', TEXT[shape])}>{draft ?? placeholder}</div>
      {compact
        ? running && <div className="flex shrink-0 items-center py-0.5 pr-1">{send}</div>
        : (
          <div className="flex flex-wrap items-center gap-1 px-2 pb-2 pt-1 md:flex-nowrap">
            <span className="grid size-7 shrink-0 place-items-center rounded-md text-fg-3"><IconPlus className="size-[18px]" /></span>
            <ApprovalPicker value="default" options={MODES} onChange={() => undefined} compact size="sm" side="bottom" />
            <div className="ml-auto flex min-w-0 items-center gap-1">
              <ModelPill label={model} {...(agent ? { agent } : {})} />
              {send}
            </div>
          </div>
        )}
    </div>
  );
}

/** A chip in the attachment rail: a file waiting to be sent, with its state. */
export function AttachmentChip({ name, state }: { name: string; state?: 'uploading' }) {
  return (
    <span className="inline-flex h-8 max-w-full items-center gap-2 rounded-lg bg-muted pl-2 pr-3 text-xs text-fg-2">
      {state === 'uploading' ? <Spinner className="size-3.5" /> : <IconFile className="size-3.5 shrink-0 text-fg-3" />}
      <span className="min-w-0 truncate">{name}</span>
    </span>
  );
}

interface MenuRow { icon?: ReactNode; name: string; hint?: string; active?: boolean }

/** The menu a `/` or `@` opens above the card: a header row, then a scrolling list. */
export function TriggerMenu({ kind, heading, rows, className }: { kind: 'slash' | 'mention'; heading: string; rows: MenuRow[]; className?: string }) {
  return (
    <div className={cn(menuSurface, 'static animate-none p-0', className)}>
      <div className="flex h-8 items-center gap-1.5 edge-b px-3 text-xs text-fg-3">
        {kind === 'slash' ? <IconSlash className="size-3" /> : <IconAtSign className="size-3" />}
        {heading}
      </div>
      <div className="flex max-h-64 flex-col overflow-y-auto p-1">
        {rows.map((row) => (
          <span key={row.name} className={cn('flex min-h-8 w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left text-sm', row.active && 'bg-hover')}>
            {row.icon}
            <span className="shrink-0 font-mono text-xs text-fg">{row.name}</span>
            {row.hint && <span className="min-w-0 flex-1 truncate text-xs text-fg-3">{row.hint}</span>}
            {kind === 'mention' && row.active && <IconChevronRight className="ml-auto size-3.5 text-fg-4" />}
          </span>
        ))}
      </div>
    </div>
  );
}
