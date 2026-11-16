import { useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { Automation, AutomationTrigger, LaunchTarget, NativeBackendCatalogEntry, NativeBackendId } from '@contracts';
import { IconCalendarClock } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Field, Input, Segmented, Select, Switch, Textarea } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, HttpError, type ProjectRecord } from '@/lib/api';
import { useDiscardGuard } from '@/lib/dialogs';
import { cn, errorMessage } from '@/lib/utils';
import { CRON_PRESETS, cronTrigger, describeCron, formatWhen, localTimeZone, nameFromPrompt, onceTrigger, toLocalInput, triggerNextRun } from './automation';

/** What the editor opens with: an automation being changed, or the fields a new one starts from. */
export interface AutomationEditorState {
  automation?: Automation;
  seed?: { name?: string; prompt?: string; target?: LaunchTarget; projectId?: string; isolate?: boolean; trigger?: AutomationTrigger };
  /** Open scrolled to the "when" group. */
  focus?: 'when';
}

type When = 'manual' | 'once' | 'repeat';

interface Fields { name: string; prompt: string; backendId: NativeBackendId | ''; projectId: string; isolate: boolean; when: When; onceAt: string; preset: string; custom: string; delivery: Automation['delivery']; catchUp: boolean }

function fieldsOf(state: AutomationEditorState, defaultProjectId: string): Fields {
  const source = state.automation;
  const seed = state.seed;
  const first = source ? source.triggers[0] : seed?.trigger;
  const cron = first?.kind === 'cron' ? first.cron : CRON_PRESETS[0];
  const known = (CRON_PRESETS as readonly string[]).includes(cron);
  return {
    name: source?.name ?? seed?.name ?? '',
    prompt: source?.prompt ?? seed?.prompt ?? '',
    backendId: (source?.backendId ?? seed?.target?.backendId ?? '') as NativeBackendId | '',
    projectId: source ? source.projectId ?? '' : seed?.projectId ?? defaultProjectId,
    isolate: Boolean(source?.isolate ?? seed?.isolate),
    when: !first ? 'manual' : first.kind === 'once' ? 'once' : 'repeat',
    onceAt: first?.kind === 'once' ? toLocalInput(new Date(first.at)) : '',
    preset: known ? cron : 'custom',
    custom: known ? '' : cron,
    delivery: source?.delivery ?? 'new',
    catchUp: (source?.catchUp ?? 'latest') === 'latest',
  };
}

const groupTitle = 'text-xs font-medium text-fg-3';

