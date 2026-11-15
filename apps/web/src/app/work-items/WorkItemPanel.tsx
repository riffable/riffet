import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { WORK_ITEM_LIMITS, WORK_ITEM_STATUSES, type NativeBackendCatalogEntry, type WorkItem, type WorkItemCommand, type WorkItemEvent, type WorkItemQuestion, type WorkItemStatus, type WorkItemSubmission } from '@contracts';
import type { ProjectRecord } from '@/lib/api';
import { AgentLogo } from '@/components/AgentLogo';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/controls';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { IconArrowUp, IconCheck, IconChevronDown, IconEllipsis, IconListTodo, IconMinus, IconPlay, IconPlus, IconRotateCcw, IconTrash2, IconX } from '@/components/icons';
import { api } from '@/lib/api';
import { agentMarkStyle, sessionBackend } from '@/lib/backends';
import { confirmDialog, promptDialog } from '@/lib/dialogs';
import { relativeTime } from '@/lib/i18n/format';
import { OverlayScopeContext, useOverlayState } from '@/lib/overlay-navigation';
import { toast } from '@/lib/toast';
import { cn, errorMessage, newId } from '@/lib/utils';
import { useStores } from '../state/stores';
import { Markdown } from '../session/Markdown';
import { liveOf, type WorkItemView } from './model';
import { assigneeChoices, assigneeValue } from './NewWorkItemDialog';
import { AssigneeMark, LiveMark, SectionHeading, StatusIcon, useAssigneeLabel, useLiveLabel, useStatusLabel, WorkItemNumber } from './parts';

/**
 * One item, in a panel floating over the board (surfaces §3.1, 悬浮): inset 16, `shadow-peek`, so the
 * board underneath keeps its layout. Full screen on a phone. Escape closes it before the page.
 */
