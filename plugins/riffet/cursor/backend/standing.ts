import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AgentProjectView, AgentStandingLaunch } from '@riffet/plugin-api/experimental/agent';
import { runCursor, withCursorConfigDir, type CursorLaunchProfile } from '../cli-driver.js';
import { CURSOR_HOOK_EVENTS, cursorHookCommand } from './launch-plugin.js';

/*
 * The 助理 on Cursor (docs/ASSISTANT.md §4).
 *
 * Cursor takes its user configuration from `CURSOR_CONFIG_DIR` (`cli-config.json`, `hooks.json`, `chats/`)
 * and its project state (including `mcp-disabled.json`) from `CURSOR_DATA_DIR`. A standing conversation runs
 * against its own isolated directory (`<stateDir>/cursor-standing`) for both variables:
 *
 * - Transport settings (`network`, e.g. HTTP/1 relay) are copied from the owner's `cli-config.json`;
 *   approval modes and other preferences are never inherited.
 * - Non-assistant MCP servers from `~/.cursor/mcp.json` and `<cwd>/.cursor/mcp.json` are disabled via
 *   `<standingDir>/projects/<slug>/mcp-disabled.json`, while the assistant's own `.mcp.json`, Riffet's tools,
 *   and capability packs (`packs/*`) are mounted via `--plugin-dir` with `--approve-mcps`.
 * - System prompt replacement (`--system-prompt <file>`) is enabled when the account supports it (probed once
 *   in the background and cached per launch profile); accounts that refuse it (e.g. team restrictions) fall back
 *   seamlessly to an always-applied workspace rule (`.cursor/rules/riffet-assistant.mdc`) without launch delay.
 * - Interactive TUI hooks live in `<standingDir>/hooks.json` (`userHooks`) so `beforeSubmitPrompt`,
 *   `sessionStart`, `preCompact`, and `preToolUse` all fire reliably.
 * - `preToolUse` enforces `protectedFiles` read-only guards and restricts background `dontAsk` runs to
 *   safe built-in tools plus the isolated MCP tools.
 */

const INSTRUCTION_FILE_CHARS = 20_000;
const SYSTEM_PROMPT_PROBE_TTL_MS = 7 * 24 * 60 * 60_000;
const ASSISTANT_RULE_RELATIVE = join('.cursor', 'rules', 'riffet-assistant.mdc');
const STANDING_MCP_PLUGIN = 'riffet-assistant-mcp';

const EDIT_TOOLS = new Set(['Write', 'Delete', 'StrReplace', 'Edit', 'MultiEdit']);
const BACKGROUND_ALLOWED_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'Write', 'StrReplace', 'Edit', 'MultiEdit', 'WebFetch', 'WebSearch']);

const GLOBAL_CODING_NOTE = 'Cursor also loads its built-in coding instructions and the owner\'s global skills into every session. Those are for coding sessions and are not addressed to you: follow your assistant instructions and your own skills/packs instead.';

/** Per-backend cache for `--system-prompt` capability probes, owned and cleared by `CursorBackend`. */
export class StandingProbeCache {
  readonly results = new Map<string, { supported: boolean; checkedAt: number }>();
  readonly inFlight = new Map<string, Promise<boolean>>();

  clear(): void {
    this.results.clear();
    this.inFlight.clear();
  }
}

/** The isolated directory holding Cursor's config, hooks, chats, and project state for standing conversations. */
export function cursorStandingDir(stateDir: string): string {
  return join(stateDir, 'cursor-standing');
}

/** Whether [project] is the personal assistant's standing project. */
export function isStandingProject(project: Pick<AgentProjectView, 'system'> | undefined): boolean {
  return project?.system === 'assistant';
}

/** The chat-store config directory for a project: isolated for the personal assistant, the profile's own otherwise. */
export function cursorProjectConfigDir(baseConfigDir: string, stateDir: string, project: Pick<AgentProjectView, 'system'> | undefined): string {
  return isStandingProject(project) ? cursorStandingDir(stateDir) : baseConfigDir;
}

