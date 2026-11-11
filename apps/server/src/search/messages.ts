import type { WorkbenchEvent } from '../../../../packages/contracts/src/index.js';

/** One searchable message, as stored. `messageId` is the provider's own id for the message. */
export interface IndexedMessage {
  sessionId: string;
  messageId: string;
  kind: 'user' | 'assistant' | 'tool';
  text: string;
  at: string;
}

/**
 * Longest text kept per message. A single answer can run to megabytes, and nobody searches for a
 * phrase that far into one; the cap keeps the index bounded and every query cheap.
 */
export const MAX_INDEXED_TEXT = 4_000;

/**
 * Recorded for a conversation the server read and found nothing to index — never a message, and its
 * empty text cannot match a non-empty query. Without it such a conversation would stay "missing"
 * forever and every search would keep re-reading it.
 */
export const EMPTY_INDEX_MARKER = '__riffet_none__';

/** A query worth running, or nothing when it is empty or long enough to be a mistake. */
export function normalizeQuery(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200) return undefined;
  return trimmed;
}

interface EventData {
  content?: { type?: unknown; text?: unknown };
  toolName?: unknown;
  title?: unknown;
  filePath?: unknown;
  command?: unknown;
}

/**
 * The searchable text of one event, or nothing when it carries none.
 *
 * Thinking is deliberately excluded: it is long, it is not what anyone remembers reading, and
 * including it would bury real answers. Tool calls are included by name, path and command — that is
 * how someone finds "the turn where it edited config.ts".
 */
function textOf(event: WorkbenchEvent): { kind: IndexedMessage['kind']; text: string } | undefined {
  const data = event.data as EventData | undefined;
  const content = data?.content;
  if (content?.type === 'text' && typeof content.text === 'string' && content.text.trim()) {
    if (event.type === 'user_message_chunk') return { kind: 'user', text: content.text };
    if (event.type === 'agent_message_chunk') return { kind: 'assistant', text: content.text };
    return undefined;
  }
  if (event.type === 'tool_call' || event.type === 'tool_call_update') {
    const parts = [data?.toolName, data?.title, data?.filePath, data?.command].filter((value): value is string => typeof value === 'string' && Boolean(value.trim()));
    if (parts.length) return { kind: 'tool', text: parts.join(' ') };
  }
  return undefined;
}

/**
 * Turns a transcript window into the rows to store, each text capped at `maxText`.
 *
 * A streamed answer arrives as many chunks under one native message id, so the chunks of a message
 * are joined here: what is indexed then reads exactly like the message on screen, and a later
 * window for the same message replaces it rather than appending a fragment to it.
 */
export function extractIndexable(sessionId: string, events: readonly WorkbenchEvent[], maxText = MAX_INDEXED_TEXT): IndexedMessage[] {
  const byMessage = new Map<string, IndexedMessage>();
  for (const event of events) {
    const found = textOf(event);
    if (!found || !found.text.trim()) continue;
    // Provider transcripts carry the native id; anything else still has a stable sequence.
    const nativeId = (event as WorkbenchEvent & { nativeId?: unknown }).nativeId;
    const messageId = typeof nativeId === 'string' && nativeId ? nativeId : `${event.sequence}`;
    const existing = byMessage.get(messageId);
    if (existing && existing.kind === found.kind) {
      // Joined raw, not line by line: a phrase can straddle two chunks, and a separator inserted
      // here would put it out of reach of a search for it.
      existing.text = (existing.text + found.text).slice(0, maxText);
      continue;
    }
    byMessage.set(messageId, { sessionId, messageId, kind: found.kind, text: found.text.slice(0, maxText), at: event.createdAt });
  }
  return [...byMessage.values()].map((row) => ({ ...row, text: row.text.trim() }));
}

/**
 * The pattern for a SQL `LIKE ... ESCAPE '\'`, with the wildcards in the query itself escaped so a
 * search for `100%` or `a_b` looks for those characters instead of matching everything.
 */
export function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/** A window of text around the match, for the result row. */
export function snippet(text: string, query: string, radius = 60): string {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + query.length + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
