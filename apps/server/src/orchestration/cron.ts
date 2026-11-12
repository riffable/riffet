import { AppError } from '../errors.js';

/**
 * A five-field cron expression (minute hour day-of-month month day-of-week) read in an IANA time
 * zone (the zone of whoever set it, not the server's), plus the common `@hourly`/`@daily`/`@weekly`/`@monthly` shorthands. Each field takes `*`,
 * numbers, ranges, lists and `/step`. As in Vixie cron, when both day fields are restricted a day
 * matching either one runs. Written here rather than added as a dependency: this is all a local
 * scheduler needs, and the parser is smaller than any package that offers it.
 */
export interface Cron { minutes: Set<number>; hours: Set<number>; days: Set<number>; months: Set<number>; weekdays: Set<number>; anyDay: boolean; anyWeekday: boolean; }

const ALIASES: Record<string, string> = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *' };

function field(text: string, min: number, max: number, name: string): Set<number> {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new AppError('INVALID_CRON', `Cron ${name} field is invalid: ${part}`);
    const step = match[4] === undefined ? 1 : Number(match[4]);
    const from = match[1] === '*' ? min : Number(match[2]);
    const to = match[1] === '*' ? max : match[3] !== undefined ? Number(match[3]) : match[4] !== undefined ? max : from;
    if (!step || from < min || to > max || from > to) throw new AppError('INVALID_CRON', `Cron ${name} field is out of range: ${part}`);
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

export function parseCron(expression: string): Cron {
  const trimmed = expression.trim();
  const text = Object.hasOwn(ALIASES, trimmed) ? ALIASES[trimmed] : trimmed;
  const parts = text.split(/\s+/);
  if (parts.length !== 5) throw new AppError('INVALID_CRON', 'Cron needs five fields: minute hour day month weekday');
  const weekdays = field(parts[4], 0, 7, 'weekday');
  if (weekdays.delete(7)) weekdays.add(0);
  return {
    minutes: field(parts[0], 0, 59, 'minute'), hours: field(parts[1], 0, 23, 'hour'),
    days: field(parts[2], 1, 31, 'day'), months: field(parts[3], 1, 12, 'month'), weekdays,
    anyDay: parts[2].startsWith('*'), anyWeekday: parts[4].startsWith('*'),
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let item = formatters.get(timeZone);
  if (!item) {
    try { item = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }); }
    catch { throw new AppError('INVALID_TIME_ZONE', `Unknown time zone: ${timeZone}`); }
    formatters.set(timeZone, item);
  }
  return item;
}

export function validTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 100) return false;
  try { formatter(timeZone); return true; } catch { return false; }
}

/** The wall clock of `instant` in `timeZone`, as the same fields read in UTC: a calendar the zone's offsets cannot disturb. */
export function wallClock(instant: number, timeZone: string): number {
  const fields: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(instant)) if (part.type !== 'literal') fields[part.type] = Number(part.value);
  return Date.UTC(fields.year!, fields.month! - 1, fields.day!, fields.hour! === 24 ? 0 : fields.hour!, fields.minute!, fields.second!);
}

const offsetAt = (instant: number, timeZone: string) => wallClock(instant, timeZone) - Math.floor(instant / 1000) * 1000;

/**
 * The earliest instant whose wall clock in `timeZone` reads `wall`. A time the zone skips (the
 * spring-forward hour) has none, and one it repeats (the fall-back hour) is its first occurrence.
 */
function instantOf(wall: number, timeZone: string): number | undefined {
  const found: number[] = [];
  for (const offset of new Set([offsetAt(wall - 86_400_000, timeZone), offsetAt(wall + 86_400_000, timeZone)])) {
    const instant = wall - offset;
    if (wallClock(instant, timeZone) === wall) found.push(instant);
  }
  return found.length ? Math.min(...found) : undefined;
}

function dayMatches(cron: Cron, date: Date): boolean {
  const day = cron.days.has(date.getUTCDate()), weekday = cron.weekdays.has(date.getUTCDay());
  // Vixie marks a leading wildcard even when it has a step, so `*/2` still constrains
  // the other day field instead of turning it into an extra set of execution days.
  if (cron.anyDay || cron.anyWeekday) return day && weekday;
  return day || weekday;
}

/**
 * The first matching minute strictly after [after] in [timeZone], or undefined when none falls
 * within about four years. The search walks the zone's wall clock with field-level skips, then maps
 * each candidate back to an instant, so a skipped DST time never matches and a repeated one runs once.
 */
export function nextCronTime(cron: Cron, after: Date, timeZone: string): Date | undefined {
  const date = new Date(Math.floor(wallClock(after.getTime(), timeZone) / 60_000) * 60_000 + 60_000);
  const limit = date.getTime() + 4 * 366 * 24 * 60 * 60 * 1000;
  while (date.getTime() <= limit) {
    if (!cron.months.has(date.getUTCMonth() + 1)) { date.setUTCMonth(date.getUTCMonth() + 1, 1); date.setUTCHours(0, 0, 0, 0); continue; }
    if (!dayMatches(cron, date)) { date.setUTCDate(date.getUTCDate() + 1); date.setUTCHours(0, 0, 0, 0); continue; }
    if (!cron.hours.has(date.getUTCHours())) { date.setUTCHours(date.getUTCHours() + 1, 0, 0, 0); continue; }
    if (!cron.minutes.has(date.getUTCMinutes())) { date.setUTCMinutes(date.getUTCMinutes() + 1, 0, 0); continue; }
    const instant = instantOf(date.getTime(), timeZone);
    if (instant !== undefined && instant > after.getTime()) return new Date(instant);
    date.setUTCMinutes(date.getUTCMinutes() + 1, 0, 0);
  }
  return undefined;
}
