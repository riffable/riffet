import { constants as fsConstants, existsSync, readFileSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MachineReport, NativeBackendId } from '../../../packages/contracts/src/index.js';
export type { MachineReport };
import { type DoctorCheck, type DoctorStatus } from '@riffet/plugin-api';
import { detectTailscale, tmuxTooOld } from '@riffet/plugin-api/kit';
import { CLAUDE_CLI_VERSIONS } from './backends/claude/index.js';
import { codexFlavor, traexFlavor } from './backends/codex/flavors.js';
import { DROID_CLI_VERSIONS } from './backends/droid/index.js';
import { DSH_CLI_VERSIONS } from './backends/dsh/settings.js';
import { PI_CLI_VERSIONS } from './backends/pi/index.js';
import { cliCheck } from './backends/shared/cli-check.js';
import { parseVersion, versionAtLeast, type CliVersionRange } from './backends/shared/cli-version.js';
import { runProcess } from './git/exec.js';
import { TMUX_MIN_VERSION } from './terminal/control.js';
import { PluginRegistry } from './plugins/registry.js';
import type { SettingsService } from './settings/index.js';

export type { DoctorCheck, DoctorStatus };

/** The CLIs the core still checks itself, in report order; an Agent from a plugin reports through `doctorChecks`. */
const BACKENDS: Record<string, { label: string; env?: string; command: string; install: string; versions: CliVersionRange }> = {
  codex: { label: 'Codex CLI', env: 'CODEX_CLI', command: 'codex', install: 'Install it with `npm i -g @openai/codex`, or set CODEX_CLI / the profile executable.', versions: codexFlavor.cliVersions },
  claude: { label: 'Claude Code', env: 'CLAUDE_CLI', command: 'claude', install: 'Install it with `npm i -g @anthropic-ai/claude-code`, or set CLAUDE_CLI / the profile executable.', versions: CLAUDE_CLI_VERSIONS },
  dsh: { label: 'DeepSeek Harness', command: 'dsh', install: `Install it with \`npm i -g @deepseek-ai/dsh@${DSH_CLI_VERSIONS.minimum}\`, or set the profile executable.`, versions: DSH_CLI_VERSIONS },
  droid: { label: 'Factory Droid', command: 'droid', install: 'Install the Factory Droid CLI (`droid`), or set the profile executable.', versions: DROID_CLI_VERSIONS },
  traex: { label: 'TRAE CLI', env: 'TRAEX_CLI', command: 'traex', install: 'Install the TRAE CLI (`traex`), or set TRAEX_CLI / the profile executable.', versions: traexFlavor.cliVersions },
  antigravity: { label: 'Antigravity CLI', command: 'agy', install: 'Install and sign in to Antigravity CLI (`agy`), or set the profile executable.', versions: { minimum: '1.5.6', testedThrough: '1.5.10' } },
  pi: { label: 'pi', env: 'PI_CLI', command: 'pi', install: 'Install it with `npm i -g @earendil-works/pi-coding-agent`, or set PI_CLI / the profile executable.', versions: PI_CLI_VERSIONS },
};

