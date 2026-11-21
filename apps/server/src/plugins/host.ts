import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PluginHost, PluginManifest } from '@riffet/plugin-api';
import type { ModelUseDeclaration, Task, TaskParams } from '../../../../packages/contracts/src/index.js';
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
  /** `host.models.complete`, given the plugin's own declared model uses; absent for an isolated installed package, which gets none. */
  completeModel?: (request: Parameters<NonNullable<PluginHost['models']>['complete']>[0], uses: readonly ModelUseDeclaration[]) => Promise<string>;
  /** `host.models.stream`, given the plugin's own declared model uses; absent for an isolated installed package. */
  streamModel?: (request: Parameters<NonNullable<NonNullable<PluginHost['models']>['stream']>>[0], uses: readonly ModelUseDeclaration[]) => Promise<string>;
  /** The model uses this plugin declares: `use` may name these only. */
  ownModelUses?: readonly ModelUseDeclaration[];
  /** Hands an event to the 助理's delegations (`host.assistant.emit`); the topic has been checked against `ownAssistantEvents`. Absent for an isolated installed package, which gets none. */
  emitAssistantEvent?: (topic: string, payload: unknown, key: string | undefined) => void;
  /** The assistant event topics this plugin declares: `emit` may name these only. */
  ownAssistantEvents?: readonly string[];
  /** The inbox's approvals (`host.approvals`), keyed by plugin here. Absent for an isolated installed package, which gets none. */
  approvals?: { request(pluginId: string, request: Parameters<NonNullable<PluginHost['approvals']>['request']>[0]): void; withdraw(pluginId: string, id: string): void };
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
    ...(options.completeModel ? { models: {
      complete: request => options.completeModel!(request, options.ownModelUses ?? []),
      ...(options.streamModel ? { stream: request => options.streamModel!(request, options.ownModelUses ?? []) } : {}),
    } } : {}),
    ...(options.emitAssistantEvent && options.ownAssistantEvents?.length ? { assistant: {
      emit(topic: string, payload?: unknown, emitOptions?: { key?: string }): void {
        if (typeof topic !== 'string' || !topic.startsWith(`${id}/`) || !options.ownAssistantEvents!.includes(topic)) throw new AppError('PLUGIN_ASSISTANT_EVENT_UNDECLARED', `${id} can only emit topics declared in contributes.assistantEvents (${options.ownAssistantEvents!.join(', ')})`, 403);
        options.emitAssistantEvent!(topic, payload, emitOptions?.key);
      },
    } } : {}),
    ...(options.approvals ? { approvals: {
      request: request => options.approvals!.request(id, request),
      withdraw: approvalId => options.approvals!.withdraw(id, approvalId),
    } } : {}),
    error: (code, message, statusCode) => new AppError(code, message, statusCode),
  };
}
