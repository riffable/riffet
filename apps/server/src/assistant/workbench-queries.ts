import { z } from 'zod/v4';
import type { NativeStatus, Session } from '../../../../packages/contracts/src/index.js';
import { ASSISTANT_QUERY_BUDGET as budget } from '../../../../packages/contracts/src/budgets.js';
import { defineRead } from '../assistant-capability.js';
import { AppError } from '../errors.js';
import type { RestartAssessment } from '../native/dispatch.js';
import type { Store } from '../store.js';
import { zoneOf } from './standing.js';

/** The registry supplies this projection from committed state, independently of its management API. */
interface PluginInventoryEntry {
  id: string;
  name: string;
  labels: string[];
  source: string;
  version?: string;
  enablement: string;
  enabled: boolean;
  active: boolean;
  activation: string;
  reason: string | null;
  activatedAt?: string;
  health?: string;
  toolGroups: string[];
}

interface WorkbenchSources {
  store: Pick<Store, 'getSession' | 'getProject'>;
  ownerName(): string | undefined;
  timeZone(): string | undefined;
  nativeStatus(sessionId: string): NativeStatus;
  pluginSettings(id: string, offset: number, limit: number): Promise<Record<string,unknown>>;
  pluginInventory(): Promise<PluginInventoryEntry[]>;
  pluginToolGroups(session: Session): ReadonlyArray<{ id: string; tools: string[] }>;
  restartability(): RestartAssessment;
}

const pageSize = z.number().int().min(1).max(budget.pageItems);
const pluginFilter = z.strictObject({
  query: z.string().trim().min(1).max(100).optional(),
  limit: pageSize.optional(),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});

function pluginSummary(plugin: PluginInventoryEntry) {
  return {
    id: plugin.id, name: plugin.name.slice(0, 120), source: plugin.source,
    ...(plugin.labels.length ? { label: plugin.labels[0]!.slice(0, 120) } : {}),
    ...(plugin.version ? { version: plugin.version } : {}),
    enablement: plugin.enablement, enabled: plugin.enabled, active: plugin.active,
    activation: plugin.activation, ...(plugin.reason ? { reason: plugin.reason } : {}),
    ...(plugin.activatedAt ? { activatedAt: plugin.activatedAt } : {}),
    ...(plugin.health ? { lastReportedHealth: plugin.health } : {}),
  };
}

