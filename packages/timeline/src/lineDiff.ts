/*
 * Language-free line diff: the LCS alignment of one edit and the added / removed counts of a tool's
 * diffs. The web renders hunks from it; the channel card's footer sums it.
 */

export interface DiffLine { type: 'same' | 'add' | 'del' | 'gap'; text: string; oldNo?: number; newNo?: number; }

/** Every line of one edit, aligned once; `lineDiff` derives each caller's hunks from it. */
export interface AlignedDiff { full: DiffLine[]; added: number; removed: number }

const DIFF_CELL_LIMIT = 1_200_000;

export function computeAlignment(before: string, after: string): AlignedDiff | null {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > DIFF_CELL_LIMIT) return null;
  const n = midA.length;
  const m = midB.length;
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] = midA[i] === midB[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const full: DiffLine[] = [];
  for (let i = 0; i < start; i += 1) full.push({ type: 'same', text: a[i]!, oldNo: i + 1, newNo: i + 1 });
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) { full.push({ type: 'same', text: midA[i]!, oldNo: start + i + 1, newNo: start + j + 1 }); i += 1; j += 1; }
    else if (j < m && (i >= n || table[i]![j + 1]! >= table[i + 1]![j]!)) { full.push({ type: 'add', text: midB[j]!, newNo: start + j + 1 }); j += 1; added += 1; }
    else { full.push({ type: 'del', text: midA[i]!, oldNo: start + i + 1 }); i += 1; removed += 1; }
  }
  for (let k = endA; k < a.length; k += 1) full.push({ type: 'same', text: a[k]!, oldNo: k + 1, newNo: endB + (k - endA) + 1 });
  return { full, added, removed };
}

/** Splits text into logical lines matching `git diff --numstat` (one trailing newline does not add an empty line). */
export function logicalLines(text: string): string[] {
  if (!text) return [];
  const trimmed = text.endsWith('\r\n') ? text.slice(0, -2) : text.endsWith('\n') ? text.slice(0, -1) : text;
  if (!trimmed) return text.length ? [''] : [];
  return trimmed.split(/\r?\n/);
}

/** Exact net added/removed line counts between two whole-file UTF-8 texts, aligned with `git diff --numstat`. */
export function textLineDelta(before: string, after: string): { added: number; removed: number } {
  if (before === after) return { added: 0, removed: 0 };
  const a = logicalLines(before);
  const b = logicalLines(after);
  if (!a.length) return { added: b.length, removed: 0 };
  if (!b.length) return { added: 0, removed: a.length };
  const aligned = computeAlignment(a.join('\n'), b.join('\n'));
  if (aligned) return { added: aligned.added, removed: aligned.removed };
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  return { added: b.length - head - tail, removed: a.length - head - tail };
}

/**
 * Lines added and removed across every `diff` content item of a tool call. Diffs too large to align
 * count the changed middle (after the shared head and tail) instead.
 */
export function contentDiffStats(contents: readonly Record<string, unknown>[], align: (before: string, after: string) => { added: number; removed: number } | null = computeAlignment): { added: number; removed: number; files: number } | undefined {
  const diffs = contents.filter((item) => item.type === 'diff');
  if (!diffs.length) return undefined;
  let added = 0;
  let removed = 0;
  for (const item of diffs) {
    const before = typeof item.oldText === 'string' ? item.oldText : '';
    const after = String(item.newText ?? '');
    const diff = align(before, after);
    if (diff) { added += diff.added; removed += diff.removed; continue; }
    const a = before === '' ? [] : before.split('\n');
    const b = after === '' ? [] : after.split('\n');
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
    added += b.length - head - tail;
    removed += a.length - head - tail;
  }
  return { added, removed, files: new Set(diffs.map((item) => item.path)).size };
}

/** Statuses of a tool call that has not been confirmed applied on disk. */
export const UNSETTLED_TOOL_STATUSES = new Set(['pending', 'in_progress', 'running', 'queued', 'cancelled', 'rejected']);

export interface ToolFileChange {
  path: string;
  added: number;
  removed: number;
  created: boolean;
  status: 'created' | 'modified' | 'deleted';
  binary?: boolean;
  accuracy?: 'exact' | 'estimated';
  preHash?: string | null;
  postHash?: string | null;
  observed?: boolean;
}

