import type { CursorCliSettings, CursorCliSettingsUpdate } from '@contracts';

type DraftPayload = Omit<CursorCliSettings, 'hasApiKey'>;

export function normalizeCliSettings(value?: CursorCliSettings): DraftPayload {
  return {
    executable: value?.executable?.trim() ?? '',
    configDir: value?.configDir?.trim() ?? '',
    apiEndpoint: value?.apiEndpoint?.trim() ?? '',
    agentEndpoint: value?.agentEndpoint?.trim() ?? '',
    disableAutoUpdate: value?.disableAutoUpdate === true,
  };
}

export function hasSeparateAgentEndpoint(value?: CursorCliSettings): boolean {
  return (value?.agentEndpoint?.trim() ?? '') !== (value?.apiEndpoint?.trim() ?? '');
}

export function updateGateway(value: CursorCliSettings, gateway: string, separateAgentEndpoint: boolean): CursorCliSettings {
  return { ...value, apiEndpoint: gateway, ...(!separateAgentEndpoint ? { agentEndpoint: gateway } : {}) };
}

export function cliSettingsPatch(value: CursorCliSettings, saved?: CursorCliSettings, scope: 'connection' | 'launch' | 'all' = 'all'): CursorCliSettingsUpdate {
  const next = normalizeCliSettings(value);
  const previous = normalizeCliSettings(saved);
  const patch: CursorCliSettingsUpdate = {};
  for (const key of ['executable', 'configDir', 'apiEndpoint', 'agentEndpoint'] as const) {
    if (scope === 'connection' && (key === 'executable' || key === 'configDir')) continue;
    if (scope === 'launch' && (key === 'apiEndpoint' || key === 'agentEndpoint')) continue;
    if (next[key] !== previous[key]) patch[key] = next[key];
  }
  if (scope !== 'connection' && next.disableAutoUpdate !== previous.disableAutoUpdate) patch.disableAutoUpdate = next.disableAutoUpdate;
  return patch;
}
