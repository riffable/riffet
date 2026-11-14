/**
 * Model providers, one list per CLI.
 *
 * A provider is where a CLI gets its models: either the CLI's own login, or a gateway addressed
 * by URL and key. The list shows one row per provider and opens one editor at a time, so the
 * page stays readable as providers accumulate. A session picks its provider when it is created
 * and keeps it, which is why removing one that sessions still use is refused rather than
 * silently redirected.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { AppSettings, CommandObservation, PluginAction, ModelContextWindows, ModelInfo, ModelInputModalities, ModelSourceDescriptor, NativeBackendId, NativeBackendProfileSettings, NativeBackendProfileSettingsUpdate, NativeCliVersion, NativeModelApiProtocol, NativeModelSource } from '@contracts';
import { AgentMark } from '@/components/agent-marks';
import { IconChevronRight, IconCircleAlert, IconPlus, IconRefreshCw, IconSave, IconTrash2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input, Select, Segmented, Spinner, StatusDot, Switch } from '@/components/ui/controls';
import { api, type ProjectRecord } from '@/lib/api';
import { backendLabel } from '@/lib/backends';
import { confirmDialog, useDiscardGuard } from '@/lib/dialogs';
import { loadPlugins, modelSourcesFor, usePlugins, type ModelSourceEntry } from '@/lib/plugins';
import { LEGACY_DEFAULT_BACKEND_ID } from '@/lib/legacy-identity';
import { catalogParams, parseSelection, serializeSelection } from '@/lib/models';
import { toast } from '@/lib/toast';
import { compareText } from '@/lib/i18n/format';
import { cleanLabel, cn, errorMessage } from '@/lib/utils';
import { settingsPagesOf } from '@/plugins/catalog';
import { useSettingsPages } from '@/plugins/registry';
import { ModelPicker } from '../session/ModelPicker';
import { useCatalog, useStores } from '../state/stores';
import { PluginFlowDialog } from '../plugins/PluginFlowDialog';
import { ProviderModelList } from './ProviderModelList';
import { SettingsGroup, SettingsLinkRow, SettingsRow } from './SettingsLayout';
import { DefaultApprovalSetting } from './DefaultApprovalSetting';

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
 * Per-CLI differences in what a provider may carry. Codex rejects a source directory and cannot
 * disable its own updater, so offering those controls would only produce save errors. Droid only
 * runs on its own Factory login, so it has no endpoint or config directory to point elsewhere.
 */
