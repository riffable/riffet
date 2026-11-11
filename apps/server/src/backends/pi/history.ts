import { open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { AppError } from '../../errors.js';

/*
 * pi's own session file (docs/PI.md): an append-only JSONL tree. The first line is a session header
 * (`type: "session"`, version 3), every later line is an entry with its own `id` and `parentId`; the
 * last entry is the leaf the conversation would resume from. A read follows that leaf back to the
 * root, so an edited prompt starts another branch without rewriting the history it left.
 */

/** The same characters pi accepts for a session id; the file name adds a timestamp before it. */
const SAFE_SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;
const HEADER_BYTES = 64 * 1024;

type RecordValue = Record<string, unknown>;

/** One entry of pi's session tree. Unknown fields stay as pi wrote them; projections read what they need. */
export type PiEntry = {
  id: string;
  parentId?: string | null;
  type: string;
  timestamp: string;
  [key: string]: unknown;
};

/** Token and cost totals over the entries a transcript holds. */
export interface PiUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

/** One pi session file, reduced to the branch pi would resume. */
export interface PiTranscript {
  path: string;
  /** The id in the file header, which is the conversation's stable identity. */
  sessionId: string;
  cwd?: string;
  title?: string;
  leafId?: string;
  /** Every entry read from the file, in append order, hidden ones included. */
  entries: PiEntry[];
  /** Root-to-leaf entries of the active branch, hidden ones included. */
  chain: PiEntry[];
  usage?: PiUsageTotals;
  /** `provider/modelId` of the last model change on the active branch. */
  model?: string;
  thinkingLevel?: string;
  generation: string;
}

export interface PiSessionHeader {
  type: 'session';
  version?: number;
  id: string;
  timestamp: string;
  cwd?: string;
  parentSession?: string;
}

export function validatePiSessionId(value: string): void {
  if (value.length > 200 || !SAFE_SESSION_ID.test(value)) throw new AppError('INVALID_NATIVE_SESSION_ID', 'pi session id is invalid', 400);
}

function expandHome(value: string): string {
  if (value === '~') return homedir();
  return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
}

/** Where pi keeps sessions when no profile names another agent directory. */
export function piAgentDir(): string {
  return resolve(expandHome(process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent')));
}

/** pi names a project's session directory after its real path. */
function projectDirectory(cwd: string): string {
  const safe = `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  return safe;
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

async function canonical(path: string): Promise<string> {
  try { return await realpath(path); } catch { return resolve(path); }
}

/** A candidate is only read from under the roots the profile names. */
async function inside(root: string, path: string): Promise<boolean> {
  const base = await canonical(root);
  const real = await canonical(path);
  return real === base || real.startsWith(`${base}${sep}`);
}

async function exists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function directoryExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

/** The first line of a session file, without reading a long conversation. */
async function readHeader(path: string): Promise<PiSessionHeader | undefined> {
  let file;
  try { file = await open(path, 'r'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(10);
    const line = buffer.toString('utf8', 0, end >= 0 ? end : bytesRead).trim();
    if (!line) return undefined;
    const value: unknown = JSON.parse(line);
    const record = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    if (record?.type !== 'session' || typeof record.id !== 'string') return undefined;
    return {
      type: 'session',
      id: record.id,
      timestamp: typeof record.timestamp === 'string' ? record.timestamp : '',
      ...(typeof record.version === 'number' ? { version: record.version } : {}),
      ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}),
      ...(typeof record.parentSession === 'string' ? { parentSession: record.parentSession } : {}),
    };
  } catch {
    return undefined;
  } finally {
    await file.close();
  }
}

/** Whether a file really is this conversation in this project, whatever its name says. */
async function verify(path: string, nativeSessionId: string, cwd: string): Promise<boolean> {
  const header = await readHeader(path);
  if (!header || header.id !== nativeSessionId) return false;
  // Old sessions may carry no cwd; a header that names one must name this project.
  return !header.cwd || samePath(header.cwd, cwd);
}

const located = new Map<string, string>();

/**
 * The JSONL file of a pi session, or `undefined` when pi has not written one. `sessionDir` is a
 * directory of session files (a project's session directory, or a `sessions` root); a profile's
 * agent directory is accepted too, since `readPiShare` hands over its configured config dir.
 */
export async function findPiTranscript(nativeSessionId: string, cwd: string, sessionDir?: string): Promise<string | undefined> {
  validatePiSessionId(nativeSessionId);
  const roots: string[] = [];
  const addRoot = (root: string) => { if (!roots.includes(root)) roots.push(root); };
  // pi's own override comes first: a spawned process inherits it even when the profile names an agent directory.
  const environmentDir = process.env.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (environmentDir) {
    const environment = resolve(expandHome(environmentDir));
    addRoot(environment);
    addRoot(join(environment, 'sessions'));
  }
  const configuredDir = sessionDir?.trim();
  if (configuredDir) {
    const configured = resolve(expandHome(configuredDir));
    addRoot(configured);
    addRoot(join(configured, 'sessions'));
  } else addRoot(join(piAgentDir(), 'sessions'));

  // A profile root is part of the cache key: the same conversation under another root is another file.
  const cacheKey = JSON.stringify([roots, resolve(cwd), nativeSessionId]);
  const remembered = located.get(cacheKey);
  if (remembered && await exists(remembered) && await verify(remembered, nativeSessionId, cwd)
    && (await Promise.all(roots.map(root => inside(root, remembered)))).some(Boolean)) return remembered;

  const matches = (name: string) => name.endsWith(`_${nativeSessionId}.jsonl`) || name === `${nativeSessionId}.jsonl`;
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (path: string) => { if (!seen.has(path)) { seen.add(path); candidates.push(path); } };
  for (const root of roots) {
    // A configured root may itself be one session file.
    if (await exists(root)) { if (matches(basename(root))) add(root); continue; }
    if (!await directoryExists(root)) continue;
    // A project session directory holds its files directly.
    try {
      for (const name of await readdir(root)) if (matches(name)) add(join(root, name));
    } catch { /* unreadable session directory */ }
    const preferred = join(root, projectDirectory(cwd));
    if (await directoryExists(preferred)) {
      try {
        for (const name of await readdir(preferred)) if (matches(name)) add(join(preferred, name));
      } catch { /* a vanished project directory */ }
    }
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const directory = join(root, entry.name);
        if (directory === preferred) continue;
        try {
          for (const name of await readdir(directory)) if (matches(name)) add(join(directory, name));
        } catch { /* unreadable project directory */ }
      }
    } catch { /* no sessions directory yet */ }
  }

  for (const candidate of candidates) {
    if (!await exists(candidate)) continue;
    if (!await verify(candidate, nativeSessionId, cwd)) continue;
    // A symlink inside the sessions root may still point elsewhere; only the real file is read.
    if (!(await Promise.all(roots.map(root => inside(root, candidate)))).some(Boolean)) continue;
    located.set(cacheKey, candidate);
    return candidate;
  }
  return undefined;
}

const parsed = new Map<string, { size: number; mtimeMs: number; transcript: PiTranscript }>();

/** Parses a session file, reusing the previous parse while the file is unchanged. */
export async function readPiTranscript(path: string, nativeSessionId: string): Promise<PiTranscript> {
  const info = await stat(path);
  if (info.size > MAX_TRANSCRIPT_BYTES) throw new AppError('NATIVE_HISTORY_TOO_LARGE', 'The pi session file is too large to read', 413);
  // One file under another native session is another conversation: the header check belongs to the cache key.
  const key = `${path}\0${nativeSessionId}`;
  const cached = parsed.get(key);
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.transcript;
  const transcript = parsePiTranscript(await readFile(path, 'utf8'), path, nativeSessionId);
  parsed.set(key, { size: info.size, mtimeMs: info.mtimeMs, transcript });
  if (parsed.size > 32) parsed.delete(parsed.keys().next().value!);
  return transcript;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function isoTime(value: unknown, fallback: string): string {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}

/** The usage of one entry, if it reports any (assistant messages, tool results, summaries, usage records). */
export function piEntryUsage(entry: PiEntry): PiUsageTotals | undefined {
  const message = record(entry.message);
  const usage = record(entry.type === 'message' ? message?.usage : entry.usage);
  if (!usage) return undefined;
  const count = (name: string, source: RecordValue = usage) => typeof source[name] === 'number' && Number.isFinite(source[name]) ? Math.max(0, source[name] as number) : 0;
  const cost = record(usage.cost);
  const input = count('input'), output = count('output'), cacheRead = count('cacheRead'), cacheWrite = count('cacheWrite');
  const total = count('totalTokens') || input + output + cacheRead + cacheWrite;
  // Older records may leave out `total`; the per-field costs still add up.
  const totalCost = cost
    ? count('total', cost) || count('input', cost) + count('output', cost) + count('cacheRead', cost) + count('cacheWrite', cost)
    : typeof usage.cost === 'number' && Number.isFinite(usage.cost) ? Math.max(0, usage.cost as number) : 0;
  if (!input && !output && !cacheRead && !cacheWrite && !total && !totalCost) return undefined;
  return { input, output, cacheRead, cacheWrite, totalTokens: total, cost: totalCost };
}

export function piMessageRole(entry: PiEntry): string | undefined {
  if (entry.type !== 'message' && entry.type !== 'custom_message') return undefined;
  if (entry.type === 'custom_message') return 'custom';
  return text(record(entry.message)?.role);
}

/** The last model change and thinking level on a branch. */
function branchSettings(chain: readonly PiEntry[]): { model?: string; thinkingLevel?: string } {
  let model: string | undefined;
  let thinkingLevel: string | undefined;
  for (const entry of chain) {
    if (entry.type === 'model_change') {
      const provider = text(entry.provider), modelId = text(entry.modelId);
      if (provider && modelId) model = `${provider}/${modelId}`;
    } else if (entry.type === 'thinking_level_change') {
      thinkingLevel = text(entry.thinkingLevel) ?? thinkingLevel;
    }
  }
  return { ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) };
}

/** The latest user-visible session name on a branch. */
function branchTitle(chain: readonly PiEntry[]): string | undefined {
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const entry = chain[index]!;
    if (entry.type !== 'session_info') continue;
    const name = text(entry.name);
    if (name) return name;
  }
  return undefined;
}

export function parsePiTranscript(content: string, path: string, nativeSessionId: string): PiTranscript {
  let header: PiSessionHeader | undefined;
  let lastTime = new Date(0).toISOString();
  const entries: PiEntry[] = [];
  const byId = new Map<string, PiEntry>();
  let leaf: PiEntry | undefined;
  // Only LF-terminated lines are committed; the last one may still be a partial append.
  const lines = content.split('\n');
  if (!content.endsWith('\n')) lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let value: unknown;
    // The last line can be half-written while pi is appending to it.
    try { value = JSON.parse(line); } catch { continue; }
    const item = record(value);
    if (!item) continue;
    if (item.type === 'session' && typeof item.id === 'string') {
      header = {
        type: 'session', id: item.id,
        timestamp: typeof item.timestamp === 'string' ? item.timestamp : '',
        ...(typeof item.version === 'number' ? { version: item.version } : {}),
        ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}),
        ...(typeof item.parentSession === 'string' ? { parentSession: item.parentSession } : {}),
      };
      lastTime = isoTime(item.timestamp, lastTime);
      continue;
    }
    const id = text(item.id), type = text(item.type);
    if (!id || !type) continue;
    const entry: PiEntry = {
      ...item,
      id,
      type,
      timestamp: isoTime(item.timestamp, lastTime),
      ...(typeof item.parentId === 'string' ? { parentId: item.parentId } : { parentId: null }),
    };
    entries.push(entry);
    byId.set(id, entry);
    leaf = entry;
    lastTime = entry.timestamp;
  }
  if (header && header.id !== nativeSessionId) throw new AppError('INVALID_NATIVE_SESSION_ID', 'The pi session file belongs to another conversation', 400);

  const chain: PiEntry[] = [];
  for (let current = leaf, seen = new Set<string>(); current && !seen.has(current.id); current = typeof current.parentId === 'string' ? byId.get(current.parentId) : undefined) {
    seen.add(current.id);
    chain.push(current);
  }
  chain.reverse();

  // A usage record counts once, however many times its entry is read.
  const counted = new Set<string>();
  const usage = entries.reduce<PiUsageTotals | undefined>((total, entry) => {
    if (counted.has(entry.id)) return total;
    const add = piEntryUsage(entry);
    if (!add) return total;
    counted.add(entry.id);
    total ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
    total.input += add.input; total.output += add.output; total.cacheRead += add.cacheRead;
    total.cacheWrite += add.cacheWrite; total.totalTokens += add.totalTokens; total.cost += add.cost;
    return total;
  }, undefined);

  const settings = branchSettings(chain);
  const title = branchTitle(chain);
  const root = chain[0]?.id ?? 'empty';
  return {
    path,
    sessionId: header?.id ?? nativeSessionId,
    entries,
    chain,
    generation: `${header?.id ?? nativeSessionId}:${root}`,
    ...(header?.cwd ? { cwd: header.cwd } : {}),
    ...(title ? { title } : {}),
    ...(leaf ? { leafId: leaf.id } : {}),
    ...(usage ? { usage } : {}),
    ...settings,
  };
}