export function WorkItemPanel({ view, views, projects, backends, starting, onStart, onOpenSession, onOpenItem, onNewChild, onClose }: {
  view: WorkItemView;
  views: WorkItemView[];
  projects: ProjectRecord[];
  backends: NativeBackendCatalogEntry[];
  starting: boolean;
  onStart: (item: WorkItem) => Promise<boolean>;
  onOpenSession: (sessionId: string) => void;
  onOpenItem: (id: string) => void;
  onNewChild: (parent: WorkItem) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const { workItems } = useStores();
  const statusLabel = useStatusLabel();
  const liveLabel = useLiveLabel();
  const assigneeLabel = useAssigneeLabel();
  const overlay = useOverlayState({ open: true, onOpenChange: (next) => { if (!next) onClose(); } });
  const { item, sessions, title, live } = view;
  const update = (patch: Parameters<typeof workItems.update>[1]) => void workItems.update(item.id, patch);
  const children = views.filter((entry) => entry.item.parentId === item.id);
  const parent = item.parentId ? views.find((entry) => entry.item.id === item.parentId) : undefined;
  const project = item.projectId ? projects.find((entry) => entry.id === item.projectId) : undefined;
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { panel.current?.focus({ preventScroll: true }); }, []);
  // A press anywhere else on the page closes it. A card's press is left to the card, which opens
  // that item (or, for this one, closes it). Menus and dialogs are portals and never reach the page.
  const latestClose = useRef(onClose);
  latestClose.current = onClose;
  useEffect(() => {
    const page = panel.current?.parentElement;
    if (!page) return;
    const press = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (event.button !== 0 || !target || panel.current?.contains(target) || target.closest('[data-work-item]')) return;
      latestClose.current();
    };
    page.addEventListener('pointerdown', press);
    return () => page.removeEventListener('pointerdown', press);
  }, []);

  const remove = async () => {
    if (!await confirmDialog({ title: t`删除这个任务？`, description: t`会话会保留，只是不再属于它。删除后无法恢复。`, confirmLabel: t`删除任务`, destructive: true })) return;
    if (await workItems.remove(item.id)) onClose();
  };
  const addLabel = async () => {
    const label = (await promptDialog({ title: t`添加标签`, confirmLabel: t`添加` }))?.trim();
    if (label && !item.labels.includes(label)) update({ labels: [...item.labels, label.slice(0, WORK_ITEM_LIMITS.label)] });
  };
  // The reasons go to the conversation that submitted: it is the one that knows the work.
  const rework = async () => {
    const reason = (await promptDialog({ title: t`返工`, label: t`要改什么`, multiline: true, confirmLabel: t`发送` }))?.trim();
    if (!reason) return;
    try { await api.reworkWorkItem(item.id, { text: reason, commandId: newId() }); }
    catch (error) { toast.error(errorMessage(error, t`无法返工`)); }
  };

  return (
    <OverlayScopeContext.Provider value={overlay.scope}>
      <aside
        ref={panel}
        tabIndex={-1}
        aria-label={t`任务详情`}
        className="absolute inset-y-4 right-4 z-(--z-panel) flex w-[440px] max-w-[calc(100%-32px)] flex-col rounded-xl bg-bg shadow-peek outline-none animate-in fade-in-0 slide-in-from-right-3 duration-[var(--duration-medium)] ease-[var(--ease-decelerate)] max-md:inset-0 max-md:w-auto max-md:max-w-none max-md:rounded-none"
      >
        <header className="flex h-12 shrink-0 items-center gap-2 pl-4 pr-3 edge-b">
          <StatusIcon status={item.status} />
          <WorkItemNumber number={item.number} className="text-xs" />
          {parent && <button type="button" className="min-w-0 truncate text-xs text-fg-3 hover:text-fg" onClick={() => onOpenItem(parent.item.id)}>· {parent.title}</button>}
          <div className="ml-auto flex items-center gap-0.5">
            <DropdownMenu>
              <Tip label={t`更多操作`}><DropdownMenuTrigger asChild><Button size="icon-xs" variant="quiet" aria-label={t`更多操作`}><IconEllipsis /></Button></DropdownMenuTrigger></Tip>
              <DropdownMenuContent align="end">
                {!item.parentId && <DropdownMenuItem onSelect={() => onNewChild(item)}><IconListTodo /><Trans>新建子任务</Trans></DropdownMenuItem>}
                {item.status !== 'cancelled' && <DropdownMenuItem onSelect={() => update({ status: 'cancelled' })}><IconX /><Trans>取消任务</Trans></DropdownMenuItem>}
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="danger" onSelect={() => void remove()}><IconTrash2 /><Trans>删除…</Trans></DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Tip label={t`关闭`} kbd="Esc"><Button size="icon-xs" variant="quiet" aria-label={t`关闭`} onClick={onClose}><IconX /></Button></Tip>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-4">
          <EditableTitle key={`title:${item.id}:${title}`} value={title} onSave={(next) => update({ title: next })} />

          <dl className="mb-4 grid grid-cols-[64px_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5 text-sm">
            <dt className="text-fg-3"><Trans>状态</Trans></dt>
            <dd className="flex min-h-7 items-center gap-2">
              <ValueMenu label={<><StatusIcon status={item.status} />{statusLabel(item.status)}</>}>
                <DropdownMenuRadioGroup value={item.status} onValueChange={(value) => update({ status: value as WorkItemStatus })}>
                  {WORK_ITEM_STATUSES.map((status) => <DropdownMenuRadioItem key={status} value={status}><StatusIcon status={status} />{statusLabel(status)}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </ValueMenu>
              {live && <span className="inline-flex items-center gap-1.5 text-xs text-fg-3"><LiveMark live={live} words={false} />{liveLabel(live)}</span>}
            </dd>
            <dt className="text-fg-3"><Trans>执行者</Trans></dt>
            <dd className="flex min-h-7 items-center">
              <ValueMenu label={<><AssigneeMark assignee={item.assignee} />{assigneeLabel(item.assignee)}</>}>
                <DropdownMenuRadioGroup value={assigneeValue(item.assignee)} onValueChange={(value) => { const next = assigneeChoices(backends).find((choice) => assigneeValue(choice) === value); if (next) update({ assignee: next }); }}>
                  {assigneeChoices(backends).map((choice) => <DropdownMenuRadioItem key={assigneeValue(choice)} value={assigneeValue(choice)}><AssigneeMark assignee={choice} size={16} />{assigneeLabel(choice)}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </ValueMenu>
            </dd>
            <dt className="text-fg-3"><Trans>项目</Trans></dt>
            <dd className="flex min-h-7 items-center">
              <ValueMenu label={project?.name ?? <span className="text-fg-3"><Trans>无项目</Trans></span>}>
                <DropdownMenuRadioGroup value={item.projectId ?? ''} onValueChange={(value) => update({ projectId: value || null })}>
                  {projects.map((entry) => <DropdownMenuRadioItem key={entry.id} value={entry.id}>{entry.name}</DropdownMenuRadioItem>)}
                  <DropdownMenuRadioItem value=""><Trans>无项目</Trans></DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </ValueMenu>
            </dd>
            <dt className="text-fg-3"><Trans>标签</Trans></dt>
            <dd className="flex min-h-7 flex-wrap items-center gap-1">
              {item.labels.map((label) => (
                <Badge key={label} className="group/badge pr-0.5">
                  {label}
                  <button type="button" aria-label={t`移除标签 ${label}`} className="grid size-4 place-items-center rounded text-fg-4 hover:bg-hover hover:text-fg" onClick={() => update({ labels: item.labels.filter((entry) => entry !== label) })}><IconX className="size-3" /></button>
                </Badge>
              ))}
              <Tip label={t`添加标签`}><Button size="icon-xs" variant="quiet" aria-label={t`添加标签`} onClick={() => void addLabel()}><IconPlus /></Button></Tip>
            </dd>
          </dl>

          {item.questions?.map((question) => <Question key={question.id} item={item} question={question} onOpenSession={onOpenSession} />)}

          <Description key={`description:${item.id}:${item.description ?? ''}`} value={item.description ?? ''} onSave={(next) => update({ description: next || null })} />

          <Criteria key={`criteria:${item.id}:${(item.criteria ?? []).join('\n')}`} criteria={item.criteria ?? []} submission={item.status === 'review' || item.status === 'done' ? item.submission : undefined} onSave={(next) => update({ criteria: next })} />

          <Actions item={item} hasSessions={sessions.length > 0} starting={starting} onStart={() => void onStart(item)} onDone={() => update({ status: 'done' })} onRework={() => void rework()} />

          {item.submission && <Delivery submission={item.submission} />}

          {sessions.length > 0 && (
            <section className="mb-5">
              <SectionHeading count={sessions.length}><Trans>会话</Trans></SectionHeading>
              {sessions.map((session) => {
                const own = liveOf([session]).live;
                return (
                  <button key={session.id} type="button" onClick={() => onOpenSession(session.id)} className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-lg px-2.5 text-left text-sm text-fg outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus no-hover:min-h-11">
                    <AgentLogo backend={sessionBackend(session)} size={14} style={agentMarkStyle(sessionBackend(session))} />
                    <span className="min-w-0 flex-1 truncate">{session.title}</span>
                    {own === 'waiting'
                      ? <span className="shrink-0 text-2xs text-warning">{liveLabel('waiting')}</span>
                      : <><LiveMark live={own} words={false} /><span className="shrink-0 text-2xs tabular-nums text-fg-4">{relativeTime(session.lastActivityAt ?? session.createdAt)}</span></>}
                  </button>
                );
              })}
            </section>
          )}

          {children.length > 0 && (
            <section className="mb-5">
              <SectionHeading count={`${children.filter((entry) => entry.item.status === 'done').length}/${children.length}`}><Trans>子任务</Trans></SectionHeading>
              {children.map((entry) => (
                <button key={entry.item.id} type="button" onClick={() => onOpenItem(entry.item.id)} className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-lg px-2.5 text-left text-sm outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus no-hover:min-h-11">
                  <StatusIcon status={entry.item.status} />
                  <WorkItemNumber number={entry.item.number} />
                  <span className={cn('min-w-0 flex-1 truncate', entry.item.status === 'done' ? 'text-fg-2' : 'text-fg')}>{entry.title}</span>
                  <LiveMark live={entry.live} />
                  <AssigneeMark assignee={entry.item.assignee} />
                </button>
              ))}
            </section>
          )}

          <Activity item={item} views={views} />
        </div>
      </aside>
    </OverlayScopeContext.Provider>
  );
}

/** A value shown as a borderless pill that opens the app's menu (riffet-style §6: selections in panels are pills). */
function ValueMenu({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="-ml-2 inline-flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-2 text-sm text-fg outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus data-[state=open]:bg-hover">
          {label}<IconChevronDown className="size-3 shrink-0 text-fg-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

function EditableTitle({ value, onSave }: { value: string; onSave: (value: string) => void }) {
  const { t } = useLingui();
  const [text, setText] = useState(value);
  const save = () => { const next = text.trim(); if (next && next !== value) onSave(next); else setText(value); };
  return (
    <textarea
      aria-label={t`标题`}
      rows={1}
      value={text}
      maxLength={WORK_ITEM_LIMITS.title}
      onChange={(event) => setText(event.target.value.replace(/\n/g, ' '))}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
        if (event.key === 'Escape') { event.stopPropagation(); setText(value); requestAnimationFrame(() => event.currentTarget?.blur()); }
      }}
      className="mb-3 -ml-1 field-sizing-content w-full resize-none rounded-lg bg-transparent px-1 py-0.5 text-lg font-medium text-fg outline-none transition-colors hover:bg-hover focus:bg-subtle"
    />
  );
}

/** Markdown when read, the raw text once clicked; an empty one is a field to type into. */
function Description({ value, onSave }: { value: string; onSave: (value: string) => void }) {
  const { t } = useLingui();
  const [text, setText] = useState(value);
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);
  if (value && !editing) {
    return (
      <div
        role="button"
        tabIndex={0}
        aria-label={t`编辑描述`}
        // A link, or text being selected, is not a request to edit.
        onClick={(event) => { if (!(event.target as Element).closest('a') && !window.getSelection()?.toString()) setEditing(true); }}
        onKeyDown={(event) => { if (event.target === event.currentTarget && event.key === 'Enter') { event.preventDefault(); setEditing(true); } }}
        className="mb-4 -ml-1 cursor-text rounded-lg px-1 py-1 outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
      >
        <Markdown className="min-w-0 text-base text-fg select-text" text={value} />
      </div>
    );
  }
  return (
    <textarea
      aria-label={t`描述`}
      placeholder={t`添加描述…`}
      value={text}
      autoFocus={editing}
      maxLength={WORK_ITEM_LIMITS.description}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        setEditing(false);
        if (cancelled.current) { cancelled.current = false; setText(value); return; }
        if (text.trim() !== value.trim()) onSave(text.trim());
      }}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); cancelled.current = true; event.currentTarget.blur(); } }}
      className="mb-4 -ml-1 field-sizing-content min-h-9 w-full resize-none rounded-lg bg-transparent px-1 py-1 text-base text-fg outline-none transition-colors placeholder:text-fg-4 hover:bg-hover focus:bg-subtle"
    />
  );
}

