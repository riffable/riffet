import { useLingui } from '@lingui/react/macro';
import type { AppSettings, CouncilAgent, NativeBackendCatalogEntry } from '@contracts';
import { useSettings } from '../state/stores';
import { useAgentModelChoice } from '../session/agentModelChoice';
import { ModelPicker } from '../session/ModelPicker';

/** What a seat can run on: the Agents a new conversation could start on, and quick chat's models. */
export const seatAgents = (catalog: readonly NativeBackendCatalogEntry[]) =>
  catalog.filter((entry) => entry.available !== false && entry.profiles.length > 0);

/** The profile a seat runs on when only its Agent was picked. */
export const defaultProfile = (entry: NativeBackendCatalogEntry) => entry.profiles.find((profile) => profile.isDefault)?.id ?? entry.profiles[0]!.id;

type SeatDefaults = Pick<AppSettings, 'nativeBackendDefaults' | 'auxiliaryModels'>;

/**
 * What a new conversation on the Agent would start on, named so the seat shows it: the provider and model last picked
 * for it in the composer, else the provider's own default; quick chat's model is the one set for quick chat. A model
 * left unnamed is one the Agent picks itself from its own configuration.
 */
export function startingAgent(entry: NativeBackendCatalogEntry, settings: SeatDefaults, profileId?: string): CouncilAgent {
  const fallback = defaultProfile(entry);
  if (entry.backendId === 'chat') {
    const chat = settings.auxiliaryModels?.chat;
    return { backendId: 'chat', profileId: fallback, ...(chat ? { model: `${chat.backendId}:${chat.profileId}:${chat.model}` } : {}) };
  }
  const saved = settings.nativeBackendDefaults?.[entry.backendId];
  const known = (id: string | undefined) => (id && entry.profiles.some((profile) => profile.id === id) ? id : undefined);
  const preferred = known(saved?.profileId) ?? fallback;
  const profile = known(profileId) ?? preferred;
  const model = saved?.profileModels?.[profile] || (profile === preferred ? saved?.model : undefined) || (profile === fallback ? entry.defaultModel : undefined);
  return { backendId: entry.backendId, profileId: profile, ...(model ? { model } : {}) };
}

const STAGE = {
  lg: { trigger: 'h-auto max-w-full rounded-lg px-2 py-0.5 text-lg font-semibold text-fg', label: 'max-w-56 sm:max-w-56' },
  md: { trigger: 'h-auto max-w-full rounded-lg px-2 py-0.5 text-base font-semibold text-fg', label: 'max-w-40 sm:max-w-40' },
} as const;

/**
 * A seat's Agent, provider and model, picked with the composer's Agent → Provider → Model menu. On the launch stage
 * the model's name is the seat's heading and the Agent's mark stands on its own tile, so the trigger drops it.
 */
export function SeatPicker({ backends, value, disabled, stage, onChange }: {
  backends: readonly NativeBackendCatalogEntry[];
  value: CouncilAgent | undefined;
  disabled?: boolean;
  stage?: keyof typeof STAGE;
  onChange: (next: CouncilAgent) => void;
}) {
  const { t } = useLingui();
  const nativeBackendDefaults = useSettings((settings) => settings.nativeBackendDefaults);
  const auxiliaryModels = useSettings((settings) => settings.auxiliaryModels);
  const { picker, pick } = useAgentModelChoice({ projectId: '', backends, choice: value, agents: true, quickChat: true });
  return (
    <ModelPicker
      side="bottom"
      align="start"
      placeholder={value ? t`默认模型` : t`选择模型`}
      {...picker}
      className={stage ? STAGE[stage].trigger : 'h-7 max-w-64 px-2 text-sm'}
      {...(stage ? { leading: null, labelClassName: STAGE[stage].label } : {})}
      disabled={disabled}
      onChange={(id) => {
        const picked = pick(id);
        const backend = picked && backends.find((entry) => entry.backendId === picked.backendId);
        if (!picked || !backend?.profiles.length) return;
        // An Agent or provider picked without a model starts where a new conversation on it would.
        onChange(picked.model
          ? { backendId: picked.backendId, profileId: picked.profileId ?? defaultProfile(backend), model: picked.model }
          : startingAgent(backend, { nativeBackendDefaults, auxiliaryModels }, picked.profileId));
      }}
    />
  );
}
