import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { Attachment, DiscussionCreateRequest, DiscussionSource, ModelInfo, Run, Session } from '@contracts';
import { IconChevronDown, IconEllipsis, IconMaximize, IconMessagesSquare, IconMinimize, IconTrash2, IconX } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { FeedbackNotice } from '@/components/ui/feedback-notice';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api, HttpError, type NativeSessionCreateResult } from '@/lib/api';
import { catalogParams, catalogSelection, parseSelection, serializeSelection } from '@/lib/models';
import { cn, errorMessage, newId } from '@/lib/utils';
import { Composer } from './Composer';
import { TranscriptView } from './TranscriptView';
import { AnswerBringBackContext, WorkingIndicator } from './Timeline';
import { useSessionSync } from './useSessionSync';
import { useSessionTranscript } from './useSessionTranscript';
import { isUncertainRequest } from './nativeOutbox';
import { SessionMarksContext } from './marks';
import { ImageSourceContext, projectImageSource } from './imageSource';
import { FileAccessContext } from './fileAccess';
import { SubagentContext, SubagentStoreContext, NativeJobStoreContext } from './subagents';
import { ActivityContext, useActivityControls } from './Activities';
import { OverlayScopeContext, useOverlayState } from '@/lib/overlay-navigation';
import { readNativeOutbox, writeNativeOutbox, removeNativeOutbox } from '@/lib/native-outbox-storage';
import { ModelPicker } from './ModelPicker';
import { isSessionDeleted, onSessionsDeleted } from '@/lib/session-deletion';
import { requestSessionDeletion, useDeletionLoading } from '../SessionDeletion';
import { useLists } from '../state/stores';

export interface DiscussionDraft { id: string; source: DiscussionSource; request?: DiscussionCreateRequest }
export type DiscussionTarget = { draft: DiscussionDraft } | { session: Session; run?: Run };
const pendingKey = (parentId: string) => `riffet.discussion-create.${parentId}`;
const draftSourceKey = (parentId: string) => `riffet.discussion-source.${parentId}`;
const selectedKey = (parentId: string) => `riffet.discussion-selected.${parentId}`;

function readSource(parentId: string): DiscussionDraft | undefined {
  try {
    const draft = JSON.parse(sessionStorage.getItem(draftSourceKey(parentId)) ?? 'null') as DiscussionDraft | null;
    return draft && typeof draft.id === 'string' && typeof draft.source?.anchor?.messageId === 'string'
      && typeof draft.source.quote?.exact === 'string' && typeof draft.source.quote.prefix === 'string'
      && typeof draft.source.quote.suffix === 'string' ? draft : undefined;
  } catch { return undefined; }
}

function readSelected(parentId: string): string | undefined {
  try { return sessionStorage.getItem(selectedKey(parentId)) ?? undefined; }
  catch { return undefined; }
}

function selectStored(parentId: string, sessionId?: string): void {
  try {
    if (sessionId) sessionStorage.setItem(selectedKey(parentId), sessionId);
    else sessionStorage.removeItem(selectedKey(parentId));
  } catch { /* The current discussion still remains selected in memory. */ }
}

function readPending(parentId: string): DiscussionDraft | undefined {
  try {
    const copies = readNativeOutbox([pendingKey(parentId)]).filter(item => item.key === pendingKey(parentId));
    if (new Set(copies.map(item => item.value)).size > 1) return undefined;
    const value = JSON.parse(copies[0]?.value ?? 'null') as Partial<DiscussionCreateRequest> | null;
    if (!value || typeof value.clientSessionId !== 'string' || typeof value.commandId !== 'string' || typeof value.text !== 'string'
      || typeof value.anchor?.messageId !== 'string' || typeof value.quote?.exact !== 'string'
      || typeof value.quote.prefix !== 'string' || typeof value.quote.suffix !== 'string') return undefined;
    const request = value as DiscussionCreateRequest;
    return { id: request.clientSessionId, source: { anchor: request.anchor, quote: request.quote }, request };
  } catch { return undefined; }
}

