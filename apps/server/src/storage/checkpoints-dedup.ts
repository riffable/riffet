import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { link, lstat, mkdir, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface CheckpointDedupResult {
  projects: number;
  linkedFiles: number;
  savedBytes: number;
  prunedObjects: number;
}

const UUID_DIR = /^[a-f0-9-]{36}$/i;
const BLOB_FILE = /^blob-[a-f0-9]{64}$/;
const STALE_LINKTMP = /^\.blob-.*\.linktmp$/;
const STALE_OBJTMP = /^\.blob-.*\.tmp$/;
const ORPHAN_GRACE_MS = 5 * 60_000;

/**
 * Deduplicates legacy independent `blob-<sha256>` copies across each project's completed checkpoints
 * (directories with `manifest.json`) by atomically hard-linking them to `<project>/.objects/blob-<sha256>`
 * (matching `GitService.storeBlob`), and removes stale temp files and unreferenced objects (`nlink <= 1`).
 *
 * Yields to the event loop between checkpoints so online maintenance stays responsive.
 */
export async function deduplicateCheckpoints(stateDir: string): Promise<CheckpointDedupResult> {
  const root = join(stateDir, 'checkpoints');
  const result: CheckpointDedupResult = { projects: 0, linkedFiles: 0, savedBytes: 0, prunedObjects: 0 };
  let projectDirs: string[];
  try { projectDirs = await readdir(root); } catch { return result; }
  const cutoff = Date.now() - ORPHAN_GRACE_MS;

  for (const projectName of projectDirs) {
    const projectDir = join(root, projectName);
    const pInfo = await lstat(projectDir).catch(() => undefined);
    if (!pInfo?.isDirectory()) continue;
    const entries = await readdir(projectDir).catch(() => [] as string[]);
    const checkpoints = entries.filter(name => UUID_DIR.test(name));
    if (!checkpoints.length) continue;
    result.projects += 1;

    const objectsDir = join(projectDir, '.objects');
    try { await mkdir(objectsDir, { recursive: true, mode: 0o700 }); } catch { continue; }

    let linkUnsupported = false;
    for (const cp of checkpoints) {
      if (linkUnsupported) break;
      const cpDir = join(projectDir, cp);
      // Skip in-progress checkpoints that have not committed `manifest.json` yet.
      if (!await lstat(join(cpDir, 'manifest.json')).then(info => info.isFile(), () => false)) continue;
      const files = await readdir(cpDir).catch(() => [] as string[]);
      for (const name of files) {
        if (STALE_LINKTMP.test(name)) {
          const tmpPath = join(cpDir, name);
          const tmpInfo = await lstat(tmpPath).catch(() => undefined);
          if (tmpInfo?.isFile() && tmpInfo.mtimeMs < cutoff) await unlink(tmpPath).catch(() => undefined);
          continue;
        }
        if (!BLOB_FILE.test(name)) continue;
        const filePath = join(cpDir, name);
        const info = await lstat(filePath).catch(() => undefined);
        if (!info || info.isSymbolicLink() || !info.isFile()) continue;

        const shared = join(objectsDir, name);
        const sharedInfo = await lstat(shared).catch(() => undefined);
        if (!sharedInfo) {
          try { await link(filePath, shared); }
          catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EXDEV' || code === 'EPERM' || code === 'ENOTSUP' || code === 'ENOSYS') { linkUnsupported = true; break; }
          }
          continue;
        }
        if (sharedInfo.isSymbolicLink() || !sharedInfo.isFile()) continue;
        if (sharedInfo.dev === info.dev && sharedInfo.ino === info.ino) continue;
        if (sharedInfo.size !== info.size) continue;

        const temp = join(cpDir, `.${name}.${process.pid}.${randomUUID().slice(0, 8)}.linktmp`);
        try {
          await link(shared, temp);
          await rename(temp, filePath);
          result.linkedFiles += 1;
          if (info.nlink === 1) result.savedBytes += typeof info.blocks === 'number' ? info.blocks * 512 : info.size;
        } catch (error) {
          await unlink(temp).catch(() => undefined);
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EXDEV' || code === 'EPERM' || code === 'ENOTSUP' || code === 'ENOSYS') { linkUnsupported = true; break; }
        }
      }
      await new Promise<void>(resolve => setImmediate(resolve));
    }

    for (const name of await readdir(objectsDir).catch(() => [] as string[])) {
      const isObj = BLOB_FILE.test(name);
      const isTmp = STALE_OBJTMP.test(name);
      if (!isObj && !isTmp) continue;
      const entry = join(objectsDir, name);
      const info = await lstat(entry).catch(() => undefined);
      if (info?.isFile() && info.mtimeMs < cutoff && (isTmp || info.nlink <= 1)) {
        await unlink(entry).catch(() => undefined);
        result.prunedObjects += 1;
      }
    }
  }
  return result;
}