/** Cursor's project directory slug under `<CURSOR_DATA_DIR>/projects/`: non-alphanumeric runs become `-`. */
export function cursorDataProjectSlug(cwd: string): string {
  return cwd.replace(/^\/+/, '').replace(/[^A-Za-z0-9-]+/g, '-');
}

function writeAtomicSync(file: string, content: string, mode = 0o600): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, content, { mode, flag: 'wx' });
    renameSync(temp, file);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* ignore */ }
    throw error;
  }
}

function readJsonRecord(file: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function real(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function normalizedTargetPath(path: string): string {
  const folder = path.endsWith(`${sep}**`) ? path.slice(0, -3) : undefined;
  if (folder) return `${real(folder)}${sep}**`;
  return join(real(dirname(path)), basename(path));
}

/**
 * Copies only transport-level `network` settings (such as `useHttp1ForAgent`) from the owner's
 * `cli-config.json` into the standing directory, keeping approval/permission preferences isolated.
 */
export function syncStandingTransport(ownerConfigDir: string, standingDir: string): void {
  mkdirSync(standingDir, { recursive: true, mode: 0o700 });
  const ownerConfig = readJsonRecord(join(ownerConfigDir, 'cli-config.json'));
  const targetPath = join(standingDir, 'cli-config.json');
  const existing = readJsonRecord(targetPath) ?? {};
  const ownerNetwork = ownerConfig?.network;
  const next: Record<string, unknown> = {};
  if (ownerNetwork && typeof ownerNetwork === 'object' && !Array.isArray(ownerNetwork)) {
    next.network = ownerNetwork;
  } else if (existing.network && typeof existing.network === 'object' && !Array.isArray(existing.network)) {
    next.network = existing.network;
  }
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  let current: string | undefined;
  try { current = readFileSync(targetPath, 'utf8'); } catch { /* absent */ }
  if (current !== serialized) writeAtomicSync(targetPath, serialized);
}

/** Writes `<standingDir>/hooks.json` (`userHooks`) so interactive TUI fires `beforeSubmitPrompt` and all other hooks. */
export function writeStandingHooksFile(standingDir: string, bridgeConfigPath: string): string {
  const command = cursorHookCommand(bridgeConfigPath);
  const hooksPath = join(standingDir, 'hooks.json');
  const content = `${JSON.stringify({
    version: 1,
    hooks: Object.fromEntries(CURSOR_HOOK_EVENTS.map(event => [event, [{ command, timeout: 10 }]])),
  }, null, 2)}\n`;
  let existing: string | undefined;
  try { existing = readFileSync(hooksPath, 'utf8'); } catch { /* absent */ }
  if (existing !== content) writeAtomicSync(hooksPath, content);
  return hooksPath;
}

function mcpServerNamesFromFile(file: string): string[] {
  const parsed = readJsonRecord(file);
  const servers = parsed?.mcpServers;
  return servers && typeof servers === 'object' && !Array.isArray(servers) ? Object.keys(servers) : [];
}

/** Expands `${VAR}` and `${VAR:-default}` in an `.mcp.json` server definition. */
function expandEnvValue(value: unknown, pluginRoot?: string): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => {
      if ((name === 'CLAUDE_PLUGIN_ROOT' || name === 'CURSOR_PLUGIN_ROOT') && pluginRoot) return pluginRoot;
      return process.env[name] ?? fallback ?? '';
    });
  }
  if (Array.isArray(value)) return value.map(item => expandEnvValue(item, pluginRoot));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnvValue(v, pluginRoot)]));
  }
  return value;
}

/**
 * Packages the assistant home's `.mcp.json` files (if any) into a dedicated Cursor plugin directory so they
 * load via `--plugin-dir` alongside Riffet tools and packs.
 */
