import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Plain Node, also used before the macOS toolchain or pnpm dependencies are available.
const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$(?!\s)/;
const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' };
// Ignore an enclosing repository's location while retaining user Git authentication configuration.
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
function git(args) {
  return execFileSync('git', args, { cwd: root, env, encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function readRecord() {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  if (typeof pkg.version !== 'string' || !stable.test(pkg.version) || !Number.isSafeInteger(pkg.buildNumber) || pkg.buildNumber <= 0) {
    throw new Error('package.json must contain a stable version and a positive buildNumber');
  }
  let commit = null;
  let tag = null;
  let dirty = true;
  try {
    if (realpathSync(git(['rev-parse', '--show-toplevel'])) !== root) throw new Error('Not the source repository root');
    commit = git(['rev-parse', '--verify', 'HEAD^{commit}']);
    dirty = git(['status', '--porcelain=v1', '--untracked-files=normal']).length > 0;
    const expected = `v${pkg.version}`;
    if (!dirty) {
      try {
        if (git(['rev-parse', '--verify', `refs/tags/${expected}^{commit}`]) === commit) tag = expected;
      } catch { /* An untagged clean checkout is a development build. */ }
    }
  } catch {
    // A source archive or missing Git can still be built, but is never a release identity.
    tag = null;
    dirty = true;
  }
  // A public build must not record the build machine's checkout path: the shipped binary and its
  // source maps are shared as-is. An empty source root keeps the build identity (version, commit)
  // while disabling the App's source-checkout update flow.
  const sourceRoot = process.env.RIFFET_PUBLIC_BUILD === '1' ? '' : root;
  return { build: { version: pkg.version, buildNumber: pkg.buildNumber, tag, commit, dirty }, sourceRoot };
}

function verifyRecord(record) {
  const now = readRecord();
  if (record.sourceRoot !== now.sourceRoot || Object.keys(now.build).some(key => record.build?.[key] !== now.build[key])) {
    throw new Error('Source identity changed during the build; rebuild from the intended unchanged checkout');
  }
  return record;
}

function verify(path) {
  return verifyRecord(JSON.parse(readFileSync(path, 'utf8')));
}

function runBuild() {
  // Capture a parent's pin once. Other builds and later parent writes cannot replace this identity.
  const record = process.env.RIFFET_BUILD_INFO_FILE ? verify(resolve(process.env.RIFFET_BUILD_INFO_FILE)) : readRecord();
  mkdirSync(resolve(root, '.riffet'), { recursive: true });
  const directory = mkdtempSync(resolve(root, '.riffet/build-'));
  const snapshot = resolve(directory, 'build-info.json');
  try {
    writeFileSync(snapshot, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o444 });
    // Each bundler lists the npm files it shipped here; the notices step credits their packages.
    const bundled = resolve(directory, 'bundled');
    mkdirSync(bundled);
    const buildEnv = { ...process.env, RIFFET_BUILD_INFO_FILE: snapshot, RIFFET_BUNDLED_PACKAGES_DIR: bundled };
    const runTool = (name, args) => {
      // Use each installed package's declared binary, without shell or package-manager recursion.
      const packagePath = resolve(root, 'node_modules', name, 'package.json');
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[name];
      if (typeof bin !== 'string') throw new Error(`${name} does not declare its executable`);
      execFileSync(process.execPath, [resolve(dirname(packagePath), bin), ...args], { cwd: root, env: buildEnv, stdio: 'inherit' });
    };
    runTool('vite', ['build', '--config', 'apps/web/vite.config.ts']);
    verifyRecord(record);
    runTool('vite', ['build', '--config', 'apps/web/vite.config.ts', '--mode', 'share']);
    verifyRecord(record);
    runTool('tsx', ['scripts/build.ts']);
    verifyRecord(record);
    runTool('tsx', ['scripts/third-party-notices.ts', 'dist/runtime-package.json', bundled, 'dist/THIRD_PARTY_NOTICES.md']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
if (args[0] === '--build' && args.length === 1) {
  runBuild();
} else if (args[0] === '--verify' && args.length === 2) {
  verify(resolve(args[1]));
} else if (args[0] === '--stdout' && args.length === 1) {
  process.stdout.write(`${JSON.stringify(readRecord())}\n`);
} else if (!args.length || (args[0] === '--output' && args.length === 2)) {
  if (!args.length && process.env.RIFFET_BUILD_INFO_FILE) {
    // A parent build (e.g. macOS payload) owns this immutable snapshot.
    verify(resolve(process.env.RIFFET_BUILD_INFO_FILE));
  } else {
    const output = resolve(args[1] ?? resolve(root, '.riffet/build-info.json'));
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(readRecord(), null, 2)}\n`);
  }
} else {
  throw new Error('Usage: node scripts/build-info.mjs [--output <file> | --stdout | --verify <file> | --build]');
}
