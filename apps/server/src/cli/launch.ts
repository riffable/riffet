import { Command, Option } from 'commander';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AGENT_PROCESS_BUDGET } from '../../../../packages/contracts/src/index.js';
import { isTempStateDir } from '../terminal/orphans.js';
import { createApp } from '../app.js';
import { isServerProfileInput, parseIdleExitMs, resolveServerProfile, serverProfileBudget, type ServerProfileInput } from '../memory/profile.js';
import { claimStateDirectory } from '../compat.js';
import { COMPACTION_WAIT_MS, compactionRunning, runRequestedCompaction, runStorageMigrationIfNeeded } from '../storage/compaction.js';
import { startDiscovery, type DiscoveryHandle } from '../discovery.js';
import { SERVER_VERSION } from '../version.js';
import { rotateServerLog, stampServerOutput } from '../server-log.js';
import { portFree } from '../doctor.js';
import { APP_MANAGED_HINT, DEFAULT_HOST, DEFAULT_PORT, accessToken, active, entry, health, installRoot, isLoopback, ownsPid, pidExists, readDaemon, serverUrl, stateDir, type DaemonRecord } from './context.js';
import { drainForRestart } from './drain.js';
import { assertSourceStartAllowed } from './source-update.js';
import { serverSummary } from './status.js';
import { CliError, MARK, UsageError, duration, err, hint, note, out, printLines, spinner, tilde, warning } from './ui.js';

/** How a server is launched; `stateDir` comes from the global option, the rest from the command line or the saved launch. */
export interface LaunchOptions {
  stateDir: string; host: string; port: string; cli: string; allowHost?: string[];
  workspace?: string; auth?: boolean; mdns?: boolean; dev?: boolean;
  profile?: string; idleExit?: string;
}

const collect = (value: string, previous: string[] = []) => [...previous, value];
/** `RIFFET_MDNS=0` mirrors `--no-mdns`; any other value keeps the default of advertising. */
const mdnsDisabled = (value: string | undefined) => /^(?:0|false|off)$/i.test(value?.trim() ?? '');
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

/** The options every command that launches a server takes: `open`, `start`, `restart`, `serve`. */
export function configure(command: Command): Command {
  return command
    .addOption(new Option('--host <host>', 'address to listen on; 0.0.0.0 for other devices').env('RIFFET_HOST').default(DEFAULT_HOST))
    .addOption(new Option('--port <port>', 'port to listen on').env('RIFFET_PORT').default(DEFAULT_PORT))
    .option('--auth', 'require the access token, also from this computer')
    .option('--no-auth', 'no token for this computer (loopback only)')
    .option('--allow-host <hostname>', 'also accept this hostname; repeatable', collect)
    .option('--workspace <path>', 'add this directory as a project')
    .addOption(new Option('--profile <profile>', 'memory profile: full, lite, or auto').env('RIFFET_PROFILE').default('full'))
    .addOption(new Option('--idle-exit <duration>', 'stop after being idle for this duration (e.g. 30m, 2h, 0 to disable)').env('RIFFET_IDLE_EXIT'))
    .addOption(new Option('--mdns', 'advertise on the local network').hideHelp())
    .option('--no-mdns', 'do not advertise on the local network')
    .addOption(new Option('--cli <command>', 'Cursor executable or shell:<function>').env('RIFFET_CLI').default('cursor-agent').hideHelp())
    .addOption(new Option('--dev', 'serve APIs for the Vite development frontend').hideHelp())
    // Earlier launchers, updaters and the App pass this; the token is never printed now.
    .addOption(new Option('--no-token').hideHelp());
}

