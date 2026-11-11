import { readFile } from 'node:fs/promises';
import { AppError } from './errors.js';

// The same static-resource contract as the visualization producer. No app origin or API access.
const resources = 'data: blob: https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://esm.sh https://fonts.bunny.net https://fonts.googleapis.com https://fonts.gstatic.com https://unpkg.com';
export const VISUALIZATION_CSP = [
  'sandbox allow-scripts', "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${resources}`,
  `style-src 'unsafe-inline' ${resources}`, `img-src ${resources}`, `font-src ${resources}`,
  `media-src ${resources}`, 'worker-src blob:', "connect-src 'none'", "frame-src 'none'",
  "object-src 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ');
export const MAX_VISUALIZATION_BYTES = 1_000_000;

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
let assets: Promise<{ css: string; kit: string }> | undefined;
function loadAssets() {
  return assets ??= Promise.all([
    readFile(new URL('./visualization/assets/visualize.css', import.meta.url), 'utf8'),
    readFile(new URL('./visualization/assets/visualize.html', import.meta.url), 'utf8'),
  ]).then(([css, kit]) => ({ css, kit })).catch((error) => { assets = undefined; throw error; });
}

// Local interaction state only; the preview receives no host commands, credentials or message API.
const stateBridge = `<script>(function(){
  let state = null;
  window.openai = {
    get widgetState(){ return state; },
    setWidgetState(next){ state = next; return Promise.resolve(); }
  };
})();</script>`;

/**
 * Finds the byte-offset span `[start, end)` of a top-level HTML tag in `html`, skipping comments
 * and raw-text elements (`script`, `style`, `textarea`, `title`, `xmp`) so strings like `</body>`
 * inside inline JavaScript or comments are never mistaken for real document structure.
 */
function findHtmlTag(html: string, name: string, fromLast = false): { start: number; end: number } | undefined {
  const lower = html.toLowerCase();
  const target = name.toLowerCase();
  const rawContainers = new Set(['script', 'style', 'textarea', 'title', 'xmp']);
  let found: { start: number; end: number } | undefined;
  let index = 0;
  while (index < lower.length) {
    const lt = lower.indexOf('<', index);
    if (lt < 0) break;
    if (lower.startsWith('<!--', lt)) {
      const endComment = lower.indexOf('-->', lt + 4);
      index = endComment < 0 ? lower.length : endComment + 3;
      continue;
    }
    const rest = lower.slice(lt);
    const match = /^<(\/?[a-z][a-z0-9:-]*|\!doctype)\b/i.exec(rest);
    if (!match) { index = lt + 1; continue; }
    const tag = match[1]!.toLowerCase();
    let cursor = lt + match[0].length;
    let quote = '';
    while (cursor < lower.length) {
      const ch = lower[cursor]!;
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        cursor += 1;
        break;
      }
      cursor += 1;
    }
    if (tag === target) {
      found = { start: lt, end: cursor };
      if (!fromLast) return found;
    }
    if (rawContainers.has(tag) && !lower.slice(lt, cursor).trimEnd().endsWith('/>')) {
      const closePattern = new RegExp(`</${tag}\\s*>`, 'i');
      const closeMatch = closePattern.exec(lower.slice(cursor));
      index = closeMatch ? cursor + closeMatch.index + closeMatch[0].length : lower.length;
      continue;
    }
    index = cursor;
  }
  return found;
}

/** Wrap the explicit visualization source with its utilities, not the workbench's DOM or styles. */
export async function renderVisualization(source: string, title: string, scheme?: string): Promise<string> {
  if (Buffer.byteLength(source, 'utf8') > MAX_VISUALIZATION_BYTES) throw new AppError('VISUALIZATION_TOO_LARGE', 'Preview exceeds the 1 MB limit; open the source instead', 413, undefined, { limit: '1 MB' });
  if (source.includes('\0')) throw new AppError('INVALID_VISUALIZATION', 'A visualization preview must be an HTML text', 415, undefined, { subject: 'text' });
  const { css, kit } = await loadAssets();
  const colorScheme = scheme === 'dark' ? 'dark' : scheme === 'light' ? 'light' : 'light dark';
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><style>${css}\n:root{color-scheme:${colorScheme}}body{padding:16px}</style>${stateBridge}`;
  const runtime = kit.replace('<!--__INLINE_VISUALIZATION_FRAGMENT__-->', '');
  // Complete HTML documents are also useful artifacts. Insert the prelude without nesting html,
  // head or body tags, while a fragment gets the complete document the producer expects the host to own.
  if (/^\s*(?:<!--[^]*?-->\s*)*(?:<html(?:\s|>)|<!doctype\s)/i.test(source)) {
    let page = source;
    const headOpen = findHtmlTag(page, 'head');
    const htmlOpen = !headOpen ? findHtmlTag(page, 'html') : undefined;
    const doctypeOpen = !headOpen && !htmlOpen ? findHtmlTag(page, '!doctype') : undefined;
    if (headOpen) page = page.slice(0, headOpen.end) + head + page.slice(headOpen.end);
    else if (htmlOpen) page = `${page.slice(0, htmlOpen.end)}<head>${head}</head>${page.slice(htmlOpen.end)}`;
    else if (doctypeOpen) page = `${page.slice(0, doctypeOpen.end)}<head>${head}</head>${page.slice(doctypeOpen.end)}`;
    const bodyClose = findHtmlTag(page, '/body', true);
    return bodyClose ? `${page.slice(0, bodyClose.start)}${runtime}${page.slice(bodyClose.start)}` : page + runtime;
  }
  return `<!doctype html><html><head><title>${escape(title)}</title>${head}</head><body>${source}\n${runtime}</body></html>`;
}
