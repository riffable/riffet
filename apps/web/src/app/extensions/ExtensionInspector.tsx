import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { Components } from 'react-markdown';
import type { ExtensionAction, ExtensionContext, ExtensionDetail, ExtensionDocument, ExtensionRuntimeReport } from '@contracts';
import {
  IconEllipsis, IconFileCode2, IconFileCog, IconFileText, IconLayers, IconRefreshCw,
  IconPencilLine, IconSave, IconServer, IconShieldCheck, IconSparkles, IconX, IconZap,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Badge, Input, Select, Spinner, StatusDot, Switch, UnderlineTabs } from '@/components/ui/controls';
import { FeedbackNotice } from '@/components/ui/feedback-notice';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api, HttpError } from '@/lib/api';
import { useBackendLabel } from '@/lib/backends';
import { confirmDialog } from '@/lib/dialogs';
import { extensionNewPath, extensionScopes, extensionTemplate } from '@/lib/extensions';
import { formatClock } from '@/lib/i18n/format';
import { errorMessage } from '@/lib/utils';
import { Markdown } from '../session/Markdown';
import { ZoomableImage } from '../session/ImageViewer';
import { localImagePath } from '../session/imageSource';
import { invalidateSlashCatalogs } from '../session/useSlashCatalog';
import {
  extensionActions, extensionContextKey, extensionRuntimeEntries,
  type ExtensionCreation, type ExtensionEntry,
} from './model';

const ExtensionEditor = lazy(() => import('./ExtensionEditor'));
const kindIcons = {
  skill: IconSparkles, mcp: IconServer, plugin: IconLayers, hook: IconZap,
  rule: IconShieldCheck, command: IconFileCode2, config: IconFileCog,
};

