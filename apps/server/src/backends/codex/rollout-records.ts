/**
 * The rows of a rollout, in the shape Codex writes them.
 *
 * TRAE CLI no longer writes model items as `response_item` rows: it wraps them in
 * `history_mutation { operation, items[] }`. `append` adds items; `replace` starts a compacted context
 * window whose items are the summary that replaces the old history. Either way each item is the same
 * payload a `response_item` row carries, so unfolding them lets one parser read both CLIs. A replace
 * does not undo what came before it — a compaction keeps the todo state, as Codex's `compacted` does.
 */
export function* rolloutRows(content: string): Generator<Record<string, unknown>> {
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let row: Record<string, unknown> | undefined;
    try { row = record(JSON.parse(line)); } catch { continue; }
    if (!row) continue;
    if (row.type !== 'history_mutation') {
      yield row;
      continue;
    }
    const payload = record(row.payload);
    const items = Array.isArray(payload?.items) ? payload.items : [];
    for (const item of items) {
      const itemPayload = record(item);
      if (itemPayload) yield { type: 'response_item', timestamp: row.timestamp, payload: itemPayload };
    }
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * The newest `compacted` row of a rollout (Codex writes `{ message, replacement_history }` when it
 * replaces the history with a summary): the summary text, and when it was written.
 */
export function lastRolloutCompaction(content: string): { message?: string; timestamp?: string } | undefined {
  let found: { message?: string; timestamp?: string } | undefined;
  for (const row of rolloutRows(content)) {
    if (row.type !== 'compacted') continue;
    const payload = record(row.payload);
    const message = typeof payload?.message === 'string' && payload.message.trim() ? payload.message : undefined;
    found = { ...(message ? { message } : {}), ...(typeof row.timestamp === 'string' ? { timestamp: row.timestamp } : {}) };
  }
  return found;
}
