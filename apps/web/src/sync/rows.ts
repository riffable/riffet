import { PENDING_ROW_POS, type Run, type TimelineRow, type WorkbenchEvent } from '@contracts';
import type { TimelineItem } from '../../../../packages/timeline/src/model';
import type { ProjectedEvent } from '../../../../packages/timeline/src/projectEvents';
import { POS_STEP } from '../../../../packages/timeline/src/rows';
import { nativeTaskOutcome } from '../../../../packages/timeline/src/failures';

/*
 * Sync v3 rows as the transcript renders them. The server folds a lane into `TimelineRow`s with the
 * same code that built the web's `TimelineItem`s (`packages/timeline`), so this only undoes what the
 * row format left out: the text inside the event's data, the event's own shape, and the Run a prompt
 * row stands for. Items keep their object while their row and Run do, which is what lets the
 * transcript replan only the turns that changed.
 */

type Truncation = NonNullable<TimelineRow['truncated']>;

const KINDS = new Set<string>(['user', 'assistant', 'thought', 'tool', 'plan', 'image', 'status', 'task_notification', 'activity']);
/** Kinds whose text the row carries as `text` rather than in the event's `content`. */
const TEXT_KINDS = new Set<string>(['user', 'assistant', 'thought']);
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const items = new WeakMap<TimelineRow, { sessionId: string; run: Run | undefined; item: TimelineItem }>();
const truncations = new WeakMap<TimelineItem, Truncation>();

/** The event a row was folded from, in the shape the transcript's readers take (`ProjectedEvent`). */
function eventOf(row: TimelineRow, sessionId: string): ProjectedEvent {
  const source = row.event;
  let data = isRecord(source.data) ? source.data : {};
  const text = (row as { text?: unknown }).text;
  if (TEXT_KINDS.has(row.kind) && typeof text === 'string' && isRecord(data.content) && typeof data.content.text !== 'string') {
    data = { ...data, content: { ...data.content, text } };
  }
  const base = {
    // A row's place is its first event's sequence times POS_STEP, so this is that sequence back.
    sequence: Math.floor(row.pos / POS_STEP), sessionId, type: source.type, data, createdAt: source.createdAt,
    ...(source.runId ? { runId: source.runId } : {}), ...(source.nativeId ? { nativeId: source.nativeId } : {}),
    ...(source.nativeTurnId ? { nativeTurnId: source.nativeTurnId } : {}),
  } as WorkbenchEvent;
  // One source event per native id the row was folded from, the last dated by the row's latest change.
  const ids: Array<string | undefined> = Array.isArray(source.sourceIds) && source.sourceIds.length ? source.sourceIds : [undefined];
  const sourceEvents = ids.map((id, index) => ({
    ...base, ...(index === ids.length - 1 && source.lastAt ? { createdAt: source.lastAt } : {}), ...(id ? { nativeId: id } : {}),
  }) as WorkbenchEvent);
  return { ...base, projectionKey: row.key, sourceEvents };
}

/** The item for one row, or nothing for a kind this client does not render. [run] is the Run a prompt row stands for. */
export function timelineItem(row: TimelineRow, sessionId: string, run?: Run, failureShown = false): TimelineItem | undefined {
  if (!KINDS.has(row.kind)) return undefined;
  const held = items.get(row);
  if (held && held.sessionId === sessionId && held.run === run && (held.item.kind !== 'user' || Boolean(held.item.failureShown) === failureShown)) return held.item;
  const { pos: _pos, turn: _turn, seq: _seq, rev: _rev, runId: _runId, event: _event, truncated, pending: _pending, ...fields } = row as TimelineRow & { pending?: unknown; subagent?: unknown };
  const event = held?.sessionId === sessionId ? held.item.event : eventOf(row, sessionId);
  const item = { ...fields, turn: row.turn, event, ...(row.kind === 'user' && run ? { run, ...(failureShown ? { failureShown } : {}) } : {}) } as TimelineItem;
  if (truncated) truncations.set(item, truncated);
  items.set(row, { sessionId, run, item });
  return item;
}