export function writeStandingMcpPlugin(standingDir: string, mcpConfigFiles: readonly string[]): { pluginDir?: string; serverNames: string[] } {
  const merged: Record<string, unknown> = {};
  for (const file of mcpConfigFiles) {
    const parsed = readJsonRecord(file);
    const servers = parsed?.mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) continue;
    for (const [name, definition] of Object.entries(servers)) {
      if (definition && typeof definition === 'object' && !Array.isArray(definition)) {
        merged[name] = expandEnvValue(definition);
      }
    }
  }
  const serverNames = Object.keys(merged);
  const pluginDir = join(standingDir, 'plugins', STANDING_MCP_PLUGIN);
  if (!serverNames.length) {
    try { rmSync(pluginDir, { recursive: true, force: true }); } catch { /* ignore */ }
    return { serverNames };
  }
  writeAtomicSync(join(pluginDir, '.cursor-plugin', 'plugin.json'), `${JSON.stringify({ name: STANDING_MCP_PLUGIN, version: '1.0.0' })}\n`);
  writeAtomicSync(join(pluginDir, '.mcp.json'), `${JSON.stringify({ mcpServers: merged }, null, 2)}\n`);
  return { pluginDir, serverNames };
}

/**
 * Disables every non-assistant MCP server from `~/.cursor/mcp.json` and `<cwd>/.cursor/mcp.json`
 * via `<standingDir>/projects/<slug>/mcp-disabled.json`.
 */
export function writeStandingMcpDisabled(standingDir: string, cwd: string, keepServers: ReadonlySet<string>, homeDir = homedir()): string[] {
  const candidates = new Set<string>([
    ...mcpServerNamesFromFile(join(homeDir, '.cursor', 'mcp.json')),
    ...mcpServerNamesFromFile(join(cwd, '.cursor', 'mcp.json')),
  ]);
  const disabled = [...candidates].filter(name => !keepServers.has(name)).sort();
  const slugs = new Set<string>([cursorDataProjectSlug(cwd), cursorDataProjectSlug(real(cwd))]);
  const content = `${JSON.stringify(disabled, null, 2)}\n`;
  for (const slug of slugs) {
    if (!slug) continue;
    const target = join(standingDir, 'projects', slug, 'mcp-disabled.json');
    let existing: string | undefined;
    try { existing = readFileSync(target, 'utf8'); } catch { /* absent */ }
    if (existing !== content) writeAtomicSync(target, content);
  }
  return disabled;
}

/**
 * Checks whether the current Cursor account accepts `--system-prompt <file>`.
 * Returns the cached verdict synchronously when fresh; otherwise returns `false` immediately so launches
 * never stall on retries, and triggers a single background probe whose result is persisted for subsequent launches.
 */
export function systemPromptSupported(standingProfile: CursorLaunchProfile, standingDir: string, cache?: StandingProbeCache): boolean {
  const key = standingProfile.identityKey;
  const now = Date.now();
  const mem = cache?.results.get(key);
  if (mem && now - mem.checkedAt < SYSTEM_PROMPT_PROBE_TTL_MS) return mem.supported;
  const probeFile = join(standingDir, 'system-prompt-probe.json');
  const disk = readJsonRecord(probeFile);
  if (disk && disk.identityKey === key && typeof disk.supported === 'boolean' && typeof disk.checkedAt === 'number' && now - disk.checkedAt < SYSTEM_PROMPT_PROBE_TTL_MS) {
    cache?.results.set(key, { supported: disk.supported, checkedAt: disk.checkedAt });
    return disk.supported;
  }
  if (cache && !cache.inFlight.has(key)) {
    const task = probeSystemPromptOnce(standingProfile, standingDir, probeFile, cache).finally(() => { cache.inFlight.delete(key); });
    cache.inFlight.set(key, task);
  }
  return false;
}

