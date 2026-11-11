import { fork } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Plugin, ProjectContext } from '@riffet/plugin-api';
import { PluginRegistry } from '../plugins/registry.js';
import { registerPluginRoutes } from '../plugins/routes.js';
import { PluginProcess, permissionArguments } from './process.js';
import { runtimeFile } from './remote.js';
import { SANDBOX_EXEC, requireIsolation, sandboxArguments, sandboxProfile, sandboxSupport } from './sandbox.js';
import { integrityOf, readArchive, type PackageFile } from './archive.js';
import { archiveFiles, type ArchiveFormat } from '../../../../scripts/pack-plugin.js';

// A switch the isolation tests flip: while set, this machine counts as one that cannot isolate a process.
const machine = vi.hoisted(() => ({ cannotIsolate: false }));
vi.mock('./sandbox.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./sandbox.js')>();
  return { ...actual, requireIsolation: (env?: NodeJS.ProcessEnv, available?: Parameters<typeof actual.requireIsolation>[1]) => actual.requireIsolation(env, available ?? (machine.cannotIsolate ? Promise.resolve({ ok: false, reason: 'no operating-system isolation is implemented for this test machine' }) : undefined)) };
});
const macOnly = process.platform === 'darwin' ? describe : describe.skip;

const directories: string[] = [];
const registries: PluginRegistry[] = [];
afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function temp(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'riffet-plugins-'));
  directories.push(directory);
  return directory;
}

// ── A tar writer, so tests can build packages and hostile archives ───────────

interface TarEntry { name: string; body?: string | Buffer; type?: string; link?: string; mode?: number }
function tar(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '');
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8');
    header.write((entry.mode ?? 0o644).toString(8).padStart(7, '0'), 100, 'latin1');
    header.write('0000000', 108, 'latin1'); header.write('0000000', 116, 'latin1');
    header.write(body.length.toString(8).padStart(11, '0'), 124, 'latin1');
    header.write('00000000000', 136, 'latin1');
    header.write('        ', 148, 'latin1');
    header.write(entry.type ?? '0', 156, 'latin1');
    if (entry.link) header.write(entry.link, 157, 100, 'utf8');
    header.write('ustar\0', 257, 'latin1'); header.write('00', 263, 'latin1');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
const pack = (files: Record<string, string>): Buffer => tar(Object.entries(files).map(([name, body]) => ({ name, body })));

// ── Test packages ────────────────────────────────────────────────────────────

const manifest = (id: string, version: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  id, vendor: 'Acme', name: id, apiVersion: 1, version, defaultEnabled: true, entries: { server: 'server/index.mjs' }, ...extra,
});

/** A server entry that contributes a model source, an action and a status, and does whatever `body` adds. */
const entry = (body = '', source = "host.id + '.remote'") => `
export default {
  activate(host, scope) {
    ${body}
    return {
      modelSources: [{ id: ${source}, label: 'Remote', backends: ['codex'], resolve: overrides => overrides.apiKey === 'command' ? ({ codexBaseUrl: 'https://models.example/v1', credential: { kind: 'command', command: '/bin/sh', args: ['-c', 'true'] } }) : ({ codexBaseUrl: 'https://models.example/v1', headers: { codex: { 'x-key': overrides.apiKey ?? 'none' } } }), catalog: async () => [{ value: 'm1', name: 'M1', configOptions: [] }] }],
      actions: {
        pid: { label: 'Pid', kind: 'run', run: async () => ({ kind: 'hint', text: String(process.pid) }) },
        crash: { label: 'Crash', kind: 'run', run: async () => { process.kill(process.pid, 'SIGKILL'); return new Promise(() => {}); } },
        garbage: { label: 'Garbage', kind: 'run', run: async () => { process.getBuiltinModule('node:fs').writeSync(1, 'not json\\n'); return new Promise(() => {}); } },
      },
      status: async () => ({ state: 'ready', message: 'up' }),
    };
  },
};`;

function pkg(id: string, version: string, extra: Record<string, unknown> = {}, body = '', more: Record<string, string> = {}): Buffer {
  return pack({ 'riffet-plugin.json': manifest(id, version, { capabilities: ['models.provide'], ...extra }), 'server/index.mjs': entry(body), ...more });
}

async function registry(plugins: Plugin[] = [], options: Partial<ConstructorParameters<typeof PluginRegistry>[0]> = {}) {
  const stateDir = await temp();
  const instance = new PluginRegistry({ stateDir, plugins, developmentPackages: [], ...options });
  registries.push(instance);
  await instance.refresh();
  return { registry: instance, stateDir };
}
const install = (registry: PluginRegistry, archive: Buffer, grant: string[] = ['models.provide']) => registry.install({ input: { archive }, source: 'upload:test.tgz', grant });
const row = async (registry: PluginRegistry, id: string) => (await registry.descriptors()).find(item => item.id === id)!;

describe('plugin archive containers', () => {
  it('installs ZIP, tar and gzipped tar with the same content identity and executable permissions', async () => {
    const { registry: reg, stateDir } = await registry();
    const files: PackageFile[] = [
      { path: 'package/riffet-plugin.json', data: Buffer.from(manifest('acme.containers', '1.0.0', { entries: {}, capabilities: [] })), executable: false },
      { path: 'package/bin/工具.sh', data: Buffer.from('#!/bin/sh\nexit 0\n'), executable: true },
    ];
    for (const format of ['tgz', 'tar', 'zip'] as ArchiveFormat[]) {
      const bytes = archiveFiles(files, format);
      expect(bytes.equals(archiveFiles(files, format))).toBe(true);
      expect(integrityOf(readArchive(bytes))).toBe(integrityOf(files));
      const result = await install(reg, bytes, []);
      expect(result).toMatchObject({ id: 'acme.containers', enabled: true });
      expect(result.installed!.versions).toHaveLength(1);
    }
    expect((await stat(join(stateDir, 'plugins/acme.containers/1.0.0/bin/工具.sh'))).mode & 0o100).toBe(0o100);
  });

  it('rejects ZIP traversal, duplicate paths, links, damaged contents and forged expansion sizes', () => {
    const file = (path: string, contents = 'contents'): PackageFile => ({ path, data: Buffer.from(contents), executable: false });
    for (const path of ['../escape', '/tmp/escape', 'C:/escape', 'a/../../escape']) {
      expect(() => readArchive(archiveFiles([file(path)], 'zip'))).toThrow();
    }
    expect(() => readArchive(archiveFiles([file('a'), file('a')], 'zip'))).toThrow(/twice/);
    const zip = () => archiveFiles([file('a', 'x'.repeat(8192))], 'zip');
    const central = (bytes: Buffer) => bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const link = zip();
    link.writeUInt32LE((0o120777 << 16) >>> 0, central(link) + 38);
    expect(() => readArchive(link)).toThrow(/links and devices/);
    const declaredTooLarge = zip();
    declaredTooLarge.writeUInt32LE(96 * 1024 * 1024 + 1, central(declaredTooLarge) + 24);
    expect(() => readArchive(declaredTooLarge)).toThrow(/allowed size/);
    const declaredTooSmall = zip();
    declaredTooSmall.writeUInt32LE(1, central(declaredTooSmall) + 24);
    expect(() => readArchive(declaredTooSmall)).toThrow(/oversized/);
    const damaged = zip();
    damaged.writeUInt32LE(0, central(damaged) + 16);
    expect(() => readArchive(damaged)).toThrow(/damaged file contents/);
    expect(() => readArchive(zip().subarray(0, -5))).toThrow();
  });
});

