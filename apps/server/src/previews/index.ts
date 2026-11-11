import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '../errors.js';
import { browserScript, pdfFonts, mathStyles } from './browser-assets.js';
import { contentPreviewPage } from './content.js';
import { escapeHtml, inlineScript, previewDocument, previewTheme, scriptHash, scriptJson, type PreviewTheme, type PreviewQuery } from './document.js';
import { decodePreviewText, diagramLanguage, extensionOf, MAX_PREVIEW_FILE_BYTES, previewKind, type PreviewKind } from './formats.js';

type Parsed = { body: string; styles?: string; scripts?: string[] };
type Input = { data: Uint8Array; name: string; kind: PreviewKind; theme: PreviewTheme; databasePath?: string };
const MAX_CONCURRENT = 2, MAX_QUEUED = 8;
let active = 0;
const waiting: (() => void)[] = [];

/** Expensive parsers live outside the API process, with a memory budget and a hard deadline. */
async function parse(input: Input): Promise<Parsed> {
  if (active >= MAX_CONCURRENT) {
    if (waiting.length >= MAX_QUEUED) throw new AppError('PREVIEW_BUSY', 'Too many previews are queued; try again shortly', 503);
    await new Promise<void>(resolve => waiting.push(resolve));
  } else active++;
  let temporary: string | undefined;
  try {
    if (input.kind === 'database') {
      temporary = await mkdtemp(join(tmpdir(), 'riffet-preview-'));
      input.databasePath = join(temporary, 'snapshot.sqlite');
      await writeFile(input.databasePath, input.data, { mode: 0o600 });
      input.data = new Uint8Array();
    }
    return await new Promise<Parsed>((resolve, reject) => {
      const development = import.meta.url.endsWith('.ts');
      const entry = fileURLToPath(new URL(development ? './worker.ts' : './preview-worker.js', import.meta.url));
      const child = fork(entry, [], { serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: ['--max-old-space-size=512', ...(development ? ['--import', createRequire(import.meta.url).resolve('tsx')] : [])], env: { ...process.env, NODE_OPTIONS: '' } });
      let settled = false;
      const done = (error?: Error, result?: Parsed) => {
        if (settled) return;
        settled = true; clearTimeout(timer); child.kill('SIGTERM');
        if (error) reject(error); else resolve(result!);
      };
      const timer = setTimeout(() => { child.kill('SIGKILL'); done(new AppError('PREVIEW_TIMEOUT', 'The file took too long to parse; download the original file to view it', 422)); }, 12_000);
      child.stderr?.resume();
      child.once('error', error => done(error));
      child.once('exit', () => done(new AppError('PREVIEW_FAILED', 'This file could not be parsed; download the original file to view it', 422)));
      child.once('message', (message: { ok: boolean; result?: Parsed; message?: string }) => {
        if (!message.ok || !message.result || typeof message.result.body !== 'string') return done(new AppError('PREVIEW_FAILED', message.message ? `This file could not be parsed: ${message.message}` : 'This file could not be parsed', 422));
        done(undefined, message.result);
      });
      child.send(input, error => { if (error) done(error); });
    });
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    const next = waiting.shift();
    if (next) next(); else active--;
  }
}

const mediaMime: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac' };

type Page = { html: string; csp: string };
type Resource = (path: string) => Promise<{ mimeType: string; data: Buffer }>;
const pages = new Map<string, { page: Page; bytes: number; at: number }>();
const pending = new Map<string, Promise<Page>>();
let cachedBytes = 0;

/** A short, bounded cache avoids parsing twice when a client validates a document before loading
 * its isolated HTTP frame. Callers still resolve scope and read the current bytes on every request. */
export async function renderFilePreview(data: Buffer, name: string, query: PreviewQuery = {}, resource?: Resource): Promise<Page> {
  if (data.byteLength > MAX_PREVIEW_FILE_BYTES) throw new AppError('PREVIEW_TOO_LARGE', 'Preview exceeds the 32 MB limit; download the original file', 413, undefined, { limit: '32 MB' });
  const kind = previewKind(name, data);
  if (resource && (kind === 'markdown' || kind === 'notebook')) return renderUncached(data, name, query, resource);
  const key = createHash('sha256').update(data).update(JSON.stringify([name, previewTheme(query)])).digest('base64url');
  const current = pages.get(key);
  if (current) {
    pages.delete(key);
    if (Date.now() - current.at < 30_000) { pages.set(key, current); return current.page; }
    cachedBytes -= current.bytes;
  }
  const running = pending.get(key);
  if (running) return running;
  const task = renderUncached(data, name, query).then(page => {
    const bytes = Buffer.byteLength(page.html) + Buffer.byteLength(page.csp);
    if (bytes <= 24 * 1024 * 1024) {
      while (pages.size && (pages.size >= 8 || cachedBytes + bytes > 24 * 1024 * 1024)) {
        const oldest = pages.keys().next().value!;
        cachedBytes -= pages.get(oldest)!.bytes; pages.delete(oldest);
      }
      pages.set(key, { page, bytes, at: Date.now() }); cachedBytes += bytes;
    }
    return page;
  }).finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}

