import type { ReactNode, SVGProps } from 'react';
import { useLingui } from '@lingui/react/macro';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { NativeBackendOption } from '@contracts';
import { Tip } from '@/components/ui/tooltip';
import { createStore, useStore } from '@/lib/store';
import { cn, readStored, writeStored } from '@/lib/utils';

export const permissionIconStyles = ['shield', 'semantic', 'gate', 'ring'] as const;
export type PermissionIconStyle = (typeof permissionIconStyles)[number];

export const permissionTiers = ['read', 'ask', 'default', 'workspace', 'auto', 'deny', 'full'] as const;
export type PermissionTier = (typeof permissionTiers)[number];

const STYLE_KEY = 'riffet.permission-icons';
const DEFAULT_STYLE: PermissionIconStyle = 'shield';

const parseStyle = (raw: string): PermissionIconStyle =>
  (permissionIconStyles as readonly string[]).includes(raw) ? (raw as PermissionIconStyle) : DEFAULT_STYLE;

const styleStore = createStore<{ style: PermissionIconStyle }>({ style: parseStyle(readStored(STYLE_KEY)) });

export function setPermissionIconStyle(style: PermissionIconStyle): void {
  writeStored(STYLE_KEY, style === DEFAULT_STYLE ? undefined : style);
  styleStore.set({ style });
}

if (typeof window !== 'undefined') {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STYLE_KEY && event.key !== null) return;
    styleStore.set({ style: parseStyle(readStored(STYLE_KEY)) });
  };
  window.addEventListener('storage', onStorage);
  import.meta.hot?.dispose(() => window.removeEventListener('storage', onStorage));
}

export function usePermissionIconStyle(): PermissionIconStyle {
  return useStore(styleStore, (state) => state.style);
}

const riskyModes = ['unrestricted', 'bypassPermissions', 'danger-full-access', 'always-proceed', 'never', 'high'];
/** Shown in the warning colour: a mode that lets everything through, or one the server marks as not working on this profile. */
const warned = (options: NativeBackendOption[], mode: string) => riskyModes.includes(mode) || options.find((option) => option.id === mode)?.tone === 'warning';

/**
 * Maps every backend's permission id onto one of 7 semantic tiers so no two choices in the same
 * agent's menu ever share a glyph (including Claude Code's 7-option list).
 */
export function permissionTierOf(mode: string): PermissionTier {
  switch (mode) {
    case 'read-only':
    case 'plan':
      return 'read';
    case 'allowlist':
    case 'manual':
    case 'off':
    case 'request-review':
      return 'ask';
    case 'default':
    case 'strict':
    case 'low':
      return 'default';
    case 'acceptEdits':
    case 'on-request':
    case 'workspace-write':
    case 'proceed-in-sandbox':
    case 'medium':
      return 'workspace';
    case 'auto-review':
    case 'auto':
      return 'auto';
    case 'dontAsk':
      return 'deny';
    case 'unrestricted':
    case 'bypassPermissions':
    case 'danger-full-access':
    case 'always-proceed':
    case 'high':
    case 'never':
      return 'full';
    default:
      return 'default';
  }
}

const SHIELD_OUTLINE = 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z';
const GATE_OPEN = 'M8.5 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20h2M15.5 4h2A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-2';

function innerGlyphs(cy: number): Record<PermissionTier, ReactNode> {
  const r = (n: number) => Math.round(n * 100) / 100;
  return {
    read: <><path d={`M8.25 ${r(cy)}Q12 ${r(cy - 3)} 15.75 ${r(cy)}Q12 ${r(cy + 3)} 8.25 ${r(cy)}Z`} /><circle cx="12" cy={r(cy)} r="0.9" fill="currentColor" stroke="none" /></>,
    ask: <><path d={`M9.85 ${r(cy - 1.5)}C9.85 ${r(cy - 2.65)} 10.75 ${r(cy - 3.3)} 11.9 ${r(cy - 3.3)}c1.15 0 2 .65 2 1.65 0 .95-.65 1.4-1.35 1.8-.4.25-.55.55-.55 1.05`} /><circle cx="12" cy={r(cy + 3.1)} r="0.8" fill="currentColor" stroke="none" /></>,
    default: <path d={`m9.1 ${r(cy)} 1.9 1.9 3.9-3.9`} />,
    workspace: <path d={`m10.3 ${r(cy - 1.9)}-1.9 1.9 1.9 1.9M13.7 ${r(cy - 1.9)}l1.9 1.9-1.9 1.9`} />,
    auto: <path d={`M12 ${r(cy - 3.6)}Q12 ${r(cy)} 15.6 ${r(cy)}Q12 ${r(cy)} 12 ${r(cy + 3.6)}Q12 ${r(cy)} 8.4 ${r(cy)}Q12 ${r(cy)} 12 ${r(cy - 3.6)}Z`} />,
    deny: <path d={`m9.8 ${r(cy - 2.2)} 4.4 4.4M14.2 ${r(cy - 2.2)}l-4.4 4.4`} />,
    full: <path d={`M12.5 ${r(cy - 3.6)} 9.6 ${r(cy + 0.2)}h4.8L11.5 ${r(cy + 3.6)}`} />,
  };
}

