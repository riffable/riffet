import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { ChannelAccountInfo, ChannelHealth, ChannelsState } from '@contracts';
import { Button } from '@/components/ui/button';
import { IconBot, IconChevronRight, IconCircleAlert, IconPlus, IconRefreshCw } from '@/components/icons';
import { Badge, EmptyState, Spinner, StatusDot } from '@/components/ui/controls';
import { FeedbackNotice } from '@/components/ui/feedback-notice';
import { api } from '@/lib/api';
import { errorMessage, timeAgo } from '@/lib/utils';
import { useStores } from '../state/stores';
import { SettingsGroup } from './SettingsLayout';
import { AddBotDialog, type AddBotMode } from './channels/AddBotDialog';
import { BotDetail } from './channels/BotDetail';
import { CardSettings } from './channels/CardSettings';
import { BotAvatar, botName, pendingCount } from './channels/shared';

/** 机器人: the IM bots connected to this server; a row opens that bot's page in place. */
export function ChannelsSection() {
  const { t } = useLingui();
  const [state, setState] = useState<ChannelsState>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [detailId, setDetailId] = useState<string>();
  const [cardOpen, setCardOpen] = useState(false);
  const [dialog, setDialog] = useState<{ mode: AddBotMode; key: number; open: boolean }>();
  const [healths, setHealths] = useState<Record<string, ChannelHealth>>({});
  const { lists } = useStores();
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => lists.onChannels(reload), [lists, reload]);
  useEffect(() => {
    const controller = new AbortController();
    api.channels(controller.signal)
      .then((next) => { setState(next); setError(''); })
      .catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason, t`无法读取机器人`)); });
    return () => controller.abort();
  }, [revision, t]);

  // The list's "待完成 N 项" needs each bot's checks; they are few, so each is read as it appears or changes.
  const watched = useMemo(() => state?.accounts.map((account) => `${account.id}:${account.status.state}:${account.enabled}`).join(',') ?? '', [state]);
  useEffect(() => {
    const controller = new AbortController();
    for (const account of state?.accounts ?? []) {
      api.channelHealth(account.id, false, controller.signal)
        .then((health) => setHealths((current) => ({ ...current, [account.id]: health })))
        .catch(() => undefined);
    }
    return () => controller.abort();
    // Keyed by `watched`: only a new bot or a changed connection rereads the checks.
  }, [watched]);

  const run = useCallback(async (action: () => Promise<unknown>, fallback: string) => {
    setBusy(true); setError('');
    try { await action(); }
    catch (reason) { setError(errorMessage(reason, fallback)); }
    finally { setBusy(false); reload(); }
  }, [reload]);

  const openDialog = (mode: AddBotMode) => setDialog((current) => ({ mode, key: (current?.key ?? 0) + 1, open: true }));

  if (!state) return error
    ? <EmptyState icon={<IconCircleAlert />} title={t`无法读取机器人`} description={error}>
      <Button size="sm" onClick={reload}><IconRefreshCw /><Trans>重试</Trans></Button>
    </EmptyState>
    : <div className="flex justify-center p-5"><Spinner /></div>;

  const detail = detailId ? state.accounts.find((account) => account.id === detailId) : undefined;

  const status = (account: ChannelAccountInfo) => {
    const { state: connection, lastEventAt } = account.status;
    const health = healths[account.id];
    const pending = connection === 'connected' && health ? pendingCount(account, health) : 0;
    if (connection === 'disabled') return { tone: 'idle' as const, label: t`已停用` };
    if (connection === 'connecting') return { tone: 'warning' as const, label: t`连接中`, pulse: true };
    if (connection !== 'connected') return { tone: 'danger' as const, label: t`连接失败` };
    if (pending > 0) return { tone: 'warning' as const, label: t`待完成 ${pending} 项` };
    const last = health?.lastEventAt ?? lastEventAt;
    return { tone: 'success' as const, label: last ? t`已连接 · ${timeAgo(last)}` : t`已连接` };
  };

  return <div className="flex flex-col gap-6">
    <FeedbackNotice scope="channels" message={error} tone="danger" />
    {detail
      ? cardOpen
        ? <CardSettings account={detail} busy={busy} run={run} onBack={() => setCardOpen(false)} />
        : <BotDetail account={detail} state={state} busy={busy} run={run} onBack={() => setDetailId(undefined)} onOpenCard={() => setCardOpen(true)} onDialog={openDialog} />
      : state.accounts.length === 0
        ? <EmptyState icon={<IconBot />} title={t`还没有机器人`}><Button variant="primary" onClick={() => openDialog({ kind: 'add' })}><IconPlus /><Trans>添加飞书机器人</Trans></Button></EmptyState>
        : <SettingsGroup action={<Button size="xs" variant="ghost" onClick={() => openDialog({ kind: 'add' })}><IconPlus /><Trans>添加</Trans></Button>}>
          {state.accounts.map((account) => {
            const { tone, label, pulse } = status(account);
            return <button key={account.id} type="button" onClick={() => setDetailId(account.id)} className="-mx-4 flex min-h-14 items-center gap-3 px-4 text-left hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus max-md:-mx-3 max-md:px-3">
              <BotAvatar account={account} size="sm" />
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className="truncate text-sm font-medium text-fg">{botName(account)}</span>
                {account.domain === 'lark' && <Badge>Lark</Badge>}
              </span>
              <span className="flex shrink-0 items-center gap-1.5 text-sm text-fg-2"><StatusDot tone={tone} pulse={pulse} />{label}</span>
              <IconChevronRight className="size-4 shrink-0 text-fg-4" />
            </button>;
          })}
        </SettingsGroup>}
    {dialog && <AddBotDialog key={dialog.key} open={dialog.open} mode={dialog.mode} state={state} onChanged={reload} onOpenChange={(open) => setDialog((current) => current && { ...current, open })} />}
  </div>;
}
