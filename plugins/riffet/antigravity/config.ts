import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
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
const MAX_TOTAL = 64 * 1024 * 1024;
const MAX_FILES = 5000;
// Authentication/account state is deliberately absent. Preserve only conventional customization roots.
const CUSTOMIZATIONS = [
  'AGENTS.md',
  'GEMINI.md',
  'config/rules',
  'config/skills',
  'antigravity-cli/skills',
  'skills',
  'config/agents',
  'config/plugins',
  'config/hooks.json',
  'config/mcp_config.json',
  'config/skills.json',
  'config/rules.json',
  'config/agents.json',
  'config/plugins.json',
];
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
const SECRET_FILE = /(^|[._-])(oauth|credentials?|tokens?|secrets?|keyring|auth)([._-]|$)|^\.env(?:\.|$)|\.(pem|key|p12|pfx)$/i;
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
async function copyCustomizations(sourceDir: string, target: string, finalTarget: string): Promise<void> {
  const sourceStat = await stat(sourceDir);
  if (!sourceStat) return;
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink())
    throw new Error('Antigravity customization source must be a real directory');
  const source = await realpath(sourceDir);
  let nodes = 0;
  let total = 0;
  const validateJson = (from: string, bytes: Buffer): Buffer => {
    const rel = relative(sourceDir, from);
    const normalized = rel.split(sep).join('/');
    const manifest = /^config\/(?:skills|rules|agents|plugins)\.json$/.test(normalized);
    const pluginManifest = /(^|\/)plugin\.json$/.test(normalized);
    if (!manifest && !pluginManifest) return bytes;
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new Error('Antigravity customization JSON is invalid');
    }
    if (!agyRecord(value)) throw new Error('Antigravity customization JSON must be an object');
    if (manifest) {
      for (const field of ['entries', 'inherits']) {
        const entries = value[field];
        if (entries === undefined) continue;
        if (!Array.isArray(entries)) throw new Error('Antigravity discovery manifest is invalid');
        for (const entry of entries) {
          if (!agyRecord(entry) || typeof entry.path !== 'string') throw new Error('Antigravity discovery manifest path is invalid');
          const referenced = isAbsolute(entry.path) ? resolve(entry.path) : resolve(sourceDir, 'config', entry.path);
          const selected = CUSTOMIZATIONS.some(name => contained(join(sourceDir, name), referenced));
          const inheritedManifest = /^config\/(?:skills|rules|agents|plugins)\.json$/.test(
            relative(sourceDir, referenced).split(sep).join('/'),
          );
          if (!selected || entry.path.startsWith('~') || (field === 'inherits' && !inheritedManifest))
            throw new Error('Antigravity discovery manifest references an unsupported customization source');
          if (isAbsolute(entry.path)) entry.path = join(finalTarget, relative(sourceDir, referenced));
        }
      }
      return Buffer.from(JSON.stringify(value, null, 2) + '\n');
    }
    if (pluginManifest && value.skills !== undefined) {
      const pluginRoot = ['.antigravity-plugin', '.gemini-plugin'].includes(relative(dirname(dirname(from)), dirname(from)))
        ? dirname(dirname(from))
        : dirname(from);
      for (const path of Array.isArray(value.skills) ? value.skills : [value.skills]) {
        if (typeof path !== 'string' || isAbsolute(path) || !contained(pluginRoot, resolve(pluginRoot, path)))
          throw new Error('Antigravity plugin references an external skill directory');
      }
    }
    return bytes;
  };
  const copy = async (from: string, to: string, depth: number): Promise<void> => {
    const info = await stat(from);
    if (!info) return;
    if (++nodes > MAX_FILES) throw new Error('Antigravity customization exceeds its snapshot limit');
    if (info.isSymbolicLink() || !contained(source, await realpath(from)))
      throw new Error('Antigravity customization contains a symbolic link or external path');
    if (depth > 32) throw new Error('Antigravity customization exceeds its depth limit');
    if (info.isDirectory()) {
      await privateDirectory(to);
      const names = await readdir(from);
      if (names.length > MAX_FILES) throw new Error('Antigravity customization exceeds its snapshot limit');
      for (const name of names) {
        if (SECRET_FILE.test(name)) continue;
        await copy(join(from, name), join(to, name), depth + 1);
      }
    } else if (info.isFile()) {
      const bytes = validateJson(from, await fileBytes(from));
      total += bytes.length;
      if (total > MAX_TOTAL) throw new Error('Antigravity customization exceeds its snapshot limit');
      await privateDirectory(dirname(to));
      // Relative native commands may execute bundled helpers directly. Keep owner execution only.
      const handle = await open(
        to,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        from.endsWith('.json') || !(info.mode & 0o111) ? 0o600 : 0o700,
      );
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
    } else throw new Error('Antigravity customization contains a non-regular file');
  };
  for (const name of CUSTOMIZATIONS) {
    // A linked parent (e.g. config/) must not silently redirect a selected subtree.
    let ancestor = dirname(join(sourceDir, name));
    while (contained(sourceDir, ancestor) && ancestor !== sourceDir) {
      if ((await stat(ancestor))?.isSymbolicLink()) throw new Error('Antigravity customization contains a symbolic link');
      ancestor = dirname(ancestor);
    }
    await copy(join(sourceDir, name), join(target, name), 0);
  }
  // Refuse linked account/config parents even when the selected settings file itself is regular.
  for (const path of [join(sourceDir, 'antigravity-cli'), join(sourceDir, 'antigravity-cli', 'cache')])
    if ((await stat(path))?.isSymbolicLink()) throw new Error('Antigravity customization contains a symbolic link');
  const settings = nativeSettings(await json(join(sourceDir, 'antigravity-cli', 'settings.json')));
  await write(join(target, 'antigravity-cli', 'settings.json'), settings);
  const onboarding = await json(join(sourceDir, 'antigravity-cli', 'cache', 'onboarding.json'));
  const completed = Object.fromEntries(
    ['consumerOnboardingComplete', 'enterpriseOnboardingComplete', 'onboardingComplete'].flatMap(key =>
      onboarding?.[key] === true ? [[key, true]] : [],
    ),
  );
  if (Object.keys(completed).length) await write(join(target, 'antigravity-cli', 'cache', 'onboarding.json'), completed);
}
export interface PreparedAgySession {
  root: string;
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
/** Restore launch-specific paths from the saved launch record; current is only the conventional inspection path. */
export function agySessionPaths(stateDir: string, sessionId: string, launchId = 'current'): PreparedAgySession {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(launchId))
    throw new Error('Invalid Antigravity session or launch identity');
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
async function prepare(input: PrepareAgySessionInput): Promise<PreparedAgySession> {
  const state = absolute(input.stateDir, 'stateDir');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.sessionId)) throw new Error('Invalid Antigravity session identity');
  const project = await realpath(absolute(input.projectCwd, 'projectCwd'));
  if (!(await lstat(project)).isDirectory()) throw new Error('Antigravity project is not a directory');
  const mode = agyMode(input.mode);
  const permission = agyToolPermission(input.approval);
  agySelection(input.model);
  // Resolve the trusted host-provided state root; session-owned descendants must never be links.
  await privateDirectory(state);
  const paths = agySessionPaths(await realpath(state), input.sessionId, randomUUID());
  const { root, geminiDir, bridgeDir, settingsPath, logPath } = paths;
  if (contained(project, root)) throw new Error('Antigravity private state must be outside the project workspace');
  await privateDirectory(dirname(root));
  await privateDirectory(root);
  const marker = join(root, 'initialized.json');
  const initialized = await json(marker);
  if (initialized) {
    if (initialized.version !== 1 || initialized.projectCwd !== project || initialized.sourceDir !== input.profile.sourceDir)
      throw new Error('Antigravity private state belongs to another launch profile or workspace');
    if (!(await stat(geminiDir))?.isDirectory() || (await stat(geminiDir))?.isSymbolicLink())
      throw new Error('Antigravity private native root is unavailable');
  } else {
    if (await stat(geminiDir)) throw new Error('Antigravity private state initialization is incomplete');
    const temporary = join(root, `native-${randomUUID()}.tmp`);
    try {
      await privateDirectory(temporary);
      await copyCustomizations(input.profile.sourceDir, temporary, geminiDir);
      await rename(temporary, geminiDir);
      await write(marker, { version: 1, projectCwd: project, sourceDir: input.profile.sourceDir });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  await privateDirectory(bridgeDir);
  await privateDirectory(join(root, 'launches'));
  await privateDirectory(dirname(settingsPath));
  await privateDirectory(join(geminiDir, 'antigravity-cli'));
  const nativeSettingsPath = join(geminiDir, 'antigravity-cli', 'settings.json');
  const settings = nativeSettings(await json(nativeSettingsPath));
  // Picking the project for this conversation is the trust decision agy's first-run dialog asks for (as for
  // Claude Code). It is recorded in the session's private native settings, never in the user's own; only that
  // key is touched there, so what agy itself saved in the file stays as it was.
  const trusted = Array.isArray(settings.trustedWorkspaces)
    ? settings.trustedWorkspaces.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const trustedWorkspaces = [...new Set([...trusted, resolve(input.projectCwd), project])];
  const trustAdded = !trusted.includes(project);
  if (trustAdded) await write(nativeSettingsPath, { ...(await json(nativeSettingsPath)), trustedWorkspaces });
  // Model selection is a native --model argument; labels saved by /model remain untouched. A custom model goes into
  // this launch's own settings, never the session's native file, so it lasts exactly as long as the selection.
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
