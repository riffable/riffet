import { AppError } from '../errors.js';

/**
 * A five-field cron expression (minute hour day-of-month month day-of-week) in the server's local
 * time, plus the common `@hourly`/`@daily`/`@weekly`/`@monthly` shorthands. Each field takes `*`,
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

function dayMatches(cron: Cron, date: Date): boolean {
  const day = cron.days.has(date.getDate()), weekday = cron.weekdays.has(date.getDay());
  // Vixie marks a leading wildcard even when it has a step, so `*/2` still constrains
  // the other day field instead of turning it into an extra set of execution days.
  if (cron.anyDay || cron.anyWeekday) return day && weekday;
  return day || weekday;
}

/** The first matching minute strictly after [after], or undefined when none falls within about four years. */
export function nextCronTime(cron: Cron, after: Date): Date | undefined {
  const date = new Date(after.getTime());
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);
  const limit = after.getTime() + 4 * 366 * 24 * 60 * 60 * 1000;
  while (date.getTime() <= limit) {
    if (!cron.months.has(date.getMonth() + 1)) { date.setMonth(date.getMonth() + 1, 1); date.setHours(0, 0, 0, 0); continue; }
    if (!dayMatches(cron, date)) { date.setDate(date.getDate() + 1); date.setHours(0, 0, 0, 0); continue; }
    if (!cron.hours.has(date.getHours())) { date.setHours(date.getHours() + 1, 0, 0, 0); continue; }
    if (!cron.minutes.has(date.getMinutes())) { date.setMinutes(date.getMinutes() + 1, 0, 0); continue; }
    return date;
  }
  return undefined;
}
