import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { AppSettings, CommandObservation, ModelInfo, NativeBackendId, NativeBackendProfileSettings, NativeBackendProfileSettingsUpdate, Session } from '@contracts';
import { Notice } from '@/components/ui/notice';
import { AgentMark } from '@/components/agent-marks';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Input, Segmented, Select, Spinner, Switch, UnderlineTabs } from '@/components/ui/controls';
import { api } from '@/lib/api';
import { agentMarkStyle, backendLabel, backendSelection, sessionBackend } from '@/lib/backends';
import { useDiscardGuard } from '@/lib/dialogs';
import { LEGACY_DEFAULT_BACKEND_ID } from '@/lib/legacy-identity';
import { catalogParams, catalogSelection, contextChoices, isOn, optionLabel, paramKind, paramTitle, parseSelection, toggledValue, type ModelParam } from '@/lib/models';
import { loadPlugins, usePlugins } from '@/lib/plugins';
import { sessionActivityAt } from '@/lib/session-order';
import { errorMessage } from '@/lib/utils';
import { settingsPagesOf } from '@/plugins/catalog';
import { useSettingsPages } from '@/plugins/registry';
import { useCatalog, useLists, useStores } from '../state/stores';
import { DefaultApprovalSetting } from './DefaultApprovalSetting';
import { SettingsGroup, SettingsLinkRow, SettingsRow } from './SettingsLayout';

const launchFields = ['executable', 'configDir', 'sourceDir', 'disableAutoUpdate'] as const;
type LaunchDraft = Pick<NativeBackendProfileSettingsUpdate, typeof launchFields[number]>;
const launchDraft = (profile?: NativeBackendProfileSettings): LaunchDraft => ({
  executable: profile?.executable ?? '', configDir: profile?.configDir ?? '', sourceDir: profile?.sourceDir ?? '', disableAutoUpdate: profile?.disableAutoUpdate === true,
});

