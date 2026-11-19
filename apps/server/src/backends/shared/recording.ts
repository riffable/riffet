import type { JournalRow } from '../../journal/journal.js';

/** Generated ids: uuids, and the provider's message ids (`msg_` and hex), which change on every re-record. */
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\bmsg_[0-9a-f]{20,}\b/gi;
const ISO_TIME = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\b/g;
const VOLATILE_KEY = /^(at|ts|time|timestamp|duration|elapsed)$|(At|Ms|Time|Duration)$/;

/** Rows without what changes from run to run: sequence, digests, clocks and generated ids. */
export function stableRows(rows: JournalRow[]): unknown[] {
  return stable(rows.map(row => ({ kind: row.kind, nativeId: row.nativeId, rev: row.rev, ...(row.turnId ? { turnId: row.turnId } : {}), payload: row.payload }))) as unknown[];
}

/** Any value without clocks and generated ids: ids become `<id-n>` in order of appearance. */
export function stable(value: unknown): unknown {
  const ids = new Map<string, string>();
  const id = (value: string) => value.replace(UUID, match => {
    if (!ids.has(match)) ids.set(match, `<id-${ids.size + 1}>`);
    return ids.get(match)!;
  });
  const clean = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string') return VOLATILE_KEY.test(key) ? '<time>' : id(value).replace(ISO_TIME, '<time>');
    if (typeof value === 'number') return VOLATILE_KEY.test(key) ? '<n>' : value;
    if (Array.isArray(value)) return value.map(item => clean(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, clean(item, name)]));
    return value;
  };
  return clean(value);
}
