import { gunzipSync } from 'node:zlib';
import { unzipSync } from 'fflate';
import * as XLSX from 'xlsx';
import { escapeHtml } from './document.js';
import { decodePreviewText, extensionOf, MAX_PREVIEW_FILE_BYTES } from './formats.js';
import type { PreviewFragment, PreviewParseInput } from './parse.js';

const ROWS = 1000, COLS = 100, SHEETS = 12, CELLS = 100_000, ENTRIES = 10_000;
const tableScript = `document.addEventListener('click',event=>{const button=event.target.closest('button[data-sheet]');if(!button)return;document.querySelectorAll('[data-sheet-panel]').forEach(panel=>{panel.hidden=panel.dataset.sheetPanel!==button.dataset.sheet});document.querySelectorAll('button[data-sheet]').forEach(tab=>tab.setAttribute('aria-selected',String(tab===button)))})`;

/** ZIP-backed workbooks get an expansion preflight before SheetJS touches any member. Listing
 * through a false filter reads only the central directory, never inflating attacker-supplied data. */
function checkWorkbookZip(data: Uint8Array): void {
  if (data[0] !== 0x50 || data[1] !== 0x4b) return;
  let bytes = 0, entries = 0;
  unzipSync(data, { filter(file) {
    bytes += file.originalSize;
    if (++entries > ENTRIES || bytes > 64 * 1024 * 1024) throw new Error('工作簿解压后超过预览限制');
    return false;
  } });
}