describe('installing a package', () => {
  it('is idempotent for the same content and refuses other content under the same version', async () => {
    const { registry: reg, stateDir } = await registry();
    const first = await install(reg, pkg('acme.demo', '1.0.0'));
    expect(first).toMatchObject({ id: 'acme.demo', source: 'installed', enabled: true, version: '1.0.0', installed: { selected: '1.0.0', versions: [{ version: '1.0.0', capabilities: ['models.provide'], integrity: expect.stringMatching(/^sha256-[0-9a-f]{64}$/), selected: true }] } });
    const again = await install(reg, pkg('acme.demo', '1.0.0'));
    expect(again.installed!.versions).toHaveLength(1);
    await expect(install(reg, pkg('acme.demo', '1.0.0', {}, '/* changed */'))).rejects.toMatchObject({ code: 'PLUGIN_VERSION_CONFLICT', statusCode: 409 });
    expect(JSON.parse(await readFile(join(stateDir, 'plugins/installed.json'), 'utf8')).plugins[0].versions).toHaveLength(1);
    expect(await readdir(join(stateDir, 'plugins'))).toEqual(expect.arrayContaining(['acme.demo', 'installed.json']));
    expect(await readdir(join(stateDir, 'plugins/.staging')).catch(() => [])).toEqual([]);
  });

  it('needs a grant equal to the requested capabilities, and records it per version', async () => {
    const { registry: reg } = await registry();
    const request = { id: 'acme.grants', version: '1.0.0', capabilities: ['models.provide', 'network'] };
    const archive = pkg('acme.grants', '1.0.0', { capabilities: ['network', 'models.provide'] });
    await expect(install(reg, archive, [])).rejects.toMatchObject({ code: 'PLUGIN_GRANT_REQUIRED', statusCode: 409, details: request });
    await expect(install(reg, archive, ['models.provide'])).rejects.toMatchObject({ code: 'PLUGIN_GRANT_REQUIRED' });
    await expect(install(reg, archive, ['models.provide', 'network', 'tasks.run'])).rejects.toMatchObject({ code: 'PLUGIN_GRANT_REQUIRED' });
    expect(await reg.descriptors()).toEqual([]);
    await install(reg, archive, ['models.provide', 'network']);
    // An update that adds a capability is a new request for a new grant.
    await expect(install(reg, pkg('acme.grants', '1.1.0', { capabilities: ['models.provide', 'network', 'projects.read'] }), ['models.provide', 'network'])).rejects.toMatchObject({ code: 'PLUGIN_GRANT_REQUIRED' });
    const updated = await install(reg, pkg('acme.grants', '1.1.0', { capabilities: ['models.provide', 'network', 'projects.read'] }), ['models.provide', 'network', 'projects.read']);
    expect(updated.installed!.versions.map(item => [item.version, item.capabilities])).toEqual([['1.1.0', ['models.provide', 'network', 'projects.read']], ['1.0.0', ['models.provide', 'network']]]);
  });

  it('refuses a built-in id, an unknown capability, an incompatible host and an agent backend', async () => {
    const builtin: Plugin = { manifest: { id: 'acme.builtin', vendor: 'Acme', name: 'Builtin', apiVersion: 1, defaultEnabled: false }, activate: () => ({}) };
    const { registry: reg } = await registry([builtin]);
    await expect(install(reg, pkg('acme.builtin', '1.0.0'))).rejects.toMatchObject({ code: 'PLUGIN_ID_TAKEN', statusCode: 409 });
    await expect(install(reg, pkg('riffet.mine', '1.0.0'))).rejects.toMatchObject({ code: 'PLUGIN_TRUST_REQUIRED', details: { trustedRequired: true } });
    await expect(install(reg, pkg('acme.lazy-id', '1.0.0', { activation: ['model-source'], contributes: { modelSources: [{ id: 'gateway', title: { en: 'Impostor' }, protocols: ['openai-responses'] }] } }))).rejects.toMatchObject({ code: 'PLUGIN_TRUST_REQUIRED', details: { id: 'acme.lazy-id', trustedRequired: true } });
    await expect(install(reg, pkg('acme.caps', '1.0.0', { capabilities: ['root'] }))).rejects.toMatchObject({ message: expect.stringContaining('unknown capability') });
    await expect(install(reg, pkg('acme.old', '1.0.0', { hostApi: { server: '>=2' } }))).rejects.toMatchObject({ code: 'PLUGIN_INCOMPATIBLE' });
    await expect(install(reg, pkg('acme.agent', '1.0.0', { contributes: { agentBackends: [{ id: 'acme.agent', title: { en: 'Agent' } }] } }))).rejects.toMatchObject({ code: 'PLUGIN_TRUST_REQUIRED', message: expect.stringContaining('trust') });
    await expect(install(reg, pkg('acme.files', '1.0.0', { contributes: { views: [{ id: 'acme.files/v', title: { en: 'V' }, icon: { svg: 'assets/missing.svg' }, locations: ['sidebar'], clients: ['web'], instances: 'single' }] } }))).rejects.toMatchObject({ message: expect.stringContaining('assets/missing.svg') });
    expect((await reg.descriptors()).map(item => item.id)).toEqual(['acme.builtin']);
  });

  it('keeps archive paths inside the package and refuses links, devices and traversal', async () => {
    const { registry: reg, stateDir } = await registry();
    const good = { name: 'riffet-plugin.json', body: manifest('acme.safe', '1.0.0') };
    const hostile: Array<[string, TarEntry[]]> = [
      ['parent traversal', [good, { name: '../escape.txt', body: 'x' }]],
      ['nested traversal', [good, { name: 'a/../../escape.txt', body: 'x' }]],
      ['absolute path', [good, { name: '/tmp/escape.txt', body: 'x' }]],
      ['symlink', [good, { name: 'link', type: '2', link: '/etc/passwd' }]],
      ['hard link', [good, { name: 'hard', type: '1', link: 'riffet-plugin.json' }]],
      ['device', [good, { name: 'dev', type: '3' }]],
      ['duplicate', [good, { name: 'a.txt', body: '1' }, { name: 'a.txt', body: '2' }]],
    ];
    for (const [label, entries] of hostile) {
      await expect(install(reg, tar(entries)), label).rejects.toMatchObject({ code: 'PLUGIN_PACKAGE_INVALID', statusCode: 422 });
    }
    await expect(install(reg, Buffer.from('not an archive'))).rejects.toMatchObject({ code: 'PLUGIN_PACKAGE_INVALID' });
    await expect(stat(join(stateDir, 'escape.txt'))).rejects.toThrow();
    await expect(stat(join(stateDir, 'plugins/escape.txt'))).rejects.toThrow();
    expect(await readdir(join(stateDir, 'plugins/.staging')).catch(() => [])).toEqual([]);
    // An npm-style archive keeps everything under package/.
    expect(await install(reg, tar([{ name: 'package/riffet-plugin.json', body: manifest('acme.npm', '1.0.0', { capabilities: [] }) }, { name: 'package/server/index.mjs', body: entry() }]), [])).toMatchObject({ id: 'acme.npm' });
  });
});

