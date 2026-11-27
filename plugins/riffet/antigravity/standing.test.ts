import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentStandingLaunch } from '@riffet/plugin-api/experimental/agent';
import {
  agyStandingDir,
  evaluateStandingToolUse,
  isStandingSession,
  prepareStandingGeminiDir,
  standingMemberKey,
  standingProtectsPath,
  type StandingGuardPolicy,
} from './standing.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'riffet-agy-standing-'));
  roots.push(root);
  const stateDir = join(root, 'state');
  const sourceDir = join(root, 'user-gemini');
  const memberDir = join(root, 'members', 'researcher');
  const memoryDir = join(memberDir, 'memory');
  const skillsDir = join(memberDir, 'skills');
  const packDir = join(root, 'packs', 'web-pack');
  const repoDir = join(root, 'repo');
  await mkdir(memoryDir, { recursive: true });
  await mkdir(join(skillsDir, 'briefing'), { recursive: true });
  await mkdir(join(packDir, 'skills', 'fetch-doc'), { recursive: true });
  await mkdir(repoDir, { recursive: true });
  await mkdir(sourceDir, { recursive: true });

  const agentsFile = join(memberDir, 'AGENTS.md');
  const userFile = join(root, 'USER.md');
  const memoryFile = join(memoryDir, 'MEMORY.md');
  const systemPromptFile = join(root, 'system.md');
  const mcpFile = join(memberDir, '.mcp.json');
  await writeFile(agentsFile, 'You are the Researcher member.');
  await writeFile(userFile, 'User prefers concise summaries.');
  await writeFile(memoryFile, 'Remembered facts.');
  await writeFile(systemPromptFile, 'Follow member instructions strictly.');
  await writeFile(
    mcpFile,
    JSON.stringify({
      mcpServers: {
        docs: {
          command: 'node',
          args: ['${RIFFET_TEST_MCP_ARG:-default-arg}'],
        },
      },
    }),
  );
  await writeFile(join(skillsDir, 'briefing', 'SKILL.md'), '---\nname: briefing\ndescription: Write a brief\n---\nBody');
  await writeFile(join(skillsDir, 'briefing', '.env'), 'SECRET=should-not-copy');
  await writeFile(join(packDir, 'skills', 'fetch-doc', 'SKILL.md'), '---\nname: fetch-doc\n---\nPack skill');

  const launch: AgentStandingLaunch = {
    systemPromptFile,
    memoryDir,
    mcpConfigFiles: [mcpFile],
    pluginDirs: [packDir],
    protectedFiles: [agentsFile, userFile, join(memberDir, 'config', '**')],
    compactAtTokens: 100_000,
    instructionFiles: [agentsFile, userFile, memoryFile],
    skillsDir,
  };
  return { root, stateDir, sourceDir, memberDir, repoDir, packDir, agentsFile, userFile, launch };
}