/** The bundled CLI and the TypeScript source sit at different depths, so look upward for our own manifest. */
function packageManifest(): { engines?: { node?: string } } | undefined {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth++) {
    const file = join(directory, 'package.json');
    if (existsSync(file)) {
      try {
        const manifest = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; engines?: { node?: string } };
        if (manifest.name === 'riffet') return manifest;
      } catch { /* keep looking */ }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

export function satisfiesMinimum(version: string, range: string): boolean | undefined {
  const minimum = /^\s*>=\s*(\d+\.\d+\.\d+)\s*$/.exec(range)?.[1];
  if (!minimum || !parseVersion(version)) return undefined;
  return versionAtLeast(version, minimum);
}

function nodeCheck(): DoctorCheck {
  const range = packageManifest()?.engines?.node;
  const label = 'Node.js';
  if (!range) return { id: 'node', label, status: 'warn', detail: `${process.version}; package.json engines.node was not found` };
  const result = satisfiesMinimum(process.version, range);
  if (result === undefined) return { id: 'node', label, status: 'warn', detail: `${process.version}; cannot evaluate engines range “${range}”` };
  return result
    ? { id: 'node', label, status: 'ok', detail: `${process.version} (requires ${range})` }
    : { id: 'node', label, status: 'fail', detail: `${process.version} does not satisfy ${range}`, fix: `Install Node.js ${range.replace(/^>=\s*/, '')} or newer (nvm install 24 / brew install node).` };
}

/** What `--version` printed; a CLI that fails or hangs only leaves its version unknown. */
async function readVersion(executable: string): Promise<string | undefined> {
  const result = await runProcess(executable, ['--version'], { cwd: process.cwd(), timeoutMs: 8_000, maxOutputBytes: 64 * 1024 });
  return result.code === 0 ? `${result.stdout}\n${result.stderr}` : undefined;
}

async function backendChecks(settings: SettingsService): Promise<Array<DoctorCheck & { installed: boolean }>> {
  return Promise.all(Object.entries(BACKENDS).map(async ([id, backend]) => {
    const commands = [(backend.env && process.env[backend.env]?.trim()) || backend.command];
    let note = '';
    try {
      for (const profile of settings.getNativeBackendProfiles(id as NativeBackendId).profiles) if (profile.executable?.trim()) commands.push(profile.executable.trim());
    } catch { note = '; saved profiles could not be read'; }
    return cliCheck({ id, name: backend.label, commands, note, install: backend.install, versions: backend.versions, readVersion });
  }));
}

export function portFree(host: string, port: number): Promise<NodeJS.ErrnoException | undefined> {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', error => resolve(error as NodeJS.ErrnoException));
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(undefined)));
  });
}

async function portCheck(host: string, portText: string, daemon: { host: string; port: number } | undefined): Promise<DoctorCheck> {
  const port = Number(portText);
  const label = `Port ${host}:${portText}`;
  if (!Number.isInteger(port) || port < 0 || port > 65535) return { id: 'port', label, status: 'fail', detail: 'not a valid port', fix: 'Pass --port 0–65535.' };
  if (daemon && daemon.port === port) return { id: 'port', label, status: 'ok', detail: 'served by the running Riffet daemon' };
  const error = await portFree(host, port);
  if (!error) return { id: 'port', label, status: 'ok', detail: 'available' };
  if (error.code === 'EADDRINUSE') return { id: 'port', label, status: 'fail', detail: 'already in use by another process', fix: `Stop the other process (lsof -i :${port}) or start with --port <other>.` };
  if (error.code === 'EACCES') return { id: 'port', label, status: 'fail', detail: 'permission denied', fix: 'Use a port above 1024.' };
  if (error.code === 'EADDRNOTAVAIL') return { id: 'port', label, status: 'fail', detail: `${host} is not an address of this machine`, fix: 'Pass --host 127.0.0.1 or a local interface address.' };
  return { id: 'port', label, status: 'warn', detail: `could not be probed (${error.code ?? error.message})` };
}

