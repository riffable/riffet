import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyProcessEnvironment, captureLoginShellPath, captureRequests, currentEnvironmentReport, defaultPath,
  environmentCachePath, isPlausiblePath, mergePath, pathAdditions, pathEntries, readCapture,
  resetEnvironmentForTests, resolveEnvironmentPath, scrubEnvironment, terminalEnvironment,
} from './environment.js';

const START_MARK = '__RIFFET_PATH_BEGIN__';
const END_MARK = '__RIFFET_PATH_END__';

let home: string;
const original = { ...process.env };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'riffet-env-'));
  resetEnvironmentForTests();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
  Object.assign(process.env, original);
  resetEnvironmentForTests();
});

/** A directory that exists, so it counts as evidence of a real PATH. */
function directory(...segments: string[]): string {
  const path = join(home, ...segments);
  mkdirSync(path, { recursive: true });
  return path;
}

/** A stand-in login shell: prints a marker payload and ignores the -i/-l/-c flags. */
function fakeShell(name: string, body: string): string {
  const bin = directory('fakebin');
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('scrubEnvironment', () => {
  it('removes the agent credentials a caller would otherwise leak into every terminal', () => {
    const { environment, dropped } = scrubEnvironment({
      PATH: '/usr/bin:/bin',
      ANTHROPIC_API_KEY: 'sk-ant',
      CLAUDE_CODE_SSE_PORT: '1234',
      CURSOR_API_KEY: 'cursor',
      MIRAGE_TOKEN: 'x',
      SSH_AUTH_SOCK: '/tmp/agent',
      TMUX: '/tmp/tmux,1,0',
      HOME: '/home/u',
    });
    expect(environment).toEqual({ PATH: '/usr/bin:/bin', HOME: '/home/u' });
    expect(dropped).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_SSE_PORT', 'CURSOR_API_KEY', 'MIRAGE_TOKEN', 'SSH_AUTH_SOCK', 'TMUX']);
  });

  it('keeps the server configuration the daemon is supposed to read', () => {
    const { environment } = scrubEnvironment({ DEEPSEEK_API_KEY: 'server', DEEPSEEK_BASE_URL: 'https://x', RIFFET_CLI: 'cursor-agent', LANG: 'en_US.UTF-8' });
    expect(environment.DEEPSEEK_API_KEY).toBe('server');
    expect(environment.DEEPSEEK_BASE_URL).toBe('https://x');
    expect(environment.RIFFET_CLI).toBe('cursor-agent');
  });

  it('does not mistake a name that merely contains a reserved word', () => {
    const { environment } = scrubEnvironment({ MY_CURSOR_NOTES: 'kept', CURSOR_API_KEY: 'dropped' });
    expect(environment.MY_CURSOR_NOTES).toBe('kept');
    expect(environment.CURSOR_API_KEY).toBeUndefined();
  });

  it('honours an explicit keep list and an extra drop list', () => {
    const kept = scrubEnvironment({ CURSOR_CONFIG_DIR: '/tmp/c', SECRET_THING: 'x' }, { keep: ['CURSOR_CONFIG_DIR'] });
    expect(kept.environment.CURSOR_CONFIG_DIR).toBe('/tmp/c');
    const dropped = scrubEnvironment({ MY_TOOL_KEY: 'x', OTHER: 'y' }, { drop: ['MY_TOOL'] });
    expect(dropped.environment.MY_TOOL_KEY).toBeUndefined();
    expect(dropped.environment.OTHER).toBe('y');
  });
});

describe('path helpers', () => {
  it('merges without reordering or duplicating', () => {
    expect(mergePath(['/a:/b', '/b:/c', undefined, ''])).toBe('/a:/b:/c');
  });

  it('splits entries and ignores blanks', () => {
    expect(pathEntries('/a::/b:')).toEqual(['/a', '/b']);
  });

  it('rejects a startup banner that is not a PATH', () => {
    expect(isPlausiblePath('Not privileged to set domain environment.')).toBe(false);
    expect(isPlausiblePath(`${directory('one')}`)).toBe(false);
    expect(isPlausiblePath(`${directory('one')}\n${directory('two')}`)).toBe(false);
    expect(isPlausiblePath(`${directory('one')}${delimiter}${directory('two')}`)).toBe(true);
  });

  it('appends the toolchain directories a bare PATH is missing', () => {
    const additions = pathAdditions({ JAVA_HOME: '/jdk', ANDROID_HOME: '/sdk', PNPM_HOME: '/pnpm' }, home);
    expect(additions).toContain(join('/jdk', 'bin'));
    expect(additions).toContain(join('/sdk', 'platform-tools'));
    expect(additions).toContain(join('/pnpm', 'bin'));
    expect(additions).toContain(join(home, '.local', 'bin'));
  });

  it("keeps the macOS app's bundled node out of the agents' PATH", () => {
    const bundled = '/Applications/Riffet.app/Contents/Resources/server/bin/node';
    expect(pathAdditions({}, home, bundled)).toContain(dirname(bundled));
    const additions = pathAdditions({ RIFFET_BUNDLED_NODE: '1' }, home, bundled);
    expect(additions.some(entry => entry.startsWith('/Applications/Riffet.app'))).toBe(false);
    expect(additions).toContain(join(home, '.local', 'bin'));
  });

  it('offers per-platform defaults that exist on the platforms riffet serves', () => {
    expect(defaultPath({}, home).length).toBeGreaterThan(2);
  });
});

describe('login shell capture', () => {
  it('asks the user shell interactively first, because only then are the rc files read', () => {
    const shell = fakeShell('zsh', ':');
    const requests = captureRequests({ SHELL: shell });
    expect(requests[0]?.args).toEqual(['-ilc', expect.stringContaining(START_MARK)]);
    expect(requests[1]?.args).toEqual(['-lc', expect.stringContaining(START_MARK)]);
  });

  it('uses fish syntax when the user runs fish', () => {
    const shell = fakeShell('fish', ':');
    const requests = captureRequests({ SHELL: shell });
    expect(requests[0]?.args[1]).toContain('string join');
  });

  it('reads the payload and ignores whatever a startup file printed around it', () => {
    const value = `${directory('a')}${delimiter}${directory('b')}`;
    expect(readCapture(`hello\n${START_MARK}${value}${END_MARK}\nbye`)).toBe(value);
    expect(readCapture(`noise only`)).toBeUndefined();
  });

  it('falls back to the login-only attempt when the interactive one dies', () => {
    const value = `${directory('a')}${delimiter}${directory('b')}`;
    const calls: string[][] = [];
    return captureLoginShellPath({
      env: { SHELL: fakeShell('zsh', ':') },
      run: async (_shell, args) => {
        calls.push(args);
        if (args[0] === '-ilc') throw Object.assign(new Error('boom'), { code: 'ENOENT' });
        return `${START_MARK}${value}${END_MARK}`;
      },
    }).then(result => {
      expect(result.path).toBe(value);
      expect(calls.map(args => args[0])).toEqual(['-ilc', '-lc']);
    });
  });

  it('reports why nothing was captured instead of throwing', async () => {
    const result = await captureLoginShellPath({
      env: { SHELL: fakeShell('zsh', ':') },
      run: async () => { throw new Error('nope'); },
    });
    expect(result.path).toBeUndefined();
    expect(result.note).toContain('failed');
  });

  it('refuses a payload that is not a usable PATH', async () => {
    const result = await captureLoginShellPath({
      env: { SHELL: fakeShell('zsh', ':') },
      run: async () => `${START_MARK}Not privileged to set domain environment.${END_MARK}`,
    });
    expect(result.path).toBeUndefined();
  });
});

describe('resolveEnvironmentPath', () => {
  it('prefers an explicit override', async () => {
    const explicit = `${directory('explicit')}${delimiter}${directory('explicit2')}`;
    const resolution = await resolveEnvironmentPath({ explicitPath: explicit, env: { PATH: '/usr/bin:/bin' }, home });
    expect(resolution.source).toBe('explicit');
    expect(pathEntries(resolution.value)).toContain(dirOf(explicit, 0));
  });

  it('takes the login shell PATH when there is no override', async () => {
    const captured = `${directory('captured')}${delimiter}${directory('captured2')}`;
    const resolution = await resolveEnvironmentPath({
      env: { SHELL: fakeShell('zsh', ':'), PATH: '/usr/bin:/bin' },
      home,
      run: async () => `${START_MARK}${captured}${END_MARK}`,
    });
    expect(resolution.source).toBe('login-shell');
    expect(pathEntries(resolution.value)).toContain(dirOf(captured, 0));
  });

  it('uses the cached PATH when no shell can answer, which is how systemd and docker boot', async () => {
    const cached = `${directory('cached')}${delimiter}${directory('cached2')}`;
    mkdirSync(home, { recursive: true });
    writeFileSync(environmentCachePath(home), `${JSON.stringify({ version: 1, path: cached, source: 'login-shell', capturedAt: 'now' })}\n`);
    const resolution = await resolveEnvironmentPath({ env: { PATH: '/usr/bin:/bin' }, stateDir: home, home, run: async () => { throw new Error('no shell'); } });
    expect(resolution.source).toBe('cache');
    expect(pathEntries(resolution.value)).toContain(dirOf(cached, 0));
  });

  it('falls back to the inherited PATH, then to platform defaults', async () => {
    const inherited = `${directory('inherited')}${delimiter}${directory('inherited2')}`;
    const fromInherited = await resolveEnvironmentPath({ env: { PATH: inherited }, home, run: async () => { throw new Error('no shell'); } });
    expect(fromInherited.source).toBe('inherited');
    const fromDefault = await resolveEnvironmentPath({ env: { PATH: '' }, home, run: async () => { throw new Error('no shell'); } });
    expect(fromDefault.source).toBe('default');
    expect(pathEntries(fromDefault.value).length).toBeGreaterThan(2);
  });

  it('always appends the directories riffet itself needs', async () => {
    const resolution = await resolveEnvironmentPath({ explicitPath: `${directory('a')}${delimiter}${directory('b')}`, env: {}, home });
    expect(pathEntries(resolution.value)).toContain(join(home, '.local', 'bin'));
    expect(resolution.added.length).toBeGreaterThan(0);
  });
});

describe('applyProcessEnvironment', () => {
  it('scrubs, resolves and reports in one pass', async () => {
    const nodeBin = directory('.local', 'bin', 'node', 'bin');
    const fakeNode = join(nodeBin, 'node');
    writeFileSync(fakeNode, '');
    const report = await applyProcessEnvironment({
      stateDir: home,
      home,
      executablePath: fakeNode,
      env: { PATH: `${directory('a')}${delimiter}${directory('b')}`, HOME: home, SHELL: '/bin/zsh', ANTHROPIC_API_KEY: 'leak' },
      run: async () => { throw new Error('no shell'); },
    });
    expect(report.dropped).toContain('ANTHROPIC_API_KEY');
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(pathEntries(process.env.PATH)).toContain(nodeBin);
    expect(currentEnvironmentReport()).toBe(report);
  });

  it('is idempotent, so every entry point agrees on one environment', async () => {
    const first = await applyProcessEnvironment({ home, env: { PATH: `${directory('a')}${delimiter}${directory('b')}` }, run: async () => { throw new Error('no shell'); } });
    const second = await applyProcessEnvironment({ home, env: { PATH: '/nowhere' }, run: async () => { throw new Error('no shell'); } });
    expect(second).toBe(first);
  });

  it('states the identity rather than inheriting the caller’s', async () => {
    await applyProcessEnvironment({ home, env: { PATH: `${directory('a')}${delimiter}${directory('b')}`, HOME: home, USER: 'real', SHELL: '/bin/zsh' }, run: async () => { throw new Error('no shell'); } });
    expect(process.env.HOME).toBe(home);
    expect(process.env.LOGNAME).toBe(process.env.USER);
    expect(process.env.TERM).toBeTruthy();
  });

  it('survives a read-only state directory, and says so in the report instead of on stderr', async () => {
    const readOnly = join(home, 'not-a-directory');
    writeFileSync(readOnly, 'this is a file, so the cache cannot be created here');
    const report = await applyProcessEnvironment({
      stateDir: readOnly,
      home,
      explicitPath: `${directory('a')}${delimiter}${directory('b')}`,
      env: {},
      run: async () => { throw new Error('no shell'); },
    });
    expect(report.path.value).toContain(dirOf(`${directory('a')}${delimiter}${directory('b')}`, 0));
    expect(report.path.note).toContain('could not cache');
  });
});

describe('terminalEnvironment', () => {
  it('carries PATH and the toolchain variables into a terminal, and refuses multiline values', () => {
    process.env.JAVA_HOME = '/jdk';
    process.env.BROKEN = 'a\nb';
    const environment = terminalEnvironment({ platform: 'darwin', node: { path: '/n', version: 'v1' }, path: { value: '/usr/bin:/bin', source: 'inherited', added: [] }, dropped: [] });
    expect(environment.PATH).toBe('/usr/bin:/bin');
    expect(environment.JAVA_HOME).toBe('/jdk');
    expect(Object.keys(environment)).not.toContain('BROKEN');
  });
});

/** The first entry of a delimiter-joined pair, so assertions read clearly. */
function dirOf(value: string, index: number): string {
  return value.split(delimiter)[index] as string;
}