/** A question a conversation asked (`task_ask`): its options as buttons, or an answer in the owner's words. */
function Question({ item, question, onOpenSession }: { item: WorkItem; question: WorkItemQuestion; onOpenSession: (sessionId: string) => void }) {
  const { t } = useLingui();
  const [text, setText] = useState('');
  const [sending, setSending] = useState<string>();
  const send = async (answer: string) => {
    const body = answer.trim();
    if (!body || sending) return;
    setSending(body);
    try { await api.answerWorkItem(item.id, question.id, { text: body, commandId: question.id }); setText(''); }
    catch (error) { toast.error(errorMessage(error, t`无法发送回答`)); }
    finally { setSending(undefined); }
  };
  return (
    <section className="mb-4 rounded-xl bg-subtle p-3 shadow-[inset_0_0_0_1px_var(--line)]">
      <div className="mb-2 flex items-center gap-2 text-xs text-fg-3">
        <LiveMark live="waiting" words={false} />
        <button type="button" className="min-w-0 truncate hover:text-fg" onClick={() => onOpenSession(question.sessionId)}>{t({ message: '提问', context: 'work-item-question' })}</button>
        <span className="ml-auto shrink-0 tabular-nums text-fg-4">{relativeTime(question.at)}</span>
      </div>
      <p className="mb-3 whitespace-pre-wrap break-words text-sm text-fg select-text">{question.text}</p>
      {question.options && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {question.options.map((option) => <Button key={option} size="sm" variant="secondary" busy={sending === option} onClick={() => void send(option)}>{option}</Button>)}
        </div>
      )}
      <div className="flex items-end gap-2">
        <textarea
          aria-label={t`回答`}
          placeholder={question.options ? t`或者写下回答…` : t`写下回答…`}
          value={text}
          maxLength={WORK_ITEM_LIMITS.comment}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void send(text); } }}
          className="block field-sizing-content max-h-30 min-h-9 min-w-0 flex-1 resize-none rounded-lg bg-bg px-2.5 py-2 text-sm text-fg outline-none shadow-[inset_0_0_0_1px_var(--line)] placeholder:text-fg-4 focus:shadow-[inset_0_0_0_1px_var(--line-strong)]"
        />
        <Button size="icon-sm" variant="primary" className="rounded-full" aria-label={t`发送回答`} disabled={!text.trim()} busy={Boolean(sending) && sending === text.trim()} onClick={() => void send(text)}><IconArrowUp /></Button>
      </div>
    </section>
  );
}