/** Shield tapers below y=13; its maximum inscribed circle sits above the geometric midpoint. */
const SHIELD_INNER = innerGlyphs(11.4);
const CENTER_INNER = innerGlyphs(12);

const GLYPH_PATHS: Record<PermissionIconStyle, Record<PermissionTier, ReactNode>> = {
  shield: {
    read: <><path d={SHIELD_OUTLINE} />{SHIELD_INNER.read}</>,
    ask: <><path d={SHIELD_OUTLINE} />{SHIELD_INNER.ask}</>,
    default: <><path d={SHIELD_OUTLINE} />{SHIELD_INNER.default}</>,
    workspace: <><path d={SHIELD_OUTLINE} />{SHIELD_INNER.workspace}</>,
    auto: <><path d={SHIELD_OUTLINE} />{SHIELD_INNER.auto}</>,
    deny: <><path d={SHIELD_OUTLINE} />{SHIELD_INNER.deny}</>,
    full: <><path d={SHIELD_OUTLINE} />{SHIELD_INNER.full}</>,
  },
  semantic: {
    read: <><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" /><circle cx="12" cy="12" r="3" /></>,
    ask: <><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />{CENTER_INNER.ask}</>,
    default: <><path d={SHIELD_OUTLINE} />{SHIELD_INNER.default}</>,
    workspace: <path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12" />,
    auto: <><path d="M12 3Q12 12 21 12Q12 12 12 21Q12 12 3 12Q12 12 12 3Z" /><path d="M19 4v3M17.5 5.5h3" /></>,
    deny: <><circle cx="12" cy="12" r="9" /><path d="m5.64 5.64 12.72 12.72" /></>,
    full: <path d="M13 3 5 13.5h6.5L11 21l8-10.5h-6.5L13 3Z" />,
  },
  gate: {
    read: <><rect x="4" y="4" width="16" height="16" rx="3.5" />{CENTER_INNER.read}</>,
    ask: <><path d={GATE_OPEN} />{CENTER_INNER.ask}</>,
    default: <><rect x="4" y="4" width="16" height="16" rx="3.5" />{CENTER_INNER.default}</>,
    workspace: <><rect x="4" y="4" width="16" height="16" rx="3.5" />{CENTER_INNER.workspace}</>,
    auto: <><path d={GATE_OPEN} />{CENTER_INNER.auto}</>,
    deny: <><rect x="4" y="4" width="16" height="16" rx="3.5" />{CENTER_INNER.deny}</>,
    full: <><path d={GATE_OPEN} />{CENTER_INNER.full}</>,
  },
  ring: {
    read: <><circle cx="12" cy="12" r="9" />{CENTER_INNER.read}</>,
    ask: <><circle cx="12" cy="12" r="9" />{CENTER_INNER.ask}</>,
    default: <><circle cx="12" cy="12" r="9" />{CENTER_INNER.default}</>,
    workspace: <><circle cx="12" cy="12" r="9" />{CENTER_INNER.workspace}</>,
    auto: <><circle cx="12" cy="12" r="9" strokeDasharray="3.5 2.5" />{CENTER_INNER.auto}</>,
    deny: <><circle cx="12" cy="12" r="9" />{CENTER_INNER.deny}</>,
    full: <><circle cx="12" cy="12" r="9" />{CENTER_INNER.full}</>,
  },
};

