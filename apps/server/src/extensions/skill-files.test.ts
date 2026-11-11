import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteConfigDocument, hashConfigContent, withConfigFileLock } from '../settings/config-documents.js';
import { writeExtensionFile } from './files.js';
import { removeSkillFiles, setSkillFileEnabled } from './skill-files.js';
import type { ExtensionDocumentDescriptor } from './types.js';

const rename = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, rename: rename.mockImplementation(original.rename) };
});

let root: string;
let stateDir: string;
let descriptor: ExtensionDocumentDescriptor;
const content = '---\nname: example\n---\nRun the skill.\n';

async function put(relative: string, value: string): Promise<string> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, value);
  return target;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'riffet-skill-files-')));
  stateDir = path.join(root, 'state');
  descriptor = {
    id: 'skill', path: '.claude/skills/example/SKILL.md', relativePath: '.claude/skills/example/SKILL.md',
    root, absolutePath: await put('.claude/skills/example/SKILL.md', content),
    editable: true, scope: 'project', language: 'markdown', applyEffect: 'Next turn',
  };
});

afterEach(async () => {
  rename.mockReset();
  rename.mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename);
  await rm(root, { recursive: true, force: true });
});

describe('owned skill lifecycle', () => {
  it('disables and reenables without changing bytes and retains private backups', async () => {
    const disabled = await setSkillFileEnabled(descriptor, false, hashConfigContent(content), stateDir);
    expect(await readFile(disabled.backupPath, 'utf8')).toBe(content);
    expect((await lstat(disabled.backupPath)).mode & 0o777).toBe(0o600);
    await expect(lstat(descriptor.absolutePath)).rejects.toMatchObject({ code: 'ENOENT' });
    const disabledPath = descriptor.absolutePath + '.riffet-disabled';
    expect(await readFile(disabledPath, 'utf8')).toBe(content);
    await setSkillFileEnabled({ ...descriptor, absolutePath: disabledPath, relativePath: descriptor.relativePath + '.riffet-disabled' }, true, hashConfigContent(content), stateDir);
    expect(await readFile(descriptor.absolutePath, 'utf8')).toBe(content);
    await expect(lstat(disabledPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects stale hashes and never overwrites an alternate manifest', async () => {
    await expect(setSkillFileEnabled(descriptor, false, hashConfigContent('stale'), stateDir)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' });
    await put('.claude/skills/example/SKILL.md.riffet-disabled', 'other');
    await expect(setSkillFileEnabled(descriptor, false, hashConfigContent(content), stateDir)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' });
    expect(await readFile(descriptor.absolutePath, 'utf8')).toBe(content);
    expect(await readFile(descriptor.absolutePath + '.riffet-disabled', 'utf8')).toBe('other');
  });

  it('removes the entire directory to an unscanned backup and preserves internal links without following them', async () => {
    await put('.claude/skills/example/scripts/run.sh', '#!/bin/sh\necho ok\n');
    const outside = await put('outside.txt', 'untouched');
    await symlink(outside, path.join(path.dirname(descriptor.absolutePath), 'outside-link'));
    const { backupPath } = await removeSkillFiles(descriptor, hashConfigContent(content), stateDir);
    await expect(lstat(path.dirname(descriptor.absolutePath))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(backupPath, 'SKILL.md'), 'utf8')).toBe(content);
    expect(await readFile(path.join(backupPath, 'scripts/run.sh'), 'utf8')).toContain('echo ok');
    expect(await readlink(path.join(backupPath, 'outside-link'))).toBe(outside);
    expect(await readFile(outside, 'utf8')).toBe('untouched');
    expect(await readdir(path.join(root, '.claude/skills'))).toEqual([]);
  });

  it('refuses nested skills, shared ancestors, read-only sources, and the skills root itself', async () => {
    await put('.claude/skills/example/child/SKILL.md.riffet-disabled', 'nested');
    await expect(removeSkillFiles(descriptor, hashConfigContent(content), stateDir)).rejects.toMatchObject({ code: 'EXTENSION_SKILL_DIRECTORY_UNSAFE' });
    await rm(path.join(root, '.claude/skills/example/child'), { recursive: true });
    await expect(removeSkillFiles({ ...descriptor, editable: false }, hashConfigContent(content), stateDir)).rejects.toMatchObject({ code: 'EXTENSION_READ_ONLY' });
    const rootManifest = await put('.claude/skills/SKILL.md', content);
    await expect(removeSkillFiles({ ...descriptor, absolutePath: rootManifest, relativePath: '.claude/skills/SKILL.md' }, hashConfigContent(content), stateDir)).rejects.toMatchObject({ code: 'EXTENSION_SKILL_DIRECTORY_UNSAFE' });
    await rm(rootManifest);
    await symlink(path.dirname(descriptor.absolutePath), path.join(root, '.claude/skills/shared'));
    await expect(removeSkillFiles({ ...descriptor, absolutePath: path.join(root, '.claude/skills/shared/SKILL.md'), relativePath: '.claude/skills/shared/SKILL.md' }, hashConfigContent(content), stateDir)).rejects.toMatchObject({ code: 'EXTENSION_SYMLINK_UNSUPPORTED' });
    expect(await readFile(descriptor.absolutePath, 'utf8')).toBe(content);
  });

  it('supports classification directories while refusing children of another skill', async () => {
    const relativePath = '.claude/skills/group/nested/SKILL.md';
    const nested = { ...descriptor, relativePath, absolutePath: await put(relativePath, content) };
    const { backupPath } = await removeSkillFiles(nested, hashConfigContent(content), stateDir);
    expect(await readFile(path.join(backupPath, 'SKILL.md'), 'utf8')).toBe(content);
    expect(await readdir(path.join(root, '.claude/skills/group'))).toEqual([]);
    await put(relativePath, content);
    await put('.claude/skills/group/SKILL.md', 'parent');
    await expect(removeSkillFiles(nested, hashConfigContent(content), stateDir)).rejects.toMatchObject({ code: 'EXTENSION_SKILL_DIRECTORY_UNSAFE' });
  });

  it('refuses backups inside skills, including a symlinked state ancestor', async () => {
    await expect(removeSkillFiles(descriptor, hashConfigContent(content), path.join(root, '.claude/skills/backups'))).rejects.toMatchObject({ code: 'EXTENSION_SKILL_BACKUP_UNSAFE' });
    await symlink(path.join(root, '.claude/skills'), path.join(root, 'state-link'));
    await expect(removeSkillFiles(descriptor, hashConfigContent(content), path.join(root, 'state-link/new-state'))).rejects.toMatchObject({ code: 'EXTENSION_SKILL_BACKUP_UNSAFE' });
    expect(await readFile(descriptor.absolutePath, 'utf8')).toBe(content);
  });

  it('refuses another Agent skills tree and both lexical and canonical skills ancestors', async () => {
    const otherSkills = path.join(root, 'other-agent/skills');
    await mkdir(otherSkills, { recursive: true });
    const outside = path.join(root, 'outside-backups');
    await mkdir(outside);
    await symlink(otherSkills, path.join(root, 'other-state-link'));
    await symlink(outside, path.join(otherSkills, 'outside-link'));
    for (const statePath of [
      path.join(otherSkills, 'state'),
      path.join(root, 'other-state-link/state'),
      path.join(otherSkills, 'outside-link/state'),
    ]) {
      await expect(removeSkillFiles(descriptor, hashConfigContent(content), statePath)).rejects.toMatchObject({ code: 'EXTENSION_SKILL_BACKUP_UNSAFE' });
    }
    expect(await readFile(descriptor.absolutePath, 'utf8')).toBe(content);
    expect(await readdir(outside)).toEqual([]);
    expect(await readdir(otherSkills)).toEqual(['outside-link']);
  });

  it('reports cross-filesystem backups without removing the original skill', async () => {
    rename.mockRejectedValueOnce(Object.assign(new Error('cross device'), { code: 'EXDEV' }));
    await expect(removeSkillFiles(descriptor, hashConfigContent(content), stateDir)).rejects.toMatchObject({ code: 'EXTENSION_SKILL_BACKUP_CROSS_DEVICE' });
    expect(await readFile(descriptor.absolutePath, 'utf8')).toBe(content);
    expect(await readdir(path.join(stateDir, 'skill-backups'))).toEqual([]);
  });

  it('serializes manifest rename with the editor and rejects a save that would resurrect an empty file', async () => {
    await writeFile(descriptor.absolutePath, '');
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const hold = withConfigFileLock(descriptor.absolutePath, async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
    await ready;
    let alternateLocked = false;
    const alternate = withConfigFileLock(descriptor.absolutePath + '.riffet-disabled', async () => { alternateLocked = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(alternateLocked).toBe(false);
    const remove = removeSkillFiles(descriptor, hashConfigContent(''), stateDir);
    release();
    await hold;
    await alternate;
    await remove;
    await expect(writeExtensionFile(descriptor, { content: 'resurrect', expectedHash: hashConfigContent('') }, stateDir)).rejects.toMatchObject({ code: 'EXTENSION_DOCUMENT_NOT_FOUND' });
    await expect(atomicWriteConfigDocument({ stateDir, root, filePath: descriptor.absolutePath, previous: Buffer.alloc(0), content: 'resurrect', expectedHash: hashConfigContent('') })).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' });
    await expect(lstat(descriptor.absolutePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
