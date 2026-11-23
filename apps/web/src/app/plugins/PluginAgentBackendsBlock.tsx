import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  PLUGIN_PAGE_BUDGET,
  type NativeBackendCatalogEntry,
  type NativeBackendId,
  type NativeBackendProfile,
  type PluginDescriptor,
} from '@contracts';
import { AgentMark } from '@/components/agent-marks';
import { IconArrowLeft, IconChevronRight, IconPlus } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/controls';
import { api } from '@/lib/api';
import { agentMarkStyle, backendLabel } from '@/lib/backends';
import { formatNumber } from '@/lib/i18n/format';
import { cn, errorMessage } from '@/lib/utils';
import { SettingsGroup, SettingsLinkRow } from '../settings/SettingsLayout';
import { useNav } from '../state/stores';

/** Whether the plugin declares any Agent, so the host draws an 「Agent 配置」 group for it. */
export function hasAgentBackendsBlock(plugin: PluginDescriptor): boolean {
  return (plugin.declared?.agentBackends?.length ?? 0) > 0;
}

interface ProfileReading {
  profile: NativeBackendProfile;
  /** Undefined while this profile's availability probe has not answered or failed. */
  entry?: NativeBackendCatalogEntry;
}

interface Reading {
  backendId: NativeBackendId;
  profiles: ProfileReading[];
}

// Last reading per Agent, so reopening a plugin shows it at once and refreshes behind it.
// perf-rules: allow keyed by the Agents installed plugins declare, a handful at most
const cache = new Map<string, Reading>();

const TONE = {
  ok: 'text-fg-2',
  warning: 'text-warning',
  danger: 'text-danger',
  none: 'text-fg-4',
} as const;

function summaryOf(entry: NativeBackendCatalogEntry | undefined): { text: string; tone: keyof typeof TONE } {
  if (!entry) return { text: '—', tone: 'none' };
  if (entry.needsLogin) return { text: i18n._(msg`未登录`), tone: 'warning' };
  if (!entry.available) return { text: i18n._(msg`不可用`), tone: 'danger' };
  if (entry.cliVersion?.status === 'too-old') return { text: i18n._(msg`版本过旧`), tone: 'warning' };
  return { text: i18n._(msg`已就绪`), tone: 'ok' };
}

async function readBackend(backendId: NativeBackendId, signal: AbortSignal): Promise<Reading> {
  const { profiles } = await api.backendProfiles(backendId, signal);
  const entries = await Promise.all(profiles.map((profile) =>
    api.backendCatalog(backendId, profile.id, undefined, signal).catch(() => undefined)));
  return { backendId, profiles: profiles.map((profile, index) => ({ profile, entry: entries[index] })) };
}

function ProfileRow({ backendId, item, onOpen }: { backendId: NativeBackendId; item: ProfileReading; onOpen: () => void }) {
  const { t } = useLingui();
  const { entry, profile } = item;
  const summary = summaryOf(entry);
  const version = entry?.cliVersion?.version;
  const detail = entry && !entry.available && !entry.needsLogin ? entry.reason : undefined;
  const subtitle = [backendLabel(backendId), version, detail].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      onClick={onOpen}
      className="-mx-4 flex min-h-14 items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus max-md:-mx-3 max-md:px-3"
    >
      <AgentMark backend={backendId} size={16} style={agentMarkStyle(backendId)} className="shrink-0" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-fg">{profile.name}</span>
          {profile.isDefault && <Badge className="shrink-0 font-normal"><Trans>默认</Trans></Badge>}
        </span>
        <span className="truncate text-xs text-fg-3">{subtitle}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <span className={cn('text-sm font-medium', TONE[summary.tone])}>{summary.text}</span>
        <IconChevronRight className="size-4 shrink-0 text-fg-4" />
      </span>
    </button>
  );
}

/**
 * The host-drawn `agentBackends` section on a plugin's page (docs/design/system/plugins.md §6.3): one row per
 * configuration of the plugin's Agents, ending in the CLI and login status. Navigation is the caller's.
 */
