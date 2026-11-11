import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import type { ExternalHolder, ExternalSessionEntry } from '../types.js';
import { asArray, asRecord, str } from './util.js';

const execFileAsync = promisify(execFile);

/** `thread/list` takes at most this many threads per page. */
export const EXTERNAL_PAGE_SIZE = 200;
/** A scan starts a management app-server, so a listing is reused for this long. */
export const EXTERNAL_CACHE_MS = 15_000;

/** The sources the picker lists by default: conversations a person typed into. */
export function externalSourceKinds(includeNonInteractive: boolean): string[] {
  return includeNonInteractive ? ['cli', 'vscode', 'exec', 'appServer'] : ['cli', 'vscode'];
}

/** The entry for one `thread/list` thread, or undefined for a subagent thread or one without an id. */
export function externalEntryOf(raw: unknown): ExternalSessionEntry | undefined {
  const thread = asRecord(raw);
  const id = str(thread?.id);
  if (!thread || !id) return undefined;
  const source = thread.source;
  // Subagent threads belong to their parent's conversation, not to the picker.
  if (asRecord(source)?.subAgent !== undefined || str(thread.parentThreadId)) return undefined;
  const name = oneLine(str(thread.name));
  const preview = oneLine(str(thread.preview));
  const branch = str(asRecord(thread.gitInfo)?.branch);
  const updated = typeof thread.updatedAt === 'number' && Number.isFinite(thread.updatedAt) ? thread.updatedAt : 0;
  return {
    nativeSessionId: id,
    cwd: str(thread.cwd) ?? '',
    title: name ?? preview ?? id.slice(0, 8),
    ...(name && preview ? { preview } : {}),
    ...(branch ? { gitBranch: branch } : {}),
    // The protocol counts seconds.
    updatedAt: updated * 1000,
    source: externalSourceOf(source, str(thread.originator)),
  };
}

function externalSourceOf(source: unknown, originator: string | undefined): ExternalSessionEntry['source'] {
  // The desktop app talks to its own app-server, so only its originator tells it from a bare app-server client.
  if (originator && /desktop/i.test(originator)) return 'desktop';
  switch (source) {
    case 'cli': return 'cli';
    case 'vscode': return 'ide';
    case 'exec': return 'exec';
    default: return 'other';
  }
}

function oneLine(text: string | undefined): string | undefined {
  const line = text?.replace(/\s+/g, ' ').trim();
  return line ? line.slice(0, 200) : undefined;
}

/** `thread/list` pages, newest first, until `limit` threads or no further page. */
export async function listExternalThreads(
  request: (params: Record<string, unknown>) => Promise<unknown>,
  options: { includeNonInteractive: boolean; limit: number; signal: AbortSignal },
): Promise<ExternalSessionEntry[]> {
  const entries: ExternalSessionEntry[] = [];
  let cursor: string | undefined;
  do {
    options.signal.throwIfAborted();
    const page = asRecord(await request({
      sortKey: 'updated_at',
      // Present but empty means every provider; omitted lists only the current one.
      modelProviders: [],
      archived: false,
      sourceKinds: externalSourceKinds(options.includeNonInteractive),
      useStateDbOnly: true,
      limit: Math.min(EXTERNAL_PAGE_SIZE, options.limit),
      ...(cursor ? { cursor } : {}),
    }));
    for (const raw of asArray<unknown>(page?.data)) {
      const entry = externalEntryOf(raw);
      if (entry) entries.push(entry);
    }
    cursor = str(page?.nextCursor);
  } while (cursor && entries.length < options.limit);
  return entries.slice(0, options.limit);
}

export interface ProcessRow { pid: number; argv: string[] }

/** Every process's pid and argv, in one `ps` call; empty when `ps` fails. */
export async function scanProcesses(): Promise<ProcessRow[]> {
  try {
    const { stdout } = await execFileAsync('ps', ['-axwwo', 'pid=,args='], { timeout: 2_000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const rows: ProcessRow[] = [];
    for (const line of stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (match) rows.push({ pid: Number(match[1]), argv: match[2]!.split(/\s+/) });
    }
    return rows;
  } catch { return []; }
}

/**
 * The CLI process holding `threadId`: its argv names the thread and one of the first two words
 * (the binary, or the interpreter before a script) is the flavor's executable. Codex has no
 * cross-process lock, so this is the only evidence. `ours`: it joined one of Riffet's own app-servers.
 */
export function holderOf(rows: readonly ProcessRow[], threadId: string, executables: ReadonlySet<string>, ownAddresses: ReadonlySet<string>): ExternalHolder | undefined {
  let found: ExternalHolder | undefined;
  for (const { pid, argv } of rows) {
    if (pid === process.pid || !argv.includes(threadId) || argv.includes('app-server')) continue;
    if (!argv.slice(0, 2).some(word => executables.has(basename(word)))) continue;
    const ours = remoteOf(argv).some(address => ownAddresses.has(address));
    if (!found || (ours && !found.ours)) found = { pid, ...(ours ? { ours } : {}) };
  }
  return found;
}

function remoteOf(argv: readonly string[]): string[] {
  const addresses: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index]!;
    if (word === '--remote' && argv[index + 1]) addresses.push(argv[index + 1]!);
    else if (word.startsWith('--remote=')) addresses.push(word.slice('--remote='.length));
  }
  return addresses;
}