/**
 * What done means, one line each, edited in place. Under review each line carries the agent's word
 * on it from the latest submission: met, not met, or nothing said.
 */
function Criteria({ criteria, submission, onSave }: { criteria: string[]; submission: WorkItemSubmission | undefined; onSave: (criteria: string[]) => void }) {
  const { t } = useLingui();
  const [lines, setLines] = useState(criteria);
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const commit = (next: string[]) => {
    const kept = next.map((line) => line.trim()).filter(Boolean);
    setLines(kept);
    if (kept.join('\n') !== criteria.join('\n')) onSave(kept);
  };
  const said = (text: string) => submission?.criteria.find((entry) => entry.text === text);
  const add = () => { setLines([...lines, '']); requestAnimationFrame(() => refs.current[lines.length]?.focus()); };
  return (
    <section className="mb-5">
      <SectionHeading count={criteria.length || undefined}><Trans>验收标准</Trans></SectionHeading>
      {lines.map((line, index) => {
        const word = said(line);
        return (
          <div key={index} className="group/criterion flex items-start gap-2 rounded-lg px-1 py-0.5">
            <span className="mt-2 grid size-4 shrink-0 place-items-center">
              {word?.met === true ? <IconCheck aria-label={t`已达成`} className="size-3.5 text-fg-2" /> : word?.met === false ? <IconX aria-label={t`未达成`} className="size-3.5 text-danger" /> : <span className="size-1 rounded-full bg-fg-4" />}
            </span>
            <div className="min-w-0 flex-1">
              <input
                ref={(element) => { refs.current[index] = element; }}
                aria-label={t`验收标准 ${index + 1}`}
                value={line}
                maxLength={WORK_ITEM_LIMITS.criterion}
                onChange={(event) => setLines(lines.map((entry, at) => at === index ? event.target.value : entry))}
                onBlur={() => commit(lines)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === 'Enter') { event.preventDefault(); if (lines.length < WORK_ITEM_LIMITS.criteria) add(); else event.currentTarget.blur(); }
                  if (event.key === 'Escape') { event.stopPropagation(); setLines(criteria); event.currentTarget.blur(); }
                }}
                className="h-8 w-full rounded-md bg-transparent px-1 text-sm text-fg outline-none transition-colors hover:bg-hover focus:bg-subtle"
              />
              {word?.note && <p className="px-1 pb-1 text-xs whitespace-pre-wrap break-words text-fg-3 select-text">{word.note}</p>}
            </div>
          </div>
        );
      })}
      {lines.length < WORK_ITEM_LIMITS.criteria && (
        <button type="button" onClick={add} className="flex h-8 items-center gap-2 rounded-lg px-1 text-sm text-fg-4 outline-none transition-colors hover:bg-hover hover:text-fg-2 focus-visible:ring-2 focus-visible:ring-focus">
          <IconPlus className="size-4" /><Trans>添加验收标准</Trans>
        </button>
      )}
    </section>
  );
}

