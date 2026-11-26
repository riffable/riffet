import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { CodexAppServerClient } from '../shared/codex-app-server.js';
import type { StandingLaunch } from '../types.js';
import { readConfiguredMcpNames } from './extensions.js';
import { asArray, asRecord, str } from './util.js';

/*
 * The 助理 on Codex (docs/ASSISTANT.md §4). Claude Code takes its isolation as launch flags; the Codex app-server takes
 * it per thread, at every start and resume, and has a switch for most of it:
 *
 * - its coding prompt is replaced (`baseInstructions`), and the directory's `AGENTS.md` is not read as a project
 *   file but handed over with the owner's profile and the memory index (`developerInstructions`);
 * - Riffet's skills, the capability packs and the owner's skills for the 助理 are extra skill roots of the process;
 *   every other skill it finds (bundled, the owner's, plugins') is switched off by its path;
 * - plugins and ChatGPT apps are off, and so is every MCP server of the owner's configuration; the directory's and
 *   the packs' own (`.mcp.json`) are declared instead;
 * - the thread's sandbox is a permission profile ({@link STANDING_PROFILE}) that leaves the owner's files read-only,
 *   in place of the workspace-write preset; a turn that names a sandbox of its own replaces it until the thread is
 *   loaded again, so the runtime names none while the profile stands (`runtime.ts`);
 * - it summarizes at the same size as Claude Code does for it (`model_auto_compact_token_limit`).
 *
 * Two things have no switch: the owner's global `$CODEX_HOME/AGENTS.md` is always loaded (the developer
 * instructions say it is not addressed to the 助理), and the owner's hooks still run (Riffet's own command
 * observation is a hook, so hooks stay on).
 */

/** Longest text of one instruction file handed over; the system prompt asks for far less. */
const INSTRUCTION_FILE_CHARS = 20_000;

export interface CodexStanding {
  memberDir: string;
  baseInstructions: string;
  developerInstructions: string;
  /** The directory's and the packs' MCP servers (Claude Code's `.mcp.json`), as Codex declares them. */
  mcpServers: Record<string, Record<string, unknown>>;
  /** The owner's files (`StandingLaunch.protectedFiles`): exact paths, or a folder's contents as `<folder>/**`. */
  protectedFiles: string[];
  compactAtTokens: number;
  /** Plugin folders (`.claude-plugin/plugin.json`, which Codex reads, naming their skills `<plugin>:<skill>`) and the owner's skill folder. */
  skillRoots: string[];
}

const GLOBAL_NOTE = 'Codex also loads the owner\'s global instructions file into every session it runs; it appears as "AGENTS.md instructions" without a directory. It was written for the owner\'s coding sessions and is not addressed to you: do not follow it. Your rules, the owner\'s profile and your memory index follow, as read from your directory when this session started.';

export function codexStanding(launch: StandingLaunch | undefined): CodexStanding | undefined {
  if (!launch) return undefined;
  const home = dirname(launch.instructionFiles[0] ?? launch.skillsDir);
  const files = launch.instructionFiles.flatMap(file => {
    let text: string;
    try { text = readFileSync(file, 'utf8').trim(); } catch { return []; }
    if (!text) return [];
    const clipped = text.length > INSTRUCTION_FILE_CHARS ? `${text.slice(0, INSTRUCTION_FILE_CHARS)}\n[…]` : text;
    return [`# ${relative(home, file).split(sep).join('/') || basename(file)}\n\n${clipped}`];
  });
  return {
    memberDir: home,
    baseInstructions: readFileSync(launch.systemPromptFile, 'utf8'),
    developerInstructions: [GLOBAL_NOTE, ...files].join('\n\n'),
    skillRoots: [...launch.pluginDirs, launch.skillsDir],
    protectedFiles: launch.protectedFiles,
    compactAtTokens: launch.compactAtTokens,
    mcpServers: Object.assign({}, ...launch.mcpConfigFiles.map(file => codexMcpServers(file)), ...launch.pluginDirs.map(dir => codexMcpServers(join(dir, '.mcp.json'), dir))),
  };
}

/**
 * Claude Code's `.mcp.json` as Codex `mcp_servers` entries. Its `${VAR}` and `${VAR:-default}` are expanded here,
 * from the server's environment, and a plugin's `${CLAUDE_PLUGIN_ROOT}` to [pluginRoot]: Codex expands neither. A
 * server Codex cannot run (SSE) or cannot be named in a dotted key is left out, as is a file that does not parse.
 */
