import manifest from './riffet-plugin.json';
// Request recorder (README.md): the reference implementation of `runtimeHooks`. A proxy in front of the model gateway a Claude Code
// conversation already uses forwards every request unchanged and records it for that conversation on the server.

import { join } from 'node:path';
import { type ActivationScope, type Plugin, type PluginHost, type RuntimeAttachment, type RuntimeContext, type RuntimeControl } from '@riffet/plugin-api';
import { recorderPage } from './page.js';
import { prepareRecorder, recoverRecorder, type RecorderHandle, type Status } from './process.js';
import { Recordings } from './recorder.js';

const DEFAULT_UPSTREAM = 'https://api.anthropic.com';

/** The gateway this conversation's CLI would use: the profile's endpoint, else the environment's, else the vendor's. */
export function resolveUpstream(profileConfig: Readonly<Record<string, unknown>>, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const typed = typeof profileConfig.apiEndpoint === 'string' ? profileConfig.apiEndpoint.trim() : '';
  const candidate = typed || env.ANTHROPIC_BASE_URL?.trim() || DEFAULT_UPSTREAM;
  try {
    const url = new URL(candidate);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.toString() : undefined;
  } catch { return undefined; }
}

const text = (zh: string, en: string) => ({ 'zh-Hans': zh, en });

function controlFor(status: Status): RuntimeControl {
  const count = text(`${status.count} 条`, `${status.count} requests`);
  return {
    revision: status.paused ? 'paused' : 'recording',
    ...(status.paused ? { notice: { tone: 'neutral' as const, label: text('已暂停记录', 'Recording paused') } } : {}),
    actions: [{ id: status.paused ? 'resume' : 'pause', label: status.paused ? text('继续记录', 'Resume recording') : text('暂停记录', 'Pause recording'), hint: count }],
  };
}

function attachment(handle: RecorderHandle, state: { status: Status }, host: PluginHost, scope: ActivationScope, held: Set<RecorderHandle>): RuntimeAttachment {
  return {
    id: handle.id,
    launchEnv: { ANTHROPIC_BASE_URL: handle.baseUrl },
    control: () => controlFor(state.status),
    async act({ action, revision }) {
      if (scope.signal.aborted) throw host.error('RUNTIME_CONTROL_UNAVAILABLE', 'Request recording is turned off', 503);
      if (action !== 'pause' && action !== 'resume') throw host.error('INVALID_RUNTIME_CONTROL', 'Unknown action', 400);
      if (revision !== (state.status.paused ? 'paused' : 'recording')) throw host.error('RUNTIME_CONTROL_CHANGED', 'The recording state changed; try again', 409);
      try { await handle.setPaused(action === 'pause'); } catch { throw host.error('RUNTIME_CONTROL_UNAVAILABLE', 'The recorder cannot be reached right now', 503); }
    },
    bindNative: input => handle.bindNative(input),
    detach() { held.delete(handle); handle.detach(); },
    async stop() { held.delete(handle); await handle.stop(); },
  };
}

export const requestRecorder: Plugin = {
  manifest: manifest as Plugin['manifest'],
  activate(host, scope) {
    const held = new Set<RecorderHandle>();
    // The CLI and its proxy outlive turning this off: the activation only stops observing.
    scope.onDispose(() => { for (const handle of [...held]) handle.detach(); });
    let store: Promise<Recordings> | undefined;
    const recordings = () => store ??= host.stateDir().then(dir => new Recordings(join(dir, 'recordings')));
    void recordings().then(value => value.enforce()).catch(() => undefined);
    const track = (context: RuntimeContext, initial: Status) => {
      const state = { status: initial, live: false };
      return { state, onStatus: (status: Status) => { state.status = status; if (state.live) context.onChange(); } };
    };
    return {
      page: recorderPage(host, recordings),
      runtimeHooks: [{
        backendId: 'claude',
        async prepare(context) {
          if (scope.signal.aborted) return undefined;
          const upstream = resolveUpstream(context.profileConfig);
          if (!upstream) return undefined;
          const { state, onStatus } = track(context, { paused: false, count: 0 });
          const handle = await prepareRecorder({ ...context, directory: join(context.directory, 'request-recorder'), upstream, recordDir: (await recordings()).root, onStatus });
          if (scope.signal.aborted) { await handle.stop(); return undefined; }
          held.add(handle);
          state.live = true;
          return attachment(handle, state, host, scope, held);
        },
        async recover(context) {
          if (scope.signal.aborted) return undefined;
          const { state, onStatus } = track(context, { paused: false, count: 0 });
          const handle = await recoverRecorder({ ...context, directory: join(context.directory, 'request-recorder'), onStatus });
          if (!handle) return undefined;
          state.status = handle.status();
          if (scope.signal.aborted) { handle.detach(); return undefined; }
          held.add(handle);
          state.live = true;
          return attachment(handle, state, host, scope, held);
        },
      }],
    };
  },
};

export default requestRecorder;
