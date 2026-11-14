import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { SessionShare, ShareCapability } from '@contracts';
import { Button } from '@/components/ui/button';
import { IconCircleAlert, IconRefreshCw } from '@/components/icons';
import { EmptyState, Select, Spinner } from '@/components/ui/controls';
import { FeedbackNotice } from '@/components/ui/feedback-notice';
import { copyWithToast } from '@/lib/files';
import { api } from '@/lib/api';
import { shares, shareCapabilityMessage, shareManagedElsewhere } from '@/lib/shares';
import { errorMessage, formatDateTime } from '@/lib/utils';
import { SettingsGroup, SettingsRow } from '../settings/SettingsLayout';
import { removeShare } from './ShareDialog';

/** All remote shares remain manageable after their local conversation is deleted. */
export function SharesSection() {
  const { t } = useLingui();
  const [items, setItems] = useState<SessionShare[]>();
  const [capability, setCapability] = useState<ShareCapability>();
  // A share is checked against the publisher that made it, which is not always the one new shares use.
  const [owned, setOwned] = useState<Record<string, ShareCapability>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    const load = () => Promise.all([shares.list(), shares.capability()]).then(async ([values, nextCapability]) => {
      const others = [...new Set(values.map(share => share.publisher))].filter((owner): owner is string => Boolean(owner) && owner !== nextCapability.publisher?.id);
      const found = await Promise.all(others.map(async owner => [owner, await shares.capability(false, undefined, owner)] as const));
      if (active) { setItems(values); setCapability(nextCapability); setOwned(Object.fromEntries(found)); setError(''); }
    }).catch(reason => { if (active) setError(errorMessage(reason, t`无法读取分享记录`)); });
    void load();
    return () => { active = false; };
  }, [revision]);
  const polling = Boolean(items?.some(item => item.operation && item.operation !== 'uncertain'));
  useEffect(() => {
    if (!polling) return;
    let active = true;
    const timer = window.setInterval(() => {
      void shares.list().then(values => { if (active) setItems(values); })
        .catch(reason => { if (active) setError(errorMessage(reason, t`无法读取分享记录`)); });
    }, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [polling]);
  const act = async (share: SessionShare, action: 'reconcile' | 'retry' | 'remove') => {
    setBusy(share.id); setError('');
    try {
      const value = await (action === 'remove' ? removeShare(share) : shares[action](share.id));
      if (value) setItems(current => current?.map(item => item.id === value.id ? value : item));
    } catch (reason) { setError(errorMessage(reason, t`分享操作失败`)); }
    finally { setBusy(undefined); }
  };
  const choosePublisher = async (id: string) => {
    setError('');
    try { await api.setPluginDefaults({ defaultSharePublisher: id }); setRevision(value => value + 1); }
    catch (reason) { setError(errorMessage(reason, t`无法保存`)); }
  };
  const visible = items?.filter(item => item.state !== 'removed' || item.operation);
  return <SettingsGroup>
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <span className="text-xs text-fg-3">{capability?.available ? [capability.publisher?.label, capability.username].filter(Boolean).join(' · ') : capability ? shareCapabilityMessage(capability) : ''}</span>
      <Button variant="quiet" size="xs" onClick={() => setRevision(value => value + 1)}><Trans>刷新</Trans></Button>
    </div>
    {capability?.publisher && capability.publishers && capability.publishers.length > 1 && (
      <SettingsRow title={t`发布到`}>
        <Select label={t`发布到`} className="w-56 max-md:w-full" value={capability.publisher.id} onChange={next => void choosePublisher(next)}
          options={capability.publishers.map(publisher => ({ value: publisher.id, label: publisher.label }))} />
      </SettingsRow>
    )}
    {!items && !error && <div className="flex justify-center p-5"><Spinner /></div>}
    {!items && error && (
      <EmptyState icon={<IconCircleAlert />} title={t`无法读取分享记录`} description={error}>
        <Button size="sm" onClick={() => setRevision(value => value + 1)}><IconRefreshCw /><Trans>重试</Trans></Button>
      </EmptyState>
    )}
    <FeedbackNotice scope="shares" message={items && error} tone="danger" className="px-4 py-3" />
    {visible?.length === 0 && <p className="px-4 py-5 text-sm text-fg-3"><Trans>在会话菜单中创建分享。</Trans></p>}
    {visible?.map(share => {
      const own = (share.publisher ? owned[share.publisher] : undefined) ?? capability;
      const elsewhere = shareManagedElsewhere(share, own);
      const disabled = Boolean(busy || !own?.available || elsewhere || own.username && (own.username !== share.username || (own.profile ?? '') !== (share.profile ?? '')) || share.operation && share.operation !== 'uncertain');
      return <div key={share.id} className="flex flex-wrap items-center gap-3 edge-t px-4 py-3">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="truncate text-sm text-fg" title={share.title}>{share.title}</p>
          <p className="text-xs text-fg-3">{share.username}{share.expiresAt ? ` · ${t`${formatDateTime(share.expiresAt)} 到期`}` : ''}</p>
          {share.url && <a href={share.url} target="_blank" rel="noopener noreferrer" className="block truncate text-xs text-accent hover:underline">{share.url}</a>}
          {share.operation && <p className="text-xs text-fg-3">{share.operation === 'uncertain' ? t`操作结果待核对` : share.operation === 'publishing' ? t`正在发布…` : t`正在取消分享…`}</p>}
          {share.error && <p className="text-xs text-danger">{share.error}</p>}
          {elsewhere && <p className="text-xs text-fg-3">{elsewhere}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {share.url && <Button variant="quiet" size="xs" onClick={() => void copyWithToast(share.url!)}><Trans>复制链接</Trans></Button>}
          {share.operation === 'uncertain' && <>
            <Button variant="quiet" size="xs" disabled={disabled} onClick={() => void act(share, 'reconcile')}><Trans>核对状态</Trans></Button>
            <Button variant="quiet" size="xs" disabled={disabled} onClick={() => void act(share, 'retry')}><Trans>重试</Trans></Button>
          </>}
          {(!share.operation || share.operation === 'uncertain') && (share.url || share.previewId) && <Button variant="quiet" size="xs" disabled={disabled} onClick={() => void act(share, 'remove')}><Trans>取消分享</Trans></Button>}
          {busy === share.id && <Spinner />}
        </div>
      </div>;
    })}
  </SettingsGroup>;
}
