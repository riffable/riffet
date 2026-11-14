import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { ExtensionAction, ExtensionActionRequest, ExtensionActionResult, ExtensionContext, ExtensionKind, ExtensionRuntimeReport, NativeBackendCatalogEntry, NativeBackendId } from '@contracts';
import { IconDownload, IconEllipsis, IconPlus, IconRefreshCw, IconSettings2, IconX } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { SearchField } from '@/components/ui/search-field';
import { EmptyState, Field, Input, Kbd, Select, Spinner, UnderlineTabs } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Notice } from '@/components/ui/notice';
import { FeedbackNotice } from '@/components/ui/feedback-notice';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { api, type ProjectRecord } from '@/lib/api';
import { useBackendLabel } from '@/lib/backends';
import { confirmDialog, useDiscardGuard } from '@/lib/dialogs';
import { copyWithToast } from '@/lib/files';
import { extensionKinds, extensionScopes } from '@/lib/extensions';
import { compareText, formatClock } from '@/lib/i18n/format';
import { OverlayScopeContext, useOverlayState } from '@/lib/overlay-navigation';
import { cn, errorMessage } from '@/lib/utils';
import { invalidateSlashCatalogs } from '../session/useSlashCatalog';
import { useStores } from '../state/stores';
import { ExtensionCatalog } from './ExtensionCatalog';
import { ExtensionInspector } from './ExtensionInspector';
import { extensionActions, extensionContextKey, extensionEntryKey, extensionStatus, type ExtensionCreation, type ExtensionEntry } from './model';
import { useExtensionSources } from './useExtensionSources';
import './extensions.css';
import { PageHeader } from '../PageScaffold';

interface Props {
  active: boolean;
  projects: ProjectRecord[];
  backends: NativeBackendCatalogEntry[];
  initialBackend?: NativeBackendId;
  sidebarCollapsed: boolean;
  onClose(): void;
  onOpenSidebar(): void;
  onExpandSidebar(): void;
  onError(message: string): void;
  onBeforeLeaveChange(guard: (() => Promise<boolean>) | undefined): void;
}

const pageSize = 20;
const kinds: ExtensionKind[] = ['skill', 'mcp', 'plugin', 'hook', 'rule', 'command', 'config'];
type Status = 'all' | 'attention' | 'enabled' | 'disabled' | 'unknown';
type Picker = 'install' | 'runtime';

function authorizationLink(value?: string): string | undefined {
  try { const url = new URL(value ?? ''); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined; }
  catch { return undefined; }
}

