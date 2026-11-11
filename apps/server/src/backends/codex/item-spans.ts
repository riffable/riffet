import { open, stat } from 'node:fs/promises';
import { rolloutRows } from './rollout-records.js';
import { findCodexRollout } from './rollout-usage.js';
import { subagentToolCallId, type ItemSpan } from './transcript.js';
import type { RpcItem } from './types.js';
import { asRecord, finiteToken, str, toIso } from './util.js';

/*
 * When each item of a Codex thread happened.
 *
 * The app-server's history (`thread/turns/list`) states no time for an item, so every row of a turn
 * would carry the turn's start. The rollout does: each `item_completed` line is stamped when the item
 * finished and, for commands and tool calls, says how long it took. A live notification states both
 * ends itself. A row's `createdAt` is the item's start and the result of a tool call is stamped with
 * its end, which the timeline folds into the row's `lastAt`.
 *
 * Journal rows are compared by content, never by `createdAt`, so the small difference between a
 * live time and the rollout's does not make a new version of a row; what a row was first written
 * with stays.
 */

export type ItemSpans = (item: RpcItem) => ItemSpan | undefined;

/** A live `item/started` or `item/completed` notification's own times. */
export function notificationSpan(method: string, params: Record<string, unknown>, item: RpcItem): ItemSpan | undefined {
  const started = method === 'item/started';
  const at = toIso(finiteToken(started ? params.startedAtMs : params.completedAtMs));
  if (!at) return undefined;
  const duration = started ? undefined : durationMs(item);
  return { startedAt: duration ? new Date(Date.parse(at) - duration).toISOString() : at, completedAt: at };
}

function durationMs(item: Record<string, unknown>): number {
  const direct = finiteToken(item.durationMs);
  if (direct !== undefined) return Math.max(0, Math.round(direct));
  const native = asRecord(item.duration);
  const secs = finiteToken(native?.secs), nanos = finiteToken(native?.nanos);
  return secs === undefined ? 0 : Math.max(0, Math.round(secs * 1000 + (nanos ?? 0) / 1e6));
}

interface RolloutTimes {
  ino: number;
  /** Bytes read so far; always the end of a whole line. */
  offset: number;
  /** Item id to when it completed and how long it ran, in milliseconds. */
  items: Map<string, [completedMs: number, durationMs: number]>;
  /** Reads of one file follow each other, so none counts a line twice. */
  chain: Promise<unknown>;
}

const BLOCK_BYTES = 8 * 1024 * 1024;
const FILES_KEPT = 8;
const files = new Map<string, RolloutTimes>();

/** Reads what the rollout gained since the last read; a file that shrank or was replaced is read again from its start. */
async function advance(path: string, file: RolloutTimes): Promise<void> {
  const info = await stat(path);
  if (info.size < file.offset || info.ino !== file.ino) Object.assign(file, { offset: 0, items: new Map(), ino: info.ino });
  if (info.size === file.offset) return;
  const handle = await open(path, 'r');
  try {
    let position = file.offset;
    let carry: Buffer = Buffer.alloc(0);
    while (position < info.size) {
      const block = Buffer.allocUnsafe(Math.min(BLOCK_BYTES, info.size - position));
      const { bytesRead } = await handle.read(block, 0, block.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      const data = carry.length ? Buffer.concat([carry, block.subarray(0, bytesRead)]) : block.subarray(0, bytesRead);
      const end = data.lastIndexOf(0x0a) + 1;
      if (end) absorb(file, data.toString('utf8', 0, end));
      carry = data.subarray(end);
    }
    // A line still being written is read again, whole, next time.
    file.offset = position - carry.length;
  } finally {
    await handle.close();
  }
}

function absorb(file: RolloutTimes, text: string): void {
  const lines = text.split('\n').filter(line => line.includes('"item_completed"')).join('\n');
  for (const row of rolloutRows(lines)) {
    const payload = asRecord(row.payload);
    if (row.type !== 'event_msg' || payload?.type !== 'item_completed') continue;
    const item = asRecord(payload.item);
    const id = str(item?.id);
    const at = Date.parse(String(row.timestamp ?? ''));
    // The first line of an item is its completion; a later one naming it again is not.
    if (item && id && Number.isFinite(at) && !file.items.has(id)) file.items.set(id, [at, durationMs(item)]);
  }
}

/**
 * The times of a thread's items from its rollout (a subagent's thread has a rollout of its own), or
 * undefined when it has none. Only what the file gained since the last call is read, so a poll of a
 * rollout of tens of megabytes costs a `stat`. The lookup it returns is for items already read:
 * call this again to see the ones a running turn has written since.
 */
export async function rolloutItemSpans(codexHome: string, threadId: string): Promise<ItemSpans | undefined> {
  try {
    const path = await findCodexRollout(codexHome, threadId);
    if (!path) return undefined;
    let file = files.get(path);
    if (!file) {
      file = { ino: 0, offset: 0, items: new Map(), chain: Promise.resolve() };
      files.set(path, file);
      if (files.size > FILES_KEPT) files.delete(files.keys().next().value!);
    }
    const known = file;
    const read = known.chain.then(() => advance(path, known));
    known.chain = read.catch(() => undefined);
    await read;
    return item => {
      const id = subagentToolCallId(item);
      const found = id ? known.items.get(id) : undefined;
      return found ? { startedAt: new Date(found[0] - found[1]).toISOString(), completedAt: new Date(found[0]).toISOString() } : undefined;
    };
  } catch {
    // The rollout is an optional source of times: unreadable or half-written, rows keep their turn's start.
    return undefined;
  }
}
