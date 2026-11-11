import * as React from 'react';
import { Switch as SwitchPrimitive } from 'radix-ui';
import { IconChevronDown, IconLoaderCircle } from '@/components/icons';
import { cn } from '@/lib/utils';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from './dropdown-menu';

export const fieldClass = 'w-full min-w-0 rounded-lg border border-line-strong bg-elevated px-2.5 text-sm text-fg outline-none transition-[border-color,box-shadow] placeholder:text-fg-4 hover:border-fg-4/60 focus:border-accent focus:ring-3 focus:ring-accent/15 disabled:opacity-50';

export function Input({ className, ...props }: React.ComponentProps<'input'>) {
  return <input className={cn(fieldClass, 'h-8 no-hover:min-h-11', className)} {...props} />;
}

/** Native select with the same field styling as Input and a consistently inset chevron. */
export function Select({ className, wrapperClassName, children, ...props }: React.ComponentProps<'select'> & { wrapperClassName?: string }) {
  return (
    <div className={cn('relative w-full min-w-0', wrapperClassName)}>
      <select className={cn(fieldClass, 'h-8 appearance-none pr-9 max-md:h-11 max-md:rounded-xl max-md:px-3 max-md:pr-10 max-md:text-base', className)} {...props}>
        {children}
      </select>
      <IconChevronDown aria-hidden className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-fg-3" />
    </div>
  );
}

/** A field-sized choice using the app's menu surface, including rich option previews. */
export function ChoiceMenu<T extends string>({ id, label, value, options, onChange, disabled, className }: {
  id?: string;
  label: string;
  value: T;
  options: Array<{ value: T; label: string; icon?: React.ReactNode }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  const valueId = React.useId();
  const selected = options.find(option => option.value === value);
  return <DropdownMenu>
    <DropdownMenuTrigger
      id={id} aria-label={label} aria-describedby={valueId} disabled={disabled}
      className={cn(fieldClass, 'flex h-8 items-center gap-2 text-left max-md:h-11 max-md:rounded-xl max-md:px-3 max-md:text-base data-[state=open]:border-accent data-[state=open]:ring-3 data-[state=open]:ring-accent/15', className)}
    >
      {selected?.icon}
      <span id={valueId} className="min-w-0 flex-1 truncate">{selected?.label ?? value}</span>
      <IconChevronDown aria-hidden className="size-3.5 shrink-0 text-fg-3" />
    </DropdownMenuTrigger>
    <DropdownMenuContent className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-32">
      <DropdownMenuRadioGroup value={value} onValueChange={next => onChange(next as T)}>
        {options.map(option => <DropdownMenuRadioItem key={option.value} value={option.value} textValue={option.label}>
          {option.icon}<span className="min-w-0 truncate">{option.label}</span>
        </DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}

export function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return <textarea className={cn(fieldClass, 'min-h-20 resize-y py-2 leading-5', className)} {...props} />;
}

export function Field({ label, hint, children, className }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <span className="text-sm font-medium text-fg">{label}</span>
      {children}
      {hint && <span className="text-xs text-fg-3">{hint}</span>}
    </label>
  );
}

export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn('group/switch inline-flex h-[18px] w-8 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-45 no-hover:size-11', className)}
      {...props}
    >
      <span className="inline-flex h-[18px] w-8 shrink-0 items-center rounded-full bg-line-strong p-0.5 transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)] group-data-[state=checked]/switch:bg-accent">
        <SwitchPrimitive.Thumb className="block size-3.5 rounded-full bg-white shadow-xs transition-[translate,background-color] duration-[var(--duration-fast)] ease-[var(--ease-standard)] data-[state=checked]:translate-x-3.5 data-[state=checked]:bg-accent-fg" />
      </span>
    </SwitchPrimitive.Root>
  );
}

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return <kbd className={cn('inline-flex h-5 min-w-5 items-center justify-center rounded-sm bg-muted px-1 font-sans text-2xs font-medium text-fg-3', className)}>{children}</kbd>;
}

export function Spinner({ className }: { className?: string }) {
  return <IconLoaderCircle aria-hidden className={cn('ui-spinner size-3.5 animate-spin text-fg-3', className)} />;
}

export interface SegmentOption<T extends string> { value: T; label: React.ReactNode; icon?: React.ReactNode; disabled?: boolean; }