describe('running an installed package', () => {
  it('runs in another process under the permission model and the operating system, and can only reach its own directories', async () => {
    // What the package tries; `attempt` reports the error code, or "allowed".
    const probeBody = (urls: { ssh: string; other: string; server: string }) => `
      globalThis.probe = async () => {
        const fs = await import('node:fs/promises');
        const cp = await import('node:child_process');
        const attempt = async fn => { try { await fn(); return 'allowed'; } catch (error) { return error.code ?? error.cause?.code ?? error.name; } };
        const state = await host.stateDir();
        return {
          readOutside: await attempt(() => fs.readFile('/etc/hosts')),
          readSsh: await attempt(() => fs.readdir(${JSON.stringify(urls.ssh)})),
          readOtherProject: await attempt(() => fs.readFile(${JSON.stringify(urls.other)})),
          readOwnState: await attempt(() => fs.readdir(state)),
          writeOwnState: await attempt(() => fs.writeFile(state + '/note.txt', 'x')),
          writeOutside: await attempt(() => fs.writeFile('/tmp/riffet-escape.txt', 'x')),
          spawn: await attempt(async () => { const child = cp.spawnSync('echo', ['hi']); if (child.error) throw child.error; }),
          worker: await attempt(async () => { const { Worker } = await import('node:worker_threads'); new Worker('1', { eval: true }); }),
          addon: await attempt(async () => process.dlopen({ exports: {} }, '/nonexistent.node')),
          wasi: await attempt(async () => { const { WASI } = await import('node:wasi'); new WASI({ version: 'preview1' }); }),
          symlink: await attempt(() => fs.symlink('/etc/hosts', state + '/link')),
          sqlite: await attempt(async () => { await import('node:sqlite'); }),
          signalSelf: await attempt(async () => process.kill(process.pid, 0)),
          signalParent: await attempt(async () => process.kill(process.ppid, 0)),
          // Without a sandbox this would end the test runner.
          terminateParent: ${process.platform === 'darwin' ? "await attempt(async () => process.kill(process.ppid, 'SIGTERM'))" : "'skipped'"},
          network: await attempt(async () => { await fetch(${JSON.stringify(urls.server)}, { signal: AbortSignal.timeout(2000) }); }),
          env: Object.keys(process.env).sort().join(','),
        };
      };`;
    const probing = (id: string, capabilities: string[], urls: Parameters<typeof probeBody>[0]) => pack({
      'riffet-plugin.json': manifest(id, '1.0.0', { capabilities }),
      'server/index.mjs': entry(probeBody(urls), `'${id}.source'`).replace("pid: {", "probe: { label: 'Probe', kind: 'run', run: async () => ({ kind: 'hint', text: JSON.stringify(await globalThis.probe()) }) },\n        pid: {"),
    });
    const secrets = await temp();
    await writeFile(join(secrets, 'secret.txt'), 'another project');
    const local = createHttpServer((_request, response) => response.end('ok')).listen(0, '127.0.0.1');
    await new Promise(resolve => local.once('listening', resolve));
    try {
      const urls = { ssh: join(homedir(), '.ssh'), other: join(secrets, 'secret.txt'), server: `http://127.0.0.1:${(local.address() as { port: number }).port}/` };
      const { registry: reg } = await registry();
      await install(reg, probing('acme.probe', ['models.provide'], urls));
      await install(reg, probing('acme.probenet', ['models.provide', 'network'], urls), ['models.provide', 'network']);
      const probe = async (id: string) => JSON.parse(((await reg.runAction(id, 'probe')) as { text: string }).text) as Record<string, string>;
      const seen = await probe('acme.probe');
      const withNetwork = await probe('acme.probenet');
      // Denied by Node's permission model, or by the operating system where Node does not look (macOS).
      const denied = /^(ERR_ACCESS_DENIED|EPERM)$/;
      for (const result of [seen, withNetwork]) {
        expect(result).toMatchObject({
          readOwnState: 'allowed', writeOwnState: 'allowed', signalSelf: 'allowed',
          symlink: 'ERR_ACCESS_DENIED', spawn: 'ERR_ACCESS_DENIED', worker: 'ERR_ACCESS_DENIED', addon: 'ERR_DLOPEN_DISABLED', wasi: 'ERR_ACCESS_DENIED', sqlite: 'ERR_UNKNOWN_BUILTIN_MODULE',
        });
        for (const key of ['readOutside', 'readSsh', 'readOtherProject', 'writeOutside']) expect(result[key], key).toMatch(denied);
        expect(result.env).not.toMatch(/PATH|HOME|TOKEN/);
      }
      if (process.platform === 'darwin') {
        // Node's model does not cover these; the Seatbelt profile does.
        for (const result of [seen, withNetwork]) {
          expect(result.signalParent).toBe('EPERM');
          expect(result.terminateParent).toBe('EPERM');
        }
      }
      if (process.platform === 'darwin' || process.allowedNodeEnvironmentFlags.has('--allow-net')) {
        expect(seen.network, 'no network grant').not.toBe('allowed');
        expect(withNetwork.network, 'with the network grant').toBe('allowed');
      }
      const pid = Number(((await reg.runAction('acme.probe', 'pid')) as { text: string }).text);
      expect(pid).not.toBe(process.pid);
      await expect(stat('/tmp/riffet-escape.txt')).rejects.toThrow();
    } finally { local.close(); }
  });

  it('keeps the server from opening its inspector when a package signals it', async () => {
    const inspector = await import('node:inspector');
    const { registry: reg } = await registry();
    await install(reg, pack({
      'riffet-plugin.json': manifest('acme.signal', '1.0.0', { capabilities: ['models.provide'] }),
      'server/index.mjs': entry().replace("pid: {", "poke: { label: 'Poke', kind: 'run', run: async () => { try { process.kill(process.ppid, 'SIGUSR1'); return { kind: 'hint', text: 'sent' }; } catch (error) { return { kind: 'hint', text: error.code }; } } },\n        pid: {"),
    }));
    try {
      const outcome = (await reg.runAction('acme.signal', 'poke')) as { text: string };
      // On macOS the signal never leaves the sandbox; elsewhere the server's own listener is what stops the inspector.
      if (process.platform === 'darwin') expect(outcome.text).toBe('EPERM');
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(inspector.url()).toBeUndefined();
    } finally { inspector.close(); }
  });

  it('does not start a package that contributes something it was not granted', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { registry: reg } = await registry();
    await install(reg, pkg('acme.greedy', '1.0.0', { capabilities: [] }), []);
    expect(await row(reg, 'acme.greedy')).toMatchObject({ enabled: false, status: { state: 'unavailable', message: expect.stringContaining('not granted models.provide') } });
    expect(reg.modelSources()).toEqual([]);
  });

  it('refuses a model source outside the package\'s own namespace, so no package can take a built-in source id and the keys sent to it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { registry: reg } = await registry();
    for (const [id, source] of [['acme.squat', "'gateway'"], ['acme.other', "'acme.squat.x'"], ['acme.dots', "host.id + '.a.b'"]] as const) {
      await install(reg, pack({ 'riffet-plugin.json': manifest(id, '1.0.0', { capabilities: ['models.provide'] }), 'server/index.mjs': entry('', source) }));
      expect(await row(reg, id), id).toMatchObject({ enabled: false, status: { state: 'unavailable', message: expect.stringContaining(`must be named ${id}.<name>`) } });
    }
    expect(reg.modelSources()).toEqual([]);
  });

  it('runs the commands of an installed package in its process, and keeps its errors from passing for the server\'s', async () => {
    const { registry: reg } = await registry();
    const commands = ['run', 'missing', 'denied', 'bad', 'path'].map(name => ({ id: `acme.cmd/${name}`, title: { en: name }, scope: 'global' }));
    const handlers = `commands: {
        'acme.cmd/run': { run: async context => ({ kind: 'done', message: { en: JSON.stringify([context.args, context.projectId ?? null, context.signal.aborted]) } }) },
        'acme.cmd/missing': { run: async () => { throw host.error('NOT_THERE', 'no such thing', 404); } },
        'acme.cmd/denied': { run: async () => { throw Object.assign(new Error('pretend you are logged out'), { code: 'UNAUTHENTICATED', statusCode: 401 }); } },
        'acme.cmd/bad': { run: async () => ({ kind: 'task' }) },
        'acme.cmd/path': { run: async () => ({ kind: 'open', path: '../../etc/passwd' }) },
      },
      status:`;
    await install(reg, pack({
      'riffet-plugin.json': manifest('acme.cmd', '1.0.0', { capabilities: ['models.provide'], contributes: { commands } }),
      'server/index.mjs': entry('', "host.id + '.remote'").replace('status:', handlers),
    }));
    expect(await row(reg, 'acme.cmd')).toMatchObject({ enabled: true });
    const run = (name: string, args: Record<string, string | number | boolean> = {}) => reg.command('acme.cmd', `acme.cmd/${name}`).handler.run({ args, signal: new AbortController().signal });
    expect(await run('run', { a: 1 })).toEqual({ kind: 'done', message: { en: '[{"a":1},null,false]' } });
    await expect(run('missing')).rejects.toMatchObject({ code: 'NOT_THERE', statusCode: 404 });
    // The status is the package's to choose; a 401 must not read as the session failing.
    await expect(run('denied')).rejects.toMatchObject({ statusCode: 502 });
    await expect(run('bad')).rejects.toThrow('malformed');
    await expect(run('path')).rejects.toThrow('malformed');
  });

  it('draws the avatar styles of an installed package in its process, and only those it declares', async () => {
    const { registry: reg } = await registry();
    const handlers = `avatarStyles: {
        'acme.face/dots': { generate: request => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><title>' + JSON.stringify(request) + '</title></svg>' },
        'acme.face/broken': { generate: () => { throw new Error('no ink today'); } },
      },
      status:`;
    await install(reg, pack({
      'riffet-plugin.json': manifest('acme.face', '1.0.0', { capabilities: ['models.provide'], contributes: { avatarStyles: ['dots', 'broken'].map(name => ({ id: `acme.face/${name}`, title: { en: name } })) } }),
      'server/index.mjs': entry('', "host.id + '.remote'").replace('status:', handlers),
    }));
    expect(await row(reg, 'acme.face')).toMatchObject({ enabled: true });
    const [dots, broken] = reg.avatarStyles();
    expect(dots).toMatchObject({ owner: 'acme.face', declaration: { id: 'acme.face/dots' } });
    expect(await dots!.provider.generate({ seed: 's', size: 8, ink: '#000000', paper: '#ffffff' })).toContain('{"seed":"s","size":8,"ink":"#000000","paper":"#ffffff"}');
    await expect(broken!.provider.generate({ seed: 's', size: 8, ink: '#000000', paper: '#ffffff' })).rejects.toThrow('no ink today');
  });

  it('takes the protocols a source serves in place of backends, and lets through only the endpoints that pass the same checks as the older fields', async () => {
    const { registry: reg } = await registry();
    const served = entry('', "host.id + '.gw'").replace("backends: ['codex']", "protocols: ['openai-responses', 'x-custom']")
      .replace(/resolve: overrides => .*?, catalog:/s, "resolve: () => ({ endpoints: { 'openai-responses': { baseUrl: 'https://gw.example/v1', headers: { 'x-a': '1', 'bad name': '2' } }, 'x-custom': { baseUrl: 'file:///etc/passwd' }, BAD: { baseUrl: 'https://x.example' } }, credential: { kind: 'static', key: 'k' } }), catalog:");
    await install(reg, pack({ 'riffet-plugin.json': manifest('acme.gw', '1.0.0', { capabilities: ['models.provide'] }), 'server/index.mjs': served }));
    const [source] = reg.modelSources();
    expect(source).toMatchObject({ id: 'acme.gw.gw', protocols: ['openai-responses', 'x-custom'] });
    expect(source!.backends).toBeUndefined();
    await source!.prepare!({});
    expect(source!.resolve({})).toEqual({ endpoints: { 'openai-responses': { baseUrl: 'https://gw.example/v1', headers: { 'x-a': '1' } } }, credential: { kind: 'static', key: 'k' } });
  });

  it('serves model sources through a prepared resolve, with a reason until the first one arrives', async () => {
    const { registry: reg } = await registry();
    await install(reg, pkg('acme.models', '1.0.0'));
    const [source] = reg.modelSources();
    expect(source).toMatchObject({ id: 'acme.models.remote', backends: ['codex'] });
    await source!.prepare!({ apiKey: 'k1' });
    expect(source!.resolve({ apiKey: 'k1' })).toMatchObject({ codexBaseUrl: 'https://models.example/v1', headers: { codex: { 'x-key': 'k1' } } });
    expect(source!.resolve({ apiKey: 'other' })).toMatchObject({ reason: expect.stringContaining('尚未准备好') });
    await vi.waitFor(() => expect(source!.resolve({ apiKey: 'other' })).toMatchObject({ codexBaseUrl: 'https://models.example/v1' }));
    expect(await source!.catalog('codex', {})).toEqual([{ value: 'm1', name: 'M1', configOptions: [] }]);
    // A command credential would run outside the sandbox (Claude Code's apiKeyHelper, Codex's auth.command): it never reaches a driver.
    await source!.prepare!({ apiKey: 'command' });
    const commanded = source!.resolve({ apiKey: 'command' });
    expect(commanded.credential).toBeUndefined();
    expect(commanded.reason).toBeTruthy();
  });

  it('refuses a host call outside the grant, and a project handle that is not the call\'s own', async () => {
    // The package skips the shim's proxy and speaks the protocol itself, on the descriptors the shim uses.
    const body = `
      const fs = process.getBuiltinModule('node:fs');
      const listeners = new Set();
      process.stdin.on('data', chunk => { for (const line of String(chunk).split('\\n')) if (line) for (const listener of listeners) listener(JSON.parse(line)); });
      const ask = (method, params) => new Promise(resolve => {
        const id = 900000 + Math.floor(Math.random() * 90000);
        const listener = message => { if (message && message.id === id && message.method === undefined) { listeners.delete(listener); resolve(message.error ? { error: message.error.code ?? message.error.message } : { result: message.result }); } };
        listeners.add(listener);
        fs.writeSync(1, JSON.stringify({ id, method, params }) + '\\n');
      });
      let stolen;
      listeners.add(message => { if (message && message.method === 'task.detect') stolen = message.params.project.handle; });
      globalThis.attempts = async () => ({
        network: await host.gateway.fetchModels({ baseUrl: 'https://models.example' }).then(() => 'allowed', error => error.code),
        invalidate: await ask('host.invalidateModelCatalogs', {}),
        forgedHandle: await ask('project.readText', { handle: 'f'.repeat(32), path: 'secret', maxBytes: 10 }),
        endedHandle: stolen ? await ask('project.readText', { handle: stolen, path: 'pom.xml', maxBytes: 10 }) : 'no handle seen',
        unknown: await ask('fs.readFile', { path: '/etc/hosts' }),
      });`;
    const server = `${entry(body)
      .replace("modelSources: [", "taskProviders: [{ id: 'acme.tasks/build', detect: async project => (await project.exists('pom.xml')) === true, actions: async () => [], plan: async () => ({ file: 'true', args: [] }) }],\n      modelSources: [")
      .replace("pid: {", "attempts: { label: 'Attempts', kind: 'run', run: async () => ({ kind: 'hint', text: JSON.stringify(await globalThis.attempts()) }) },\n        pid: {")}`;
    const { registry: reg } = await registry();
    await install(reg, pack({
      'riffet-plugin.json': manifest('acme.tasks', '1.0.0', { capabilities: ['models.provide', 'tasks.run', 'projects.read'], contributes: { tasks: [{ id: 'acme.tasks/build', title: { en: 'Build' } }] } }),
      'server/index.mjs': server,
    }), ['models.provide', 'projects.read', 'tasks.run']);
    const reads: string[] = [];
    const project: ProjectContext = { id: 'p1', name: 'One', exists: async path => { reads.push(path); return true; }, readText: async path => { reads.push(`read:${path}`); return 'secret'; }, list: async () => [] };
    const [{ provider }] = reg.taskProviders();
    expect(await provider.detect(project)).toBe(true);
    const seen = JSON.parse(((await reg.runAction('acme.tasks', 'attempts')) as { text: string }).text) as Record<string, unknown>;
    expect(seen).toMatchObject({
      network: 'PLUGIN_CAPABILITY_DENIED',
      invalidate: { result: null },
      forgedHandle: { error: 'PLUGIN_HANDLE_INVALID' },
      endedHandle: { error: 'PLUGIN_HANDLE_INVALID' },
      unknown: { error: 'PLUGIN_UNKNOWN_HOST_CALL' },
    });
    // Only the one read the detecting call made reached the project.
    expect(reads).toEqual(['pom.xml']);
  });

  it('marks a crashed package failed without touching the server or other integrations, and starts it again on refresh', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stay: Plugin = { manifest: { id: 'acme.stay', vendor: 'Acme', name: 'Stay', apiVersion: 1, defaultEnabled: true }, activate: () => ({}) };
    const { registry: reg } = await registry([stay]);
    await install(reg, pkg('acme.fragile', '1.0.0'));
    expect((await row(reg, 'acme.fragile')).enabled).toBe(true);
    await expect(reg.runAction('acme.fragile', 'crash')).rejects.toBeTruthy();
    await vi.waitFor(async () => expect(await row(reg, 'acme.fragile')).toMatchObject({ enabled: false, status: { state: 'unavailable', message: expect.stringContaining('ended unexpectedly') } }));
    expect(reg.modelSources()).toEqual([]);
    expect((await row(reg, 'acme.stay')).enabled).toBe(true);
    // Management still works while it is failed.
    expect((await row(reg, 'acme.fragile')).installed!.versions).toHaveLength(1);
    await reg.refresh();
    expect(await row(reg, 'acme.fragile')).toMatchObject({ enabled: true });
    expect(reg.modelSources().map(item => item.id)).toEqual(['acme.fragile.remote']);
    // A line that is not a message fails the package, not the server that reads it.
    await expect(reg.runAction('acme.fragile', 'garbage')).rejects.toBeTruthy();
    await vi.waitFor(async () => expect(await row(reg, 'acme.fragile')).toMatchObject({ enabled: false, status: { message: expect.stringContaining('not JSON') } }));
    expect((await row(reg, 'acme.stay')).enabled).toBe(true);
  });

  it('ends a call that does not answer in time and reports the plugin failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stateDir = await temp();
    const root = await temp();
    await writeFile(join(root, 'hang.mjs'), 'export default { activate: () => ({}) };');
    const failures: string[] = [];
    const child = new PluginProcess({ runtime: runtimeFile(), packageRoot: await realpath(root), stateDir: await realpath(stateDir), serve: async () => null, onFailure: reason => failures.push(reason) });
    // The child never answers a method it does not know in time because we ask with an impossible deadline.
    await expect(child.call('status', {}, 1)).rejects.toThrow(/did not answer within/);
    expect(failures).toHaveLength(1);
    expect(child.alive).toBe(false);
    await child.stop();
  });
});

