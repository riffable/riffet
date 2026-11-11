import type { BuildInfo, ReleaseTag, SourceInfo, UpdateCheck } from '@contracts';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { runProcess, type ProcessResult } from './git/exec.js';

const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$(?!\s)/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const gitEnvironment = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_ASKPASS: 'false', SSH_ASKPASS_REQUIRE: 'never' };
  // The selected clone, not a repository inherited from an enclosing terminal/agent, is authoritative.
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
  return env;
};

export function parseReleaseTag(tag: string): { major: string; minor: string; patch: string } | null {
  const match = STABLE_TAG.exec(tag);
  return match ? { major: match[1], minor: match[2], patch: match[3] } : null;
}

/** Decimal strings keep even unusually large valid version segments exact. */
export function compareReleaseTags(a: string, b: string): number {
  const left = parseReleaseTag(a);
  const right = parseReleaseTag(b);
  if (!left || !right) throw new Error('Expected stable release tags');
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key].length !== right[key].length) return left[key].length > right[key].length ? 1 : -1;
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  return 0;
}

function ensureSuccess(result: ProcessResult, action: string, allowMissing = false): string {
  if (result.timedOut) throw new Error(`${action} timed out. Check Git connectivity and authentication in a terminal.`);
  if (result.truncated) throw new Error(`${action} exceeded the output limit.`);
  if (result.code !== 0 && !(allowMissing && result.code === 1 && !result.stdout && !result.stderr)) {
    // Git stderr can contain credential-bearing remote URLs or local paths; never return it to clients.
    throw new Error(`${action} failed. Check the source repository, origin and Git authentication in a terminal.`);
  }
  return result.stdout;
}

async function git(root: string, args: string[], action: string, options: { allowMissing?: boolean; timeoutMs?: number } = {}): Promise<string> {
  return ensureSuccess(await runProcess('git', args, { cwd: root, env: gitEnvironment(), timeoutMs: options.timeoutMs ?? 15_000 }), action, options.allowMissing);
}

async function assertSourceRoot(root: string): Promise<void> {
  const actual = await git(root, ['rev-parse', '--show-toplevel'], 'Read source repository');
  if (await realpath(root) !== await realpath(actual.trim())) throw new Error('The configured directory is not the source repository root.');
}

export async function readSourceInfo(root: string): Promise<SourceInfo> {
  await assertSourceRoot(root);
  const commit = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'], 'Read source commit')).trim();
  const dirty = Boolean(await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], 'Read source changes'));
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version?: unknown };
  const expected = `v${pkg.version}`;
  const tags = await localReleaseTags(root);
  const tag = parseReleaseTag(expected) && tags.get(expected)?.commit === commit ? expected : null;
  return { commit: OBJECT_ID.test(commit) ? commit : null, tag, dirty };
}

function parseRemoteTags(output: string): ReleaseTag[] {
  const refs = new Map<string, { objectId?: string; peeled?: string }>();
  for (const line of output.split('\n')) {
    if (!line) continue;
    const match = /^([^\t]+)\trefs\/tags\/(.+?)(\^\{\})?$/.exec(line);
    if (!match || !OBJECT_ID.test(match[1])) throw new Error('Git returned an invalid tag advertisement.');
    const [, objectId, name, peeled] = match;
    if (!parseReleaseTag(name)) continue;
    const ref = refs.get(name) ?? {};
    const key = peeled ? 'peeled' : 'objectId';
    if (ref[key] && ref[key] !== objectId) throw new Error('Git returned conflicting release tag advertisements.');
    ref[key] = objectId;
    refs.set(name, ref);
  }
  return [...refs].map(([tag, ref]) => {
    if (!ref.objectId) throw new Error('Git returned a peeled tag without its tag object.');
    return { tag, version: tag.slice(1), commit: ref.peeled ?? ref.objectId, objectId: ref.objectId };
  }).sort((a, b) => compareReleaseTags(b.tag, a.tag));
}

async function localReleaseTags(root: string): Promise<Map<string, ReleaseTag>> {
  const output = await git(root, ['show-ref', '--tags', '-d'], 'Read local release tags', { allowMissing: true });
  // show-ref uses a space; ls-remote uses a tab. The ref/peel format is otherwise identical.
  return new Map(parseRemoteTags(output.replace(/^([0-9a-f]+) /gm, '$1\t')).map(tag => [tag.tag, tag]));
}

