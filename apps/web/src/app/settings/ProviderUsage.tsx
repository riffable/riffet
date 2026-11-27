import { useCallback, useEffect, useRef, useState } from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { NativeBackendId, NativeBackendUsage, UsageWindow } from '@contracts';
import { IconRefreshCw } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/controls';
import { Progress, type ProgressTone } from '@/components/ui/progress';
import { Tip } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { providerUsageScope, readLiveUsage, useUsageRevision, writeLiveUsage } from '@/lib/catalog-cache';
import { formatDate, formatDateTime, formatNumber, formatTime, isJustNow, timeAgo } from '@/lib/i18n/format';
import { formatQuotaAmount } from '@/lib/usage';
import { cleanLabel, cn, errorMessage } from '@/lib/utils';

export function remainingPercent(usedPercent: number): number {
  return Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
}

export function quotaTone(leftPercent: number): ProgressTone {
  return leftPercent <= 0 ? 'danger' : leftPercent < 20 ? 'warning' : 'accent';
}

export function quotaTextClass(leftPercent: number): string {
  return leftPercent <= 0 ? 'text-danger' : leftPercent < 20 ? 'text-warning' : 'text-fg-2';
}

export function windowLabel(minutes: number | undefined): string {
  if (!minutes || minutes <= 0) return i18n._(msg`额度`);
  if (minutes === 1440) return i18n._(msg`每日`);
  if (minutes === 10080) return i18n._(msg`每周`);
  if (minutes >= 40320 && minutes <= 44640) return i18n._(msg`每月`);
  if (minutes % 60 === 0) return i18n._(msg`${minutes / 60} 小时`);
  return i18n._(msg`${minutes} 分钟`);
}