export function codexMcpServers(file: string, pluginRoot?: string): Record<string, Record<string, unknown>> {
  let declared: Record<string, unknown> | undefined;
  try { declared = asRecord(asRecord(JSON.parse(readFileSync(file, 'utf8')))?.mcpServers); } catch { return {}; }
  const expand = (value: unknown): unknown => typeof value === 'string'
    ? value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => name === 'CLAUDE_PLUGIN_ROOT' && pluginRoot ? pluginRoot : process.env[name] ?? fallback ?? '')
    : Array.isArray(value) ? value.map(expand)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)])) : value;
  const strings = (value: unknown) => asArray<unknown>(value).filter((item): item is string => typeof item === 'string');
  const table = (value: unknown) => Object.fromEntries(Object.entries(asRecord(value) ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const servers: Record<string, Record<string, unknown>> = {};
  for (const [name, raw] of Object.entries(declared ?? {})) {
    const server = asRecord(expand(raw));
    if (!server || !/^[\w-]+$/.test(name)) continue;
    const command = str(server.command), url = str(server.url), type = str(server.type), env = table(server.env), headers = table(server.headers);
    if (command && (!type || type === 'stdio')) {
      servers[name] = { command, args: strings(server.args), ...(Object.keys(env).length ? { env } : {}), ...(str(server.cwd) ? { cwd: str(server.cwd) } : {}) };
    } else if (url && (!type || type === 'http')) {
      servers[name] = { url, ...(Object.keys(headers).length ? { http_headers: headers } : {}) };
    }
  }
  return servers;
}

/** Makes the standing skill roots the process's extra roots: the app-server keeps one set, which a later call replaces. */
export async function useStandingSkillRoots(transport: CodexAppServerClient, standing: CodexStanding): Promise<void> {
  await transport.request('skills/extraRoots/set', { extraRoots: standing.skillRoots }, 10_000);
}

function real(path: string): string { try { return realpathSync(path); } catch { return path; } }

/** The permission profile of the 助理's thread: the workspace-write preset with the owner's files read-only. */
export const STANDING_PROFILE = 'riffet_assistant';

/** A protected path as Codex compares it, resolved through links (macOS's temp and state folders often are one). */
function protectedPath(path: string): string {
  const folder = path.endsWith(`${sep}**`) ? path.slice(0, -3) : undefined;
  if (folder) return `${real(folder)}${sep}**`;
  return join(real(dirname(path)), basename(path));
}

/** Whether a write to [path] is one the 助理 must not make: one of the owner's files (docs/ASSISTANT.md §2). */
export function standingProtects(path: string, standing: CodexStanding): boolean {
  const file = protectedPath(path);
  return standing.protectedFiles.map(protectedPath).some(entry => entry.endsWith(`${sep}**`) ? file.startsWith(entry.slice(0, -2)) : file === entry);
}

/** Whether a skill file belongs to the 助理: under one of its roots. */
export function standingSkill(path: string, standing: CodexStanding): boolean {
  const file = real(path);
  return standing.skillRoots.some(root => file.startsWith(`${real(root)}${sep}`));
}

/**
 * The thread's overrides: everything it would load that is not the 助理's own is off, except the MCP servers named in
 * [keep] (Riffet's, which the thread adds itself). Call after {@link useStandingSkillRoots}.
 */
export async function standingThreadConfig(transport: CodexAppServerClient, cwd: string, standing: CodexStanding, keep: readonly string[]): Promise<Record<string, unknown>> {
  const [listed, servers] = await Promise.all([
    transport.request<unknown>('skills/list', { cwds: [cwd], forceReload: true }, 15_000),
    readConfiguredMcpNames(transport, cwd),
  ]);
  // Every skill found, enabled or not: a per-thread list replaces the owner's, so one they switched off would come back.
  const off = asArray<unknown>(asRecord(listed)?.data).flatMap(group => asArray<unknown>(asRecord(group)?.skills))
    .map(skill => str(asRecord(skill)?.path)).filter((path): path is string => Boolean(path) && !standingSkill(path!, standing));
  const own = Object.keys(standing.mcpServers);
  const sameDir = real(standing.memberDir) === real(cwd);
  return {
    // Only suppress `<cwd>/AGENTS.md` when cwd IS the member directory (already passed in developerInstructions);
    // project-scoped members still read the bound code repository's `AGENTS.md` (docs/TEAM.md §3.3).
    ...(sameDir ? { project_doc_max_bytes: 0 } : {}),
    model_auto_compact_token_limit: standing.compactAtTokens,
    default_permissions: STANDING_PROFILE,
    [`permissions.${STANDING_PROFILE}`]: { extends: ':workspace', filesystem: Object.fromEntries(standing.protectedFiles.map(path => [protectedPath(path), 'read'])) },
    'features.plugins': false,
    'features.apps': false,
    'skills.bundled.enabled': false,
    'skills.config': [...new Set(off)].map(path => ({ path, enabled: false })),
    // A dotted key cannot carry a dot inside a server name; the CLI's own names never have one.
    ...Object.fromEntries([...servers].filter(name => !keep.includes(name) && !own.includes(name) && /^[\w-]+$/.test(name)).map(name => [`mcp_servers.${name}.enabled`, false])),
    // The directory's and the packs' own, declared over any of the owner's with the same name.
    ...Object.fromEntries(Object.entries(standing.mcpServers).filter(([name]) => !keep.includes(name)).map(([name, server]) => [`mcp_servers.${name}`, server])),
  };
}

const CONTEXT = /^\s*(?:<riffet-context>[\s\S]*?<\/riffet-context>\s*)+/;
/** Strips legacy `<riffet-context>` blocks from older Codex transcripts so history stays clean. */
export function withoutStandingContext(text: string): string { return CONTEXT.test(text) ? text.replace(CONTEXT, '') : text; }
