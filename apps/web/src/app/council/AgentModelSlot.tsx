import { useLingui } from '@lingui/react/macro';
import type { CouncilModelRef, NativeBackendCatalogEntry } from '@contracts';
import { Button } from '@/components/ui/button';
import { IconX } from '@/components/icons';
import { ModelPicker } from '../session/ModelPicker';
import { useAgentModelChoice } from '../session/agentModelChoice';

export function workerBackendsOf(backends: readonly NativeBackendCatalogEntry[]): NativeBackendCatalogEntry[] {
  return backends.filter((b) => b.backendId !== 'chat' && b.available !== false);
}

/**
 * Reuses Riffet's exact 3-column Agent -> Provider -> Model picker (`ModelPicker` + `useAgentModelChoice`)
 * across all available agents and providers.
 */
export function AgentModelSlot({
  backends,
  value,
  onChange,
  onRemove,
  badge,
  side = 'bottom',
  align = 'start',
}: {
  backends: readonly NativeBackendCatalogEntry[];
  value: CouncilModelRef | undefined;
  onChange: (next: CouncilModelRef) => void;
  onRemove?: () => void;
  badge?: string;
  side?: 'top' | 'bottom';
  align?: 'start' | 'end';
}) {
  const { t } = useLingui();
  const { picker, pick } = useAgentModelChoice({
    projectId: '',
    backends,
    choice: value ? { backendId: value.backendId, ...(value.profileId ? { profileId: value.profileId } : {}), model: value.model } : undefined,
    agents: true,
  });

  return (
    <div className="inline-flex max-w-full items-center gap-1 rounded-lg border border-line bg-subtle/60 px-1.5 py-0.5">
      {badge && (
        <span className="shrink-0 rounded-sm bg-bg px-1.5 py-0.5 text-2xs font-medium text-fg-3">
          {badge}
        </span>
      )}
      <ModelPicker
        {...picker}
        placeholder={t`选择模型`}
        side={side}
        align={align}
        className="h-6.5 max-w-48 px-1.5 text-xs"
        onChange={(id) => {
          const picked = pick(id);
          if (!picked) return;
          const model = (picked.model ?? '').replace(/\[[^\]]*\]$/u, '').trim()
            || backends.find((b) => b.backendId === picked.backendId)?.defaultModel
            || '';
          onChange({
            backendId: picked.backendId,
            ...(picked.profileId ? { profileId: picked.profileId } : {}),
            model,
          });
        }}
      />
      {onRemove && (
        <Button
          size="icon-xs"
          variant="quiet"
          aria-label={t`移除`}
          onClick={onRemove}
          className="size-5 text-fg-3 hover:text-fg"
        >
          <IconX className="size-3" />
        </Button>
      )}
    </div>
  );
}
