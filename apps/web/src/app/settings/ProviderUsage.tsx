import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { NativeBackendId, NativeBackendUsage } from '@contracts';
import { IconRefreshCw } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/controls';
import { api } from '@/lib/api';
import { formatDateTime, formatNumber } from '@/lib/i18n/format';
import { errorMessage } from '@/lib/utils';
import { SettingsRow } from './SettingsLayout';

/** Mounted for one saved connection; its caller replaces it when that connection changes. */
export function ProviderUsage({ backendId, profileId, projectId }: { backendId: NativeBackendId; profileId: string; projectId?: string }) {
  const { t } = useLingui();
  const [value, setValue] = useState<NativeBackendUsage>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    void api.backendUsage(backendId, { profileId, ...(projectId ? { projectId } : { scope: 'global' as const }) }, controller.signal)
      .then((next) => { if (!controller.signal.aborted) setValue(next); })
      .catch((failure) => { if (!controller.signal.aborted) setError(errorMessage(failure, t`额度读取失败`)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [backendId, profileId, projectId, refresh]);
  const account = value?.account;
  const windows = account?.windows ?? [];
  return <div className="flex flex-col py-3.5">
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm font-medium"><Trans>额度</Trans></span>
      <Button variant="ghost" size="icon-xs" aria-label={t`刷新额度`} busy={loading} onClick={() => setRefresh((current) => current + 1)}><IconRefreshCw /></Button>
    </div>
    {loading && !value ? <div className="flex justify-center py-3"><Spinner /></div> : <>
      {account?.plan && <SettingsRow title={t`套餐`}><span className="text-sm text-fg-3">{account.plan}</span></SettingsRow>}
      {windows.map((window, index) => {
        const minutes = window.windowMinutes;
        const label = minutes === 1440 ? t`每日` : minutes === 10080 ? t`每周` : minutes === undefined ? t`额度` : minutes % 60 === 0 ? t`${minutes / 60} 小时` : t`${minutes} 分钟`;
        const remaining = formatNumber(Math.max(0, 100 - window.usedPercent));
        const reset = window.resetsAt ? formatDateTime(window.resetsAt) : undefined;
        return <SettingsRow key={index} title={label} description={reset ? t`${reset} 重置` : undefined}><span className="text-sm tabular-nums text-fg-3"><Trans>剩余 {remaining}%</Trans></span></SettingsRow>;
      })}
      {account?.credits && <SettingsRow title={t`余额`}><span className="text-sm tabular-nums text-fg-3">{account.credits.unlimited ? t`不限额` : account.credits.balance === undefined ? '—' : formatNumber(account.credits.balance)}</span></SettingsRow>}
      {account?.limitReached && <p className="py-2 text-xs text-danger"><Trans>额度已用尽</Trans></p>}
      {!account && !error && <span className="py-2 text-sm text-fg-3">—</span>}
    </>}
    {error && <div role="alert" className="flex items-center justify-between gap-2 py-2"><span className="text-xs text-danger">{error}</span><Button variant="ghost" size="xs" disabled={loading} onClick={() => setRefresh((current) => current + 1)}><Trans>重试</Trans></Button></div>}
  </div>;
}
