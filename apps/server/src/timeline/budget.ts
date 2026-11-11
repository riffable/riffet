import { SYNC_BUDGET } from '../../../../packages/contracts/src/sync.js';
import type { RowContent } from '../../../../packages/timeline/src/rows.js';

/*
 * The row budget (docs/SYNC-V3.md, 预算): a row is at most 64KB. Text over 32KB is sent as a 16KB preview;
 * a tool's output and its diffs keep 16KB each; inline images become blob URLs. A row that was cut names
 * the blob holding all of it (`truncated`), so a client can fetch the rest when it is opened.
 */

/** Stores bytes a session's clients fetch from `/api/sessions/:id/blobs/:hash`; returns the hash. */
export type BlobWriter = (sessionId: string, bytes: Buffer, type: string) => string;

/** Strings no longer than this are kept whole wherever they are: ids, titles, statuses. */
const SHORT = 512;
const GUARD_STRING = 2048;
const GUARD_ITEMS = 200;
const GUARD_SOURCES = 64;
const TEXT_KINDS = new Set(['user', 'assistant', 'thought', 'status']);

export const blobUrl = (sessionId: string, hash: string): string => `/api/sessions/${encodeURIComponent(sessionId)}/blobs/${hash}`;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** `text` cut to at most `bytes` of UTF-8, never inside a character. */
export function utf8Prefix(text: string, bytes: number): string {
  if (text.length <= bytes / 3 || Buffer.byteLength(text) <= bytes) return text;
  return Buffer.from(text).subarray(0, bytes).toString('utf8').replace(/�+$/, '');
}

interface Fit { sessionId: string; put: BlobWriter; cut: boolean }

const DATA_URL = /^data:(image\/[\w.+-]+);base64,(.*)$/s;

function imageBlob(fit: Fit, mimeType: string, base64: string): string {
  return blobUrl(fit.sessionId, fit.put(fit.sessionId, Buffer.from(base64, 'base64'), mimeType));
}

/** Inline images anywhere under `value` become `{ type: 'image', mimeType, uri }`; nothing else changes. */
function withoutInlineImages(value: unknown, fit: Fit): unknown {
  if (Array.isArray(value)) {
    let copy: unknown[] | undefined;
    value.forEach((item, index) => { const next = withoutInlineImages(item, fit); if (next !== item) (copy ??= [...value])[index] = next; });
    return copy ?? value;
  }
  if (!isRecord(value)) return value;
  if (value.type === 'image' && typeof value.data === 'string' && typeof value.mimeType === 'string' && value.mimeType.startsWith('image/')) {
    const { data, ...rest } = value;
    return { ...rest, uri: imageBlob(fit, value.mimeType, data as string) };
  }
  let copy: Record<string, unknown> | undefined;
  for (const [key, item] of Object.entries(value)) {
    const next = withoutInlineImages(item, fit);
    if (next !== item) (copy ??= { ...value })[key] = next;
  }
  return copy ?? value;
}

/** Long strings under `value` cut so that together they stay within `allowance`; a diff's texts draw on their own. */
function clipped(value: unknown, fit: Fit, allowance: { output: number; diff: number }, diff = false): unknown {
  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value);
    if (bytes <= SHORT) return value;
    const left = diff ? allowance.diff : allowance.output;
    const keep = Math.min(bytes, Math.max(0, left));
    if (diff) allowance.diff -= keep; else allowance.output -= keep;
    if (keep === bytes) return value;
    fit.cut = true;
    return utf8Prefix(value, keep);
  }
  if (Array.isArray(value)) return value.map(item => clipped(item, fit, allowance, diff));
  if (!isRecord(value)) return value;
  const inDiff = diff || value.type === 'diff';
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clipped(item, fit, allowance, inDiff)]));
}

/** A text over the text limit becomes its preview. */
function previewed(text: string, fit: Fit): string {
  if (Buffer.byteLength(text) <= SYNC_BUDGET.textBytes) return text;
  fit.cut = true;
  return utf8Prefix(text, SYNC_BUDGET.previewBytes);
}

