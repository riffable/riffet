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
export async function resolveExternalFile(input: string, deniedRoots: readonly string[] = [], harnessImageHomes: readonly string[] = [], artifactStateDir?: string, generatedImageHomes: readonly string[] = []): Promise<string> {
  if (typeof input !== 'string' || !input || input.includes('\0')) throw new AppError('INVALID_PATH', 'Path is invalid');
  if (!path.isAbsolute(input)) throw new AppError('INVALID_PATH', 'An absolute path is required');
  let real: string;
  try { real = await realpath(path.resolve(input)); } catch { throw new AppError('FILE_NOT_FOUND', 'File does not exist', 404); }
  if (await isSecretPath(real, deniedRoots, true, harnessImageHomes, artifactStateDir, generatedImageHomes)) throw new AppError('PATH_DENIED', 'This file holds credentials and cannot be read through the workbench', 403);
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
const SESSION_ARTIFACT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const GENERATED_IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}\.(?:png|jpe?g|gif|webp|bmp|avif)$/i;

/**
 * Whether `real` is a regular generated-image artifact written by Codex under
 * `<codexHome>/generated_images/<threadId>/<imageFile>`.
 */
async function isGeneratedImagePath(real: string, generatedImageHomes: readonly string[]): Promise<boolean> {
  if (!generatedImageHomes.length || SECRET_NAME.test(path.basename(real))) return false;
  for (const candidate of generatedImageHomes) {
    const resolved = await realpath(candidate).catch(() => undefined);
    if (!resolved) continue;
    const rel = path.relative(resolved, real);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const parts = rel.split(path.sep);
    if (parts.length === 3 && parts[0] === 'generated_images' && SESSION_ARTIFACT_SEGMENT.test(parts[1]!) && GENERATED_IMAGE_NAME.test(parts[2]!)) return true;
  }
  return false;
}

/**
 * Session-scoped agent output files written inside a protected Riffet/harness directory:
 * - Active `stateDir`: Antigravity's `antigravity-cli/brain/<conversationId>/` and Cursor standing's
 *   `plans/`, `projects/<slug>/terminals/`, `projects/<slug>/agent-tools/`.
 * - User home: TRAE CLI's `~/.trae/cli/plans/`.
 * Always rejects credential filenames (`.env`, keys) regardless of `byName`.
 */
async function readableArtifactRoot(artifactStateDir: string | undefined, real: string, home: string): Promise<{ root: string; kind: 'state' | 'trae' } | undefined> {
  if (!artifactStateDir || SECRET_NAME.test(path.basename(real))) return undefined;
  const resolvedStateDir = await realpath(artifactStateDir).catch(() => path.resolve(artifactStateDir));
  const stateRel = path.relative(resolvedStateDir, real);
  if (stateRel && !stateRel.startsWith('..') && !path.isAbsolute(stateRel)) {
    const parts = stateRel.split(path.sep);
    // `<stateDir>/plugin-data/riffet.antigravity/sessions/<sessionId>/native/antigravity-cli/brain/<conversationId>/<file...>`
    if (parts.length >= 9
      && parts[0] === 'plugin-data'
      && parts[1] === 'riffet.antigravity'
      && parts[2] === 'sessions'
      && SESSION_ARTIFACT_SEGMENT.test(parts[3]!)
      && parts[4] === 'native'
      && parts[5] === 'antigravity-cli'
      && parts[6] === 'brain'
      && SESSION_ARTIFACT_SEGMENT.test(parts[7]!)) {
      return { root: resolvedStateDir, kind: 'state' };
    }
    // `<stateDir>/cursor-standing/plans/<file...>`
    // `<stateDir>/cursor-standing/projects/<slug>/(terminals|agent-tools)/<file...>`
    if (parts[0] === 'cursor-standing' && (
      (parts.length >= 3 && parts[1] === 'plans')
      || (parts.length >= 5 && parts[1] === 'projects' && SESSION_ARTIFACT_SEGMENT.test(parts[2]!) && (parts[3] === 'terminals' || parts[3] === 'agent-tools'))
    )) {
      return { root: resolvedStateDir, kind: 'state' };
    }
  }
  const traeDir = path.join(home, '.trae');
  const resolvedTrae = await realpath(traeDir).catch(() => traeDir);
  const traeRel = path.relative(resolvedTrae, real);
  if (traeRel && !traeRel.startsWith('..') && !path.isAbsolute(traeRel)) {
    const parts = traeRel.split(path.sep);
    if (parts.length >= 3 && parts[0] === 'cli' && parts[1] === 'plans') {
      return { root: resolvedTrae, kind: 'trae' };
    }
  }
  return undefined;
}

