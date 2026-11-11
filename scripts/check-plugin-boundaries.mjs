#!/usr/bin/env node
// Keeps built-in plugins separable from the core (docs/PLUGIN_ARCHITECTURE.md):
// - the core reaches `plugins/` only through apps/server/src/plugins/registry.ts;
// - packages/plugin-api depends on nothing but `@contracts`, Node built-ins and package.json dependencies (its kit runs in the core and in plugins alike);
// - a server-side plugin file imports only the API, `@contracts`, Node built-ins, npm
//   dependencies, and files of its own package directory (`plugins/<vendor>/<name>/`), not those of another
//   package of the same vendor; a directory that exports several plugins (`acme/model-sources`) is one
//   package, so a build can leave a package out;
// - a client file (`plugins/<vendor>/<name>/web/**`) imports only `@riffet/plugin-web`,
//   `@contracts`, npm dependencies and files of its own package, and nothing of Node or the server;
// - the web core reaches the client entries (`plugins/web.ts`) only through
//   apps/web/src/plugins/registry.ts, as the server core does through registry.ts.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = 'apps/server/src/plugins/registry.ts';
const WEB_GATE = 'apps/web/src/plugins/registry.ts';
const WEB_ENTRIES = /^plugins\/web(?:\.[jt]sx?)?$/;
// Client code of a package; `plugins/web.ts` lists them all, as `index.ts` does the server side.
const CLIENT_FILE = /^plugins\/[^/]+\/[^/]+\/web\//;
const API = 'packages/plugin-api/';
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const packages = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})]);
const builtins = new Set(builtinModules);

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'apps', 'packages', 'plugins'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter(file => /\.(?:[cm]?[jt]s|tsx)$/.test(file) && !file.startsWith('apps/mobile/') && !/(?:^|\/)(?:node_modules|dist|build)\//.test(file));

const posix = path => path.split(sep).join('/');
const packageName = specifier => specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
const problems = [];

for (const file of files) {
  let text;
  try { text = readFileSync(resolve(root, file), 'utf8'); } catch { continue; }
  for (const { fileName: specifier } of ts.preProcessFile(text, true, true).importedFiles) {
    const relativeTarget = specifier.startsWith('.') ? posix(relative(root, resolve(root, dirname(file), specifier))) : undefined;
    const fail = reason => problems.push(`${file}: ${reason} (${specifier})`);
    if (CLIENT_FILE.test(file) || file === 'plugins/web.ts') {
      if (relativeTarget !== undefined) {
        const own = file === 'plugins/web.ts' ? 'plugins/' : `${file.split('/').slice(0, 3).join('/')}/`;
        if (!relativeTarget.startsWith(own)) fail(`may only import files under ${own}`);
      } else if (specifier !== '@riffet/plugin-web' && specifier !== '@contracts' && specifier !== '@riffet/contracts' && !packages.has(packageName(specifier))) {
        fail('client code may import only @riffet/plugin-web, @contracts and package.json dependencies');
      }
    } else if (file.startsWith('plugins/')) {
      if (relativeTarget !== undefined) {
        // `plugins/index.ts` and `web.ts` list the packages; every other file belongs to the one directory `plugins/<vendor>/<name>/`.
        const own = file.split('/').length > 2 ? `${file.split('/').slice(0, 3).join('/')}/` : 'plugins/';
        if (!relativeTarget.startsWith(own)) fail(`may only import files under ${own}`);
      } else if (specifier !== '@riffet/plugin-api' && specifier !== '@contracts' && specifier !== '@riffet/contracts' && !specifier.startsWith('node:') && !builtins.has(specifier) && !packages.has(packageName(specifier))) {
        fail('may import only @riffet/plugin-api, @contracts, Node built-ins and package.json dependencies');
      }
    } else if (file.startsWith(API)) {
      if (relativeTarget !== undefined ? !relativeTarget.startsWith(API)
        : specifier !== '@contracts' && specifier !== '@riffet/contracts' && !specifier.startsWith('node:') && !builtins.has(specifier) && !packages.has(packageName(specifier))) fail('the plugin API may import only @contracts, Node built-ins and package.json dependencies');
    } else if ((relativeTarget === 'plugins' || relativeTarget?.startsWith('plugins/')) && file !== GATE && !(file === WEB_GATE && WEB_ENTRIES.test(relativeTarget))) {
      fail(`only ${GATE} may import plugins/, and ${WEB_GATE} only plugins/web`);
    }
  }
}

if (problems.length) {
  console.error(`Plugin boundary violations:\n${problems.map(problem => `  ${problem}`).join('\n')}`);
  process.exit(1);
}
console.log(`Plugin boundaries hold (${files.length} files).`);
