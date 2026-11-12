import { PENDING_ROW_POS, type NativeWorkbenchEvent, type RowEvent, type TimelineRow } from '../../contracts/src/index.js';
import { chunkText, nativeSourceIds, timelineItemTime, type TimelineItem } from './model.js';
import { timelineTurnKeys } from './timelineTurns.js';
import { isRecord } from './values.js';

/*
 * Sync v3 rows (docs/SYNC-V3.md, 时间线由服务端折叠): the server folds a lane with `buildTimeline` and
 * sends each row as a `TimelineRow`. This is that conversion; the lane `seq` and `rev` are given by the
 * row table (`apps/server/src/timeline`), which also fits rows to the row budget.
 */

/** A row as the fold makes it: everything but the `seq` and `rev` its lane assigns. */
export type RowContent = TimelineRow extends infer Row ? Row extends unknown ? Omit<Row, 'seq' | 'rev'> : never : never;

/**
 * Room each journal entity has in `pos`. An event row sits in the middle of its entity's slot; a run row
 * filed after it takes the next free place above it, so neither ever moves the other.
 */
export const POS_STEP = 1024;
const EVENT_SLOT = POS_STEP / 2;

/** A row made from a Run rather than an event: a prompt the transcript has not echoed, or the one a compaction dropped. */
export const isRunRow = (item: TimelineItem): boolean => item.event.projectionKey.startsWith('pending:') || item.event.projectionKey.startsWith('receipt:');

type Pending = NonNullable<Extract<TimelineRow, { kind: 'user' }>['pending']>;

/** Where a run that stands in for its own prompt is in its delivery; undefined once the CLI has it. */
export function pendingOf(item: TimelineItem): Pending | undefined {
  if (item.kind !== 'user' || !item.run || !item.event.projectionKey.startsWith('pending:')) return undefined;
  const { run } = item;
  const native = run.native;
  if (run.state === 'failed' || native?.delivery === 'failed') return 'failed';
  if (native ? native.delivery === 'queued' : run.state === 'queued') return 'queued';
  if (native?.delivery === 'preparing') return 'preparing';
  return native && (native.nativeMessageId || native.delivery === 'observed') ? undefined : 'unconfirmed';
}

/**
 * The event's data without the text a text row already carries as `text`. Only `content.text` goes, and
 * `content` stays: a row folded from an event always has data, only a run row's is empty.
 */
function withoutText(item: TimelineItem): Record<string, unknown> {
  const data = item.event.data;
  if (item.kind === 'user' && item.run?.native?.contextSnapshots?.length && chunkText(item.event) !== item.text) {
    // The row already restores Run.prompt; do not retain the CLI echo's injected reference data and local paths.
    const { text: _text, content, ...rest } = data;
    if (isRecord(content)) {
      const { text: _contentText, ...contentFields } = content;
      return { ...rest, content: contentFields };
    }
    return rest;
  }
  if (item.kind !== 'assistant' && item.kind !== 'thought' && !(item.kind === 'user' && chunkText(item.event) === item.text)) return data;
  const content = data.content;
  if (!isRecord(content) || typeof content.text !== 'string') return data;
  const { text: _text, ...rest } = content;
  return { ...data, content: rest };
}

function rowEvent(item: TimelineItem): RowEvent {
  const event = item.event as TimelineItem['event'] & Partial<Pick<NativeWorkbenchEvent, 'nativeId' | 'nativeTurnId'>>;
  return {
    type: event.type, data: withoutText(item), createdAt: event.createdAt, lastAt: timelineItemTime(item),
    ...(event.runId ? { runId: event.runId } : {}), ...(event.nativeId ? { nativeId: event.nativeId } : {}),
    ...(event.nativeTurnId ? { nativeTurnId: event.nativeTurnId } : {}), sourceIds: nativeSourceIds(event),
  };
}

export interface RowOptions {
  /**
   * Journal identity of the first event folded, for a fold of a lane's tail: run rows before the first
   * event row are placed from it, and turns without an identity of their own are numbered under it so
   * they cannot meet the keys of the rows before. A whole lane is folded from 1.
   */
  base?: number;
}

/** Where a row sits: its `pos` and its turn key. */
export interface RowPlace { pos: number; turn: string }

/**
 * Where each row of a timeline sits, in its order: `pos` grows along it, an event row's comes from its
 * first event's sequence (the journal identity) unless it is filed after a later one, and from the first
 * pending prompt after the last event row on rows sit from {@link PENDING_ROW_POS}. `turn` is the row's
 * `timelineTurnKeys` key.
 */
export function rowPlaces(items: TimelineItem[], options: RowOptions = {}): RowPlace[] {
  const base = options.base ?? 1;
  const turns = timelineTurnKeys(items);
  const lastEvent = items.findLastIndex(item => !isRunRow(item));
  let anchor = base * POS_STEP;
  let slot = 0;
  let pendingFrom = -1;
  return items.map((item, index) => {
    let pos: number;
    const own = item.event.sequence * POS_STEP + EVENT_SLOT;
    if (!isRunRow(item) && own > anchor) {
      pos = anchor = own;
      slot = 0;
    } else if (!isRunRow(item)) {
      // Filed after a later entity (Claude's compaction goes after the `/compact` it logged before): it follows that row.
      pos = anchor + Math.min(++slot, EVENT_SLOT - 1);
    } else if (pendingFrom >= 0 || (index > lastEvent && pendingOf(item))) {
      if (pendingFrom < 0) pendingFrom = index;
      pos = PENDING_ROW_POS + index - pendingFrom;
    } else pos = anchor + Math.min(++slot, EVENT_SLOT - 1);
    const turn = turns[index]!;
    return { pos, turn: base > 1 && /^turn:(?:orphan|\d+)$/.test(turn) ? `turn:${base}:${turn.slice('turn:'.length)}` : turn };
  });
}

/** The row one timeline item is sent as, at its place. */
export function rowContent(item: TimelineItem, { pos, turn }: RowPlace): RowContent {
  const pending = pendingOf(item);
  const runId = item.kind === 'user' ? item.run?.id ?? item.event.runId : item.event.runId;
  const { key, event: _event, kind, run: _run, ...fields } = item as TimelineItem & { run?: unknown };
  const references = item.kind === 'user' ? item.run?.native?.contextSnapshots ?? item.references : undefined;
  return { key, pos, turn, ...(runId ? { runId } : {}), event: rowEvent(item), kind, ...fields, ...(references?.length ? { references } : {}), ...(pending ? { pending } : {}) } as RowContent;
}

export function timelineRows(items: TimelineItem[], options: RowOptions = {}): RowContent[] {
  const places = rowPlaces(items, options);
  return items.map((item, index) => rowContent(item, places[index]!));
}
