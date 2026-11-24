import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { LocalizedText, Task, TaskAction, TaskActionIcon, TaskConfirmation, TaskLogRecords, TaskLogRule, TaskLogTone, TaskParamField, TaskParams, TaskState } from '@contracts';
import {
  IconChevronDown, IconChevronRight, IconCircleAlert, IconEllipsis, IconCircleCheck, IconCircleDashed, IconCircleHelp, IconDownload, IconFileText, IconImage, IconListChecks,
  IconOctagonX, IconPackage, IconPlay, IconRotateCw, IconSearch, IconTrash2, IconTriangleAlert, IconWrapText, type IconProps,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/controls';
import { Tip } from '@/components/ui/tooltip';
import { HttpError } from '@/lib/errors';
import { formatDuration } from '@/lib/format-duration';
import { localizedText, pluginTitle, usePlugins } from '@/lib/plugins';
import { clearFocusedTask, taskConfirmation, tasksApi, useFocusedTask, useTaskActions } from '@/lib/tasks';
import { toast } from '@/lib/toast';
import { cn, errorMessage, formatBytes, newId, timeAgo } from '@/lib/utils';
import { useStores } from '../app/state/stores';
import type { DeclarativeViewProps } from './catalog';
import { RecordsLog } from './LogRecords';
import { useOpenProjectFile } from './projectFileOpener';
import { TaskConfirmDialog } from './TaskConfirmDialog';

/*
 * The host's renderer of `renderer: { kind: 'tasks', provider }` views (docs/TASKS.md): the body of a
 * side-panel view for one task provider in one project. The tasks are the server's: closing the
 * view, switching tabs or leaving the project only stops this view's polling, and the one thing that
 * stops a task is the Cancel button. An instance belongs to one project (`PluginView` keys it), and
 * every read is bound to the view's signal, so a late answer can never be drawn in another project.
 */

const RECENT = 20;
/** The newest bytes of a log read when a task is selected; the rest stays on the server. */
const TAIL_BYTES = 64 * 1024;
const LOG_CHUNK = 64 * 1024;
/** What the log view keeps: the end of the output, whatever is read. */
const LOG_CHARS = 200_000;
const POLL_MS = 1000;
const TASK_POLL_MS = 2000;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

const isOpen = (task: Pick<Task, 'state'>): boolean => task.state === 'running' || task.state === 'cancelling';
/** A task only moves forward: a read that was in flight while a newer answer arrived must not take it back. */
const rank = (state: TaskState): number => (state === 'running' ? 0 : state === 'cancelling' ? 1 : 2);
const newest = (a: Task, b: Task): number => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0);

/** An abort controller that also aborts with `signal`, the view's. */
function linked(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', () => controller.abort(), { once: true });
  return controller;
}

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

export function TasksView({ declaration, context }: DeclarativeViewProps) {
  const provider = declaration.renderer?.kind === 'tasks' ? declaration.renderer.provider : undefined;
  if (!provider || !context.projectId) return null;
  return <Tasks provider={provider} projectId={context.projectId} signal={context.signal} visible={context.visible} />;
}

/** This provider's recent tasks in the project, kept current by the server's `task` events and a poll while one is open. */
function useProviderTasks(projectId: string, provider: string, signal: AbortSignal, visible: boolean) {
  const { lists } = useStores();
  const [tasks, setTasks] = useState<Task[]>();

  const merge = useCallback((incoming: readonly Task[], replace: boolean) => setTasks((current) => {
    const byId = new Map((replace ? [] : current ?? []).map((task) => [task.id, task]));
    for (const task of incoming) {
      if (task.projectId !== projectId || task.providerId !== provider) continue;
      const known = (current ?? []).find((item) => item.id === task.id);
      byId.set(task.id, known && rank(known.state) > rank(task.state) ? known : task);
    }
    return [...byId.values()].sort(newest).slice(0, RECENT);
  }), [projectId, provider]);

  const refresh = useCallback(async () => {
    try {
      const list = await tasksApi.list(projectId, RECENT, signal);
      if (!signal.aborted) merge(list, true);
    } catch { /* the next event or poll reads again; what is shown stays */ }
  }, [projectId, signal, merge]);

  // The list on arrival, whenever the view is shown again, and for each task event of this project.
  useEffect(() => {
    if (!visible) return;
    void refresh();
    let timer: number | undefined;
    const off = lists.onTask((event) => {
      if (event && event.projectId !== projectId) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), 150);
    });
    return () => { off(); window.clearTimeout(timer); };
  }, [visible, projectId, lists, refresh]);

  // An open task is also read directly, so a missed event costs seconds, not the state.
  const openIds = (tasks ?? []).filter(isOpen).map((task) => task.id).join(',');
  useEffect(() => {
    if (!visible || !openIds) return;
    const timer = window.setInterval(() => {
      for (const id of openIds.split(',')) tasksApi.get(id, signal).then((task) => { if (!signal.aborted) merge([task], false); }, () => undefined);
    }, TASK_POLL_MS);
    return () => window.clearInterval(timer);
  }, [visible, openIds, signal, merge]);

  return { tasks, merge };
}

