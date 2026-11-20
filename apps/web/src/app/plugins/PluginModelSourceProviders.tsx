import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  PLUGIN_PAGE_BUDGET,
  paramKind,
  paramsFromOptions,
  type ModelInfo,
  type NativeBackendId,
  type NativeBackendProfileSettings,
  type PluginDescriptor,
} from '@contracts';
import { AgentMark } from '@/components/agent-marks';
import { IconArrowLeft, IconChevronRight, IconPlus, IconRefreshCw } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, Spinner } from '@/components/ui/controls';
import { CopyButton } from '@/components/ui/copy-button';
import { SearchField } from '@/components/ui/search-field';
import { Tip } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { agentMarkStyle, backendLabel } from '@/lib/backends';
import { compareText, formatNumber } from '@/lib/i18n/format';
import { localizedText } from '@/lib/plugins';
import { formatTokens } from '@/lib/stats-format';
import { cleanLabel, cn, errorMessage } from '@/lib/utils';
import { SettingsGroup, SettingsLinkRow } from '../settings/SettingsLayout';
import {
  QuotaDetails,
  formatFetchedLabel,
  quotaTextClass,
  remainingPercent,
  summarizeUsage,
  useProviderUsage,
} from '../settings/ProviderUsage';
import { useCatalog, useSettings, useUi } from '../state/stores';

export interface NormalizedPluginModelSource {
  id: string;
  label?: string;
  role: 'source' | 'adapter';
  usage: boolean;
  defaultEndpoint?: string;
  protocols?: readonly string[];
  backends?: readonly NativeBackendId[];
  overridable?: readonly ('apiEndpoint' | 'apiKey')[];
}

/** Merges static manifest declarations and active runtime descriptors for a plugin's model sources. */
export function pluginModelSources(plugin: PluginDescriptor | undefined): NormalizedPluginModelSource[] {
  if (!plugin) return [];
  const map = new Map<string, NormalizedPluginModelSource>();
  for (const declared of plugin.declared?.modelSources ?? []) {
    map.set(declared.id, {
      id: declared.id,
      role: declared.role ?? 'source',
      usage: declared.usage === true,
      protocols: declared.protocols,
      backends: declared.backends,
      overridable: declared.overridable,
    });
  }
  for (const runtime of plugin.contributes.modelSources ?? []) {
    const existing = map.get(runtime.id);
    map.set(runtime.id, {
      id: runtime.id,
      label: runtime.label,
      role: runtime.role ?? existing?.role ?? 'source',
      usage: runtime.usage === true || existing?.usage === true,
      defaultEndpoint: runtime.defaultEndpoint,
      protocols: runtime.protocols ?? existing?.protocols,
      backends: runtime.backends ?? existing?.backends,
      overridable: runtime.overridable ?? existing?.overridable,
    });
  }
  return [...map.values()];
}

/** Whether the plugin's `settings` act as fallback connection fields for a gateway adapter/source. */
export function hasFallbackConnectionSettings(plugin: PluginDescriptor | undefined): boolean {
  if (!plugin || !plugin.settings.length) return false;
  const sources = pluginModelSources(plugin);
  if (!sources.length) return false;
  return sources.some((source) => source.role === 'adapter' || Boolean(source.overridable?.length));
}

export type ModelSourceSubpage =
  | { kind: 'all-providers' }
  | {
    kind: 'models';
    backendId: NativeBackendId;
    profileId: string;
    providerName: string;
    enabledModels: string[] | null;
    hasUsage: boolean;
    from?: 'all-providers';
  };

interface LinkedProvider {
  backendId: NativeBackendId;
  profile: NativeBackendProfileSettings;
  source: NormalizedPluginModelSource;
  isDefault: boolean;
}

function hostOf(profile: NativeBackendProfileSettings, plugin: PluginDescriptor, source: NormalizedPluginModelSource): string | undefined {
  const raw = profile.apiEndpoint?.trim()
    || plugin.settings.find((field) => field.key === 'baseUrl')?.value?.trim()
    || source.defaultEndpoint?.trim();
  if (!raw) return undefined;
  try { return new URL(raw).host || raw; }
  catch { return raw; }
}

