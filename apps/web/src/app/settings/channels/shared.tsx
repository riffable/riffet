import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useVisibleInterval } from '@/lib/use-visible-interval';
import { Trans, useLingui } from '@lingui/react/macro';
import type { ChannelAccountInfo, ChannelBindCode, ChannelHealth, ChannelProviderInfo, ChannelsState } from '@contracts';
import { Button } from '@/components/ui/button';
import { IconBot, IconCircle, IconCircleAlert, IconCircleCheck, IconCopy, IconExternalLink, IconRefreshCw } from '@/components/icons';
import { Spinner } from '@/components/ui/controls';
import { Notice } from '@/components/ui/notice';
import { api } from '@/lib/api';
import { copyWithToast } from '@/lib/files';
import { formatTime } from '@/lib/i18n/format';
import { localizedText } from '@/lib/plugins';
import { cn, errorMessage } from '@/lib/utils';

export const botName = (account: ChannelAccountInfo, fallback?: string) =>
  account.botName || account.identity?.value || fallback || account.appId || account.id;

export const providerOf = (state: ChannelsState | undefined, kind: string | undefined): ChannelProviderInfo | undefined =>
  kind ? state?.providers.find((provider) => provider.id === kind) : undefined;

export const providerName = (provider: ChannelProviderInfo | undefined, locale: string, fallbackKind?: string): string =>
  localizedText(provider?.title, [locale]) ?? (fallbackKind ? fallbackKind.slice(fallbackKind.lastIndexOf('/') + 1) : '');

/** The bot's own picture, or a neutral one until the platform has told us. */
export function BotAvatar({ account, size }: { account: ChannelAccountInfo; size: 'sm' | 'lg' }) {
  const [failed, setFailed] = useState(false);
  const box = size === 'lg' ? 'size-10' : 'size-8';
  if (account.avatarUrl && !failed) return <img alt="" src={account.avatarUrl} onError={() => setFailed(true)} className={cn(box, 'shrink-0 rounded-full bg-muted object-cover')} />;
  return <span className={cn(box, 'grid shrink-0 place-items-center rounded-full bg-muted text-fg-3')}><IconBot className={size === 'lg' ? 'size-5' : 'size-4'} /></span>;
}

/** The account's live checks; `intervalMs` keeps reading them until it is left undefined. */
export function useChannelHealth(account: ChannelAccountInfo | undefined, intervalMs?: number) {
  const [health, setHealth] = useState<ChannelHealth>();
  const [loading, setLoading] = useState(false);
  const id = account?.id;
  const connection = account?.status.state;
  const read = useCallback(async (refresh: boolean) => {
    if (!id) return;
    setLoading(true);
    try { setHealth(await api.channelHealth(id, refresh)); }
    catch { /* the last reading stays */ }
    finally { setLoading(false); }
  }, [id]);
  // A change of connection state or of the platform's last event is worth a fresh read.
  useEffect(() => { void read(false); }, [read, connection, account?.enabled]);
  useVisibleInterval(() => void read(false), intervalMs ?? 0, Boolean(intervalMs));
  return { health, loading, refresh: () => read(true) };
}

/** What still stands between the bot and its first message, in the order the page lists it. */
export function pendingCount(account: ChannelAccountInfo, health: ChannelHealth, bound = true) {
  return [
    !health.connected && account.enabled,
    health.activated === false,
    (health.missingScopes?.length ?? 0) > 0,
    health.needsLongConnection === true,
    !bound,
    !(health.lastEventAt ?? account.status.lastEventAt),
  ].filter(Boolean).length;
}

export type CheckState = 'ok' | 'bad' | 'todo' | 'busy';

export function CheckItem({ state, title, detail, action }: { state: CheckState; title: ReactNode; detail?: ReactNode; action?: ReactNode }) {
  const icon = state === 'ok' ? <IconCircleCheck className="text-success" />
    : state === 'bad' ? <IconCircleAlert className="text-danger" />
      : state === 'busy' ? <Spinner className="size-4" /> : <IconCircle className="text-fg-4" />;
  return <div className="flex items-center gap-3 py-3 max-md:flex-wrap">
    <span className="grid size-4 shrink-0 place-items-center [&_svg]:size-4">{icon}</span>
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="text-sm text-fg">{title}</span>
      {detail && <span className="text-xs text-fg-3">{detail}</span>}
    </div>
    {action}
  </div>;
}

/** A fresh bind code for one bot, with the one line that says what to do with it. */
export function BindCodeView({ accountId, platformName, openUrl }: { accountId: string; platformName?: string; openUrl?: string }) {
  const { t } = useLingui();
  const [code, setCode] = useState<ChannelBindCode>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);
  const generate = useCallback(async () => {
    setBusy(true); setError('');
    try { const next = await api.channelBindCode(accountId); setCode(next); setExpired(Date.parse(next.expiresAt) <= Date.now()); }
    catch (reason) { setError(errorMessage(reason, t`无法生成绑定码`)); }
    finally { setBusy(false); }
  }, [accountId, t]);
  useEffect(() => { void generate(); }, [generate]);
  useEffect(() => {
    if (!code || expired) return;
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, Date.parse(code.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [code, expired]);
  if (error) return <Notice tone="danger" action={<Button size="xs" disabled={busy} onClick={() => void generate()}><Trans>重试</Trans></Button>}>{error}</Notice>;
  if (!code) return <div className="flex justify-center py-4"><Spinner /></div>;
  const command = `/bind ${code.code}`;
  return <div className="flex flex-col items-center gap-2.5 py-2 text-center">
    <span className={cn('select-all font-mono text-3xl font-semibold tracking-widest text-fg transition-opacity', expired && 'opacity-30')}>{code.code}</span>
    <span role="status" className="text-xs text-fg-3">{expired ? t`已过期` : t`有效至 ${formatTime(code.expiresAt)}`}</span>
    <span className="text-sm text-fg-2">
      {platformName
        ? <Trans>在 {platformName} 私聊机器人发送 <code className="rounded bg-hover px-1.5 py-0.5 font-mono text-xs">{command}</code></Trans>
        : <Trans>私聊机器人发送 <code className="rounded bg-hover px-1.5 py-0.5 font-mono text-xs">{command}</code></Trans>}
    </span>
    <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
      {!expired && <Button variant="secondary" size="sm" onClick={() => void copyWithToast(command)}><IconCopy /><Trans>复制命令</Trans></Button>}
      {!expired && openUrl && <Button asChild variant="secondary" size="sm"><a href={openUrl} target="_blank" rel="noreferrer">{platformName ? <Trans>在 {platformName} 中打开</Trans> : <Trans>打开机器人</Trans>}<IconExternalLink /></a></Button>}
      {expired && <Button variant="primary" size="sm" disabled={busy} onClick={() => void generate()}><IconRefreshCw /><Trans>重新生成</Trans></Button>}
    </div>
  </div>;
}