const SHOWN_FILES = 8;

/** The latest submission: the agent's account, and what the server saw the conversations run and change. */
function Delivery({ submission }: { submission: WorkItemSubmission }) {
  const { t } = useLingui();
  const [allFiles, setAllFiles] = useState(false);
  const { files, commands } = submission.evidence;
  const shown = allFiles ? files : files.slice(0, SHOWN_FILES);
  return (
    <section className="mb-5">
      <SectionHeading count={relativeTime(submission.at)}><Trans>交付</Trans></SectionHeading>
      {/* Agents write their account in Markdown, as they write their answers. */}
      <Markdown className="mb-3 min-w-0 px-1 text-sm text-fg select-text" text={submission.summary} />
      {commands.length > 0 && (
        <div className="mb-3">
          <h3 className="px-1 pb-1 text-xs text-fg-3"><Trans>运行过的命令</Trans></h3>
          {commands.map((command) => <CommandLine key={`${command.sessionId}:${command.command}`} command={command} />)}
        </div>
      )}
      {files.length > 0 && (
        <div>
          <h3 className="px-1 pb-1 text-xs text-fg-3"><Trans>改动的文件</Trans> <span className="tabular-nums text-fg-4">{files.length}</span></h3>
          {shown.map((file) => <div key={file} className="truncate px-1 py-0.5 text-left font-mono text-xs text-fg-2 select-text" dir="rtl"><bdi>{file}</bdi></div>)}
          {files.length > SHOWN_FILES && !allFiles && (
            <button type="button" className="px-1 py-0.5 text-xs text-fg-3 hover:text-fg" onClick={() => setAllFiles(true)}>{t`还有 ${files.length - SHOWN_FILES} 个`}</button>
          )}
        </div>
      )}
    </section>
  );
}