export async function spreadsheetPreview({ data, name }: PreviewParseInput): Promise<PreviewFragment> {
  checkWorkbookZip(data);
  const ext = extensionOf(name);
  const source = ext === 'csv' || ext === 'tsv' ? decodePreviewText(data) : data;
  if (source === undefined) throw new Error('无法读取表格文本编码');
  const options: XLSX.ParsingOptions = {
    type: typeof source === 'string' ? 'string' : 'array', dense: true, raw: true,
    cellHTML: false, cellStyles: false, cellFormula: false, cellNF: false,
    bookVBA: false, bookDeps: false, sheetRows: ROWS + 1,
    ...(ext === 'tsv' ? { FS: '\t' } : {}),
  };
  const metadata = XLSX.read(source, { ...options, bookSheets: true });
  const names = metadata.SheetNames.slice(0, SHEETS);
  const workbook = XLSX.read(source, { ...options, sheets: names });
  let budget = CELLS;
  let characters = 2_000_000;
  let clipped = metadata.SheetNames.length > SHEETS;
  const cellText = (value: unknown): string => {
    const raw = String(value ?? '');
    const shown = raw.slice(0, Math.min(32_768, characters));
    characters -= shown.length;
    if (shown.length < raw.length) clipped = true;
    return escapeHtml(shown) + (shown.length < raw.length ? '…' : '');
  };
  const panels = names.map((title, index) => {
    const sheet = workbook.Sheets[title];
    let table = '';
    if (sheet?.['!ref'] && budget > 0) {
      const range = XLSX.utils.decode_range(sheet['!ref']);
      const columns = Math.min(COLS, range.e.c - range.s.c + 1);
      const rows = Math.min(ROWS, range.e.r - range.s.r + 1, Math.floor(budget / Math.max(1, columns)));
      if (columns <= 0 || rows <= 0) return '';
      const end = { r: range.s.r + rows - 1, c: range.s.c + columns - 1 };
      clipped ||= end.r < range.e.r || end.c < range.e.c || !!sheet['!fullref'];
      const values = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '', blankrows: true, range: { s: range.s, e: end } });
      budget -= rows * columns;
      table = `<div class="table-scroll"><table><thead><tr><th></th>${Array.from({ length: columns }, (_, c) => `<th>${XLSX.utils.encode_col(range.s.c + c)}</th>`).join('')}</tr></thead><tbody>${values.map((row, r) => `<tr><th>${range.s.r + r + 1}</th>${Array.from({ length: columns }, (_, c) => `<td>${cellText(row[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    }
    return `<section class="sheet" data-sheet-panel="${index}" role="tabpanel" id="sheet-${index}"${index ? ' hidden' : ''}>${table}</section>`;
  });
  if (budget <= 0) clipped = true;
  const nav = `<nav role="tablist">${names.map((title, index) => `<button type="button" role="tab" data-sheet="${index}" aria-controls="sheet-${index}" aria-selected="${index === 0}">${escapeHtml(title)}</button>`).join('')}</nav>`;
  return { body: `<main>${nav}${panels.join('')}${clipped ? `<p class="muted">仅显示前 ${SHEETS} 个工作表、每表 ${ROWS} 行及 ${COLS} 列，合计最多 ${CELLS} 个单元格</p>` : ''}</main>`, scripts: [tableScript] };
}

interface ArchiveEntry { name: string; size: number; compressed?: number; type?: string }

function tarEntries(data: Uint8Array): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let offset = 0;
  let nextName: string | undefined;
  const text = (start: number, count: number) => new TextDecoder().decode(data.subarray(start, start + count)).replace(/\0.*$/s, '');
  while (offset + 512 <= data.length && entries.length < ENTRIES) {
    if (data.subarray(offset, offset + 512).every(value => value === 0)) break;
    const rawSize = text(offset + 124, 12).trim();
    if (!/^[0-7]+$/.test(rawSize)) throw new Error('归档文件大小字段无效');
    const size = Number.parseInt(rawSize, 8);
    const start = offset + 512;
    if (!Number.isSafeInteger(size) || size < 0 || start + size > data.length) throw new Error('归档文件内容不完整');
    const type = text(offset + 156, 1);
    const prefix = text(offset + 345, 155);
    const name = nextName ?? `${prefix ? prefix + '/' : ''}${text(offset, 100)}`;
    nextName = undefined;
    // GNU long paths are metadata only; nothing is ever extracted onto the filesystem.
    if (type === 'L') nextName = text(start, Math.min(size, 4096));
    else if (type !== 'x' && type !== 'g') entries.push({ name, size, type: type === '5' ? '目录' : type === '2' || type === '1' ? '链接' : '文件' });
    offset = start + Math.ceil(size / 512) * 512;
  }
  return entries;
}

export function archivePreview({ data, name }: PreviewParseInput): PreviewFragment {
  const ext = extensionOf(name);
  let entries: ArchiveEntry[];
  if (['zip', 'jar', 'war', 'apk', 'ipa'].includes(ext)) {
    entries = [];
    unzipSync(data, { filter(file) {
      if (entries.length < ENTRIES) entries.push({ name: file.name, size: file.originalSize, compressed: file.size, type: file.name.endsWith('/') ? '目录' : '文件' });
      return false;
    } });
  } else {
    const unpacked = ['gz', 'gzip', 'tgz'].includes(ext) ? gunzipSync(data, { maxOutputLength: MAX_PREVIEW_FILE_BYTES }) : data;
    const tar = ext === 'tar' || ext === 'tgz' || /\.tar\.(?:gz|gzip)$/i.test(name)
      || Buffer.from(unpacked.subarray(257, 262)).toString('ascii') === 'ustar';
    if (tar) entries = tarEntries(unpacked);
    else {
      const text = decodePreviewText(unpacked);
      if (text !== undefined) return { body: `<main><pre>${escapeHtml(text.slice(0, 2_000_000))}</pre>${text.length > 2_000_000 ? '<p class="muted">内容过长，仅显示前一部分</p>' : ''}</main>` };
      entries = [{ name: name.replace(/\.(?:gz|gzip)$/i, ''), size: unpacked.length, type: '文件' }];
    }
  }
  return { body: `<main><div class="table-scroll"><table><thead><tr><th>名称</th><th>大小</th><th>类型</th></tr></thead><tbody>${entries.map(entry => `<tr><td>${escapeHtml(entry.name.slice(0, 512) + (entry.name.length > 512 ? '…' : ''))}</td><td>${entry.size.toLocaleString('en-US')} B</td><td>${entry.type ?? ''}</td></tr>`).join('')}</tbody></table></div>${entries.length >= ENTRIES ? `<p class="muted">仅显示前 ${ENTRIES} 项</p>` : ''}</main>` };
}
