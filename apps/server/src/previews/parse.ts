import type { PreviewTheme } from './document.js';
import { MAX_PREVIEW_FILE_BYTES, type PreviewKind } from './formats.js';

export interface PreviewFragment {
  body: string;
  styles?: string;
  scripts?: string[];
  asset?: 'structured';
  data?: unknown;
  /** Image paths are resolved by the parent process, never by the parser worker. */
  images?: { token: string; sources: string[] }[];
}
export interface PreviewParseInput { data: Uint8Array; name: string; kind: PreviewKind; theme: PreviewTheme }

/** Runs only inside the preview worker. Resource limits and the document/CSP envelope belong to
 * its caller; parsers here return inert fragments and explicitly identified application scripts. */
export async function parsePreview(input: PreviewParseInput): Promise<PreviewFragment> {
  if (input.data.byteLength > MAX_PREVIEW_FILE_BYTES) throw new Error('文件超过预览大小限制');
  let result: PreviewFragment;
  switch (input.kind) {
    case 'document': case 'presentation':
      result = await (await import('./parse-document.js')).officePreview(input); break;
    case 'markdown':
      result = (await import('./parse-document.js')).markdownPreview(input); break;
    case 'notebook':
      result = await (await import('./parse-document.js')).notebookPreview(input); break;
    case 'spreadsheet': case 'table':
      result = await (await import('./parse-tables.js')).spreadsheetPreview(input); break;
    case 'archive':
      result = (await import('./parse-tables.js')).archivePreview(input); break;
    case 'structured':
      result = await (await import('./parse-structured.js')).structuredPreview(input); break;
    case 'image':
      result = await (await import('./parse-image.js')).imagePreview(input); break;
    default: throw new Error('此文件需要使用系统预览');
  }
  const bytes = Buffer.byteLength(result.body) + Buffer.byteLength(result.styles ?? '')
    + (result.scripts ?? []).reduce((size, script) => size + Buffer.byteLength(script), 0);
  if (bytes > MAX_PREVIEW_FILE_BYTES) throw new Error('转换后的内容超过预览大小限制');
  return result;
}
