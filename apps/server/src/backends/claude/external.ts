import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExternalSessionEntry, ExternalHolder, ExternalSessionScan } from '../types.js';
import { processAlive, processStarts, sameStart } from '../shared/process-identity.js';

/** Bytes read from each end of a transcript: the first prompt lives in the head, renames and the branch in the tail. */
const EDGE_BYTES = 256 * 1024;
const TEXT_LIMIT = 200;
/** Files handled between two yields to the event loop. */
const YIELD_EVERY = 16;
/** `procStart` as macOS writes it (`Wed Nov 11 12:49:16 2026`); other forms are not compared. */
const DATE_START = /^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;
const HOLDER_TTL_MS = 1000;
const MAX_CACHED_FILES = 5000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Riffet's private tmux names its sessions `cw-<20 hex>` (terminal/service.ts `terminalName`). */
const RIFFET_TMUX_SESSION = /^cw-[0-9a-f]{20}:/;

type Source = ExternalSessionEntry['source'];
type Parsed = Omit<ExternalSessionEntry, 'updatedAt' | 'live'>;
type Cached = { key: string; parsed: Parsed | null };

/** Parsed files by path; a file is re-read only when its inode, size or mtime moved. */
const parsedFiles = new Map<string, Cached>();
const holderReads = new Map<string, { at: number; read: Promise<Map<string, ExternalHolder>> }>();

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Text a client pasted in is wrapped in a tag; the words typed around it say what the conversation is about. */
const PASTED = /<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content>/g;

function clip(value: string): string {
  const typed = value.replace(PASTED, ' ').trim();
  const text = typed || value.replace(/<\/?pasted_content\b[^>]*>/g, ' ');
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > TEXT_LIMIT ? `${flat.slice(0, TEXT_LIMIT - 1)}…` : flat;
}

export function externalSourceOf(entrypoint: string | undefined): Source {
  const value = entrypoint?.toLowerCase() ?? '';
  if (value === 'cli') return 'cli';
  if (value.startsWith('sdk')) return 'sdk';
  if (/vscode|jetbrains|ide/.test(value)) return 'ide';
  if (value.includes('desktop')) return 'desktop';
  return 'other';
}

