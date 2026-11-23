import { useLingui } from '@lingui/react/macro';
import type { AppSettings, CouncilAgent, NativeBackendCatalogEntry } from '@contracts';
import { IconChevronDown } from '@/components/icons';
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

/** The card already shows the Agent mark. Its model trigger extends over the card header. */
export function SeatPicker({ backends, value, disabled, card, onChange }: {
  backends: readonly NativeBackendCatalogEntry[];
  value: CouncilAgent | undefined;
  disabled?: boolean;
  card?: boolean;
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
      className={card
        ? 'h-7 max-w-full rounded-none px-0 text-sm font-semibold text-fg after:absolute after:inset-0 after:rounded-2xl hover:bg-transparent hover:after:bg-hover/40 focus-visible:ring-0 focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-focus data-[state=open]:bg-transparent data-[state=open]:after:bg-hover/40 @md:text-base'
        : 'h-7 max-w-full px-2 text-sm no-hover:min-h-11'}
      labelClassName="min-w-0 max-w-none sm:max-w-none"
      leading={<>{!card && picker.leading}<IconChevronDown aria-hidden className="order-last size-3 shrink-0 text-fg-3" /></>}
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