async function stateDirCheck(stateDir: string): Promise<DoctorCheck> {
  const label = 'State directory';
  try {
    await access(stateDir, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
  } catch {
    return { id: 'state-dir', label, status: 'fail', detail: `${stateDir} is not readable and writable by this user`, fix: `chown -R "$USER" ${JSON.stringify(stateDir)} && chmod 700 ${JSON.stringify(stateDir)}` };
  }
  const exposed: string[] = [];
  if ((await stat(stateDir)).mode & 0o077) exposed.push(stateDir);
  for (const name of ['access-token', 'cookie-secret']) {
    try { if ((await stat(join(stateDir, name))).mode & 0o077) exposed.push(join(stateDir, name)); } catch { /* not created yet */ }
  }
  if (exposed.length) return { id: 'state-dir', label, status: 'warn', detail: `readable by other users: ${exposed.join(', ')}`, fix: `chmod 700 ${JSON.stringify(stateDir)} && chmod 600 ${JSON.stringify(stateDir)}/access-token ${JSON.stringify(stateDir)}/cookie-secret` };
  return { id: 'state-dir', label, status: 'ok', detail: `${stateDir} (private)` };
}


export async function machineReport(): Promise<MachineReport> {
  const cwd = process.cwd();
  const [tmux, tailscale] = await Promise.all([runProcess('tmux', ['-V'], { cwd, timeoutMs: 3000, maxOutputBytes: 16 * 1024 }), detectTailscale(cwd)]);
  const old = tmux.code === 0 && tmuxTooOld(tmux.stdout);
  const warnings = tmux.code !== 0 ? ['tmux was not found or could not be started.']
    : old ? [`${tmux.stdout.trim().replace(/[\r\n]+/g, ' ').slice(0, 1000)} is too old: terminals need tmux ${TMUX_MIN_VERSION} or newer.`] : [];
  return { tmux: tmux.code === 0 && !old, tailscale, warnings, checkedAt: new Date().toISOString() };
}

export interface DoctorSection { title: 'Runtime' | 'Agents' | 'Server' | 'Plugins'; checks: DoctorCheck[] }

/**
 * The rows of every enabled integration, grouped. An Agent that a plugin provides (Cursor) reports with the
 * Agents, where the core's own CLIs are listed; any other plugin's rows come last.
 */
export async function doctorChecks(input: { stateDir: string; host: string; port: string; settings: SettingsService; machine: MachineReport; daemon?: { host: string; port: number } }): Promise<DoctorSection[]> {
  const tmux: DoctorCheck = input.machine.tmux
    ? { id: 'tmux', label: 'tmux', status: 'ok', detail: 'available' }
    : { id: 'tmux', label: 'tmux', status: 'fail', detail: input.machine.warnings.find(warning => warning.includes('too old')) ?? `not found or could not be started; agent sessions and terminals need tmux ${TMUX_MIN_VERSION} or newer`, fix: 'Install or upgrade it with `brew install tmux` (macOS) or `sudo apt install tmux` (Debian/Ubuntu; 22.04 and newer have 3.2a or later).' };
  const { agents, others } = await pluginChecks(input.stateDir, input.settings);
  const core = await backendChecks(input.settings);
  const installed = [...agents, ...core, ...others].some(check => check.installed);
  const strip = (checks: Array<DoctorCheck & { installed?: boolean }>) => checks.map(({ installed: _installed, ...check }) => check);
  return [
    { title: 'Runtime' as const, checks: [nodeCheck(), tmux] },
    { title: 'Agents' as const, checks: strip([
      ...agents, ...core,
      ...installed ? [] : [{ id: 'backend:any', label: 'Agent CLIs', status: 'fail' as const, detail: 'none of the supported agent CLIs could be found', fix: 'Install and sign in to at least one of the CLIs above.' }],
    ]) },
    { title: 'Server' as const, checks: [await portCheck(input.host, input.port, input.daemon), await stateDirCheck(input.stateDir)] },
    { title: 'Plugins' as const, checks: strip(others) },
  ].filter(section => section.checks.length);
}

/** The registry only evaluates here, so whatever a plugin opened is released before the command ends. */
async function pluginChecks(stateDir: string, settings: SettingsService): Promise<{ agents: DoctorCheck[]; others: DoctorCheck[] }> {
  const plugins = new PluginRegistry({ stateDir, savedModelSources: () => settings.savedModelSources(), agentProfiles: backendId => settings.agentProfiles(backendId) });
  try {
    const checks = await plugins.doctorChecks();
    const owners = [...new Set(plugins.declaredAgentBackends().filter(declared => declared.enabled).map(declared => `integration:${declared.owner}:`))];
    const isAgent = (check: DoctorCheck) => owners.some(prefix => check.id.startsWith(prefix));
    return { agents: checks.filter(isAgent), others: checks.filter(check => !isAgent(check)) };
  } finally { await plugins.close(); }
}
