import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { BuildInfo, ReleaseTag, UpdateCheck } from '../../../../packages/contracts/src/index.js';
import { runProcess } from '../git/exec.js';
import { xmlEscape, systemdValue } from '../service-files.js';
import { COMPACTION_WAIT_MS, compactionRunning } from '../storage/compaction.js';
import { checkForUpdates } from '../update/git.js';
import { OFFICIAL_NPM_REGISTRY, displayRegistry, inspectNpmUpdate, isMissingNpmTargetOutput, isNpmInstall, npmInstaller } from '../update/npm.js';
import { writeCachedCheck } from '../update/status.js';
import { SERVER_BUILD, SOURCE_ROOT } from '../version.js';
import { APP_MANAGED_HINT, accessToken, active, appAgentLoaded, entry, installRoot, ownsPid, pidExists, readDaemon, serverUrl, stateDir, type DaemonRecord, type Health } from './context.js';
import { drainForRestart } from './drain.js';
import { restartWaitSeconds, type RestartWaitOptions } from './launch.js';
import { LAUNCH_AGENT_LABEL, LAUNCH_AGENT_PATH, SYSTEMD_UNIT, serviceFile, serviceRunsThis } from './service.js';
import { readAppInstallation, runSourceUpdate, shellQuote } from './source-update.js';
import { CliError, MARK, UsageError, duration, err, fields, hint, note, out, printJson, printLines, spinner, success, tilde } from './ui.js';

export interface UpdateOptions extends RestartWaitOptions { stateDir: string; check?: boolean; json?: boolean; app?: boolean; configuration?: string }

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const buildLabel = (build: BuildInfo) => build.tag && !build.dirty ? build.tag : `${build.version} ${out.dim(`dev ${build.commit?.slice(0, 7) ?? ''}${build.dirty ? '+' : ''}`.trimEnd())}`;

