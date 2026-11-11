import type { FastifyInstance } from 'fastify';
import type { Metafile } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import { encodingFor } from './static-assets.js';

type Engine = 'mermaid' | 'dot' | 'plantuml' | 'd2' | 'vega';
type Encoding = 'br' | 'gzip' | 'identity';
export interface DiagramPage { html: string; csp: string }
interface CachedPage extends DiagramPage { script: string; body: Record<Encoding, Buffer>; etag: string }
const engines: Engine[] = ['mermaid', 'dot', 'plantuml', 'd2', 'vega'];
const cached = new Map<Engine, Promise<CachedPage>>();
const aliases: Record<string, Engine> = {
  mermaid: 'mermaid', mmd: 'mermaid',
  dot: 'dot', graphviz: 'dot', gv: 'dot',
  plantuml: 'plantuml', puml: 'plantuml', uml: 'plantuml', wsd: 'plantuml',
  d2: 'd2',
  vega: 'vega', 'vega-lite': 'vega', vegalite: 'vega', vl: 'vega',
};

function engineFor(language: string): Engine {
  const engine = aliases[language.toLowerCase()];
  if (!engine || !engines.includes(engine)) throw new Error('Unsupported diagram language');
  return engine;
}

async function bundleEngine(engine: Engine): Promise<{ text: string; metafile: Metafile }> {
  const { build } = await import('esbuild');
  const result = await build({
    entryPoints: [fileURLToPath(new URL(`./previews/diagram-${engine}.ts`, import.meta.url))],
    bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2022',
    // TeaVM emits nested labels around try/catch. esbuild's syntax minifier currently rewrites
    // some of these into undeclared labels; keep that generated engine's control flow intact.
    minify: engine !== 'plantuml', minifyWhitespace: true, legalComments: 'inline', logLevel: 'silent', metafile: true,
  });
  const output = result.outputFiles?.[0];
  if (!output) throw new Error(`Unable to bundle ${engine}`);
  return { text: output.text, metafile: result.metafile };
}

/** Build scripts call this once; packaged servers only read these portable JavaScript assets. */
export async function buildDiagramAssets(outputDirectory: string): Promise<Metafile[]> {
  await mkdir(outputDirectory, { recursive: true });
  return Promise.all(engines.map(async (engine) => {
    const { text, metafile } = await bundleEngine(engine);
    await writeFile(join(outputDirectory, `${engine}.js`), text);
    return metafile;
  }));
}

function page(engine: Engine): Promise<CachedPage> {
  let pending = cached.get(engine);
  if (pending) return pending;
  pending = (async () => {
    let script: string;
    try { script = await readFile(new URL(`./diagram-assets/${engine}.js`, import.meta.url), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !import.meta.url.endsWith('.ts')) throw error;
      script = (await bundleEngine(engine)).text;
    }
    script = `try{${script}\n}catch(error){console.error(error);const params=new URLSearchParams(location.hash.slice(1));document.documentElement.dataset.riffetMermaid='error';const target=document.getElementById('diagram');if(target)target.textContent=params.get('source')||'';if(target&&parent!==window)parent.postMessage({type:'riffet-mermaid',id:params.get('id'),status:'error'},'*');}`.replace(/<\/script/gi, '<\\/script');
    const digest = createHash('sha256').update(script).digest('base64');
    // Vega uses its official AST interpreter. WASM and Blob workers are local engine
    // implementations; sources and data cannot initiate network or host API requests.
    const evaluation = ['dot', 'plantuml', 'd2'].includes(engine) ? " 'wasm-unsafe-eval'" : '';
    const csp = `sandbox allow-scripts; default-src 'none'; script-src 'sha256-${digest}'${evaluation}; worker-src blob:; connect-src data: blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>html,body{margin:0;padding:0;background:transparent}#diagram{display:inline-block;max-width:100%;vertical-align:top;white-space:pre-wrap;font:14px/1.6 system-ui,sans-serif}#diagram>svg{display:block;max-width:100%;height:auto}</style></head><body><div id="diagram"></div><script>${script}</script></body></html>`;
    const identity = Buffer.from(html);
    const [br, gz] = await Promise.all([
      promisify(brotliCompress)(identity, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }),
      promisify(gzip)(identity),
    ]);
    return { html, csp, script, body: { identity, br, gzip: gz }, etag: createHash('sha256').update(identity).digest('base64url') };
  })().catch((error) => { cached.delete(engine); throw error; });
  cached.set(engine, pending);
  return pending;
}

/** Fragment initialization matches /mermaid, and no diagram source is ever sent to this route. */
export async function renderDiagramPage(language = 'mermaid'): Promise<DiagramPage> {
  const { html, csp } = await page(engineFor(language));
  return { html, csp };
}

/** The same cached engine enriches fenced code blocks in an already isolated file document. */
export async function renderDiagramScript(language: string): Promise<string> {
  return (await page(engineFor(language))).script;
}

export function registerDiagramAssets(app: FastifyInstance): void {
  for (const path of ['/diagram', '/mermaid']) app.get<{ Querystring: { engine?: string } }>(path, async (request, reply) => {
    const encoding = encodingFor(request.headers['accept-encoding']);
    if (!encoding) return reply.code(406).send();
    let engine: Engine;
    try { engine = engineFor(request.query.engine ?? 'mermaid'); }
    catch { return reply.code(400).send({ error: 'Unsupported diagram language' }); }
    const asset = await page(engine);
    const etag = `"${asset.etag}-${encoding}"`;
    reply.type('text/html; charset=utf-8')
      .header('Content-Security-Policy', asset.csp)
      .header('Cache-Control', 'public, no-cache')
      .header('Vary', 'Accept-Encoding').header('ETag', etag);
    if (request.headers['if-none-match']?.split(',').some((value) => value.trim().replace(/^W\//, '') === etag || value.trim() === '*')) return reply.code(304).send();
    if (encoding !== 'identity') reply.header('Content-Encoding', encoding);
    return reply.header('Content-Length', asset.body[encoding].length).send(asset.body[encoding]);
  });
}
