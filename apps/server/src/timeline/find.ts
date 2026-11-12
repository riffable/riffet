import { FIND_MAX_ROWS, type LaneFind, type LaneFindHit, type SyncLane } from '../../../../packages/contracts/src/sync.js';
import { countOccurrences, findableText, findNeedle } from '../../../../packages/timeline/src/findText.js';
import { rowOf, type TimelineTables } from './tables.js';

/*
 * 会话内查找 over a whole lane (`GET /api/v3/sessions/:id/find`): the rows a client has not loaded are
 * counted as well as the ones it has, each by what it shows folded (`findableText`), so the client can
 * step to a hit anywhere and page in the rows around it by place.
 *
 * A row's text is derived once per revision and kept for the few lanes found in last, so a find typed
 * key by key reads the lane's places and only the rows that changed since, never every payload again.
 * The first read of a lane is the expensive one — its payloads are mostly tool output, on pages no
 * reader has touched lately (about a second for 6k rows, 39 MB) — so it reads a slice of rows per turn
 * of the event loop, once however many finds ask meanwhile.
 */

interface Text { rev: number; pos: number; turn: string; text: string }
interface LaneTexts { generation: string; root: string | undefined; rows: Map<string, Text> }

/** Lanes whose texts are kept between finds: one reader's conversation and the few they switch between. */
const KEPT_LANES = 6;
/** Rows a first read takes per turn of the event loop: a few tens of milliseconds of cold reads at most. */
const STEP_ROWS = 250;

const yieldLoop = () => new Promise<void>(resolve => setImmediate(resolve));

export class LaneFinder {
  private readonly lanes = new Map<string, LaneTexts>();
  private readonly reading = new Map<string, Promise<LaneTexts>>();

  constructor(private readonly tables: TimelineTables, private readonly stepRows = STEP_ROWS) {}

  /** The lane's rows holding [query] as of [head]; nothing is counted for a blank query. */
  async find(sessionId: string, lane: SyncLane, head: { generation: string; headSeq: number }, query: string, root?: string): Promise<LaneFind> {
    const needle = findNeedle(query);
    if (!needle) return { generation: head.generation, headSeq: head.headSeq, total: 0, hits: [] };
    const texts = await this.texts(sessionId, lane, head.generation, root);
    const hits: LaneFindHit[] = [];
    let total = 0;
    for (const [key, entry] of texts.rows) {
      const count = countOccurrences(entry.text, needle);
      if (!count) continue;
      total += count;
      hits.push({ key, pos: entry.pos, turn: entry.turn, count });
    }
    hits.sort((left, right) => left.pos - right.pos || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
    const truncated = hits.length > FIND_MAX_ROWS;
    return { generation: head.generation, headSeq: head.headSeq, total, hits: truncated ? hits.slice(0, FIND_MAX_ROWS) : hits, ...(truncated ? { truncated } : {}) };
  }

  private async texts(sessionId: string, lane: SyncLane, generation: string, root: string | undefined): Promise<LaneTexts> {
    const id = `${sessionId}\n${lane}`;
    let texts = this.lanes.get(id);
    // A new generation may reuse keys at lower revisions, and a new root shortens paths differently.
    if (!texts || texts.generation !== generation || texts.root !== root) {
      const at = `${id}\n${generation}\n${root ?? ''}`;
      let read = this.reading.get(at);
      if (!read) {
        read = this.read(sessionId, lane, generation, root).finally(() => this.reading.delete(at));
        this.reading.set(at, read);
      }
      texts = await read;
    }
    this.refresh(sessionId, lane, texts);
    this.lanes.delete(id);
    this.lanes.set(id, texts);
    while (this.lanes.size > KEPT_LANES) this.lanes.delete(this.lanes.keys().next().value!);
    return texts;
  }

  /** Every live row's text, a slice per turn of the event loop. Rows changed meanwhile are caught up by `refresh`. */
  private async read(sessionId: string, lane: SyncLane, generation: string, root: string | undefined): Promise<LaneTexts> {
    const rows = new Map<string, Text>();
    let after: { pos: number; key: string } | undefined;
    for (;;) {
      const slice = this.tables.findRows(sessionId, lane, after, this.stepRows);
      for (const entry of slice) rows.set(entry.key, { rev: entry.rev, pos: entry.pos, turn: entry.turn, text: findableText(entry.row, root) });
      if (slice.length < this.stepRows) return { generation, root, rows };
      after = { pos: slice.at(-1)!.pos, key: slice.at(-1)!.key };
      await yieldLoop();
    }
  }

  /** Brings [texts] to the lane's rows now: places moved, rows changed, added or gone. */
  private refresh(sessionId: string, lane: SyncLane, texts: LaneTexts): void {
    const live = new Set<string>();
    for (const place of this.tables.findPlaces(sessionId, lane)) {
      live.add(place.key);
      const entry = texts.rows.get(place.key);
      if (entry && entry.rev === place.rev) { entry.pos = place.pos; entry.turn = place.turn; continue; }
      const stored = this.tables.row(sessionId, lane, place.key);
      if (!stored || stored.deleted) continue;
      texts.rows.set(place.key, { rev: place.rev, pos: place.pos, turn: place.turn, text: findableText(rowOf(stored.payload, stored.seq, stored.rev), texts.root) });
    }
    for (const key of texts.rows.keys()) if (!live.has(key)) texts.rows.delete(key);
  }
}