function updateRoot(): string {
  // Prefer the checkout containing this CLI: it remains correct if a clone was moved.
  for (const candidate of [installRoot, SOURCE_ROOT]) {
    if (!candidate) continue;
    try { if (JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8')).name === 'riffet') return realpathSync(candidate); } catch { /* next */ }
  }
  throw new CliError('Could not find the Riffet checkout this command belongs to', ['Run `riffet update` from a build of the checkout you want to update']);
}

async function verifiedHealth(record: DaemonRecord): Promise<Health> {
  const response = await fetch(serverUrl(record) + '/health', { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new CliError('Could not check the running server');
  const health = await response.json() as Health;
  if (!health.ok || health.instanceId !== record.instanceId) throw new CliError('The running server does not match daemon.json; nothing was updated', ['riffet status']);
  return health;
}

/** Read-only SQLite access does not create stores, run migrations or start a backend. */
function assertIdle(dir: string): void {
  const path = join(dir, 'workbench.db');
  if (!existsSync(path)) throw new CliError('Could not check for running conversations; the server was not stopped');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE json_extract(json,'$.state') IN ('starting','running','waiting','cancelling')").get() as { count: number };
    if (row.count > 0) throw new CliError(`${row.count} conversations are running or waiting for you`, ['Let them finish, then `riffet update` again']);
  } finally { db.close(); }
}

const STATUS_TEXT: Record<UpdateCheck['status'], string> = {
  available: 'A newer release is available',
  current: 'Up to date',
  ahead: 'Newer than the latest release; not downgrading',
  development: 'Development build; update the checkout yourself',
  unavailable: 'Could not check for updates',
  'no-releases': 'No releases are published yet',
  conflict: 'The release tag changed upstream; check it by hand',
};

function printCheck(current: BuildInfo, result: UpdateCheck, what: string): void {
  const tone = result.status === 'available' ? out.accent : result.status === 'current' ? out.ok : result.status === 'unavailable' || result.status === 'conflict' ? out.fail : out.warn;
  const lines = [
    `${tone(result.status === 'current' ? MARK.ok : MARK.running)} ${out.bold(STATUS_TEXT[result.status])}`,
    '',
    ...fields([
      [what, buildLabel(current)],
      ['Latest', result.latest?.tag ? out.bold(result.latest.tag) : result.latestVersion ? out.bold(`v${result.latestVersion}`) : out.dim('unknown')],
      ['Checkout', result.source ? `${result.source.tag ?? result.source.commit?.slice(0, 12) ?? 'unknown'}${result.source.dirty ? out.warn(' · local changes') : ''}` : undefined],
    ]),
  ];
  if (result.message && (result.status === 'unavailable' || result.status === 'conflict')) lines.push('', `  ${out.dim(result.message)}`);
  if (result.latest && result.source?.commit === result.latest.commit && current.commit !== result.latest.commit) lines.push('', hint('The checkout is updated but not built; `pnpm build`, then `riffet restart`', out));
  else if (result.status === 'available') lines.push('', hint('riffet update', out));
  printLines(lines);
}

/** Waits until the server on `dir` is a new instance reporting `version`. */
async function waitForVersion(dir: string, previous: DaemonRecord, version: string): Promise<boolean> {
  for (let attempt = 0; attempt < 150; attempt++) {
    const next = readDaemon(dir);
    if (next && next.instanceId !== previous.instanceId) {
      try { if ((await verifiedHealth(next)).version === version) return true; } catch { /* still starting */ }
    }
    await sleep(200);
  }
  return false;
}

/**
 * An npm install: the package manager that installed Riffet replaces it with the newer release while the
 * server keeps running (its code is already loaded), then the server restarts on the new files, waiting for
 * running turns the same way `riffet restart` does. What is compared with the registry is the running
 * server's version, so a run after an install whose restart failed finishes the restart.
 */
async function updateNpm(options: UpdateOptions, dir: string, waitSeconds: number): Promise<void> {
  if (options.app || options.configuration) throw new UsageError('--app only applies to an App built from a source checkout');
  const record = await active(dir);
  let health: Health | undefined;
  if (record) {
    try { health = await verifiedHealth(record); }
    catch (error) { if (!options.check) throw error; }
  }
  const running = health?.build ?? SERVER_BUILD;
  const checking = options.json ? undefined : spinner('Checking npm for a newer release');
  let inspected: Awaited<ReturnType<typeof inspectNpmUpdate>>;
  let result: UpdateCheck;
  try {
    inspected = await inspectNpmUpdate(running);
    result = writeCachedCheck(dir, inspected.check);
  } finally { checking?.stop(); }
  if (options.check) {
    if (options.json) printJson(result); else printCheck(running, result, health ? 'Running' : 'Installed');
    if (result.status === 'unavailable') process.exitCode = 1;
    return;
  }
  if (result.status === 'unavailable') throw new CliError(result.message ?? 'Could not check npm for a newer release');
  if (result.status !== 'available' || !result.latestVersion) { success(`Already on the latest release ${out.dim(`v${running.version}`)}`); return; }
  const target = result.latestVersion;
  // The same guards as a source update, before anything is installed.
  if (health?.managedBy === 'app') throw new CliError('This server is run by Riffet.app, which updates itself', [APP_MANAGED_HINT]);
  if (record && !ownsPid(record)) throw new CliError('The server on this state directory comes from another installation; this one cannot update it', ['riffet status']);
  if (health?.managedBy === 'launchd' && !serviceRunsThis(dir)) throw new CliError('The login service runs another installation or state directory; nothing was changed', ['riffet service status']);

  const installer = npmInstaller(target, undefined, inspected.registry);
  const rollback = `\`${[installer.command, ...npmInstaller(running.version).args].join(' ')}\``;
  process.stderr.write(`Updating v${running.version} ${MARK.arrow} ${err.accent(`v${target}`)}\n`);
  // Installed earlier, but the server still runs the old version: only the restart is left.
  if (SERVER_BUILD.version !== target) {
    if (!installer.writable) throw new CliError(`${tilde(installer.root)} is not writable by you, so ${installer.manager} cannot replace it`, [`\`sudo ${[installer.command, ...installer.args].join(' ')}\`, then \`riffet restart\``]);
    const began = Date.now();
    const runInstall = async (activeInstaller: ReturnType<typeof npmInstaller>, label: string) => {
      const installing = spinner(label);
      try { return await runProcess(activeInstaller.command, activeInstaller.args, { cwd: dir, timeoutMs: 10 * 60_000 }); }
      finally { installing.stop(); }
    };
    let installed = await runInstall(
      installer,
      `Installing riffet@${target} with ${installer.manager}${inspected.registry ? ` (${displayRegistry(inspected.registry)})` : ''}`,
    );
    if ((installed.code !== 0 || installed.timedOut) && inspected.registry !== OFFICIAL_NPM_REGISTRY && isMissingNpmTargetOutput(`${installed.stderr}\n${installed.stdout}`)) {
      const fallback = npmInstaller(target, undefined, OFFICIAL_NPM_REGISTRY);
      installed = await runInstall(fallback, `Mirror does not carry riffet@${target} yet; installing from ${OFFICIAL_NPM_REGISTRY}`);
    }
    if (installed.code !== 0 || installed.timedOut) {
      const tail = `${installed.stderr || installed.stdout}`.trim().split('\n').slice(-8).join('\n');
      throw new CliError(`${installer.manager} could not install riffet@${target}${tail ? '\n' + err.dim(tail) : ''}`, ['Nothing was restarted; Riffet keeps running the current version']);
    }
    process.stderr.write(`${err.ok(MARK.ok)} Installed riffet@${target} ${err.dim(`(${duration(Date.now() - began)})`)}\n`);
  }

  if (!record) { success(`Updated to v${target} ${out.dim('· Riffet was not running')}`); return; }
  // The new files restart the server: launchd or systemd restart their own service, otherwise the new CLI does.
  if (health?.managedBy === 'launchd') {
    const release = waitSeconds > 0 ? await drainForRestart(record, accessToken(dir), { waitSeconds, log: note }) : undefined;
    try {
      // A server without the drain endpoints: refuse while any conversation is active, as a source update does.
      if (waitSeconds > 0 && !release) assertIdle(dir);
      const restarted = await runProcess(process.platform === 'darwin' ? '/bin/launchctl' : 'systemctl', process.platform === 'darwin'
        ? ['kickstart', '-k', `gui/${process.getuid!()}/${LAUNCH_AGENT_LABEL}`] : ['--user', 'restart', SYSTEMD_UNIT], { cwd: dir, timeoutMs: 30_000 });
      if (restarted.code !== 0) throw new CliError('The login service did not restart; the new version is installed', ['riffet service status', 'riffet update']);
    } catch (error) { await release?.(); throw error; }
  } else {
    const restarted = await runProcess(process.execPath, [join(installer.root, 'dist/cli.js'), 'restart', '--state-dir', dir, ...(options.force ? ['--force'] : options.waitIdle !== undefined ? ['--wait-idle', options.waitIdle] : [])], { cwd: dir, timeoutMs: COMPACTION_WAIT_MS + (waitSeconds + 60) * 1000 });
    if (restarted.code !== 0) throw new CliError('Riffet did not restart on the new version; the new version is installed', ['riffet update', `To go back: ${rollback}, then \`riffet restart\``]);
  }
  const confirming = spinner('Waiting for the new version to answer');
  let ready = false;
  try { ready = await waitForVersion(dir, record, target); } finally { confirming.stop(); }
  if (!ready) throw new CliError(`The restarted server does not report v${target}`, ['riffet status', `To go back: ${rollback}, then \`riffet restart\``]);
  success(`Riffet v${target} is running`);
}

export async function update(options: UpdateOptions): Promise<void> {
  if (options.json && !options.check) throw new UsageError('--json only works with --check');
  if (options.configuration && !options.app) throw new UsageError('--configuration only works with --app');
  const waitSeconds = restartWaitSeconds(options);
  const dir = stateDir(options.stateDir);
  if (isNpmInstall()) return updateNpm(options, dir, waitSeconds);
  const root = updateRoot();
  const record = await active(dir);
  let health: Health | undefined;
  if (record) {
    try { health = await verifiedHealth(record); }
    catch (error) { if (!options.check) throw error; }
  }
  const app = options.app ? readAppInstallation(root, options.configuration) : undefined;
  const current = app?.build ?? (record ? health?.build ?? { version: health?.version ?? 'unknown', buildNumber: 0, tag: null, commit: null, dirty: true } : SERVER_BUILD);
  if (options.check) {
    const checking = options.json ? undefined : spinner('Checking for a newer release');
    let result: UpdateCheck;
    try { result = await checkForUpdates({ root, current }); } finally { checking?.stop(); }
    // The running server's own answer is what everyone else reads; a check of the App's build is not.
    if (!options.app) writeCachedCheck(dir, result);
    if (options.json) printJson(result); else printCheck(current, result, options.app ? 'App' : record ? 'Running' : 'Installed');
    if (result.status === 'unavailable' || result.status === 'conflict') process.exitCode = 1;
    return;
  }
  if (entry.endsWith('.ts') || realpathSync(entry) !== realpathSync(join(root, 'dist/cli.js'))) {
    throw new CliError('Updating only works from the checkout\'s own build; this copy can only check', ['riffet update --check']);
  }
  if (record && options.app && ownsPid(record)) throw new CliError('A server from this checkout is running', ['riffet stop', 'Quit Riffet.app, then `riffet update --app` again']);
  if (record && !options.app) {
    if (health?.managedBy === 'app') throw new CliError('This server is run by Riffet.app', ['riffet update --app', APP_MANAGED_HINT]);
    if (!ownsPid(record)) throw new CliError('The server on this state directory comes from another installation; this checkout cannot update it');
    if (health?.managedBy !== 'cli' && health?.managedBy !== 'launchd') throw new CliError('Could not tell how this server was started', ['riffet stop', 'Then `riffet update` again']);
  }
  const manager = record && !options.app ? health!.managedBy : undefined;
  const controller = async (args: string[]) => {
    const executable = process.platform === 'darwin' ? '/bin/launchctl' : 'systemctl';
    const result = await runProcess(executable, args, { cwd: root, timeoutMs: 30_000 });
    if (result.code !== 0 || result.timedOut || result.truncated) throw new CliError(`${executable} ${args[0]} failed; the update did not finish`, ['riffet service status']);
  };
  const domain = process.platform === 'darwin' ? `gui/${process.getuid!()}` : '';
  if (manager === 'launchd' && !serviceRunsThis(dir)) throw new CliError('The login service runs another checkout or state directory; nothing was stopped', ['riffet service status']);
  if (manager !== 'launchd' && existsSync(serviceFile()) && readFileSync(serviceFile(), 'utf8').includes(process.platform === 'darwin' ? xmlEscape(entry) : systemdValue(entry))) {
    const running = await runProcess(process.platform === 'darwin' ? '/bin/launchctl' : 'systemctl', process.platform === 'darwin'
      ? ['print', `${domain}/${LAUNCH_AGENT_LABEL}`] : ['--user', 'is-active', SYSTEMD_UNIT], { cwd: root });
    if (running.code === 0 || running.stdout.trim() === 'activating') throw new CliError('The login service is loaded but no server answers for it', ['Stop it with `riffet service uninstall` or your service manager, then update']);
    if (running.timedOut || running.truncated || running.code === null) throw new CliError('Could not check the login service', ['riffet service status']);
  }
  const recoveryCommand = options.app
    ? 'Rebuild and open the App; it restarts its own server.'
    : manager === 'launchd'
      ? process.platform === 'darwin' ? `launchctl bootstrap ${shellQuote(domain)} ${shellQuote(LAUNCH_AGENT_PATH)}` : `systemctl --user start ${SYSTEMD_UNIT}`
      : `${shellQuote(process.execPath)} ${shellQuote(join(root, 'dist/cli.js'))} start --state-dir ${shellQuote(dir)}`;
  await runSourceUpdate({
    root, current, app: options.app, configuration: options.configuration, runningPid: options.app ? undefined : record?.pid,
    lifecycle: {
      recoveryCommand,
      stop: async () => {
        if (appAgentLoaded()) throw new CliError('Riffet.app\'s server is still registered', [APP_MANAGED_HINT]);
        if (options.app || !record) return;
        await verifiedHealth(record);
        // Turns of Claude, Cursor, Codex and Traex outlive the restart; only the ones it would end are waited for.
        // `--force` / `--wait-idle 0` stop without waiting, as `riffet restart` does; a service without the drain
        // endpoints falls back to refusing while any session is active.
        const release = waitSeconds > 0 ? await drainForRestart(record, accessToken(dir), { waitSeconds }) : undefined;
        try {
          if (waitSeconds > 0 && !release) assertIdle(dir);
          if (manager === 'launchd') await controller(process.platform === 'darwin' ? ['bootout', domain, LAUNCH_AGENT_PATH] : ['--user', 'stop', SYSTEMD_UNIT]);
          else process.kill(record.pid, 'SIGTERM');
          for (let attempt = 0; attempt < 100 && pidExists(record.pid); attempt++) await sleep(100);
          if (pidExists(record.pid)) throw new CliError('The server did not stop; the source was not changed', ['riffet logs']);
        } catch (error) {
          // The service is still up: let it deliver again.
          await release?.();
          throw error;
        }
      },
      restore: async (release: ReleaseTag): Promise<void | 'stopped'> => {
        if (!record) return 'stopped';
        if (manager === 'launchd') {
          await controller(process.platform === 'darwin' ? ['bootstrap', domain, LAUNCH_AGENT_PATH] : ['--user', 'start', SYSTEMD_UNIT]);
        } else {
          // `start` bounds its own wait, which a compaction asked for on the settings page lengthens.
          const result = await runProcess(process.execPath, [join(root, 'dist/cli.js'), 'start', '--state-dir', dir], { cwd: root, timeoutMs: COMPACTION_WAIT_MS + 30_000 });
          if (result.code !== 0 || result.timedOut || result.truncated) throw new CliError('The new version did not start');
        }
        const compactionLimit = Date.now() + COMPACTION_WAIT_MS;
        for (let attempt = 0; attempt < 100; attempt++) {
          // A compaction before the start does not use up the attempts, up to its own limit.
          if (attempt > 0 && Date.now() < compactionLimit && compactionRunning(dir)) { attempt -= 1; await sleep(1000); continue; }
          const next = readDaemon(dir);
          if (next && next.instanceId !== record.instanceId) {
            try {
              const ready = await verifiedHealth(next);
              if (ready.build?.tag === release.tag && ready.build.commit === release.commit && !ready.build.dirty) return;
            } catch { /* The replacement is still starting. */ }
          }
          await sleep(200);
        }
        throw new CliError(`The new server did not report ${release.tag}; the update is not confirmed`, ['riffet status']);
      },
    },
  });
}
