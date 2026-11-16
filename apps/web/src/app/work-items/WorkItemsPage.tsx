import { useEffect, useMemo, useState, type DragEvent, type KeyboardEvent } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { NativeBackendCatalogEntry, Session, WorkItem, WorkItemAssignee, WorkItemStatus } from '@contracts';
import type { ProjectRecord } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, Segmented, Select } from '@/components/ui/controls';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { RowActions } from '@/components/ui/list-row';
import { Tip } from '@/components/ui/tooltip';
import { IconInbox, IconList, IconListFilter, IconPlus, IconSquareKanban } from '@/components/icons';
import { relativeTime } from '@/lib/i18n/format';
import { cn, readStored, writeStored } from '@/lib/utils';
import { MOBILE_LAYOUT_QUERY, useMediaQuery } from '@/lib/use-media-query';
import { PageScaffold } from '../PageScaffold';
import { useStores, useWorkItems } from '../state/stores';
import { BOARD_STATUSES, byAttention, byInbox, DONE_SHOWN_MS, LIST_STATUSES, viewWorkItems, type WorkItemView } from './model';
import { AssigneeMark, LiveMark, SectionHeading, StatusIcon, useAssigneeLabel, useStatusLabel, WorkItemNumber } from './parts';
import { NewWorkItemDialog, type NewWorkItemDraft } from './NewWorkItemDialog';
import { WorkItemPanel } from './WorkItemPanel';

type View = 'board' | 'list';
const VIEW_KEY = 'riffet.workItems.view';
const ALL = '';

export interface WorkItemsPageProps {
  projects: ProjectRecord[];
  sessions: Session[];
  backends: NativeBackendCatalogEntry[];
  sidebarCollapsed: boolean;
  onClose: () => void;
  onOpenSidebar: () => void;
  onExpandSidebar: () => void;
  onOpenSession: (sessionId: string) => void;
  /** Opens a conversation for the item with its assignee; false when it could not. */
  onStart: (item: WorkItem) => Promise<boolean>;
}