/** Resolve only for matching an already-discovered file; this never grants file access. */
function extensionResourcePath(value: string, documentPath: string): string | undefined {
  const path = localImagePath(value.split(/[?#]/, 1)[0] ?? '');
  if (!path) return undefined;
  const combined = /^(?:\/|~\/)/.test(path) ? path : `${documentPath.slice(0, documentPath.lastIndexOf('/') + 1)}${path}`;
  const parts: string[] = [];
  for (const part of combined.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
    else if (part !== '..' || !combined.startsWith('/')) parts.push(part);
  }
  return `${combined.startsWith('/') ? '/' : ''}${parts.join('/')}`;
}

const remoteResource = (value: string) => /^(?:https?:)?\/\//i.test(value);

interface Props {
  active: boolean;
  entry?: ExtensionEntry;
  creation?: ExtensionCreation;
  runtime?: ExtensionRuntimeReport;
  disabled: boolean;
  onClose(): void;
  onOpen(key: string): void;
  onDirtyChange(dirty: boolean): void;
  onBusyChange(busy: boolean): void;
  onChanged(context: ExtensionContext): Promise<void>;
  onAction(entry: ExtensionEntry, action: ExtensionAction, target?: string): Promise<void>;
  onCheckRuntime(context: ExtensionContext): Promise<void>;
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-3 py-1.5 text-xs leading-5">
    <dt className="text-fg-3">{label}</dt><dd className="min-w-0 text-fg-2">{children}</dd>
  </div>;
}

/** A selection owns its requests and drafts; a new scope cannot receive an older response. */
export function ExtensionInspector(props: Props) {
  const context = props.creation?.context ?? props.entry?.context;
  if (!context) return null;
  const key = props.creation ? `create:${extensionContextKey(context)}` : props.entry!.key;
  return <InspectorContent key={key} {...props} context={context} />;
}

function InspectorContent({
  active, entry, creation, runtime, disabled, onClose, onOpen, onDirtyChange,
  onBusyChange, onChanged, onAction, onCheckRuntime, context: initialContext,
}: Props & { context: ExtensionContext }) {
  const { t } = useLingui();
  const label = useBackendLabel();
  const actionLabels: Record<ExtensionAction, string> = {
    enable: t`启用`, disable: t`停用`, install: t`安装`, update: t`更新`,
    uninstall: t`卸载`, reload: t`重载 MCP`, login: t`认证`,
  };
  const stateLabels = { unknown: t`未确认`, loaded: t`已加载`, error: t`异常`, pending: t`等待加载` };
  const context = useRef(initialContext).current;
  const [detail, setDetail] = useState<ExtensionDetail>();
  const [document, setDocument] = useState<ExtensionDocument>();
  const [tab, setTab] = useState<'content' | 'files' | 'runtime'>('content');
  const [editing, setEditing] = useState(Boolean(creation));
  const [showSource, setShowSource] = useState(false);
  const [creating, setCreating] = useState(Boolean(creation));
  const [targetId, setTargetId] = useState(creation?.targets[0]?.id ?? '');
  const [newPath, setNewPath] = useState(() => creation?.targets[0] ? extensionNewPath(creation.targets[0]) : '');
  const [text, setText] = useState(() => creation?.targets[0] ? extensionTemplate(creation.targets[0]) : '');
  const [fileId, setFileId] = useState('');
  const [detailLoading, setDetailLoading] = useState(Boolean(entry));
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const [detailVersion, setDetailVersion] = useState(0);
  const alive = useRef(true);
  const readGeneration = useRef(0);
  const readController = useRef<AbortController | undefined>(undefined);
  const saveLock = useRef(false);
  const actionLock = useRef(false);
  const callbackRef = useRef({ onDirtyChange, onBusyChange });
  callbackRef.current = { onDirtyChange, onBusyChange };

  const dirty = creating || Boolean(document && text !== document.content);
  const blocked = !active || disabled || saving || actionBusy;
  const readBusy = detailLoading || reading;
  const target = creation?.targets.find(value => value.id === targetId);
  // Inventory carries the latest native state; a slower detail read must not restore old toggles.
  const item = entry?.item ?? detail?.item;
  const effectiveEntry = entry && item ? { ...entry, item } : undefined;
  const actions = effectiveEntry ? extensionActions(effectiveEntry) : [];
  const canToggle = Boolean(item && typeof item.enabled === 'boolean'
    && actions.includes(item.enabled ? 'disable' : 'enable'));
  const managementActions = canToggle ? actions.filter(action => action !== 'enable' && action !== 'disable') : actions;
  const secondaryActions = managementActions.filter(action => action === 'update' || action === 'uninstall');
  const matchingRuntime = effectiveEntry ? extensionRuntimeEntries(effectiveEntry, runtime) : [];
  const profileRuntime = !matchingRuntime.length && (item?.kind === 'hook' || item?.kind === 'mcp' && entry?.ambiguousNativeId
    || ['codex', 'traex'].includes(context.backendId) && Boolean(item?.sourcePath?.endsWith('.toml')));
  const runtimeEntries = profileRuntime ? runtime?.entries ?? [] : matchingRuntime;
  const KindIcon = item ? kindIcons[item.kind] : IconFileText;
  const selectionRef = useRef({ fileId, primaryId: detail?.item.documentId, dirty });
  selectionRef.current = { fileId, primaryId: detail?.item.documentId, dirty };
  const title = creating ? t`新建扩展` : item?.name ?? document?.path.split('/').at(-1) ?? t`扩展文件`;
  const toggleLabel = item?.enabled ? t`停用` : t`启用`;

  useEffect(() => {
    alive.current = active;
    return () => {
      alive.current = false;
      ++readGeneration.current;
      readController.current?.abort();
      callbackRef.current.onDirtyChange(false);
      callbackRef.current.onBusyChange(false);
    };
  }, [active]);
  useEffect(() => { onDirtyChange(active && dirty); }, [active, dirty, onDirtyChange]);
  useEffect(() => {
    if (!active || (!dirty && !saving)) return;
    const preventExit = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', preventExit);
    return () => window.removeEventListener('beforeunload', preventExit);
  }, [active, dirty, saving]);

  const readDocument = useCallback(async (id: string, keepDraft = false) => {
    if (!active) return;
    const generation = ++readGeneration.current;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    setFileId(id);
    if (!keepDraft) { setDocument(undefined); setText(''); setEditing(false); setShowSource(false); }
    setReading(true); setError(''); setMessage('');
    try {
      const value = await api.extensionDocument(context, id, controller.signal);
      if (!alive.current || controller.signal.aborted || generation !== readGeneration.current) return;
      setDocument(value);
      if (!keepDraft) setText(value.content);
      setConflict(false);
      setPreview(keepDraft);
    } catch (reason) {
      if (alive.current && !controller.signal.aborted && generation === readGeneration.current) {
        setError(errorMessage(reason, t`无法读取扩展文件`));
      }
    } finally {
      if (alive.current && !controller.signal.aborted && generation === readGeneration.current) setReading(false);
    }
  }, [active, context]);

  useEffect(() => {
    if (!active || !entry) return;
    const controller = new AbortController();
    setDetailLoading(true);
    setError('');
    void api.extension(context, entry.item.id, controller.signal).then(value => {
      if (!alive.current || controller.signal.aborted) return;
      const current = selectionRef.current;
      // Follow a renamed primary document, while preserving an explicitly selected related file.
      const id = current.fileId && current.fileId !== current.primaryId
        && value.files.some(file => file.id === current.fileId)
        ? current.fileId : value.item.documentId ?? '';
      setDetail(value);
      if (!current.dirty) {
        if (id) void readDocument(id);
        else { setFileId(''); setDocument(undefined); setText(''); setEditing(false); }
      }
    }).catch(reason => {
      if (alive.current && !controller.signal.aborted) setError(errorMessage(reason, t`无法读取扩展详情`));
    }).finally(() => {
      if (alive.current && !controller.signal.aborted) setDetailLoading(false);
    });
    return () => controller.abort();
  }, [active, context, entry?.key, entry?.item.documentId, detailVersion, readDocument]);

  const changeFile = useCallback(async (id: string) => {
    if (blocked || readBusy) return;
    if (id !== fileId && dirty && !await confirmDialog({ title: t`放弃未保存的修改？`, confirmLabel: t`切换文件`, destructive: true })) return;
    if (!alive.current) return;
    setTab('content');
    if (id !== fileId || !document) await readDocument(id);
  }, [blocked, readBusy, fileId, dirty, document, readDocument]);

  const readerResources = useMemo<Pick<Components, 'a' | 'img'>>(() => ({
    a({ children, href }) {
      if (href && (remoteResource(href) || /^mailto:/i.test(href))) {
        return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
      }
      const path = href && document ? extensionResourcePath(href, document.path) : undefined;
      const file = path && detail?.files.find(value => value.path === path);
      return file ? <button type="button" className="text-accent underline underline-offset-2" disabled={blocked || readBusy}
        title={file.path} onClick={() => void changeFile(file.id)}>{children}</button> : <span title={href}>{children}</span>;
    },
    img({ src, alt }) {
      if (typeof src !== 'string' || !src) return null;
      if (remoteResource(src)) return <ZoomableImage src={src} name={alt || t({ message: '图片', context: 'extensions-image-name' })} maxHeight={448} className="my-1 rounded-lg" />;
      return <span className="break-all text-fg-3" title={src}>{alt ? `${alt} (${src})` : src}</span>;
    },
  }), [document, detail?.files, blocked, readBusy, changeFile]);

  async function stopEditing() {
    if (blocked || readBusy) return;
    if (dirty && !await confirmDialog({ title: t`放弃未保存的修改？`, confirmLabel: t`放弃修改`, destructive: true })) return;
    if (!alive.current) return;
    setText(document?.content ?? ''); setEditing(false); setPreview(false); setConflict(false); setError('');
  }

  async function changeTarget(id: string) {
    if (blocked || readBusy || id === targetId) return;
    const next = creation?.targets.find(value => value.id === id);
    if (!next) return;
    const modified = target && (text !== extensionTemplate(target) || newPath !== extensionNewPath(target));
    if (modified && !await confirmDialog({ title: t`切换新建位置？`, description: t`当前内容将替换为所选位置的模板。`, confirmLabel: t`切换`, destructive: true })) return;
    if (!alive.current) return;
    setTargetId(id); setNewPath(extensionNewPath(next)); setText(extensionTemplate(next));
    setPreview(false); setError(''); setConflict(false);
  }

  async function reload(keepDraft = false) {
    if (blocked || readBusy || !document) return;
    const accepted = await confirmDialog({
      title: keepDraft ? t`读取最新文件并保留草稿？` : t`重新读取文件？`,
      description: keepDraft ? t`最新内容将作为比较和保存的基准。请在差异预览中检查并合并外部修改。` : dirty ? t`当前未保存的修改会被替换。` : undefined,
      confirmLabel: t`重新读取`, destructive: dirty && !keepDraft,
    });
    if (accepted && alive.current) await readDocument(document.id, keepDraft);
  }

  async function save() {
    if (saveLock.current || actionLock.current || blocked || readBusy || conflict || !dirty
      || (creating ? !target || !newPath.trim() : !document?.editable)) return;
    if (!preview) { setPreview(true); return; }
    saveLock.current = true;
    setSaving(true); onBusyChange(true); setError(''); setMessage('');
    try {
      const value = creating
        ? await api.createExtensionDocument(context, { targetId, path: newPath, content: text })
        : await api.saveExtensionDocument(context, document!.id, text, document!.hash);
      invalidateSlashCatalogs();
      if (!alive.current) return;
      setDocument(value); setFileId(value.id); setText(value.content); setCreating(false);
      setPreview(false); setEditing(false); setTab('content'); setConflict(false); setMessage(t`文件已保存。`);
      try { await onChanged(context); }
      catch { if (alive.current) setMessage(t`文件已保存，目录刷新失败；请稍后刷新。`); }
    } catch (reason) {
      if (!alive.current) return;
      const changed = reason instanceof HttpError && reason.code === 'CONFIG_CONFLICT';
      setConflict(changed);
      setError(changed ? t`文件已被外部修改，草稿已保留。` : errorMessage(reason, t`保存失败，草稿已保留。`));
    } finally {
      saveLock.current = false;
      if (alive.current) { setSaving(false); callbackRef.current.onBusyChange(false); }
    }
  }

  async function run(action?: ExtensionAction, runtimeTarget?: string) {
    if (!effectiveEntry || blocked || readBusy || dirty || actionLock.current || saveLock.current) return;
    actionLock.current = true; setActionBusy(true); setError(''); setMessage('');
    try {
      if (action) {
        await onAction(effectiveEntry, action, runtimeTarget);
        if (alive.current) setDetailVersion(value => value + 1);
      }
      else await onCheckRuntime(context);
    } catch (reason) {
      if (alive.current) setError(errorMessage(reason, action ? t({ message: '操作失败', context: 'extensions-action-failed' }) : t`无法读取运行状态`));
    } finally {
      actionLock.current = false;
      if (alive.current) setActionBusy(false);
    }
  }

  const sourceInformation = item && <div className="space-y-3 text-xs text-fg-3">
    {item.readOnlyReason && <p className="break-words leading-5">{item.readOnlyReason}</p>}
    {entry?.ownerKey && <Button size="xs" variant="quiet" disabled={blocked || dirty} onClick={() => onOpen(entry.ownerKey!)}><IconLayers />{entry.sourceLabel}</Button>}
    {item.sourcePath && <details><summary className="cursor-pointer"><Trans>来源</Trans></summary>
      <dl className="mt-2"><DetailRow label="Agent">{label(context.backendId)}</DetailRow><DetailRow label={t`作用域`}>{extensionScopes[item.scope]}</DetailRow>
        <DetailRow label={t`路径`}><span className="break-all font-mono text-2xs">{item.sourcePath}</span></DetailRow>
        {item.nativeId && <DetailRow label={t`原生标识`}><span className="break-all font-mono text-2xs">{item.nativeId}</span></DetailRow>}
      </dl>
    </details>}
  </div>;
  const markdownBody = (() => {
    const content = document?.content ?? '';
    if (item?.kind !== 'skill' || document?.id !== detail?.item.documentId) return content;
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const end = lines.indexOf('---', 1);
    return lines[0] === '---' && end > 0 && lines.slice(1, end).some(line => /^(name|description):/.test(line))
      ? lines.slice(end + 1).join('\n') : content;
  })();

  return <aside className="extensions-inspector" aria-label={t`${title} 详情`}>
    <div className="flex items-start gap-3 px-6 pt-6">
      <KindIcon className="mt-1 size-5 shrink-0 text-fg-3" />
      <div className="min-w-0 flex-1">
        <h2 className="break-words text-lg font-semibold text-fg">{title}</h2>
        <p className="mt-1 text-xs leading-5 text-fg-3">{[label(context.backendId), item && extensionScopes[item.scope]].filter(Boolean).join(' · ')}</p>
      </div>
      <Button variant="quiet" size="icon-sm" disabled={blocked} onClick={onClose} aria-label={t`关闭详情`}><IconX /></Button>
    </div>
    <div className="flex flex-wrap items-center gap-2 px-6 pb-5 pt-4">
      {item && <span className="mr-1 inline-flex items-center gap-2 text-xs text-fg-2">
        {typeof item.enabled === 'boolean' && <Switch checked={item.enabled} aria-label={t`${toggleLabel} ${item.name}`} disabled={!canToggle || blocked || readBusy || dirty} onCheckedChange={() => void run(item.enabled ? 'disable' : 'enable')} />}
        {item.enabled === undefined ? t`已发现` : item.enabled ? t`已启用` : t`已停用`}
      </span>}
      {managementActions.filter(action => action !== 'update' && action !== 'uninstall').map(action => <Button key={action} size="xs" variant="secondary" disabled={blocked || readBusy || dirty} onClick={() => void run(action)}>{actionLabels[action]}</Button>)}
      <span className="flex-1" />
      {!creating && !editing && document?.editable && <Button size="sm" variant="secondary" disabled={blocked || readBusy} onClick={() => { setTab('content'); setEditing(true); setPreview(false); }}><IconPencilLine /><Trans>编辑</Trans></Button>}
      {secondaryActions.length > 0 && <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon-sm" variant="quiet" aria-label={t`更多操作`} disabled={blocked || readBusy || dirty}><IconEllipsis /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">{secondaryActions.map(action => <DropdownMenuItem key={action} variant={action === 'uninstall' ? 'danger' : undefined} onSelect={() => void run(action)}>{item?.kind === 'skill' && action === 'uninstall' ? t`删除 Skill` : actionLabels[action]}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>}
    </div>
    {!creating && entry && <div className="h-10 shrink-0 border-b border-line px-3">
      <UnderlineTabs value={tab} onChange={setTab} ariaLabel={t`扩展详情`} options={[
        { value: 'content', label: <span className="inline-flex items-center gap-1.5"><Trans>内容</Trans>{dirty && <span className="size-1.5 rounded-full bg-warning" aria-label={t`未保存`} />}</span>, disabled: blocked },
        { value: 'files', label: detail ? t`文件 · ${detail.files.length}` : t({ message: '文件', context: 'extensions-files-tab' }), disabled: blocked },
        { value: 'runtime', label: t`运行状态`, disabled: blocked },
      ]} />
    </div>}
    <div className="extensions-inspector-body flex min-h-0 flex-1 flex-col gap-5 p-6">
      <FeedbackNotice scope={JSON.stringify(['extension-error', entry?.key ?? extensionContextKey(context), fileId])} message={error} tone="danger" noticeClassName="text-xs"
        action={() => conflict ? <Button size="xs" variant="ghost" disabled={blocked || readBusy} onClick={() => void reload(true)}><Trans>读取最新</Trans></Button> : undefined} />
      <FeedbackNotice scope={JSON.stringify(['extension-result', entry?.key ?? extensionContextKey(context), fileId])} message={message} tone="neutral" noticeClassName="text-xs" icon={null} />
      <FeedbackNotice scope={`extension-capability:${entry?.key ?? extensionContextKey(context)}`} message={entry?.capabilityError} tone="danger" noticeClassName="text-xs" />
      <FeedbackNotice scope={`extension-inventory:${entry?.key ?? extensionContextKey(context)}`} message={entry?.inventoryError} tone="neutral" noticeClassName="text-xs" />
      {item?.managementNote && <p className="text-xs leading-5 text-fg-3">{item.managementNote}</p>}
      {detailLoading ? <div className="flex justify-center py-8"><Spinner /></div> : !detail && entry && error ? <Button size="sm" disabled={blocked} onClick={() => setDetailVersion(value => value + 1)}><Trans>重新读取详情</Trans></Button> : tab === 'runtime' && effectiveEntry ? <section aria-label={t`运行状态`}>
        <div className="flex items-center justify-between gap-3"><h3 className="text-xs font-medium text-fg"><Trans>运行状态</Trans></h3><Button size="xs" variant="quiet" disabled={blocked || readBusy || dirty} onClick={() => void run()}><IconRefreshCw /><Trans>检查</Trans></Button></div>
        {runtimeEntries.length ? <>
          <p className="mt-2 text-xs text-fg-3" title={runtime ? t`检查于 ${formatClock(runtime.checkedAt)}` : undefined}>{profileRuntime ? t`配置会话` : t({ message: '会话', context: 'extensions-runtime-session' })} · {runtimeEntries.length}</p>
          {profileRuntime && <p className="mt-2 text-xs leading-5 text-fg-3"><Trans>配置级报告，尚未匹配到此条目。</Trans></p>}
          <ul className="mt-2 divide-y divide-line">{runtimeEntries.map((value, index) => <li key={`${value.sessionId}:${value.kind}:${value.name}:${index}`} className="py-3 text-xs">
            <div className="flex items-center justify-between gap-3"><span className="min-w-0 break-words text-fg-2">{value.name}</span><span className="inline-flex shrink-0 items-center gap-1.5 text-fg-3"><StatusDot tone={value.state === 'loaded' ? 'success' : value.state === 'error' ? 'danger' : value.state === 'pending' ? 'warning' : 'idle'} shape={value.state === 'unknown' ? 'ring' : 'dot'} />{stateLabels[value.state]}</span></div>
            <p className="mt-1 break-all font-mono text-[10px] text-fg-4"><Trans>会话 {value.sessionId}</Trans></p>
            {value.message && <p className="mt-1 whitespace-pre-wrap break-words leading-5 text-fg-3">{value.message}</p>}
            {value.tools?.length ? <details className="mt-2 text-fg-3"><summary className="cursor-pointer"><Trans>工具 · {value.tools.length}</Trans></summary><ul className="mt-1 space-y-1 font-mono text-2xs">{value.tools.map(tool => <li key={tool} className="break-all">{tool}</li>)}</ul></details> : null}
            {value.kind === 'mcp' && profileRuntime && entry?.capabilities?.kinds.mcp?.includes('login') && <Button size="xs" variant="ghost" className="mt-2" disabled={blocked || readBusy || dirty} onClick={() => void run('login', value.name)}><Trans>认证</Trans></Button>}
          </li>)}</ul>
        </> : <p className="mt-2 text-xs text-fg-3">{runtime ? t`未匹配到会话` : t`未检查`}</p>}
        {runtime?.diagnostics.length ? <details className="mt-3 text-xs text-fg-3"><summary className="cursor-pointer"><Trans>检查说明 · {runtime.diagnostics.length}</Trans></summary><div className="mt-2 space-y-1">{runtime.diagnostics.map((line, index) => <p key={index} className="break-words leading-5">{line}</p>)}</div></details> : null}
      </section> : tab === 'files' ? <>
        {sourceInformation}
        {detail?.files.length ? <ul className="divide-y divide-line rounded-lg border border-line">{detail.files.map(file => <li key={file.id}>
          <button type="button" className="flex w-full min-w-0 items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-hover disabled:opacity-50" disabled={blocked || readBusy} onClick={() => void changeFile(file.id)}>
            <IconFileText className="mt-0.5 size-4 shrink-0 text-fg-3" />
            <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium text-fg">{file.path.split('/').at(-1)}</span><span className="mt-1 block break-all font-mono text-2xs leading-5 text-fg-3">{file.path}</span></span>
            {file.id === detail.item.documentId && <Badge><Trans>主文件</Trans></Badge>}{!file.editable && <Badge><Trans>只读</Trans></Badge>}
          </button>
        </li>)}</ul> : <p className="text-xs text-fg-3"><Trans>此扩展未提供可查看的文件。</Trans></p>}
      </> : <>
        {creating && <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-xs text-fg-3"><Trans>类型与位置</Trans><Select aria-label={t`新建位置`} value={targetId} disabled={blocked} onChange={event => void changeTarget(event.target.value)}>{creation?.targets.map(value => <option key={value.id} value={value.id}>{value.label} · {extensionScopes[value.scope]}</option>)}</Select></label>
          <label className="flex flex-col gap-1.5 text-xs text-fg-3"><Trans>文件路径</Trans><Input aria-label={t`新建文件路径`} className="font-mono text-xs" value={newPath} disabled={blocked || Boolean(target?.fileName)} onChange={event => { setNewPath(event.target.value); setPreview(false); }} /></label>
          {!target && <p className="text-xs text-fg-3"><Trans>当前配置没有可用的新建位置。</Trans></p>}
        </div>}
        {reading ? <div className="flex justify-center py-8"><Spinner /></div> : creating || document ? <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 truncate text-xs font-medium text-fg" title={document?.path}>{preview ? t`保存预览` : document?.path.split('/').at(-1) ?? t`文件内容`}</span>
            <div className="flex flex-wrap items-center gap-1">
              {dirty && <Badge tone="warning"><Trans>未保存</Trans></Badge>}{document && !document.editable && <Badge><Trans>只读</Trans></Badge>}
              {!editing && document?.language === 'markdown' && <div className="inline-flex rounded-md border border-line p-0.5">{[{ value: false, label: t`阅读` }, { value: true, label: t`源码` }].map(option => <Button key={option.label} size="xs" variant={showSource === option.value ? 'secondary' : 'quiet'} aria-pressed={showSource === option.value} onClick={() => setShowSource(option.value)}>{option.label}</Button>)}</div>}
              {document && <Button size="icon-xs" variant="quiet" aria-label={t`重新读取文件`} title={t`重新读取文件`} disabled={blocked || readBusy} onClick={() => void reload()}><IconRefreshCw /></Button>}
              {editing && !creating && <Button size="xs" variant="quiet" disabled={blocked || readBusy} onClick={() => void stopEditing()}><Trans>取消编辑</Trans></Button>}
              {editing && <Button size="xs" variant="quiet" disabled={blocked} onClick={() => setPreview(value => !value)}>{preview ? t`继续编辑` : t`查看差异`}</Button>}
            </div>
          </div>
          {!editing && <>
            {item?.description && <p className="whitespace-pre-wrap break-words text-sm leading-6 text-fg-2">{item.description}</p>}
            {document?.reason && document.reason !== item?.readOnlyReason && <p className="text-xs leading-5 text-fg-3">{document.reason}</p>}
          </>}
          {!editing && document?.language === 'markdown' && !showSource
            ? <div className="min-w-0 border-t border-line pt-4"><Markdown text={markdownBody} resourceComponents={readerResources} /></div>
            : <Suspense fallback={<div className="flex justify-center py-8"><Spinner /></div>}><ExtensionEditor value={text} original={creating ? '' : document?.content ?? ''} preview={preview} readOnly={blocked || !editing || (!creating && !document?.editable)} onChange={setText} /></Suspense>}
          {editing && (creating || document?.editable) && <>
            {document?.applyEffect && <p className="text-xs leading-5 text-fg-3">{document.applyEffect}</p>}
            <div className="flex justify-end"><Button size="sm" variant="primary" disabled={blocked || readBusy || !dirty || conflict || (creating && (!target || !newPath.trim()))} onClick={() => void save()}>{saving ? <Spinner /> : <IconSave />}{preview ? t`确认保存` : t`预览保存`}</Button></div>
            {document?.validationNote && <details className="text-xs text-fg-3"><summary className="cursor-pointer"><Trans>文件格式</Trans></summary><p className="mt-2 leading-5">{document.validationNote}</p></details>}
          </>}
        </> : <div className="flex flex-col gap-4 text-xs text-fg-3">
          {item?.description && <p className="whitespace-pre-wrap break-words text-sm leading-6 text-fg-2">{item.description}</p>}
          {sourceInformation}
          {fileId && error ? <Button size="sm" disabled={blocked || readBusy} onClick={() => void readDocument(fileId)}><Trans>重新读取文件</Trans></Button> : detail?.files.length ? <Button size="sm" variant="secondary" onClick={() => setTab('files')}><IconFileText /><Trans>查看文件</Trans></Button> : <p><Trans>此扩展未提供可查看的文件。</Trans></p>}
        </div>}
      </>}
    </div>
  </aside>;
}
