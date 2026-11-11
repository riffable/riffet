import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';
import { expandHome, isExecutableFile, nodeDirectories, pathEntries } from './environment.js';

/**
 * Where a backend's CLI actually is.
 *
 * Every backend used to fall back to a bare command name (`dsh`, `claude`, `codex`, `cursor-agent`)
 * and hope the daemon's PATH contained it. PATH is the least reliable thing a background service
 * has: it depends on which shell started it, which rc files that shell read, and which node version
 * manager was active. Resolving to an absolute path here means a configured install survives a
 * hostile environment, and a missing one produces a message that names what was searched.
 */
export type CliResolutionSource =
  /** An absolute path the user configured. */
  | 'configured'
  /** The configured value is relative; it was made absolute against the working directory. */
  | 'configured-relative'
  /** A `shell:<function>` launcher resolved by the user's own shell. */
  | 'shell-function'
  /** Found in one of the daemon's PATH directories. */
  | 'path'
  /** Found in a known install directory. */
  | 'install-dir'
  /** Found beside the node that runs the daemon (where global npm packages land). */
  | 'node-prefix'
  /** Not found anywhere. */
  | 'unresolved';

export interface CliResolution {
  /** The value to execute: absolute when resolved, otherwise the configured command. */
  executable: string;
  /** The configured command name, kept so messages can show what the user asked for. */
  configured: string;
  resolved: boolean;
  source: CliResolutionSource;
  /** Directories the search covered, for a truthful "could not find it" message. */
  searched: string[];
}

export interface CliResolveInput {
  command: string;
  env?: NodeJS.ProcessEnv;
  /** Extra directories to search before the platform defaults. */
  candidates?: string[];
  /** The node that runs the daemon; global npm shims usually sit beside it. */
  executablePath?: string;
  home?: string;
  cwd?: string;
}

const WINDOWS_EXTENSIONS = ['', '.cmd', '.exe', '.bat', '.ps1'];

/** Install directories worth searching when PATH is wrong or empty. */
export function installDirectories(input: CliResolveInput = { command: '' }): string[] {
  const home = input.home ?? homedir();
  return [
    ...(input.candidates ?? []),
    join(home, '.local', 'bin'),
    join(home, '.local', 'bin', 'node', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.yarn', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.asdf', 'shims'),
    join(home, '.local', 'share', 'mise', 'shims'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/home/linuxbrew/.linuxbrew/bin',
    '/snap/bin',
    '/usr/bin',
    '/bin',
    ...nodeDirectories(input.executablePath),
  ];
}

function lookIn(directory: string, command: string): string | undefined {
  const names = process.platform === 'win32' ? WINDOWS_EXTENSIONS.map(extension => `${command}${extension}`) : [command];
  for (const name of names) {
    const candidate = join(directory, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolve a configured command to something executable, without ever rebuilding PATH.
 *
 * Absolute configuration wins outright: the user already answered this question, and second
 * guessing it is how a working machine breaks after an upgrade. A bare name is searched in the
 * daemon's PATH first (so the user's own order is honoured), then in the known install directories,
 * then beside the running node.
 */
export function resolveCliExecutable(input: CliResolveInput): CliResolution {
  const env = input.env ?? process.env;
  const home = input.home ?? homedir();
  const configured = input.command.trim();
  if (!configured) return { executable: '', configured, resolved: false, source: 'unresolved', searched: [] };
  if (configured.startsWith('shell:')) return { executable: configured, configured, resolved: true, source: 'shell-function', searched: [] };
  if (isAbsolute(configured) || configured.startsWith('~')) {
    const path = expandHome(configured, home);
    const absolute = isAbsolute(path) ? path : resolve(input.cwd ?? process.cwd(), path);
    return { executable: absolute, configured, resolved: isExecutableFile(absolute), source: 'configured', searched: [] };
  }
  if (configured.includes('/') || configured.includes('\\')) {
    const absolute = resolve(input.cwd ?? process.cwd(), expandHome(configured, home));
    return { executable: absolute, configured, resolved: isExecutableFile(absolute), source: 'configured-relative', searched: [] };
  }
  const searched: string[] = [];
  for (const directory of pathEntries(env.PATH)) {
    if (!isAbsolute(directory)) continue;
    searched.push(directory);
    const found = lookIn(directory, configured);
    if (found) return { executable: found, configured, resolved: true, source: 'path', searched };
  }
  const nodeOwned = new Set(nodeDirectories(input.executablePath));
  for (const directory of installDirectories({ ...input, home })) {
    if (!isAbsolute(directory) || searched.includes(directory) || !existsSync(directory)) continue;
    searched.push(directory);
    const found = lookIn(directory, configured);
    if (found) {
      const source: CliResolutionSource = nodeOwned.has(directory) ? 'node-prefix' : 'install-dir';
      return { executable: found, configured, resolved: true, source, searched };
    }
  }
  return { executable: configured, configured, resolved: false, source: 'unresolved', searched };
}

/** The shell a `shell:<function>` launcher has to run under: the user's own, not a hardcoded zsh. */
export function resolveCommandShell(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SHELL;
  if (configured && isAbsolute(configured) && existsSync(configured)) {
    const name = basename(configured).toLowerCase();
    if (name === 'zsh' || name === 'bash' || name === 'fish') return configured;
  }
  for (const fallback of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (existsSync(fallback)) return fallback;
  }
  return '/bin/sh';
}

export function shellFunctionInvocation(functionName: string, args: string[], env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  return { command: resolveCommandShell(env), args: ['-lic', `${functionName} "$@"`, 'riffet', ...args] };
}

/** A short, honest description of a failed search, for a probe's reason string. */
export function describeSearch(resolution: CliResolution, limit = 8): string {
  if (resolution.resolved || !resolution.searched.length) return '';
  const shown = resolution.searched.slice(0, limit).join(delimiter === ':' ? ', ' : ', ');
  const rest = resolution.searched.length > limit ? `, +${resolution.searched.length - limit} more` : '';
  return ` Searched: ${shown}${rest}.`;
}
