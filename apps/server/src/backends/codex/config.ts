import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from '@riffet/plugin-api/kit';
import type { Project } from '../../../../../packages/contracts/src/index.js';
import { readProbe, type AppServerProbe, type CodexFlavor } from './flavors.js';
import { resolveCliExecutable } from '../shared/cli-resolve.js';
import { versionAtLeast } from '../shared/cli-version.js';
import type { NativeBackendProfileConfig } from '../types.js';
import { asRecord, str } from './util.js';

/** A rollout larger than this is not read whole for statistics. */
export const MAX_ROLLOUT_BYTES = 64 * 1024 * 1024;
const probes = new Map<string, Promise<AppServerProbe>>();
const PROFILE_PREFERENCE_FIELDS = new Set(['id', 'backendId', 'name', 'description', 'isDefault', 'defaultModel', 'enabledModels', 'modelInputModalities']);
type CodexPermissionId = 'on-request' | 'dontAsk' | 'read-only' | 'danger-full-access';
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
 * is the cross-backend "run everything". `dontAsk` has Claude Code's name and meaning: what would need asking is
 * refused, which is what a run nobody watches needs (docs/ASSISTANT.md §6).
 */
const CODEX_PERMISSIONS: Record<CodexPermissionId, { approvalPolicy: 'on-request' | 'never'; sandbox: CodexSandboxMode }> = {
  'on-request': { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  dontAsk: { approvalPolicy: 'never', sandbox: 'workspace-write' },
  'read-only': { approvalPolicy: 'on-request', sandbox: 'read-only' },
  'danger-full-access': { approvalPolicy: 'never', sandbox: 'danger-full-access' },
};

export function normalizePermission(value: string | undefined, flavor: CodexFlavor['id'] = 'codex'): PermissionId {
  if (flavor === 'traex' && value === 'auto-review') return value;
  if (value === 'read-only' || value === 'danger-full-access') return value;
  if (value === 'dontAsk' && flavor === 'codex') return value;
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

async function probeCliCommand(executable: string, args: string[], maxBuffer: number) {
  // runProcess bounds the combined output. Keep the original limit on each stream as well.
  const options = { cwd: process.cwd(), maxOutputBytes: 2 * maxBuffer };
  let result = await runProcess(executable, args, { ...options, timeoutMs: 5_000 });
  // Keep both attempts and their kill grace periods within a 10-second catalog request.
  if (result.timedOut && !result.truncated) result = await runProcess(executable, args, { ...options, timeoutMs: 3_000 });
  return {
    ok: result.code === 0 && !result.timedOut && !result.truncated && Math.max(result.stdoutData.length, result.stderrData.length) <= maxBuffer,
    text: `${result.stdout}\n${result.stderr}`,
    timedOut: result.timedOut && !result.truncated,
    missing: result.spawnErrorCode === 'ENOENT',
  };
}

export async function probeAppServer(executable: string): Promise<AppServerProbe> {
  // Global npm installs replace the launcher at the same path, sometimes with a preserved mtime.
  // As with Claude's probe, cache the installed file identity, never the command path alone.
  let key = executable;
  try {
    const path = await realpath(executable);
    const file = await stat(path);
    key = `${path}:${file.dev}:${file.ino}:${file.size}:${file.mtimeMs}:${file.ctimeMs}`;
  } catch { /* Unresolved commands are retried after a failed probe. */ }
  const cached = probes.get(key);
  if (cached) return await cached;
  const task = (async () => {
    try {
      const results = await Promise.all([
        probeCliCommand(executable, ['--version'], 128 * 1024),
        probeCliCommand(executable, ['app-server', '--help'], 512 * 1024),
        probeCliCommand(executable, ['resume', '--help'], 512 * 1024),
      ] as const);
      if (results.every(result => result.ok)) return readProbe(results[0].text, results[1].text, results[2].text);
      probes.delete(key);
      return {
        ...readProbe('', '', ''),
        ...(results.some(result => result.missing) ? { executableNotFound: true } : {}),
        ...(results.some(result => result.timedOut) ? { timedOut: true } : {}),
      };
    } catch {
      probes.delete(key);
      return readProbe('', '', '');
    }
  })();
  probes.set(key, task);
  return await task;
}

/** Env var a TUI reads its loopback app-server token from; the token never appears in argv. */
export const TUI_TOKEN_ENV = 'RIFFET_APP_SERVER_TOKEN';
/**
 * The workbench's own tools act only on their conversation; a per-call approval would hold a
 * wake-up or notice for a reader who may be away. `approve` is the CLI's own per-server setting.
 */
/**
 * How the Riffet server is offered (verified on codex-cli 0.160.0):
 * - `default_tools_approval_mode: approve`: the workbench's own tools act only on their
 *   conversation; a per-call approval would hold a wake-up or notice for a reader who may be away.
 * - `omit_tools_from: [deferred]`: a model whose catalog claims tool search gets MCP tools only
 *   through `tool_search`, which a model behind a compatible gateway may never be offered; the
 *   agent then sees none of them. Five small tools are cheaper listed directly.
 * - `startup_readiness: catalog`: the first turn, sent right after `thread/start`, waits for the
 *   shim's `tools/list` instead of being built without it.
 * - `tool_timeout_sec: 330`: a device call waits up to 300 s for the device (docs/DEVICES.md §3);
 *   the CLI's own 60 s default would abandon it first.
 */
export const RIFFET_MCP_EXPOSURE = { default_tools_approval_mode: 'approve', omit_tools_from: ['deferred'], startup_readiness: 'catalog', tool_timeout_sec: 330 } as const;

/** The permission fields of a `thread/start`, `thread/resume` or `turn/start` request; `sandboxField` names where the sandbox goes. */
export function permissionParamsOf(permission: Permission, sandboxField: 'sandbox' | 'sandboxPolicy'): Record<string, unknown> {
  return {
    approvalPolicy: permission.approvalPolicy,
    ...(permission.permissions ? { permissions: permission.permissions, approvalsReviewer: permission.approvalsReviewer }
      : { [sandboxField]: sandboxField === 'sandbox' ? permission.sandbox : sandboxPolicyOf(permission.sandbox) }),
  };
}

/** Whether thread settings carry an extended native permission profile rather than a bare preset. */
export function hasNativePermissions(settings: Record<string, unknown> | undefined): boolean {
  return Boolean(settings && (asRecord(settings.activePermissionProfile) || asRecord(settings.permissionProfile)
    || asRecord(settings.sandboxPolicy) || asRecord(settings.sandbox)));
}

/** The config override that offers the Riffet MCP server to a thread, or none when the host has no such server. */
export function riffetMcpOverride(server: { name: string; command: string; args: string[]; http?: { url: string; headers: Record<string, string> } } | undefined): Record<string, unknown> {
  if (!server) return {};
  if (server.http) return { [`mcp_servers.${server.name}`]: { url: server.http.url, http_headers: server.http.headers, ...RIFFET_MCP_EXPOSURE } };
  return { [`mcp_servers.${server.name}`]: { command: server.command, args: server.args, ...RIFFET_MCP_EXPOSURE } };
}

function unquoteToml(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try { return JSON.parse(trimmed) as string; } catch { return trimmed.slice(1, -1); }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return undefined;
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && ch === '\\') { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = undefined; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') return line.slice(0, i);
  }
  return line;
}

function splitTomlPath(section: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < section.length; i++) {
    const ch = section[i]!;
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '.') {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function readCodexConfigToml(file: string): {
  top: Record<string, string>;
  providers: Record<string, { fields: Record<string, string>; headers: Record<string, string> }>;
} {
  const top: Record<string, string> = {};
  const providers: Record<string, { fields: Record<string, string>; headers: Record<string, string> }> = {};
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); } catch { return { top, providers }; }
  let section: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const clean = stripTomlComment(line).trim();
    if (!clean) continue;
    if (clean.startsWith('[') && clean.endsWith(']') && !clean.startsWith('[[')) {
      section = splitTomlPath(clean.slice(1, -1));
      continue;
    }
    const eq = clean.indexOf('=');
    if (eq <= 0) continue;
    const rawKey = clean.slice(0, eq).trim();
    const key = unquoteToml(rawKey) ?? rawKey;
    const value = unquoteToml(clean.slice(eq + 1));
    if (value === undefined) continue;
    if (section.length === 0) {
      top[key] = value;
    } else if (section[0] === 'model_providers' && section[1]) {
      const entry = providers[section[1]] ??= { fields: {}, headers: {} };
      if (section.length === 2) entry.fields[key] = value;
      else if (section.length === 3 && section[2] === 'http_headers') entry.headers[key] = value;
    }
  }
  return { top, providers };
}

