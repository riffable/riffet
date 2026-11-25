import { toolObject as object, type ToolDefinition } from '../assistant-capability.js';
import type { RemoteExecResult, ServerInfo, Session } from '../../../../packages/contracts/src/index.js';
import { LINK_BUDGET } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';

export interface LinkedServersSource {
  servers(): ServerInfo[];
  requestJson<T>(serverId: string, method: 'GET' | 'POST', path: string, body?: unknown, options?: { signal?: AbortSignal; timeoutMs?: number; origin?: string }): Promise<T>;
}

export const REMOTE_TOOL_NAMES = new Set(['remote_list', 'remote_exec']);

export function buildRemoteTools(servers: readonly ServerInfo[]): ToolDefinition[] {
  if (!servers.length) return [];
  const listSummary = servers.map(item => `${item.alias || item.id} (${item.name}${item.note ? `: ${item.note}` : ''})`).join(', ');
  const aliases = servers.map(item => item.alias || item.id);
  return [
    {
      name: 'remote_list',
      description: 'List the linked servers explicitly granted to this conversation, including their alias, display name, online/permission status, platform, note, and registered project directories.',
      inputSchema: object({}),
    },
    {
      name: 'remote_exec',
      description: `Run a non-interactive shell command on one of the linked servers granted to this conversation (${listSummary}) over its Riffet tunnel. Output and wall-clock time are bounded; use standard shell pipelines/tools to read files, inspect logs, or run builds.`,
      inputSchema: object({
        server: { type: 'string', description: `Target server alias or id: ${aliases.join(', ')}.${servers.length === 1 ? ' May be omitted.' : ''}` },
        command: { type: 'string', description: 'Shell command to run on the target server.' },
        cwd: { type: 'string', description: 'Working directory on the target server (~ expands to its home directory). Defaults to home.' },
        timeoutSeconds: { type: 'number', description: `Wall-clock timeout in seconds (1-${Math.floor(LINK_BUDGET.execTimeoutMaxMs / 1000)}, default ${Math.floor(LINK_BUDGET.execTimeoutDefaultMs / 1000)}).` },
      }, [...(servers.length > 1 ? ['server'] : []), 'command']),
    },
  ];
}

export async function callRemoteTool(
  links: LinkedServersSource | undefined,
  allowed: readonly ServerInfo[],
  session: Session,
  name: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!links || !allowed.length) {
    throw new AppError('TOOL_NOT_AVAILABLE', `${name} is not available in this conversation; grant a linked server in Skills & Tools first`);
  }
  const origin = `session:${session.id.slice(0, 8)}`;

  if (name === 'remote_list') {
    const servers = await Promise.all(allowed.map(async (server) => {
      let projects: Array<{ name: string; cwd: string }> | undefined;
      if (server.online && server.outbound && server.compatible) {
        const list = await links.requestJson<{ projects?: Array<{ name: string; cwd: string; archivedAt?: string; system?: string }> }>(
          server.id, 'GET', '/api/projects', undefined, { signal, timeoutMs: 5_000, origin },
        ).catch(() => undefined);
        if (Array.isArray(list?.projects)) {
          projects = list.projects.filter(item => !item.archivedAt && !item.system).slice(0, 32).map(item => ({ name: item.name, cwd: item.cwd }));
        }
      }
      return {
        id: server.id,
        alias: server.alias || server.id,
        name: server.name,
        online: server.online,
        outbound: server.outbound,
        compatible: server.compatible,
        ...(server.platform ? { platform: server.platform } : {}),
        ...(server.note ? { note: server.note } : {}),
        ...(projects ? { projects } : {}),
      };
    }));
    return { servers };
  }

  // Hard whitelist check: `server` must match one of the servers explicitly granted in `session.toolGroups`.
  const rawServer = typeof input.server === 'string' ? input.server.trim() : '';
  let target: ServerInfo | undefined;
  if (!rawServer) {
    if (allowed.length === 1) target = allowed[0];
    else throw new AppError('INVALID_ARGUMENT', `Specify which linked server: ${allowed.map(item => item.alias || item.id).join(', ')}`);
  } else {
    const lower = rawServer.toLowerCase();
    target = allowed.find(item => item.alias?.toLowerCase() === lower || item.id.toLowerCase() === lower || item.name.toLowerCase() === lower);
  }
  if (!target) {
    throw new AppError('REMOTE_NOT_ALLOWED', `Server "${rawServer}" is not granted to this conversation. Allowed: ${allowed.map(item => item.alias || item.id).join(', ')}`);
  }
  if (!target.online) throw new AppError('LINK_OFFLINE', `${target.name} (${target.alias || target.id}) is offline`);
  if (!target.compatible) throw new AppError('LINK_INCOMPATIBLE', `${target.name} runs an incompatible Riffet protocol version`);
  if (!target.outbound) throw new AppError('LINK_NOT_ALLOWED', `${target.name} does not allow this server to operate it`);

  const command = typeof input.command === 'string' ? input.command : '';
  if (!command.trim()) throw new AppError('INVALID_ARGUMENT', 'command must be a non-empty string');
  const cwd = typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : undefined;
  const rawTimeout = input.timeoutSeconds;
  if (rawTimeout !== undefined && (typeof rawTimeout !== 'number' || !Number.isFinite(rawTimeout) || rawTimeout < 1 || rawTimeout > Math.floor(LINK_BUDGET.execTimeoutMaxMs / 1000))) {
    throw new AppError('INVALID_ARGUMENT', `timeoutSeconds must be a number from 1 to ${Math.floor(LINK_BUDGET.execTimeoutMaxMs / 1000)}`);
  }
  const timeoutMs = rawTimeout !== undefined ? Math.round(rawTimeout * 1000) : LINK_BUDGET.execTimeoutDefaultMs;

  const result = await links.requestJson<RemoteExecResult>(
    target.id, 'POST', '/api/remote/exec',
    { command, ...(cwd ? { cwd } : {}), timeoutMs },
    { signal, timeoutMs: timeoutMs + 10_000, origin },
  );
  return {
    server: { id: target.id, alias: target.alias || target.id, name: target.name },
    ...result,
  };
}
