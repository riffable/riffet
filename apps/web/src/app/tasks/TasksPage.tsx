import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconArrowLeft, IconBookmarkPlus, IconCalendarClock, IconCircleAlert, IconEllipsis, IconMenu, IconPencilLine, IconPlay, IconPlus, IconRefreshCw, IconTrash2 } from '@/components/icons';
import type { NativeBackendCatalogEntry, NativeBackendId, Schedule, Session, TaskTemplate } from '@contracts';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, Field, Input, Segmented, Select, Spinner, Switch, Textarea } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { api, HttpError, type LaunchIds, type NativeSessionCreateResult, type ProjectRecord } from '@/lib/api';
import { confirmDialog, useDiscardGuard } from '@/lib/dialogs';
import { OverlayScopeContext, useOverlayState } from '@/lib/overlay-navigation';
import { useBackendLabel } from '@/lib/backends';
import { toast } from '@/lib/toast';
import { cn, errorMessage, formatDateTime, newId } from '@/lib/utils';
import { ExpandSidebarButton } from '../ExpandSidebarButton';

const PRESETS = [
  { cron: '0 9 * * 1-5' },
  { cron: '0 9 * * *' },
  { cron: '0 9 * * 1' },
  { cron: '0 * * * *' },
] as const;
const ALIASES: Record<string, MessageDescriptor> = { '@hourly': msg`每小时`, '@daily': msg`每天 0:00`, '@midnight': msg`每天 0:00`, '@weekly': msg`每周日 0:00`, '@monthly': msg`每月 1 日 0:00` };

/**
 * Reads the common shapes back as words — a fixed time on every day, workdays or one weekday, and
 * the hourly ones. Anything else stays the expression itself: a wrong paraphrase of a schedule is
 * worse than showing what will actually run.
 */
export function describeCron(cron: string): string {
  const text = cron.trim();
  const alias = ALIASES[text];
  if (alias) return i18n._(alias);
  const parts = text.split(/\s+/);
  if (parts.length !== 5) return text;
  const [minute, hour, day, month, weekday] = parts as [string, string, string, string, string];
  if (!/^\d+$/.test(minute) || day !== '*' || month !== '*') return text;
  if (hour === '*') return weekday === '*' ? (minute === '0' ? i18n._(msg`每小时`) : i18n._(msg`每小时第 ${minute} 分`)) : text;
  if (!/^\d+$/.test(hour)) return text;
  const time = `${hour}:${minute.padStart(2, '0')}`;
  if (weekday === '*') return i18n._(msg`每天 ${time}`);
  if (weekday === '1-5') return i18n._(msg`工作日 ${time}`);
  if (weekday === '0,6' || weekday === '6,0') return i18n._(msg`周末 ${time}`);
  if (/^[0-7]$/.test(weekday)) {
    const weekly = [
      msg`每周日 ${time}`,
      msg`每周一 ${time}`,
      msg`每周二 ${time}`,
      msg`每周三 ${time}`,
      msg`每周四 ${time}`,
      msg`每周五 ${time}`,
      msg`每周六 ${time}`,
    ];
    return i18n._(weekly[Number(weekday) % 7]);
  }
  return text;
}

