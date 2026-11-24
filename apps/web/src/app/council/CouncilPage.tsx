import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { councilAwaitsReader, councilSuggestsClosing, type CouncilAgent, type CouncilCreateRequest, type CouncilDiscussion, type CouncilSummary, type NativeBackendCatalogEntry } from '@contracts';
import { api, type ProjectRecord } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Badge, Spinner } from '@/components/ui/controls';
import { Notice } from '@/components/ui/notice';
import { Tip } from '@/components/ui/tooltip';
import { IconGitFork, IconPanelRight, IconSquare, IconSquareKanban, IconSquarePen } from '@/components/icons';
import { confirmDialog } from '@/lib/dialogs';
import { PageScaffold } from '../PageScaffold';
import { Composer } from '../session/Composer';
import { useCouncil, useNav, useSettings, useStores } from '../state/stores';
import { CouncilAside, CouncilOverviewMenu } from './CouncilAside';
import { CouncilExportDialog, defaultExportBody } from './CouncilExportDialog';
import { CouncilLaunch } from './CouncilLaunch';
import { CouncilPromptDialog } from './CouncilPromptDialog';
import { CouncilHistoryMenu, CouncilRecent } from './CouncilNav';
import { CouncilStage, CouncilStageSkeleton } from './CouncilStage';
import { conclusionOf, seatName, useCouncilLabels } from './model';
import { SeatPicker, seatAgents } from './SeatPicker';
import { useCouncilDiscussion } from './useCouncilDiscussion';

export interface CouncilPageProps {
  projects: ProjectRecord[];
  backends: NativeBackendCatalogEntry[];
  sidebarCollapsed: boolean;
  onClose: () => void;
  onOpenSidebar: () => void;
  onExpandSidebar: () => void;
  /** Opens a new conversation with `quote` in its composer, for the reader to say what to do with it. */
  onDraftSession: (quote: string) => void;
  onOpenTasks: () => void;
  onOpenProviderSettings: () => void;
}

const summaryOf = (d: CouncilDiscussion): CouncilSummary => ({
  id: d.id, format: d.format, title: d.title, status: d.status, createdAt: d.createdAt, updatedAt: d.updatedAt, maxRounds: d.maxRounds, rhythm: d.rhythm,
  ...(d.settledAt ? { settledAt: d.settledAt } : {}), ...(d.seenAt ? { seenAt: d.seenAt } : {}),
  seats: d.seats.map((seat) => ({ role: seat.role, model: seat.model, ...(seat.task ? { task: seat.task } : {}) })),
});

/**
 * What the reader can do when the discussion waits: the next round, wrapping up, or a retry, with the model of the seat
 * that failed open to change first. A review has no composer, so its stop is here.
 */
export function CouncilControls({ discussion, onContinue, onStop, seatBackends, onSwapSeat }: {
  discussion: CouncilDiscussion;
  onContinue: (action: 'next' | 'conclude') => void;
  onStop?: () => void;
  /** What a seat can run on; with `onSwapSeat`, a failed seat's model can be changed. */
  seatBackends?: readonly NativeBackendCatalogEntry[];
  onSwapSeat?: (seatId: string, model: CouncilAgent) => void;
}) {
  const { t } = useLingui();
  const labels = useCouncilLabels();
  if (discussion.status === 'running') {
    return onStop && discussion.format === 'review'
      ? <Button size="sm" variant="secondary" onClick={onStop}><IconSquare /><span><Trans>停止</Trans></span></Button>
      : null;
  }
  // A failed step (in a debate one speech is the step) is retried as it was; its seat may first be put on another model.
  const failed = discussion.status === 'failed' ? discussion.speeches.findLast((s) => s.status === 'failed') : undefined;
  const failedSeat = failed && discussion.seats.find((seat) => seat.id === failed.seatId);
  const swap = failedSeat && seatBackends && onSwapSeat && (
    <span role="group" aria-label={t`更换 ${seatName(failedSeat, discussion.seats)} 的模型`} className="flex min-w-0 items-center gap-1 text-xs text-fg-3">
      <span className="shrink-0">{t`换成`}</span>
      <SeatPicker backends={seatAgents(seatBackends)} value={failedSeat.model} onChange={(model) => onSwapSeat(failedSeat.id, model)} />
    </span>
  );
  if (discussion.status === 'failed') {
    return (
      <Notice tone="danger" action={<span className="flex flex-wrap items-center gap-2">{swap}<Button size="xs" variant="secondary" onClick={() => onContinue('next')}><Trans>重试</Trans></Button></span>}>
        {discussion.error}
      </Notice>
    );
  }
  if (discussion.status !== 'paused') return null;
  const buttons = (primary: { label: string; action: 'next' | 'conclude'; disabled?: boolean }, secondary?: { label: string; action: 'next' | 'conclude' }) => (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="primary" disabled={primary.disabled} onClick={() => onContinue(primary.action)}>{primary.label}</Button>
      {secondary && <Button size="sm" variant="secondary" onClick={() => onContinue(secondary.action)}>{secondary.label}</Button>}
    </div>
  );
  if (discussion.speeches.some((s) => s.status === 'stopped')) return buttons({ label: t`继续`, action: 'next' });
  const next = discussion.round + 1;
  if (discussion.format === 'ld') {
    const closing = labels.phase('ld', 'closing');
    if (next >= (discussion.closingRound ?? discussion.maxRounds)) return buttons({ label: t`进入${closing}`, action: 'next' });
    const toNext = { label: t`继续${labels.round(next)}`, action: 'next' as const };
    const toClose = { label: t`进入${closing}`, action: 'conclude' as const };
    return councilSuggestsClosing(discussion) ? buttons(toClose, toNext) : buttons(toNext, toClose);
  }
  if (discussion.format === 'roundtable') {
    const toNext = { label: t`继续${labels.round(next)}`, action: 'next' as const };
    const toClose = { label: t`总结`, action: 'conclude' as const };
    return councilSuggestsClosing(discussion) ? buttons(toClose, toNext) : buttons(toNext, toClose);
  }
  if (discussion.format === 'prism') return buttons({ label: t`回应分歧`, action: 'next' }, { label: t`直接总结`, action: 'conclude' });
  return buttons({ label: t`生成修订稿`, action: 'next', disabled: !discussion.accepted?.length });
}