/** Parent-scoped UI state. Closing the panel keeps its target; the server owns sent discussions. */
export function useSideDiscussion(parent: Session, onSessionChanged: (session: Session) => void, onTargetDeleted?: () => void) {
  const [threads, setThreads] = useState<Session[]>([]);
  const [target, setTarget] = useState<DiscussionTarget>();
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState('');
  const epoch = useRef(0);
  const listRevision = useRef(0);
  const parentId = useRef(parent.id);
  parentId.current = parent.id;
  const refresh = useCallback(async () => {
    const observed = epoch.current;
    const revision = ++listRevision.current;
    setLoading(true);
    setListError('');
    try {
      const sessions = await api.discussions(parent.id);
      if (observed === epoch.current && revision === listRevision.current) {
        const live = sessions.filter(item => !isSessionDeleted(item.id));
        setThreads(live);
        const selected = readSelected(parent.id);
        const saved = selected && live.find(session => session.id === selected);
        if (saved) setTarget(current => current ?? { session: saved });
      }
    } catch (error) {
      if (observed === epoch.current && revision === listRevision.current) setListError(errorMessage(error));
    } finally { if (observed === epoch.current && revision === listRevision.current) setLoading(false); }
  }, [parent.id]);
  useEffect(() => {
    epoch.current += 1;
    setThreads([]);
    const pending = readPending(parent.id) ?? (readSelected(parent.id) ? undefined : readSource(parent.id));
    setTarget(pending ? { draft: pending } : undefined);
    void refresh();
    return () => { epoch.current += 1; };
  }, [parent.id, refresh]);
  // A side chat deleted here or elsewhere leaves the list, and the panel stops showing it.
  useEffect(() => onSessionsDeleted((ids) => {
    setThreads(current => current.filter(item => !ids.includes(item.id)));
    if (target && 'session' in target && ids.includes(target.session.id)) { setTarget(undefined); onTargetDeleted?.(); }
  }), [target, onTargetDeleted]);
  const start = useCallback((source: DiscussionSource) => {
    // An uncertain creation remains the same request until it has a receipt.
    const pending = readPending(parent.id);
    const stored = readSource(parent.id);
    // Before the first send there is one draft per parent. Changing its passage retains its input.
    const draft = pending ?? { id: stored?.id ?? newId(), source };
    try { sessionStorage.setItem(draftSourceKey(parent.id), JSON.stringify({ id: draft.id, source: draft.source })); } catch { /* Composer reports unavailable draft storage. */ }
    selectStored(parent.id);
    setTarget({ draft });
  }, [parent.id]);
  const created = useCallback((result: NativeSessionCreateResult) => {
    if (result.session.origin?.sessionId !== parentId.current) return;
    listRevision.current += 1;
    try { if (readSource(parent.id)?.id === result.session.id) sessionStorage.removeItem(draftSourceKey(parent.id)); } catch { /* The durable discussion remains discoverable. */ }
    setLoading(false);
    setThreads(current => [result.session, ...current.filter(item => item.id !== result.session.id)]);
    setTarget(current => {
      if (current && ('session' in current || current.draft.id !== result.session.id)) return current;
      selectStored(parent.id, result.session.id);
      return { session: result.session, run: result.run };
    });
    onSessionChanged(result.session);
  }, [parent.id, onSessionChanged]);
  const changed = useCallback((session: Session) => {
    if (session.origin?.sessionId !== parentId.current) return;
    setThreads(current => current.map(item => item.id === session.id ? session : item));
    setTarget(current => current && 'session' in current && current.session.id === session.id ? { ...current, session } : current);
    onSessionChanged(session);
  }, [onSessionChanged]);
  const reopen = useCallback((session: Session) => {
    selectStored(parent.id, session.id);
    setTarget({ session });
  }, [parent.id]);
  return { threads, target, loading, listError, start, created, changed, reopen, refresh };
}

