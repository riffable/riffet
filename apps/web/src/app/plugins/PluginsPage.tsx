import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { PluginDescriptor, PluginDiagnostic, PluginLogEntry, PluginGrantRequired, PluginMarketEntry, PluginMarketList, PluginUpdate, ViewDeclaration } from '@contracts';
import { IconEllipsis, IconRefreshCw, IconSettings2, IconSquareArrowOutUpRight, IconUpload } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { SearchField } from '@/components/ui/search-field';
import { Badge, EmptyState, Field, Input, Kbd, Select, Spinner, Switch, UnderlineTabs } from '@/components/ui/controls';
import { Tile, TileGrid } from '@/components/ui/tile';
import { Tip } from '@/components/ui/tooltip';
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api } from '@/lib/api';
import { syncAppearance } from '@/lib/appearance';
import { confirmDialog, useDiscardGuard } from '@/lib/dialogs';
import { HttpError } from '@/lib/errors';
import { localizedText, loadPlugins, refreshPlugins, reloadPlugins, replacePlugin, replacePlugins, usePlugins, usePluginRecovery } from '@/lib/plugins';
import { cn, errorMessage } from '@/lib/utils';
import { isApplePlatform } from '@/lib/platform';
import { keybindingCaps } from '../pluginKeybindings';
import { PluginView } from '@/plugins/PluginView';
import { satisfiesHostApi } from '@riffet/plugin-web';
import { PLUGIN_SOURCE_BUILTIN, PLUGIN_WEB_API_VERSION } from '@contracts';
import { useSettingsPages } from '@/plugins/registry';
import type { ViewEntry } from '@/plugins/catalog';
import { PageScaffold } from '../PageScaffold';
import type { PluginDetailTab } from '../state/navStore';
import { ExecutableNote, ModelSourceNote, PluginGrantDialog, capabilityLabel } from './PluginGrantDialog';
import { PluginVersionsDialog } from './PluginVersionsDialog';
import { PluginFlowDialog } from './PluginFlowDialog';
import { PluginMarket, sourceName } from './PluginMarket';
import { AddPluginSourceDialog, EnablePluginSource, PluginSourceMenu } from './PluginSources';
import { CapabilityFacts, PLUGIN_GROUPS, PluginMark, installedGroup, useGroupTitles } from './PluginMark';
import { ALL_SOURCES, PluginsAside, PluginsScopeMenu, sourceScope, type PluginScope } from './PluginsNav';
import { PluginPageView } from './PluginPageView';
import { Markdown } from '../session/Markdown';

/** `update`: a newer release of an installed package, installed in place without leaving the list. */
type InstallSource = { file: File } | { market: { source: string; id: string; version: string }; update?: boolean };
const keyOf = (plugin: PluginDescriptor) => (plugin.source ?? 'builtin') + ':' + plugin.id + (plugin.source === 'development' && plugin.developmentPath ? ':' + plugin.developmentPath : '');
const removable = (plugin: PluginDescriptor) => plugin.source === 'installed' ? Boolean(plugin.installed) : plugin.source === 'development' && Boolean(plugin.developmentPath);
const deviceFlows = (plugin: PluginDescriptor) => [...(plugin.declared?.actions ?? []), ...plugin.actions].some(action => action.kind === 'device-flow');
/** Whether the plugin has a page of its own: one it builds, its settings, a settings view for this client or a sign-in. */
const hasPage = (plugin: PluginDescriptor) => Boolean(plugin.declared?.page || plugin.settings.length || plugin.declared?.views?.some(view => view.locations.includes('settings') && view.clients.includes('web')) || deviceFlows(plugin));
/** The source an installed package came from, read from its install record (`market:<source>/<id>@<version>`; the older `market:<id>@<version>` is the built-in one). */
function originOf(plugin: PluginDescriptor): string | undefined {
  const record = plugin.installed?.versions.find(version => version.selected)?.source;
  const match = record?.match(/^market:(?:([^/@]+)\/)?[^/]+@/);
  return match ? match[1] ?? PLUGIN_SOURCE_BUILTIN : undefined;
}

