import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * The released baseline of the plugin SDK's TypeScript surface, the counterpart of the contract
 * snapshots (`scripts/gen-contracts.ts`): the declaration files of a package's public entry as they
 * were when its version was released, in `packages/<package>/released/<package.json version>/`.
 * `<package>/src/released-compat.ts` compares them with the current source inside the ordinary
 * `pnpm typecheck`.
 *
 * - `@riffet/plugin-api`: the root entry (`src/index.ts` and the package files it references).
 * - `@riffet/plugin-web`: the isolated-view bridge protocol only (`src/bridge.ts`); the in-app React
 *   surface is experimental.
 *
 * Imports of `@riffet/contracts` stay as written; the contracts have their own guard and the
 * baseline resolves them to the current contracts through the tsconfig paths.
 *
 * `--check` only requires that the directory of the current version exists, so a version bump
 * without a baseline fails. It never regenerates a released baseline. `pnpm gen:plugin-api`, run
 * when the SDK version is bumped, writes the baseline of the current version (replacing that
 * version's directory); older directories stay.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');

const PACKAGES = [
  { dir: 'packages/plugin-api', entry: 'src/index.ts' },
  { dir: 'packages/plugin-web', entry: 'src/bridge.ts' },
];

let failed = false;
for (const { dir, entry } of PACKAGES) {
  const packageDir = resolve(root, dir);
  const pkg = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8')) as { name: string; version: string };
  const outDir = resolve(packageDir, 'released', pkg.version);
  if (checkOnly) {
    if (!existsSync(outDir)) {
      console.error(`${pkg.name}@${pkg.version} has no released baseline at ${relative(root, outDir)}; run \`pnpm gen:plugin-api\` when releasing.`);
      failed = true;
    }
    continue;
  }
  rmSync(outDir, { recursive: true, force: true });
  const files = emitBaseline(packageDir, entry, outDir);
  console.log(`${pkg.name}@${pkg.version}: ${files.length} declaration file(s) in ${relative(root, outDir)}`);
}
if (failed) process.exit(1);

function emitBaseline(packageDir: string, entry: string, outDir: string): string[] {
  const configPath = resolve(root, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const options: ts.CompilerOptions = {
    ...parsed.options,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    incremental: false,
    outDir,
    rootDir: resolve(packageDir, 'src'),
  };
  const program = ts.createProgram([resolve(packageDir, entry)], options);
  const written: string[] = [];
  program.emit(undefined, (fileName, text) => {
    const rel = relative(outDir, fileName);
    // Only this package's own files; the contracts files the program also read are not baseline.
    if (rel.startsWith('..')) return;
    mkdirSync(dirname(fileName), { recursive: true });
    writeFileSync(fileName, text);
    written.push(rel.split(sep).join('/'));
  }, undefined, true);
  return written;
}