type DiscussionController = ReturnType<typeof useSideDiscussion>;

export function DiscussionPanel({ parent, discussion, active, enterBehavior, onLocateSource, onBringBack, onClose, expandedSize, onToggleSize, className }: {
  parent: Session;
  discussion: DiscussionController;
  active: boolean;
  enterBehavior?: string;
  onLocateSource: (source: DiscussionSource) => void;
  onBringBack: (text: string) => void;
  onClose: () => void;
  expandedSize: boolean;
  onToggleSize: () => void;
  className?: string;
}) {
  const { t } = useLingui();
  const target = discussion.target;
  const source = target && ('draft' in target ? target.draft.source : target.session.origin?.discussion);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [source?.quote.exact]);
  const title = target && 'session' in target ? target.session.title : t`侧边聊天`;
  const deletable = useLists(state => state.sessionDelete);
  const chat = target && 'session' in target ? target.session : undefined;
  const deleting = useDeletionLoading(chat?.id ?? '');
  return (
    <div className={cn('flex min-h-0 min-w-0 flex-col', className)}>
      <div className="flex h-12 shrink-0 items-center gap-1.5 px-3">
        <IconMessagesSquare className="size-4 shrink-0 text-fg-3" />
        {discussion.threads.length > 0 ? <DropdownMenu onOpenChange={open => { if (open) void discussion.refresh(); }}>
          <DropdownMenuTrigger className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-1 text-left text-sm font-medium text-fg outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus" title={title}><span className="min-w-0 truncate">{title}</span><IconChevronDown className="size-3 shrink-0 text-fg-3" /></DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
            {discussion.threads.map(session => <DropdownMenuItem key={session.id} onSelect={() => discussion.reopen(session)} className="min-w-0"><span className="truncate">{session.title}</span></DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu> : <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>}
        {deletable && chat && <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="icon-sm" variant="quiet" aria-label={t`更多操作`} title={t`更多操作`}><IconEllipsis className="size-4" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem variant="danger" disabled={deleting} onSelect={() => void requestSessionDeletion(chat)}><IconTrash2 /><Trans>删除…</Trans></DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>}
        <Button size="icon-sm" variant="quiet" aria-label={expandedSize ? t`恢复大小` : t`放大聊天`} title={expandedSize ? t`恢复大小` : t`放大聊天`} onClick={onToggleSize}>{expandedSize ? <IconMinimize className="size-4" /> : <IconMaximize className="size-4" />}</Button>
        <Button size="icon-sm" variant="quiet" aria-label={t`关闭侧边聊天`} title={t`关闭侧边聊天`} onClick={onClose}><IconX className="size-4" /></Button>
      </div>
      {source && <div className="shrink-0 px-3 pb-2">
        <div className="flex items-start gap-1 rounded-lg bg-subtle p-2.5">
          <button type="button" aria-label={t`回到原文`} title={t`回到原文`} onClick={() => onLocateSource(source)} className="min-w-0 flex-1 rounded-sm text-left text-xs text-fg-2 outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus">
            <span className={cn('block whitespace-pre-wrap wrap-anywhere', expanded ? 'max-h-28 overflow-y-auto' : 'line-clamp-2')}>{source.quote.exact}</span>
          </button>
          <Button size="icon-xs" variant="quiet" aria-label={expanded ? t`收起` : t`展开`} title={expanded ? t`收起` : t`展开`} onClick={() => setExpanded(value => !value)}><IconChevronDown className={cn('size-3.5', expanded && 'rotate-180')} /></Button>
        </div>
      </div>}
      <FeedbackNotice scope={parent.id} message={discussion.listError} tone="warning" className="mx-3 mt-3" action={() => <Button size="xs" onClick={() => void discussion.refresh()}><Trans>重试</Trans></Button>} />
      {!target ? <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-fg-3"><Trans>选中回答中的文字开始聊天</Trans></div>
        : 'draft' in target ? <NewDiscussion key={target.draft.id} parent={parent} draft={target.draft} active={active} enterBehavior={enterBehavior} onCreated={discussion.created} />
          : <DiscussionConversation key={target.session.id} session={target.session} initialRun={target.run} active={active} enterBehavior={enterBehavior} onSessionChanged={discussion.changed} onBringBack={onBringBack} />}
    </div>
  );
}

/** Adapter for the session host. Kept mounted while closed to retain draft and read position. */
export function SideDiscussionPanel({ parent, source, openRequest, active, enterBehavior, onClose, onSessionChanged, onOpenSource, onBringBack, onSourceConsumed }: {
  parent: Session;
  source?: DiscussionSource;
  /** A discussion to show, e.g. one picked from the session's info; each new `nonce` is a new request. */
  openRequest?: { session: Session; nonce: number };
  active: boolean;
  enterBehavior?: string;
  onClose: () => void;
  onSessionChanged: (session: Session) => void;
  onOpenSource: (source: DiscussionSource) => void;
  onBringBack: (text: string) => void;
  onSourceConsumed: () => void;
}) {
  const { t } = useLingui();
  const discussion = useSideDiscussion(parent, onSessionChanged, onClose);
  const pane = useRef<HTMLDivElement>(null);
  const [expandedSize, setExpandedSize] = useState(false);
  const conversation = discussion.target && 'session' in discussion.target;
  const overlay = useOverlayState({ open: active, onOpenChange: open => { if (!open) onClose(); } });
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => pane.current?.querySelector<HTMLTextAreaElement>('[data-composer-input]')?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [active]);
  useEffect(() => { if (active) void discussion.refresh(); }, [active, discussion.refresh]);
  useEffect(() => { if (source) { discussion.start(source); onSourceConsumed(); } }, [source, discussion.start, onSourceConsumed]);
  useEffect(() => { if (openRequest) discussion.reopen(openRequest.session); }, [openRequest, discussion.reopen]);
  useEffect(() => {
    if (!source && !discussion.target && discussion.threads[0]) discussion.reopen(discussion.threads[0]);
  }, [source, discussion.target, discussion.threads, discussion.reopen]);
  return <OverlayScopeContext.Provider value={overlay.scope}><div ref={pane}
    role="dialog" aria-label={t`侧边聊天`} tabIndex={-1} data-composer-drop="none"
    className={cn('absolute bottom-3 right-3 z-(--z-dock) flex max-h-[calc(100%-24px)] max-w-[calc(100%-24px)] flex-col overflow-hidden rounded-2xl bg-elevated text-fg shadow-pop outline-none',
      expandedSize ? 'h-[calc(100%-24px)] w-[560px]' : conversation ? 'h-[560px] w-[400px]' : 'h-[320px] w-[400px]',
      active ? 'animate-in fade-in-0 slide-in-from-right-2 duration-[var(--duration-fast)]' : 'hidden!')}
  ><DiscussionPanel parent={parent} discussion={discussion} active={active} enterBehavior={enterBehavior} onLocateSource={onOpenSource} onBringBack={onBringBack} onClose={onClose} expandedSize={expandedSize} onToggleSize={() => setExpandedSize(value => !value)} className="flex-1" /></div></OverlayScopeContext.Provider>;
}

