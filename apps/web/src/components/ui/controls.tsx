import * as React from 'react';
import { Switch as SwitchPrimitive } from 'radix-ui';
import { IconChevronDown, IconLoaderCircle } from '@/components/icons';
import { cn } from '@/lib/utils';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from './dropdown-menu';

export const fieldClass = 'w-full min-w-0 rounded-lg border border-line-strong bg-elevated px-2.5 text-sm text-fg outline-none transition-[border-color,box-shadow] placeholder:text-fg-4 hover:border-fg-4/60 focus:border-accent focus:ring-3 focus:ring-accent/15 disabled:opacity-50';

export function Input({ className, ...props }: React.ComponentProps<'input'>) {
  return <input className={cn(fieldClass, 'h-8 no-hover:min-h-11', className)} {...props} />;
}

/** A field-sized select using the app's menu surface, including rich option previews. */
export function Select<T extends string>({ id, name, label, value, options, onChange, disabled, placeholder, appearance = 'field', className }: {
  id?: string;
  /** Renders a hidden input so the value is included in a surrounding form's FormData. */
  name?: string;
  label: string;
  value: T;
  options: Array<{ value: T; label: string; icon?: React.ReactNode; disabled?: boolean }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  /** Shown when `value` matches no option. */
  placeholder?: string;
  /**
   * `heading` titles the sections after it and switches what they configure (which Agent, which
   * project): borderless, set at heading size. `field` is a form value.
   */
  appearance?: 'field' | 'heading';
  className?: string;
}) {
  const valueId = React.useId();
  const selected = options.find(option => option.value === value);
  return <>
    {name !== undefined && <input type="hidden" name={name} value={value} />}
    <DropdownMenu>
    <DropdownMenuTrigger
      id={id} aria-label={label} aria-describedby={valueId} disabled={disabled}
      className={cn(
        appearance === 'heading'
          ? '-mx-2 inline-flex h-9 min-w-0 max-w-full items-center gap-2 rounded-lg px-2 text-left text-base font-medium text-fg outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 data-[state=open]:bg-hover max-md:h-11 [&_svg:not([class*=size-])]:size-4'
          : cn(fieldClass, 'flex h-8 items-center gap-2 text-left max-md:h-11 max-md:rounded-xl max-md:px-3 max-md:text-base data-[state=open]:border-accent data-[state=open]:ring-3 data-[state=open]:ring-accent/15'),
        className,
      )}
    >
      {selected?.icon}
      <span id={valueId} className={cn('min-w-0 truncate', appearance === 'field' && 'flex-1', !selected && 'text-fg-4')}>{selected ? selected.label : placeholder ?? value}</span>
      <IconChevronDown aria-hidden className={cn('shrink-0 text-fg-3', appearance === 'heading' ? 'size-4' : 'size-3.5')} />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className={cn(appearance === 'field' && 'w-[var(--radix-dropdown-menu-trigger-width)]', 'min-w-32', appearance === 'heading' && 'min-w-52')}>
      <DropdownMenuRadioGroup value={value} onValueChange={next => onChange(next as T)}>
        {options.map(option => <DropdownMenuRadioItem key={option.value} value={option.value} textValue={option.label} disabled={option.disabled}>
          {option.icon}<span className="min-w-0 truncate">{option.label}</span>
        </DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
    </DropdownMenu>
  </>;
}

export function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return <textarea className={cn(fieldClass, 'min-h-20 resize-y py-2 leading-5', className)} {...props} />;
}

export function Field({ label, hint, error, children, className }: { label: React.ReactNode; hint?: React.ReactNode; /** A failed validation, shown under the control and announced. */ error?: React.ReactNode; children: React.ReactNode; className?: string }) {
  const errorId = React.useId();
  const invalid = error !== undefined && error !== null && error !== false && error !== '';
  // A single control gets the error wired to it; a composite child (a fragment) is left as is.
  const control = invalid && React.isValidElement<Record<string, unknown>>(children) && children.type !== React.Fragment
    ? React.cloneElement(children, { 'aria-invalid': true, 'aria-describedby': [children.props['aria-describedby'], errorId].filter(Boolean).join(' ') })
    : children;
  // The label wraps only its text and the control: an error inside it would join the control's
  // name and be read twice, once more through aria-describedby.
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label className="flex min-w-0 flex-col gap-1.5">
        <span className="text-sm font-medium text-fg">{label}</span>
        {control}
      </label>
      {invalid ? <p id={errorId} role="alert" className="text-xs text-danger">{error}</p> : hint && <p className="text-xs text-fg-3">{hint}</p>}
    </div>
  );
}

