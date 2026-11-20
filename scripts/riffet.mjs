#!/usr/bin/env node
// `riffet` from a source checkout or an npm install: the command itself is the build, dist/cli.js.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Node resolves the installed symlink to this file, so any working directory works.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'dist/cli.js');

function globalManager(packageDir) {
  let real = packageDir;
  try { real = realpathSync(packageDir); } catch { /* keep the package directory */ }
  const parts = real.split(sep);
  if (parts.includes('pnpm') || parts.some(part => part.startsWith('.pnpm'))) return 'pnpm';
  if (parts.includes('.bun')) return 'bun';
  if (parts.includes('.yarn') || parts.includes('yarn')) return 'yarn';
  return 'npm';
}

function nodeUpgradeHint(minimum, executable, needsNpmReinstall) {
  const major = /^(\d+)/.exec(minimum)?.[1] ?? '24';
  const reinstall = needsNpmReinstall ? ' && npm install -g riffet' : '';
  let resolved = executable;
  try { resolved = realpathSync(executable); } catch { /* keep the invoked path */ }
  const locations = `${executable}\n${resolved}`;
  const tail = ', or check `which -a node` if already installed';
  if (/[\\/]\.nvm[\\/]/.test(locations)) return `Run \`nvm install ${major} && nvm alias default ${major}${reinstall}\`${tail}`;
  if (/[\\/](?:\.fnm|fnm_multishells|fnm)[\\/]/.test(locations)) return `Run \`fnm install ${major} && fnm default ${major}${reinstall}\`${tail}`;
  if (/[\\/]\.?mise[\\/]/.test(locations)) return `Run \`mise use -g node@${major}${reinstall}\`${tail}`;
  if (/[\\/]\.?volta[\\/]/.test(locations)) return `Run \`volta install node@${major}${reinstall}\`${tail}`;
  if (/[\\/]\.asdf[\\/]/.test(locations)) return `Run \`asdf install nodejs latest:${major} && asdf set -u nodejs latest:${major}${reinstall}\`${tail}`;
  if (/[\\/]n[\\/]versions[\\/]node[\\/]/.test(locations)) return `Run \`n ${major}${reinstall}\`${tail}`;
  if (/[\\/](?:Cellar|opt)[\\/]node@/.test(locations)) return `Run \`brew install node\`${tail}`;
  if (/[\\/](?:opt[\\/]homebrew|linuxbrew|Cellar[\\/]node)[\\/]/.test(locations)) return `Run \`brew upgrade node\`${tail}`;
  return `Install Node.js ${minimum} or newer (\`nvm install ${major}\` / \`brew install node\`), or check \`which -a node\``;
}

// Check before importing dist/cli.js: older Node fails at ESM link time on node:sqlite or throws on hex styleText.
function checkNodeVersion() {
  let range = '>=24.19.0';
  let needsNpmReinstall = false;
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (typeof manifest?.engines?.node === 'string') range = manifest.engines.node;
    needsNpmReinstall = manifest?.private !== true && globalManager(root) === 'npm';
  } catch { /* fall back to the built-in minimum */ }
  const requiredMatch = /^\s*>=\s*(\d+)\.(\d+)\.(\d+)\s*$/.exec(range);
  const currentMatch = /^(\d+)\.(\d+)\.(\d+)(?:-|$)/.exec(process.versions.node);
  if (!requiredMatch || !currentMatch) return;
  const required = [Number(requiredMatch[1]), Number(requiredMatch[2]), Number(requiredMatch[3])];
  const current = [Number(currentMatch[1]), Number(currentMatch[2]), Number(currentMatch[3])];
  for (let i = 0; i < 3; i++) {
    if (current[i] > required[i]) return;
    if (current[i] < required[i]) break;
    if (i === 2 && !process.versions.node.includes('-')) return;
  }
  const min = required.join('.');
  const hint = nodeUpgradeHint(min, process.execPath, needsNpmReinstall);
  console.error(`✗ Riffet requires Node.js >=${min}, but this is ${process.version} (${process.execPath})\n  → ${hint}`);
  process.exit(1);
}

checkNodeVersion();
if (!existsSync(entry)) {
  console.error(`✗ Riffet is not built yet\n  → cd ${root} && pnpm build`);
  process.exit(1);
}
// Native CLI hooks and MCP entries are written with absolute paths into dist/, and npm may delete its
// npx cache, which would leave them pointing at nothing.
if (/[\\/]_npx[\\/]/.test(root)) console.error('! Running from the npx cache, which npm may clear; hooks Riffet installs would then break\n  → npm i -g riffet');
const { main } = await import(pathToFileURL(entry).href);
await main();
