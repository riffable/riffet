import { useEffect, useId, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { Automation, AutomationTrigger, LaunchTarget, NativeBackendCatalogEntry } from '@contracts';
import { IconChevronDown } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Field, fieldClass, Input, Segmented, Select, Switch, Textarea } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, HttpError, type ProjectRecord } from '@/lib/api';
import { useDiscardGuard } from '@/lib/dialogs';
import { cn, errorMessage } from '@/lib/utils';
import { type AgentModelValue, useAgentModelChoice } from '../session/agentModelChoice';
import { ModelPicker } from '../session/ModelPicker';
import { CRON_PRESETS, cronTrigger, describeCron, formatWhen, localTimeZone, nameFromPrompt, onceTrigger, toLocalInput, triggerNextRun } from './automation';

/** What the editor opens with: an automation being changed, or the fields a new one starts from. */
export interface AutomationEditorState {
  automation?: Automation;
  seed?: { name?: string; prompt?: string; target?: LaunchTarget; projectId?: string; isolate?: boolean; trigger?: AutomationTrigger };
  /** Open scrolled to the "when" group. */
  focus?: 'when';
}

type When = 'manual' | 'once' | 'repeat';

interface Fields { name: string; prompt: string; agent?: AgentModelValue; projectId: string; isolate: boolean; when: When; onceAt: string; preset: string; custom: string; delivery: Automation['delivery']; catchUp: boolean }

