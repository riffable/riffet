import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AgentProjectView, AgentSessionView, AgentStandingLaunch } from '@riffet/plugin-api/experimental/agent';
import { withCursorConfigDir, type CursorLaunchProfile } from '../cli-driver.js';

/*
 * Standing team members on Cursor (docs/ASSISTANT.md §4, docs/TEAM.md §3.3).
 *
 * Cursor takes its user configuration from `CURSOR_CONFIG_DIR` (`cli-config.json`, `chats/`) and its project
 * state (including `mcp-disabled.json`) from `CURSOR_DATA_DIR`. A standing conversation runs against its own
 * isolated directory (`<stateDir>/cursor-standing`) for both variables:
 *
 * - Transport settings (`network`, e.g. HTTP/1 relay) are copied from the owner's `cli-config.json`;
 *   approval modes and other preferences are never inherited.
 * - Non-member MCP servers from `~/.cursor/mcp.json` and `<cwd>/.cursor/mcp.json` are disabled via
 *   `<standingDir>/projects/<slug>/mcp-disabled.json`, while the member's own `.mcp.json`, Riffet's tools,
 *   and capability packs (`packs/*`) are mounted via `--plugin-dir` with `--approve-mcps`.
 * - Member identity, member `AGENTS.md`, shared `USER.md`, `memory/MEMORY.md`, and the system prompt are
 *   seeded once per fresh chat (and after compaction) as a leading `<riffet-member>` block on the first prompt
 *   (`wrapStandingPrompt`) and stripped by `userQuery()` / receipt matching (`withoutStandingMemberContext`),
 *   so no `.cursor/rules/` files are written into code repositories or skipped by `.gitignore`.
 * - For project-scoped members whose `cwd` is a code repo, `--add-dir <memberDir>` grants tool access to the
 *   member's `memory/` and `files/` directories without leaving the bound repo.
 * - `preToolUse` enforces `protectedFiles` read-only guards and restricts background `dontAsk` runs to
 *   safe built-in tools plus the isolated MCP tools.
 */

const INSTRUCTION_FILE_CHARS = 20_000;
const STANDING_PROMPT_MAX_CHARS = 36_000;
const STANDING_MEMBER_TAG = /^\s*<riffet-member>[\s\S]*?<\/riffet-member>\s*/;
const STANDING_MCP_PLUGIN = 'riffet-assistant-mcp';

const EDIT_TOOLS = new Set(['Write', 'Delete', 'StrReplace', 'Edit', 'MultiEdit']);
const BACKGROUND_ALLOWED_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'Write', 'StrReplace', 'Edit', 'MultiEdit', 'WebFetch', 'WebSearch']);

const GLOBAL_CODING_NOTE = 'Cursor also loads its built-in default persona and the owner\'s global skills into every session. Those are not addressed to you: follow your Riffet member system prompt, your member AGENTS.md, and your own skills/packs instead.';

/** The isolated directory holding Cursor's config, chats, and project state for standing conversations. */
export function cursorStandingDir(stateDir: string): string {
  return join(stateDir, 'cursor-standing');
}

/** Whether [project] (or a specific [session] inside a bound code project) runs as a standing team member. */
export function isStandingSession(
  project: Pick<AgentProjectView, 'system' | 'agentMemberId'> | undefined,
  session?: Pick<AgentSessionView, 'agentMemberId'> | undefined,
): boolean {
  return project?.system === 'assistant' || Boolean(project?.agentMemberId) || Boolean(session?.agentMemberId);
}

/** Whether [project] itself is a standing member project (`personal` / `global` / legacy assistant). */
export function isStandingProject(project: Pick<AgentProjectView, 'system' | 'agentMemberId'> | undefined): boolean {
  return isStandingSession(project);
}

