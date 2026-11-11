import { PENDING_ROW_POS, type TimelinePage, type TimelineRow } from '@contracts';

/** docs/SYNC-V3.md 预算, 客户端窗口: what one lane keeps in memory on the web. */
export const WINDOW_LIMIT = { rows: 2000, bytes: 8 * 1024 * 1024 } as const;
export interface WindowLimit { readonly rows: number; readonly bytes: number }

/**
 * How a page goes in. `before` and `from` extend the window up or down; `around` (a jump) and
 * `latest` (back to the live end) replace it.
 */
export type PageMode = 'before' | 'from' | 'around' | 'latest';

const order = (a: TimelineRow, b: TimelineRow) => a.pos - b.pos || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
/** What a row costs the budget: its JSON length, near enough to its bytes for the mostly ASCII payloads. */
const sizeOf = (row: TimelineRow) => JSON.stringify(row).length;
export const isRow = (row: unknown): row is TimelineRow => {
  const value = row as Partial<TimelineRow> | undefined;
  return typeof value?.key === 'string' && typeof value.pos === 'number' && Number.isFinite(value.pos) && typeof value.seq === 'number' && typeof value.kind === 'string';
};
const pendingRow = (row: TimelineRow) => row.pos >= PENDING_ROW_POS;

/**
 * The rows of one lane this tab holds: a contiguous run of the lane's rows by `pos`, plus the pending
 * prompts after them. `hasBefore` / `hasAfter` say whether the lane goes on past either end. A window
 * that has the lane's end (`!hasAfter`) takes every new row; one the reader moved away from (paged up
 * past the limit, or jumped) takes only the rows that land inside it, and pages to come back.
 *
 * Over the limit it gives up rows from the end away from the reader, whichever way the rows came in:
 * `readerAtEnd` says which end that is. The direction of a request is not the reader's position — a
 * prefetch of older rows while the reader follows the live end must not drop the rows being read. A
 * place (`pos`) is always given up whole, because a page asks for the rows strictly before the first one.
 */
export class LaneWindow {
  hasBefore = false;
  hasAfter = false;
  bytes = 0;
  /** The reader is nearer the window's bottom than its top; set by the view, true until it says otherwise. */
  readerAtEnd = true;
  /** The last page of older rows did not fit beside the reader's end; asking again would only repeat that. */
  olderFull = false;
  private placed: TimelineRow[] = [];
  private pending: TimelineRow[] = [];
  private byKey = new Map<string, { row: TimelineRow; bytes: number }>();
  private view: readonly TimelineRow[] | undefined;
  /** While a page is on its way: the newest change the stream made to each key meanwhile. */
  private recent: Map<string, { seq: number; row?: TimelineRow }> | undefined;
  private requests = 0;

  constructor(readonly limit: WindowLimit = WINDOW_LIMIT) {}

  /** Every row, in order; the same array until something changes. */
  rows(): readonly TimelineRow[] {
    return this.view ??= this.pending.length ? [...this.placed, ...this.pending] : this.placed.slice();
  }

  get count(): number { return this.placed.length + this.pending.length; }
  get first(): TimelineRow | undefined { return this.placed[0]; }
  get last(): TimelineRow | undefined { return this.placed.at(-1); }
  get(key: string): TimelineRow | undefined { return this.byKey.get(key)?.row; }

  clear(): void {
    this.placed = [];
    this.pending = [];
    this.byKey.clear();
    this.bytes = 0;
    this.hasBefore = false;
    this.hasAfter = false;
    this.view = undefined;
  }

  /** The window becomes [rows]. `keepPending` holds on to the pending prompts, which a page from the middle of the lane does not carry. */
  replace(rows: readonly TimelineRow[], edges: { hasBefore: boolean; hasAfter: boolean }, keepPending = false): void {
    const pending = keepPending ? this.pending : [];
    this.clear();
    this.olderFull = false;
    for (const row of rows) if (isRow(row) && !this.byKey.has(row.key)) this.insert(row);
    for (const row of pending) if (!this.byKey.has(row.key)) this.insert(row);
    this.hasBefore = edges.hasBefore;
    this.hasAfter = edges.hasAfter;
    this.evict('top');
  }

