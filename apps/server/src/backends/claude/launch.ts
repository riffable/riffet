import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { NativeBackendId, NativeInteraction, Session, TerminalInfo } from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import { launchSource, modelSourceOf, resolveSource, sourceEndpoint } from '../shared/model-source.js';
import { describeSearch, resolveCliExecutable } from '../shared/cli-resolve.js';
import { parseVersion, versionAtLeast, type CliVersion, type CliVersionRange } from '../shared/cli-version.js';
import type { NativeBackendAvailability, NativeBackendHost, NativeBackendProfileConfig } from '../types.js';
import { claudeScreenInteraction, isClaudeScreenInteraction } from './screen-dialog.js';
import { parseDialog } from '../../agent-host/interaction-screen.js';
import { isKnownBlockingTitle } from '../../agent-host/interaction-choice.js';
import type { ClaudeProcess } from './session-state.js';

export const backendId: NativeBackendId = 'claude';

const execFileAsync = promisify(execFile);

const probes = new Map<string, Promise<ClaudeCliProbe>>();
/**
 * The local interaction bridge needs 2.1.200; 2.1.322 is the newest run end to end.
 */
export const CLAUDE_CLI_VERSIONS: CliVersionRange = { minimum: '2.1.200', testedThrough: '2.1.322' };

/**
 * What keeps a standing conversation (docs/ASSISTANT.md §4) on its own directory: the owner's settings, instructions,
 * skills and plugins are not read, and only the MCP servers named on the command line are started. Sign-in is not a
 * setting source, so it still comes from the profile's config directory.
 */
export const STANDING_ISOLATION = ['--setting-sources', 'project,local', '--strict-mcp-config'];

export const CLAUDE_PERMISSIONS = [
  { id: 'default', label: 'Claude default', shortLabel: 'Default' },
  { id: 'manual', label: 'Ask before each permission', shortLabel: 'Ask' },
  { id: 'acceptEdits', label: 'Accept edits automatically', shortLabel: 'Accept edits' },
  { id: 'plan', label: 'Plan mode (read only)', shortLabel: 'Plan' },
  { id: 'auto', label: 'Auto mode', shortLabel: 'Auto' },
  { id: 'dontAsk', label: 'Deny tools that need permission', shortLabel: 'Deny' },
  { id: 'bypassPermissions', label: 'Bypass permissions', shortLabel: 'Bypass' },
];

