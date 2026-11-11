import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BuildInfo } from '@contracts';
import { assertSourceStartAllowed, claimUpdate, runSourceUpdate, type UpdateLifecycle } from './cli-update.js';

const cleanups: Array<() => Promise<void>> = [];
const originalPath = process.env.PATH;
afterEach(async () => {
  process.env.PATH = originalPath;
  delete process.env.RIFFET_UPDATE_PROBE_FAIL;
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function installation() {
  const directory = await mkdtemp(join(tmpdir(), 'riffet-source-update-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const repository = join(directory, 'repository');
  await mkdir(repository);
  const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(repository, 'init', '--initial-branch=main');
  git(repository, 'config', 'user.name', 'Riffet update probe');
  git(repository, 'config', 'user.email', 'update@example.invalid');
  await writeFile(join(repository, '.gitignore'), '.riffet/\ndist/\nnode_modules/\napps/macos/build/\n');
  await writeFile(join(repository, 'package.json'), JSON.stringify({ name: 'riffet', version: '1.0.0', buildNumber: 1, engines: { node: '>=24.0.0' } }));
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', 'first release');
  git(repository, 'tag', 'v1.0.0');
  const first = git(repository, 'rev-parse', 'HEAD');
  await writeFile(join(repository, 'package.json'), JSON.stringify({ name: 'riffet', version: '1.1.0', buildNumber: 2, engines: { node: '>=24.0.0' } }));
  git(repository, 'commit', '-am', 'second release');
  git(repository, 'tag', '-a', 'v1.1.0', '-m', 'published');
  const second = git(repository, 'rev-parse', 'HEAD');
  const root = join(directory, 'installed');
  git(directory, 'clone', repository, root);
  git(root, 'switch', '-c', 'installed', first);
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const pnpm = join(bin, 'pnpm');
  await writeFile(pnpm, `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const action = process.argv[2];
if (action === '--version') { console.log('10.0.0'); process.exit(0); }
fs.appendFileSync('.riffet/commands', action + '\\n');
if (action === 'build') {
  if (process.env.RIFFET_UPDATE_PROBE_FAIL === '1') process.exit(9);
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const commit = cp.execFileSync('git', ['rev-parse','HEAD'], {encoding:'utf8'}).trim();
  fs.mkdirSync('dist', {recursive:true});
  fs.writeFileSync('dist/build-info.json', JSON.stringify({build:{version:pkg.version,buildNumber:pkg.buildNumber,tag:'v'+pkg.version,commit,dirty:false},sourceRoot:process.cwd()}));
}
`);
  await chmod(pnpm, 0o755);
  process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
  const current: BuildInfo = { version: '1.0.0', buildNumber: 1, tag: 'v1.0.0', commit: first, dirty: false };
  const events: string[] = [];
  const lifecycle: UpdateLifecycle = {
    stop: async () => {
      expect(() => assertSourceStartAllowed(root)).toThrow('正在更新');
      events.push(`stop:${git(root, 'rev-parse', 'HEAD')}`);
    },
    restore: async release => {
      expect(() => assertSourceStartAllowed(root)).not.toThrow();
      expect(() => claimUpdate(root)).toThrow('已有更新进程');
      const built = JSON.parse(await readFile(join(root, 'dist/build-info.json'), 'utf8'));
      expect(built.build.commit).toBe(release.commit);
      events.push(`restore:${release.commit}`);
    },
    recoveryCommand: 'riffet start',
  };
  return { root, first, second, current, git: (...args: string[]) => git(root, ...args), events, lifecycle };
}

describe('source installation update effects', () => {
  it('preserves the original branch, stops before switching and restores only the verified target build', async () => {
    const fixture = await installation();
    await runSourceUpdate(fixture);
    expect(fixture.git('rev-parse', 'HEAD')).toBe(fixture.second);
    expect(fixture.git('rev-parse', 'refs/heads/installed')).toBe(fixture.first);
    expect(fixture.git('status', '--porcelain')).toBe('');
    expect(fixture.events).toEqual([`stop:${fixture.first}`, `restore:${fixture.second}`]);
    expect(await readFile(join(fixture.root, '.riffet/commands'), 'utf8')).toBe('install\nversion:check\nbuild\n');
    expect(existsSync(join(fixture.root, '.riffet/update.lock'))).toBe(false);
  });

  it('never changes dirty source, and rejects a concurrent updater before lifecycle effects', async () => {
    const fixture = await installation();
    const release = claimUpdate(fixture.root);
    try {
      expect(() => assertSourceStartAllowed(fixture.root)).toThrow('正在更新');
      await expect(runSourceUpdate(fixture)).rejects.toThrow('已有更新进程');
    }
    finally { release(); }
    await writeFile(join(fixture.root, '.riffet/update.lock'), '2147483647');
    expect(() => assertSourceStartAllowed(fixture.root)).toThrow('正在更新');
    await expect(runSourceUpdate(fixture)).rejects.toThrow('遗留更新锁');
    expect(await readFile(join(fixture.root, '.riffet/update.lock'), 'utf8')).toBe('2147483647');
    await rm(join(fixture.root, '.riffet/update.lock'));
    await writeFile(join(fixture.root, 'local-note.txt'), 'user-owned content');
    await expect(runSourceUpdate(fixture)).rejects.toThrow('干净的发布 tag');
    expect(await readFile(join(fixture.root, 'local-note.txt'), 'utf8')).toBe('user-owned content');
    expect(fixture.git('rev-parse', 'HEAD')).toBe(fixture.first);
    expect(fixture.events).toEqual([]);
  });

  it('refuses a same-clone server even when it belongs to another state directory', async () => {
    const fixture = await installation();
    await mkdir(join(fixture.root, 'dist'));
    const entry = join(fixture.root, 'dist/cli.js');
    await writeFile(entry, 'setInterval(() => {}, 1000);');
    const child = spawn(process.execPath, [entry, 'serve', '--state-dir', join(fixture.root, '.riffet/other-state')], { stdio: 'ignore' });
    await once(child, 'spawn');
    try {
      await expect(runSourceUpdate(fixture)).rejects.toThrow('其它状态目录');
      expect(fixture.git('rev-parse', 'HEAD')).toBe(fixture.first);
      expect(fixture.events).toEqual([]);
    } finally {
      child.kill();
      await once(child, 'exit');
    }
  });

  it.runIf(process.platform === 'darwin')('refuses a running App reached through a clone alias containing spaces', async () => {
    const fixture = await installation();
    const app = join(fixture.root, 'apps/macos/build/Debug/Riffet.app');
    await mkdir(join(app, 'Contents/MacOS'), { recursive: true });
    await mkdir(join(app, 'Contents/Resources'));
    await writeFile(join(app, 'Contents/MacOS/Riffet'), 'setInterval(() => {}, 1000);');
    await writeFile(join(app, 'Contents/Resources/RiffetBuildInfo.json'), JSON.stringify({ build: fixture.current, sourceRoot: fixture.root, buildConfiguration: 'Debug' }));
    const alias = join(fixture.root, '..', 'clone alias with spaces');
    await symlink(fixture.root, alias, 'dir');
    const child = spawn(process.execPath, [join(alias, 'apps/macos/build/Debug/Riffet.app/Contents/MacOS/Riffet')], { stdio: 'ignore' });
    await once(child, 'spawn');
    try {
      await expect(runSourceUpdate({ ...fixture, app: true, configuration: 'Debug' })).rejects.toThrow('退出此 App');
      expect(fixture.git('rev-parse', 'HEAD')).toBe(fixture.first);
      expect(fixture.events).toEqual([]);
    } finally {
      child.kill();
      await once(child, 'exit');
    }
  });

  it('does not start an incomplete build and releases its lock so the same target can be retried', async () => {
    const fixture = await installation();
    process.env.RIFFET_UPDATE_PROBE_FAIL = '1';
    await expect(runSourceUpdate(fixture)).rejects.toThrow('pnpm 失败');
    expect(fixture.events).toEqual([`stop:${fixture.first}`]);
    expect(fixture.git('rev-parse', 'HEAD')).toBe(fixture.second);
    expect(fixture.git('rev-parse', 'refs/heads/installed')).toBe(fixture.first);
    expect(existsSync(join(fixture.root, '.riffet/update.lock'))).toBe(false);
    expect(await readFile(join(fixture.root, '.riffet/update.log'), 'utf8')).toContain('riffet start');
    delete process.env.RIFFET_UPDATE_PROBE_FAIL;
    await runSourceUpdate({ ...fixture, lifecycle: { ...fixture.lifecycle, stop: async () => {} } });
    expect(fixture.events.at(-1)).toBe(`restore:${fixture.second}`);
  });
});
