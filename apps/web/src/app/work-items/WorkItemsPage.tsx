import { useEffect, useMemo, useState, type DragEvent, type KeyboardEvent } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { NativeBackendCatalogEntry, Session, WorkItem, WorkItemAssignee, WorkItemStatus } from '@contracts';
import type { ProjectRecord } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { Badge, EmptyState, Segmented, Select, Spinner } from '@/components/ui/controls';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { RowActions, rowConceal } from '@/components/ui/list-row';
import { SearchField } from '@/components/ui/search-field';
import { Tip } from '@/components/ui/tooltip';
import { IconCheck, IconChevronDown, IconChevronRight, IconEye, IconInbox, IconList, IconListFilter, IconMessageSquareText, IconPlay, IconPlus, IconSlash, IconSquareKanban } from '@/components/icons';
import { formatDateTime, relativeTime } from '@/lib/i18n/format';
import { MOBILE_LAYOUT_QUERY, useMediaQuery } from '@/lib/use-media-query';
import { cn, readStored, writeStored } from '@/lib/utils';
import { PageScaffold } from '../PageScaffold';
import { useStores, useWorkItems } from '../state/stores';
import { BOARD_STATUSES, byAttention, byInbox, bySettled, DONE_SHOWN_MS, LIST_STATUSES, viewWorkItems, type WorkItemView } from './model';
import { AssigneeMark, LiveMark, SectionHeading, StatusIcon, useAssigneeLabel, useStatusLabel, WorkItemNumber } from './parts';
import { NewWorkItemDialog, type NewWorkItemDraft } from './NewWorkItemDialog';
import { WorkItemPanel } from './WorkItemPanel';

type View = 'board' | 'list';
type DropZone = WorkItemStatus | 'watching';
const VIEW_KEY = 'riffet.workItems.view';
const PROJECT_KEY = 'riffet.workItems.project';
const FILTERS_KEY = 'riffet.workItems.filters';
const INBOX_OPEN_KEY = 'riffet.workItems.inboxOpen';
const WATCHING_OPEN_KEY = 'riffet.workItems.watchingOpen';
const ALL = '';
const DONE_CARD_LIMIT = 10;

function readFilters(): Set<string> {
  const raw = readStored(FILTERS_KEY);
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((entry): entry is string => typeof entry === 'string')) : new Set();
  } catch { return new Set(); }
}

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