export function AutomationEditor({ state, projects, backends, defaultProjectId, onClose, onSaved, onError }: {
  state?: AutomationEditorState;
  projects: ProjectRecord[];
  backends: NativeBackendCatalogEntry[];
  defaultProjectId?: string;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const { t } = useLingui();
  const existing = state?.automation;
  const [fields, setFields] = useState<Fields>(() => fieldsOf(state ?? {}, ''));
  const [initial, setInitial] = useState('');
  const [busy, setBusy] = useState(false);
  const [cronError, setCronError] = useState('');
  const [editingExisting, setEditingExisting] = useState(false);
  const whenRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!state) return;
    const live = projects.some((item) => item.id === defaultProjectId) ? defaultProjectId! : '';
    const next = fieldsOf(state, live);
    setFields(next);
    setInitial(JSON.stringify(next));
    setCronError('');
    setEditingExisting(Boolean(state.automation));
    if (state.focus === 'when') window.setTimeout(() => whenRef.current?.scrollIntoView({ block: 'start' }), 60);
    // Opened afresh for each state; the project list may change underneath without resetting it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  const set = (patch: Partial<Fields>) => { setFields((current) => ({ ...current, ...patch })); setCronError(''); };
  const discard = useDiscardGuard(Boolean(state) && JSON.stringify(fields) !== initial);
  const close = () => discard.close(onClose);

  const cron = fields.preset === 'custom' ? fields.custom.trim() : fields.preset;
  const onceDate = fields.onceAt ? new Date(fields.onceAt) : undefined;
  const onceValid = Boolean(onceDate && !Number.isNaN(onceDate.getTime()));
  const previous = existing?.triggers[0] ?? state?.seed?.trigger;
  // A time left as it was goes back as it was: re-encoding it would drop the seconds of a preset
  // and add a zone, which the server reads as a new time.
  const saved = initial ? JSON.parse(initial) as Fields : undefined;
  const whenUntouched = Boolean(existing?.triggers[0] && saved && (['when', 'onceAt', 'preset', 'custom'] as const).every((key) => saved[key] === fields[key]));
  const first: AutomationTrigger | undefined = whenUntouched ? existing!.triggers[0]
    : fields.when === 'once' ? (onceValid ? onceTrigger(onceDate!) : undefined)
    : fields.when === 'repeat' && cron ? cronTrigger(cron, previous?.kind === 'cron' ? previous.timeZone : localTimeZone()) : undefined;
  const scheduled = fields.when !== 'manual';
  const complete = Boolean(fields.prompt.trim()) && (!scheduled || (Boolean(first) && Boolean(fields.projectId)));
  const unchangedWhen = Boolean(existing?.nextRunAt) && JSON.stringify(first) === JSON.stringify(existing?.triggers[0]);
  const next = unchangedWhen ? new Date(existing!.nextRunAt!) : triggerNextRun(first);

  const submit = async () => {
    if (busy || !complete) return;
    setBusy(true);
    setCronError('');
    try {
      // Model, mode and permission belong to one backend; switching it falls back to that backend's
      // saved defaults rather than carrying values it may not understand.
      const base: LaunchTarget = existing ?? state?.seed?.target ?? {};
      const kept = base.backendId === (fields.backendId || undefined)
        ? { ...(base.backendProfileId ? { backendProfileId: base.backendProfileId } : {}), ...(base.model ? { model: base.model } : {}), ...(base.mode ? { mode: base.mode } : {}), ...(base.approval ? { approval: base.approval } : {}) }
        : {};
      const target: LaunchTarget = { ...(fields.backendId ? { backendId: fields.backendId } : {}), ...kept };
      // Only the first trigger is edited here; the others the agent or a later version set stay,
      // unless the task is made manual, which it then really is.
      const triggers = first ? [first, ...(existing?.triggers.slice(1) ?? [])] : [];
      const body = {
        name: fields.name.trim() || nameFromPrompt(fields.prompt), prompt: fields.prompt.trim(), target, isolate: fields.isolate,
        triggers, delivery: fields.delivery, catchUp: fields.catchUp ? 'latest' as const : 'skip' as const,
      };
      if (existing) await api.updateAutomation(existing.id, { ...body, projectId: fields.projectId || null });
      else await api.createAutomation({ ...body, ...(fields.projectId ? { projectId: fields.projectId } : {}), enabled: true });
      onClose();
      onSaved();
    } catch (error) {
      if (error instanceof HttpError && error.code === 'INVALID_CRON') setCronError(t`无法识别这个时间表达式`);
      else onError(errorMessage(error, t`无法保存自动化`));
    } finally { setBusy(false); }
  };

  const chip = (active: boolean) => cn('h-7 rounded-lg border px-2.5 text-sm transition-colors no-hover:min-h-11', active ? 'border-accent bg-accent-soft text-fg' : 'border-line text-fg-2 hover:bg-hover');
  const orphan = fields.projectId && !projects.some((item) => item.id === fields.projectId);
  // Literal braces must be values, not message text: ICU would read `{{date}}` as an argument.
  const dateToken = '{{date}}';
  const projectToken = '{{project}}';
  return (
    <Dialog open={Boolean(state)} onOpenChange={(open) => { if (!open && !busy) close(); }}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{editingExisting ? t`编辑自动化` : t`新建自动化`}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-5">
          <section className="flex flex-col gap-3">
            <Field label={t`名称`}><Input value={fields.name} onChange={(event) => set({ name: event.target.value })} placeholder={nameFromPrompt(fields.prompt) || undefined} /></Field>
            <Field label={t`任务`} hint={<Trans>运行时 <code className="font-mono">{dateToken}</code> 会替换为当天日期，<code className="font-mono">{projectToken}</code> 替换为项目名。</Trans>}>
              <Textarea autoFocus={!existing && !fields.prompt} value={fields.prompt} onChange={(event) => set({ prompt: event.target.value })} className="min-h-28" placeholder={t`让 Agent 做什么`} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Agent">
                <Select<string> label="Agent" value={fields.backendId} onChange={(next) => set({ backendId: next as NativeBackendId | '' })}
                  options={[{ value: '', label: t`默认 Agent` }, ...backends.map((entry) => ({ value: entry.backendId, label: `${entry.label}${entry.available ? '' : t`（不可用）`}` }))]} />
              </Field>
              <Field label={t`项目`}>
                <Select label={t`项目`} value={fields.projectId} onChange={(projectId) => set({ projectId })}
                  options={[
                    ...(!scheduled ? [{ value: '', label: t`运行时选择` }] : !fields.projectId ? [{ value: '', label: t`选择项目`, disabled: true }] : []),
                    ...(orphan ? [{ value: fields.projectId, label: t`已移除的项目` }] : []),
                    ...projects.map((item) => ({ value: item.id, label: item.name })),
                  ]} />
              </Field>
            </div>
            <label className="flex items-center justify-between gap-3 text-sm text-fg">
              <Trans>每次在新的 Worktree 中运行</Trans>
              <Switch checked={fields.isolate} onCheckedChange={(isolate) => set({ isolate })} aria-label={t`每次在新的 Worktree 中运行`} />
            </label>
          </section>

          <section ref={whenRef} className="flex scroll-mt-2 flex-col gap-3 border-t border-line pt-5">
            <h3 className={groupTitle}><Trans>何时运行</Trans></h3>
            <Segmented<When> value={fields.when} onChange={(when) => set({ when })} ariaLabel={t`何时运行`} options={[{ value: 'manual', label: t`手动` }, { value: 'once', label: t`一次` }, { value: 'repeat', label: t`重复` }]} />
            {fields.when === 'once' && <Input type="datetime-local" autoFocus={state?.focus === 'when'} value={fields.onceAt} onChange={(event) => set({ onceAt: event.target.value })} aria-label={t`日期时间`} />}
            {fields.when === 'repeat' && (
              <div className="flex flex-col gap-1.5">
                <div className="flex flex-wrap gap-1.5">
                  {[...CRON_PRESETS.map((item) => ({ cron: item as string, label: describeCron(item) })), { cron: 'custom', label: t`自定义` }].map((item) => (
                    <button key={item.cron} type="button" aria-pressed={fields.preset === item.cron} onClick={() => set({ preset: item.cron })} className={chip(fields.preset === item.cron)}>{item.label}</button>
                  ))}
                </div>
                {fields.preset === 'custom' && (
                  <>
                    <Input autoFocus className="font-mono" value={fields.custom} onChange={(event) => set({ custom: event.target.value })} placeholder="30 8 * * 1-5" aria-label={t`Cron 表达式`} />
                    <span className={cn('text-xs', cronError ? 'text-danger' : 'text-fg-3')}>
                      {cronError || (fields.custom.trim() && describeCron(fields.custom) !== fields.custom.trim() ? describeCron(fields.custom) : t`分 时 日 月 周，本地时间；也可以用 @daily、@hourly`)}
                    </span>
                  </>
                )}
              </div>
            )}
            {scheduled && next && <span className="text-xs text-fg-3"><Trans>下次 {formatWhen(next.toISOString())}</Trans></span>}
          </section>

          <section className="flex flex-col gap-3 border-t border-line pt-5">
            <h3 className={groupTitle}><Trans>运行方式</Trans></h3>
            <Segmented<Automation['delivery']> value={fields.delivery} onChange={(delivery) => set({ delivery })} ariaLabel={t`运行方式`} options={[{ value: 'new', label: t`每次开新会话` }, { value: 'same', label: t`在同一会话继续` }]} />
            {scheduled && (
              <label className="flex items-center justify-between gap-3 text-sm text-fg">
                <Trans>错过后补跑</Trans>
                <Switch checked={fields.catchUp} onCheckedChange={(catchUp) => set({ catchUp })} aria-label={t`错过后补跑`} />
              </label>
            )}
          </section>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={close}><Trans context="tasks-cancel-action">取消</Trans></Button>
          <Button variant="primary" disabled={!complete} onClick={() => void submit()} busy={busy}><IconCalendarClock /><Trans>保存</Trans></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