/** The tail of the selected task's log, followed by byte offset while the task is open. */
function useTaskLog(task: Task | undefined, signal: AbortSignal, visible: boolean): string {
  const [log, setLog] = useState<{ id: string; text: string }>();
  /** Where the next read starts, per task: a view hidden and shown again continues from here. */
  const position = useRef<{ id: string; from: number } | undefined>(undefined);
  const size = useRef(0);
  size.current = task?.logSize ?? 0;
  const id = task?.id;

  useEffect(() => {
    if (!id || !visible) return;
    const controller = linked(signal);
    if (position.current?.id !== id) {
      position.current = { id, from: Math.max(0, size.current - TAIL_BYTES) };
      setLog({ id, text: '' });
    }
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          const chunk = await tasksApi.log(id, position.current!.from, LOG_CHUNK, controller.signal);
          if (controller.signal.aborted) return;
          if (chunk.to > position.current!.from) {
            position.current = { id, from: chunk.to };
            const text = chunk.text.replace(ANSI, '');
            setLog((current) => (current?.id === id ? { id, text: (current.text + text).slice(-LOG_CHARS) } : current));
            // A full window means there is more to read now.
            if (chunk.to - chunk.from >= LOG_CHUNK - 4) continue;
          }
          if (chunk.eof) return;
        } catch (error) {
          // A task that has aged out of the server has no log to follow.
          if (controller.signal.aborted || (error instanceof HttpError && error.status === 404)) return;
        }
        await pause(POLL_MS, controller.signal);
      }
    })();
    return () => controller.abort();
  }, [id, visible, signal]);

  return log && log.id === id ? log.text : '';
}

const ICONS: Record<TaskActionIcon, ComponentType<IconProps>> = {
  run: IconPlay, build: IconPackage, test: IconListChecks, inspect: IconSearch, clean: IconTrash2,
  crash: IconOctagonX, screenshot: IconImage, sync: IconRotateCw, log: IconFileText,
};

/** The choices a provider's actions share, by key: one selector for each, whichever action is started. */
function sharedChoices(actions: readonly TaskAction[]): TaskParamField[] {
  const byKey = new Map<string, TaskParamField>();
  for (const action of actions) for (const field of action.params ?? []) if (field.kind === 'choice' && field.options?.length && !byKey.has(field.key)) byKey.set(field.key, field);
  return [...byKey.values()];
}

/** The selections of one provider in one project, kept on this device; a value no longer offered falls back to the default. */
function useChoices(projectId: string, provider: string, fields: readonly TaskParamField[]) {
  const key = `riffet.tasks.choices.v1.${projectId}.${provider}`;
  const [saved, setSaved] = useState<Record<string, string>>(() => {
    try { const value: unknown = JSON.parse(localStorage.getItem(key) ?? '{}'); return value && typeof value === 'object' ? value as Record<string, string> : {}; } catch { return {}; }
  });
  const values: Record<string, string> = {};
  for (const field of fields) {
    const value = saved[field.key];
    values[field.key] = value && field.options?.includes(value) ? value : String(field.default ?? field.options?.[0] ?? '');
  }
  const choose = (field: string, value: string) => setSaved((current) => {
    const next = { ...current, [field]: value };
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* kept for this view only */ }
    return next;
  });
  return { values, choose };
}