export async function checkForUpdates({ root, current }: { root: string; current: BuildInfo }): Promise<UpdateCheck> {
  let source: SourceInfo | null = null;
  let latest: ReleaseTag | null = null;
  const currentReleaseTag = current.tag && parseReleaseTag(current.tag) && current.tag === `v${current.version}`
    && current.commit && OBJECT_ID.test(current.commit) && !current.dirty ? current.tag : null;
  try {
    source = await readSourceInfo(root);
    const remote = parseRemoteTags(await git(root, ['ls-remote', '--tags', 'origin', 'refs/tags/v*'], 'Query release tags'));
    latest = remote[0] ?? null;
    const local = await localReleaseTags(root);
    for (const release of remote) {
      const existing = local.get(release.tag);
      if ((existing && (existing.objectId !== release.objectId || existing.commit !== release.commit))
        || (currentReleaseTag === release.tag && current.commit !== release.commit)) {
        return { status: 'conflict', current, latest, source, message: `Release tag ${release.tag} differs from the previously recorded tag. Resolve it manually before updating.` };
      }
    }
    if (!latest) return { status: 'no-releases', current, latest, source };
    if (!currentReleaseTag) {
      return { status: 'development', current, latest, source };
    }
    const order = compareReleaseTags(currentReleaseTag, latest.tag);
    return { status: order < 0 ? 'available' : order > 0 ? 'ahead' : 'current', current, latest, source };
  } catch (error) {
    // Only intentionally sanitized Git errors may be exposed; filesystem errors may include paths.
    const message = error instanceof Error && /^(Read |Query |Git returned|The configured)/.test(error.message)
      ? error.message : 'Unable to inspect the source repository. Check its Git configuration in a terminal.';
    return { status: 'unavailable', current, latest: null, source, message };
  }
}

export interface ReleasePackage {
  name: 'riffet';
  version: string;
  buildNumber: number;
  engines?: { node?: string; [key: string]: unknown };
  packageManager?: string;
}

/** Mutating phase: fetch only the selected immutable tag, never a branch or a forced tag. */
export async function fetchRelease(root: string, release: ReleaseTag): Promise<ReleasePackage> {
  if (!parseReleaseTag(release.tag) || release.version !== release.tag.slice(1) || !OBJECT_ID.test(release.objectId) || !OBJECT_ID.test(release.commit)) {
    throw new Error('Invalid target release.');
  }
  await assertSourceRoot(root);
  const existing = (await localReleaseTags(root)).get(release.tag);
  if (existing && (existing.objectId !== release.objectId || existing.commit !== release.commit)) throw new Error('The local release tag conflicts with the selected remote release.');
  const ref = `refs/tags/${release.tag}`;
  await git(root, ['fetch', '--no-tags', 'origin', `${ref}:${ref}`], 'Fetch selected release', { timeoutMs: 60_000 });
  const objectId = (await git(root, ['rev-parse', '--verify', ref], 'Read fetched release object')).trim();
  const commit = (await git(root, ['rev-parse', '--verify', `${ref}^{commit}`], 'Read fetched release commit')).trim();
  if (objectId !== release.objectId || commit !== release.commit) throw new Error('The release tag changed after checking; no source files were switched. Check again.');
  const pkg: unknown = JSON.parse(await git(root, ['show', `${commit}:package.json`], 'Read release package'));
  if (!pkg || typeof pkg !== 'object' || !('name' in pkg) || pkg.name !== 'riffet') throw new Error('The release is not a Riffet package. Check the origin repository.');
  if (!('version' in pkg) || pkg.version !== release.version) throw new Error('The release tag does not match package.json.version.');
  const metadata = pkg as ReleasePackage;
  if (!Number.isSafeInteger(metadata.buildNumber) || metadata.buildNumber <= 0) throw new Error('The release contains an invalid buildNumber.');
  if ((metadata.packageManager !== undefined && typeof metadata.packageManager !== 'string')
    || (metadata.engines !== undefined && (typeof metadata.engines !== 'object' || metadata.engines === null || Array.isArray(metadata.engines) || (metadata.engines.node !== undefined && typeof metadata.engines.node !== 'string')))) {
    throw new Error('The release contains invalid toolchain metadata.');
  }
  return metadata;
}
