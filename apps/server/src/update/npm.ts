import type { BuildInfo, UpdateCheck } from '@contracts';
import { execFile } from 'node:child_process';
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import { compareReleaseTags, parseReleaseTag } from './git.js';

const execFileAsync = promisify(execFile);

export const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org';
const CONFIG_TIMEOUT_MS = 2000;

/**
 * Whether this program was installed from the npm package: the published manifest next to dist/
 * is not private, unlike a checkout's and the App payload's. Under tsx it resolves to nothing.
 */
export function isNpmInstall(from: URL = new URL('../package.json', import.meta.url)): boolean {
  try {
    const manifest = JSON.parse(readFileSync(fileURLToPath(from), 'utf8')) as { name?: unknown; private?: unknown };
    return manifest.name === 'riffet' && manifest.private !== true;
  } catch { return false; }
}

export function normalizeRegistry(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === 'undefined' || trimmed === 'null') return undefined;
  try {
    const parsed = new URL(trimmed);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.search || parsed.hash) return undefined;
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

export function displayRegistry(raw: string): string {
  try {
    const parsed = new URL(raw);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return raw;
  }
}

function parseNpmrcValue(raw: string): string {
  const trimmed = raw.trim();
  const quoted = /^(['"])(.*?)\1(?:\s*(?:[#;].*)?)?$/.exec(trimmed);
  if (quoted) return quoted[2]!;
  return trimmed.replace(/\s+[#;].*$/, '').trim();
}

function readNpmrcRegistry(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = env.npm_config_userconfig?.trim() || env.NPM_CONFIG_USERCONFIG?.trim() || join(homedir(), '.npmrc');
  let resolved: string | undefined;
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (/^\s*[#;]/.test(line)) continue;
      const match = /^\s*registry\s*=\s*(.+?)\s*$/.exec(line);
      if (!match) continue;
      const normalized = normalizeRegistry(parseNpmrcValue(match[1]!));
      if (normalized) resolved = normalized;
    }
  } catch { /* unreadable or absent .npmrc */ }
  return resolved;
}

function readBunfigRegistry(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const home = env.HOME?.trim() || homedir();
  const candidates = [
    join(process.cwd(), 'bunfig.toml'),
    ...(env.BUN_INSTALL?.trim() ? [join(env.BUN_INSTALL.trim(), 'bunfig.toml')] : []),
    join(home, '.bunfig.toml'),
  ];
  for (const file of candidates) {
    try {
      const parsed = parseToml(readFileSync(file, 'utf8')) as { install?: { registry?: unknown } };
      const raw = parsed.install?.registry;
      const value = typeof raw === 'string'
        ? raw
        : raw && typeof raw === 'object' && 'url' in raw && typeof (raw as { url?: unknown }).url === 'string'
          ? (raw as { url: string }).url
          : undefined;
      const normalized = normalizeRegistry(value);
      if (normalized) return normalized;
    } catch { /* absent or invalid bunfig.toml */ }
  }
  return undefined;
}

export async function configuredNpmRegistry(
  manager: NpmInstaller['manager'],
  options: { env?: NodeJS.ProcessEnv; exec?: (command: string, args: string[]) => Promise<string> } = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const candidates = manager === 'pnpm'
    ? [env.npm_config_registry, env.pnpm_config_registry, env.NPM_CONFIG_REGISTRY]
    : manager === 'yarn'
      ? [env.YARN_NPM_REGISTRY_SERVER, env.npm_config_registry, env.NPM_CONFIG_REGISTRY]
      : [env.npm_config_registry, env.NPM_CONFIG_REGISTRY];
  const envRegistry = candidates.map(normalizeRegistry).find(Boolean);
  if (envRegistry) return envRegistry;

  const run = options.exec ?? (async (command: string, args: string[]) => {
    const { stdout } = await execFileAsync(command, args, { env, timeout: CONFIG_TIMEOUT_MS, encoding: 'utf8' });
    return stdout;
  });
  const queries = manager === 'npm' || manager === 'pnpm'
    ? [['config', 'get', 'registry']]
    : manager === 'yarn'
      ? [['config', 'get', 'npmRegistryServer'], ['config', 'get', 'registry']]
      : [];
  for (const args of queries) {
    try {
      const registry = normalizeRegistry(await run(manager, args));
      if (registry) return registry;
    } catch { /* fall back to config files / official registry */ }
  }
  return (manager === 'bun' ? readBunfigRegistry(env) : undefined) ?? readNpmrcRegistry(env);
}

export function candidateNpmRegistries(configured?: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.RIFFET_NPM_REGISTRIES ?? '').split(/[\s,]+/).filter(Boolean);
  const candidates = [configured, ...extra, OFFICIAL_NPM_REGISTRY]
    .map(normalizeRegistry)
    .filter((value): value is string => Boolean(value));
  return [...new Set(candidates)];
}

async function fetchRegistryLatest(registry: string, fetchImpl: typeof fetch): Promise<{ registry: string; version: string } | undefined> {
  try {
    const response = await fetchImpl(`${registry}/riffet/latest`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    const version = response.ok ? (await response.json() as { version?: unknown }).version : undefined;
    // Only a stable x.y.z goes any further; anything else from the network is dropped.
    if (typeof version !== 'string' || !parseReleaseTag(`v${version}`)) return undefined;
    return { registry, version };
  } catch {
    return undefined;
  }
}

function detectNpmManager(from: URL = new URL('..', import.meta.url)): NpmInstaller['manager'] {
  try {
    const real = realpathSync(fileURLToPath(from)).replace(/[\\/]$/, '');
    const parts = real.split(sep);
    return parts.includes('pnpm') || parts.some(part => part.startsWith('.pnpm')) ? 'pnpm'
      : parts.includes('.bun') ? 'bun'
      : parts.includes('.yarn') || parts.includes('yarn') ? 'yarn'
      : 'npm';
  } catch {
    return 'npm';
  }
}

export interface InspectedNpmUpdate {
  check: UpdateCheck;
  /** Non-undefined only when the winning version must be installed from a registry other than the configured default. */
  registry?: string;
}

/**
 * Checks both the package manager's configured registry and `registry.npmjs.org`, returning the
 * newest stable version found across reachable registries and noting when installation needs an
 * explicit `--registry` override because the configured mirror lags behind.
 */
export async function inspectNpmUpdate(
  current: BuildInfo,
  options: {
    from?: URL;
    fetch?: typeof fetch;
    registries?: readonly string[];
    configuredRegistry?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<InspectedNpmUpdate> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const manager = detectNpmManager(options.from);
  const configured = options.configuredRegistry !== undefined
    ? normalizeRegistry(options.configuredRegistry)
    : options.registries ? normalizeRegistry(options.registries[0]) : await configuredNpmRegistry(manager, { env });
  const registries = options.registries
    ? [...new Set(options.registries.map(normalizeRegistry).filter((value): value is string => Boolean(value)))]
    : candidateNpmRegistries(configured, env);

  const hits = (await Promise.all(registries.map(registry => fetchRegistryLatest(registry, fetchImpl))))
    .filter((entry): entry is { registry: string; version: string } => Boolean(entry));

  let best: { registry: string; version: string } | undefined;
  for (const hit of hits) {
    if (!best || compareReleaseTags(`v${hit.version}`, `v${best.version}`) > 0) best = hit;
  }
  if (!best) {
    return { check: { status: 'unavailable', current, latest: null, source: null, message: 'Could not reach the npm registry from this computer.' } };
  }

  // A prerelease or local version is not something the registry's release can be ordered against.
  if (!parseReleaseTag(`v${current.version}`)) {
    return { check: { status: 'development', current, latest: null, source: null, latestVersion: best.version } };
  }
  const order = compareReleaseTags(`v${current.version}`, `v${best.version}`);
  const check: UpdateCheck = {
    status: order < 0 ? 'available' : order > 0 ? 'ahead' : 'current',
    current,
    latest: null,
    source: null,
    latestVersion: best.version,
  };
  const defaultRegistry = configured ?? OFFICIAL_NPM_REGISTRY;
  const defaultHasBest = hits.some(hit => hit.registry === defaultRegistry && compareReleaseTags(`v${hit.version}`, `v${best.version}`) >= 0);
  return { check, ...(defaultHasBest ? {} : { registry: best.registry }) };
}

/**
 * Release check for an npm install, which has no Git clone to inspect. The registry only names a
 * version, so `latest` stays null rather than inventing a commit and `latestVersion` carries it.
 */
export async function checkNpmUpdate(current: BuildInfo): Promise<UpdateCheck> {
  return (await inspectNpmUpdate(current)).check;
}

/**
 * The path to `real` (a file in this package, symlinks resolved) that still leads to the installed version
 * after an update. pnpm keeps each version in its own store directory
 * (`…/node_modules/.pnpm/riffet@0.7.0/node_modules/riffet`) and points `…/node_modules/riffet` at the
 * current one; a server, a login service or a restart started from the store path would run the old
 * version, or a directory pnpm has pruned. Other managers replace the package in place.
 */
export function stablePath(real: string): string {
  const marker = `${sep}node_modules${sep}.pnpm${sep}`;
  const at = real.indexOf(marker);
  if (at < 0) return real;
  const rest = real.slice(at + marker.length).split(sep); // riffet@0.7.0, node_modules, riffet, dist, cli.js
  if (rest[1] !== 'node_modules' || rest[2] !== 'riffet') return real;
  const candidate = join(real.slice(0, at), 'node_modules', ...rest.slice(2));
  try { return realpathSync(candidate) === real ? candidate : real; } catch { return real; }
}

/** The package manager that owns a global install, and the command that replaces it with `version`. */
export interface NpmInstaller { manager: 'npm' | 'pnpm' | 'bun' | 'yarn'; command: string; args: string[]; root: string; writable: boolean }

/**
 * Which tool installed this package globally, read off where it lives: pnpm, bun and Yarn keep their
 * global packages in directories of their own; anything else is npm's (`<prefix>/lib/node_modules`).
 */
export function npmInstaller(version: string, from: URL = new URL('..', import.meta.url), registry?: string): NpmInstaller {
  const real = realpathSync(fileURLToPath(from)).replace(/[\\/]$/, '');
  const root = stablePath(real);
  const spec = `riffet@${version}`;
  const parts = real.split(sep);
  const manager: NpmInstaller['manager'] = parts.includes('pnpm') || parts.some(part => part.startsWith('.pnpm')) ? 'pnpm'
    : parts.includes('.bun') ? 'bun'
    : parts.includes('.yarn') || parts.includes('yarn') ? 'yarn'
    : 'npm';
  const baseArgs = manager === 'npm' ? ['install', '-g', spec] : manager === 'pnpm' ? ['add', '-g', spec] : manager === 'bun' ? ['add', '-g', spec] : ['global', 'add', spec];
  const normalized = normalizeRegistry(registry);
  const args = normalized ? [...baseArgs, `--registry=${normalized}`] : baseArgs;
  // The package directory and the directory holding it are replaced; both have to be writable.
  // `root` is where the next version will be found, so a restart runs `root/dist/cli.js`.
  let writable = true;
  try { accessSync(root, constants.W_OK); accessSync(dirname(root), constants.W_OK); } catch { writable = false; }
  return { manager, command: manager, args, root, writable };
}

export function isMissingNpmTargetOutput(output: string): boolean {
  return /\bETARGET\b|No matching version found|No version matching\b|Couldn't find any versions/i.test(output);
}