function CommandLine({ command }: { command: WorkItemCommand }) {
  const { t } = useLingui();
  const failed = command.result === 'failed';
  return (
    <div className="flex items-start gap-2 px-1 py-0.5">
      <span className="mt-0.5 grid size-4 shrink-0 place-items-center">
        {command.result === 'ok' ? <IconCheck aria-label={t`成功`} className="size-3.5 text-fg-3" /> : failed ? <IconX aria-label={t`失败`} className="size-3.5 text-danger" /> : <IconMinus aria-label={t`结果未知`} className="size-3.5 text-fg-4" />}
      </span>
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg-2 select-text">{command.command}</code>
      {failed && command.exitCode !== undefined && <span className="shrink-0 text-2xs tabular-nums text-danger">{t`退出码 ${command.exitCode}`}</span>}
    </div>
  );
}

/** 开始 / 完成 / 返工 / 再开一个会话 (docs/TASK-BOARD.md §9). Only the owner marks an item done. */
function Actions({ item, hasSessions, starting, onStart, onDone, onRework }: { item: WorkItem; hasSessions: boolean; starting: boolean; onStart: () => void; onDone: () => void; onRework: () => void }) {
  const agent = item.assignee.kind === 'agent';
  const startable = agent && (item.status === 'todo' || item.status === 'doing' || item.status === 'review');
  if (!startable && item.status !== 'review') return null;
  return (
    <div className="mb-5 flex flex-wrap items-center gap-2">
      {item.status === 'todo' && agent && <Button size="sm" variant="primary" busy={starting} onClick={onStart}><IconPlay /><Trans>开始</Trans></Button>}
      {item.status === 'review' && <>
        <Button size="sm" variant="primary" onClick={onDone}><IconCheck /><Trans>完成</Trans></Button>
        {hasSessions && <Button size="sm" variant="secondary" onClick={onRework}><IconRotateCcw /><Trans>返工</Trans></Button>}
      </>}
      {(item.status === 'doing' || item.status === 'review') && agent && <Button size="sm" variant="ghost" busy={starting} onClick={onStart}><IconPlus /><Trans>再开一个会话</Trans></Button>}
    </div>
  );
}