function RowMenu({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button size="icon-sm" variant="quiet" aria-label={label}><IconEllipsis /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col">
      <div className="mb-1.5 flex h-7 items-center justify-between px-1">
        <h2 className="text-xs font-medium text-fg-3">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

const listClass = 'flex flex-col [&>*+*]:edge-t rounded-xl border border-line bg-elevated';

/**
 * Reusable tasks and the schedules that run them, as one page beside the conversations: a task is
 * written once (often saved from a conversation that went well), then run by hand in any project or
 * left on a schedule. Schedules come first because they are what keeps happening without anyone
 * looking; templates are the library underneath.
 */
export function TasksPage({ projects, project, sessions, backends, sidebarCollapsed, onClose, onOpenSidebar, onExpandSidebar, onLaunched, onOpenSession, onError }: {
  projects: ProjectRecord[];
  /** Where a template run by hand goes; the project the reader came from. */
  project?: ProjectRecord;
  sessions: Session[];
  backends: NativeBackendCatalogEntry[];
  sidebarCollapsed: boolean;
  onClose: () => void;
  onOpenSidebar: () => void;
  onExpandSidebar: () => void;
  onLaunched: (result: NativeSessionCreateResult) => void;
  onOpenSession: (id: string) => void;
  onError: (message: string) => void;
}) {
  const overlay = useOverlayState({ open: true, onOpenChange: (next) => { if (!next) onClose(); } });
  const { t } = useLingui();
  const label = useBackendLabel();
  /** A run that started is the normal outcome and gets no badge. */
  const resultBadge: Partial<Record<NonNullable<Schedule['lastResult']>, { label: string; tone: 'warning' | 'danger' | 'neutral' }>> = {
    skipped: { label: t`已跳过`, tone: 'neutral' },
    missed: { label: t`已错过`, tone: 'warning' },
    failed: { label: t`失败`, tone: 'danger' },
  };
  const [templates, setTemplates] = useState<TaskTemplate[]>();
  const [schedules, setSchedules] = useState<Schedule[]>();
  const [loadError, setLoadError] = useState('');
  const [editingTemplate, setEditingTemplate] = useState<TaskTemplate | 'new'>();
  const [editingSchedule, setEditingSchedule] = useState<Schedule | { templateId?: string }>();
  const [running, setRunning] = useState<string>();
  const [toggling, setToggling] = useState<Set<string>>(() => new Set());
  const templateRequests = useRef(new Map<string, LaunchIds>());

  const reload = useCallback(async () => {
    try {
      const [nextTemplates, nextSchedules] = await Promise.all([api.templates(), api.schedules()]);
      setTemplates(nextTemplates);
      setSchedules(nextSchedules);
      setLoadError('');
    } catch (error) { setLoadError(errorMessage(error, t`无法加载任务`)); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  // Next and last runs move on their own while the page is open.
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void reload(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [reload]);

  const live = projects.filter((item) => !item.archivedAt);
  const projectName = (id: string) => projects.find((item) => item.id === id)?.name ?? t`已移除的项目`;
  const templateById = useMemo(() => new Map((templates ?? []).map((item) => [item.id, item])), [templates]);

  const runTemplate = async (template: TaskTemplate) => {
    if (!project || running) return;
    setRunning(template.id);
    const requestKey = `${project.id}:${template.id}`;
    const ids = templateRequests.current.get(requestKey) ?? { clientSessionId: newId(), commandId: newId() };
    templateRequests.current.set(requestKey, ids);
    try {
      const result = await api.runTemplate(template.id, { ...ids, projectId: project.id });
      templateRequests.current.delete(requestKey);
      onLaunched(result);
    }
    catch (error) { onError(errorMessage(error, t`无法运行模板`)); }
    finally { setRunning(undefined); }
  };
  const removeTemplate = async (template: TaskTemplate) => {
    if (!await confirmDialog({ title: t`删除模板「${template.name}」？`, confirmLabel: t({ message: '删除', context: 'tasks-delete-action' }), destructive: true })) return;
    try { await api.deleteTemplate(template.id); await reload(); }
    catch (error) {
      onError(error instanceof HttpError && error.code === 'TEMPLATE_IN_USE' ? t`还有定时任务在用这个模板，先删除它们` : errorMessage(error, t`无法删除模板`));
    }
  };
  const runSchedule = async (schedule: Schedule) => {
    if (running) return;
    setRunning(schedule.id);
    try {
      const next = await api.runSchedule(schedule.id);
      setSchedules((current) => current?.map((item) => item.id === next.id ? next : item));
      if (next.lastResult === 'started' && next.lastSessionId) toast.success(t`已运行「${next.name}」`, { action: { label: t`打开`, onClick: () => onOpenSession(next.lastSessionId!) } });
      else if (next.lastResult === 'skipped') toast.info(t`上一次运行的会话还在进行，这次已跳过`);
      else if (next.lastResult === 'failed') onError(next.lastError ?? t`运行失败`);
    } catch (error) { onError(errorMessage(error, t`无法运行定时任务`)); }
    finally { setRunning(undefined); }
  };
  const toggleSchedule = async (schedule: Schedule, enabled: boolean) => {
    if (toggling.has(schedule.id)) return;
    setToggling((current) => new Set(current).add(schedule.id));
    setSchedules((current) => current?.map((item) => item.id === schedule.id ? { ...item, enabled } : item));
    try {
      const next = await api.updateSchedule(schedule.id, { enabled });
      setSchedules((current) => current?.map((item) => item.id === next.id ? next : item));
    } catch (error) {
      setSchedules((current) => current?.map((item) => item.id === schedule.id ? schedule : item));
      onError(errorMessage(error, t`无法更新定时任务`));
    } finally { setToggling((current) => { const next = new Set(current); next.delete(schedule.id); return next; }); }
  };
  const removeSchedule = async (schedule: Schedule) => {
    if (!await confirmDialog({ title: t`删除定时任务「${schedule.name}」？`, description: t`已经运行出的会话会保留。`, confirmLabel: t({ message: '删除', context: 'tasks-delete-action' }), destructive: true })) return;
    try { await api.deleteSchedule(schedule.id); await reload(); }
    catch (error) { onError(errorMessage(error, t`无法删除定时任务`)); }
  };

  const loading = !templates || !schedules;
  return (
    <OverlayScopeContext.Provider value={overlay.scope}>
      <div className="flex h-full min-h-0 flex-col bg-bg">
        <header className="flex h-12 shrink-0 items-center gap-2 px-3 max-md:edge-b md:h-13 md:pl-4">
          <Button size="icon-sm" variant="quiet" className="size-11 md:hidden" aria-label={t`打开侧边栏`} onClick={onOpenSidebar}><IconMenu /></Button>
          {sidebarCollapsed && <ExpandSidebarButton onClick={onExpandSidebar} />}
          <h1 className="min-w-0 truncate text-sm font-medium text-fg"><Trans>定时任务</Trans></h1>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 pb-12 pt-4 md:pt-8">
            {loading && !loadError && <div className="flex justify-center py-24"><Spinner className="size-5" /></div>}
            {loading && loadError && (
              <EmptyState className="py-16" icon={<IconCircleAlert />} title={t`无法加载任务`} description={loadError}>
                <Button size="sm" onClick={() => void reload()}><IconRefreshCw /><Trans>重试</Trans></Button>
              </EmptyState>
            )}
            {!loading && !templates.length && (
              <EmptyState className="py-20" icon={<IconCalendarClock />} title={t`把常做的事存成任务`} description={t`可在任意项目运行，或按计划自动运行。`}>
                <Button variant="primary" onClick={() => setEditingTemplate('new')}><IconPlus /><Trans>新建任务模板</Trans></Button>
              </EmptyState>
            )}
            {!loading && templates.length > 0 && (
              <>
                <Section title={t`定时运行`} action={<Button size="xs" variant="quiet" onClick={() => setEditingSchedule({})}><IconPlus /><Trans>新建</Trans></Button>}>
                  {schedules.length ? (
                    <div className={listClass}>
                      {schedules.map((schedule) => {
                        const template = templateById.get(schedule.templateId);
                        const last = schedule.lastResult ? resultBadge[schedule.lastResult] : undefined;
                        return (
                          <div key={schedule.id} className={cn('flex items-center gap-3 px-4 py-3 max-md:px-3', !schedule.enabled && '[&_[data-dim]]:opacity-55')}>
                            <div data-dim className="flex min-w-0 flex-1 flex-col gap-0.5">
                              <span className="flex min-w-0 items-center gap-2">
                                <span className="truncate text-sm font-medium text-fg">{schedule.name}</span>
                                {last && (
                                  <Tip label={schedule.lastError ?? (schedule.lastRunAt ? t`上次 ${formatDateTime(schedule.lastRunAt)}` : undefined)}>
                                    <span><Badge tone={last.tone}>{last.label}</Badge></span>
                                  </Tip>
                                )}
                              </span>
                              <span className="truncate text-xs text-fg-3">
                                {describeCron(schedule.cron)} · {projectName(schedule.projectId)} · {template?.name ?? t`模板已删除`}
                                {schedule.target === 'same' && t` · 同一会话`}
                              </span>
                            </div>
                            <span data-dim className="hidden shrink-0 text-right text-xs tabular-nums text-fg-3 sm:block">
                              {schedule.enabled ? (schedule.nextRunAt ? <Trans>下次 {formatDateTime(schedule.nextRunAt)}</Trans> : t`不会再运行`) : t`已暂停`}
                            </span>
                            <Switch checked={schedule.enabled} disabled={toggling.has(schedule.id)} onCheckedChange={(enabled) => void toggleSchedule(schedule, enabled)} aria-label={schedule.enabled ? t`暂停` : t`启用`} />
                            <RowMenu label={t`${schedule.name} 的操作`}>
                              <DropdownMenuItem disabled={Boolean(running)} onSelect={() => void runSchedule(schedule)}><IconPlay /><Trans>立即运行</Trans></DropdownMenuItem>
                              {schedule.lastSessionId && sessions.some((item) => item.id === schedule.lastSessionId) && <DropdownMenuItem onSelect={() => onOpenSession(schedule.lastSessionId!)}><IconArrowLeft className="rotate-180" /><Trans>打开上次的会话</Trans></DropdownMenuItem>}
                              <DropdownMenuItem onSelect={() => setEditingSchedule(schedule)}><IconPencilLine /><Trans>编辑</Trans></DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem variant="danger" onSelect={() => void removeSchedule(schedule)}><IconTrash2 /><Trans context="tasks-delete-action">删除</Trans></DropdownMenuItem>
                            </RowMenu>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <button type="button" onClick={() => setEditingSchedule({})} className="flex h-16 items-center justify-center gap-2 rounded-xl border border-dashed border-line text-sm text-fg-3 transition-colors hover:bg-hover hover:text-fg-2">
                      <IconCalendarClock className="size-4" /><Trans>让一个模板按计划自动运行</Trans>
                    </button>
                  )}
                  <p className="mt-2 px-1 text-xs text-fg-4"><Trans>按本机时间运行；Riffet 需保持开启，重叠运行会跳过，错过超过一小时不补跑。</Trans></p>
                </Section>

                <Section title={t`模板`} action={<Button size="xs" variant="quiet" onClick={() => setEditingTemplate('new')}><IconPlus /><Trans>新建</Trans></Button>}>
                  <div className={listClass}>
                    {templates.map((template) => (
                      <div key={template.id} className="group/template flex items-center gap-3 px-4 py-3 max-md:px-3">
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-sm font-medium text-fg">{template.name}</span>
                            {template.isolate && <Badge><Trans>独立 Worktree</Trans></Badge>}
                          </span>
                          <span className="truncate text-xs text-fg-3">{template.backendId ? label(template.backendId) : t`默认 Agent`} · {template.prompt.split('\n')[0]}</span>
                        </div>
                        <Tip label={project ? t`在「${project.name}」中运行` : t`先选择一个项目`}>
                          <span><Button size="xs" variant="secondary" disabled={!project || Boolean(running)} onClick={() => void runTemplate(template)}>{running === template.id ? <Spinner /> : <IconPlay />}<Trans>运行</Trans></Button></span>
                        </Tip>
                        <RowMenu label={t`${template.name} 的操作`}>
                          <DropdownMenuItem onSelect={() => setEditingSchedule({ templateId: template.id })}><IconCalendarClock /><Trans>定时运行…</Trans></DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setEditingTemplate(template)}><IconPencilLine /><Trans>编辑</Trans></DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="danger" onSelect={() => void removeTemplate(template)}><IconTrash2 /><Trans context="tasks-delete-action">删除</Trans></DropdownMenuItem>
                        </RowMenu>
                      </div>
                    ))}
                  </div>
                </Section>
              </>
            )}
          </div>
        </div>
      </div>
      <TemplateEditor
        template={editingTemplate}
        backends={backends}
        onClose={() => setEditingTemplate(undefined)}
        onSaved={() => void reload()}
        onError={onError}
      />
      <ScheduleEditor
        schedule={editingSchedule}
        templates={templates ?? []}
        projects={live}
        defaultProjectId={project?.id}
        onClose={() => setEditingSchedule(undefined)}
        onSaved={() => void reload()}
        onError={onError}
      />
    </OverlayScopeContext.Provider>
  );
}

function TemplateEditor({ template, backends, onClose, onSaved, onError }: {
  template?: TaskTemplate | 'new'; backends: NativeBackendCatalogEntry[];
  onClose: () => void; onSaved: () => void; onError: (message: string) => void;
}) {
  const { t } = useLingui();
  // Literal braces must be values, not message text: ICU would read `{{date}}` as an argument.
  const dateToken = '{{date}}';
  const projectToken = '{{project}}';
  const existing = template && template !== 'new' ? template : undefined;
  const [editingExisting, setEditingExisting] = useState(Boolean(existing));
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [backendId, setBackendId] = useState<NativeBackendId | ''>('');
  const [isolate, setIsolate] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!template) return;
    setEditingExisting(Boolean(existing));
    setName(existing?.name ?? '');
    setPrompt(existing?.prompt ?? '');
    setBackendId(existing?.backendId ?? '');
    setIsolate(Boolean(existing?.isolate));
  }, [template]);
  const discard = useDiscardGuard(Boolean(template) && (name !== (existing?.name ?? '') || prompt !== (existing?.prompt ?? '') || backendId !== (existing?.backendId ?? '') || isolate !== Boolean(existing?.isolate)));
  const close = () => discard.close(onClose);
  const submit = async () => {
    if (busy || !name.trim() || !prompt.trim()) return;
    setBusy(true);
    try {
      // Model, mode and permission belong to one backend; switching it falls back to that backend's
      // saved defaults rather than carrying values it may not understand.
      const kept = existing && existing.backendId === (backendId || undefined)
        ? { ...(existing.backendProfileId ? { backendProfileId: existing.backendProfileId } : {}), ...(existing.model ? { model: existing.model } : {}), ...(existing.mode ? { mode: existing.mode } : {}), ...(existing.approval ? { approval: existing.approval } : {}) }
        : {};
      const body = { name: name.trim(), prompt: prompt.trim(), isolate, target: { ...(backendId ? { backendId } : {}), ...kept } };
      if (existing) await api.updateTemplate(existing.id, body);
      else await api.createTemplate(body);
      onClose();
      onSaved();
    } catch (error) { onError(errorMessage(error, t`无法保存模板`)); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={Boolean(template)} onOpenChange={(open) => { if (!open && !busy) close(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{(template ? Boolean(existing) : editingExisting) ? t`编辑任务模板` : t`新建任务模板`}</DialogTitle>
          <DialogDescription><Trans>模板不属于某个项目，运行时才决定在哪里做。</Trans></DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <Field label={t`名称`}><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={t`比如：晨间依赖检查`} /></Field>
          <Field label={t`任务`} hint={<Trans>运行时 <code className="font-mono">{dateToken}</code> 会替换为当天日期，<code className="font-mono">{projectToken}</code> 替换为项目名。</Trans>}>
            <Textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} className="min-h-32" placeholder={t`让 Agent 做什么`} />
          </Field>
          <Field label="Agent">
            <Select value={backendId} onChange={(event) => setBackendId(event.target.value as NativeBackendId | '')}>
              <option value=""><Trans>默认 Agent</Trans></option>
              {backends.map((entry) => <option key={entry.backendId} value={entry.backendId}>{entry.label}{entry.available ? '' : t`（不可用）`}</option>)}
            </Select>
          </Field>
          <label className="flex items-center justify-between gap-3 text-sm text-fg-2">
            <span className="flex flex-col"><span className="text-fg"><Trans>每次在新的 Worktree 中运行</Trans></span><span className="text-xs text-fg-3"><Trans>不碰项目当前的工作区。</Trans></span></span>
            <Switch checked={isolate} onCheckedChange={setIsolate} aria-label={t`每次在新的 Worktree 中运行`} />
          </label>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={close}><Trans context="tasks-cancel-action">取消</Trans></Button>
          <Button variant="primary" disabled={busy || !name.trim() || !prompt.trim()} onClick={() => void submit()}>{busy ? <Spinner className="text-primary-fg" /> : <IconBookmarkPlus />}<Trans>保存</Trans></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ScheduleEditor({ schedule, templates, projects, defaultProjectId, onClose, onSaved, onError }: {
  /** An existing schedule, or the template a new one starts from. */
  schedule?: Schedule | { templateId?: string };
  templates: TaskTemplate[]; projects: ProjectRecord[]; defaultProjectId?: string;
  onClose: () => void; onSaved: () => void; onError: (message: string) => void;
}) {
  const { t } = useLingui();
  const presets = [
    { cron: '0 9 * * 1-5', label: t`工作日 9:00` },
    { cron: '0 9 * * *', label: t`每天 9:00` },
    { cron: '0 9 * * 1', label: t`每周一 9:00` },
    { cron: '0 * * * *', label: t`每小时` },
  ] as const;
  const existing = schedule && 'id' in schedule ? schedule : undefined;
  const [editingExisting, setEditingExisting] = useState(Boolean(existing));
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [preset, setPreset] = useState<string>(PRESETS[0].cron);
  const [custom, setCustom] = useState('');
  const [target, setTarget] = useState<Schedule['target']>('new');
  const [busy, setBusy] = useState(false);
  const [cronError, setCronError] = useState('');
  /** The fields as the dialog filled them in, to tell an edit from a glance. */
  const [initial, setInitial] = useState('');
  useEffect(() => {
    if (!schedule) return;
    setEditingExisting(Boolean(existing));
    const cron = existing?.cron ?? PRESETS[0].cron;
    const known = PRESETS.some((item) => item.cron === cron);
    const fields = [
      existing?.name ?? '',
      existing?.templateId ?? schedule.templateId ?? templates[0]?.id ?? '',
      existing?.projectId ?? (projects.some((item) => item.id === defaultProjectId) ? defaultProjectId! : projects[0]?.id ?? ''),
      known ? cron : 'custom',
      known ? '' : cron,
      existing?.target ?? 'new',
    ] as const;
    setName(fields[0]);
    setTemplateId(fields[1]);
    setProjectId(fields[2]);
    setPreset(fields[3]);
    setCustom(fields[4]);
    setTarget(fields[5]);
    setCronError('');
    setInitial(JSON.stringify(fields));
  }, [schedule]);
  const discard = useDiscardGuard(Boolean(schedule) && JSON.stringify([name, templateId, projectId, preset, custom, target]) !== initial);
  const close = () => discard.close(onClose);
  const cron = preset === 'custom' ? custom.trim() : preset;
  const templateName = templates.find((item) => item.id === templateId)?.name ?? '';
  const submit = async () => {
    if (busy || !templateId || !projectId || !cron) return;
    setBusy(true);
    setCronError('');
    try {
      const body = { name: name.trim() || templateName, templateId, projectId, cron, target };
      if (existing) await api.updateSchedule(existing.id, body);
      else await api.createSchedule({ ...body, enabled: true });
      onClose();
      onSaved();
    } catch (error) {
      if (error instanceof HttpError && error.code === 'INVALID_CRON') setCronError(t`无法识别这个时间表达式`);
      else onError(errorMessage(error, t`无法保存定时任务`));
    } finally { setBusy(false); }
  };
  return (
    <Dialog open={Boolean(schedule)} onOpenChange={(open) => { if (!open && !busy) close(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{(schedule ? Boolean(existing) : editingExisting) ? t`编辑定时任务` : t`定时运行`}</DialogTitle>
          <DialogDescription><Trans>完成时会照常通知。</Trans></DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t`模板`}>
              <Select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
                {templates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </Select>
            </Field>
            <Field label={t`项目`}>
              <Select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </Select>
            </Field>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-fg"><Trans>时间</Trans></span>
            <div className="flex flex-wrap gap-1.5">
              {[...presets, { cron: 'custom', label: t`自定义` }].map((item) => (
                <button
                  key={item.cron}
                  type="button"
                  aria-pressed={preset === item.cron}
                  onClick={() => setPreset(item.cron)}
                  className={cn('h-7 rounded-lg border px-2.5 text-sm transition-colors no-hover:min-h-11', preset === item.cron ? 'border-accent bg-accent-soft text-fg' : 'border-line text-fg-2 hover:bg-hover')}
                >
                  {item.label}
                </button>
              ))}
            </div>
            {preset === 'custom' && (
              <>
                <Input autoFocus className="font-mono" value={custom} onChange={(event) => { setCustom(event.target.value); setCronError(''); }} placeholder="30 8 * * 1-5" aria-label={t`Cron 表达式`} />
                <span className={cn('text-xs', cronError ? 'text-danger' : 'text-fg-3')}>
                  {cronError || (custom.trim() && describeCron(custom) !== custom.trim() ? describeCron(custom) : t`分 时 日 月 周，本地时间；也可以用 @daily、@hourly`)}
                </span>
              </>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-fg"><Trans>每次运行</Trans></span>
            <Segmented value={target} onChange={setTarget} ariaLabel={t`每次运行`} options={[{ value: 'new', label: t`开新会话` }, { value: 'same', label: t`发到同一会话` }]} />
            <span className="text-xs text-fg-3">{target === 'new' ? t`每次是一段独立的会话。` : t`Agent 能看到之前几次的结果；会话归档后会重新开一段。`}</span>
          </div>
          <Field label={t`名称`}><Input value={name} onChange={(event) => setName(event.target.value)} placeholder={templateName || t`默认使用模板名`} /></Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={close}><Trans context="tasks-cancel-action">取消</Trans></Button>
          <Button variant="primary" disabled={busy || !templateId || !projectId || !cron} onClick={() => void submit()}>{busy ? <Spinner className="text-primary-fg" /> : <IconCalendarClock />}<Trans>保存</Trans></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
