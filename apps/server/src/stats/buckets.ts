import type { StatsGranularity } from '../../../../packages/contracts/src/index.js';

/**
 * Calendar buckets cut in an IANA zone. SQLite knows nothing about zones, so bucket edges are
 * computed here with `Intl` and rows are assigned to them in JS; that is what keeps the day of a
 * daylight-saving change 23 or 25 hours long instead of a fixed 24.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** More buckets than any chart can show; a request that would exceed it is coarsened instead. */
export const MAX_BUCKETS = 1_500;

const WEEKDAYS: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

/** The zone itself when `Intl` accepts it, otherwise UTC. */
export function validZone(zone: unknown): string {
  if (typeof zone !== 'string' || !zone || zone.length > 100) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return 'UTC';
  }
}

function formatter(zone: string): Intl.DateTimeFormat {
  let value = formatters.get(zone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(zone, value);
  }
  return value;
}

/** Wall-clock fields of an instant in a zone. `month` is 1-based, `weekday` 0 = Monday. */
export interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number; }

export function localParts(at: number, zone: string): LocalParts {
  const fields: Record<string, string> = {};
  for (const part of formatter(zone).formatToParts(at)) fields[part.type] = part.value;
  return {
    year: Number(fields.year), month: Number(fields.month), day: Number(fields.day),
    hour: Number(fields.hour) % 24, minute: Number(fields.minute), second: Number(fields.second),
    weekday: WEEKDAYS[fields.weekday ?? 'Mon'] ?? 0,
  };
}

/** Zone offset at an instant, in milliseconds east of UTC. */
function offsetAt(at: number, zone: string): number {
  const p = localParts(at, zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
}

/**
 * The instant a wall-clock time names in a zone. Fields may overflow (`day = 32`) and roll over
 * the way `Date.UTC` does. The second pass corrects a guess that landed across an offset change.
 */
export function fromLocal(zone: string, year: number, month: number, day: number, hour = 0): number {
  const wall = Date.UTC(year, month - 1, day, hour);
  const guess = wall - offsetAt(wall, zone);
  return wall - offsetAt(guess, zone);
}

/** `YYYY-MM-DD` of the instant in the zone. */
export function localDate(at: number, zone: string): string {
  const p = localParts(at, zone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** The calendar day before a `YYYY-MM-DD` date. Pure date arithmetic; no zone is involved. */
export function previousDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! - 1)).toISOString().slice(0, 10);
}

export function bucketStart(at: number, zone: string, granularity: StatsGranularity): number {
  // Hours are cut on the absolute timeline at the zone's offset: that stays aligned to local hour
  // starts across a whole-hour offset change, and a repeated wall-clock hour is not merged.
  if (granularity === 'hour') {
    const offset = offsetAt(at, zone);
    return at - ((((at + offset) % HOUR) + HOUR) % HOUR);
  }
  const p = localParts(at, zone);
  switch (granularity) {
    case 'day': return fromLocal(zone, p.year, p.month, p.day);
    case 'week': return fromLocal(zone, p.year, p.month, p.day - p.weekday);
    case 'month': return fromLocal(zone, p.year, p.month, 1);
  }
}

export function nextBucket(start: number, zone: string, granularity: StatsGranularity): number {
  if (granularity === 'hour') return start + HOUR;
  // Noon of the bucket's first day is safely inside it whatever the offset change was.
  const p = localParts(start + 12 * HOUR, zone);
  switch (granularity) {
    case 'day': return fromLocal(zone, p.year, p.month, p.day + 1);
    case 'week': return fromLocal(zone, p.year, p.month, p.day + 7);
    case 'month': return fromLocal(zone, p.year, p.month + 1, 1);
  }
}

/** Bucket starts covering `[from, to)`; the first one is the bucket containing `from`. */
export function bucketEdges(from: number, to: number, zone: string, granularity: StatsGranularity): number[] {
  const edges: number[] = [];
  let start = bucketStart(from, zone, granularity);
  while (start < to && edges.length <= MAX_BUCKETS * 4) {
    edges.push(start);
    const next = nextBucket(start, zone, granularity);
    if (next <= start) break;
    start = next;
  }
  return edges;
}

/** Index of the bucket containing `at`, or -1 when it falls before the first edge. */
export function bucketIndex(edges: readonly number[], at: number): number {
  let low = 0;
  let high = edges.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (edges[middle]! <= at) { found = middle; low = middle + 1; } else high = middle - 1;
  }
  return found;
}

const ORDER: StatsGranularity[] = ['hour', 'day', 'week', 'month'];

/** The default granularity for a window length. */
export function autoGranularity(from: number, to: number): StatsGranularity {
  const span = to - from;
  if (span <= 2 * DAY) return 'hour';
  if (span <= 92 * DAY) return 'day';
  if (span <= 400 * DAY) return 'week';
  return 'month';
}

/** The requested granularity, or the next coarser one that keeps the bucket count drawable. */
export function boundedGranularity(from: number, to: number, granularity: StatsGranularity): StatsGranularity {
  const approximate: Record<StatsGranularity, number> = { hour: HOUR, day: DAY, week: 7 * DAY, month: 30 * DAY };
  for (let index = ORDER.indexOf(granularity); index < ORDER.length; index += 1) {
    const candidate = ORDER[index]!;
    if ((to - from) / approximate[candidate] <= MAX_BUCKETS) return candidate;
  }
  return 'month';
}
