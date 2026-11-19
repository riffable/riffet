import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BuildInfo } from '@contracts';
import { OFFICIAL_NPM_REGISTRY, candidateNpmRegistries, configuredNpmRegistry, displayRegistry, inspectNpmUpdate, isMissingNpmTargetOutput, normalizeRegistry, npmInstaller } from './npm.js';

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const build = (version: string): BuildInfo => ({
  version, buildNumber: 1, tag: `v${version}`, commit: null, dirty: false,
});

function fakeFetch(versions: Record<string, string | Error>): typeof fetch {
  return (async (input) => {
    const url = String(input);
    const base = url.replace(/\/riffet\/latest$/, '');
    const entry = versions[base];
    if (entry instanceof Error) throw entry;
    if (!entry) return new Response('Not found', { status: 404 });
    return new Response(JSON.stringify({ version: entry }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

describe('npm multi-registry update check', () => {
  it('picks the newest stable version across configured mirror and official registry, and overrides --registry only when the mirror lags', async () => {
    const mirror = 'https://registry.npmmirror.com';

    // Mirror lags on 0.8.0 while official registry already has 0.9.0 -> override to official registry
    const lagging = await inspectNpmUpdate(build('0.8.0'), {
      configuredRegistry: mirror,
      fetch: fakeFetch({ [mirror]: '0.8.0', [OFFICIAL_NPM_REGISTRY]: '0.9.0' }),
    });
    expect(lagging.check).toMatchObject({ status: 'available', latestVersion: '0.9.0' });
    expect(lagging.registry).toBe(OFFICIAL_NPM_REGISTRY);

    // Mirror already synced 0.9.0 -> keep default install with no --registry override
    const synced = await inspectNpmUpdate(build('0.8.0'), {
      configuredRegistry: mirror,
      fetch: fakeFetch({ [mirror]: '0.9.0', [OFFICIAL_NPM_REGISTRY]: '0.9.0' }),
    });
    expect(synced.check).toMatchObject({ status: 'available', latestVersion: '0.9.0' });
    expect(synced.registry).toBeUndefined();

    // Unconfigured registry with RIFFET_NPM_REGISTRIES synced at the same version as official -> no override
    const extraSynced = await inspectNpmUpdate(build('0.8.0'), {
      configuredRegistry: '',
      env: { RIFFET_NPM_REGISTRIES: mirror } as NodeJS.ProcessEnv,
      fetch: fakeFetch({ [mirror]: '0.9.0', [OFFICIAL_NPM_REGISTRY]: '0.9.0' }),
    });
    expect(extraSynced.check).toMatchObject({ status: 'available', latestVersion: '0.9.0' });
    expect(extraSynced.registry).toBeUndefined();
  });

  it('succeeds when either the official registry or the configured mirror is unreachable', async () => {
    const intranet = 'https://npm.internal.example/repository/npm';

    const airgapped = await inspectNpmUpdate(build('0.8.0'), {
      configuredRegistry: intranet,
      fetch: fakeFetch({ [intranet]: '0.9.0', [OFFICIAL_NPM_REGISTRY]: new Error('ETIMEDOUT') }),
    });
    expect(airgapped.check).toMatchObject({ status: 'available', latestVersion: '0.9.0' });
    expect(airgapped.registry).toBeUndefined();

    const mirrorDown = await inspectNpmUpdate(build('0.8.0'), {
      configuredRegistry: intranet,
      fetch: fakeFetch({ [intranet]: new Error('ECONNREFUSED'), [OFFICIAL_NPM_REGISTRY]: '0.9.0' }),
    });
    expect(mirrorDown.check).toMatchObject({ status: 'available', latestVersion: '0.9.0' });
    expect(mirrorDown.registry).toBe(OFFICIAL_NPM_REGISTRY);

    const bothDown = await inspectNpmUpdate(build('0.8.0'), {
      configuredRegistry: intranet,
      fetch: fakeFetch({ [intranet]: new Error('down'), [OFFICIAL_NPM_REGISTRY]: new Error('down') }),
    });
    expect(bothDown.check.status).toBe('unavailable');
  });

  it('reads registry config from env (ignoring empty strings), .npmrc (last wins, inline comments), and bunfig.toml', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'riffet-npmrc-'));
    cleanups.push(dir);
    const npmrc = join(dir, '.npmrc');
    await writeFile(npmrc, [
      'registry=https://old.example.com/',
      'registry = "https://registry.npmmirror.com/" # mirror',
    ].join('\n'));

    expect(await configuredNpmRegistry('npm', {
      env: { npm_config_registry: '', NPM_CONFIG_USERCONFIG: npmrc },
      exec: async () => { throw new Error('skip'); },
    })).toBe('https://registry.npmmirror.com');

    await writeFile(join(dir, 'bunfig.toml'), '[install]\nregistry = "https://bun-mirror.example.com/"\n');
    expect(await configuredNpmRegistry('bun', {
      env: { BUN_INSTALL: dir, HOME: dir },
      exec: async () => { throw new Error('skip'); },
    })).toBe('https://bun-mirror.example.com');

    expect(candidateNpmRegistries('https://registry.npmmirror.com/', {
      RIFFET_NPM_REGISTRIES: 'https://mirror.example.org/, https://registry.npmjs.org/',
    } as NodeJS.ProcessEnv)).toEqual([
      'https://registry.npmmirror.com',
      'https://mirror.example.org',
      OFFICIAL_NPM_REGISTRY,
    ]);
  });

  it('sanitizes registry URLs, adds --registry only when needed, and recognizes ETARGET across package managers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'riffet-npm-root-'));
    cleanups.push(dir);
    const pkgRoot = join(dir, 'lib', 'node_modules', 'riffet');
    await mkdir(pkgRoot, { recursive: true });
    const url = pathToFileURL(`${pkgRoot}/`);

    expect(normalizeRegistry('https://mirror.example.com/?foo=bar')).toBeUndefined();
    expect(displayRegistry('https://user:secret@mirror.example.com/npm/')).toBe('https://mirror.example.com/npm');
    expect(npmInstaller('0.9.0', url).args).toEqual(['install', '-g', 'riffet@0.9.0']);
    expect(npmInstaller('0.9.0', url, 'https://registry.npmjs.org/').args).toEqual([
      'install', '-g', 'riffet@0.9.0', '--registry=https://registry.npmjs.org',
    ]);
    expect(isMissingNpmTargetOutput('npm error code ETARGET\nnpm error notarget No matching version found for riffet@0.9.0.')).toBe(true);
    expect(isMissingNpmTargetOutput('error: No version matching "0.9.0" found for specifier "riffet"')).toBe(true);
    expect(isMissingNpmTargetOutput('error Couldn\'t find any versions for "riffet" that matches "0.9.0"')).toBe(true);
    expect(isMissingNpmTargetOutput('EACCES permission denied')).toBe(false);
  });
});