export function PluginAgentBackendsBlock({ plugin, disabled, onOpenAgentSettings }: {
  plugin: PluginDescriptor;
  disabled?: boolean;
  /** Opens 设置 › Agent for the Agent, on the configuration when `profileId` is given, else on its list (add one). */
  onOpenAgentSettings: (backendId: NativeBackendId, profileId?: string) => void;
}) {
  const { t } = useLingui();
  const settingsOpen = useNav((state) => state.settingsOpen);
  const backendIds = useMemo(
    () => (plugin.declared?.agentBackends ?? []).map((item) => item.id as NativeBackendId),
    [plugin.declared?.agentBackends],
  );
  const key = backendIds.join(',');
  const [readings, setReadings] = useState<Reading[]>(() => backendIds.flatMap((id) => cache.get(id) ?? []));
  const [loading, setLoading] = useState(readings.length < backendIds.length);
  const [refreshing, setRefreshing] = useState(true);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const wasSettingsOpen = useRef(settingsOpen);

  // Settings may have changed a configuration or a login; read again once it closes.
  useEffect(() => {
    const closed = wasSettingsOpen.current && !settingsOpen;
    wasSettingsOpen.current = settingsOpen;
    if (closed) setTick((value) => value + 1);
  }, [settingsOpen]);

  useEffect(() => {
    const controller = new AbortController();
    const cached = backendIds.flatMap((id) => cache.get(id) ?? []);
    setReadings(cached);
    setLoading(cached.length < backendIds.length);
    setRefreshing(true);
    setError('');
    void Promise.allSettled(backendIds.map((id) => readBackend(id, controller.signal))).then((results) => {
      if (controller.signal.aborted) return;
      let failure: unknown;
      const next = backendIds.flatMap((id, index) => {
        const result = results[index]!;
        if (result.status === 'fulfilled') {
          cache.set(id, result.value);
          return [result.value];
        }
        failure ??= result.reason;
        return cache.get(id) ?? [];
      });
      setReadings(next);
      if (failure !== undefined) setError(errorMessage(failure, t`无法读取 Agent 配置`));
    }).finally(() => {
      if (controller.signal.aborted) return;
      setLoading(false);
      setRefreshing(false);
    });
    return () => controller.abort();
  }, [plugin.id, key, tick]);

  const rows = useMemo(
    () => readings.flatMap((reading) => reading.profiles.map((item) => ({ backendId: reading.backendId, item }))),
    [readings],
  );
  const retry = useCallback(() => setTick((value) => value + 1), []);
  const primary = backendIds[0];
  if (!primary) return null;

  const dim = refreshing && rows.length > 0;
  const alert = error ? (
    <div role="alert" className="flex items-center justify-between gap-3 py-3">
      <span className="min-w-0 break-words text-xs text-danger">{error}</span>
      <Button type="button" size="xs" variant="secondary" disabled={refreshing} onClick={retry}><Trans>重试</Trans></Button>
    </div>
  ) : null;
  const renderRow = ({ backendId, item }: (typeof rows)[number]) => (
    <ProfileRow key={`${backendId}:${item.profile.id}`} backendId={backendId} item={item} onOpen={() => onOpenAgentSettings(backendId, item.profile.id)} />
  );

  if (showAll) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex items-center gap-2">
          <Button type="button" size="icon-xs" variant="quiet" aria-label={t`返回`} onClick={() => setShowAll(false)}>
            <IconArrowLeft />
          </Button>
          <h3 className="text-sm font-medium text-fg"><Trans>Agent 配置</Trans></h3>
          <span className="text-xs tabular-nums text-fg-3">{formatNumber(rows.length)}</span>
        </div>
        <SettingsGroup>
          {alert}
          <div className={cn('flex flex-col transition-opacity duration-[var(--duration-fast)] [&>*+*]:edge-t', dim && 'opacity-60')}>{rows.map(renderRow)}</div>
        </SettingsGroup>
      </div>
    );
  }

  const overflow = rows.length > PLUGIN_PAGE_BUDGET.summaryRows;
  return (
    <SettingsGroup
      title={t`Agent 配置`}
      loading={loading && rows.length === 0 && !error}
      action={rows.length > 0 ? (
        <Button type="button" size="xs" variant="ghost" disabled={disabled} onClick={() => onOpenAgentSettings(primary)}>
          <IconPlus />
          <Trans>添加</Trans>
        </Button>
      ) : undefined}
    >
      {alert}
      {rows.length === 0 ? (
        !loading && !error && (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <p className="text-sm text-fg-3"><Trans>还没有 {backendLabel(primary)} 配置</Trans></p>
            <Button type="button" size="sm" variant="secondary" disabled={disabled} onClick={() => onOpenAgentSettings(primary)}>
              <IconPlus />
              <Trans>添加配置</Trans>
            </Button>
          </div>
        )
      ) : (
        <>
          <div className={cn('flex flex-col transition-opacity duration-[var(--duration-fast)] [&>*+*]:edge-t', dim && 'opacity-60')}>
            {rows.slice(0, PLUGIN_PAGE_BUDGET.summaryRows).map(renderRow)}
          </div>
          {overflow && <SettingsLinkRow title={t`全部 ${formatNumber(rows.length)} 个`} onClick={() => setShowAll(true)} />}
        </>
      )}
    </SettingsGroup>
  );
}