export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn('group/switch inline-flex h-[18px] w-8 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 no-hover:size-11', className)}
      {...props}
    >
      <span className="inline-flex h-[18px] w-8 shrink-0 items-center rounded-full bg-fg/[0.16] p-0.5 transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)] group-data-[state=checked]/switch:bg-primary">
        <SwitchPrimitive.Thumb className="block size-3.5 rounded-full bg-white shadow-soft transition-[translate,background-color] duration-[var(--duration-fast)] ease-[var(--ease-standard)] data-[state=checked]:translate-x-3.5 data-[state=checked]:bg-primary-fg" />
      </span>
    </SwitchPrimitive.Root>
  );
}

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return <kbd className={cn('inline-flex h-5 min-w-5 items-center justify-center rounded-sm bg-muted px-1 font-sans text-2xs font-medium text-fg-3', className)}>{children}</kbd>;
}

// motion-loop: in-progress spinner; a global reduced-motion rule in index.css swaps the rotation for a slow fade
export function Spinner({ className }: { className?: string }) {
  return <IconLoaderCircle aria-hidden className={cn('ui-spinner size-3.5 animate-spin text-fg-3', className)} />;
}

export interface SegmentOption<T extends string> {
  value: T; label: React.ReactNode; icon?: React.ReactNode; disabled?: boolean;
  /** `UnderlineTabs` only: the id of the panel this tab shows, set as `aria-controls`. */
  panelId?: string;
}

/**
 * Arrow Left/Right/Home/End move focus among the enabled options of a tablist or radiogroup; Enter,
 * Space or a click selects (APG's manual activation). Selection does not follow focus because many
 * callers persist or navigate on change, and a busy caller disables its options, which would drop
 * focus mid-way. Only the selected option is in the Tab order.
 */
export function useRoving<T extends string>(options: Array<Pick<SegmentOption<T>, 'value' | 'disabled'>>, value: T) {
  const group = React.useRef<HTMLDivElement>(null);
  const hasSelected = options.some(option => option.value === value && !option.disabled);
  const firstEnabled = options.find(option => !option.disabled)?.value;
  const tabIndexOf = (option: SegmentOption<T>) => (hasSelected ? option.value === value : option.value === firstEnabled) ? 0 : -1;
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const enabled = options.map((option, index) => ({ option, index })).filter(entry => !entry.option.disabled);
    if (enabled.length === 0 || event.altKey || event.ctrlKey || event.metaKey) return;
    const buttons = [...(group.current?.querySelectorAll<HTMLElement>('button') ?? [])];
    // From the focused option, so a group with nothing selected still steps one at a time.
    const focused = buttons.indexOf(document.activeElement as HTMLElement);
    const current = enabled.findIndex(entry => entry.index === focused);
    let next: number;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % enabled.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = current < 0 ? enabled.length - 1 : (current - 1 + enabled.length) % enabled.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = enabled.length - 1;
    else return;
    event.preventDefault();
    buttons[enabled[next]!.index]?.focus();
  };
  return { group, tabIndexOf, onKeyDown };
}

