#!/usr/bin/env node
// Keeps private data out of the source and the commit history before the repository goes public.
//
//   pnpm check:privacy                          # every tracked file
//   pnpm check:privacy --range origin/main      # lines each commit in origin/main..HEAD adds, commit messages, author/committer emails
//   pnpm check:privacy --range <base>..<head>   # the same for an explicit range (a pull request: base sha..head sha)
//   pnpm check:privacy --message <file>         # one commit message (commit-msg hook: `node scripts/check-privacy.mjs --message "$1"`)
//
// Rules: private words (scripts/privacy-words.mjs: RIFFET_EXCLUDED_VENDORS, RIFFET_ARTIFACT_DENYLIST,
// RIFFET_ARTIFACT_DENYLIST_FILE, ~/.config/riffet/private-words.txt), then built-in patterns: private IPv4
// addresses, absolute home paths, email addresses and token-like strings. A line containing
// `privacy: allow <reason>` is skipped. A private-word hit prints its category only, a pattern hit a masked
// value. History is read with `--no-replace-objects`, so a local `git replace` graft is never scanned.
// Exit 2 on a configuration error, 1 on hits.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMarkers, markerPattern } from './privacy-words.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fail = message => { console.error(message); process.exit(2); };

// Public project addresses and obvious placeholders; everything else that looks like an address is a hit.
const EMAIL_ALLOW = [
  /@(?:[a-z0-9-]+\.)*example\.(?:com|org|net|invalid|test)$/i,
  /@(?:[a-z0-9-]+\.)?riffet\.example$/i,
  /@users\.noreply\.github\.com$/i,
  // Co-author trailers and bots: a no-reply address belongs to no one.
  /^(?:[a-z0-9._+-]*[.+-])?no-?reply@/i,
  /^git@github\.com$/i,
  // Cursor's own co-author address.
  /^cursoragent@cursor\.com$/i,
  /@(?:mac\.local|domain\.tld|b\.co)$/i,
];
// Kotlin labels (`this@Foo.bar`) and image suffixes (`icon@2x.png`) look like addresses.
const EMAIL_NOT = /^(?:this|return|break|continue|super)@|\.(?:png|jpe?g|gif|webp|svg|ts|tsx|js|mjs|kt|swift|json|xml)$/i;
const HOME_PLACEHOLDER = /^(?:[^\w$*{].*|<.*|x|linuxbrew|me|you|user|username|name|your-?name|example|<[^>]*>|\$\{?\w+\}?|\{[^}]*\}|\*|foo|bar|test|runner|shared|Shared|Library|Guest|root)$/i;
const PRIVATE_IP = /(?<![\w.])(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2})(?![\w.]*\w)/g;
const IP_DOCS = /^(?:10\.0\.0\.[0-9]|192\.168\.(?:0|1)\.(?:1|2|10|100)|192\.168\.0\.0|10\.0\.0\.0)$/;

const mask = value => value.length <= 6 ? '***' : `${value.slice(0, 2)}***${value.slice(-2)}`;
const TOKENS = [
  ['token', /\bwkn_[0-9a-f]{16}_[A-Za-z0-9_-]{32,}/g],
  ['token', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}/g],
  ['token', /\bgh[pousr]_[A-Za-z0-9]{36,}/g],
  ['token', /\bgithub_pat_[A-Za-z0-9_]{40,}/g],
  ['token', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['token', /\bxox[abprs]-[A-Za-z0-9-]{20,}/g],
  ['token', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g],
];

let markers;
try { markers = loadMarkers(); } catch (error) { fail(error.message); }
const words = markers.map(markerPattern);

