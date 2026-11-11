import { afterEach, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { BuildInfo } from '@contracts';
import { checkForUpdates, fetchRelease } from './update.js';

const roots: string[] = [];
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Update Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Update Test', GIT_COMMITTER_EMAIL: 'test@example.invalid', GIT_TERMINAL_PROMPT: '0' };
function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'riffet-update-'));
  roots.push(root);
  const origin = join(root, 'origin');
  const clone = join(root, 'clone');
  git(root, 'init', '--initial-branch=main', origin);
  await writeFile(join(origin, 'package.json'), JSON.stringify({ name: 'riffet', type: 'module', version: '0.9.0', buildNumber: 1, engines: { node: '>=24' } }));
  git(origin, 'add', '.');
  git(origin, 'commit', '-m', 'first');
  git(origin, 'tag', 'v0.9.0');
  git(root, 'clone', origin, clone);
  const current: BuildInfo = { version: '0.9.0', buildNumber: 1, tag: 'v0.9.0', commit: git(clone, 'rev-parse', 'HEAD'), dirty: false };
  return { root, origin, clone, current };
}

async function publish(origin: string, version: string, annotated = true) {
  await writeFile(join(origin, 'package.json'), JSON.stringify({ name: 'riffet', version, buildNumber: 2, engines: { node: '>=24' }, packageManager: 'pnpm@10.0.0' }));
  git(origin, 'add', '.');
  git(origin, 'commit', '-m', version);
  git(origin, 'tag', ...(annotated ? ['-a', `v${version}`, '-m', version] : [`v${version}`]));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Git release protocol', () => {
  it('checks remote lightweight/annotated releases without changing refs, index or source; fetches only the selected tag', async () => {
    const { origin, clone, current } = await fixture();
    expect((await checkForUpdates({ root: clone, current })).status).toBe('current');
    expect((await checkForUpdates({ root: clone, current: { ...current, commit: 'invalid' } })).status).toBe('development');
    expect((await checkForUpdates({ root: clone, current: { ...current, commit: 'f'.repeat(40), dirty: true } })).status).toBe('development');
    expect((await checkForUpdates({ root: clone, current: { ...current, commit: 'f'.repeat(40) } })).status).toBe('conflict');
    await publish(origin, '0.10.0');
    git(origin, 'tag', 'v01.99.0');
    git(origin, 'tag', 'v99.0.0-preview');
    const refs = git(clone, 'show-ref');
    const index = await readFile(join(clone, '.git/index'));
    const source = await readFile(join(clone, 'package.json'));
    const check = await checkForUpdates({ root: clone, current });
    expect(check.status).toBe('available');
    expect(check.latest).toMatchObject({ tag: 'v0.10.0', version: '0.10.0', commit: git(origin, 'rev-parse', 'HEAD'), objectId: git(origin, 'rev-parse', 'v0.10.0') });
    expect(check.latest!.objectId).not.toBe(check.latest!.commit);
    expect(git(clone, 'show-ref')).toBe(refs);
    expect(await readFile(join(clone, '.git/index'))).toEqual(index);
    expect(await readFile(join(clone, 'package.json'))).toEqual(source);
    expect(await fetchRelease(clone, check.latest!)).toMatchObject({ version: '0.10.0', engines: { node: '>=24' } });
    expect(git(clone, 'tag', '--list')).toBe('v0.10.0\nv0.9.0');
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(current.commit);
    expect(git(clone, 'rev-parse', 'refs/remotes/origin/main')).toBe(current.commit);
    expect(await readFile(join(clone, 'package.json'))).toEqual(source);
  });

  it('rejects a moved remote tag between checking and fetching and never switches the checkout', async () => {
    const { origin, clone, current } = await fixture();
    await publish(origin, '0.10.0', false);
    const check = await checkForUpdates({ root: clone, current });
    await writeFile(join(origin, 'change.txt'), 'changed after publication');
    git(origin, 'add', '.');
    git(origin, 'commit', '-m', 'move tag');
    git(origin, 'tag', '-f', 'v0.10.0');
    await expect(fetchRelease(clone, check.latest!)).rejects.toThrow('changed after checking');
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(current.commit);
    expect(git(clone, 'branch', '--show-current')).toBe('main');
  });

  it('rejects target packages with the wrong version or project identity without changing HEAD', async () => {
    const { origin, clone, current } = await fixture();
    git(origin, 'tag', 'v0.10.0');
    const check = await checkForUpdates({ root: clone, current });
    await expect(fetchRelease(clone, check.latest!)).rejects.toThrow('does not match package.json.version');
    await writeFile(join(origin, 'package.json'), JSON.stringify({ name: 'unrelated-project', version: '0.11.0' }));
    git(origin, 'add', '.');
    git(origin, 'commit', '-m', 'wrong project');
    git(origin, 'tag', 'v0.11.0');
    const wrongProject = await checkForUpdates({ root: clone, current });
    await expect(fetchRelease(clone, wrongProject.latest!)).rejects.toThrow('not a Riffet package');
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(current.commit);
  });

  it('reports immutable tag conflicts, source changes and failed checks without leaking remote details', async () => {
    const { root, origin, clone, current } = await fixture();
    await publish(origin, '0.10.0');
    git(clone, 'tag', 'v0.10.0');
    expect((await checkForUpdates({ root: clone, current })).status).toBe('conflict');
    const remoteTag = { tag: 'v0.10.0', version: '0.10.0', commit: git(origin, 'rev-parse', 'HEAD'), objectId: git(origin, 'rev-parse', 'v0.10.0') };
    const refs = git(clone, 'show-ref');
    await expect(fetchRelease(clone, remoteTag)).rejects.toThrow('conflicts');
    expect(git(clone, 'show-ref')).toBe(refs);
    await writeFile(join(clone, 'local.txt'), 'do not change');
    git(clone, 'remote', 'set-url', 'origin', join(root, 'private-credential-repository'));
    const failed = await checkForUpdates({ root: clone, current });
    expect(failed).toMatchObject({ status: 'unavailable', latest: null, source: { commit: current.commit, dirty: true } });
    expect(JSON.stringify(failed)).not.toContain('private-credential');
    expect(await readFile(join(clone, 'local.txt'), 'utf8')).toBe('do not change');
  });

  it('does not mistake source package changes for a running build identity', async () => {
    const { root, origin, clone, current } = await fixture();
    // Run the real plain-Node builder inside a minimal clean source tree.
    const script = await readFile(resolve('scripts/build-info.mjs'), 'utf8');
    await import('node:fs/promises').then(fs => fs.mkdir(join(clone, 'scripts')));
    await writeFile(join(clone, 'scripts/build-info.mjs'), script);
    await writeFile(join(clone, '.gitignore'), '.riffet/\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-m', 'build tool');
    git(clone, 'tag', '-f', 'v0.9.0');
    const output = join(root, 'snapshot.json');
    execFileSync(process.execPath, [join(clone, 'scripts/build-info.mjs'), '--output', output], { env });
    const snapshot = JSON.parse(await readFile(output, 'utf8'));
    expect(snapshot.build).toMatchObject({ version: '0.9.0', tag: 'v0.9.0', dirty: false, commit: git(clone, 'rev-parse', 'HEAD') });
    const inheritedRepository = {
      ...env,
      GIT_DIR: join(origin, '.git'),
      GIT_WORK_TREE: origin,
      GIT_COMMON_DIR: join(origin, '.git'),
      GIT_INDEX_FILE: join(root, 'wrong-index'),
      GIT_OBJECT_DIRECTORY: join(root, 'missing-objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(root, 'missing-alternate-objects'),
    };
    const fromInheritedRepository = JSON.parse(execFileSync(process.execPath, [join(clone, 'scripts/build-info.mjs'), '--stdout'], { env: inheritedRepository, encoding: 'utf8' }));
    expect(fromInheritedRepository).toEqual(snapshot);
    execFileSync(process.execPath, [join(clone, 'scripts/build-info.mjs'), '--verify', output], { env: inheritedRepository, stdio: 'pipe' });
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(snapshot);
    await writeFile(join(clone, 'package.json'), JSON.stringify({ version: '0.10.0', buildNumber: 2 }));
    expect(() => execFileSync(process.execPath, [join(clone, 'scripts/build-info.mjs'), '--verify', output], { env, stdio: 'pipe' })).toThrow();
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(snapshot);
    // The checker continues to compare the given running identity, independently of checkout metadata.
    await publish(origin, '0.10.0');
    const check = await checkForUpdates({ root: clone, current: { ...current, tag: null } });
    expect(check.status).toBe('conflict'); // The locally re-created v0.9.0 must never be silently trusted.
  });

  it('gives concurrent Web/Server builds independent pinned snapshots despite parent/default snapshot replacement', async () => {
    const { clone } = await fixture();
    await mkdir(join(clone, 'scripts'));
    await writeFile(join(clone, 'scripts/build-info.mjs'), await readFile(resolve('scripts/build-info.mjs')));
    await writeFile(join(clone, '.gitignore'), '.riffet/\nnode_modules/\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-m', 'build coordinator');
    git(clone, 'tag', '-f', 'v0.9.0');
    const script = join(clone, 'scripts/build-info.mjs');
    const baseline = JSON.parse(execFileSync(process.execPath, [script, '--stdout'], { encoding: 'utf8', env }));
    const state = join(clone, '.riffet');
    await mkdir(state);
    const parent = join(state, 'parent.json');
    await writeFile(parent, JSON.stringify({ ...baseline, buildConfiguration: 'A' }));
    // A legacy/default snapshot must have no role in this build invocation.
    await writeFile(join(state, 'build-info.json'), 'overwritten default');
    for (const tool of ['vite', 'tsx']) {
      const toolRoot = join(clone, 'node_modules', tool);
      await mkdir(toolRoot, { recursive: true });
      await writeFile(join(toolRoot, 'package.json'), JSON.stringify({ bin: './cli.mjs' }));
      await writeFile(join(toolRoot, 'cli.mjs'), `
        import { existsSync, readFileSync, writeFileSync } from 'node:fs';
        const id = process.env.TEST_BUILD_ID;
        const tool = ${JSON.stringify(tool)};
        const file = process.env.RIFFET_BUILD_INFO_FILE;
        const observe = suffix => writeFileSync('.riffet/' + tool + '-' + id + suffix + '.json', JSON.stringify({ file, record: JSON.parse(readFileSync(file, 'utf8')) }));
        observe('');
        if (tool === 'vite') {
          writeFileSync('.riffet/ready-' + id, '');
          const deadline = Date.now() + 5000;
          while (!existsSync('.riffet/release')) {
            if (Date.now() > deadline) throw new Error('Build barrier timed out');
            await new Promise(resolve => setTimeout(resolve, 5));
          }
          observe('-after');
        }
      `);
    }
    const run = (id: string, pin: string | undefined) => promisify(execFile)(process.execPath, [script, '--build'], {
      cwd: clone, env: { ...env, TEST_BUILD_ID: id, RIFFET_BUILD_INFO_FILE: pin }, timeout: 10_000,
    }).then(() => undefined, error => error as Error);
    const completions = [run('A', parent)];
    const ready = (id: string) => expect.poll(async () => {
      try { await access(join(state, `ready-${id}`)); return true; } catch { return false; }
    }, { timeout: 6000 }).toBe(true);
    try {
      await ready('A');
      await writeFile(parent, JSON.stringify({ ...baseline, buildConfiguration: 'B' }));
      completions.push(run('B', parent));
      await ready('B');
      await writeFile(parent, 'parent overwritten during both builds');
      await writeFile(join(state, 'release'), '');
      expect(await Promise.all(completions)).toEqual([undefined, undefined]);
      const observations = await Promise.all(['A', 'B'].map(async id => {
        const before = JSON.parse(await readFile(join(state, `vite-${id}.json`), 'utf8'));
        const after = JSON.parse(await readFile(join(state, `vite-${id}-after.json`), 'utf8'));
        const server = JSON.parse(await readFile(join(state, `tsx-${id}.json`), 'utf8'));
        expect(after).toEqual(before);
        expect(server).toEqual(before);
        expect(before.file).not.toBe(parent);
        expect(before.record).toEqual({ ...baseline, buildConfiguration: id });
        return before;
      }));
      expect(observations[0].file).not.toBe(observations[1].file);
      expect(await run('C', undefined)).toBeUndefined();
      expect(JSON.parse(await readFile(join(state, 'tsx-C.json'), 'utf8')).record).toEqual(baseline);
      await writeFile(join(clone, 'node_modules/tsx/cli.mjs'), 'throw new Error("fixture build failed");\n');
      expect(await run('D', undefined)).toBeInstanceOf(Error);
      expect((await readdir(state, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.startsWith('build-'))).toEqual([]);
    } finally {
      await writeFile(join(state, 'release'), '');
      await Promise.all(completions);
    }
  });

  it('verifies and publishes the exact captured Server identity even if its input pin is overwritten during bundling', async () => {
    const { clone } = await fixture();
    await mkdir(join(clone, 'scripts'));
    for (const name of ['build-info.mjs', 'build.ts', 'runtime-package.ts']) {
      await writeFile(join(clone, 'scripts', name), await readFile(resolve('scripts', name)));
    }
    // The server build copies Riffet's own license and notice next to its output.
    for (const name of ['LICENSE', 'NOTICE']) await writeFile(join(clone, name), await readFile(resolve(name)));
    // build.ts writes the installed version of every runtime dependency, so the fixture needs the
    // manifests of the packages dist/ resolves by path (the fake metafile below has no imports).
    const manifest = JSON.parse(await readFile(join(clone, 'package.json'), 'utf8')) as Record<string, unknown>;
    const { dependencies } = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { dependencies: Record<string, string> };
    await writeFile(join(clone, 'package.json'), JSON.stringify({ ...manifest, dependencies }));
    for (const name of ['katex', 'pdfjs-dist', 'heic-decode']) {
      const installed = JSON.parse(await readFile(resolve('node_modules', name, 'package.json'), 'utf8')) as { version: string };
      await mkdir(join(clone, 'node_modules', name), { recursive: true });
      await writeFile(join(clone, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: installed.version }));
    }
    await writeFile(join(clone, '.gitignore'), '.riffet/\nnode_modules/\ndist/\n');
    for (const path of ['apps/server/src/backends/dsh/bridge-runtime', 'apps/server/src/backends/shared', 'apps/server/src/visualization/assets']) {
      await mkdir(join(clone, path), { recursive: true });
    }
    await writeFile(join(clone, 'apps/server/src/backends/dsh/NOTICE'), 'fixture');
    await writeFile(join(clone, 'apps/server/src/backends/shared/hook-cli.mjs'), '// fixture');
    await writeFile(join(clone, 'apps/server/src/backends/shared/hook-target.mjs'), '// fixture');
    await mkdir(join(clone, 'apps/server/src/backends/claude'), { recursive: true });
    await writeFile(join(clone, 'apps/server/src/backends/claude/statusline-cli.mjs'), '// fixture');
    await mkdir(join(clone, 'apps/server/src/riffet-mcp'), { recursive: true });
    await writeFile(join(clone, 'apps/server/src/riffet-mcp/riffet-mcp.mjs'), '// fixture');
    await mkdir(join(clone, 'packages/plugin-api/src/runtime'), { recursive: true });
    await writeFile(join(clone, 'packages/plugin-api/src/runtime/child.mjs'), '// fixture');
    // build.ts imports the preview and diagram asset builders; the fixture only needs them to exist.
    await mkdir(join(clone, 'apps/server/src/previews'), { recursive: true });
    await writeFile(join(clone, 'apps/server/src/previews/browser-assets.ts'), 'export async function buildPreviewAssets() {}\n');
    await writeFile(join(clone, 'apps/server/src/diagram-assets.ts'), 'export async function buildDiagramAssets() {}\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-m', 'server build');
    git(clone, 'tag', '-f', 'v0.9.0');
    const state = join(clone, '.riffet');
    await mkdir(state);
    const parent = join(state, 'parent.json');
    execFileSync(process.execPath, [join(clone, 'scripts/build-info.mjs'), '--output', parent], { env });
    const captured = await readFile(parent, 'utf8');
    const esbuildRoot = join(clone, 'node_modules/esbuild');
    await mkdir(esbuildRoot, { recursive: true });
    await writeFile(join(esbuildRoot, 'package.json'), JSON.stringify({ type: 'module', exports: './index.mjs' }));
    await writeFile(join(esbuildRoot, 'index.mjs'), `
      import { mkdir, writeFile } from 'node:fs/promises';
      export async function build(options) {
        await writeFile('.riffet/embedded.json', options.define.__RIFFET_BUILD_RECORD__);
        await writeFile(process.env.RIFFET_BUILD_INFO_FILE, 'input replaced after capture');
        await mkdir('dist', { recursive: true });
        await writeFile('dist/cli.js', '// fixture');
        return { metafile: { inputs: {}, outputs: {} } };
      }
    `);
    const tsxPackage = JSON.parse(await readFile(resolve('node_modules/tsx/package.json'), 'utf8')) as { bin: string };
    const tsx = resolve('node_modules/tsx', tsxPackage.bin);
    execFileSync(process.execPath, [tsx, join(clone, 'scripts/build.ts')], {
      cwd: clone, env: { ...env, RIFFET_BUILD_INFO_FILE: parent }, stdio: 'pipe', timeout: 10_000,
    });
    expect(await readFile(parent, 'utf8')).toBe('input replaced after capture');
    expect(await readFile(join(clone, 'dist/build-info.json'), 'utf8')).toBe(captured);
    expect(JSON.parse(await readFile(join(state, 'embedded.json'), 'utf8'))).toEqual(JSON.parse(captured));
    expect((await readdir(state)).filter(name => name.startsWith('server-build-'))).toEqual([]);
  });
});
