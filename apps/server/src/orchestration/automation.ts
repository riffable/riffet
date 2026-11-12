import type { Automation, AutomationTrigger, Project } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { nextCronTime, parseCron, validTimeZone, wallClock } from './cron.js';

export const MAX_TRIGGERS = 4;

/** The zone of a server that has none configured; used for migrated schedules and `{{date}}` without a cron trigger. */
export const serverTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** Triggers as a request gives them, checked and in canonical form. `at` must carry an offset: a bare local time would be read in the server's zone. */
export function parseTriggers(value: unknown): AutomationTrigger[] {
  if (!Array.isArray(value) || value.length > MAX_TRIGGERS) throw new AppError('INVALID_INPUT', `triggers must be a list of at most ${MAX_TRIGGERS}`);
  return value.map((item): AutomationTrigger => {
    const raw = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    if (raw.kind === 'once') {
      if (typeof raw.at !== 'string' || !/(Z|[+-]\d{2}:?\d{2})$/i.test(raw.at.trim())) throw new AppError('INVALID_INPUT', 'at must be a date-time with a time zone (Z or ±hh:mm)');
      const at = new Date(raw.at);
      if (!Number.isFinite(at.getTime())) throw new AppError('INVALID_INPUT', 'at is not a valid date-time');
      if (raw.timeZone !== undefined && !validTimeZone(raw.timeZone)) throw new AppError('INVALID_TIME_ZONE', 'timeZone must be an IANA time zone');
      return { kind: 'once', at: at.toISOString(), ...(raw.timeZone !== undefined ? { timeZone: raw.timeZone as string } : {}) };
    }
    if (raw.kind === 'cron') {
      if (typeof raw.cron !== 'string' || raw.cron.length > 200) throw new AppError('INVALID_CRON', 'cron must be a string');
      parseCron(raw.cron);
      if (!validTimeZone(raw.timeZone)) throw new AppError('INVALID_TIME_ZONE', 'timeZone must be an IANA time zone');
      return { kind: 'cron', cron: raw.cron.trim(), timeZone: raw.timeZone };
    }
    throw new AppError('INVALID_INPUT', 'A trigger is once or cron');
  });
}

/**
 * The earliest time any trigger has after `after`. A one-time trigger counts when it is later than
 * `onceFrom` (default `after`): a new one may be a minute late, a settled one must not repeat.
 */
export function nextTime(triggers: readonly AutomationTrigger[], after: Date, onceFrom = after): Date | undefined {
  let best: Date | undefined;
  for (const trigger of triggers) {
    let candidate: Date | undefined;
    if (trigger.kind === 'once') { const at = new Date(trigger.at); candidate = at.getTime() > onceFrom.getTime() ? at : undefined; }
    else { try { candidate = nextCronTime(parseCron(trigger.cron), after, trigger.timeZone); } catch { candidate = undefined; } }
    if (candidate && (!best || candidate < best)) best = candidate;
  }
  return best;
}

/** `{{date}}` (in the zone of the first cron trigger, else of a trigger that names one, else the server's) and `{{project}}`, the only placeholders; anything else is left as written. */
export function renderPrompt(automation: Pick<Automation, 'prompt' | 'triggers'>, project: Project, at = new Date()): string {
  const zone = automation.triggers.find(item => item.kind === 'cron')?.timeZone ?? automation.triggers.find(item => item.timeZone)?.timeZone ?? serverTimeZone();
  const wall = new Date(wallClock(at.getTime(), zone));
  const date = `${wall.getUTCFullYear()}-${String(wall.getUTCMonth() + 1).padStart(2, '0')}-${String(wall.getUTCDate()).padStart(2, '0')}`;
  return automation.prompt.replace(/\{\{\s*date\s*\}\}/g, date).replace(/\{\{\s*project\s*\}\}/g, project.name);
}

/** The first line of a prompt as a name, for records that were not given one. */
export const nameFromPrompt = (prompt: string): string => prompt.trim().split('\n')[0]!.slice(0, 100) || 'Follow-up';

const LATEST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The most recent time at or before `at` that a trigger had, looking back at most a week: what a
 * `catchUp: 'latest'` run stands for after the server was off for days.
 */
export function latestDue(triggers: readonly AutomationTrigger[], at: Date): Date | undefined {
  let best: Date | undefined;
  for (const trigger of triggers) {
    if (trigger.kind !== 'cron') continue;
    let cursor = new Date(at.getTime() - LATEST_WINDOW_MS);
    const cron = parseCron(trigger.cron);
    for (;;) {
      const found = nextCronTime(cron, cursor, trigger.timeZone);
      if (!found || found.getTime() > at.getTime()) break;
      if (!best || found > best) best = found;
      cursor = found;
    }
  }
  return best;
}