/** Agent behavior and launch settings. Existing per-profile launch identities remain separate. */
export function AgentSettingsSection({ settings, onRefresh, onDirtyChange, onBusyChange, onOpenPage, onError }: {
  settings: AppSettings;
  onRefresh: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onOpenPage: (id: string) => void;
  onError: (message: string) => void;
}) {
  const { t } = useLingui();
  const { settings: settingsStore } = useStores();
  const offered = useCatalog((state) => state.backends);
  const sessions = useLists((state) => state.sessions);
  const agentPanelId = useId();
  const [backendId, setBackendId] = useState<NativeBackendId>(settings.defaultBackendId ?? offered[0]?.backendId ?? LEGACY_DEFAULT_BACKEND_ID);
  const currentCatalog = offered.find((entry) => entry.backendId === backendId);
  const cliVersion = currentCatalog?.cliVersion;
  const profileFields = currentCatalog?.capabilities.profileFields;
  const executablePlaceholder = profileFields?.executablePlaceholder ?? (backendId === 'antigravity' ? 'agy' : backendId);
  const showConfigDir = profileFields ? profileFields.configDir === true : (backendId !== 'droid' && backendId !== 'antigravity');
  const sourceDirKind = profileFields !== undefined ? profileFields.sourceDir : (backendId === 'dsh' ? 'source' : backendId === 'antigravity' ? 'config' : undefined);
  const showDisableAutoUpdate = profileFields ? profileFields.disableAutoUpdate === true : (backendId === 'claude' || backendId === 'antigravity');
  const [profileReads, setProfileReads] = useState<Record<string, { profiles?: NativeBackendProfileSettings[]; loading: boolean; error: string }>>({});
  const profileRead = profileReads[backendId];
  const profiles = profileRead?.profiles ?? [];
  const loading = !profileRead || profileRead.loading;
  const error = profileRead?.error ?? '';
  const profilesPending = loading && !profileRead?.profiles;
  const [launchEdit, setLaunchEdit] = useState<{ scope: string; value: LaunchDraft }>();
  const [saving, setSaving] = useState(false);
  const [retry, setRetry] = useState(0);
  const [observations, setObservations] = useState<Partial<Record<string, CommandObservation['state']>>>({});
  const observation = observations[backendId];
  const plugins = usePlugins();
  const pages = settingsPagesOf(plugins, useSettingsPages(), backendId, 'agent');
  const ownPages = pages.length > 0;
  const scopedProfiles = profiles.filter((item) => item.backendId === backendId);
  const busy = loading || saving;
  const defaults = settings.nativeBackendDefaults?.[backendId];
  const implicitProfileId = scopedProfiles.find((item) => item.isDefault)?.id ?? scopedProfiles[0]?.id ?? '';
  const defaultProfileId = defaults?.profileId ?? implicitProfileId;
  const defaultProfile = scopedProfiles.find((item) => item.id === defaultProfileId);
  const profile = defaultProfile;
  const launchScope = `${backendId}:${defaultProfileId}`;
  const baseline = launchDraft(profile);
  const draft = launchEdit?.scope === launchScope ? launchEdit.value : baseline;
  const setDraft = (change: (current: LaunchDraft) => LaunchDraft) => setLaunchEdit({ scope: launchScope, value: change(draft) });
  const dirty = Boolean(profile && launchFields.some((field) => draft[field] !== baseline[field]));
  const { confirm: leave } = useDiscardGuard(dirty, saving);

  const modelScope = `${backendId}:${defaultProfileId}`;
  const [modelReads, setModelReads] = useState<Record<string, { models?: ModelInfo[]; defaultModel?: string; loading: boolean; error: string }>>({});
  const [modelRefresh, setModelRefresh] = useState(0);
  const modelState = modelReads[modelScope];
  const catalogDefaultProfileId = offered.find((entry) => entry.backendId === backendId)?.profiles.find((item) => item.isDefault)?.id ?? 'default';
  const recentModel = useMemo(() => {
    let latest: Session | undefined;
    for (const item of sessions) {
      if (!item.model || sessionBackend(item) !== backendId) continue;
      if ((item.backendProfileId ?? catalogDefaultProfileId) !== (defaultProfileId || catalogDefaultProfileId)) continue;
      if (!latest || Date.parse(sessionActivityAt(item)) > Date.parse(sessionActivityAt(latest))) latest = item;
    }
    return latest?.model;
  }, [sessions, backendId, defaultProfileId, catalogDefaultProfileId]);
  const selection = defaults?.model || recentModel
    || (backendId === LEGACY_DEFAULT_BACKEND_ID && (!defaultProfileId || defaultProfileId === 'default') ? settings.defaultModel : undefined)
    || modelState?.defaultModel || '';
  const catalog = modelState?.models ?? [];
  const selectedModel = parseSelection(backendSelection(backendId, catalog, selection));
  const modelLoading = Boolean(defaultProfile) && (!modelState || modelState.loading);
  const modelError = modelState?.error ?? '';
  const startupPending = profilesPending || (modelLoading && !modelState?.models);
  const modelDisabled = busy || modelLoading || Boolean(modelError) || !defaultProfile;
  const modelParams = catalogParams(catalog, selectedModel.model, selectedModel.params);
  const modelChoices = catalog.map((item) => ({ id: item.value, label: item.name }));
  // A temporarily incomplete catalog cannot erase a saved model or its parameter overrides.
  if (selectedModel.model && !modelChoices.some((item) => item.id === selectedModel.model)) modelChoices.push({ id: selectedModel.model, label: selectedModel.model });
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(saving); return () => onBusyChange(false); }, [saving, onBusyChange]);
  useEffect(() => { void loadPlugins().catch((failure) => onError(errorMessage(failure, t`无法读取插件`))); }, []);
  useEffect(() => {
    if (offered.length && !offered.some((item) => item.backendId === backendId)) setBackendId(offered[0]!.backendId);
  }, [offered, backendId]);
  useEffect(() => {
    const controller = new AbortController();
    setProfileReads((current) => ({ ...current, [backendId]: { profiles: current[backendId]?.profiles, loading: true, error: '' } }));
    void api.backendProfiles(backendId, controller.signal).then((result) => {
      if (!controller.signal.aborted) setProfileReads((current) => ({ ...current, [backendId]: { profiles: result.profiles, loading: false, error: '' } }));
    }).catch((failure) => {
      if (!controller.signal.aborted) setProfileReads((current) => ({ ...current, [backendId]: { profiles: current[backendId]?.profiles, loading: false, error: errorMessage(failure, t`无法加载启动设置`) } }));
    });
    return () => controller.abort();
  }, [backendId, retry]);
  useEffect(() => {
    const controller = new AbortController();
    if (!defaultProfile) return () => controller.abort();
    setModelReads((current) => ({ ...current, [modelScope]: { ...current[modelScope], loading: true, error: '' } }));
    void api.backendCatalog(backendId, defaultProfileId, undefined, controller.signal).then((entry) => {
      if (controller.signal.aborted) return;
      if (!entry.available || entry.reason) throw new Error(entry.reason || t`当前不可用`);
      setModelReads((current) => ({ ...current, [modelScope]: { models: entry.models, defaultModel: entry.defaultModel, loading: false, error: '' } }));
    }).catch((failure) => {
      if (!controller.signal.aborted) setModelReads((current) => ({ ...current, [modelScope]: { ...current[modelScope], loading: false, error: errorMessage(failure, t`无法读取模型`) } }));
    });
    return () => controller.abort();
  }, [backendId, defaultProfileId, Boolean(defaultProfile), modelRefresh]);
  useEffect(() => {
    const controller = new AbortController();
    void api.commandObservation(backendId, controller.signal).then((result) => {
      if (!controller.signal.aborted) setObservations((current) => ({ ...current, [backendId]: result.state }));
    }).catch(() => {
      if (!controller.signal.aborted) setObservations((current) => ({ ...current, [backendId]: current[backendId] ?? 'unsupported' }));
    });
    return () => controller.abort();
  }, [backendId]);
  const write = async (action: () => Promise<unknown>) => {
    setSaving(true);
    try { await action(); } catch (failure) { onError(errorMessage(failure, t`无法保存，请重试`)); }
    finally { setSaving(false); }
  };
  const saveDefaultModel = (model: string) => {
    if (modelDisabled || model === (defaults?.model ?? '')) return;
    void write(() => settingsStore.updateBackendDefaults(backendId, (current) => {
      if ((current?.profileId ?? implicitProfileId) !== defaultProfileId) return undefined;
      const { model: _model, ...rest } = current ?? {};
      return { ...rest, profileId: defaultProfileId, ...(model ? { model } : {}) };
    }));
  };
  const saveLaunch = () => write(async () => {
    if (!profile) return;
    const patch = Object.fromEntries(launchFields.filter((field) => draft[field] !== baseline[field]).map((field) => [field, draft[field]]));
    const saved = await api.updateBackendProfile(backendId, profile.id, { ...patch, name: profile.name });
    setProfileReads((current) => ({ ...current, [backendId]: {
      ...current[backendId]!, profiles: current[backendId]?.profiles?.map((item) => item.id === saved.id ? { ...saved, isDefault: saved.isDefault ?? item.isDefault } : item),
    } }));
    setModelRefresh((current) => current + 1);
    setLaunchEdit((current) => current?.scope === launchScope ? undefined : current);
    await onRefresh();
  });
  const agentOptions = offered.filter((entry) => entry.backendId !== 'chat').map((entry) => ({ value: entry.backendId, label: backendLabel(entry.backendId), icon: <AgentMark backend={entry.backendId} size={14} style={agentMarkStyle(entry.backendId)} /> }));
  return <div className="flex flex-col gap-6">
    <SettingsGroup>
      <SettingsRow title={t`默认 Agent`}>
        <Select<NativeBackendId | ''> label={t`默认 Agent`} className="w-48" value={settings.defaultBackendId ?? ''} placeholder={t`未设置`} disabled={saving} options={agentOptions.filter((item) => offered.find((entry) => entry.backendId === item.value)?.available !== false || item.value === settings.defaultBackendId).map((item) => ({ ...item, disabled: offered.find((entry) => entry.backendId === item.value)?.available === false }))}
          onChange={(next) => { if (next) void write(() => settingsStore.updateBackendDefaults(next, (current) => current ?? {}, { defaultBackendId: next })); }} />
      </SettingsRow>
    </SettingsGroup>
    <UnderlineTabs<NativeBackendId>
      scrollable className="h-11 shrink-0" ariaLabel={t`配置的 Agent`} value={backendId}
      options={agentOptions.map((option) => ({ ...option, icon: <AgentMark backend={option.value} size={16} style={agentMarkStyle(option.value)} />, disabled: saving, panelId: agentPanelId }))}
      onChange={(next) => { if (next !== backendId) void leave().then((ok) => { if (ok) { setLaunchEdit(undefined); setBackendId(next); } }); }} />
    <div id={agentPanelId} role="tabpanel" aria-label={backendLabel(backendId)} className="flex flex-col gap-6">
      {cliVersion?.version && <div className="flex flex-col gap-3">
        {cliVersion.status === 'too-old' && cliVersion.minimum && <Notice tone="warning">{t`需要 ${cliVersion.minimum} 或更高版本，当前版本可能无法正常运行`}</Notice>}
        <SettingsGroup>
          <SettingsRow title={t`CLI 版本`} description={cliVersion.status === 'untested' && cliVersion.testedThrough ? t`Riffet 只验证到 ${cliVersion.testedThrough}，会话异常时可先改用这个版本` : undefined}>
            <span className="text-sm text-fg-3">{cliVersion.version}</span>
          </SettingsRow>
        </SettingsGroup>
      </div>}
    <SettingsGroup title={t`启动设置`} loading={startupPending}>
      {error ? <SettingsRow title={error}><Button variant="secondary" size="sm" onClick={() => setRetry((value) => value + 1)}><Trans>重试</Trans></Button></SettingsRow> : scopedProfiles.length === 0 ? <p className="py-4 text-sm text-fg-3"><Trans>还没有提供商</Trans></p> : <>
        <SettingsRow title={t`默认提供商`}>
          <Select label={t`默认提供商`} className="w-64 max-md:w-full" value={defaultProfileId} disabled={busy} options={scopedProfiles.map((item) => ({ value: item.id, label: item.name }))}
            onChange={(next) => { if (next === defaultProfileId) return; void leave().then((ok) => { if (ok) void write(async () => {
              await settingsStore.updateBackendDefaults(backendId, (current) => { const { model: _model, ...rest } = current ?? {}; return { ...rest, profileId: next }; });
              setLaunchEdit(undefined);
              await onRefresh();
            }); }); }} />
        </SettingsRow>
        <SettingsRow title={t`默认模型`}>
          <Select label={t`默认模型`} className="w-64 max-md:w-full" value={defaults?.model ? selectedModel.model : ''} disabled={modelDisabled}
            options={[{ value: '', label: t`自动选择`, icon: modelLoading ? <Spinner /> : undefined }, ...modelChoices.map((item) => ({ value: item.id, label: item.label, icon: modelLoading ? <Spinner /> : undefined }))]}
            onChange={(model) => saveDefaultModel(model ? catalogSelection(catalog, model, model === selectedModel.model ? Object.fromEntries(modelParams.map((item) => [item.id, item.value])) : {}) : '')} />
        </SettingsRow>
        {modelError && <div role="alert" className="flex items-center gap-2 py-3"><span className="min-w-0 flex-1 text-xs text-danger">{modelError}</span><Button size="xs" variant="ghost" disabled={busy || modelLoading} onClick={() => setModelRefresh((current) => current + 1)}><Trans>重试</Trans></Button></div>}
        {modelParams.map((param) => <ModelParameterSetting key={`${modelScope}:${selectedModel.model}:${param.id}`} param={param} disabled={modelDisabled}
          onChange={(value) => saveDefaultModel(catalogSelection(catalog, selectedModel.model, { ...Object.fromEntries(modelParams.map((item) => [item.id, item.value])), [param.id]: value }, param.id))} />)}
      </>}
    </SettingsGroup>
    <SettingsGroup title={t`新会话`} loading={observation === undefined}>
      <DefaultApprovalSetting key={backendId} backendId={backendId} capabilities={offered.find((entry) => entry.backendId === backendId)?.capabilities} profileId={defaultProfileId} value={settings.nativeBackendDefaults?.[backendId]?.approval ?? ''} disabled={busy}
        onChange={(approval) => void write(() => settingsStore.updateBackendDefaults(backendId, (current) => {
          const { approval: _approval, ...rest } = current ?? {}; return { ...rest, ...(approval ? { approval } : {}) };
        }))} />
      {observation && observation !== 'unsupported' && <SettingsRow title={t`记录命令改动的文件`} description={observation === 'untrusted' ? t`由 Codex 写入 ~/.codex/config.toml` : undefined}>
        {observation === 'active' && <span className="text-sm text-fg-3"><Trans>已开启</Trans></span>}
        {observation === 'inactive' && <span className="text-sm text-fg-3"><Trans>重启会话后生效</Trans></span>}
        {observation === 'untrusted' && <Button size="sm" variant="secondary" busy={saving} onClick={() => void write(async () => { const result = await api.trustCommandObservation(backendId); setObservations((current) => ({ ...current, [backendId]: result.state })); })}><Trans>信任</Trans></Button>}
      </SettingsRow>}
    </SettingsGroup>
    {ownPages ? <SettingsGroup>{pages.map((page) => <SettingsLinkRow key={page.id} title={page.title} onClick={() => onOpenPage(page.id)} />)}</SettingsGroup> : <SettingsGroup title={t`高级启动配置`} loading={profilesPending}>
      {error ? <SettingsRow title={error}><Button variant="secondary" size="sm" onClick={() => setRetry((value) => value + 1)}><Trans>重试</Trans></Button></SettingsRow> : !profile ? <p className="py-4 text-sm text-fg-3"><Trans>还没有提供商</Trans></p> : <>
        <SettingsRow title={t`CLI 入口`} description={t`留空沿用服务器启动环境中的 CLI`}>
          <Input aria-label={t`CLI 入口`} className="h-8 w-64 font-mono max-md:w-full" value={draft.executable ?? ''} disabled={busy} placeholder={executablePlaceholder} onChange={(event) => setDraft((current) => ({ ...current, executable: event.target.value }))} />
        </SettingsRow>
        {showConfigDir && <SettingsRow title={t`配置目录`} description={t`更换后会切换账号与原生历史范围`}>
          <Input aria-label={t`配置目录`} className="h-8 w-64 font-mono max-md:w-full" value={draft.configDir ?? ''} disabled={busy} placeholder={t`使用 CLI 默认目录`} onChange={(event) => setDraft((current) => ({ ...current, configDir: event.target.value }))} />
        </SettingsRow>}
        {sourceDirKind === 'source' && <SettingsRow title={t`DSH 源码目录`}>
          <Input aria-label={t`DSH 源码目录`} className="h-8 w-64 font-mono max-md:w-full" value={draft.sourceDir ?? ''} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, sourceDir: event.target.value }))} />
        </SettingsRow>}
        {sourceDirKind === 'config' && <SettingsRow title={t`配置目录`} description={t`更换后会切换账号与原生历史范围`}>
          <Input aria-label={t`配置目录`} className="h-8 w-64 font-mono max-md:w-full" value={draft.sourceDir ?? ''} disabled={busy} placeholder={t`使用 CLI 默认目录`} onChange={(event) => setDraft((current) => ({ ...current, sourceDir: event.target.value }))} />
        </SettingsRow>}
        {showDisableAutoUpdate && <SettingsRow title={t`关闭自动更新`}><Checkbox aria-label={t`关闭自动更新`} disabled={busy} checked={draft.disableAutoUpdate === true} onCheckedChange={(value) => setDraft((current) => ({ ...current, disableAutoUpdate: value === true }))} /></SettingsRow>}
        <div className="flex justify-end py-3"><Button size="sm" busy={saving} disabled={!dirty} onClick={() => void saveLaunch()}><Trans>保存</Trans></Button></div>
      </>}
    </SettingsGroup>}
    </div>
  </div>;
}

