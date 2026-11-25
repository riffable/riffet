import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { AgentDiscussionRequest } from '@riffet/plugin-api/experimental/agent';
import { discussionPrompt } from '@riffet/plugin-api/kit';
import type { NativeBackendProfileConfig } from '../types.js';
import { waitForExit } from '../shared/child-process.js';
import { droidProjectSessionDir } from './history.js';
import { isHiddenMessage, messageFromProtocol } from './events.js';
import { DroidRpcClient } from './rpc.js';
import { confirmDroidSettings, desiredSettings, droidSettingsOverlay, readSettings, record, spawnDroid, START_TIMEOUT_MS, str } from './runtime-shared.js';

/** A fresh RPC session is fenced before receiving the discussion. An empty Droid allowlist means its defaults. */
export async function streamDroidDiscussion(profile: NativeBackendProfileConfig, request: AgentDiscussionRequest): Promise<void> {
  request.signal.throwIfAborted();
  if (!request.model) throw new Error('The original Droid model is unavailable for this side chat');
  const cwd = await mkdtemp(join(tmpdir(), 'riffet-droid-discussion-'));
  const factoryHome = resolve(cwd, process.env.FACTORY_HOME_OVERRIDE || homedir());
  const sessionDir = droidProjectSessionDir(cwd, join(factoryHome, '.factory', 'sessions'));
  let ownsSessionDir = false;
  try {
    // Droid flattens the cwd into one name. Claim that directory exclusively before launching or cleaning it.
    await mkdir(dirname(sessionDir), { recursive: true, mode: 0o700 });
    await mkdir(sessionDir, { mode: 0o700 });
    ownsSessionDir = true;
    const desired = desiredSettings(profile, { model: request.model });
    const settingsFile = join(cwd, 'settings.json');
    await writeFile(settingsFile, JSON.stringify({
      ...droidSettingsOverlay(desired), hooks: { hooksDisabled: true }, cloudSessionSync: false, ideAutoConnect: false,
    }), { mode: 0o600 });
    request.signal.throwIfAborted();
    const group = process.platform !== 'win32';
    const child = spawnDroid(profile, cwd, settingsFile, group);
    child.stderr!.resume();
    let complete!: () => void;
    let fail!: (error: unknown) => void;
    const done = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
    void done.catch(() => {}); // A disconnect can precede the answer to initialize_session.
    let pinnedModel = desired.modelId;
    let streamed = false;
    const rpc = new DroidRpcClient(child.stdin!, child.stdout!, {
      onRequest: async method => method === 'droid.ask_user' ? { cancelled: true, answers: [] } : { selectedOption: 'cancel' },
      onClose: fail,
      onNotification(event) {
        try {
          if (event.type === 'settings_updated') {
            const current = readSettings(event.settings);
            if (current.modelId && pinnedModel && current.modelId !== pinnedModel) throw new Error('Droid switched the side chat model');
          } else if (event.type === 'assistant_text_delta' && typeof event.textDelta === 'string' && event.textDelta) {
            streamed = true;
            request.onDelta(event.textDelta);
          } else if (event.type === 'create_message' && !streamed) {
            const message = messageFromProtocol(event.message);
            if (message?.role === 'assistant' && !isHiddenMessage(message)) {
              for (const item of message.content) {
                const block = record(item);
                if (block?.type === 'text' && typeof block.text === 'string') request.onDelta(block.text);
              }
            }
          } else if (event.type === 'agent_turn_completed') {
            if (event.reason && event.reason !== 'completed') throw new Error(`Droid ended the side chat with ${event.reason}`);
            complete();
          }
        } catch (error) { rpc.close(error instanceof Error ? error : new Error(String(error))); }
      },
    });
    child.once('error', error => rpc.close(error));
    child.once('close', () => rpc.close(new Error('Droid closed the side chat')));
    const abort = () => rpc.close(new Error('Droid side chat cancelled', { cause: request.signal.reason }));
    request.signal.addEventListener('abort', abort, { once: true });
    try {
      request.signal.throwIfAborted();
      const { settings } = await rpc.request<{ settings: Record<string, unknown> }>('droid.initialize_session', {
        machineId: hostname(), cwd, title: 'Side chat', ...desired, systemPrompt: request.system, autoRejectPermissionRequests: true,
        disableBuiltinSkills: true, restrictToolIds: ['read-cli'], disabledToolIds: ['read-cli'],
      }, { timeoutMs: START_TIMEOUT_MS });
      const reported = readSettings(settings);
      confirmDroidSettings(reported, desired);
      pinnedModel ??= reported.modelId;
      // Pin the only candidate tool and deny it. Both lists stay in force when MCP tools refresh.
      const onlyRead = (value: unknown) => Array.isArray(value) && value.length === 1 && value[0] === 'read-cli';
      if (settings.systemPrompt !== request.system) throw new Error('Droid did not confirm the side chat instructions');
      if (!onlyRead(settings.restrictToolIds) || !onlyRead(settings.disabledToolIds)) throw new Error('Droid did not confirm the side chat tool restrictions');
      const { tools } = await rpc.request<{ tools: unknown[] }>('droid.list_tools', {});
      if (!Array.isArray(tools) || tools.some(tool => record(tool)?.currentlyAllowed !== false)) throw new Error('Droid could not confirm that all tools are disabled');
      request.signal.throwIfAborted();
      await rpc.request('droid.add_user_message', { text: discussionPrompt(request.messages) });
      await done;
    } finally {
      request.signal.removeEventListener('abort', abort);
      rpc.close();
      child.stdin!.end();
      const kill = (signal: NodeJS.Signals) => {
        try { if (group && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* already exited */ }
      };
      kill('SIGTERM');
      const exited = await waitForExit(child, 2_000);
      // A wrapper can exit on TERM before a child in its dedicated process group.
      if (group || !exited) kill('SIGKILL');
      if (!exited) await waitForExit(child, 2_000);
    }
  } finally {
    try { if (ownsSessionDir) await rm(sessionDir, { force: true, recursive: true }); }
    finally { await rm(cwd, { force: true, recursive: true }); }
  }
}
