import type { ModelDailyQuota, ModelStatus, NativeBackendUsage, UsageWindow } from '@contracts';
import { formatNumber } from './i18n/format';

/**
 * Usage figures as the model picker shows them. The picker reads in English throughout (model,
 * parameter and provider names are English), so these are not localized.
 */

/** A metered window's name, from its length. */
export function windowName(minutes: number | undefined): string {
  if (!minutes) return 'Quota';
  if (minutes === 300) return '5h';
  if (minutes === 1440) return 'Daily';
  if (minutes === 10080) return 'Weekly';
  if (minutes >= 40320 && minutes <= 44640) return 'Monthly';
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatClock(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** When a window resets: relative within a day, weekday + clock within 6 days, date + clock beyond. */
export function resetLabel(iso: string | undefined, now = Date.now()): string | undefined {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return undefined;
  const left = at - now;
  if (left <= 0) return 'Resets soon';
  const mins = Math.max(1, Math.round(left / 60_000));
  if (mins < 60) return `Resets in ${mins} min`;
  const hrs = Math.round(left / 3_600_000);
  if (hrs < 24) return `Resets in ${hrs} hr`;
  const date = new Date(at);
  if (left < 6 * 86_400_000) return `Resets ${WEEKDAYS[date.getDay()]} ${formatClock(date)}`;
  return `Resets ${date.getMonth() + 1}/${date.getDate()} ${formatClock(date)}`;
}

/** Exact local reset date and clock for hover tooltips. */
function exactResetLabel(iso: string | undefined): string | undefined {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return undefined;
  const date = new Date(at);
  return `Resets ${WEEKDAYS[date.getDay()]} ${date.getMonth() + 1}/${date.getDate()} ${formatClock(date)}`;
}

/** How a load reads: above 100% the provider queues requests, which is what a reader needs to see. */
export function loadTone(percent: number): 'danger' | 'warning' | 'muted' {
  if (percent > 100) return 'danger';
  if (percent >= 80) return 'warning';
  return 'muted';
}

export function loadHint(percent: number): string {
  return percent > 100 ? `Load ${percent}%: over capacity, requests queue` : `Load ${percent}%`;
}

export function quotaLabel(quota: NonNullable<ModelStatus['quota']>): string {
  if (quota.depleted) return 'Quota used up';
  if (quota.remaining !== undefined && quota.limit !== undefined) {
    return `${quota.remaining} of ${quota.limit} left`;
  }
  return `${remainingPercent(quota.usedPercent)}% left`;
}

/** Quotas read as what is left, which is what decides whether to keep using a model. */
function remainingPercent(used: number): number {
  return Math.max(0, 100 - used);
}

export function quotaHint(quota: NonNullable<ModelStatus['quota']>, now = Date.now()): string {
  const name = windowName(quota.windowMinutes);
  const leftPercent = remainingPercent(quota.usedPercent);
  const left = `${name}: ${leftPercent}% left`;
  const reset = resetLabel(quota.resetsAt, now);
  return reset ? `${left} · ${reset}` : left;
}

/** Up to two decimals, without a trailing `.0`: 9.5, 9.25, 10. */
export function formatQuotaAmount(value: number): string {
  return formatNumber(value, { maximumFractionDigits: 2 });
}

/** A daily allowance reads separately from the shared weekly quota beside it. */
export function dailyQuotaLabel(quota: ModelDailyQuota): string {
  return `Daily ${formatQuotaAmount(quota.remaining)}/${formatQuotaAmount(quota.limit)} left`;
}

export function dailyQuotaHint(quota: ModelDailyQuota, now = Date.now()): string {
  return quotaHint(quota, now);
}

/** Why a model has no quota figure: the provider meters it but its snapshot did not arrive. */
export function quotaUnavailable(status: ModelStatus): boolean {
  return (status.quotaLimited === true && !status.quota) || (Boolean(status.dailyQuotaKey) && !status.dailyQuota);
}

export interface QuotaTag { text: string; hint?: string; tone: 'danger' | 'warning' | 'muted'; }

/** The short figures a model row shows: weekly quota, daily quota, low priority, then availability. */
export function statusQuotaTags(status: ModelStatus, now = Date.now()): QuotaTag[] {
  const tags: QuotaTag[] = [];
  if (status.quota) tags.push({ text: quotaLabel(status.quota), hint: quotaHint(status.quota, now), tone: status.quota.depleted ? 'danger' : 'muted' });
  if (status.dailyQuota) {
    tags.push({ text: dailyQuotaLabel(status.dailyQuota), hint: dailyQuotaHint(status.dailyQuota, now), tone: 'muted' });
    if (status.dailyQuota.depleted) tags.push({ text: 'Low priority', hint: 'Daily quota used up; requests still go through', tone: 'muted' });
  }
  if (quotaUnavailable(status)) tags.push({ text: 'Quota unavailable', tone: 'muted' });
  return tags;
}

function windowSummary(window: UsageWindow): string {
  const name = windowName(window.windowMinutes);
  const left = remainingPercent(window.usedPercent);
  return [`${name}: ${left}% left`, exactResetLabel(window.resetsAt)].filter(Boolean).join(' · ');
}

/** Below this share left a window is highlighted as warning. */
const LOW_REMAINING = 20;

export interface AccountFigure {
  kind: 'window' | 'credit' | 'limit';
  name?: string;
  value: string;
  tone: 'danger' | 'warning' | 'muted';
  reset?: string;
  hint?: string;
}

/**
 * The account quota entries: every metered window shows what is left and when it resets. Credits
 * are shown only as a fallback when no metered window is reported (pure credit-based accounts),
 * since subscription credits alongside timed windows carry little actionable signal.
 */
export function accountFigures(account: NonNullable<NativeBackendUsage['account']>, now = Date.now()): AccountFigure[] {
  const figures: AccountFigure[] = account.windows.map((window) => {
    const left = remainingPercent(window.usedPercent);
    const tone = left <= 0 ? 'danger' : left < LOW_REMAINING ? 'warning' : 'muted';
    return {
      kind: 'window',
      name: windowName(window.windowMinutes),
      value: `${left}%`,
      tone,
      reset: resetLabel(window.resetsAt, now),
      hint: windowSummary(window),
    };
  });
  if (account.windows.length === 0 && !account.limitReached) {
    if (account.credits?.unlimited) figures.push({ kind: 'credit', value: 'Unlimited credits', tone: 'muted' });
    else if (account.credits?.balance !== undefined) figures.push({ kind: 'credit', value: `${formatNumber(Math.floor(account.credits.balance))} credits`, tone: 'muted' });
  }
  // A provider can stop the account without any window reading full.
  if (account.limitReached && !figures.some((figure) => figure.tone === 'danger')) figures.push({ kind: 'limit', value: 'Limit reached', tone: 'danger' });
  return figures;
}