/** 任务看板 (docs/TASK-BOARD.md §9): the inbox over a board or a list, and one item's panel beside them. */
export function WorkItemsPage({ projects, sessions, backends, sidebarCollapsed, onClose, onOpenSidebar, onExpandSidebar, onOpenSession, onStart }: WorkItemsPageProps) {
  const { t } = useLingui();
  const { workItems } = useStores();
  const items = useWorkItems((state) => state.items);
  const statusLabel = useStatusLabel();
  const assigneeLabel = useAssigneeLabel();
  const [chosenView, setView] = useState<View>(() => readStored(VIEW_KEY) === 'list' ? 'list' : 'board');
  // A phone has no room for columns side by side: it always lists (docs/TASK-BOARD.md §9).
  const mobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const view: View = mobile ? 'list' : chosenView;
  const [projectId, setProjectId] = useState(ALL);
  /** `agent:<backendId>`, `owner`, or `label:<name>`; every one must match. */
  const [filters, setFilters] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedId, setSelectedId] = useState<string | undefined>(() => workItems.takeReveal());
  // A conversation's task mark asked for an item while the board was already showing.
  const revealId = useWorkItems((state) => state.revealId);
  useEffect(() => { if (revealId) setSelectedId(workItems.takeReveal()); }, [revealId, workItems]);
  const [draft, setDraft] = useState<NewWorkItemDraft>();
  const [dropTarget, setDropTarget] = useState<WorkItemStatus>();
  const [starting, setStarting] = useState<string>();

  const liveProjects = useMemo(() => projects.filter((project) => !project.archivedAt && !project.system), [projects]);
  const projectName = (id: string | undefined) => id ? projects.find((project) => project.id === id)?.name : undefined;
  const views = useMemo(() => viewWorkItems(items ?? [], sessions), [items, sessions]);
  const assigneeKey = (assignee: WorkItemAssignee) => assignee.kind === 'owner' ? 'owner' : `agent:${assignee.backendId}`;
  const shown = useMemo(() => views.filter(({ item }) => item.status !== 'cancelled'
    && (projectId === ALL || item.projectId === projectId)
    && [...filters].every((filter) => filter.startsWith('label:') ? item.labels.includes(filter.slice(6)) : assigneeKey(item.assignee) === filter)), [views, projectId, filters]);
  const inbox = useMemo(() => shown.filter((entry) => entry.inInbox).sort(byInbox), [shown]);
  const selected = views.find((entry) => entry.item.id === selectedId);
  const family = useMemo(() => familyOf(views), [views]);

  const changeView = (next: View) => { setView(next); writeStored(VIEW_KEY, next === 'board' ? undefined : next); };
  const toggleFilter = (key: string) => setFilters((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const open = (id: string) => setSelectedId((current) => current === id ? undefined : id);
  const start = async (item: WorkItem) => {
    setStarting(item.id);
    try { return await onStart(item); } finally { setStarting(undefined); }
  };
  /** Moving a card to 进行中 that has never run starts it, as 开始 would. */
  const move = (entry: WorkItemView, status: WorkItemStatus) => {
    if (entry.item.status === status) return;
    if (status === 'doing' && entry.item.status === 'todo' && !entry.sessions.length && entry.item.assignee.kind === 'agent') { void start(entry.item); return; }
    void workItems.update(entry.item.id, { status });
  };

  const assignees = useMemo(() => {
    const seen = new Map<string, WorkItemAssignee>();
    for (const { item } of views) seen.set(assigneeKey(item.assignee), item.assignee);
    return [...seen.entries()];
  }, [views]);
  const labels = useMemo(() => [...new Set(views.flatMap(({ item }) => item.labels))].sort(), [views]);

  const empty = items !== undefined && !views.some(({ item }) => item.status !== 'cancelled');
  const newDraft = (overrides: Partial<NewWorkItemDraft> = {}): NewWorkItemDraft => ({ projectId: projectId || liveProjects[0]?.id, ...overrides });

  return <>
    <PageScaffold
      title={t`任务看板`}
      column="board"
      sidebarCollapsed={sidebarCollapsed}
      onClose={onClose}
      onOpenSidebar={onOpenSidebar}
      onExpandSidebar={onExpandSidebar}
      actions={<Button size="sm" variant="primary" onClick={() => setDraft(newDraft())}><IconPlus /><Trans>新建任务</Trans></Button>}
      pinned={selected && (
        <WorkItemPanel
          key={selected.item.id}
          view={selected}
          views={views}
          projects={liveProjects}
          backends={backends}
          starting={starting === selected.item.id}
          onStart={start}
          onOpenSession={onOpenSession}
          onOpenItem={setSelectedId}
          onNewChild={(parent) => setDraft(newDraft({ parentId: parent.id, projectId: parent.projectId }))}
          onClose={() => setSelectedId(undefined)}
        />
      )}
    >
      {empty ? (
        <EmptyState
          className="mt-16"
          icon={<IconSquareKanban />}
          title={t`还没有任务`}
          description={t`在新会话页发出第一条消息时会建一个任务。`}
        >
          <Button variant="secondary" onClick={() => setDraft(newDraft())}><IconPlus /><Trans>新建任务</Trans></Button>
        </EmptyState>
      ) : <>
        <div className="mb-4 flex min-w-0 items-center gap-1">
          <Select
            appearance="heading"
            label={t`项目`}
            value={projectId}
            onChange={setProjectId}
            options={[{ value: ALL, label: t`全部项目` }, ...liveProjects.map((project) => ({ value: project.id, label: project.name }))]}
          />
          <span className="flex-1" />
          <DropdownMenu>
            <Tip label={t`筛选`}>
              <DropdownMenuTrigger asChild>
                {filters.size
                  ? <Button size="sm" variant="secondary" aria-label={t`筛选`}><IconListFilter /><span className="tabular-nums">{filters.size}</span></Button>
                  : <Button size="icon-sm" variant="quiet" aria-label={t`筛选`}><IconListFilter /></Button>}
              </DropdownMenuTrigger>
            </Tip>
            <DropdownMenuContent align="end" className="w-56" mobileSheet>
              <DropdownMenuLabel><Trans>执行者</Trans></DropdownMenuLabel>
              {assignees.map(([key, assignee]) => (
                <DropdownMenuCheckboxItem key={key} checked={filters.has(key)} onSelect={(event) => event.preventDefault()} onCheckedChange={() => toggleFilter(key)}>
                  <AssigneeMark assignee={assignee} size={16} />{assigneeLabel(assignee)}
                </DropdownMenuCheckboxItem>
              ))}
              {labels.length > 0 && <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel><Trans>标签</Trans></DropdownMenuLabel>
                {labels.map((label) => (
                  <DropdownMenuCheckboxItem key={label} checked={filters.has(`label:${label}`)} onSelect={(event) => event.preventDefault()} onCheckedChange={() => toggleFilter(`label:${label}`)}>{label}</DropdownMenuCheckboxItem>
                ))}
              </>}
            </DropdownMenuContent>
          </DropdownMenu>
          {!mobile && <Segmented
            value={view}
            onChange={changeView}
            ariaLabel={t`视图`}
            options={[{ value: 'board', label: t`看板`, icon: <IconSquareKanban /> }, { value: 'list', label: t`列表`, icon: <IconList /> }]}
          />}
        </div>

        {inbox.length > 0 && (
          <section className="mb-6">
            <SectionHeading icon={<IconInbox />} count={inbox.length}><Trans>收件箱</Trans></SectionHeading>
            <div className="rounded-xl p-1 shadow-[inset_0_0_0_1px_var(--line)]">
              {inbox.map((entry) => (
                <InboxRow key={entry.item.id} entry={entry} selected={entry.item.id === selectedId} onOpen={() => open(entry.item.id)} onDone={() => void workItems.update(entry.item.id, { status: 'done' })} />
              ))}
            </div>
          </section>
        )}

        {view === 'board' ? (
          <div className="-mx-1 overflow-x-auto px-1 pb-1">
            <div className="grid min-w-[912px] grid-cols-4 items-start gap-3">
              {BOARD_STATUSES.map((status) => {
                const column = shown.filter(({ item }) => item.status === status && (status !== 'done' || Date.now() - Date.parse(item.statusAt) < DONE_SHOWN_MS)).sort(byAttention);
                return (
                  <section
                    key={status}
                    aria-label={statusLabel(status)}
                    className={cn('flex min-w-0 flex-col rounded-xl transition-colors duration-[var(--duration-fast)]', dropTarget === status && 'bg-hover')}
                    onDragOver={(event) => { if (!event.dataTransfer.types.includes(DRAG_TYPE)) return; event.preventDefault(); setDropTarget(status); }}
                    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(undefined); }}
                    onDrop={(event) => {
                      setDropTarget(undefined);
                      const entry = views.find(({ item }) => item.id === event.dataTransfer.getData(DRAG_TYPE));
                      if (entry) { event.preventDefault(); move(entry, status); }
                    }}
                  >
                    <div className="flex h-8 items-center gap-2 pl-1.5 pr-1">
                      <StatusIcon status={status} />
                      <span className="text-sm font-medium text-fg">{statusLabel(status)}</span>
                      <span className="text-xs tabular-nums text-fg-4">{column.length}</span>
                      {status === 'todo' && <Tip label={t`新建任务`}><Button size="icon-xs" variant="quiet" className="ml-auto" aria-label={t`新建任务`} onClick={() => setDraft(newDraft())}><IconPlus /></Button></Tip>}
                    </div>
                    <div className="flex min-h-24 flex-col gap-2 pb-4 pt-1">
                      {column.map((entry) => (
                        <WorkItemCard key={entry.item.id} entry={entry} family={family} projectName={projectId === ALL ? projectName(entry.item.projectId) : undefined} selected={entry.item.id === selectedId} onOpen={() => open(entry.item.id)} />
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {LIST_STATUSES.map((status) => {
              const group = shown.filter(({ item }) => item.status === status).sort(byAttention);
              if (!group.length) return null;
              return (
                <section key={status}>
                  <SectionHeading icon={<StatusIcon status={status} />} count={group.length}>{statusLabel(status)}</SectionHeading>
                  <div className="rounded-xl p-1 shadow-[inset_0_0_0_1px_var(--line)]">
                    {group.map((entry) => <ListRow key={entry.item.id} entry={entry} selected={entry.item.id === selectedId} onOpen={() => open(entry.item.id)} />)}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </>}
    </PageScaffold>
    <NewWorkItemDialog
      draft={draft}
      projects={liveProjects}
      backends={backends}
      parents={views.filter(({ item }) => !item.parentId && item.status !== 'done' && item.status !== 'cancelled')}
      onClose={() => setDraft(undefined)}
      onCreated={(item, startNow) => { setSelectedId(item.id); if (startNow) void start(item); }}
    />
  </>;
}

const DRAG_TYPE = 'application/x-riffet-work-item';

/** Subtask progress per parent, and each item's number, for the cards. */
interface Family { children: Map<string, { done: number; total: number }>; numbers: Map<string, number> }
function familyOf(views: readonly WorkItemView[]): Family {
  const children = new Map<string, { done: number; total: number }>();
  const numbers = new Map<string, number>();
  for (const { item } of views) {
    numbers.set(item.id, item.number);
    if (!item.parentId || item.status === 'cancelled') continue;
    const count = children.get(item.parentId) ?? { done: 0, total: 0 };
    count.total += 1;
    if (item.status === 'done') count.done += 1;
    children.set(item.parentId, count);
  }
  return { children, numbers };
}

/** Enter and Space open a row that is a `div` (it holds its own buttons). */
const activate = (open: () => void) => (event: KeyboardEvent<HTMLElement>) => {
  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  open();
};

function WorkItemCard({ entry, projectName, family, selected, onOpen }: { entry: WorkItemView; projectName: string | undefined; family: Family; selected: boolean; onOpen: () => void }) {
  const { t } = useLingui();
  const { item, sessions, title, live } = entry;
  const [dragging, setDragging] = useState(false);
  const children = family.children.get(item.id);
  const parent = item.parentId ? family.numbers.get(item.parentId) : undefined;
  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      aria-pressed={selected}
      data-work-item=""
      onClick={onOpen}
      onKeyDown={activate(onOpen)}
      onDragStart={(event: DragEvent) => { event.dataTransfer.setData(DRAG_TYPE, item.id); event.dataTransfer.effectAllowed = 'move'; setDragging(true); }}
      onDragEnd={() => setDragging(false)}
      className={cn(
        'cursor-default select-none rounded-xl bg-bg px-3 py-2.5 text-left shadow-[inset_0_0_0_1px_var(--line)] outline-none transition-[box-shadow,background-color,opacity] duration-[var(--duration-fast)] hover:shadow-[inset_0_0_0_1px_var(--line-strong)] focus-visible:ring-2 focus-visible:ring-focus',
        selected && 'bg-active shadow-[inset_0_0_0_1px_var(--line-strong)]',
        dragging && 'opacity-40',
      )}
    >
      <div className="flex h-4 min-w-0 items-center gap-1.5">
        <WorkItemNumber number={item.number} />
        {projectName && <span className="min-w-0 truncate text-2xs text-fg-4">{projectName}</span>}
        {parent !== undefined && <span className="shrink-0 text-2xs tabular-nums text-fg-4">· #{parent}</span>}
        <LiveMark live={live} className="ml-auto" />
      </div>
      <p className={cn('mb-2 mt-1.5 line-clamp-2 text-sm', item.status === 'done' ? 'text-fg-2' : 'text-fg')}>{title}</p>
      {item.labels.length > 0 && <div className="-mt-0.5 mb-2 flex flex-wrap gap-1">{item.labels.map((label) => <Badge key={label}>{label}</Badge>)}</div>}
      <div className="flex h-4 items-center gap-2 text-2xs text-fg-3">
        <AssigneeMark assignee={item.assignee} />
        {sessions.length > 1 && <span>{t`${sessions.length} 个会话`}</span>}
        {children && <span className="tabular-nums">{children.done}/{children.total}</span>}
        <span className="ml-auto tabular-nums text-fg-4">{relativeTime(item.updatedAt)}</span>
      </div>
    </div>
  );
}

function InboxRow({ entry, selected, onOpen, onDone }: { entry: WorkItemView; selected: boolean; onOpen: () => void; onDone: () => void }) {
  const { t } = useLingui();
  const statusLabel = useStatusLabel();
  const { item, title, live, liveSession } = entry;
  const stuck = live !== 'waiting' ? item.stuck : undefined;
  const reason = stuck ? stuck.note.split('\n')[0]
    : live === 'failed' ? liveSession?.error?.split('\n')[0] || t`失败`
    : entry.question && !(liveSession && liveSession.id !== entry.question.sessionId) ? entry.question.text.split('\n')[0]
      : live === 'waiting' ? t({ message: '待确认', context: 'workbench-session-pending' }) : statusLabel(item.status);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      data-work-item=""
      onClick={onOpen}
      onKeyDown={activate(onOpen)}
      className={cn('group/row flex min-h-9 w-full min-w-0 cursor-default select-none items-center gap-2 rounded-lg px-2.5 text-sm text-fg outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus no-hover:min-h-11', selected && 'bg-active')}
    >
      <span className="grid size-4 shrink-0 place-items-center">{live ? <LiveMark live={live} words={false} /> : <StatusIcon status={item.status} />}</span>
      <WorkItemNumber number={item.number} className="w-9" />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <span className={cn('min-w-0 max-w-[38%] shrink truncate text-xs', live === 'waiting' || stuck ? 'text-warning' : live === 'failed' ? 'text-danger' : 'text-fg-3')} title={stuck?.note}>{reason}</span>
      <AssigneeMark assignee={item.assignee} />
      <span className="grid shrink-0 items-center justify-items-end">
        <span className={cn('col-start-1 row-start-1 min-w-12 text-right text-2xs tabular-nums text-fg-4', item.status === 'review' && 'transition-opacity group-hover/row:opacity-0 group-focus-within/row:opacity-0 no-hover:opacity-0')}>{relativeTime(item.updatedAt)}</span>
        {item.status === 'review' && (
          <RowActions className="col-start-1 row-start-1">
            <Button size="xs" variant="secondary" onClick={(event) => { event.stopPropagation(); onDone(); }}><Trans>完成</Trans></Button>
          </RowActions>
        )}
      </span>
    </div>
  );
}

function ListRow({ entry, selected, onOpen }: { entry: WorkItemView; selected: boolean; onOpen: () => void }) {
  const { item, title, live } = entry;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      data-work-item=""
      onClick={onOpen}
      onKeyDown={activate(onOpen)}
      className={cn('flex min-h-9 w-full min-w-0 cursor-default select-none items-center gap-2 rounded-lg px-2.5 text-sm outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus no-hover:min-h-11', selected && 'bg-active')}
    >
      <StatusIcon status={item.status} />
      <WorkItemNumber number={item.number} className="w-9" />
      <span className={cn('min-w-0 flex-1 truncate', item.status === 'done' ? 'text-fg-2' : 'text-fg')}>{title}</span>
      {item.labels.map((label) => <Badge key={label} className="max-md:hidden">{label}</Badge>)}
      <LiveMark live={live} />
      <AssigneeMark assignee={item.assignee} />
      <span className="w-12 shrink-0 text-right text-xs tabular-nums text-fg-3">{relativeTime(item.updatedAt)}</span>
    </div>
  );
}
