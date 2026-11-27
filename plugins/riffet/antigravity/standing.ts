import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { NativeSlashItem } from '@contracts';
import type { AgentProjectView, AgentSessionView, AgentStandingLaunch } from '@riffet/plugin-api/experimental/agent';
import { scanSkillRoots } from '@riffet/plugin-api/kit';

/*
 * Standing team members on Antigravity (docs/ASSISTANT.md §4, docs/TEAM.md §3.3, docs/ANTIGRAVITY.md §25.5).
 *
 * Each standing team member gets its own isolated `--gemini_dir` (`<stateDir>/standing/<memberKey>`):
 * - Rules/instructions (`instructionFiles` + `systemPromptFile`) are written to `<standingDir>/config/rules/riffet-member.md`.
 * - Member-scoped MCP servers (`mcpConfigFiles`) are expanded and written to `<standingDir>/config/mcp_config.json`,
 *   completely isolated from the user's `~/.gemini/config/mcp_config.json`.
 * - Member skills (`skillsDir` + `pluginDirs/skills`) are synced into `<standingDir>/config/skills/`.
 * - Riffet MCP still loads per-session via the bridge plugin (`--add-dir <bridgeDir>`).
 * - `PreToolUse` hook enforces `StandingGuardPolicy` (`protectedFiles` + background shell blocking).
 */

const INSTRUCTION_FILE_CHARS = 24_000;
const STANDING_INSTRUCTIONS_MAX_CHARS = 48_000;
const MAX_SKILL_FILE_BYTES = 1024 * 1024;
const MAX_SKILL_DEPTH = 4;

const WRITE_TOOLS = new Set([
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'edit_file',
  'write_file',
  'delete_file',
  'create_file',
  'move_file',
  'rename_file',
  'write',
  'edit',
  'strreplace',
  'multiedit',
  'delete',
]);

const SHELL_TOOLS = new Set([
  'run_command',
  'send_command_input',
  'run_shell_command',
  'execute_command',
  'shell',
  'bash',
  'terminal',
]);

const PATH_KEYS = [
  'TargetFile',
  'target_file',
  'AbsolutePath',
  'absolute_path',
  'FilePath',
  'file_path',
  'path',
  'Path',
  'destination',
  'DestinationPath',
  'dest',
  'target',
  'file',
  'source',
  'SourcePath',
  'source_path',
  'from',
  'old_path',
  'oldPath',
] as const;

const SECRET_FILE_PATTERN = /^(?:\.env(?:\..+)?|.*\.(?:pem|key|p12|pfx)|credentials\.json|secrets?\.json)$/i;

export interface StandingGuardPolicy {
  memberDir: string;
  cwd: string;
  protectedFiles: string[];
  isBackgroundRun: boolean;
}

export interface StandingToolDecision {
  decision: 'allow' | 'deny';
  reason?: string;
}

export interface PreparedStandingGeminiDir {
  standingDir: string;
  memberDir: string;
  guard: StandingGuardPolicy;
  mcpServerNames: string[];
  extraDirs: string[];
}

/** Whether [project] (or a specific [session] inside a bound code project) runs as a standing team member. */
export function isStandingSession(
  project: Pick<AgentProjectView, 'system' | 'agentMemberId'> | undefined,
  session?: Pick<AgentSessionView, 'agentMemberId'> | undefined,
): boolean {
  return project?.system === 'assistant' || Boolean(project?.agentMemberId) || Boolean(session?.agentMemberId);
}

/** Resolves a standing member's home directory from its `memoryDir` (`<memberDir>/memory`). */
export function memberHomeDir(launch: Pick<AgentStandingLaunch, 'memoryDir'> | undefined, fallbackCwd: string): string {
  return launch?.memoryDir ? dirname(launch.memoryDir) : fallbackCwd;
}

