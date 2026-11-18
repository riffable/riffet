import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import { crc32, inflateRawSync } from 'node:zlib';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerWorkspaceRoutes } from '../routes/workspace.js';
import type { RouteDeps } from '../routes/deps.js';
import { contentDisposition, rawFileType } from './download.js';
import { WorkspaceService } from './index.js';

const testHome = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => testHome.value ?? actual.homedir() };
});

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Reads entries through the central directory, as unzip tools do. */
function readZip(zip: Buffer): Map<string, Buffer | 'dir'> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let cursor = zip.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer | 'dir'>();
  for (let index = 0; index < count; index += 1) {
    expect(zip.readUInt32LE(cursor)).toBe(0x02014b50);
    const method = zip.readUInt16LE(cursor + 10);
    const crc = zip.readUInt32LE(cursor + 16);
    const compressed = zip.readUInt32LE(cursor + 20);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const offset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    expect(zip.readUInt32LE(offset)).toBe(0x04034b50);
    const dataStart = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    if (name.endsWith('/')) entries.set(name, 'dir');
    else {
      expect(method).toBe(8);
      const data = inflateRawSync(zip.subarray(dataStart, dataStart + compressed));
      expect(crc32(data)).toBe(crc);
      entries.set(name, data);
    }
    cursor += 46 + nameLength;
  }
  return entries;
}