function NewDiscussion({ parent, draft, active, enterBehavior, onCreated }: {
  parent: Session; draft: DiscussionDraft; active: boolean; enterBehavior?: string; onCreated: (result: NativeSessionCreateResult) => void;
}) {
  const { t } = useLingui();
  const [recovered] = useState(() => {
    const stored = readPending(parent.id);
    return draft.request ?? (stored?.id === draft.id ? stored.request : undefined);
  });
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [uncertain, setUncertain] = useState(Boolean(recovered));
  const models = useDiscussionModels(parent);
  const [chosen, setChosen] = useState<{ scope: string; model: string }>();
  const modelScope = `${parent.backendId}:${parent.backendProfileId}:${parent.model}`;
  const chosenModel = chosen?.scope === modelScope ? chosen.model : recovered?.model;
  const pending = useRef(recovered);
  const [restored, setRestored] = useState<{ text: string; attachments: Attachment[]; onPersisted?: () => void; nonce: number }>();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const send = async (text: string, onStored?: () => boolean) => {
    if (sending) return false;
    const request = pending.current ?? { ...draft.source, clientSessionId: draft.id, commandId: newId(), text, ...(chosenModel ? { model: chosenModel } : {}) };
    try { writeNativeOutbox(pendingKey(parent.id), JSON.stringify(request)); }
    catch (failure) { setError(errorMessage(failure, t`无法保存待发送消息，请检查浏览器存储空间`)); return false; }
    pending.current = request;
    setSending(true);
    setError('');
    try {
      if (onStored && !onStored()) throw new HttpError(409, t`草稿无法保存到浏览器，刷新后会丢失`, 'CLIENT_DRAFT_NOT_PERSISTED');
      const result = await api.createDiscussion(parent.id, request);
      try { removeNativeOutbox(pendingKey(parent.id)); } catch { /* A known receipt must not become an uncertain send. */ }
      onCreated(result);
      return true;
    } catch (failure) {
      const unknown = isUncertainRequest(failure);
      if (!unknown) {
        if (uncertain || onStored) setRestored({ text: request.text, attachments: [], onPersisted: () => removeNativeOutbox(pendingKey(parent.id)), nonce: Date.now() });
        pending.current = undefined; try { if (!uncertain && !onStored) removeNativeOutbox(pendingKey(parent.id)); } catch { /* Keep the original id if storage becomes unavailable. */ } }
      if (!mounted.current) return false;
      setUncertain(unknown);
      setError(unknown ? '' : errorMessage(failure, t`无法发起侧边聊天`));
      return unknown;
    } finally { if (mounted.current) setSending(false); }
  };
  const check = async () => {
    const request = pending.current;
    if (!request || sending) return;
    setSending(true);
    try {
      const found = (await api.sessions()).find(item => item.id === request.clientSessionId);
      const run = found ? (await api.runs(found.id, request.commandId)).find(item => item.sessionId === found.id && item.commandId === request.commandId) : undefined;
      if (!found || !run || !mounted.current) return;
      removeNativeOutbox(pendingKey(parent.id));
      onCreated({ session: found, run });
    } catch (failure) { if (mounted.current) setError(errorMessage(failure, t`无法检查状态，请稍后重试`)); }
    finally { if (mounted.current) setSending(false); }
  };
  return <>
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
      <div className="flex min-h-full flex-col justify-end">
      <FeedbackNotice scope={`${parent.id}:${draft.id}`} message={!uncertain && error} tone="danger" className="mb-2" />
      <Composer
        projectId={parent.projectId}
        draftKey={`discussion:${draft.id}`}
        disabled={sending || uncertain}
        autoFocus={active}
        embedded
        windowDrop={false}
        attachmentsAllowed={false}
        placeholder={t`输入消息`}
        restoreDraft={restored}
        enterBehavior={enterBehavior}
        fileMentions={false}
        references={[]}
        onReferencesChange={() => {}}
        endPickers={<DiscussionModel models={models} value={chosenModel ?? models.model} disabled={sending || uncertain} onChange={model => setChosen({ scope: modelScope, model })} />}
        mobileSettingsLabel={parseSelection(chosenModel ?? models.model).model.split(':').slice(2).join(':') || t`主会话模型`}
        submitDisabled={sending || uncertain}
        onSubmit={async (text, _attachments, _references, onStored) => send(text, onStored)}
        onError={setError}
        feedback={uncertain ? <div className="rounded-lg bg-subtle px-3 py-2 text-xs text-fg-3"><p className="line-clamp-2 break-words text-fg-2">{pending.current?.text}</p><div className="mt-1 flex flex-wrap items-center gap-3"><span><Trans>暂时无法确认是否已发送</Trans></span><button type="button" disabled={sending} onClick={() => void check()} className="underline underline-offset-2 disabled:opacity-50"><Trans>检查状态</Trans></button><button type="button" disabled={sending} onClick={() => void send(pending.current!.text)} className="underline underline-offset-2 disabled:opacity-50"><Trans>重试发送</Trans></button></div>{error && <p className="mt-1 text-danger">{error}</p>}</div> : undefined}
      />
      </div>
    </div>
  </>;
}

