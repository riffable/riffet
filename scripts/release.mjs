#!/usr/bin/env node
// Release bookkeeping, in plain Node so the release workflow can run it before installing anything.
// The process it implements is docs/RELEASE.md.
//
//   pnpm release:notes                  user-facing commits since the last release, to write "Unreleased" from
//   pnpm release:prepare 0.8.0-beta.1   check, bump, (stable: date the changelogs), commit and tag; no push
//   node scripts/release.mjs check v0.8.0 [--notes <file>]
//                                       what the release workflow verifies before building anything
//   node scripts/release.mjs changelog <base>..<head>
//                                       CI: warns when user-facing commits leave both changelogs untouched
//
// Stable releases move the "Unreleased" sections of CHANGELOG.md and CHANGELOG.zh-CN.md under the
// version. A beta leaves them in place: its notes are the upcoming release's sections as they are at
// the beta's commit, so the changelogs only ever list stable versions.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHANGELOGS = [
  { path: 'CHANGELOG.md', unreleased: 'Unreleased', language: 'English' },
  { path: 'CHANGELOG.zh-CN.md', unreleased: '未发布', language: '简体中文' },
];
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$(?!\s)/;

// `feat`, `fix` and `perf` reach users, except for the repository's own tooling.
const USER_FACING = /^\S+ (feat|fix|perf)(\((?!(?:ci|scripts|tests|build)\))[^)]*\))?!?:/;

const fail = (message) => { console.error(`release: ${message}`); process.exit(1); };
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (...args) => { try { return git(...args); } catch { return null; } };

/** { major, minor, patch, beta } with beta null for a stable version; null when not a release version. */
function parse(version) {
  const match = VERSION.exec(version);
  return match ? { major: +match[1], minor: +match[2], patch: +match[3], beta: match[4] ? +match[4] : null } : null;
}
/** Semver order restricted to our grammar: a beta precedes the stable version it leads to. */
function compare(a, b) {
  const x = parse(a), y = parse(b);
  for (const key of ['major', 'minor', 'patch']) if (x[key] !== y[key]) return x[key] - y[key];
  if (x.beta === y.beta) return 0;
  if (x.beta === null) return 1;
  if (y.beta === null) return -1;
  return x.beta - y.beta;
}
const core = (version) => version.replace(/-.*/, '');
const releaseTags = () => (tryGit('tag', '--list', 'v*') ?? '').split('\n').filter((tag) => parse(tag.slice(1))).map((tag) => tag.slice(1));

