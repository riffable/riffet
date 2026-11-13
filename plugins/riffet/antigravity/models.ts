import type { AgentHost, AgentModelQuery } from '@riffet/plugin-api';
import { agyModelSelector } from './config.js';
import { agyRecord, type AgyRecord } from './protocol.js';
import type { Hub } from './runtime.js';

export async function listModels(hub: Hub, _host: AgentHost, query: AgentModelQuery) {
  const runtime = query.session
    ? hub.runtimes.get(query.session.id)
    : [...hub.runtimes.values()].find(r => r.context.profile.id === query.profile.id && r.rpc);
  if (runtime?.rpc) {
    const response = await runtime.rpc.call('GetAvailableModels', {});
    const catalog = response.response;
    if (agyRecord(catalog?.models) && Array.isArray(catalog.agentModelSorts)) {
      const ids: string[] = catalog.agentModelSorts.flatMap((sort: AgyRecord) =>
        Array.isArray(sort.groups) ? sort.groups.flatMap((group: AgyRecord) => (Array.isArray(group.modelIds) ? group.modelIds : [])) : [],
      );
      runtime.models = [...new Set(ids)].flatMap(value =>
        typeof value === 'string' && typeof catalog.models[value]?.displayName === 'string'
          ? [{ value, name: catalog.models[value].displayName as string, configOptions: [] as [] }]
          : [],
      );
      return runtime.models;
    }
  }
  const value = agyModelSelector(
    query.session?.model ?? (typeof query.profile.config.defaultModel === 'string' ? query.profile.config.defaultModel : undefined),
  );
  return value ? [{ value, name: value, configOptions: [] }] : [];
}
