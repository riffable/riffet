import type { AppSettings, AssistantSettings, NativeBackendCatalogEntry, NativeBackendId } from '@contracts';

/** The 助理's agent, provider and model, as far as they still exist (docs/ASSISTANT.md). */
export interface AssistantChoice { backendId: NativeBackendId; profileId?: string; model?: string }

/** The agent the 助理 is built on: its own instructions, memory and Riffet's skills reach only this one (docs/ASSISTANT.md §4). */
const STANDING_BACKEND: NativeBackendId = 'claude';

/**
 * The saved choice while its agent is still offered. A provider since removed falls back to the
 * agent's default one, and its model with it. With nothing saved it is Claude Code where that can
 * run, rather than whichever agent the composer last used elsewhere.
 */
export function assistantChoice(saved: AssistantSettings | undefined, backends: NativeBackendCatalogEntry[]): AssistantChoice | undefined {
  const backend = (saved?.backendId ? backends.find((entry) => entry.backendId === saved.backendId) : undefined)
    ?? backends.find((entry) => entry.backendId === STANDING_BACKEND && entry.available);
  if (!backend) return undefined;
  const profileKept = !saved?.profileId || backend.profiles.some((profile) => profile.id === saved.profileId);
  return {
    backendId: backend.backendId,
    ...(profileKept && saved?.profileId ? { profileId: saved.profileId } : {}),
    ...(profileKept && saved?.model ? { model: saved.model } : {}),
  };
}

/** The settings a composer reads its opening model from, with the 助理's in place of the agent's own. */
export function withAssistantDefaults(settings: AppSettings, choice: AssistantChoice): AppSettings {
  const { profileId: _profile, model: _model, ...rest } = settings.nativeBackendDefaults?.[choice.backendId] ?? {};
  return {
    ...settings,
    nativeBackendDefaults: {
      ...settings.nativeBackendDefaults,
      [choice.backendId]: { ...rest, ...(choice.profileId ? { profileId: choice.profileId } : {}), ...(choice.model ? { model: choice.model } : {}) },
    },
  };
}
