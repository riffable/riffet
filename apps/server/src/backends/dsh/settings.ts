import { createHash } from 'node:crypto';
import { execFile as nodeExecFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ModelInputModalities, Session } from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import { defaultDshConfigDir } from '../../compat.js';
import { describeSearch, isCliMissing, resolveCliExecutable } from '../shared/cli-resolve.js';
import { parseVersion, versionAtLeast, type CliVersion, type CliVersionRange } from '../shared/cli-version.js';
import type { NativeBackendAvailability, NativeBackendProfileConfig } from '../types.js';
import { nonEmpty } from './util.js';
import { dshProfilePatch, type DshProfilePatchSettings } from './profile-patch.js';
import { DEFAULT_MODEL } from './selection.js';

export { DEFAULT_MODEL, DEFAULT_PROVIDER } from './selection.js';

const execFile = promisify(nodeExecFile);
const PROFILE_NAME_PREFIX = 'riffet-dsh-';

export interface DshRuntimeSettings extends DshProfilePatchSettings {
  key: string;
  profileHome: string;
  profileDir: string;
  bridgePatchPath: string;
  bridgePackageDir: string;
  executable: string;
  explicitExecutable: boolean;
  executableArgs: string[];
  cwd: string;
  sourceDir?: string;
  apiKey?: string;
  defaultModel: string;
}

function secretHash(value: string | undefined): string {
  return value ? createHash('sha256').update(value).digest('hex') : '';
}

function backendConfig(profile: NativeBackendProfileConfig): Record<string, unknown> {
  return profile.config;
}

function settingPath(value: unknown): string | undefined {
  const path = nonEmpty(value);
  return path ? resolve(path) : undefined;
}

export function runtimeSettings(profile: NativeBackendProfileConfig): DshRuntimeSettings {
  const config = backendConfig(profile);
  const configuredExecutable = nonEmpty(config.executable);
  const executable = configuredExecutable ?? 'dsh';
  const sourceDir = settingPath(config.sourceDir);
  const configDir = settingPath(config.configDir) ?? defaultDshConfigDir();
  const apiEndpoint = nonEmpty(config.apiEndpoint) ?? nonEmpty(process.env.DEEPSEEK_BASE_URL);
  const apiKey = nonEmpty(config.apiKey) ?? nonEmpty(process.env.DEEPSEEK_API_KEY);
  const defaultModel = nonEmpty(config.defaultModel) ?? process.env.DEEPSEEK_MODEL?.trim() ?? DEFAULT_MODEL;
  const enabledModels = Array.isArray(config.enabledModels) ? config.enabledModels.filter((id): id is string => typeof id === 'string') : undefined;
  const modelInputModalities = declaredModelInputModalities(config.modelInputModalities);
  const profileId = profile.id;
  const profileName = `${PROFILE_NAME_PREFIX}${createHash('sha256').update(profileId).digest('hex').slice(0, 16)}`;
  // DSH reads the catalog once at boot. Hash the actual overlay so declarations that do not
  // change it (including picker-only lists) can share a process. The default model is selected
  // per conversation, rather than passed to the process, and can change without a restart.
  const patch = dshProfilePatch({ profileName, apiEndpoint, enabledModels, modelInputModalities });
  const key = createHash('sha256').update(JSON.stringify({
    profileId, executable, explicitExecutable: configuredExecutable !== undefined, sourceDir,
    configDir, apiEndpoint, apiKey: secretHash(apiKey), cwd: sourceDir ?? process.cwd(), patch,
  })).digest('hex');
  const profileDir = join(configDir, 'profiles', profileName);
  return {
    key, profileHome: configDir, profileName, profileDir,
    bridgePatchPath: join(profileDir, `.riffet-bridge-${key.slice(0, 16)}.patch.yml`),
    bridgePackageDir: join(profileDir, 'node_modules', '@riffet', 'dsh-native-bridge'),
    executable, explicitExecutable: configuredExecutable !== undefined, executableArgs: [], cwd: sourceDir ?? process.cwd(),
    ...(sourceDir ? { sourceDir } : {}), ...(apiEndpoint ? { apiEndpoint } : {}),
    ...(apiKey ? { apiKey } : {}), defaultModel,
    ...(enabledModels ? { enabledModels } : {}),
    ...(modelInputModalities ? { modelInputModalities } : {}),
  };
}