/** Top-level view tabs: plain labels with an underline, so nested `Segmented` controls read as a sub-level. */
export function UnderlineTabs<T extends string>({ value, options, onChange, className, ariaLabel }: { value: T; options: SegmentOption<T>[]; onChange: (value: T) => void; className?: string; ariaLabel?: string }) {
  return (
    <div role="tablist" aria-label={ariaLabel} className={cn('flex h-full min-w-0 items-stretch gap-1', className)}>
      {options.map((option) => (
        <button
          key={option.value}
          role="tab"
          type="button"
          aria-selected={value === option.value}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            'relative inline-flex items-center gap-1.5 whitespace-nowrap px-2 text-sm font-medium text-fg-3 outline-none transition-colors hover:text-fg focus-visible:text-fg disabled:opacity-40 max-md:px-3 max-md:text-base [&_svg]:size-3.5',
            'after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-transparent after:transition-colors max-md:after:inset-x-3',
            value === option.value && 'text-fg after:bg-fg',
          )}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}


export function Segmented<T extends string>({ value, options, onChange, size = 'sm', className, ariaLabel }: { value: T; options: SegmentOption<T>[]; onChange: (value: T) => void; size?: 'xs' | 'sm'; className?: string; ariaLabel?: string }) {
  return (
    <div role="tablist" aria-label={ariaLabel} className={cn('inline-flex w-fit min-w-0 max-w-full items-center gap-1 overflow-x-auto scrollbar-none rounded-lg bg-muted p-0.5 no-hover:min-h-12', className)}>
      {options.map((option) => (
        <button
          key={option.value}
          role="tab"
          type="button"
          aria-selected={value === option.value}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            // Each label keeps its own width and padding; narrow tracks scroll instead of
            // squeezing the longest label into an equal-width segment.
            'inline-flex flex-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium text-fg-3 transition-colors hover:text-fg disabled:opacity-40 no-hover:min-h-11 no-hover:min-w-11 [&_svg]:size-3.5',
            size === 'xs' ? 'h-6 px-2 text-xs' : 'h-7 px-2.5 text-sm',
            // Ring only — a downward drop shadow bleeds past the track's 2px padding
            // and makes the active pill look glued to the bottom edge.
            value === option.value && 'bg-elevated text-fg shadow-[0_0_0_0.5px_var(--line-strong)]',
          )}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** `ring` is the hollow variant, so two states that differ only by hue still differ by shape. */
export function StatusDot({ tone, pulse, shape = 'dot', label, className }: { tone: 'success' | 'warning' | 'danger' | 'accent' | 'idle'; pulse?: boolean; shape?: 'dot' | 'ring'; label?: string; className?: string }) {
  const color = shape === 'ring'
    ? { success: 'border-success', warning: 'border-warning', danger: 'border-danger', accent: 'border-accent', idle: 'border-fg-4' }[tone]
    : { success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger', accent: 'bg-accent', idle: 'bg-fg-4' }[tone];
  return (
    <span
      {...(label ? { role: 'img', 'aria-label': label, title: label } : { 'aria-hidden': true })}
      className={cn('inline-block size-1.5 shrink-0 rounded-full', shape === 'ring' && 'border-[1.5px]', color, pulse && 'animate-pulse-dot', className)}
    />
  );
}

type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
const badgeClass = 'inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-2xs font-medium [&_svg]:size-3';
const badgeTones: Record<BadgeTone, string> = {
  neutral: 'bg-muted text-fg-2',
  accent: 'bg-accent-soft text-accent',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
};

export function Badge({ children, tone = 'neutral', className, title }: { children: React.ReactNode; tone?: BadgeTone; className?: string; title?: string }) {
  return <span title={title} className={cn(badgeClass, badgeTones[tone], className)}>{children}</span>;
}

/**
 * False where a status pill sits inside another control (the phone header's title button), so it
 * stays a plain badge instead of nesting one button in another; the action is then reached from
 * that control's own sheet.
 */
export const StatusPillActions = React.createContext(true);

/**
 * A status whose remedy is one safe action. Hovering or focusing it says the action and a click
 * runs it; a touch screen has no hover to find that by, so there it reads as the action from the
 * start. Both labels share one grid cell, so the pill keeps the wider one's width as they swap.
 */
export function StatusPill({ tone = 'neutral', label, actionLabel, onAction, disabled, busy, title, className }: {
  tone?: BadgeTone;
  label: string;
  actionLabel: string;
  onAction: () => void;
  disabled?: boolean;
  /** The action is under way: still focusable, so keyboard focus is not dropped while it runs. */
  busy?: boolean;
  /** The detail behind the status, e.g. the error a retry would clear. */
  title?: string;
  className?: string;
}) {
  const actions = React.useContext(StatusPillActions);
  if (!actions) return <Badge tone={tone} title={title} className={className}>{busy && <Spinner className="size-3 text-current" />}{label}</Badge>;
  const actionable = !disabled && !busy;
  return (
    // The status is spoken before the button, so a live region around the pill announces what
    // happened and not only what can be done about it.
    <span className="inline-flex shrink-0">
      <span className="sr-only">{label}</span>
      <button
        type="button"
        onClick={() => { if (actionable) onAction(); }}
        disabled={disabled && !busy}
        aria-disabled={busy || undefined}
        aria-busy={busy || undefined}
        aria-label={actionLabel}
        aria-description={title}
        title={title}
        className={cn(badgeClass, badgeTones[tone], 'group/pill outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60 aria-disabled:opacity-60', className)}
      >
        {busy && <Spinner className="size-3 text-current" />}
        <span aria-hidden className="grid">
          <span className={cn('col-start-1 row-start-1 transition-opacity', actionable && 'can-hover:group-hover/pill:opacity-0 group-focus-visible/pill:opacity-0 no-hover:opacity-0')}>{label}</span>
          <span className={cn('col-start-1 row-start-1 opacity-0 transition-opacity', actionable && 'can-hover:group-hover/pill:opacity-100 group-focus-visible/pill:opacity-100 no-hover:opacity-100')}>{actionLabel}</span>
        </span>
      </button>
    </span>
  );
}

export function EmptyState({ icon, title, description, children, className }: { icon?: React.ReactNode; title: React.ReactNode; description?: React.ReactNode; children?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 px-6 py-10 text-center', className)}>
      {icon && <div className="grid size-10 place-items-center rounded-xl bg-muted text-fg-3 [&_svg]:size-5">{icon}</div>}
      <div className="flex max-w-sm flex-col gap-1">
        <p className="text-base font-medium text-fg">{title}</p>
        {description && <p className="text-sm text-fg-3">{description}</p>}
      </div>
      {children}
    </div>
  );
}
