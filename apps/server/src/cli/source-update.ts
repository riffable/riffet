import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BuildInfo, ReleaseTag } from '@contracts';
import { runProcess } from '../git/exec.js';
import { satisfiesMinimum } from '../doctor.js';
import { CliError, duration, err, hint, MARK, spinner, success, type Spinner } from './ui.js';
import { checkForUpdates, compareReleaseTags, fetchRelease, gitEnvironment, readSourceInfo } from '../update/git.js';

export interface UpdateLifecycle {
  /** Runs after all remote/toolchain checks, before changing dependencies or source. */
  stop(): Promise<void>;
  /** Restores the original launcher and verifies the new running build. */
  restore(release: ReleaseTag): Promise<void | 'stopped'>;
  recoveryCommand: string;
}

interface AppInstallation {
  path: string;
  configuration: 'Debug' | 'Release';
  build: BuildInfo;
}

/** Shell quoting is only for the human-readable recovery instructions, never process execution. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export function readAppInstallation(root: string, selected?: string): AppInstallation {
  if (selected !== undefined && selected !== 'Debug' && selected !== 'Release') throw new Error('--configuration accepts Debug or Release.');
  const installed: AppInstallation[] = [];
  for (const configuration of ['Release', 'Debug'] as const) {
    if (selected && selected !== configuration) continue;
    const path = join(root, 'apps/macos/build', configuration, 'Riffet.app');
    try {
      const info = JSON.parse(readFileSync(join(path, 'Contents/Resources/RiffetBuildInfo.json'), 'utf8')) as { build?: BuildInfo; sourceRoot?: string; buildConfiguration?: string };
      if (info.sourceRoot && realpathSync(info.sourceRoot) === realpathSync(root) && info.build && info.buildConfiguration === configuration) {
        installed.push({ path, configuration, build: info.build });
      }
    } catch { /* An old app must be rebuilt once to record its source and version. */ }
  }
  if (installed.length === 1) return installed[0];
  if (installed.length > 1) throw new Error('This checkout has both a Debug and a Release App; choose one with `--configuration Debug` or `--configuration Release`.');
  throw new Error('No App built from this checkout was found. Run `./scripts/build.sh debug` or `./scripts/build.sh release` in apps/macos once first.');
}

