import { execFile as execFileCallback } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { expandHome, isExecutableFile, mergePath, nodeDirectories, pathEntries } from '../../../packages/plugin-api/src/kit/environment.js';

export { expandHome, isExecutableFile, mergePath, nodeDirectories, pathEntries };

const execFile = promisify(execFileCallback);

/**
 * The daemon's own environment, resolved once per process.
 *
 * Two concerns were previously collapsed into one: keeping the calling agent's credentials out of
 * the daemon (they would otherwise reach every terminal and every agent started from the UI), and
 * giving the daemon the toolchain the user actually installed. The old implementation achieved the
 * first by rebuilding the environment from an allowlist (`env -i` plus a handful of directories),
 * which can never enumerate how a given machine installs node, dsh, cursor-agent or pnpm. Losing
 * `dsh` after a restart was one symptom; silently moving the whole service onto a different node
 * runtime was another.
 *
 * So this module inverts the strategy: the inherited environment is *scrubbed* rather than
 * replaced, and PATH is resolved from a trusted source with explicit, ordered fallbacks. Nothing
 * here may ever be fatal — a machine with no login shell, no cache and a bare PATH still has to
 * start.
 */

/** Agent-runtime variables that must never reach a daemon or a terminal it starts. */
const LEAKED_PREFIXES = ['ANTHROPIC_', 'CLAUDE_', 'CLAUDE_CODE_', 'CURSOR_', 'MIRAGE_', 'SSH_', 'RIFFET_RESTART_'];
/** Shell/session bookkeeping that would confuse a fresh login inside a terminal. */
const LEAKED_KEYS = new Set(['TMUX', 'TMUX_PANE', 'OLDPWD', 'SHLVL', '_', 'PROMPT_COMMAND', 'RIFFET_RESTART_DETACHED']);

export type PathSource = 'explicit' | 'login-shell' | 'cache' | 'inherited' | 'default';

export interface PathResolution {
  value: string;
  source: PathSource;
  /** Absolute directories the login shell contributed beyond what we already had. */
  added: string[];
  /** Why a higher-precedence source could not be used, when one failed. */
  note?: string;
}

export interface EnvironmentReport {
  platform: NodeJS.Platform;
  shell?: string;
  node: { path: string; version: string };
  path: PathResolution;
  /** Names removed by the scrub, so `doctor` can prove no agent credential survived. */
  dropped: string[];
  stateDir?: string;
}

let applied: EnvironmentReport | undefined;
let applying: Promise<EnvironmentReport> | undefined;

/** Extra directories a user can add without replacing the whole resolution. */
function configuredDirectories(env: NodeJS.ProcessEnv): string[] {
  return String(env.RIFFET_PATH_EXTRA ?? '')
    .split(delimiter)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0 && isAbsolute(entry));
}

/**
 * Directories appended after whatever PATH resolved, because they hold the tools riffet and its
 * terminals need. This is the successor to the old `toolchain_prefix` in `riffet-restart.sh`: the
 * same directories, but derived from the environment (and from the node that is actually running)
 * instead of hardcoded in bash.
 */
export function pathAdditions(env: NodeJS.ProcessEnv, home = homedir(), executablePath = process.execPath): string[] {
  const add = (value: string | undefined): string[] => {
    if (!value) return [];
    const trimmed = value.trim();
    return trimmed && isAbsolute(trimmed) ? [trimmed] : [];
  };
  const javaHome = add(env.JAVA_HOME);
  const androidHome = add(env.ANDROID_HOME).concat(add(env.ANDROID_SDK_ROOT));
  const pnpmHome = add(env.PNPM_HOME);
  return [
    ...javaHome.map(dir => join(dir, 'bin')),
    ...androidHome.map(dir => join(dir, 'platform-tools')),
    ...androidHome.map(dir => join(dir, 'tools')),
    ...pnpmHome.map(dir => join(dir, 'bin')),
    // The macOS app's bundled runtime serves riffet only; agents and terminals keep the user's own node.
    ...(env.RIFFET_BUNDLED_NODE === '1' ? [] : nodeDirectories(executablePath)),
    join(home, '.local', 'bin'),
    ...configuredDirectories(env),
  ];
}

