import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UPDATE_CHECK_BUDGET, type BuildInfo, type ReleaseNote, type ReleaseNotes, type UpdateCheck } from '../../../../packages/contracts/src/index.js';
import { runProcess } from '../git/exec.js';
import { checkForUpdates, compareReleaseTags, gitEnvironment, parseReleaseTag } from './git.js';
import { checkNpmUpdate, isNpmInstall } from './npm.js';
import { SERVER_BUILD, SOURCE_ROOT } from '../version.js';

/*
 * Whether a newer release is out, as one answer for the CLI, the server and every client: a check (a Git
 * or npm registry lookup) is written to `<state>/update-check.json` and reused for
 * `UPDATE_CHECK_BUDGET.cacheHours`. Nobody waits for the network to learn that an update exists; only
 * an explicit "check now" does. A failed lookup keeps the last good answer and is retried after
 * `retryMinutes`, and whoever starts a background check first claims it so readers do not pile up.
 */

const CACHE_FILE = 'update-check.json';
const CACHE_MS = UPDATE_CHECK_BUDGET.cacheHours * 60 * 60 * 1000;
const RETRY_MS = UPDATE_CHECK_BUDGET.retryMinutes * 60 * 1000;

/** How this build is updated: from its Git checkout, from npm, or not by Riffet at all (the App's bundled payload). */
export type UpdateChannel = 'source' | 'npm' | 'none';
export const updateChannel = (): UpdateChannel => (isNpmInstall() ? 'npm' : SOURCE_ROOT ? 'source' : 'none');

const buildLabel = (build: BuildInfo) => build.tag ?? build.version;

/** One lookup, without the cache. */
export async function checkLatest(current: BuildInfo = SERVER_BUILD): Promise<UpdateCheck> {
  const channel = updateChannel();
  if (channel === 'npm') return checkNpmUpdate(current);
  if (channel === 'source') return checkForUpdates({ root: SOURCE_ROOT!, current });
  return { status: 'unavailable', current, latest: null, source: null };
}

/** `build` is the build the check describes; `attemptedAt` is when a background check last started. */
interface Cached { checkedAt?: string; build?: string; check?: UpdateCheck; attemptedAt?: string }

const age = (iso: string | undefined) => (iso ? Date.now() - Date.parse(iso) : Number.NaN);
const within = (iso: string | undefined, ms: number) => age(iso) <= ms; // false for a missing or unreadable time

function readFile(stateDir: string): Cached {
  try { return JSON.parse(readFileSync(join(stateDir, CACHE_FILE), 'utf8')) as Cached; } catch { return {}; }
}

function writeFile(stateDir: string, value: Cached): void {
  const path = join(stateDir, CACHE_FILE), temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value) + '\n', { mode: 0o600 }); renameSync(temp, path);
}

/**
 * The last check about `build` (the running server's), however old; `stale` once it is due again. A
 * result about another build (before an update or a restart) says nothing about this one.
 */
export function readCachedCheck(stateDir: string, build: BuildInfo = SERVER_BUILD): { check: UpdateCheck; stale: boolean } | undefined {
  const cached = readFile(stateDir);
  if (cached.build !== buildLabel(build) || !cached.check?.status || !cached.checkedAt) return undefined;
  const stale = cached.check.status === 'unavailable' || !within(cached.checkedAt, CACHE_MS);
  return { check: { ...cached.check, checkedAt: cached.checkedAt }, stale };
}

/**
 * Whether the caller should start a background check now: not when another one started within
 * `retryMinutes`. Claiming records the start, so the next reader waits for that one instead.
 */
export function claimBackgroundCheck(stateDir: string): boolean {
  const cached = readFile(stateDir);
  if (within(cached.attemptedAt, RETRY_MS)) return false;
  try { writeFile(stateDir, { ...cached, attemptedAt: new Date().toISOString() }); } catch { return false; }
  return true;
}

/**
 * Records a check for everyone else. A failed lookup does not replace a good answer about the same build:
 * a network blip must not hide an available update for a day.
 */
export function writeCachedCheck(stateDir: string, check: UpdateCheck): UpdateCheck {
  const checkedAt = new Date().toISOString();
  const previous = readFile(stateDir);
  const build = buildLabel(check.current);
  const keep = check.status === 'unavailable' && previous.build === build && previous.check?.status && previous.check.status !== 'unavailable';
  if (!keep) writeFile(stateDir, { checkedAt, build, check: { ...check, checkedAt: undefined }, attemptedAt: checkedAt });
  return { ...check, checkedAt };
}

/** Checks now and remembers the answer for everyone else. */
export async function refreshCachedCheck(stateDir: string): Promise<UpdateCheck> {
  return writeCachedCheck(stateDir, await checkLatest());
}