/** Scope is resolved by the server, so no client fallback can switch the provider. */
function useDiscussionModels(session: Session) {
  const scope = `${session.id}:${session.backendProfileId}:${session.model}`;
  const [catalog, setCatalog] = useState<{ scope: string; model: string; models: ModelInfo[]; providerName: string }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++revision.current;
    setLoading(true);
    setError('');
    try {
      const next = await api.discussionModels(session.id);
      if (current === revision.current) setCatalog({ ...next, scope });
    } catch (failure) { if (current === revision.current) setError(errorMessage(failure)); }
    finally { if (current === revision.current) setLoading(false); }
  }, [session.id, scope]);
  useEffect(() => { void refresh(); return () => { revision.current += 1; }; }, [refresh]);
  const current = catalog?.scope === scope ? catalog : undefined;
  // Nothing known for this scope yet counts as loading from the first render, before the effect has started the request.
  return { model: current?.model, catalog: current?.models ?? [], providerName: current?.providerName, loading: loading || (!current && !error), error, refresh };
}

function DiscussionModel({ models, value, disabled, onChange }: {
  models: ReturnType<typeof useDiscussionModels>; value?: string; disabled?: boolean; onChange: (model: string) => void;
}) {
  const { t } = useLingui();
  const selection = parseSelection(value);
  const choices = models.catalog.map(model => ({ id: model.value, label: model.name }));
  if (selection.model && !choices.some(item => item.id === selection.model)) choices.unshift({ id: selection.model, label: selection.model.split(':').slice(2).join(':') });
  const params = catalogParams(models.catalog, selection.model, selection.params);
  const select = (model: string, overrides = selection.params) => {
    const selected = parseSelection(catalogSelection(models.catalog, model, overrides));
    onChange(serializeSelection(selected.model, { ...selected.params, ...(selection.params.fast ? { fast: selection.params.fast } : {}) }));
  };
  return <div className="min-w-0 max-w-full" title={models.providerName ?? t`主会话模型`}><ModelPicker models={choices} value={selection.model} params={params} onChange={model => select(model)} onParamChange={(id, next) => select(selection.model, { ...selection.params, [id]: next })} disabled={disabled || models.loading && !value} loading={models.loading && !models.catalog.length} error={models.error} onRetry={() => void models.refresh()} /></div>;
}

