import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors.js';
import { hashConfigContent, MAX_CONFIG_DOCUMENT_BYTES, readConfigDocumentBytes, withConfigFileLock } from '../settings/config-documents.js';
import { assertWithin, isWithin } from '../workspace/scope.js';
import { rejectSymlinkPath } from './files.js';
import type { ExtensionDocumentDescriptor } from './types.js';

const MANIFEST = 'SKILL.md';
const DISABLED_MANIFEST = 'SKILL.md.riffet-disabled';

/** `trees`: the skills directories the backend's own layout declares, beyond the conventional ones below. */
async function skillPaths(descriptor: ExtensionDocumentDescriptor, trees: readonly string[]): Promise<{ manifest: string; directory: string; skillsRoot: string; lock: string }> {
  if (!descriptor.editable || !['user', 'project'].includes(descriptor.scope)) throw new AppError('EXTENSION_READ_ONLY', descriptor.reason ?? 'This skill is read-only', 403, undefined, descriptor.reason ? { subject: 'reason', reason: descriptor.reason } : { subject: 'skill' });
  const root = path.resolve(descriptor.root);
  const manifest = path.resolve(descriptor.absolutePath);
  assertWithin(root, manifest, 'EXTENSION_PATH_OUTSIDE_ROOT');
  if (path.resolve(root, descriptor.relativePath) !== manifest) throw new AppError('INVALID_EXTENSION_PATH', 'Skill descriptor paths disagree');
  const relative = path.relative(root, manifest).split(path.sep).join('/');
  // Classification directories are allowed, but skills/SKILL.md can never authorize
  // removing the whole skills tree. The manifest's immediate directory is the unit.
  const declared = trees.find(tree => relative.startsWith(`${tree}/`) && /^.+\/SKILL\.md(?:\.riffet-disabled)?$/.test(relative.slice(tree.length + 1)));
  const layout = declared ? [relative, declared] : relative.match(/^((?:\.(?:agents|claude|codex|factory|trae)\/)?skills)\/.+\/SKILL\.md(?:\.riffet-disabled)?$/);
  if (!layout) {
    throw new AppError('EXTENSION_SKILL_DIRECTORY_UNSAFE', 'Skill must have its own directory beneath a skills root', 409);
  }
  await rejectSymlinkPath(root, descriptor.relativePath);
  let directory: string;
  try { directory = await realpath(path.dirname(manifest)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('CONFIG_CONFLICT', 'Skill changed; reload before managing it', 409, undefined, { subject: 'skill' });
    throw error;
  }
  const skillsRoot = await realpath(path.join(root, layout[1]!));
  const realRoot = await realpath(root);
  assertWithin(realRoot, directory, 'EXTENSION_PATH_OUTSIDE_ROOT');
  for (let parent = path.dirname(directory); isWithin(skillsRoot, parent); parent = path.dirname(parent)) {
    for (const name of [MANIFEST, DISABLED_MANIFEST]) {
      try { await lstat(path.join(parent, name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      throw new AppError('EXTENSION_SKILL_DIRECTORY_UNSAFE', 'Skill directory is nested inside another skill', 409);
    }
    if (parent === skillsRoot) break;
  }
  return { manifest: path.join(directory, path.basename(manifest)), directory, skillsRoot, lock: path.join(directory, MANIFEST) };
}

async function checkedManifest(manifest: string, expectedHash: string): Promise<Buffer> {
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new AppError('EXPECTED_HASH_REQUIRED', 'A SHA-256 expectedHash is required');
  let info;
  try { info = await lstat(manifest); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('CONFIG_CONFLICT', 'Skill changed; reload before managing it', 409, undefined, { subject: 'skill' });
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new AppError('EXTENSION_SKILL_DIRECTORY_UNSAFE', 'Skill manifest must be a regular file', 409);
  const content = await readConfigDocumentBytes(manifest, MAX_CONFIG_DOCUMENT_BYTES, 'CONFIG_CONFLICT');
  const actualHash = hashConfigContent(content);
  if (actualHash !== expectedHash) throw new AppError('CONFIG_CONFLICT', 'Skill changed; reload before managing it', 409, { expectedHash, actualHash }, { subject: 'skill' });
  return content;
}

/** Resolve existing ancestors too, so a nonexistent state directory cannot hide a symlink into skills. */
async function resolveFuturePath(target: string): Promise<string> {
  let ancestor = path.resolve(target);
  while (true) {
    try { return path.resolve(await realpath(ancestor), path.relative(ancestor, target)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

async function backupRoot(stateDir: string, skillsRoot: string, folder: string): Promise<string> {
  const target = path.resolve(stateDir, folder);
  const statePath = path.resolve(stateDir);
  const canonicalState = await resolveFuturePath(statePath);
  const canonicalTarget = await resolveFuturePath(target);
  // A backup containing SKILL.md must not become a live skill in another Agent's
  // tree either. Check both spellings: a lexical skills ancestor may be a symlink.
  const insideSkills = (value: string) => value.split(path.sep).some(segment => segment.toLowerCase() === 'skills');
  if ([statePath, target, canonicalState, canonicalTarget].some(insideSkills)
    || isWithin(skillsRoot, canonicalState) || isWithin(skillsRoot, canonicalTarget)) {
    throw new AppError('EXTENSION_SKILL_BACKUP_UNSAFE', 'Skill backups must be outside the scanned skills tree', 409);
  }
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await rejectSymlinkPath(stateDir, folder);
  await mkdir(target, { recursive: true, mode: 0o700 });
  return target;
}

async function rejectNestedSkills(directory: string): Promise<void> {
  const visit = async (folder: string) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (folder !== directory && [MANIFEST, DISABLED_MANIFEST].includes(entry.name)) throw new AppError('EXTENSION_SKILL_DIRECTORY_UNSAFE', 'Skill directory contains another skill; remove it separately', 409);
      if (entry.isDirectory()) await visit(path.join(folder, entry.name));
      // Symbolic links are moved as links, never traversed or copied.
    }
  };
  await visit(directory);
}

export async function setSkillFileEnabled(descriptor: ExtensionDocumentDescriptor, enabled: boolean, expectedHash: string, stateDir: string, trees: readonly string[] = []): Promise<{ enabled: boolean; backupPath: string }> {
  const paths = await skillPaths(descriptor, trees);
  return withConfigFileLock(paths.lock, async () => {
    await rejectSymlinkPath(descriptor.root, descriptor.relativePath);
    const content = await checkedManifest(paths.manifest, expectedHash);
    const target = path.join(paths.directory, enabled ? MANIFEST : DISABLED_MANIFEST);
    if (target === paths.manifest) throw new AppError('EXTENSION_SKILL_STATE_UNCHANGED', 'Skill already has the requested state; reload before managing it', 409);
    const backups = await backupRoot(stateDir, paths.skillsRoot, path.join('config-backups', hashConfigContent(paths.lock).slice(0, 32)));
    const backupPath = path.join(backups, `${randomUUID()}.bak`);
    await writeFile(backupPath, content, { flag: 'wx', mode: 0o600 });
    await checkedManifest(paths.manifest, expectedHash);
    // link() gives an atomic no-overwrite destination, unlike POSIX rename().
    try { await link(paths.manifest, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError('CONFIG_CONFLICT', 'The alternate skill manifest already exists; no file was overwritten', 409, undefined, { subject: 'manifestExists' });
      throw error;
    }
    try { await unlink(paths.manifest); }
    catch (error) { await unlink(target).catch(() => undefined); throw error; }
    return { enabled, backupPath };
  });
}

export async function removeSkillFiles(descriptor: ExtensionDocumentDescriptor, expectedHash: string, stateDir: string, trees: readonly string[] = []): Promise<{ backupPath: string }> {
  const paths = await skillPaths(descriptor, trees);
  return withConfigFileLock(paths.lock, async () => {
    await rejectSymlinkPath(descriptor.root, descriptor.relativePath);
    await checkedManifest(paths.manifest, expectedHash);
    await rejectNestedSkills(paths.directory);
    const backupDirectory = await backupRoot(stateDir, paths.skillsRoot, path.join('skill-backups', randomUUID()));
    const backupPath = path.join(backupDirectory, 'skill');
    await checkedManifest(paths.manifest, expectedHash);
    await writeFile(path.join(backupDirectory, 'metadata.json'), JSON.stringify({ originalPath: paths.directory, manifest: path.basename(paths.manifest), hash: expectedHash, removedAt: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
    try { await rename(paths.directory, backupPath); }
    catch (error) {
      await rm(backupDirectory, { recursive: true, force: true }).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') throw new AppError('EXTENSION_SKILL_BACKUP_CROSS_DEVICE', 'Skill backup directory is on another filesystem; skill was not removed', 409);
      throw error;
    }
    return { backupPath };
  });
}
