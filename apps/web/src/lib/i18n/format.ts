/**
 * Numbers, dates and ages in the active locale. Everything the UI formats goes through here, so a
 * language switch reaches them too.
 *
 * This module imports nothing on purpose. `lib/utils.ts` re-exports the time helpers, and the server
 * and the fixture generator load `utils.ts` through the shared transcript modules; an import of
 * Lingui here would become a runtime dependency of the server. `lib/i18n` binds the locale and the
 * age wording each time it activates a catalog.
 */

export type AgeUnit = 'minute' | 'hour' | 'day' | 'month' | 'year';

/** The age wording, from the active catalog. */
export interface AgePhrases {
  justNow: () => string;
  /** A bare age, as a list shows it: 5 分钟. */
  age: (unit: AgeUnit, count: number) => string;
  /** A past moment: 5 分钟前. */
  ago: (unit: AgeUnit, count: number) => string;
}

// The source locale's tag until `lib/i18n` binds one, so a test or script still formats as the UI did.
let intl = 'zh-CN';
/*
 * The source catalog's wording, so `relativeTime` and `timeAgo` also work before any catalog is
 * bound (a script or a test). `lib/i18n` replaces these on every activation.
 */
const sourceUnits: Record<AgeUnit, string> = {
  minute: '分钟', hour: '小时', day: '天', month: '个月', year: '年', // i18n-ignore: the source catalog's wording, not interface text authored here
};
let phrases: AgePhrases = {
  justNow: () => '刚刚', // i18n-ignore: the source catalog's wording, not interface text authored here
  age: (unit, count) => `${count} ${sourceUnits[unit]}`,
  ago: (unit, count) => `${count} ${sourceUnits[unit]}前`, // i18n-ignore: the source catalog's wording
};

/** Called by `lib/i18n` on every activation. */
export function bindFormatLocale(tag: string, wording: AgePhrases): void {
  intl = tag;
  phrases = wording;
}

const formats = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat | Intl.Collator>();

/** Constructing an `Intl` formatter is the expensive part, and lists format hundreds of values. */
function cached<T extends Intl.NumberFormat | Intl.DateTimeFormat | Intl.Collator>(kind: string, options: object | undefined, create: () => T): T {
  const key = `${kind}\u0000${intl}\u0000${JSON.stringify(options ?? {})}`;
  let format = formats.get(key) as T | undefined;
  if (!format) formats.set(key, (format = create()));
  return format;
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return cached('number', options, () => new Intl.NumberFormat(intl, options)).format(value);
}

/** An unreadable value reads as `Invalid Date`, as `toLocaleString` has it, rather than throwing mid-render. */
export function formatDate(value: string | number | Date, options: Intl.DateTimeFormatOptions): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(date);
  return cached('date', options, () => new Intl.DateTimeFormat(intl, options)).format(date);
}

/** Sort order for names shown to the reader. */
export function compareText(a: string, b: string, options?: Intl.CollatorOptions): number {
  return cached('collator', options, () => new Intl.Collator(intl, options)).compare(a, b);
}

export function formatClock(value: string): string {
  return formatDate(value, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** A time without seconds, for a line that already says the date. */
export function formatTime(value: string): string {
  return formatDate(value, { hour: '2-digit', minute: '2-digit' });
}

export function formatDateTime(value: string): string {
  return formatDate(value, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function wording(): AgePhrases {
  return phrases;
}

/** Whole units, rounded down: a month is 30 days. Under a minute is now. */
function ageOf(value: string | undefined): { unit: AgeUnit; count: number } | 'now' | undefined {
  if (!value) return undefined;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return undefined;
  const minutes = Math.floor(Math.max(0, Date.now() - time) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return { unit: 'minute', count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: 'hour', count: hours };
  const days = Math.floor(hours / 24);
  if (days < 30) return { unit: 'day', count: days };
  const months = Math.floor(days / 30);
  if (months < 12) return { unit: 'month', count: months };
  return { unit: 'year', count: Math.floor(months / 12) };
}

/** How long ago, as a bare age: 5 分钟, or 刚刚. */
export function relativeTime(value: string | undefined): string {
  const age = ageOf(value);
  if (!age) return '';
  return age === 'now' ? wording().justNow() : wording().age(age.unit, age.count);
}

/** Whether the age reads as "just now". Callers must not compare the localized wording. */
export function isJustNow(value: string | undefined): boolean {
  return ageOf(value) === 'now';
}

/** A past moment: 5 分钟前, or 刚刚. */
export function timeAgo(value: string | undefined): string {
  const age = ageOf(value);
  if (!age) return '';
  return age === 'now' ? wording().justNow() : wording().ago(age.unit, age.count);
}
