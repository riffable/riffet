import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * One version for the server, Web, macOS, iPhone and Android, kept in the root package.json:
 * `version` (MAJOR.MINOR.PATCH, or MAJOR.MINOR.PATCH-beta.N for the beta channel) and `buildNumber`
 * (yyMMddNN, shared by Android `versionCode` and Apple `CFBundleVersion`, which both refuse to install
 * over a larger value; Sparkle and TestFlight order builds by it too, across channels).
 *
 * The Android build reads package.json itself. XcodeGen cannot, so the two project.yml files carry
 * a copy that this script rewrites, and `--check` lets CI fail when they drift. Apple's
 * `MARKETING_VERSION` takes three integers only, so a beta's copy is its MAJOR.MINOR.PATCH.
 *
 *   pnpm version:bump                 next build number, same version
 *   pnpm version:bump 0.8.0           new version and next build number
 *   pnpm version:bump 0.8.0-beta.1    a beta of 0.8.0
 *   pnpm version:check                verify the copies match
 *   pnpm version:bump --help          show usage without changing files
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = resolve(root, 'package.json');
const appleProjects = ['apps/macos/project.yml', 'apps/mobile/iosApp/project.yml'].map((path) => resolve(root, path));

// `$` alone also matches before a final line break, which is not part of a version.
const RELEASE_VERSION = /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-beta\.([1-9]\d*))?$(?!\s)/;
/** The MAJOR.MINOR.PATCH part, which is what Apple's MARKETING_VERSION accepts. */
const marketingVersion = (version: string): string => RELEASE_VERSION.exec(version)![1];
const VERSION_LINE = /("version":\s*")([^"]+)(")/;
const BUILD_LINE = /("buildNumber":\s*)(\d+)/;
const MARKETING_LINE = /^(\s*MARKETING_VERSION:\s*).*$/m;
const BUILD_SETTING_LINE = /^(\s*CURRENT_PROJECT_VERSION:\s*).*$/m;

function readPackage(): { text: string; version: string; build: number } {
  const text = readFileSync(packagePath, 'utf8');
  const version = text.match(VERSION_LINE)?.[2];
  const build = Number(text.match(BUILD_LINE)?.[2]);
  if (!version || !RELEASE_VERSION.test(version)) throw new Error(`package.json: invalid "version" ${version}; expected MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-beta.N`);
  if (!Number.isSafeInteger(build) || build <= 0) throw new Error('package.json: missing "buildNumber"');
  return { text, version, build };
}

/** Today's first build is yyMMdd01; later builds the same day count up, and never go backwards. */
function nextBuild(current: number, now = new Date()): number {
  const day = (now.getFullYear() % 100) * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
  const next = Math.max(day * 100 + 1, current + 1);
  if (next % 100 === 0) throw new Error(`build number ${current} has no room left today`);
  return next;
}

function syncedYaml(text: string, version: string, build: number, path: string): string {
  if (!MARKETING_LINE.test(text) || !BUILD_SETTING_LINE.test(text)) {
    throw new Error(`${path}: MARKETING_VERSION / CURRENT_PROJECT_VERSION not found`);
  }
  return text.replace(MARKETING_LINE, `$1${marketingVersion(version)}`).replace(BUILD_SETTING_LINE, `$1${build}`);
}

const args = process.argv.slice(2);
let checkOnly = false;
let help = false;
let requested: string | undefined;
for (const arg of args) {
  if (arg === '--check') {
    if (checkOnly) throw new Error('duplicate option: --check');
    checkOnly = true;
  } else if (arg === '--help' || arg === '-h') {
    if (help) throw new Error('duplicate option: --help / -h');
    help = true;
  } else {
    if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    if (requested !== undefined) throw new Error('only one version may be specified');
    if (!RELEASE_VERSION.test(arg)) throw new Error(`expected MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-beta.N: ${arg}`);
    requested = arg;
  }
}
if (checkOnly && requested !== undefined) throw new Error('--check does not accept a version');
if (help && (checkOnly || requested !== undefined)) throw new Error('--help / -h must be used alone');
if (help) {
  console.log(`Usage:
  pnpm version:bump [VERSION]  Set the version and advance the build number
  pnpm version:check           Check version copies without changing files
  pnpm version:bump --help     Show this help

VERSION is MAJOR.MINOR.PATCH, or MAJOR.MINOR.PATCH-beta.N for a beta. Without a version,
version:bump keeps the current version and advances the build number. Other pre-release
labels and build metadata are not supported.`);
  process.exit(0);
}

const current = readPackage();
const version = checkOnly ? current.version : requested ?? current.version;
const build = checkOnly ? current.build : nextBuild(current.build);

const projects = appleProjects.map((path) => {
  const text = readFileSync(path, 'utf8');
  const synced = syncedYaml(text, version, build, path);
  return { path, text, synced };
});

if (checkOnly) {
  const stale = projects.filter(({ text, synced }) => synced !== text).map(({ path }) => path);
  if (stale.length) {
    console.error(`Out of sync with package.json (${version}, build ${build}):\n  ${stale.join('\n  ')}\nRun pnpm version:bump.`);
    process.exit(1);
  }
  console.log(`version ${version}, build ${build}`);
} else {
  for (const { path, text, synced } of projects) {
    if (synced !== text) writeFileSync(path, synced);
  }
  writeFileSync(packagePath, current.text.replace(VERSION_LINE, `$1${version}$3`).replace(BUILD_LINE, `$1${build}`));
  console.log(`version ${current.version} → ${version}, build ${current.build} → ${build}`);
}
