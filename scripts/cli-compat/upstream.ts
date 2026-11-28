import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { NativeCliVersionStatus } from '../../packages/contracts/src/index.js';
import {
  cliVersionStatus,
  compareVersions,
  parseVersion,
  type CliVersionRange,
} from '../../packages/plugin-api/src/kit/cli-version.js';
import {
  BUILTIN_CLI_BACKENDS,
  readDeclaredCliVersions,
  type BuiltinCliBackendId,
} from './manifest.js';

const execFileAsync = promisify(execFile);

export type UpstreamFetchStatus = 'ok' | 'manual' | 'error';

export interface UpstreamChannelSpec {
  readonly backendId: BuiltinCliBackendId;
  readonly kind: 'npm' | 'json-manifest' | 'manual';
  readonly packageName?: string;
  readonly url?: string;
  readonly command: string;
  readonly envVar: string;
  readonly note?: string;
}

export interface UpstreamCheckResult {
  backendId: BuiltinCliBackendId;
  channel: UpstreamChannelSpec;
  status: UpstreamFetchStatus;
  testedThrough?: string;
  minimum?: string;
  installedVersion?: string;
  installedStatus: NativeCliVersionStatus;
  upstreamVersion?: string;
  stableVersion?: string;
  upstreamAhead?: boolean;
  error?: string;
  note?: string;
}

export interface CheckUpstreamOptions {
  backends?: readonly string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  repoRoot?: string;
  declared?: Partial<Record<BuiltinCliBackendId, CliVersionRange>>;
  probeLocalVersion?: (backendId: BuiltinCliBackendId, command: string) => Promise<string | undefined>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const ANTIGRAVITY_MANIFEST_BASE = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests';
const ANTIGRAVITY_FALLBACK_TARGET = 'darwin_arm64';
const SUPPORTED_ANTIGRAVITY_TARGETS = new Set([
  'darwin_arm64',
  'darwin_x64',
  'linux_arm64',
  'linux_x64',
]);

export function resolveAntigravityManifestTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const candidate = `${platform}_${arch}`;
  return SUPPORTED_ANTIGRAVITY_TARGETS.has(candidate) ? candidate : ANTIGRAVITY_FALLBACK_TARGET;
}

export function resolveAntigravityManifestUrl(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return `${ANTIGRAVITY_MANIFEST_BASE}/${resolveAntigravityManifestTarget(platform, arch)}.json`;
}

const ANTIGRAVITY_DEFAULT_TARGET = resolveAntigravityManifestTarget();
const ANTIGRAVITY_FALLBACK_URL = `${ANTIGRAVITY_MANIFEST_BASE}/${ANTIGRAVITY_FALLBACK_TARGET}.json`;

/**
 * Official public release channels for the 8 built-in CLI backends.
 * Read-only metadata used by `pnpm cli:compat upstream` to compare upstream releases against
 * locally installed CLIs and Riffet's declared `testedThrough`.
 */
