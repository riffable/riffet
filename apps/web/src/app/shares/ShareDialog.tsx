import { useEffect, useRef, useState } from 'react';
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { SessionShare, ShareStatus, ShareAppearanceRequest, ShareDraft, ShareDraftProgress, ShareSelection, ShareTurnCatalog } from '@contracts';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, Segmented, Spinner, Switch } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { copyWithToast } from '@/lib/files';
import { confirmDialog } from '@/lib/dialogs';
import { toast } from '@/lib/toast';
import { errorMessage, formatDateTime } from '@/lib/utils';
import { shareCapabilityMessage, shares } from '@/lib/shares';
import { useNow } from '@/lib/use-now';
import { palettesOf, useAppearance } from '@/lib/appearance';
import { localizedText } from '@/lib/plugins';
import { useTheme } from '@/lib/theme';
import { useThemeOptions, syncThemeLibrary, themeOption } from '@/lib/theme-library';
import { textOf } from '@/lib/errors';
import { ThemeSwatch } from '@/components/theme-swatch';
import { formatDuration } from '@/lib/format-duration';
import { useLists } from '../state/stores';

const progressLabels: Record<ShareDraftProgress['stage'], MessageDescriptor> = {
  auth: msg`正在检查登录…`,
  history: msg`正在读取会话…`,
  assets: msg`正在准备预览…`,
  resources: msg`正在整理附件…`,
  finalizing: msg`正在完成预览…`,
};

export async function removeShare(share: SessionShare): Promise<SessionShare | undefined> {
  if (!await confirmDialog({ title: i18n._(msg`取消分享？`), description: i18n._(msg`链接将失效。`), confirmLabel: i18n._(msg`取消分享`), destructive: true })) return;
  return shares.remove(share.id);
}