/** Persistent launch intent survives `stop`; daemon.json only describes the live process. */
export function savedLaunchArgs(dir: string): string[] | undefined {
  try {
    const value = JSON.parse(readFileSync(join(dir, 'server-config.json'), 'utf8')) as { version?: unknown; args?: unknown };
    if (value.version !== 1 || !Array.isArray(value.args) || !value.args.every(arg => typeof arg === 'string') || value.args[0] !== 'serve') {
      throw new CliError(`${join(dir, 'server-config.json')} is not a saved launch configuration`, ['Remove it to start with the defaults']);
    }
    return value.args as string[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Saved launch values, overridden by what this command line (or the environment) says. Authentication
 * follows the address unless asked for: an address other devices can reach requires the token.
 */
export function resolveLaunchOptions(options: LaunchOptions, command: Command, savedArgs?: string[]): LaunchOptions {
  const explicit = (name: string) => ['cli', 'env'].includes(command.getOptionValueSource(name) ?? '');
  let merged: LaunchOptions = { ...options };
  let savedAuth: boolean | undefined;
  if (savedArgs) {
    const parser = configure(new Command()).option('--state-dir <path>').exitOverride();
    parser.configureOutput({ writeErr: () => undefined });
    try { parser.parse(savedArgs.slice(1), { from: 'user' }); }
    catch (error) { throw new CliError(`The saved launch settings could not be read: ${error instanceof Error ? error.message.replace(/^error: /, '') : String(error)}`, ['Remove server-config.json in the state directory to start with the defaults']); }
    const saved = parser.opts() as LaunchOptions;
    // Earlier servers wrote only `--no-auth`; no flag meant the token was required.
    savedAuth = !savedArgs.includes('--no-auth');
    const overrides = Object.fromEntries(Object.entries(options).filter(([name]) => explicit(name)));
    merged = { ...saved, ...overrides, stateDir: options.stateDir, dev: options.dev };
  }
  if (!explicit('auth')) merged.auth = explicit('host') && !isLoopback(merged.host) ? true : savedAuth ?? !isLoopback(merged.host);
  return merged;
}

export function validateLaunchOptions(options: LaunchOptions): void {
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`--port must be 0–65535, not ${options.port}`);
  if (options.auth === false && !isLoopback(options.host)) {
    throw new UsageError(`Token-free access only works on 127.0.0.1, localhost or ::1, not ${options.host}`, ['Use --auth so other devices sign in with the access token']);
  }
  if (options.workspace) {
    let directory = false;
    try { directory = statSync(realpathSync(resolve(options.workspace))).isDirectory(); } catch { /* reported below */ }
    if (!directory) throw new UsageError(`--workspace is not a directory: ${options.workspace}`);
  }
  if (options.profile !== undefined && !isServerProfileInput(options.profile)) {
    throw new UsageError(`--profile must be full, lite, or auto, not ${options.profile}`);
  }
  if (options.idleExit !== undefined) {
    try { parseIdleExitMs(options.idleExit); }
    catch (error) { throw new UsageError(error instanceof Error ? error.message : String(error)); }
  }
}

export function saveLaunchConfig(options: LaunchOptions, args: string[]): void {
  const path = join(stateDir(options.stateDir), 'server-config.json'), temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ version: 1, args }, null, 2) + '\n', { mode: 0o600 }); renameSync(temp, path);
}

/** The `serve` command line that reproduces `options`; saved as the launch intent. */
export function argsFor(options: LaunchOptions): string[] {
  const args = ['serve', '--state-dir', stateDir(options.stateDir), '--host', options.host, '--port', options.port, '--cli', options.cli];
  for (const host of options.allowHost ?? []) args.push('--allow-host', host);
  if (options.workspace) args.push('--workspace', resolve(options.workspace));
  if (options.profile && options.profile !== 'full') args.push('--profile', options.profile);
  if (options.idleExit !== undefined) args.push('--idle-exit', options.idleExit);
  args.push(options.auth === false ? '--no-auth' : '--auth');
  if (options.mdns === false) args.push('--no-mdns');
  return args;
}

function assertSourceStartable(): void {
  // Bundled standalone payloads do not share the clone's dependencies or build products.
  if (existsSync(join(installRoot, '.git'))) assertSourceStartAllowed(realpathSync(installRoot));
}

// ---------------------------------------------------------------------------------------------------
// serve