/** Localised reset timestamp: clock only when today, weekday + clock within a week, date + clock beyond. */
export function formatResetLabel(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return undefined;
  const now = Date.now();
  if (at <= now) return i18n._(msg`即将重置`);
  const target = new Date(at);
  const today = new Date(now);
  const sameDay = target.getFullYear() === today.getFullYear()
    && target.getMonth() === today.getMonth()
    && target.getDate() === today.getDate();
  if (sameDay) {
    const clock = formatTime(iso);
    return i18n._(msg`${clock} 重置`);
  }
  if (at - now < 6 * 86_400_000) {
    const weekday = formatDate(iso, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    return i18n._(msg`${weekday} 重置`);
  }
  const date = formatDateTime(iso);
  return i18n._(msg`${date} 重置`);
}

export function formatFetchedLabel(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return undefined;
  if (isJustNow(iso)) return i18n._(msg`刚刚读取`);
  const age = timeAgo(iso);
  return age ? i18n._(msg`${age}读取`) : undefined;
}

export interface UsageSummary {
  text: string;
  tone: 'danger' | 'warning' | 'muted';
}

/** Most constrained window's remaining share for a collapsed provider row (plugins.md §6.3.1). */
export function summarizeUsage(usage: NativeBackendUsage | undefined): UsageSummary | undefined {
  if (!usage) return undefined;
  const account = usage.account;
  const windows = account?.windows ?? [];
  if (windows.length > 0) {
    const lowest = Math.min(...windows.map((w) => remainingPercent(w.usedPercent)));
    if (lowest <= 0 || account?.limitReached) return { text: i18n._(msg`已用尽`), tone: 'danger' };
    const remaining = formatNumber(lowest);
    if (lowest < 20) return { text: i18n._(msg`剩余 ${remaining}%`), tone: 'warning' };
    return { text: i18n._(msg`剩余 ${remaining}%`), tone: 'muted' };
  }
  if (account?.limitReached) return { text: i18n._(msg`已用尽`), tone: 'danger' };
  if (account?.credits?.unlimited) return { text: i18n._(msg`不限额`), tone: 'muted' };
  if (account?.credits?.balance !== undefined) return { text: formatNumber(account.credits.balance), tone: 'muted' };
  const modelLefts: number[] = [];
  for (const status of Object.values(usage.models)) {
    if (status.quota) modelLefts.push(status.quota.depleted ? 0 : remainingPercent(status.quota.usedPercent));
    if (status.dailyQuota) modelLefts.push(status.dailyQuota.depleted ? 0 : remainingPercent(status.dailyQuota.usedPercent));
  }
  if (modelLefts.length > 0) {
    const lowest = Math.min(...modelLefts);
    if (lowest <= 0) return { text: i18n._(msg`已用尽`), tone: 'danger' };
    const remaining = formatNumber(lowest);
    if (lowest < 20) return { text: i18n._(msg`剩余 ${remaining}%`), tone: 'warning' };
    return { text: i18n._(msg`剩余 ${remaining}%`), tone: 'muted' };
  }
  return { text: '—', tone: 'muted' };
}

export interface ModelQuotaEntry {
  id: string;
  label: string;
  usedPercent: number;
  leftPercent: number;
  figure?: string;
  resetsAt?: string;
}

/** Per-model dedicated quotas, ordered from most constrained to least constrained. */
export function dedicatedModelQuotas(usage: NativeBackendUsage): ModelQuotaEntry[] {
  const entries: ModelQuotaEntry[] = [];
  for (const [id, status] of Object.entries(usage.models)) {
    const name = cleanLabel(id);
    if (status.quota) {
      const left = status.quota.depleted ? 0 : remainingPercent(status.quota.usedPercent);
      const figure = status.quota.depleted
        ? i18n._(msg`已用尽`)
        : status.quota.remaining !== undefined && status.quota.limit !== undefined
          ? i18n._(msg`剩余 ${formatNumber(status.quota.remaining)} / ${formatNumber(status.quota.limit)}`)
          : undefined;
      entries.push({ id: `${id}:quota`, label: name, usedPercent: status.quota.depleted ? 100 : status.quota.usedPercent, leftPercent: left, figure, resetsAt: status.quota.resetsAt });
    }
    if (status.dailyQuota) {
      const left = status.dailyQuota.depleted ? 0 : remainingPercent(status.dailyQuota.usedPercent);
      entries.push({
        id: `${id}:daily`,
        label: i18n._(msg`${name} · 每日`),
        usedPercent: status.dailyQuota.depleted ? 100 : status.dailyQuota.usedPercent,
        leftPercent: left,
        figure: status.dailyQuota.depleted ? i18n._(msg`已用尽`) : i18n._(msg`剩余 ${formatQuotaAmount(status.dailyQuota.remaining)} / ${formatQuotaAmount(status.dailyQuota.limit)}`),
        resetsAt: status.dailyQuota.resetsAt,
      });
    }
  }
  return entries.sort((a, b) => a.leftPercent - b.leftPercent || a.label.localeCompare(b.label));
}

export function QuotaMeterBar({ label, usedPercent, leftPercent, figure, resetsAt }: {
  label: string;
  usedPercent: number;
  leftPercent?: number;
  figure?: string;
  resetsAt?: string;
}) {
  const { t } = useLingui();
  const left = leftPercent ?? remainingPercent(usedPercent);
  const reset = formatResetLabel(resetsAt);
  const remaining = formatNumber(left);
  const text = figure ?? (left <= 0 ? t`已用尽` : t`剩余 ${remaining}%`);
  return (
    <div className="flex flex-col gap-1.5 py-2.5">
      <div className="flex items-baseline justify-between gap-4">
        <span className="min-w-0 truncate text-xs font-medium text-fg">{label}</span>
        <div className="flex shrink-0 items-baseline gap-2.5 text-xs tabular-nums">
          {reset && <span className="text-fg-3">{reset}</span>}
          <span className={cn('font-medium', quotaTextClass(left))}>{text}</span>
        </div>
      </div>
      <Progress value={left / 100} tone={quotaTone(left)} role="meter" label={label} />
    </div>
  );
}

function formatPlanLabel(plan: string): string {
  return plan.replace(/_/g, ' ').replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

function hasAccountCredits(account: NativeBackendUsage['account']): boolean {
  return Boolean(account?.credits?.unlimited || account?.credits?.balance !== undefined);
}

/** Whether a usage snapshot has any account or per-model quota information worth displaying. */
export function hasUsageContent(usage: NativeBackendUsage | undefined, showPlan = false): boolean {
  if (!usage) return false;
  const account = usage.account;
  const windows = account?.windows ?? [];
  const showCredits = windows.length === 0 && hasAccountCredits(account);
  return Boolean((showPlan && account?.plan) || windows.length || showCredits || account?.limitReached || dedicatedModelQuotas(usage).length);
}

/** Account windows, fallback credits and per-model quotas rendered consistently in provider settings and plugin pages. */
export function QuotaDetails({ usage, maxModelMeters, showPlan = false }: {
  usage: NativeBackendUsage;
  /** Caps inline per-model meters when a dedicated Models subpage is right below. */
  maxModelMeters?: number;
  showPlan?: boolean;
}) {
  // Subscribe to locale switches so pure `i18n._` helpers re-render in the active language.
  const { i18n: activeI18n } = useLingui();
  void activeI18n.locale;
  const account = usage.account;
  const windows: UsageWindow[] = account?.windows ?? [];
  const modelQuotas = dedicatedModelQuotas(usage);
  const shownModels = maxModelMeters !== undefined ? modelQuotas.slice(0, maxModelMeters) : modelQuotas;
  const hasZeroWindow = windows.some((w) => remainingPercent(w.usedPercent) <= 0);
  const showCredits = windows.length === 0 && hasAccountCredits(account);
  const hasContent = Boolean((showPlan && account?.plan) || windows.length || showCredits || account?.limitReached || shownModels.length);

  if (!hasContent) {
    return (
      <div className="flex items-center justify-between gap-4 py-2.5 text-xs">
        <span className="text-fg-3"><Trans>额度</Trans></span>
        <span className="tabular-nums text-fg-3">—</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col [&>*+*]:edge-t">
      {showPlan && account?.plan && (
        <div className="flex items-center justify-between gap-4 py-2.5 text-xs">
          <span className="font-medium text-fg"><Trans>套餐</Trans></span>
          <span className="text-fg-2">{formatPlanLabel(account.plan)}</span>
        </div>
      )}
      {windows.map((window, index) => (
        <QuotaMeterBar
          key={`${window.windowMinutes ?? 'w'}-${index}`}
          label={windowLabel(window.windowMinutes)}
          usedPercent={window.usedPercent}
          resetsAt={window.resetsAt}
        />
      ))}
      {showCredits && account?.credits && (
        <div className="flex items-center justify-between gap-4 py-2.5 text-xs">
          <span className="font-medium text-fg"><Trans>余额</Trans></span>
          <span className="font-medium tabular-nums text-fg-2">
            {account.credits.unlimited ? <Trans>不限额</Trans> : account.credits.balance === undefined ? '—' : formatNumber(account.credits.balance)}
          </span>
        </div>
      )}
      {account?.limitReached && !hasZeroWindow && (
        <p className="py-2.5 text-xs font-medium text-danger"><Trans>额度已用尽</Trans></p>
      )}
      {shownModels.map((item) => (
        <QuotaMeterBar
          key={item.id}
          label={item.label}
          usedPercent={item.usedPercent}
          leftPercent={item.leftPercent}
          figure={item.figure}
          resetsAt={item.resetsAt}
        />
      ))}
    </div>
  );
}

/**
 * Reads one provider's quota backed by the shared cache (model picker, provider editor, plugin page).
 * Shows any cached reading immediately, refreshes once in the background, and retains the previous
 * reading while refreshing or on failure.
 */
export function useProviderUsage(backendId: NativeBackendId, profileId: string, options: { projectId?: string; enabled?: boolean } = {}) {
  const { t } = useLingui();
  const enabled = options.enabled ?? true;
  const scope = providerUsageScope(backendId, profileId, options.projectId);
  const revision = useUsageRevision();
  const [usage, setUsage] = useState<NativeBackendUsage | undefined>(() => enabled ? readLiveUsage(scope) : undefined);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState('');
  const [manualTick, setManualTick] = useState(0);
  const lastScopeRef = useRef({ scope, revision });
  const completedManualTickRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setUsage(undefined);
      setLoading(false);
      setError('');
      return;
    }
    const scopeChanged = lastScopeRef.current.scope !== scope || lastScopeRef.current.revision !== revision;
    lastScopeRef.current = { scope, revision };
    const cached = readLiveUsage(scope);
    setUsage((prev) => scopeChanged ? cached : cached ?? prev);
    const controller = new AbortController();
    const force = manualTick > 0 && manualTick !== completedManualTickRef.current;
    setLoading(true);
    setError('');
    void api.backendUsage(backendId, { profileId, ...(options.projectId ? { projectId: options.projectId } : { scope: 'global' as const }), ...(force ? { refresh: true } : {}) }, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        writeLiveUsage(scope, next);
        setUsage(next);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(errorMessage(failure, t`额度读取失败`));
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          completedManualTickRef.current = manualTick;
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [backendId, profileId, options.projectId, scope, enabled, revision, manualTick]);

  const refresh = useCallback(() => {
    setManualTick((value) => value + 1);
  }, []);

  return { usage, loading, error, refresh };
}

/** Mounted for one saved connection inside 设置 › 模型提供商; shares cache and meters with the plugin page. */
export function ProviderUsage({ backendId, profileId, projectId, hideWhenEmpty = false }: { backendId: NativeBackendId; profileId: string; projectId?: string; hideWhenEmpty?: boolean }) {
  const { t } = useLingui();
  const { usage, loading, error, refresh } = useProviderUsage(backendId, profileId, { projectId });
  if (hideWhenEmpty && !error && !hasUsageContent(usage, true)) return null;
  const fetched = formatFetchedLabel(usage?.fetchedAt);
  return (
    <div className="flex flex-col py-3.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-fg"><Trans>额度</Trans></span>
          {fetched && <span className="text-xs text-fg-4">{fetched}</span>}
        </div>
        <Tip label={t`刷新额度`}>
          <Button variant="ghost" size="icon-xs" aria-label={t`刷新额度`} busy={loading} onClick={refresh}><IconRefreshCw /></Button>
        </Tip>
      </div>
      {loading && !usage ? (
        <div className="flex justify-center py-4"><Spinner /></div>
      ) : (
        <div className={cn('mt-1 transition-opacity duration-[var(--duration-fast)]', loading && 'opacity-60')}>
          {usage && <QuotaDetails usage={usage} showPlan />}
        </div>
      )}
      {error && (
        <div role="alert" className="mt-1 flex items-center justify-between gap-2 pt-2">
          <span className="min-w-0 break-words text-xs text-danger">{error}</span>
          <Button variant="secondary" size="xs" disabled={loading} onClick={refresh}><Trans>重试</Trans></Button>
        </div>
      )}
    </div>
  );
}
