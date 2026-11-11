import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { ModelDailyQuota, ModelStatus, NativeBackendUsage, UsageWindow } from '@contracts';
import { formatNumber } from './i18n/format';

/** A metered window's name, from its length. */
export function windowName(minutes: number | undefined): string {
  if (!minutes) return i18n._(msg`额度`);
  if (minutes === 300) return i18n._(msg`5 小时`);
  if (minutes === 1440) return i18n._(msg`每日`);
  if (minutes === 10080) return i18n._(msg`每周`);
  if (minutes >= 40320 && minutes <= 44640) return i18n._(msg`每月`);
  if (minutes % 60 === 0) { const hours = minutes / 60; return i18n._(msg`${hours} 小时`); }
  return i18n._(msg`${minutes} 分钟`);
}

/** When a window resets: relative within a day, as a date after that. */
export function resetLabel(iso: string | undefined, now = Date.now()): string | undefined {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return undefined;
  const left = at - now;
  if (left <= 0) return i18n._(msg`即将重置`);
  if (left < 3_600_000) { const minutes = Math.max(1, Math.round(left / 60_000)); return i18n._(msg`${minutes} 分钟后重置`); }
  if (left < 86_400_000) { const hours = Math.round(left / 3_600_000); return i18n._(msg`${hours} 小时后重置`); }
  const date = new Date(at);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return i18n._(msg`${month}月${day}日重置`);
}

/** How a load reads: above 100% the provider queues requests, which is what a reader needs to see. */
export function loadTone(percent: number): 'danger' | 'warning' | 'muted' {
  if (percent > 100) return 'danger';
  if (percent >= 80) return 'warning';
  return 'muted';
}

export function loadHint(percent: number): string {
  return percent > 100 ? i18n._(msg`当前负载 ${percent}%，超出容量，请求会排队`) : i18n._(msg`当前负载 ${percent}%`);
}

export function quotaLabel(quota: NonNullable<ModelStatus['quota']>): string {
  if (quota.depleted) return i18n._(msg`额度用尽`);
  if (quota.remaining !== undefined && quota.limit !== undefined) {
    const remaining = quota.remaining;
    const limit = quota.limit;
    return i18n._(msg`余 ${remaining}/${limit}`);
  }
  const left = remainingPercent(quota.usedPercent);
  return i18n._(msg`剩余 ${left}%`);
}

/** Quotas read as what is left, which is what decides whether to keep using a model. */
function remainingPercent(used: number): number {
  return Math.max(0, 100 - used);
}

export function quotaHint(quota: NonNullable<ModelStatus['quota']>, now = Date.now()): string {
  const name = windowName(quota.windowMinutes);
  const leftPercent = remainingPercent(quota.usedPercent);
  const left = i18n._(msg`${name}额度剩余 ${leftPercent}%`);
  const reset = resetLabel(quota.resetsAt, now);
  return reset ? i18n._(msg`${left}，${reset}`) : left;
}

/** Up to two decimals, without a trailing `.0`: 9.5, 9.25, 10. */
export function formatQuotaAmount(value: number): string {
  return formatNumber(value, { maximumFractionDigits: 2 });
}

/** A daily allowance reads separately from the shared weekly quota beside it. */
export function dailyQuotaLabel(quota: ModelDailyQuota): string {
  return i18n._(msg`日余 ${formatQuotaAmount(quota.remaining)}/${formatQuotaAmount(quota.limit)}`);
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
    if (status.dailyQuota.depleted) tags.push({ text: i18n._(msg`低优先级`), hint: i18n._(msg`每日额度用尽，请求仍可用`), tone: 'muted' });
  }
  if (quotaUnavailable(status)) tags.push({ text: i18n._(msg`额度暂不可用`), tone: 'muted' });
  return tags;
}

function windowSummary(window: UsageWindow, now: number): string {
  const name = windowName(window.windowMinutes);
  const left = remainingPercent(window.usedPercent);
  return [i18n._(msg`${name}剩余 ${left}%`), resetLabel(window.resetsAt, now)].filter(Boolean).join(' · ');
}

/** One line for the account: plan, each metered window, then credits. */
export function accountSummary(account: NonNullable<NativeBackendUsage['account']>, now = Date.now()): string {
  const plan = account.plan ? account.plan.replace(/_/g, ' ').replace(/^\w/, letter => letter.toUpperCase()) : undefined;
  let credits: string | undefined;
  if (account.credits?.unlimited) credits = i18n._(msg`credits 不限`);
  else if (account.credits?.balance !== undefined) {
    const balance = formatNumber(Math.floor(account.credits.balance));
    credits = i18n._(msg`credits ${balance}`);
  }
  return [plan, ...account.windows.map(window => windowSummary(window, now)), credits].filter(Boolean).join(' · ');
}