/** Keep only the declarations the settings layer would have accepted; a hand-edited file is not trusted. */
function declaredModelInputModalities(value: unknown): ModelInputModalities | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: ModelInputModalities = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!id.trim() || !Array.isArray(raw)) continue;
    const modalities = raw.filter((item): item is 'text' | 'image' => item === 'text' || item === 'image');
    if (!modalities.length) continue;
    result[id] = [...new Set(modalities)];
  }
  return Object.keys(result).length ? result : undefined;
}

export function runtimeKey(profile: NativeBackendProfileConfig): string { return runtimeSettings(profile).key; }

/** Stable, opaque DSH session id derived from a workbench session id. */
export function nativeDshSessionId(session: Session): string {
  if (session.nativeSessionId) return requireSafeNativeSessionId(session.nativeSessionId);
  const digest = createHash('sha256').update(session.id).digest('hex').slice(0, 32);
  return `riffet-${digest}`;
}

export function requireSafeNativeSessionId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new AppError('NATIVE_SESSION_ID_INVALID', 'The DeepSeek Harness session id is not a safe DSH session identifier', 400);
  }
  return value;
}

export function validateDshNativeSessionId(value: string): void {
  requireSafeNativeSessionId(value);
}

/**
 * The bridge is written against dsh 0.2.0-rc.2 (0.1.x is incompatible); 0.2.1-rc.2 is the newest
 * run end to end.
 */
export const DSH_CLI_VERSIONS: CliVersionRange = { minimum: '0.2.0-rc.2', testedThrough: '0.2.1-rc.2' };
const DSH_MINIMUM = DSH_CLI_VERSIONS.minimum!;

/** Finds a compatible configured CLI without writing profiles or installing packages. */
export async function probeDshCli(profile: NativeBackendProfileConfig): Promise<NativeBackendAvailability> {
  const settings = runtimeSettings(profile);
  const command = resolveExecutable(settings);
  if (!command) {
    return { available: false, reason: `The configured DSH sourceDir has no built apps/cli/lib/bin.js. Build DeepSeek Harness first or configure its dsh ${DSH_MINIMUM} executable.` };
  }
  try {
    const result = await execFile(command.executable, [...command.args, '--version'], {
      cwd: command.cwd,
      env: scrubbedEnvironment(),
      timeout: 8_000,
      maxBuffer: 32 * 1024,
    });
    const version = `${result.stdout}\n${result.stderr}`.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').trim();
    const parsed = parseVersion(version);
    if (!parsed) return { available: false, reason: `Could not read DeepSeek Harness version from ${command.executable}.` };
    if (!isSupportedDshVersion(parsed)) {
      return { available: false, reason: `DeepSeek Harness ${parsed.text} is incompatible; configure a built dsh 0.2.x CLI (minimum ${DSH_MINIMUM}).`, version };
    }
    return { available: true, version };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // The bare name `dsh` used to be the whole answer, and it silently depended on the daemon's
      // PATH — which a service started without a login shell does not have. Say what was searched
      // and how to make it unconditional.
      const resolution = resolveCliExecutable({ command: settings.executable });
      if (!resolution.resolved) {
        const cliMissing = isCliMissing(resolution);
        return { available: false, ...(cliMissing ? { cliMissing: true } : {}), reason: `Cannot find “${settings.executable}”. Install @deepseek-ai/dsh@${DSH_MINIMUM}, then set this profile's dsh executable to its absolute path.${describeSearch(resolution)}` };
      }
      return { available: false, reason: `Cannot start DeepSeek Harness at “${command.executable}”.` };
    }
    return { available: false, reason: `Could not start DeepSeek Harness at “${command.executable}” (${typeof code === 'string' ? code : 'process error'}).` };
  }
}

/** The bridge speaks the 0.2 line's protocol: another minor is incompatible whichever way it moved. */
function isSupportedDshVersion(version: CliVersion): boolean {
  return version.major === 0 && version.minor === 2 && versionAtLeast(version, DSH_MINIMUM);
}

export function resolveExecutable(settings: DshRuntimeSettings): { executable: string; args: string[]; cwd: string } | undefined {
  if (settings.sourceDir && !settings.explicitExecutable) {
    const built = join(settings.sourceDir, 'apps', 'cli', 'lib', 'bin.js');
    if (!existsSync(built)) return undefined;
    return { executable: process.execPath, args: [built], cwd: settings.sourceDir };
  }
  return { executable: resolveCliExecutable({ command: settings.executable }).executable, args: settings.executableArgs, cwd: settings.cwd };
}

export function scrubbedEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/(?:KEY|SECRET|TOKEN|PASSWORD)/i.test(key)) environment[key] = value;
  }
  return environment;
}
