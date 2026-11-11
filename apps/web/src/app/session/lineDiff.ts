import { msg } from '@lingui/core/macro';
import { i18n } from '@lingui/core';
import { boundedCache } from '@/lib/bounded-cache';

import { computeAlignment, type AlignedDiff, type DiffLine } from '../../../../../packages/timeline/src/lineDiff';

export type { DiffLine };

/**
 * The same edit is diffed by the change summary, the session's outputs and the diff card, each with
 * its own context. Alignment is the expensive part (O(n·m) over the changed middle), so it is done
 * once per pair of texts and shared; a few dozen recent edits cover a transcript's visible rows.
 */
const alignedCache = boundedCache<string, AlignedDiff | null>({ limit: 48 });

function alignLines(before: string, after: string): AlignedDiff | null {
  const key = `${before.length}:${before}\u0000${after}`;
  const hit = alignedCache.get(key);
  if (hit !== undefined) return hit;
  const aligned = computeAlignment(before, after);
  alignedCache.set(key, aligned);
  return aligned;
}

/**
 * Line diff with LCS; returns null when the inputs are too large to diff cheaply. `lineOffset`
 * and `trailingLines` describe unchanged lines the server already trimmed from both sides;
 * `newLineOffset` is where the new side starts when an earlier hunk moved it.
 */
export function lineDiff(before: string, after: string, context = 3, lineOffset = 0, trailingLines = 0, newLineOffset = lineOffset): { lines: DiffLine[]; added: number; removed: number } | null {
  const aligned = alignLines(before, after);
  if (!aligned) return null;
  const { full, added, removed } = aligned;
  const keep = new Array<boolean>(full.length).fill(false);
  full.forEach((line, index) => {
    if (line.type === 'same') return;
    for (let k = Math.max(0, index - context); k <= Math.min(full.length - 1, index + context); k += 1) keep[k] = true;
  });
  const lines: DiffLine[] = [];
  let skipped = lineOffset;
  full.forEach((line, index) => {
    if (keep[index]) {
      if (skipped) { lines.push({ type: 'gap', text: i18n._(msg`${skipped} 行未改动`) }); skipped = 0; }
      lines.push(lineOffset || newLineOffset ? { ...line, ...(line.oldNo ? { oldNo: line.oldNo + lineOffset } : {}), ...(line.newNo ? { newNo: line.newNo + newLineOffset } : {}) } : line);
    } else skipped += 1;
  });
  skipped += trailingLines;
  if (skipped && lines.length) lines.push({ type: 'gap', text: i18n._(msg`${skipped} 行未改动`) });
  return { lines, added, removed };
}