function effortRange(model: ModelInfo): string | undefined {
  const effort = paramsFromOptions(model.configOptions).find((param) => paramKind(param) === 'effort');
  if (!effort || effort.options.length < 2) return undefined;
  const values = effort.options.map((option) => option.value).filter((value) => value && value !== 'default');
  if (values.length < 2) return undefined;
  return `${values[0]}–${values[values.length - 1]}`;
}

const SUMMARY_TONE = {
  danger: 'text-danger',
  warning: 'text-warning',
  muted: 'text-fg-2',
} as const;

function ProviderQuotaRow({ item, plugin, expanded, disabled, onToggle, onOpenModels, onEdit }: {
  item: LinkedProvider;
  plugin: PluginDescriptor;
  expanded: boolean;
  disabled?: boolean;
  onToggle: () => void;
  onOpenModels: () => void;
  onEdit: () => void;
}) {
  const { t } = useLingui();
  const canReadUsage = plugin.enabled && item.source.usage;
  const { usage, loading, error, refresh } = useProviderUsage(item.backendId, item.profile.id, { enabled: canReadUsage });
  const summary = canReadUsage ? summarizeUsage(usage) : undefined;
  const fetched = formatFetchedLabel(usage?.fetchedAt);
  const host = hostOf(item.profile, plugin, item.source);
  const subtitle = [backendLabel(item.backendId), host].filter(Boolean).join(' · ');
  const modelCountLabel = item.profile.enabledModels
    ? formatNumber(item.profile.enabledModels.length)
    : usage && Object.keys(usage.models).length > 0
      ? formatNumber(Object.keys(usage.models).length)
      : t`全部`;
  const collapsedModels = item.profile.enabledModels
    ? t`${formatNumber(item.profile.enabledModels.length)} 个模型`
    : t`全部模型`;

  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="-mx-4 flex min-h-14 items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus max-md:-mx-3 max-md:px-3"
      >
        <AgentMark backend={item.backendId} size={16} style={agentMarkStyle(item.backendId)} className="shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-fg">{item.profile.name}</span>
            {item.isDefault && <Badge className="shrink-0 font-normal"><Trans>默认</Trans></Badge>}
          </span>
          <span className="truncate text-xs text-fg-3">{subtitle}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {canReadUsage ? (
            loading && !usage ? (
              <Spinner />
            ) : (
              <span className={cn('text-sm font-medium tabular-nums transition-opacity duration-[var(--duration-fast)]', SUMMARY_TONE[summary?.tone ?? 'muted'], loading && 'opacity-60')}>
                {summary?.text ?? '—'}
              </span>
            )
          ) : !item.source.usage ? (
            <span className="text-xs text-fg-3">{collapsedModels}</span>
          ) : (
            <span className="text-sm tabular-nums text-fg-4">—</span>
          )}
          <IconChevronRight className={cn('size-4 shrink-0 text-fg-4 transition-transform duration-[var(--duration-fast)] ease-[var(--ease-standard)]', expanded && 'rotate-90')} />
        </span>
      </button>

      {expanded && (
        <div className="mb-3.5 mt-0.5 flex flex-col overflow-hidden rounded-lg bg-subtle px-3.5 py-1">
          {canReadUsage && (
            <>
              {loading && !usage ? (
                <div className="flex justify-center py-4"><Spinner /></div>
              ) : usage ? (
                <div className={cn('transition-opacity duration-[var(--duration-fast)]', loading && 'opacity-60')}>
                  <QuotaDetails usage={usage} maxModelMeters={4} />
                </div>
              ) : !error ? (
                <div className="flex items-center justify-between gap-4 py-2.5 text-xs">
                  <span className="text-fg-3"><Trans>额度</Trans></span>
                  <span className="tabular-nums text-fg-3">—</span>
                </div>
              ) : null}
              {error && (
                <div role="alert" className={cn('flex items-center justify-between gap-3 py-2.5', usage && 'edge-t')}>
                  <span className="min-w-0 break-words text-xs text-danger">{error}</span>
                  <Button type="button" size="xs" variant="secondary" disabled={loading} onClick={refresh}><Trans>重试</Trans></Button>
                </div>
              )}
            </>
          )}

          <button
            type="button"
            onClick={onOpenModels}
            className={cn(
              '-mx-3.5 flex min-h-10 items-center justify-between gap-3 px-3.5 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus max-md:min-h-11',
              canReadUsage && 'edge-t',
            )}
          >
            <span className="text-xs font-medium text-fg"><Trans>模型</Trans></span>
            <span className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-fg-3">
              <span>{modelCountLabel}</span>
              <IconChevronRight className="size-3.5 text-fg-4" />
            </span>
          </button>

          <div className="edge-t flex items-center justify-between gap-3 py-2">
            <span className="min-w-0 truncate text-xs text-fg-3">
              {canReadUsage
                ? fetched ?? (loading ? t`读取中…` : error ? t`读取失败` : '')
                : !plugin.enabled
                  ? t`插件已停用`
                  : ''}
            </span>
            <div className="flex shrink-0 items-center gap-1.5">
              {canReadUsage && (
                <Tip label={t`刷新额度`}>
                  <Button type="button" size="icon-xs" variant="quiet" aria-label={t`刷新额度`} busy={loading} onClick={refresh}>
                    <IconRefreshCw />
                  </Button>
                </Tip>
              )}
              <Button type="button" size="xs" variant="secondary" disabled={disabled} onClick={onEdit}>
                <Trans>编辑</Trans>
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ProviderModelsSubpage({ subpage, pluginEnabled, onBack }: {
  subpage: Extract<ModelSourceSubpage, { kind: 'models' }>;
  pluginEnabled: boolean;
  onBack: () => void;
}) {
  const { t } = useLingui();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [tick, setTick] = useState(0);
  const { usage } = useProviderUsage(subpage.backendId, subpage.profileId, { enabled: pluginEnabled && subpage.hasUsage });

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void api.backendCatalog(subpage.backendId, subpage.profileId, undefined, controller.signal, true)
      .then((entry) => {
        if (controller.signal.aborted) return;
        setModels(entry.available ? entry.models : []);
        if (!entry.available || entry.reason) setError(entry.reason ?? t`无法读取模型目录`);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(errorMessage(failure, t`无法读取模型目录`));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [subpage.backendId, subpage.profileId, tick]);

  const enabledSet = useMemo(
    () => subpage.enabledModels ? new Set(subpage.enabledModels) : undefined,
    [subpage.enabledModels],
  );
  const needle = query.trim().toLocaleLowerCase();
  const visible = useMemo(
    () => !needle ? models : models.filter((model) => model.name.toLocaleLowerCase().includes(needle) || model.value.toLocaleLowerCase().includes(needle)),
    [models, needle],
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex items-center gap-2">
        <Button type="button" size="icon-xs" variant="quiet" aria-label={t`返回`} onClick={onBack}>
          <IconArrowLeft />
        </Button>
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h3 className="truncate text-sm font-medium text-fg">{subpage.providerName}</h3>
          {!loading && models.length > 0 && <span className="shrink-0 text-xs tabular-nums text-fg-3"><Trans>{formatNumber(models.length)} 个模型</Trans></span>}
        </div>
        <Tip label={t`重新读取`}>
          <Button type="button" size="icon-xs" variant="quiet" aria-label={t`重新读取`} busy={loading} onClick={() => setTick((v) => v + 1)}>
            <IconRefreshCw />
          </Button>
        </Tip>
      </div>

      {models.length > PLUGIN_PAGE_BUDGET.filterThreshold && (
        <SearchField value={query} onChange={setQuery} placeholder={t`筛选模型`} aria-label={t`筛选模型`} />
      )}

      {error && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg bg-danger/5 px-3.5 py-2.5 text-xs text-danger">
          <span className="min-w-0 break-words">{error}</span>
          <Button type="button" size="xs" variant="secondary" disabled={loading} onClick={() => setTick((v) => v + 1)}><Trans>重试</Trans></Button>
        </div>
      )}

      {loading && models.length === 0 ? (
        <SettingsGroup loading><div /></SettingsGroup>
      ) : visible.length === 0 ? (
        <EmptyState title={needle ? t`没有匹配的模型` : t`没有可用模型`} />
      ) : (
        <SettingsGroup>
          {visible.map((model) => {
            const status = usage?.models[model.value] ?? model.aliases?.map((alias) => usage?.models[alias]).find(Boolean);
            const isEnabled = !enabledSet || enabledSet.has(model.value);
            const effort = effortRange(model);
            const contextText = model.contextWindow ? t`上下文 ${formatTokens(model.contextWindow)}` : undefined;
            const effortText = effort ? t`推理 ${effort}` : undefined;
            const modelQuotas = [status?.quota, status?.dailyQuota].filter((q): q is NonNullable<typeof q> => Boolean(q));
            const quotaLeft = modelQuotas.length
              ? Math.min(...modelQuotas.map((q) => q.depleted ? 0 : remainingPercent(q.usedPercent)))
              : undefined;
            const queueing = status?.loadPercent !== undefined && status.loadPercent > 100;

            return (
              <div key={model.value} className="flex items-center justify-between gap-4 py-3 max-md:flex-col max-md:items-stretch max-md:gap-2">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium text-fg">{cleanLabel(model.name)}</span>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-fg-3">
                    <span className="inline-flex min-w-0 max-w-full items-center gap-0.5">
                      <span className="truncate font-mono">{model.value}</span>
                      <CopyButton size="xs" text={model.value} label={t`复制模型 ID`} />
                    </span>
                    {contextText && <span>· {contextText}</span>}
                    {effortText && <span>· {effortText}</span>}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 max-md:justify-start">
                  {quotaLeft !== undefined && (
                    <span className={cn('text-xs font-medium tabular-nums', quotaTextClass(quotaLeft))}>
                      {quotaLeft <= 0 ? <Trans>已用尽</Trans> : <Trans>剩余 {formatNumber(quotaLeft)}%</Trans>}
                    </span>
                  )}
                  {queueing && <Badge className="font-normal text-warning"><Trans>排队中</Trans></Badge>}
                  {isEnabled && <Badge className="font-normal"><Trans>已启用</Trans></Badge>}
                </div>
              </div>
            );
          })}
        </SettingsGroup>
      )}
    </div>
  );
}

/**
 * The host-drawn `modelSources` section on a plugin's page (docs/design/system/plugins.md §6.3.1):
 * lists every provider on this server using the plugin's model sources, with expandable quota meters,
 * a Models subpage, and direct jumps to edit or add a provider in Settings.
 */
export function PluginModelSourceProviders({ plugin, subpage, disabled, onSubpageChange, onEditProvider, onAddProvider }: {
  plugin: PluginDescriptor;
  subpage?: ModelSourceSubpage;
  disabled?: boolean;
  onSubpageChange: (next: ModelSourceSubpage | undefined) => void;
  onEditProvider: (backendId: NativeBackendId, profileId: string) => void;
  onAddProvider: (modelSource: string, backendId?: NativeBackendId) => void;
}) {
  const { t, i18n } = useLingui();
  const backends = useCatalog((state) => state.backends);
  const nativeDefaults = useSettings((state) => state.nativeBackendDefaults);
  const settingsOpen = useUi((state) => state.settingsOpen);
  const sources = useMemo(() => pluginModelSources(plugin), [plugin]);
  const sourceById = useMemo(() => new Map(sources.map((item) => [item.id, item])), [sources]);
  const backendIds = useMemo(
    () => backends.filter((entry) => entry.backendId !== 'chat').map((entry) => entry.backendId),
    [backends],
  );
  const [profilesByBackend, setProfilesByBackend] = useState<Array<{ backendId: NativeBackendId; profiles: NativeBackendProfileSettings[] }>>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reloadTick, setReloadTick] = useState(0);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState('');
  const autoExpandedFor = useRef('');
  const wasSettingsOpen = useRef(settingsOpen);

  // Re-read provider list after closing Settings (e.g. user just added or edited a provider).
  useEffect(() => {
    const closed = wasSettingsOpen.current && !settingsOpen;
    wasSettingsOpen.current = settingsOpen;
    if (closed) setReloadTick((value) => value + 1);
  }, [settingsOpen]);

  useEffect(() => {
    if (!sources.length || !backendIds.length) {
      setProfilesByBackend([]);
      setLoading(false);
      setLoadError('');
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    void Promise.allSettled(
      backendIds.map(async (backendId) => ({
        backendId,
        profiles: (await api.backendProfiles(backendId, controller.signal)).profiles,
      })),
    ).then((results) => {
      if (controller.signal.aborted) return;
      const loaded: Array<{ backendId: NativeBackendId; profiles: NativeBackendProfileSettings[] }> = [];
      let failed = 0;
      for (const result of results) {
        if (result.status === 'fulfilled') loaded.push(result.value);
        else failed += 1;
      }
      setProfilesByBackend(loaded);
      if (failed > 0 && loaded.length === 0) setLoadError(t`无法加载提供商`);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [plugin.id, sources.length, backendIds.join(','), reloadTick]);

  const providers = useMemo<LinkedProvider[]>(() => {
    if (!profilesByBackend) return [];
    const matched: LinkedProvider[] = [];
    for (const { backendId, profiles } of profilesByBackend) {
      const defaultId = nativeDefaults?.[backendId]?.profileId ?? profiles.find((item) => item.isDefault)?.id;
      for (const profile of profiles) {
        if (!profile.modelSource) continue;
        const source = sourceById.get(profile.modelSource);
        if (!source) continue;
        matched.push({ backendId, profile, source, isDefault: profile.id === defaultId });
      }
    }
    return matched.sort((a, b) =>
      Number(b.isDefault) - Number(a.isDefault)
      || compareText(a.profile.name, b.profile.name)
      || compareText(backendLabel(a.backendId), backendLabel(b.backendId)));
  }, [profilesByBackend, nativeDefaults, sourceById]);

  const rowKey = (item: LinkedProvider) => `${item.backendId}:${item.profile.id}`;

  // Expand the first (default) provider automatically when opening this plugin so quota bars show right away.
  useEffect(() => {
    if (autoExpandedFor.current === plugin.id) return;
    if (loading || profilesByBackend === undefined) return;
    autoExpandedFor.current = plugin.id;
    setExpandedKey(providers.length > 0 ? rowKey(providers[0]!) : null);
  }, [plugin.id, loading, profilesByBackend, providers]);

  const primarySource = sources[0];
  const preferredAddBackend = useMemo(() => {
    if (!primarySource) return undefined;
    const match = backends.find((entry) => {
      if (entry.backendId === 'chat') return false;
      const consumes = entry.capabilities.consumesProtocols;
      if (consumes && primarySource.protocols) return primarySource.protocols.some((protocol) => consumes.includes(protocol));
      if (primarySource.backends) return primarySource.backends.includes(entry.backendId);
      return false;
    });
    return match?.backendId;
  }, [backends, primarySource]);

  const pluginName = localizedText(plugin.title, [i18n.locale]) ?? plugin.name;

  const openModels = useCallback((item: LinkedProvider, from?: 'all-providers') => {
    onSubpageChange({
      kind: 'models',
      backendId: item.backendId,
      profileId: item.profile.id,
      providerName: item.profile.name,
      enabledModels: item.profile.enabledModels ?? null,
      hasUsage: item.source.usage,
      ...(from ? { from } : {}),
    });
  }, [onSubpageChange]);

  if (!sources.length) return null;

  if (subpage?.kind === 'models') {
    return (
      <ProviderModelsSubpage
        subpage={subpage}
        pluginEnabled={plugin.enabled}
        onBack={() => onSubpageChange(subpage.from === 'all-providers' ? { kind: 'all-providers' } : undefined)}
      />
    );
  }

  if (subpage?.kind === 'all-providers') {
    const needle = filterQuery.trim().toLocaleLowerCase();
    const filtered = !needle ? providers : providers.filter((item) =>
      item.profile.name.toLocaleLowerCase().includes(needle)
      || backendLabel(item.backendId).toLocaleLowerCase().includes(needle)
      || (hostOf(item.profile, plugin, item.source) ?? '').toLocaleLowerCase().includes(needle));

    return (
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex items-center gap-2">
          <Button type="button" size="icon-xs" variant="quiet" aria-label={t`返回`} onClick={() => { setFilterQuery(''); onSubpageChange(undefined); }}>
            <IconArrowLeft />
          </Button>
          <h3 className="text-sm font-medium text-fg"><Trans context="plugin-providers-section">提供商</Trans></h3>
          {profilesByBackend !== undefined && (
            <span className="text-xs tabular-nums text-fg-3">{formatNumber(providers.length)}</span>
          )}
        </div>
        {providers.length > PLUGIN_PAGE_BUDGET.filterThreshold && (
          <SearchField value={filterQuery} onChange={setFilterQuery} placeholder={t`筛选提供商`} aria-label={t`筛选提供商`} />
        )}
        {loadError ? (
          <SettingsGroup>
            <div role="alert" className="flex items-center justify-between gap-3 py-4">
              <span className="min-w-0 break-words text-sm text-danger">{loadError}</span>
              <Button type="button" size="xs" variant="secondary" disabled={loading} onClick={() => setReloadTick((value) => value + 1)}><Trans>重试</Trans></Button>
            </div>
          </SettingsGroup>
        ) : loading && profilesByBackend === undefined ? (
          <SettingsGroup loading><div /></SettingsGroup>
        ) : filtered.length === 0 ? (
          <EmptyState title={t`没有匹配的提供商`} />
        ) : (
          <SettingsGroup>
            {filtered.map((item) => {
              const key = rowKey(item);
              return (
                <ProviderQuotaRow
                  key={key}
                  item={item}
                  plugin={plugin}
                  expanded={expandedKey === key}
                  disabled={disabled}
                  onToggle={() => setExpandedKey((current) => current === key ? null : key)}
                  onOpenModels={() => openModels(item, 'all-providers')}
                  onEdit={() => onEditProvider(item.backendId, item.profile.id)}
                />
              );
            })}
          </SettingsGroup>
        )}
      </div>
    );
  }

  const shown = providers.slice(0, PLUGIN_PAGE_BUDGET.summaryRows);
  const overflow = providers.length > PLUGIN_PAGE_BUDGET.summaryRows;
  const canAdd = Boolean(primarySource && plugin.enabled);

  return (
    <SettingsGroup
      title={t({ message: '提供商', context: 'plugin-providers-section' })}
      loading={loading && profilesByBackend === undefined}
      action={canAdd && providers.length > 0 ? (
        <Button type="button" size="xs" variant="ghost" disabled={disabled} onClick={() => onAddProvider(primarySource!.id, preferredAddBackend)}>
          <IconPlus />
          <Trans>添加</Trans>
        </Button>
      ) : undefined}
    >
      {loadError ? (
        <div role="alert" className="flex items-center justify-between gap-3 py-4">
          <span className="min-w-0 break-words text-sm text-danger">{loadError}</span>
          <Button type="button" size="xs" variant="secondary" disabled={loading} onClick={() => setReloadTick((value) => value + 1)}><Trans>重试</Trans></Button>
        </div>
      ) : providers.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <p className="text-sm text-fg-3"><Trans>还没有提供商使用 {pluginName}</Trans></p>
          {canAdd && (
            <Button type="button" size="sm" variant="secondary" disabled={disabled} onClick={() => onAddProvider(primarySource!.id, preferredAddBackend)}>
              <IconPlus />
              <Trans>添加提供商</Trans>
            </Button>
          )}
        </div>
      ) : (
        <>
          {shown.map((item) => {
            const key = rowKey(item);
            return (
              <ProviderQuotaRow
                key={key}
                item={item}
                plugin={plugin}
                expanded={expandedKey === key}
                disabled={disabled}
                onToggle={() => setExpandedKey((current) => current === key ? null : key)}
                onOpenModels={() => openModels(item)}
                onEdit={() => onEditProvider(item.backendId, item.profile.id)}
              />
            );
          })}
          {overflow && (
            <SettingsLinkRow
              title={t`全部 ${formatNumber(providers.length)} 个`}
              onClick={() => onSubpageChange({ kind: 'all-providers' })}
            />
          )}
        </>
      )}
    </SettingsGroup>
  );
}
