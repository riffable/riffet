/**
 * Model providers, one list per Agent; Agent launch settings live in AgentSettingsSection.
 *
 * A provider is where a CLI gets its models: either the CLI's own login, or a gateway addressed
 * by URL and key. The list shows one row per provider and opens one editor at a time, so the
 * page stays readable as providers accumulate. A session picks its provider when it is created
 * and keeps it, which is why removing one that sessions still use is refused rather than
 * silently redirected.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { AppSettings, PluginAction, ModelContextWindows, ModelInfo, ModelInputModalities, ModelSourceDescriptor, NativeBackendId, NativeBackendProfileSettings, NativeBackendProfileSettingsUpdate, NativeModelApiProtocol, NativeModelSource, PluginDescriptor } from '@contracts';
import { AgentMark } from '@/components/agent-marks';
import { IconArrowLeft, IconChevronRight, IconPlus, IconRefreshCw, IconSave, IconTrash2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input, Select, Spinner, StatusDot, UnderlineTabs } from '@/components/ui/controls';
import { api, type ProjectRecord } from '@/lib/api';
import { agentMarkStyle, backendLabel, backendSelection } from '@/lib/backends';
import { confirmDialog, useDiscardGuard } from '@/lib/dialogs';
import { loadPlugins, modelSourcesFor, usePlugins, type ModelSourceEntry } from '@/lib/plugins';
import { LEGACY_DEFAULT_BACKEND_ID } from '@/lib/legacy-identity';
import { catalogParams, catalogSelection, parseSelection } from '@/lib/models';
import { toast } from '@/lib/toast';
import { compareText } from '@/lib/i18n/format';
import { cleanLabel, cn, errorMessage } from '@/lib/utils';
import { settingsPagesOf } from '@/plugins/catalog';
import { useSettingsPages } from '@/plugins/registry';
import { invalidateModelUsage, ModelPicker } from '../session/ModelPicker';
import { useCatalog, useStores } from '../state/stores';
import { PluginFlowDialog } from '../plugins/PluginFlowDialog';
import { ProviderModelList } from './ProviderModelList';
import { SettingsGroup, SettingsLinkRow, SettingsRow } from './SettingsLayout';
import { ProviderUsage } from './ProviderUsage';
import { ListRow } from '@/components/ui/list-row';

/** Scalar fields the editor writes. `enabledModels` is an array and is compared separately. */
const fields = ['name', 'executable', 'configDir', 'sourceDir', 'apiEndpoint', 'apiProtocol', 'defaultModel', 'disableAutoUpdate', 'modelSource'] as const;
const modelApis: Array<{ value: NativeModelApiProtocol; label: string }> = [
  { value: 'openai-completions', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'google-generative-ai', label: 'Google Gemini' },
];

/** A source an enabled plugin provides, and the two states that are not a source. */
type SourceChoice = NativeModelSource | 'login' | 'custom';
type Overridable = ModelSourceDescriptor['overridable'];
const anyField: Overridable = ['apiEndpoint', 'apiKey'];

/**
 * Agents that only use their own login do not offer a configurable API endpoint.
 */
const extras: Partial<Record<NativeBackendId, { endpoint?: false }>> = {
  droid: { endpoint: false },
  traex: { endpoint: false },
};

/**
 * Each CLI builds its request path differently: Claude appends `/v1/messages` to the base URL
 * while Codex appends directly, so the same gateway is written with and without the version
 * segment. Getting this wrong fails at the first turn rather than at save time.
 */
type EndpointHints = Partial<Record<NativeBackendId, { placeholder: string; hint: string }>>;

type Draft = NativeBackendProfileSettingsUpdate;
type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; count: number }
  | { kind: 'warn'; text: string }
  | { kind: 'error'; text: string };

const editable = (profile?: NativeBackendProfileSettings): Draft => ({
  name: profile?.name ?? '',
  executable: profile?.executable ?? '', configDir: profile?.configDir ?? '', sourceDir: profile?.sourceDir ?? '',
  apiEndpoint: profile?.apiEndpoint ?? '', defaultModel: profile?.defaultModel ?? '',
  apiProtocol: profile?.apiProtocol,
  disableAutoUpdate: profile?.disableAutoUpdate,
  enabledModels: profile?.enabledModels ?? null,
  modelInputModalities: profile?.modelInputModalities ?? {},
  modelContextWindows: profile?.modelContextWindows ?? {},
  modelSource: profile?.modelSource ?? null,
});