/** Stable directory-safe key isolating each standing member's `--gemini_dir` under `<stateDir>/standing/`. */
export function standingMemberKey(launch: Pick<AgentStandingLaunch, 'memoryDir'>): string {
  const dir = memberHomeDir(launch, '');
  const base = basename(dir).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[^A-Za-z0-9]+|-+$/g, '');
  const hash = createHash('sha256').update(dir).digest('hex').slice(0, 8);
  return base ? `${base.slice(0, 40)}-${hash}` : hash;
}

/** The isolated `--gemini_dir` root for a standing team member. */
export function agyStandingDir(stateDir: string, launch: Pick<AgentStandingLaunch, 'memoryDir'>): string {
  return join(resolve(stateDir), 'standing', standingMemberKey(launch));
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Resolves symlinks on [path] itself when it exists, or on the nearest existing ancestor when creating nested children. */
function canonicalPath(path: string): string {
  const abs = resolve(path);
  const tail: string[] = [];
  let cursor = abs;
  for (;;) {
    try {
      const resolved = realpathSync(cursor);
      return tail.length ? join(resolved, ...tail.reverse()) : resolved;
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return abs;
      tail.push(basename(cursor));
      cursor = parent;
    }
  }
}

function normalizedTargetPath(path: string): string {
  const folder = path.endsWith(`${sep}**`) ? path.slice(0, -3) : undefined;
  if (folder) return `${canonicalPath(folder)}${sep}**`;
  return canonicalPath(path);
}

function writeAtomicSync(file: string, content: string, mode = 0o600): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, content, { mode, flag: 'wx' });
    renameSync(temp, file);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* ignore */
    }
    throw error;
  }
}

function writeIfChangedSync(file: string, content: string, mode = 0o600): void {
  let current: string | undefined;
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    /* absent */
  }
  if (current !== content) writeAtomicSync(file, content, mode);
}

function readJsonRecord(file: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Expands `${VAR}` and `${VAR:-default}` in an `.mcp.json` server definition. */
function expandEnvValue(value: unknown, pluginRoot?: string): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => {
      if ((name === 'CLAUDE_PLUGIN_ROOT' || name === 'CURSOR_PLUGIN_ROOT' || name === 'ANTIGRAVITY_PLUGIN_ROOT') && pluginRoot) {
        return pluginRoot;
      }
      return process.env[name] ?? fallback ?? '';
    });
  }
  if (Array.isArray(value)) return value.map(item => expandEnvValue(item, pluginRoot));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnvValue(v, pluginRoot)]));
  }
  return value;
}

/** Builds the member instruction document written to `<standingDir>/config/rules/riffet-member.md`. */
export function buildStandingInstructions(cwd: string, launch: AgentStandingLaunch, maxChars = STANDING_INSTRUCTIONS_MAX_CHARS): string {
  const memberDir = memberHomeDir(launch, cwd);
  const sameDir = real(memberDir) === real(cwd);
  const cwdAgentsReal = real(join(cwd, 'AGENTS.md'));

  const orderedFiles: Array<{ label: string; path: string; text: string }> = [];
  for (const file of launch.instructionFiles) {
    if (sameDir && real(file) === cwdAgentsReal) continue;
    let text: string;
    try {
      text = readFileSync(file, 'utf8').trim();
    } catch {
      continue;
    }
    if (!text) continue;
    const rel = relative(memberDir, file).split(sep).join('/');
    const heading = rel && !rel.startsWith('..') ? rel : basename(file);
    const clipped = text.length > INSTRUCTION_FILE_CHARS ? `${text.slice(0, INSTRUCTION_FILE_CHARS)}\n[…]` : text;
    orderedFiles.push({ label: heading, path: file, text: clipped });
  }
  try {
    const sys = readFileSync(launch.systemPromptFile, 'utf8').trim();
    if (sys) orderedFiles.push({ label: 'Riffet System Instructions', path: launch.systemPromptFile, text: sys });
  } catch {
    /* missing system prompt file */
  }

  const parts: string[] = [];
  let used = 0;
  for (const item of orderedFiles) {
    const header = `# ${item.label}\n\n`;
    const full = `${header}${item.text}`;
    const sepLen = parts.length ? 2 : 0;
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
  return parts.length ? `${parts.join('\n\n')}\n` : '';
}

function syncMemberMcpConfig(standingDir: string, mcpConfigFiles: readonly string[]): string[] {
  const merged: Record<string, unknown> = {};
  for (const file of mcpConfigFiles) {
    const parsed = readJsonRecord(file);
    const servers = parsed?.mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) continue;
    const pluginRoot = dirname(file);
    for (const [name, definition] of Object.entries(servers)) {
      if (definition && typeof definition === 'object' && !Array.isArray(definition)) {
        merged[name] = expandEnvValue(definition, pluginRoot);
      }
    }
  }
  writeIfChangedSync(join(standingDir, 'config', 'mcp_config.json'), `${JSON.stringify({ mcpServers: merged }, null, 2)}\n`);
  return Object.keys(merged);
}