/** Per-platform fallbacks for a machine whose PATH is unusable or missing. */
export function defaultPath(env: NodeJS.ProcessEnv, home = homedir()): string[] {
  const shared = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  if (process.platform === 'darwin') return [...shared, '/opt/homebrew/bin'];
  if (process.platform === 'win32') return [];
  return [
    ...shared,
    '/home/linuxbrew/.linuxbrew/bin',
    '/snap/bin',
    join(home, '.nix-profile', 'bin'),
    join(home, '.local', 'bin'),
  ];
}

/**
 * Remove the calling agent's credentials from an environment without discarding everything else.
 * A blanket `*_API_KEY` rule would be wrong here: `DEEPSEEK_API_KEY` and friends are legitimate
 * server configuration, and the daemon reads them. The curated list is what actually leaks —
 * exported by the agent runtimes that start a restart — and `RIFFET_ENV_DROP` covers the rest.
 */
export function scrubEnvironment(source: NodeJS.ProcessEnv, options: { keep?: string[]; drop?: string[] } = {}): { environment: NodeJS.ProcessEnv; dropped: string[] } {
  const keep = new Set(options.keep ?? []);
  const extraDrop = (options.drop ?? []).map(name => name.toUpperCase());
  const environment: NodeJS.ProcessEnv = {};
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    const leaks = LEAKED_KEYS.has(upper)
      || LEAKED_PREFIXES.some(prefix => upper.startsWith(prefix))
      || extraDrop.some(entry => upper === entry || upper.startsWith(`${entry}_`));
    if (leaks && !keep.has(name) && !keep.has(upper)) dropped.push(name);
    else environment[name] = value;
  }
  return { environment, dropped: dropped.sort() };
}

/**
 * A plausible PATH: printable, single-line, and pointing at directories that exist. Interactive
 * startup files can print banners, and some of them exit non-zero; requiring real directories is
 * what keeps a greeting from being mistaken for a search path.
 */
export function isPlausiblePath(value: string): boolean {
  if (!value || value.length > 32 * 1024) return false;
  if (/[\0\r\n]/.test(value)) return false;
  const entries = pathEntries(value);
  if (entries.length < 2) return false;
  let existing = 0;
  for (const entry of entries) {
    if (!isAbsolute(entry)) continue;
    try {
      if (statSync(entry).isDirectory()) existing += 1;
    } catch { /* a stale PATH entry is normal; it just does not count as evidence */ }
  }
  return existing >= 2;
}

const MARK_BEGIN = '__RIFFET_PATH_BEGIN__';
const MARK_END = '__RIFFET_PATH_END__';

export interface CaptureRequest { shell: string; args: string[]; marker: string }

/**
 * How to ask a shell for its own PATH. `-i` matters: bash and zsh only read `~/.bashrc` and
 * `~/.zshrc` interactively, and on most machines those files — not the login profiles — are what
 * put nvm, asdf, mise, pnpm and a user-local npm prefix on PATH. The login-only form is kept as a
 * second attempt because it is cheaper and still reads `~/.profile` and `/etc/profile.d`.
 */
export function captureRequests(env: NodeJS.ProcessEnv): CaptureRequest[] {
  if (process.platform === 'win32') return [];
  const shellName = basename(env.SHELL ?? '').toLowerCase();
  const candidates = shellName === 'fish' || shellName === 'bash' || shellName === 'zsh'
    ? [env.SHELL as string]
    : ['/bin/zsh', '/bin/bash'];
  const requests: CaptureRequest[] = [];
  for (const shell of candidates) {
    if (!shell || !isAbsolute(shell) || !existsSync(shell)) continue;
    const fish = basename(shell).toLowerCase() === 'fish';
    const marker = fish
      ? `printf '%s%s%s' '${MARK_BEGIN}' (string join : $PATH) '${MARK_END}'`
      : `printf '%s%s%s' '${MARK_BEGIN}' "$PATH" '${MARK_END}'`;
    requests.push({ shell, args: ['-ilc', marker], marker: shell });
    requests.push({ shell, args: ['-lc', marker], marker: shell });
  }
  return requests;
}

