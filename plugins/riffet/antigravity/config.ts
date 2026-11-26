import { randomUUID } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseSelection } from '@contracts';
import type { AgentHost, AgentProfile } from '@riffet/plugin-api/experimental/agent';
import { AppError, resolveCliExecutable } from '@riffet/plugin-api/kit';
import { agyRecord } from './protocol.js';

export interface AgyProfile {
  readonly executable: string;
  readonly sourceDir: string;
  readonly apiEndpoint?: string;
  readonly apiProtocol?: 'google-generative-ai';
  readonly disableAutoUpdate: boolean;
  readonly hasApiKey: boolean;
}
const secrets = new WeakMap<AgyProfile, string>();
const MAX_FILE = 4 * 1024 * 1024;
const SETTINGS_KEYS = new Set([
  'agentMode',
  'colorScheme',
  'altScreenMode',
  'toolPermission',
  'artifactReviewPolicy',
  'notifications',
  'showTips',
  'showFeedbackSurvey',
  'editor',
  'editorMode',
  'vimInsertFirst',
  'allowNonWorkspaceAccess',
  'enableTerminalSandbox',
  'useG1Credits',
  'verbosity',
  'runningLightSpeed',
  'copyOnSelect',
  'hideActiveItems',
  'pickerGrouping',
  'queuedMessages',
  'clearScrollbackOnResize',
  'historySize',
  'model',
  'modelProvider',
  'customModelsConfig',
  'trustedWorkspaces',
  'useTerminalCursor',
  'permissions',
  'statusLine',
  'title',
]);
const preparing = new Map<string, Promise<PreparedAgySession>>();
function invalid(message: string): never {
  throw new AppError('INVALID_SETTINGS', message);
}
function text(value: unknown, field: string, maximum = 8192): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > maximum || /[\r\n\0]/.test(value)) return invalid(`Antigravity ${field} is invalid`);
  return value.trim() || undefined;
}
function absolute(value: string, field: string): string {
  if (!isAbsolute(value)) return invalid(`Antigravity ${field} must be an absolute path`);
  return resolve(value);
}
export function parseAgyProfile(config: Record<string, unknown>): AgyProfile {
  const command = text(config.executable ?? config.cliPath, 'executable') ?? 'agy';
  if (command.startsWith('shell:')) invalid('Antigravity requires a directly executable CLI');
  const sourceDir = absolute(text(config.sourceDir, 'sourceDir') ?? join(homedir(), '.gemini'), 'sourceDir');
  const endpoint = text(config.apiEndpoint, 'apiEndpoint');
  let apiEndpoint: string | undefined;
  if (endpoint) {
    try {
      const url = new URL(endpoint);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
      apiEndpoint = url.toString().replace(/\/$/, '');
    } catch {
      invalid('Antigravity apiEndpoint must be an HTTP(S) URL without credentials, query parameters, or fragments');
    }
  }
  if (config.apiProtocol !== undefined && config.apiProtocol !== 'google-generative-ai')
    invalid('Antigravity requires the google-generative-ai protocol');
  const key = text(config.apiKey, 'apiKey', 64 * 1024);
  if (config.apiKey !== undefined && (!key || /\s/.test(key))) invalid('Antigravity API key is unavailable or invalid');
  if ((apiEndpoint || config.apiProtocol) && !key) invalid('Antigravity Gemini API profile requires an API key');
  if (config.disableAutoUpdate !== undefined && typeof config.disableAutoUpdate !== 'boolean')
    invalid('Antigravity disableAutoUpdate must be a boolean');
  const profile: AgyProfile = Object.freeze({
    executable: resolveCliExecutable({ command }).executable,
    sourceDir,
    ...(apiEndpoint ? { apiEndpoint } : {}),
    ...(key ? { apiProtocol: 'google-generative-ai' as const } : {}),
    disableAutoUpdate: typeof config.disableAutoUpdate === 'boolean' ? config.disableAutoUpdate : true,
    hasApiKey: Boolean(key),
  });
  if (key) secrets.set(profile, key);
  return profile;
}
/** Separate maps let the host put credentials into the pane's secret channel only. */
export function agyProfileEnvironment(profile: AgyProfile): { env: Record<string, string>; secretEnv: Record<string, string> } {
  const key = secrets.get(profile);
  if (profile.hasApiKey && !key) invalid('Antigravity API key is unavailable');
  return {
    env: {
      ...(profile.apiEndpoint ? { GOOGLE_GEMINI_BASE_URL: profile.apiEndpoint } : {}),
      ...(profile.disableAutoUpdate ? { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } : {}),
    },
    secretEnv: key ? { GEMINI_API_KEY: key } : {},
  };
}
/** What `agy --effort` takes. */
export const AGY_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export interface AgySelection {
  model: string;
  effort?: string;
}
/** A saved selection (`model` or `model[effort=…]`); `default` leaves the effort to agy. */
export function agySelection(value: string | undefined): AgySelection | undefined {
  const selection = text(value, 'model', 1024);
  if (!selection) return undefined;
  const { model, params } = parseSelection(selection);
  if (Object.keys(params).some(key => key !== 'effort')) invalid('Antigravity model parameter is unsupported');
  if (params.effort === undefined || params.effort === 'default') return { model };
  if (!AGY_EFFORTS.includes(params.effort)) invalid('Antigravity model effort is unsupported');
  return { model, effort: params.effort };
}
/** The profile's configuration with its model source resolved to the endpoint and key agy is started with. */
export async function agyLaunchConfig(host: AgentHost, profile: AgentProfile): Promise<Record<string, unknown>> {
  const config = { ...profile.config };
  const endpoint = await host.modelSources.resolve(profile.id, 'google-generative-ai');
  if (config.modelSource && !endpoint) throw host.error('AGY_PROVIDER_UNAVAILABLE', 'The Antigravity model source is unavailable', 409);
  if (!endpoint) return config;
  if (!endpoint.credential || Object.keys(endpoint.headers ?? {}).some(key => !['x-goog-api-key'].includes(key.toLowerCase()))) {
    throw host.error('AGY_PROVIDER_UNSUPPORTED', 'Antigravity requires a static Gemini API key without custom headers', 400);
  }
  return { ...config, apiEndpoint: endpoint.baseUrl, apiKey: endpoint.credential.key, apiProtocol: 'google-generative-ai' };
}
export function agyMode(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value === '' || value === 'default' || value === 'agent') return '';
  if (['accept-edits', 'auto', 'plan'].includes(value)) return value;
  return invalid('Antigravity mode is unsupported');
}
export function agyToolPermission(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value === 'allowlist') return 'request-review';
  if (value === 'auto-review') return 'proceed-in-sandbox';
  if (value === 'unrestricted') return 'always-proceed';
  if (['request-review', 'proceed-in-sandbox', 'always-proceed', 'strict'].includes(value)) return value;
  return invalid('Antigravity approval mode is unsupported');
}
function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
async function stat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
async function privateDirectory(path: string): Promise<void> {
  const parent = dirname(path);
  // The host state root may pass through platform aliases such as /var -> /private/var.
  // Existing ancestors are resolved by the caller; only newly owned directories are chmod'ed.
  if (parent !== path && !(await stat(parent))) await privateDirectory(parent);
  const current = await stat(path);
  if (current?.isSymbolicLink() || (current && !current.isDirectory())) throw new Error('Antigravity private state path is unsafe');
  if (!current) await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
}
async function fileBytes(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE) throw new Error('Antigravity configuration file is unsafe or exceeds its limit');
    const bytes = Buffer.alloc(Math.min(info.size + 1, MAX_FILE + 1));
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > info.size || length > MAX_FILE) throw new Error('Antigravity configuration changed while being copied');
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}
async function json(path: string): Promise<Record<string, unknown> | undefined> {
  if (!(await stat(path))) return undefined;
  try {
    const value: unknown = JSON.parse((await fileBytes(path)).toString('utf8'));
    if (agyRecord(value)) return value;
  } catch {
    throw new Error('Antigravity configuration JSON is unavailable or invalid');
  }
  throw new Error('Antigravity configuration JSON must be an object');
}
async function write(path: string, value: unknown): Promise<void> {
  await privateDirectory(dirname(path));
  if ((await stat(path))?.isSymbolicLink()) throw new Error('Antigravity private configuration path is unsafe');
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
/** The reader's own custom models stay; the launch's model is added under its id unless they already define it. */
function withCustomModel(value: unknown, id: string): Record<string, unknown> {
  const config = agyRecord(value) ? value : {};
  const models = agyRecord(config.customModels) ? config.customModels : {};
  return { ...config, customModels: { ...models, [id]: agyRecord(models[id]) ? models[id] : { modelName: id } } };
}
/** Only model settings are inherited in a side chat. Session hooks, tools and project files are private to the main conversation. */
export async function discussionModelSettings(profile: AgyProfile, customModel?: string): Promise<Record<string, unknown>> {
  const saved = await json(join(profile.sourceDir, 'antigravity-cli', 'settings.json'));
  const settings = nativeSettings(Object.fromEntries(['model', 'modelProvider', 'customModelsConfig', 'useG1Credits']
    .flatMap(key => saved?.[key] === undefined ? [] : [[key, saved[key]]])));
  if (profile.hasApiKey) settings.modelProvider = 'gemini';
  if (customModel) settings.customModelsConfig = withCustomModel(settings.customModelsConfig, customModel);
  return settings;
}
function nativeSettings(value: Record<string, unknown> | undefined): Record<string, unknown> {
  const settings = Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => SETTINGS_KEYS.has(key)));
  const check = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const child of current) check(child);
    } else if (agyRecord(current))
      for (const [key, child] of Object.entries(current)) {
        if (/^(api_?key|access_?token|refresh_?token|password|credential|secret)$/i.test(key))
          throw new Error('Antigravity native settings contain credentials');
        check(child);
      }
  };
  check(settings);
  return settings;
}
export interface PreparedAgySession {
  root: string;
  /**
   * agy's data root (`--gemini_dir`): the provider's own `sourceDir` for sessions started since native history
   * (layout 2), the session's private copy under `root/native` for older ones, which resume where they were.
   */
  geminiDir: string;
  bridgeDir: string;
  settingsPath: string;
  logPath: string;
  /** This launch is the first to trust the project for the session (see `prepare`). */
  trustAdded?: boolean;
}
export interface PrepareAgySessionInput {
  stateDir: string;
  sessionId: string;
  projectCwd: string;
  profile: AgyProfile;
  model?: string;
  /** A gateway model id agy does not know by itself, registered for this launch only. */
  customModel?: string;
  mode?: string;
  approval?: string;
}
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Restore launch-specific paths from the saved launch record; current is only the conventional inspection path. */
export function agySessionPaths(stateDir: string, sessionId: string, launchId = 'current'): PreparedAgySession {
  if (!SESSION_ID.test(sessionId) || !SESSION_ID.test(launchId)) throw new Error('Invalid Antigravity session or launch identity');
  const root = join(absolute(stateDir, 'stateDir'), 'sessions', sessionId);
  const launch = join(root, 'launches', launchId);
  return {
    root,
    geminiDir: join(root, 'native'),
    bridgeDir: join(root, 'workspace'),
    settingsPath: join(launch, 'settings.json'),
    logPath: join(launch, 'agy.log'),
  };
}
/**
 * Where a session's native conversation lives, read from its `initialized.json`: the provider's data root for
 * layout 2, the private `native/` copy for layout 1. A session that never launched has neither.
 */
