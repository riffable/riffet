import { spawn } from 'node:child_process';
import type { BuildInfo } from '../../../../packages/contracts/src/index.js';
import { availableTag, claimBackgroundCheck, readCachedCheck, refreshCachedCheck } from '../update/status.js';
import { SERVER_BUILD } from '../version.js';
import { entry } from './context.js';

/*
 * "A newer release is out", as `status` and the start summary show it. The answer is the one the server
 * and every client share (update/status.ts); a command never waits for the network to learn it. When
 * the shared answer is due again, a detached `riffet __update-check` refreshes it for next time.
 * RIFFET_NO_UPDATE_NOTIFIER=1 turns the notice off.
 */

const disabled = () => /^(?:1|true|yes)$/i.test(process.env.RIFFET_NO_UPDATE_NOTIFIER ?? '') || Boolean(process.env.CI);
const label = (build: BuildInfo) => build.tag ?? build.version;

/**
 * The release newer than `running` (the server's build), if the last check found one. This CLI checks
 * in the background only for its own build: right after an update, before the restart, the server's
 * build is the older one and the server refreshes its own answer.
 */
export function availableUpdate(stateDir: string, running: BuildInfo = SERVER_BUILD): string | undefined {
  if (disabled()) return undefined;
  const cached = readCachedCheck(stateDir, running);
  // Out of band: the user does not wait for the network, and a failure leaves no trace.
  if ((!cached || cached.stale) && label(running) === label(SERVER_BUILD) && claimBackgroundCheck(stateDir)) {
    spawn(process.execPath, [...process.execArgv, entry, '__update-check', '--state-dir', stateDir], { detached: true, stdio: 'ignore' })
      .on('error', () => undefined).unref();
  }
  return availableTag(cached?.check);
}

/** `riffet __update-check`: one lookup, written for everyone to read. */
export async function refreshUpdateCheck(stateDir: string): Promise<void> {
  await refreshCachedCheck(stateDir);
}
