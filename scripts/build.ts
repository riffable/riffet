import { build, type Metafile, type Plugin } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildInfo } from '@contracts';
import { buildPreviewAssets } from '../apps/server/src/previews/browser-assets.js';
import { buildDiagramAssets } from '../apps/server/src/diagram-assets.js';
import { writePrompts } from './gen-prompts.js';
import { runtimePackage } from './runtime-package.js';

const buildInfoPath = resolve(process.env.RIFFET_BUILD_INFO_FILE ?? '.riffet/build-info.json');
const captured = await readFile(buildInfoPath, 'utf8');
const record = JSON.parse(captured) as { build: BuildInfo; sourceRoot: string };

/**
 * Vendors a public build leaves out (`RIFFET_EXCLUDED_VENDORS=acme`, comma-separated). The
 * core imports `plugins/index.ts` in exactly one place, so the build substitutes a generated
 * list there and the excluded vendor's modules never enter the bundle. Unset means every built-in
 * plugin ships.
 */
const excludedVendors = new Set((process.env.RIFFET_EXCLUDED_VENDORS ?? '')
  .split(',').map(vendor => vendor.trim().toLowerCase()).filter(Boolean));
// A typo would otherwise ship the vendor it meant to leave out. A partial checkout (the update
// tests copy only the build inputs) has no plugins directory and excludes nothing.
const vendors = new Set([...(await readdir('plugins', { withFileTypes: true }).catch(() => []))
  .filter(entry => entry.isDirectory()).map(entry => entry.name.toLowerCase())]);
for (const vendor of excludedVendors) if (!vendors.has(vendor)) throw new Error(`RIFFET_EXCLUDED_VENDORS names unknown vendor "${vendor}" (known: ${[...vendors].join(', ')})`);

// Inline the prompt Markdown into the module the bundle imports (see gen-prompts.ts). It writes only
// when the module is stale, so building a clean tree leaves it clean.
writePrompts();

await mkdir('.riffet', { recursive: true });
const directory = await mkdtemp(resolve('.riffet/server-build-'));
const snapshot = resolve(directory, 'build-info.json');

/** The plugins module with the excluded vendor imports removed, or undefined for a full build. */
async function excludedPluginsModule(target: string): Promise<{ path: string; plugin: Plugin } | undefined> {
  if (!excludedVendors.size) return undefined;
  const source = await readFile('plugins/index.ts', 'utf8');
  const imports = [...source.matchAll(/^import \{ ([^}]+) \} from '(\.\/[^']+)';$/gm)].map(([, names, path]) => ({
    names: names!.split(',').map(name => name.trim()).filter(Boolean),
    path: path!,
    vendor: path!.split('/')[1]!.toLowerCase(),
  }));
  const entries = /export const builtinPlugins[^=]*=\s*\[([\s\S]*?)\];/.exec(source);
  if (!entries) throw new Error('plugins/index.ts no longer declares builtinPlugins as a literal array');
  const kept = [...entries[1]!.matchAll(/\.\.\.(\w+)|(\w+)/g)]
    .map(([, spread, name]) => ({ spread: Boolean(spread), name: (spread ?? name)! }))
    .filter(entry => imports.some(item => item.names.includes(entry.name) && !excludedVendors.has(item.vendor)));
  const used = imports.filter(item => !excludedVendors.has(item.vendor) && item.names.some(name => kept.some(entry => entry.name === name)));
  await writeFile(target, [
    ...used.map(item => `import { ${item.names.join(', ')} } from '${resolve('plugins', item.path.replace(/\.js$/, '.ts'))}';`),
    '',
    `export const builtinPlugins = [${kept.map(entry => `${entry.spread ? '...' : ''}${entry.name}`).join(', ')}];`,
    '',
  ].join('\n'));
  return {
    path: target,
    plugin: {
      name: 'riffet-excluded-vendors',
      setup(builder) { builder.onResolve({ filter: /(^|\/)plugins\/index\.js$/ }, () => ({ path: target })); },
    },
  };
}

/**
 * SheetJS is published only from its own CDN, so an `npm install` of the server package could not
 * fetch it from the registry. Bundling its ESM entry keeps it out of runtime-package.json; the
 * notices still credit it through the server metafile.
 */
const bundledXlsx: Plugin = {
  name: 'riffet-bundled-xlsx',
  setup(builder) { builder.onResolve({ filter: /^xlsx$/ }, () => ({ path: fileURLToPath(import.meta.resolve('xlsx')) })); },
};

const pluginsModule = await excludedPluginsModule(resolve(directory, 'plugins-index.ts'));
const entryPoints: Record<string, string> = {
  cli: 'apps/server/src/cli.ts',
  index: 'apps/server/src/index.ts',
  'preview-worker': 'apps/server/src/previews/worker.ts',
};
// Spaces were removed in 0.6.0; an earlier build must not leave the agent shim behind.
await rm('dist/space-cli.mjs', { force: true });

