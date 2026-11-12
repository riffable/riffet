import type { ModelDailyQuota, ModelStatus, NativeBackendUsage, UsageWindow } from '@contracts';
import { formatNumber } from './i18n/format';

/**
 * Usage figures as the model picker shows them. The picker reads in English throughout (model,
 * parameter and provider names are English), so these are not localized.
 */

/** A metered window's name, from its length. */
export function windowName(minutes: number | undefined): string {
  if (!minutes) return 'Quota';
  if (minutes === 300) return '5 hours';
  if (minutes === 1440) return 'Daily';
  if (minutes === 10080) return 'Weekly';
  if (minutes >= 40320 && minutes <= 44640) return 'Monthly';
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** When a window resets: relative within a day, as a date after that. */
export function resetLabel(iso: string | undefined, now = Date.now()): string | undefined {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return undefined;
  const left = at - now;
  if (left <= 0) return 'Resets soon';
  if (left < 3_600_000) return `Resets in ${Math.max(1, Math.round(left / 60_000))} min`;
  if (left < 86_400_000) return `Resets in ${Math.round(left / 3_600_000)} hr`;
  const date = new Date(at);
  return `Resets on ${date.getMonth() + 1}/${date.getDate()}`;
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

function windowSummary(window: UsageWindow, now: number): string {
  const name = windowName(window.windowMinutes);
  const left = remainingPercent(window.usedPercent);
  return [`${name}: ${left}% left`, resetLabel(window.resetsAt, now)].filter(Boolean).join(' · ');
}

/** One line for the account: plan, each metered window, then credits. */
export function accountSummary(account: NonNullable<NativeBackendUsage['account']>, now = Date.now()): string {
  const plan = account.plan ? account.plan.replace(/_/g, ' ').replace(/^\w/, letter => letter.toUpperCase()) : undefined;
  let credits: string | undefined;
  if (account.credits?.unlimited) credits = 'Unlimited credits';
  else if (account.credits?.balance !== undefined) {
    credits = `${formatNumber(Math.floor(account.credits.balance))} credits`;
  }
  return [plan, ...account.windows.map(window => windowSummary(window, now)), credits].filter(Boolean).join(' · ');
}