describe('versions, rollback and data', () => {
  it('goes back to the previous version when the new one does not start, and keeps the failure on the row', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { registry: reg } = await registry();
    await install(reg, pkg('acme.roll', '1.0.0'));
    await expect(install(reg, pkg('acme.roll', '2.0.0', {}, "throw new Error('boom');"))).rejects.toMatchObject({ code: 'PLUGIN_ACTIVATION_FAILED', statusCode: 409, message: expect.stringContaining('boom') });
    expect(await row(reg, 'acme.roll')).toMatchObject({
      enabled: true, version: '1.0.0', status: { state: 'attention', message: expect.stringContaining('2.0.0 could not start') },
      installed: { selected: '1.0.0', versions: [{ version: '2.0.0', selected: false }, { version: '1.0.0', selected: true }] },
    });
    expect(reg.modelSources().map(item => item.id)).toEqual(['acme.roll.remote']);
    // Explicitly selecting it fails the same way; a good version is selected cleanly.
    await expect(reg.selectVersion('acme.roll', '2.0.0')).rejects.toMatchObject({ code: 'PLUGIN_ACTIVATION_FAILED' });
    await install(reg, pkg('acme.roll', '3.0.0'));
    expect(await row(reg, 'acme.roll')).toMatchObject({ version: '3.0.0', installed: { selected: '3.0.0' } });
    expect((await row(reg, 'acme.roll')).status).toMatchObject({ message: expect.stringContaining('up') });
    expect(await reg.selectVersion('acme.roll', '1.0.0')).toMatchObject({ version: '1.0.0', enabled: true });
    expect(JSON.parse(await readFile(join(reg.packages.root, 'installed.json'), 'utf8')).plugins[0].selected).toBe('1.0.0');
  });

  it('backs the data up before a newer data version, keeps two backups, and refuses an older version than the data', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { registry: reg, stateDir } = await registry();
    const data = join(stateDir, 'plugin-data/acme.data');
    await install(reg, pkg('acme.data', '1.0.0', { dataVersion: 1 }));
    expect((await readFile(join(data, '.riffet-data-version'), 'utf8')).trim()).toBe('1');
    await writeFile(join(data, 'cache.json'), '{"format":1}');

    await install(reg, pkg('acme.data', '2.0.0', { dataVersion: 2 }));
    expect((await readFile(join(data, '.riffet-data-version'), 'utf8')).trim()).toBe('2');
    expect(await readFile(join(stateDir, 'plugin-data/acme.data.backup-v1/cache.json'), 'utf8')).toBe('{"format":1}');

    // The older version would read data it does not understand: it stays off, and the error names the backup.
    await expect(reg.selectVersion('acme.data', '1.0.0')).rejects.toMatchObject({ code: 'PLUGIN_ACTIVATION_FAILED', message: expect.stringContaining('acme.data.backup-v1') });
    expect(await row(reg, 'acme.data')).toMatchObject({ version: '2.0.0', enabled: true });

    await install(reg, pkg('acme.data', '3.0.0', { dataVersion: 3 }));
    await install(reg, pkg('acme.data', '4.0.0', { dataVersion: 4 }));
    const backups = (await readdir(join(stateDir, 'plugin-data'))).filter(name => name.includes('.backup-'));
    expect(backups.sort()).toEqual(['acme.data.backup-v2', 'acme.data.backup-v3']);
    expect((await row(reg, 'acme.data')).installed).toMatchObject({ dataVersion: 4, hasData: true, backups: ['acme.data.backup-v3', 'acme.data.backup-v2'] });
  });

  it('puts the backup back when a version that migrated the data does not start, so the previous version runs on its own format', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { registry: reg, stateDir } = await registry();
    const data = join(stateDir, 'plugin-data/acme.undo');
    await install(reg, pkg('acme.undo', '1.0.0', { dataVersion: 1 }));
    await writeFile(join(data, 'cache.json'), '{"format":1}');

    // Version 2 is backed up and marked first, then throws; it does not get to keep what it did to the data.
    await expect(install(reg, pkg('acme.undo', '2.0.0', { dataVersion: 2 }, "throw new Error('boom');"))).rejects.toMatchObject({ code: 'PLUGIN_ACTIVATION_FAILED' });
    expect(await row(reg, 'acme.undo')).toMatchObject({ enabled: true, version: '1.0.0', status: { state: 'attention', message: expect.stringContaining('still using 1.0.0') } });
    expect((await readFile(join(data, '.riffet-data-version'), 'utf8')).trim()).toBe('1');
    expect(await readFile(join(data, 'cache.json'), 'utf8')).toBe('{"format":1}');
    expect((await readdir(join(stateDir, 'plugin-data'))).filter(name => name.startsWith('acme.undo.'))).toEqual([]);
  });

  it('removes versions without touching data, defers files something still uses, and deletes data only when asked', async () => {
    let busy = true;
    const { registry: reg, stateDir } = await registry([], { versionInUse: (id, version) => busy && id === 'acme.life' && version === '1.0.0' });
    await install(reg, pkg('acme.life', '1.0.0'));
    await install(reg, pkg('acme.life', '2.0.0'));
    await writeFile(join(stateDir, 'plugin-data/acme.life/keep.txt'), 'data');
    await expect(reg.uninstallVersion('acme.life', '2.0.0')).rejects.toMatchObject({ code: 'PLUGIN_VERSION_SELECTED' });
    const after = await reg.uninstallVersion('acme.life', '1.0.0');
    expect(after.find(item => item.id === 'acme.life')!.installed!.versions.map(item => item.version)).toEqual(['2.0.0']);
    // The old version is no longer a choice, but its files wait for the task that uses them.
    expect((await stat(join(stateDir, 'plugins/acme.life/1.0.0'))).isDirectory()).toBe(true);
    busy = false;
    await reg.packages.prune(() => false);
    await expect(stat(join(stateDir, 'plugins/acme.life/1.0.0'))).rejects.toThrow();

    await reg.uninstallVersion('acme.life', '2.0.0');
    expect(await reg.descriptors()).toEqual([]);
    await expect(stat(join(stateDir, 'plugins/acme.life'))).rejects.toThrow();
    expect(await readFile(join(stateDir, 'plugin-data/acme.life/keep.txt'), 'utf8')).toBe('data');
    await reg.deleteData('acme.life');
    await expect(stat(join(stateDir, 'plugin-data/acme.life'))).rejects.toThrow();
    await expect(reg.deleteData('acme.life')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('uninstalls all versions in one operation, keeps settings and data, and stays removed after restart', async () => {
    let retained = true;
    const { registry: reg, stateDir } = await registry([], { versionInUse: (id, version) => retained && id === 'acme.remove-all' && version === '1.0.0' });
    await install(reg, pkg('acme.remove-all', '1.0.0'));
    await install(reg, pkg('acme.remove-all', '2.0.0'));
    reg.store.update('acme.remove-all', { settings: { region: 'eu' }, secrets: { key: 'keep' } });
    await writeFile(join(stateDir, 'plugin-data/acme.remove-all/keep.txt'), 'data');
    expect(await reg.uninstall('acme.remove-all')).toEqual([]);
    expect(reg.packages.record('acme.remove-all')).toBeUndefined();
    expect(reg.store.item('acme.remove-all')).toMatchObject({ settings: { region: 'eu' }, secrets: { key: 'keep' } });
    expect(await readFile(join(stateDir, 'plugin-data/acme.remove-all/keep.txt'), 'utf8')).toBe('data');
    expect((await stat(join(stateDir, 'plugins/acme.remove-all/1.0.0'))).isDirectory()).toBe(true);
    retained = false;
    await reg.packages.prune(() => false);
    await expect(stat(join(stateDir, 'plugins/acme.remove-all'))).rejects.toThrow();
    await reg.close();
    const restarted = new PluginRegistry({ stateDir, plugins: [], developmentPackages: [] });
    registries.push(restarted);
    await restarted.refresh();
    expect(await restarted.descriptors()).toEqual([]);
    expect(await readFile(join(stateDir, 'plugin-data/acme.remove-all/keep.txt'), 'utf8')).toBe('data');
  });

  it('keeps the installed record and runtime untouched when running tasks prevent whole-plugin removal', async () => {
    let running = false;
    const builtin: Plugin = { manifest: { id: 'acme.builtin', vendor: 'Acme', name: 'Builtin', apiVersion: 1, defaultEnabled: true }, activate: () => ({}) };
    const { registry: reg } = await registry([builtin], { runningTasks: id => running && id === 'acme.remove-busy' ? 1 : 0 });
    await install(reg, pkg('acme.remove-busy', '1.0.0'));
    running = true;
    await expect(reg.uninstall('acme.remove-busy')).rejects.toMatchObject({ code: 'PLUGIN_TASKS_RUNNING' });
    expect(await row(reg, 'acme.remove-busy')).toMatchObject({ active: true, installed: { selected: '1.0.0' } });
    await expect(reg.uninstall('acme.builtin')).rejects.toMatchObject({ statusCode: 404 });
    running = false;
    await reg.uninstall('acme.remove-busy');
    expect((await reg.descriptors()).map(item => item.id)).toEqual(['acme.builtin']);
  });

  it('survives a restart: the selected version loads again, and files that changed on disk are rejected', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { registry: first, stateDir } = await registry();
    await install(first, pkg('acme.persist', '1.0.0'));
    await install(first, pkg('acme.tamper', '1.0.0'));
    await first.close();
    await writeFile(join(stateDir, 'plugins/acme.tamper/1.0.0/server/index.mjs'), 'export default { activate: () => ({}) };');
    const second = new PluginRegistry({ stateDir, plugins: [], developmentPackages: [] });
    registries.push(second);
    await second.refresh();
    expect(await row(second, 'acme.persist')).toMatchObject({ enabled: true, version: '1.0.0', installed: { selected: '1.0.0' } });
    expect(await row(second, 'acme.tamper')).toMatchObject({ enabled: false, rejected: true, status: { message: expect.stringContaining('changed since they were installed') }, installed: { selected: '1.0.0' } });
    // Installing the same package again puts the damaged version right.
    expect(await install(second, pkg('acme.tamper', '1.0.0'))).toMatchObject({ enabled: true, version: '1.0.0' });
    expect((await second.descriptors()).filter(item => item.id === 'acme.tamper')).toHaveLength(1);
  });

  it('exposes per-entry compatibility', async () => {
    const { registry: reg } = await registry();
    const shown = await install(reg, pkg('acme.compat', '1.0.0', { hostApi: { server: '^1', web: '>=99' } }));
    expect(shown.compatibility).toEqual({ server: { range: '^1', ok: true }, web: { range: '>=99', ok: false } });
  });
});