/**
 * Reads a Codex CLI default profile's HTTP gateway and API key from `~/.codex/config.toml`,
 * `~/.codex/auth.json` or `OPENAI_*` env vars when Riffet itself has no `apiEndpoint` configured.
 * ChatGPT OAuth logins without an API key or custom `model_provider` stay excluded.
 */
export function readCodexOwnerGateway(profile: NativeBackendProfileConfig, stateHome: string): NativeBackendProfileConfig | undefined {
  const { top, providers } = readCodexConfigToml(join(stateHome, 'config.toml'));
  let auth: Record<string, unknown> | undefined;
  try { auth = asRecord(JSON.parse(readFileSync(join(stateHome, 'auth.json'), 'utf8'))); }
  catch { auth = undefined; }
  const authStr = (key: string) => {
    const envVal = process.env[key]?.trim();
    if (envVal) return envVal;
    const authVal = auth?.[key];
    return typeof authVal === 'string' && authVal.trim() ? authVal.trim() : undefined;
  };
  let endpoint: string | undefined;
  let apiKey: string | undefined;
  let headers: Record<string, string> | undefined;
  const providerName = top.model_provider?.trim();
  if (providerName && providerName !== 'openai') {
    const custom = providers[providerName];
    if (!custom?.fields.base_url) return undefined;
    if (custom.fields.wire_api && custom.fields.wire_api !== 'responses') return undefined;
    endpoint = custom.fields.base_url;
    apiKey = custom.fields.experimental_bearer_token?.trim()
      || (custom.fields.env_key ? authStr(custom.fields.env_key) : undefined);
    if (Object.keys(custom.headers).length) headers = custom.headers;
  } else {
    const rawEndpoint = top.openai_base_url?.trim() || process.env.OPENAI_BASE_URL?.trim();
    const openAiKey = authStr('OPENAI_API_KEY');
    if (!rawEndpoint && !openAiKey) return undefined;
    endpoint = rawEndpoint || 'https://api.openai.com/v1';
    apiKey = openAiKey;
  }
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  } catch { return undefined; }
  const defaultModel = str(profile.config.defaultModel) || top.model?.trim() || undefined;
  return {
    ...profile,
    config: {
      ...profile.config,
      apiEndpoint: endpoint.replace(/\/+$/, ''),
      ...(apiKey ? { apiKey } : {}),
      ...(headers ? { gatewayHeaders: headers } : {}),
      ...(defaultModel ? { defaultModel } : {}),
    },
  };
}

/** Whether `$CODEX_HOME/auth.json` holds a ChatGPT OAuth session for the Codex CLI itself. */
export function hasCodexChatgptAuth(stateHome: string): boolean {
  let auth: Record<string, unknown> | undefined;
  try { auth = asRecord(JSON.parse(readFileSync(join(stateHome, 'auth.json'), 'utf8'))); }
  catch { return false; }
  if (!auth) return false;
  const tokens = asRecord(auth.tokens);
  return Boolean(tokens && (typeof tokens.access_token === 'string' && tokens.access_token || typeof tokens.refresh_token === 'string' && tokens.refresh_token));
}
