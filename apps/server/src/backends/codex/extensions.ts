import type { ExtensionRuntimeEntry } from '../../../../../packages/contracts/src/index.js';
import { redactConfigDocument } from '../../settings/config-documents.js';
import type { CodexAppServerClient } from '../shared/codex-app-server.js';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Only reported runtimeStatus can establish connectivity; a cached tools list cannot. */
export function mcpRuntimeEntries(value: unknown, sessionId: string): ExtensionRuntimeEntry[] {
  const data = record(value).data;
  if (!Array.isArray(data)) return [];
  return data.flatMap(raw => {
    const row = record(raw);
    if (typeof row.name !== 'string') return [];
    const status = row.runtimeStatus;
    const state = status === 'connected' ? 'loaded' : status === 'failed' || status === 'authenticationRequired' ? 'error' : status === 'starting' || status === 'notStarted' ? 'pending' : 'unknown';
    return [{ sessionId, kind: 'mcp', name: row.name, state,
      ...(status === 'disabled' ? { enabled: false } : {}),
      ...(typeof status === 'string' ? { message: status } : {}),
      tools: Object.keys(record(row.tools)).slice(0, 500),
    } satisfies ExtensionRuntimeEntry];
  });
}

export async function readMcpRuntime(transport: CodexAppServerClient, sessionId: string, threadId?: string): Promise<ExtensionRuntimeEntry[]> {
  const entries: ExtensionRuntimeEntry[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  const deadline = Date.now() + 15_000;
  for (let page = 0; page < 20; page++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('MCP status listing exceeded the 15 second deadline');
    const value = await transport.request<unknown>('mcpServerStatus/list', { ...(cursor ? { cursor } : {}), ...(threadId ? { threadId } : {}), limit: 100, detail: 'toolsAndAuthOnly' }, Math.min(10_000, remaining));
    entries.push(...mcpRuntimeEntries(value, sessionId));
    const next = record(value).nextCursor;
    if (typeof next !== 'string' || !next || seen.has(next)) break;
    seen.add(next); cursor = next;
  }
  return entries;
}

/** Every configured MCP server and its tool count, from a connection with no thread. */
export async function readMcpServers(transport: CodexAppServerClient): Promise<Array<{ name: string; tools?: number }>> {
  const servers: Array<{ name: string; tools?: number }> = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const value = await transport.request<unknown>('mcpServerStatus/list', { ...(cursor ? { cursor } : {}), limit: 100, detail: 'toolsAndAuthOnly' }, 15_000);
    const data = record(value).data;
    for (const raw of Array.isArray(data) ? data : []) {
      const row = record(raw);
      if (typeof row.name !== 'string' || servers.some(server => server.name === row.name)) continue;
      const tools = Object.keys(record(row.tools)).length;
      servers.push({ name: row.name, ...(tools ? { tools } : {}) });
    }
    const next = record(value).nextCursor;
    if (typeof next !== 'string' || !next || seen.has(next)) break;
    seen.add(next); cursor = next;
  }
  return servers;
}

/**
 * The MCP servers the effective configuration defines for `cwd`. Only these can be switched off per thread: the
 * app-server refuses a thread whose `mcp_servers.<name>.enabled` names a server that comes from a plugin or an app
 * instead (measured on 0.166, \"invalid transport\"), however the same server is listed by `mcpServerStatus/list`.
 */
export async function readConfiguredMcpNames(transport: CodexAppServerClient, cwd: string): Promise<Set<string>> {
  const value = await transport.request<unknown>('config/read', { includeLayers: false, cwd }, 10_000);
  return new Set(Object.keys(record(record(record(value).config).mcp_servers)));
}

export function extensionDiagnostic(error: unknown): string {
  return redactConfigDocument(error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/** Discovery is availability, not evidence that the skill/hook ran in this conversation. */
export function fileRuntimeEntries(value: unknown, kind: 'skill' | 'hook', sessionId: string): ExtensionRuntimeEntry[] {
  const data = record(value).data;
  if (!Array.isArray(data)) return [];
  return data.flatMap(group => {
    const rows = record(group)[kind === 'skill' ? 'skills' : 'hooks'];
    if (!Array.isArray(rows)) return [];
    return rows.flatMap(raw => {
      const row = record(raw);
      const name = kind === 'skill' ? row.name : row.eventName;
      const path = kind === 'skill' ? row.path : row.sourcePath;
      if (typeof name !== 'string') return [];
      return [{ sessionId, kind, name, state: 'unknown', ...(typeof path === 'string' ? { sourcePath: path } : {}), ...(typeof row.enabled === 'boolean' ? { enabled: row.enabled } : {}), message: kind === 'skill' ? '原生技能目录' : `原生 Hook 目录 · ${String(row.trustStatus ?? 'unknown')}` } satisfies ExtensionRuntimeEntry];
    });
  });
}