export async function serve(options: LaunchOptions): Promise<void> {
  stampServerOutput();
  assertSourceStartable();
  const dir = stateDir(options.stateDir);
  if (await active(dir)) throw new CliError('Riffet is already running on this state directory', ['riffet status']);
  validateLaunchOptions(options);
  const port = Number(options.port);
  const cwd = options.workspace ? realpathSync(resolve(options.workspace)) : undefined;
  const releaseState = claimStateDirectory(dir);
  process.once('exit', releaseState);
  rotateServerLog(join(dir, 'server.log'));
  // Migrate a legacy single-file workbench.db before opening databases, then run any requested compaction.
  runStorageMigrationIfNeeded(dir);
  runRequestedCompaction(dir);
  const instanceId = randomUUID();
  const webRoot = options.dev ? undefined : join(dirname(entry), 'public');
  // Development reads the plugin index `pnpm build:site` wrote, when there is one and nothing else was asked for.
  const localIndex = fileURLToPath(new URL('../../../../dist/site/plugins/index.json', import.meta.url));
  if (options.dev && !process.env.RIFFET_PLUGIN_INDEX?.trim() && existsSync(localIndex)) process.env.RIFFET_PLUGIN_INDEX = pathToFileURL(localIndex).href;
  const profile = resolveServerProfile(options.profile as ServerProfileInput | undefined);
  const idleExitMs = parseIdleExitMs(options.idleExit);
  const began = Date.now();
  let services: Awaited<ReturnType<typeof createApp>> | undefined;
  let discovery: DiscoveryHandle | undefined;
  const path = join(dir, 'daemon.json');
  let record: DaemonRecord;
  try {
    services = await createApp({ stateDir: dir, cliPath: options.cli, host: options.host, port, auth: options.auth !== false, allowedHosts: options.allowHost ?? [], webRoot, instanceId, profile, profileStalls: true });
    if (cwd) services.store.createProject(cwd, dirname(cwd) === cwd ? cwd : cwd.split('/').at(-1)!);
    await services.app.listen({ host: options.host, port });
    const address = services.app.server.address();
    if (!address || typeof address === 'string') throw new Error('Could not determine the listening port');
    record = { pid: process.pid, port: address.port, host: options.host, instanceId, startedAt: new Date().toISOString(), args: argsFor({ ...options, port: String(address.port) }) };
    const temp = `${path}.${process.pid}.tmp`; writeFileSync(temp, JSON.stringify(record, null, 2), { mode: 0o600 }); renameSync(temp, path);
    saveLaunchConfig(options, record.args);
    // Discovery is best-effort: it must never keep the HTTP server from starting or stop it.
    if (options.mdns !== false && !mdnsDisabled(process.env.RIFFET_MDNS)) discovery = await startDiscovery({ port: address.port, host: options.host, name: 'Riffet', version: SERVER_VERSION });
  } catch (error) { await discovery?.stop(); await services?.app.close(); releaseState(); throw error; }
  if (process.stdout.isTTY) {
    printLines(await serverSummary(record, dir, { readyMs: Date.now() - began }));
    if (options.dev) process.stdout.write(hint('`pnpm dev:web`, then open http://localhost:5173', out) + '\n');
    process.stdout.write(`\n  ${out.dim('Press Ctrl+C to stop')}\n`);
  } else {
    // The log of a background server: one plain line, stamped by stampServerOutput.
    const profileTag = profile === 'lite' ? ', profile lite' : '';
    console.log(`[riffet] ${SERVER_VERSION} listening on ${serverUrl(record)} (pid ${process.pid}, ${options.auth === false ? 'no token on loopback' : 'token required'}${profileTag})`);
  }
  if (options.dev && process.env.RIFFET_PLUGIN_INDEX) console.log(`[riffet] plugin index: ${process.env.RIFFET_PLUGIN_INDEX}`);
  let shuttingDown = false;
  const stop = async () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    const timeout = setTimeout(() => process.exit(1), 8000); timeout.unref();
    try { await discovery?.stop(); await services!.app.close(); if (readDaemon(dir)?.instanceId === instanceId) unlinkSync(path); }
    finally { releaseState(); clearTimeout(timeout); process.exit(0); }
  };
  process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
  const effectiveIdleExitMs = idleExitMs ?? (isTempStateDir(dir) ? AGENT_PROCESS_BUDGET.tempInstanceIdleMinutes * 60_000 : undefined);
  if (effectiveIdleExitMs !== undefined && effectiveIdleExitMs > 0) {
    stopWhenUnused(services, effectiveIdleExitMs, isTempStateDir(dir) && idleExitMs === undefined ? 'temp instance unused' : 'idle-exit timeout reached', () => void stop());
  }
  // Node exits on an unhandled rejection; one stray background promise must not take every session down with it.
  process.on('unhandledRejection', reason => console.error('[riffet] unhandled rejection:', reason));
}

