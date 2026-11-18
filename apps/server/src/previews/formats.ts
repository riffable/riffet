import { extname } from 'node:path';

export const MAX_PREVIEW_FILE_BYTES = 32 * 1024 * 1024;
export type PreviewKind = 'markdown' | 'html' | 'image' | 'pdf' | 'document' | 'presentation' | 'spreadsheet' | 'table' | 'notebook' | 'structured' | 'diagram' | 'media' | 'archive' | 'database' | 'model' | 'font';

const formats: Record<string, PreviewKind> = {};
for (const [kind, extensions] of Object.entries({
  markdown: 'md markdown mdown mkd mdx mdc', html: 'html htm xhtml',
  image: 'svg ico tif tiff heic heif', pdf: 'pdf',
  document: 'docx docm dotx odt ott rtf epub tex latex ltx',
  presentation: 'pptx pptm ppsx potx odp otp odg otg',
  spreadsheet: 'xlsx xlsm xlsb xls xltx xltm ods ots numbers', table: 'csv tsv',
  notebook: 'ipynb', structured: 'json jsonl ndjson yaml yml xml toml',
  diagram: 'mmd mermaid dot gv puml plantuml wsd d2 vega vl',
  media: 'mp4 m4v webm mov ogv mp3 wav ogg oga m4a aac flac opus',
  archive: 'zip jar war apk ipa tar tgz gz gzip', database: 'sqlite sqlite3 db db3',
  model: 'glb gltf obj stl ply', font: 'ttf otf woff woff2',
})) for (const extension of extensions.split(' ')) formats[extension] = kind as PreviewKind;

export const extensionOf = (name: string): string => extname(name).slice(1).toLowerCase();
export function previewKind(name: string, sample?: Uint8Array): PreviewKind | undefined {
  const extension = extensionOf(name);
  if (sample && Buffer.from(sample.subarray(0, 16)).toString('ascii').startsWith('SQLite format 3\0')) return 'database';
  if (sample && Buffer.from(sample.subarray(0, 5)).toString('ascii') === '%PDF-') return 'pdf';
  if (/\.(?:vega|vl|vega-lite)\.json$/i.test(name)) return 'diagram';
  return formats[extension];
}

export function diagramLanguage(name: string): string {
  const extension = extensionOf(name);
  if (/\.(?:vl|vega-lite)(?:\.json)?$/i.test(name)) return 'vega-lite';
  if (/\.vega\.json$/i.test(name)) return 'vega';
  return ({ mmd: 'mermaid', gv: 'dot', puml: 'plantuml', wsd: 'plantuml' } as Record<string, string>)[extension] ?? extension;
}

/** Decode BOM-marked UTF-16 and legacy Chinese text without mistaking it for binary. */
export function decodePreviewText(data: Uint8Array): string | undefined {
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) return new TextDecoder('utf-16le').decode(data);
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) return new TextDecoder('utf-16be').decode(data);
  const sample = data.subarray(0, 8192);
  if (sample.includes(0)) {
    const pairs = Math.floor(sample.length / 2);
    let even = 0, odd = 0;
    for (let i = 0; i < pairs * 2; i += 2) { if (sample[i] === 0) even++; if (sample[i + 1] === 0) odd++; }
    if (pairs > 2 && odd > pairs * .6 && even < pairs * .1) return new TextDecoder('utf-16le').decode(data);
    if (pairs > 2 && even > pairs * .6 && odd < pairs * .1) return new TextDecoder('utf-16be').decode(data);
    return undefined;
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data); }
  catch {
    try { return new TextDecoder('gb18030', { fatal: true }).decode(data); }
    catch { return new TextDecoder('utf-8').decode(data); }
  }
}
