import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { BuildInfo } from '../../../../packages/contracts/src/index.js';
import { isNpmInstall, npmInstaller } from '../update/npm.js';
import { availableTag, claimBackgroundCheck, markUpdateDeclined, readCachedCheck, refreshCachedCheck, wasUpdateDeclined } from '../update/status.js';
import { SERVER_BUILD, SOURCE_ROOT } from '../version.js';
import { active, entry, health, installRoot, ownsPid, type Health } from './context.js';
import { serviceRunsThis } from './service.js';
import { Cancelled, MARK, err, interactive } from './ui.js';

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

function canAutoUpdateSource(stateDir: string, running: BuildInfo): boolean {
  if (readCachedCheck(stateDir, running)?.check.source?.dirty) return false;
  for (const candidate of [installRoot, SOURCE_ROOT]) {
    if (!candidate) continue;
    try {
      if (JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8')).name !== 'riffet') continue;
      const root = realpathSync(candidate);
      return existsSync(join(root, '.git')) && realpathSync(entry) === realpathSync(join(root, 'dist/cli.js')) && !existsSync(join(root, '.riffet/update.lock'));
    } catch { /* next */ }
  }
  return false;
}

async function askYesNo(prompt: string): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const ac = new AbortController();
  let interrupted = false;
  const onSigint = () => { interrupted = true; ac.abort(); };
  const onClose = () => { ac.abort(); };
  rl.on('SIGINT', onSigint);
  rl.once('close', onClose);
  try {
    const answer = await rl.question(prompt, { signal: ac.signal });
    return /^y(?:es)?$/i.test(answer.trim());
  } catch (error) {
    if (interrupted) { process.stderr.write('\n'); throw new Cancelled(); }
    if ((error as NodeJS.ErrnoException)?.code === 'ABORT_ERR' || (error as NodeJS.ErrnoException)?.code === 'ERR_USE_AFTER_CLOSE') return false;
    throw error;
  } finally {
    rl.off('SIGINT', onSigint);
    rl.off('close', onClose);
    rl.close();
  }
}

/**
 * Asks whether to install a known update before running an interactive entry command. Only prompts when
 * an update is cached, the terminal is interactive and this installation can actually run `update`.
 */
export async function promptForUpdate(stateDir: string, options: { requireActive?: boolean } = {}): Promise<boolean> {
  if (!interactive() || !process.stderr.isTTY || entry.endsWith('.ts')) return false;
  const record = await active(stateDir);
  if (options.requireActive && !record) return false;
  let state: Health | undefined;
  if (record) {
    if (!ownsPid(record)) return false;
    state = await health(record);
    if (state?.managedBy === 'app') return false;
    if (state?.managedBy === 'launchd') {
      let runsThis = false;
      try { runsThis = serviceRunsThis(stateDir); } catch { /* missing service file */ }
      if (!runsThis) return false;
    }
  }
  const running = state?.build ?? SERVER_BUILD;
  const target = availableUpdate(stateDir, running);
  if (!target || wasUpdateDeclined(stateDir, target)) return false;

  if (isNpmInstall()) {
    try { if (!npmInstaller(target.replace(/^v/, '')).writable) return false; } catch { return false; }
  } else if (!canAutoUpdateSource(stateDir, running)) {
    return false;
  }

  const from = running.tag && !running.dirty ? running.tag : `v${running.version}`;
  process.stderr.write(`${err.accent(MARK.running)} Riffet update available: ${err.dim(from)} ${MARK.arrow} ${err.accent(target)}\n`);
  const accepted = await askYesNo('Update now? [y/N] ');
  if (!accepted) markUpdateDeclined(stateDir, target);
  return accepted;
}

/** Runs the original command on the newly installed CLI after an accepted interactive update. */
export function relaunchAfterUpdate(args: string[]): number {
  const result = spawnSync(process.execPath, [...process.execArgv, entry, ...args], {
    stdio: 'inherit',
    env: { ...process.env, RIFFET_NO_UPDATE_NOTIFIER: '1' },
  });
  return result.status ?? (result.signal ? 128 : 1);
}