/** Top-level view tabs: plain labels with an underline, so nested `Segmented` controls read as a sub-level. */
export function UnderlineTabs<T extends string>({ value, options, onChange, className, ariaLabel, scrollable = false }: { value: T; options: SegmentOption<T>[]; onChange: (value: T) => void; className?: string; ariaLabel?: string; scrollable?: boolean }) {
  const roving = useRoving(options, value);
  // Only scroll this strip; scrollIntoView would also move the surrounding settings form.
  const reveal = React.useCallback((tab: HTMLElement | null) => {
    const strip = roving.group.current;
    if (!scrollable || !strip || !tab) return;
    const bounds = strip.getBoundingClientRect();
    const item = tab.getBoundingClientRect();
    if (item.left < bounds.left) strip.scrollLeft += item.left - bounds.left;
    else if (item.right > bounds.right) strip.scrollLeft += item.right - bounds.right;
  }, [scrollable, roving.group]);
  const keys = options.map(option => option.value).join('\u0000');
  React.useLayoutEffect(() => {
    const strip = roving.group.current;
    if (!scrollable || !strip) return;
    const showSelected = () => reveal(strip.querySelector<HTMLElement>('[aria-selected="true"]'));
    showSelected();
    const resize = new ResizeObserver(showSelected);
    resize.observe(strip);
    for (const child of strip.children) resize.observe(child);
    return () => resize.disconnect();
  }, [value, keys, scrollable, reveal, roving.group]);
  return (
    <div ref={roving.group} role="tablist" aria-label={ariaLabel} onKeyDown={roving.onKeyDown}
      onFocusCapture={(event) => reveal((event.target as HTMLElement).closest<HTMLElement>('[role="tab"]'))}
      className={cn('flex h-full min-w-0 items-stretch gap-1', scrollable && 'max-w-full overflow-x-auto', className)}>
      {options.map((option) => (
        <button
          key={option.value}
          role="tab"
          type="button"
          aria-selected={value === option.value}
          aria-controls={option.panelId}
          tabIndex={roving.tabIndexOf(option)}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            'relative inline-flex items-center gap-1.5 whitespace-nowrap px-2 text-sm font-medium text-fg-3 outline-none transition-colors hover:text-fg focus-visible:text-fg focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus disabled:opacity-50 max-md:px-3 max-md:text-base [&_svg]:size-3.5',
            scrollable && 'shrink-0',
            'after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-transparent after:transition-colors max-md:after:inset-x-3',
            value === option.value && 'text-fg after:bg-primary',
          )}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}


/**
 * One choice among a few. The selection is a single thumb that slides from the old segment to the
 * new one (foundations §8: a state changes in place), so a choice reads as one object moving.
 */
export function Segmented<T extends string>({ value, options, onChange, size = 'sm', className, ariaLabel }: { value: T; options: SegmentOption<T>[]; onChange: (value: T) => void; size?: 'xs' | 'sm'; className?: string; ariaLabel?: string }) {
  const roving = useRoving(options, value);
  const track = roving.group;
  const thumb = React.useRef<HTMLSpanElement>(null);
  const keys = options.map(option => option.value).join('\u0000');
  // Puts the thumb over the selected segment; `instant` skips the slide (first paint, a resize).
  const place = React.useCallback((instant: boolean) => {
    const pill = thumb.current;
    const active = track.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    if (!pill) return;
    pill.style.visibility = active ? '' : 'hidden';
    if (!active) return;
    if (instant) pill.style.transition = 'none';
    pill.style.width = `${active.offsetWidth}px`;
    pill.style.height = `${active.offsetHeight}px`;
    pill.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
    if (instant) { void pill.offsetWidth; pill.style.transition = ''; }
  }, []);
  const placed = React.useRef(false);
  React.useLayoutEffect(() => { place(!placed.current); placed.current = true; }, [value, keys, place]);
  React.useEffect(() => {
    const element = track.current;
    if (!element) return;
    const observer = new ResizeObserver(() => place(true));
    // The segments only: the thumb resizes during its own slide, and reacting to that would cut the slide short.
    for (const child of element.children) if (child !== thumb.current) observer.observe(child);
    return () => observer.disconnect();
  }, [keys, place]);
  return (
    <div
      ref={track}
      role="radiogroup" aria-label={ariaLabel} onKeyDown={roving.onKeyDown}
      className={cn('relative inline-flex w-fit min-w-0 max-w-full items-center overflow-x-auto scrollbar-none rounded-lg bg-muted p-0.5 shadow-[inset_0_0_0_0.5px_var(--line)]', className)}
    >
      <span
        ref={thumb}
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 rounded-md bg-accent-soft transition-[transform,width] duration-[var(--duration-base)] ease-[var(--ease-standard)]"
      />
      {options.map((option) => (
        <button
          key={option.value}
          role="radio"
          type="button"
          aria-checked={value === option.value}
          tabIndex={roving.tabIndexOf(option)}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            // Each label keeps its own width and padding; narrow tracks scroll instead of
            // squeezing the longest label into an equal-width segment.
            'relative inline-flex flex-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium text-fg-3 outline-none transition-colors duration-[var(--duration-base)] ease-[var(--ease-standard)] hover:text-fg-2 focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 no-hover:min-h-11 no-hover:min-w-11 [&_svg]:size-3.5',
            size === 'xs' ? 'h-6 px-2.5 text-xs' : 'h-7 px-3 text-sm',
            value === option.value && 'text-fg hover:text-fg',
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
  // motion-loop: `pulse` marks a live status (running, recording, reconnecting) and a session waiting on the user, whose ring pulses to ask for attention
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
        className={cn(badgeClass, badgeTones[tone], 'group/pill outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 aria-disabled:opacity-50', className)}
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
