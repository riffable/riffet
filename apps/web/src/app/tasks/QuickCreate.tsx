import { useState } from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { AutomationTrigger, NativeBackendCatalogEntry, NativeBackendId } from '@contracts';
import { IconArrowUp, IconCalendarClock, IconChevronDown } from '@/components/icons';
import { Spinner } from '@/components/ui/controls';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { api, type ProjectRecord } from '@/lib/api';
import { cn, errorMessage } from '@/lib/utils';
import { BackendPicker } from '../session/BackendPicker';
import { classifyEnterGesture, primaryEnterHint, readEnterKeyBehavior, resolveEnter } from '../session/composerKeyboard';
import { CRON_PRESETS, cronTrigger, describeCron, nameFromPrompt, ONCE_PRESETS, onceDate, onceLabel, onceTrigger, type OncePreset } from './automation';
import type { AutomationEditorState } from './AutomationEditor';

type When = { kind: 'once'; preset: OncePreset } | { kind: 'cron'; cron: string };

const whenLabel = (when: When) => when.kind === 'once' ? onceLabel(when.preset) : describeCron(when.cron);
const triggerOf = (when: When): AutomationTrigger => when.kind === 'once' ? onceTrigger(onceDate(when.preset)) : cronTrigger(when.cron);

const EXAMPLES: ReadonlyArray<{ text: ReturnType<typeof msg>; when: When }> = [
  { text: msg`总结昨天的提交`, when: { kind: 'cron', cron: '0 9 * * 1-5' } },
  { text: msg`检查依赖更新`, when: { kind: 'cron', cron: '0 9 * * 1' } },
  { text: msg`跑一遍测试并汇报失败`, when: { kind: 'cron', cron: '0 22 * * *' } },
];

const pill = 'inline-flex h-7 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-sm text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus data-[state=open]:bg-hover data-[state=open]:text-fg no-hover:min-h-11';

/** Write what to do, pick when, press send: the whole of making a scheduled task. */
export function QuickCreate({ projects, defaultProjectId, backends, enterBehavior, examples, onCreated, onCustom, onError }: {
  projects: ProjectRecord[];
  defaultProjectId?: string;
  backends: NativeBackendCatalogEntry[];
  enterBehavior?: string;
  /** Sample tasks under the bar, for a page with nothing on it yet. */
  examples: boolean;
  onCreated: () => void;
  /** "Custom" in the time menu: the full editor, with what has been filled in so far. */
  onCustom: (state: AutomationEditorState) => void;
  onError: (message: string) => void;
}) {
  const { t } = useLingui();
  const behavior = readEnterKeyBehavior(enterBehavior);
  const [text, setText] = useState('');
  const [when, setWhen] = useState<When>({ kind: 'once', preset: '1h' });
  const [projectId, setProjectId] = useState(defaultProjectId ?? '');
  const [backendId, setBackendId] = useState<NativeBackendId>();
  const [busy, setBusy] = useState(false);
  const project = projects.find((item) => item.id === projectId) ?? projects.find((item) => item.id === defaultProjectId) ?? projects[0];
  const agent = backendId ?? backends.find((item) => item.available)?.backendId ?? backends[0]?.backendId;
  const ready = Boolean(text.trim() && project) && !busy;

  const submit = async () => {
    if (!ready || !project) return;
    setBusy(true);
    try {
      await api.createAutomation({
        name: nameFromPrompt(text), prompt: text.trim(), projectId: project.id,
        ...(backendId ? { target: { backendId } } : {}),
        triggers: [triggerOf(when)], delivery: 'new', catchUp: 'latest', enabled: true,
      });
      setText('');
      onCreated();
    } catch (error) { onError(errorMessage(error, t`无法创建定时任务`)); }
    finally { setBusy(false); }
  };
  const openEditor = () => onCustom({
    seed: { prompt: text.trim(), projectId: project?.id, ...(backendId ? { target: { backendId } } : {}), trigger: triggerOf(when) },
    focus: 'when',
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col rounded-2xl bg-elevated shadow-composer transition-shadow focus-within:shadow-composer-focus max-md:rounded-3xl max-md:border max-md:border-line-strong max-md:shadow-soft max-md:focus-within:border-fg-4/55">
        <textarea
          rows={1}
          value={text}
          aria-label={t`要做什么…`}
          placeholder={t`要做什么…`}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            const composing = event.nativeEvent.isComposing || event.keyCode === 229;
            const outcome = resolveEnter({
              kind: classifyEnterGesture({ key: event.key, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, composing, repeat: event.repeat }),
              composing, repeat: event.repeat, hasDraft: Boolean(text.trim()),
            }, behavior);
            if (outcome.preventDefault) event.preventDefault();
            if (outcome.action === 'send') void submit();
          }}
          className="field-sizing-content max-h-60 min-h-[52px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-base leading-6 text-fg outline-none placeholder:text-fg-4"
        />
        <div className="flex min-w-0 items-center gap-1 px-2 pb-2 pt-1">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-0.5">
            <DropdownMenu>
              <DropdownMenuTrigger className={pill} aria-label={t`选择时间`}>
                <IconCalendarClock className="size-3.5 shrink-0" />
                <span className="truncate">{whenLabel(when)}</span>
                <IconChevronDown className="size-3 shrink-0 text-fg-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-52">
                {ONCE_PRESETS.map((preset) => <DropdownMenuItem key={preset} onSelect={() => setWhen({ kind: 'once', preset })}>{onceLabel(preset)}</DropdownMenuItem>)}
                <DropdownMenuSeparator />
                {CRON_PRESETS.map((cron) => <DropdownMenuItem key={cron} onSelect={() => setWhen({ kind: 'cron', cron })}>{describeCron(cron)}</DropdownMenuItem>)}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => openEditor()}><Trans>自定义…</Trans></DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger className={cn(pill, 'max-w-40')} aria-label={t`选择项目`} disabled={!projects.length}>
                <span className="truncate">{project?.name}</span>
                <IconChevronDown className="size-3 shrink-0 text-fg-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-72 min-w-48 overflow-y-auto">
                <DropdownMenuRadioGroup value={project?.id ?? ''} onValueChange={setProjectId}>
                  {projects.map((item) => <DropdownMenuRadioItem key={item.id} value={item.id}>{item.name}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            {agent && backends.length > 0 && <BackendPicker backends={backends} backendId={agent} onChange={setBackendId} />}
          </div>
          <Tip label={t`创建`} kbd={primaryEnterHint(behavior)}>
            <button
              type="button"
              aria-label={t`创建`}
              disabled={!ready}
              onClick={() => void submit()}
              className="grid size-11 shrink-0 place-items-center rounded-full bg-primary text-primary-fg transition-[background-color,color,transform] hover:bg-primary-hover active:scale-90 disabled:bg-fg/[0.08] disabled:text-fg-4 disabled:active:scale-100 md:size-8"
            >
              {busy ? <Spinner className="size-4 text-current" /> : <IconArrowUp className="size-4" strokeWidth={2.4} />}
            </button>
          </Tip>
        </div>
      </div>
      {examples && (
        <ul className="flex flex-col">
          {EXAMPLES.map((example) => {
            const item = { when: example.when, label: i18n._(example.text) };
            return (
            <li key={item.label}>
              <button type="button" onClick={() => { setText(item.label); setWhen(item.when); }} className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-fg-2 transition-colors hover:bg-hover md:min-h-9">
                <span className="w-28 shrink-0 text-fg-3">{whenLabel(item.when)}</span>
                <span className="min-w-0 truncate">{item.label}</span>
              </button>
            </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