function textsPreviewed(value: unknown, fit: Fit): unknown {
  if (typeof value === 'string') return previewed(value, fit);
  if (Array.isArray(value)) return value.map(item => textsPreviewed(item, fit));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, textsPreviewed(item, fit)]));
}

/** Last resort for a row still over budget: every string and list under `value` short. */
function guarded(value: unknown): unknown {
  if (typeof value === 'string') return utf8Prefix(value, GUARD_STRING);
  if (Array.isArray(value)) return value.slice(0, GUARD_ITEMS).map(guarded);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, guarded(item)]));
}

/** What survives of an event's data when the row is still too big: its short scalar fields. */
function scalars(data: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if ((typeof value === 'string' && Buffer.byteLength(value) <= SHORT) || typeof value === 'number' || typeof value === 'boolean') kept[key] = value;
  }
  return { ...kept, truncated: true };
}

const sizeOf = (row: unknown) => Buffer.byteLength(JSON.stringify(row));

/**
 * `row` fitted to the row budget: the payload to store and its size. Blobs it needs (images, the full row
 * of one that was cut) are written through `put`; identical bytes are one blob.
 */
export function fitRow(row: RowContent, sessionId: string, put: BlobWriter): { row: RowContent; json: string; bytes: number } {
  const fit: Fit = { sessionId, put, cut: false };
  let full = row as RowContent & Record<string, unknown>;
  if (full.kind === 'image') {
    const match = DATA_URL.exec(full.src);
    if (match) full = { ...full, src: imageBlob(fit, match[1]!, match[2]!) };
  }
  const data = withoutInlineImages(full.event.data, fit) as Record<string, unknown>;
  if (data !== full.event.data) full = { ...full, event: { ...full.event, data } };
  const fullJson = JSON.stringify(full);
  const fullBytes = Buffer.byteLength(fullJson);
  // Most rows are small and have nothing long: they are sent as they are.
  if (fullBytes <= SYNC_BUDGET.toolOutputBytes) return { row: full, json: fullJson, bytes: fullBytes };

  // A text row's text is cut only past the text limit; anything else's long strings share the output and diff allowances.
  const text = TEXT_KINDS.has(full.kind);
  const allowance = { output: SYNC_BUDGET.toolOutputBytes, diff: SYNC_BUDGET.diffBytes };
  const fitValue = (value: unknown) => text ? textsPreviewed(value, fit) : clipped(value, fit, allowance);
  const { key, pos, turn, kind, event, ...fields } = full;
  let fitted = {
    key, pos, turn, kind, ...(fitValue(fields) as Record<string, unknown>), event: { ...event, data: fitValue(event.data) as Record<string, unknown> },
  } as RowContent & Record<string, unknown>;
  if (sizeOf(fitted) > SYNC_BUDGET.rowBytes) {
    fit.cut = true;
    fitted = { ...fitted, event: { ...fitted.event, data: scalars(fitted.event.data), sourceIds: fitted.event.sourceIds.slice(0, GUARD_SOURCES) } };
  }
  if (sizeOf(fitted) > SYNC_BUDGET.rowBytes) {
    const { key: k, pos: p, turn: t, kind: kd, event: e, ...rest } = fitted;
    fitted = { key: k, pos: p, turn: t, kind: kd, ...(guarded(rest) as Record<string, unknown>), event: guarded(e) as RowContent['event'] } as RowContent & Record<string, unknown>;
  }
  if (!fit.cut) return { row: full, json: fullJson, bytes: fullBytes };
  const blobRef = put(sessionId, Buffer.from(fullJson), 'application/json');
  const result = { ...fitted, truncated: { blobRef, bytes: fullBytes } } as RowContent;
  const json = JSON.stringify(result);
  return { row: result, json, bytes: Buffer.byteLength(json) };
}
