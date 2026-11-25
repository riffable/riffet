import { realpathSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import { messageFromJsonl, projectDroidMessage, projectDroidTurnEnd, type DroidMessage, type DroidProjectionOptions } from './events.js';

/** Messages in the window a fresh read returns, and in each older page after it. */
const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface DroidTurnOutcome { reason: string; lastSeq?: number; createdAt: string }

/** One session file, reduced to the branch Droid would resume. */
export interface DroidTranscript {
  path: string;
  title?: string;
  cwd?: string;
  /** Root-to-leaf messages of the active branch, hidden ones included. */
  chain: DroidMessage[];
  /** Turn outcomes by turn id, each remembering the highest `seq` written before it. */
  outcomes: Map<string, DroidTurnOutcome>;
  /** Highest `seq` in the file: where the next live message continues. */
  lastSeq?: number;
  generation: string;
}

export interface DroidSessionSettings {
  model?: string;
  reasoningEffort?: string;
  autonomyLevel?: string;
  interactionMode?: string;
}

export function validateDroidSessionId(value: string): void {
  if (!SAFE_SESSION_ID.test(value)) throw new AppError('INVALID_NATIVE_SESSION_ID', 'Droid session id is invalid', 400);
}

export function droidSessionsRoot(): string {
  return join(homedir(), '.factory', 'sessions');
}

/** Droid names a project's directory after its real path with every `/` turned into `-`. */
export function droidProjectSessionDir(cwd: string, root = droidSessionsRoot()): string {
  let real = resolve(cwd);
  try { real = realpathSync(real); } catch { /* a missing workspace still has a predictable name */ }
  return join(root, real.replace(/[\\/]/g, '-'));
}

const located = new Map<string, string>();

/** The JSONL file of a session, or `undefined` when Droid has not written one. */
export async function findDroidTranscript(nativeSessionId: string, cwd: string, root = droidSessionsRoot()): Promise<string | undefined> {
  validateDroidSessionId(nativeSessionId);
  const remembered = located.get(nativeSessionId);
  if (remembered && await exists(remembered)) return remembered;
  const candidates = [join(droidProjectSessionDir(cwd, root), `${nativeSessionId}.jsonl`)];
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(join(root, entry.name, `${nativeSessionId}.jsonl`));
    }
  } catch { /* no sessions directory yet */ }
  for (const candidate of candidates) {
    if (!await exists(candidate)) continue;
    located.set(nativeSessionId, candidate);
    return candidate;
  }
  return undefined;
}

async function exists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

const parsed = new Map<string, { size: number; mtimeMs: number; transcript: DroidTranscript }>();

/** Parses a session file, reusing the previous parse while the file is unchanged. */
export async function readDroidTranscript(path: string, nativeSessionId: string): Promise<DroidTranscript> {
  const info = await stat(path);
  if (info.size > MAX_TRANSCRIPT_BYTES) throw new AppError('NATIVE_HISTORY_TOO_LARGE', 'The Droid session file is too large to read', 413);
  const cached = parsed.get(path);
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.transcript;
  const transcript = parseDroidTranscript(await readFile(path, 'utf8'), path, nativeSessionId);
  parsed.set(path, { size: info.size, mtimeMs: info.mtimeMs, transcript });
  if (parsed.size > 32) parsed.delete(parsed.keys().next().value!);
  return transcript;
}

