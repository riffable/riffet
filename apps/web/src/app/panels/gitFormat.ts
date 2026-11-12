/** The Git panel reads in English in every locale, its dates and ages included. */
const ages = new Intl.RelativeTimeFormat('en', { style: 'narrow', numeric: 'auto' });
const dates = new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** 6m ago, 3h ago, yesterday; under a minute is now. A month is 30 days. */
export function gitTimeAgo(value: string): string {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return '';
  const minutes = Math.floor(Math.max(0, Date.now() - time) / 60_000);
  if (minutes < 1) return ages.format(0, 'second');
  if (minutes < 60) return ages.format(-minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return ages.format(-hours, 'hour');
  const days = Math.floor(hours / 24);
  if (days < 30) return ages.format(-days, 'day');
  const months = Math.floor(days / 30);
  return months < 12 ? ages.format(-months, 'month') : ages.format(-Math.floor(months / 12), 'year');
}

export function gitDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dates.format(date);
}