/** Only the main conversation may read its owner's workbench diagnostics. */
export function createAssistantWorkbenchQueries(sources: WorkbenchSources) {
  const main = (id: string) => {
    const session = sources.store.getSession(id);
    const project = sources.store.getProject(session.projectId);
    if (session.archivedAt || session.state === 'archived' || project.archivedAt || session.origin?.kind === 'assistant'
      || project.system !== 'assistant' || project.mainSessionId !== id) {
      throw new AppError('TOOL_NOT_AVAILABLE', 'This query is only available to the personal assistant main conversation', 403);
    }
    return session;
  };
  return {
    identity(sessionId: string) {
      const session = main(sessionId);
      const configuredZone = sources.timeZone();
      const timeZone = zoneOf(configuredZone);
      let runtimeModel: string | undefined;
      try {
        const runtime = sources.nativeStatus(session.id);
        if (runtime.phase !== 'offline' && runtime.phase !== 'starting') runtimeModel = runtime.model;
      } catch { /* runtime state is optional */ }
      return {
        owner: { name: sources.ownerName() ?? null, timeZone, timeZoneSource: timeZone === configuredZone ? 'configured' : 'server' },
        assistant: {
          sessionId: session.id, role: 'main', backendId: session.backendId,
          configuredModel: session.model ?? null, runtimeModel: runtimeModel ?? null,
          runtimeModelState: runtimeModel ? 'reported' : 'unknown',
        },
        observedAt: new Date().toISOString(),
      };
    },

    async plugins(sessionId: string, { query, offset = 0, limit = 20 }: z.infer<typeof pluginFilter>) {
      main(sessionId);
      const find = query?.toLowerCase();
      const inventory = (await sources.pluginInventory()).filter(plugin => !find || [plugin.id, plugin.name, ...plugin.labels].some(value => value.toLowerCase().includes(find)));
      main(sessionId);
      inventory.sort((left, right) => left.id.localeCompare(right.id));
      const end = offset + limit;
      return {
        plugins: inventory.slice(offset, end).map(plugin => ({ ...pluginSummary(plugin), declaresAgentTools: plugin.toolGroups.length > 0 })),
        total: inventory.length,
        ...(end < inventory.length ? { nextOffset: end } : {}),
        observedAt: new Date().toISOString(),
      };
    },

    async pluginSettings(sessionId: string, id: string, offset = 0, limit = 20) {
      main(sessionId);
      const result = await sources.pluginSettings(id,offset,limit);
      main(sessionId);
      return result;
    },

    async plugin(sessionId: string, id: string) {
      main(sessionId);
      const plugin = (await sources.pluginInventory()).find(item => item.id === id);
      if (!plugin) throw new AppError('PLUGIN_NOT_FOUND', 'No such plugin is listed in the workbench inventory', 404);
      const session = main(sessionId);
      const granted = new Set<string>(session.toolGroups ?? []);
      const available = new Map(sources.pluginToolGroups(session).map(group => [group.id, group.tools]));
      return {
        plugin: pluginSummary(plugin),
        launchConfigPending: session.configPending === true,
        toolGroups: plugin.toolGroups.slice(0, budget.pageItems).map(id => {
          const authorized = granted.has(id);
          const tools = available.get(id) ?? [];
          const serverAvailable = tools.length > 0;
          return {
            id, authorized, serverAvailable, cliLoaded: 'unknown',
            ...(serverAvailable ? { tools: tools.slice(0, budget.pageItems), totalTools: tools.length } : {
              reasons: [...(!authorized ? ['not_authorized_for_session'] : []), ...(plugin.reason ? [plugin.reason] : authorized ? ['tools_unavailable'] : [])],
            }),
          };
        }),
        totalToolGroups: plugin.toolGroups.length,
        observedAt: new Date().toISOString(),
      };
    },

    restartImpact(sessionId: string) {
      main(sessionId);
      const { restartable, draining, blockers } = sources.restartability();
      const visible = blockers.filter(blocker => {
        try {
          const session = sources.store.getSession(blocker.sessionId);
          const project = sources.store.getProject(session.projectId);
          return !session.archivedAt && session.state !== 'archived' && !project.archivedAt
            && (session.id === sessionId || (!project.system && session.origin?.kind !== 'council'));
        } catch { return false; }
      });
      return {
        restartable, draining,
        blockers: visible.slice(0, budget.pageItems).map(({ sessionId, title, backendId, reason }) => ({ sessionId, title: title.slice(0, 200), backendId, reason })),
        hasHiddenBlockers: visible.length < blockers.length,
        ...(visible.length > budget.pageItems ? { totalVisibleBlockers: visible.length } : {}),
        observedAt: new Date().toISOString(),
      };
    },
  };
}

export function workbenchReads(queries: ReturnType<typeof createAssistantWorkbenchQueries>) {
  return [
    defineRead('workbench.identity', 'Read the owner nickname, effective time zone and the current personal assistant session and model.', ['owner', 'nickname', 'time zone', 'identity', '昵称', '主人', '时区', '模型', '身份'], z.strictObject({}), id => queries.identity(id)),
    defineRead('plugins.list', 'Search installed workbench plugins and see their enablement and last known activation state. Filter by plug-in name or ID.', ['plugin', 'installation', 'browser', '插件', '浏览器插件', '安装', '启用'], pluginFilter, (id, args) => queries.plugins(id, args)),
    defineRead('settings.plugin', 'Find the configuration fields an installed plugin declares and the settings page for entering them. Values and secrets are never returned.',
      ['plugin settings','credential','secret','插件设置','配置','密钥'], z.strictObject({pluginId:z.string().min(1).max(200),offset:z.number().int().nonnegative().optional(),limit:pageSize.optional()}),
      (id,args)=>queries.pluginSettings(id,args.pluginId,args.offset,args.limit)),
    defineRead('plugins.inspect', 'Explain why a workbench plugin’s agent tools are available or unavailable to this conversation. Use a plugin ID from plugins.list. Launch config can be pending. Server authorization cannot establish what the running CLI loaded.', ['plugin', 'authorization', 'available', 'browser', '插件', '授权', '加载', '浏览器插件', '可用'], z.strictObject({ pluginId: z.string().trim().min(1).max(200) }), (id, { pluginId }) => queries.plugin(id, pluginId)),
    defineRead('service.restart_impact', 'Check whether restarting this Riffet service would interrupt delivery or an active session. It only reads the current assessment.', ['restart', 'service', 'blockers', '重启', '服务', '中断'], z.strictObject({}), id => queries.restartImpact(id)),
  ];
}
