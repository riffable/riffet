import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Project } from '../../../../packages/contracts/src/index.js';
import { assertWithin, isWithin, projectDirectory, resolveScopedPath } from '../../../../packages/plugin-api/src/kit/workspace.js';
import { AppError } from '../errors.js';
import { assertTaskWorkspaceAvailable } from '../task-workspaces/identity.js';

export type ProjectRef = Project | string;

export async function projectRoot(project: ProjectRef): Promise<string> {
  if (typeof project !== 'string') await assertTaskWorkspaceAvailable(project);
  return projectDirectory(project);
}

export { assertWithin, isWithin, resolveScopedPath };

export function toProjectRelative(root: string, target: string): string {
  assertWithin(root, target);
  const relative = path.relative(root, target);
  return relative.split(path.sep).join('/');
}

/**
 * Resolve an explicit absolute path that lives outside the project.
 *
 * Used for single-file read-only access (preview, editor hand-off, one file reference) so
 * the user can actually look at what the agent just produced — e.g. a screenshot in /tmp.
 * It stays deliberately narrow: the path must be absolute, must exist and must be a
 * regular file. No directory listing, no search, no globbing. Callers gate it on the
 * `allowOutsideRead` workbench setting so a LAN deployment can turn it back off.
 *
 * Only the image route supplies configured harness homes. Their normalized image objects can
 * be read, but explicit denied roots and unrelated credential stores still take precedence.
 */
export async function resolveExternalFile(input: string, deniedRoots: readonly string[] = [], harnessImageHomes: readonly string[] = []): Promise<string> {
  if (typeof input !== 'string' || !input || input.includes('\0')) throw new AppError('INVALID_PATH', 'Path is invalid');
  if (!path.isAbsolute(input)) throw new AppError('INVALID_PATH', 'An absolute path is required');
  let real: string;
  try { real = await realpath(path.resolve(input)); } catch { throw new AppError('FILE_NOT_FOUND', 'File does not exist', 404); }
  if (await isSecretPath(real, deniedRoots, true, harnessImageHomes)) throw new AppError('PATH_DENIED', 'This file holds credentials and cannot be read through the workbench', 403);
  let info;
  try { info = await stat(real); } catch { throw new AppError('FILE_NOT_FOUND', 'File does not exist', 404); }
  if (!info.isFile()) throw new AppError('NOT_A_FILE', 'Path is not a regular file');
  return real;
}

/**
 * Credential stores an authenticated client must never read through the single-file escape hatch,
 * whatever the `allowOutsideRead` setting says: reading one of them turns a paired phone into the
 * workbench's own access token, a backend API key or an SSH identity.
 */
const SECRET_HOME_DIRECTORIES = ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.config/gcloud', '.config/gh', '.riffet', '.local/share/riffet', '.trae'];
const SECRET_HOME_FILES = ['.netrc', '.git-credentials', '.npmrc', '.pypirc', '.claude.json', '.codex/auth.json', '.claude/.credentials.json', '.config/cursor/auth.json', '.factory/auth.json', '.claude/settings.json', '.cursor/cli-config.json', '.traecli.toml'];
const SECRET_NAME = /^(?:\.env(?:\..+)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|.+\.(?:pem|key|p12|pfx|keystore|jks))$/i;

/** [byName] also refuses any `.env` or key file by its name; a project's own copies are left readable. */
export async function isSecretPath(real: string, deniedRoots: readonly string[] = [], byName = true, harnessImageHomes: readonly string[] = []): Promise<boolean> {
  if (byName && SECRET_NAME.test(path.basename(real))) return true;
  const home = homedir();
  // Only real objects in configured stores qualify. Native path components avoid treating a
  // POSIX filename containing backslashes as a store, and canonical paths close symlink escapes.
  let harnessImage = false;
  const harnessHomes: string[] = [];
  for (const candidate of harnessImageHomes) {
    const resolved = await realpath(candidate).catch(() => undefined);
    if (!resolved) continue;
    harnessHomes.push(resolved);
    const parts = path.relative(resolved, real).split(path.sep);
    if (parts.length === 5 && parts[0] === 'attachments' && parts[1] === 'v1' && parts[2] === 'objects'
      && /^[0-9a-f]{64}$/.test(parts[4]!) && parts[3] === parts[4]!.slice(0, 2)) harnessImage = true;
  }
  // A DSH store may live in the Riffet config container. This exception never overrides the
  // active state directory, SSH stores or any other credential root, even when configured there.
  const configContainers = new Set(['.riffet'].map(item => path.join(home, item)));
  for (const candidate of [...deniedRoots, ...SECRET_HOME_DIRECTORIES.map(item => path.join(home, item))]) {
    const resolved = await realpath(candidate).catch(() => candidate);
    if (isWithin(resolved, real) && !(harnessImage && !deniedRoots.includes(candidate) && configContainers.has(candidate))) return true;
  }
  for (const candidate of SECRET_HOME_FILES.map(item => path.join(home, item))) {
    if (await realpath(candidate).catch(() => candidate) === real) return true;
  }
  if (!harnessImage && harnessHomes.some(candidate => isWithin(candidate, real))) return true;
  return false;
}

/**
 * Resolve a path for reading. Project paths keep the strict scoping; an explicit absolute
 * path outside the project falls back to the relaxed single-file read when allowed.
 */
export async function resolveReadablePath(root: string, input: string, allowOutside = false, deniedRoots: readonly string[] = [], harnessImageHomes: readonly string[] = []): Promise<string> {
  if (allowOutside && path.isAbsolute(input) && !isWithin(root, path.resolve(input))) return resolveExternalFile(input, deniedRoots, harnessImageHomes);
  const target = await resolveScopedPath(root, input);
  // A project rooted at the home directory (or above the state directory) holds the same stores.
  const real = await realpath(target).catch(() => target);
  if (await isSecretPath(real, deniedRoots, false, harnessImageHomes)) throw new AppError('PATH_DENIED', 'This file holds credentials and cannot be read through the workbench', 403);
  // Trusted-store reads must use the canonical path whose credential policy was checked.
  return harnessImageHomes.length ? real : target;
}
