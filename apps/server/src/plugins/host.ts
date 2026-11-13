import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PluginHost, PluginManifest } from '@riffet/plugin-api';
import type { Task, TaskParams } from '../../../../packages/contracts/src/index.js';
import { resolveCliExecutable } from '../backends/shared/cli-resolve.js';
import { effortOption, fetchGatewayModels, gatewayBaseUrl, gatewayRootUrl } from '../backends/shared/gateway-models.js';
import { AppError } from '../errors.js';
import { runProcess } from '../git/exec.js';
import type { PluginStore } from './store.js';

const SECRET_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** The core as one plugin sees it: existing utilities, plus state scoped to its id. */
export function createPluginHost(id: PluginManifest['id'], options: {
  stateDir: string; store: PluginStore; invalidateModelCatalogs: () => void; savedModelSources: () => Iterable<string>; agentProfiles?: PluginHost['agentProfiles'];
  /** The Agent backends this plugin declares: `agentProfiles` answers for those only (profile configs carry API keys), and is absent when this is not given. */
  ownAgentBackends?: readonly string[];
  /** The task providers this plugin declares. `tasks` is offered only to one that declares some, and starts nothing else. */
  ownTaskProviders?: readonly string[];
  /** The task service's `start`; absent in a host without one (the doctor's registry). */
  startTask?: (input: { requestId: string; projectId: string; providerId: string; actionId: string; params?: TaskParams; confirm?: string }) => Promise<Task>;
  /** `host.services.get` of this plugin; absent for an installed package, which gets none. */
  service?: (pluginId: string, name: string, range: string) => unknown;
  /** The core's conversations; offered only when `ownsSessionSurfaces`. */
  sessions?: NonNullable<PluginHost['sessions']>;
  /** Whether this plugin declares agent tools or channels. */
  ownsSessionSurfaces?: boolean;
}): PluginHost {
  const directory = join(options.stateDir, 'plugin-data', id);
  return {
    id,
    async stateDir() { await mkdir(directory, { recursive: true, mode: 0o700 }); return directory; },
    settings: () => options.store.item(id).settings,
    secrets: {
      get: name => options.store.item(id).secrets[name],
      async set(name, value) {
        if (!SECRET_NAME.test(name) || (value !== null && (typeof value !== 'string' || value.length > 64 * 1024))) throw new AppError('INVALID_INTEGRATION_SECRET', 'Invalid secret');
        options.store.update(id, { secrets: { [name]: value } });
      },
    },
    runProcess: (file, args, processOptions) => runProcess(file, args, processOptions),
    resolveCli(command, env) {
      const resolution = resolveCliExecutable({ command, ...(env ? { env } : {}) });
      return resolution.resolved ? resolution.executable : undefined;
    },
    gateway: { fetchModels: fetchGatewayModels, baseUrl: gatewayBaseUrl, rootUrl: gatewayRootUrl, effortOption },
    invalidateModelCatalogs: () => options.invalidateModelCatalogs(),
    modelSourceInUse(source) {
      for (const saved of options.savedModelSources()) if (saved === source) return true;
      return false;
    },
    ...(options.agentProfiles && options.ownAgentBackends?.length ? {
      agentProfiles: (backendId: string) => options.ownAgentBackends!.includes(String(backendId)) ? options.agentProfiles!(backendId as never) : [],
    } : {}),
    ...(options.startTask && options.ownTaskProviders?.length ? { tasks: {
      start(projectId: string, actionId: string, params?: TaskParams, taskOptions?: { providerId?: string; confirm?: string }): Promise<Task> {
        const own = options.ownTaskProviders!;
        const providerId = taskOptions?.providerId ?? (own.length === 1 ? own[0] : undefined);
        if (!providerId || !own.includes(providerId)) throw new AppError('PLUGIN_TASK_PROVIDER_FOREIGN', `${id} can only start tasks of its own providers (${own.join(', ')}); name one in providerId`, 403);
        // One request id per call: the command that calls this runs once (its own request id), so a task is not started twice.
        return options.startTask!({ requestId: `host-${randomUUID()}`, projectId, providerId, actionId, ...(params ? { params } : {}), ...(taskOptions?.confirm ? { confirm: taskOptions.confirm } : {}) });
      },
    } } : {}),
    ...(options.service ? { services: { get: ((pluginId: string, name: string, range: string) => options.service!(pluginId, name, range)) as NonNullable<PluginHost['services']>['get'] } } : {}),
    ...(options.sessions && options.ownsSessionSurfaces ? { sessions: options.sessions } : {}),
    error: (code, message, statusCode) => new AppError(code, message, statusCode),
  };
}
