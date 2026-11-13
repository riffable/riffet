import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson } from './bridge.js';
import { sha } from './composer.js';
import { AGY_ID, type AgyRecord } from './protocol.js';
import { nativeStatus, owned, type Hub, type Runtime } from './runtime.js';
import { readAgySnapshot } from './storage.js';
import { mapAgySnapshot } from './transcript.js';

export const mcpServerName = (sessionId: string) => `riffet_${sha(sessionId).slice(0, 16)}`;

/** Riffet's MCP tools must be loaded in agy before input is pasted, or the turn starts without them. */
export async function mcpReady(runtime: Runtime): Promise<void> {
  const name = mcpServerName(runtime.context.session.id);
  const config = await readJson(join(runtime.launch.geminiDir, 'config', 'mcp_config.json'));
  if (!config?.mcpServers?.[name] || config.mcpServers[name].disabled === true) return;
  const inventory = await runtime.rpc!.call('GetMcpServerStates', {});
  const server = Array.isArray(inventory.states) ? inventory.states.find((state: AgyRecord) => state.spec?.serverName === name) : undefined;
  // Waiting does not fix a server agy failed to start (its shim moved, say): say so instead of holding the message.
  if (server?.status === 'MCP_SERVER_STATUS_ERROR') {
    const reason = typeof server.error === 'string' && server.error ? `: ${server.error.slice(0, 200)}` : '';
    throw runtime.host.error('AGY_MCP_UNAVAILABLE', `Antigravity could not start its Riffet tools${reason}`, 409);
  }
  if (
    inventory.isLoading === true ||
    server?.status !== 'MCP_SERVER_STATUS_READY' ||
    !Array.isArray(server.tools) ||
    !['read_context', 'list_wakeups', 'list_devices'].every(name => server.tools.some((tool: AgyRecord) => tool.name === name))
  ) {
    throw runtime.host.error('CLI_BUSY', 'Antigravity is loading its Riffet tools', 409);
  }
}

/** Accepts a Riffet MCP call only when its metadata proves it comes from this session's verified conversation. */
export async function validateMcp(hub: Hub, runtime: Runtime, metadata: Record<string, unknown>): Promise<void> {
  if (runtime.stopped || runtime.conflict || hub.closed) throw new Error('Antigravity binding is offline');
  await owned(runtime);
  const status = await nativeStatus(runtime);
  const id = runtime.host.view.session(runtime.context.session.id)?.nativeSessionId;
  if (!id || status?.conversation_id !== id || metadata['antigravity.google/root_conversation_id'] !== id) {
    throw new Error('Antigravity tool scope changed');
  }
  const current = metadata['antigravity.google/conversation_id'];
  if (typeof current !== 'string' || !AGY_ID.test(current)) throw new Error('Antigravity tool conversation is unavailable');
  if (current !== id) {
    const child = readAgySnapshot(runtime.launch.geminiDir, current);
    if (
      metadata['antigravity.google/parent_conversation_id'] !== id ||
      child?.metadata?.parentConversationId !== id ||
      child.metadata.rootConversationId !== id
    ) {
      throw new Error('Antigravity child lineage is unavailable');
    }
    const parent = await runtime.rpc!.snapshot(id);
    if (!mapAgySnapshot(parent).children.some(entry => entry.agentId === current)) {
      throw new Error('Antigravity child is not active in this parent');
    }
  } else if (metadata['antigravity.google/parent_conversation_id']) {
    throw new Error('Antigravity parent scope is inconsistent');
  }
  const hook = await readJson(join(runtime.launch.root, 'bridge', `${id}.json`));
  // agy may report the project by its resolved path when the project path goes through a symlink.
  const cwd = runtime.context.project.cwd;
  const project = [cwd, await realpath(cwd).catch(() => cwd)];
  if (
    hook?.nonce !== runtime.launch.nonce ||
    hook.at < runtime.launch.startedAt ||
    hook.payload?.conversationId !== id ||
    !Array.isArray(hook.payload?.workspacePaths) ||
    !project.some(path => hook.payload.workspacePaths.includes(path)) ||
    ![runtime.launch.bridgeDir, ...project].includes(hook.payload?.cwd)
  ) {
    throw new Error('Antigravity workspace identity is unavailable');
  }
  const artifact = typeof metadata['antigravity.google/artifacts_dir'] === 'string' ? metadata['antigravity.google/artifacts_dir'] : '';
  if (artifact !== join(runtime.launch.geminiDir, 'antigravity-cli', 'brain', current)) {
    throw new Error('Antigravity tool artifacts are outside the session');
  }
}
