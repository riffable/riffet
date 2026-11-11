import type { TranscriptRow } from './transcriptRows';

/** Below this many rows the transcript renders whole; above it only a window around the reader. */
export const VIRTUAL_MIN_ROWS = 150;
/** Once windowed, stay windowed until the list falls this far, so a row count at the edge cannot flap. */
export const VIRTUAL_RELEASE_ROWS = 100;
/** What a row not yet measured counts for. */
export const ESTIMATED_ROW_HEIGHT = 88;
/** The part of a row's height that a new column width does not rewrap: about one line with its gaps. */
const UNWRAPPED_HEIGHT = 48;
/** Least extra distance kept mounted above and below the viewport. */
export const OVERSCAN_MIN = 600;

/**
 * What a row measured [height] px tall at a text width of [from] px likely measures at [to] px, until
 * it is measured again. Wrapped text grows about inversely with the width; the first line, the
 * row's gaps and anything that does not wrap do not, so only the height past one line is scaled.
 */
export function rescaledHeight(height: number, from: number, to: number): number {
  if (!(from > 0) || !(to > 0)) return height;
  const fixed = Math.min(height, UNWRAPPED_HEIGHT);
  return fixed + (height - fixed) * from / to;
}

/** [from, to) of the rows to mount. */
export type Segment = readonly [from: number, to: number];

/**
 * Where every row sits, as the sum of the heights before it: measured ones where known, an
 * estimate for the rest. `offsets[i]` is the top of row `i` within the list; `offsets[n]` is its end.
 */
export interface RowLayout {
  rows: readonly TranscriptRow[];
  offsets: Float64Array;
  /** Indices of the rows that open a turn (a prompt), in order. */
  turnRows: number[];
  indexOf(key: string): number | undefined;
}

export function buildLayout(rows: readonly TranscriptRow[], heights: ReadonlyMap<string, number>): RowLayout {
  const offsets = new Float64Array(rows.length + 1);
  const turnRows: number[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    offsets[index + 1] = offsets[index]! + (heights.get(row.key) ?? ESTIMATED_ROW_HEIGHT);
    if (row.type === 'item' && row.item.kind === 'user') turnRows.push(index);
  }
  let byKey: Map<string, number> | undefined;
  return {
    rows, offsets, turnRows,
    indexOf(key) {
      if (!byKey) byKey = new Map(rows.map((row, index) => [row.key, index]));
      return byKey.get(key);
    },
  };
}

/** The row containing [y] (a list offset): the last one whose top is at or above it. */
export function indexAt(offsets: Float64Array, count: number, y: number): number {
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (offsets[middle]! <= y) low = middle;
    else high = middle - 1;
  }
  return Math.max(0, low);
}

/**
 * The rows to mount for a viewport of [viewport] px whose top is [top] px into the list: those
 * reaching [overscan] beyond either edge, plus the rows from [tailStart] on wherever the reader is,
 * so the row that is streaming never unmounts.
 */
export function windowSegments(offsets: Float64Array, count: number, tailStart: number, top: number, viewport: number, overscan: number): Segment[] {
  if (count === 0) return [];
  const start = indexAt(offsets, count, top - overscan);
  const end = Math.min(count, Math.max(start + 1, indexAt(offsets, count, top + viewport + overscan) + 1));
  const tail = Math.min(Math.max(0, tailStart), count - 1);
  if (end >= tail) return [[Math.min(start, tail), count]];
  return [[start, end], [tail, count]];
}

/** Whether one mounted segment spans the band [a, b] of the list, so no row in it is missing. */
export function segmentsCover(segments: readonly Segment[], offsets: Float64Array, count: number, a: number, b: number): boolean {
  return segments.some(([from, to]) => (from === 0 || offsets[from]! <= a) && (to >= count || offsets[to]! >= b));
}