/** `null` means "every model" and differs from `[]`; the two must not collapse into one value. */
function sameModels(a: string[] | null | undefined, b: string[] | null | undefined): boolean {
  const left = a ?? null;
  const right = b ?? null;
  if (left === null || right === null) return left === right;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Declarations are order-free, so compare them by id and by the set of types behind each id. */
function sameInputs(a: ModelInputModalities | null | undefined, b: ModelInputModalities | null | undefined): boolean {
  const left = Object.entries(a ?? {}).map(([id, types]) => [id, [...types].sort().join(',')] as const).sort((x, y) => compareText(x[0], y[0]));
  const right = Object.entries(b ?? {}).map(([id, types]) => [id, [...types].sort().join(',')] as const).sort((x, y) => compareText(x[0], y[0]));
  return left.length === right.length && left.every((entry, index) => entry[0] === right[index]?.[0] && entry[1] === right[index]?.[1]);
}

/** Windows compare by id and token count; key order means nothing. */
function sameWindows(a: ModelContextWindows | null | undefined, b: ModelContextWindows | null | undefined): boolean {
  const left = Object.entries(a ?? {});
  return left.length === Object.keys(b ?? {}).length && left.every(([id, tokens]) => b?.[id] === tokens);
}

function changedFields(profile: NativeBackendProfileSettings, draft: Draft): Draft {
  const baseline = editable(profile);
  const patch: Record<string, unknown> = {};
  for (const key of fields) {
    if (draft[key] === baseline[key]) continue;
    // Text fields clear with an empty string; optional source/protocol enums clear with null.
    patch[key] = key === 'disableAutoUpdate' ? draft[key] === true : draft[key] ?? (key === 'modelSource' || key === 'apiProtocol' ? null : '');
  }
  if (!sameModels(draft.enabledModels, baseline.enabledModels)) patch.enabledModels = draft.enabledModels ?? null;
  // `null` drops every declaration, which is the only value that restores the backend's own answer.
  if (!sameInputs(draft.modelInputModalities, baseline.modelInputModalities)) {
    patch.modelInputModalities = Object.keys(draft.modelInputModalities ?? {}).length ? draft.modelInputModalities : null;
  }
  if (!sameWindows(draft.modelContextWindows, baseline.modelContextWindows)) {
    patch.modelContextWindows = Object.keys(draft.modelContextWindows ?? {}).length ? draft.modelContextWindows : null;
  }
  // A provider the CLI supplies has no stored record until its first save, and the server names a
  // new record after its id unless told otherwise. Always sending the name keeps the CLI's own
  // name instead of letting an unrelated edit rewrite it to something like `local`.
  if (Object.keys(patch).length) patch.name = draft.name;
  return patch as Draft;
}

/** The name the Agent switch and the provider lines use, shorter than the full one for two CLIs. */
function shortLabel(id: NativeBackendId): string {
  if (id === 'claude') return 'Claude';
  if (id === 'dsh') return 'DeepSeek';
  return backendLabel(id);
}

/**
 * Mirrors the server's `modelSourceOf`: a saved gateway adapter nothing provides runs as the profile's own API
 * connection. An uninstalled plugin leaves no declaration behind, so an unknown source falls back too.
 */
function runsAsApi(profile: Pick<NativeBackendProfileSettings, 'modelSource' | 'apiEndpoint'> | undefined, plugins: PluginDescriptor[] | undefined): boolean {
  if (!plugins || !profile?.modelSource || !profile.apiEndpoint?.trim()) return false;
  const declared = plugins.flatMap((plugin) => plugin.contributes.modelSources ?? []).find((item) => item.id === profile.modelSource);
  return !declared || declared.role === 'adapter';
}

/**
 * `sources` is undefined until the plugins load; only then can a saved source be called
 * unavailable, which happens when the plugin providing it is off or not on this server.
 */
function summarize(profile: NativeBackendProfileSettings, sources: ModelSourceEntry[] | undefined, plugins: PluginDescriptor[] | undefined): string {
  const source = profile.modelSource ? sources?.find((entry) => entry.source.id === profile.modelSource) : undefined;
  const where = profile.modelSource && !(!source && runsAsApi(profile, plugins))
    ? source?.source.label ?? (sources ? `${profile.modelSource} · ${i18n._(msg`不可用`)}` : profile.modelSource)
    : profile.apiEndpoint || i18n._(msg`${shortLabel(profile.backendId)} CLI 自带登录`);
  const models = profile.enabledModels ? i18n._(msg`${profile.enabledModels.length} 个模型`) : i18n._(msg`全部模型`);
  return `${where} · ${models}`;
}

function StatusLine({ status }: { status: Status }) {
  const { t } = useLingui();
  if (status.kind === 'loading') return <span className="inline-flex items-center gap-2 text-xs text-fg-3"><Spinner /><Trans>读取中…</Trans></span>;
  if (status.kind === 'idle') return <span className="text-xs text-fg-3"><Trans>尚未检测</Trans></span>;
  // Available is the normal state: the model count is what is left to say.
  if (status.kind === 'ok') return <span role="status" className="text-xs text-fg-3"><Trans>{status.count} 个模型</Trans></span>;
  const tone = status.kind === 'warn' ? 'warning' : 'danger';
  const text = status.text;
  return <span role="status" className="inline-flex min-w-0 items-start gap-1.5 text-xs text-fg-2" title={text}><StatusDot tone={tone} className="mt-1 shrink-0" /><span className="min-w-0 break-words">{text}</span></span>;
}

export function BackendProfilesSection({ settings, project, onRefresh, onDirtyChange, onBusyChange, onOpenPage, onError }: {
  settings: AppSettings;
  project?: ProjectRecord;
  onRefresh: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  /** Opens a settings page a plugin contributes. */
  onOpenPage: (pageId: string) => void;
  onError: (message: string) => void;
}) {
  const { t } = useLingui();
  const endpointHints: EndpointHints = {
    claude: { placeholder: 'https://gateway.example.com', hint: t`需兼容 Anthropic Messages API，地址不要带 /v1` },
    codex: { placeholder: 'https://gateway.example.com/v1', hint: t`需兼容 OpenAI Responses API，地址要带 /v1` },
    dsh: { placeholder: 'https://api.deepseek.com', hint: t`需兼容 DeepSeek 接口` },
  };
  // Writes to the per-backend defaults go through the settings store's queue, which builds each one from the latest defaults.
  const { settings: settingsStore } = useStores();
  // Only the Agents the server offers now: one whose plugin is off is not listed.
  const offered = useCatalog((state) => state.backends);
  const ids = useMemo(() => offered.filter((entry) => entry.backendId !== 'chat').map((entry) => entry.backendId), [offered]);
  const providerPanelId = useId();
  const [backendId, setBackendId] = useState<NativeBackendId>(settings.defaultBackendId ?? ids[0] ?? LEGACY_DEFAULT_BACKEND_ID);
  useEffect(() => { if (ids.length && !ids.includes(backendId)) setBackendId(ids[0]!); }, [ids]);
  const consumes = useCatalog((state) => state.backends.find((entry) => entry.backendId === backendId)?.capabilities.consumesProtocols);
  const [providers, setProviders] = useState<NativeBackendProfileSettings[]>([]);
  const [openId, setOpenId] = useState('');
  const [draft, setDraft] = useState<Draft>({});
  const [source, setSource] = useState<SourceChoice>('login');
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [adding, setAdding] = useState<{ name: string; source: SourceChoice; apiEndpoint: string; apiKey: string; apiProtocol?: NativeModelApiProtocol }>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [profilesRequest, setProfilesRequest] = useState(0);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [catalog, setCatalog] = useState<ModelInfo[]>([]);
  const [reload, setReload] = useState(0);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [login, setLogin] = useState<{ pluginId: string; action: PluginAction }>();
  const [loginOpen, setLoginOpen] = useState(false);
  const plugins = usePlugins();
  const catalogRequest = useRef<AbortController | undefined>(undefined);
  // An Agent whose plugin brings settings pages is configured there, in place of a provider list.
  const settingsPages = settingsPagesOf(plugins, useSettingsPages(), backendId, 'providers');
  const ownPages = settingsPages.length > 0;

  const open = providers.find((item) => item.id === openId);
  const baseline = open ? editable(open) : undefined;
  const dirty = Boolean(open && baseline && (fields.some((key) => draft[key] !== baseline[key])
    || !sameModels(draft.enabledModels, baseline.enabledModels)
    || !sameInputs(draft.modelInputModalities, baseline.modelInputModalities)
    || !sameWindows(draft.modelContextWindows, baseline.modelContextWindows))) || Boolean(apiKey) || clearKey
    || Boolean(adding && (adding.name || adding.apiEndpoint || adding.apiKey || adding.source !== 'login'));
  const defaultProviderId = settings.nativeBackendDefaults?.[backendId]?.profileId ?? providers.find((item) => item.isDefault)?.id;
  const busy = saving || loading;

  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    onBusyChange(saving);
    return () => onBusyChange(false);
  }, [saving, onBusyChange]);
  // Once per visit: the sources come from the plugins, which the settings dialog also reads on opening.
  useEffect(() => { void loadPlugins().catch((error) => onError(errorMessage(error, t`无法读取插件`))); }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    setProviders([]);
    setOpenId('');
    setAdding(undefined);
    setApiKey('');
    setClearKey(false);
    setSource('login');
    if (ownPages) {
      setLoading(false);
      return () => controller.abort();
    }
    void api.backendProfiles(backendId, controller.signal).then((result) => {
      if (!controller.signal.aborted) setProviders(result.profiles);
    }).catch((error) => { if (!controller.signal.aborted) setLoadError(errorMessage(error, t`无法加载模型提供商`)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [backendId, profilesRequest, ownPages]);

  // Only the open provider is checked. The catalog reflects saved settings and reloads after a
  // save, so the editor never needs a button the user has to remember to press.
  useEffect(() => {
    catalogRequest.current?.abort();
    setCatalog([]);
    if (!openId || ownPages) { setStatus({ kind: 'idle' }); return; }
    const controller = new AbortController();
    catalogRequest.current = controller;
    setStatus({ kind: 'loading' });
    void api.backendCatalog(backendId, openId, project?.id, controller.signal, true).then((entry) => {
      if (controller.signal.aborted) return;
      setCatalog(entry.available ? entry.models : []);
      setStatus(!entry.available
        ? { kind: 'error', text: entry.reason ?? t`当前不可用` }
        : entry.reason ? { kind: 'warn', text: t`CLI 可用，但读取模型失败：${entry.reason}` } : { kind: 'ok', count: entry.models.length });
    }).catch((error) => { if (!controller.signal.aborted) setStatus({ kind: 'error', text: errorMessage(error, t`检测失败`) }); });
    return () => controller.abort();
  }, [backendId, openId, project?.id, reload]);

  const { confirm: leave } = useDiscardGuard(dirty);

  const openProvider = async (id: string) => {
    if (busy) return;
    if (id === openId) { if (await leave()) { setOpenId(''); setApiKey(''); setClearKey(false); } return; }
    if (!(await leave())) return;
    setOpenId(id);
    const profile = providers.find((item) => item.id === id);
    setDraft(editable(profile));
    setSource(profile?.modelSource ?? (profile?.apiEndpoint ? 'custom' : 'login'));
    setApiKey('');
    setClearKey(false);
    setAdding(undefined);
  };

  const changeBackend = async (next: NativeBackendId) => {
    if (next === backendId || busy || !(await leave())) return;
    setBackendId(next);
  };

  const save = async () => {
    if (!open || busy) return;
    if (needsEndpoint) return;
    const patch: Draft = { ...changedFields(open, draft), ...(backendId === 'antigravity' ? { apiProtocol: source === 'custom' ? 'google-generative-ai' as const : null } : {}), ...(apiKey ? { apiKey } : clearKey || credentialsSourceChanged ? { apiKey: null } : {}) };
    if (!Object.keys(patch).length) return;
    setSaving(true);
    try {
      const saved = await api.updateBackendProfile(backendId, open.id, patch);
      setProviders((current) => current.map((item) => item.id === saved.id ? { ...saved, isDefault: saved.isDefault ?? item.isDefault } : item));
      setDraft(editable(saved));
      setConnectionRevision((value) => value + 1);
      if (['apiEndpoint', 'apiKey', 'modelSource', 'apiProtocol'].some((field) => field in patch)) invalidateModelUsage();
      setSource(saved.modelSource ?? (saved.apiEndpoint ? 'custom' : 'login'));
      setApiKey('');
      setClearKey(false);
      setReload((value) => value + 1);
      if (patch.defaultModel !== undefined) {
        // The server already moved this provider's default model; mirror it into the cached defaults.
        void settingsStore.syncBackendDefaults(backendId, (current) => {
          if (current?.model === undefined || (current.profileId ?? providers.find((item) => item.isDefault)?.id) !== saved.id) return undefined;
          const { model: _dropped, ...rest } = current;
          return saved.defaultModel ? { ...rest, model: saved.defaultModel } : rest;
        });
      }
      await onRefresh();
    } catch (error) { onError(errorMessage(error, t`无法保存，请检查输入后重试。`)); }
    finally { setSaving(false); }
  };

  const create = async () => {
    if (!adding || busy) return;
    const name = adding.name.trim();
    const choice: SourceChoice = adding.source;
    if (!name || (isApi(choice) && !adding.apiEndpoint.trim())) return;
    const custom = choice === 'custom';
    setSaving(true);
    try {
      const created = await api.createBackendProfile(backendId, {
        name,
        ...(choice !== 'login' && adding.apiEndpoint.trim() ? { apiEndpoint: adding.apiEndpoint.trim() } : {}),
        ...(choice !== 'login' && adding.apiKey ? { apiKey: adding.apiKey } : {}),
        ...(backendId === 'pi' && custom ? { apiProtocol: adding.apiProtocol ?? 'openai-completions' } : {}),
        ...(backendId === 'antigravity' && custom ? { apiProtocol: 'google-generative-ai' as const } : {}),
        ...(choice !== 'login' && !custom ? { modelSource: choice } : {}),
      });
      setProviders((current) => [...current, created]);
      setAdding(undefined);
      setOpenId(created.id);
      setDraft(editable(created));
      setSource(created.modelSource ?? (created.apiEndpoint ? 'custom' : 'login'));
      setApiKey('');
      setClearKey(false);
      await onRefresh();
    } catch (error) { onError(errorMessage(error, t`无法添加提供商`)); }
    finally { setSaving(false); }
  };

  const remove = async (provider: NativeBackendProfileSettings) => {
    if (busy) return;
    if (!await confirmDialog({ title: t`删除「${provider.name}」？`, description: t`保存的地址和 API Key 会一并删除。`, confirmLabel: t({ message: '删除', context: 'settings-delete-action' }), destructive: true })) return;
    setSaving(true);
    try {
      await api.deleteBackendProfile(backendId, provider.id);
      setProviders((current) => current.filter((item) => item.id !== provider.id));
      void settingsStore.syncBackendDefaults(backendId, (defaults) => {
        if (defaults?.profileId !== provider.id) return undefined;
        const { profileId: _removed, ...remaining } = defaults;
        return remaining;
      });
      setProfilesRequest((value) => value + 1);
      setOpenId('');
      setApiKey('');
      setClearKey(false);
      await onRefresh();
    } catch (error) { onError(errorMessage(error, t`无法删除提供商`)); }
    finally { setSaving(false); }
  };

  const makeDefault = async (provider: NativeBackendProfileSettings) => {
    if (busy) return;
    setSaving(true);
    try {
      // Only the model belongs to a provider: another gateway lists other models. The approval and
      // mode are this CLI's own new-session preferences, so they follow the switch.
      await settingsStore.updateBackendDefaults(backendId, (previous) => {
        const { model: _providerModel, ...shared } = previous ?? {};
        return { ...(previous?.profileId === provider.id ? previous : shared), profileId: provider.id };
      });
      await onRefresh();
    } catch (error) { onError(errorMessage(error, t`无法保存默认提供商`)); }
    finally { setSaving(false); }
  };

  const hint = endpointHints[backendId];
  const extra = extras[backendId] ?? {};
  const sources = plugins ? modelSourcesFor(plugins, backendId, consumes) : undefined;
  const sourceEntry = (choice: SourceChoice) => sources?.find((entry) => entry.source.id === choice);
  const knownSource = (choice: SourceChoice) => plugins?.flatMap((plugin) => plugin.contributes.modelSources ?? []).find((item) => item.id === choice);
  const isApi = (choice: SourceChoice) => choice === 'custom' || knownSource(choice)?.role === 'adapter' || (choice === open?.modelSource && runsAsApi(open, plugins));
  const savedSource = open?.modelSource ?? (open?.apiEndpoint ? 'custom' : 'login');
  const credentialsSourceChanged = source !== savedSource && !(isApi(source) && isApi(savedSource));
  const needsEndpoint = isApi(source) && !draft.apiEndpoint?.trim() && !(open?.modelSource === source && !open.apiEndpoint);
  const overridable = (choice: SourceChoice): Overridable => isApi(choice) ? anyField : choice === 'login' ? [] : sourceEntry(choice)?.source.overridable ?? [];
  const named = source === 'login' || source === 'custom' ? undefined : source;
  const namedEntry = named ? sourceEntry(named) : undefined;
  const openOverridable = overridable(source);
  const editorCatalog = useMemo(() => (draft.modelSource !== baseline?.modelSource && !(isApi(source) && isApi(savedSource))) || draft.apiEndpoint !== baseline?.apiEndpoint || draft.apiProtocol !== baseline?.apiProtocol ? [] : catalog,
    [draft.modelSource, draft.apiEndpoint, draft.apiProtocol, baseline?.modelSource, baseline?.apiEndpoint, baseline?.apiProtocol, catalog, source, savedSource, plugins]);
  const { model: draftModel, params: draftParams } = parseSelection(backendSelection(backendId, editorCatalog, draft.defaultModel ?? ''));
  const modelParams = catalogParams(editorCatalog, draftModel, draftParams);
  const paramValues = (list: typeof modelParams) => Object.fromEntries(list.map((param) => [param.id, param.value]));
  const setModel = (defaultModel: string) => setDraft((current) => ({ ...current, defaultModel }));
  const enabled = draft.enabledModels ?? null;
  const pickable = enabled === null ? editorCatalog : editorCatalog.filter((model) => enabled.includes(model.value));

  const sourceHint = source === 'custom' ? hint?.hint : !isApi(source) && namedEntry ? t`地址留空则使用 ${namedEntry.source.label} 的默认地址` : undefined;
  const choices = (keep?: NativeModelSource | null) => [
    { value: 'login', label: t`CLI 自带登录` },
    { value: 'custom', label: 'API' },
    ...(sources ?? []).filter((entry) => entry.source.role !== 'adapter').map((entry) => ({ value: entry.source.id, label: entry.source.label })),
    ...(keep && !isApi(keep) && !sourceEntry(keep) ? [{ value: keep, label: t`${keep} · 不可用` }] : []),
  ];
  const gatewayChoices = [{ value: 'custom', label: t`通用` }, ...(sources ?? []).filter((entry) => entry.source.role === 'adapter').map((entry) => ({ value: entry.source.id, label: entry.source.label })), ...(named && isApi(named) && !namedEntry ? [{ value: named, label: t`${knownSource(named)?.label ?? named} · 不可用` }] : [])];
  const changeSource = (next: SourceChoice) => {
    if (next === source) return;
    const preserve = isApi(source) && isApi(next);
    setSource(next);
    setDraft((current) => ({ ...current, modelSource: next === 'login' || next === 'custom' ? null : next,
      ...(!preserve ? { apiEndpoint: '', defaultModel: '', enabledModels: null, modelInputModalities: {}, modelContextWindows: {} } : {}) }));
    if (!preserve) { setApiKey(''); setClearKey(true); }
  };
  const startLogin = (entry: ModelSourceEntry | undefined) => {
    if (!entry?.login) return;
    setLogin({ pluginId: entry.pluginId, action: entry.login });
    setLoginOpen(true);
  };
  /** How to sign in to a source: its plugin's action, a command to run elsewhere, or both. */
  const loginRow = (entry: ModelSourceEntry | undefined) => (entry?.login || entry?.source.hint) && (
    <SettingsRow title={t`登录`} description={entry.source.hint?.text}>
      <div className="flex items-center gap-2">
        {entry.source.hint?.command && <span className="select-all font-mono text-xs text-fg-2">{entry.source.hint.command}</span>}
        {entry.login && <Button size="sm" variant="secondary" disabled={busy} onClick={() => startLogin(entry)}>{entry.login.label}</Button>}
      </div>
    </SettingsRow>
  );
  const addingEntry = adding ? sourceEntry(adding.source) : undefined;
  const addingOverridable = adding ? overridable(adding.source) : [];

  return (
    <div className="flex flex-col gap-6">
      <UnderlineTabs<NativeBackendId>
        scrollable
        className="h-11 shrink-0"
        ariaLabel={t`配置的 Agent`}
        value={backendId}
        onChange={(next) => void changeBackend(next)}
        options={ids.map((id) => ({ value: id, label: backendLabel(id), icon: <AgentMark backend={id} size={16} style={agentMarkStyle(id)} />, disabled: busy, panelId: providerPanelId }))}
      />
      <div id={providerPanelId} role="tabpanel" aria-label={backendLabel(backendId)}>
      {ownPages ? (
        <SettingsGroup title={backendLabel(backendId)}>
          {settingsPages.map((page) => <SettingsLinkRow key={page.id} title={page.title} onClick={() => onOpenPage(page.id)} />)}
        </SettingsGroup>
      ) : (
        <section className="flex flex-col">
          <div className="mb-1 flex h-7 items-center justify-between">
            <h3 className="text-xs font-medium text-fg-3"><Trans>模型提供商</Trans></h3>
            {!adding && !openId && extra.endpoint !== false && <Button size="xs" variant="ghost" disabled={busy || Boolean(loadError)} onClick={() => void leave().then((ok) => { if (ok) { setOpenId(''); setApiKey(''); setClearKey(false); setAdding({ name: '', source: 'custom', apiEndpoint: '', apiKey: '' }); } })}><IconPlus /><Trans>添加</Trans></Button>}
          </div>
          <div className="flex flex-col gap-2">
            {loading && <div className="flex justify-center rounded-xl border border-line bg-elevated py-6"><Spinner /></div>}
            {!loading && loadError && <div role="alert" className="flex items-center gap-3 rounded-xl border border-line bg-elevated px-4 py-4"><p className="flex-1 text-sm text-danger">{loadError}</p><Button size="sm" variant="secondary" onClick={() => setProfilesRequest((value) => value + 1)}><IconRefreshCw /><Trans>重试</Trans></Button></div>}
            {!loading && !loadError && providers.length === 0 && !adding && (
              <p className="rounded-xl border border-line bg-elevated px-4 py-6 text-center text-sm text-fg-3"><Trans>还没有提供商。</Trans></p>
            )}

            {providers.filter((provider) => !adding && (!openId || provider.id === openId)).map((provider) => {
              const isOpen = provider.id === openId;
              return (
                <div key={provider.id} className={cn('overflow-hidden rounded-xl border bg-elevated', isOpen ? 'border-line-strong' : 'border-line')}>
                  {!isOpen && <ListRow disabled={busy} className="min-h-16 rounded-none py-3 focus-visible:ring-inset" onClick={() => void openProvider(provider.id)} trailing={<IconChevronRight className="size-4 text-fg-3" />}>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex items-center gap-2 text-fg">
                        <span className="truncate">{provider.name}</span>
                        {provider.id === defaultProviderId && <span className="text-xs text-fg-3"><Trans>默认</Trans></span>}
                      </span>
                      <span className="truncate text-xs text-fg-3">{summarize(provider, sources, plugins)}</span>
                    </span>
                  </ListRow>}
                  {isOpen && <div className="flex items-center gap-2 px-4 py-3">
                    <Button size="icon-xs" variant="quiet" aria-label={t`返回模型提供商`} disabled={busy} onClick={() => void openProvider(provider.id)}><IconArrowLeft /></Button>
                    <span className="truncate text-sm font-medium">{provider.name}</span>
                  </div>}

                  {isOpen && (
                    <div className="flex flex-col edge-t [&>*+*]:edge-t px-4 max-md:px-3">
                      <SettingsRow title={t`名称`}>
                        <Input aria-label={t`名称`} className="h-8 w-64 max-md:h-11 max-md:w-full" value={draft.name ?? ''} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
                      </SettingsRow>
                      {extra.endpoint !== false && (
                        <>
                          <SettingsRow title={t`接入方式`}>
                            <Select label={t`接入方式`} value={isApi(source) ? 'custom' : source} options={choices(provider.modelSource)} disabled={busy || !plugins} onChange={(next) => { if (next !== (isApi(source) ? 'custom' : source)) changeSource(next); }} className="w-64 max-md:w-full" />
                          </SettingsRow>
                          {isApi(source) && <SettingsRow title={t`网关类型`}>
                            <Select label={t`网关类型`} value={source} options={gatewayChoices} disabled={busy || !plugins} onChange={changeSource} className="w-64 max-md:w-full" />
                          </SettingsRow>}
                          {named && !namedEntry && plugins && (isApi(named)
                            ? <p className="py-3 text-xs text-fg-3"><Trans>插件不可用，暂按通用网关连接</Trans></p>
                            : <p role="alert" className="py-3 text-xs text-danger"><Trans>提供此类型的插件不可用</Trans></p>)}
                        </>
                      )}
                      {backendId === 'pi' && source === 'custom' && (
                        <SettingsRow title="API">
                          <Select<string> label="API" className="w-64 max-md:w-full" value={draft.apiProtocol ?? 'openai-completions'} disabled={busy}
                            onChange={(next) => setDraft((current) => ({ ...current, apiProtocol: next as NativeModelApiProtocol }))}
                            options={modelApis.map((protocol) => ({ value: protocol.value, label: protocol.label }))} />
                        </SettingsRow>
                      )}
                      {extra.endpoint !== false && loginRow(namedEntry)}
                      {extra.endpoint !== false && openOverridable.includes('apiEndpoint') && (
                        <SettingsRow title={t`服务地址`} description={sourceHint}>
                          <Input aria-label={t`服务地址`} className="h-8 w-64 font-mono max-md:h-11 max-md:w-full" value={draft.apiEndpoint ?? ''} disabled={busy} placeholder={!isApi(source) && named ? namedEntry?.source.defaultEndpoint ?? t`使用来源默认地址` : hint?.placeholder} onChange={(event) => setDraft((current) => ({ ...current, apiEndpoint: event.target.value }))} />
                        </SettingsRow>
                      )}
                      {openOverridable.includes('apiKey') && (named || draft.apiEndpoint) && (
                        <SettingsRow title="API Key" description={!isApi(source) && named ? t`可覆盖来源凭据；已存 Key 留空保留，清除后使用来源凭据` : t`仅保存到服务器；留空保留现有 Key，不会回显`}>
                          <div className="flex w-64 flex-col gap-1.5 max-md:w-full">
                            <Input aria-label="API Key" type="password" autoComplete="new-password" className="h-8 font-mono max-md:h-11" value={apiKey} disabled={busy} placeholder={provider.hasApiKey ? t`输入新 Key 替换现有值` : t`输入 API Key`} onChange={(event) => { setApiKey(event.target.value); setClearKey(false); }} />
                            <span className="inline-flex items-center gap-1.5 text-xs text-fg-3">
                              {(clearKey || !provider.hasApiKey) && <><StatusDot tone="idle" />{clearKey ? t`保存后清除已存 Key` : t`未配置 Key`}</>}
                              {provider.hasApiKey && !credentialsSourceChanged && <Button size="xs" variant="ghost" disabled={busy} onClick={() => { setApiKey(''); setClearKey((value) => !value); }}>{clearKey ? t({ message: '取消', context: 'settings-cancel-action' }) : t`清除`}</Button>}
                            </span>
                          </div>
                        </SettingsRow>
                      )}

                      {sourceEntry(source)?.source.usage && (draft.modelSource === baseline?.modelSource && draft.apiEndpoint === baseline?.apiEndpoint && !apiKey && !clearKey
                        ? <ProviderUsage key={`${connectionRevision}:${JSON.stringify(provider)}`} backendId={backendId} profileId={provider.id} projectId={project?.id} />
                        : <SettingsRow title={t`额度`}><span className="text-xs text-fg-3"><Trans>保存后读取额度</Trans></span></SettingsRow>)}

                      <div className="flex flex-col gap-2 py-3.5">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm font-medium text-fg"><Trans>模型</Trans></span>
                          <div className="flex items-center gap-2">
                            <StatusLine status={status} />
                            <Button size="icon-xs" variant="ghost" aria-label={t`重新检测`} disabled={busy || status.kind === 'loading'} onClick={() => setReload((value) => value + 1)}><IconRefreshCw /></Button>
                          </div>
                        </div>
                        <ProviderModelList
                          backendId={backendId}
                          profileId={provider.id}
                          apiProtocol={backendId === 'antigravity' ? 'google-generative-ai' : backendId === 'pi' ? draft.apiProtocol ?? 'openai-completions' : undefined}
                          apiEndpoint={draft.apiEndpoint ?? ''}
                          apiKey={apiKey}
                          clearKey={clearKey || credentialsSourceChanged}
                          modelSource={draft.modelSource ?? undefined}
                          catalog={editorCatalog}
                          value={enabled}
                          disabled={busy}
                          onChange={(next) => setDraft((current) => ({ ...current, enabledModels: next }))}
                          // Only expose declarations consumed by the backend's provider configuration.
                          {...(backendId === 'dsh' || backendId === 'pi' && source === 'custom' ? {
                            inputs: draft.modelInputModalities ?? {},
                            onInputsChange: (next: ModelInputModalities) => setDraft((current) => ({ ...current, modelInputModalities: next })),
                          } : {})}
                          // Claude uses its context budget; custom pi providers register the declared window.
                          {...(backendId === 'claude' || backendId === 'pi' && source === 'custom' ? {
                            windows: draft.modelContextWindows ?? {},
                            savedWindows: baseline?.modelContextWindows ?? {},
                            onWindowsChange: (next: ModelContextWindows) => setDraft((current) => ({ ...current, modelContextWindows: next })),
                          } : {})}
                        />
                      </div>

                      <SettingsRow title={t`默认模型`} description={t`留空则沿用 CLI 自己的默认值。`}>
                        <div className="flex items-center gap-1 max-md:w-full">
                          {draft.defaultModel && <Button size="xs" variant="ghost" disabled={busy} onClick={() => setModel('')}><Trans>清除</Trans></Button>}
                          <ModelPicker
                            side="bottom"
                            placeholder={t`CLI 默认`}
                            className="h-8 rounded-lg border border-line-strong bg-elevated px-3 text-fg-2 max-md:min-w-0 max-md:flex-1"
                            models={pickable.map((item) => ({ id: item.value, label: cleanLabel(item.name) }))}
                            value={draftModel || undefined}
                            params={modelParams}
                            disabled={busy}
                            refreshCatalog={() => setReload((value) => value + 1)}
                            onChange={(id) => setModel(catalogSelection(editorCatalog, id))}
                            onParamChange={(id, next) => setModel(catalogSelection(editorCatalog, draftModel, { ...paramValues(modelParams), [id]: next }, id))}
                          />
                        </div>
                      </SettingsRow>

                      <div className="flex items-center gap-2 py-3">
                        {provider.id === defaultProviderId
                          ? <span className="inline-flex items-center gap-1.5 text-xs text-fg-2"><StatusDot tone="success" /><Trans>新会话默认</Trans></span>
                          : <Button size="sm" variant="secondary" disabled={busy || dirty} onClick={() => void makeDefault(provider)}><Trans>设为默认</Trans></Button>}
                        <Button size="sm" variant="danger-ghost" disabled={busy} onClick={() => void remove(provider)}><IconTrash2 /><Trans context="settings-delete-action">删除</Trans></Button>
                        <Button size="sm" variant="primary" className="ml-auto" disabled={loading || !dirty || !draft.name?.trim() || needsEndpoint} onClick={() => void save()} busy={saving}><IconSave /><Trans>保存</Trans></Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {adding && (
              <div className="flex flex-col overflow-hidden [&>*+*]:edge-t rounded-xl border border-line-strong bg-elevated px-4 max-md:px-3">
                <SettingsRow title={t`接入方式`}>
                  <Select label={t`接入方式`} value={isApi(adding.source) ? 'custom' : adding.source} options={choices()} disabled={busy || !plugins} className="w-64 max-md:w-full"
                    onChange={(value) => setAdding((current) => current && value !== (isApi(current.source) ? 'custom' : current.source) ? { ...current, source: value, apiEndpoint: '', apiKey: '' } : current)} />
                </SettingsRow>
                {isApi(adding.source) && <SettingsRow title={t`网关类型`}>
                  <Select label={t`网关类型`} value={adding.source} options={gatewayChoices} disabled={busy || !plugins} className="w-64 max-md:w-full"
                    onChange={(value) => setAdding((current) => current && { ...current, source: value })} />
                </SettingsRow>}
                <SettingsRow title={t`名称`}>
                  <Input autoFocus aria-label={t`名称`} className="h-8 w-64 max-md:h-11 max-md:w-full" value={adding.name} disabled={busy} placeholder={isApi(adding.source) ? t`例如 公司网关` : shortLabel(backendId)} onChange={(event) => setAdding((current) => current && { ...current, name: event.target.value })} />
                </SettingsRow>
                {backendId === 'pi' && adding.source === 'custom' && (
                  <SettingsRow title="API">
                    <Select<string> label="API" className="w-64 max-md:w-full" value={adding.apiProtocol ?? 'openai-completions'} disabled={busy}
                      onChange={(next) => setAdding((current) => current && { ...current, apiProtocol: next as NativeModelApiProtocol })}
                      options={modelApis.map((protocol) => ({ value: protocol.value, label: protocol.label }))} />
                  </SettingsRow>
                )}
                {addingOverridable.includes('apiEndpoint') && (
                  <SettingsRow title={t`服务地址`} description={adding.source === 'custom' ? hint?.hint : !isApi(adding.source) && addingEntry ? t`留空则使用 ${addingEntry.source.label} 的默认地址` : undefined}>
                    <Input aria-label={t`服务地址`} className="h-8 w-64 font-mono max-md:h-11 max-md:w-full" value={adding.apiEndpoint} disabled={busy} placeholder={isApi(adding.source) ? hint?.placeholder : addingEntry?.source.defaultEndpoint ?? t`使用来源默认地址`} onChange={(event) => setAdding((current) => current && { ...current, apiEndpoint: event.target.value })} />
                  </SettingsRow>
                )}
                {addingOverridable.includes('apiKey') && (
                  <SettingsRow title="API Key" description={isApi(adding.source) ? t`仅保存到服务器，不会回显` : t`留空则使用服务器解析出的凭据`}>
                    <Input aria-label="API Key" type="password" autoComplete="new-password" className="h-8 w-64 font-mono max-md:h-11 max-md:w-full" value={adding.apiKey} disabled={busy} onChange={(event) => setAdding((current) => current && { ...current, apiKey: event.target.value })} />
                  </SettingsRow>
                )}
                {loginRow(addingEntry)}
                <div className="flex items-center gap-2 py-3">
                  <Button size="sm" variant="primary" disabled={loading || !adding.name.trim() || (isApi(adding.source) && !adding.apiEndpoint.trim())} onClick={() => void create()} busy={saving}><IconPlus /><Trans>添加</Trans></Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void leave().then((ok) => { if (ok) setAdding(undefined); })}><Trans context="settings-cancel-action">取消</Trans></Button>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      </div>

      <PluginFlowDialog
        pluginId={login?.pluginId}
        action={login?.action}
        open={loginOpen}
        onOpenChange={setLoginOpen}
        onDone={() => { toast.success(t`已登录`); setReload((value) => value + 1); void loadPlugins().catch(() => undefined); }}
      />
    </div>
  );
}
