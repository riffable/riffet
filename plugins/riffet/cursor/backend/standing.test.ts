import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentStandingLaunch } from '@riffet/plugin-api/experimental/agent';
import {
  buildStandingSessionContext,
  cursorDataProjectSlug,
  cursorProjectConfigDir,
  cursorStandingDir,
  evaluateStandingToolUse,
  isStandingSession,
  standingProtectsPath,
  syncStandingTransport,
  withoutStandingMemberContext,
  wrapStandingPrompt,
  writeStandingMcpDisabled,
  writeStandingMcpPlugin,
} from './standing.js';
import { userQuery } from '../native/chat-store.js';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

describe('cursor standing isolation', () => {
  it('copies only network transport settings and drops owner approval preferences', () => {
    const owner = makeTemp('riffet-cursor-owner-');
    const standing = makeTemp('riffet-cursor-standing-');
    writeFileSync(join(owner, 'cli-config.json'), JSON.stringify({
      network: { useHttp1ForAgent: true },
      approvalMode: 'unrestricted',
      permissions: { allow: ['Shell(*)'] },
    }));

    syncStandingTransport(owner, standing);

    expect(JSON.parse(readFileSync(join(standing, 'cli-config.json'), 'utf8'))).toEqual({
      network: { useHttp1ForAgent: true },
    });
  });

  it('disables non-assistant user and project MCP servers while keeping assistant servers', () => {
    const home = makeTemp('riffet-cursor-home-');
    const work = join(makeTemp('riffet-cursor-work_dir-'), 'assistant');
    const standing = makeTemp('riffet-cursor-standing-');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    mkdirSync(join(work, '.cursor'), { recursive: true });
    writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({
      mcpServers: { user_only: { command: 'echo' }, shared_name: { command: 'echo' } },
    }));
    writeFileSync(join(work, '.cursor', 'mcp.json'), JSON.stringify({
      mcpServers: { project_extra: { command: 'echo' } },
    }));

    const disabled = writeStandingMcpDisabled(standing, work, new Set(['shared_name']), home);
    expect(disabled).toEqual(['project_extra', 'user_only']);

    const slug = cursorDataProjectSlug(work);
    expect(slug).not.toContain('_');
    const saved = JSON.parse(readFileSync(join(standing, 'projects', slug, 'mcp-disabled.json'), 'utf8')) as string[];
    expect(saved).toEqual(['project_extra', 'user_only']);
  });

  it('packages member .mcp.json files into per-member isolated plugin directories with env expansion', () => {
    const standing = makeTemp('riffet-cursor-standing-');
    const work = makeTemp('riffet-cursor-work-');
    const mcpFileA = join(work, 'a.mcp.json');
    const mcpFileB = join(work, 'b.mcp.json');
    writeFileSync(mcpFileA, JSON.stringify({
      mcpServers: { calendar: { command: 'node', args: ['${RIFFET_TEST_MISSING:-fallback.js}'] } },
    }));
    writeFileSync(mcpFileB, JSON.stringify({
      mcpServers: { finance: { command: 'node', args: ['fin.js'] } },
    }));

    const packagedA = writeStandingMcpPlugin(standing, [mcpFileA], 'member-a');
    const packagedB = writeStandingMcpPlugin(standing, [mcpFileB], 'member-b');
    expect(packagedA.serverNames).toEqual(['calendar']);
    expect(packagedB.serverNames).toEqual(['finance']);
    expect(packagedA.pluginDir).toBeDefined();
    expect(packagedB.pluginDir).toBeDefined();
    expect(packagedA.pluginDir).not.toBe(packagedB.pluginDir);
    const written = JSON.parse(readFileSync(join(packagedA.pluginDir!, '.mcp.json'), 'utf8')) as {
      mcpServers: { calendar: { args: string[] } };
    };
    expect(written.mcpServers.calendar.args).toEqual(['fallback.js']);
  });

  it('builds sessionStart context with system prompt, profile, and memory index while avoiding duplicate cwd AGENTS.md', () => {
    const work = makeTemp('riffet-cursor-work-');
    const sysFile = join(work, 'system-prompt.md');
    mkdirSync(join(work, 'memory'), { recursive: true });
    writeFileSync(sysFile, 'ASSISTANT_SYSTEM_IDENTITY');
    writeFileSync(join(work, 'AGENTS.md'), 'OWNER_RULES');
    writeFileSync(join(work, 'USER.md'), 'OWNER_PROFILE');
    writeFileSync(join(work, 'memory', 'MEMORY.md'), 'MEMORY_INDEX');
    const launch: AgentStandingLaunch = {
      systemPromptFile: sysFile,
      memoryDir: join(work, 'memory'),
      mcpConfigFiles: [],
      pluginDirs: [],
      protectedFiles: [join(work, 'AGENTS.md')],
      compactAtTokens: 200_000,
      instructionFiles: [join(work, 'AGENTS.md'), join(work, 'USER.md'), join(work, 'memory', 'MEMORY.md')],
      skillsDir: join(work, '.claude', 'skills'),
    };

    const ctx = buildStandingSessionContext(work, launch);
    expect(ctx).toContain('ASSISTANT_SYSTEM_IDENTITY');
    expect(ctx).toContain('OWNER_PROFILE');
    expect(ctx).toContain('MEMORY_INDEX');
    expect(ctx).not.toContain('OWNER_RULES');
  });

  it('protects owner files and restricts background dontAsk runs to safe tools and MCP', () => {
    const work = makeTemp('riffet-cursor-work-');
    mkdirSync(join(work, 'packs', 'finance'), { recursive: true });
    mkdirSync(join(work, 'memory'), { recursive: true });
    const launch: AgentStandingLaunch = {
      systemPromptFile: join(work, 'sys.md'),
      memoryDir: join(work, 'memory'),
      mcpConfigFiles: [],
      pluginDirs: [],
      protectedFiles: [join(work, 'AGENTS.md'), join(work, 'packs', '**')],
      compactAtTokens: 200_000,
      allow: ['Read', 'Write(/**)'],
      instructionFiles: [join(work, 'AGENTS.md')],
      skillsDir: join(work, '.claude', 'skills'),
    };

    expect(standingProtectsPath('AGENTS.md', launch, work)).toBe(true);
    expect(standingProtectsPath(join(work, 'packs', 'finance', 'SKILL.md'), launch, work)).toBe(true);
    expect(standingProtectsPath('.cursor/rules/riffet-assistant.mdc', launch, work)).toBe(true);
    expect(standingProtectsPath(join(work, 'memory', 'notes.md'), launch, work)).toBe(false);

    expect(evaluateStandingToolUse('Write', { file_path: 'AGENTS.md' }, launch, work, false).allowed).toBe(false);
    expect(evaluateStandingToolUse('Write', { file_path: 'memory/notes.md' }, launch, work, false).allowed).toBe(true);
    expect(evaluateStandingToolUse('Shell', { command: 'ls' }, launch, work, true).allowed).toBe(false);
    expect(evaluateStandingToolUse('Delete', { file_path: 'memory/notes.md' }, launch, work, true).allowed).toBe(false);
    expect(evaluateStandingToolUse('Read', { file_path: 'memory/notes.md' }, launch, work, true).allowed).toBe(true);
    expect(evaluateStandingToolUse('MCP:run_report', {}, launch, work, true).allowed).toBe(true);
  });

  it('includes member AGENTS.md in sessionStart context for project-scoped members without touching the code repo', () => {
    const repo = makeTemp('riffet-cursor-repo-');
    const member = makeTemp('riffet-cursor-member-');
    const team = makeTemp('riffet-cursor-team-');
    const stateDir = makeTemp('riffet-cursor-state-');
    mkdirSync(join(member, 'memory'), { recursive: true });
    writeFileSync(join(repo, 'AGENTS.md'), 'REPO_CODING_RULES');
    writeFileSync(join(member, 'AGENTS.md'), 'MEMBER_PM_IDENTITY');
    writeFileSync(join(team, 'USER.md'), 'GLOBAL_USER_PROFILE');
    writeFileSync(join(member, 'memory', 'MEMORY.md'), 'MEMBER_MEMORY_INDEX');
    const sysFile = join(team, 'system-prompt-pm.md');
    writeFileSync(sysFile, 'MEMBER_SYSTEM_PROMPT');

    const launch: AgentStandingLaunch = {
      systemPromptFile: sysFile,
      memoryDir: join(member, 'memory'),
      mcpConfigFiles: [],
      pluginDirs: [],
      protectedFiles: [join(member, 'AGENTS.md'), join(team, 'USER.md')],
      compactAtTokens: 200_000,
      instructionFiles: [join(member, 'AGENTS.md'), join(team, 'USER.md'), join(member, 'memory', 'MEMORY.md')],
      skillsDir: join(member, '.claude', 'skills'),
    };

    const ctx = buildStandingSessionContext(repo, launch);
    expect(existsSync(join(repo, '.cursor'))).toBe(false);
    expect(existsSync(join(member, '.cursor'))).toBe(false);
    expect(ctx).toContain('MEMBER_SYSTEM_PROMPT');
    expect(ctx).toContain('MEMBER_PM_IDENTITY');
    expect(ctx).toContain('GLOBAL_USER_PROFILE');
    expect(ctx).toContain('MEMBER_MEMORY_INDEX');
    expect(ctx).not.toContain('REPO_CODING_RULES');

    expect(standingProtectsPath(join(member, 'AGENTS.md'), launch, repo)).toBe(true);
    expect(standingProtectsPath(join(team, 'USER.md'), launch, repo)).toBe(true);
    expect(standingProtectsPath(join(repo, '.cursor', 'rules', 'repo.mdc'), launch, repo)).toBe(false);
    expect(standingProtectsPath(join(repo, 'AGENTS.md'), launch, repo)).toBe(false);

    expect(isStandingSession({ system: undefined }, { agentMemberId: 'pm' })).toBe(true);
    expect(isStandingSession({ system: undefined }, {})).toBe(false);
    expect(cursorProjectConfigDir('/owner/.cursor', stateDir, { system: undefined }, { agentMemberId: 'pm' })).toBe(cursorStandingDir(stateDir));
    expect(cursorProjectConfigDir('/owner/.cursor', stateDir, { system: undefined }, {})).toBe('/owner/.cursor');

    const wrapped = wrapStandingPrompt(repo, launch, '你是谁');
    expect(wrapped).toContain('<riffet-member>');
    expect(wrapped).toContain('MEMBER_PM_IDENTITY');
    expect(wrapped).toContain('你是谁');
    expect(withoutStandingMemberContext(wrapped)).toBe('你是谁');
    expect(userQuery({
      role: 'user',
      content: [{ type: 'text', text: `<timestamp>Thu</timestamp>\n<user_query>\n${wrapped}\n</user_query>` }],
    })).toEqual({ text: '你是谁' });
  });
});
