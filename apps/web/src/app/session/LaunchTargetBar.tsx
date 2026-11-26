import { useLingui } from '@lingui/react/macro';
import type { LaunchTarget, NativeBackendCatalogEntry, NativeBackendId } from '@contracts';
import { ApprovalPicker } from './ApprovalPicker';
import { ModePicker } from './Composer';
import { ModelPicker } from './ModelPicker';
import { useAgentModelChoice, type AgentModelValue } from './agentModelChoice';

/** One launch's backend, profile, model, mode and approval, as the editors hold it. */
export interface LaunchTargetShape { backendId?: NativeBackendId; profileId?: string; model?: string; mode?: string; approval?: string }

export const launchTargetOf = (shape: LaunchTargetShape): LaunchTarget => ({
  ...(shape.backendId ? { backendId: shape.backendId } : {}),
  ...(shape.profileId ? { backendProfileId: shape.profileId } : {}),
  ...(shape.model ? { model: shape.model } : {}),
  ...(shape.mode ? { mode: shape.mode } : {}),
  ...(shape.approval ? { approval: shape.approval } : {}),
});

/**
 * One launch target as a row of the composer's own pickers: the unified Agent / Provider / Model
 * picker (via `useAgentModelChoice`), plus mode and approval when supported.
 * `showBackend` is off where the backend is picked elsewhere (the handoff's cards); `showMode`
 * is off there too — a handoff continues work already under way, so only model and approval differ.
 */
export function LaunchTargetBar({ value, onChange, backends, projectId, disabled, showBackend = true, showMode = true }: {
  value: LaunchTargetShape;
  onChange: (patch: Partial<LaunchTargetShape>) => void;
  backends: NativeBackendCatalogEntry[];
  projectId: string;
  disabled?: boolean;
  showBackend?: boolean;
  showMode?: boolean;
}) {
  const { t } = useLingui();
  const choice: AgentModelValue | undefined = value.backendId
    ? { backendId: value.backendId, ...(value.profileId ? { profileId: value.profileId } : {}), ...(value.model ? { model: value.model } : {}) }
    : undefined;
  const { picker, pick, params, withParam, capabilities } = useAgentModelChoice({
    projectId,
    backends,
    choice,
    agents: showBackend,
    allowDefault: true,
  });
  if (!value.backendId) return null;
  const modes = capabilities?.modes ?? [];
  const permissions = capabilities?.permissions ?? [];
  const applyChoice = (next: AgentModelValue | undefined) => {
    if (!next) return;
    const switched = next.backendId !== value.backendId;
    onChange({
      backendId: next.backendId,
      profileId: next.profileId,
      model: next.model,
      ...(switched ? { mode: undefined, approval: undefined } : {}),
    });
  };
  return (
    <>
      <ModelPicker
        side="bottom"
        align="start"
        placeholder={t`默认模型`}
        disabled={disabled}
        {...picker}
        params={params}
        onChange={(id) => applyChoice(pick(id))}
        onParamChange={(id, next) => applyChoice(withParam(id, next))}
      />
      {showMode && capabilities?.supportsModeSelection && modes.length > 0 && (
        <ModePicker modes={modes} value={value.mode ?? modes.find((mode) => mode.id === 'agent')?.id ?? modes[0]?.id} disabled={disabled} onChange={(id) => onChange({ mode: id })} />
      )}
      {capabilities?.supportsPermissionSelection && permissions.length > 0 && (
        <ApprovalPicker side="bottom" options={permissions} value={value.approval ?? permissions[0]?.id ?? ''} disabled={disabled} onChange={(id) => onChange({ approval: id })} />
      )}
    </>
  );
}