function DiscussionConversation({ session, initialRun, active, enterBehavior, onSessionChanged, onBringBack }: {
  session: Session; initialRun?: Run; active: boolean; enterBehavior?: string; onSessionChanged: (session: Session) => void; onBringBack: (text: string) => void;
}) {
  const { t } = useLingui();
  const [error, setError] = useState('');
  const [switchingModel, setSwitchingModel] = useState(false);
  const models = useDiscussionModels(session);
  const [restoreDraft, setRestoreDraft] = useState<{ text: string; attachments: []; onPersisted?: () => void; nonce: number }>();
  const native = useSessionSync(session, { onSessionChanged, onError: setError, notificationsEnabled: false, initialRun });
  const working = native.status.phase === 'busy' || native.sending || native.interrupting || native.runs.some(run => run.state === 'running');
  const transcript = useSessionTranscript(native, { working, busy: working, compacting: false });
  const activities = useActivityControls(session.id, () => native.activities);
  const source = useMemo(() => projectImageSource(session.projectId), [session.projectId]);
  return <>
    <SessionMarksContext.Provider value={undefined}>
    <AnswerBringBackContext.Provider value={onBringBack}>
    <ImageSourceContext.Provider value={source}>
    <FileAccessContext.Provider value={{ projectId: session.projectId }}>
    <SubagentContext.Provider value={null}>
    <SubagentStoreContext.Provider value={native.subagents}>
    <NativeJobStoreContext.Provider value={native.jobs}>
    <ActivityContext.Provider value={activities}>
      <TranscriptView
        embedded
        sessionId={session.id}
        timeline={transcript.visibleTimeline}
        timelineVersion={native.timelineVersion}
        resetVersion={native.resetVersion}
        loaded={native.loaded}
        catchingUp={native.catchingUp}
        historyLoad={native.historyLoad}
        onRetryHistory={native.retryConnection}
        running={working}
        activeTurnId={native.status.activeTurnId}
        onOpenPath={() => {}}
        hasMoreHistory={native.history?.hasMore}
        loadingEarlier={native.loadingHistory}
        onLoadEarlier={native.loadOlder}
        hasMoreLater={native.hasMoreLater}
        loadingLater={native.loadingLater}
        onLoadLater={native.loadLater}
        onReaderEnd={native.readerAtEnd}
        onJumpToLatest={native.jumpToLatest}
        onLoadTurn={native.loadTurn}
        onExpandRow={native.expandRow}
        onRetryNativeRun={native.retryNativeRun}
        onCheckNativeRun={native.checkNativeRun}
        onCancelNativeRun={native.cancelNativeRun}
        onRestoreNativeRun={async run => {
          const restoredRun = await native.recoverNativeRun(run);
          if (restoredRun) setRestoreDraft({ text: restoredRun.text, attachments: [], onPersisted: restoredRun.onPersisted, nonce: Date.now() });
        }}
        progress={working ? <WorkingIndicator connected={native.connected} /> : undefined}
      />
    </ActivityContext.Provider>
    </NativeJobStoreContext.Provider>
    </SubagentStoreContext.Provider>
    </SubagentContext.Provider>
    </FileAccessContext.Provider>
    </ImageSourceContext.Provider>
    </AnswerBringBackContext.Provider>
    </SessionMarksContext.Provider>
    <div className="flex shrink-0 flex-col gap-2 px-3 pb-3">
      <FeedbackNotice scope={session.id} message={error} tone="danger" />
      <Composer
        projectId={session.projectId}
        draftKey={session.id}
        autoFocus={active}
        embedded
        windowDrop={false}
        attachmentsAllowed={false}
        placeholder={t`输入消息`}
        enterBehavior={enterBehavior}
        fileMentions={false}
        references={[]}
        onReferencesChange={() => {}}
        endPickers={<DiscussionModel models={models} value={session.model} disabled={working || switchingModel || native.hasUnknownSubmission || Boolean(session.archivedAt)} onChange={model => {
          setSwitchingModel(true); setError('');
          void api.nativeSetModel(session.id, model).then(onSessionChanged).catch(failure => setError(errorMessage(failure))).finally(() => setSwitchingModel(false));
        }} />}
        mobileSettingsLabel={parseSelection(session.model).model.split(':').slice(2).join(':')}
        running={working}
        onStop={() => void native.cancel()}
        stopping={native.interrupting}
        stopDisabled={native.interrupting || native.sending || !native.connected}
        submitDisabled={working || switchingModel || !native.connected || native.hasUnknownSubmission || Boolean(session.archivedAt)}
        restoreDraft={restoreDraft}
        onSubmit={async (prompt, attachments, references, onStored) => { setError(''); return native.send(prompt, attachments, references, onStored); }}
        onError={setError}
      />
    </div>
  </>;
}
