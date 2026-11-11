import { useLingui } from '@lingui/react/macro';
import { IconShieldCheck, IconShieldHalf, IconZap } from '@/components/icons';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { NativeBackendOption } from '@contracts';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const modeIcons: Record<string, typeof IconShieldCheck> = { allowlist: IconShieldCheck, 'auto-review': IconShieldHalf, unrestricted: IconZap, bypassPermissions: IconZap, 'danger-full-access': IconZap, auto: IconShieldHalf };

/** The mode as a glyph, for places too narrow for its name; Run Everything is tinted as a warning. */
export function ApprovalIcon({ mode, className, label }: { mode: string; className?: string; label?: string }) {
  const Icon = modeIcons[mode] ?? IconShieldCheck;
  return <Icon aria-label={label ?? mode} className={cn('size-3.5 shrink-0', ['unrestricted', 'bypassPermissions', 'danger-full-access'].includes(mode) && 'text-warning', className)} />;
}

/**
 * Chooses how the CLI approves tool calls. Used both when a conversation is created (below the
 * composer) and inside a native conversation, where switching restarts the CLI with the flag —
 * hence the note, and hence the same control in both places.
 */
export function ApprovalPicker({ value, onChange, disabled, size = 'sm', side = 'top', note, iconOnly, className, options }: {
  value: string;
  onChange: (value: string) => void;
  /** The backend's own `capabilities.permissions`, in its words. */
  options: NativeBackendOption[];
  disabled?: boolean;
  /** `xs` matches the backend switch on the start page, `sm` the composer's model picker. */
  size?: 'xs' | 'sm';
  side?: 'top' | 'bottom';
  note?: string;
  /** Show only the mode's icon; the name moves to the tooltip. */
  iconOnly?: boolean;
  className?: string;
}) {
  const { t } = useLingui();
  const current = options.find((mode) => mode.id === value) ?? { id: value, label: value === 'custom' ? t`自定义` : value || t`权限模式` };
  const Icon = modeIcons[current.id] ?? IconShieldCheck;
  const trigger = (
    <DropdownMenuTrigger
      aria-label={iconOnly ? t`权限模式：${current.label}` : t`权限模式`}
      disabled={disabled || !options.length}
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 disabled:hover:bg-transparent data-[state=open]:bg-hover data-[state=open]:text-fg [&_svg]:size-3.5 [&_svg]:shrink-0',
        iconOnly
          ? 'size-11 justify-center rounded-md md:size-7 [&_svg]:size-4'
          : size === 'xs' ? 'h-11 rounded-lg px-2 text-xs font-medium md:h-6' : 'h-11 rounded-full px-2.5 text-sm md:h-7',
        iconOnly && current.id === 'unrestricted' && 'text-warning hover:text-warning',
        className,
      )}
    >
      <Icon />
      {/* Capped only where the control sits inline on a composer row; the mobile settings sheet
          gives it a full line of its own and should show the whole name. */}
      {!iconOnly && <span className="min-w-0 truncate md:max-w-44">{current.label}</span>}
    </DropdownMenuTrigger>
  );
  return (
    <DropdownMenu>
      {iconOnly ? <Tip label={t`权限模式：${current.label}`}>{trigger}</Tip> : trigger}
      <DropdownMenuContent side={side} align={size === 'xs' ? 'end' : 'start'} className="max-h-[min(60dvh,420px)] w-[min(22rem,calc(100vw-24px))] overflow-y-auto">
        {note && <div className="px-2 pb-1 pt-1.5 text-xs text-fg-3">{note}</div>}
        <DropdownMenuLabel>{t`权限模式`}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={current.id} onValueChange={onChange}>
          {options.map((mode) => {
            const ModeIcon = modeIcons[mode.id] ?? IconShieldCheck;
            return (
              <Tip key={mode.id} label={mode.description} side="right">
                <DropdownMenuRadioItem value={mode.id} textValue={mode.label} className="h-auto items-start gap-2 py-2.5 md:py-2.5">
                  <ModeIcon className="mt-0.5 size-4 text-fg-3" />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="break-words font-medium leading-snug">{mode.label}</span>
                    {mode.description && <span className="truncate text-xs leading-normal text-fg-3">{mode.description}</span>}
                  </span>
                </DropdownMenuRadioItem>
              </Tip>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