/** Synchronous variant used during offline `compactDatabase` (`riffet doctor --compact`). */
export function deduplicateCheckpointsSync(stateDir: string): CheckpointDedupResult {
  const root = join(stateDir, 'checkpoints');
  const result: CheckpointDedupResult = { projects: 0, linkedFiles: 0, savedBytes: 0, prunedObjects: 0 };
  if (!existsSync(root)) return result;
  let projectDirs: string[];
  try { projectDirs = readdirSync(root); } catch { return result; }
  const cutoff = Date.now() - ORPHAN_GRACE_MS;

  for (const projectName of projectDirs) {
    const projectDir = join(root, projectName);
    let pInfo;
    try { pInfo = lstatSync(projectDir); } catch { continue; }
    if (!pInfo.isDirectory()) continue;
    let entries: string[];
    try { entries = readdirSync(projectDir); } catch { continue; }
    const checkpoints = entries.filter(name => UUID_DIR.test(name));
    if (!checkpoints.length) continue;
    result.projects += 1;

    const objectsDir = join(projectDir, '.objects');
    try { mkdirSync(objectsDir, { recursive: true, mode: 0o700 }); } catch { continue; }

    let linkUnsupported = false;
    for (const cp of checkpoints) {
      if (linkUnsupported) break;
      const cpDir = join(projectDir, cp);
      let hasManifest = false;
      try { hasManifest = lstatSync(join(cpDir, 'manifest.json')).isFile(); } catch { hasManifest = false; }
      if (!hasManifest) continue;
      let files: string[];
      try { files = readdirSync(cpDir); } catch { continue; }
      for (const name of files) {
        if (STALE_LINKTMP.test(name)) {
          const tmpPath = join(cpDir, name);
          try { if (lstatSync(tmpPath).mtimeMs < cutoff) unlinkSync(tmpPath); } catch { /* ignore */ }
          continue;
        }
        if (!BLOB_FILE.test(name)) continue;
        const filePath = join(cpDir, name);
        let info;
        try { info = lstatSync(filePath); } catch { continue; }
        if (info.isSymbolicLink() || !info.isFile()) continue;

        const shared = join(objectsDir, name);
        let sharedInfo;
        try { sharedInfo = lstatSync(shared); } catch { sharedInfo = undefined; }
        if (!sharedInfo) {
          try { linkSync(filePath, shared); }
          catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EXDEV' || code === 'EPERM' || code === 'ENOTSUP' || code === 'ENOSYS') { linkUnsupported = true; break; }
          }
          continue;
        }
        if (sharedInfo.isSymbolicLink() || !sharedInfo.isFile()) continue;
        if (sharedInfo.dev === info.dev && sharedInfo.ino === info.ino) continue;
        if (sharedInfo.size !== info.size) continue;

        const temp = join(cpDir, `.${name}.${process.pid}.${randomUUID().slice(0, 8)}.linktmp`);
        try {
          linkSync(shared, temp);
          renameSync(temp, filePath);
          result.linkedFiles += 1;
          if (info.nlink === 1) result.savedBytes += typeof info.blocks === 'number' ? info.blocks * 512 : info.size;
        } catch (error) {
          try { unlinkSync(temp); } catch { /* ignore */ }
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EXDEV' || code === 'EPERM' || code === 'ENOTSUP' || code === 'ENOSYS') { linkUnsupported = true; break; }
        }
      }
    }

    let objFiles: string[];
    try { objFiles = readdirSync(objectsDir); } catch { continue; }
    for (const name of objFiles) {
      const isObj = BLOB_FILE.test(name);
      const isTmp = STALE_OBJTMP.test(name);
      if (!isObj && !isTmp) continue;
      const entry = join(objectsDir, name);
      try {
        const info = lstatSync(entry);
        if (info.isFile() && info.mtimeMs < cutoff && (isTmp || info.nlink <= 1)) {
          unlinkSync(entry);
          result.prunedObjects += 1;
        }
      } catch { /* ignore */ }
    }
  }
  return result;
}