/** [byName] also refuses any `.env` or key file by its name; a project's own copies are left readable. */
export async function isSecretPath(real: string, deniedRoots: readonly string[] = [], byName = true, harnessImageHomes: readonly string[] = [], artifactStateDir?: string, generatedImageHomes: readonly string[] = []): Promise<boolean> {
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
  const generatedImage = await isGeneratedImagePath(real, generatedImageHomes);
  const artifact = await readableArtifactRoot(artifactStateDir, real, home);
  // A DSH store or Codex home may live in the Riffet config container. This exception never overrides the
  // active state directory, SSH stores or any other credential root, even when configured there.
  const configContainers = new Set(['.riffet'].map(item => path.join(home, item)));
  const stateContainers = new Set(['.riffet', '.local/share/riffet'].map(item => path.join(home, item)));
  for (const candidate of [...deniedRoots, ...SECRET_HOME_DIRECTORIES.map(item => path.join(home, item))]) {
    const resolved = await realpath(candidate).catch(() => candidate);
    if (!isWithin(resolved, real)) continue;
    if ((harnessImage || generatedImage) && !deniedRoots.includes(candidate) && configContainers.has(candidate)) continue;
    if (artifact?.kind === 'state' && (resolved === artifact.root || (stateContainers.has(candidate) && isWithin(resolved, artifact.root)))) continue;
    if (artifact?.kind === 'trae' && !deniedRoots.includes(candidate) && resolved === artifact.root) continue;
    return true;
  }
  for (const candidate of SECRET_HOME_FILES.map(item => path.join(home, item))) {
    if (await realpath(candidate).catch(() => candidate) === real) return true;
  }
  if (!harnessImage && harnessHomes.some(candidate => isWithin(candidate, real))) return true;
  return false;
}

/**
 * Expand a leading `~` or `~/` to the server user's home directory, mirroring project picker and
 * settings inputs. Bare `~user/...` stays untouched.
 */
export function expandHomePath(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return path.join(homedir(), input.slice(2));
  return input;
}

/**
 * Resolve a path for reading. Project paths keep the strict scoping; an explicit absolute
 * (or `~/`) path outside the project falls back to the relaxed single-file read when allowed.
 * Read-only image callers may also pass `generatedImageHomes` to allow agent-generated images
 * under `<home>/generated_images/<thread>/<image>` even when general outside reads are disabled.
 */
export async function resolveReadablePath(root: string, input: string, allowOutside = false, deniedRoots: readonly string[] = [], harnessImageHomes: readonly string[] = [], artifactStateDir?: string, generatedImageHomes: readonly string[] = []): Promise<string> {
  const expanded = typeof input === 'string' ? expandHomePath(input) : input;
  if (path.isAbsolute(expanded) && !isWithin(root, path.resolve(expanded))) {
    if (allowOutside) return resolveExternalFile(expanded, deniedRoots, harnessImageHomes, artifactStateDir, generatedImageHomes);
    if (generatedImageHomes.length) {
      const real = await realpath(path.resolve(expanded)).catch(() => undefined);
      if (real && await isGeneratedImagePath(real, generatedImageHomes)) {
        return resolveExternalFile(expanded, deniedRoots, harnessImageHomes, artifactStateDir, generatedImageHomes);
      }
    }
  }
  const target = await resolveScopedPath(root, expanded);
  // A project rooted at the home directory (or above the state directory) holds the same stores.
  const real = await realpath(target).catch(() => target);
  if (await isSecretPath(real, deniedRoots, false, harnessImageHomes, artifactStateDir, generatedImageHomes)) throw new AppError('PATH_DENIED', 'This file holds credentials and cannot be read through the workbench', 403);
  // Trusted-store reads must use the canonical path whose credential policy was checked.
  if (harnessImageHomes.length || generatedImageHomes.length || (artifactStateDir && await readableArtifactRoot(artifactStateDir, real, homedir()))) return real;
  return target;
}
