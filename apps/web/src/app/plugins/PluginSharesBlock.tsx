import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { PLUGIN_PAGE_BUDGET, type PluginDescriptor, type SessionShare } from '@contracts';
import { IconArrowLeft, IconExternalLink } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/controls';
import { Tip } from '@/components/ui/tooltip';
import { formatDate, formatNumber } from '@/lib/i18n/format';
import { shares } from '@/lib/shares';
import { cn, errorMessage } from '@/lib/utils';
import { SettingsGroup, SettingsLinkRow } from '../settings/SettingsLayout';
import { removeShare } from '../shares/ShareDialog';

/** Whether the plugin publishes shares, so the host draws the 分享 group (docs/design/system/plugins.md §6.3). */
export function hasSharesBlock(plugin: PluginDescriptor): boolean {
  return Boolean(plugin.declared?.sharePublisher || plugin.contributes.sharePublisher);
}

/** Last reading, shown first on the next visit while the list is re-read in the background. */
let cachedShares: SessionShare[] | undefined;

function validFor(plugin: PluginDescriptor, list: SessionShare[]): SessionShare[] {
  const now = Date.now();
  return list
    .filter((share) => share.publisher === plugin.id && share.state === 'published' && share.url
      && (!share.expiresAt || new Date(share.expiresAt).getTime() > now))
    .sort((a, b) => (a.expiresAt ?? '9999').localeCompare(b.expiresAt ?? '9999'));
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try { return new URL(url).host; } catch { return undefined; }
}

function ShareRow({ share, enabled, busy, onRevoke }: {
  share: SessionShare;
  enabled: boolean;
  busy: boolean;
  onRevoke: (share: SessionShare) => void;
}) {
  const { t } = useLingui();
  const pending = Boolean(share.operation);
  return (
    <div className="flex min-h-14 items-center gap-3 py-3">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-fg" title={share.title}>{share.title}</span>
        <span className="truncate text-xs text-fg-3">{hostOf(share.url)}</span>
      </span>
      <span className="shrink-0 text-xs tabular-nums text-fg-3">
        {share.expiresAt ? t`${formatDate(share.expiresAt, { month: 'long', day: 'numeric' })}到期` : t`不过期`}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <Tip label={t`打开`}>
          <Button type="button" size="icon-xs" variant="quiet" aria-label={t`打开`} asChild>
            <a href={share.url} target="_blank" rel="noopener noreferrer"><IconExternalLink /></a>
          </Button>
        </Tip>
        {busy ? <Spinner /> : (
          <Button type="button" size="xs" variant="quiet" disabled={!enabled || pending} onClick={() => onRevoke(share)}>
            <Trans>撤下</Trans>
          </Button>
        )}
      </span>
    </div>
  );
}

/**
 * The host-drawn `sharePublisher` group on a plugin's page (docs/design/system/plugins.md §6.3):
 * shares published through this plugin that are still valid, each with its expiry, open and revoke.
 */
export function PluginSharesBlock({ plugin }: { plugin: PluginDescriptor }) {
  const { t } = useLingui();
  const [list, setList] = useState<SessionShare[] | undefined>(cachedShares);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string>();
  const [tick, setTick] = useState(0);
  const [all, setAll] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    shares.list()
      .then((value) => { if (active) { cachedShares = value; setList(value); } })
      .catch((failure) => { if (active) setError(errorMessage(failure, t`无法读取分享`)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [tick]);

  const items = useMemo(() => list ? validFor(plugin, list) : [], [plugin, list]);
  const revoke = useCallback(async (share: SessionShare) => {
    setBusyId(share.id);
    setError('');
    try {
      const value = await removeShare(share);
      if (value && alive.current) {
        setList((current) => {
          const next = current?.map((item) => item.id === value.id ? value : item);
          cachedShares = next;
          return next;
        });
      }
    } catch (failure) {
      if (alive.current) setError(errorMessage(failure, t`无法撤下`));
    } finally {
      if (alive.current) setBusyId(undefined);
    }
  }, [t]);
  const retry = () => setTick((value) => value + 1);

  const alert = error && (
    <div role="alert" className="flex items-center justify-between gap-3 py-3">
      <span className="min-w-0 break-words text-xs text-danger">{error}</span>
      <Button type="button" size="xs" variant="secondary" disabled={loading} onClick={retry}><Trans>重试</Trans></Button>
    </div>
  );
  const rows = (visible: SessionShare[]) => (
    <div className={cn('flex flex-col transition-opacity duration-[var(--duration-fast)] [&>*+*]:edge-t', loading && 'opacity-60')}>
      {visible.map((share) => (
        <ShareRow key={share.id} share={share} enabled={plugin.enabled} busy={busyId === share.id} onRevoke={(value) => void revoke(value)} />
      ))}
    </div>
  );

  if (all) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex items-center gap-2">
          <Button type="button" size="icon-xs" variant="quiet" aria-label={t`返回`} onClick={() => setAll(false)}>
            <IconArrowLeft />
          </Button>
          <h3 className="text-sm font-medium text-fg"><Trans context="plugin-shares-section">分享</Trans></h3>
          <span className="text-xs tabular-nums text-fg-3">{formatNumber(items.length)}</span>
        </div>
        <SettingsGroup>{alert}{rows(items)}</SettingsGroup>
      </div>
    );
  }

  const overflow = items.length > PLUGIN_PAGE_BUDGET.summaryRows;
  return (
    <SettingsGroup title={t({ message: '分享', context: 'plugin-shares-section' })} loading={loading && list === undefined}>
      {alert}
      {items.length === 0 ? (
        !error && (
          <p className="py-6 text-center text-sm text-fg-3"><Trans>没有仍然有效的分享</Trans></p>
        )
      ) : (
        <>
          {rows(items.slice(0, PLUGIN_PAGE_BUDGET.summaryRows))}
          {overflow && <SettingsLinkRow title={t`全部 ${formatNumber(items.length)} 个`} onClick={() => setAll(true)} />}
        </>
      )}
    </SettingsGroup>
  );
}
