import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { currentEnvironmentReport, terminalEnvironment } from '../environment.js';
import { buildLaunchAgentPlist, buildSystemdUnit, xmlEscape, systemdValue } from '../service-files.js';
import { APP_MANAGED_HINT, appAgentLoaded, entry, stateDir } from './context.js';
import type { LaunchOptions } from './launch.js';
import { CliError, MARK, fields, hint, note, out, printLines, success, tilde } from './ui.js';

/*
 * `riffet service`: a login service (launchd on macOS, systemd --user on Linux) that runs `serve` at
 * login and restarts it when it exits. The service manager owns that process, not `riffet start`.
 */

export const LAUNCH_AGENT_PATH = join(homedir(), 'Library/LaunchAgents/local.riffet.plist');
export const SYSTEMD_UNIT_PATH = join(homedir(), '.config/systemd/user/riffet.service');
export const SYSTEMD_UNIT = 'riffet.service';
export const LAUNCH_AGENT_LABEL = 'local.riffet';
export const serviceFile = (): string => (process.platform === 'darwin' ? LAUNCH_AGENT_PATH : SYSTEMD_UNIT_PATH);

/** Whether the installed service file runs this CLI on `dir`. */
export function serviceRunsThis(dir: string): boolean {
  const content = readFileSync(serviceFile(), 'utf8');
  const quote = process.platform === 'darwin' ? xmlEscape : systemdValue;
  return content.includes(quote(entry)) && content.includes(quote(dir));
}

/**
 * The environment a service manager has to hand the daemon. A background service gets none of the
 * user's shell startup — no PATH from nvm/asdf/mise, no pnpm or Android variables — so the snapshot
 * taken here is what keeps the daemon able to find node, the agent CLIs and the toolchains its
 * terminals promise. `riffet service install --refresh-environment` re-takes it after a new install.
 */
export function serviceEnvironment(): Record<string, string> {
  const report = currentEnvironmentReport();
  const environment = terminalEnvironment(report);
  if (report?.shell) environment.SHELL = report.shell;
  environment.RIFFET_MANAGED_BY = 'launchd';
  return environment;
}

/** `serve` in the foreground: a service manager owns the process lifecycle, not our daemonizer. */
function serviceArgs(options: LaunchOptions): string[] {
  const args = ['serve', '--state-dir', stateDir(options.stateDir), '--host', options.host, '--port', options.port, '--cli', options.cli];
  for (const host of options.allowHost ?? []) args.push('--allow-host', host);
  for (const network of options.trustNetwork ?? []) args.push('--trust-network', network);
  args.push(options.auth === false ? '--no-auth' : '--auth');
  if (options.mdns === false) args.push('--no-mdns');
  return args;
}

function writeLaunchAgent(options: LaunchOptions): void {
  const xml = buildLaunchAgentPlist({ label: LAUNCH_AGENT_LABEL, programArguments: [process.execPath, entry, ...serviceArgs(options)], environment: serviceEnvironment(), logPath: join(stateDir(options.stateDir), 'server.log') });
  mkdirSync(dirname(LAUNCH_AGENT_PATH), { recursive: true });
  writeFileSync(LAUNCH_AGENT_PATH, xml, { mode: 0o600 });
  const domain = `gui/${process.getuid!()}`;
  spawnSync('launchctl', ['bootout', domain, LAUNCH_AGENT_PATH], { stdio: 'ignore' });
  const result = spawnSync('launchctl', ['bootstrap', domain, LAUNCH_AGENT_PATH], { encoding: 'utf8' });
  if (result.status !== 0) throw new CliError(`launchctl could not load the service: ${result.stderr.trim() || `exit code ${result.status}`}`);
}