export function ShareDialog({ sessionId, title, open, onOpenChange, purpose = 'share' }: { sessionId: string; title: string; open: boolean; onOpenChange: (open: boolean) => void; purpose?: 'share' | 'pdf' }) {
  const { t } = useLingui();
  const pdf = purpose === 'pdf';
  const [status, setStatus] = useState<ShareStatus>();
  const capability = status?.capability;
  const currentTheme = useTheme();
  const themeOptions = useThemeOptions();
  const { catalog, effective } = useAppearance();
  const pluginPalettes = palettesOf(catalog);
  /** What the page is painted with now: a share keeps a plugin's palette as a theme of its own, so it looks as it does here. */
  const paintedThemeId = currentTheme.paletteKey ?? currentTheme.themeId;
  const [appearance, setAppearance] = useState<ShareAppearanceRequest>({ themeId: paintedThemeId, mode: pdf ? 'light' : currentTheme.resolved });
  const owner = useLists((state) => state.owner);
  const hasOwner = Boolean(owner?.name || owner?.avatar);
  const [author, setAuthor] = useState(false);
  const [checking, setChecking] = useState(!pdf);
  const [share, setShare] = useState<SessionShare | null>();
  const [draft, setDraft] = useState<ShareDraft>();
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [printStatus, setPrintStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [printRevision, setPrintRevision] = useState(0);
  const [expiryDays, setExpiryDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ShareDraftProgress>();
  const [startedAt, setStartedAt] = useState(Date.now);
  const [previewStartedAt, setPreviewStartedAt] = useState(Date.now);
  const [error, setError] = useState('');
  const [selectionMode, setSelectionMode] = useState<ShareSelection['mode']>('all');
  const [recentCount, setRecentCount] = useState(20);
  const [turnCatalog, setTurnCatalog] = useState<ShareTurnCatalog>();
  const [selectedTurnIds, setSelectedTurnIds] = useState<string[]>([]);
  const [loadingTurns, setLoadingTurns] = useState(false);
  const [turnsError, setTurnsError] = useState('');
  const [turnsRevision, setTurnsRevision] = useState(0);
  const epoch = useRef(0);
  const statusRevision = useRef(0);
  const actionBusy = useRef(false);
  const actionAbort = useRef<AbortController | undefined>(undefined);
  const publishIntent = useRef<'create' | 'update' | undefined>(undefined);
  const previewFrame = useRef<HTMLIFrameElement>(null);
  const printFrame = useRef<HTMLIFrameElement>(null);
  const printLoaded = pdf ? previewLoaded : printStatus === 'ready';
  const loadingStatus = !pdf && (checking || share === undefined && !error);
  const accountName = [capability?.username, capability?.profile].filter(Boolean).join(' · ');
  const now = useNow(open && (loadingStatus || busy || Boolean(draft && !previewLoaded && !previewFailed)));

  useEffect(() => {
    setSelectionMode('all'); setRecentCount(20); setTurnCatalog(undefined); setSelectedTurnIds([]); setTurnsError('');
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    const generation = ++epoch.current;
    const readRevision = ++statusRevision.current;
    const controller = new AbortController();
    setChecking(true); setShare(undefined); setDraft(undefined); setPreviewLoaded(false); setPreviewFailed(false); setPrintStatus('loading'); setError(''); setBusy(false); setProgress(undefined); setStartedAt(Date.now());
    actionBusy.current = false;
    publishIntent.current = undefined;
    setStatus(undefined);
    if (pdf) {
      setChecking(false); setShare(null);
      setAppearance({ themeId: paintedThemeId, mode: 'light' }); setAuthor(false);
    } else {
      void shares.status(sessionId, true, controller.signal).then(value => {
        if (generation !== epoch.current || readRevision !== statusRevision.current) return;
        setStatus(value); setShare(value.share);
        setAppearance(value.share?.appearance ?? { themeId: paintedThemeId, mode: currentTheme.resolved });
        setAuthor(value.share?.author === true);
      }).catch(reason => {
        if (generation === epoch.current) setError(errorMessage(reason, t`无法读取分享状态`));
      }).finally(() => { if (generation === epoch.current) setChecking(false); });
    }
    void syncThemeLibrary();
    return () => { epoch.current += 1; statusRevision.current += 1; controller.abort(); actionAbort.current?.abort(); };
  }, [open, sessionId, purpose]);

  useEffect(() => {
    if (!open || selectionMode !== 'selected' || draft) return;
    let current = true;
    const controller = new AbortController();
    setLoadingTurns(true); setTurnsError(''); setTurnCatalog(undefined);
    void shares.turns(sessionId, controller.signal).then(catalog => {
      if (!current) return;
      setTurnCatalog(catalog);
      const availableIds = new Set(catalog.turns.map(turn => turn.id));
      setSelectedTurnIds(previous => previous.filter(id => availableIds.has(id)));
    }).catch(reason => {
      if (current && !controller.signal.aborted) setTurnsError(errorMessage(reason, t`无法读取会话列表`));
    }).finally(() => { if (current) setLoadingTurns(false); });
    return () => { current = false; controller.abort(); };
  }, [open, sessionId, selectionMode, Boolean(draft), turnsRevision]);

  useEffect(() => {
    if (pdf || !open || !share?.operation || share.operation === 'uncertain') return;
    let current = true;
    let reading = false;
    const timer = window.setInterval(() => {
      if (actionBusy.current || reading) return;
      reading = true;
      const readRevision = ++statusRevision.current;
      void shares.status(sessionId).then(value => {
        if (!current || readRevision !== statusRevision.current) return;
        setStatus(previous => previous?.share && value.share && value.share.updatedAt < previous.share.updatedAt ? previous : value);
        setShare(previous => previous && value.share && value.share.updatedAt < previous.updatedAt ? previous : value.share);
        reportPublishOutcome(value.share);
      }).catch(reason => {
        if (current && readRevision === statusRevision.current) setError(errorMessage(reason, t`无法读取分享状态`));
      }).finally(() => { reading = false; });
    }, 2000);
    return () => { current = false; window.clearInterval(timer); };
  }, [open, sessionId, share?.operation, pdf]);

  useEffect(() => {
    if (!open || !draft) return;
    const ready = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const preview = event.source === previewFrame.current?.contentWindow;
      const print = event.source === printFrame.current?.contentWindow;
      if (!preview && !print) return;
      const value: unknown = event.data;
      if (!value || typeof value !== 'object' || !('type' in value)) return;
      if (value.type === 'riffet-share-error' && (!('capturedAt' in value) || value.capturedAt === draft.capturedAt)) {
        if (preview) { setPreviewLoaded(false); setPreviewFailed(true); }
        else setPrintStatus('error');
        return;
      }
      if (value.type !== 'riffet-share-ready' || !('capturedAt' in value) || value.capturedAt !== draft.capturedAt) return;
      if (preview) { setPreviewLoaded(true); setPreviewFailed(false); }
      else setPrintStatus('ready');
    };
    window.addEventListener('message', ready);
    return () => window.removeEventListener('message', ready);
  }, [open, draft]);

  useEffect(() => {
    if (!open || !draft || previewLoaded || previewFailed) return;
    const timer = window.setTimeout(() => setPreviewFailed(true), pdf ? 45_000 : 30_000);
    return () => window.clearTimeout(timer);
  }, [open, draft, previewLoaded, previewFailed, previewRevision, pdf]);

  useEffect(() => {
    if (!open || !draft || pdf || printStatus !== 'loading') return;
    const timer = window.setTimeout(() => setPrintStatus('error'), 45_000);
    return () => window.clearTimeout(timer);
  }, [open, draft, pdf, printStatus, printRevision]);

  const execute = async (action?: (signal: AbortSignal) => Promise<void>, fresh = false, refreshStatus = true) => {
    if (actionBusy.current) return;
    actionBusy.current = true;
    statusRevision.current += 1;
    const generation = epoch.current;
    const controller = new AbortController();
    actionAbort.current = controller;
    setBusy(true); setError(''); setStartedAt(Date.now());
    if (fresh) setChecking(true);
    try {
      await action?.(controller.signal);
      if (generation !== epoch.current || controller.signal.aborted || pdf || !refreshStatus) return;
      const readRevision = ++statusRevision.current;
      const value = await shares.status(sessionId, fresh, controller.signal);
      if (generation === epoch.current && readRevision === statusRevision.current) { setStatus(value); setShare(value.share); reportPublishOutcome(value.share); }
    }
    catch (reason) { if (generation === epoch.current && !controller.signal.aborted) { publishIntent.current = undefined; setError(errorMessage(reason, pdf ? t`PDF 导出失败` : t`分享操作失败`)); void syncThemeLibrary(); } }
    finally { if (generation === epoch.current) { if (fresh) setChecking(false); setBusy(false); setProgress(undefined); actionBusy.current = false; actionAbort.current = undefined; } }
  };
  const cancel = () => {
    epoch.current += 1; statusRevision.current += 1;
    actionAbort.current?.abort(); actionAbort.current = undefined; actionBusy.current = false;
    publishIntent.current = undefined;
    setBusy(false); setProgress(undefined);
  };
  const reportPublishOutcome = (next: SessionShare | null | undefined) => {
    const intent = publishIntent.current;
    if (!intent || !next) return;
    if (next.operation === 'publishing') return;
    publishIntent.current = undefined;
    if (!next.operation && next.state === 'published' && next.url) {
      toast.success(intent === 'update' ? t`分享链接已更新` : t`分享链接已创建`);
    }
  };
  const publisher = capability?.publisher;
  const audience = publisher?.audience;
  const localOnly = pdf || Boolean(capability && !publisher);
  const pending = busy || Boolean(share?.operation && share.operation !== 'uncertain');
  const published = share?.state === 'published' && share.url;
  const canRemove = status?.actions.remove;
  const selection: ShareSelection = selectionMode === 'selected'
    ? { mode: 'selected', turnIds: selectedTurnIds, ...(turnCatalog?.nativeChatId ? { nativeChatId: turnCatalog.nativeChatId } : {}) }
    : selectionMode === 'recent' ? { mode: 'recent', count: recentCount } : { mode: 'all' };
  const selectionReady = selectionMode !== 'selected' || Boolean(!loadingTurns && !turnsError && turnCatalog && selectedTurnIds.length);
  const selectedTurnIdSet = new Set(selectedTurnIds);
  const prepare = () => execute(async signal => {
    if (!selectionReady) return;
    const generation = epoch.current;
    setPrintStatus('loading');
    setProgress({ stage: localOnly ? 'history' : 'auth' });
    const value = await (pdf ? shares.printDraft : shares.draft)(sessionId, value => { if (generation === epoch.current && !signal.aborted) setProgress(value); }, signal, selection, { themeId: appearance.themeId, mode: appearance.mode, ...(themeOption(appearance.themeId)?.builtin === false ? { themeRevision: themeOption(appearance.themeId)!.revision } : {}),
      ...(effective.uiFont ? { uiFont: effective.uiFont.id } : {}), ...(effective.monoFont ? { monoFont: effective.monoFont.id } : {}), ...(effective.background ? { background: effective.background.id } : {}) }, hasOwner && author);
    if (generation === epoch.current && !signal.aborted) { setDraft(value); setPreviewLoaded(false); setPreviewFailed(false); setPreviewStartedAt(Date.now()); }
  });
  const publish = () => draft && execute(async () => {
    const generation = epoch.current;
    publishIntent.current = published ? 'update' : 'create';
    const result = await shares.publish(sessionId, draft.id, expiryDays);
    if (generation === epoch.current) { setShare(result); setDraft(undefined); reportPublishOutcome(result); }
  });
  const print = () => execute(async signal => {
    const generation = epoch.current;
    if (!draft || !printLoaded) throw new Error(t`打印预览尚未就绪，请重试`);
    // The printable document is prepared alongside the visible preview, from the same frozen draft.
    const frame = pdf ? previewFrame : printFrame;
    const reader = frame.current?.contentWindow;
    if (!reader?.riffetPreparePrint) throw new Error(t`打印预览尚未就绪，请重试`);
    await reader.riffetPreparePrint();
    if (generation !== epoch.current || signal.aborted || frame.current?.contentWindow !== reader) return;
    reader.print();
  }, false, false);
  return (
    <Dialog open={open} onOpenChange={value => { if (!value) cancel(); onOpenChange(value); }}>
      <DialogContent mobileFullscreen size={draft ? 'workspace' : 'form'} className={draft ? 'h-[min(92dvh,1000px)]' : undefined} aria-describedby={undefined}>
        <DialogHeader className={draft ? 'pb-3' : 'pb-5'}>
          <DialogTitle className="text-base">{pdf ? <Trans>导出为 PDF</Trans> : <Trans>分享会话</Trans>}</DialogTitle>
          {!pdf && !draft && <p className="truncate text-sm text-fg-3" title={title}>{title}</p>}
        </DialogHeader>
        {draft && <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 pb-3 text-xs text-fg-3">
          <span className="min-w-0"><Trans>内容截至 {formatDateTime(draft.capturedAt)}</Trans></span>
          {publisher && <span>{publisher.audience}</span>}
          <div className="ml-auto flex items-center gap-2">
            {!pdf && printStatus === 'loading' && <span role="status" className="flex items-center gap-2"><Spinner /><Trans>正在准备 PDF…</Trans></span>}
            {!pdf && printStatus === 'error' && <><span role="alert"><Trans>PDF 准备失败</Trans></span><Button variant="quiet" size="sm" disabled={pending} onClick={() => { setPrintStatus('loading'); setPrintRevision(value => value + 1); }}><Trans>重试</Trans></Button></>}
            <Button className="shrink-0" size="sm" disabled={(pending && !(busy && !progress)) || !printLoaded} busy={busy && !progress} title={t`打开系统打印窗口，选择“保存为 PDF”`} onClick={() => void print()}>
              <Trans>导出为 PDF</Trans>
            </Button>
          </div>
          <p className="basis-full text-right"><Trans>在打印窗口选择“保存为 PDF”，并关闭“页眉和页脚”。</Trans></p>
        </div>}
        <DialogBody className={draft ? 'flex min-h-0 flex-1 flex-col gap-3 pb-4' : 'space-y-4 pb-5'}>
          {(loadingStatus || progress || !pdf && accountName) && <div role="status" className="flex min-h-8 shrink-0 items-center gap-2 text-sm text-fg-3">
            {loadingStatus || progress ? <>
              <Spinner />
              <span className="min-w-0 truncate">{progress ? i18n._(progressLabels[progress.stage]) : checking ? t`正在检查登录…` : t`正在读取分享状态…`}</span>
              <span className="shrink-0 text-xs tabular-nums">{formatDuration(now - startedAt)}</span>
            </> : <span className="truncate" title={accountName}>{accountName}</span>}
          </div>}
          {!draft && !localOnly && !checking && capability && !capability.available && <p className="text-sm text-fg-3">{shareCapabilityMessage(capability)}</p>}
          {!checking && status?.blocker && <p className="text-sm text-fg-3">{(status.blocker.messageRef && textOf(status.blocker.messageRef, status.blocker.message)) || status.blocker.message}</p>}
          {published && <div className="space-y-1.5 rounded-lg bg-subtle p-3">
            <a href={share.url} target="_blank" rel="noopener noreferrer" className="block break-all text-sm text-accent hover:underline">{share.url}</a>
            {(audience || share.expiresAt) && <p className="text-xs text-fg-3">{[audience, share.expiresAt && t`${formatDateTime(share.expiresAt)} 到期`].filter(Boolean).join(' · ')}</p>}
            {share.capturedAt && <p className="text-xs text-fg-3"><Trans>内容截至 {formatDateTime(share.capturedAt)}</Trans></p>}
          </div>}
          {!draft && <div className="space-y-4">
            <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-x-4 gap-y-4 max-sm:grid-cols-1 max-sm:gap-y-2">
              <label htmlFor="share-selection-mode" className="text-sm text-fg-2">{pdf ? <Trans>导出范围</Trans> : <Trans>分享范围</Trans>}</label>
              <div className="flex min-w-0 items-center gap-2">
                <Select id="share-selection-mode" label={pdf ? t`导出范围` : t`分享范围`} value={selectionMode} disabled={pending} onChange={setSelectionMode}
                  options={[{ value: 'recent', label: t`最近几轮` }, { value: 'selected', label: t`手动选择` }, { value: 'all', label: t`全部` }]} />
                {selectionMode === 'recent' && <Select label={pdf ? t`导出轮数` : t`分享轮数`} className="w-24 shrink-0" value={String(recentCount)} disabled={pending} onChange={value => setRecentCount(Number(value))}
                  options={[1, 5, 10, 20, 50].map(count => ({ value: String(count), label: t`${count} 轮` }))} />}
              </div>
            </div>
            {selectionMode === 'selected' && <div className="overflow-hidden rounded-lg border border-line">
              {loadingTurns ? <p role="status" className="flex items-center gap-2 p-3 text-sm text-fg-3"><Spinner /><Trans>正在读取会话列表…</Trans></p>
                : turnsError ? <div className="flex items-center justify-between gap-2 p-3"><p role="alert" className="text-sm text-danger">{turnsError}</p><Button variant="quiet" size="sm" onClick={() => setTurnsRevision(value => value + 1)}><Trans>重试</Trans></Button></div>
                : turnCatalog && <>
                  <div className="flex items-center justify-between border-b border-line px-3 py-1.5 text-xs text-fg-3">
                    <span><Trans>已选 {selectedTurnIds.length} 轮</Trans></span>
                    <Button variant="quiet" size="sm" disabled={pending || !turnCatalog.turns.length} onClick={() => setSelectedTurnIds(selectedTurnIds.length === turnCatalog.turns.length ? [] : turnCatalog.turns.map(turn => turn.id))}>{selectedTurnIds.length === turnCatalog.turns.length && turnCatalog.turns.length ? t`清空` : t`全选`}</Button>
                  </div>
                  <div className="max-h-72 overflow-y-auto divide-y divide-line">
                    {turnCatalog.turns.map(turn => <label key={turn.id} className="flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-subtle">
                      <Checkbox className="mt-0.5" checked={selectedTurnIdSet.has(turn.id)} disabled={pending} onCheckedChange={checked => setSelectedTurnIds(previous => checked === true ? [...previous, turn.id] : previous.filter(id => id !== turn.id))} />
                      <span className="min-w-0 flex-1 space-y-1"><span className="line-clamp-2 block whitespace-pre-wrap break-words text-sm text-fg">{turn.text || t`无文字提问`}</span><span className="block text-xs text-fg-3">{formatDateTime(turn.createdAt)}</span></span>
                    </label>)}
                    {!turnCatalog.turns.length && <p className="p-3 text-sm text-fg-3">{pdf ? <Trans>没有可导出的会话记录</Trans> : <Trans>没有可分享的会话记录</Trans>}</p>}
                  </div>
                </>}
            </div>}
            <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-x-4 gap-y-4 border-t border-line pt-4 max-sm:grid-cols-1 max-sm:gap-y-2">
              <label htmlFor="share-theme" className="text-sm text-fg-2"><Trans>主题</Trans></label>
              <Select id="share-theme" label={t`主题`} value={appearance.themeId} disabled={pending} onChange={themeId => setAppearance(previous => ({ ...previous, themeId }))}
                options={[
                  ...themeOptions.map(theme => ({ value: theme.id, label: theme.name, icon: <ThemeSwatch id={theme.id} className="h-4 w-6 rounded-sm" /> })),
                  ...pluginPalettes.map(({ palette, key }) => ({ value: key, label: localizedText(palette.title) ?? palette.id, icon: <ThemeSwatch id={key} className="h-4 w-6 rounded-sm" /> })),
                ]} />
              <span className="text-sm text-fg-2 max-sm:mt-2"><Trans>明暗</Trans></span>
              <Segmented ariaLabel={t`明暗`} value={appearance.mode} onChange={mode => setAppearance(previous => ({ ...previous, mode }))} options={[{ value: 'system', label: t`跟随系统`, disabled: pending }, { value: 'light', label: t`浅色`, disabled: pending }, { value: 'dark', label: t`深色`, disabled: pending }]} />
              {!pdf && hasOwner && <>
                <label htmlFor="share-author" className="text-sm text-fg-2 max-sm:mt-2"><Trans>显示分享者</Trans></label>
                <Switch id="share-author" checked={author} disabled={pending} onCheckedChange={setAuthor} />
              </>}
            </div>
          </div>}
          {draft && <>
            <div className="relative flex min-h-64 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-bg">
              <iframe ref={previewFrame} key={`${draft.id}:${previewRevision}`} title={pdf ? t`PDF 预览` : t`分享预览`} src={pdf ? `${draft.previewUrl}${draft.previewUrl.includes('?') ? '&' : '?'}print=1` : draft.previewUrl} sandbox={`allow-scripts allow-same-origin allow-downloads${pdf ? ' allow-modals' : ''}`} referrerPolicy="no-referrer" onError={event => { if (event.currentTarget === previewFrame.current) { setPreviewLoaded(false); setPreviewFailed(true); } }} className="min-h-64 w-full flex-1 border-0" />
              {!previewLoaded && <div role="status" className="absolute inset-0 flex items-center justify-center gap-2 bg-bg text-sm text-fg-3">
                {previewFailed ? <><Trans>无法加载预览</Trans><Button variant="quiet" size="sm" onClick={() => { setPreviewFailed(false); setPreviewStartedAt(Date.now()); setPreviewRevision(value => value + 1); }}><Trans>重试</Trans></Button></> : <><Spinner /><Trans>正在加载预览…</Trans><span className="text-xs tabular-nums">{formatDuration(now - previewStartedAt)}</span></>}
              </div>}
            </div>
            {!pdf && <iframe ref={printFrame} key={`${draft.id}:${printRevision}`} title={t`PDF 预览`} src={`${draft.previewUrl}${draft.previewUrl.includes('?') ? '&' : '?'}print=1`} sandbox="allow-scripts allow-same-origin allow-modals" referrerPolicy="no-referrer" aria-hidden="true" tabIndex={-1} onError={event => { if (event.currentTarget === printFrame.current) setPrintStatus('error'); }} className="pointer-events-none fixed left-[-10000px] top-0 h-[297mm] w-[210mm] border-0" />}
          </>}
          {(error || share?.error) && <p role="alert" className="text-sm text-danger">{error || (share?.errorRef && textOf(share.errorRef, share.error)) || share?.error}</p>}
          {share?.operation && <p className="flex items-center gap-2 text-xs text-fg-3">{share.operation !== 'uncertain' && <Spinner />}{share.operation === 'publishing' ? t`正在发布…` : share.operation === 'removing' ? t`正在取消分享…` : t`操作结果待核对`}</p>}
        </DialogBody>
        <DialogFooter className="border-t border-line">
          <div className="flex flex-wrap items-center justify-end gap-2">
          {!pdf && (!capability?.available || status?.blocker || checking || error) && <Button variant="quiet" size="sm" disabled={busy || checking} onClick={() => void execute(undefined, true)}><Trans>刷新</Trans></Button>}
          {published && <Button variant="quiet" size="sm" onClick={() => void copyWithToast(share.url!)}><Trans>复制链接</Trans></Button>}
          {canRemove && share && !draft && <Button variant="quiet" size="sm" disabled={!status?.actions.remove || pending} onClick={() => void execute(async () => { const generation = epoch.current; const value = await removeShare(share); if (value && generation === epoch.current) setShare(value); })}><Trans>取消分享</Trans></Button>}
          {share?.operation === 'uncertain' ? <>
            <Button variant="quiet" size="sm" disabled={!status?.actions.reconcile || busy} onClick={() => void execute(async () => { const generation = epoch.current; const value = await shares.reconcile(share.id); if (generation === epoch.current) setShare(value); })}><Trans>核对状态</Trans></Button>
            <Button size="sm" disabled={!status?.actions.retry || busy} onClick={() => void execute(async () => { const generation = epoch.current; const value = await shares.retry(share.id); if (generation === epoch.current) setShare(value); })}><Trans>重试</Trans></Button>
          </> : draft ? <>
            <Button size="sm" variant="quiet" disabled={pending} onClick={() => { setDraft(undefined); setPreviewLoaded(false); }}><Trans>返回</Trans></Button>
            {!localOnly && <>
              <div className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap text-xs text-fg-3"><span><Trans>有效期</Trans></span><Select label={t`分享有效期`} className="w-24" value={String(expiryDays)} disabled={pending} onChange={value => setExpiryDays(Number(value))} options={[7, 30, 90, 365].map(days => ({ value: String(days), label: t`${days} 天` }))} /></div>
              <Button size="sm" disabled={!status?.actions.publish || pending || !previewLoaded} onClick={() => void publish()}>{busy && !checking ? t`发布中…` : published ? t`更新链接` : t`创建链接`}</Button>
            </>}
          </> : <Button size="sm" busy={busy} disabled={(!pdf && (!status?.actions.preview || share === undefined)) || (pending && !busy) || !selectionReady} onClick={() => void prepare()}>{published && !localOnly ? t`更新分享` : t`生成预览`}</Button>}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
