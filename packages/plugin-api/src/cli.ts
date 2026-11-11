#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { manifestJsonSchema } from './manifest.js';
import { buildPlugin, packSource, validatePackage, watchPlugin, type ArchiveFormat } from './tooling.js';

const args = process.argv.slice(2);
const command = args.shift() ?? 'help';
const flag = (name: string): string | undefined => { const at = args.indexOf(name); if (at < 0) return undefined; const value = args[at + 1]; if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`); args.splice(at, 2); return value; };
const entries = () => { const values: string[] = []; let value: string | undefined; while ((value = flag('--entry')) !== undefined) values.push(value); return values; };
const directory = (fallback = '.') => { const source = args.shift() ?? fallback; if (source.startsWith('--') || args.length) throw new Error(`Unknown argument: ${args[0] ?? source}`); return resolve(source); };

async function main(): Promise<void> {
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log('riffet-plugin build [directory] [--entry name=source]\nriffet-plugin check [directory]\nriffet-plugin pack [directory] [--format tgz|tar|zip] [--out file] [--entry name=source]\nriffet-plugin dev [directory] [--entry name=source] [--riffet executable] [--build-only]\nriffet-plugin schema [--out file]');
    return;
  }
  if (command === 'schema') { const out = flag('--out'); const text = `${JSON.stringify(manifestJsonSchema, null, 2)}\n`; if (args.length) throw new Error(`Unknown argument: ${args[0]}`); if (out) { await mkdir(dirname(resolve(out)), { recursive: true }); await writeFile(out, text); } else process.stdout.write(text); return; }
  if (command === 'check') { const result = await validatePackage(directory('dist/package')); console.log(`${result.manifest.id} ${result.manifest.version}: valid`); return; }
  if (command === 'pack') {
    const out = flag('--out'), requested = flag('--format');
    const format = requested === 'tar.gz' ? 'tgz' : requested;
    if (format && !['tgz', 'tar', 'zip'].includes(format)) throw new Error('format must be tgz, tar or zip');
    const extra = entries();
    const result = await packSource(directory(), { out, format: format as ArchiveFormat | undefined, entries: extra });
    console.log(`${result.file}\n${result.integrity}\ncapabilities: ${result.capabilities.join(', ') || 'none'}`);
    for (const warning of result.warnings) console.warn(warning);
    return;
  }
  if (command === 'build') {
    const extra = entries();
    const result = await buildPlugin(directory(), { entries: extra });
    console.log(`${result.manifest.id} ${result.manifest.version}: ${result.directory}`);
    return;
  }
  if (command === 'dev') {
    const executable = flag('--riffet') ?? 'riffet', extra = entries();
    // --reload was previously opt-in; host development now always links and reloads.
    const reload = args.indexOf('--reload'); if (reload >= 0) args.splice(reload, 1);
    const buildOnly = args.indexOf('--build-only'); if (buildOnly >= 0) args.splice(buildOnly, 1);
    const source = directory();
    if (buildOnly >= 0) {
      const watcher = await watchPlugin(source, { entries: extra, onBuild: result => { console.log(`${result.manifest.id} ${result.manifest.version}: ${result.directory}`); }, onError: error => { console.error(error instanceof Error ? error.message : error); } });
      const close = () => { watcher.close(); process.removeListener('SIGINT', close); process.removeListener('SIGTERM', close); };
      process.once('SIGINT', close); process.once('SIGTERM', close);
      return;
    }
    const child = spawn(executable, ['plugin', 'dev', source, ...extra.flatMap(entry => ['--entry', entry])], { stdio: 'inherit' });
    child.once('error', error => { console.error(error.message); process.exitCode = 1; });
    child.once('exit', code => { process.exitCode = code ?? 1; });
    const interrupt = () => { child.kill('SIGINT'); }, terminate = () => { child.kill('SIGTERM'); };
    process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
    child.once('close', () => { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); });
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
