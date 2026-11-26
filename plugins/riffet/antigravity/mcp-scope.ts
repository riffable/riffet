import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentHost } from '@riffet/plugin-api/experimental/agent';
import { BRIDGE_PLUGIN, bridgePluginDir, readJson } from './bridge.js';
import { composerText, emptyComposer, sha } from './composer.js';
import type { PreparedAgySession } from './config.js';
import { AGY_ID, type AgyRecord } from './protocol.js';
import { nativeStatus, owned, type Hub, type Runtime } from './runtime.js';
import { readAgySnapshot } from './storage.js';
import { mapAgySnapshot } from './transcript.js';

export const mcpServerName = (sessionId: string) => `riffet_${sha(sessionId).slice(0, 16)}`;

/** Sessions from before native history keep their own data root under the session, with MCP in its config. */
const privateRoot = (paths: Pick<PreparedAgySession, 'root' | 'geminiDir'>) => paths.geminiDir === join(paths.root, 'native');

/**
 * Where this launch's Riffet MCP server is declared: the session's own bridge plugin, so only this agy process
 * loads it; a private data root (layout 1) keeps it in that root's config as before.
 */
export const mcpConfigPath = (paths: Pick<PreparedAgySession, 'root' | 'geminiDir' | 'bridgeDir'>) =>
  privateRoot(paths) ? join(paths.geminiDir, 'config', 'mcp_config.json') : join(bridgePluginDir(paths), 'mcp_config.json');

type Control = Parameters<Parameters<AgentHost['terminals']['interact']>[1]>[0];

const MCP_VIEW_WAIT_MS = 2_000;
const MCP_LOAD_WAIT_MS = 3_000;

async function until(check: () => Promise<boolean>, timeout: number): Promise<boolean> {
  for (const deadline = Date.now() + timeout; ; ) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await delay(150);
  }
}

/**
 * agy (1.5.10) starts the MCP servers of an `--add-dir` plugin only when its MCP view opens or a message
 * arrives, and that message runs without them. Opening the view and closing it again starts them first.
 */
async function startPluginServers(runtime: Runtime, control: Control): Promise<void> {
  await control.paste('/mcp', false);
  if (!(await until(async () => composerText(await control.screen()).trim() === '/mcp', MCP_VIEW_WAIT_MS)))
    throw runtime.host.error('AGY_INPUT_UNCONFIRMED', 'Antigravity has not confirmed the pasted input', 409);
  await control.keys(['Enter']);
  await until(async () => /MCP Servers/.test((await control.screen()) ?? ''), MCP_VIEW_WAIT_MS);
  await control.keys(['Escape']);
  if (!(await until(async () => emptyComposer(await control.screen()), MCP_VIEW_WAIT_MS)))
    throw runtime.host.error('CLI_INTERACTION_REQUIRED', 'The Antigravity terminal has a draft or an open dialog', 409);
}

/** Riffet's MCP tools must be loaded in agy before input is pasted, or the turn starts without them. */
export async function mcpReady(runtime: Runtime, control: Control): Promise<void> {
  const name = mcpServerName(runtime.context.session.id);
  const config = await readJson(mcpConfigPath(runtime.launch));
  if (!config?.mcpServers?.[name] || config.mcpServers[name].disabled === true) return;
  const served = privateRoot(runtime.launch) ? name : `${BRIDGE_PLUGIN}_${name}`;
  const states = async () => {
    const inventory = await runtime.rpc!.call('GetMcpServerStates', {});
    const server = Array.isArray(inventory.states) ? inventory.states.find((state: AgyRecord) => state.spec?.serverName === served) : undefined;
    return { inventory, server };
  };
  let { inventory, server } = await states();
  if (!server && inventory.isLoading !== true && !privateRoot(runtime.launch)) {
    await startPluginServers(runtime, control);
    await until(async () => {
      ({ inventory, server } = await states());
      return server?.status === 'MCP_SERVER_STATUS_READY' || server?.status === 'MCP_SERVER_STATUS_ERROR';
    }, MCP_LOAD_WAIT_MS);
  }
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