/** The newest stable version older than `version`'s MAJOR.MINOR.PATCH: what this release is compared with. */
function previousStable(version, tags = releaseTags()) {
  return tags.filter((tag) => parse(tag).beta === null && compare(tag, core(version)) < 0).sort(compare).at(-1) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Changelogs

function sections(text) {
  const result = [];
  const lines = text.split('\n');
  let current = null;
  for (const line of lines) {
    const heading = /^## (.+?)\s*$/.exec(line);
    if (heading) { current = { title: heading[1], body: [] }; result.push(current); }
    else if (current) current.body.push(line);
  }
  return result.map(({ title, body }) => ({ title, body: body.join('\n').trim() }));
}
const sectionOf = (text, name) => sections(text).find(({ title }) => title === name || title.startsWith(`${name} - `)) ?? null;
const readChangelog = (path, ref) => ref ? tryGit('show', `${ref}:${path}`) : readFileSync(resolve(root, path), 'utf8');

/**
 * Each changelog's notes for `version`: its dated section for a released stable, the unreleased one
 * for a beta, or for a stable that is still being prepared (`pending`).
 */
function notesFor(version, ref, pending = false) {
  return CHANGELOGS.map((log) => {
    const text = readChangelog(log.path, ref);
    if (text === null) fail(`${log.path} does not exist${ref ? ` at ${ref}` : ''}`);
    const name = parse(version).beta === null && !pending ? version : log.unreleased;
    const section = sectionOf(text, name);
    if (!section?.body) fail(`${log.path} has no notes under "## ${name}"`);
    return { ...log, body: section.body };
  });
}

/** The GitHub release body (and, rendered, the Sparkle release notes): English, then the translation folded. */
function releaseNotes(notes) {
  const [english, ...others] = notes;
  return [english.body, ...others.map(({ language, body }) => `<details>\n<summary>${language}</summary>\n\n${body}\n\n</details>`)].join('\n\n') + '\n';
}

function dateChangelogs(version, date) {
  for (const log of CHANGELOGS) {
    const path = resolve(root, log.path);
    const text = readFileSync(path, 'utf8');
    const heading = new RegExp(`^## ${log.unreleased}[ \\t]*$`, 'm');
    if (!heading.test(text)) fail(`${log.path} has no "## ${log.unreleased}" heading`);
    writeFileSync(path, text.replace(heading, `## ${log.unreleased}\n\n## ${version} - ${date}`));
  }
}

// ---------------------------------------------------------------------------------------------
// Compatibility: what makes a release more than a PATCH (docs/RELEASE.md, "Version numbers")

const SIGNALS = [
  { name: 'database schema', path: 'apps/server/src/store.ts', read: (text) => /^const SCHEMA_VERSION = (\d+);/m.exec(text)?.[1] },
  { name: 'plugin API', path: 'packages/plugin-api/src/index.ts', read: (text) => /export const PLUGIN_API_VERSION = (\d+);/.exec(text)?.[1] },
  { name: 'agent protocol', path: 'packages/plugin-api/src/agent.ts', read: (text) => /export const AGENT_PROTOCOL_VERSION = (\d+);/.exec(text)?.[1] },
  { name: 'wire protocol version', path: 'packages/contracts/src/protocol.ts', read: (text) => /PROTOCOL_INFO: ProtocolInfo = \{ version: (\d+)/.exec(text)?.[1] },
  {
    name: 'wire protocol features', path: 'packages/contracts/src/protocol.ts',
    read: (text) => /PROTOCOL_INFO: ProtocolInfo = \{[^}]*features: \[([^\]]*)\]/.exec(text)?.[1].match(/'[^']+'/g)?.sort().join(','),
    // Adding a feature is compatible; removing one is not.
    breaks: (before, after) => before.split(',').some((feature) => !after.split(',').includes(feature)),
    describe: (before, after) => `removed ${before.split(',').filter((feature) => !after.split(',').includes(feature)).join(', ')}`,
  },
  { name: 'Node.js requirement', path: 'package.json', read: (text) => JSON.parse(text).engines?.node },
  { name: 'macOS requirement', path: 'apps/macos/project.yml', read: (text) => /deploymentTarget:\s*\n\s*macOS:\s*"?([\d.]+)/.exec(text)?.[1] },
  { name: 'iOS requirement', path: 'apps/mobile/iosApp/project.yml', read: (text) => /deploymentTarget:\s*\n\s*iOS:\s*"?([\d.]+)/.exec(text)?.[1] },
  { name: 'Android requirement', path: 'apps/mobile/gradle/libs.versions.toml', read: (text) => /^androidMinSdk = "(\d+)"/m.exec(text)?.[1] },
];

/** The changes since `base` that a PATCH may not carry. */
function incompatibleChanges(base, ref) {
  const read = (path, at) => at ? tryGit('show', `${at}:${path}`) : readFileSync(resolve(root, path), 'utf8');
  const changes = [];
  for (const signal of SIGNALS) {
    const before = read(signal.path, base);
    const after = read(signal.path, ref);
    if (before === null || after === null) continue;
    const [was, now] = [signal.read(before), signal.read(after)];
    if (now === undefined) fail(`${signal.path}: cannot read the ${signal.name}; update SIGNALS in scripts/release.mjs`);
    if (was === undefined || was === now) continue;
    if (signal.breaks ? signal.breaks(was, now) : true) changes.push(`${signal.name}: ${signal.describe?.(was, now) ?? `${was} → ${now}`}`);
  }
  return changes;
}

function checkIncrement(version, ref) {
  const base = previousStable(version);
  if (!base) return;
  const [from, to] = [parse(base), parse(version)];
  if (to.major !== from.major || to.minor !== from.minor) return;
  const changes = incompatibleChanges(`v${base}`, ref);
  if (changes.length) fail(`${version} is a PATCH of ${base}, but these changes need a MINOR release:\n  ${changes.join('\n  ')}`);
}

// ---------------------------------------------------------------------------------------------
// Commands

function notes() {
  const last = releaseTags().sort(compare).at(-1);
  const range = last ? `v${last}..HEAD` : 'HEAD';
  const log = tryGit('log', '--no-merges', '--format=%h %s', range) ?? '';
  const visible = log.split('\n').filter((line) => USER_FACING.test(line));
  console.log(`${visible.length} user-facing commits since ${last ? `v${last}` : 'the first commit'}:\n`);
  console.log(visible.join('\n'));
}

function prepare(version) {
  const target = parse(version ?? '');
  if (!target) fail('usage: pnpm release:prepare <MAJOR.MINOR.PATCH | MAJOR.MINOR.PATCH-beta.N>');
  if (git('status', '--porcelain')) fail('the working tree has uncommitted changes; commit or stash them first');
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main' && !/^release\/\d+\.\d+$/.test(branch)) fail(`releases are made from main or release/X.Y, not ${branch}`);
  const current = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
  const tags = releaseTags();
  if (tags.includes(version)) fail(`v${version} already exists`);
  const newest = [...tags, current].sort(compare).at(-1);
  // A patch of an older line (release/X.Y) may be lower than main's newest version, but not lower than its own line.
  if (branch === 'main' && compare(version, newest) <= 0) fail(`${version} is not newer than ${newest}`);
  if (target.beta !== null && tags.includes(core(version))) fail(`${core(version)} is already released; a beta must precede it`);

  notesFor(version, undefined, true);
  checkIncrement(version);

  // Node runs the TypeScript directly (type stripping), so this needs no installed dependencies.
  execFileSync(process.execPath, [resolve(root, 'scripts/version.ts'), version], { cwd: root, stdio: 'inherit' });
  if (target.beta === null) dateChangelogs(version, new Date().toISOString().slice(0, 10));
  const files = ['package.json', 'apps/macos/project.yml', 'apps/mobile/iosApp/project.yml', ...CHANGELOGS.map(({ path }) => path)];
  git('add', '--', ...files);
  git('commit', '--quiet', '-m', `chore: release v${version}`);
  git('tag', '--annotate', `v${version}`, '-m', `Riffet ${version}`);
  console.log(`\nTagged v${version}. Push it to start the release workflow:\n\n  git push origin ${branch} v${version}\n`);
}

function check(tag, options) {
  const version = tag?.startsWith('v') ? tag.slice(1) : '';
  const target = parse(version);
  if (!target) fail(`${tag} is not a release tag (vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-beta.N)`);
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  if (pkg.version !== version) fail(`${tag} does not match package.json version ${pkg.version}`);

  // Only reviewed history is released: the tagged commit must be on main or a release/X.Y line.
  const branches = (tryGit('branch', '--remotes', '--contains', 'HEAD', '--format=%(refname:short)') ?? '').split('\n');
  if (!branches.some((name) => name === 'origin/main' || /^origin\/release\/\d+\.\d+$/.test(name))) {
    fail(`${tag} is not on origin/main or an origin/release/X.Y branch`);
  }
  const tags = releaseTags();
  if (target.beta !== null && tags.includes(core(version))) fail(`${core(version)} is already released; ${version} would follow it`);
  checkIncrement(version, 'HEAD');

  const channel = target.beta === null ? 'stable' : 'beta';
  // GitHub's "latest" badge and npm's `latest` tag go to the newest stable only: a patch on an older
  // line must not take them from a newer minor.
  const newerStable = tags.some((other) => parse(other).beta === null && compare(other, version) > 0);
  const outputs = {
    version,
    channel,
    'npm-tag': channel === 'beta' ? 'next' : newerStable ? `release-${target.major}.${target.minor}` : 'latest',
    latest: String(channel === 'stable' && !newerStable),
  };
  if (options.notes) writeFileSync(options.notes, releaseNotes(notesFor(version, 'HEAD')));
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join('\n');
  if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `${lines}\n`, { flag: 'a' });
  console.log(lines);
}

/**
 * Changelog entries are written with the change (AGENTS.md). Only a warning: some fixes are invisible
 * to users, and the entries are curated again before a release.
 */
function changelog(range) {
  const commits = (tryGit('log', '--no-merges', '--format=%h %s', range) ?? '').split('\n').filter((line) => USER_FACING.test(line));
  if (!commits.length) return console.log(`No user-facing commits in ${range}.`);
  const changed = new Set((tryGit('diff', '--name-only', range) ?? '').split('\n'));
  const touched = CHANGELOGS.filter((log) => changed.has(log.path));
  const warn = (message) => console.log(process.env.GITHUB_ACTIONS ? `::warning title=Changelog::${message}` : `warning: ${message}`);
  if (!touched.length) warn(`${commits.length} user-facing commit(s) without a changelog entry: ${commits.join('; ')}. Add one to the unreleased sections of CHANGELOG.md and CHANGELOG.zh-CN.md, or ignore this if users cannot notice the change.`);
  else if (touched.length < CHANGELOGS.length) warn(`only ${touched[0].path} changed; CHANGELOG.md and CHANGELOG.zh-CN.md list the same entries.`);
  else console.log(`Changelogs updated for ${commits.length} user-facing commit(s).`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'notes' && !rest.length) notes();
else if (command === 'prepare' && rest.length === 1) prepare(rest[0]);
else if (command === 'check' && (rest.length === 1 || (rest.length === 3 && rest[1] === '--notes'))) check(rest[0], { notes: rest[2] });
else if (command === 'changelog' && rest.length === 1) changelog(rest[0]);
else fail('usage: release.mjs notes | prepare <version> | check <tag> [--notes <file>] | changelog <base>..<head>');
