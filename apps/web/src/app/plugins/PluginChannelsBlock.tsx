import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { PLUGIN_PAGE_BUDGET, type ChannelAccountInfo, type ChannelsState, type PluginDescriptor } from '@contracts';
import { IconChevronRight, IconPlus } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { StatusDot } from '@/components/ui/controls';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/i18n/format';
import { localizedText } from '@/lib/plugins';
import { cn, errorMessage } from '@/lib/utils';
import { SettingsGroup, SettingsLinkRow } from '../settings/SettingsLayout';
import { BotAvatar, botName } from '../settings/channels/shared';
import { useStores } from '../state/stores';

const declaredKinds = (plugin: PluginDescriptor): string[] => plugin.declared?.imChannels?.map((item) => item.id) ?? [];

/** Whether the plugin serves at least one IM platform, so its page gets the bots block. */
export function hasChannelsBlock(plugin: PluginDescriptor): boolean {
  return declaredKinds(plugin).length > 0;
}

// The last reading survives leaving and reopening the page; a background read replaces it.
let cached: ChannelsState | undefined;

/**
 * The host-drawn `imChannels` section on a plugin's page (docs/design/system/plugins.md §6.3):
 * one row per bot of the platforms this plugin serves, with its connection state at the row end.
 * A row opens that bot in Settings; the empty state starts adding one.
 */
export function PluginChannelsBlock({ plugin, disabled, onOpenChannels, onAddBot }: {
  plugin: PluginDescriptor;
  disabled?: boolean;
  onOpenChannels: (accountId?: string) => void;
  onAddBot: (kind: string) => void;
}) {
  const { t, i18n } = useLingui();
  const { lists } = useStores();
  const kinds = useMemo(() => declaredKinds(plugin), [plugin]);
  const [state, setState] = useState<ChannelsState | undefined>(cached);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((value) => value + 1), []);
  useEffect(() => lists.onChannels(reload), [lists, reload]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    api.channels(controller.signal)
      .then((next) => { cached = next; setState(next); setError(''); })
      .catch((failure) => { if (!controller.signal.aborted) setError(errorMessage(failure, t`无法读取机器人`)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [tick, t]);

  const accounts = useMemo(
    () => (state?.accounts ?? []).filter((account) => kinds.includes(account.kind)),
    [state, kinds],
  );
  const addKind = kinds.find((kind) => state?.providers.some((provider) => provider.id === kind));
  const canAdd = Boolean(addKind && plugin.enabled);
  // The platform's name (飞书), not the plugin's (飞书机器人): the sentence is about bots on that platform.
  const platform = localizedText(plugin.declared?.imChannels?.[0]?.title, [i18n.locale]) ?? localizedText(plugin.title, [i18n.locale]) ?? plugin.name;

  const summary = (account: ChannelAccountInfo) => {
    switch (account.status.state) {
      case 'connected': return { tone: 'success' as const, label: t`已连接` };
      case 'connecting': return { tone: 'warning' as const, label: t`连接中`, pulse: true };
      case 'disabled': return { tone: 'idle' as const, label: t`已停用` };
      default: return { tone: 'danger' as const, label: t`连接失败` };
    }
  };

  const shown = accounts.slice(0, PLUGIN_PAGE_BUDGET.summaryRows);
  const title = t({ message: '机器人', context: 'plugin-channels-section' });

  return (
    <SettingsGroup
      title={title}
      loading={loading && !state}
      action={canAdd && accounts.length > 0 ? (
        <Button type="button" size="xs" variant="ghost" disabled={disabled} onClick={() => onAddBot(addKind!)}>
          <IconPlus />
          <Trans>添加</Trans>
        </Button>
      ) : undefined}
    >
      {error && (
        <div role="alert" className="flex items-center justify-between gap-3 py-4">
          <span className="min-w-0 break-words text-sm text-danger">{error}</span>
          <Button type="button" size="xs" variant="secondary" disabled={loading} onClick={reload}><Trans>重试</Trans></Button>
        </div>
      )}
      {state && accounts.length === 0 && !error && (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <p className="text-sm text-fg-3"><Trans>还没有{platform}机器人</Trans></p>
          {canAdd && (
            <Button type="button" size="sm" variant="secondary" disabled={disabled} onClick={() => onAddBot(addKind!)}>
              <IconPlus />
              <Trans>添加机器人</Trans>
            </Button>
          )}
        </div>
      )}
      {accounts.length > 0 && (
        <div className={cn('flex flex-col transition-opacity duration-[var(--duration-fast)] [&>*+*]:edge-t', loading && 'opacity-60')} aria-busy={loading}>
          {shown.map((account) => {
            const { tone, label, pulse } = summary(account);
            return (
              <button
                key={account.id}
                type="button"
                disabled={disabled}
                onClick={() => onOpenChannels(account.id)}
                title={account.status.error}
                className="-mx-4 flex min-h-14 items-center gap-3 px-4 text-left hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus max-md:-mx-3 max-md:px-3"
              >
                <BotAvatar account={account} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{botName(account)}</span>
                <span className="flex shrink-0 items-center gap-1.5 text-sm text-fg-2"><StatusDot tone={tone} pulse={pulse} />{label}</span>
                <IconChevronRight className="size-4 shrink-0 text-fg-4" />
              </button>
            );
          })}
          {accounts.length > shown.length && (
            <SettingsLinkRow title={t`全部 ${formatNumber(accounts.length)} 个`} onClick={() => onOpenChannels()} />
          )}
        </div>
      )}
    </SettingsGroup>
  );
}
