import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Trans } from '@lingui/react/macro';
import type { Automation, AutomationRun, NativeBackendCatalogEntry, Session } from '@contracts';
import { IconArrowLeft, IconBot, IconCalendarClock, IconCircleAlert, IconCircleCheck, IconEllipsis, IconMenu, IconPencilLine, IconPlay, IconPlus, IconRefreshCw, IconTrash2, IconTriangleAlert, IconX } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { EmptyState, Select, Spinner, Switch } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { api, type LaunchIds, type ProjectRecord } from '@/lib/api';
import { confirmDialog } from '@/lib/dialogs';
import { OverlayScopeContext, useOverlayState } from '@/lib/overlay-navigation';
import { toast } from '@/lib/toast';
import { cn, errorMessage, formatDateTime, newId } from '@/lib/utils';
import { ExpandSidebarButton } from '../ExpandSidebarButton';
import { automationKind, describeTrigger, formatWhen } from './automation';
import { AutomationEditor, type AutomationEditorState } from './AutomationEditor';
import { QuickCreate } from './QuickCreate';

function RowMenu({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button size="icon-sm" variant="quiet" aria-label={label}><IconEllipsis /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col">
      <h2 className="mb-1.5 flex h-7 items-center px-1 text-xs font-medium text-fg-3">{title}</h2>
      {children}
    </section>
  );
}

const listClass = 'flex flex-col [&>*+*]:edge-t rounded-xl border border-line bg-elevated';

function Row({ lead, title, mark, sub, dim, children }: { lead?: React.ReactNode; title: string; mark?: React.ReactNode; sub?: React.ReactNode; dim?: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-2.5 max-md:px-3">
      {lead}
      <div className={cn('flex min-w-0 flex-1 flex-col gap-0.5', dim && 'opacity-55')}>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium text-fg">{title}</span>
          {mark}
        </span>
        {sub && <span className="truncate text-xs text-fg-3">{sub}</span>}
      </div>
      {children}
    </div>
  );
}

const timeColumn = 'w-24 shrink-0 text-xs tabular-nums text-fg-3 max-sm:w-20';

/**
 * Everything that runs by itself, or by a tap: the next things due first, then what only runs when
 * asked, what is paused, and what just ran. Making one is the bar at the top; the full editor is
 * for what the bar does not say.
 */
