import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { councilSuggestsClosing, type CouncilCreateRequest, type CouncilDiscussion, type CouncilSummary, type NativeBackendCatalogEntry } from '@contracts';
import { api, type ProjectRecord } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Badge, Spinner } from '@/components/ui/controls';
import { Notice } from '@/components/ui/notice';
import { Tip } from '@/components/ui/tooltip';
import { IconGitFork, IconPanelRight, IconSquareKanban } from '@/components/icons';
import { PageScaffold } from '../PageScaffold';
import { Composer } from '../session/Composer';
import { useNav, useSettings, useStores } from '../state/stores';
import { CouncilAside, CouncilOverviewMenu } from './CouncilAside';
import { CouncilExportDialog } from './CouncilExportDialog';
import { CouncilLaunch } from './CouncilLaunch';
import { CouncilPromptDialog } from './CouncilPromptDialog';
import { CouncilAsideNav, CouncilHistoryMenu } from './CouncilNav';
import { CouncilStage, CouncilStageSkeleton } from './CouncilStage';
import { conclusionOf, useCouncilLabels } from './model';
import { useCouncilDiscussion } from './useCouncilDiscussion';

export interface CouncilPageProps {
  projects: ProjectRecord[];
  backends: NativeBackendCatalogEntry[];
  sidebarCollapsed: boolean;
  onClose: () => void;
  onOpenSidebar: () => void;
  onExpandSidebar: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenTasks: () => void;
  onOpenProviderSettings: () => void;
}

const summaryOf = (d: CouncilDiscussion): CouncilSummary => ({
  id: d.id, format: d.format, title: d.title, status: d.status, createdAt: d.createdAt, updatedAt: d.updatedAt, maxRounds: d.maxRounds, rhythm: d.rhythm,
  seats: d.seats.map((seat) => ({ role: seat.role, model: seat.model, ...(seat.task ? { task: seat.task } : {}) })),
});