try {
  // Also protect direct invocations from mutable parent pins: verify the exact embedded record.
  await writeFile(snapshot, captured, { flag: 'wx', mode: 0o444 });
  execFileSync(process.execPath, ['scripts/build-info.mjs', '--verify', snapshot], { stdio: 'inherit' });
  await mkdir('dist',{recursive:true});
  const { metafile } = await build({entryPoints,outdir:'dist',bundle:true,platform:'node',format:'esm',target:'node24',packages:'external',sourcemap:true,metafile:true,plugins:[bundledXlsx,...pluginsModule ? [pluginsModule.plugin] : []],define:{__RIFFET_BUILD_RECORD__:JSON.stringify(record)}});
  // Lingui macros are compile-time only. A web module the server bundles cannot use one: with
  // node_modules left external the import survives, and the server dies at startup on the macro's
  // own peer dependency. Pass the translated text in instead (see visualizationReferences.ts).
  for (const file of Object.keys(metafile.outputs).filter(output => output.endsWith('.js'))) {
    if ((await readFile(file, 'utf8')).includes('@lingui/core/macro')) throw new Error(`${file} imports the compile-time macro @lingui/core/macro; the server bundle must not use Lingui macros`);
  }
  // The App payload installs exactly this manifest next to dist/.
  const manifest = runtimePackage(metafile, JSON.parse(await readFile('package.json', 'utf8')));
  await writeFile('dist/runtime-package.json', `${JSON.stringify(manifest, null, 2)}\n`);
  const [preview, diagrams] = await Promise.all([buildPreviewAssets(resolve('dist/preview-assets')), buildDiagramAssets(resolve('dist/diagram-assets'))]);
  // What these bundles contain, for scripts/third-party-notices.ts (set by `pnpm build`).
  const bundled = process.env.RIFFET_BUNDLED_PACKAGES_DIR;
  if (bundled) {
    const inputs = (...metafiles: Metafile[]) => JSON.stringify(metafiles.flatMap(({ inputs }) => Object.keys(inputs)));
    await writeFile(resolve(bundled, 'server.json'), inputs(metafile));
    await writeFile(resolve(bundled, 'preview-assets.json'), inputs(preview));
    await writeFile(resolve(bundled, 'diagram-assets.json'), inputs(...diagrams));
  }
  // Native hooks and plugins run in the CLI process, so they remain standalone assets.
  await cp('apps/server/src/backends/dsh/bridge-runtime', 'dist/bridge-runtime', { recursive: true });
  await copyFile('apps/server/src/backends/dsh/NOTICE', 'dist/bridge-runtime/NOTICE');
  // Riffet's own license and notice travel with every copy of the build.
  await copyFile('LICENSE', 'dist/LICENSE');
  await copyFile('NOTICE', 'dist/NOTICE');
  await copyFile('apps/server/src/backends/shared/hook-cli.mjs', 'dist/hook-cli.mjs');
  await copyFile('apps/server/src/backends/shared/hook-target.mjs', 'dist/hook-target.mjs');
  // The code index parses in child processes that load these files by path (apps/server/src/workspace/symbols/indexes.ts); the grammars' NOTICE travels with them.
  await copyFile('apps/server/src/workspace/symbols/parse-worker.mjs', 'dist/parse-worker.mjs');
  await cp('apps/server/src/workspace/symbols/grammars', 'dist/grammars', { recursive: true });
  // The shim an installed plugin package's process runs (apps/server/src/plugins-host/remote.ts); the permission model lets it read only this file.
  await copyFile('packages/plugin-api/src/runtime/child.mjs', 'dist/plugin-runtime.mjs');
  await copyFile('apps/server/src/backends/claude/statusline-cli.mjs', 'dist/statusline-cli.mjs');
  // Each conversation's CLI spawns the Riffet MCP shim itself (docs/DEVICES.md §2).
  await copyFile('apps/server/src/riffet-mcp/riffet-mcp.mjs', 'dist/riffet-mcp.mjs');
  await cp('apps/server/src/visualization/assets', 'dist/visualization/assets', { recursive: true });
  // A package's `assets/` (an appearance pack's fonts, palette and images) and README are served from here; the App payload carries dist/ whole.
  // The layout is what apps/server/src/plugins/package-root.ts looks for, and a left-out vendor ships nothing.
  await rm('dist/integrations', { recursive: true, force: true }); // Legacy build output, never user data.
  await rm('dist/plugins', { recursive: true, force: true });
  for (const vendor of (await readdir('plugins', { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory() && !excludedVendors.has(entry.name.toLowerCase()))) {
    for (const pack of (await readdir(`plugins/${vendor.name}`, { withFileTypes: true })).filter(entry => entry.isDirectory())) {
      const assets = `plugins/${vendor.name}/${pack.name}/assets`;
      if ((await stat(assets).catch(() => undefined))?.isDirectory()) await cp(assets, `dist/${assets}`, { recursive: true });
      // Its README (`README.md`, `README.<language>.md`), for 介绍 in the plugin's details.
      for (const file of (await readdir(`plugins/${vendor.name}/${pack.name}`)).filter(name => /^README(\.[A-Za-z-]+)?\.md$/.test(name))) {
        await mkdir(`dist/plugins/${vendor.name}/${pack.name}`, { recursive: true });
        await copyFile(`plugins/${vendor.name}/${pack.name}/${file}`, `dist/plugins/${vendor.name}/${pack.name}/${file}`);
      }
    }
  }
  await chmod('dist/cli.js',0o755);
  execFileSync(process.execPath, ['scripts/build-info.mjs', '--verify', snapshot], { stdio: 'inherit' });
  // The offline record is byte-for-byte the input used for the embedded identity.
  await writeFile('dist/build-info.json', captured);
} finally {
  await rm(directory, { recursive: true, force: true });
}
