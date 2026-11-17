import type { AppSettings, AssistantChoice } from '@contracts';

export { assistantChoice, isAssistantBackend, type AssistantChoice } from '@contracts';

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