describe('file downloads', () => {
  let dir: string;
  let workspace: WorkspaceService;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'riffet-download-'));
    testHome.value = dir;
    workspace = new WorkspaceService({ stateDir: path.join(dir, '.state') });
  });
  afterEach(async () => { testHome.value = undefined; await rm(dir, { recursive: true, force: true }); });

  it('serves media and text inline and everything else as a download', () => {
    expect(rawFileType('report.pdf', Buffer.from('%PDF'))).toEqual({ contentType: 'application/pdf', inline: true });
    expect(rawFileType('page.html', Buffer.from('<html>'))).toEqual({ contentType: 'text/html; charset=utf-8', inline: true });
    expect(rawFileType('main.rs', Buffer.from('fn main() {}'))).toEqual({ contentType: 'text/plain; charset=utf-8', inline: true });
    expect(rawFileType('blob.bin', Buffer.from([1, 0, 2]))).toEqual({ contentType: 'application/octet-stream', inline: false });
  });

  it('keeps non-ASCII names in the disposition header', () => {
    expect(contentDisposition('attachment', '报告 "v2".md')).toBe(`attachment; filename="__ _v2_.md"; filename*=UTF-8''${encodeURIComponent('报告 "v2".md')}`);
  });

  it('streams a single file, including one outside the project when allowed', async () => {
    const project = path.join(dir, 'project');
    await mkdir(project);
    await writeFile(path.join(project, 'notes.txt'), 'hello');
    await writeFile(path.join(dir, 'outside.png'), 'png');
    const inside = await workspace.rawFile(project, 'notes.txt');
    expect(inside).toMatchObject({ name: 'notes.txt', size: 5, contentType: 'text/plain; charset=utf-8', inline: true });
    await expect(workspace.rawFile(project, path.join(dir, 'outside.png'))).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await expect(workspace.rawFile(project, path.join(dir, 'outside.png'), { allowOutside: true })).resolves.toMatchObject({ name: 'outside.png', contentType: 'image/png' });
    await expect(workspace.rawFile(project, '../outside.png')).rejects.toMatchObject({ code: 'INVALID_PATH' });
  });

  it('expands home-relative (~/) paths for single-file reads while enforcing outside and secret rules', async () => {
    const project = path.join(dir, 'project');
    await mkdir(project);
    const rule = path.join(dir, '.cursor', 'rules', 'global.mdc');
    await mkdir(path.dirname(rule), { recursive: true });
    await writeFile(rule, '# rule\n');
    const secret = path.join(dir, '.cursor', 'cli-config.json');
    await writeFile(secret, '{"apiKey":"secret"}\n');

    await expect(workspace.preview(project, '~/.cursor/rules/global.mdc')).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await expect(workspace.preview(project, '~/.cursor/rules/global.mdc', { allowOutside: true })).resolves.toMatchObject({
      path: await realpath(rule),
      content: '# rule\n',
    });
    await expect(workspace.rawFile(project, '~/.cursor/rules/global.mdc', { allowOutside: true })).resolves.toMatchObject({ name: 'global.mdc' });
    await expect(workspace.preview(project, '~/.cursor/cli-config.json', { allowOutside: true })).rejects.toMatchObject({ code: 'PATH_DENIED' });
  });

  it('refuses harness credential stores both outside and inside a project', async () => {
    // testHome is `dir`, so these stores sit where each harness keeps its login.
    const project = path.join(dir, 'project');
    await mkdir(project);
    for (const file of ['.trae/traecli.toml', '.traecli.toml', '.cursor/cli-config.json']) {
      const absolute = path.join(dir, file);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, 'secret\n');
      await expect(workspace.rawFile(project, absolute, { allowOutside: true }), file).rejects.toMatchObject({ code: 'PATH_DENIED' });
      // A project rooted at the home directory must not reach the same stores by relative path.
      await expect(workspace.rawFile(dir, file), file).rejects.toMatchObject({ code: 'PATH_DENIED' });
    }
    // Only the harness stores are denied: a project's own lookalikes and .env stay readable.
    await mkdir(path.join(project, '.trae'), { recursive: true });
    await writeFile(path.join(project, '.trae', 'config.json'), 'project-local\n');
    await writeFile(path.join(project, '.env'), 'LOCAL=1\n');
    await expect(workspace.rawFile(project, '.trae/config.json')).resolves.toMatchObject({ name: 'config.json' });
    await expect(workspace.rawFile(project, '.env')).resolves.toMatchObject({ name: '.env' });
  });

  it('serves only configured harness objects and keeps other credential restrictions', async () => {
    const project = path.join(dir, 'project');
    await mkdir(project);
    const home = path.join(dir, '.riffet', 'dsh');
    const objectPath = (root: string, shard = 'cc') => path.join(root, 'attachments', 'v1', 'objects', shard, 'c'.repeat(64));
    const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const putImage = async (file: string) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, image); return file; };
    const object = await putImage(objectPath(home));
    const options = { allowOutside: true, harnessImageHomes: [home] };
    await expect(workspace.readPreviewImage(project, object, options)).resolves.toMatchObject({ mimeType: 'image/jpeg' });
    // The same file remains secret without a configured home and through non-image endpoints.
    await expect(workspace.readPreviewImage(project, object, { allowOutside: true })).rejects.toMatchObject({ code: 'PATH_DENIED' });
    await expect(workspace.preview(project, object, { allowOutside: true })).rejects.toMatchObject({ code: 'PATH_DENIED' });
    await expect(workspace.readPreviewImage(project, object, { ...options, allowOutside: false })).rejects.toMatchObject({ code: 'INVALID_PATH' });
    // A project rooted above the store must enforce the same policy for its relative paths.
    await expect(workspace.readPreviewImage(dir, path.relative(dir, object), options)).resolves.toMatchObject({ mimeType: 'image/jpeg' });
    for (const denied of [
      await putImage(path.join(home, 'settings.json')),
      await putImage(objectPath(home, 'ab')),
      await putImage(objectPath(path.join(dir, '.riffet', 'unrelated-store'))),
      await putImage(path.join(dir, '.riffet', `attachments\\v1\\objects\\cc\\${'c'.repeat(64)}`)),
      await putImage(objectPath(workspace.stateDir)),
      await putImage(objectPath(path.join(dir, '.ssh'))),
    ]) {
      await expect(workspace.readPreviewImage(project, denied, options)).rejects.toMatchObject({ code: 'PATH_DENIED' });
      await expect(workspace.readPreviewImage(dir, path.relative(dir, denied), options)).rejects.toMatchObject({ code: 'PATH_DENIED' });
    }
    // Even an explicitly configured home cannot override state or unrelated credential roots.
    for (const deniedHome of [workspace.stateDir, path.join(dir, '.ssh')]) {
      await expect(workspace.readPreviewImage(project, objectPath(deniedHome), { allowOutside: true, harnessImageHomes: [deniedHome] })).rejects.toMatchObject({ code: 'PATH_DENIED' });
    }
    const alias = path.join(dir, 'home-alias');
    await symlink(home, alias);
    await expect(workspace.readPreviewImage(project, path.join(alias, path.relative(home, object)), { allowOutside: true, harnessImageHomes: [alias] })).resolves.toMatchObject({ mimeType: 'image/jpeg' });
    const linkedStore = path.join(dir, '.riffet', 'linked-dsh');
    await mkdir(linkedStore);
    await symlink(path.join(workspace.stateDir, 'attachments'), path.join(linkedStore, 'attachments'));
    await expect(workspace.readPreviewImage(project, objectPath(linkedStore), { allowOutside: true, harnessImageHomes: [linkedStore] })).rejects.toMatchObject({ code: 'PATH_DENIED' });
  });

  it('uses the configured DSH profile home on the image route and retains outside-read gating', async () => {
    const project = path.join(dir, 'project');
    const home = path.join(dir, '.riffet', 'custom-dsh');
    const object = path.join(home, 'attachments', 'v1', 'objects', 'cc', 'c'.repeat(64));
    await mkdir(project);
    await mkdir(path.dirname(object), { recursive: true });
    await writeFile(object, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
    let outside = true;
    const profileSettings = vi.fn(() => ({ profiles: [{ configDir: home }] }));
    const app = Fastify();
    try {
      registerWorkspaceRoutes(app, { workspace, store: { getProject: () => project }, nativeBackends: { catalog: { profileSettings } }, allowOutsideRead: () => outside } as unknown as RouteDeps);
      const url = `/api/projects/test/file/image?path=${encodeURIComponent(object)}`;
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
      expect(profileSettings).toHaveBeenCalledWith('dsh');
      outside = false;
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(403);
    } finally { await app.close(); }
  });

  it('serves registered attachment images by local path without enabling outside reads', async () => {
    const project = path.join(dir, 'project');
    await mkdir(project);
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    const attachment = await workspace.upload(project, { name: 'image.png', mimeType: 'image/png', dataBase64: image.toString('base64') });
    const app = Fastify();
    try {
      registerWorkspaceRoutes(app, { workspace, store: { getProject: () => project }, nativeBackends: { catalog: { profileSettings: () => ({ profiles: [] }) } }, allowOutsideRead: () => false } as unknown as RouteDeps);
      const response = await app.inject({ method: 'GET', url: `/api/projects/test/file/image?path=${encodeURIComponent(attachment.path)}` });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('image/png');
      expect(response.rawPayload).toEqual(image);
      await expect(workspace.rawFile(project, attachment.path, { allowOutside: true })).rejects.toMatchObject({ code: 'PATH_DENIED' });
      await expect(workspace.preview(project, attachment.path, { allowOutside: true })).rejects.toMatchObject({ code: 'PATH_DENIED' });
    } finally { await app.close(); }
  });

  it('keeps attachment validation and state-directory restrictions on image previews', async () => {
    const project = path.join(dir, 'project');
    await mkdir(project);
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const attachment = await workspace.upload(project, { name: 'image.png', mimeType: 'image/png', dataBase64: image.toString('base64') });
    const options = { allowOutside: true };
    const unregistered = path.join(workspace.stateDir, 'attachments', '00000000-0000-0000-0000-000000000000.bin');
    await writeFile(unregistered, image);
    await expect(workspace.readPreviewImage(project, unregistered, options)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });

    const metadataPath = path.join(workspace.stateDir, 'attachments', `${attachment.id}.json`);
    await writeFile(metadataPath, JSON.stringify({ ...attachment, path: unregistered }));
    await expect(workspace.readPreviewImage(project, attachment.path, options)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
    await writeFile(metadataPath, JSON.stringify(attachment));
    await rm(attachment.path);
    await symlink(unregistered, attachment.path);
    await expect(workspace.readPreviewImage(project, attachment.path, options)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });

    const stateFile = path.join(workspace.stateDir, 'secret.png');
    await writeFile(stateFile, image);
    await expect(workspace.readPreviewImage(project, stateFile, options)).rejects.toMatchObject({ code: 'PATH_DENIED' });
  });

  it('zips a folder without symlinks or dependency folders', async () => {
    const project = path.join(dir, 'project');
    await mkdir(path.join(project, 'docs', 'empty'), { recursive: true });
    await mkdir(path.join(project, 'docs', 'node_modules'), { recursive: true });
    await writeFile(path.join(project, 'docs', '说明.md'), '# 你好\n'.repeat(200));
    await writeFile(path.join(project, 'docs', 'node_modules', 'skip.js'), 'x');
    await writeFile(path.join(dir, 'secret.txt'), 'secret');
    await symlink(path.join(dir, 'secret.txt'), path.join(project, 'docs', 'link.txt'));

    const archive = await workspace.archive(project, 'docs');
    expect(archive).toMatchObject({ name: 'docs.zip', files: 1 });
    const entries = readZip(await collect(archive.stream()));
    expect([...entries.keys()]).toEqual(['docs/empty/', 'docs/说明.md']);
    expect((entries.get('docs/说明.md') as Buffer).toString('utf8')).toBe('# 你好\n'.repeat(200));
    await expect(workspace.archive(project, '../')).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await expect(workspace.archive(project, 'docs/说明.md')).rejects.toMatchObject({ code: 'NOT_A_DIRECTORY' });
  });

  it('packages what git shows in a work tree, leaving ignored files out', async () => {
    const project = path.join(dir, 'repo');
    await mkdir(path.join(project, 'src', '.cache'), { recursive: true });
    await writeFile(path.join(project, '.gitignore'), '.cache/\n*.log\n');
    await writeFile(path.join(project, 'src', 'main.ts'), 'tracked');
    await writeFile(path.join(project, 'src', 'new.ts'), 'untracked');
    await writeFile(path.join(project, 'src', 'debug.log'), 'ignored');
    await writeFile(path.join(project, 'src', '.cache', 'blob'), 'ignored');
    execFileSync('git', ['init', '-q'], { cwd: project });
    execFileSync('git', ['add', '.gitignore', 'src/main.ts'], { cwd: project });

    const entries = readZip(await collect((await workspace.archive(project, 'src')).stream()));
    expect([...entries.keys()]).toEqual(['src/main.ts', 'src/new.ts']);
    expect([...readZip(await collect((await workspace.archive(project, '')).stream())).keys()]).toEqual(['repo/.gitignore', 'repo/src/main.ts', 'repo/src/new.ts']);
  });

  it('reads a missing path as the only listed file ending with it, never one of several', async () => {
    const project = path.join(dir, 'repo');
    await mkdir(path.join(project, 'src', 'cell'), { recursive: true });
    await mkdir(path.join(project, 'docs'), { recursive: true });
    await writeFile(path.join(project, 'src', 'cell', 'Cell.swift'), 'cell');
    await writeFile(path.join(project, 'src', 'index.ts'), 'src');
    await writeFile(path.join(project, 'docs', 'index.ts'), 'docs');
    execFileSync('git', ['init', '-q'], { cwd: project });
    execFileSync('git', ['add', '.'], { cwd: project });

    expect((await workspace.preview(project, 'Cell.swift')).path).toBe('src/cell/Cell.swift');
    expect((await workspace.preview(project, 'cell/Cell.swift')).path).toBe('src/cell/Cell.swift');
    await expect(workspace.preview(project, 'index.ts')).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    await expect(workspace.preview(project, 'ell.swift')).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  });

  it('names a whole-project archive after the project folder', async () => {
    const project = path.join(dir, 'my-app');
    await mkdir(project);
    await writeFile(path.join(project, 'a.txt'), 'a');
    const archive = await workspace.archive(project, '');
    expect(archive.name).toBe('my-app.zip');
    expect(await text(archive.stream())).toContain('my-app/a.txt');
  });
});
