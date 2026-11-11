import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import ts from 'typescript';

// Build distributable SDKs, never publishing them. Consumers can pin the resulting archives in
// their own plugin directory; neither generated JS nor declarations refer to this checkout.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const at = process.argv.indexOf('--out');
const output = resolve(at >= 0 ? process.argv[at + 1] : join(root, 'dist/plugin-sdk'));
const temporary = await mkdtemp(join(tmpdir(), 'riffet-plugin-sdk-'));
const contractsTypes = join(temporary, 'contracts/dist/index.d.ts');
const configs = [
  { folder: 'contracts', entries: { index: 'index.ts' } },
  { folder: 'plugin-api', entries: { index: 'index.ts', manifest: 'manifest.ts', tooling: 'tooling.ts', 'package-files': 'package-files.ts', cli: 'cli.ts', agent: 'agent.ts' } },
  { folder: 'plugin-web', entries: { index: 'index.ts', bridge: 'bridge.ts', 'bridge-client': 'bridge-client.ts' } },
];
await mkdir(output, { recursive: true });
await mkdir(join(temporary, 'node_modules', '@riffet'), { recursive: true });
for (const name of ['zod', 'esbuild', 'fflate', 'react']) await symlink(join(root, 'node_modules', name), join(temporary, 'node_modules', name), 'dir');
await symlink(join(temporary, 'contracts'), join(temporary, 'node_modules', '@riffet', 'contracts'), 'dir');
try {
  for (const { folder, entries } of configs) {
    const source = join(root, 'packages', folder, 'src');
    const directory = join(temporary, folder);
    const dist = join(directory, 'dist');
    await mkdir(dist, { recursive: true });
    const metadata = JSON.parse(await readFile(join(root, 'packages', folder, 'package.json'), 'utf8'));
    await writeFile(join(directory, 'package.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    await cp(join(root, 'LICENSE'), join(directory, 'LICENSE'));
    await cp(join(root, 'NOTICE'), join(directory, 'NOTICE'));
    const readme = join(root, 'packages', folder, 'README.md');
    await cp(readme, join(directory, 'README.md')).catch(() => {});
    const rootNames = (await readdir(source, { recursive: true, encoding: 'utf8' })).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts')).map(name => join(source, name));
    const options = { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, esModuleInterop: true, resolveJsonModule: true, skipLibCheck: true, declaration: true, emitDeclarationOnly: true, rootDir: source, outDir: dist, types: ['node', 'react'], baseUrl: root, paths: { '@contracts': [contractsTypes], '@riffet/contracts': [contractsTypes] } };
    if (folder === 'contracts') delete options.paths;
    const program = ts.createProgram(rootNames, options);
    const diagnostics = [...ts.getPreEmitDiagnostics(program), ...program.emit().diagnostics];
    if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: file => file, getCurrentDirectory: () => root, getNewLine: () => '\n' }));
    for (const name of await readdir(dist, { recursive: true, encoding: 'utf8' })) if (name.endsWith('.d.ts')) {
      const file = join(dist, name);
      await writeFile(file, (await readFile(file, 'utf8')).replaceAll("'@contracts'", "'@riffet/contracts'"));
    }
    await build({ absWorkingDir: root, entryPoints: Object.fromEntries(Object.entries(entries).map(([name, file]) => [name, join(source, file)])), outdir: dist, bundle: true, format: 'esm', platform: folder === 'plugin-web' ? 'browser' : 'node', target: folder === 'plugin-web' ? 'es2023' : 'node24', packages: 'external', alias: { '@contracts': join(root, 'packages/contracts/src/index.ts'), '@riffet/contracts': join(root, 'packages/contracts/src/index.ts') }, external: ['@riffet/contracts'], legalComments: 'linked' });
    if (folder === 'plugin-api') {
      await chmod(join(dist, 'cli.js'), 0o755);
      const manifest = await import(pathToFileURL(join(dist, 'manifest.js')).href);
      await writeFile(join(directory, 'riffet-plugin.schema.json'), `${JSON.stringify(manifest.manifestJsonSchema, null, 2)}\n`);
    }
    const npm = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output], { cwd: directory, encoding: 'utf8' });
    if (npm.status !== 0) throw new Error(npm.stderr || npm.stdout);
    const [{ filename }] = JSON.parse(npm.stdout);
    console.log(`${metadata.name}@${metadata.version}: ${join(output, filename)}`);
    // Keep the generated package tree as the stable local build output used by package exports.
    const localDist = join(root, 'packages', folder, 'dist');
    await rm(localDist, { recursive: true, force: true }); await cp(dist, localDist, { recursive: true });
    if (folder === 'plugin-api') await cp(join(directory, 'riffet-plugin.schema.json'), join(root, 'packages', folder, 'riffet-plugin.schema.json'));
  }
} finally { await rm(temporary, { recursive: true, force: true }); }