describe('the install routes', () => {
  const multipart = (parts: Array<{ name: string; filename?: string; data: Buffer | string }>) => {
    const boundary = '----riffet-test';
    const body = Buffer.concat([
      ...parts.flatMap(part => [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.filename ? `; filename="${part.filename}"` : ''}\r\n\r\n`), Buffer.from(part.data), Buffer.from('\r\n')]),
      Buffer.from(`--${boundary}--\r\n`),
    ]);
    return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
  };

  it('installs an uploaded archive once its grant matches, and a path only for a request from this machine', async () => {
    const { registry: reg } = await registry();
    const app = Fastify();
    registerPluginRoutes(app, { plugins: reg });
    await app.ready();
    registries.push({ close: async () => { await app.close(); } } as PluginRegistry);
    const archive = pkg('acme.http', '1.0.0');
    const upload = (grant?: string) => {
      const { body, headers } = multipart([{ name: 'package', filename: 'demo.tgz', data: archive }, ...(grant === undefined ? [] : [{ name: 'grant', data: grant }])]);
      return app.inject({ method: 'POST', url: '/api/integrations/install', headers, payload: body });
    };
    const refused = await upload();
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'PLUGIN_GRANT_REQUIRED' });
    const done = await upload('["models.provide"]');
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ id: 'acme.http', source: 'installed', enabled: true, installed: { versions: [{ source: 'upload:demo.tgz' }] } });

    const directory = await temp();
    await writeFile(join(directory, 'riffet-plugin.json'), manifest('acme.local', '1.0.0', { capabilities: [] }));
    await mkdir(join(directory, 'server'));
    await writeFile(join(directory, 'server/index.mjs'), entry());
    const fromPath = (remoteAddress: string, grant: string[]) => app.inject({ method: 'POST', url: '/api/integrations/install', remoteAddress, payload: { path: directory, grant } });
    expect((await fromPath('203.0.113.9', [])).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/integrations/install', headers: { 'x-forwarded-for': '203.0.113.9' }, payload: { path: directory, grant: [] } })).statusCode).toBe(403);
    expect((await fromPath('127.0.0.1', [])).json()).toMatchObject({ id: 'acme.local', installed: { versions: [{ source: `path:${directory}` }] } });

    expect((await app.inject({ method: 'DELETE', url: '/api/integrations/acme.http/versions/1.0.0' })).json().integrations.map((item: { id: string }) => item.id)).toEqual(['acme.local']);
    // Other routes do not take a multipart body.
    expect((await app.inject({ method: 'PATCH', url: '/api/integrations/acme.local', ...multipart([{ name: 'x', data: 'y' }]) })).statusCode).toBe(415);
  });
});

describe('the runtime boundary', () => {
  it('gives the process exactly its shim, its package and its state directory', () => {
    expect(permissionArguments({ runtime: '/r/child.mjs', packageRoot: '/p', stateDir: '/s' })).toEqual([
      '--permission', '--no-experimental-sqlite', '--enable-source-maps', '--allow-fs-read=/r/child.mjs', '--allow-fs-read=/p', '--allow-fs-read=/s', '--allow-fs-write=/s', '--max-old-space-size=256',
    ]);
    const network = permissionArguments({ runtime: '/r/child.mjs', packageRoot: '/p', stateDir: '/s', network: true });
    expect(network.includes('--allow-net')).toBe(process.allowedNodeEnvironmentFlags.has('--allow-net'));
  });
});

macOnly('the operating-system layer on its own', () => {
  // Started under the Seatbelt profile without Node's permission model, so what is denied here is denied by the operating system.
  async function underProfile(network: boolean, env: Record<string, string>, withhold: number[] = []): Promise<Record<string, string>> {
    const support = await sandboxSupport();
    if (!support.ok) throw new Error(support.reason);
    const root = await realpath(await temp());
    const state = join(root, 'state');
    await mkdir(state);
    const entry = join(root, 'probe.mjs');
    await writeFile(entry, `
      const out = {};
      const attempt = async (key, run) => { try { await run(); out[key] = 'allowed'; } catch (error) { out[key] = error.code ?? error.cause?.code ?? error.name; } };
      const fs = await import('node:fs/promises');
      const cp = await import('node:child_process');
      const net = await import('node:net');
      const { env } = process;
      await attempt('readSsh', () => fs.readdir(env.SSH));
      await attempt('readOtherProject', () => fs.readFile(env.OTHER));
      await attempt('statOtherProject', () => fs.stat(env.OTHER));
      await attempt('readOwnPackage', () => fs.readFile(env.ENTRY));
      await attempt('writeOwnPackage', () => fs.writeFile(env.ENTRY + '.copy', 'x'));
      await attempt('readOwnState', () => fs.readdir(env.STATE));
      await attempt('writeOwnState', () => fs.writeFile(env.STATE + '/note.txt', 'x'));
      await attempt('spawn', () => { const child = cp.spawnSync('/bin/echo', ['hi']); if (child.error) throw child.error; });
      await attempt('signalSelf', () => process.kill(process.pid, 0));
      await attempt('signalParent', () => process.kill(process.ppid, 0));
      await attempt('terminateParent', () => process.kill(process.ppid, 'SIGTERM'));
      await attempt('fetch', () => fetch(env.SERVER, { signal: AbortSignal.timeout(2000) }));
      await attempt('fetchServer', () => fetch(env.WITHHELD, { signal: AbortSignal.timeout(2000) }));
      await attempt('fetchServerMapped', () => fetch(env.WITHHELD_MAPPED, { signal: AbortSignal.timeout(2000) }));
      await attempt('listen', () => new Promise((resolve, reject) => { const server = net.createServer().on('error', reject).listen(0, '127.0.0.1', () => { server.close(); resolve(); }); }));
      await attempt('unixSocket', () => new Promise((resolve, reject) => { const socket = net.connect(env.SOCKET).on('connect', () => { socket.destroy(); resolve(); }).on('error', reject); }));
      process.send(out);
    `);
    const child = fork(entry, [], {
      execPath: SANDBOX_EXEC, cwd: state, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      execArgv: sandboxArguments({ node: support.node, libraries: support.libraries, read: [entry, state], write: [state], network, withhold }),
      env: { OPENSSL_CONF: '/dev/null', STATE: state, ENTRY: entry, ...env },
    });
    let errors = '';
    child.stderr!.on('data', chunk => { errors += String(chunk); });
    return new Promise((resolve, reject) => {
      child.once('message', message => resolve(message as Record<string, string>));
      child.once('exit', code => reject(new Error(`the probe ended with ${code}: ${errors.slice(-300)}`)));
    });
  }

  it('denies signals to other processes, files it was not given, new processes and sockets, and allows the network only with the grant', async () => {
    const other = join(await realpath(await temp()), 'secret.txt');
    await writeFile(other, 'another project');
    const local = createHttpServer((_request, response) => response.end('ok')).listen(0, '127.0.0.1');
    // Stands for the Riffet server itself, whose port stays closed to a package that may otherwise use the network.
    const own = createHttpServer((_request, response) => response.end('ok')).listen(0, '127.0.0.1');
    const sockets = createSocketServer(socket => socket.end()).listen(`/tmp/wk-${process.pid}.sock`);
    await Promise.all([new Promise(resolve => local.once('listening', resolve)), new Promise(resolve => own.once('listening', resolve)), new Promise(resolve => sockets.once('listening', resolve))]);
    try {
      const ownPort = (own.address() as { port: number }).port;
      const env = { SSH: join(homedir(), '.ssh'), OTHER: other, SERVER: `http://127.0.0.1:${(local.address() as { port: number }).port}/`, WITHHELD: `http://127.0.0.1:${ownPort}/`, WITHHELD_MAPPED: `http://[::ffff:127.0.0.1]:${ownPort}/`, SOCKET: `/tmp/wk-${process.pid}.sock` };
      const closed = await underProfile(false, env);
      const open = await underProfile(true, env);
      const beside = await underProfile(true, env, [ownPort]);
      for (const seen of [closed, open]) {
        expect(seen).toMatchObject({
          readSsh: 'EPERM', readOtherProject: 'EPERM', statOtherProject: 'EPERM', writeOwnPackage: 'EPERM', spawn: 'EPERM',
          signalParent: 'EPERM', terminateParent: 'EPERM', listen: 'EPERM', unixSocket: 'EPERM',
          readOwnPackage: 'allowed', readOwnState: 'allowed', writeOwnState: 'allowed', signalSelf: 'allowed',
        });
      }
      expect(closed.fetch).not.toBe('allowed');
      expect(open).toMatchObject({ fetch: 'allowed', fetchServer: 'allowed', fetchServerMapped: 'allowed' });
      // The server's own port is closed even with the grant, also as an IPv4-mapped IPv6 address; every other local port is not.
      expect(beside).toMatchObject({ fetch: 'allowed', fetchServer: 'EPERM', fetchServerMapped: 'EPERM' });
    } finally {
      local.close();
      own.close();
      sockets.close();
    }
  });

  it('starts from deny-default and never leaves a rule without a filter', () => {
    const profile = sandboxProfile({ read: ['/a', '/b'], write: ['/b'], network: false });
    expect(profile).toContain('(deny default)');
    expect(profile).not.toContain('network');
    // A rule whose filter list is empty would allow its operation everywhere.
    expect(sandboxProfile({ read: [], write: [], network: false })).not.toMatch(/\(allow (?:file-read\*|file-write\*|file-read-metadata)\s*\)/);
  });
});

describe('a machine that cannot isolate a process', () => {
  afterEach(() => { machine.cannotIsolate = false; vi.unstubAllEnvs(); });

  it('refuses to start installed packages and leaves built-in and development packages alone', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('RIFFET_UNSAFE_PLUGIN_PROCESS', '');
    machine.cannotIsolate = true;
    const directory = await temp();
    await writeFile(join(directory, 'riffet-plugin.json'), manifest('acme.dev', '1.0.0', { capabilities: [] }));
    await mkdir(join(directory, 'server'));
    await writeFile(join(directory, 'server/index.mjs'), 'export default { activate: () => ({ status: async () => ({ state: "ready", message: "dev up" }) }) };');
    const stay: Plugin = { manifest: { id: 'acme.builtin', vendor: 'Acme', name: 'Builtin', apiVersion: 1, defaultEnabled: true }, activate: () => ({}) };
    const { registry: reg } = await registry([stay], { developmentPackages: [directory] });
    const installed = await install(reg, pkg('acme.refused', '1.0.0'));
    expect(installed).toMatchObject({ enabled: false, status: { state: 'unavailable', message: expect.stringMatching(/operating-system isolation.*RIFFET_UNSAFE_PLUGIN_PROCESS=1/) } });
    expect(reg.modelSources()).toEqual([]);
    expect(await row(reg, 'acme.builtin')).toMatchObject({ enabled: true });
    expect(await row(reg, 'acme.dev')).toMatchObject({ enabled: true, source: 'development', status: { message: 'dev up' } });
    // The package stays installed, so a machine that can isolate (or an operator who accepts the risk) starts it later.
    expect(installed.installed!.versions).toHaveLength(1);
  });

  it('starts them only when the operator accepts that, and keeps a warning in the status for as long as they run', async () => {
    machine.cannotIsolate = true;
    vi.stubEnv('RIFFET_UNSAFE_PLUGIN_PROCESS', '1');
    const { registry: reg } = await registry();
    const shown = await install(reg, pkg('acme.unsafe', '1.0.0'));
    expect(shown).toMatchObject({ enabled: true, status: { state: 'attention', message: expect.stringMatching(/^Running without operating-system isolation.*· up$/) } });
    expect(reg.modelSources().map(item => item.id)).toEqual(['acme.unsafe.remote']);
    expect((await reg.doctorChecks()).find(check => check.id === 'integration:acme.unsafe:isolation')).toMatchObject({ status: 'warn' });
  });

  it('decides from the environment only', async () => {
    const none = Promise.resolve({ ok: false as const, reason: 'nothing here' });
    await expect(requireIsolation({}, none)).rejects.toMatchObject({ code: 'PLUGIN_ISOLATION_UNAVAILABLE' });
    await expect(requireIsolation({ RIFFET_UNSAFE_PLUGIN_PROCESS: 'true' }, none)).rejects.toMatchObject({ code: 'PLUGIN_ISOLATION_UNAVAILABLE' });
    await expect(requireIsolation({ RIFFET_UNSAFE_PLUGIN_PROCESS: '1' }, none)).resolves.toMatchObject({ kind: 'none' });
    await expect(requireIsolation({}, Promise.resolve({ ok: true, node: '/node', libraries: [] }))).resolves.toEqual({ kind: 'os', node: '/node', libraries: [] });
  });
});