/** Workbench-owned management. Reading this page never activates or probes a plugin. */
export function PluginsPage({ selectedId, selectedViewId, initialTab, openRevision, projectId, sessionId, onSelect, onClose, sidebarCollapsed, onOpenSidebar, onExpandSidebar, onBeforeLeaveChange, onOpenFeature, availableViewIds, commandActions, rejectedKeybindings, onOpenAppearance, onOpenModels }: {
  selectedId: string;
  selectedViewId?: string;
  initialTab?: PluginDetailTab;
  openRevision?: number;
  projectId?: string;
  sessionId?: string;
  onSelect(id: string, tab?: PluginDetailTab): void;
  onClose(): void;
  sidebarCollapsed: boolean;
  onOpenSidebar: () => void;
  onExpandSidebar: () => void;
  onBeforeLeaveChange(guard: (() => Promise<boolean>) | undefined): void;
  availableViewIds: string[];
  commandActions: Array<{ id: string; run: () => void }> ;
  rejectedKeybindings: ReadonlySet<string>;
  onOpenAppearance(): void;
  onOpenModels(): void;
  onOpenFeature(view: ViewDeclaration): void;
}) {
  const { t, i18n } = useLingui();
  const list = usePlugins();
  const recovery = usePluginRecovery();
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<PluginScope>('installed');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reachable, setReachable] = useState(navigator.onLine);
  const [grant, setGrant] = useState<{ source: InstallSource; request: PluginGrantRequired }>();
  const [market, setMarket] = useState<PluginMarketList>();
  const [marketError, setMarketError] = useState('');
  const [addingSource, setAddingSource] = useState(false);
  const [versions, setVersions] = useState(false);
  const [flow, setFlow] = useState<{ pluginId: string; action: PluginDescriptor['actions'][number] }>();
  const [draft, setDraft] = useState<Record<string, string | null>>({});
  const [baseline, setBaseline] = useState<PluginDescriptor>();
  const [diagnostics, setDiagnostics] = useState<PluginDiagnostic[]>([]);
  const [detailTab, setDetailTab] = useState<PluginDetailTab>('overview');
  const [readme, setReadme] = useState<{ key: string; text?: string }>();
  const [customView, setCustomView] = useState('');
  const [customDirty, setCustomDirty] = useState(false);
  const [customBusy, setCustomBusy] = useState(false);
  const [customRevision, setCustomRevision] = useState(0);
  const working = busy || customBusy;
  const fileInput = useRef<HTMLInputElement>(null);
  const operation = useRef(false);
  const detailNavigation = useRef(false);
  const editingPage = useRef<{ owner: string; entry: ViewEntry } | undefined>(undefined);
  const alive = useRef(true);
  const dirty = Object.keys(draft).length > 0 || customDirty;
  const currentSelected = list?.find(p => keyOf(p) === selectedId) ?? list?.find(p => p.id === selectedId && !p.rejected) ?? list?.find(p => p.id === selectedId);
  const sameEditor = baseline && (keyOf(baseline) === selectedId || baseline.id === selectedId);
  // A refresh may remove a plugin while its editor or operation is still open. Retain that
  // context until the user closes it, including a completed operation's result or error.
  const selected = sameEditor && (dirty || working || !currentSelected) ? baseline : currentSelected;
  const missing = Boolean(selected && (!currentSelected || keyOf(currentSelected) !== keyOf(selected)));
  const unavailable = missing || currentSelected?.rejected === true;
  const { confirm, close } = useDiscardGuard(dirty, working);
  const guard = useCallback(async () => {
    if (!await confirm()) return false;
    // A contributed form owns its draft. Remount it after discarding, including when
    // the destination keeps the same plugin page mounted (reread or a cancelled file picker).
    if (customDirty) setCustomRevision(value => value + 1);
    setDraft({}); setCustomDirty(false); return true;
  }, [confirm, customDirty]);
  useEffect(() => { onBeforeLeaveChange(guard); return () => onBeforeLeaveChange(undefined); }, [guard, onBeforeLeaveChange]);
  useEffect(() => {
    alive.current = true;
    void loadPlugins().then(() => { if (alive.current) setReachable(true); }).catch(e => { if (alive.current) { setReachable(false); setError(errorMessage(e, t({ message: '无法读取插件' }))); } });
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    const offline = () => setReachable(false);
    const online = () => { void loadPlugins().then(() => { if (alive.current) setReachable(true); }).catch(() => {}); };
    window.addEventListener('offline', offline); window.addEventListener('online', online);
    return () => { window.removeEventListener('offline', offline); window.removeEventListener('online', online); };
  }, []);
  useEffect(() => {
    if (!selectedId) setBaseline(undefined);
    else if (!dirty && !working && currentSelected) setBaseline(currentSelected);
  }, [currentSelected, selectedId, dirty, working]);
  useEffect(() => { setDetailTab(selectedViewId ? 'page' : initialTab ?? 'overview'); setCustomView(selectedViewId ?? ''); }, [selectedId, selectedViewId, initialTab, openRevision]);
  const settingsPages = useSettingsPages();
  const pages = settingsPages.filter(p => p.id.startsWith((selected?.id ?? '\u0000') + '/'));
  const settingsViews = selected?.declared?.views?.filter(view => view.locations.includes('settings') && view.clients.includes('web')) ?? [];
  const pageTitle = (p: PluginDescriptor) => localizedText(p.declared?.page?.title, [i18n.locale]) ?? t({ message: '设置', context: 'plugin-detail-tab' });
  // The plugin's own page comes first; without one, its settings as a form.
  const configurationOptions = [...(selected?.declared?.page ? [{ value: '', label: pageTitle(selected) }] : selected?.settings.length ? [{ value: '', label: t({ message: '通用', context: 'plugin-configuration' }) }] : []), ...settingsViews.map(view => ({ value: view.id, label: localizedText(view.title, [i18n.locale]) ?? view.id }))];
  const configurationId = configurationOptions.some(option => option.value === customView) ? customView : configurationOptions[0]?.value;
  const livePage = pages.find(p => p.id === configurationId);
  const keepPage = Boolean(dirty || working) && editingPage.current?.owner === (selected && keyOf(selected)) && editingPage.current?.entry.id === configurationId;
  const page = keepPage ? editingPage.current?.entry : livePage;
  if (!keepPage) editingPage.current = selected && livePage ? { owner: keyOf(selected), entry: livePage } : undefined;
  const configurationUnavailable = unavailable || !currentSelected?.enabled || !livePage || livePage.unavailable;
  const pageService = useMemo(() => ({ setDirty: setCustomDirty, setBusy: setCustomBusy }), []);
  const label = (p: PluginDescriptor) => localizedText(p.title, [i18n.locale]) ?? p.name;
  const status = (p: PluginDescriptor) => p.stopping ? t({ message: '等待任务结束' }) : p.status?.state === 'unavailable' || p.rejected ? t({ message: '不可用' }) : p.status?.state === 'attention' ? t({ message: '异常' }) : p.enabled ? t({ message: '已启用' }) : t({ message: '已停用' });
  const source = (p: PluginDescriptor) => p.source === 'installed' ? t({ message: '已安装' }) : p.source === 'development' ? t({ message: '开发包' }) : t({ message: '内置' });
  const attention = (p: PluginDescriptor) => Boolean(p.rejected || p.stopping || p.status && p.status.state !== 'ready');
  // An update is offered only by the source a package was installed from.
  const offers = new Map((market?.plugins ?? []).filter(entry => entry.installed?.sameSource && entry.update).map(entry => [entry.id, entry]));
  const updateOf = (p: PluginDescriptor) => { const entry = p.source === 'installed' ? offers.get(p.id) : undefined; return entry && originOf(p) === entry.sourceId ? entry : undefined; };
  const visible = (list ?? []).filter(p => (p === selected && (dirty || working)) || (!query || (label(p) + ' ' + p.id + ' ' + p.vendor).toLocaleLowerCase().includes(query.toLocaleLowerCase())) && (scope === 'updates' ? Boolean(updateOf(p)) : scope === 'attention' ? attention(p) : true));
  const changed = async () => { await reloadPlugins(); if (alive.current) setReachable(true); await syncAppearance(); };
  const run = async (action: () => Promise<unknown>) => {
    if (operation.current || customBusy) return;
    operation.current = true; setBusy(true); setError('');
    try { await action(); await changed(); }
    catch (e) { if (alive.current) { if (!(e instanceof HttpError)) setReachable(false); setError(errorMessage(e, t({ message: '操作失败' }))); } }
    finally { operation.current = false; if (alive.current) setBusy(false); }
  };
  const select = async (p: PluginDescriptor, tab: PluginDetailTab = 'overview') => { if (await guard()) { if (!visible.includes(p)) { setQuery(''); setScope('installed'); } setDetailTab(tab); setCustomView(''); setDiagnostics([]); setVersions(false); setBaseline(p); onSelect(keyOf(p), tab); } };
  const navigateDetail = async (change: () => void) => {
    if (detailNavigation.current) return;
    detailNavigation.current = true;
    try { if (await guard()) change(); }
    finally { detailNavigation.current = false; }
  };
  const closeSettings = () => close(() => { setDraft({}); setCustomDirty(false); setCustomView(''); setVersions(false); onSelect(''); });
  const update = (patch: PluginUpdate, target = selected) => target && list?.some(plugin => keyOf(plugin) === keyOf(target) && !plugin.rejected) && run(async () => { replacePlugin(await api.updatePlugin(target.id, patch)); });
  const install = async (source: InstallSource, capabilities?: string[], trusted = false) => {
    if (operation.current || customBusy) return;
    await run(async () => {
      try {
        const installed = 'file' in source ? await api.installPlugin(source.file, capabilities, trusted) : await api.installMarketPlugin(source.market.source, source.market.id, source.market.version, capabilities ?? [], trusted);
        setGrant(undefined);
        if (!('market' in source && source.update)) { setQuery(''); setScope('installed'); onSelect(keyOf(installed)); }
      } catch (e) {
        if (e instanceof HttpError && (e.code === 'PLUGIN_GRANT_REQUIRED' || e.code === 'PLUGIN_TRUST_REQUIRED') && e.details && typeof e.details === 'object' && 'capabilities' in e.details) {
          setGrant({ source, request: e.details as PluginGrantRequired });
        } else { setGrant(undefined); throw e; }
      }
    });
  };
  const sources = market?.sources;
  const enabledSources = (sources ?? []).filter(source => source.enabled);
  // Only the newest read or source change lands: an older read finishing later would undo it.
  const marketRevision = useRef(0);
  const applyMarket = (value: PluginMarketList) => { marketRevision.current++; setMarket(value); setMarketError(''); };
  const loadMarket = async (refresh = false) => {
    const revision = ++marketRevision.current;
    setMarketError('');
    try { const value = await api.marketPlugins(refresh); if (alive.current && revision === marketRevision.current) setMarket(value); }
    catch (e) { if (alive.current && revision === marketRevision.current) setMarketError(errorMessage(e, '')); }
  };
  // Read on arrival: the contents count each source's plugins and the installed ones with updates.
  useEffect(() => { void loadMarket(); }, []);
  // The market marks what is installed as of its read: a change to the installed list reads it again.
  const installedKey = (list ?? []).map(plugin => `${plugin.id}@${plugin.installed?.selected ?? plugin.version ?? ''}`).sort().join('\n');
  // The first list to arrive is the one the read on arrival already reflects.
  const seenInstalled = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!list || seenInstalled.current === installedKey) return;
    const first = seenInstalled.current === undefined;
    seenInstalled.current = installedKey;
    if (first) return;
    void loadMarket();
  }, [installedKey]);
  // A package that asks for nothing installs like an upload that asks for nothing; anything else is confirmed first.
  const installFromMarket = (entry: PluginMarketEntry) => {
    const source = { market: { source: entry.sourceId, id: entry.id, version: entry.version }, update: Boolean(entry.installed?.sameSource && entry.update) };
    if (!entry.capabilities.length && !entry.trustedRequired) void install(source, []);
    else setGrant({ source, request: { id: entry.id, version: entry.version, capabilities: entry.capabilities, ...(entry.modelSources ? { modelSources: entry.modelSources } : {}), ...(entry.trustedRequired ? { trustedRequired: true } : {}), trustedAllowed: market?.trustedAllowed ?? false } });
  };
  const chooseInstall = async () => { if (await guard()) fileInput.current?.click(); };
  const remove = async () => {
    const target = selected;
    if (!target || working || missing || !removable(target) || !await guard()) return;
    if (!await confirmDialog({
      title: t({ message: '卸载插件？' }),
      description: target.source === 'development' ? t({ message: '源目录、设置和数据会保留' }) : t({ message: '设置和数据会保留' }),
      confirmLabel: t({ message: '卸载插件' }),
      destructive: true,
    })) return;
    await run(async () => {
      const result = await api.uninstallPlugin(target.id, target.source as 'installed' | 'development', target.developmentPath);
      replacePlugins(result.integrations);
      setVersions(false); setFlow(undefined); setCustomView(''); setDiagnostics([]); setBaseline(undefined);
      onSelect('');
    });
  };
  const save = () => selected && baseline && !unavailable && run(async () => {
    const saved = await api.updatePlugin(selected.id, { settings: draft, ...(baseline.configRevision ? { configRevision: baseline.configRevision } : {}) });
    replacePlugin(saved); setBaseline(saved); setDraft({});
  });
  const [logs, setLogs] = useState<PluginLogEntry[]>([]);
  useEffect(() => setLogs([]), [selected?.id]);
  // The README is read once per plugin and language while the dialog is open; a failure shows the description instead.
  const readmeKey = selected && !selected.rejected ? selected.id + '\u0000' + i18n.locale : undefined;
  useEffect(() => {
    if (!readmeKey || readme?.key === readmeKey) return;
    const controller = new AbortController();
    void api.pluginReadme(selected!.id, i18n.locale, controller.signal).then(answer => setReadme({ key: readmeKey, text: answer.readme }), () => { if (!controller.signal.aborted) setReadme({ key: readmeKey }); });
    return () => controller.abort();
  }, [readmeKey]);
  const readmeText = readme?.key === readmeKey ? readme?.text : undefined;
  const readmeLoading = Boolean(readmeKey) && readme?.key !== readmeKey;
  const declarations = selected?.declared;
  const pluginActions = [...new Map([...(declarations?.actions ?? []), ...(selected?.actions ?? [])].map(action => [action.id, action])).values()];
  const groupTitles = useGroupTitles();
  const errorNotice = error && <div role="alert" className="flex items-center gap-3 rounded-lg bg-danger/5 p-3 text-sm text-danger"><span className="min-w-0 flex-1 break-words">{error}</span><Button size="xs" variant="secondary" disabled={working} onClick={() => void guard().then(ok => { if (ok) void run(reloadPlugins); })}><Trans>重新读取</Trans></Button></div>;
  const featureGroups = [
    { title: 'Agent', names: declarations?.agentBackends?.map(value => localizedText(value.title, [i18n.locale]) ?? value.id) ?? [] },
    { title: t({ message: '模型源', context: 'plugin-feature' }), names: declarations?.modelSources?.map(value => localizedText(value.title, [i18n.locale]) ?? value.id) ?? selected?.contributes.modelSources?.map(value => value.label) ?? [] },
    { title: t({ message: '任务', context: 'plugin-feature' }), names: declarations?.tasks?.map(value => localizedText(value.title, [i18n.locale]) ?? value.id) ?? [] },
    { title: t({ message: '分享', context: 'plugin-feature' }), names: declarations?.sharePublisher ? [localizedText(declarations.sharePublisher.title, [i18n.locale]) ?? selected!.name] : selected?.contributes.sharePublisher ? [selected.contributes.sharePublisher.label] : [] },
  ].filter(group => group.names.length > 0);
  const hasFeatureActions = Boolean(declarations?.views?.some(view => !view.locations.includes('settings')) || declarations?.commands?.length || declarations?.appearance || pluginActions.some(action => action.kind !== 'device-flow'));
  const overview = selected && <div className="flex min-w-0 flex-col gap-5">
    {readmeText ? <Markdown className="min-w-0 text-sm" text={readmeText} />
      : readmeLoading ? <div className="flex justify-center p-6"><Spinner /></div>
      : selected.description && <p className="whitespace-pre-wrap break-words text-sm text-fg-2">{localizedText(selected.description, [i18n.locale])}</p>}
    {featureGroups.map(group => <section key={group.title} className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-fg-3">{group.title}</h3>
      <div className="flex flex-wrap gap-2">{group.names.map((name, index) => <Badge key={index} className="h-auto min-h-5 whitespace-normal py-1">{name}</Badge>)}</div>
    </section>)}
    {hasFeatureActions && <div className="flex flex-wrap gap-2">
      {declarations?.views?.filter(view => !view.locations.includes('settings')).map(view => <Button key={view.id} size="sm" variant="secondary" disabled={missing || !selected.enabled || Boolean(selected.stopping) || !availableViewIds.includes(view.id) || view.instances === 'per-session' && !sessionId || view.instances === 'per-project' && !projectId} onClick={() => onOpenFeature(view)}>{localizedText(view.title, [i18n.locale])}<IconSquareArrowOutUpRight /></Button>)}
      {declarations?.commands?.map(command => <Button key={command.id} size="sm" variant="secondary" disabled={missing || !commandActions.some(action => action.id === 'plugin:' + command.id) || working} onClick={() => commandActions.find(action => action.id === 'plugin:' + command.id)?.run()}>{localizedText(command.title, [i18n.locale])}{command.keybinding && <Tip label={rejectedKeybindings.has(command.id) ? t`快捷键未生效` : ''}><span className={cn('flex items-center gap-0.5', rejectedKeybindings.has(command.id) && 'opacity-50 line-through')}>{keybindingCaps(command.keybinding, isApplePlatform).map(cap => <Kbd key={cap}>{cap}</Kbd>)}</span></Tip>}</Button>)}
      {((declarations?.modelSources?.length ?? selected.contributes.modelSources?.length) || declarations?.agentBackends?.length) ? <Button size="sm" variant="secondary" disabled={missing} onClick={onOpenModels}><Trans>模型与 Agent</Trans><IconSquareArrowOutUpRight /></Button> : null}
      {declarations?.appearance && <Button size="sm" variant="secondary" disabled={missing} onClick={onOpenAppearance}><Trans>选择外观</Trans><IconSquareArrowOutUpRight /></Button>}
      {pluginActions.filter(action => action.kind !== 'device-flow').map(action => <Button key={action.id} size="sm" variant="secondary" disabled={missing || working || !selected.enabled || Boolean(selected.stopping) || !selected.actions.some(value => value.id === action.id)} onClick={() => setFlow({ pluginId: selected.id, action })}>{action.label}</Button>)}
    </div>}
  </div>;
  const configuration = selected && <div className="flex min-w-0 flex-col gap-5">
    {/* The plugin decides how many pages it has: a heading switcher, not a segmented row (patterns.md §3). */}
    {configurationOptions.length > 1 && <Select appearance="heading" label={t({ message: '配置', context: 'plugin-detail-tab' })} value={configurationId ?? ''} disabled={working} onChange={value => { if (value !== configurationId) void navigateDetail(() => setCustomView(value)); }} options={configurationOptions} />}
      {configurationId === '' && selected.declared?.page && (!selected.enabled || missing
        ? <div className="flex flex-col items-start gap-3 text-sm text-fg-3"><p><Trans>启用插件后可用</Trans></p>{!missing && <Button size="sm" variant="secondary" disabled={working || dirty || !reachable || selected.rejected || Boolean(selected.stopping)} onClick={() => void update({ enablement: 'on' })}><Trans>启用插件</Trans></Button>}</div>
        : <PluginPageView key={selected.id} pluginId={selected.id} disabled={working || !reachable} onChanged={() => { void reloadPlugins().catch(() => undefined); }} />)}
      {configurationId === '' && !selected.declared?.page && selected.settings.length > 0 && <form onSubmit={e => { e.preventDefault(); void save(); }} className="flex flex-col gap-4">
        {selected.settings.map(field => <Field key={field.key} label={field.label}>
          <div className="flex items-center gap-2"><Input type={field.kind === 'secret' ? 'password' : 'text'} autoComplete="off" disabled={working} readOnly={unavailable} value={draft[field.key] ?? (Object.hasOwn(draft, field.key) ? '' : baseline?.settings.find(f => f.key === field.key)?.value ?? '')} placeholder={field.kind === 'secret' && field.set ? t({ message: '已设置' }) : undefined} onChange={e => setDraft(value => ({ ...value, [field.key]: e.target.value }))} />{field.kind === 'secret' && field.set && <Button type="button" size="xs" variant="secondary" disabled={working || unavailable} onClick={() => setDraft(value => ({ ...value, [field.key]: null }))}><Trans>清除</Trans></Button>}</div>
        </Field>)}
        <div className="flex gap-2"><Button type="submit" size="sm" disabled={working || unavailable || !reachable || Object.keys(draft).length === 0}><Trans>保存</Trans></Button><Button type="button" size="sm" variant="secondary" disabled={working || Object.keys(draft).length === 0} onClick={() => { setDraft({}); setBaseline(selected); }}><Trans>取消</Trans></Button></div>
      </form>}

    {configurationId && (!selected.enabled && !keepPage
      ? <div className="flex flex-col items-start gap-3 text-sm text-fg-3"><p><Trans>启用插件后可打开专用配置</Trans></p><Button size="sm" variant="secondary" disabled={working || dirty || missing || !reachable || selected.rejected || Boolean(selected.stopping)} onClick={() => void update({ enablement: 'on' })}><Trans>启用插件</Trans></Button></div>
      : page ? <fieldset className="min-w-0" disabled={busy || configurationUnavailable}><PluginView key={customRevision} entry={page} projectId={projectId} sessionId={sessionId} settingsPage={pageService} /></fieldset>
      : <EmptyState title={t({ message: '此配置在当前客户端不可用' })} />)}
    {pluginActions.filter(action => action.kind === 'device-flow').map(action => <Button key={action.id} className="self-start" size="sm" variant="secondary" disabled={missing || working || !selected.enabled || Boolean(selected.stopping) || !selected.actions.some(value => value.id === action.id)} onClick={() => setFlow({ pluginId: selected.id, action })}>{action.label}</Button>)}
    {configurationOptions.length === 0 && !pluginActions.some(action => action.kind === 'device-flow') && <EmptyState title={t({ message: '没有可配置项' })} />}
  </div>;
  const managementContent = selected && <div className="flex min-w-0 flex-col gap-5">
    {selected.source === 'installed' || selected.source === 'development'
      ? <Button className="self-start" size="sm" variant="danger" disabled={working || dirty || missing || !reachable || !removable(selected)} onClick={() => void remove()}><Trans>卸载插件</Trans></Button>
      : <p className="text-xs text-fg-3"><Trans>内置插件不可卸载</Trans></p>}
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
        <div className="min-w-0"><dt className="text-xs text-fg-3"><Trans>发布者</Trans></dt><dd className="mt-1 break-words text-sm">{selected.vendor}</dd></div>
        {(selected.version || selected.installed) && <div className="min-w-0"><dt className="text-xs text-fg-3"><Trans context="plugin-version-label">版本</Trans></dt><dd className="mt-1 flex flex-wrap items-center gap-2 text-sm"><span>{selected.version}</span>{selected.installed && <Button size="xs" variant="secondary" disabled={working || dirty || missing || !reachable} onClick={() => setVersions(true)}><Trans>版本</Trans></Button>}</dd></div>}
        <div className="min-w-0"><dt className="text-xs text-fg-3"><Trans>来源</Trans></dt><dd className="mt-1 text-sm">{source(selected)}</dd></div>
        <div className="min-w-0"><dt className="text-xs text-fg-3"><Trans>状态</Trans></dt><dd className="mt-1 text-sm">{status(selected)}</dd></div>
        <div className="min-w-0 sm:col-span-2"><dt className="text-xs text-fg-3"><Trans>插件 ID</Trans></dt><dd className="mt-1 break-all font-mono text-xs text-fg-2">{selected.id}</dd></div>
      </dl>
    </div>

        {!selected.rejected && <Field label={t({ message: '启用策略' })}><Select<PluginUpdate['enablement'] & string> label={t({ message: '启用策略' })} value={selected.enablement} disabled={working || dirty || missing || !reachable} onChange={enablement => void update({ enablement })} options={[{ value: 'auto', label: t`自动` }, { value: 'on', label: t`开启` }, { value: 'off', label: t`关闭` }]} /></Field>}
    <section className="flex flex-col gap-3 border-t border-line pt-4">
      <h3 className="text-sm font-medium"><Trans>权限</Trans></h3>
      <div className="flex flex-col gap-3 text-sm">{(selected.capabilities ?? []).map(capability => <p key={capability}>{capabilityLabel(capability)}</p>)}{selected.capabilities?.includes('models.provide') && <ModelSourceNote sources={declarations?.modelSources} />}{selected.capabilities?.includes('process.exec') && <ExecutableNote names={selected.executables} />}<p className="text-fg-3"><Trans>安装和启停影响连接这台服务器的所有客户端</Trans></p>{(selected.source === 'development' || selected.installed?.versions.some(version => version.selected && version.trusted)) && <p className="text-fg-3"><Trans>以服务器进程的权限运行</Trans></p>}</div>
    </section>
  </div>;
  const diagnosticContent = selected && <section className="flex min-w-0 flex-col gap-5 border-t border-line pt-4">
    <h3 className="text-sm font-medium"><Trans>诊断</Trans></h3>
    {selected.activation?.state === 'idle' && <p className="text-sm text-fg-3"><Trans>按需加载</Trans></p>}
    {selected.status?.message && <p className="break-words text-sm text-fg-3">{selected.status.message}</p>}
    {selected.stopping && <Button className="self-start" size="sm" variant="secondary" disabled={working || dirty || missing || !reachable} onClick={() => void confirmDialog({ title: t({ message: '立即停用或切换版本？' }), description: t({ message: '运行中的任务会继续，插件功能立即撤下' }), confirmLabel: t({ message: '继续' }) }).then(ok => { if (ok) void update({ force: true }); })}><Trans>立即处理</Trans></Button>}

    {selected.execution && <code className="text-xs text-fg-3">{['server', selected.execution.platform, selected.execution.mode].join(' · ')}</code>}
      <div className="flex flex-col gap-4 text-sm">
        <Button className="self-start" size="sm" variant="secondary" disabled={working || unavailable || !reachable} onClick={() => void run(async () => { setDiagnostics(await api.pluginDiagnostics(selected.id)); })}><Trans>运行诊断</Trans></Button>
        <Button className="self-start" size="sm" variant="secondary" disabled={working || unavailable || !reachable} onClick={() => void run(async () => { setLogs((await api.pluginLogs(selected.id)).logs); })}><Trans>日志</Trans></Button>
        {logs.length > 0 && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-fg-3">{logs.map(log => `${log.at} ${log.version ?? ''} #${log.generation} ${log.level} ${log.phase} ${log.message}`).join('\n')}</pre>}
        {diagnostics.map((check, index) => <div key={check.id + index} className="rounded-lg border border-line p-3"><p className="font-medium">{check.label}</p><p className="break-words text-fg-3">{check.detail}</p>{check.fix && <p className="mt-1 break-words text-fg-3">{check.fix}</p>}</div>)}
        {selected.compatibility?.server?.ok === false && <p><Trans>服务器版本不兼容</Trans></p>}
        {selected.compatibility?.web && !satisfiesHostApi(PLUGIN_WEB_API_VERSION, selected.compatibility.web.range) && <p><Trans>当前客户端版本不兼容</Trans></p>}
        {selected.requires?.map(dependency => <Button key={dependency.id} size="sm" className="self-start" variant="quiet" onClick={() => { const target = list?.find(p => p.id === dependency.id); if (target) void select(target); }}>{dependency.id}</Button>)}
        {!selected.rejected && <Button className="self-start" size="sm" variant="secondary" disabled={working || dirty || missing || !reachable} onClick={() => void run(() => api.reloadPlugin(selected.id))}><Trans>重载插件</Trans></Button>}

      </div>
  </section>;
  // Management and diagnostics are both rare: one tab, diagnostics below.
  const management = selected && <div className="flex min-w-0 flex-col gap-6">{managementContent}{diagnosticContent}</div>;
  const pageShown = Boolean(selected && hasPage(selected));
  const shownTab: PluginDetailTab = detailTab === 'page' && !pageShown ? 'overview' : detailTab;
  const detailTabs: Array<{ value: PluginDetailTab; label: string }> = [
    { value: 'overview', label: t({ message: '介绍', context: 'plugin-detail-tab' }) },
    ...(pageShown && selected ? [{ value: 'page' as const, label: selected.declared?.page ? pageTitle(selected) : t({ message: '设置', context: 'plugin-detail-tab' }) }] : []),
    { value: 'management', label: t({ message: '管理', context: 'plugin-detail-tab' }) },
  ];
  // `全部插件源` is offered only while more than one source is on; a removed source falls back to it.
  const several = enabledSources.length > 1;
  const shownScope: PluginScope = !scope.startsWith('source:') || !sources ? scope
    : scope === ALL_SOURCES ? (several ? ALL_SOURCES : sourceScope((enabledSources[0] ?? sources[0])?.id ?? 'all'))
    : sources.some(value => sourceScope(value.id) === scope) ? scope : several ? ALL_SOURCES : sourceScope((enabledSources[0] ?? sources[0])?.id ?? 'all');
  const scopeSource = shownScope.startsWith('source:') ? sources?.find(value => sourceScope(value.id) === shownScope) : undefined;
  const browsing = shownScope.startsWith('source:');
  const counts = { installed: list?.length, updates: (list ?? []).filter(p => updateOf(p)).length, attention: (list ?? []).filter(attention).length, available: market?.plugins.length, bySource: (market?.plugins ?? []).reduce((counted, entry) => counted.set(entry.sourceId, (counted.get(entry.sourceId) ?? 0) + 1), new Map<string, number>()) };
  const chooseScope = (next: PluginScope) => { if (!dirty && !working) { setScope(next); onSelect(''); } };
  const scopeTitle = scopeSource ? sourceName(scopeSource) : shownScope === 'updates' ? t({ message: '有更新' }) : shownScope === 'attention' ? t({ message: '异常' }) : browsing ? t({ message: '全部插件源' }) : t({ message: '已安装' });
  const navProps = { sources, counts, scope: shownScope, disabled: dirty || working, onScope: chooseScope, onAddSource: () => setAddingSource(true) };
  const trustedLabel = t({ message: '以服务器进程的权限运行' });
  const installedTile = (plugin: PluginDescriptor) => {
    const origin = originOf(plugin);
    const originSource = origin ? sources?.find(value => value.id === origin) : undefined;
    const offer = updateOf(plugin);
    const granted = plugin.installed?.versions.find(version => version.selected);
    return <Tile
      key={keyOf(plugin)}
      media={<PluginMark plugin={plugin} />}
      title={label(plugin)}
      badge={plugin.source !== 'installed' && <Badge className="font-normal">{source(plugin)}</Badge>}
      meta={[plugin.vendor, plugin.version && 'v' + plugin.version, several && originSource ? sourceName(originSource) : undefined].filter(Boolean).join(' · ')}
      description={plugin.description && localizedText(plugin.description, [i18n.locale])}
      facts={attention(plugin)
        ? <span className="text-xs text-fg-3">{status(plugin)}</span>
        : <CapabilityFacts capabilities={plugin.capabilities ?? []} trusted={plugin.source === 'development' || granted?.trusted} trustedLabel={trustedLabel} />}
      actions={<>
        {offer && <Button size="sm" variant="secondary" disabled={working || dirty || !reachable} onClick={() => installFromMarket(offer)}><Trans>更新</Trans></Button>}
        {hasPage(plugin) && <Button size="icon-sm" variant="quiet" disabled={working} aria-label={t({ message: '设置' }) + ' ' + label(plugin)} aria-haspopup="dialog" onClick={() => void select(plugin, 'page')}><IconSettings2 /></Button>}
        {!plugin.rejected && <Switch checked={plugin.enabled} disabled={working || dirty || !reachable || Boolean(plugin.stopping)} aria-label={label(plugin) + ' · ' + status(plugin)} onCheckedChange={enabled => void update({ enablement: enabled ? 'on' : 'off' }, plugin)} />}
      </>}
      disabled={working}
      onOpen={() => void select(plugin)}
    />;
  };
  return (
    <PageScaffold
      title={<Trans>插件</Trans>}
      meta={<>
        <span className="min-w-0 truncate text-xs text-fg-4 max-lg:hidden">{window.location.host}</span>
        <PluginsScopeMenu {...navProps} />
      </>}
      actions={<>
        <Button size="icon-sm" variant="quiet" disabled={working || dirty || !reachable} onClick={() => { void loadMarket(true); void run(refreshPlugins); }} aria-label={t({ message: '重新检测' })}><IconRefreshCw /></Button>
        {!recovery && <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon-sm" variant="quiet" disabled={working || dirty || !reachable} aria-label={t({ message: '更多操作' })}><IconEllipsis /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => void confirmDialog({ title: t({ message: '暂停所有外部插件？' }), description: t({ message: '保留原启用策略，可随时恢复' }), confirmLabel: t({ message: '暂停' }) }).then(ok => { if (ok) void run(() => api.setPluginRecovery(true)); })}><Trans>暂停所有外部插件</Trans></DropdownMenuItem></DropdownMenuContent></DropdownMenu>}
        <Button size="sm" disabled={customBusy || !reachable} onClick={() => void chooseInstall()} busy={busy}><IconUpload /><Trans>安装</Trans></Button>
      </>}
      column="board"
      columnClassName="flex flex-col gap-6"
      aside={<PluginsAside {...navProps} />}
      sidebarCollapsed={sidebarCollapsed}
      onClose={onClose}
      onOpenSidebar={onOpenSidebar}
      onExpandSidebar={onExpandSidebar}
    >
      {recovery && <div className="flex flex-wrap items-center gap-3 text-sm"><Trans>外部插件已暂停</Trans><Button variant="secondary" size="xs" disabled={working || dirty || !reachable} onClick={() => void run(() => api.setPluginRecovery(false))}><Trans>恢复原启用策略</Trans></Button></div>}
      {!selected && errorNotice}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-medium">{scopeTitle}</h2>
          {scopeSource && <p className="mt-0.5 truncate text-xs text-fg-3">{scopeSource.url}</p>}
        </div>
        <SearchField className="w-full md:w-56" disabled={dirty || working} value={query} onChange={value => { setQuery(value); onSelect(''); }} placeholder={t({ message: '搜索插件' })} aria-label={t({ message: '搜索插件' })} />
        {scopeSource && <PluginSourceMenu key={scopeSource.id} source={scopeSource} disabled={working || !reachable} onChange={next => { applyMarket(next); setScope(sourceScope(scopeSource.id)); }} onRemoved={() => setScope(ALL_SOURCES)} />}
      </div>
      {browsing && (scopeSource && !scopeSource.enabled
        ? <EmptyState title={t({ message: '已停用' })}><EnablePluginSource key={scopeSource.id} source={scopeSource} disabled={working || !reachable} onChange={next => { applyMarket(next); setScope(sourceScope(scopeSource.id)); }} /></EmptyState>
        : <PluginMarket market={market} error={marketError} query={query} busy={busy} sourceId={scopeSource?.id ?? 'all'} onInstall={installFromMarket} onRetry={() => void loadMarket(true)} />)}
      {!browsing && <>
        {!list && !error && <div className="flex justify-center p-6"><Spinner /></div>}
        {list && visible.length === 0 && <EmptyState title={query || shownScope !== 'installed' ? t({ message: '没有匹配的插件' }) : t({ message: '没有插件' })} />}
        {PLUGIN_GROUPS.map(group => {
          const items = visible.filter(plugin => installedGroup(plugin) === group);
          if (!items.length) return null;
          return <section key={group} className="flex flex-col gap-3" aria-label={groupTitles[group]}>
            <h3 className="flex items-center gap-2 text-sm font-medium">{groupTitles[group]}<span className="text-xs font-normal text-fg-4">{items.length}</span></h3>
            <TileGrid>{items.map(installedTile)}</TileGrid>
          </section>;
        })}
      </>}
      <p className="text-xs text-fg-3"><Trans>安装和启停影响连接这台服务器的所有客户端</Trans></p>
      <Dialog open={Boolean(selected)} onOpenChange={open => { if (!open) closeSettings(); }}>
        <DialogContent mobileFullscreen size="content" className="h-[min(42rem,calc(var(--app-height,100dvh)-32px))]" aria-describedby={undefined}>
      <DialogHeader><div className="flex min-w-0 items-center gap-3">{selected && <PluginMark plugin={selected} />}<div className="min-w-0"><DialogTitle>{selected && label(selected)}</DialogTitle>{selected && <p className="mt-1 text-xs text-fg-3">{[selected.version && 'v' + selected.version, source(selected), status(selected)].filter(Boolean).join(' · ')}</p>}</div></div></DialogHeader>
      <UnderlineTabs className="mx-5 h-10 shrink-0 overflow-x-auto border-b border-line" value={shownTab} onChange={value => { if (value !== shownTab) void navigateDetail(() => setDetailTab(value)); }} ariaLabel={t({ message: '插件' })} options={detailTabs.map(tab => ({ ...tab, panelId: 'plugin-detail-panel', disabled: working }))} />
      <DialogBody key={shownTab} id="plugin-detail-panel" className="flex flex-1 flex-col gap-5 py-5" role="tabpanel" aria-label={detailTabs.find(tab => tab.value === shownTab)?.label}>{errorNotice}{(missing || (dirty || working) && unavailable || keepPage && configurationUnavailable) && <p role="status" className="text-sm text-fg-3"><Trans>插件已不可用，当前内容会保留到关闭</Trans></p>}{shownTab === 'overview' ? overview : shownTab === 'page' ? configuration : management}</DialogBody>
        </DialogContent>
        <PluginVersionsDialog plugin={versions ? selected : undefined} onClose={() => setVersions(false)} onChanged={() => { void changed(); }} />
        <PluginFlowDialog pluginId={flow?.pluginId} action={flow?.action} open={Boolean(flow)} onOpenChange={open => { if (!open) { setFlow(undefined); void changed(); } }} />
      </Dialog>
      <input ref={fileInput} className="sr-only" type="file" accept=".tgz,.tar.gz,.tar,.zip,application/gzip,application/x-tar,application/zip" tabIndex={-1} aria-hidden onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void install({ file }); }} />
      <AddPluginSourceDialog open={addingSource} knownIds={(sources ?? []).map(value => value.id)} onOpenChange={setAddingSource} onAdded={(next, added) => { applyMarket(next); if (added) chooseScope(sourceScope(added.id)); }} />
      <PluginGrantDialog request={grant?.request} busy={busy} onCancel={() => setGrant(undefined)} onConfirm={trusted => { if (grant) void install(grant.source, grant.request.capabilities, trusted); }} />
    </PageScaffold>
  );
}
