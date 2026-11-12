import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { Automation, AutomationTrigger } from '@contracts';
import { formatDateTime } from '@/lib/utils';
import { formatTime } from '@/lib/i18n/format';

const ALIASES: Record<string, MessageDescriptor> = { '@hourly': msg`每小时`, '@daily': msg`每天 0:00`, '@midnight': msg`每天 0:00`, '@weekly': msg`每周日 0:00`, '@monthly': msg`每月 1 日 0:00` };

/**
 * Reads the common shapes back as words — a fixed time on every day, workdays or one weekday, and
 * the hourly ones. Anything else stays the expression itself: a wrong paraphrase of a schedule is
 * worse than showing what will actually run.
 */
export function describeCron(cron: string): string {
  const text = cron.trim();
  const alias = ALIASES[text];
  if (alias) return i18n._(alias);
  const parts = text.split(/\s+/);
  if (parts.length !== 5) return text;
  const [minute, hour, day, month, weekday] = parts as [string, string, string, string, string];
  if (!/^\d+$/.test(minute) || day !== '*' || month !== '*') return text;
  if (hour === '*') return weekday === '*' ? (minute === '0' ? i18n._(msg`每小时`) : i18n._(msg`每小时第 ${minute} 分`)) : text;
  if (!/^\d+$/.test(hour)) return text;
  const time = `${hour}:${minute.padStart(2, '0')}`;
  if (weekday === '*') return i18n._(msg`每天 ${time}`);
  if (weekday === '1-5') return i18n._(msg`每个工作日 ${time}`);
  if (weekday === '0,6' || weekday === '6,0') return i18n._(msg`周末 ${time}`);
  if (/^[0-7]$/.test(weekday)) {
    const weekly = [
      msg`每周日 ${time}`,
      msg`每周一 ${time}`,
      msg`每周二 ${time}`,
      msg`每周三 ${time}`,
      msg`每周四 ${time}`,
      msg`每周五 ${time}`,
      msg`每周六 ${time}`,
    ];
    return i18n._(weekly[Number(weekday) % 7]);
  }
  return text;
}

export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The recurring presets the quick bar and the editor offer. */
export const CRON_PRESETS = ['0 9 * * 1-5', '0 9 * * *', '0 9 * * 1'] as const;
/** One-time presets: minutes from now, or the next 9:00 tomorrow. */
export type OncePreset = '10m' | '1h' | 'tomorrow';
export const ONCE_PRESETS: readonly OncePreset[] = ['10m', '1h', 'tomorrow'];

export function onceDate(preset: OncePreset, now = new Date()): Date {
  if (preset === '10m') return new Date(now.getTime() + 10 * 60_000);
  if (preset === '1h') return new Date(now.getTime() + 60 * 60_000);
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(9, 0, 0, 0);
  return next;
}

export const onceLabel = (preset: OncePreset): string =>
  i18n._(preset === '10m' ? msg`10 分钟后` : preset === '1h' ? msg`1 小时后` : msg`明天 9:00`);

export const onceTrigger = (at: Date): AutomationTrigger => ({ kind: 'once', at: at.toISOString(), timeZone: localTimeZone() });
export const cronTrigger = (cron: string, timeZone = localTimeZone()): AutomationTrigger => ({ kind: 'cron', cron, timeZone });

/** `datetime-local` wants the reader's wall clock without a zone. */
export function toLocalInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Today 14:30 / tomorrow 09:00 / the date. */
export function formatWhen(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const time = formatTime(iso);
  const day = (offset: number) => { const next = new Date(now); next.setDate(next.getDate() + offset); return next.toDateString(); };
  if (date.toDateString() === day(0)) return i18n._(msg`今天 ${time}`);
  if (date.toDateString() === day(1)) return i18n._(msg`明天 ${time}`);
  return formatDateTime(iso);
}

function zoneAbbreviation(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(i18n.locale, { timeZone, timeZoneName: 'short' }).formatToParts(new Date()).find((part) => part.type === 'timeZoneName')?.value ?? timeZone;
  } catch { return timeZone; }
}

/** What a trigger does, with its zone named only when it is not the reader's own. */
export function describeTrigger(trigger: AutomationTrigger): string {
  if (trigger.kind === 'once') return i18n._(msg`一次`);
  const text = describeCron(trigger.cron);
  return trigger.timeZone && trigger.timeZone !== localTimeZone() ? `${text} (${zoneAbbreviation(trigger.timeZone)})` : text;
}

/** The next time of the shapes the presets use, in the reader's own zone; anything else is left to the server. */
export function nextCronRun(cron: string, now = new Date()): Date | undefined {
  const match = /^(\d+) (\d+) \* \* (\*|[0-7]|1-5|0,6|6,0)$/.exec(cron.trim());
  if (!match) return undefined;
  const [, minute, hour, weekday] = match as unknown as [string, string, string, string];
  const allowed = (day: number) => weekday === '*' || (weekday === '1-5' ? day >= 1 && day <= 5 : weekday === '0,6' || weekday === '6,0' ? day === 0 || day === 6 : day === Number(weekday) % 7);
  for (let offset = 0; offset < 8; offset++) {
    const candidate = new Date(now);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(Number(hour), Number(minute), 0, 0);
    if (candidate > now && allowed(candidate.getDay())) return candidate;
  }
  return undefined;
}

export function triggerNextRun(trigger: AutomationTrigger | undefined): Date | undefined {
  if (!trigger) return undefined;
  if (trigger.kind === 'once') { const at = new Date(trigger.at); return at > new Date() ? at : undefined; }
  return trigger.timeZone === localTimeZone() ? nextCronRun(trigger.cron) : undefined;
}

/** A name from the first line of a prompt. */
export function nameFromPrompt(prompt: string, limit = 40): string {
  const line = prompt.trim().split('\n')[0]?.trim() ?? '';
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

export type AutomationKind = 'upcoming' | 'manual' | 'paused';

/** Which list an automation belongs in. */
export function automationKind(item: Automation): AutomationKind {
  if (!item.triggers.length) return 'manual';
  if (item.enabled && item.nextRunAt) return 'upcoming';
  return 'paused';
}
