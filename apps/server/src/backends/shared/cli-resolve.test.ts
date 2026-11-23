import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeSearch, isCliMissing, resolveCliExecutable, resolveCommandShell, shellFunctionInvocation } from './cli-resolve.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'riffet-cli-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function executable(...segments: string[]): string {
  const path = join(home, ...segments);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
}

function directory(...segments: string[]): string {
  const path = join(home, ...segments);
  mkdirSync(path, { recursive: true });
  return path;
}

describe('resolveCliExecutable', () => {
  it('takes an absolute configured path as the answer', () => {
    const path = executable('opt', 'dsh');
    const resolution = resolveCliExecutable({ command: path, env: {} });
    expect(resolution).toMatchObject({ executable: path, resolved: true, source: 'configured' });
  });

  it('expands a configured home-relative path', () => {
    const path = executable('.local', 'bin', 'dsh');
    const resolution = resolveCliExecutable({ command: '~/.local/bin/dsh', env: {}, home });
    expect(resolution.executable).toBe(path);
    expect(resolution.resolved).toBe(true);
  });

  it('makes a relative configured path absolute', () => {
    const directory = join(home, 'scripts');
    mkdirSync(directory, { recursive: true });
    const resolution = resolveCliExecutable({ command: './dsh', env: {}, cwd: directory });
    expect(resolution.executable).toBe(join(directory, 'dsh'));
  });

  it('leaves a shell launcher alone: the user’s shell resolves it, not us', () => {
    const resolution = resolveCliExecutable({ command: 'shell:cursor-agent', env: {} });
    expect(resolution).toMatchObject({ executable: 'shell:cursor-agent', resolved: true, source: 'shell-function' });
  });

  it('honours the daemon PATH before anything else', () => {
    const path = executable('first', 'dsh');
    const alsoThere = executable('second', 'dsh');
    const resolution = resolveCliExecutable({ command: 'dsh', env: { PATH: `${join(home, 'first')}${delimiter}${join(home, 'second')}` } });
    expect(resolution.executable).toBe(path);
    expect(resolution.source).toBe('path');
    expect(resolution.executable).not.toBe(alsoThere);
  });

  it('finds a global npm package beside the node that installed it', () => {
    const nodeBin = join(home, '.local', 'bin', 'node', 'bin');
    mkdirSync(nodeBin, { recursive: true });
    const dsh = executable('.local', 'bin', 'node', 'bin', 'dsh');
    const resolution = resolveCliExecutable({
      command: 'dsh',
      env: { PATH: '/usr/bin:/bin' },
      home,
      executablePath: join(nodeBin, 'node'),
    });
    expect(resolution).toMatchObject({ executable: dsh, resolved: true, source: 'node-prefix' });
  });

  it('finds a CLI in a known install directory that PATH never mentions', () => {
    const claude = executable('.local', 'bin', 'claude');
    const resolution = resolveCliExecutable({ command: 'claude', env: { PATH: '/usr/bin:/bin' }, home });
    expect(resolution).toMatchObject({ executable: claude, resolved: true, source: 'install-dir' });
  });

  it('reports what it searched instead of failing silently', () => {
    const searchDirectory = directory('only');
    const input = { command: 'missing-agent', env: { PATH: `${searchDirectory}${delimiter}/usr/bin` }, home };
    const resolution = resolveCliExecutable(input);
    expect(resolution.resolved).toBe(false);
    expect(resolution.executable).toBe('missing-agent');
    expect(resolution.searched.length).toBeGreaterThan(0);
    expect(describeSearch(resolution)).toContain('Searched:');
    expect(isCliMissing(resolution)).toBe(true);
    writeFileSync(join(searchDirectory, input.command), 'not executable', { mode: 0o644 });
    if (process.platform !== 'win32') expect(resolveCliExecutable(input).resolved).toBe(false);
    expect(isCliMissing(resolveCliExecutable(input))).toBe(false);
  });

  it('keeps an unusable configured path visible, so the error names what the user chose', () => {
    const path = join(home, 'nowhere', 'dsh');
    const resolution = resolveCliExecutable({ command: path, env: {} });
    expect(resolution.executable).toBe(path);
    expect(resolution.resolved).toBe(false);
    expect(resolution.source).toBe('configured');
  });
});

describe('shell functions', () => {
  it('runs a shell: launcher in the user’s own shell, not a hardcoded zsh', () => {
    const bash = executable('bin', 'bash');
    expect(resolveCommandShell({ SHELL: bash })).toBe(bash);
    const invocation = shellFunctionInvocation('cursor-agent', ['--version'], { SHELL: bash });
    expect(invocation.command).toBe(bash);
    expect(invocation.args.slice(0, 3)).toEqual(['-lic', 'cursor-agent "$@"', 'riffet']);
    expect(invocation.args.slice(3)).toEqual(['--version']);
  });

  it('falls back to a shell that exists when SHELL is unset, as it is under systemd', () => {
    expect(resolveCommandShell({})).toMatch(/^\/(?:bin|usr\/bin)\//);
  });
});

/**
 * The 2026-10-09 outage, as a test: a service restarted without a login shell has a bare PATH, and
 * this machine keeps node, its global packages and the agent CLIs under a user-local npm prefix.
 * Every backend has to resolve anyway — before the fix, DSH was the one that did not, because only
 * `~/.local/bin` was ever appended.
 */
describe('a bare environment still resolves every backend', () => {
  it('finds dsh, cursor-agent and claude under the node prefix and the install dir', () => {
    const nodeBin = join(home, '.local', 'bin', 'node', 'bin');
    mkdirSync(nodeBin, { recursive: true });
    const dsh = executable('.local', 'bin', 'node', 'bin', 'dsh');
    const cursorAgent = executable('.local', 'bin', 'cursor-agent');
    const claude = executable('.local', 'bin', 'claude');
    const homebrew = directory('homebrew', 'bin');
    const codex = executable('homebrew', 'bin', 'codex');
    const bare = { PATH: '/usr/bin:/bin' };
    const options = { env: bare, home, executablePath: join(nodeBin, 'node'), candidates: [homebrew] };

    expect(resolveCliExecutable({ command: 'dsh', ...options })).toMatchObject({ executable: dsh, resolved: true });
    expect(resolveCliExecutable({ command: 'cursor-agent', ...options })).toMatchObject({ executable: cursorAgent, resolved: true });
    expect(resolveCliExecutable({ command: 'claude', ...options })).toMatchObject({ executable: claude, resolved: true });
    expect(resolveCliExecutable({ command: 'codex', ...options })).toMatchObject({ executable: codex, resolved: true });
  });
});
