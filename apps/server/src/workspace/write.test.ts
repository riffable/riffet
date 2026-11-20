import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileWrites } from './write.js';

const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const cleanups: string[] = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function setup() {
  const project = await mkdtemp(path.join(tmpdir(), 'riffet-write-'));
  const stateDir = await mkdtemp(path.join(tmpdir(), 'riffet-write-state-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'riffet-write-outside-'));
  cleanups.push(project, stateDir, outside);
  const noted: string[] = [];
  return { project, stateDir, outside, noted, writes: new FileWrites({ stateDir, noteWrite: file => noted.push(file) }) };
}

describe('project file writes', () => {
  it('writes only inside the project, never into Git or the state directory', async () => {
    const { project, outside, writes } = await setup();
    await mkdir(path.join(project, '.git'));
    await writeFile(path.join(outside, 'target.txt'), 'outside');
    await symlink(outside, path.join(project, 'linked'));
    const code = (run: Promise<unknown>) => run.then(() => 'ok', (error: { code?: string }) => error.code);
    expect(await code(writes.create(project, { path: '../escape.txt', kind: 'file' }))).toBe('INVALID_PATH');
    expect(await code(writes.create(project, { path: path.join(outside, 'abs.txt'), kind: 'file' }))).toBe('INVALID_PATH');
    expect(await code(writes.save(project, { path: 'linked/target.txt', content: 'x', expectedHash: hash('outside') }))).toBe('PATH_OUTSIDE_PROJECT');
    expect(await code(writes.create(project, { path: '.git/hooks/pre-commit', kind: 'file' }))).toBe('PATH_DENIED');
    // Git's folder as a case-insensitive disk or Windows would match it, and through a link inside the project.
    expect(await code(writes.create(project, { path: '.GIT/hooks/pre-commit', kind: 'file' }))).toBe('PATH_DENIED');
    expect(await code(writes.remove(project, { path: '.Git', permanent: true }))).toBe('PATH_DENIED');
    expect(await code(writes.create(project, { path: '.git./config', kind: 'file' }))).toBe('PATH_DENIED');
    await symlink(path.join(project, '.git'), path.join(project, 'repo'));
    expect(await code(writes.create(project, { path: 'repo/hooks/pre-commit', kind: 'file' }))).toBe('PATH_DENIED');
    expect(await code(writes.create(project, { path: 'repo/new/deeper/x', kind: 'file' }))).toBe('PATH_DENIED');
    expect(await code(writes.remove(project, { path: '.' }))).toBe('INVALID_PATH');
    const nested = new FileWrites({ stateDir: path.join(project, 'state') });
    await mkdir(path.join(project, 'state'));
    expect(await code(nested.create(project, { path: 'state/x.json', kind: 'file' }))).toBe('PATH_DENIED');
    expect(await readFile(path.join(outside, 'target.txt'), 'utf8')).toBe('outside');
  });

  it('refuses a save against a changed file and leaves it as the other writer left it', async () => {
    const { project, writes, noted } = await setup();
    const file = path.join(project, 'notes.md');
    await writeFile(file, 'first');
    const opened = hash('first');
    await writeFile(file, 'agent wrote this');
    await expect(writes.save(project, { path: 'notes.md', content: 'mine', expectedHash: opened })).rejects.toMatchObject({ code: 'FILE_CHANGED', statusCode: 409 });
    expect(await readFile(file, 'utf8')).toBe('agent wrote this');
    const saved = await writes.save(project, { path: 'notes.md', content: 'mine', expectedHash: hash('agent wrote this') });
    expect(saved).toEqual({ path: 'notes.md', hash: hash('mine'), size: 4 });
    expect(noted).toEqual([path.join(await realpath(project), 'notes.md')]);
    // Two saves from the same version: the second finds the first's result and is refused.
    const results = await Promise.allSettled([
      writes.save(project, { path: 'notes.md', content: 'a', expectedHash: saved.hash }),
      writes.save(project, { path: 'notes.md', content: 'b', expectedHash: saved.hash }),
    ]);
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('keeps line endings, a BOM and the file mode, and does not edit other encodings', async () => {
    const { project, writes } = await setup();
    const file = path.join(project, 'win.txt');
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\r\n')]);
    await writeFile(file, original, { mode: 0o755 });
    await writes.save(project, { path: 'win.txt', content: 'a\nb\nc\n', expectedHash: hash(original) });
    expect(await readFile(file)).toEqual(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\r\nc\r\n')]));
    expect((await stat(file)).mode & 0o777).toBe(0o755);
    const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);
    await writeFile(path.join(project, 'gbk.txt'), gbk);
    await expect(writes.save(project, { path: 'gbk.txt', content: 'x', expectedHash: hash(gbk) })).rejects.toMatchObject({ code: 'FILE_NOT_EDITABLE' });
  });

  it('keeps a deletion for undo and restores it in place', async () => {
    const { project, writes } = await setup();
    await mkdir(path.join(project, 'docs'));
    await writeFile(path.join(project, 'docs', 'a.md'), 'kept');
    const deleted = await writes.remove(project, { path: 'docs' });
    expect(deleted.restoreId).toBeTruthy();
    await expect(stat(path.join(project, 'docs'))).rejects.toThrow();
    expect(await writes.restore(project, deleted.restoreId!)).toEqual({ path: 'docs' });
    expect(await readFile(path.join(project, 'docs', 'a.md'), 'utf8')).toBe('kept');
    await expect(writes.restore(project, deleted.restoreId!)).rejects.toMatchObject({ code: 'RESTORE_EXPIRED' });
    await writeFile(path.join(project, 'b.md'), 'b');
    await writeFile(path.join(project, 'c.md'), 'c');
    await expect(writes.move(project, { from: 'b.md', to: 'c.md' })).rejects.toMatchObject({ code: 'FILE_EXISTS' });
    expect(await readFile(path.join(project, 'c.md'), 'utf8')).toBe('c');
  });
});