export function agySessionGeminiDir(stateDir: string, sessionId: string): string | undefined {
  if (!SESSION_ID.test(sessionId)) throw new Error('Invalid Antigravity session identity');
  const root = join(absolute(stateDir, 'stateDir'), 'sessions', sessionId);
  let marker: unknown;
  try {
    marker = JSON.parse(readFileSync(join(root, 'initialized.json'), 'utf8'));
  } catch {
    return undefined;
  }
  if (!agyRecord(marker)) return undefined;
  if (marker.version === 1) return join(root, 'native');
  return marker.version === 2 && typeof marker.geminiDir === 'string' && isAbsolute(marker.geminiDir) ? marker.geminiDir : undefined;
}
/** The user's own agy settings, which may be a managed dotfile link; unreadable ones are agy's to report, not ours. */
async function userSettings(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return agyRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
const trustedList = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);
async function prepare(input: PrepareAgySessionInput): Promise<PreparedAgySession> {
  const state = absolute(input.stateDir, 'stateDir');
  if (!SESSION_ID.test(input.sessionId)) throw new Error('Invalid Antigravity session identity');
  const project = await realpath(absolute(input.projectCwd, 'projectCwd'));
  if (!(await lstat(project)).isDirectory()) throw new Error('Antigravity project is not a directory');
  const mode = agyMode(input.mode);
  const permission = agyToolPermission(input.approval);
  agySelection(input.model);
  // Resolve the trusted host-provided state root; session-owned descendants must never be links.
  await privateDirectory(state);
  const base = agySessionPaths(await realpath(state), input.sessionId, randomUUID());
  const { root } = base;
  if (contained(project, root)) throw new Error('Antigravity private state must be outside the project workspace');
  await privateDirectory(dirname(root));
  await privateDirectory(root);
  const marker = join(root, 'initialized.json');
  const initialized = await json(marker);
  const sourceDir = input.profile.sourceDir;
  if (initialized && (initialized.projectCwd !== project || initialized.sourceDir !== sourceDir))
    throw new Error('Antigravity session state belongs to another launch profile or workspace');
  const legacy = initialized?.version === 1;
  if (initialized && !legacy && (initialized.version !== 2 || initialized.geminiDir !== sourceDir))
    throw new Error('Antigravity session state is unsupported');
  const paths = legacy ? base : { ...base, geminiDir: sourceDir };
  const { geminiDir, bridgeDir, settingsPath, logPath } = paths;
  if (legacy) {
    if (!(await stat(geminiDir))?.isDirectory() || (await stat(geminiDir))?.isSymbolicLink())
      throw new Error('Antigravity private native root is unavailable');
  } else if (!initialized) {
    if (await stat(join(root, 'native'))) throw new Error('Antigravity private state initialization is incomplete');
    // History goes where the CLI keeps it, so the user's own agy and usage tools see these conversations.
    await write(marker, { version: 2, projectCwd: project, sourceDir, geminiDir: sourceDir });
  }
  await privateDirectory(bridgeDir);
  await privateDirectory(join(root, 'launches'));
  await privateDirectory(dirname(settingsPath));
  const nativeSettingsPath = join(geminiDir, 'antigravity-cli', 'settings.json');
  // Layout 1 starts from the whole private copy; layout 2 overlays only what Riffet decides on the user's own
  // settings, which agy keeps reading: the keys below are read so the overlay extends them instead of hiding them.
  // Custom models are read only when this launch adds one, so a user's own model credentials never stop a launch.
  const saved = legacy ? await json(nativeSettingsPath) : await userSettings(nativeSettingsPath);
  const extended = ['trustedWorkspaces', 'statusLine', ...(input.customModel ? ['customModelsConfig'] : [])];
  const settings = nativeSettings(
    legacy ? saved : Object.fromEntries(extended.flatMap(key => (saved?.[key] === undefined ? [] : [[key, saved[key]]]))),
  );
  // Picking the project for this conversation is the trust decision agy's first-run dialog asks for (as for
  // Claude Code). It goes into this launch's settings only; a legacy private root also keeps it in its own file.
  const trusted = trustedList(settings.trustedWorkspaces);
  const trustedWorkspaces = [...new Set([...trusted, resolve(input.projectCwd), project])];
  const trustAdded = !trusted.includes(project);
  if (legacy && trustAdded) await write(nativeSettingsPath, { ...saved, trustedWorkspaces });
  // Model selection is a native --model argument; labels saved by /model remain untouched. A custom model goes into
  // this launch's own settings, never a native file, so it lasts exactly as long as the selection.
  Object.assign(
    settings,
    { queuedMessages: 'queue', altScreenMode: 'always', trustedWorkspaces },
    input.profile.hasApiKey ? { modelProvider: 'gemini' } : {},
    input.customModel ? { customModelsConfig: withCustomModel(settings.customModelsConfig, input.customModel) } : {},
    mode !== undefined ? { agentMode: mode } : {},
    permission !== undefined ? { toolPermission: permission } : {},
    // agy requires both the approval policy and the terminal sandbox setting to let sandboxed commands proceed.
    permission === 'proceed-in-sandbox' ? { enableTerminalSandbox: true } : {},
  );
  await write(settingsPath, settings);
  return { root, geminiDir, bridgeDir, settingsPath, logPath, ...(trustAdded ? { trustAdded } : {}) };
}
export async function prepareAgySession(input: PrepareAgySessionInput): Promise<PreparedAgySession> {
  const key = join(resolve(input.stateDir), 'sessions', input.sessionId);
  const existing = preparing.get(key);
  const result = existing ? existing.then(() => prepare(input)) : prepare(input);
  preparing.set(key, result);
  try {
    return await result;
  } finally {
    if (preparing.get(key) === result) preparing.delete(key);
  }
}