/** Extract the payload a capture printed, ignoring anything a startup file wrote around it. */
export function readCapture(stdout: string): string | undefined {
  const begin = stdout.indexOf(MARK_BEGIN);
  if (begin < 0) return undefined;
  const end = stdout.indexOf(MARK_END, begin + MARK_BEGIN.length);
  if (end < 0) return undefined;
  const value = stdout.slice(begin + MARK_BEGIN.length, end).trim();
  return isPlausiblePath(value) ? value : undefined;
}

export type CaptureRunner = (shell: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;

export interface CaptureOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  run?: CaptureRunner;
}

const defaultRunner: CaptureRunner = async (shell, args, env) => {
  // `-c` never reads stdin, so the inherited stdin cannot make a startup file wait for input; the
  // timeout is the backstop for a startup file that hangs on its own.
  const { stdout } = await execFile(shell, args, {
    env,
    timeout: 5000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  });
  return stdout;
};

/**
 * Ask the user's login shell what PATH it has. Every failure mode — no SHELL, a shell that hangs,
 * a startup file that prints a banner or errors out — degrades to "no answer", never to a throw.
 */
export async function captureLoginShellPath(options: CaptureOptions = {}): Promise<{ path?: string; note?: string }> {
  const env = options.env ?? process.env;
  const run = options.run ?? defaultRunner;
  const requests = captureRequests(env);
  if (!requests.length) return { note: 'no login shell available' };
  const notes: string[] = [];
  for (const request of requests) {
    try {
      const stdout = await run(request.shell, request.args, env);
      const path = readCapture(stdout);
      if (path) return { path };
      notes.push(`${basename(request.shell)} ${request.args[0]} printed no usable PATH`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      notes.push(`${basename(request.shell)} ${request.args[0]} failed${code ? ` (${code})` : ''}`);
    }
  }
  return { note: notes.join('; ') };
}

interface CachedEnvironment { version: number; path: string; source: PathSource; capturedAt: string; shell?: string }

export function environmentCachePath(stateDir: string): string {
  return join(stateDir, 'environment.json');
}

function readCache(stateDir: string | undefined): { path?: string; note?: string } {
  if (!stateDir) return {};
  try {
    const parsed = JSON.parse(readFileSync(environmentCachePath(stateDir), 'utf8')) as CachedEnvironment;
    if (typeof parsed?.path === 'string' && isPlausiblePath(parsed.path)) return { path: parsed.path };
    return { note: 'cached PATH is not usable' };
  } catch {
    return {};
  }
}

/** Remember the PATH for machines that boot without a shell. Returns a note when it could not. */
function writeCache(stateDir: string | undefined, resolution: PathResolution): string | undefined {
  if (!stateDir) return undefined;
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const record: CachedEnvironment = { version: 1, path: resolution.value, source: resolution.source, capturedAt: new Date().toISOString(), shell: process.env.SHELL };
    writeFileSync(environmentCachePath(stateDir), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    return undefined;
  } catch (error) {
    // A read-only state directory is a legitimate deployment; the resolution still stands, so this
    // belongs in the report rather than on stderr in front of every command's output.
    return `could not cache the resolved PATH: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export interface ResolveOptions extends CaptureOptions {
  stateDir?: string;
  explicitPath?: string;
  home?: string;
  /** The node whose global package directories should be appended; defaults to the running one. */
  executablePath?: string;
}

/**
 * Resolve PATH in precedence order — explicit override, live login shell, last good capture, the
 * inherited value, per-platform defaults — then append the directories riffet itself needs. The
 * chosen source is reported so `doctor` can explain a machine instead of only failing on it.
 */
export async function resolveEnvironmentPath(options: ResolveOptions = {}): Promise<PathResolution> {
  const env = options.env ?? process.env;
  const explicit = options.explicitPath ?? env.RIFFET_PATH;
  let chosen: { value?: string; source: PathSource; note?: string } = { source: 'default' };
  if (explicit && isPlausiblePath(explicit)) chosen = { value: explicit, source: 'explicit' };
  else {
    const notes: string[] = [];
    if (explicit) notes.push('RIFFET_PATH is not a usable PATH');
    const captured = await captureLoginShellPath(options);
    if (captured.path) chosen = { value: captured.path, source: 'login-shell' };
    else {
      if (captured.note) notes.push(captured.note);
      const cached = readCache(options.stateDir);
      if (cached.path) chosen = { value: cached.path, source: 'cache' };
      else {
        if (cached.note) notes.push(cached.note);
        const inherited = env.PATH;
        if (inherited && isPlausiblePath(inherited)) chosen = { value: inherited, source: 'inherited' };
        else chosen = { value: defaultPath(env, options.home).join(delimiter), source: 'default' };
      }
    }
    if (notes.length) chosen = { ...chosen, note: notes.join('; ') };
  }
  const base = pathEntries(chosen.value);
  const additions = pathAdditions(env, options.home, options.executablePath);
  const added = additions.filter(entry => !base.includes(entry));
  return {
    value: mergePath([chosen.value, ...additions]),
    source: chosen.source,
    added,
    ...(chosen.note ? { note: chosen.note } : {}),
  };
}

function readDropOption(env: NodeJS.ProcessEnv, name: string): string[] {
  return String(env[name] ?? '').split(/[,\s]+/).map(entry => entry.trim()).filter(Boolean);
}

/**
 * Apply the resolved environment to this process. Idempotent, and the single place any riffet
 * entry point — `riffet serve`, `riffet start`, `install-service`, the restart script's child —
 * gets its environment from, so all of them agree.
 */
export async function applyProcessEnvironment(options: ResolveOptions = {}): Promise<EnvironmentReport> {
  if (applied) return applied;
  if (applying) return await applying;
  applying = (async (): Promise<EnvironmentReport> => {
    const source = options.env ?? process.env;
    const { environment, dropped } = scrubEnvironment(source, {
      keep: readDropOption(source, 'RIFFET_ENV_KEEP'),
      drop: readDropOption(source, 'RIFFET_ENV_DROP'),
    });
    // Identity is ours to state, not the caller's to leak: a terminal started from the UI must
    // look like a normal login for this user.
    environment.HOME = source.HOME || homedir();
    environment.USER = source.USER || environment.LOGNAME || '';
    environment.LOGNAME = environment.USER;
    environment.SHELL = source.SHELL || environment.SHELL || '/bin/sh';
    environment.TERM = source.TERM || 'xterm-256color';
    environment.LANG = source.LANG || 'en_US.UTF-8';
    for (const name of Object.keys(source)) if (!(name in environment)) delete process.env[name];
    for (const [name, value] of Object.entries(environment)) if (value !== undefined) process.env[name] = value;
    const path = await resolveEnvironmentPath({ ...options, env: environment });
    process.env.PATH = path.value;
    if (path.source === 'login-shell' || path.source === 'explicit') {
      const failure = writeCache(options.stateDir, path);
      if (failure) path.note = path.note ? `${path.note}; ${failure}` : failure;
    }
    applied = {
      platform: process.platform,
      ...(environment.SHELL ? { shell: environment.SHELL } : {}),
      node: { path: process.execPath, version: process.version },
      path,
      dropped,
      ...(options.stateDir ? { stateDir: options.stateDir } : {}),
    };
    return applied;
  })();
  return await applying;
}

/** The report for the environment this process is running with, if it has been applied. */
export function currentEnvironmentReport(): EnvironmentReport | undefined {
  return applied;
}

/** Variables worth handing to a terminal or a native session, so it matches the daemon. */
export function terminalEnvironment(report = applied): Record<string, string> {
  const names = ['PATH', 'JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'PNPM_HOME', 'LANG', 'LC_ALL', 'TZ', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'SSH_AUTH_SOCK'];
  const environment: Record<string, string> = {};
  for (const name of names) {
    const value = name === 'PATH' ? report?.path.value ?? process.env.PATH : process.env[name];
    // A `-e KEY=value` argument cannot carry a line break, and no legitimate value here has one.
    if (typeof value === 'string' && value.length > 0 && !/[\0\r\n]/.test(value)) environment[name] = value;
  }
  return environment;
}

/** Test seam: forget the memoized result so a case can resolve a different environment. */
export function resetEnvironmentForTests(): void {
  applied = undefined;
  applying = undefined;
}

/** Read-only view used by `doctor` when the process never applied an environment (tests, probes). */
export function describeEnvironment(): Promise<EnvironmentReport> {
  return applyProcessEnvironment({});
}