async function assertAppStopped(root: string, app: AppInstallation): Promise<void> {
  const result = await runProcess('ps', ['-axo', 'pid=,command='], { cwd: root, maxOutputBytes: 4 * 1024 * 1024 });
  if (result.code !== 0 || result.timedOut || result.truncated) throw new Error('Could not check running App processes; the source was not changed.');
  const target = realpathSync(app.path);
  const usesApp = result.stdout.split('\n').some(line => {
    if (line.includes(join(app.path, 'Contents/MacOS/Riffet')) || line.includes(join(app.path, 'Contents/Resources/server/'))) return true;
    // ps preserves argv aliases and does not retain argument boundaries. Try each absolute path
    // boundary before the bundle suffix, including paths with spaces and symlinked clone roots.
    for (const marker of line.matchAll(/\/Contents\/(?:MacOS\/Riffet(?=\s|$)|Resources\/server\/)/g)) {
      const prefix = line.slice(0, marker.index);
      for (const start of prefix.matchAll(/(?:^|\s|["'])(\/)/g)) {
        const candidate = prefix.slice(start.index + start[0].length - 1);
        try { if (realpathSync(candidate) === target) return true; } catch { /* Not an argv path. */ }
      }
    }
    return false;
  });
  if (usesApp) {
    throw new Error('Stop the managed service in the App settings, quit the App, then run `riffet update --app` again.');
  }
}

/** One checkout is shared by its source, dependencies and build products. */
export function claimUpdate(root: string): () => void {
  const directory = join(root, '.riffet');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'update.lock');
  try {
    const fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return () => { try { if (readFileSync(path, 'utf8').split('\n')[0] === String(process.pid)) unlinkSync(path); } catch {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // Never unlink a stale lock here: a competing updater may already have replaced it.
    throw new Error(`Another update is running, or a stale update lock remains. Make sure no update is running, then check ${path}.`);
  }
}

/** A completed build may be started while its updater still holds the checkout lock. */
export function assertSourceStartAllowed(root: string): void {
  try {
    const lock = readFileSync(join(root, '.riffet/update.lock'), 'utf8');
    const ready = /^([1-9]\d*)\nready$/.exec(lock);
    if (ready && Number.isSafeInteger(Number(ready[1]))) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('This checkout is being updated; start the server after the update finishes.');
}

/** Catch a server using this clone even when it uses a different state directory. */
async function assertSourceProcessesStopped(root: string, allowedPid?: number): Promise<void> {
  const result = await runProcess('ps', ['-axo', 'pid=,command='], { cwd: root, maxOutputBytes: 4 * 1024 * 1024 });
  if (result.code !== 0 || result.timedOut || result.truncated) throw new Error('Could not check running processes for this checkout; the source was not changed.');
  const entries = [join(root, 'dist/cli.js'), join(root, 'apps/server/src/cli.ts')];
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || pid === allowedPid) continue;
    const command = match[2];
    let usesSource = entries.some(entry => command.includes(entry));
    if (!usesSource && /(?:dist\/cli\.js|apps\/server\/src\/cli\.ts)(?:\s|$)/.test(command)) {
      // ps does not expose argv boundaries portably; inspect cwd for relative CLI invocations.
      const relative = /(?:^|\s)([^\s]*(?:dist\/cli\.js|apps\/server\/src\/cli\.ts))(?=\s|$)/.exec(command)?.[1];
      if (relative) {
        let cwd: string | undefined;
        try {
          if (relative.startsWith('/')) cwd = '/';
          else if (process.platform === 'linux') cwd = realpathSync(`/proc/${pid}/cwd`);
          else if (process.platform === 'darwin') {
            const files = await runProcess('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { cwd: root });
            cwd = files.stdout.split('\n').find(value => value.startsWith('n'))?.slice(1);
          }
          if (!cwd) throw new Error('missing cwd');
          usesSource = entries.includes(realpathSync(resolve(cwd, relative)));
        } catch { throw new Error(`Could not tell which source CLI process ${pid} uses; stop the related Riffet instances first.`); }
      }
    }
    if (usesSource) throw new Error(`Process ${pid} is still using this checkout; stop the server or App running from another state directory, then update again.`);
  }
}

function cleanOutput(value: string): string {
  return value.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:token|access_token|private_token)=)[^\s&]+/gi, '$1[redacted]');
}

/** Called by a local CLI, so it can outlive the server being stopped and rebuilt. */
export async function runSourceUpdate(options: {
  root: string;
  current: BuildInfo;
  app?: boolean;
  configuration?: string;
  runningPid?: number;
  lifecycle: UpdateLifecycle;
}): Promise<void> {
  const { current, lifecycle } = options;
  const root = realpathSync(options.root);
  const releaseLock = claimUpdate(root);
  const allowStart = () => {
    const path = join(root, '.riffet/update.lock');
    if (readFileSync(path, 'utf8') !== String(process.pid)) throw new Error('The update lock changed; the new version was not started.');
    // No source, dependency or build mutations are allowed after this phase transition.
    writeFileSync(path, `${process.pid}\nready`, { mode: 0o600 });
  };
  const logPath = join(root, '.riffet/update.log');
  /** The log file gets everything, redacted; the terminal only gets the steps. */
  const logFile = (line: string) => {
    appendFileSync(logPath, `${new Date().toISOString()} ${cleanOutput(line)}\n`, { mode: 0o600 });
  };
  const ok = err.ok(MARK.ok);
  let running: { spinner: Spinner; startedAt: number } | undefined;
  /** Shows a spinner until `finish`, which replaces it with `✓ done`. */
  const begin = (text: string) => { running = { spinner: spinner(text), startedAt: Date.now() }; };
  const finish = (done: string, timed = false) => {
    if (!running) return;
    const elapsed = Date.now() - running.startedAt;
    running.spinner.stop(`${ok} ${done}${timed && elapsed >= 5000 ? err.dim(` (${duration(elapsed)})`) : ''}`);
    running = undefined;
  };
  let step = 'preflight checks';
  let changed = false;
  let originalCommit: string | null = null;
  const command = async (file: string, args: string[], timeoutMs = 30_000, env = gitEnvironment()) => {
    logFile(`Running ${file} ${args.map(shellQuote).join(' ')}`);
    const result = await runProcess(file, args, { cwd: root, env: file === 'git' ? gitEnvironment() : env, timeoutMs, maxOutputBytes: 16 * 1024 * 1024 });
    if (result.stdout) logFile(result.stdout.trimEnd());
    if (result.stderr) logFile(result.stderr.trimEnd());
    if (result.code !== 0 || result.timedOut || result.truncated) {
      throw new Error(`${file} failed (${result.timedOut ? 'timed out' : result.truncated ? 'output too large' : `exit code ${result.code}`}). See ${logPath}.`);
    }
    return result.stdout.trim();
  };
  try {
    begin('Checking the installation');
    const source = await readSourceInfo(root);
    originalCommit = source.commit;
    if (source.dirty || !source.tag || !source.commit) throw new Error('Updating needs a clean checkout of a release tag. Deal with local changes or development commits, then switch to a release tag.');
    await assertSourceProcessesStopped(root, options.runningPid);
    const branch = await runProcess('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root, env: gitEnvironment() });
    logFile(`Before update: ${source.tag} · ${source.commit} · ${branch.code === 0 ? branch.stdout.trim() : 'detached HEAD'}`);
    const check = await checkForUpdates({ root, current });
    if (!check.latest || check.status === 'conflict' || check.status === 'unavailable' || check.status === 'ahead') {
      throw new Error(check.message ?? 'No newer release is available.');
    }
    const target = check.latest;
    if (source.tag !== target.tag && compareReleaseTags(source.tag, target.tag) > 0) {
      throw new Error('The local source is newer than the latest remote release; it will not be downgraded.');
    }
    const app = options.app ? readAppInstallation(root, options.configuration) : undefined;
    if (options.app && process.platform !== 'darwin') throw new Error('`--app` is only supported on macOS.');
    if (app) await assertAppStopped(root, app);
    if (source.commit === target.commit && current.tag === target.tag && current.commit === target.commit && !current.dirty) {
      logFile(`Already on the latest release ${target.tag}.`);
      running?.spinner.stop();
      running = undefined;
      success(`Already on the latest release ${target.tag}`);
      return;
    }
    await command('pnpm', ['--version']);
    finish('Checked installation and toolchain');
    process.stderr.write(`Updating ${current.tag ?? current.version} ${MARK.arrow} ${err.accent(target.tag)}\n`);
    step = 'fetching the target tag';
    begin(`Fetching ${target.tag}`);
    logFile(`Fetching ${target.tag}; the running service stays up.`);
    const manifest = await fetchRelease(root, target);
    if (manifest.engines?.node && satisfiesMinimum(process.version, manifest.engines.node) !== true) {
      throw new Error(`${target.tag} needs Node.js ${manifest.engines.node}, but this is ${process.version}. Update Node.js first.`);
    }
    if (manifest.engines?.pnpm !== undefined) {
      const pnpmVersion = await command('pnpm', ['--version']);
      if (typeof manifest.engines.pnpm !== 'string' || satisfiesMinimum(pnpmVersion, manifest.engines.pnpm) !== true) throw new Error(`${target.tag} needs a different pnpm version than the one installed. Check your toolchain, then retry.`);
    }
    if (manifest.packageManager) {
      const required = /^pnpm@(\d+\.\d+\.\d+)(?:\+.*)?$/.exec(manifest.packageManager)?.[1];
      if (!required || await command('pnpm', ['--version']) !== required) throw new Error(`${target.tag} uses ${manifest.packageManager}. Switch to that pnpm version first.`);
    }
    const unchanged = async () => {
      const latest = await readSourceInfo(root);
      if (latest.dirty || latest.commit !== source.commit || latest.tag !== source.tag) throw new Error('The source changed after the checks; the update stopped. Deal with the local changes and retry.');
    };
    await unchanged();
    if (app) await assertAppStopped(root, app);
    finish(`Fetched ${target.tag}`);
    step = 'stopping the service';
    begin('Stopping the service');
    logFile('Entering the update phase; the service stays stopped during install and build.');
    await lifecycle.stop();
    await assertSourceProcessesStopped(root);
    await unchanged();
    finish('Stopped the service');
    changed = true;
    step = 'switching the source';
    begin(`Switching to ${target.tag}`);
    await command('git', ['-c', 'core.hooksPath=/dev/null', 'switch', '--detach', target.commit]);
    finish(`Switched to ${target.tag}`);
    step = 'installing dependencies';
    begin('Installing dependencies');
    await command('pnpm', ['install', '--frozen-lockfile'], 15 * 60_000);
    finish('Installed dependencies', true);
    step = 'verifying the version';
    begin('Verifying the version');
    await command('pnpm', ['version:check']);
    finish('Verified the version');
    step = 'building the server and web client';
    begin('Building the server and web client');
    // Do not inherit an unrelated build's pinned metadata from an Xcode/agent caller.
    const buildEnv = gitEnvironment();
    delete buildEnv.RIFFET_BUILD_INFO_FILE;
    await command('pnpm', ['build'], 15 * 60_000, buildEnv);
    const built = JSON.parse(readFileSync(join(root, 'dist/build-info.json'), 'utf8')) as { build?: BuildInfo };
    if (built.build?.tag !== target.tag || built.build.commit !== target.commit || built.build.dirty) throw new Error('The build does not match the target tag; the new version was not started.');
    const finalSource = await readSourceInfo(root);
    if (finalSource.dirty || finalSource.commit !== target.commit || finalSource.tag !== target.tag) throw new Error('The source changed during the build; the new version was not started.');
    finish('Built the server and web client', true);
    if (app) {
      step = 'building the App';
      begin('Building the App');
      await command('/bin/bash', ['apps/macos/scripts/build.sh', app.configuration === 'Release' ? 'update-release' : 'update-debug'], 30 * 60_000, buildEnv);
      const staged = join(root, 'apps/macos/build/update/Riffet.app');
      const appInfo = JSON.parse(readFileSync(join(staged, 'Contents/Resources/RiffetBuildInfo.json'), 'utf8')) as { build?: BuildInfo; sourceRoot?: string; buildConfiguration?: string };
      if (appInfo.build?.tag !== target.tag || appInfo.build.commit !== target.commit || appInfo.build.dirty || appInfo.buildConfiguration !== app.configuration || !appInfo.sourceRoot || realpathSync(appInfo.sourceRoot) !== root) throw new Error('The App build does not match the target tag; the existing App was kept.');
      await assertAppStopped(root, app);
      const replacement = app.path + `.update-${process.pid}`;
      const previous = app.path + `.previous-${process.pid}`;
      if (existsSync(replacement) || existsSync(previous)) throw new Error('A staging folder from an earlier App replacement is still there; check it by hand, then retry.');
      await cp(staged, replacement, { recursive: true, verbatimSymlinks: true });
      renameSync(app.path, previous);
      try { renameSync(replacement, app.path); }
      catch (error) { renameSync(previous, app.path); throw error; }
      rmSync(previous, { recursive: true, force: true });
      allowStart();
      await command('/usr/bin/open', [app.path]);
      finish('Built the App', true);
      logFile(`App replaced with ${target.tag}.`);
      success(`App replaced with ${target.tag}`);
      process.stderr.write(hint('Start the managed service from the App, then check its version.') + '\n');
    } else {
      step = 'restarting and verifying the service';
      begin('Restarting the service');
      allowStart();
      const restored = await lifecycle.restore(target);
      finish(restored === 'stopped' ? 'Left the service stopped, as it was' : 'Restarted and verified the service');
      logFile(`Update complete: ${target.tag} · ${target.commit}`);
      success(restored === 'stopped' ? `Updated to ${target.tag}` : `Riffet ${target.tag} is running`);
    }
  } catch (error) {
    running?.spinner.stop();
    running = undefined;
    logFile(`Update stopped at ${step}: ${error instanceof Error ? error.message : String(error)}`);
    const guidance: string[] = [`Stopped at ${step}.`];
    if (originalCommit) {
      guidance.push(`Run \`cd ${shellQuote(root)}\``);
      if (changed) guidance.push(`To go back to the previous version, check the working tree, then run \`git switch --detach ${originalCommit}\``);
      guidance.push('Then rebuild: `pnpm install --frozen-lockfile && pnpm build`');
      guidance.push(/^['/]|^(?:launchctl|systemctl|riffet) /.test(lifecycle.recoveryCommand) ? `Then start the service: \`${lifecycle.recoveryCommand}\`` : lifecycle.recoveryCommand);
    }
    guidance.push(`Full log: ${logPath}`);
    for (const line of guidance) logFile(line);
    // Printed under the error itself, as every other failure's next steps are.
    throw new CliError(error instanceof Error ? error.message : String(error), guidance);
  } finally {
    releaseLock();
  }
}
