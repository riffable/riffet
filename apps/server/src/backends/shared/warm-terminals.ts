import type { AgentReservation, AgentTerminals } from '@riffet/plugin-api/experimental/agent';
import type { WarmupTerminalInfo } from '../../terminal/service.js';
import { warmupOf } from '../../terminal/service.js';
import type { NativeBackendHost } from '../types.js';
import type { NativeBackendId } from '../../../../../packages/contracts/src/index.js';

export type WarmTerminals = Pick<AgentTerminals, 'reserve' | 'observe' | 'screen' | 'extendReservation' | 'releaseReservation'>;

const reservationOf = (info: WarmupTerminalInfo): AgentReservation => {
  const warmup = warmupOf(info);
  return { terminal: { id: info.id, epoch: info.epoch, state: info.state }, ownerToken: warmup.ownerToken, resourceKey: warmup.resourceKey, nativeSessionId: warmup.nativeSessionId, expiresAt: warmup.expiresAt };
};

/**
 * The host's reserved terminals in the shape the plugin kit's warm-pool helpers take (`reserveWarmTerminal`,
 * `terminalWarmOptions`), for an Agent built into the server; a plugin's Agent gets the same through its port.
 */
export function warmTerminals(host: NativeBackendHost, backendId: NativeBackendId): WarmTerminals {
  return {
    reserve: async request => reservationOf(await host.terminal.createWarmup(host.getProject(request.projectId), {
      kind: request.spec.kind ?? 'native', ...(request.spec.title ? { title: request.spec.title } : {}), ...(request.appearance ? { appearance: request.appearance } : {}),
      launchSpec: { command: request.spec.command, args: [...request.spec.args], ...(request.spec.env ? { env: request.spec.env } : {}), ...(request.spec.secretEnv ? { secretEnv: request.spec.secretEnv } : {}), cwd: request.spec.cwd },
      warmup: { ownerToken: request.ownerToken, resourceKey: request.resourceKey, nativeSessionId: request.nativeSessionId, expiresAt: request.expiresAt, backendId },
    })),
    observe: (terminalId, callback) => host.terminal.observe(terminalId, observation => { if (observation.type !== 'state') callback(observation); }),
    screen: terminalId => host.terminal.screen(terminalId),
    extendReservation: async (terminalId, extension) => reservationOf(await host.terminal.extendWarmup(terminalId, extension)),
    releaseReservation: (terminalId, ownerToken) => host.terminal.stopWarmup(terminalId, ownerToken),
  };
}