function fieldsOf(state: AutomationEditorState, defaultProjectId: string): Fields {
  const source = state.automation;
  const seed = state.seed;
  const first = source ? source.triggers[0] : seed?.trigger;
  const cron = first?.kind === 'cron' ? first.cron : CRON_PRESETS[0];
  const known = (CRON_PRESETS as readonly string[]).includes(cron);
  return {
    name: source?.name ?? seed?.name ?? '',
    prompt: source?.prompt ?? seed?.prompt ?? '',
    agent: agentOf(source ?? seed?.target),
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

/** The agent, provider and model a target names; none means the default agent at run time. */
function agentOf(target: LaunchTarget | undefined): AgentModelValue | undefined {
  if (!target?.backendId) return undefined;
  return { backendId: target.backendId, ...(target.backendProfileId ? { profileId: target.backendProfileId } : {}), ...(target.model ? { model: target.model } : {}) };
}

const CUSTOM = 'custom';
/** Segments share the column's width, as the fields above and below them do. */
const fill = 'w-full [&>[role=radio]]:flex-1';

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
  const promptId = useId();
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
  const { picker, pick, params, withParam } = useAgentModelChoice({ projectId: fields.projectId, backends, choice: fields.agent, agents: true });

  const submit = async () => {
    if (busy || !complete) return;
    setBusy(true);
    setCronError('');
    try {
      // Mode and permission belong to one backend; switching it falls back to that backend's saved
      // defaults rather than carrying values it may not understand.
      const base: LaunchTarget = existing ?? state?.seed?.target ?? {};
      const agent = fields.agent;
      const kept = agent && base.backendId === agent.backendId ? { ...(base.mode ? { mode: base.mode } : {}), ...(base.approval ? { approval: base.approval } : {}) } : {};
      const target: LaunchTarget = agent
        ? { backendId: agent.backendId, ...(agent.profileId ? { backendProfileId: agent.profileId } : {}), ...(agent.model ? { model: agent.model } : {}), ...kept }
        : {};
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

  const orphan = fields.projectId && !projects.some((item) => item.id === fields.projectId);
  // Literal braces must be values, not message text: ICU would read `{{date}}` as an argument.
  const dateToken = '{{date}}';
  const projectToken = '{{project}}';
  const customCron = fields.preset === CUSTOM;
  const described = customCron && fields.custom.trim() && describeCron(fields.custom) !== fields.custom.trim() ? describeCron(fields.custom) : '';
  const nextText = scheduled && next ? t`下次 ${formatWhen(next.toISOString())}` : '';
  const whenHint = cronError || [described, nextText].filter(Boolean).join(' · ') || (customCron ? t`分 时 日 月 周，本地时间；也可以用 @daily、@hourly` : '');
  return (
    <Dialog open={Boolean(state)} onOpenChange={(open) => { if (!open && !busy) close(); }}>
      <DialogContent size="content" mobileFullscreen aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{editingExisting ? t`编辑自动化` : t`新建自动化`}</DialogTitle>
        </DialogHeader>
        <DialogBody className="grid gap-x-6 gap-y-5 md:grid-cols-[minmax(0,1fr)_16.5rem]">
          <div className="flex min-w-0 flex-col gap-4">
            <Field label={t`名称`}><Input value={fields.name} onChange={(event) => set({ name: event.target.value })} placeholder={nameFromPrompt(fields.prompt) || undefined} /></Field>
            {/* A Field whose box grows to the settings column beside it, so the two end on one line. */}
            <div className="flex min-h-0 flex-1 flex-col gap-1.5">
              <label htmlFor={promptId} className="text-sm font-medium text-fg"><Trans>任务</Trans></label>
              <Textarea id={promptId} autoFocus={!existing && !fields.prompt} value={fields.prompt} onChange={(event) => set({ prompt: event.target.value })} className="min-h-56 flex-1 resize-none md:min-h-72" placeholder={t`让 Agent 做什么`} />
              <p className="text-xs text-fg-3"><Trans>运行时 <code className="font-mono">{dateToken}</code> 替换为当天日期，<code className="font-mono">{projectToken}</code> 替换为项目名</Trans></p>
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-5 max-md:edge-t max-md:pt-5 md:edge-l md:pl-6">
            <div className="flex flex-col gap-4">
              <Field label="Agent">
                {/* The composer's Agent → provider → model menu, on a trigger drawn as the Select below it. */}
                <span className="relative flex min-w-0">
                  <ModelPicker side="bottom" align="start" placeholder={fields.agent ? t`默认模型` : t`默认 Agent`} {...picker}
                    className={cn(fieldClass, 'h-8 w-full justify-start pr-8 text-fg hover:bg-elevated hover:text-fg data-[state=open]:border-accent data-[state=open]:bg-elevated data-[state=open]:text-fg data-[state=open]:ring-3 data-[state=open]:ring-accent/15 max-md:h-11 max-md:rounded-xl max-md:px-3 max-md:pr-8 max-md:text-base')}
                    labelClassName="min-w-0 flex-1 max-w-none truncate text-left sm:max-w-none"
                    params={params} onParamChange={(id, value) => { const agent = withParam(id, value); if (agent) set({ agent }); }}
                    onChange={(id) => { const agent = pick(id); if (agent) set({ agent }); }} />
                  <IconChevronDown aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-3" />
                </span>
              </Field>
              <Field label={t`项目`}>
                <Select label={t`项目`} value={fields.projectId} onChange={(projectId) => set({ projectId })}
                  options={[
                    ...(!scheduled ? [{ value: '', label: t`运行时选择` }] : !fields.projectId ? [{ value: '', label: t`选择项目`, disabled: true }] : []),
                    ...(orphan ? [{ value: fields.projectId, label: t`已移除的项目` }] : []),
                    ...projects.map((item) => ({ value: item.id, label: item.name })),
                  ]} />
              </Field>
              <label className="flex min-h-8 items-center justify-between gap-3 text-sm text-fg">
                <Trans>每次新建 Worktree</Trans>
                <Switch checked={fields.isolate} onCheckedChange={(isolate) => set({ isolate })} aria-label={t`每次新建 Worktree`} />
              </label>
            </div>

            <div ref={whenRef} className="flex scroll-mt-2 flex-col gap-2 edge-t pt-5">
              <span className="text-sm font-medium text-fg"><Trans>何时运行</Trans></span>
              <Segmented<When> className={fill} value={fields.when} onChange={(when) => set({ when })} ariaLabel={t`何时运行`} options={[{ value: 'manual', label: t`手动` }, { value: 'once', label: t`一次` }, { value: 'repeat', label: t`重复` }]} />
              {fields.when === 'once' && <Input type="datetime-local" autoFocus={state?.focus === 'when'} value={fields.onceAt} onChange={(event) => set({ onceAt: event.target.value })} aria-label={t`日期时间`} />}
              {fields.when === 'repeat' && (
                <Select<string> label={t`重复`} value={fields.preset} onChange={(preset) => set({ preset })}
                  options={[...CRON_PRESETS.map((item) => ({ value: item as string, label: describeCron(item) })), { value: CUSTOM, label: t`自定义` }]} />
              )}
              {fields.when === 'repeat' && customCron && (
                <Input autoFocus className="font-mono" value={fields.custom} onChange={(event) => set({ custom: event.target.value })} placeholder="30 8 * * 1-5" aria-label={t`Cron 表达式`} aria-invalid={Boolean(cronError) || undefined} />
              )}
              {whenHint && <span role={cronError ? 'alert' : undefined} className={cn('text-xs', cronError ? 'text-danger' : 'text-fg-3')}>{whenHint}</span>}
            </div>

            <div className="flex flex-col gap-2 edge-t pt-5">
              <span className="text-sm font-medium text-fg"><Trans>运行方式</Trans></span>
              <Segmented<Automation['delivery']> className={fill} value={fields.delivery} onChange={(delivery) => set({ delivery })} ariaLabel={t`运行方式`} options={[{ value: 'new', label: t`每次开新会话` }, { value: 'same', label: t`在同一会话继续` }]} />
              {scheduled && (
                <label className="flex min-h-8 items-center justify-between gap-3 text-sm text-fg">
                  <Trans>错过后补跑</Trans>
                  <Switch checked={fields.catchUp} onCheckedChange={(catchUp) => set({ catchUp })} aria-label={t`错过后补跑`} />
                </label>
              )}
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={close}><Trans context="tasks-cancel-action">取消</Trans></Button>
          <Button variant="primary" disabled={!complete} onClick={() => void submit()} busy={busy}><Trans>保存</Trans></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