/** What a start of `action` sends: the shared selections it declares, nothing it does not. */
function paramsFor(action: TaskAction, values: Readonly<Record<string, string>>): TaskParams | undefined {
  const params: TaskParams = {};
  for (const field of action.params ?? []) if (field.kind === 'choice' && values[field.key] && field.options?.includes(values[field.key]!)) params[field.key] = values[field.key]!;
  return Object.keys(params).length ? params : undefined;
}

const groupKey = (group: LocalizedText | undefined): string => (group ? JSON.stringify(group) : '');

function Tasks({ provider, projectId, signal, visible }: { provider: string; projectId: string; signal: AbortSignal; visible: boolean }) {
  const { t, i18n } = useLingui();
  const offered = useTaskActions(projectId);
  const actions = useMemo(() => (offered?.actions ?? []).filter((action) => action.providerId === provider), [offered, provider]);
  const { tasks, merge } = useProviderTasks(projectId, provider, signal, visible);
  const [picked, setPicked] = useState<string>();
  const selected = tasks?.find((task) => task.id === picked) ?? tasks?.find(isOpen) ?? tasks?.[0];
  const log = useTaskLog(selected, signal, visible);
  const fields = useMemo(() => sharedChoices(actions), [actions]);
  const { values, choose } = useChoices(projectId, provider, fields);

  // A command that started a task of this provider asks for it to be shown selected.
  const focusedId = useFocusedTask();
  useEffect(() => {
    if (!focusedId) return;
    void tasksApi.get(focusedId, signal).then((task) => {
      if (signal.aborted || task.projectId !== projectId || task.providerId !== provider) return;
      merge([task], false);
      setPicked(task.id);
      clearFocusedTask(task.id);
    }, () => undefined);
  }, [focusedId, projectId, provider, signal, merge]);

  // A start is one click: an action is off while its start is in flight and while a task of it runs;
  // another action that would wait on the same lock is answered by the server with the task that holds
  // it, which is then shown. After a failure with no answer (the request may have been accepted) the
  // same request id is used again, so retrying cannot start a second task.
  const [starting, setStarting] = useState<string>();
  const attempt = useRef<{ key: string; requestId: string } | undefined>(undefined);
  /** A first run of an installed package's command waits here for the user to approve what it runs. */
  const [confirming, setConfirming] = useState<{ action: TaskAction; params?: TaskParams; confirmation: TaskConfirmation }>();
  /** An action that asks before every start. */
  const [asking, setAsking] = useState<TaskAction>();
  const plugins = usePlugins();
  const start = async (action: TaskAction, params: TaskParams | undefined, confirm?: string) => {
    if (starting) return;
    setStarting(action.id);
    const key = `${action.id}|${JSON.stringify(params ?? {})}`;
    const requestId = attempt.current?.key === key ? attempt.current.requestId : newId();
    attempt.current = { key, requestId };
    try {
      const task = await tasksApi.start({ requestId, projectId, providerId: action.providerId, actionId: action.id, ...(params ? { params } : {}), ...(confirm ? { confirm } : {}) });
      attempt.current = undefined;
      if (signal.aborted) return;
      merge([task], false);
      setPicked(task.id);
    } catch (error) {
      if (error instanceof HttpError && error.status >= 400 && error.status < 500) attempt.current = undefined;
      if (signal.aborted) return;
      const confirmation = taskConfirmation(error);
      if (confirmation) { setConfirming({ action, ...(params ? { params } : {}), confirmation }); return; }
      const holder = error instanceof HttpError && error.code === 'TASK_BUSY' ? (error.details as { taskId?: unknown } | undefined)?.taskId : undefined;
      // Another task holds the lock: show that one.
      if (typeof holder === 'string') setPicked(holder);
      else toast.error(errorMessage(error));
    } finally { setStarting(undefined); }
  };
  const request = (action: TaskAction) => (action.confirm ? setAsking(action) : void start(action, paramsFor(action, values)));

  // Cancel asks; the task stays `cancelling` until the server reports it over.
  const [cancelBusy, setCancelBusy] = useState(false);
  const cancel = async (task: Task) => {
    setCancelBusy(true);
    try {
      const updated = await tasksApi.cancel(task.id);
      if (!signal.aborted) merge([updated], false);
    } catch (error) { if (!signal.aborted) toast.error(errorMessage(error)); }
    finally { setCancelBusy(false); }
  };

  const stateLabel: Record<TaskState, string> = {
    running: t`运行中`, cancelling: t`正在取消`, succeeded: t`成功`, failed: t`失败`, cancelled: t`已取消`, unknown: t`状态未知`,
  };
  const text = (value: LocalizedText | undefined) => localizedText(value, [i18n.locale]);
  const title = (task: Task) => text(actions.find((action) => action.id === task.actionId)?.title) ?? text(task.title) ?? task.actionId;
  const runningActions = new Set((tasks ?? []).filter(isOpen).map((task) => task.actionId));

  // The toolbar: the actions without a section, main one first. Sectioned actions go in a menu by
  // section; a provider whose every action has a section (a list of configurations) is a picker
  // instead, like a run-configuration selector, with one button that runs the picked action.
  const toolbar = actions.filter((action) => !action.group).sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)));
  const sections: Array<{ key: string; group: LocalizedText; actions: TaskAction[] }> = [];
  for (const action of actions) {
    if (!action.group) continue;
    const key = groupKey(action.group);
    const section = sections.find((item) => item.key === key) ?? sections[sections.push({ key, group: action.group, actions: [] }) - 1]!;
    section.actions.push(action);
  }
  const picking = toolbar.length === 0 && sections.length > 0;
  const { picked: pickedAction, pick } = usePicked(projectId, provider, actions);
  const busyOf = (action: TaskAction) => starting === action.id || runningActions.has(action.id);

  const actionButton = (action: TaskAction) => {
    const Icon = action.icon ? ICONS[action.icon] : IconPlay;
    return (
      <Button key={action.id} size="sm" variant="ghost" className="gap-1.5 px-2 text-fg max-md:h-10" disabled={Boolean(starting) || busyOf(action)} onClick={() => request(action)}>
        {busyOf(action) ? <Spinner /> : <Icon className={action.primary ? 'text-success' : 'text-fg-3'} />}{text(action.title) ?? action.id}
      </Button>
    );
  };

  const menuItems = (onSelect: (action: TaskAction) => void, current?: TaskAction) => sections.map((section, index) => (
    <DropdownMenuGroup key={section.key}>
      {index > 0 && <DropdownMenuSeparator />}
      <DropdownMenuLabel className="text-2xs">{text(section.group)}</DropdownMenuLabel>
      {section.actions.map((action) => {
        // In a picker the rows are names to choose from: only a glyph that sets one apart (a clean) is drawn.
        const Icon = action.icon && !(current && action.icon === 'run') ? ICONS[action.icon] : current ? undefined : IconPlay;
        return (
          <DropdownMenuItem key={action.id} disabled={!current && (Boolean(starting) || busyOf(action))} onSelect={() => onSelect(action)} className={cn(current && 'pl-3', current?.id === action.id && 'bg-active')}>
            {busyOf(action) ? <Spinner /> : Icon ? <Icon /> : null}<span className="min-w-0 flex-1 truncate">{text(action.title) ?? action.id}</span>
          </DropdownMenuItem>
        );
      })}
    </DropdownMenuGroup>
  ));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TaskConfirmDialog
        title={confirming ? pluginTitle(plugins, confirming.action.pluginId, [i18n.locale]) : ''}
        confirmation={confirming?.confirmation}
        onCancel={() => setConfirming(undefined)}
        onConfirm={() => { if (!confirming) return; const { action, params, confirmation } = confirming; setConfirming(undefined); void start(action, params, confirmation.fingerprint); }}
      />
      <AskDialog
        action={asking} text={text}
        onCancel={() => setAsking(undefined)}
        onConfirm={() => { if (!asking) return; const action = asking; setAsking(undefined); void start(action, paramsFor(action, values)); }}
      />

      <div className="flex shrink-0 flex-wrap items-center gap-1 px-2.5 py-2">
        {fields.map((field) => <ChoiceChip key={field.key} field={field} value={values[field.key]!} label={text(field.label) ?? field.key} onChange={(value) => choose(field.key, value)} />)}
        {picking && pickedAction && (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger className={cn(chip, 'min-w-0 flex-1 font-sans')}>
                <span className="min-w-0 flex-1 truncate text-left">{text(pickedAction.title) ?? pickedAction.id}</span>
                <IconChevronDown aria-hidden className="size-3 shrink-0 text-fg-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-[min(36rem,70vh)] w-[var(--radix-dropdown-menu-trigger-width)] min-w-56 overflow-y-auto">
                {menuItems(pick, pickedAction)}
              </DropdownMenuContent>
            </DropdownMenu>
            <Tip label={text(pickedAction.title) ?? pickedAction.id}>
              <Button size="icon-sm" variant="ghost" aria-label={t`运行`} className="max-md:size-10" disabled={Boolean(starting) || busyOf(pickedAction)} onClick={() => request(pickedAction)}>
                {busyOf(pickedAction) ? <Spinner /> : <IconPlay className="text-success" />}
              </Button>
            </Tip>
          </>
        )}
        {!picking && (
          <div className="ml-auto flex items-center gap-0.5">
            {toolbar.map(actionButton)}
            {sections.length > 0 && (
              <DropdownMenu>
                <Tip label={t`更多`}>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon-sm" variant="ghost" aria-label={t`更多`} className="text-fg-3 max-md:size-10"><IconEllipsis /></Button>
                  </DropdownMenuTrigger>
                </Tip>
                <DropdownMenuContent align="end" className="max-h-96 min-w-44 overflow-y-auto">
                  {menuItems(request)}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
      </div>

      {!tasks && <div className="flex justify-center py-10 edge-t"><Spinner /></div>}

      {selected && (
        <TaskDetail
          key={selected.id} task={selected} log={log} visible={visible} title={title(selected)} stateLabel={stateLabel}
          logStyle={actions.find((action) => action.id === selected.actionId)?.log}
          cancelBusy={cancelBusy} onCancel={() => void cancel(selected)}
        />
      )}

      {tasks && tasks.length > 1 && (
        <ul aria-label={t`最近的任务`} className="flex max-h-36 shrink-0 flex-col gap-0.5 overflow-y-auto px-2 py-2 edge-t">
          {tasks.map((task) => (
            <li key={task.id}>
              <button type="button" onClick={() => setPicked(task.id)} aria-current={task.id === selected?.id}
                className={cn('flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-hover max-md:h-11', task.id === selected?.id && 'bg-active')}>
                <StateGlyph state={task.state} label={stateLabel[task.state]} />
                <span className="shrink-0 text-fg">{title(task)}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-3">{paramSummary(task)}</span>
                <span className="shrink-0 text-fg-3">{timeAgo(task.startedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const paramSummary = (task: Task): string => Object.values(task.params ?? {}).filter((value) => typeof value === 'string').join(' · ');

const chip = 'flex h-7 min-w-0 items-center gap-1 rounded-md px-2 text-xs text-fg-2 outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus data-[state=open]:bg-hover data-[state=open]:text-fg max-md:h-10';

/** The picked action of a provider that is a picker, kept on this device; the first one until one is picked. */
function usePicked(projectId: string, provider: string, actions: readonly TaskAction[]) {
  const key = `riffet.tasks.picked.v1.${projectId}.${provider}`;
  const [id, setId] = useState(() => { try { return localStorage.getItem(key) ?? undefined; } catch { return undefined; } });
  const picked = actions.find((action) => action.id === id) ?? actions.find((action) => action.group);
  const pick = (action: TaskAction) => { setId(action.id); try { localStorage.setItem(key, action.id); } catch { /* this view only */ } };
  return { picked, pick };
}

/** One shared selection as a compact menu; its name is the menu's label, the value is what shows. */
function ChoiceChip({ field, value, label, onChange }: { field: TaskParamField; value: string; label: string; onChange: (value: string) => void }) {
  return (
    <DropdownMenu>
      <Tip label={label}>
        <DropdownMenuTrigger
          aria-label={label}
          className={cn(chip, 'max-w-44 font-mono')}
        >
          <span className="min-w-0 truncate">{value}</span>
          <IconChevronDown aria-hidden className="size-3 shrink-0 text-fg-3" />
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent className="max-h-72 overflow-y-auto">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {field.options!.map((option) => <DropdownMenuRadioItem key={option} value={option} className="font-mono text-xs">{option}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The question of an action that asks before every start, in the provider's words. */
function AskDialog({ action, text, onConfirm, onCancel }: { action: TaskAction | undefined; text: (value: LocalizedText | undefined) => string | undefined; onConfirm: () => void; onCancel: () => void }) {
  // The content stays through the closing animation after `action` is cleared.
  const last = useRef(action);
  if (action) last.current = action;
  const shown = action ?? last.current;
  return (
    <Dialog open={Boolean(action)} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{text(shown?.title) ?? shown?.id}</DialogTitle>
          <DialogDescription className="whitespace-pre-line">{text(shown?.confirm)}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}><Trans>取消</Trans></Button>
          <Button variant="primary" onClick={onConfirm}><Trans>运行</Trans></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TaskDetail({ task, log, visible, title, stateLabel, logStyle, cancelBusy, onCancel }: {
  task: Task; log: string; visible: boolean; title: string; stateLabel: Record<TaskState, string>; logStyle: { rules: readonly TaskLogRule[]; records?: TaskLogRecords } | undefined; cancelBusy: boolean; onCancel: () => void;
}) {
  const { t } = useLingui();
  const openFile = useOpenProjectFile();
  // Elapsed time of an open task.
  const [now, setNow] = useState(() => Date.now());
  const open = isOpen(task);
  useEffect(() => {
    if (!visible || !open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [visible, open]);

  const [wrap, setWrap] = useState(() => { try { return localStorage.getItem(WRAP_KEY) === '1'; } catch { return false; } });
  const toggleWrap = () => setWrap((value) => { try { localStorage.setItem(WRAP_KEY, value ? '0' : '1'); } catch { /* this view only */ } return !value; });

  const diagnostics = [...(task.diagnostics ?? [])].sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error'));
  const errors = diagnostics.filter((item) => item.severity === 'error').length;
  const [problemsOpen, setProblemsOpen] = useState(true);
  const images = (task.artifacts ?? []).filter((artifact) => IMAGE.test(artifact.name));
  const files = (task.artifacts ?? []).filter((artifact) => !IMAGE.test(artifact.name));

  return (
    <div className="flex min-h-0 flex-1 flex-col edge-t">
      <div className="flex h-10 shrink-0 items-center gap-2 px-3 text-sm">
        <StateGlyph state={task.state} label={stateLabel[task.state]} />
        <span className="shrink-0 text-fg">{title}</span>
        <span className="min-w-0 truncate font-mono text-2xs text-fg-3">{paramSummary(task)}</span>
        <Tip label={t`自动换行`}>
          <Button size="icon-xs" variant="quiet" aria-label={t`自动换行`} aria-pressed={wrap} className={cn('ml-auto max-md:size-10', wrap && 'bg-hover text-fg')} onClick={toggleWrap}><IconWrapText /></Button>
        </Tip>
        <span className="shrink-0 text-xs tabular-nums text-fg-3" title={task.unknownReason}>
          {task.state === 'unknown' ? stateLabel.unknown : formatDuration((task.endedAt ? Date.parse(task.endedAt) : now) - Date.parse(task.startedAt))}
        </span>
        {open && (
          <Button size="xs" variant="ghost" className="max-md:h-10" disabled={task.state === 'cancelling' || cancelBusy} onClick={onCancel}>
            {task.state === 'cancelling' ? <Trans>正在取消</Trans> : <Trans>取消</Trans>}
          </Button>
        )}
      </div>

      {diagnostics.length > 0 && (
        <div className="flex shrink-0 flex-col pb-1">
          <button type="button" aria-expanded={problemsOpen} onClick={() => setProblemsOpen((value) => !value)}
            className="flex h-7 items-center gap-2 px-3 text-xs text-fg-2 hover:text-fg max-md:h-10">
            {problemsOpen ? <IconChevronDown className="size-3 text-fg-3" /> : <IconChevronRight className="size-3 text-fg-3" />}
            {errors > 0 && <span className="flex items-center gap-1 tabular-nums"><IconCircleAlert aria-label={t`错误`} className="size-3.5 text-danger" />{errors}</span>}
            {diagnostics.length > errors && <span className="flex items-center gap-1 tabular-nums"><IconTriangleAlert aria-label={t`警告`} className="size-3.5 text-warning" />{diagnostics.length - errors}</span>}
          </button>
          {problemsOpen && (
            <ul aria-label={t`诊断`} className="flex max-h-56 flex-col overflow-y-auto px-2">
              {diagnostics.map((item, index) => {
                const where = item.file ? `${basename(item.file)}${item.line ? `:${item.line}` : ''}` : undefined;
                const Glyph = item.severity === 'error' ? IconCircleAlert : IconTriangleAlert;
                const [first, ...rest] = item.message.split('\n');
                const body = (
                  <>
                    <Glyph className={cn('mt-0.5 size-3.5 shrink-0', item.severity === 'error' ? 'text-danger' : 'text-warning')} />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className={cn('break-words text-xs', item.severity === 'error' ? 'text-fg' : 'text-fg-2', item.message.startsWith('at ') && 'font-mono text-2xs')}>{first}</span>
                      {rest.length > 0 && <span className="line-clamp-2 break-words text-2xs text-fg-3">{rest.join('\n')}</span>}
                    </span>
                    {where && <span className="mt-0.5 max-w-[45%] shrink-0 truncate font-mono text-2xs text-accent">{where}</span>}
                  </>
                );
                return (
                  <li key={index}>
                    {item.file
                      ? <button type="button" title={`${item.file}${item.line ? `:${item.line}` : ''}`} className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-hover max-md:min-h-11" onClick={() => openFile(item.file!, item.line)}>{body}</button>
                      : <div className="flex items-start gap-2 px-2 py-1.5">{body}</div>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {images.map((artifact) => (
        <a key={artifact.id} href={tasksApi.artifactUrl(task.id, artifact.id)} target="_blank" rel="noreferrer" aria-label={artifact.name}
          className="mx-3 mb-2 flex max-h-64 shrink-0 justify-center overflow-hidden rounded-lg bg-subtle">
          <img src={tasksApi.artifactUrl(task.id, artifact.id)} alt={artifact.name} className="max-h-64 w-auto object-contain" />
        </a>
      ))}
      {files.map((artifact) => (
        <a key={artifact.id} href={tasksApi.artifactUrl(task.id, artifact.id)} download={artifact.name} aria-label={t`下载 ${artifact.name}`}
          className="mx-2 mb-1 flex h-8 shrink-0 items-center gap-2 rounded-lg px-2 text-sm text-fg hover:bg-hover max-md:h-11">
          <IconDownload className="size-3.5 shrink-0 text-fg-3" />
          <span className="min-w-0 truncate">{artifact.name}</span>
          <span className="ml-auto shrink-0 text-xs tabular-nums text-fg-3">{formatBytes(artifact.size)}</span>
        </a>
      ))}

      {logStyle?.records
        ? <RecordsLogView log={log} rules={logStyle.rules} records={logStyle.records} wrap={wrap} storageKey={`riffet.tasks.log.v1.${task.providerId}.${task.actionId}`} />
        : <LogView log={log} rules={logStyle?.rules} wrap={wrap} />}
    </div>
  );
}

const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** The most lines drawn; older ones stay on the server. */
const LOG_LINES = 4000;
const WRAP_KEY = 'riffet.tasks.wrap.v1';

const TONES: Record<TaskLogTone, string> = { muted: 'text-fg-4', error: 'text-danger', warning: 'text-warning', success: 'text-success', accent: 'text-accent' };

interface Compiled { test: RegExp; tone?: TaskLogTone; fold?: boolean }

function compile(rules: readonly TaskLogRule[] | undefined): Compiled[] {
  const compiled: Compiled[] = [];
  for (const rule of rules ?? []) {
    try { compiled.push({ test: new RegExp(rule.pattern, rule.flags === 'i' ? 'i' : undefined), ...(rule.tone ? { tone: rule.tone } : {}), ...(rule.fold ? { fold: true } : {}) }); } catch { /* the server already drops these */ }
  }
  return compiled;
}

type LogRow = { kind: 'line'; text: string; tone?: TaskLogTone } | { kind: 'fold'; lines: Array<{ text: string; tone?: TaskLogTone }>; start: number };

/** The log in rows: each line toned by the first rule it matches, consecutive folded lines as one row. */
function rowsOf(log: string, rules: readonly Compiled[]): LogRow[] {
  const lines = log.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const offset = Math.max(0, lines.length - LOG_LINES);
  const rows: LogRow[] = [];
  for (let index = offset; index < lines.length; index++) {
    const text = lines[index]!;
    const rule = rules.find((item) => item.test.test(text));
    const line = { text, ...(rule?.tone ? { tone: rule.tone } : {}) };
    const last = rows.at(-1);
    if (rule?.fold) {
      if (last?.kind === 'fold') last.lines.push(line);
      else rows.push({ kind: 'fold', lines: [line], start: index });
    } else rows.push({ kind: 'line', ...line });
  }
  // A single folded line is not worth a row of its own.
  return rows.map((row) => (row.kind === 'fold' && row.lines.length === 1 ? { kind: 'line', ...row.lines[0]! } : row));
}

function RecordsLogView({ rules, ...props }: { log: string; rules: readonly TaskLogRule[]; records: TaskLogRecords; wrap: boolean; storageKey: string }) {
  const compiled = useMemo(() => compile(rules), [rules]);
  const tone = useCallback((text: string) => compiled.find((rule) => rule.test.test(text))?.tone, [compiled]);
  return <RecordsLog {...props} tone={tone} />;
}

function LogView({ log, rules, wrap }: { log: string; rules: readonly TaskLogRule[] | undefined; wrap: boolean }) {
  const { t } = useLingui();
  const compiled = useMemo(() => compile(rules), [rules]);
  const rows = useMemo(() => rowsOf(log, compiled), [log, compiled]);
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set());

  const ref = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  useLayoutEffect(() => { const node = ref.current; if (node && stuck.current) node.scrollTop = node.scrollHeight; }, [rows]);

  const line = (text: string, tone: TaskLogTone | undefined, key: string | number) => <div key={key} className={cn('min-h-5', tone ? TONES[tone] : 'text-fg-2')}>{text || ' '}</div>;

  return (
    <div className="flex min-h-0 flex-1 flex-col edge-t">
      <div
        ref={ref} role="log" aria-label={t`日志`} tabIndex={0}
        onScroll={(event) => { const node = event.currentTarget; stuck.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24; }}
        className={cn('min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-xs leading-5', wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre')}
      >
        <div className={cn(!wrap && 'w-max min-w-full')}>
          {rows.map((row, index) => {
            if (row.kind === 'line') return line(row.text, row.tone, index);
            if (opened.has(row.start)) return <div key={`f${row.start}`}>{row.lines.map((item, inner) => line(item.text, item.tone, inner))}</div>;
            return (
              <button key={`f${row.start}`} type="button" aria-label={t`展开 ${row.lines.length} 行`}
                onClick={() => setOpened((current) => new Set(current).add(row.start))}
                className="flex min-h-5 items-center gap-1 rounded text-fg-4 hover:text-fg-2">
                <IconChevronRight className="size-3" /><span className="tabular-nums">{row.lines.length}</span>
                <span className="truncate">{row.lines.at(-1)!.text}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function StateGlyph({ state, label }: { state: TaskState; label: string }) {
  const common = { 'aria-label': label, role: 'img' } as const;
  if (state === 'running') return <span {...common} className="flex shrink-0"><Spinner /></span>;
  if (state === 'cancelling') return <span {...common} className="flex shrink-0"><Spinner className="text-warning" /></span>;
  if (state === 'succeeded') return <IconCircleCheck {...common} className="size-3.5 shrink-0 text-success" />;
  if (state === 'failed') return <IconCircleAlert {...common} className="size-3.5 shrink-0 text-danger" />;
  if (state === 'cancelled') return <IconCircleDashed {...common} className="size-3.5 shrink-0 text-fg-3" />;
  return <IconCircleHelp {...common} className="size-3.5 shrink-0 text-warning" />;
}