/** Status changes, conversations attached and comments, oldest first, with the comment box under them. */
function Activity({ item, views }: { item: WorkItem; views: WorkItemView[] }) {
  const { t } = useLingui();
  const statusLabel = useStatusLabel();
  const [events, setEvents] = useState<WorkItemEvent[]>();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api.workItemEvents(item.id, controller.signal).then(setEvents, () => {});
    return () => controller.abort();
  }, [item.id, item.updatedAt]);
  const sessionTitle = (id: string) => views.flatMap((entry) => entry.sessions).find((session) => session.id === id)?.title;

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const event = await api.commentWorkItem(item.id, { id: newId(), text: body });
      setEvents((current) => [...(current ?? []), event]);
      setText('');
    } catch (error) { toast.error(errorMessage(error, t`无法发表评论`)); }
    finally { setSending(false); }
  };

  const line = (event: WorkItemEvent): ReactNode => {
    switch (event.kind) {
      case 'created': return t`创建`;
      case 'status': return t`${statusLabel(event.from)} → ${statusLabel(event.to)}`;
      case 'session': return event.detached ? t`移出会话「${sessionTitle(event.sessionId) ?? '…'}」` : t`加入会话「${sessionTitle(event.sessionId) ?? '…'}」`;
      case 'comment': return <span className="whitespace-pre-wrap break-words text-fg select-text">{event.text}</span>;
      case 'question': return <span className="whitespace-pre-wrap break-words select-text">{t`提问：${event.question.text}`}</span>;
      case 'answer': return <span className="whitespace-pre-wrap break-words select-text">{t`回答：${event.text}`}</span>;
      case 'submit': return t`交付`;
      case 'rework': return <span className="whitespace-pre-wrap break-words select-text">{t`返工：${event.text}`}</span>;
    }
  };

  return (
    <section>
      <SectionHeading><Trans>活动</Trans></SectionHeading>
      {/* A local read answers in milliseconds; a spinner would only flash. */}
      {events?.map((event) => (
        <div key={event.id} className="flex gap-2 py-1 text-sm text-fg-2">
          <span className="min-w-0 flex-1">{line(event)}</span>
          <span className="shrink-0 pt-px text-xs tabular-nums text-fg-4">{relativeTime(event.at)}</span>
        </div>
      ))}
      <div className="mt-3 rounded-xl bg-subtle shadow-[inset_0_0_0_1px_var(--line)]">
        <textarea
          aria-label={t`评论`}
          placeholder={t`写评论…`}
          value={text}
          maxLength={WORK_ITEM_LIMITS.comment}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}
          className="block field-sizing-content max-h-30 min-h-13 w-full resize-none bg-transparent px-3 pb-1 pt-2.5 text-base text-fg outline-none placeholder:text-fg-4"
        />
        <div className="flex justify-end px-2 pb-2">
          <Button size="icon-sm" variant="primary" className="rounded-full" aria-label={t`发表评论`} disabled={!text.trim()} busy={sending} onClick={() => void send()}><IconArrowUp /></Button>
        </div>
      </div>
    </section>
  );
}