/** The newer release's tag, when the last check found one (`v0.7.1`), whatever the channel. */
export function availableTag(check: UpdateCheck | undefined): string | undefined {
  if (check?.status !== 'available') return undefined;
  return check.latest?.tag ?? (check.latestVersion ? `v${check.latestVersion}` : undefined);
}

// ---------------------------------------------------------------------------------------------------
// Release notes

const GITHUB = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;

/** The GitHub repository releases come from: the checkout's origin, or the npm package's `repository`. */
async function repository(): Promise<{ owner: string; name: string } | undefined> {
  let url: string | undefined;
  if (updateChannel() === 'npm') {
    try {
      const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { repository?: string | { url?: string } };
      url = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
    } catch { /* no manifest, no notes */ }
  } else if (SOURCE_ROOT) {
    const result = await runProcess('git', ['remote', 'get-url', 'origin'], { cwd: SOURCE_ROOT, env: gitEnvironment(), timeoutMs: 5000 });
    if (result.code === 0) url = result.stdout.trim();
  }
  const match = url ? GITHUB.exec(url) : null;
  return match ? { owner: match[1]!, name: match[2]! } : undefined;
}

/** The released sections of a CHANGELOG newer than `from` and up to `to`, newest first. */
export function changelogSections(markdown: string, from: string, to: string): ReleaseNote[] {
  const notes: ReleaseNote[] = [];
  for (const block of markdown.split(/^## /m).slice(1)) {
    const [heading = '', ...body] = block.split('\n');
    const match = /^(\d+\.\d+\.\d+)(?:\s+-\s+(\d{4}-\d\d-\d\d))?\s*$/.exec(heading.trim());
    if (!match) continue; // Unreleased
    const tag = `v${match[1]}`;
    if (!parseReleaseTag(tag) || compareReleaseTags(tag, from) <= 0 || compareReleaseTags(tag, to) > 0) continue;
    notes.push({ version: match[1]!, date: match[2] ?? null, markdown: body.join('\n').trim() });
  }
  return notes;
}

let notesCache: { key: string; notes: ReleaseNotes; at: number } | undefined;

/**
 * What changed between this build and `latest`, from the CHANGELOG at the latest release's tag, in the
 * reader's language when it has one. Kept for the one pair of versions it was asked about.
 */
export async function releaseNotes(latest: string, language: string): Promise<ReleaseNotes> {
  const from = SERVER_BUILD.tag && parseReleaseTag(SERVER_BUILD.tag) ? SERVER_BUILD.tag : `v${SERVER_BUILD.version}`;
  const file = /^zh/i.test(language) ? 'CHANGELOG.zh-CN.md' : 'CHANGELOG.md';
  const key = `${from}|${latest}|${file}`;
  // Notes found are kept; finding none (GitHub unreachable, an older tag) is asked again after a while.
  if (notesCache?.key === key && (notesCache.notes.notes.length || Date.now() - notesCache.at < RETRY_MS)) return notesCache.notes;
  const repo = await repository();
  if (!repo || !parseReleaseTag(latest) || !parseReleaseTag(from)) return { notes: [], compareUrl: null };
  const base = `https://github.com/${repo.owner}/${repo.name}`;
  // Only a release can be compared with a release; a development build has no tag on the forge.
  const compareUrl = SERVER_BUILD.tag && !SERVER_BUILD.dirty ? `${base}/compare/${from}...${latest}` : null;
  const read = async (name: string): Promise<string | undefined> => {
    try {
      const response = await fetch(`https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${latest}/${name}`, { signal: AbortSignal.timeout(UPDATE_CHECK_BUDGET.changelogReadMs) });
      if (!response.ok || !response.body || Number(response.headers.get('content-length') ?? 0) > UPDATE_CHECK_BUDGET.changelogBytes) return undefined;
      // Without a length (or when compressed), stop reading once the body is larger than the budget.
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        size += next.value.byteLength;
        if (size > UPDATE_CHECK_BUDGET.changelogBytes) { await reader.cancel(); return undefined; }
        chunks.push(next.value);
      }
      return Buffer.concat(chunks).toString('utf8');
    } catch { return undefined; }
  };
  // Older releases have only the English CHANGELOG; the notes are a courtesy, the update does not depend on them.
  const text = await read(file) ?? (file === 'CHANGELOG.md' ? undefined : await read('CHANGELOG.md'));
  const notes = text ? changelogSections(text, from, latest) : [];
  const value = { notes, compareUrl };
  notesCache = { key, notes: value, at: Date.now() };
  return value;
}