  /**
   * A rows frame. `seq` is the frame's `to`, the date of its deletes. A row outside the window is left
   * out; the page that later covers its place brings it as it is then. Returns whether anything shown changed.
   */
  apply(upserts: readonly TimelineRow[], deletes: readonly string[], seq: number): boolean {
    let changed = false;
    for (const key of deletes) {
      this.note(key, seq);
      if (this.remove(key)) changed = true;
    }
    for (const row of upserts) {
      if (!isRow(row)) continue;
      this.note(row.key, row.seq, row);
      const held = this.byKey.get(row.key);
      if (held && held.row.seq > row.seq) continue;
      if (held) { this.remove(row.key); changed = true; }
      if (this.covers(row.pos)) { this.insert(row); changed = true; }
    }
    if (changed) this.evict(this.awayFromReader());
    return changed;
  }

  /** A page request starts; until the last one ends, the stream's changes are noted so an older page cannot undo them. */
  begin(): void {
    if (this.requests++ === 0) this.recent = new Map();
  }

  end(): void {
    if (this.requests > 0 && --this.requests === 0) this.recent = undefined;
  }

  /**
   * Takes a page in, newest version of each row winning. `added` counts the rows it added that the
   * budget then kept; `full` is a page whose rows the budget gave up again to keep the reader's end.
   */
  merge(page: TimelinePage, mode: PageMode): { added: number; full: boolean } {
    const incoming = new Map<string, TimelineRow>();
    for (const row of page.rows) if (isRow(row)) incoming.set(row.key, row);
    const placedIn = page.rows.filter((row) => isRow(row) && !pendingRow(row));
    // The places the page answers for; the stream's changes there since it was cut are laid over it.
    const low = mode === 'from' ? this.last?.pos ?? Number.NEGATIVE_INFINITY : page.hasBefore ? placedIn[0]?.pos ?? Number.NEGATIVE_INFINITY : Number.NEGATIVE_INFINITY;
    const high = mode === 'before' ? this.first?.pos ?? Number.POSITIVE_INFINITY : page.hasAfter ? placedIn.at(-1)?.pos ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY;
    for (const [key, change] of this.recent ?? []) {
      const known = incoming.get(key);
      if (known && known.seq >= change.seq) continue;
      if (!change.row) { incoming.delete(key); continue; }
      const inside = pendingRow(change.row) ? mode !== 'before' : change.row.pos >= low && change.row.pos <= high;
      if (inside) incoming.set(key, change.row);
      else incoming.delete(key);
    }
    if (mode === 'around' || mode === 'latest') {
      const before = new Set(this.byKey.keys());
      this.replace([...incoming.values()].sort(order), { hasBefore: page.hasBefore, hasAfter: page.hasAfter }, mode === 'around');
      return { added: [...this.byKey.keys()].filter((key) => !before.has(key)).length, full: false };
    }
    const added: string[] = [];
    for (const row of incoming.values()) {
      const held = this.byKey.get(row.key);
      if (held && held.row.seq >= row.seq) continue;
      if (held) this.remove(row.key);
      else added.push(row.key);
      this.insert(row);
    }
    if (mode === 'before') this.hasBefore = page.hasBefore;
    else this.hasAfter = page.hasAfter;
    const edge = mode === 'before' ? this.first : this.last;
    this.evict(this.awayFromReader());
    const kept = added.filter((key) => this.byKey.has(key)).length;
    // The page's far end was given up again: the window is at its budget and the reader is at the other side.
    const full = kept === 0 && (mode === 'before' ? this.first !== edge : this.last !== edge);
    if (mode === 'before') this.olderFull = full;
    return { added: kept, full };
  }

  /** The end a window over its budget gives up. */
  private awayFromReader(): 'top' | 'bottom' {
    return this.readerAtEnd ? 'top' : 'bottom';
  }