/** The chat-store config directory for a project/session: isolated for standing members, the profile's own otherwise. */
export function cursorProjectConfigDir(
  baseConfigDir: string,
  stateDir: string,
  project: Pick<AgentProjectView, 'system' | 'agentMemberId'> | undefined,
  session?: Pick<AgentSessionView, 'agentMemberId'> | undefined,
): string {
  return isStandingSession(project, session) ? cursorStandingDir(stateDir) : baseConfigDir;
}

/** Resolves a standing member's own home directory from its `memoryDir` (`<memberDir>/memory`). */
function memberHomeDir(launch: Pick<AgentStandingLaunch, 'memoryDir'> | undefined, fallbackCwd: string): string {
  return launch?.memoryDir ? dirname(launch.memoryDir) : fallbackCwd;
}

/** Stable directory-safe key isolating per-member generated plugins under `<standingDir>/plugins/`. */
function standingMemberKey(launch: Pick<AgentStandingLaunch, 'memoryDir'>): string {
  const dir = memberHomeDir(launch, '');
  const base = basename(dir).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const hash = createHash('sha256').update(dir).digest('hex').slice(0, 8);
  return base ? `${base.slice(0, 40)}-${hash}` : hash;
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
 * Packages the member home's `.mcp.json` files (if any) into a dedicated Cursor plugin directory so they
 * load via `--plugin-dir` alongside Riffet tools and packs without colliding across members.
 */
export function writeStandingMcpPlugin(standingDir: string, mcpConfigFiles: readonly string[], memberKey?: string): { pluginDir?: string; serverNames: string[] } {
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
  const pluginName = memberKey ? `${STANDING_MCP_PLUGIN}-${memberKey}` : STANDING_MCP_PLUGIN;
  const pluginDir = join(standingDir, 'plugins', pluginName);
  if (!serverNames.length) {
    try { rmSync(pluginDir, { recursive: true, force: true }); } catch { /* ignore */ }
    return { serverNames };
  }
  writeAtomicSync(join(pluginDir, '.cursor-plugin', 'plugin.json'), `${JSON.stringify({ name: pluginName, version: '1.0.0' })}\n`);
  writeAtomicSync(join(pluginDir, '.mcp.json'), `${JSON.stringify({ mcpServers: merged }, null, 2)}\n`);
  return { pluginDir, serverNames };
}

/**
 * Disables every non-member MCP server from `~/.cursor/mcp.json` and `<cwd>/.cursor/mcp.json`
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
 * Builds the standing member instruction text carrying:
 * - guidance to override Cursor's built-in persona and global coding skills,
 * - the member's instruction files: `AGENTS.md` (included when working inside a bound code project where
 *   Cursor loads the repo's `AGENTS.md` instead), shared `USER.md`, and `memory/MEMORY.md`,
 * - the full member system prompt.
 */
export function buildStandingSessionContext(cwd: string, launch: AgentStandingLaunch, maxChars = STANDING_PROMPT_MAX_CHARS): string {
  const memberDir = memberHomeDir(launch, cwd);
  const sameDir = real(memberDir) === real(cwd);
  const cwdAgentsReal = real(join(cwd, 'AGENTS.md'));

  // Prioritize member identity (`AGENTS.md`), user profile and memory index before shared boilerplate
  // so tight truncation never strips who the member is.
  const orderedFiles: Array<{ label: string; path: string; text: string }> = [];
  for (const file of launch.instructionFiles) {
    if (sameDir && real(file) === cwdAgentsReal) continue;
    let text: string;
    try { text = readFileSync(file, 'utf8').trim(); } catch { continue; }
    if (!text) continue;
    const rel = relative(memberDir, file).split(sep).join('/');
    const heading = rel && !rel.startsWith('..') ? rel : basename(file);
    const clipped = text.length > INSTRUCTION_FILE_CHARS ? `${text.slice(0, INSTRUCTION_FILE_CHARS)}\n[…]` : text;
    orderedFiles.push({ label: heading, path: file, text: clipped });
  }
  try {
    const sys = readFileSync(launch.systemPromptFile, 'utf8').trim();
    if (sys) orderedFiles.push({ label: 'Riffet System Instructions', path: launch.systemPromptFile, text: sys });
  } catch { /* missing prompt file */ }

  const parts: string[] = [GLOBAL_CODING_NOTE];
  let used = GLOBAL_CODING_NOTE.length;
  for (const item of orderedFiles) {
    const header = `# ${item.label}\n\n`;
    const full = `${header}${item.text}`;
    const sepLen = 2;
    if (used + sepLen + full.length <= maxChars) {
      parts.push(full);
      used += sepLen + full.length;
      continue;
    }
    const suffix = `\n\n[Truncated to fit standing context limit. Read full file at: ${item.path}]`;
    const room = maxChars - used - sepLen - header.length - suffix.length;
    if (room >= 200) {
      parts.push(`${header}${item.text.slice(0, room)}${suffix}`);
      used = maxChars;
    } else {
      const pointer = `${header}[Read full file at: ${item.path}]`;
      if (used + sepLen + pointer.length <= maxChars) {
        parts.push(pointer);
        used += sepLen + pointer.length;
      }
    }
  }
  return parts.join('\n\n');
}

/** Wraps the first user turn of a Cursor standing chat with `<riffet-member>` instructions (stripped from transcripts). */
export function wrapStandingPrompt(cwd: string, launch: AgentStandingLaunch, userText: string): string {
  const context = buildStandingSessionContext(cwd, launch);
  if (!context) return userText;
  return `<riffet-member>\n${context}\n</riffet-member>\n\n${userText}`;
}

/** Strips the leading `<riffet-member>…</riffet-member>` block injected on a standing chat's seed turn. */
export function withoutStandingMemberContext(text: string): string {
  return STANDING_MEMBER_TAG.test(text) ? text.replace(STANDING_MEMBER_TAG, '') : text;
}

/** Whether writing to [filePath] hits one of the owner's protected files in the member directory. */
export function standingProtectsPath(
  filePath: string,
  launch: Pick<AgentStandingLaunch, 'protectedFiles'> & Partial<Pick<AgentStandingLaunch, 'memoryDir'>>,
  cwd: string,
): boolean {
  const absolute = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  const candidate = normalizedTargetPath(absolute);
  const memberDir = memberHomeDir(launch.memoryDir ? { memoryDir: launch.memoryDir } : undefined, cwd);
  const guarded = [...launch.protectedFiles, join(memberDir, '.cursor', '**')];
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
 * 1. Protects owner-owned files (`protectedFiles` + `<memberDir>/.cursor/**`) from file-editing tools.
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
 * Prepares the isolated Cursor configuration directory, MCP allow/disable lists, per-member plugins,
 * and extra CLI launch arguments for one standing conversation launch.
 */
export function prepareStandingLaunch(options: {
  baseProfile: CursorLaunchProfile;
  stateDir: string;
  cwd: string;
  launch: AgentStandingLaunch;
}): PreparedStandingLaunch {
  const standingDir = cursorStandingDir(options.stateDir);
  syncStandingTransport(options.baseProfile.configDir, standingDir);
  const standingProfile = withCursorConfigDir(options.baseProfile, standingDir);

  const memberDir = memberHomeDir(options.launch, options.cwd);
  const memberKey = standingMemberKey(options.launch);
  const mcpPlugin = writeStandingMcpPlugin(standingDir, options.launch.mcpConfigFiles, memberKey);
  const keepServers = new Set<string>(mcpPlugin.serverNames);
  for (const dir of options.launch.pluginDirs) {
    for (const name of mcpServerNamesFromFile(join(dir, '.mcp.json'))) keepServers.add(name);
  }
  writeStandingMcpDisabled(standingDir, options.cwd, keepServers);

  const args: string[] = ['--approve-mcps'];
  // For project-scoped members, cwd is the code repo while memory and delivered files live in `memberDir`.
  if (real(memberDir) !== real(options.cwd) && existsSync(memberDir)) {
    args.push('--add-dir', memberDir);
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