/** Directories scanned for a standing member's own skills and capability pack skills. */
export function standingSkillRoots(launch: Pick<AgentStandingLaunch, 'skillsDir' | 'pluginDirs'>): string[] {
  return [launch.skillsDir, ...launch.pluginDirs.map(dir => join(dir, 'skills'))];
}

/** Lists slash-invocable skills belonging to a standing member. */
export function scanStandingSkills(launch: Pick<AgentStandingLaunch, 'skillsDir' | 'pluginDirs'>): Promise<NativeSlashItem[]> {
  return scanSkillRoots(standingSkillRoots(launch));
}

function copySafeSkillTree(srcDir: string, destDir: string, depth = 0): void {
  if (depth > MAX_SKILL_DEPTH) return;
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  let entries;
  try {
    entries = readdirSync(srcDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SECRET_FILE_PATTERN.test(entry.name)) continue;
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    let info;
    try {
      info = lstatSync(srcPath);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      copySafeSkillTree(srcPath, destPath, depth + 1);
    } else if (info.isFile() && info.size <= MAX_SKILL_FILE_BYTES) {
      copyFileSync(srcPath, destPath);
    }
  }
}

function discoverSkillDirs(root: string, depth = 0, out: string[] = []): string[] {
  if (depth > MAX_SKILL_DEPTH || !existsSync(root)) return out;
  if (existsSync(join(root, 'SKILL.md'))) {
    out.push(root);
    return out;
  }
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) discoverSkillDirs(full, depth + 1, out);
  }
  return out;
}

