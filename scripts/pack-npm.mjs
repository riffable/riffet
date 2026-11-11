#!/usr/bin/env node
// Stages and packs the `riffet` npm package from an existing dist/ (run `pnpm build` first):
//
//   RIFFET_PUBLIC_BUILD=1 pnpm build
//   pnpm pack:npm            # build/npm/ and build/npm/riffet-<version>.tgz
//   npm publish build/npm    # by a maintainer, after inspecting `tar tzf` of the tarball
//
// The package carries dist/ (without source maps), the `riffet` launcher and the legal files;
// its dependencies are exactly what dist/ loads at runtime (dist/runtime-package.json, the same
// manifest the macOS App payload installs). dist/ embeds the build identity, so a build that
// recorded this machine's checkout path (sourceRoot) is refused: build with RIFFET_PUBLIC_BUILD=1.
// A vendor left out with RIFFET_EXCLUDED_VENDORS must also be left out of that build; to verify
// it, run `RIFFET_ARTIFACT_DENYLIST=... node scripts/check-public-artifacts.mjs build/npm`
// (without markers that script exits 2 by design, so it is not run here).
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'build/npm');
const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const fail = (message) => { console.error(`pack-npm: ${message}`); process.exit(1); };

const project = read('package.json');
let runtime, info;
try { runtime = read('dist/runtime-package.json'); info = read('dist/build-info.json'); }
catch { fail('dist/ is missing or incomplete; run `RIFFET_PUBLIC_BUILD=1 pnpm build` first.'); }
if (info.sourceRoot) fail('dist/ was built with a source checkout path; rebuild with RIFFET_PUBLIC_BUILD=1 so the package carries no build-machine path.');
if (runtime.version !== project.version) fail(`dist/ was built for ${runtime.version}, but package.json is ${project.version}; rebuild.`);
// The launcher imports commander itself; it is a runtime dependency of dist/cli.js as well.
if (!runtime.dependencies.commander) fail('dist/runtime-package.json does not list commander, which scripts/riffet.mjs needs.');

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'scripts'), { recursive: true });
cpSync(join(root, 'dist'), join(out, 'dist'), {
  recursive: true,
  // Source maps stay out (the App payload does the same); runtime-package.json becomes package.json below.
  filter: (source) => !source.endsWith('.map') && source !== join(root, 'dist/runtime-package.json'),
});
copyFileSync(join(root, 'scripts/riffet.mjs'), join(out, 'scripts/riffet.mjs'));
for (const file of ['LICENSE', 'NOTICE', 'README.md', 'README.zh-CN.md']) copyFileSync(join(root, file), join(out, file));

const repository = 'https://github.com/riffetai/riffet';
const manifest = {
  name: 'riffet',
  version: project.version,
  description: project.description,
  license: project.license,
  type: 'module',
  bin: { riffet: 'scripts/riffet.mjs', 'riffet-server': 'dist/cli.js' },
  engines: project.engines,
  os: ['darwin', 'linux'],
  repository: { type: 'git', url: `git+${repository}.git` },
  homepage: `${repository}#readme`,
  bugs: { url: `${repository}/issues` },
  keywords: ['riffet', 'cursor', 'codex', 'claude-code', 'coding-agent', 'workbench'],
  files: ['dist/', 'scripts/riffet.mjs', 'LICENSE', 'NOTICE', 'README.md', 'README.zh-CN.md'],
  publishConfig: { access: 'public' },
  dependencies: runtime.dependencies,
};
writeFileSync(join(out, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// The same build-machine check on what is actually shipped: the checkout path must not appear in any file.
const leaks = [];
const scan = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) scan(path);
    else if (readFileSync(path).includes(root)) leaks.push(path.slice(out.length + 1));
  }
};
scan(out);
if (leaks.length) fail(`the build-machine path ${root} appears in: ${leaks.join(', ')}`);

execFileSync('npm', ['pack', '--pack-destination', out], { cwd: out, stdio: 'inherit' });
