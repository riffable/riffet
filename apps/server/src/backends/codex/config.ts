import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Project } from '../../../../../packages/contracts/src/index.js';
import { readProbe, type AppServerProbe, type CodexFlavor } from './flavors.js';
import { resolveCliExecutable } from '../shared/cli-resolve.js';
import { versionAtLeast } from '../shared/cli-version.js';
import type { NativeBackendProfileConfig } from '../types.js';
import { str } from './util.js';

/** A rollout larger than this is not read whole for statistics. */
export const MAX_ROLLOUT_BYTES = 64 * 1024 * 1024;
const execFileAsync = promisify(execFile);
const probes = new Map<string, Promise<AppServerProbe>>();
const PROFILE_PREFERENCE_FIELDS = new Set(['id', 'backendId', 'name', 'description', 'isDefault', 'defaultModel', 'enabledModels', 'modelInputModalities']);
type CodexPermissionId = 'on-request' | 'read-only' | 'danger-full-access';
type PermissionId = CodexPermissionId | 'auto-review';
type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
interface Permission {
  id: PermissionId;
  approvalPolicy: 'on-request' | 'never';
  sandbox: CodexSandboxMode;
  approvalsReviewer?: 'user' | 'auto_review';
  permissions?: { type: 'profile'; id: string };
}

/**
 * Each permission is one of Codex's own presets, an approval policy paired with a sandbox: an
 * approval policy alone is not a permission — `never` inside the read-only sandbox Codex falls back
 * to for an untrusted project can neither write nor ask to. Ids recorded before the presets existed
 * (`never`, `untrusted`) settle on the default rather than widening what was chosen; `unrestricted`
 * is the cross-backend "run everything".
 */
