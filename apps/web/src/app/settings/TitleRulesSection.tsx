import { useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { matchTitleRule, renderDisplayTitle, TITLE_RULE_TEMPLATE_MAX, TITLE_RULES_MAX, type AppSettings, type Session, type TitleRule, type TitleRuleContext, type TitleRuleOrigin } from '@contracts';
import { IconArrowDown, IconArrowUp, IconEllipsis, IconFolderPlus, IconPencilLine, IconPlus, IconTrash2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState, Field, Input, Segmented, Textarea } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { ProjectRecord } from '@/lib/api';
import { api } from '@/lib/api';
import { useDiscardGuard } from '@/lib/dialogs';
import { baseTitle } from '@/lib/shown-title';
import { toast } from '@/lib/toast';
import { errorMessage, newId } from '@/lib/utils';
import { useCatalog, useLists } from '../state/stores';
import { SettingsGroup } from './SettingsLayout';

type SaveProps = {
  settings: AppSettings;
  onSaved: (settings: AppSettings, patch: Partial<AppSettings>) => void;
  onError: (message: string) => void;
};

/** What the editor offers as a source; 自动化 also stands for the templates and schedules it replaced. */
const ORIGIN_CHOICES: ReadonlyArray<{ value: TitleRuleOrigin; covers: TitleRuleOrigin[] }> = [
  { value: 'manual', covers: ['manual'] },
  { value: 'automation', covers: ['automation', 'template', 'schedule'] },
  { value: 'channel', covers: ['channel'] },
  { value: 'assistant', covers: ['assistant'] },
  { value: 'fork', covers: ['fork'] },
  { value: 'handoff', covers: ['handoff'] },
  { value: 'attempt', covers: ['attempt'] },
  { value: 'discussion', covers: ['discussion'] },
];
// Literal braces must be values, not message text: ICU would read `{{title}}` as an argument.
const TOKENS = ['{{title}}', '{{project}}', '{{date}}', '{{time}}'] as const;
const EXAMPLE_TEMPLATE = '{{date}} {{title}}';

/** The conversations a rule would name, with their project, as the preview and the list count need them. */
function useRuleSubjects() {
  const sessions = useLists((state) => state.sessions);
  const projects = useLists((state) => state.projects);
  return useMemo(() => {
    const byId = new Map(projects.map((project) => [project.id, project]));
    return sessions.filter((session) => !session.archivedAt).map((session) => {
      const project = byId.get(session.projectId);
      const originProject = project?.worktree ? byId.get(project.worktree.originProjectId) : undefined;
      // The lists show what a rule made of a title; rules start from the title itself.
      const subject: Session = { ...session, title: baseTitle(session) };
      const context: TitleRuleContext = { ...(project ? { project } : {}), ...(originProject ? { originProject } : {}) };
      return { subject, context };
    });
  }, [sessions, projects]);
}

/** 会话标题: rules that change how conversations are shown, first match wins. */
export function TitleRulesSection({ settings, onSaved, onError }: SaveProps) {
  const { t } = useLingui();
  const rules = settings.titleRules ?? [];
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ rule?: TitleRule; key: number }>();
  const subjects = useRuleSubjects();
  const timeZone = settings.assistant?.timeZone;
  const counts = useMemo(() => {
    const result = new Map<string, number>();
    for (const { subject, context } of subjects) {
      const rule = matchTitleRule(rules, subject, { ...context, ...(timeZone ? { timeZone } : {}) });
      if (rule) result.set(rule.id, (result.get(rule.id) ?? 0) + 1);
    }
    return result;
  }, [rules, subjects, timeZone]);

  const save = async (next: TitleRule[], failure: string) => {
    setBusy(true);
    try {
      const saved = await api.updateSettings({ titleRules: next });
      onSaved(saved, { titleRules: saved.titleRules });
      return true;
    } catch (error) { onError(errorMessage(error, failure)); return false; }
    finally { setBusy(false); }
  };
  const move = (index: number, by: number) => {
    const next = [...rules];
    const [rule] = next.splice(index, 1);
    next.splice(index + by, 0, rule!);
    void save(next, t`无法保存标题规则`);
  };
  const remove = async (rule: TitleRule) => {
    const previous = rules;
    if (!await save(rules.filter((item) => item.id !== rule.id), t`无法删除标题规则`)) return;
    toast.success(t`已删除规则`, { action: { label: t`撤销`, onClick: () => void save(previous, t`无法恢复标题规则`) } });
  };
  const add = () => setEditing({ key: Date.now() });

  return <div className="flex flex-col gap-6">
    {rules.length === 0
      ? <EmptyState icon={<IconPencilLine />} title={t`还没有标题规则`}><Button variant="primary" onClick={add}><IconPlus /><Trans>添加规则</Trans></Button></EmptyState>
      : <SettingsGroup
          note={t`只改变显示的名称，CLI 里的会话名不变；保存在这台服务器`}
          action={rules.length < TITLE_RULES_MAX && <Button size="xs" variant="ghost" disabled={busy} onClick={add}><IconPlus /><Trans>添加</Trans></Button>}
        >
          {rules.map((rule, index) => (
            <div key={rule.id} className="-mx-4 flex min-h-14 items-center gap-1 pr-2 hover:bg-hover max-md:-mx-3 max-md:pr-1">
              <button type="button" disabled={busy} onClick={() => setEditing({ rule, key: Date.now() })} className="flex min-h-14 min-w-0 flex-1 flex-col justify-center gap-0.5 px-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus max-md:px-3">
                <span className="truncate font-mono text-sm text-fg">{rule.template}</span>
                <RuleSummary rule={rule} />
              </button>
              <span className="shrink-0 text-xs tabular-nums text-fg-4">{t`${counts.get(rule.id) ?? 0} 个会话`}</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button size="icon-sm" variant="quiet" disabled={busy} aria-label={t`更多操作`}><IconEllipsis /></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem disabled={index === 0} onSelect={() => move(index, -1)}><IconArrowUp /><Trans>上移</Trans></DropdownMenuItem>
                  <DropdownMenuItem disabled={index === rules.length - 1} onSelect={() => move(index, 1)}><IconArrowDown /><Trans>下移</Trans></DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="danger" onSelect={() => void remove(rule)}><IconTrash2 /><Trans>删除规则</Trans></DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
        </SettingsGroup>}
    {editing && <TitleRuleEditor
      key={editing.key}
      rule={editing.rule}
      rules={rules}
      timeZone={timeZone}
      busy={busy}
      onClose={() => setEditing(undefined)}
      onSave={async (rule) => {
        const next = editing.rule ? rules.map((item) => item.id === rule.id ? rule : item) : [...rules, rule];
        if (await save(next, t`无法保存标题规则`)) setEditing(undefined);
      }}
    />}
  </div>;
}

function useOriginLabels(): Record<TitleRuleOrigin, string> {
  const { t } = useLingui();
  return {
    manual: t`手动新建`, automation: t`自动化`, template: t`自动化`, schedule: t`自动化`, channel: t`机器人`, assistant: t`个人助理`,
    fork: t`分支`, handoff: t({ message: '交接', context: 'session-origin' }), attempt: t`尝试`, discussion: t`侧边聊天`, call: t({ message: '调用', context: 'session-origin' }), link: t`互联的服务器`, plugin: t`插件`,
  };
}

/** The rule's conditions on one line; a rule without any applies to every conversation. */
function RuleSummary({ rule }: { rule: TitleRule }) {
  const { t } = useLingui();
  const backends = useCatalog((state) => state.backends);
  const origins = useOriginLabels();
  const { directories, agents, origins: from, tags } = rule.match;
  const parts = [
    ...(directories ?? []),
    ...(agents ?? []).map((id) => backends.find((item) => item.backendId === id)?.label ?? id),
    ...[...new Set((from ?? []).map((origin) => origins[origin]))],
    ...(tags ?? []).map((tag) => `#${tag}`),
  ];
  return <span className="truncate text-xs text-fg-3">
    {parts.length ? parts.join(' · ') : t`所有会话`}
    {rule.scope === 'all' && <> · <Trans>含手动命名</Trans></>}
  </span>;
}

interface Draft { template: string; directories: string; agents: string[]; origins: TitleRuleOrigin[]; tags: string; scope: 'auto' | 'all' }

function draftOf(rule: TitleRule | undefined): Draft {
  return {
    template: rule?.template ?? '',
    directories: (rule?.match.directories ?? []).join('\n'),
    agents: rule?.match.agents ?? [],
    origins: rule?.match.origins ?? [],
    tags: (rule?.match.tags ?? []).join(', '),
    scope: rule?.scope ?? 'auto',
  };
}

function ruleOf(id: string, draft: Draft): TitleRule {
  const lines = (value: string, separator: RegExp) => [...new Set(value.split(separator).map((item) => item.trim()).filter(Boolean))];
  const directories = lines(draft.directories, /\n/);
  const tags = lines(draft.tags, /[,，]/);
  return {
    id,
    template: draft.template.trim(),
    match: {
      ...(directories.length ? { directories } : {}),
      ...(draft.agents.length ? { agents: draft.agents } : {}),
      ...(draft.origins.length ? { origins: draft.origins } : {}),
      ...(tags.length ? { tags } : {}),
    },
    ...(draft.scope === 'all' ? { scope: 'all' as const } : {}),
  };
}

function TitleRuleEditor({ rule, rules, timeZone, busy, onClose, onSave }: {
  rule?: TitleRule;
  rules: TitleRule[];
  timeZone?: string;
  busy: boolean;
  onClose: () => void;
  onSave: (rule: TitleRule) => Promise<void>;
}) {
  const { t } = useLingui();
  const [id] = useState(() => rule?.id ?? newId());
  const [initial] = useState(() => JSON.stringify(draftOf(rule)));
  const [draft, setDraft] = useState(() => draftOf(rule));
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const discard = useDiscardGuard(JSON.stringify(draft) !== initial, busy);
  const close = () => discard.close(onClose);
  const templateRef = useRef<HTMLInputElement>(null);
  const backends = useCatalog((state) => state.backends);
  const projects = useLists((state) => state.projects);
  const subjects = useRuleSubjects();
  const originLabels = useOriginLabels();

  const candidate = ruleOf(id, draft);
  const complete = Boolean(candidate.template);
  // The preview runs the whole list with this rule in its place, so a rule above it that matches first is accounted for.
  const preview = useMemo(() => {
    if (!complete) return { count: 0, examples: [] as Array<{ id: string; before: string; after: string }> };
    const list = rule ? rules.map((item) => item.id === id ? candidate : item) : [...rules, candidate];
    const examples: Array<{ id: string; before: string; after: string }> = [];
    let count = 0;
    for (const { subject, context } of subjects) {
      const full = { ...context, ...(timeZone ? { timeZone } : {}) };
      if (matchTitleRule(list, subject, full)?.id !== id) continue;
      count++;
      if (examples.length < 4) examples.push({ id: subject.id, before: subject.title, after: renderDisplayTitle([candidate], subject, full) ?? subject.title });
    }
    return { count, examples };
    // `candidate` is rebuilt from `draft` on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, rules, subjects, timeZone, complete]);

  const insert = (token: string) => {
    const input = templateRef.current;
    const at = input?.selectionStart ?? draft.template.length;
    const end = input?.selectionEnd ?? at;
    const next = `${draft.template.slice(0, at)}${token}${draft.template.slice(end)}`;
    set({ template: next });
    requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(at + token.length, at + token.length); });
  };
  const toggle = <T extends string>(list: T[], values: readonly T[], on: boolean) => on ? [...new Set([...list, ...values])] : list.filter((item) => !values.includes(item));
  const addDirectory = (cwd: string) => {
    const current = draft.directories.split('\n').map((item) => item.trim()).filter(Boolean);
    if (!current.includes(cwd)) set({ directories: [...current, cwd].join('\n') });
  };
  const tokenLabels: Record<(typeof TOKENS)[number], string> = { '{{title}}': t`原标题`, '{{project}}': t`项目`, '{{date}}': t`日期`, '{{time}}': t`时间` };
  const pickable = projects.filter((project: ProjectRecord) => !project.system && !project.archivedAt && !project.worktree);

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) close(); }}>
      <DialogContent size="content" mobileFullscreen aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{rule ? t`编辑标题规则` : t`新建标题规则`}</DialogTitle>
        </DialogHeader>
        <DialogBody className="grid gap-x-6 gap-y-5 md:grid-cols-[minmax(0,1fr)_16.5rem]">
          <div className="flex min-w-0 flex-col gap-4">
            <Field label={t`显示为`}>
              <Input ref={templateRef} autoFocus={!rule} className="font-mono" maxLength={TITLE_RULE_TEMPLATE_MAX} value={draft.template} placeholder={EXAMPLE_TEMPLATE} onChange={(event) => set({ template: event.target.value })} />
            </Field>
            <div className="-mt-2 flex flex-wrap gap-1.5">
              {TOKENS.map((token) => <Button key={token} size="xs" variant="secondary" onClick={() => insert(token)}><IconPlus />{tokenLabels[token]}</Button>)}
            </div>
            <div className="flex flex-col gap-2 edge-t pt-4">
              <span className="text-sm font-medium text-fg">{complete ? t`匹配 ${preview.count} 个会话` : <Trans>预览</Trans>}</span>
              {preview.examples.length > 0 && <ul className="flex flex-col gap-2">
                {preview.examples.map((example) => <li key={example.id} className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-sm text-fg">{example.after}</span>
                  {example.after !== example.before && <span className="truncate text-xs text-fg-3">{example.before}</span>}
                </li>)}
              </ul>}
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-5 max-md:edge-t max-md:pt-5 md:edge-l md:pl-6">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-fg"><Trans>目录</Trans></span>
                {pickable.length > 0 && <DropdownMenu>
                  <DropdownMenuTrigger asChild><Button size="icon-xs" variant="quiet" aria-label={t`添加项目目录`}><IconFolderPlus /></Button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="max-h-[min(60dvh,360px)] overflow-y-auto">
                    {pickable.map((project) => <DropdownMenuItem key={project.id} onSelect={() => addDirectory(project.cwd)}>
                      <span className="flex min-w-0 flex-col"><span className="truncate">{project.name}</span><span className="truncate text-xs text-fg-3">{project.cwd}</span></span>
                    </DropdownMenuItem>)}
                  </DropdownMenuContent>
                </DropdownMenu>}
              </div>
              <Textarea aria-label={t`目录`} rows={3} className="resize-none font-mono" value={draft.directories} placeholder="~/work" onChange={(event) => set({ directories: event.target.value })} />
            </div>

            {backends.length > 0 && <CheckList label="Agent" options={backends.map((item) => ({ value: item.backendId as string, label: item.label, covers: [item.backendId as string] }))} selected={draft.agents} onChange={(values, on) => set({ agents: toggle(draft.agents, values, on) })} />}
            <CheckList label={t`来源`} options={ORIGIN_CHOICES.map((item) => ({ value: item.value, label: originLabels[item.value], covers: item.covers }))} selected={draft.origins} onChange={(values, on) => set({ origins: toggle(draft.origins, values, on) })} />
            <Field label={t({ message: '标签', context: 'session-tags' })}>
              <Input value={draft.tags} placeholder={t`多个标签用逗号分隔`} onChange={(event) => set({ tags: event.target.value })} />
            </Field>
            <div className="flex flex-col gap-2 edge-t pt-5">
              <span className="text-sm font-medium text-fg"><Trans>适用于</Trans></span>
              <Segmented<Draft['scope']> className="w-full [&>[role=radio]]:flex-1" value={draft.scope} onChange={(scope) => set({ scope })} ariaLabel={t`适用于`} options={[{ value: 'auto', label: t`自动标题` }, { value: 'all', label: t`全部标题` }]} />
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={close}><Trans context="tasks-cancel-action">取消</Trans></Button>
          <Button variant="primary" disabled={!complete} busy={busy} onClick={() => void onSave(candidate)}><Trans>保存</Trans></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Choices a rule matches any of; none checked means the condition is not used. */
function CheckList<T extends string>({ label, options, selected, onChange }: {
  label: string;
  options: Array<{ value: T; label: string; covers: T[] }>;
  selected: T[];
  onChange: (values: T[], on: boolean) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-sm font-medium text-fg">{label}</legend>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        {options.map((option) => (
          <label key={option.value} className="flex min-h-8 min-w-0 items-center gap-2 text-sm text-fg-2 max-md:min-h-11">
            <Checkbox checked={option.covers.some((value) => selected.includes(value))} onCheckedChange={(checked) => onChange(option.covers, checked === true)} />
            <span className="min-w-0 truncate">{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