/** The words of a real human prompt, or undefined for what Claude Code writes on the reader's behalf. */
function humanPrompt(row: Record<string, unknown>): string | undefined {
  if (row.type !== 'user' || row.isMeta === true || row.isSidechain === true || row.isCompactSummary === true) return undefined;
  const content = (row.message as { content?: unknown } | undefined)?.content;
  const value = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.flatMap(part => part && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string' ? [(part as { text: string }).text] : []).join('\n')
      : '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('Caveat:') || trimmed.startsWith('<command-name>') || trimmed.startsWith('<local-command') || trimmed.startsWith('<command-message>')) return undefined;
  return trimmed;
}

function* jsonRows(chunk: string, dropFirst: boolean): Generator<Record<string, unknown>> {
  const lines = chunk.split('\n');
  // A window cut mid-file starts and ends inside a line.
  for (const [index, line] of lines.entries()) {
    if (!line || (dropFirst && index === 0)) continue;
    try {
      const row: unknown = JSON.parse(line);
      if (row && typeof row === 'object') yield row as Record<string, unknown>;
    } catch { /* a torn or foreign line */ }
  }
}

async function readEdges(file: string, size: number): Promise<Array<{ chunk: string; partial: boolean }>> {
  if (size <= EDGE_BYTES * 2) return [{ chunk: await readFile(file, 'utf8'), partial: false }];
  const handle = await open(file, 'r');
  try {
    const head = Buffer.alloc(EDGE_BYTES);
    const tail = Buffer.alloc(EDGE_BYTES);
    await handle.read(head, 0, EDGE_BYTES, 0);
    await handle.read(tail, 0, EDGE_BYTES, size - EDGE_BYTES);
    // The head's last line is cut as well, so it is dropped with its torn JSON by the parse.
    return [{ chunk: head.toString('utf8'), partial: false }, { chunk: tail.toString('utf8'), partial: true }];
  } finally { await handle.close(); }
}

async function parseTranscript(file: string, nativeSessionId: string, size: number): Promise<Parsed | null> {
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let entrypoint: string | undefined;
  let custom: string | undefined;
  let ai: string | undefined;
  let summary: string | undefined;
  let first: string | undefined;
  for (const { chunk, partial } of await readEdges(file, size)) {
    for (const row of jsonRows(chunk, partial)) {
      cwd ??= text(row.cwd);
      gitBranch = text(row.gitBranch) ?? gitBranch;
      entrypoint ??= text(row.entrypoint);
      if (row.type === 'custom-title') custom = text(row.customTitle) ?? custom;
      else if (row.type === 'ai-title') ai = text(row.aiTitle) ?? ai;
      else if (row.type === 'summary') summary = text(row.summary) ?? summary;
      else first ??= humanPrompt(row);
    }
  }
  // No real prompt (also none in the head of a huge file): nothing worth resuming.
  if (!first || !cwd) return null;
  const title = custom ?? ai ?? summary;
  return {
    nativeSessionId,
    cwd,
    title: clip(title ?? first),
    ...(title ? { preview: clip(first) } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    source: externalSourceOf(entrypoint),
  };
}

async function listFiles(configDir: string, signal: AbortSignal): Promise<string[]> {
  const root = join(configDir, 'projects');
  const files: string[] = [];
  let directories: import('node:fs').Dirent[];
  try { directories = await readdir(root, { withFileTypes: true }); } catch { return files; }
  for (const directory of directories) {
    signal.throwIfAborted();
    if (!directory.isDirectory()) continue;
    try {
      // Only the first level: `<id>/subagents` and `tool-results` live in subdirectories and reuse the parent's sessionId.
      for (const entry of await readdir(join(root, directory.name), { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.jsonl') && SESSION_ID.test(entry.name.slice(0, -6))) files.push(join(root, directory.name, entry.name));
      }
    } catch { /* an unreadable project folder */ }
  }
  return files;
}

export async function scanClaudeSessions(configDir: string, options: ExternalSessionScan): Promise<ExternalSessionEntry[]> {
  const { signal } = options;
  signal.throwIfAborted();
  const files = await listFiles(configDir, signal);
  const holders = await claudeHolders(configDir);
  const found: ExternalSessionEntry[] = [];
  let handled = 0;
  for (const file of files) {
    signal.throwIfAborted();
    if (++handled % YIELD_EVERY === 0) await new Promise<void>(resolve => setImmediate(resolve));
    let info;
    try { info = await stat(file); } catch { continue; }
    const key = `${info.ino}:${info.size}:${info.mtimeMs}`;
    let cached = parsedFiles.get(file);
    if (cached?.key !== key) {
      const id = file.slice(file.lastIndexOf('/') + 1, -6);
      let parsed: Parsed | null;
      try { parsed = await parseTranscript(file, id, info.size); } catch { continue; }
      cached = { key, parsed };
      parsedFiles.delete(file);
      parsedFiles.set(file, cached);
      if (parsedFiles.size > MAX_CACHED_FILES) parsedFiles.delete(parsedFiles.keys().next().value!);
    }
    const parsed = cached.parsed;
    if (!parsed || (parsed.source === 'sdk' && !options.includeNonInteractive)) continue;
    const live = holders.get(parsed.nativeSessionId);
    found.push({ ...parsed, updatedAt: info.mtimeMs, ...(live ? { live } : {}) });
  }
  found.sort((a, b) => b.updatedAt - a.updatedAt);
  return found.slice(0, Math.max(0, options.limit));
}

async function readHolders(configDir: string): Promise<Map<string, ExternalHolder>> {
  const holders = new Map<string, ExternalHolder>();
  const directory = join(configDir, 'sessions');
  let names: string[];
  try { names = await readdir(directory); } catch { return holders; }
  const rows = (await Promise.all(names.filter(name => name.endsWith('.json')).map(async name => {
    try {
      const record = JSON.parse(await readFile(join(directory, name), 'utf8')) as Record<string, unknown>;
      const pid = record.pid;
      const sessionId = text(record.sessionId);
      if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || !sessionId || !processAlive(pid)) return undefined;
      return { pid, sessionId, record };
    } catch { return undefined; /* a half-written or foreign file */ }
  }))).filter(row => row !== undefined);
  // A file left by a CLI that crashed names a pid a later process may have taken; its start time tells them apart.
  const starts = await processStarts(rows.map(row => row.pid));
  for (const { pid, sessionId, record } of rows) {
    const recorded = text(record.procStart);
    // Without `ps` the file is believed: a live holder missed would let a second writer launch.
    if (starts && recorded && DATE_START.test(recorded) && !sameStart(starts.get(pid), recorded)) continue;
    const status = record.status === 'idle' || record.status === 'busy' ? record.status : undefined;
    const tmux = text(record.tmux);
    const holder: ExternalHolder = { pid, ...(status ? { status } : {}), ...(tmux && RIFFET_TMUX_SESSION.test(tmux) ? { ours: true } : {}) };
    // A stale file of a recycled session id loses to the one that is busy.
    const existing = holders.get(sessionId);
    if (!existing || (holder.status === 'busy' && existing.status !== 'busy')) holders.set(sessionId, holder);
  }
  return holders;
}

/** Live Claude processes of a config directory by conversation, read at most once a second. */
export function claudeHolders(configDir: string): Promise<Map<string, ExternalHolder>> {
  const cached = holderReads.get(configDir);
  if (cached && Date.now() - cached.at < HOLDER_TTL_MS) return cached.read;
  const read = readHolders(configDir);
  holderReads.set(configDir, { at: Date.now(), read });
  return read;
}
