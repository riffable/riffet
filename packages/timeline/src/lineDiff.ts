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
