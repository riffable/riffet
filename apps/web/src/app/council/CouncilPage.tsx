import { useCallback, useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type {
  CouncilCreateRequest,
  CouncilDiscussion,
  CouncilStreamEvent,
  NativeBackendCatalogEntry,
} from '@contracts';
import { api, councilStreamUrl, type ProjectRecord } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge, Spinner } from '@/components/ui/controls';
import { Notice } from '@/components/ui/notice';
import { Tip } from '@/components/ui/tooltip';
import { IconArrowUp, IconGitFork, IconPanelRight, IconSquare, IconSquareKanban } from '@/components/icons';
import { PageScaffold } from '../PageScaffold';
import { CouncilAside } from './CouncilAside';
import { CouncilExportDialog } from './CouncilExportDialog';
import { CouncilLaunch } from './CouncilLaunch';
import { CouncilAsideNav, CouncilHistoryMenu } from './CouncilNav';
import { DebateStage } from './DebateStage';
import { InsightStage } from './InsightStage';
import { formatDuration, formatTokens } from './model';
import { PrismStage } from './PrismStage';

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
  const [items, setItems] = useState<CouncilDiscussion[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [asideOpen, setAsideOpen] = useState(true);
  const [pulseTurnId, setPulseTurnId] = useState<string | null>(null);
  const [litQuoteId, setLitQuoteId] = useState<string | null>(null);
  const [litParaId, setLitParaId] = useState<string | null>('P1');
  const [steerText, setSteerText] = useState('');
  const [steering, setSteering] = useState(false);
  const [exportKind, setExportKind] = useState<'task' | 'session' | null>(null);
  const [exporting, setExporting] = useState(false);
  const [liveStreams, setLiveStreams] = useState<Record<string, { text?: string; thought?: string }>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  const active = activeId ? items.find((item) => item.id === activeId) : undefined;

  const upsertDiscussion = useCallback((next: CouncilDiscussion) => {
    setItems((prev) => {
      const idx = prev.findIndex((item) => item.id === next.id);
      if (idx < 0) return [next, ...prev];
      const copy = [...prev];
      copy[idx] = next;
      return copy;
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void api.councilList(controller.signal).then((res) => setItems(res.items)).catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!activeId) return;
    setLiveStreams({});
    const source = new EventSource(councilStreamUrl(activeId));
    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as CouncilStreamEvent;
        if (parsed.type === 'snapshot') {
          upsertDiscussion(parsed.discussion);
          if (parsed.discussion.status !== 'running') setLiveStreams({});
        } else if (parsed.type === 'delta') {
          setLiveStreams((prev) => ({
            ...prev,
            [parsed.targetId]: {
              ...prev[parsed.targetId],
              [parsed.kind]: parsed.text,
            },
          }));
        }
      } catch { /* ignore malformed frame */ }
    };
    return () => source.close();
  }, [activeId, upsertDiscussion]);

  const handleSelect = (id: string | null) => {
    setActiveId(id);
    setLitQuoteId(null);
    const target = id ? items.find((item) => item.id === id) : undefined;
    setLitParaId(target?.insight?.paragraphs[0]?.id ?? null);
  };

  const handleCreate = async (req: CouncilCreateRequest) => {
    setSubmitting(true);
    try {
      const created = await api.councilCreate(req);
      upsertDiscussion(created);
      setActiveId(created.id);
      setLitQuoteId(null);
      setLitParaId(created.insight?.paragraphs[0]?.id ?? null);
    } catch (error) {
      toast.error(errorMessage(error, t`无法开始协作`));
    } finally {
      setSubmitting(false);
    }
  };

  const handleAdvance = async (action?: 'next-round' | 'conclude') => {
    if (!active) return;
    try {
      const next = await api.councilAdvance(active.id, action ? { action } : undefined);
      upsertDiscussion(next);
    } catch (error) {
      toast.error(errorMessage(error, t`继续失败`));
    }
  };

  const handlePatch = async (patch: Parameters<typeof api.councilPatch>[1]) => {
    if (!active) return;
    try {
      const next = await api.councilPatch(active.id, patch);
      upsertDiscussion(next);
    } catch (error) {
      toast.error(errorMessage(error, t`更新失败`));
    }
  };

  const handleCancel = async () => {
    if (!active) return;
    try {
      const next = await api.councilCancel(active.id);
      upsertDiscussion(next);
    } catch (error) {
      toast.error(errorMessage(error, t`无法停止`));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.councilDelete(id);
      setItems((prev) => prev.filter((x) => x.id !== id));
      if (activeId === id) setActiveId(null);
    } catch (error) {
      toast.error(errorMessage(error, t`删除失败`));
    }
  };

  const handleSteer = async () => {
    if (!active || !steerText.trim() || steering) return;
    const text = steerText.trim();
    setSteering(true);
    try {
      const next = await api.councilSteer(active.id, { text });
      upsertDiscussion(next);
      setSteerText('');
    } catch (error) {
      toast.error(errorMessage(error, t`追问失败`));
    } finally {
      setSteering(false);
    }
  };

  const handleExport = async (payload: Parameters<typeof api.councilExport>[1]) => {
    if (!active) return;
    setExporting(true);
    try {
      const result = await api.councilExport(active.id, payload);
      setExportKind(null);
      if (result.kind === 'task') {
        toast.success(t`已创建任务`);
        onOpenTasks();
      } else {
        onOpenSession(result.id);
      }
    } catch (error) {
      toast.error(errorMessage(error, t`导出失败`));
    } finally {
      setExporting(false);
    }
  };

  const focusTurn = (turnId: string) => {
    setPulseTurnId(turnId);
    document.getElementById(`council-turn-${turnId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => setPulseTurnId((cur) => (cur === turnId ? null : cur)), 2200);
  };

  const highlightPara = (para: string) => {
    setLitParaId((cur) => (cur === para ? null : para));
    document.getElementById(`council-para-${para}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const modeBadge = active ? (active.mode === 'debate' ? t`辩论` : active.mode === 'prism' ? 'Prism' : t`审阅`) : null;
  const totalTokens = active ? active.inputTokens + active.outputTokens : 0;

  const headerTitle = (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="truncate">{active ? active.title : t`模型协作`}</span>
      <CouncilHistoryMenu items={items} activeId={activeId} onSelect={handleSelect} />
    </span>
  );

  const headerMeta = active ? (
    <span className="inline-flex items-center gap-2">
      <Badge>{modeBadge}</Badge>
      {(active.durationMs > 0 || totalTokens > 0) && (
        <span className="text-xs tabular-nums text-fg-3 max-md:hidden">
          {formatDuration(active.durationMs)}{totalTokens > 0 ? ` · ${formatTokens(totalTokens)}` : ''}
        </span>
      )}
    </span>
  ) : undefined;

  const headerActions = active ? (
    <>
      {active.status === 'running' && (
        <Button size="sm" variant="secondary" onClick={() => void handleCancel()}>
          <IconSquare className="size-3" />
          <span><Trans>停止</Trans></span>
        </Button>
      )}
      <Button size="sm" variant="secondary" className="max-md:hidden" onClick={() => setExportKind('session')}>
        <IconGitFork />
        <span><Trans>带入会话</Trans></span>
      </Button>
      <Button size="sm" variant="primary" className="max-md:hidden" onClick={() => setExportKind('task')}>
        <IconSquareKanban />
        <span><Trans>转为任务</Trans></span>
      </Button>
      <Tip label={asideOpen ? t`收起右侧栏` : t`展开右侧栏`}>
        <Button size="icon-sm" variant="quiet" className="max-xl:hidden" aria-label={t`切换右侧栏`} onClick={() => setAsideOpen((v) => !v)}>
          <IconPanelRight />
        </Button>
      </Tip>
    </>
  ) : undefined;

  return (
    <PageScaffold
      title={headerTitle}
      meta={headerMeta}
      actions={headerActions}
      column="none"
      aside={<CouncilAsideNav items={items} activeId={activeId} onSelect={handleSelect} onDelete={(id) => void handleDelete(id)} />}
      sidebarCollapsed={sidebarCollapsed}
      onClose={onClose}
      onOpenSidebar={onOpenSidebar}
      onExpandSidebar={onExpandSidebar}
    >
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-8 py-5 pb-12 max-md:px-4">
            {!active ? (
              <CouncilLaunch
                backends={backends}
                submitting={submitting}
                onCreate={(req) => void handleCreate(req)}
                onOpenProviderSettings={onOpenProviderSettings}
              />
            ) : (
              <div className="flex flex-col gap-4">
                <div className={cn('mx-auto flex w-full flex-wrap items-center gap-1 border-b border-line pb-3', active.mode === 'prism' ? 'max-w-5xl' : 'max-w-3xl')}>
                  {(active.phases ?? []).map((label, idx) => {
                    const isCur = idx === active.phaseIndex;
                    const isDone = idx < active.phaseIndex || active.status === 'done';
                    return (
                      <span key={label} className="inline-flex items-center gap-1">
                        {idx > 0 && <span className="px-0.5 text-xs text-fg-4">›</span>}
                        <span
                          className={cn(
                            'inline-flex h-6.5 items-center gap-1.5 rounded-full px-2.5 text-xs',
                            isCur && active.status === 'running' ? 'bg-active font-medium text-fg' : isDone ? 'text-fg-2' : 'text-fg-4',
                          )}
                        >
                          {isCur && active.status === 'running' && <Spinner />}
                          <span>{label}</span>
                        </span>
                      </span>
                    );
                  })}
                  {active.status === 'running' && (
                    <span className="ml-auto text-xs text-fg-3"><Trans>正在生成…</Trans></span>
                  )}
                </div>

                {active.status === 'failed' && active.error && (
                  <div className={cn('mx-auto w-full', active.mode === 'prism' ? 'max-w-5xl' : 'max-w-3xl')}>
                    <Notice tone="danger">{active.error}</Notice>
                  </div>
                )}

                {active.mode === 'debate' && (
                  <DebateStage
                    discussion={active}
                    pulseTurnId={pulseTurnId}
                    liveStreams={liveStreams}
                    onSwapSides={() => void handlePatch({ swapDebateSides: true })}
                    onAdvance={() => void handleAdvance('next-round')}
                    onConclude={() => void handleAdvance('conclude')}
                    onFocusTurn={focusTurn}
                    onExport={(kind) => setExportKind(kind)}
                  />
                )}

                {active.mode === 'prism' && (
                  <PrismStage
                    discussion={active}
                    litQuoteId={litQuoteId}
                    liveStreams={liveStreams}
                    onToggleContradiction={(id) => void handlePatch({ toggleContradictionId: id })}
                    onAdvance={() => void handleAdvance()}
                  />
                )}

                {active.mode === 'insight' && (
                  <InsightStage
                    discussion={active}
                    litParaId={litParaId}
                    onSelectPara={highlightPara}
                    onToggleAnnotation={(id) => void handlePatch({ toggleAnnotationId: id })}
                    onAdvance={() => void handleAdvance()}
                  />
                )}
              </div>
            )}
          </div>

          {active && active.mode !== 'insight' && active.status !== 'running' && (
            <div className="shrink-0 px-8 pt-2 pb-4 max-md:px-4">
              <div className={cn('mx-auto flex items-center gap-2 rounded-xl border border-line bg-subtle py-1.5 pr-1.5 pl-3.5', active.mode === 'prism' ? 'max-w-5xl' : 'max-w-3xl')}>
                <input
                  value={steerText}
                  onChange={(e) => setSteerText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleSteer(); } }}
                  placeholder={active.mode === 'debate' ? t`作为主持人向双方追问或补充约束…` : t`补充条件或追问…`}
                  className="min-w-0 flex-1 border-0 bg-transparent text-sm text-fg outline-none placeholder:text-fg-4"
                />
                <Button
                  size="icon-sm"
                  variant="primary"
                  className="rounded-full"
                  aria-label={t`发送`}
                  busy={steering}
                  disabled={!steerText.trim()}
                  onClick={() => void handleSteer()}
                >
                  <IconArrowUp />
                </Button>
              </div>
            </div>
          )}
        </div>

        {active && asideOpen && (
          <CouncilAside
            discussion={active}
            litQuoteId={litQuoteId}
            litParaId={litParaId}
            onFocusTurn={focusTurn}
            onHighlightQuote={(id) => setLitQuoteId((cur) => (cur === id ? null : id))}
            onHighlightPara={highlightPara}
            onToggleAnnotation={(id) => void handlePatch({ toggleAnnotationId: id })}
          />
        )}
      </div>

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