export function TasksPage({ projects, project, sessions, backends, enterBehavior, sidebarCollapsed, onClose, onOpenSidebar, onExpandSidebar, onOpenSession, onError }: {
  projects: ProjectRecord[];
  /** Where a new task goes unless told otherwise; the project the reader came from. */
  project?: ProjectRecord;
  sessions: Session[];
  backends: NativeBackendCatalogEntry[];
  enterBehavior?: string;
  sidebarCollapsed: boolean;
  onClose: () => void;
  onOpenSidebar: () => void;
  onExpandSidebar: () => void;
  onOpenSession: (id: string) => void;
  onError: (message: string) => void;
}) {
  const overlay = useOverlayState({ open: true, onOpenChange: (next) => { if (!next) onClose(); } });
  const { t } = useLingui();
  const [automations, setAutomations] = useState<Automation[]>();
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState<AutomationEditorState>();
  const [choosing, setChoosing] = useState<Automation>();
  const [running, setRunning] = useState<string>();
  const [toggling, setToggling] = useState<Set<string>>(() => new Set());
  const requests = useRef(new Map<string, LaunchIds>());

  const reload = useCallback(async () => {
    try {
      const [nextAutomations, nextRuns] = await Promise.all([api.automations(), api.automationRuns(20)]);
      setAutomations(nextAutomations);
      setRuns(nextRuns);
      setLoadError('');
    } catch (error) { setLoadError(errorMessage(error, t`无法加载任务`)); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  // Next and last runs move on their own while the page is open, and are stale after it was hidden.
  useEffect(() => {
    const visible = () => { if (document.visibilityState === 'visible') void reload(); };
    const timer = window.setInterval(visible, 30_000);
    document.addEventListener('visibilitychange', visible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [reload]);

  const live = useMemo(() => projects.filter((item) => !item.archivedAt), [projects]);
  const projectName = (id: string | undefined) => id ? projects.find((item) => item.id === id)?.name ?? t`已移除的项目` : undefined;
  const sessionById = useMemo(() => new Map(sessions.map((item) => [item.id, item])), [sessions]);
  const nameById = useMemo(() => new Map((automations ?? []).map((item) => [item.id, item.name])), [automations]);

  const { upcoming, manual, paused } = useMemo(() => {
    const all = automations ?? [];
    return {
      upcoming: all.filter((item) => automationKind(item) === 'upcoming').sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!)),
      manual: all.filter((item) => !item.followUp && automationKind(item) === 'manual'),
      paused: all.filter((item) => !item.followUp && automationKind(item) === 'paused'),
    };
  }, [automations]);

  const run = async (item: Automation, projectId?: string) => {
    if (running) return;
    setRunning(item.id);
    const key = `${item.id}:${projectId ?? ''}`;
    const ids = requests.current.get(key) ?? { clientSessionId: newId(), commandId: newId() };
    requests.current.set(key, ids);
    try {
      const result = await api.runAutomation(item.id, { ...ids, ...(projectId ? { projectId } : {}) });
      requests.current.delete(key);
      if (result.result === 'started' && result.sessionId) {
        const sessionId = result.sessionId;
        toast.success(t`已运行「${item.name}」`, { action: { label: t`打开`, onClick: () => onOpenSession(sessionId) } });
      }
      else if (result.reason === 'busy') toast.info(t`上一轮仍在运行`);
      else if (result.result === 'failed') onError(result.error ?? t`运行失败`);
      else if (result.reason) onError(reasonText(result));
      void reload();
    } catch (error) { onError(errorMessage(error, t`无法运行定时任务`)); }
    finally { setRunning(undefined); }
  };
  const reasonText = (item: AutomationRun): string => {
    if (item.result === 'failed') return item.error ?? t`运行失败`;
    if (item.reason === 'busy') return t`上一轮仍在运行`;
    if (item.reason === 'offline') return t`Riffet 未运行`;
    if (item.reason === 'project-unavailable') return t`项目不可用`;
    if (item.reason === 'session-unavailable') return t`会话不可用`;
    return '';
  };
  const toggle = async (item: Automation, enabled: boolean) => {
    if (toggling.has(item.id)) return;
    setToggling((current) => new Set(current).add(item.id));
    setAutomations((current) => current?.map((entry) => entry.id === item.id ? { ...entry, enabled } : entry));
    try {
      const next = await api.updateAutomation(item.id, { enabled });
      setAutomations((current) => current?.map((entry) => entry.id === next.id ? next : entry));
    } catch (error) {
      setAutomations((current) => current?.map((entry) => entry.id === item.id ? item : entry));
      onError(errorMessage(error, t`无法更新定时任务`));
    } finally { setToggling((current) => { const next = new Set(current); next.delete(item.id); return next; }); }
  };
  const remove = async (item: Automation) => {
    if (!item.followUp && !await confirmDialog({ title: t`删除定时任务「${item.name}」？`, description: t`已经运行出的会话会保留。`, confirmLabel: t({ message: '删除', context: 'tasks-delete-action' }), destructive: true })) return;
    try { await api.deleteAutomation(item.id); await reload(); }
    catch (error) { onError(errorMessage(error, t`无法删除定时任务`)); }
  };

  const hasSession = (id: string | undefined): id is string => Boolean(id && sessionById.has(id));
  const agentMark = (item: Automation) => item.followUp?.by === 'agent' || item.createdBySessionId
    ? <Tip label="Agent"><span className="shrink-0 text-fg-4"><IconBot className="size-3.5" /></span></Tip> : null;
  const subOf = (item: Automation) => {
    const trigger = item.triggers[0];
    const where = item.followUp ? sessionById.get(item.followUp.sessionId)?.title : projectName(item.projectId);
    return [trigger ? describeTrigger(trigger) : undefined, where].filter(Boolean).join(' · ');
  };
  const menu = (item: Automation) => (
    <RowMenu label={t`${item.name} 的操作`}>
      {item.followUp ? <>
        {hasSession(item.followUp.sessionId) && <DropdownMenuItem onSelect={() => onOpenSession(item.followUp!.sessionId)}><IconArrowLeft className="rotate-180" /><Trans>打开会话</Trans></DropdownMenuItem>}
        <DropdownMenuItem variant="danger" onSelect={() => void remove(item)}><IconX /><Trans context="tasks-cancel-action">取消</Trans></DropdownMenuItem>
      </> : <>
        <DropdownMenuItem disabled={Boolean(running)} onSelect={() => item.projectId ? void run(item) : setChoosing(item)}><IconPlay /><Trans>立即运行</Trans></DropdownMenuItem>
        {hasSession(item.lastSessionId) && <DropdownMenuItem onSelect={() => onOpenSession(item.lastSessionId!)}><IconArrowLeft className="rotate-180" /><Trans>打开上次的会话</Trans></DropdownMenuItem>}
        <DropdownMenuItem onSelect={() => setEditing({ automation: item })}><IconPencilLine /><Trans>编辑</Trans></DropdownMenuItem>
        {!item.triggers.length && <DropdownMenuItem onSelect={() => setEditing({ automation: item, focus: 'when' })}><IconCalendarClock /><Trans>添加计划</Trans></DropdownMenuItem>}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="danger" onSelect={() => void remove(item)}><IconTrash2 /><Trans context="tasks-delete-action">删除</Trans></DropdownMenuItem>
      </>}
    </RowMenu>
  );
  const switchOf = (item: Automation) => (
    <Switch checked={item.enabled} disabled={toggling.has(item.id)} onCheckedChange={(enabled) => void toggle(item, enabled)} aria-label={item.enabled ? t`暂停` : t`启用`} />
  );

  const loading = !automations;
  const empty = automations?.length === 0;
  return (
    <OverlayScopeContext.Provider value={overlay.scope}>
      <div className="flex h-full min-h-0 flex-col bg-bg">
        <header className="flex h-12 shrink-0 items-center gap-2 px-3 max-md:edge-b md:h-13 md:pl-4">
          <Button size="icon-sm" variant="quiet" className="size-11 md:hidden" aria-label={t`打开侧边栏`} onClick={onOpenSidebar}><IconMenu /></Button>
          {sidebarCollapsed && <ExpandSidebarButton onClick={onExpandSidebar} />}
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium text-fg"><Trans>定时任务</Trans></h1>
          <Tip label={t`新建`}><Button size="icon-sm" variant="quiet" className="max-md:size-11" aria-label={t`新建`} onClick={() => setEditing({ seed: { projectId: project?.id } })}><IconPlus /></Button></Tip>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 pb-12 pt-4 md:pt-8">
            {loading && !loadError && <div className="flex justify-center py-24"><Spinner className="size-5" /></div>}
            {loading && loadError && (
              <EmptyState className="py-16" icon={<IconCircleAlert />} title={t`无法加载任务`} description={loadError}>
                <Button size="sm" onClick={() => void reload()}><IconRefreshCw /><Trans>重试</Trans></Button>
              </EmptyState>
            )}
            {!loading && (
              <>
                <QuickCreate
                  projects={live}
                  defaultProjectId={project?.id}
                  backends={backends}
                  enterBehavior={enterBehavior}
                  examples={empty}
                  onCreated={() => void reload()}
                  onCustom={setEditing}
                  onError={onError}
                />

                {upcoming.length > 0 && (
                  <Section title={t`即将运行`}>
                    <div className={listClass}>
                      {upcoming.map((item) => (
                        <Row key={item.id} title={item.name} mark={agentMark(item)} sub={subOf(item)}
                          lead={<span className={timeColumn}>{formatWhen(item.nextRunAt!)}</span>}>
                          {!item.followUp && switchOf(item)}
                          {menu(item)}
                        </Row>
                      ))}
                    </div>
                  </Section>
                )}

                {manual.length > 0 && (
                  <Section title={t`手动`}>
                    <div className={listClass}>
                      {manual.map((item) => (
                        <Row key={item.id} title={item.name} mark={agentMark(item)} sub={subOf(item)}>
                          <Tip label={t`运行`}>
                            <Button size="icon-sm" variant="quiet" className="max-md:size-11" aria-label={t`运行`} disabled={Boolean(running)} onClick={() => item.projectId ? void run(item) : setChoosing(item)}>
                              {running === item.id ? <Spinner /> : <IconPlay />}
                            </Button>
                          </Tip>
                          {menu(item)}
                        </Row>
                      ))}
                    </div>
                  </Section>
                )}

                {paused.length > 0 && (
                  <Section title={t`已暂停`}>
                    <div className={listClass}>
                      {paused.map((item) => (
                        <Row key={item.id} title={item.name} mark={agentMark(item)} sub={subOf(item)} dim={!item.enabled}>
                          {item.enabled ? <span className="shrink-0 text-xs text-fg-3"><Trans context="tasks-schedule-ended">已结束</Trans></span> : switchOf(item)}
                          {menu(item)}
                        </Row>
                      ))}
                    </div>
                  </Section>
                )}

                {runs.length > 0 && (
                  <Section title={t`最近运行`}>
                    <div className={listClass}>
                      {runs.map((item) => {
                        const reason = reasonText(item);
                        const openable = hasSession(item.sessionId);
                        const tone = item.result === 'started' ? 'text-success' : item.result === 'failed' ? 'text-danger' : item.result === 'missed' ? 'text-warning' : 'text-fg-4';
                        const body = (
                          <>
                            {item.result === 'started' ? <IconCircleCheck className={cn('size-4 shrink-0', tone)} /> : item.result === 'failed' ? <IconCircleAlert className={cn('size-4 shrink-0', tone)} /> : <IconTriangleAlert className={cn('size-4 shrink-0', tone)} />}
                            <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
                              <span className="truncate text-sm text-fg">{nameById.get(item.automationId) ?? t`已删除的任务`}</span>
                              {reason && <Tip label={reason.length > 60 ? reason : undefined}><span className="truncate text-xs text-fg-3">{reason}</span></Tip>}
                            </span>
                            <span className="shrink-0 text-xs tabular-nums text-fg-3">{formatDateTime(item.at)}</span>
                          </>
                        );
                        const rowClass = 'flex min-h-12 w-full items-center gap-3 px-4 py-2 max-md:px-3';
                        return openable
                          ? <button key={item.id} type="button" onClick={() => onOpenSession(item.sessionId!)} className={cn(rowClass, 'transition-colors hover:bg-hover')}>{body}</button>
                          : <div key={item.id} className={rowClass}>{body}</div>;
                      })}
                    </div>
                  </Section>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      <AutomationEditor
        state={editing}
        projects={live}
        backends={backends}
        defaultProjectId={project?.id}
        onClose={() => setEditing(undefined)}
        onSaved={() => void reload()}
        onError={onError}
      />
      <ProjectChoice
        automation={choosing}
        projects={live}
        defaultProjectId={project?.id}
        onClose={() => setChoosing(undefined)}
        onChoose={(item, projectId) => { setChoosing(undefined); void run(item, projectId); }}
      />
    </OverlayScopeContext.Provider>
  );
}

/** A task with no project of its own asks where to run each time. */
function ProjectChoice({ automation, projects, defaultProjectId, onClose, onChoose }: {
  automation?: Automation; projects: ProjectRecord[]; defaultProjectId?: string; onClose: () => void; onChoose: (automation: Automation, projectId: string) => void;
}) {
  const { t } = useLingui();
  const [projectId, setProjectId] = useState('');
  useEffect(() => {
    if (automation) setProjectId(projects.some((item) => item.id === defaultProjectId) ? defaultProjectId! : projects[0]?.id ?? '');
    // Reset when a different task opens it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [automation?.id]);
  return (
    <Dialog open={Boolean(automation)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-sm" aria-describedby={undefined}>
        <DialogHeader><DialogTitle>{automation?.name}</DialogTitle></DialogHeader>
        <DialogBody>
          <Select value={projectId} onChange={(event) => setProjectId(event.target.value)} aria-label={t`项目`}>
            {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </Select>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}><Trans context="tasks-cancel-action">取消</Trans></Button>
          <Button variant="primary" disabled={!projectId} onClick={() => automation && onChoose(automation, projectId)}><IconPlay /><Trans>运行</Trans></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
