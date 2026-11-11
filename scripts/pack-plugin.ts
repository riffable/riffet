import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packSource, type ArchiveFormat } from '../packages/plugin-api/src/tooling.js';
export { archiveFiles, packPlugin, tarball, type ArchiveFormat, type Packed } from '../packages/plugin-api/src/tooling.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const out = args.indexOf('--out');
  const target = out >= 0 ? args[out + 1] : undefined;
  const formatFlag = args.indexOf('--format');
  const requested = formatFlag >= 0 ? args[formatFlag + 1] : target?.toLowerCase().endsWith('.zip') ? 'zip' : target?.toLowerCase().endsWith('.tar') ? 'tar' : 'tgz';
  const format = requested === 'tar.gz' ? 'tgz' : requested;
  const directory = args.find((item, index) => !item.startsWith('--') && (out < 0 || index !== out + 1) && (formatFlag < 0 || index !== formatFlag + 1));
  if ((out >= 0 && !target) || !['tgz', 'tar', 'zip'].includes(format ?? '')) { console.error('usage: pack-plugin.ts [directory] [--out file] [--format tgz|tar|zip]'); process.exitCode = 2; return; }
  const packed = await packSource(resolve(directory ?? '.'), { format: format as ArchiveFormat, out: target });
  const file = packed.file;
  console.log(`${file}\n${packed.id} ${packed.version} · ${packed.files} files · ${packed.archive.length} bytes · ${packed.integrity}\ncapabilities: ${packed.capabilities.join(', ') || 'none'}`);
  for (const warning of packed.warnings) console.warn(`warning: ${warning}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