export function parseDroidTranscript(content: string, path: string, nativeSessionId: string): DroidTranscript {
  const byId = new Map<string, DroidMessage>();
  const outcomes = new Map<string, DroidTurnOutcome>();
  let leaf: DroidMessage | undefined;
  let lastSeq: number | undefined;
  let lastTime = new Date(0).toISOString();
  let title: string | undefined;
  let cwd: string | undefined;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    // The last line can be half-written while Droid is appending to it.
    try { value = JSON.parse(line); } catch { continue; }
    const entry = value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
    if (!entry) continue;
    if (entry.type === 'session_start') {
      if (typeof entry.title === 'string') title = entry.title;
      if (typeof entry.cwd === 'string') cwd = entry.cwd;
      continue;
    }
    if (entry.type === 'agent_turn_outcome') {
      if (typeof entry.turnId === 'string' && typeof entry.reason === 'string') {
        outcomes.set(entry.turnId, { reason: entry.reason, createdAt: lastTime, ...(lastSeq !== undefined ? { lastSeq } : {}) });
      }
      continue;
    }
    if (entry.type === 'session_title_updated' && typeof entry.title === 'string') {
      title = entry.title;
      continue;
    }
    const message = messageFromJsonl(entry);
    if (!message) continue;
    byId.set(message.id, message);
    leaf = message;
    lastTime = message.createdAt;
    if (message.seq !== undefined) lastSeq = Math.max(lastSeq ?? message.seq, message.seq);
  }
  const chain: DroidMessage[] = [];
  const seen = new Set<string>();
  for (let current = leaf; current && !seen.has(current.id); current = current.parentId ? byId.get(current.parentId) : undefined) {
    seen.add(current.id);
    chain.push(current);
  }
  chain.reverse();
  return {
    path,
    chain,
    outcomes,
    generation: `${nativeSessionId}:${chain[0]?.id ?? 'empty'}`,
    ...(title ? { title } : {}),
    ...(cwd ? { cwd } : {}),
    ...(lastSeq !== undefined ? { lastSeq } : {}),
  };
}

/** The settings sidecar Droid keeps beside a session file. */
export async function readDroidSessionSettings(transcriptPath: string): Promise<DroidSessionSettings | undefined> {
  try {
    const value = JSON.parse(await readFile(transcriptPath.replace(/\.jsonl$/, '.settings.json'), 'utf8')) as Record<string, unknown>;
    const pick = (key: string) => typeof value[key] === 'string' ? value[key] as string : undefined;
    return {
      ...(pick('model') ? { model: pick('model') } : {}),
      ...(pick('reasoningEffort') ? { reasoningEffort: pick('reasoningEffort') } : {}),
      ...(pick('autonomyLevel') ? { autonomyLevel: pick('autonomyLevel') } : {}),
      ...(pick('interactionMode') ? { interactionMode: pick('interactionMode') } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * The whole chain as events, in order, each turn's outcome right after the last message Droid wrote
 * before it, numbered from 1.
 *
 * @param commandFor - the workbench command a user message answered, when it is known; `false` for a
 *   subagent, whose turns are not workbench runs and so have no outcomes to show.
 */
export function projectDroidChain(
  transcript: DroidTranscript,
  options: Omit<DroidProjectionOptions, 'commandId' | 'runId'>,
  commandFor: ((messageId: string) => { commandId: string; runId?: string } | undefined) | false = () => undefined,
): NativeWorkbenchEvent[] {
  const ended = new Map<number, NativeWorkbenchEvent[]>();
  if (commandFor) {
    for (const message of transcript.chain) {
      const outcome = message.role === 'user' ? transcript.outcomes.get(message.id) : undefined;
      if (!outcome || outcome.lastSeq === undefined) continue;
      const command = commandFor(message.id);
      const event = projectDroidTurnEnd({ turnId: message.id, reason: outcome.reason }, outcome.lastSeq, outcome.createdAt, { ...options, ...(command ? { commandId: command.commandId, ...(command.runId ? { runId: command.runId } : {}) } : {}) });
      if (event) ended.set(outcome.lastSeq, [...ended.get(outcome.lastSeq) ?? [], event]);
    }
  }
  const events: NativeWorkbenchEvent[] = [];
  for (const message of transcript.chain) {
    const command = message.role === 'user' && commandFor ? commandFor(message.id) : undefined;
    events.push(...projectDroidMessage(message, { ...options, ...(command ? { commandId: command.commandId, ...(command.runId ? { runId: command.runId } : {}) } : {}) }));
    if (message.seq !== undefined) events.push(...ended.get(message.seq) ?? []);
  }
  return events.map((event, index) => ({ ...event, sequence: index + 1 }));
}