const ALLOW = /privacy: allow\b/;
// Returns [{ category, rule, value? }] for one line (value only for masked pattern hits).
function scanLine(line, lenient, wordsOnly) {
  if (ALLOW.test(line)) return [];
  const found = [];
  if (words.some(pattern => pattern.test(line))) found.push({ category: 'private word', rule: 'denylist' });
  if (wordsOnly) return found;
  for (const match of lenient ? [] : line.matchAll(PRIVATE_IP)) {
    if (!IP_DOCS.test(match[0])) found.push({ category: 'private IP', rule: 'ipv4', value: mask(match[0]) });
  }
  for (const match of lenient ? [] : line.matchAll(/(?<![\w.~])\/(?:Users|home)\/([^/\s'"`)\]}>:;,\\]+)/g)) {
    if (!HOME_PLACEHOLDER.test(match[1])) found.push({ category: 'home path', rule: 'home-path', value: mask(match[0]) });
  }
  for (const match of line.matchAll(/(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)) {
    if (!EMAIL_NOT.test(match[0]) && !EMAIL_ALLOW.some(pattern => pattern.test(match[0]))) found.push({ category: 'email', rule: 'email', value: mask(match[0]) });
  }
  for (const [category, pattern] of TOKENS) {
    for (const match of line.matchAll(pattern)) if (!/test|fake|dummy|example|secret|redact|0123456789/i.test(match[0])) found.push({ category, rule: pattern.source.slice(0, 24), value: mask(match[0]) });
  }
  return found;
}

const git = args => execFileSync('git', ['--no-replace-objects', '-c', 'core.quotePath=false', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 30, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' } });
const hits = [];
const scanText = (where, text, firstLine = 1, wordsOnly = false, file = where) => {
  const lenient = TEST_FILE.test(file);
  text.split('\n').forEach((line, index) => {
    for (const hit of scanLine(line, lenient, wordsOnly)) hits.push(`${where}:${firstLine + index}  ${hit.category} [${hit.rule}]${hit.value ? ` ${hit.value}` : ''}`);
  });
};

const args = process.argv.slice(2);
const flag = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1] ?? fail(`${name} needs a value.`); };
const range = flag('--range');
const messageFile = flag('--message');
if (range && messageFile) fail('Use either --range or --message.');

// Lockfiles and vendored or generated trees carry hashes and upstream addresses, not our data.
const SKIP = /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Podfile\.lock|gradle\.lockfile|Package\.resolved)$|(?:^|\/)(?:node_modules|vendor|Pods|Licenses|icon-sources|Icons\.xcassets)\/|\.generated\.|\.svg$/;
// Test fixtures use LAN addresses and sample home paths as their subject; the other rules still apply.
const TEST_FILE = /\.test\.[cm]?[jt]sx?$|(?:^|\/)(?:commonTest|jvmTest|androidTest|[A-Za-z]*Tests)\/|Tests?\.(?:kt|swift)$/;

// The path of a `+++ b/<path>` header; `/dev/null` for a deletion. Git still C-quotes a path with a quote,
// backslash or control character even with core.quotePath=false.
function diffPath(raw) {
  let path = raw;
  if (raw.startsWith('"')) {
    const escapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
    const bytes = [];
    for (let at = 1; at < raw.length - 1; at++) {
      const char = raw[at];
      if (char !== '\\') { bytes.push(...Buffer.from(char, 'utf8')); continue; }
      const next = raw[++at];
      if (/[0-7]/.test(next)) { bytes.push(parseInt(raw.slice(at, at + 3), 8)); at += 2; }
      else bytes.push(escapes[next] ?? next.charCodeAt(0));
    }
    path = Buffer.from(bytes).toString('utf8');
  }
  return path.startsWith('b/') ? path.slice(2) : '';
}

if (messageFile) {
  if (!existsSync(messageFile)) fail(`${messageFile} does not exist.`);
  scanText('commit message', readFileSync(messageFile, 'utf8').split('\n').filter(line => !line.startsWith('#')).join('\n'));
} else if (range) {
  const [base, head = 'HEAD'] = range.split('..');
  try { for (const ref of [base, head]) git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); } catch { fail(`Cannot resolve ${range}; fetch the base first.`); }
  for (const commit of git(['rev-list', `${base}..${head}`]).split('\n').filter(Boolean)) {
    const short = commit.slice(0, 8);
    scanText(`${short} message`, git(['show', '-s', '--format=%B', commit]));
    // A contributor's commit address is theirs to publish; only a private word (a company domain) is a hit.
    scanText(`${short} identity`, git(['show', '-s', '--format=%an <%ae>%n%cn <%ce>', commit]), 1, true);
  }
  // Every commit's own diff, not the net base...head one: a secret added and removed again inside the
  // range is still in the history being published. Merge commits show no diff of their own.
  let commit = '';
  let file = '';
  let line = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const row of git(['log', '-p', '-U0', '--no-color', '--no-ext-diff', '--no-renames', '--format=%x01%H', `${base}..${head}`]).split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      // Inside a hunk the header's counts, not the first character, say where it ends, so an added
      // line reading `+++ x` or `diff --git` is content.
      if (row.startsWith('\\')) continue; // "\ No newline at end of file"
      if (row.startsWith('-')) { oldLeft--; continue; }
      if (row.startsWith(' ')) { oldLeft--; newLeft--; line++; continue; }
      newLeft--;
      if (file && !SKIP.test(file)) scanText(`${commit} ${file}`, row.slice(1), line, false, file);
      line++;
      continue;
    }
    if (row.startsWith('\x01')) { commit = row.slice(1, 9); file = ''; continue; }
    if (row.startsWith('diff --git ')) { file = ''; continue; }
    if (row.startsWith('+++ ')) { file = diffPath(row.slice(4)); continue; }
    const header = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row);
    if (header) {
      oldLeft = header[1] === undefined ? 1 : Number(header[1]);
      line = Number(header[2]);
      newLeft = header[3] === undefined ? 1 : Number(header[3]);
    }
  }
} else {
  for (const file of git(['ls-files', '-z']).split('\0').filter(Boolean)) {
    if (SKIP.test(file) || !existsSync(resolve(root, file))) continue;
    const buffer = readFileSync(resolve(root, file));
    if (buffer.subarray(0, 8000).includes(0)) continue;
    scanText(file, buffer.toString('utf8'));
  }
}

if (hits.length) {
  console.error(`Private data found (${hits.length}); fix it, or add \`privacy: allow <reason>\` to a placeholder line:\n${hits.map(hit => `  ${hit}`).join('\n')}`);
  process.exit(1);
}
console.log('No private data found.');
