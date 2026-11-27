import { realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentContext, AgentHost } from '@riffet/plugin-api/experimental/agent';
import { readJson } from './bridge.js';
import { agySessionGeminiDir } from './config.js';
import { validateMcp } from './mcp-scope.js';
import { endOpenTurns, refresh, schedule } from './poll.js';
import { nativeStatus, assertCurrent, detach, epochOf, sessionRoot, type Hub, type Launch, type Runtime } from './runtime.js';

export function attach(hub: Hub, host: AgentHost, context: AgentContext): Promise<Runtime | undefined> {
  const id = context.session.id;
  const existing = hub.attaching.get(id);
  if (existing) return existing;
  const task = attachOnce(hub, host, context).finally(() => {
    if (hub.attaching.get(id) === task) hub.attaching.delete(id);
  });
  hub.attaching.set(id, task);
  return task;
}

/** The persisted launch record, if it still describes this session's live terminal. */
async function readSavedLaunch(hub: Hub, context: AgentContext): Promise<Launch | undefined> {
  const saved = await readJson(join(sessionRoot(hub, context.session.id), 'launch.json'));
  if (
    !saved ||
    saved.terminalId !== context.session.terminalId ||
    typeof saved.token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(saved.marker) ||
    !Array.isArray(saved.args)
  ) {
    return undefined;
  }
  const root = await realpath(sessionRoot(hub, context.session.id));
  const expectedGeminiDir = agySessionGeminiDir(dirname(dirname(root)), context.session.id);
  const [savedGeminiReal, expectedGeminiReal] =
    typeof saved.geminiDir === 'string' && expectedGeminiDir
      ? await Promise.all([
          realpath(saved.geminiDir).catch(() => saved.geminiDir),
          realpath(expectedGeminiDir).catch(() => expectedGeminiDir),
        ])
      : [undefined, undefined];
  if (
    saved.root !== root ||
    // The data root recorded when the session was first prepared, compared after symlink resolution.
    !savedGeminiReal ||
    !expectedGeminiReal ||
    savedGeminiReal !== expectedGeminiReal ||
    saved.bridgeDir !== join(root, 'workspace') ||
    typeof saved.command !== 'string' ||
    typeof saved.nonce !== 'string' ||
    !/^[a-f0-9]{48}$/.test(saved.nonce) ||
    !saved.args.includes(`--gemini_dir=${saved.geminiDir}`) ||
    !saved.args.includes(`--csrf_token=${saved.token}`)
  ) {
    return undefined;
  }
  return saved as Launch;
}

async function attachOnce(hub: Hub, host: AgentHost, context: AgentContext): Promise<Runtime | undefined> {
  if (hub.closed) return;
  let epoch = epochOf(hub, context.session.id);
  const existing = hub.runtimes.get(context.session.id);
  if (existing && !existing.stopped) {
    const terminal = await host.terminals.get(existing.launch.terminalId).catch(() => undefined);
    if (terminal?.state !== 'exited') return existing;
    await endOpenTurns(existing);
    detach(hub, context.session.id);
    epoch = epochOf(hub, context.session.id);
  }
  if (!context.session.terminalId || host.view.terminal(context.session.terminalId)?.state === 'exited') return;
  const launch = await readSavedLaunch(hub, context);
  if (!launch) return;
  assertCurrent(hub, context.session.id, epoch);
  const runtime: Runtime = {
    host,
    context,
    launch,
    status: { phase: 'starting', connection: { state: 'reconnecting' } },
    stopped: false,
  };
  hub.runtimes.set(context.session.id, runtime);
  runtime.unbind = host.bindRiffetMcp(context.session.id, metadata => validateMcp(hub, runtime, metadata));
  await refresh(hub, runtime);
  schedule(hub, runtime);
  return runtime;
}

/** The attached runtime after a fresh poll, provided the terminal is the session's conversation and ready for input. */
export async function required(hub: Hub, host: AgentHost, context: AgentContext): Promise<Runtime> {
  const runtime = await attach(hub, host, context);
  if (!runtime) throw host.error('AGY_NOT_RUNNING', 'Open the Antigravity terminal first', 409);
  await refresh(hub, runtime);
  const native = await nativeStatus(runtime);
  const id = host.view.session(context.session.id)?.nativeSessionId;
  // A relaunched agy reports its conversation only once it is up: until then it is not ready, not another conversation.
  if (id && !native?.conversation_id) throw host.error('CLI_BUSY', 'Antigravity is not ready', 409);
  if (id && native!.conversation_id !== id) throw host.error('AGY_IDENTITY_CONFLICT', 'The Antigravity terminal changed conversation', 409);
  if (runtime.conflict || !runtime.rpc || runtime.status.connection?.state !== 'connected') {
    throw host.error('CLI_BUSY', 'Antigravity is not ready', 409);
  }
  return runtime;
}