function writeSystemdUnit(options: LaunchOptions): void {
  const unit = buildSystemdUnit({ description: 'Riffet — local agent workbench', programArguments: [process.execPath, entry, ...serviceArgs(options)], environment: serviceEnvironment(), workingDirectory: process.cwd(), logPath: join(stateDir(options.stateDir), 'server.log') });
  mkdirSync(dirname(SYSTEMD_UNIT_PATH), { recursive: true });
  writeFileSync(SYSTEMD_UNIT_PATH, unit, { mode: 0o600 });
  const reloaded = spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8' });
  if (reloaded.error) throw new CliError(`systemctl is unavailable: ${reloaded.error.message}`);
  spawnSync('systemctl', ['--user', 'enable', SYSTEMD_UNIT], { encoding: 'utf8' });
  const started = spawnSync('systemctl', ['--user', 'restart', SYSTEMD_UNIT], { encoding: 'utf8' });
  if (started.status !== 0) throw new CliError(`systemctl could not start the service: ${started.stderr.trim() || `exit code ${started.status}`}`);
}

const unsupported = () => new CliError('Login services work on macOS (launchd) and Linux (systemd --user)');

export async function installService(options: LaunchOptions & { refreshEnvironment?: boolean }): Promise<void> {
  if (entry.endsWith('.ts')) throw new CliError('Build Riffet before installing a login service', ['`pnpm build`']);
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw unsupported();
  if (options.refreshEnvironment && !existsSync(serviceFile())) throw new CliError('No login service is installed to refresh', ['riffet service install']);
  if (process.platform === 'darwin') {
    if (appAgentLoaded()) throw new CliError('Riffet.app already runs a server at login; a second service would compete for the same state directory', [APP_MANAGED_HINT]);
    writeLaunchAgent(options);
  } else writeSystemdUnit(options);
  success(`${options.refreshEnvironment ? 'Refreshed' : 'Installed'} the login service ${out.dim(tilde(serviceFile()))}`);
  if (process.platform === 'linux') note('It runs while you are logged in; `loginctl enable-linger $USER` keeps it running after logout');
}

export async function uninstallService(): Promise<void> {
  if (process.platform === 'darwin' && existsSync(LAUNCH_AGENT_PATH)) {
    spawnSync('launchctl', ['bootout', `gui/${process.getuid!()}`, LAUNCH_AGENT_PATH], { stdio: 'ignore' });
    unlinkSync(LAUNCH_AGENT_PATH);
  } else if (process.platform === 'linux' && existsSync(SYSTEMD_UNIT_PATH)) {
    spawnSync('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT], { stdio: 'ignore' });
    unlinkSync(SYSTEMD_UNIT_PATH);
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
  } else {
    note('No login service is installed');
    return;
  }
  success(`Removed the login service ${out.dim('· conversations and settings are kept')}`);
}

/** Whether launchd or systemd has the service loaded and running. */
function serviceState(): 'running' | 'loaded' | 'stopped' {
  if (process.platform === 'darwin') {
    const result = spawnSync('launchctl', ['print', `gui/${process.getuid!()}/${LAUNCH_AGENT_LABEL}`], { encoding: 'utf8' });
    if (result.status !== 0) return 'stopped';
    return /\bstate = running\b/.test(result.stdout) ? 'running' : 'loaded';
  }
  const result = spawnSync('systemctl', ['--user', 'is-active', SYSTEMD_UNIT], { encoding: 'utf8' });
  return result.stdout.trim() === 'active' ? 'running' : result.stdout.trim() === 'activating' ? 'loaded' : 'stopped';
}

export async function serviceStatus(options: { stateDir: string }): Promise<void> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw unsupported();
  if (!existsSync(serviceFile())) {
    printLines([`${out.dim(MARK.stopped)} ${out.bold('Login service')} ${out.dim('not installed')}`, '', hint('riffet service install', out)]);
    return;
  }
  const state = serviceState();
  const marker = state === 'running' ? out.ok(MARK.running) : state === 'loaded' ? out.warn(MARK.running) : out.dim(MARK.stopped);
  const dir = stateDir(options.stateDir);
  printLines([
    `${marker} ${out.bold('Login service')} ${out.dim(state === 'running' ? 'running' : state === 'loaded' ? 'loaded, not running' : 'installed, not loaded')}`,
    '',
    ...fields([
      ['File', tilde(serviceFile())],
      ['Runs', serviceRunsThis(dir) ? `this Riffet ${out.dim('· ' + tilde(dir))}` : out.warn('another Riffet installation or state directory')],
    ]),
  ]);
}