export const UPSTREAM_CHANNELS: Record<BuiltinCliBackendId, UpstreamChannelSpec> = {
  claude: {
    backendId: 'claude',
    kind: 'npm',
    packageName: '@anthropic-ai/claude-code',
    url: 'https://registry.npmjs.org/-/package/@anthropic-ai%2Fclaude-code/dist-tags',
    command: 'claude',
    envVar: 'CLAUDE_CLI',
  },
  codex: {
    backendId: 'codex',
    kind: 'npm',
    packageName: '@openai/codex',
    url: 'https://registry.npmjs.org/-/package/@openai%2Fcodex/dist-tags',
    command: 'codex',
    envVar: 'CODEX_CLI',
  },
  pi: {
    backendId: 'pi',
    kind: 'npm',
    packageName: '@earendil-works/pi-coding-agent',
    url: 'https://registry.npmjs.org/-/package/@earendil-works%2Fpi-coding-agent/dist-tags',
    command: 'pi',
    envVar: 'PI_CLI',
  },
  dsh: {
    backendId: 'dsh',
    kind: 'npm',
    packageName: '@deepseek-ai/dsh',
    url: 'https://registry.npmjs.org/-/package/@deepseek-ai%2Fdsh/dist-tags',
    command: 'dsh',
    envVar: 'DSH_CLI',
  },
  traex: {
    backendId: 'traex',
    kind: 'json-manifest',
    url: 'https://lf-cdn.trae.com.cn/obj/trae-com-cn/trae-cli/v2/public/stable/latest.json',
    command: 'traex',
    envVar: 'TRAEX_CLI',
    note: 'TRAE CLI public stable manifest',
  },
  antigravity: {
    backendId: 'antigravity',
    kind: 'json-manifest',
    url: resolveAntigravityManifestUrl(),
    command: 'agy',
    envVar: 'ANTIGRAVITY_CLI',
    note: `Antigravity CLI public updater manifest (${ANTIGRAVITY_DEFAULT_TARGET})`,
  },
  droid: {
    backendId: 'droid',
    kind: 'manual',
    command: 'droid',
    envVar: 'DROID_CLI',
    note: 'Distributed via Factory installer script; check upstream manually',
  },
  cursor: {
    backendId: 'cursor',
    kind: 'manual',
    command: 'cursor-agent',
    envVar: 'CURSOR_AGENT_CLI',
    note: 'Distributed via Cursor Agent updater; check upstream manually',
  },
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function extractNpmVersions(payload: unknown): { latest?: string; stable?: string } {
  const root = asRecord(payload);
  if (!root) return {};
  const tags = asRecord(root['dist-tags']) ?? root;
  const latest = asNonEmptyString(tags.latest) ?? asNonEmptyString(root.version);
  const stable = asNonEmptyString(tags.stable);
  return {
    ...(latest ? { latest } : {}),
    ...(stable ? { stable } : {}),
  };
}

function extractManifestVersion(payload: unknown): string | undefined {
  const root = asRecord(payload);
  if (!root) return undefined;
  const directCandidates = [
    root.version,
    root.latest,
    root.tag,
    root.tag_name,
    root.releaseVersion,
    asRecord(root.release)?.version,
    asRecord(root.stable)?.version,
    asRecord(root.data)?.version,
  ];
  for (const candidate of directCandidates) {
    const text = asNonEmptyString(candidate);
    if (!text) continue;
    return parseVersion(text)?.text ?? text;
  }
  return undefined;
}

async function defaultProbeLocalVersion(
  channel: UpstreamChannelSpec,
  timeoutMs: number,
): Promise<string | undefined> {
  const executable = process.env[channel.envVar]?.trim() || channel.command;
  try {
    const { stdout, stderr } = await execFileAsync(executable, ['--version'], {
      timeout: Math.min(timeoutMs, 5_000),
      maxBuffer: 128 * 1024,
      env: process.env,
    });
    const combined = `${stdout}\n${stderr}`.trim();
    return parseVersion(combined)?.text;
  } catch {
    return undefined;
  }
}

async function fetchJsonWithTimeout(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function selectBackends(requested: readonly string[] | undefined): BuiltinCliBackendId[] {
  if (!requested?.length || requested.includes('all')) return [...BUILTIN_CLI_BACKENDS];
  const valid = new Set<string>(BUILTIN_CLI_BACKENDS);
  const selected: BuiltinCliBackendId[] = [];
  for (const id of requested) {
    if (!valid.has(id)) {
      throw new Error(`Unknown CLI backend "${id}". Expected one of: ${BUILTIN_CLI_BACKENDS.join(', ')}`);
    }
    if (!selected.includes(id as BuiltinCliBackendId)) {
      selected.push(id as BuiltinCliBackendId);
    }
  }
  return selected;
}

async function checkSingleBackend(
  backendId: BuiltinCliBackendId,
  declaredRange: CliVersionRange | undefined,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  probeLocalVersion?: (backendId: BuiltinCliBackendId, command: string) => Promise<string | undefined>,
): Promise<UpstreamCheckResult> {
  const channel = UPSTREAM_CHANNELS[backendId];
  const command = process.env[channel.envVar]?.trim() || channel.command;
  const installedTask = (probeLocalVersion
    ? probeLocalVersion(backendId, command).catch(() => undefined)
    : defaultProbeLocalVersion(channel, timeoutMs)
  ).then(raw => (raw ? parseVersion(raw)?.text ?? raw : undefined));

  if (channel.kind === 'manual' || !channel.url) {
    const installedVersion = await installedTask;
    return {
      backendId,
      channel,
      status: 'manual',
      ...(declaredRange?.testedThrough ? { testedThrough: declaredRange.testedThrough } : {}),
      ...(declaredRange?.minimum ? { minimum: declaredRange.minimum } : {}),
      ...(installedVersion ? { installedVersion } : {}),
      installedStatus: cliVersionStatus(declaredRange, installedVersion),
      ...(channel.note ? { note: channel.note } : {}),
    };
  }

  let status: UpstreamFetchStatus = 'ok';
  let upstreamVersion: string | undefined;
  let stableVersion: string | undefined;
  let error: string | undefined;

  try {
    let payload: unknown;
    try {
      payload = await fetchJsonWithTimeout(channel.url, fetchImpl, timeoutMs);
    } catch (primaryErr) {
      if (backendId === 'antigravity' && channel.url !== ANTIGRAVITY_FALLBACK_URL) {
        payload = await fetchJsonWithTimeout(ANTIGRAVITY_FALLBACK_URL, fetchImpl, timeoutMs);
      } else {
        throw primaryErr;
      }
    }
    if (channel.kind === 'npm') {
      const parsed = extractNpmVersions(payload);
      upstreamVersion = parsed.latest ?? parsed.stable;
      stableVersion = parsed.stable;
      if (!upstreamVersion) {
        status = 'error';
        error = `No latest version found in npm dist-tags for ${channel.packageName}`;
      }
    } else {
      upstreamVersion = extractManifestVersion(payload);
      if (!upstreamVersion) {
        status = 'error';
        error = 'Manifest JSON did not contain a recognizable version field';
      }
    }
  } catch (err) {
    status = 'error';
    error = err instanceof Error ? err.message : String(err);
  }

  const installedVersion = await installedTask;
  const parsedUpstream = parseVersion(upstreamVersion);
  const parsedTested = parseVersion(declaredRange?.testedThrough);
  const upstreamAhead = parsedUpstream && parsedTested
    ? compareVersions(parsedUpstream, parsedTested) > 0
    : undefined;

  return {
    backendId,
    channel,
    status,
    ...(declaredRange?.testedThrough ? { testedThrough: declaredRange.testedThrough } : {}),
    ...(declaredRange?.minimum ? { minimum: declaredRange.minimum } : {}),
    ...(installedVersion ? { installedVersion } : {}),
    installedStatus: cliVersionStatus(declaredRange, installedVersion),
    ...(upstreamVersion ? { upstreamVersion } : {}),
    ...(stableVersion ? { stableVersion } : {}),
    ...(upstreamAhead !== undefined ? { upstreamAhead } : {}),
    ...(error ? { error } : {}),
    ...(channel.note ? { note: channel.note } : {}),
  };
}

/**
 * Concurrently checks official upstream release channels against locally installed CLI versions and
 * Riffet's source-declared `testedThrough`. Individual query failures degrade to `status: 'error'`.
 */
export async function checkUpstreamVersions(
  options: CheckUpstreamOptions = {},
): Promise<UpstreamCheckResult[]> {
  const backends = selectBackends(options.backends);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const declared = options.declared ?? readDeclaredCliVersions(options.repoRoot);

  return await Promise.all(
    backends.map(backendId =>
      checkSingleBackend(backendId, declared[backendId], fetchImpl, timeoutMs, options.probeLocalVersion),
    ),
  );
}

function describeStatus(result: UpstreamCheckResult): string {
  if (result.status === 'manual') return 'manual';
  if (result.status === 'error') return 'error';
  if (result.upstreamAhead === true) return 'upgrade-available';
  if (result.upstreamAhead === false) return 'up-to-date';
  return 'ok';
}

function describeDetail(result: UpstreamCheckResult): string {
  if (result.status === 'error') return result.error ?? 'fetch failed';
  if (result.status === 'manual') return result.note ?? 'manual check required';
  const parts: string[] = [];
  if (result.channel.packageName) parts.push(`npm:${result.channel.packageName}`);
  else if (result.note) parts.push(result.note);
  if (result.stableVersion && result.stableVersion !== result.upstreamVersion) {
    parts.push(`stable=${result.stableVersion}`);
  }
  return parts.join(' ');
}

/** Formats upstream comparison results into an aligned plain-text table for CLI output. */
export function formatUpstreamTable(results: readonly UpstreamCheckResult[]): string {
  const headers = ['Backend', 'Tested Through', 'Installed', 'Upstream', 'Status', 'Channel / Note'];
  const rows = results.map(result => [
    result.backendId,
    result.testedThrough ?? '-',
    result.installedVersion ? `${result.installedVersion} (${result.installedStatus})` : '-',
    result.upstreamVersion ?? '-',
    describeStatus(result),
    describeDetail(result),
  ]);

  const widths = headers.map((header, col) =>
    Math.max(header.length, ...rows.map(row => row[col]!.length)),
  );
  const formatRow = (cells: readonly string[]) =>
    cells.map((cell, col) => cell.padEnd(widths[col]!)).join('  ').trimEnd();
  const separator = widths.map(width => '-'.repeat(width)).join('  ');

  return [formatRow(headers), separator, ...rows.map(formatRow)].join('\n');
}