function syncStandingSkillsDir(standingDir: string, launch: Pick<AgentStandingLaunch, 'skillsDir' | 'pluginDirs'>): void {
  const targetRoot = join(standingDir, 'config', 'skills');
  mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  const keep = new Set<string>();
  for (const root of standingSkillRoots(launch)) {
    for (const skillDir of discoverSkillDirs(root)) {
      const slug = basename(skillDir).replace(/[^A-Za-z0-9._-]+/g, '-');
      if (!slug || keep.has(slug)) continue;
      keep.add(slug);
      const dest = join(targetRoot, slug);
      try {
        rmSync(dest, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      copySafeSkillTree(skillDir, dest);
    }
  }
  try {
    for (const entry of readdirSync(targetRoot, { withFileTypes: true })) {
      if (!keep.has(entry.name)) {
        rmSync(join(targetRoot, entry.name), { recursive: true, force: true });
      }
    }
  } catch {
    /* ignore */
  }
}

/** Whether writing to [filePath] hits one of the protected files in [policy]. */
export function standingProtectsPath(filePath: string, policy: StandingGuardPolicy): boolean {
  const absolute = isAbsolute(filePath) ? filePath : resolve(policy.cwd, filePath);
  const candidate = normalizedTargetPath(absolute);
  const guarded = [...policy.protectedFiles];
  return guarded.map(normalizedTargetPath).some(entry =>
    entry.endsWith(`${sep}**`)
      ? candidate.startsWith(entry.slice(0, -2)) || candidate === entry.slice(0, -3)
      : candidate === entry,
  );
}

/**
 * Enforces standing member guardrails for `PreToolUse`:
 * 1. Protects owner-owned files (`protectedFiles`) from file-editing tools.
 * 2. In background runs (`isBackgroundRun`), blocks shell/command execution tools while allowing
 *    read-only tools, non-protected file edits, web search, and MCP tools.
 */
export function evaluateStandingToolUse(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  policy: StandingGuardPolicy,
): StandingToolDecision {
  const lower = toolName.trim().toLowerCase();
  if (WRITE_TOOLS.has(toolName) || WRITE_TOOLS.has(lower)) {
    for (const key of PATH_KEYS) {
      const raw = toolInput?.[key];
      if (typeof raw === 'string' && raw.length > 0 && standingProtectsPath(raw, policy)) {
        return {
          decision: 'deny',
          reason: 'This file is protected and read-only for this team member.',
        };
      }
    }
  }
  if (policy.isBackgroundRun && (SHELL_TOOLS.has(toolName) || SHELL_TOOLS.has(lower))) {
    return {
      decision: 'deny',
      reason: `${toolName} is blocked during autonomous background runs.`,
    };
  }
  return { decision: 'allow' };
}

/**
 * Prepares the isolated `--gemini_dir` for a standing team member, syncing instructions,
 * member MCP config, skills, and producing the `PreToolUse` guard policy and extra `--add-dir` paths.
 */
export function prepareStandingGeminiDir(options: {
  stateDir: string;
  cwd: string;
  launch: AgentStandingLaunch;
  sourceDir: string;
  isBackgroundRun?: boolean;
}): PreparedStandingGeminiDir {
  const rawStandingDir = agyStandingDir(options.stateDir, options.launch);
  for (const dir of [
    rawStandingDir,
    join(rawStandingDir, 'antigravity-cli'),
    join(rawStandingDir, 'config'),
    join(rawStandingDir, 'config', 'rules'),
    join(rawStandingDir, 'config', 'skills'),
    join(rawStandingDir, 'config', 'plugins'),
  ]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const standingDir = real(rawStandingDir);
  const memberDir = memberHomeDir(options.launch, options.cwd);
  const realCwd = real(options.cwd);

  const instructions = buildStandingInstructions(options.cwd, options.launch);
  const rulesFile = join(standingDir, 'config', 'rules', 'riffet-member.md');
  if (instructions) {
    writeIfChangedSync(rulesFile, instructions, 0o600);
  } else {
    try {
      rmSync(rulesFile, { force: true });
    } catch {
      /* ignore */
    }
  }

  const mcpFiles = [
    ...options.launch.mcpConfigFiles,
    ...options.launch.pluginDirs.map(dir => join(dir, '.mcp.json')),
  ];
  const mcpServerNames = syncMemberMcpConfig(standingDir, mcpFiles);
  syncStandingSkillsDir(standingDir, options.launch);

  const extraDirs: string[] = [];
  const seenDirs = new Set<string>([realCwd]);
  const maybeAdd = (dir: string) => {
    if (!dir || !existsSync(dir)) return;
    const canonical = real(dir);
    if (seenDirs.has(canonical)) return;
    seenDirs.add(canonical);
    extraDirs.push(dir);
  };
  if (real(memberDir) !== realCwd) maybeAdd(memberDir);
  for (const pluginDir of options.launch.pluginDirs) maybeAdd(pluginDir);

  const guard: StandingGuardPolicy = {
    memberDir: real(memberDir),
    cwd: realCwd,
    protectedFiles: [...options.launch.protectedFiles],
    isBackgroundRun: Boolean(options.isBackgroundRun ?? options.launch.allow),
  };

  return { standingDir, memberDir, guard, mcpServerNames, extraDirs };
}