export function ExtensionsPage({ active, projects, backends, initialBackend, sidebarCollapsed, onClose, onOpenSidebar, onExpandSidebar, onBeforeLeaveChange }: Props) {
  const { t } = useLingui();
  const agentLabel = useBackendLabel();
  const { ui } = useStores();
  const actionLabels: Record<ExtensionAction, string> = { enable: t`启用`, disable: t`停用`, install: t`安装插件`, uninstall: t`卸载`, update: t`更新`, reload: t`重载 MCP`, login: t`认证` };
  const [projectId, setProjectId] = useState('');
  // Extensions belong to the Agent's native configuration, not the conversation's LLM provider.
  const agentOptions = useMemo(() => backends.flatMap(agent => {
    const profile = agent.profiles.find(value => value.id === 'local')
      ?? agent.profiles.find(value => value.isDefault) ?? agent.profiles[0];
    return profile ? [{ ...agent, profiles: [profile] }] : [];
  }), [backends]);
  const { sources, loading, refresh, ensureCapabilities } = useExtensionSources({ backends: agentOptions, projectId: projectId || undefined, active });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [backend, setBackend] = useState<NativeBackendId | ''>(() => agentOptions.find(agent => agent.backendId === initialBackend)?.backendId ?? agentOptions[0]?.backendId ?? '');
  const currentAgent = agentOptions.find(agent => agent.backendId === backend);
  const [profileId, setProfileId] = useState(() => currentAgent?.profiles[0]?.id ?? '');
  const [kind, setKind] = useState<ExtensionKind>('skill');
  const [scope, setScope] = useState('all');
  const [origin, setOrigin] = useState('all');
  const [status, setStatus] = useState<Status>('all');
  const [sort, setSort] = useState('default');
  const [query, setQuery] = useState('');
  const [pagination, setPagination] = useState({ key: '', page: 1 });
  const deferredSearch = useDeferredValue(query.trim().toLocaleLowerCase());
  const [selectedKey, setSelectedKey] = useState<string>();
  const selectedSnapshot = useRef<ExtensionEntry | undefined>(undefined);
  const [creation, setCreation] = useState<ExtensionCreation>();
  const [detailVisit, setDetailVisit] = useState(0);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [batchMode, setBatchMode] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const [operationBusy, setOperationBusy] = useState(false);
  const operationLock = useRef(false);
  const [runtime, setRuntime] = useState<Record<string, ExtensionRuntimeReport>>({});
  const [error, setError] = useState<string | { message: string; details: string; note?: string }>('');
  const [result, setResult] = useState<ExtensionActionResult>();
  const [picker, setPicker] = useState<Picker>();
  const [pickerKey, setPickerKey] = useState('');
  const [target, setTarget] = useState('');
  const [installScope, setInstallScope] = useState<'user' | 'project'>('user');
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const catalogRef = useRef<HTMLElement>(null);
  const detailTrigger = useRef<HTMLElement | null>(null);
  const busy = editorBusy || operationBusy;
  const currentSource = sources.find(source => source.context.backendId === backend && source.context.profileId === profileId);
  const selectedSource = sources.find(source => source.key === pickerKey);
  const createTargets = currentSource?.inventory?.createTargets.filter(value => value.kind === kind) ?? [];

  const entries = useMemo(() => sources.flatMap(source => {
    const plugins = new Map(source.inventory?.items.filter(item => item.kind === 'plugin').map(item => [item.id, item]) ?? []);
    const identities = new Map<string, number>();
    for (const item of source.inventory?.items ?? []) if (item.nativeId) {
      const identity = JSON.stringify([item.kind, item.nativeId]);
      identities.set(identity, (identities.get(identity) ?? 0) + 1);
    }
    return (source.inventory?.items ?? []).map(item => ({
      key: extensionEntryKey(source.context, item.id), context: source.context, profileName: source.profileName,
      item, sourceLabel: item.ownerPluginId ? plugins.get(item.ownerPluginId)?.name ?? t`插件提供` : item.kind === 'plugin' ? t`原生插件` : item.scope === 'project' ? projects.find(value => value.id === projectId)?.name ?? t`当前项目` : extensionScopes[item.scope],
      ...(item.ownerPluginId && plugins.has(item.ownerPluginId) ? { ownerKey: extensionEntryKey(source.context, item.ownerPluginId) } : {}),
      capabilities: source.capabilities, capabilityError: source.capabilityError, inventoryError: source.error,
      ambiguousNativeId: Boolean(item.nativeId && identities.get(JSON.stringify([item.kind, item.nativeId]))! > 1),
    } satisfies ExtensionEntry));
  }), [sources, projects, projectId, t]);
  const entriesByKey = useMemo(() => new Map(entries.map(entry => [entry.key, entry])), [entries]);
  const selected = selectedKey ? entriesByKey.get(selectedKey) ?? (selectedSnapshot.current?.key === selectedKey
    ? { ...selectedSnapshot.current, inventoryError: t`当前目录不再包含此扩展，请刷新目录后重试管理操作。` } : undefined) : undefined;
  const lastDetail = useRef<{ entry?: ExtensionEntry; creation?: ExtensionCreation }>({});
  const lastPicker = useRef<Picker | undefined>(undefined);
  useLayoutEffect(() => {
    if (selected || creation) lastDetail.current = { entry: selected, creation };
    if (picker) lastPicker.current = picker;
  }, [selected, creation, picker]);
  const detailOpen = Boolean(selected || creation);
  const shownDetail = detailOpen ? { entry: selected, creation } : lastDetail.current;
  const shownPicker = picker ?? lastPicker.current;
  const indexed = useMemo(() => entries.map(entry => ({ entry, search: [entry.item.name, entry.item.description, entry.item.sourcePath, entry.item.nativeId, entry.sourceLabel, entry.profileName, agentLabel(entry.context.backendId), extensionKinds[entry.item.kind]].filter(Boolean).join(' ').toLocaleLowerCase() })), [entries, agentLabel]);
  const contextRows = useMemo(() => indexed.filter(({ entry }) => entry.context.backendId === backend
    && entry.context.profileId === profileId
    && (scope === 'all' || entry.item.scope === scope)
    && (origin === 'all' || (origin === 'plugin') === Boolean(entry.item.ownerPluginId || entry.item.kind === 'plugin'))), [indexed, backend, profileId, scope, origin]);
  const counts = useMemo(() => {
    const value = Object.fromEntries(kinds.map(key => [key, 0])) as Record<ExtensionKind, number>;
    contextRows.forEach(({ entry }) => value[entry.item.kind]++);
    return value;
  }, [contextRows]);
  const filtered = useMemo(() => {
    const words = deferredSearch.split(/\s+/).filter(Boolean);
    const list = contextRows.filter(({ entry, search }) => entry.item.kind === kind && words.every(word => search.includes(word))
      && (status === 'all' || status === 'enabled' && entry.item.enabled === true || status === 'disabled' && entry.item.enabled === false
        || status === 'unknown' && entry.item.enabled === undefined
        || status === 'attention' && extensionStatus(entry, runtime[extensionContextKey(entry.context)]).key === 'attention')).map(row => row.entry);
    if (sort === 'name') list.sort((a, b) => compareText(a.item.name, b.item.name, { numeric: true }));
    return list;
  }, [contextRows, deferredSearch, kind, status, sort, runtime]);
  const attention = contextRows.reduce((count, { entry }) => count + Number(extensionStatus(entry, runtime[extensionContextKey(entry.context)]).key === 'attention'), 0);
  const filterKey = [projectId, backend, profileId, kind, scope, origin, status, sort, deferredSearch].join('|');
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = pagination.key === filterKey ? Math.min(pagination.page, pageCount) : 1;
  const pageEntries = useMemo(() => filtered.slice((page - 1) * pageSize, page * pageSize), [filtered, page]);
  const checkedEntries = useMemo(() => pageEntries.filter(entry => checked.has(entry.key)), [pageEntries, checked]);
  useEffect(() => { setPagination({ key: filterKey, page }); }, [filterKey, page]);
  const enableEntries = checkedEntries.filter(entry => extensionActions(entry).includes('enable') && entry.item.enabled !== true);
  const disableEntries = checkedEntries.filter(entry => extensionActions(entry).includes('disable') && entry.item.enabled !== false);
  const neededCapabilities = [...new Set([...(selected ? [extensionContextKey(selected.context)] : []), ...checkedEntries.map(entry => extensionContextKey(entry.context)), ...(currentSource ? [currentSource.key] : []), ...(picker ? [pickerKey] : [])])];
  const missingCapabilities = neededCapabilities.filter(key => { const source = sources.find(value => value.key === key); return source && !source.capabilities && !source.capabilityError; }).join('\n');
  const visibleSources = sources.filter(source => source.context.backendId === backend && source.context.profileId === profileId);
  const diagnostics = [...new Set(visibleSources.flatMap(source => source.inventory?.diagnostics ?? []))];
  const failed = visibleSources.filter(source => source.error);

  const discardSelection = useCallback(() => { selectedSnapshot.current = undefined; setSelectedKey(undefined); setCreation(undefined); setDirty(false); }, []);
  const { confirm: confirmDiscard } = useDiscardGuard(active && dirty, active && busy);
  const guard = useCallback(async () => {
    if (!await confirmDiscard()) return false;
    discardSelection(); setPicker(undefined); setFiltersOpen(false);
    return true;
  }, [confirmDiscard, discardSelection]);
  useEffect(() => { onBeforeLeaveChange(guard); return () => onBeforeLeaveChange(undefined); }, [guard, onBeforeLeaveChange]);
  // Keep a removed Agent/profile from leaving an unusable directory, while preserving drafts.
  useEffect(() => {
    if (dirty || busy) return;
    const agent = agentOptions.find(value => value.backendId === backend);
    if (agent?.profiles.some(value => value.id === profileId)) return;
    const nextAgent = agent ?? agentOptions.find(value => value.backendId === initialBackend) ?? agentOptions[0];
    const nextProfile = nextAgent?.profiles[0];
    if ((nextAgent?.backendId ?? '') === backend && (nextProfile?.id ?? '') === profileId) return;
    discardSelection(); setPicker(undefined); setChecked(new Set()); setBatchMode(false);
    setBackend(nextAgent?.backendId ?? ''); setProfileId(nextProfile?.id ?? '');
  }, [backend, profileId, agentOptions, initialBackend, dirty, busy, discardSelection]);
  useEffect(() => { setChecked(new Set()); }, [filterKey, page]);
  useEffect(() => { setRuntime({}); setResult(undefined); setError(''); }, [projectId]);
  useEffect(() => {
    if (!active || !missingCapabilities) return;
    let stopped = false;
    void (async () => {
      for (const key of missingCapabilities.split('\n')) {
        if (stopped) break;
        const source = sources.find(value => value.key === key);
        if (source) await ensureCapabilities(source.context);
      }
    })();
    return () => { stopped = true; };
  }, [active, missingCapabilities, ensureCapabilities, sources]);
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || picker || creation) return;
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      if (!searchRef.current || getComputedStyle(searchRef.current).visibility === 'hidden') return;
      event.preventDefault(); searchRef.current.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, picker, creation]);

  const closePage = useCallback(() => { void guard().then(ok => { if (ok) onClose(); }); }, [guard, onClose]);
  const overlay = useOverlayState({ open: active, onOpenChange: next => { if (!next) closePage(); } });
  const resetFilters = useCallback(() => { setQuery(''); setScope('all'); setOrigin('all'); setStatus('all'); setSort('default'); }, []);
  const openEntry = useCallback((key: string, trigger?: HTMLElement) => {
    if (key === selectedKey) return;
    const entry = entriesByKey.get(key);
    if (entry && (entry.context.backendId !== backend || entry.context.profileId !== profileId)) return;
    if (!entry) { setError(t`目录中未找到此扩展，请刷新后重试。`); return; }
    const returnFocus = !selectedKey && !creation ? trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : undefined) : undefined;
    void guard().then(ok => { if (ok) { if (returnFocus) detailTrigger.current = returnFocus; if (entry.item.kind !== kind) resetFilters(); selectedSnapshot.current = entry; setSelectedKey(key); setDetailVisit((visit) => visit + 1); setKind(entry.item.kind); setChecked(new Set()); setBatchMode(false); setError(''); setResult(undefined); } });
  }, [selectedKey, creation, guard, entriesByKey, backend, profileId, kind, resetFilters]);
  const selectEntry = useCallback((key: string) => setChecked(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; }), []);
  async function switchContext(next: { backend?: NativeBackendId; kind?: ExtensionKind; projectId?: string }) {
    if (!await guard()) return;
    if (next.backend !== undefined) {
      const agent = agentOptions.find(value => value.backendId === next.backend);
      if (!agent) return;
      setBackend(agent.backendId); setProfileId(agent.profiles[0].id);
    }
    if (next.kind !== undefined) setKind(next.kind);
    if (next.projectId !== undefined) setProjectId(next.projectId);
    resetFilters(); setChecked(new Set()); setBatchMode(false); setResult(undefined); setError('');
  }
  async function openCreation(trigger?: HTMLElement) {
    const returnFocus = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    if (!currentSource || !createTargets.length || !await guard()) return;
    detailTrigger.current = returnFocus; setError(''); setResult(undefined);
    setCreation({ context: currentSource.context, profileName: currentSource.profileName, targets: createTargets });
    setDetailVisit((visit) => visit + 1);
    setChecked(new Set()); setBatchMode(false);
  }

  async function changed(_context?: ExtensionContext) {
    invalidateSlashCatalogs(); setRuntime({});
    await refresh();
  }
  async function refreshDirectory() {
    if (!await guard()) return;
    operationLock.current = true; setOperationBusy(true); setError('');
    try { await changed(); }
    catch (reason) { setError(errorMessage(reason, t`部分目录刷新失败`)); }
    finally { operationLock.current = false; setOperationBusy(false); }
  }
  async function checkRuntime(context: ExtensionContext) {
    if (operationLock.current || editorBusy || dirty) return;
    operationLock.current = true; setOperationBusy(true); setError('');
    try { const report = await api.extensionRuntime(context); setRuntime(previous => ({ ...previous, [extensionContextKey(context)]: report })); }
    catch (reason) { setError(errorMessage(reason, t`无法读取运行状态`)); }
    finally { operationLock.current = false; setOperationBusy(false); }
  }
  async function readSkillManifest(entry?: ExtensionEntry) {
    if (entry?.item.kind !== 'skill') return;
    if (!entry.item.documentId) throw new Error(t`无法读取 Skill 主文件，请刷新目录后重试。`);
    // Always use the manifest, even when the inspector is showing a supporting file.
    const document = await api.extensionDocument(entry.context, entry.item.documentId);
    if (!document.hash) throw new Error(t`无法确认 Skill 主文件版本，请刷新目录后重试。`);
    return document;
  }
  async function apply(context: ExtensionContext, request: ExtensionActionRequest, name: string, item?: ExtensionEntry) {
    if (operationLock.current || editorBusy || dirty) return;
    operationLock.current = true; setOperationBusy(true); setError('');
    let attempted = false;
    try {
      const document = await readSkillManifest(item);
      const actionRequest = document ? { ...request, expectedHash: document.hash } : request;
      const scopeName = request.scope ?? item?.item.scope;
      const deletingSkill = item?.item.kind === 'skill' && request.action === 'uninstall';
      const label = deletingSkill ? t`删除 Skill` : actionLabels[request.action];
      const scopeLabel = scopeName === 'project' ? t({ message: '项目级', context: 'extensions-scope-project' }) : t({ message: '用户级', context: 'extensions-scope-user' });
      const effect = deletingSkill
        ? t`将整个 Skill 目录从来源位置移出并备份。若此目录由多个 Agent 共用，这些 Agent 都会受到影响。`
        : item?.item.kind === 'skill' ? item.item.managementNote ?? t`技能开关写入当前 Agent 配置，其他项目也可能受影响。`
          : t`${scopeLabel}操作。`;
      const description = [
        agentLabel(context.backendId),
        document ? t`来源：${item?.item.sourcePath ?? document.path}` : undefined,
        effect,
        deletingSkill ? item?.item.managementNote : undefined,
        t`现有会话的生效时机由原生 Agent 决定。`,
      ].filter(Boolean).join('\n');
      if (!await confirmDialog({ title: t`${label} ${name}？`, description, confirmLabel: label, destructive: request.action === 'uninstall' })) return;
      attempted = true;
      const response = await api.extensionAction(context, actionRequest);
      setResult(response);
      if (response.success && request.action === 'uninstall') discardSelection();
      // Even a native command that fails may have written part of its configuration.
      try { await changed(context); }
      catch (reason) { setError({ message: t`操作已返回，但目录刷新失败。`, details: errorMessage(reason, t`目录刷新失败`) }); }
      if (response.success && request.action === 'install') { setTarget(''); setPicker(undefined); }
    } catch (reason) {
      const message = errorMessage(reason, t({ message: '操作失败', context: 'extensions-action-failed' }));
      if (attempted) {
        setResult(undefined);
        const summary = t`操作结果未确认；可能已部分修改。`;
        try { await changed(context); setError({ message: summary, details: message, note: t`目录已刷新，请核对后再操作；未自动重试。` }); }
        catch (refreshError) { setError({ message: summary, details: [message, errorMessage(refreshError, t`目录刷新失败`)].join('\n\n'), note: t`目录刷新失败，请刷新后核对；未自动重试。` }); }
      } else setError({ message: t({ message: '操作失败', context: 'extensions-action-failed' }), details: message });
    }
    finally { operationLock.current = false; setOperationBusy(false); }
  }
  async function onAction(entry: ExtensionEntry, action: ExtensionAction, runtimeTarget?: string) {
    const allowed = runtimeTarget && action === 'login' ? entry.capabilities?.kinds.mcp?.includes('login') : extensionActions(entry).includes(action);
    if (!allowed) return;
    await apply(entry.context, { action, ...(runtimeTarget ? { target: runtimeTarget } : action === 'reload' ? {} : { itemId: entry.item.id }) }, runtimeTarget ?? entry.item.name, entry);
  }
  async function batch(enable: boolean) {
    if (operationLock.current || editorBusy || dirty) return;
    const targets = enable ? enableEntries : disableEntries;
    if (!targets.length) return;
    operationLock.current = true; setOperationBusy(true); setError('');
    try {
      const requests: Array<{ entry: ExtensionEntry; request: ExtensionActionRequest }> = [];
      // Read every Skill manifest before confirmation. A failed read leaves the entire batch untouched.
      for (const entry of targets) {
        const document = await readSkillManifest(entry);
        requests.push({ entry, request: { action: enable ? 'enable' : 'disable', itemId: entry.item.id, ...(document ? { expectedHash: document.hash } : {}) } });
      }
      const contexts = new Set(targets.map(entry => agentLabel(entry.context.backendId)));
      const notes = new Set(targets.filter(entry => entry.item.kind === 'skill').map(entry => entry.item.managementNote ?? t`技能开关可能影响同配置的其他项目。`));
      const description = [t`${[...contexts].join('、')}。`, ...notes, t`${checkedEntries.length - targets.length} 项不支持此操作或无需变更，将跳过。`].join('\n');
      const batchLabel = enable ? t`启用` : t`停用`;
      if (!await confirmDialog({ title: t`${batchLabel} ${targets.length} 个扩展？`, description, confirmLabel: batchLabel })) return;
      const failures: string[] = [];
      const effects = new Set<string>();
      let successes = 0;
      const incompleteLabel = t`操作未完成`;
      const failedLabel = t({ message: '操作失败', context: 'extensions-action-failed' });
      // Native configuration locks are profile-wide; serialize writes and never retry mutations.
      for (const { entry, request } of requests) {
        try {
          const response = await api.extensionAction(entry.context, request);
          if (response.success) { successes++; if (response.applyEffect) effects.add(response.applyEffect); }
          else failures.push(t`${entry.item.name}：${response.output || response.applyEffect || incompleteLabel}`);
        } catch (reason) { failures.push(t`${entry.item.name}：${errorMessage(reason, failedLabel)}`); }
      }
      setResult({ success: failures.length === 0, applyEffect: t`${successes} 项完成，${failures.length} 项失败。${[...effects].join('\n')}`, diagnostics: failures });
      setChecked(new Set());
      try { await changed(); } catch (reason) { setError(errorMessage(reason, t`目录刷新失败`)); }
    } catch (reason) { setError(errorMessage(reason, t`无法确认扩展版本，未执行批量操作。`)); }
    finally { operationLock.current = false; setOperationBusy(false); }
  }
  async function openPicker(mode: Picker) {
    if (!currentSource || !await guard()) return;
    setPickerKey(currentSource.key); setTarget(''); setInstallScope('user'); setResult(undefined); setPicker(mode);
  }
  const authUrl = authorizationLink(result?.authorizationUrl);
  const selectedReport = selected ? runtime[extensionContextKey(selected.context)] : undefined;
  const pickerReport = runtime[pickerKey];
  const statusLabels: Record<Status, string> = { all: t`全部状态`, attention: t`需处理`, enabled: t`已启用`, disabled: t`已停用`, unknown: t`未声明` };
  const runtimeStateLabels = { unknown: t`未确认`, loaded: t`已加载`, error: t`异常`, pending: t`等待加载` };
  const emptyKindLabel = kind === 'config' ? t({ message: '配置', context: 'extensions-kind-config' }) : extensionKinds[kind];
  const activeFilters = [
    ...(scope !== 'all' ? [{ label: extensionScopes[scope as keyof typeof extensionScopes], clear: () => setScope('all') }] : []),
    ...(origin !== 'all' ? [{ label: origin === 'plugin' ? t`插件提供` : t`独立配置`, clear: () => setOrigin('all') }] : []),
    ...(status !== 'all' ? [{ label: statusLabels[status], clear: () => setStatus('all') }] : []),
    ...(sort !== 'default' ? [{ label: t`名称 A–Z`, clear: () => setSort('default') }] : []),
  ];

  const errorContent = typeof error === 'string' ? error : <><details><summary className="cursor-pointer">{error.message}</summary><div className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs">{error.details}</div></details>{error.note && <p className="mt-1">{error.note}</p>}</>;
  const operationFeedback = (error || result) && <div className="extensions-operation-feedback">
    {error && <Notice className="mx-4 mt-3" tone="danger" role="alert" action={<Button size="icon-xs" variant="quiet" aria-label={t`关闭错误提示`} onClick={() => setError('')}><IconX /></Button>}>{errorContent}</Notice>}
    {result && <Notice className="mx-4 mt-3" tone={result.success ? 'neutral' : 'warning'} action={<Button size="icon-xs" variant="quiet" aria-label={t`关闭操作结果`} onClick={() => setResult(undefined)}><IconX /></Button>}><details><summary className="cursor-pointer">{result.success ? t`操作完成` : t`操作未全部完成；可能已部分修改。`}</summary><div className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs">{[result.applyEffect, result.output, ...(result.diagnostics ?? [])].filter(Boolean).join('\n')}</div></details>{authUrl && <a className="mt-2 inline-block text-accent underline" href={authUrl} target="_blank" rel="noopener noreferrer"><Trans>打开授权页面</Trans></a>}</Notice>}
  </div>;

  return <OverlayScopeContext.Provider value={overlay.scope}><div className={cn('extensions-page', (selected || creation) && 'has-inspector')}>
    <PageHeader divided title={<Trans>扩展管理</Trans>} sidebarCollapsed={sidebarCollapsed} onOpenSidebar={onOpenSidebar} onExpandSidebar={onExpandSidebar} actions={<>
        <Button size="icon-sm" variant="quiet" disabled={busy} aria-label={t`刷新目录`} title={t`刷新目录`} onClick={() => void refreshDirectory()} busy={loading}><IconRefreshCw /></Button>
        <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon-sm" variant="quiet" aria-label={t`更多操作`}><IconEllipsis /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
          <DropdownMenuItem disabled={busy || !currentSource} onSelect={() => void openPicker('runtime')}><Trans>运行状态与 MCP</Trans></DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setShowDiagnostics(true)}><Trans>诊断</Trans></DropdownMenuItem>
        </DropdownMenuContent></DropdownMenu>
    </>} />
    {!selected && !creation && !picker && operationFeedback}
    <div className="extensions-workarea" role="tabpanel" aria-label={t`扩展管理`}>
      <section ref={catalogRef} className="extensions-catalog" aria-label={t`扩展目录`}>
        <div className="extensions-page-nav">
          <div className="extensions-context-controls">
            <Select<string> className="extensions-agent-filter" label="Agent" value={backend} disabled={busy || !agentOptions.length} onChange={next => void switchContext({ backend: next as NativeBackendId })} options={agentOptions.map(agent => ({ value: agent.backendId, label: agentLabel(agent.backendId) }))} />
            <Select className="extensions-project-filter" label={t`配置范围`} value={projectId} disabled={busy} onChange={next => void switchContext({ projectId: next })} options={[{ value: '', label: t`用户配置` }, ...projects.filter(value => !value.archivedAt).map(value => ({ value: value.id, label: value.name }))]} />
          </div>
          <SearchField ref={searchRef} className="extensions-search" aria-label={t`搜索扩展`} placeholder={t`搜索扩展`} value={query} onChange={setQuery} hint={<Kbd>/</Kbd>} />
        </div>
        <div className="extensions-browse-bar">
          <div className="extensions-kind-tabs"><UnderlineTabs value={kind} onChange={next => { if (next !== kind) void switchContext({ kind: next }); }} ariaLabel={t`扩展类型`} options={kinds.map(value => ({ value, label: <>{extensionKinds[value]}<span className="extensions-kind-count">{counts[value]}</span></>, disabled: busy }))} /></div>
          <div className="extensions-toolbar">
            <Popover open={filtersOpen} onOpenChange={setFiltersOpen}><PopoverTrigger asChild><Button size="icon-sm" title={t({ message: '筛选', context: 'extensions-filters-label' })} variant={activeFilters.length ? 'secondary' : 'quiet'} aria-label={activeFilters.length ? t`筛选，${activeFilters.length} 项已启用` : t({ message: '筛选', context: 'extensions-filters-label' })}><IconSettings2 />{activeFilters.length > 0 && <span className="text-2xs tabular-nums">{activeFilters.length}</span>}</Button></PopoverTrigger><PopoverContent mobileSheet align="end" className="w-[340px] max-w-[calc(100vw-24px)] p-4">
              <div className="mb-4 flex items-center justify-between"><h2 className="text-sm font-medium"><Trans context="extensions-filters-label">筛选</Trans></h2><Button size="xs" variant="quiet" onClick={resetFilters}><Trans>重置</Trans></Button></div>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t`作用域`}><Select label={t`作用域筛选`} value={scope} onChange={setScope} options={[{ value: 'all', label: t`全部作用域` }, ...Object.entries(extensionScopes).map(([value, label]) => ({ value, label }))]} /></Field>
                <Field label={t({ message: '状态', context: 'extensions-status-filter' })}><Select<string> label={t`扩展状态`} value={status} onChange={next => setStatus(next as Status)} options={Object.entries(statusLabels).map(([value, label]) => ({ value, label: `${label}${value === 'attention' ? ` · ${attention}` : ''}` }))} /></Field>
                <Field label={t`来源`}><Select label={t`扩展来源筛选`} value={origin} onChange={setOrigin} options={[{ value: 'all', label: t`全部来源` }, { value: 'own', label: t`独立配置` }, { value: 'plugin', label: t`插件提供` }]} /></Field>
                <Field label={t({ message: '排序', context: 'extensions-sort-field' })}><Select label={t`排序方式`} value={sort} onChange={setSort} options={[{ value: 'default', label: t`默认排序` }, { value: 'name', label: t`名称 A–Z` }]} /></Field>
              </div>
              <div className="mt-4 flex justify-end"><Button size="sm" variant="secondary" onClick={() => setFiltersOpen(false)}><Trans context="extensions-done-action">完成</Trans></Button></div>
            </PopoverContent></Popover>
            {batchMode ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setBatchMode(false); setChecked(new Set()); }}><Trans context="extensions-done-action">完成</Trans></Button> : <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon-sm" variant="quiet" aria-label={t`列表操作`} title={t`列表操作`}><IconEllipsis /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem disabled={busy || !filtered.length} onSelect={() => { setBatchMode(true); setChecked(new Set()); }}><Trans>批量选择</Trans></DropdownMenuItem></DropdownMenuContent></DropdownMenu>}
            {kind === 'plugin' ? <Button size="sm" variant="secondary" disabled={busy || !currentSource} onClick={() => void openPicker('install')}><IconDownload /><Trans>安装插件</Trans></Button> : createTargets.length > 0 && <Button size="sm" variant="secondary" disabled={busy} onClick={event => void openCreation(event.currentTarget)}><IconPlus /><Trans>新建</Trans></Button>}
          </div>
        </div>
        <FeedbackNotice scope={JSON.stringify(['extensions-directory', projectId, backend, profileId])} message={failed.length > 0 && t`扩展目录读取失败`} className="mb-3" tone="warning"
          action={() => <Button size="xs" variant="quiet" onClick={() => setShowDiagnostics(true)}><Trans>查看详情</Trans></Button>} />
        {activeFilters.length > 0 && <div className="extensions-active-filters">{activeFilters.map((filter, index) => <button key={`${index}:${filter.label}`} type="button" className="extensions-filter-chip" onClick={filter.clear} aria-label={t`取消筛选：${filter.label}`}><span className="truncate">{filter.label}</span><IconX className="size-3 shrink-0" /></button>)}<Button size="xs" variant="quiet" onClick={resetFilters}><Trans>清除</Trans></Button></div>}
        {!sources.length && !loading ? <EmptyState title={t`暂无 Agent 配置`}><Button variant="secondary" onClick={() => ui.openSettings('backends')}><IconSettings2 /><Trans>打开设置</Trans></Button></EmptyState> : currentSource?.inventory && !currentSource.loading && counts[kind] === 0 && !query && activeFilters.length === 0 ? <EmptyState title={t`暂无 ${emptyKindLabel}`}>{kind === 'plugin' ? <Button variant="secondary" disabled={busy} onClick={() => void openPicker('install')}><IconDownload /><Trans>安装插件</Trans></Button> : createTargets.length > 0 && <Button variant="secondary" disabled={busy} onClick={event => void openCreation(event.currentTarget)}><IconPlus /><Trans>新建</Trans></Button>}</EmptyState> : <ExtensionCatalog entries={pageEntries} selectedKey={selectedKey} checked={checked} batchMode={batchMode} hasFilters={Boolean(query || activeFilters.length)} runtime={runtime} loading={Boolean(currentSource?.loading)} disabled={busy} resetKey={`${filterKey}|${page}`} onOpen={openEntry} onSelect={selectEntry} onSelectAll={value => setChecked(value ? new Set(pageEntries.map(entry => entry.key)) : new Set())} onReset={resetFilters} enableCount={dirty ? 0 : enableEntries.length} disableCount={dirty ? 0 : disableEntries.length} batchLoading={checkedEntries.some(entry => entry.item.actions === undefined && entry.item.kind !== 'skill' && !entry.capabilities && !entry.capabilityError)} onBatch={enable => void batch(enable)} onClearSelection={() => setChecked(new Set())} />}
        {pageCount > 1 && <nav className="extensions-pagination" aria-label={t`扩展分页`}>
          <Button size="sm" variant="quiet" disabled={busy || page <= 1} onClick={() => setPagination({ key: filterKey, page: page - 1 })}><Trans context="extensions-pagination-previous">上一页</Trans></Button>
          <span className="text-xs tabular-nums text-fg-3" aria-live="polite">{page} / {pageCount}</span>
          <Button size="sm" variant="quiet" disabled={busy || page >= pageCount} onClick={() => setPagination({ key: filterKey, page: page + 1 })}><Trans context="extensions-pagination-next">下一页</Trans></Button>
        </nav>}
      </section>
    </div>
    <Dialog open={active && showDiagnostics} onOpenChange={setShowDiagnostics}>
      <DialogContent size="content" aria-describedby={undefined}>
        <DialogHeader><DialogTitle><Trans>诊断</Trans></DialogTitle><DialogDescription>{backend ? agentLabel(backend) : 'Agent'} · {projectId ? projects.find(value => value.id === projectId)?.name ?? t`项目配置` : t`用户配置`}</DialogDescription></DialogHeader>
        <DialogBody className="max-h-[55dvh] space-y-4">
          {error && <Notice tone="danger">{errorContent}</Notice>}
          {failed.length > 0 && <div className="space-y-2">{failed.map(source => <Notice key={source.key} tone="danger"><p className="whitespace-pre-wrap break-words text-xs leading-5">{source.error}</p></Notice>)}</div>}
          {diagnostics.length > 0 && <ul aria-label={t`扫描记录`} className="divide-y divide-line-soft">{diagnostics.map((line, index) => <li key={index} className="whitespace-pre-wrap break-words py-3 font-mono text-xs leading-5 text-fg-2">{line}</li>)}</ul>}
          {!error && !failed.length && !diagnostics.length && <p className="py-4 text-sm text-fg-3">{currentSource?.loading ? t`正在读取扩展` : currentSource?.inventory ? t`暂无诊断记录` : t`尚未读取目录`}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="quiet" disabled={!diagnostics.length && !failed.length} onClick={() => void copyWithToast([backend && agentLabel(backend), ...failed.map(source => source.error), ...diagnostics].filter(Boolean).join('\n'))}><Trans>复制记录</Trans></Button>
          <Button variant="secondary" disabled={busy} busy={loading} onClick={() => void refreshDirectory()}><Trans>重新读取</Trans></Button>
          <Button onClick={() => setShowDiagnostics(false)}><Trans>关闭</Trans></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={detailOpen} onOpenChange={value => { if (!value) void guard(); }}><DialogContent className="extensions-detail-dialog data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right" hideClose aria-describedby={undefined} onCloseAutoFocus={event => { event.preventDefault(); const target = detailTrigger.current?.isConnected ? detailTrigger.current : catalogRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]'); target?.focus({ preventScroll: true }); }}><DialogTitle className="sr-only">{shownDetail.entry?.item.name ?? t`新建扩展`}</DialogTitle>
      {!picker && operationFeedback}
      {(shownDetail.entry || shownDetail.creation) && <ExtensionInspector key={detailVisit} active={active && detailOpen} entry={shownDetail.entry} creation={shownDetail.creation} runtime={selectedReport ?? (shownDetail.entry ? runtime[extensionContextKey(shownDetail.entry.context)] : undefined)} disabled={operationBusy} onClose={() => { void guard(); }} onOpen={openEntry} onDirtyChange={setDirty} onBusyChange={setEditorBusy} onChanged={changed} onAction={onAction} onCheckRuntime={checkRuntime} />}
    </DialogContent></Dialog>
    <Dialog open={Boolean(picker)} onOpenChange={value => { if (!value && !busy) setPicker(undefined); }}><DialogContent><DialogHeader><DialogTitle>{shownPicker === 'install' ? t`安装插件` : t`运行状态与 MCP`}</DialogTitle><DialogDescription className="sr-only"><Trans>选择操作的 Agent 配置</Trans></DialogDescription></DialogHeader><DialogBody className="flex flex-col gap-4">
      <p className="text-xs text-fg-3">{selectedSource ? agentLabel(selectedSource.context.backendId) : ''}</p>
      {shownPicker === 'install' && <>
        {!selectedSource?.capabilities && !selectedSource?.capabilityError ? <Spinner /> : !selectedSource?.capabilities?.actions.includes('install') ? <p className="text-xs text-fg-3">{selectedSource?.capabilityError || selectedSource?.capabilities?.reason || t`此配置不支持原生插件安装。`}</p> : <><Field label={t`插件名称`} hint={t`使用原生插件标识，例如 name@marketplace`}><Input aria-label={t`插件名称`} value={target} disabled={busy} onChange={event => setTarget(event.target.value)} /></Field><Field label={t`安装作用域`}><Select<'user' | 'project'> label={t`安装作用域`} value={installScope} disabled={busy} onChange={setInstallScope} options={[{ value: 'user', label: t({ message: '用户级', context: 'extensions-scope-user' }) }, ...(selectedSource.context.projectId && selectedSource.capabilities.installScopes?.includes('project') ? [{ value: 'project' as const, label: t`当前项目` }] : [])]} /></Field></>}
      </>}
      {shownPicker === 'runtime' && <>
        {selectedSource?.capabilityError && <p role="alert" className="text-xs text-danger">{selectedSource.capabilityError}</p>}
        {pickerReport && <div className="max-h-72 overflow-auto"><p className="mb-2 text-xs text-fg-3">{t`检查于 ${formatClock(pickerReport.checkedAt)}`}</p>{pickerReport.entries.map((entry, index) => <div key={index} className="flex items-center gap-2 border-b border-line py-2"><span className="min-w-0 flex-1"><span className="block truncate text-sm">{entry.name}</span><span className="block truncate text-2xs text-fg-3" title={entry.sessionId}>{entry.sessionId}{entry.message ? ` · ${entry.message}` : ''}</span></span><span className="text-xs text-fg-3">{runtimeStateLabels[entry.state]}</span>{entry.kind === 'mcp' && selectedSource?.capabilities?.kinds.mcp?.includes('login') && <Button size="xs" variant="ghost" disabled={busy} onClick={() => void apply(selectedSource.context, { action: 'login', target: entry.name }, entry.name)}><Trans>认证</Trans></Button>}</div>)}{pickerReport.diagnostics.map((line, index) => <p className="mt-2 break-words text-xs text-fg-3" key={index}>{line}</p>)}</div>}
      </>}
      {error && <Notice tone="danger" role="alert">{errorContent}</Notice>}
      {result && <Notice tone={result.success ? 'neutral' : 'warning'}><div className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-xs">{[result.applyEffect, result.output, ...(result.diagnostics ?? [])].filter(Boolean).join('\n')}</div>{authUrl && <a className="mt-2 inline-block text-accent underline" href={authUrl} target="_blank" rel="noopener noreferrer"><Trans>打开授权页面</Trans></a>}</Notice>}
    </DialogBody><DialogFooter><Button disabled={busy} onClick={() => setPicker(undefined)}><Trans>关闭</Trans></Button>
      {shownPicker === 'install' && <Button variant="primary" disabled={busy || !target.trim() || !selectedSource?.capabilities?.actions.includes('install')} onClick={() => { if (selectedSource) void apply(selectedSource.context, { action: 'install', target: target.trim(), scope: installScope }, target.trim()); }}>{operationBusy && <Spinner />}<Trans>安装插件</Trans></Button>}
      {shownPicker === 'runtime' && selectedSource && <><Button disabled={editorBusy} busy={operationBusy} onClick={() => void checkRuntime(selectedSource.context)}><Trans>检查</Trans></Button>{selectedSource.capabilities?.actions.includes('reload') && <Button disabled={busy} onClick={() => void apply(selectedSource.context, { action: 'reload' }, t`MCP 配置`)}><Trans>重载 MCP</Trans></Button>}</>}
    </DialogFooter></DialogContent></Dialog>
  </div></OverlayScopeContext.Provider>;
}