const CODEX_PERMISSIONS: Record<CodexPermissionId, { approvalPolicy: 'on-request' | 'never'; sandbox: CodexSandboxMode }> = {
  'on-request': { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  'read-only': { approvalPolicy: 'on-request', sandbox: 'read-only' },
  'danger-full-access': { approvalPolicy: 'never', sandbox: 'danger-full-access' },
};

export function normalizePermission(value: string | undefined, flavor: CodexFlavor['id'] = 'codex'): PermissionId {
  if (flavor === 'traex' && value === 'auto-review') return value;
  if (value === 'read-only' || value === 'danger-full-access') return value;
  if (value === 'unrestricted') return 'danger-full-access';
  return 'on-request';
}

export function permissionOf(value: string | undefined, flavor: CodexFlavor['id'] = 'codex'): Permission {
  const id = normalizePermission(value, flavor);
  const permission = CODEX_PERMISSIONS[id === 'auto-review' ? 'on-request' : id];
  if (flavor !== 'traex') return { ...permission, id };
  // TRAE's native workspace profile includes network access. Its Auto Mode uses that same
  // profile with Guardian review; always name the reviewer so leaving Auto Mode clears it.
  return { ...permission, id, approvalsReviewer: id === 'auto-review' ? 'auto_review' : 'user', permissions: {
    type: 'profile', id: id === 'read-only' ? ':read-only' : id === 'danger-full-access' ? ':danger-full-access' : ':workspace',
  } };
}

/** Recognize the native presets only; custom profiles must not be relabelled as a built-in. */
export function reportedTraePermission(settings: Record<string, unknown> | undefined): PermissionId | undefined {
  if (!settings) return undefined;
  const profile = settings.activePermissionProfile as { id?: unknown; modifications?: unknown } | null | undefined;
  // A named preset with overlays is a custom effective policy, even if its base id is built-in.
  // Do not infer a preset from the sandbox when a named profile was supplied but is unrecognizable.
  if (profile != null && (typeof profile.id !== 'string' || !Array.isArray(profile.modifications) || profile.modifications.length > 0)) return undefined;
  const sandbox = (settings.sandboxPolicy ?? settings.sandbox) as Record<string, unknown> | undefined;
  // Legacy responses have no named profile. Match the complete native preset before naming it;
  // a workspace sandbox with networking disabled is not TRAE's Workspace Edit profile.
  const workspace = sandbox?.type === 'workspaceWrite' && sandbox.networkAccess === true
    && Array.isArray(sandbox.writableRoots) && sandbox.writableRoots.length === 0
    && sandbox.excludeTmpdirEnvVar === false && sandbox.excludeSlashTmp === false;
  const id = profile?.id ?? (workspace ? ':workspace'
    : sandbox?.type === 'readOnly' && sandbox.networkAccess === false ? ':read-only'
      : sandbox?.type === 'dangerFullAccess' ? ':danger-full-access' : undefined);
  const reviewer = settings.approvalsReviewer;
  if (id === ':danger-full-access' && settings.approvalPolicy === 'never' && reviewer === 'user') return 'danger-full-access';
  if (settings.approvalPolicy !== 'on-request') return undefined;
  if (id === ':workspace') {
    if (reviewer === 'auto_review' || reviewer === 'guardian_subagent') return 'auto-review';
    if (reviewer === 'user') return 'on-request';
  }
  if (id === ':read-only' && reviewer === 'user') return 'read-only';
  return undefined;
}

/**
 * `turn/start` takes the full policy, not the mode name; these are the values Codex derives for each
 * mode by default.
 */
export function sandboxPolicyOf(mode: CodexSandboxMode): Record<string, unknown> {
  if (mode === 'danger-full-access') return { type: 'dangerFullAccess' };
  if (mode === 'read-only') return { type: 'readOnly', networkAccess: false };
  return { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

export function configuredCommand(profile: NativeBackendProfileConfig, flavor: CodexFlavor): string {
  return str(profile.config.executable) ?? (process.env[flavor.executableEnv]?.trim() || flavor.command);
}

export function executableOf(profile: NativeBackendProfileConfig, flavor: CodexFlavor): string {
  // Resolve to an absolute path when we can: `codex` is usually a global npm package, and the
  // daemon's PATH is not guaranteed to contain the node prefix it was installed under.
  return resolveCliExecutable({ command: configuredCommand(profile, flavor) }).executable;
}

export function runtimeFingerprintFor(project: Project, profile: NativeBackendProfileConfig, flavor: CodexFlavor): string {
  // A running process is identified by what was actually launched. Profile presentation and
  // defaults for future conversations must not invalidate the owner of an existing thread.
  return createHash('sha256').update(JSON.stringify({
    version: 2, backendId: flavor.id, cwd: project.cwd, profileId: profile.id,
    executable: executableOf(profile, flavor), stateHome: flavor.stateHome(profile.config),
    args: flavor.args(profile.config), env: flavor.env(profile.config),
  })).digest('hex');
}

/** Conversation ownership is independent of the settings used to launch its process. */
export function runtimeScopeFingerprintFor(project: Project, profile: NativeBackendProfileConfig, flavor: CodexFlavor): string {
  return createHash('sha256').update(JSON.stringify([flavor.id, project.cwd, profile.id])).digest('hex');
}

/** Recognize only old representations whose launch settings we can still prove equivalent. */
export function matchesRuntimeFingerprint(saved: string, project: Project, profile: NativeBackendProfileConfig, flavor: CodexFlavor): boolean {
  const fingerprint = runtimeFingerprintFor(project, profile, flavor);
  if (saved === fingerprint) return true;
  const launchOnly = { ...profile, config: Object.fromEntries(Object.entries(profile.config).filter(([key]) => !PROFILE_PREFERENCE_FIELDS.has(key))) };
  const builtin = { ...profile, config: { executable: process.env[flavor.executableEnv]?.trim() || flavor.command } };
  for (const candidate of [profile, launchOnly, builtin]) {
    if (runtimeFingerprintFor(project, candidate, flavor) !== fingerprint) continue;
    const legacy = createHash('sha256').update(JSON.stringify([
      project.cwd, candidate.id, executableOf(candidate, flavor), JSON.stringify(candidate.config),
    ])).digest('hex');
    if (saved === legacy) return true;
  }
  return false;
}

export function assertSupportedProfile(profile: NativeBackendProfileConfig, flavor: CodexFlavor): void {
  const reason = flavor.unsupportedProfileSetting(profile.config);
  if (reason) throw new Error(reason);
}

export function providerEnv(profile: NativeBackendProfileConfig, flavor: CodexFlavor): NodeJS.ProcessEnv {
  return { ...process.env, ...flavor.env(profile.config) };
}

/** Where loopback app-servers keep their token files: private to this user, outside any project. */
export function credentialDirFor(flavor: Pick<CodexFlavor, 'id'>): string {
  return join(homedir(), '.riffet', flavor.id, 'endpoints');
}

/** Every flavor's credential directory, for code that looks for app-servers of any flavor. */
export function appServerCredentialDirs(): string[] {
  return (['codex', 'traex'] as const).map(id => credentialDirFor({ id }));
}

/** The CLI's own collaboration mode for a stored mode id, or undefined for one it does not have. */
export function collaborationModeOf(mode: string | undefined): 'default' | 'plan' | undefined {
  return mode === 'plan' || mode === 'default' ? mode : undefined;
}

/** Verified steering floors; TRAE correlates steer inputs through persisted text elements. */
export const STEER_MIN_VERSIONS: Record<CodexFlavor['id'], string> = { codex: '0.160.0', traex: '0.210.1' };

/** Only the flavor's own `--version` line or app-server user agent counts, never any other number. */
export function supportsSteerVersion(version: string | undefined, flavor: CodexFlavor['id'] = 'codex'): boolean {
  const prefix = flavor === 'codex' ? 'codex(?:-cli)?' : '(?:traecli|traex)';
  const match = version?.trim().match(new RegExp(`^(?:(?:${prefix})\\s+|(?:Codex Desktop|riffet)/)?(v?\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\\s+\\([^\\r\\n]*\\))?$`));
  return Boolean(match && versionAtLeast(match[1], STEER_MIN_VERSIONS[flavor]));
}

export async function probeAppServer(executable: string): Promise<AppServerProbe> {
  const cached = probes.get(executable);
  if (cached) return await cached;
  const task = (async () => {
    try {
      const [versionResult, appResult, tuiResult] = await Promise.all([
        execFileAsync(executable, ['--version'], { timeout: 5_000, maxBuffer: 128 * 1024, encoding: 'utf8' }),
        execFileAsync(executable, ['app-server', '--help'], { timeout: 5_000, maxBuffer: 512 * 1024, encoding: 'utf8' }),
        execFileAsync(executable, ['resume', '--help'], { timeout: 5_000, maxBuffer: 512 * 1024, encoding: 'utf8' }),
      ]);
      return readProbe(
        `${versionResult.stdout}${versionResult.stderr}`,
        `${appResult.stdout}\n${appResult.stderr}`,
        `${tuiResult.stdout}\n${tuiResult.stderr}`,
      );
    } catch {
      return { appServer: false, unixSocket: false, wsAuth: false, remoteUnix: false, remoteWs: false, noAltScreen: false };
    }
  })();
  probes.set(executable, task);
  return await task;
}