/**
 * Exits cleanly once nothing has used the server for `idleMs` — no request, no open connection,
 * no terminal viewer, and no active turn. Used for temp instances (docs/guide/performance.md §3.10)
 * and explicit `--idle-exit` scale-to-zero deployments.
 */
function stopWhenUnused(services: Awaited<ReturnType<typeof createApp>>, idleMs: number, reason: string, stop: () => void) {
  let usedAt = Date.now();
  services.app.server.on('request', () => { usedAt = Date.now(); });
  const intervalMs = Math.max(1_000, Math.min(60_000, Math.floor(idleMs / 2)));
  const timer = setInterval(() => {
    services.app.server.getConnections((error, open) => {
      const sessions = services.store.stateCounts().sessions;
      const working = ['starting', 'running', 'waiting', 'cancelling'].some(state => (sessions[state] ?? 0) > 0);
      const viewers = services.terminal.viewerCount() > 0;
      if (working || viewers || (!error && open > 0)) usedAt = Date.now();
      else if (Date.now() - usedAt >= idleMs) { clearInterval(timer); console.log(`[riffet] ${reason}; stopping`); stop(); }
    });
  }, intervalMs);
  timer.unref();
}

// ---------------------------------------------------------------------------------------------------
// start / stop / restart

const redactToken = (text: string) => text.replace(/([?&]token=)[^\s&#]+/g, '$1[REDACTED]');

/** Starts a background server unless one runs; resolves to it either way. */
export async function start(options: LaunchOptions, report: { quietIfRunning?: boolean } = {}): Promise<DaemonRecord> {
  assertSourceStartable();
  const dir = stateDir(options.stateDir);
  const existing = await active(dir);
  if (existing) {
    if (!report.quietIfRunning) printLines(await serverSummary(existing, dir, { already: true }));
    return existing;
  }
  validateLaunchOptions(options);
  if (await portFree(options.host, Number(options.port)).then(error => error?.code === 'EADDRINUSE')) {
    throw new CliError(`Port ${options.port} is already in use`, [`lsof -nP -iTCP:${options.port} -sTCP:LISTEN`, `riffet start --port ${Number(options.port) + 1}`]);
  }
  const log = join(dir, 'server.log');
  const fd = openSync(log, 'a', 0o600);
  const execArgv = [...process.execArgv];
  const resolvedProfile = resolveServerProfile(options.profile as ServerProfileInput | undefined);
  if (resolvedProfile === 'lite' && !execArgv.some(arg => arg.startsWith('--max-old-space-size'))) {
    execArgv.push(`--max-old-space-size=${serverProfileBudget('lite').v8MaxOldSpaceMb}`);
  }
  const child = spawn(process.execPath, [...execArgv, entry, ...argsFor(options)], { cwd: process.cwd(), env: { ...process.env, RIFFET_MANAGED_BY: 'cli' }, detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  closeSync(fd);
  const progress = spinner('Starting Riffet');
  // A compaction the settings page asked for runs before the service listens: wait for it, up to its own limit.
  const began = Date.now();
  let deadline = began + 8000, told = false;
  while (Date.now() < deadline) {
    await sleep(100);
    const record = await active(dir);
    if (record) {
      progress.stop();
      if (!report.quietIfRunning) printLines(await serverSummary(record, dir, { readyMs: Date.now() - began }));
      return record;
    }
    if (child.exitCode !== null) break;
    if (compactionRunning(dir)) {
      if (!told) { progress.update('Compacting the database before Riffet starts; this can take several minutes'); told = true; }
      deadline = Math.min(Math.max(deadline, Date.now() + 8000), began + COMPACTION_WAIT_MS);
    }
  }
  progress.stop();
  let tail = '';
  try { tail = readFileSync(log, 'utf8').split('\n').slice(-12).join('\n').trim(); } catch { /* the log itself may be missing */ }
  throw new CliError(`Riffet did not start${tail ? '\n' + err.dim(redactToken(tail).split('\n').map(line => '│ ' + line).join('\n')) : ''}`, [`riffet logs  ${err.dim('(full log: ' + tilde(log) + ')')}`, 'riffet doctor']);
}

/** Stops the server on this state directory; resolves to whether one was running. */
export async function stop(options: { stateDir: string }, report: { quiet?: boolean } = {}): Promise<boolean> {
  const dir = stateDir(options.stateDir);
  const record = await active(dir);
  if (!record) {
    if (!report.quiet) process.stdout.write(`${out.dim(MARK.stopped)} Riffet is not running\n`);
    return false;
  }
  if ((await health(record))?.managedBy === 'app') throw new CliError('This server is run by Riffet.app', [APP_MANAGED_HINT]);
  if (!ownsPid(record)) throw new CliError(`Process ${record.pid} does not look like this Riffet server; not signalling it`, ['riffet status']);
  const progress = spinner('Stopping Riffet');
  const signal = (name: NodeJS.Signals) => { try { process.kill(record.pid, name); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } };
  let stopped = false;
  try {
    signal('SIGTERM');
    for (let i = 0; i < 70 && !stopped; i++) { await sleep(150); stopped = !pidExists(record.pid); }
    if (!stopped) signal('SIGKILL');
  } finally { progress.stop(); }
  if (!stopped) warning('Riffet did not stop in 10s and was killed; check your conversations after the next start');
  else if (!report.quiet) process.stdout.write(`${out.ok(MARK.ok)} Stopped ${out.dim('· terminals and agent sessions keep running')}\n`);
  return true;
}

/** `restart` and `update` alike: how long to wait for the turns a restart would end; 0 (`--force` or `--wait-idle 0`) does not wait. */
export interface RestartWaitOptions { waitIdle?: string; force?: boolean }
export function restartWaitSeconds(options: RestartWaitOptions): number {
  const seconds = options.waitIdle === undefined ? 180 : Number(options.waitIdle);
  if (!Number.isInteger(seconds) || seconds < 0) throw new UsageError('--wait-idle takes a whole number of seconds');
  return options.force ? 0 : seconds;
}

/** Restarts once it would end no turn, holding new deliveries back meanwhile (docs/DELIVERY.md, 重启); a service without those endpoints restarts as before. */
export async function restart(options: LaunchOptions & RestartWaitOptions, command: Command): Promise<void> {
  const dir = stateDir(options.stateDir);
  const previous = readDaemon(dir);
  const next = resolveLaunchOptions(options, command, previous?.args ?? savedLaunchArgs(dir));
  validateLaunchOptions(next);
  const waitSeconds = restartWaitSeconds(options);
  const record = await active(dir);
  if (record && (await health(record))?.managedBy === 'app') throw new CliError('This server is run by Riffet.app', [APP_MANAGED_HINT]);
  let release: (() => Promise<void>) | undefined;
  if (record && waitSeconds > 0) {
    // The conversations in the way are named once; the spinner only shows that it is still waiting.
    let waiting = spinner('Checking for running turns');
    try { release = await drainForRestart(record, accessToken(dir), { waitSeconds, log: message => { waiting.stop(); note(message); waiting = spinner('Waiting for them to finish'); } }); }
    finally { waiting.stop(); }
  }
  // The service is still up if stopping failed: let it deliver again.
  try { await stop({ stateDir: dir }, { quiet: true }); } catch (error) { await release?.(); throw error; }
  await start(next);
}

// ---------------------------------------------------------------------------------------------------
// open

/** The default action: make sure a server runs, then open it in the browser. */
export async function open(options: LaunchOptions, command: Command): Promise<void> {
  const dir = stateDir(options.stateDir);
  const running = await active(dir);
  const record = running ?? await start(resolveLaunchOptions(options, command, savedLaunchArgs(dir)));
  const url = serverUrl(record) + '/';
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : undefined;
  const result = opener ? spawnSync(opener, [url], { stdio: 'ignore' }) : undefined;
  if (!result || result.error || result.status !== 0) throw new CliError(`Could not open a browser; visit ${out.url(url)}`);
  if (running) process.stdout.write(`${out.ok(MARK.running)} Opened ${out.url(url)} ${out.dim(`· running ${duration(Date.now() - Date.parse(running.startedAt))}`)}\n`);
  else note(`Opened ${err.url(url)}`);
}
