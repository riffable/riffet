import type { ReactNode } from 'react';
import { IconChevronRight } from '@/components/icons';
import { cn } from '@/lib/utils';

export function SettingsRow({ title, description, children }: { title: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-3.5 max-md:flex-col max-md:items-stretch max-md:gap-2 max-md:py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium text-fg">{title}</span>
        {description && <span className="text-xs text-fg-3">{description}</span>}
      </div>
      <div className="flex shrink-0 items-center max-md:min-h-11 max-md:w-full max-md:justify-start max-md:[&_button:not([role=switch])]:min-h-11">{children}</div>
    </div>
  );
}

/** A row that opens a subpage. */
export function SettingsLinkRow({ title, onClick }: { title: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="-mx-4 flex min-h-12 items-center gap-3 px-4 text-left hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus max-md:-mx-3 max-md:px-3">
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{title}</span>
      <IconChevronRight className="size-4 shrink-0 text-fg-4" />
    </button>
  );
}

/**
 * Without a title (one that would only repeat the section's) the card starts the section. `note`
 * is the one line under the card, for what the rows cannot show: where it is saved, what it costs.
 */
export function SettingsGroup({ title, action, note, children }: { title?: string; action?: ReactNode; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col">
      {(title || action) && <div className="mb-1 flex h-7 items-center justify-between">
        {title && <h3 className="text-xs font-medium text-fg-3">{title}</h3>}
        {action}
      </div>}
      <div className="flex flex-col [&>*+*]:edge-t rounded-xl border border-line bg-elevated px-4 max-md:px-3">{children}</div>
      {note && <p className="mt-2 text-xs text-fg-3">{note}</p>}
    </section>
  );
}

/** A choice between layouts, each shown as a miniature drawn by `thumb` and named under it. */
export function SettingsThumbChoice<T extends string>({ label, value, options, onChange, thumb }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; thumb: (value: T, selected: boolean) => ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex gap-3 py-4 max-md:flex-col">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn('flex flex-1 flex-col items-center gap-2 rounded-xl text-xs outline-none focus-visible:ring-2 focus-visible:ring-focus', value === option.value ? 'font-medium text-fg' : 'text-fg-2')}
        >
          {thumb(option.value, value === option.value)}
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** The frame every layout miniature is drawn in: the workbench at 16:10, ringed when chosen. */
export const thumbFrame = (selected: boolean) => cn('flex aspect-[16/10] w-full gap-[5px] rounded-lg bg-canvas p-1.5 transition-shadow', selected ? 'shadow-[0_0_0_2px_var(--accent)]' : 'shadow-[0_0_0_1px_var(--line-strong)]');

/** The miniature's sidebar: a few rows down its left. */
export function ThumbSidebar() {
  return (
    <span className="flex w-[26%] flex-col gap-[3px] pt-1">
      {[0, 1, 2, 3].map((row) => <i key={row} className="h-[3px] rounded-sm bg-fg-4 opacity-50" />)}
    </span>
  );
}
