import type { IncomingHttpHeaders } from 'node:http';
import type { Session } from '../../../../packages/contracts/src/index.js';
import type { SessionLock } from '../agent-host/session-lock.js';
import type { NativeBackendService } from '../backends/service.js';
import { AppError, sessionInTerminal } from '../errors.js';
import type { SessionCommands } from '../orchestration/session-commands.js';
import type { Store } from '../store.js';
import { recordTerminalAppearance } from '../terminal/appearance.js';
import type { NativeDispatcher } from './dispatch.js';

export interface NativeConfigurePatch { model?: string; mode?: string; approval?: string; backendProfileId?: string }

export interface ConfigureNativeDeps {
  store: Store;
  dispatch: NativeDispatcher;
  sessionLock: SessionLock;
  sessionCommands: SessionCommands;
  nativeBackends: NativeBackendService;
}

/** Changes a conversation's model, mode, permission or profile; shared by the Web route and the channels. */
export async function configureNative(deps: ConfigureNativeDeps, id: string, patch: NativeConfigurePatch, headers?: IncomingHttpHeaders): Promise<Session> {
  const { store, dispatch, sessionLock, sessionCommands, nativeBackends } = deps;
  // A terminal drives the conversation; a new model or mode here would reach the thread under it (Codex) or wait for a launch that is refused.
  if (store.getSession(id).terminalHold) throw sessionInTerminal();
  // Configuration can relaunch an idle CLI. Reserve synchronously before waiting on its lock;
  // shared reservations preserve the existing ordered queue of same-session setting changes.
  const release = dispatch.reserveSessionStart(id, { shared: true });
  try {
    return await sessionLock.withSession(id, async () => {
      // Again under the lock: a hold taken while this waited is the terminal's conversation now.
      if (store.getSession(id).terminalHold) throw sessionInTerminal();
      const configured = sessionCommands.beginConfigure(id);
      try {
        // No "is a message in flight?" gate any more: a backend that cannot apply a change without
        // disturbing a running turn records it and applies it at the next idle moment (terminal-based
        // backends relaunch their CLI; DSH applies one in place), so the switch is queued rather than
        // refused — which is what the picker in the composer now offers.
        const session = recordTerminalAppearance(store, id, headers), capabilities = await nativeBackends.capabilities(session);
        if (patch.model !== undefined && !capabilities.supportsModelSelection) throw new AppError('NATIVE_MODEL_UNSUPPORTED', 'This backend does not support model selection', 409);
        if (patch.mode !== undefined && (!capabilities.supportsModeSelection || !capabilities.modes.some(item => item.id === patch.mode))) throw new AppError('INVALID_MODE', 'Choose a mode supported by this backend');
        if (patch.approval !== undefined && (!capabilities.supportsPermissionSelection || !capabilities.permissions.some(item => item.id === patch.approval))) throw new AppError('INVALID_APPROVAL_MODE', 'Choose a permission setting supported by this backend');
        return await nativeBackends.configure(session, patch);
      } finally { configured(); }
    });
  } finally { release(); }
}
