import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDiscussionRequest } from '@riffet/plugin-api/experimental/agent';
import { discussionPrompt } from '@riffet/plugin-api/kit';
import type { CodexAppServerClient, CodexAppServerFactory } from '../shared/codex-app-server.js';
import { nativeModelEffort, nativeModelFast, parseNativeModelSelection } from '../shared/model-selection.js';
import type { NativeBackendProfileConfig } from '../types.js';
import { fastServiceTier, listModels, resolveModelSelection } from './catalog.js';
import { assertSupportedProfile, credentialDirFor, executableOf, providerEnv } from './config.js';
import { safeProviderError } from './errors.js';
import { readConfiguredMcpNames } from './extensions.js';
import { traexFlavor } from './flavors.js';
import { newThreadRequest } from './launch.js';
import { str } from './util.js';

/** TRAE's /btw sends a single model request with no tools. The ephemeral thread supplies only our frozen snapshot. */
export async function streamTraeDiscussion(start: CodexAppServerFactory, profile: NativeBackendProfileConfig,
  request: AgentDiscussionRequest, remoteAddress?: string): Promise<void> {
  assertSupportedProfile(profile, traexFlavor);
  request.signal.throwIfAborted();
  const cwd = await mkdtemp(join(tmpdir(), 'riffet-trae-discussion-'));
  const turnId = randomUUID();
  let transport: CodexAppServerClient | undefined, threadId: string | undefined;
  let output = '', finished = false;
  let resolve!: () => void, reject!: (error: Error) => void;
  const answer = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  // Exiting or aborting can precede the native RPC receipts.
  void answer.catch(() => {});
  const stopped = () => reject(request.signal.reason ?? new Error('Side chat cancelled'));
  request.signal.addEventListener('abort', stopped, { once: true });
  try {
    // mkdtemp yielded before the listener was installed. Do not start a new process for a cancelled turn.
    request.signal.throwIfAborted();
    transport = await start({
      executable: executableOf(profile, traexFlavor), cwd, env: providerEnv(profile, traexFlavor),
      args: ['-c', 'check_for_update_on_startup=false', '-c', 'features.plugins=false', '-c', 'features.hooks=false'],
      ...(remoteAddress ? { remoteAddress, credentialDir: credentialDirFor(traexFlavor) } : {}),
      onExit: reject,
      onServerRequest: async () => { throw new Error('Side chats do not handle agent tools'); },
      onNotification(method, params) {
        if (!threadId || params.threadId !== threadId || params.turnId !== turnId || finished || request.signal.aborted) return;
        try {
          if (method === 'turn/btw/delta' && typeof params.delta === 'string') {
            output += params.delta;
            request.onDelta(params.delta);
          } else if (method === 'turn/btw/completed') {
            // Some builds give only the completed answer; an already streamed prefix is published once.
            const final = typeof params.answer === 'string' ? params.answer : undefined;
            if (final !== undefined && !final.startsWith(output)) throw new Error('TRAE returned inconsistent side chat output');
            if (final && final.length > output.length) request.onDelta(final.slice(output.length));
            finished = true;
            resolve();
          } else if (method === 'turn/btw/failed') {
            finished = true;
            reject(new Error(safeProviderError(params.message, profile.config)));
          }
        } catch (error) { reject(error instanceof Error ? error : new Error('Side chat stopped')); }
      },
    });
    const client = transport;
    const ask = async () => {
      request.signal.throwIfAborted();
      const requested = parseNativeModelSelection(request.model || str(profile.config.defaultModel));
      // TRAE publishes its Fast tier id per model. Populate it even when this call follows a server restart.
      if (nativeModelFast(requested) !== undefined) await listModels(client, traexFlavor);
      const selection = await resolveModelSelection(client, traexFlavor, requested);
      const servers = await readConfiguredMcpNames(client, cwd);
      const config: Record<string, unknown> = {
        project_doc_max_bytes: 0, 'features.plugins': false, 'features.hooks': false, 'features.memories': false, 'features.apps': false,
        'skills.bundled.enabled': false, web_search: 'disabled',
      };
      for (const name of servers) {
        if (!/^[\w-]+$/.test(name)) throw new Error('Could not disable all MCP servers for the side chat');
        config[`mcp_servers.${name}.enabled`] = false;
      }
      request.signal.throwIfAborted();
      const result = await client.request<{ thread: { id: string } }>('thread/start', {
        ...newThreadRequest(traexFlavor, cwd, selection, { approvalPolicy: 'never', sandbox: 'read-only' }, config),
        threadSource: 'side', ephemeral: true, environments: [], selectedCapabilityRoots: [], dynamicTools: [],
        baseInstructions: request.system, developerInstructions: '',
      });
      threadId = result.thread.id;
      request.signal.throwIfAborted();
      const effort = nativeModelEffort(selection);
      const tier = fastServiceTier(traexFlavor, selection.model, nativeModelFast(selection));
      const receipt = await client.request<{ turnId: string }>('turn/btw', {
        threadId, turnId, question: discussionPrompt(request.messages), cwd, model: selection.model || null,
        ...(effort && effort !== 'default' ? { effort } : {}), ...(tier ? { serviceTier: tier } : {}),
      });
      if (receipt.turnId !== turnId) throw new Error('TRAE CLI returned a different side question');
      await answer;
    };
    const turn = ask();
    // Fail promptly on disconnect or cancellation. A fast completion still waits for its RPC receipt.
    await Promise.race([turn, answer.then(() => turn)]);
  } finally {
    request.signal.removeEventListener('abort', stopped);
    if (transport && threadId && !finished)
      await transport.request('turn/btw/cancel', { threadId, turnId }, 1000).catch(() => {});
    if (remoteAddress) {
      // Disconnect this observing client alone. The main session's process keeps serving its own thread.
      if (transport && threadId) await transport.request('thread/unsubscribe', { threadId }, 1000).catch(() => {});
      await transport?.detach?.().catch(() => {});
    } else await transport?.dispose().catch(() => {});
    await rm(cwd, { recursive: true, force: true });
  }
}
