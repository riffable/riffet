import { useLingui } from '@lingui/react/macro';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { NativeBackendOption } from '@contracts';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * A mode is said in words, as the agents' own CLIs say it: no glyph reads as "an automatic reviewer
 * decides" or "asks first" without a guess. Only running everything is marked, by colour, and
 * only on the trigger: the menu's descriptions already say what each mode allows.
 */
const riskyModes = ['unrestricted', 'bypassPermissions', 'danger-full-access', 'never', 'high'];

/** The toolbar's name for a mode: the backend's short one where its label would crowd the row. */
export function approvalShortLabel(options: NativeBackendOption[], mode: string) {
  const option = options.find((item) => item.id === mode);
  return option ? option.shortLabel ?? option.label : mode;
}

/** The mode's short name ahead of the mobile settings summary, with the summary's own separator. */
export function ApprovalSummary({ mode, options }: { mode: string; options: NativeBackendOption[] }) {
  if (!mode) return null;
  return (
    <>
      <span className={cn('shrink-0', riskyModes.includes(mode) && 'text-warning')}>{approvalShortLabel(options, mode)}</span>
      <span aria-hidden className="shrink-0 text-fg-4">·</span>
    </>
  );
}

/**
 * Chooses how the CLI approves tool calls. Used both when a conversation is created (below the
 * composer) and inside a native conversation, where switching restarts the CLI with the flag —
 * hence the note, and hence the same control in both places.
 */
export function ApprovalPicker({ value, onChange, disabled, size = 'sm', side = 'top', note, compact, className, options }: {
  value: string;
  onChange: (value: string) => void;
  /** The backend's own `capabilities.permissions`, in its words. */
  options: NativeBackendOption[];
  disabled?: boolean;
  /** `xs` matches the backend switch on the start page, `sm` the composer's model picker. */
  size?: 'xs' | 'sm';
  side?: 'top' | 'bottom';
  note?: string;
  /** Show the short name, for a composer row; the full one moves to the tooltip. */
  compact?: boolean;
  className?: string;
}) {
  const { t } = useLingui();
  const option = options.find((mode) => mode.id === value);
  const current = option ?? { id: value, label: value === 'custom' ? t`自定义` : value || t`权限模式` };
  const name = (compact && option?.shortLabel) || current.label;
  const risky = riskyModes.includes(current.id);
  const trigger = (
    <DropdownMenuTrigger
      aria-label={t`权限模式：${current.label}`}
      disabled={disabled || !options.length}
      className={cn(
        'inline-flex min-w-0 items-center text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 disabled:hover:bg-transparent aria-expanded:bg-hover aria-expanded:text-fg',
        size === 'xs' ? 'h-11 rounded-lg px-2 text-xs font-medium md:h-6' : 'h-11 rounded-full px-2.5 text-sm md:h-7',
        risky && 'text-warning hover:text-warning aria-expanded:text-warning',
        className,
      )}
    >
      {/* Capped only where the control sits inline on a composer row; the mobile settings sheet
          gives it a full line of its own and should show the whole name. */}
      <span className="min-w-0 truncate md:max-w-44">{name}</span>
    </DropdownMenuTrigger>
  );
  return (
    <DropdownMenu>
      <Tip label={t`权限模式：${current.label}`} disabled={name === current.label}>{trigger}</Tip>
      <DropdownMenuContent side={side} align={size === 'xs' ? 'end' : 'start'} className="max-h-[min(60dvh,420px)] w-[min(22rem,calc(100vw-24px))] overflow-y-auto">
        {note && <div className="px-2 pb-1 pt-1.5 text-xs text-fg-3">{note}</div>}
        <DropdownMenuLabel>{t`权限模式`}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={current.id} onValueChange={onChange}>
          {options.map((mode) => (
            <Tip key={mode.id} label={mode.description} side="right">
              <DropdownMenuRadioItem value={mode.id} textValue={mode.label} className="h-auto items-start py-2.5 md:py-2.5">
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="break-words font-medium leading-snug">{mode.label}</span>
                  {mode.description && <span className="truncate text-xs leading-normal text-fg-3">{mode.description}</span>}
                </span>
              </DropdownMenuRadioItem>
            </Tip>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
