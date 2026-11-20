import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FILE_BUDGET } from '../../../../packages/contracts/src/budgets.js';

/**
 * Office documents through LibreOffice, when the server has it: converted to PDF headlessly and shown
 * by the PDF viewer, which keeps their layout, pages and pictures; without it, or when a conversion
 * fails, previews fall back to the text and structure `parse-document.ts` extracts. It is optional
 * and never installed by Riffet (docs/guide/workspace.md).
 *
 * One conversion runs at a time, as a child process owned by its request: each gets a profile
 * directory of its own (two `soffice` sharing one block each other), runs in a process group of its
 * own that is killed whole past `FILE_BUDGET.officeConvertMs` (`soffice` hands the work to a child),
 * and its temporary directory is removed when it ends. At most `officeConvertsWaiting` wait; past
 * that a preview shows the extracted text. Results are kept in memory by content, within
 * `officePdfCacheBytes`, and the same document asked for twice at once is converted once.
 */

/** What LibreOffice converts better than the extracted text shows; spreadsheets keep the grid. */
const CONVERTED = new Set(['doc', 'docx', 'docm', 'dotx', 'odt', 'ott', 'rtf', 'ppt', 'pps', 'pptx', 'pptm', 'ppsx', 'potx', 'odp', 'otp', 'odg', 'otg']);

let located: string | null | undefined;
/** The `soffice` executable, found once: `RIFFET_SOFFICE`, then PATH, then the macOS app bundle. */
export function officeConverter(): string | undefined {
  if (located !== undefined) return located ?? undefined;
  const candidates = [
    process.env.RIFFET_SOFFICE,
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).flatMap(dir => [join(dir, 'soffice'), join(dir, 'libreoffice')]),
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  ];
  located = candidates.find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate!)) ?? null;
  return located ?? undefined;
}

export const convertsToPdf = (extension: string) => CONVERTED.has(extension) && Boolean(officeConverter());

// perf-rules: allow bounded by FILE_BUDGET.officePdfCacheBytes in `officePdf`, oldest out first
const cache = new Map<string, Buffer>();
let cachedBytes = 0;
let queue: Promise<unknown> = Promise.resolve();
let waiting = 0;
/** Conversions under way or waiting, by content: a second ask shares the first. */
// perf-rules: allow at most one running plus FILE_BUDGET.officeConvertsWaiting, each removed when it settles
const running = new Map<string, Promise<Buffer | undefined>>();

/** The document as PDF, or undefined when LibreOffice is missing, failed or took too long. */
export function officePdf(data: Uint8Array, name: string): Promise<Buffer | undefined> {
  const executable = officeConverter();
  if (!executable) return Promise.resolve(undefined);
  const key = createHash('sha256').update(data).update(name).digest('base64url');
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return Promise.resolve(hit); }
  const shared = running.get(key);
  if (shared) return shared;
  if (waiting >= FILE_BUDGET.officeConvertsWaiting) return Promise.resolve(undefined);
  waiting += 1;
  const start = () => { waiting -= 1; return convert(executable, data, name); };
  const run = queue.then(start, start);
  queue = run.catch(() => undefined);
  const result = run.then(pdf => { if (pdf) remember(key, pdf); return pdf; }, () => undefined).finally(() => running.delete(key));
  running.set(key, result);
  return result;
}

function remember(key: string, pdf: Buffer): void {
  if (pdf.byteLength > FILE_BUDGET.officePdfCacheBytes) return;
  const previous = cache.get(key);
  if (previous) { cachedBytes -= previous.byteLength; cache.delete(key); }
  cache.set(key, pdf); cachedBytes += pdf.byteLength;
  for (const [oldest, kept] of cache) {
    if (cachedBytes <= FILE_BUDGET.officePdfCacheBytes) break;
    cachedBytes -= kept.byteLength; cache.delete(oldest);
  }
}

async function convert(executable: string, data: Uint8Array, name: string): Promise<Buffer | undefined> {
  const work = await mkdtemp(join(tmpdir(), 'riffet-office-'));
  try {
    // A plain name: the original may hold characters the command line or LibreOffice mangle.
    const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
    const input = join(work, `document.${extension}`);
    await writeFile(input, data);
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(executable, [
        '--headless', '--norestore', '--nolockcheck', '--nodefault', '--nologo',
        `-env:UserInstallation=${pathToFileURL(join(work, 'profile')).href}`,
        '--convert-to', 'pdf', '--outdir', work, input,
      ], { stdio: 'ignore', env: { ...process.env, HOME: work }, detached: true });
      // The whole group: on Linux `soffice` is a script whose `soffice.bin` would outlive it.
      const killGroup = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
      const timer = setTimeout(killGroup, FILE_BUDGET.officeConvertMs);
      child.on('error', () => { clearTimeout(timer); resolve(null); });
      child.on('exit', (exit) => { clearTimeout(timer); killGroup(); resolve(exit); });
    });
    if (code !== 0) return undefined;
    return await readFile(join(work, 'document.pdf')).catch(() => undefined);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