/** What the reader can do when the discussion waits: the next round, wrapping up, or a retry. */
export function CouncilControls({ discussion, onContinue }: { discussion: CouncilDiscussion; onContinue: (action: 'next' | 'conclude') => void }) {
  const { t } = useLingui();
  const labels = useCouncilLabels();
  if (discussion.status === 'failed') {
    return (
      <Notice tone="danger" action={<Button size="xs" variant="secondary" onClick={() => onContinue('next')}><Trans>重试</Trans></Button>}>
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
  onOpenSession,
  onOpenTasks,
  onOpenProviderSettings,
}: CouncilPageProps) {
  const { t } = useLingui();
  const labels = useCouncilLabels();
  const { nav } = useStores();
  const activeId = useNav((state) => state.councilDiscussionId);
  const asideOpen = useNav((state) => state.councilAsideOpen);
  const expandedSpeeches = useNav((state) => state.councilExpandedSpeeches);
  const enterBehavior = useSettings((settings) => settings.composerEnterBehavior);
  const [items, setItems] = useState<CouncilSummary[]>([]);
  const deletedWhileListing = useRef<Set<string> | undefined>(undefined);
  const [listed, setListed] = useState(false);
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
  const [exportKind, setExportKind] = useState<'task' | 'session' | null>(null);
  const [exporting, setExporting] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const restoredDiscussion = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const deletedIds = new Set<string>();
    deletedWhileListing.current = deletedIds;
    const end = () => {
      if (deletedWhileListing.current === deletedIds) deletedWhileListing.current = undefined;
    };
    void api.councilList(controller.signal).then(({ items }) => {
      if (controller.signal.aborted) return;
      setItems((current) => {
        const present = new Set(current.map(({ id }) => id));
        return [...current, ...items.filter(({ id }) => !present.has(id) && !deletedIds.has(id))];
      });
    }).catch(() => {}).finally(() => {
      end();
      if (!controller.signal.aborted) setListed(true);
    });
    return () => { controller.abort(); end(); };
  }, [nav]);

  // The history row follows the open discussion's state.
  const status = discussion?.status;
  const updatedAt = discussion?.updatedAt;
  useEffect(() => {
    if (!discussion) return;
    setItems((current) => current.map((item) => (item.id === discussion.id ? summaryOf(discussion) : item)));
  }, [discussion?.id, status, updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

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
    deletedWhileListing.current?.add(id);
    setItems((current) => current.filter((item) => item.id !== id));
    if (nav.get().councilDiscussionId === id) select(null);
  }, [nav, select]);

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
    setItems((current) => [summaryOf(created), ...current.filter(({ id }) => id !== created.id)]);
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

  const handleDelete = async (id: string) => {
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
    if (result.kind === 'task') {
      toast.success(t`已创建任务`);
      onOpenTasks();
    } else {
      onOpenSession(result.id);
    }
  };

  // While a discussion is read, its summary in the list already says what the page will show.
  const reading = !active && activeId ? items.find((item) => item.id === activeId) : undefined;
  const title = (active?.format === 'review' ? active.title : active?.topic || active?.title) ?? reading?.title;
  const concluded = active ? Boolean(conclusionOf(active)) : false;
  const noting = active && active.format !== 'review' && active.status !== 'done';

  return (
    <PageScaffold
      title={(
        <span className="flex min-w-0 items-center">
          <span className="hidden truncate lg:block">{title ?? t`模型协作`}</span>
          <CouncilHistoryMenu items={items} activeId={activeId} title={title} onSelect={select} />
        </span>
      )}
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
              <Button size="sm" variant="secondary" className="max-md:hidden" onClick={() => setExportKind('session')}><IconGitFork /><span><Trans>带入会话</Trans></span></Button>
              <Button size="sm" variant="secondary" className="max-md:hidden" onClick={() => setExportKind('task')}><IconSquareKanban /><span><Trans>转为任务</Trans></span></Button>
            </>
          )}
          {active && <CouncilOverviewMenu discussion={active} />}
          <Tip label={asideOpen ? t`收起右侧栏` : t`展开右侧栏`}>
            <Button size="icon-sm" variant="quiet" className="max-xl:hidden" aria-label={t`切换右侧栏`} aria-pressed={asideOpen} onClick={() => nav.setCouncilAsideOpen(!asideOpen)}>
              <IconPanelRight />
            </Button>
          </Tip>
        </>
      ) : undefined}
      column="none"
      aside={<CouncilAsideNav items={items} activeId={activeId} onSelect={select} onDelete={(id) => void handleDelete(id)} />}
      scrollRef={scrollRef}
      onScroll={(event) => {
        if (!active) return;
        const scroller = event.currentTarget;
        following.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
        nav.rememberCouncilReadingPosition(active.id, { top: scroller.scrollTop, following: following.current });
      }}
      sidebarCollapsed={sidebarCollapsed}
      onClose={onClose}
      onOpenSidebar={onOpenSidebar}
      onExpandSidebar={onExpandSidebar}
    >
      {!activeId ? (
        <CouncilLaunch backends={seatBackends ?? backends} recent={listed && seatsRead ? items : undefined} onCreate={create} onOpenProviderSettings={onOpenProviderSettings} onError={(message) => toast.error(message)} />
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
                onToggleEdit={(id, accepted) => void run(() => api.councilPatch(active.id, { edit: { id, accepted } }), t`更新失败`)}
              />
              <div className="timeline-gap-turn"><CouncilControls discussion={active} onContinue={handleContinue} /></div>
            </div>
            {noting && (
              <div className="sticky bottom-0 max-md:bg-bg md:bg-transparent pt-2 pb-4">
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
            )}
          </div>
          {asideOpen && <div className="sticky top-0 self-start"><CouncilAside discussion={active} /></div>}
        </div>
      )}

      {active && exportKind && (
        <CouncilExportDialog
          open
          kind={exportKind}
          discussion={active}
          projects={projects}
          backends={backends}
          busy={exporting}
          onOpenChange={(open) => { if (!open) setExportKind(null); }}
          onConfirm={(payload) => void handleExport(payload)}
        />
      )}
    </PageScaffold>
  );
}