/** The transcript's items for [rows], each prompt row with its Run; [previous] comes back when nothing changed. */
export function timelineItems(rows: readonly TimelineRow[], sessionId: string, runs: readonly Run[], previous?: readonly TimelineItem[]): TimelineItem[] {
  const byId = new Map(runs.map((run) => [run.id, run]));
  // A failure can arrive before or after its Run update, or leave the loaded window. Derive its
  // owner from this frame's rows; neither text matching nor a persisted flag can handle that.
  const failedRuns = new Set<string>();
  const failedTurns = new Set<string>();
  for (const row of rows) {
    if (row.kind !== 'status' || row.event.type !== 'run_failed') continue;
    if (row.runId) failedRuns.add(row.runId);
    if (row.event.runId) failedRuns.add(row.event.runId);
    if (row.event.nativeTurnId) failedTurns.add(row.event.nativeTurnId);
  }
  const next: TimelineItem[] = [];
  for (const row of rows) {
    const run = row.kind === 'user' && row.runId ? byId.get(row.runId) : undefined;
    const outcome = run ? nativeTaskOutcome(run) : undefined;
    const failureShown = Boolean(run && (run.state === 'failed' || run.native?.delivery === 'failed')
      && run.native?.delivery !== 'uncertain' && run.native?.stage !== 'acknowledged' && outcome !== 'unknown'
      && (failedRuns.has(run.id) || outcome === 'failed' && run.native?.nativeTurnId && failedTurns.has(run.native.nativeTurnId)));
    const item = timelineItem(row, sessionId, run, failureShown);
    if (item) next.push(item);
  }
  if (previous && previous.length === next.length && next.every((item, index) => item === previous[index])) return previous as TimelineItem[];
  return next;
}

/** The lane turn the server folded an item into: unlike the item keys, the same for every row of the turn however much of it is loaded. */
export function laneTurnOf(item: TimelineItem): string | undefined {
  return item.turn;
}

/** Where the whole of an item sent cut to a preview is kept, when it was. */
export function truncationOf(item: TimelineItem): Truncation | undefined {
  return truncations.get(item);
}

const outboxRows = new WeakMap<Run, TimelineRow>();

/**
 * [rows] with a row for each send this tab made that the server does not show yet. It is keyed
 * the way the server keys the pending row it will send (`user:<commandId>`), so the server's row
 * takes its place as soon as it arrives instead of standing beside it.
 */
export function withLocalOutbox(rows: readonly TimelineRow[], locals: readonly Run[]): readonly TimelineRow[] {
  if (!locals.length) return rows;
  const keys = new Set<string>();
  const runIds = new Set<string>();
  for (const row of rows) {
    keys.add(row.key);
    if (row.kind === 'user' && row.runId) runIds.add(row.runId);
  }
  const extra: TimelineRow[] = [];
  for (const run of locals) {
    if (keys.has(`user:${run.commandId}`) || runIds.has(run.id)) continue;
    let row = outboxRows.get(run);
    if (!row) {
      const steerTurn = run.native?.intent === 'steer'
        ? run.native.ownerRunId ? `run:${run.native.ownerRunId}`
          : run.native.nativeTurnId ? `native:${run.sessionId}:${run.native.nativeTurnId}`
            : undefined
        : undefined;
      row = {
        key: `user:${run.commandId}`, pos: PENDING_ROW_POS, turn: steerTurn ?? `run:${run.id}`, seq: 0, rev: 0, runId: run.id,
        kind: 'user', text: run.prompt, attachments: run.native?.input.attachmentIds.map((id) => ({ id, name: id })) ?? [],
        pending: run.native?.delivery === 'uncertain' ? 'unconfirmed' : 'queued',
        event: { type: 'user_message_chunk', data: {}, createdAt: run.createdAt, lastAt: run.createdAt, runId: run.id, sourceIds: [] },
      };
      outboxRows.set(run, row);
    }
    extra.push(row);
  }
  return extra.length ? [...rows, ...extra] : rows;
}
