import { TRACE_BUDGET } from '../../../../packages/contracts/src/budgets.js';
import type { SyncLane } from '../../../../packages/contracts/src/sync.js';
import type { TraceRow, TraceRowDetail } from '../../../../packages/contracts/src/trace.js';
import type { StoredJournalRow } from './journal.js';

/*
 * Journal rows as the trace view reads them (docs/TRACE.md). An index row is built from the inline column
 * only: for a spilled payload that is the preview `previewOf` keeps, which holds the small fields read here,
 * so an index page never reads a blob.
 */

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;

/** First line of meaningful text, collapsed and clipped. */
function line(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (!collapsed) return undefined;
  return collapsed.length > TRACE_BUDGET.previewChars ? `${collapsed.slice(0, TRACE_BUDGET.previewChars - 1)}…` : collapsed;
}

/** The text a content block, or the first text block of a list of them, holds. */
function contentText(content: unknown): string | undefined {
  const block = record(content);
  if (block) return text(block.text) ?? contentText(block.content);
  if (Array.isArray(content)) for (const item of content) { const found = contentText(item); if (found) return found; }
  return undefined;
}

function inputText(input: Json | undefined): string | undefined {
  if (!input) return undefined;
  for (const key of ['command', 'file_path', 'path', 'filePath', 'pattern', 'query', 'url', 'description', 'prompt']) {
    const found = text(input[key]);
    if (found) return found;
  }
  return undefined;
}

/** Index fields read from a payload: an event envelope (`{ type, runId, data }`) or a `meta.*` body. */
function fieldsOf(kind: string, payload: Json): Omit<TraceRow, 'seq' | 'kind' | 'nativeId' | 'rev' | 'turnId' | 'at' | 'bytes'> {
  if (kind.startsWith('meta.')) {
    const status = text(payload.status);
    const error = text(payload.error);
    const lane = text(payload.lane);
    return {
      ...(text(payload.runId) ? { runId: payload.runId as string } : {}),
      ...(text(payload.toolCallId) ? { toolCallId: payload.toolCallId as string } : {}),
      ...(status ? { status } : {}),
      ...(text(payload.subagentType) ? { name: payload.subagentType as string } : {}),
      ...(lane?.startsWith('sub:') ? { lane: lane as SyncLane } : {}),
      ...(line(error ?? text(payload.title) ?? text(payload.model)) ? { text: line(error ?? text(payload.title) ?? text(payload.model))! } : {}),
      ...(error || status === 'failed' ? { error: true as const } : {}),
    };
  }
  const data = record(payload.data) ?? {};
  const type = text(payload.type);
  const activity = record(data.activity);
  const input = record(data.rawInput);
  const status = text(data.status) ?? text(activity?.status);
  const name = text(data.toolName) ?? text(activity?.kind) ?? (type === 'task_notification' ? text(data.kind) : undefined);
  const toolCallId = text(data.toolCallId) ?? text(activity?.toolCallId) ?? text(data.subagentToolCallId);
  const error = text(data.error) ?? text(data.reason);
  const said = error
    ?? text(data.title) ?? text(activity?.title)
    ?? inputText(input)
    ?? contentText(data.content)
    ?? (Array.isArray(data.entries) ? contentText(data.entries.map(entry => ({ text: record(entry)?.content }))) : undefined)
    ?? text(data.text) ?? text(activity?.detail) ?? text(data.detail);
  const shown = line(said);
  return {
    ...(type && type !== kind ? { type } : {}),
    ...(text(payload.runId) ? { runId: payload.runId as string } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(status ? { status } : {}),
    ...(name ? { name } : {}),
    ...(text(data.kind) && type !== 'task_notification' ? { toolKind: data.kind as string } : {}),
    ...(shown ? { text: shown } : {}),
    ...(kind === 'run_failed' || status === 'failed' ? { error: true as const } : {}),
  };
}

/** The index row of a stored journal row. */
export function traceRowOf(row: StoredJournalRow): TraceRow {
  const cleared = row.inline === '{}' && !row.blobRef;
  let payload: Json | undefined;
  if (!cleared) {
    try { payload = record(JSON.parse(row.inline)); } catch { payload = undefined; }
  }
  return {
    seq: row.seq, kind: row.kind, nativeId: row.nativeId, rev: row.rev, ...(row.turnId ? { turnId: row.turnId } : {}), at: row.at,
    bytes: row.blobRef ? row.blobSize ?? 0 : Buffer.byteLength(row.inline),
    ...(row.blobRef ? { blob: true as const } : {}),
    ...(cleared ? { cleared: true as const } : {}),
    ...(payload ? fieldsOf(row.kind, payload) : {}),
  };
}

/** One row with its whole payload, or the head of its JSON past `TRACE_BUDGET.detailBytes`. */
export function traceDetailOf(row: StoredJournalRow & { digest: string; text: string; blobMissing?: true }): TraceRowDetail {
  const base = traceRowOf(row);
  const head = { ...base, digest: row.digest, ...(row.blobRef ? { blobRef: row.blobRef } : {}) };
  const bytes = Buffer.byteLength(row.text);
  // A blob the store no longer has: the inline preview is all there is.
  if (row.blobMissing) return { ...head, payloadText: row.text, truncated: true, missing: true };
  if (bytes > TRACE_BUDGET.detailBytes) {
    const clipped = Buffer.from(row.text).subarray(0, TRACE_BUDGET.detailBytes).toString('utf8').replace(/\uFFFD+$/, '');
    return { ...head, payloadText: clipped, truncated: true };
  }
  try { return { ...head, payload: JSON.parse(row.text) as unknown }; } catch { return { ...head, payloadText: row.text }; }
}