async function renderUncached(data: Buffer, name: string, query: PreviewQuery = {}, resource?: Resource): Promise<Page> {
  if (data.byteLength > MAX_PREVIEW_FILE_BYTES) throw new AppError('PREVIEW_TOO_LARGE', 'Preview exceeds the 32 MB limit; download the original file', 413, undefined, { limit: '32 MB' });
  const kind = previewKind(name, data);
  const theme = previewTheme(query);
  const extension = extensionOf(name);
  if (kind === 'html') return contentPreviewPage(decodePreviewText(data) ?? '', 'html', theme);
  if (kind === 'diagram') {
    const { renderDiagramPage } = await import('../diagram-assets.js');
    const page = await renderDiagramPage(diagramLanguage(name));
    const params = new URLSearchParams({ source: decodePreviewText(data) ?? '', language: diagramLanguage(name), scheme: theme.dark ? 'dark' : 'light', color: theme.foreground, background: theme.background, line: theme.line, accent: theme.accent });
    const script = inlineScript(`location.hash=${scriptJson(params.toString())};`);
    // The fragment is populated before the renderer starts, without a second authenticated request.
    return { html: page.html.replace('<head>', `<head><script>${script}</script>`), csp: page.csp.replace('script-src ', `script-src ${scriptHash(script)} `) };
  }
  if (kind === 'pdf' || kind === 'model') {
    return previewDocument('<main id="preview"></main>', theme, [await browserScript(kind)], '', name, { data: data.toString('base64'), name, extension, theme, ...(kind === 'pdf' ? { assets: await pdfFonts() } : {}) });
  }
  if (kind === 'media') {
    const type = mediaMime[extension];
    const tag = type.startsWith('video/') ? 'video' : 'audio';
    return previewDocument(`<main class="media"><${tag} controls preload="metadata" playsinline src="data:${type};base64,${data.toString('base64')}"></${tag}></main>`, theme, [], '', name);
  }
  if (kind === 'font') {
    return previewDocument(`<main><div class="font-sample" contenteditable="true" spellcheck="false">Aa Bb Cc Dd Ee Ff Gg Hh Ii Jj Kk Ll Mm Nn<br>Oo Pp Qq Rr Ss Tt Uu Vv Ww Xx Yy Zz<br>0123456789<br>天地玄黄，宇宙洪荒。<br>The quick brown fox jumps over the lazy dog.</div></main>`, theme, [], `@font-face{font-family:RiffetPreview;src:url(data:font/${extension};base64,${data.toString('base64')})}`, name);
  }
  if (kind === 'image' && extension === 'svg') return contentPreviewPage(decodePreviewText(data) ?? '', 'svg', theme);
  if (kind === 'image' && extension === 'ico') return previewDocument(`<main class="media"><img alt="" src="data:image/x-icon;base64,${data.toString('base64')}"></main>`, theme, [], '', name);
  if (!kind) {
    const text = decodePreviewText(data);
    if (text === undefined) throw new AppError('UNSUPPORTED_PREVIEW', 'Download this format to view it', 415);
    return previewDocument(`<main><pre>${escapeHtml(text.slice(0, 512 * 1024))}</pre>${text.length > 512 * 1024 ? '<small>仅显示前 512 KB</small>' : ''}</main>`, theme, [], '', name);
  }
  const result = await parse({ data, name, kind, theme });
  if (resource && (kind === 'markdown' || kind === 'notebook')) {
    let bytes = 0, count = 0;
    const sources = [...new Set([...result.body.matchAll(/<img\b[^>]*\bsrc="([^"<>]+)"/gi)].map(match => match[1]!))];
    for (const source of sources) {
      if (count >= 24 || bytes >= 12 * 1024 * 1024 || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(source)) continue;
      try {
        const file = await resource(source.replace(/&amp;/g, '&'));
        if (file.data.length + bytes > 12 * 1024 * 1024) continue;
        bytes += file.data.length; count++;
        result.body = result.body.split(`src="${source}"`).join(`src="data:${file.mimeType};base64,${file.data.toString('base64')}"`);
      } catch { /* A missing or scope-denied image remains a reference; it never gains filesystem access. */ }
    }
  }
  const scripts = [...(result.scripts ?? [])];
  if (kind === 'markdown' || kind === 'notebook') {
    const aliases: Record<string, string> = { mermaid: 'mermaid', mmd: 'mermaid', dot: 'dot', graphviz: 'dot', gv: 'dot', plantuml: 'plantuml', puml: 'plantuml', uml: 'plantuml', wsd: 'plantuml', d2: 'd2', vega: 'vega', 'vega-lite': 'vega', vegalite: 'vega', vl: 'vega' };
    const engines = [...new Set([...result.body.matchAll(/<code\b[^>]*class="language-([\w-]+)"/gi)].map(match => aliases[match[1]!.toLowerCase()]).filter(Boolean))];
    if (engines.length) {
      const { renderDiagramScript } = await import('../diagram-assets.js');
      scripts.push(...await Promise.all(engines.map(engine => renderDiagramScript(engine!))));
    }
  }
  const styles = (result.body.includes('class="katex') ? await mathStyles() : '') + (result.styles ?? '');
  return previewDocument(result.body, theme, scripts, styles, name);
}
