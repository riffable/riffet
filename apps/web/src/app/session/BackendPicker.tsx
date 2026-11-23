import { useLingui } from '@lingui/react/macro';
import type { NativeBackendCatalogEntry, NativeBackendId } from '@contracts';
import { AgentLogo } from '@/components/AgentLogo';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { agentMarkStyle, useBackendLabel } from '@/lib/backends';
import { cn } from '@/lib/utils';

/**
 * The agent a new session will run. Which provider it draws models from is a property of the
 * model, not of the agent, so it is chosen in the model picker and only named there.
 */
export function BackendPicker({ backends, backendId, disabled, onChange, onOpen, className, fullWidth }: {
  backends: NativeBackendCatalogEntry[];
  backendId: NativeBackendId;
  disabled?: boolean;
  onChange: (backendId: NativeBackendId) => void;
  onOpen?: () => void;
  className?: string;
  /** Fills its row in the mobile settings sheet instead of hugging its label. */
  fullWidth?: boolean;
}) {
  const { t } = useLingui();
  const label = useBackendLabel();
  return (
    <DropdownMenu onOpenChange={(open) => { if (open) onOpen?.(); }}>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={t`选择 Agent`}
        className={cn(
          'inline-flex h-7 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-sm text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 disabled:hover:bg-transparent data-[state=open]:bg-hover data-[state=open]:text-fg',
          fullWidth && 'h-11 w-full rounded-xl border border-line-strong bg-bg px-3 text-base',
          className,
        )}
      >
        <AgentLogo backend={backendId} size={14} className="shrink-0" style={agentMarkStyle(backendId)} />
        <span className={cn('truncate', !fullWidth && 'max-w-28 sm:max-w-40')}>{label(backendId)}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuRadioGroup value={backendId} onValueChange={(value) => onChange(value as NativeBackendId)}>
          {backends.map((entry) => (
            <DropdownMenuRadioItem key={entry.backendId} value={entry.backendId}>
              <AgentLogo backend={entry.backendId} size={14} className="size-3.5" style={agentMarkStyle(entry.backendId)} />
              <span className="flex min-w-0 flex-col py-1">
                <span>{label(entry.backendId)}</span>
                {!entry.available && entry.reason && <span className="text-xs text-fg-3">{entry.reason}</span>}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