/** 任务看板 (docs/TASK-BOARD.md §9): the inbox and watching strip over a board or a list, and one item's panel beside them. */
export function WorkItemsPage({ projects, sessions, backends, sidebarCollapsed, onClose, onOpenSidebar, onExpandSidebar, onOpenSession, onStart }: WorkItemsPageProps) {
  const { t } = useLingui();
  const { workItems } = useStores();
  const items = useWorkItems((state) => state.items);
  useEffect(() => { workItems.ensureLoaded(); }, [workItems]);
  const statusLabel = useStatusLabel();
  const assigneeLabel = useAssigneeLabel();
  const [chosenView, setView] = useState<View>(() => readStored(VIEW_KEY) === 'list' ? 'list' : 'board');
  // A phone has no room for columns side by side: it always lists (docs/TASK-BOARD.md §9).
  const mobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const view: View = mobile ? 'list' : chosenView;
  const [projectId, setProjectId] = useState(() => readStored(PROJECT_KEY) ?? ALL);
  /** `agent:<backendId>`, `owner`, or `label:<name>`; every one must match. */
  const [filters, setFilters] = useState<ReadonlySet<string>>(readFilters);
  const [query, setQuery] = useState('');
  const [inboxOpen, setInboxOpen] = useState(() => readStored(INBOX_OPEN_KEY) !== '0');
  const [watchingOpen, setWatchingOpen] = useState(() => readStored(WATCHING_OPEN_KEY) !== '0');
  const [doneExpanded, setDoneExpanded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>(() => workItems.takeReveal());
  // A conversation's task mark asked for an item while the board was already showing.
  const revealId = useWorkItems((state) => state.revealId);
  useEffect(() => { if (revealId) setSelectedId(workItems.takeReveal()); }, [revealId, workItems]);
  const [draft, setDraft] = useState<NewWorkItemDraft>();
  const [dropTarget, setDropTarget] = useState<DropZone>();
  const [draggingId, setDraggingId] = useState<string>();
  const [starting, setStarting] = useState<string>();

  const liveProjects = useMemo(() => projects.filter((project) => !project.archivedAt && !project.system), [projects]);
  // Reset saved project filter if that project was archived or removed.
  const activeProjectId = projectId !== ALL && !liveProjects.some((project) => project.id === projectId) ? ALL : projectId;
  const projectName = (id: string | undefined) => id ? projects.find((project) => project.id === id)?.name : undefined;
  const views = useMemo(() => viewWorkItems(items ?? [], sessions), [items, sessions]);
  const assigneeKey = (assignee: WorkItemAssignee) => assignee.kind === 'owner' ? 'owner' : `agent:${assignee.backendId}`;
  const needle = query.trim().toLowerCase();

  const shown = useMemo(() => views.filter((entry) => {
    const { item } = entry;
    if (activeProjectId !== ALL && item.projectId !== activeProjectId) return false;
    if (![...filters].every((filter) => filter.startsWith('label:') ? item.labels.includes(filter.slice(6)) : assigneeKey(item.assignee) === filter)) return false;
    if (!needle) return true;
    const project = projectName(item.projectId)?.toLowerCase() ?? '';
    return `#${item.number}`.includes(needle)
      || entry.title.toLowerCase().includes(needle)
      || (item.description?.toLowerCase().includes(needle) ?? false)
      || (item.watch?.note?.toLowerCase().includes(needle) ?? false)
      || project.includes(needle)
      || item.labels.some((label) => label.toLowerCase().includes(needle));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [views, activeProjectId, filters, needle, projects]);

  const inbox = useMemo(() => shown.filter((entry) => entry.inInbox).sort(byInbox), [shown]);
  const watching = useMemo(() => shown.filter((entry) => entry.item.status === 'watching').sort(byAttention), [shown]);
  const selected = views.find((entry) => entry.item.id === selectedId);
  const family = useMemo(() => familyOf(views), [views]);

  const changeView = (next: View) => { setView(next); writeStored(VIEW_KEY, next === 'board' ? undefined : next); };
  const changeProject = (next: string) => { setProjectId(next); writeStored(PROJECT_KEY, next || undefined); };
  const toggleFilter = (key: string) => setFilters((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    writeStored(FILTERS_KEY, next.size ? JSON.stringify([...next]) : undefined);
    return next;
  });
  const clearFilters = () => { setFilters(new Set()); writeStored(FILTERS_KEY, undefined); };
  const toggleInbox = () => setInboxOpen((open) => { const next = !open; writeStored(INBOX_OPEN_KEY, next ? undefined : '0'); return next; });
  const toggleWatching = () => setWatchingOpen((open) => { const next = !open; writeStored(WATCHING_OPEN_KEY, next ? undefined : '0'); return next; });

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

  const empty = items !== undefined && views.length === 0;
  const newDraft = (overrides: Partial<NewWorkItemDraft> = {}): NewWorkItemDraft => ({ projectId: activeProjectId || liveProjects[0]?.id, ...overrides });

  return <>
    <PageScaffold
      title={t`任务看板`}
      column="board"
      sidebarCollapsed={sidebarCollapsed}
      onClose={onClose}
      onOpenSidebar={onOpenSidebar}
      onExpandSidebar={onExpandSidebar}
      // A phone's top bar takes icons only (mobile.md §10.2), as 自动化's 新建 does.
      actions={mobile
        ? <Button size="icon-sm" variant="quiet" className="size-11" aria-label={t`新建任务`} onClick={() => setDraft(newDraft())}><IconPlus /></Button>
        : <Button size="sm" variant="primary" onClick={() => setDraft(newDraft())}><IconPlus /><Trans>新建任务</Trans></Button>}
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
        >
          <Button variant="secondary" onClick={() => setDraft(newDraft())}><IconPlus /><Trans>新建任务</Trans></Button>
        </EmptyState>
      ) : <>
        <div className="mb-4 flex min-w-0 flex-wrap items-center gap-2">
          <Select
            appearance="heading"
            label={t`项目`}
            value={activeProjectId}
            onChange={changeProject}
            options={[{ value: ALL, label: t`全部项目` }, ...liveProjects.map((project) => ({ value: project.id, label: project.name }))]}
          />
          {view === 'board' && watching.length === 0 && draggingId ? (
            <div
              onDragOver={(event) => { if (!event.dataTransfer.types.includes(DRAG_TYPE)) return; event.preventDefault(); setDropTarget('watching'); }}
              onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(undefined); }}
              onDrop={(event) => {
                setDropTarget(undefined);
                const entry = views.find(({ item }) => item.id === event.dataTransfer.getData(DRAG_TYPE));
                if (entry) { event.preventDefault(); move(entry, 'watching'); }
              }}
              className={cn(
                'mx-2 flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-dashed px-3 text-xs transition-colors max-md:hidden',
                dropTarget === 'watching' ? 'border-line-strong bg-hover text-fg' : 'border-line text-fg-3',
              )}
            >
              <IconEye className="size-3.5" />
              <Trans>拖到这里转入观测中</Trans>
            </div>
          ) : (
            <span className="flex-1 max-md:hidden" />
          )}
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder={t`搜索任务、#编号…`}
            aria-label={t`搜索任务`}
            className="w-56 max-md:order-last max-md:w-full"
          />
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
              {filters.size > 0 && <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={clearFilters}><Trans>清除筛选</Trans></DropdownMenuItem>
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
          <section className="mb-5">
            <CollapsibleHeader open={inboxOpen} onToggle={toggleInbox}>
              <SectionHeading icon={<IconInbox />} count={inbox.length}><Trans>收件箱</Trans></SectionHeading>
            </CollapsibleHeader>
            <Collapse open={inboxOpen} keep>
              <div className="rounded-xl p-1 shadow-[inset_0_0_0_1px_var(--line)]">
                {inbox.map((entry) => (
                  <InboxRow
                    key={entry.item.id}
                    entry={entry}
                    projectName={activeProjectId === ALL ? projectName(entry.item.projectId) : undefined}
                    selected={entry.item.id === selectedId}
                    onOpen={() => open(entry.item.id)}
                    onOpenSession={onOpenSession}
                    onDone={() => void workItems.update(entry.item.id, { status: 'done' })}
                    onResume={() => void workItems.update(entry.item.id, { status: 'doing' })}
                    onDismiss={() => void workItems.update(entry.item.id, { status: 'cancelled' })}
                  />
                ))}
              </div>
            </Collapse>
          </section>
        )}

        {view === 'board' && watching.length > 0 && (
          <section
            aria-label={statusLabel('watching')}
            className={cn('mb-5 rounded-xl transition-colors duration-[var(--duration-fast)]', dropTarget === 'watching' && 'bg-hover')}
            onDragOver={(event) => { if (!event.dataTransfer.types.includes(DRAG_TYPE)) return; event.preventDefault(); setDropTarget('watching'); }}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(undefined); }}
            onDrop={(event) => {
              setDropTarget(undefined);
              const entry = views.find(({ item }) => item.id === event.dataTransfer.getData(DRAG_TYPE));
              if (entry) { event.preventDefault(); move(entry, 'watching'); }
            }}
          >
            <CollapsibleHeader open={watchingOpen} onToggle={toggleWatching}>
              <SectionHeading icon={<StatusIcon status="watching" />} count={watching.length}><Trans>观测中</Trans></SectionHeading>
            </CollapsibleHeader>
            <Collapse open={watchingOpen} keep>
              <div className="rounded-xl p-1 shadow-[inset_0_0_0_1px_var(--line)]">
                {watching.map((entry) => (
                  <WatchingRow
                    key={entry.item.id}
                    entry={entry}
                    projectName={activeProjectId === ALL ? projectName(entry.item.projectId) : undefined}
                    selected={entry.item.id === selectedId}
                    onDragStart={() => setDraggingId(entry.item.id)}
                    onDragEnd={() => { setDraggingId(undefined); setDropTarget(undefined); }}
                    onOpen={() => open(entry.item.id)}
                    onResume={() => void workItems.update(entry.item.id, { status: 'doing' })}
                    onDone={() => void workItems.update(entry.item.id, { status: 'done' })}
                    onDismiss={() => void workItems.update(entry.item.id, { status: 'cancelled' })}
                  />
                ))}
              </div>
            </Collapse>
          </section>
        )}

        {view === 'board' ? (
          <div className="-mx-1 overflow-x-auto px-1 pb-1">
            <div className="grid min-w-[912px] grid-cols-4 items-start gap-3">
              {BOARD_STATUSES.map((status) => {
                const isDoneColumn = status === 'done';
                const now = Date.now();
                const allColumn = isDoneColumn
                  ? shown.filter(({ item }) => (item.status === 'done' || item.status === 'cancelled') && (Boolean(needle) || now - Date.parse(item.statusAt) < DONE_SHOWN_MS)).sort(bySettled)
                  : shown.filter(({ item }) => item.status === status).sort(byAttention);
                const visibleColumn = isDoneColumn && !needle && !doneExpanded ? allColumn.slice(0, DONE_CARD_LIMIT) : allColumn;
                const hiddenDone = allColumn.length - visibleColumn.length;
                const activeDoing = status === 'doing' ? visibleColumn.filter((entry) => entry.live !== undefined) : [];
                const idleDoing = status === 'doing' ? visibleColumn.filter((entry) => entry.live === undefined) : [];
                const splitDoing = status === 'doing' && activeDoing.length > 0 && idleDoing.length > 0;
                const renderCard = (entry: WorkItemView) => (
                  <WorkItemCard
                    key={entry.item.id}
                    entry={entry}
                    family={family}
                    showSettledIcon={isDoneColumn}
                    projectName={activeProjectId === ALL ? projectName(entry.item.projectId) : undefined}
                    selected={entry.item.id === selectedId}
                    onDragStart={() => setDraggingId(entry.item.id)}
                    onDragEnd={() => { setDraggingId(undefined); setDropTarget(undefined); }}
                    onOpen={() => open(entry.item.id)}
                    onOpenSession={onOpenSession}
                    onWatch={() => void workItems.update(entry.item.id, { status: 'watching' })}
                    onDone={() => void workItems.update(entry.item.id, { status: 'done' })}
                    onDismiss={() => void workItems.update(entry.item.id, { status: 'cancelled' })}
                  />
                );
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
                      <span className="text-xs tabular-nums text-fg-4">{allColumn.length}</span>
                      {status === 'todo' && <Tip label={t`新建任务`}><Button size="icon-xs" variant="quiet" className="ml-auto" aria-label={t`新建任务`} onClick={() => setDraft(newDraft())}><IconPlus /></Button></Tip>}
                    </div>
                    <div className="flex min-h-24 flex-col gap-2 pb-4 pt-1">
                      {splitDoing ? <>
                        {activeDoing.map(renderCard)}
                        <div className="mt-1 flex items-center gap-2 px-1 text-2xs text-fg-4">
                          <span><Trans>停下待处理</Trans></span>
                          <span className="tabular-nums">{idleDoing.length}</span>
                          <span className="h-px flex-1 bg-line" />
                        </div>
                        {idleDoing.map(renderCard)}
                      </> : visibleColumn.map(renderCard)}
                      {isDoneColumn && !needle && allColumn.length > DONE_CARD_LIMIT && (
                        <Button
                          size="xs"
                          variant="quiet"
                          className="self-start text-fg-3"
                          onClick={() => setDoneExpanded((expanded) => !expanded)}
                        >
                          {doneExpanded ? t`收起` : t`显示其余 ${hiddenDone} 项`}
                        </Button>
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {LIST_STATUSES.map((status) => {
              const group = shown.filter(({ item }) => item.status === status).sort(status === 'done' || status === 'cancelled' ? bySettled : byAttention);
              if (!group.length) return null;
              return (
                <section key={status}>
                  <SectionHeading icon={<StatusIcon status={status} />} count={group.length}>{statusLabel(status)}</SectionHeading>
                  <div className="rounded-xl p-1 shadow-[inset_0_0_0_1px_var(--line)]">
                    {group.map((entry) => (
                      <ListRow
                        key={entry.item.id}
                        entry={entry}
                        projectName={activeProjectId === ALL ? projectName(entry.item.projectId) : undefined}
                        selected={entry.item.id === selectedId}
                        onOpen={() => open(entry.item.id)}
                      />
                    ))}
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

function CollapsibleHeader({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="group/toggle mb-0.5 inline-flex items-center gap-1 rounded-md px-0.5 text-left outline-none transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
    >
      {children}
      <span className="text-fg-4 transition-colors group-hover/toggle:text-fg-2">
        {open ? <IconChevronDown className="size-3.5" /> : <IconChevronRight className="size-3.5" />}
      </span>
    </button>
  );
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

function submissionClue(item: WorkItem, filesLabel: (count: number) => string, criteriaLabel: (met: number, total: number) => string): string | undefined {
  const submission = item.submission;
  if (!submission) return undefined;
  const parts: string[] = [];
  if (submission.criteria.length) {
    const met = submission.criteria.filter((entry) => entry.met === true).length;
    parts.push(criteriaLabel(met, submission.criteria.length));
  }
  if (submission.evidence.files.length) parts.push(filesLabel(submission.evidence.files.length));
  if (parts.length) return parts.join(' · ');
  const summaryLine = submission.summary.split('\n').map((line) => line.trim()).find(Boolean);
  return summaryLine;
}

function WorkItemCard({
  entry, projectName, family, showSettledIcon, selected, onDragStart, onDragEnd, onOpen, onOpenSession, onWatch, onDone, onDismiss,
}: {
  entry: WorkItemView;
  projectName: string | undefined;
  family: Family;
  showSettledIcon: boolean;
  selected: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onOpen: () => void;
  onOpenSession: (sessionId: string) => void;
  onWatch: () => void;
  onDone: () => void;
  onDismiss: () => void;
}) {
  const { t } = useLingui();
  const { item, sessions, title, live, latestFailed } = entry;
  const [dragging, setDragging] = useState(false);
  const children = family.children.get(item.id);
  const parent = item.parentId ? family.numbers.get(item.parentId) : undefined;
  const closed = item.status === 'done' || item.status === 'cancelled';
  const latestSession = entry.liveSession ?? sessions[0];
  const reviewHint = item.status === 'review'
    ? submissionClue(item, (count) => t`改动 ${count} 个文件`, (met, total) => t`标准 ${met}/${total}`)
    : undefined;

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      aria-pressed={selected}
      data-work-item=""
      onClick={onOpen}
      onKeyDown={activate(onOpen)}
      onDragStart={(event: DragEvent) => { event.dataTransfer.setData(DRAG_TYPE, item.id); event.dataTransfer.effectAllowed = 'move'; setDragging(true); onDragStart(); }}
      onDragEnd={() => { setDragging(false); onDragEnd(); }}
      className={cn(
        'group/row cursor-default select-none rounded-xl bg-bg px-3 py-2.5 text-left shadow-[inset_0_0_0_1px_var(--line)] outline-none transition-[box-shadow,background-color,opacity] duration-[var(--duration-fast)] hover:shadow-[inset_0_0_0_1px_var(--line-strong)] focus-visible:ring-2 focus-visible:ring-focus',
        selected && 'bg-active shadow-[inset_0_0_0_1px_var(--line-strong)]',
        dragging && 'opacity-40',
      )}
    >
      <div className="flex h-4 min-w-0 items-center gap-1.5">
        {showSettledIcon && <StatusIcon status={item.status} className="size-3.5" />}
        <WorkItemNumber number={item.number} />
        {projectName && <span className="min-w-0 truncate text-2xs text-fg-4">{projectName}</span>}
        {parent !== undefined && <span className="shrink-0 text-2xs tabular-nums text-fg-4">· #{parent}</span>}
        <LiveMark live={live} className="ml-auto" />
      </div>
      <p className={cn('mb-2 mt-1.5 line-clamp-2 text-sm', closed ? 'text-fg-2' : 'text-fg')}>{title}</p>
      {item.labels.length > 0 && <div className="-mt-0.5 mb-2 flex flex-wrap gap-1">{item.labels.map((label) => <Badge key={label}>{label}</Badge>)}</div>}
      {reviewHint && <p className="-mt-0.5 mb-2 truncate text-2xs text-fg-3">{reviewHint}</p>}
      {!live && latestFailed && !closed && <p className="-mt-0.5 mb-2 truncate text-2xs text-fg-4"><Trans>上次会话失败</Trans></p>}
      <div className="flex h-5 items-center gap-2 text-2xs text-fg-3">
        <AssigneeMark assignee={item.assignee} />
        {sessions.length > 1 && <span>{t`${sessions.length} 个会话`}</span>}
        {children && <span className="tabular-nums">{children.done}/{children.total}</span>}
        <span className="ml-auto grid shrink-0 items-center justify-items-end">
          <span className={cn('col-start-1 row-start-1 tabular-nums text-fg-4', rowConceal)}>{relativeTime(closed ? item.statusAt : item.updatedAt)}</span>
          <RowActions className="col-start-1 row-start-1 gap-0.5" onClick={(event) => event.stopPropagation()}>
            {latestSession && (
              <Tip label={t`打开会话`}>
                <Button size="icon-xs" variant="quiet" aria-label={t`打开会话`} onClick={() => onOpenSession(latestSession.id)}><IconMessageSquareText /></Button>
              </Tip>
            )}
            {!closed && <>
              {item.status !== 'watching' && (
                <Tip label={t`转入观测`}>
                  <Button size="icon-xs" variant="quiet" aria-label={t`转入观测`} onClick={onWatch}><IconEye /></Button>
                </Tip>
              )}
              <Tip label={t`完成`}>
                <Button size="icon-xs" variant="quiet" aria-label={t`完成`} onClick={onDone}><IconCheck /></Button>
              </Tip>
              <Tip label={t`无需关注`}>
                <Button size="icon-xs" variant="quiet" aria-label={t`无需关注`} onClick={onDismiss}><IconSlash /></Button>
              </Tip>
            </>}
          </RowActions>
        </span>
      </div>
    </div>
  );
}

function InboxRow({
  entry, projectName, selected, onOpen, onOpenSession, onDone, onResume, onDismiss,
}: {
  entry: WorkItemView;
  projectName: string | undefined;
  selected: boolean;
  onOpen: () => void;
  onOpenSession: (sessionId: string) => void;
  onDone: () => void;
  onResume: () => void;
  onDismiss: () => void;
}) {
  const { t } = useLingui();
  const statusLabel = useStatusLabel();
  const { item, title, live, liveSession, watchDue, sessions } = entry;
  const stuck = live !== 'waiting' ? item.stuck : undefined;
  const targetSession = liveSession ?? sessions[0];
  const reviewClue = item.status === 'review'
    ? submissionClue(item, (count) => t`改动 ${count} 个文件`, (met, total) => t`标准 ${met}/${total}`)
    : undefined;

  const reason = stuck ? stuck.note.split('\n')[0]
    : live === 'failed' ? liveSession?.error?.split('\n')[0] || t`失败`
    : entry.question && !(liveSession && liveSession.id !== entry.question.sessionId) ? entry.question.text.split('\n')[0]
      : live === 'waiting' ? t({ message: '待确认', context: 'workbench-session-pending' })
      : watchDue ? (item.watch?.note?.split('\n')[0] || t`观测到期`)
      : item.status === 'review' ? (live === 'running' ? t`运行中 · 待验收` : reviewClue || statusLabel('review'))
      : statusLabel(item.status);

  const tone = live === 'waiting' || stuck || watchDue ? 'text-warning' : live === 'failed' ? 'text-danger' : 'text-fg-3';
  const showPrimaryAction = item.status === 'review' || item.status === 'watching';

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
      <span className="grid size-4 shrink-0 place-items-center">
        {live && live !== 'running'
          ? <LiveMark live={live} words={false} />
          : <StatusIcon status={item.status} running={live === 'running'} />}
      </span>
      <WorkItemNumber number={item.number} className="w-9" />
      {projectName && <span className="hidden max-w-24 shrink-0 truncate text-xs text-fg-4 sm:inline">{projectName}</span>}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <span className={cn('inline-flex min-w-0 max-w-[38%] shrink items-center gap-1.5 text-xs', tone)}>
        {item.status === 'review' && live === 'running' && <Spinner className="size-3 shrink-0 text-accent" />}
        <span className="truncate">{reason}</span>
      </span>
      <AssigneeMark assignee={item.assignee} />
      <span className="grid shrink-0 items-center justify-items-end">
        <span className={cn('col-start-1 row-start-1 min-w-12 text-right text-2xs tabular-nums text-fg-4', rowConceal)}>{relativeTime(item.updatedAt)}</span>
        <RowActions className="col-start-1 row-start-1 gap-1" onClick={(event) => event.stopPropagation()}>
          {targetSession && (
            <Tip label={t`打开会话`}>
              <Button size="icon-xs" variant="quiet" aria-label={t`打开会话`} onClick={() => onOpenSession(targetSession.id)}><IconMessageSquareText /></Button>
            </Tip>
          )}
          {showPrimaryAction && (
            item.status === 'review'
              ? <Button size="xs" variant="secondary" onClick={onDone}><Trans>完成</Trans></Button>
              : <Button size="xs" variant="secondary" onClick={onResume}><Trans>恢复进行中</Trans></Button>
          )}
          <Tip label={t`无需关注`}>
            <Button size="icon-xs" variant="quiet" aria-label={t`无需关注`} onClick={onDismiss}><IconSlash /></Button>
          </Tip>
        </RowActions>
      </span>
    </div>
  );
}

function WatchingRow({
  entry, projectName, selected, onDragStart, onDragEnd, onOpen, onResume, onDone, onDismiss,
}: {
  entry: WorkItemView;
  projectName: string | undefined;
  selected: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onOpen: () => void;
  onResume: () => void;
  onDone: () => void;
  onDismiss: () => void;
}) {
  const { t } = useLingui();
  const { item, title, live, watchDue } = entry;
  const [dragging, setDragging] = useState(false);
  const metaParts: string[] = [];
  if (item.watch?.delegationId) metaParts.push(t`自动追踪`);
  if (item.watch?.until) metaParts.push(watchDue ? t`已到期` : formatDateTime(item.watch.until));
  if (item.watch?.note) metaParts.push(item.watch.note.split('\n')[0]!);
  const meta = metaParts.join(' · ') || t`持续观测`;

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      aria-pressed={selected}
      data-work-item=""
      onClick={onOpen}
      onKeyDown={activate(onOpen)}
      onDragStart={(event: DragEvent) => { event.dataTransfer.setData(DRAG_TYPE, item.id); event.dataTransfer.effectAllowed = 'move'; setDragging(true); onDragStart(); }}
      onDragEnd={() => { setDragging(false); onDragEnd(); }}
      className={cn(
        'group/row flex min-h-9 w-full min-w-0 cursor-default select-none items-center gap-2 rounded-lg px-2.5 text-sm text-fg outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus no-hover:min-h-11',
        selected && 'bg-active',
        dragging && 'opacity-40',
      )}
    >
      <StatusIcon status="watching" running={live === 'running'} />
      <WorkItemNumber number={item.number} className="w-9" />
      {projectName && <span className="hidden max-w-24 shrink-0 truncate text-xs text-fg-4 sm:inline">{projectName}</span>}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <span className={cn('min-w-0 max-w-[36%] shrink truncate text-xs', watchDue ? 'text-warning' : 'text-fg-3')}>{meta}</span>
      <AssigneeMark assignee={item.assignee} />
      <span className="grid shrink-0 items-center justify-items-end">
        <span className={cn('col-start-1 row-start-1 min-w-12 text-right text-2xs tabular-nums text-fg-4', rowConceal)}>{relativeTime(item.statusAt)}</span>
        <RowActions className="col-start-1 row-start-1 gap-0.5" onClick={(event) => event.stopPropagation()}>
          <Tip label={t`恢复进行中`}>
            <Button size="icon-xs" variant="quiet" aria-label={t`恢复进行中`} onClick={onResume}><IconPlay /></Button>
          </Tip>
          <Tip label={t`完成`}>
            <Button size="icon-xs" variant="quiet" aria-label={t`完成`} onClick={onDone}><IconCheck /></Button>
          </Tip>
          <Tip label={t`无需关注`}>
            <Button size="icon-xs" variant="quiet" aria-label={t`无需关注`} onClick={onDismiss}><IconSlash /></Button>
          </Tip>
        </RowActions>
      </span>
    </div>
  );
}

function ListRow({ entry, projectName, selected, onOpen }: { entry: WorkItemView; projectName: string | undefined; selected: boolean; onOpen: () => void }) {
  const { item, title, live } = entry;
  const closed = item.status === 'done' || item.status === 'cancelled';
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
      <StatusIcon status={item.status} running={live === 'running'} />
      <WorkItemNumber number={item.number} className="w-9" />
      {projectName && <span className="hidden max-w-24 shrink-0 truncate text-xs text-fg-4 sm:inline">{projectName}</span>}
      <span className={cn('min-w-0 flex-1 truncate', closed ? 'text-fg-2' : 'text-fg')}>{title}</span>
      {item.labels.map((label) => <Badge key={label} className="max-md:hidden">{label}</Badge>)}
      {live !== 'running' && <LiveMark live={live} />}
      <AssigneeMark assignee={item.assignee} />
      <span className="w-12 shrink-0 text-right text-xs tabular-nums text-fg-3">{relativeTime(closed ? item.statusAt : item.updatedAt)}</span>
    </div>
  );
}