const extras: Partial<Record<NativeBackendId, { sourceDir?: boolean; autoUpdate?: boolean; endpoint?: false; configDir?: false }>> = {
  claude: { autoUpdate: true },
  dsh: { sourceDir: true },
  droid: { endpoint: false, configDir: false },
  traex: { endpoint: false },
  antigravity: { configDir: false },
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
 * `sources` is undefined until the plugins load; only then can a saved source be called
 * unavailable, which happens when the plugin providing it is off or not on this server.
 */
function summarize(profile: NativeBackendProfileSettings, sources: ModelSourceEntry[] | undefined): string {
  const source = profile.modelSource ? sources?.find((entry) => entry.source.id === profile.modelSource) : undefined;
  const where = profile.modelSource
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

/** Only a version outside the adapter's range is shown; an untested one still runs. */
function cliVersionNote(cliVersion: NativeCliVersion | undefined) {
  if (!cliVersion?.version || (cliVersion.status !== 'untested' && cliVersion.status !== 'too-old')) return undefined;
  const range = cliVersion.status === 'too-old' ? i18n._(msg`需要 ${cliVersion.minimum ?? ''} 或更高`) : i18n._(msg`已验证至 ${cliVersion.testedThrough ?? ''}`);
  return <span className="inline-flex items-center gap-1 text-warning" title={range}><IconCircleAlert className="size-3 shrink-0" aria-label={range} />{cliVersion.version}</span>;
}

export function BackendProfilesSection({ settings, project, onSaved, onRefresh, onDirtyChange, onBusyChange, onOpenPage, onError }: {
  settings: AppSettings;
  project?: ProjectRecord;
  onSaved: (settings: AppSettings, patch: Partial<AppSettings>) => void;
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
  const ids = useMemo(() => offered.map((entry) => entry.backendId), [offered]);
  const [backendId, setBackendId] = useState<NativeBackendId>(settings.defaultBackendId ?? ids[0] ?? LEGACY_DEFAULT_BACKEND_ID);
  useEffect(() => { if (ids.length && !ids.includes(backendId)) setBackendId(ids[0]!); }, [ids]);
  const cliVersion = useCatalog((state) => state.backends.find((entry) => entry.backendId === backendId)?.cliVersion);
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
  const [login, setLogin] = useState<{ pluginId: string; action: PluginAction }>();
  const [loginOpen, setLoginOpen] = useState(false);
  const plugins = usePlugins();
  const [observation, setObservation] = useState<{ backendId: string; state: CommandObservation['state'] }>();
  const [trusting, setTrusting] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setObservation(undefined);
    void api.commandObservation(backendId, controller.signal).then((result) => {
      if (!controller.signal.aborted) setObservation({ backendId, state: result.state });
    }).catch(() => {});
    return () => controller.abort();
  }, [backendId]);
  const trustObservation = async () => {
    setTrusting(true);
    try {
      const result = await api.trustCommandObservation(backendId);
      setObservation({ backendId, state: result.state });
    } catch (error) { onError(errorMessage(error, t`无法信任`)); }
    finally { setTrusting(false); }
  };
  const observationState = observation?.backendId === backendId ? observation.state : undefined;
  const catalogRequest = useRef<AbortController | undefined>(undefined);
  // An Agent whose plugin brings settings pages is configured there, in place of a provider list.
  const settingsPages = settingsPagesOf(plugins, useSettingsPages(), backendId);
  const ownPages = settingsPages.length > 0;

  const open = providers.find((item) => item.id === openId);
  const baseline = open ? editable(open) : undefined;
  const sourceChanged = Boolean(open && source !== (open.modelSource ?? (open.apiEndpoint ? 'custom' : 'login')));
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
    if (source === 'custom' && !draft.apiEndpoint?.trim()) return;
    const patch: Draft = { ...changedFields(open, draft), ...(backendId === 'antigravity' ? { apiProtocol: source === 'custom' ? 'google-generative-ai' as const : null } : {}), ...(apiKey ? { apiKey } : clearKey || sourceChanged ? { apiKey: null } : {}) };
    if (!Object.keys(patch).length) return;
    setSaving(true);
    try {
      const saved = await api.updateBackendProfile(backendId, open.id, patch);
      setProviders((current) => current.map((item) => item.id === saved.id ? { ...saved, isDefault: saved.isDefault ?? item.isDefault } : item));
      setDraft(editable(saved));
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
    if (!name || (choice === 'custom' && !adding.apiEndpoint.trim())) return;
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
      }, { defaultBackendId: backendId });
      await onRefresh();
    } catch (error) { onError(errorMessage(error, t`无法保存默认提供商`)); }
    finally { setSaving(false); }
  };

  const saveDefaultBackend = async (next: NativeBackendId) => {
    if (busy || next === settings.defaultBackendId) return;
    setSaving(true);
    try { await settingsStore.updateBackendDefaults(next, (current) => current ?? {}, { defaultBackendId: next }); }
    catch (error) { onError(errorMessage(error, t`无法保存默认 Agent`)); }
    finally { setSaving(false); }
  };

  const saveDefaultApproval = async (approval: string) => {
    if (busy || approval === (settings.nativeBackendDefaults?.[backendId]?.approval ?? '')) return;
    setSaving(true);
    try {
      await settingsStore.updateBackendDefaults(backendId, (current) => {
        const { approval: _previous, ...defaults } = current ?? {};
        return { ...defaults, ...(approval ? { approval } : {}) };
      });
    } catch (error) { onError(errorMessage(error, t`无法保存默认审批模式`)); }
    finally { setSaving(false); }
  };

  const editorCatalog = useMemo(() => draft.modelSource !== baseline?.modelSource || draft.apiEndpoint !== baseline?.apiEndpoint || draft.apiProtocol !== baseline?.apiProtocol ? [] : catalog,
    [draft.modelSource, draft.apiEndpoint, draft.apiProtocol, baseline?.modelSource, baseline?.apiEndpoint, baseline?.apiProtocol, catalog]);
  const { model: draftModel, params: draftParams } = parseSelection(draft.defaultModel ?? '');
  const modelParams = catalogParams(editorCatalog, draftModel, draftParams);
  const paramValues = (list: typeof modelParams) => Object.fromEntries(list.map((param) => [param.id, param.value]));
  const setModel = (defaultModel: string) => setDraft((current) => ({ ...current, defaultModel }));
  const enabled = draft.enabledModels ?? null;
  const pickable = enabled === null ? editorCatalog : editorCatalog.filter((model) => enabled.includes(model.value));

  const hint = endpointHints[backendId];
  const extra = extras[backendId] ?? {};
  const inputClass = 'h-8 w-full font-mono max-md:h-11';
  const sources = plugins ? modelSourcesFor(plugins, backendId, consumes) : undefined;
  const sourceEntry = (choice: SourceChoice) => sources?.find((entry) => entry.source.id === choice);
  /** What a choice lets the profile override: a custom API is all override; an unavailable source, nothing. */
  const overridable = (choice: SourceChoice): Overridable => choice === 'custom' ? anyField : choice === 'login' ? [] : sourceEntry(choice)?.source.overridable ?? [];
  const named = source === 'login' || source === 'custom' ? undefined : source;
  const namedEntry = named ? sourceEntry(named) : undefined;
  const openOverridable = overridable(source);
  const sourceHint = named ? namedEntry && t`地址留空则使用 ${namedEntry.source.label} 的默认地址` : hint?.hint;
  const choices = (keep?: NativeModelSource | null): Array<{ value: SourceChoice; label: string; disabled: boolean }> => [
    { value: 'login', label: t`CLI 自带登录` },
    ...(sources ?? []).map((entry) => ({ value: entry.source.id, label: entry.source.label })),
    // A saved source nothing provides stays visible, so the profile shows what it names and can move off it.
    ...(keep && !sourceEntry(keep) ? [{ value: keep, label: keep }] : []),
    { value: 'custom', label: t`自定义 API` },
  ].map((option) => ({ ...option, disabled: busy }));
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
      <SettingsGroup title={t`Agent`}>
        <SettingsRow title={t`默认 Agent`}>
          <Select<string> label={t`默认 Agent`} className="w-48" value={settings.defaultBackendId ?? ''} placeholder={t`未设置`} disabled={busy} onChange={(next) => void saveDefaultBackend(next as NativeBackendId)}
            // The saved default stays named while it is unavailable, just not offered again.
            options={offered.filter((entry) => entry.backendId !== 'chat' && (entry.available !== false || entry.backendId === settings.defaultBackendId)).map((entry) => ({ value: entry.backendId, label: shortLabel(entry.backendId), icon: <AgentMark backend={entry.backendId} size={14} />, disabled: entry.available === false }))} />
        </SettingsRow>
      </SettingsGroup>

      {/* What follows configures one Agent: its name heads the sections and switches between them. */}
      <div className="-mb-3 flex min-w-0 items-center gap-3">
        <Select<NativeBackendId>
          appearance="heading"
          label={t`配置的 Agent`}
          value={backendId}
          disabled={busy}
          onChange={(next) => void changeBackend(next)}
          options={ids.map((id) => ({ value: id, label: shortLabel(id), icon: <AgentMark backend={id} size={16} /> }))}
        />
        <span className="min-w-0 truncate text-xs">{cliVersionNote(cliVersion)}</span>
      </div>

      <SettingsGroup title={t`新会话`}>
        <DefaultApprovalSetting
          key={backendId}
          backendId={backendId}
          profileId={settings.nativeBackendDefaults?.[backendId]?.profileId}
          value={settings.nativeBackendDefaults?.[backendId]?.approval ?? ''}
          disabled={busy}
          onChange={(approval) => void saveDefaultApproval(approval)}
        />
        {observationState && observationState !== 'unsupported' && (
          <SettingsRow title={t`记录命令改动的文件`} description={observationState === 'untrusted' ? t`由 Codex 写入 ~/.codex/config.toml` : undefined}>
            {observationState === 'active' && <span className="text-sm text-fg-3"><Trans>已开启</Trans></span>}
            {observationState === 'inactive' && <span className="text-sm text-fg-3"><Trans>重启会话后生效</Trans></span>}
            {observationState === 'untrusted' && <Button size="sm" variant="secondary" disabled={busy || trusting} onClick={() => void trustObservation()}><Trans>信任</Trans></Button>}
          </SettingsRow>
        )}
      </SettingsGroup>

      {ownPages ? (
        <SettingsGroup title={backendLabel(backendId)}>
          {settingsPages.map((page) => <SettingsLinkRow key={page.id} title={page.title} onClick={() => onOpenPage(page.id)} />)}
        </SettingsGroup>
      ) : (
        <section className="flex flex-col">
          <div className="mb-1 flex h-7 items-center justify-between">
            <h3 className="text-xs font-medium text-fg-3"><Trans>模型提供商</Trans></h3>
            {!adding && extra.endpoint !== false && <Button size="xs" variant="ghost" disabled={busy || Boolean(loadError)} onClick={() => void leave().then((ok) => { if (ok) { setOpenId(''); setApiKey(''); setClearKey(false); setAdding({ name: '', source: 'custom', apiEndpoint: '', apiKey: '' }); } })}><IconPlus /><Trans>添加</Trans></Button>}
          </div>
          <div className="flex flex-col gap-2">
            {loading && <div className="flex justify-center rounded-xl border border-line bg-elevated py-6"><Spinner /></div>}
            {!loading && loadError && <div role="alert" className="flex items-center gap-3 rounded-xl border border-line bg-elevated px-4 py-4"><p className="flex-1 text-sm text-danger">{loadError}</p><Button size="sm" variant="secondary" onClick={() => setProfilesRequest((value) => value + 1)}><IconRefreshCw /><Trans>重试</Trans></Button></div>}
            {!loading && !loadError && providers.length === 0 && !adding && (
              <p className="rounded-xl border border-line bg-elevated px-4 py-6 text-center text-sm text-fg-3"><Trans>还没有提供商。</Trans></p>
            )}

            {providers.map((provider) => {
              const isOpen = provider.id === openId;
              return (
                <div key={provider.id} className={cn('rounded-xl border bg-elevated', isOpen ? 'border-line-strong' : 'border-line')}>
                  <button type="button" disabled={busy} onClick={() => void openProvider(provider.id)} className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left max-md:px-3">
                    <IconChevronRight className={cn('size-4 shrink-0 text-fg-3 transition-transform', isOpen && 'rotate-90')} />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 truncate text-sm font-medium text-fg">{provider.name}</span>
                        {provider.id === defaultProviderId && <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-2xs text-fg-2"><Trans>默认</Trans></span>}
                      </span>
                      <span className="min-w-0 truncate text-xs text-fg-3">{summarize(provider, sources)}</span>
                    </span>
                    {provider.apiEndpoint && !provider.hasApiKey && <StatusDot tone="idle" label={t`未配置 Key`} />}
                  </button>

                  {isOpen && (
                    <div className="flex flex-col edge-t [&>*+*]:edge-t px-4 max-md:px-3">
                      <SettingsRow title={t`名称`}>
                        <Input aria-label={t`名称`} className="h-8 w-64 max-md:h-11 max-md:w-full" value={draft.name ?? ''} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
                      </SettingsRow>
                      {extra.endpoint !== false && (
                        <SettingsRow title={t`来源`} description={named ? t`地址与凭据由服务器解析。` : undefined}>
                          <Segmented<SourceChoice>
                            size="xs"
                            className="max-md:[&_button]:min-h-11"
                            value={source}
                            ariaLabel={t`模型来源`}
                            onChange={(next) => {
                              if (next === source) return;
                              setSource(next);
                              setDraft((current) => ({ ...current, modelSource: next === 'login' || next === 'custom' ? null : next, apiEndpoint: '', defaultModel: '', enabledModels: null, modelInputModalities: {}, modelContextWindows: {} }));
                              setApiKey('');
                              setClearKey(true);
                            }}
                            options={choices(provider.modelSource)}
                          />
                        </SettingsRow>
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
                          <Input aria-label={t`服务地址`} className="h-8 w-64 font-mono max-md:h-11 max-md:w-full" value={draft.apiEndpoint ?? ''} disabled={busy} placeholder={named ? namedEntry?.source.defaultEndpoint ?? t`使用来源默认地址` : hint?.placeholder} onChange={(event) => setDraft((current) => ({ ...current, apiEndpoint: event.target.value }))} />
                        </SettingsRow>
                      )}
                      {openOverridable.includes('apiKey') && (named || draft.apiEndpoint) && (
                        <SettingsRow title="API Key" description={named ? t`可覆盖来源凭据；已存 Key 留空保留，清除后使用来源凭据` : t`仅保存到服务器；留空保留现有 Key，不会回显`}>
                          <div className="flex w-64 flex-col gap-1.5 max-md:w-full">
                            <Input aria-label="API Key" type="password" autoComplete="new-password" className="h-8 font-mono max-md:h-11" value={apiKey} disabled={busy} placeholder={provider.hasApiKey ? t`输入新 Key 替换现有值` : t`输入 API Key`} onChange={(event) => { setApiKey(event.target.value); setClearKey(false); }} />
                            <span className="inline-flex items-center gap-1.5 text-xs text-fg-3">
                              {(clearKey || !provider.hasApiKey) && <><StatusDot tone="idle" />{clearKey ? t`保存后清除已存 Key` : t`未配置 Key`}</>}
                              {provider.hasApiKey && !sourceChanged && <Button size="xs" variant="ghost" disabled={busy} onClick={() => { setApiKey(''); setClearKey((value) => !value); }}>{clearKey ? t({ message: '取消', context: 'settings-cancel-action' }) : t`清除`}</Button>}
                            </span>
                          </div>
                        </SettingsRow>
                      )}

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
                          clearKey={clearKey || sourceChanged}
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
                            onChange={(id) => setModel(serializeSelection(id, paramValues(catalogParams(catalog, id, {}))))}
                            onParamChange={(id, next) => setModel(serializeSelection(draftModel, { ...paramValues(modelParams), [id]: next }))}
                          />
                        </div>
                      </SettingsRow>

                      <details className="group py-1">
                        <summary className="flex cursor-pointer list-none items-center gap-2 py-2.5 text-sm text-fg-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [&::-webkit-details-marker]:hidden">
                          <IconChevronRight className="size-4 shrink-0 text-fg-3 transition-transform group-open:rotate-90" />
                          <Trans>启动设置</Trans>
                        </summary>
                        <div className="flex flex-col edge-t [&>*+*]:edge-t">
                          <SettingsRow title={t`CLI 入口`} description={t`留空沿用服务器启动环境中的 CLI`}>
                            <Input aria-label={t`CLI 入口`} className={cn(inputClass, 'md:w-64')} value={draft.executable ?? ''} disabled={busy} placeholder={backendId} onChange={(event) => setDraft((current) => ({ ...current, executable: event.target.value }))} />
                          </SettingsRow>
                          {extra.configDir !== false && (
                            <SettingsRow title={t`配置目录`} description={backendId === 'dsh' ? t`默认使用独立目录；更换后会切换配置与原生历史范围` : t`留空沿用 CLI 默认目录；更换后会切换账号与原生历史范围`}>
                              <Input aria-label={t`配置目录`} className={cn(inputClass, 'md:w-64')} value={draft.configDir ?? ''} disabled={busy} placeholder={backendId === 'dsh' ? t`~/.riffet/dsh（默认）` : t`使用 CLI 默认目录`} onChange={(event) => setDraft((current) => ({ ...current, configDir: event.target.value }))} />
                            </SettingsRow>
                          )}
                          {extra.sourceDir && (
                            <SettingsRow title={t`DSH 源码目录`} description={t`需要包含已构建 lib；也可使用已安装的 dsh 0.2.0-rc.2`}>
                              <Input aria-label={t`DSH 源码目录`} className={cn(inputClass, 'md:w-64')} value={draft.sourceDir ?? ''} disabled={busy} placeholder={t`可选源码 checkout`} onChange={(event) => setDraft((current) => ({ ...current, sourceDir: event.target.value }))} />
                            </SettingsRow>
                          )}
                          {extra.autoUpdate && (
                            <SettingsRow title={t`关闭自动更新`}>
                              <Switch aria-label={t`关闭自动更新`} checked={draft.disableAutoUpdate === true} disabled={busy} onCheckedChange={(value) => setDraft((current) => ({ ...current, disableAutoUpdate: value }))} />
                            </SettingsRow>
                          )}
                        </div>
                      </details>

                      <div className="flex items-center gap-2 py-3">
                        {provider.id === defaultProviderId
                          ? <span className="inline-flex items-center gap-1.5 text-xs text-fg-2"><StatusDot tone="success" /><Trans>新会话默认</Trans></span>
                          : <Button size="sm" variant="secondary" disabled={busy || dirty} onClick={() => void makeDefault(provider)}><Trans>设为默认</Trans></Button>}
                        <Button size="sm" variant="danger-ghost" disabled={busy} onClick={() => void remove(provider)}><IconTrash2 /><Trans context="settings-delete-action">删除</Trans></Button>
                        <Button size="sm" variant="primary" className="ml-auto" disabled={busy || !dirty || (source === 'custom' && !draft.apiEndpoint?.trim())} onClick={() => void save()}>{saving ? <Spinner /> : <IconSave />}<Trans>保存</Trans></Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {adding && (
              <div className="flex flex-col [&>*+*]:edge-t rounded-xl border border-line-strong bg-elevated px-4 max-md:px-3">
                <SettingsRow title={t`来源`} description={adding.source === 'login' || adding.source === 'custom' ? undefined : t`凭据由服务器解析。`}>
                  <Segmented<SourceChoice>
                    size="xs"
                    className="max-md:[&_button]:min-h-11"
                    value={adding.source}
                    ariaLabel={t`提供商来源`}
                    onChange={(value) => setAdding((current) => current && { ...current, source: value, apiEndpoint: '', apiKey: '' })}
                    options={choices()}
                  />
                </SettingsRow>
                <SettingsRow title={t`名称`}>
                  <Input autoFocus aria-label={t`名称`} className="h-8 w-64 max-md:h-11 max-md:w-full" value={adding.name} disabled={busy} placeholder={adding.source === 'custom' ? t`例如 公司网关` : shortLabel(backendId)} onChange={(event) => setAdding((current) => current && { ...current, name: event.target.value })} />
                </SettingsRow>
                {backendId === 'pi' && adding.source === 'custom' && (
                  <SettingsRow title="API">
                    <Select<string> label="API" className="w-64 max-md:w-full" value={adding.apiProtocol ?? 'openai-completions'} disabled={busy}
                      onChange={(next) => setAdding((current) => current && { ...current, apiProtocol: next as NativeModelApiProtocol })}
                      options={modelApis.map((protocol) => ({ value: protocol.value, label: protocol.label }))} />
                  </SettingsRow>
                )}
                {addingOverridable.includes('apiEndpoint') && (
                  <SettingsRow title={t`服务地址`} description={adding.source === 'custom' ? hint?.hint : addingEntry && t`留空则使用 ${addingEntry.source.label} 的默认地址`}>
                    <Input aria-label={t`服务地址`} className="h-8 w-64 font-mono max-md:h-11 max-md:w-full" value={adding.apiEndpoint} disabled={busy} placeholder={adding.source === 'custom' ? hint?.placeholder : addingEntry?.source.defaultEndpoint ?? t`使用来源默认地址`} onChange={(event) => setAdding((current) => current && { ...current, apiEndpoint: event.target.value })} />
                  </SettingsRow>
                )}
                {addingOverridable.includes('apiKey') && (
                  <SettingsRow title="API Key" description={adding.source === 'custom' ? t`仅保存到服务器，不会回显` : t`留空则使用服务器解析出的凭据`}>
                    <Input aria-label="API Key" type="password" autoComplete="new-password" className="h-8 w-64 font-mono max-md:h-11 max-md:w-full" value={adding.apiKey} disabled={busy} onChange={(event) => setAdding((current) => current && { ...current, apiKey: event.target.value })} />
                  </SettingsRow>
                )}
                {loginRow(addingEntry)}
                <div className="flex items-center gap-2 py-3">
                  <Button size="sm" variant="primary" disabled={busy || !adding.name.trim() || (adding.source === 'custom' && !adding.apiEndpoint.trim())} onClick={() => void create()}>{saving ? <Spinner /> : <IconPlus />}<Trans>添加</Trans></Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void leave().then((ok) => { if (ok) setAdding(undefined); })}><Trans context="settings-cancel-action">取消</Trans></Button>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

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