export function PermissionGlyph({ tier, iconStyle, className, ...props }: SVGProps<SVGSVGElement> & { tier: PermissionTier; iconStyle?: PermissionIconStyle }) {
  const activeStyle = usePermissionIconStyle();
  const resolved = iconStyle ?? activeStyle;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn('lucide shrink-0', className)}
      {...props}
    >
      {GLYPH_PATHS[resolved][tier]}
    </svg>
  );
}

export function PermissionIcon({ mode, iconStyle, className, ...props }: SVGProps<SVGSVGElement> & { mode: string; iconStyle?: PermissionIconStyle }) {
  return <PermissionGlyph tier={permissionTierOf(mode)} iconStyle={iconStyle} className={className} {...props} />;
}

/** The toolbar's name for a mode: the backend's short one where its label would crowd the row. */
export function approvalShortLabel(options: NativeBackendOption[], mode: string) {
  const option = options.find((item) => item.id === mode);
  return option ? option.shortLabel ?? option.label : mode;
}

/** The mode's glyph ahead of the mobile settings summary. */
export function ApprovalSummary({ mode, options }: { mode: string; options: NativeBackendOption[] }) {
  if (!mode) return null;
  const label = approvalShortLabel(options, mode);
  return (
    <PermissionIcon
      mode={mode}
      aria-label={label}
      className={cn('size-3.5 shrink-0', warned(options, mode) && 'text-warning')}
    />
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
  /** Show only the mode's icon on the composer toolbar; the full name moves to the tooltip. */
  compact?: boolean;
  className?: string;
}) {
  const { t } = useLingui();
  const option = options.find((mode) => mode.id === value);
  const current = option ?? { id: value, label: value === 'custom' ? t`自定义` : value || t`权限模式` };
  const name = (compact && option?.shortLabel) || current.label;
  const risky = warned(options, current.id);
  // A mode that will not work here says why without opening the menu.
  const caution = option?.tone === 'warning' ? option.description : undefined;
  const tip = caution ? <span className="flex flex-col gap-0.5"><span>{t`权限模式：${current.label}`}</span><span>{caution}</span></span> : t`权限模式：${current.label}`;
  const trigger = (
    <DropdownMenuTrigger
      aria-label={t`权限模式：${current.label}`}
      disabled={disabled || !options.length}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 disabled:hover:bg-transparent aria-expanded:bg-hover aria-expanded:text-fg',
        compact
          ? 'grid size-11 place-items-center rounded-md md:size-7'
          : size === 'xs'
            ? 'h-11 min-w-0 rounded-lg px-2 text-xs font-medium md:h-6'
            : 'h-11 min-w-0 rounded-full px-2.5 text-sm md:h-7',
        risky && 'text-warning hover:text-warning aria-expanded:text-warning',
        className,
      )}
    >
      <PermissionIcon mode={current.id} className={compact ? 'size-[18px]' : 'size-3.5'} />
      {/* Capped only where the control sits inline with text; the composer row uses the icon alone,
          and the mobile settings sheet gives it a full line of its own. */}
      {!compact && <span className="min-w-0 truncate md:max-w-44">{name}</span>}
    </DropdownMenuTrigger>
  );
  return (
    <DropdownMenu>
      <Tip label={tip} disabled={!caution && !compact && name === current.label}>{trigger}</Tip>
      <DropdownMenuContent side={side} align={size === 'xs' ? 'end' : 'start'} className="max-h-[min(60dvh,420px)] w-[min(22rem,calc(100vw-24px))] overflow-y-auto">
        {note && <div className="px-2 pb-1 pt-1.5 text-xs text-fg-3">{note}</div>}
        <DropdownMenuLabel>{t`权限模式`}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={current.id} onValueChange={onChange}>
          {options.map((mode) => {
            const modeRisky = warned(options, mode.id);
            return (
              <Tip key={mode.id} label={mode.description} side="right">
                <DropdownMenuRadioItem value={mode.id} textValue={mode.label} className="h-auto items-start gap-2.5 py-2.5 md:py-2.5">
                  <PermissionIcon mode={mode.id} className={cn('mt-0.5 size-4', modeRisky ? 'text-warning' : 'text-fg-3')} />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className={cn('break-words font-medium leading-snug', modeRisky && 'text-warning')}>{mode.label}</span>
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
