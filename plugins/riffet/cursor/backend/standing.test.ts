import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentStandingLaunch } from '@riffet/plugin-api/experimental/agent';
import {
  cursorDataProjectSlug,
  evaluateStandingToolUse,
  standingProtectsPath,
  syncStandingTransport,
  writeStandingAssistantRule,
  writeStandingMcpDisabled,
  writeStandingMcpPlugin,
} from './standing.js';

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

  it('packages assistant .mcp.json files into a plugin directory with env expansion', () => {
    const standing = makeTemp('riffet-cursor-standing-');
    const work = makeTemp('riffet-cursor-work-');
    const mcpFile = join(work, '.mcp.json');
    writeFileSync(mcpFile, JSON.stringify({
      mcpServers: { calendar: { command: 'node', args: ['${RIFFET_TEST_MISSING:-fallback.js}'] } },
    }));

    const packaged = writeStandingMcpPlugin(standing, [mcpFile]);
    expect(packaged.serverNames).toEqual(['calendar']);
    expect(packaged.pluginDir).toBeDefined();
    const written = JSON.parse(readFileSync(join(packaged.pluginDir!, '.mcp.json'), 'utf8')) as {
      mcpServers: { calendar: { args: string[] } };
    };
    expect(written.mcpServers.calendar.args).toEqual(['fallback.js']);
  });

  it('writes always-applied rule with system prompt fallback or omits it when --system-prompt is active', () => {
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

    const ruleFallback = readFileSync(writeStandingAssistantRule(work, launch, false), 'utf8');
    expect(ruleFallback).toContain('alwaysApply: true');
    expect(ruleFallback).toContain('ASSISTANT_SYSTEM_IDENTITY');
    expect(ruleFallback).toContain('OWNER_PROFILE');
    expect(ruleFallback).toContain('MEMORY_INDEX');
    expect(ruleFallback).not.toContain('OWNER_RULES');

    const ruleNative = readFileSync(writeStandingAssistantRule(work, launch, true), 'utf8');
    expect(ruleNative).not.toContain('ASSISTANT_SYSTEM_IDENTITY');
    expect(ruleNative).toContain('OWNER_PROFILE');
    expect(ruleNative).toContain('MEMORY_INDEX');
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
});