/** Form parameters use the same semantics as the model menu, with settings-sized controls. */
export function ModelParameterSetting({ param, disabled, onChange }: { param: ModelParam; disabled?: boolean; onChange: (value: string) => void }) {
  const kind = paramKind(param);
  const title = paramTitle(param);
  const fallback = useRef<string | undefined>(undefined);
  if (kind === 'max' && !isOn(param)) fallback.current = param.value;
  const choice = (options: ModelParam['options'], label: string) => {
    const choices = options.map((option) => ({ value: option.value, label: optionLabel(param, option.value), disabled }));
    const compact = choices.length >= 2 && choices.length <= 4 && choices.every((item) => /^(?:[\p{Script=Han}]{1,4}|[\w.-]{1,10})$/u.test(item.label));
    return compact
      ? <Segmented size="xs" ariaLabel={label} value={param.value} options={choices} onChange={onChange} />
      : <Select label={label} className="w-64 max-md:w-full" value={param.value} disabled={disabled} options={choices} onChange={onChange} />;
  };
  if (kind === 'effort' || kind === 'select') return <SettingsRow title={title}>{choice(param.options, title)}</SettingsRow>;
  const windows = kind === 'max' ? contextChoices(param) : [];
  return <>
    <SettingsRow title={title}>
      <Switch aria-label={title} checked={isOn(param)} disabled={disabled} onCheckedChange={(checked) => onChange(toggledValue(param, checked, windows.some((item) => item.value === fallback.current) ? fallback.current : undefined))} />
    </SettingsRow>
    {kind === 'max' && !isOn(param) && windows.length > 1 && <SettingsRow title="Context">{choice(windows, 'Context')}</SettingsRow>}
  </>;
}
