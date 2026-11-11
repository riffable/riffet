import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalCwd, claudeConfigDir, claudeGlobalConfigPath, claudeUserSettingsPath,
  codexTrustArgs, ensureClaudeWorkspaceTrust,
} from './cli-trust.js';

const roots: string[] = [];
/** A temp root that also contains a real `project` directory, so `realpath` has something to resolve. */
async function workspace(): Promise<{ root: string; cwd: string; key: string }> {
  const root = await mkdtemp(join(tmpdir(), 'riffet-cli-trust-'));
  roots.push(root);
  const cwd = join(root, 'project');
  await mkdir(cwd);
  return { root, cwd, key: await realpath(cwd) };
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }).catch(() => undefined)));
});

describe('Claude Code state paths', () => {
  it('keeps the global config beside CLAUDE_CONFIG_DIR, not inside it', () => {
    // Claude Code derives it as `join(CLAUDE_CONFIG_DIR || homedir(), '.claude.json')`.
    expect(claudeGlobalConfigPath('/custom/claude-home')).toBe('/custom/claude-home/.claude.json');
    expect(claudeGlobalConfigPath(undefined)).toMatch(/\/\.claude\.json$/);
    expect(claudeGlobalConfigPath(undefined)).not.toContain('/.claude/');
    expect(claudeUserSettingsPath('/home/me/.claude')).toBe('/home/me/.claude/settings.json');
    expect(claudeConfigDir(undefined)).toMatch(/\/\.claude$/);
  });
});

describe('ensureClaudeWorkspaceTrust', () => {
  it('records the answer under the physical directory and keeps every other key', async () => {
    const { root, cwd, key } = await workspace();
    const path = join(root, '.claude.json');
    await writeFile(path, JSON.stringify({ firstStartTime: 'yesterday', projects: { '/elsewhere': { history: [1] } } }, null, 2));
    expect(ensureClaudeWorkspaceTrust({ configHome: root, cwd })).toMatchObject({ path, changed: true });
    const written = JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;
    expect(written.firstStartTime).toBe('yesterday');
    expect(written.projects['/elsewhere']).toEqual({ history: [1] });
    // The key is the resolved path the CLI itself compares: /tmp is /private/tmp on macOS.
    expect(written.projects[key]).toMatchObject({ hasTrustDialogAccepted: true });
  });

  it('is a no-op once the answer is recorded, and preserves an existing project record', async () => {
    const { root, cwd, key } = await workspace();
    const path = join(root, '.claude.json');
    await writeFile(path, JSON.stringify({ projects: { [key]: { hasTrustDialogAccepted: true, enabledMcpjsonServers: ['x'] } } }));
    expect(ensureClaudeWorkspaceTrust({ configHome: root, cwd })).toMatchObject({ changed: false });
    const kept = JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;
    expect(kept.projects[key].enabledMcpjsonServers).toEqual(['x']);

    // Accepting trust must never drop the other per-project fields the CLI stored there.
    await writeFile(path, JSON.stringify({ projects: { [key]: { allowedTools: ['Read'] } } }));
    expect(ensureClaudeWorkspaceTrust({ configHome: root, cwd })).toMatchObject({ changed: true });
    const merged = JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;
    expect(merged.projects[key]).toEqual({ allowedTools: ['Read'], hasTrustDialogAccepted: true });
  });

  it('creates a missing config file instead of failing the launch', async () => {
    const { root, cwd, key } = await workspace();
    expect(ensureClaudeWorkspaceTrust({ configHome: root, cwd })).toMatchObject({ changed: true });
    const written = JSON.parse(await readFile(join(root, '.claude.json'), 'utf8')) as Record<string, any>;
    expect(written.projects[key].hasTrustDialogAccepted).toBe(true);
  });

  it('reports an unreadable config rather than replacing it', async () => {
    const { root, cwd } = await workspace();
    const path = join(root, '.claude.json');
    await writeFile(path, '{ this is not json');
    const result = ensureClaudeWorkspaceTrust({ configHome: root, cwd });
    expect(result?.changed).toBe(false);
    expect(result?.error).toMatch(/could not be parsed/);
    expect(await readFile(path, 'utf8')).toBe('{ this is not json');
  });

  it('writes nothing when the reader disabled the workbench trust writes', async () => {
    const { root, cwd } = await workspace();
    vi.stubEnv('RIFFET_CLI_TRUST', '0');
    expect(ensureClaudeWorkspaceTrust({ configHome: root, cwd })).toBeUndefined();
    await expect(readFile(join(root, '.claude.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(codexTrustArgs(cwd)).toEqual([]);
  });
});

describe('codexTrustArgs', () => {
  it('supplies project trust without bypassing hook review', async () => {
    const { cwd, key } = await workspace();
    expect(codexTrustArgs(cwd)).toEqual([
      '-c', `projects.${JSON.stringify(key)}.trust_level="trusted"`,
    ]);
  });

  it('escapes a path the way TOML does', () => {
    expect(codexTrustArgs('/not/here/we"ird\\path')[1]).toBe('projects."/not/here/we\\"ird\\\\path".trust_level="trusted"');
  });
});

describe('canonicalCwd', () => {
  it('falls back to the absolute path when the directory does not exist yet', () => {
    expect(canonicalCwd('/definitely/not/here')).toBe('/definitely/not/here');
  });
});