function asChangeStatus(value: unknown): 'created' | 'modified' | 'deleted' | undefined {
  return value === 'created' || value === 'modified' || value === 'deleted' ? value : undefined;
}

/**
 * The files one tool call changed, from its structured `fileSnapshots` (when captured) or the `diff`
 * blocks of its folded data, in the order they appear. Unsettled (in-progress, pending, cancelled)
 * and failed edits are excluded; what a command was actually seen to change on disk (`observed`)
 * stays. Explicit `status` / `created` markers override the legacy `!oldText` heuristic so partial
 * pure-insert hunks do not mislabel existing files as created.
 */
export function toolFileChanges(data: Record<string, unknown>): ToolFileChange[] {
  const rawStatus = typeof data.status === 'string' ? data.status : typeof data.state === 'string' ? data.state : 'completed';
  const failed = rawStatus === 'failed';
  const unsettled = UNSETTLED_TOOL_STATUSES.has(rawStatus);

  const snapshots = Array.isArray(data.fileSnapshots) ? data.fileSnapshots : [];
  if (snapshots.length) {
    const out: ToolFileChange[] = [];
    for (const item of snapshots) {
      if (!item || typeof item !== 'object') continue;
      const snap = item as Record<string, unknown>;
      if (typeof snap.path !== 'string' || !snap.path) continue;
      const observed = snap.observed === true;
      if ((failed || unsettled) && !observed) continue;
      const status = asChangeStatus(snap.status) ?? 'modified';
      const added = typeof snap.added === 'number' && Number.isFinite(snap.added) ? Math.max(0, Math.floor(snap.added)) : 0;
      const removed = typeof snap.removed === 'number' && Number.isFinite(snap.removed) ? Math.max(0, Math.floor(snap.removed)) : 0;
      const preHash = snap.preHash === null ? null : typeof snap.preHash === 'string' ? snap.preHash : undefined;
      const postHash = snap.postHash === null ? null : typeof snap.postHash === 'string' ? snap.postHash : undefined;
      out.push({
        path: snap.path,
        added,
        removed,
        created: status === 'created',
        status,
        ...(snap.binary === true ? { binary: true } : {}),
        accuracy: 'exact',
        ...(preHash !== undefined ? { preHash } : {}),
        ...(postHash !== undefined ? { postHash } : {}),
        ...(observed ? { observed: true } : {}),
      });
    }
    if (out.length) return out;
  }

  const content = Array.isArray(data.content) ? data.content : [];
  return content.flatMap((item): ToolFileChange[] => {
    if (!item || typeof item !== 'object') return [];
    const block = item as Record<string, unknown>;
    if (block.type !== 'diff' || typeof block.path !== 'string' || !block.path) return [];
    const observed = block.observed === true;
    if ((failed || unsettled) && !observed) return [];
    const explicitStatus = asChangeStatus(block.status);
    const binary = block.binary === true;
    const before = typeof block.oldText === 'string' ? block.oldText : '';
    const after = typeof block.newText === 'string' ? block.newText : '';
    const hasExplicitCounts = typeof block.added === 'number' && typeof block.removed === 'number';
    const stats = binary
      ? { added: 0, removed: 0 }
      : hasExplicitCounts
        ? { added: Math.max(0, Math.floor(block.added as number)), removed: Math.max(0, Math.floor(block.removed as number)) }
        : contentDiffStats([block]) ?? { added: 0, removed: 0 };
    const isPartialHunk = typeof block.lineOffset === 'number' || typeof block.newLineOffset === 'number';
    const created = explicitStatus !== undefined
      ? explicitStatus === 'created'
      : typeof block.created === 'boolean'
        ? block.created
        : !isPartialHunk && before === '' && after !== '';
    const status: 'created' | 'modified' | 'deleted' = explicitStatus ?? (created ? 'created' : 'modified');
    return [{
      path: block.path,
      added: stats.added,
      removed: stats.removed,
      created,
      status,
      ...(binary ? { binary: true } : {}),
      accuracy: 'estimated',
      ...(observed ? { observed: true } : {}),
    }];
  });
}