  /**
   * The newest rows within [limit], for a copy that only has to paint the first screen: the pending
   * prompts and the placed rows from the end, giving up whole places like the window does.
   */
  tail(limit: WindowLimit): { rows: readonly TimelineRow[]; hasBefore: boolean } {
    let rows = this.pending.length;
    let bytes = this.pending.reduce((sum, row) => sum + this.byKey.get(row.key)!.bytes, 0);
    let start = this.placed.length;
    while (start > 0) {
      const pos = this.placed[start - 1]!.pos;
      let from = start;
      let cost = 0;
      while (from > 0 && this.placed[from - 1]!.pos === pos) { from -= 1; cost += this.byKey.get(this.placed[from]!.key)!.bytes; }
      // At least one place stays, so the copy keeps its place in the lane.
      if (start < this.placed.length && (rows + start - from > limit.rows || bytes + cost > limit.bytes)) break;
      rows += start - from;
      bytes += cost;
      start = from;
    }
    if (start === 0) return { rows: this.rows(), hasBefore: this.hasBefore };
    return { rows: [...this.placed.slice(start), ...this.pending], hasBefore: true };
  }

  /** The whole of a row that was sent cut, unless the row has changed since it was asked for. */
  expand(key: string, seq: number, full: Record<string, unknown>): boolean {
    const held = this.byKey.get(key)?.row;
    if (!held || held.seq !== seq || full.kind !== held.kind) return false;
    const { truncated: _truncated, ...rest } = full;
    this.remove(key);
    this.insert({ ...rest, key, pos: held.pos, turn: held.turn, seq: held.seq, rev: held.rev } as TimelineRow);
    return true;
  }

  private over(rows: number, bytes: number): boolean {
    return rows > this.limit.rows || bytes > this.limit.bytes;
  }

  private evict(from: 'top' | 'bottom'): void {
    const list = this.placed;
    let rows = this.count;
    let bytes = this.bytes;
    let cut = 0;
    // At least one row stays, so the window keeps its place in the lane.
    while (cut < list.length - 1 && this.over(rows, bytes)) {
      const at = (offset: number) => list[from === 'top' ? offset : list.length - 1 - offset]!;
      const pos = at(cut).pos;
      while (cut < list.length - 1 && at(cut).pos === pos) {
        rows -= 1;
        bytes -= this.byKey.get(at(cut).key)!.bytes;
        cut += 1;
      }
    }
    if (!cut) return;
    const gone = from === 'top' ? list.splice(0, cut) : list.splice(list.length - cut, cut);
    for (const row of gone) {
      this.bytes -= this.byKey.get(row.key)!.bytes;
      this.byKey.delete(row.key);
    }
    if (from === 'top') this.hasBefore = true;
    else this.hasAfter = true;
    this.view = undefined;
  }

  private covers(pos: number): boolean {
    if (pos >= PENDING_ROW_POS) return true;
    const first = this.placed[0];
    const last = this.placed.at(-1);
    if (!first || !last) return !this.hasAfter;
    return (!this.hasBefore || pos >= first.pos) && (!this.hasAfter || pos <= last.pos);
  }

  private note(key: string, seq: number, row?: TimelineRow): void {
    const held = this.recent?.get(key);
    if (this.recent && (!held || held.seq <= seq)) this.recent.set(key, { seq, ...(row ? { row } : {}) });
  }

  private insert(row: TimelineRow): void {
    const list = pendingRow(row) ? this.pending : this.placed;
    let low = 0;
    let high = list.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (order(list[middle]!, row) < 0) low = middle + 1;
      else high = middle;
    }
    list.splice(low, 0, row);
    const bytes = sizeOf(row);
    this.byKey.set(row.key, { row, bytes });
    this.bytes += bytes;
    this.view = undefined;
  }

  private remove(key: string): boolean {
    const held = this.byKey.get(key);
    if (!held) return false;
    const list = pendingRow(held.row) ? this.pending : this.placed;
    let low = 0;
    let high = list.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (list[middle]!.pos < held.row.pos) low = middle + 1;
      else high = middle;
    }
    while (low < list.length && list[low]!.key !== key) low += 1;
    if (low < list.length) list.splice(low, 1);
    this.byKey.delete(key);
    this.bytes -= held.bytes;
    this.view = undefined;
    return true;
  }
}