export interface ClaudeCliProbe { version: string; parsed: CliVersion; help: string; }

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function string(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function executableOf(profile: NativeBackendProfileConfig): string {
  const value = string(profile.config.executable)?.trim() || process.env.CLAUDE_CLI?.trim() || 'claude';
  // Resolve to an absolute path when we can: the CLI is normally a global npm package, and the
  // daemon's PATH is not guaranteed to contain the node prefix it was installed under.
  return resolveCliExecutable({ command: value }).executable;
}

export function configDirOf(profile: NativeBackendProfileConfig): string {
  const configured = string(profile.config.configDir)?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim();
  return resolve(configured || join(homedir(), '.claude'));
}

/**
 * The status line command this launch has to keep rendering, when the reader configured one.
 *
 * `statusLine` is a single value and `--settings` outranks every file the reader owns, so a launch
 * that installs the context collector replaces whatever they had. Running their command on the same
 * payload is what keeps the bar they are used to (`statusline-cli.mjs`); without one the collector
 * prints nothing at all. Claude Code resolves the key across managed, local, project and user
 * settings, so the three files a launch can read are consulted in that precedence order; a missing
 * or unreadable file is not an error, it just means no status line of their own lives there.
 */
export async function readStatusLineForward(configDir: string, cwd: string): Promise<string | undefined> {
  const files = [
    join(cwd, '.claude', 'settings.local.json'),
    join(cwd, '.claude', 'settings.json'),
    join(configDir, 'settings.json'),
  ];
  for (const file of files) {
    const command = await statusLineCommandIn(file);
    if (command) return command;
  }
  return undefined;
}

async function statusLineCommandIn(file: string): Promise<string | undefined> {
  try {
    const settings: unknown = JSON.parse(await readFile(file, 'utf8'));
    const command = string(record(record(settings)?.statusLine)?.command)?.trim();
    // A command that already is the collector (a reader who wired it up by hand) must not recurse.
    if (!command || command.includes('statusline-cli.mjs')) return undefined;
    return command;
  } catch {
    return undefined;
  }
}

/** How the reader's own CLI reaches its model, as their settings file says it. */
export interface OwnerConnection { env?: Record<string, string>; settings: Record<string, string> }

/** Settings that sign a CLI in or name its model; nothing here loads code into the conversation. */
const CONNECTION_KEYS = ['apiKeyHelper', 'model', 'awsAuthRefresh', 'awsCredentialExport', 'forceLoginMethod'];

async function settingsIn(file: string): Promise<Record<string, unknown> | undefined> {
  try { return record(JSON.parse(await readFile(file, 'utf8'))); } catch { return undefined; }
}

/**
 * The reader's settings file is where many keep their endpoint and token (`env`), their key command and their
 * model. A launch that leaves user settings out ({@link STANDING_ISOLATION}) would start a CLI that cannot sign
 * in, so those are read here and carried in the launch's own settings. Nothing else of the file is: its hooks,
 * plugins and permissions are what the isolation is for. Launch settings outrank the directory's own, which a
 * user file never does, so whatever the directory in `cwd` sets for itself is left to it.
 */
export async function readOwnerConnection(configDir: string, cwd: string): Promise<OwnerConnection> {
  const owner = await settingsIn(join(configDir, 'settings.json'));
  if (!owner) return { settings: {} };
  const own = (await Promise.all([join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')].map(settingsIn))).filter(value => value !== undefined);
  const ownEnv = new Set(own.flatMap(settings => Object.keys(record(settings.env) ?? {})));
  const env = Object.fromEntries(Object.entries(record(owner.env) ?? {})
    .filter(([name, value]) => !ownEnv.has(name) && ['string', 'number', 'boolean'].includes(typeof value)).map(([name, value]) => [name, String(value)]));
  const settings = Object.fromEntries(CONNECTION_KEYS.flatMap(key => {
    const value = string(owner[key])?.trim();
    return value && !own.some(item => item[key] !== undefined) ? [[key, value]] : [];
  }));
  return { ...(Object.keys(env).length ? { env } : {}), settings };
}

const CLAUDE_ALIAS_RE = /^(?:default|opus|sonnet|haiku|fable|opusplan|best)$/i;

/**
 * Reads a CLI default profile's HTTP gateway and key from the user's Claude `settings.json` or
 * environment when Riffet itself has no `apiEndpoint` configured. Pure `claude.ai` OAuth logins
 * have neither and stay excluded.
 */
export function readClaudeOwnerGateway(profile: NativeBackendProfileConfig): NativeBackendProfileConfig | undefined {
  let owner: Record<string, unknown> | undefined;
  try { owner = record(JSON.parse(readFileSync(join(configDirOf(profile), 'settings.json'), 'utf8'))); }
  catch { owner = undefined; }
  const env = record(owner?.env);
  const envStr = (key: string) => {
    const value = env?.[key];
    return typeof value === 'string' && value.trim() ? value.trim() : process.env[key]?.trim() || undefined;
  };
  const rawEndpoint = envStr('ANTHROPIC_BASE_URL');
  const apiKey = envStr('ANTHROPIC_AUTH_TOKEN') ?? envStr('ANTHROPIC_API_KEY');
  const apiKeyHelper = string(owner?.apiKeyHelper)?.trim() || undefined;
  const endpoint = rawEndpoint ?? ((apiKey || apiKeyHelper) ? 'https://api.anthropic.com' : undefined);
  if (!endpoint) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  } catch { return undefined; }
  const ownerModels = [
    envStr('ANTHROPIC_MODEL'),
    envStr('ANTHROPIC_DEFAULT_OPUS_MODEL'),
    envStr('ANTHROPIC_DEFAULT_SONNET_MODEL'),
    envStr('ANTHROPIC_DEFAULT_HAIKU_MODEL'),
    envStr('ANTHROPIC_SMALL_FAST_MODEL'),
    string(owner?.model)?.trim() || undefined,
  ].filter((value): value is string => Boolean(value && !CLAUDE_ALIAS_RE.test(value)));
  const uniqueOwnerModels = [...new Set(ownerModels)];
  const defaultModel = string(profile.config.defaultModel)?.trim() || uniqueOwnerModels[0];
  const isAnthropicDirect = parsed.hostname.toLowerCase() === 'api.anthropic.com';
  const enabledModels = Array.isArray(profile.config.enabledModels)
    ? profile.config.enabledModels
    : (!isAnthropicDirect && uniqueOwnerModels.length ? uniqueOwnerModels : undefined);
  const fallbackModel = uniqueOwnerModels[0];
  const sonnetTarget = envStr('ANTHROPIC_DEFAULT_SONNET_MODEL') ?? fallbackModel ?? (isAnthropicDirect ? 'claude-sonnet-4-6' : undefined);
  const opusTarget = envStr('ANTHROPIC_DEFAULT_OPUS_MODEL') ?? fallbackModel ?? (isAnthropicDirect ? 'claude-opus-4-6' : undefined);
  const haikuTarget = envStr('ANTHROPIC_DEFAULT_HAIKU_MODEL') ?? envStr('ANTHROPIC_SMALL_FAST_MODEL') ?? fallbackModel ?? (isAnthropicDirect ? 'claude-haiku-4-5' : undefined);
  const gatewayModelAliases = {
    ...(sonnetTarget ? { sonnet: sonnetTarget, default: fallbackModel ?? sonnetTarget } : {}),
    ...(opusTarget ? { opus: opusTarget, opusplan: opusTarget, fable: opusTarget, best: opusTarget } : {}),
    ...(haikuTarget ? { haiku: haikuTarget } : {}),
  };
  return {
    ...profile,
    config: {
      ...profile.config,
      apiEndpoint: endpoint.replace(/\/+$/, ''),
      ...(apiKey ? { apiKey } : {}),
      ...(!apiKey && apiKeyHelper ? { gatewayCredentialCommand: apiKeyHelper } : {}),
      ...(defaultModel ? { defaultModel } : {}),
      ...(enabledModels ? { enabledModels } : {}),
      ...(!enabledModels && !isAnthropicDirect ? { gatewayModelScope: 'claude' } : {}),
      ...(Object.keys(gatewayModelAliases).length ? { gatewayModelAliases } : {}),
    },
  };
}

export function profileEnv(profile: NativeBackendProfileConfig): Record<string, string> {
  const configuredConfigDir = string(profile.config.configDir)?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim();
  const env: Record<string, string> = configuredConfigDir ? { CLAUDE_CONFIG_DIR: resolve(configuredConfigDir) } : {};
  if (profile.config.disableAutoUpdate === true) env.DISABLE_AUTOUPDATER = '1';
  return env;
}

/**
 * Provider settings must travel in the `--settings` overlay rather than the process environment:
 * a user's own `~/.claude/settings.json` carries an `env` block that silently overrides inherited
 * variables, so an endpoint passed through the PTY environment can be redirected without warning.
 * Flag settings override user and project files; managed policy still has the final say.
 */
export function providerEnv(profile: NativeBackendProfileConfig): Record<string, string> {
  const { resolved, credential } = launchSource(profile.config);
  const gateway = sourceEndpoint(resolved, 'anthropic-messages');
  const endpoint = gateway?.baseUrl ?? string(profile.config.apiEndpoint)?.trim();
  const env: Record<string, string> = {};
  if (endpoint) env.ANTHROPIC_BASE_URL = endpoint;
  if (credential) {
    // With AUTH_TOKEN set, native client construction need not await apiKeyHelper. That can leave
    // the first request without X-Api-Key. Helper-only auth awaits the selected key before either
    // header is built, and avoids saved OAuth/Keychain credentials and API_KEY consent prompts.
    // Clearing the three is also what keeps a command credential from losing to a saved login.
    env.ANTHROPIC_AUTH_TOKEN = '';
    env.ANTHROPIC_API_KEY = '';
    env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR = '';
    // A source's static key is resolved server-side, so it rides the same helper rail as a typed
    // key without the user ever seeing it. A command credential is the helper itself.
    if (credential.kind === 'static') env.RIFFET_CLAUDE_API_KEY = credential.key;
  }
  const headers = Object.entries(gateway?.headers ?? {});
  if (headers.length) env.ANTHROPIC_CUSTOM_HEADERS = headers.map(([name, value]) => `${name}: ${value}`).join('\n');
  return env;
}

/** Riffet explicitly supplies bearer credentials for this gateway, rather than a claude.ai login. */
export function gatewayBearer(profile: NativeBackendProfileConfig): boolean {
  const endpoint = string(profile.config.apiEndpoint)?.trim();
  if (!endpoint || !string(profile.config.apiKey)?.trim()) return false;
  try { return new URL(endpoint).hostname.toLowerCase() !== 'api.anthropic.com'; }
  catch { return false; }
}

/**
 * The `apiKeyHelper` when this launch authenticates through Riffet rather than a claude.ai login —
 * a typed key, a source's static key, or a source's per-request command — else `undefined`.
 *
 * A command credential is its own helper, which is also what gets token refresh on every
 * re-invocation. A static key is already in the child's scoped environment as `RIFFET_CLAUDE_API_KEY`.
 */
export function apiKeyHelper(profile: NativeBackendProfileConfig): string | undefined {
  const { credential } = launchSource(profile.config);
  if (!credential) return undefined;
  if (credential.kind === 'command') return [credential.command, ...credential.args].map(shellQuote).join(' ');
  return `${shellQuote(process.execPath)} -e ${shellQuote("process.stdout.write(process.env.RIFFET_CLAUDE_API_KEY || '')")}`;
}

/** A pause that never keeps the process alive on its own. */
export function pause(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }

interface SavedTerminalInspection {
  terminal?: TerminalInfo;
  /** `unknown` when the terminal could not be looked at: neither proof of life nor of exit. */
  process: ClaudeProcess | 'unknown';
  /** A blocking dialog the CLI drew itself, from the screen. */
  interaction?: NativeInteraction;
  /** A dialog the shared terminal observer lifts and answers; the phase needs it, the card is its own. */
  observed?: boolean;
  notice?: string;
}

/** What the driver knows the CLI is waiting on, as opposed to what its screen merely looks like. */
interface ScreenEvidence {
  /** A hook request (a permission, a question) is held open for a person. */
  held: boolean;
  /** The main agent is in a turn, running or waiting. */
  turnOpen: boolean;
  /** Calls the conversation has made and not had answered. */
  open: Array<{ name: string; input: Record<string, unknown> }>;
  /** A question was announced (PreToolUse) and its PermissionRequest hook, which brings the card, is still on its way. */
  questionHookDue?: boolean;
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * A menu on the screen is only worth a card when something is known to be waiting behind it. Its shape
 * is also what a suggested reply or a quoted option list looks like at the end of a turn, and a card for
 * a menu nobody waits on can never be answered. So a dialog the TUI draws as a notice, one of the known
 * blocking startup screens, or one a held hook request explains is believed; otherwise a menu needs a
 * turn in progress and a call that has not returned (for Claude's own question dialog, that very question).
 */
export function screenDialogEndorsed(dialog: NativeInteraction, evidence: ScreenEvidence): boolean {
  if (isClaudeScreenInteraction(dialog) && dialog.kind === 'confirmation') return true;
  // The CLI draws its question dialog about a second before the hook asks for it; a card lifted from the screen
  // meanwhile is replaced the moment the hook lands, and an answer given to it is refused or typed past the hook.
  if (dialog.kind === 'question' && evidence.questionHookDue) return false;
  if (isKnownBlockingTitle(dialog.title) || evidence.held) return true;
  if (!evidence.turnOpen) return false;
  if (isClaudeScreenInteraction(dialog)) {
    const asked = squash(dialog.message ?? '');
    return evidence.open.some(call => call.name === 'AskUserQuestion' && Array.isArray(call.input.questions)
      && call.input.questions.some(item => typeof asRecord(item)?.question === 'string' && squash(asRecord(item)!.question as string) === asked));
  }
  return dialog.kind === 'question' ? evidence.open.some(call => call.name === 'AskUserQuestion') : evidence.open.length > 0;
}

/**
 * Look at a saved terminal without starting, restarting, or sending input to Claude. Whether the CLI
 * is alive is a fact about the terminal; what it is doing is not read here (that is the transcript's).
 * The screen is read only for a dialog that blocks the CLI before any record or hook can speak.
 */
export async function inspectSavedTerminal(host: NativeBackendHost, session: Session, endorsed: (dialog: NativeInteraction) => boolean): Promise<SavedTerminalInspection> {
  if (!session.terminalId) return { process: 'exited' };
  let terminal: TerminalInfo;
  try { terminal = await host.terminal.get(session.terminalId); }
  catch {
    // A lookup/restore error is not proof that tmux exited, nor that anything is running.
    return { process: 'unknown', notice: 'Claude Code terminal state could not be verified.' };
  }
  if (terminal.kind !== 'native' || terminal.sessionId !== session.id || terminal.projectId !== session.projectId) {
    return { terminal, process: 'unknown', notice: 'The saved Claude terminal binding could not be verified.' };
  }
  if (terminal.state === 'exited') return { terminal, process: 'exited' };
  const screen = await host.terminal.screen(terminal.id).catch(() => undefined);
  if (screen === undefined) return { terminal, process: 'alive' };
  const interaction = claudeScreenInteraction(screen, terminal);
  if (interaction && endorsed(interaction)) return { terminal, process: 'alive', interaction };
  const observed = interaction ? undefined : parseDialog(screen, terminal);
  return { terminal, process: 'alive', ...(observed && endorsed(observed.interaction) ? { observed: true } : {}) };
}

export function permissionArgs(permission?: string): string[] {
  if (!permission) return [];
  if (permission === 'default') return [];
  if (!CLAUDE_PERMISSIONS.some(item => item.id === permission)) throw new AppError('INVALID_CLAUDE_PERMISSION', 'Choose a permission mode supported by Claude Code');
  return ['--permission-mode', permission];
}

/**
 * `--version` and `--help` of the CLI at `executable`. Kept per installed binary (its real path and modification time),
 * not per path: Claude Code updates itself behind the same command, and its version gates what is driven on its screen.
 */
export async function runHelp(executable: string): Promise<ClaudeCliProbe> {
  let key = executable;
  try { const real = realpathSync(executable); key = `${real}@${statSync(real).mtimeMs}`; } catch { /* a bare command name: the path is the key */ }
  const cached = probes.get(key);
  if (cached) return cached;
  const task = (async () => {
    const versionResult = await execFileAsync(executable, ['--version'], { timeout: 8000, maxBuffer: 256 * 1024, env: process.env });
    const helpResult = await execFileAsync(executable, ['--help'], { timeout: 8000, maxBuffer: 1024 * 1024, env: process.env });
    const version = `${versionResult.stdout}\n${versionResult.stderr}`.trim();
    const parsed = parseVersion(version);
    const help = `${helpResult.stdout}\n${helpResult.stderr}`;
    if (!parsed) throw new Error('Claude CLI version could not be read');
    return { version, parsed, help };
  })();
  probes.set(key, task);
  try { return await task; }
  catch (error) { probes.delete(key); throw error; }
}

export async function claudeAvailability(profile: NativeBackendProfileConfig): Promise<NativeBackendAvailability> {
  const source = modelSourceOf(profile.config);
  const sourceReason = source && resolveSource(source, profile.config).reason;
  if (sourceReason) return { available: false, reason: sourceReason };
  try {
    const probe = await runHelp(executableOf(profile));
    const { version } = probe;
    const required = ['--settings', '--session-id', '--resume', '--model', '--permission-mode'];
    const missing = required.filter(flag => !probe.help.includes(flag));
    if (missing.length) return { available: false, reason: `Claude Code ${version} is missing required CLI support: ${missing.join(', ')}.`, version };
    const minimum = CLAUDE_CLI_VERSIONS.minimum!;
    if (!versionAtLeast(probe.parsed, minimum)) return { available: false, reason: `Claude Code ${version} is too old for the local interaction bridge; update to ${minimum} or later.`, version };
    return { available: true, version };
  } catch {
    const configured = string(profile.config.executable)?.trim() || process.env.CLAUDE_CLI?.trim() || 'claude';
    const resolution = resolveCliExecutable({ command: configured });
    return { available: false, reason: `Claude Code could not be started from “${resolution.executable}”.${resolution.resolved ? '' : ' Set this profile’s executable to an absolute path.'}${describeSearch(resolution)}` };
  }
}