describe('Antigravity standing team member isolation', () => {
  it('identifies standing sessions and derives stable per-member standing directories', () => {
    expect(isStandingSession({ system: 'assistant' })).toBe(true);
    expect(isStandingSession({ agentMemberId: 'member-1' })).toBe(true);
    expect(isStandingSession({}, { agentMemberId: 'member-1' })).toBe(true);
    expect(isStandingSession({}, {})).toBe(false);

    const keyA = standingMemberKey({ memoryDir: '/tmp/members/alice/memory' });
    const keyB = standingMemberKey({ memoryDir: '/tmp/members/bob/memory' });
    expect(keyA).toBe(standingMemberKey({ memoryDir: '/tmp/members/alice/memory' }));
    expect(keyA).not.toBe(keyB);
    expect(agyStandingDir('/tmp/state', { memoryDir: '/tmp/members/alice/memory' })).toBe(join('/tmp/state', 'standing', keyA));
  });

  it('prepares isolated --gemini_dir with member rules, expanded MCP, filtered skills, and extraDirs', async () => {
    const f = await fixture();
    const prepared = prepareStandingGeminiDir({
      stateDir: f.stateDir,
      cwd: f.repoDir,
      launch: f.launch,
      sourceDir: f.sourceDir,
      isBackgroundRun: false,
    });

    expect((await stat(prepared.standingDir)).mode & 0o777).toBe(0o700);
    const rules = await readFile(join(prepared.standingDir, 'config', 'rules', 'riffet-member.md'), 'utf8');
    expect(rules).toContain('You are the Researcher member.');
    expect(rules).toContain('User prefers concise summaries.');
    expect(rules).toContain('Follow member instructions strictly.');

    // When cwd === memberDir, member AGENTS.md is not duplicated into rules.
    const sameCwd = prepareStandingGeminiDir({
      stateDir: f.stateDir,
      cwd: f.memberDir,
      launch: f.launch,
      sourceDir: f.sourceDir,
    });
    const sameCwdRules = await readFile(join(sameCwd.standingDir, 'config', 'rules', 'riffet-member.md'), 'utf8');
    expect(sameCwdRules).not.toContain('You are the Researcher member.');
    expect(sameCwdRules).toContain('User prefers concise summaries.');

    // Member MCP expanded and isolated.
    const mcp = JSON.parse(await readFile(join(prepared.standingDir, 'config', 'mcp_config.json'), 'utf8'));
    expect(mcp).toEqual({
      mcpServers: {
        docs: { command: 'node', args: ['default-arg'] },
      },
    });
    expect(prepared.mcpServerNames).toEqual(['docs']);

    // Skills synced without secret dotfiles.
    const copiedSkill = await readFile(join(prepared.standingDir, 'config', 'skills', 'briefing', 'SKILL.md'), 'utf8');
    expect(copiedSkill).toContain('name: briefing');
    const copiedPackSkill = await readFile(join(prepared.standingDir, 'config', 'skills', 'fetch-doc', 'SKILL.md'), 'utf8');
    expect(copiedPackSkill).toContain('name: fetch-doc');
    await expect(stat(join(prepared.standingDir, 'config', 'skills', 'briefing', '.env'))).rejects.toMatchObject({ code: 'ENOENT' });

    // Project-scoped member mounts both memberDir and pluginDirs; same-dir member only mounts pluginDirs.
    expect(prepared.extraDirs).toEqual([f.memberDir, f.packDir]);
    expect(sameCwd.extraDirs).toEqual([f.packDir]);
  });

  it('enforces protectedFiles and background shell blocks in StandingGuardPolicy', async () => {
    const f = await fixture();
    const policy: StandingGuardPolicy = {
      memberDir: f.memberDir,
      cwd: f.memberDir,
      protectedFiles: f.launch.protectedFiles,
      isBackgroundRun: false,
    };

    expect(standingProtectsPath(f.agentsFile, policy)).toBe(true);
    expect(standingProtectsPath('AGENTS.md', policy)).toBe(true);
    expect(standingProtectsPath(join(f.memberDir, 'config', 'nested', 'x.json'), policy)).toBe(true);
    expect(standingProtectsPath(join(f.memberDir, 'memory', 'MEMORY.md'), policy)).toBe(false);

    expect(evaluateStandingToolUse('write_to_file', { TargetFile: f.agentsFile }, policy)).toMatchObject({ decision: 'deny' });
    expect(evaluateStandingToolUse('Edit', { file_path: f.userFile }, policy)).toMatchObject({ decision: 'deny' });
    expect(evaluateStandingToolUse('write_to_file', { TargetFile: join(f.memberDir, 'memory', 'notes.md') }, policy)).toEqual({
      decision: 'allow',
    });
    expect(evaluateStandingToolUse('run_command', { CommandLine: 'ls' }, policy)).toEqual({ decision: 'allow' });

    const bgPolicy: StandingGuardPolicy = { ...policy, isBackgroundRun: true };
    expect(evaluateStandingToolUse('run_command', { CommandLine: 'rm -rf /' }, bgPolicy)).toMatchObject({ decision: 'deny' });
    expect(evaluateStandingToolUse('Shell', { command: 'whoami' }, bgPolicy)).toMatchObject({ decision: 'deny' });
    expect(evaluateStandingToolUse('Bash', { command: 'echo hi' }, bgPolicy)).toMatchObject({ decision: 'deny' });
    expect(evaluateStandingToolUse('view_file', { AbsolutePath: f.agentsFile }, bgPolicy)).toEqual({ decision: 'allow' });
    expect(evaluateStandingToolUse('mcp__riffet__read_context', { snapshot: 'abc' }, bgPolicy)).toEqual({ decision: 'allow' });
  });
});
