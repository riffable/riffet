import { readFile, mkdir, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Metafile } from 'esbuild';

const development = import.meta.url.endsWith('.ts');
const root = development ? resolve(fileURLToPath(new URL('../../../../', import.meta.url))) : undefined;
const require = createRequire(import.meta.url);
const pdfRoot = dirname(require.resolve('pdfjs-dist/package.json'));

export async function buildPreviewAssets(directory: string): Promise<Metafile> {
  const { build } = await import('esbuild');
  const source = root ?? process.cwd();
  const worker = await readFile(join(pdfRoot, 'legacy/build/pdf.worker.min.mjs'), 'utf8');
  await mkdir(directory, { recursive: true });
  const { metafile } = await build({
    entryPoints: { pdf: join(source, 'apps/server/src/previews/browser-pdf.ts'), model: join(source, 'apps/server/src/previews/browser-model.ts') },
    outdir: directory, bundle: true, platform: 'browser', format: 'iife', target: ['chrome110', 'safari16.4'],
    minify: true, legalComments: 'eof', metafile: true, define: { __RIFFET_PDF_WORKER__: JSON.stringify(worker) },
  });
  return metafile;
}

let building: Promise<Metafile> | undefined;
const browserScripts = new Map<string, Promise<string>>();
export function browserScript(kind: 'pdf' | 'model'): Promise<string> {
  let pending = browserScripts.get(kind);
  if (!pending) {
    pending = (async () => {
      const directory = development ? join(root!, '.riffet/preview-assets') : fileURLToPath(new URL('./preview-assets/', import.meta.url));
      if (development) await (building ??= buildPreviewAssets(directory).catch(error => { building = undefined; throw error; }));
      return readFile(join(directory, `${kind}.js`), 'utf8');
    })().catch(error => { browserScripts.delete(kind); throw error; });
    browserScripts.set(kind, pending);
  }
  return pending;
}

let fonts: Promise<{ cmaps: Record<string, string>; standardFonts: Record<string, string> }> | undefined;
export function pdfFonts(): NonNullable<typeof fonts> {
  return fonts ??= Promise.all(['cmaps', 'standard_fonts'].map(async directory => {
    const names = (await readdir(join(pdfRoot, directory))).filter(name => /\.(?:bcmap|pfb|ttf)$/i.test(name));
    return Object.fromEntries(await Promise.all(names.map(async name => [name, (await readFile(join(pdfRoot, directory, name))).toString('base64')])));
  })).then(([cmaps, standardFonts]) => ({ cmaps, standardFonts }));
}

let mathCss: Promise<string> | undefined;
export function mathStyles(): Promise<string> {
  return mathCss ??= (async () => {
    const directory = dirname(require.resolve('katex/dist/katex.min.css'));
    const css = (await readFile(join(directory, 'katex.min.css'), 'utf8')).replace(/(url\(fonts\/[^)]+\.woff2\) format\("woff2"\)),url\(fonts\/[^)]+\.woff\) format\("woff"\),url\(fonts\/[^)]+\.ttf\) format\("truetype"\)/g, '$1');
    const references = [...new Set([...css.matchAll(/url\((fonts\/[^)]+)\)/g)].map(match => match[1]!))];
    const embedded = await Promise.all(references.map(async reference => {
      const extension = reference.slice(reference.lastIndexOf('.') + 1);
      return [reference, `data:font/${extension};base64,${(await readFile(join(directory, reference))).toString('base64')}`] as const;
    }));
    return embedded.reduce((result, [from, to]) => result.split(`url(${from})`).join(`url(${to})`), css);
  })();
}