export function CouncilPage({
  projects,
  backends,
  sidebarCollapsed,
  onClose,
  onOpenSidebar,
  onExpandSidebar,
  onDraftSession,
  onOpenTasks,
  onOpenProviderSettings,
}: CouncilPageProps) {
  const { t } = useLingui();
  const labels = useCouncilLabels();
  const activeId = useNav((state) => state.councilDiscussionId);
  const asideOpen = useNav((state) => state.councilAsideOpen);
  const expandedSpeeches = useNav((state) => state.councilExpandedSpeeches);
  const enterBehavior = useSettings((settings) => settings.composerEnterBehavior);
  const { nav, council } = useStores();
  const listedItems = useCouncil((state) => state.items);
  const listed = listedItems !== undefined;
  const items = useMemo(() => listedItems ?? [], [listedItems]);
  // Seats run on quick chat too, which the Agents list leaves out; read again whenever that list changes.
  const [seatBackends, setSeatBackends] = useState<NativeBackendCatalogEntry[]>();
  // Seats are drafted once this read is over, so a remembered quick-chat seat is not swapped for an Agent first.
  const [seatsRead, setSeatsRead] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void api.councilAgents(controller.signal).then(setSeatBackends).catch(() => {}).finally(() => { if (!controller.signal.aborted) setSeatsRead(true); });
    return () => controller.abort();
  }, [backends]);
  const { discussion, missingId, rows, rowLoads, loadRows } = useCouncilDiscussion(activeId);
  const active = discussion && discussion.id === activeId ? discussion : undefined;
  const [exportKind, setExportKind] = useState<'task' | null>(null);
  const [exporting, setExporting] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const restoredDiscussion = useRef<string | null>(null);


  // The history row follows the open discussion's state.
  const status = discussion?.status;
  const updatedAt = discussion?.updatedAt;
  useEffect(() => {
    if (discussion && items.some(({ id }) => id === discussion.id)) council.upsert(summaryOf(discussion));
  }, [discussion?.id, status, updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Read once it settled while in view: the sidebar's mark for it goes, here and on the reader's other devices.
  const awaiting = Boolean(active && councilAwaitsReader(active));
  useEffect(() => {
    if (!awaiting || !activeId) return;
    const id = activeId;
    let sent = false;
    const mark = () => {
      if (sent || document.visibilityState !== 'visible') return;
      sent = true;
      void api.councilPatch(id, { seen: true }).then((updated) => {
        if (nav.get().councilDiscussionId === updated.id) council.upsert(summaryOf(updated));
      }).catch(() => { sent = false; });
    };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [awaiting, activeId, council, nav]);

  // Streaming keeps the newest text in view unless the reader scrolled up to read.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !active) return;
    if (restoredDiscussion.current !== active.id) {
      restoredDiscussion.current = active.id;
      const position = nav.getCouncilReadingPosition();
      if (position) {
        following.current = position.following;
        scroller.scrollTop = position.following ? scroller.scrollHeight : position.top;
        return;
      }
    }
    if (following.current && active.status === 'running') scroller.scrollTop = scroller.scrollHeight;
  }, [active, nav]);

  const select = useCallback((id: string | null) => {
    if (id === nav.get().councilDiscussionId) return;
    following.current = true;
    restoredDiscussion.current = null;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    nav.selectCouncilDiscussion(id);
  }, [nav]);

  const forget = useCallback((id: string) => {
    council.forget(id);
    if (nav.get().councilDiscussionId === id) select(null);
  }, [council, nav, select]);

  useEffect(() => {
    if (missingId) forget(missingId);
  }, [forget, missingId]);

  const run = useCallback(async <T,>(action: () => Promise<T>, failure: string): Promise<T | undefined> => {
    try {
      return await action();
    } catch (error) {
      toast.error(errorMessage(error, failure));
      return undefined;
    }
  }, []);

  const create = async (request: CouncilCreateRequest): Promise<boolean> => {
    const navigationRevision = nav.getNavigationRevision();
    const created = await run(() => api.councilCreate(request), t`无法开始协作`);
    if (!created) return false;
    council.upsert(summaryOf(created));
    if (nav.getNavigationRevision() === navigationRevision) select(created.id);
    return true;
  };

  const handleContinue = (action: 'next' | 'conclude') => {
    if (!activeId) return;
    following.current = true;
    void run(() => api.councilContinue(activeId, { action }), t`无法继续`);
  };

  const handleSupplement = async (text: string): Promise<boolean> => {
    if (!activeId) return false;
    following.current = true;
    return Boolean(await run(() => api.councilSupplement(activeId, { text }), t`无法发送`));
  };

  // The seats' conversations go with the discussion, and neither can be brought back.
  const handleDelete = async ({ id, title }: CouncilSummary) => {
    const confirmed = await confirmDialog({
      title: t`删除这个协作？`,
      description: t`「${title}」的发言和各席位的会话会一并删除，无法恢复。`,
      confirmLabel: t`删除协作`,
      destructive: true,
    });
    if (!confirmed) return;
    const done = await run(async () => { await api.councilDelete(id); return true; }, t`删除失败`);
    if (!done) return;
    forget(id);
  };

  const handleExport = async (payload: Parameters<typeof api.councilExport>[1]) => {
    if (!activeId) return;
    setExporting(true);
    const result = await run(() => api.councilExport(activeId, payload), t`导出失败`);
    setExporting(false);
    if (!result) return;
    setExportKind(null);
    toast.success(t`已创建任务`);
    onOpenTasks();
  };

  // While a discussion is read, its summary in the list already says what the page will show.
  const reading = !active && activeId ? items.find((item) => item.id === activeId) : undefined;
  const title = (active?.format === 'review' ? active.title : active?.topic || active?.title) ?? reading?.title;
  const concluded = active ? Boolean(conclusionOf(active)) : false;
  const noting = active && active.format !== 'review' && active.status !== 'done';

  return (
    <PageScaffold
      title={activeId ? <CouncilHistoryMenu items={items} activeId={activeId} title={title} onSelect={select} /> : t`模型协作`}
      meta={active || reading ? (
        <span className="inline-flex shrink-0 items-center gap-1">
          <Badge>{labels.format((active ?? reading)!.format)}</Badge>
          {active && <CouncilPromptDialog key={active.id} discussion={active} />}
        </span>
      ) : undefined}
      actions={active || reading ? (
        <>
          {concluded && (
            <>
              {/* Labelled where the header has room; icons below that, so the title keeps its place and nothing is pushed out. */}
              <Button size="sm" variant="secondary" className="max-xl:hidden" onClick={() => onDraftSession(defaultExportBody(active!).replace(/^# /, ''))}><IconGitFork /><span><Trans>带入会话</Trans></span></Button>
              <Button size="sm" variant="secondary" className="max-xl:hidden" onClick={() => setExportKind('task')}><IconSquareKanban /><span><Trans>转为任务</Trans></span></Button>
              <Tip label={t`带入会话`}><Button size="icon-sm" variant="quiet" className="max-md:hidden xl:hidden" aria-label={t`带入会话`} onClick={() => onDraftSession(defaultExportBody(active!).replace(/^# /, ''))}><IconGitFork /></Button></Tip>
              <Tip label={t`转为任务`}><Button size="icon-sm" variant="quiet" className="max-md:hidden xl:hidden" aria-label={t`转为任务`} onClick={() => setExportKind('task')}><IconSquareKanban /></Button></Tip>
            </>
          )}
          {active && <CouncilOverviewMenu discussion={active} />}
          <Tip label={asideOpen ? t`收起右侧栏` : t`展开右侧栏`}>
            <Button size="icon-sm" variant="quiet" className="max-xl:hidden" aria-label={t`切换右侧栏`} aria-pressed={asideOpen} onClick={() => nav.setCouncilAsideOpen(!asideOpen)}>
              <IconPanelRight />
            </Button>
          </Tip>
          <Tip label={t`新建协作`}>
            <Button size="icon-sm" variant="quiet" aria-label={t`新建协作`} onClick={() => select(null)}><IconSquarePen /></Button>
          </Tip>
        </>
      ) : undefined}
      column="none"
      scrollRef={scrollRef}
      onScroll={(event) => {
        if (!active) return;
        const scroller = event.currentTarget;
        following.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
        nav.rememberCouncilReadingPosition(active.id, { top: scroller.scrollTop, following: following.current });
      }}
      footer={noting ? (
        // Outside the scroller, as in a conversation: what scrolls stops at its top edge. The reading column's width,
        // the overview's place kept beside it.
        <div className="flex max-md:bg-bg">
          <div className="min-w-0 flex-1 pt-2 pb-4">
            <div className="mx-auto w-full max-w-(--content-width) px-3 sm:px-4 md:px-12">
              <Composer
                projectId=""
                draftKey={`council-note:${active.id}`}
                windowDrop={false}
                attachmentsAllowed={false}
                fileMentions={false}
                referencesEnabled={false}
                persistReferences={false}
                references={[]}
                onReferencesChange={() => {}}
                placeholder={t`补充看法或约束`}
                enterBehavior={enterBehavior}
                running={active.status === 'running'}
                onStop={() => void run(() => api.councilStop(active.id), t`无法停止`)}
                onSubmit={(text) => handleSupplement(text)}
                onError={(message) => toast.error(message)}
              />
            </div>
          </div>
          {asideOpen && <div className="w-[248px] shrink-0 max-xl:hidden" />}
        </div>
      ) : undefined}
      sidebarCollapsed={sidebarCollapsed}
      onClose={onClose}
      onOpenSidebar={onOpenSidebar}
      onExpandSidebar={onExpandSidebar}
    >
      {!activeId ? (
        <CouncilLaunch backends={seatBackends ?? backends} recent={listed && seatsRead ? items : undefined} onCreate={create} onOpenProviderSettings={onOpenProviderSettings} onError={(message) => toast.error(message)}>
          {items.length > 0 && <CouncilRecent items={items} onSelect={select} onDelete={(item) => void handleDelete(item)} />}
        </CouncilLaunch>
      ) : !active ? (
        reading ? (
          // The same column as the discussion's, the aside's place kept, so nothing moves once it is read.
          <div className="flex min-h-full">
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="mx-auto w-full max-w-(--content-width) flex-1 px-3 pt-6 pb-8 sm:px-4 sm:pt-8 md:px-12"><CouncilStageSkeleton summary={reading} /></div>
            </div>
            {asideOpen && <div className="w-[248px] shrink-0 max-xl:hidden" />}
          </div>
        ) : <div className="grid h-40 place-items-center"><Spinner /></div>
      ) : (
        <div className="flex min-h-full">
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="mx-auto w-full max-w-(--content-width) flex-1 px-3 pt-6 pb-8 sm:px-4 sm:pt-8 md:px-12">
              <CouncilStage
                discussion={active}
                rows={rows}
                rowLoads={rowLoads}
                expandedSpeeches={expandedSpeeches}
                onExpandSpeech={(id, expanded) => nav.setCouncilSpeechExpanded(active.id, id, expanded)}
                onLoadRows={loadRows}
                onRetryRecord={(speechId) => run(() => api.councilContinue(active.id, { action: 'record', speechId }), t`无法重新生成记录`)}
                onToggleEdit={(id, accepted) => void run(() => api.councilPatch(active.id, { edit: { id, accepted } }), t`更新失败`)}
              />
              <div className="timeline-gap-turn">
                <CouncilControls
                  discussion={active}
                  onContinue={handleContinue}
                  onStop={() => void run(() => api.councilStop(active.id), t`无法停止`)}
                  {...(seatBackends ? { seatBackends } : {})}
                  onSwapSeat={(seatId, model) => void run(() => api.councilPatch(active.id, { seat: { id: seatId, model } }), t`无法更换模型`)}
                />
              </div>
            </div>
          </div>
          {asideOpen && <div className="sticky top-0 self-start"><CouncilAside discussion={active} /></div>}
        </div>
      )}

      {active && exportKind && (
        <CouncilExportDialog
          open
          discussion={active}
          projects={projects}
          busy={exporting}
          onOpenChange={(open) => { if (!open) setExportKind(null); }}
          onConfirm={(payload) => void handleExport(payload)}
        />
      )}
    </PageScaffold>
  );
}