async function probeSystemPromptOnce(standingProfile: CursorLaunchProfile, standingDir: string, probeFile: string, cache: StandingProbeCache): Promise<boolean> {
  const work = join(tmpdir(), `riffet-cursor-sysprobe-${process.pid}-${randomBytes(6).toString('hex')}`);
  const promptPath = join(work, 'sys.md');
  let supported = false;
  try {
    mkdirSync(work, { recursive: true, mode: 0o700 });
    writeFileSync(promptPath, 'Reply with OK.\n', { mode: 0o600 });
    const result = await runCursor(standingProfile, [
      '--print', '--output-format', 'json', '--trust', '--system-prompt', promptPath, '--', 'Reply with OK.',
    ], { cwd: work, env: { CURSOR_DATA_DIR: standingDir }, timeoutMs: 30_000, maxOutputBytes: 256 * 1024 });
    supported = result.code === 0 && !/Custom system prompt is not enabled/i.test(`${result.stderr}\n${result.stdout}`);
  } catch {
    supported = false;
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  const entry = { supported, checkedAt: Date.now() };
  cache.results.set(standingProfile.identityKey, entry);
  try {
    writeAtomicSync(probeFile, `${JSON.stringify({ identityKey: standingProfile.identityKey, ...entry }, null, 2)}\n`);
  } catch { /* best-effort cache */ }
  return supported;
}

/**
 * Writes the assistant's always-applied Cursor rule (`.cursor/rules/riffet-assistant.mdc`) carrying:
 * - guidance to ignore global coding skills/prompts,
 * - the full assistant system prompt whenever `--system-prompt` is not active on this account,
 * - the owner profile (`USER.md`) and memory index (`memory/MEMORY.md`).
 * (`AGENTS.md` is already read natively by Cursor from the workspace root.)
 */
export function writeStandingAssistantRule(cwd: string, launch: AgentStandingLaunch, useSystemPromptFlag: boolean): string {
  const sections: string[] = [GLOBAL_CODING_NOTE];
  if (!useSystemPromptFlag) {
    try {
      const sys = readFileSync(launch.systemPromptFile, 'utf8').trim();
      if (sys) sections.push(sys);
    } catch { /* missing prompt file */ }
  }
  for (const file of launch.instructionFiles) {
    const rel = relative(cwd, file).split(sep).join('/') || basename(file);
    // AGENTS.md is already loaded natively by Cursor from the assistant directory root.
    if (rel === 'AGENTS.md') continue;
    let text: string;
    try { text = readFileSync(file, 'utf8').trim(); } catch { continue; }
    if (!text) continue;
    const clipped = text.length > INSTRUCTION_FILE_CHARS ? `${text.slice(0, INSTRUCTION_FILE_CHARS)}\n[…]` : text;
    sections.push(`# ${rel}\n\n${clipped}`);
  }
  const ruleContent = [
    '---',
    'description: Riffet personal assistant identity, memory index, and operating rules',
    'alwaysApply: true',
    '---',
    '',
    sections.join('\n\n'),
    '',
  ].join('\n');
  const rulePath = join(cwd, ASSISTANT_RULE_RELATIVE);
  let existing: string | undefined;
  try { existing = readFileSync(rulePath, 'utf8'); } catch { /* absent */ }
  if (existing !== ruleContent) writeAtomicSync(rulePath, ruleContent);
  return rulePath;
}

/** Whether writing to [filePath] hits one of the owner's protected files in the assistant directory. */
export function standingProtectsPath(filePath: string, launch: Pick<AgentStandingLaunch, 'protectedFiles'>, cwd: string): boolean {
  const absolute = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  const candidate = normalizedTargetPath(absolute);
  const guarded = [...launch.protectedFiles, join(cwd, ASSISTANT_RULE_RELATIVE), join(cwd, '.cursor', '**')];
  return guarded.map(normalizedTargetPath).some(entry => entry.endsWith(`${sep}**`)
    ? candidate.startsWith(entry.slice(0, -2)) || candidate === entry.slice(0, -3)
    : candidate === entry);
}

export interface StandingToolDecision {
  allowed: boolean;
  userMessage?: string;
  agentMessage?: string;
}

/**
 * Enforces standing conversation guardrails inside Cursor's `preToolUse` hook:
 * 1. Protects owner-owned files (`protectedFiles` + `.cursor/**`) from file-editing tools.
 * 2. In background runs (`launch.allow` present, i.e. `approval: 'dontAsk'`), restricts execution
 *    to safe built-in tools plus isolated MCP tools (`MCP:*`), blocking `Shell` and other unapproved tools.
 */
export function evaluateStandingToolUse(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  launch: AgentStandingLaunch,
  cwd: string,
  isBackgroundRun: boolean,
): StandingToolDecision {
  if (EDIT_TOOLS.has(toolName)) {
    const rawPath = [toolInput?.file_path, toolInput?.path].find((value): value is string => typeof value === 'string' && value.length > 0);
    if (rawPath && standingProtectsPath(rawPath, launch, cwd)) {
      return {
        allowed: false,
        userMessage: 'This file is protected and can only be edited by the owner.',
        agentMessage: 'This file is protected and read-only for the assistant.',
      };
    }
  }
  if (isBackgroundRun || launch.allow) {
    const allowed = BACKGROUND_ALLOWED_TOOLS.has(toolName) || toolName.startsWith('MCP:');
    if (!allowed) {
      return {
        allowed: false,
        userMessage: `${toolName} is blocked in background runs.`,
        agentMessage: `${toolName} is not permitted during autonomous background runs.`,
      };
    }
  }
  return { allowed: true };
}

export interface PreparedStandingLaunch {
  profile: CursorLaunchProfile;
  args: string[];
  env: Record<string, string>;
}

/**
 * Prepares the isolated Cursor configuration directory, MCP allow/disable lists, hooks file,
 * assistant rule / `--system-prompt`, and extra CLI launch arguments for one standing conversation launch.
 */
export function prepareStandingLaunch(options: {
  baseProfile: CursorLaunchProfile;
  stateDir: string;
  cwd: string;
  launch: AgentStandingLaunch;
  bridgeConfigPath?: string;
  probeCache?: StandingProbeCache;
}): PreparedStandingLaunch {
  const standingDir = cursorStandingDir(options.stateDir);
  syncStandingTransport(options.baseProfile.configDir, standingDir);
  if (options.bridgeConfigPath) writeStandingHooksFile(standingDir, options.bridgeConfigPath);
  const standingProfile = withCursorConfigDir(options.baseProfile, standingDir);

  const mcpPlugin = writeStandingMcpPlugin(standingDir, options.launch.mcpConfigFiles);
  const keepServers = new Set<string>(mcpPlugin.serverNames);
  for (const dir of options.launch.pluginDirs) {
    for (const name of mcpServerNamesFromFile(join(dir, '.mcp.json'))) keepServers.add(name);
  }
  writeStandingMcpDisabled(standingDir, options.cwd, keepServers);

  const useSystemPrompt = systemPromptSupported(standingProfile, standingDir, options.probeCache);
  writeStandingAssistantRule(options.cwd, options.launch, useSystemPrompt);

  const args: string[] = ['--approve-mcps'];
  if (useSystemPrompt && existsSync(options.launch.systemPromptFile)) {
    args.push('--system-prompt', options.launch.systemPromptFile);
  }
  for (const dir of options.launch.pluginDirs) {
    if (existsSync(dir)) args.push('--plugin-dir', dir);
  }
  if (mcpPlugin.pluginDir) args.push('--plugin-dir', mcpPlugin.pluginDir);

  return {
    profile: standingProfile,
    args,
    env: { CURSOR_DATA_DIR: standingDir },
  };
}
