import { randomBytes } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentContext, AgentHost, AgentOpenResult } from '@riffet/plugin-api/experimental/agent';
import { prepareBridge, readJson, writeJson } from './bridge.js';
import { sha } from './composer.js';
import { agyModelSelector, agyProfileEnvironment, parseAgyProfile, prepareAgySession } from './config.js';
import { attach } from './lifecycle.js';
import { mcpServerName } from './mcp-scope.js';
import { agyConversationId, agyRecord } from './protocol.js';
import { refresh, schedule } from './poll.js';
import { assertCurrent, epochOf, verifyOwnership, type Hub, type Launch } from './runtime.js';

export function open(hub: Hub, host: AgentHost, context: AgentContext): Promise<AgentOpenResult> {
  const id = context.session.id;
  const existing = hub.opening.get(id);
  if (existing) return existing;
  const task = openOnce(hub, host, context).finally(() => {
    if (hub.opening.get(id) === task) hub.opening.delete(id);
  });
  hub.opening.set(id, task);
  return task;
}

/** Writes this session's Riffet MCP server into agy's own config, or removes it when the host offers none. */
async function writeMcpConfig(host: AgentHost, sessionId: string, geminiDir: string): Promise<void> {
  const mcp = await host.riffetMcp(sessionId);
  const mcpPath = join(geminiDir, 'config', 'mcp_config.json');
  await mkdir(join(geminiDir, 'config'), { recursive: true, mode: 0o700 });
  const mcpConfig = (await readJson(mcpPath)) ?? {};
  const servers = agyRecord(mcpConfig.mcpServers) ? mcpConfig.mcpServers : {};
  const mcpName = mcpServerName(sessionId);
  if (mcp) servers[mcpName] = { ...(agyRecord(servers[mcpName]) ? servers[mcpName] : {}), command: mcp.command, args: mcp.args };
  else delete servers[mcpName];
  await writeJson(mcpPath, { ...mcpConfig, mcpServers: servers });
}

async function openOnce(hub: Hub, host: AgentHost, context: AgentContext): Promise<AgentOpenResult> {
  if (hub.closed) throw host.error('AGENT_BACKEND_CLOSED', 'Antigravity is disabled', 409);
  let runtime = await attach(hub, host, context);
  const epoch = epochOf(hub, context.session.id);
  if (hub.closed) throw host.error('AGENT_BACKEND_CLOSED', 'Antigravity is disabled', 409);
  if (runtime) {
    await verifyOwnership(host, runtime);
    // An explicit open is the retry of a failed runtime: polling resumes once ownership holds again.
    if (runtime.failure) {
      runtime.failure = undefined;
      await refresh(hub, runtime);
      schedule(hub, runtime);
    }
    return {
      terminalId: runtime.launch.terminalId,
      nativeSessionId: host.view.session(context.session.id)?.nativeSessionId,
      status: runtime.status,
    };
  }
  if (context.session.terminalId && host.view.terminal(context.session.terminalId)?.state !== 'exited') {
    throw host.error('AGY_LAUNCH_UNKNOWN', 'The existing Antigravity terminal could not be verified', 409);
  }
  let config = { ...context.profile.config };
  const endpoint = await host.modelSources.resolve(context.profile.id, 'google-generative-ai');
  if (config.modelSource && !endpoint) throw host.error('AGY_PROVIDER_UNAVAILABLE', 'The Antigravity model source is unavailable', 409);
  if (endpoint) {
    if (!endpoint.credential || Object.keys(endpoint.headers ?? {}).some(key => !['x-goog-api-key'].includes(key.toLowerCase()))) {
      throw host.error('AGY_PROVIDER_UNSUPPORTED', 'Antigravity requires a static Gemini API key without custom headers', 400);
    }
    config = { ...config, apiEndpoint: endpoint.baseUrl, apiKey: endpoint.credential.key, apiProtocol: 'google-generative-ai' };
  }
  const profile = parseAgyProfile(config);
  const paths = await prepareAgySession({
    stateDir: hub.stateDir,
    sessionId: context.session.id,
    projectCwd: context.project.cwd,
    profile,
    model: context.session.model,
    mode: context.session.mode,
    approval: context.session.approval,
  });
  const nonce = randomBytes(24).toString('hex');
  await prepareBridge(paths, nonce);
  await writeMcpConfig(host, context.session.id, paths.geminiDir);
  const token = randomBytes(32).toString('base64url');
  const args = [
    `--gemini_dir=${paths.geminiDir}`,
    `--csrf_token=${token}`,
    '--settings',
    paths.settingsPath,
    '--add-dir',
    paths.bridgeDir,
    '--log-file',
    paths.logPath,
  ];
  const model = agyModelSelector(context.session.model ?? (typeof config.defaultModel === 'string' ? config.defaultModel : undefined));
  if (model) args.push('--model', model);
  if (context.session.nativeSessionId) args.push('--conversation', agyConversationId(context.session.nativeSessionId));
  const marker = sha(
    JSON.stringify({ root: paths.root, nonce, command: profile.executable, project: await realpath(context.project.cwd) }),
  );
  assertCurrent(hub, context.session.id, epoch);
  const unbind = host.bindRiffetMcp(context.session.id, async () => {
    throw new Error('Antigravity is starting');
  });
  const terminal = await host.terminals.launch(context.session.id, {
    command: profile.executable,
    args,
    ...agyProfileEnvironment(profile),
    cwd: context.project.cwd,
    launchMarker: marker,
    title: 'Antigravity',
    reuseLive: false,
  });
  try {
    if (hub.closed || epochOf(hub, context.session.id) !== epoch) {
      throw host.error('AGENT_BACKEND_CLOSED', 'Antigravity launch was cancelled', 409);
    }
    const launch: Launch = {
      config: { model, mode: context.session.mode, approval: context.session.approval },
      configRevision: context.session.configRevision,
      ...paths,
      command: profile.executable,
      args,
      nonce,
      token,
      marker,
      terminalId: terminal.id,
      epoch: terminal.epoch,
      startedAt: Date.now() - 1000,
    };
    await writeJson(join(paths.root, 'launch.json'), launch);
    assertCurrent(hub, context.session.id, epoch);
    await host.updateSession(context.session.id, { terminalId: terminal.id });
  } catch (error) {
    // A pane nothing records would run agy unowned: no runtime polls it and the next launch starts another.
    unbind();
    await host.terminals.stop(terminal.id).catch(() => undefined);
    throw error;
  }
  unbind();
  assertCurrent(hub, context.session.id, epoch);
  runtime = await attach(hub, host, { ...context, session: await host.session(context.session.id) });
  return {
    terminalId: terminal.id,
    ...(context.session.nativeSessionId ? { nativeSessionId: context.session.nativeSessionId } : {}),
    status: runtime?.status ?? { phase: 'starting' as const },
  };
}
