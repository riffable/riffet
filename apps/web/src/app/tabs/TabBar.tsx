import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Trans, useLingui } from '@lingui/react/macro';
import { isDoneUnseen, needsYou, type Session } from '@contracts';
import { AgentLogo } from '@/components/AgentLogo';
import { IconChevronDown, IconGitBranch, IconFolder, IconLink, IconMessageSquareText, IconPencilLine, IconPin, IconPinOff, IconPlus, IconServer, IconX } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Spinner, StatusDot } from '@/components/ui/controls';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { agentMarkStyle, sessionBackend } from '@/lib/backends';
import { cn } from '@/lib/utils';
import { useGitStatus } from '../state/gitStatusStore';
import { useLists, useStores } from '../state/stores';
import { useShortcutHint } from '../shortcuts';
import { tabZones, type TabEntry } from './tabsStore';
import { useTabs } from './useTabs';
import { useZoneDrag } from './useZoneDrag';
import { ExpandSidebarButton } from '../ExpandSidebarButton';
import { ServerTag, useServerBadge } from '../useServerLabel';
import { animationsOf, cancelAnimations, exit, settled } from '@/lib/motion';

export type TabBarVariant = 'inline' | 'strip';

/** Tabs arriving and leaving change width over this long, so the others give way instead of jumping. */
const TAB_MOTION = { duration: 200, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' };
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Widens a tab from nothing to where the row has put it; min/max carry it, since a flex share cannot be animated. */
function growIn(node: HTMLElement | null) {
  if (!node || reducedMotion()) return;
  // Measure the settled width: a grow already running (an effect run twice) would report its own first frame.
  cancelAnimations(node);
  const width = `${node.offsetWidth}px`;
  node.animate([{ minWidth: '0px', maxWidth: '0px', opacity: 0 }, { minWidth: width, maxWidth: width, opacity: 1 }], TAB_MOTION);
}
const HOVER_CARD_MS = 600;
const FADE = 28;

/** Where a tab sat in the last paint. */
interface Place { session: Session; zone: 'pins' | 'tabs'; index: number; width: number; preview: boolean }

const sameList = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((item, index) => item === b[index]);

/** The agent's mark, or a spinner while it works. */
function TabLead({ session }: { session: Session }) {
  const { t } = useLingui();
  const backend = sessionBackend(session);
  if (session.state === 'running' || session.state === 'starting') return <span className="grid size-3.5 place-items-center" role="status" aria-label={t`运行中`}><Spinner className="size-3 text-accent" /></span>;
  if (backend === 'chat') return <IconMessageSquareText className="size-3.5 text-fg-3" aria-hidden />;
  return <AgentLogo backend={backend} size={14} style={agentMarkStyle(backend)} />;
}

/** What needs the reader: a wait, or a failure or result they have not seen. */
function TabDot({ session }: { session: Session }) {
  const { t } = useLingui();
  const waiting = needsYou(session);
  if (!waiting && !isDoneUnseen(session)) return null;
  return (
    <span className="grid place-items-center group-hover/tab:hidden group-data-[active=true]/tab:hidden">
      {waiting
        ? <StatusDot tone="warning" pulse label={t`等待处理`} className="size-[7px] shadow-[0_0_0_3px_var(--warning-soft)]" />
        : session.state === 'failed'
          ? <StatusDot tone="danger" label={t`运行失败`} className="size-[7px]" />
          : <StatusDot tone="accent" label={session.state === 'interrupted' ? t`已中断` : t({ message: '已完成', context: 'workbench-item-status-completed' })} className="size-[7px]" />}
    </span>
  );
}

interface TabProps {
  session: Session;
  preview: boolean;
  active: boolean;
  /** The one tab Tab reaches; arrow keys move among the rest. */
  stop: boolean;
  pinned: boolean;
  variant: TabBarVariant;
  /** Opened after the bar was already showing: it grows into place. */
  enter: boolean;
  onMenu: (event: MouseEvent, id: string) => void;
  onHover: (node: HTMLElement | undefined, id: string) => void;
}

function Tab({ session, preview, active, stop, pinned, variant, enter, onMenu, onHover }: TabProps) {
  const { t } = useLingui();
  const ref = useRef<HTMLDivElement>(null);
  // Only the mount: a tab that is already showing has nowhere to grow from.
  useLayoutEffect(() => { if (enter) growIn(ref.current); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const { tabs } = useStores();
  const id = session.id;
  const server = useServerBadge(session.id);
  const title = session.title;
  const strip = variant === 'strip';
  return (
    <div
      ref={ref}
      role="tab"
      aria-selected={active}
      tabIndex={stop ? 0 : -1}
      draggable
      data-tab-id={id}
      data-active={active}
      onClick={(event) => {
        // The first click of a double click already switched tabs; the second keeps the tab.
        if (event.detail === 2) tabs.keep(id);
        else if (!active) tabs.activate(id);
      }}
      onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
      onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); tabs.close(id); } }}
      onContextMenu={(event) => onMenu(event, id)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        tabs.activate(id);
      }}
      onPointerEnter={(event) => onHover(event.currentTarget, id)}
      onPointerLeave={() => onHover(undefined, id)}
      onPointerDown={() => onHover(undefined, id)}
      className={cn(
        'group/tab relative flex shrink items-center gap-1.5 whitespace-nowrap pr-1 text-sm outline-none select-none transition-colors focus-visible:ring-2 focus-visible:ring-focus',
        strip ? 'h-9 rounded-t-lg pl-3 focus-visible:ring-inset' : 'h-7 rounded-lg border pl-2',
        // Like a browser's tab strip: every tab starts from the same width, which also sizes the
        // row, and gives way evenly as more arrive, the current one more slowly and never below a
        // readable width; past the minimums the row scrolls.
        pinned ? cn('flex-none', active ? 'max-w-[320px]' : 'max-w-[168px]')
          : cn('w-[320px]', active ? 'min-w-[200px]' : 'min-w-[88px]'),
        active ? 'z-1 font-medium text-fg' : 'text-fg-2 hover:text-fg',
        // The strip keeps its concave feet; the current surface fades into the panel beneath it.
        strip
          ? cn('isolate', active && 'session-tab-current tab-strip-current',
            !active && 'after:absolute after:inset-[4px_2px_6px] after:-z-10 after:rounded-lg after:content-[""] hover:after:bg-hover',
            !active && preview && 'after:border after:border-dashed after:border-line-strong')
          : cn(active ? 'session-tab-current shadow-soft' : 'hover:bg-hover',
            preview ? (active ? 'border-dashed border-fg-4' : 'border-dashed border-line-strong') : 'border-transparent'),
      )}
    >
      <span className="grid size-3.5 shrink-0 place-items-center"><TabLead session={session} /></span>
      <span className="min-w-0 flex-1 truncate">{session.title}</span>
      {server && (
        server.multiPeer
          ? <span className={cn('max-w-16 shrink-0 truncate rounded bg-subtle px-1 py-px font-mono text-2xs', server.offline ? 'text-warning' : 'text-fg-4')}>{server.alias}</span>
          : <IconLink aria-hidden className={cn('size-3 shrink-0', server.offline ? 'text-warning' : 'text-fg-4')} />
      )}
      <span className="grid size-5 shrink-0 place-items-center">
        <TabDot session={session} />
        <button
          type="button"
          tabIndex={-1}
          aria-label={t`关闭${title}`}
          onClick={(event) => { event.stopPropagation(); tabs.close(id); }}
          className="hidden size-5 place-items-center rounded-md text-fg-3 hover:bg-active hover:text-fg group-hover/tab:grid group-data-[active=true]/tab:grid"
        >
          <IconX className="size-3" />
        </button>
      </span>
      {strip && active && <span aria-hidden className="tab-flare" />}
      {strip && active && preview && <span aria-hidden className="tab-dash" />}
    </div>
  );
}

/** A tab just closed, collapsing where it was so its neighbours close the gap rather than jump. */
function LeavingTab({ session, width, variant, onGone }: { session: Session; width: number; variant: TabBarVariant; onGone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const gone = useRef(onGone);
  gone.current = onGone;
  // The ghost goes when its own collapse ends, so the neighbours' move and the removal share one clock.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    return exit(node, [{ minWidth: `${width}px`, maxWidth: `${width}px`, opacity: 1 }, { minWidth: '0px', maxWidth: '0px', opacity: 0 }], TAB_MOTION, () => gone.current());
  }, [width]);
  return (
    <div ref={ref} aria-hidden className={cn('pointer-events-none flex shrink-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-sm text-fg-2', variant === 'strip' ? 'h-9 pl-3' : 'h-7 rounded-lg border border-transparent pl-2')} style={{ width }}>
      <span className="grid size-3.5 shrink-0 place-items-center"><TabLead session={session} /></span>
      <span className="min-w-0 truncate">{session.title}</span>
    </div>
  );
}

/** One row of tabs that scrolls sideways, fades where it is cut off, and reorders by drag. */
function Zone({ name, variant, onReorder, onOverflow, onDragBegin, className, children }: {
  name: 'pins' | 'tabs';
  variant: TabBarVariant;
  onReorder: (ids: string[]) => void;
  onOverflow?: (over: boolean) => void;
  onDragBegin: () => void;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ left: false, right: false });
  const overflow = useRef(onOverflow);
  overflow.current = onOverflow;
  const settling = useRef(false);
  const measure = useCallback(function measure() {
    const node = ref.current;
    if (!node) return;
    // A tab growing in or collapsing out briefly overfills the row; read it once they settle, so
    // the fades and the 全部标签 button do not flash on every switch.
    const moving = animationsOf(node, { subtree: true }).filter((animation) => (animation.effect as KeyframeEffect | null)?.target?.parentElement === node);
    if (moving.length) {
      if (!settling.current) {
        settling.current = true;
        void settled(moving).then(() => { settling.current = false; measure(); });
      }
      return;
    }
    const over = node.scrollWidth > node.clientWidth + 1;
    const left = over && node.scrollLeft > 2;
    const right = over && node.scrollLeft + node.clientWidth < node.scrollWidth - 2;
    setEdge((current) => current.left === left && current.right === right ? current : { left, right });
    overflow.current?.(over);
  }, []);
  useLayoutEffect(measure);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    // A mouse wheel scrolls the row sideways; a trackpad's horizontal swipe already does. React's wheel listener is passive.
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || node.scrollWidth <= node.clientWidth) return;
      event.preventDefault();
      node.scrollLeft += event.deltaY;
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => { observer.disconnect(); node.removeEventListener('wheel', onWheel); };
  }, [measure]);
  const [epoch, setEpoch] = useState(0);
  const desync = useCallback(() => setEpoch((value) => value + 1), []);
  const drag = useZoneDrag(onReorder, onDragBegin, desync);
  const mask: CSSProperties | undefined = edge.left || edge.right
    ? { maskImage: `linear-gradient(90deg, ${edge.left ? `transparent, #000 ${FADE}px` : '#000, #000'}, ${edge.right ? `#000 calc(100% - ${FADE}px), transparent` : '#000, #000'})` }
    : undefined;
  return (
    <div
      ref={ref}
      role="tablist"
      data-zone={name}
      onScroll={measure}
      style={mask}
      {...drag}
      className={cn('flex min-w-0 items-center gap-0.5 overflow-x-auto scrollbar-none', variant === 'strip' ? 'items-end self-stretch overflow-y-hidden px-2.5 -mx-2.5' : 'py-0.5', className)}
    >
      <Fragment key={epoch}>{children}</Fragment>
    </div>
  );
}

function TabCard({ session, anchor }: { session: Session; anchor: DOMRect }) {
  const { t } = useLingui();
  const projects = useLists((state) => state.projects);
  const project = projects.find((item) => item.id === session.projectId);
  const origin = project?.worktree && projects.find((item) => item.id === project.worktree?.originProjectId);
  const git = useGitStatus(session.projectId)?.status;
  const branch = project?.worktree?.branch ?? git?.branch;
  const running = session.state === 'running' || session.state === 'starting';
  const status = running ? t`运行中`
    : session.state === 'waiting' ? t`等待处理`
      : session.state === 'failed' ? t`运行失败`
        : '';
  const server = useServerBadge(session.id);
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - 280));
  return createPortal(
    <div
      role="tooltip"
      style={{ left, top: anchor.bottom + 6 }}
      className="ui-floating-content pointer-events-none fixed z-(--z-tooltip) flex w-68 flex-col gap-1.5 rounded-xl bg-popover px-3.5 py-3 text-xs text-fg-2 shadow-peek animate-in fade-in-0 duration-[var(--duration-fast)]"
    >
      <span className="line-clamp-2 text-sm font-semibold text-fg">{session.title}</span>
      {server && (
        <span className={cn('flex min-w-0 items-center gap-1.5', server.offline && 'text-warning')}>
          <IconServer className="size-3.5 shrink-0 text-fg-3" />
          <span className="truncate">{server.label}</span>
          {server.alias !== server.name && <span className="shrink-0 font-mono text-2xs text-fg-4">{server.alias}</span>}
        </span>
      )}
      {project && !project.system && (
        <span className="flex min-w-0 items-center gap-1.5"><IconFolder className="size-3.5 shrink-0 text-fg-3" /><span className="truncate">{(origin || project).name}</span>{project.worktree && <span className="shrink-0 text-fg-4">worktree</span>}</span>
      )}
      {branch && <span className="flex min-w-0 items-center gap-1.5"><IconGitBranch className="size-3.5 shrink-0 text-fg-3" /><span className="truncate font-mono text-2xs">{branch}</span></span>}
      {status && <span className={cn('flex items-center gap-1.5', session.state === 'failed' && 'text-danger', session.state === 'waiting' && 'text-warning')}>{status}</span>}
      {running && <span className="mt-0.5 border-t border-line pt-2 text-fg-3"><Trans>关闭标签后仍在后台运行</Trans></span>}
    </div>,
    document.body,
  );
}

interface TabBarProps {
  variant: TabBarVariant;
  /** The selected conversation, or empty when the project home or a page is showing. */
  activeId: string;
  sidebarCollapsed: boolean;
  onExpandSidebar: () => void;
  onNewSession: () => void;
  /** Receives the slot at the right end, where the page header puts its actions. */
  actionsRef: (node: HTMLDivElement | null) => void;
}

export const TabBar = memo(function TabBar({ variant, activeId, sidebarCollapsed, onExpandSidebar, onNewSession, actionsRef }: TabBarProps) {
  const newHint = useShortcutHint('newSession');
  const closeHint = useShortcutHint('tabClose');
  const { t } = useLingui();
  const { tabs: store, handlers } = useStores();
  const entries = useTabs((state) => state.tabs);
  const ids = useMemo(() => new Set(entries.map((entry) => entry.sessionId)), [entries]);
  const sessions = useLists((state) => state.sessions.filter((session) => ids.has(session.id)), sameList);
  const projects = useLists((state) => state.projects);
  const byId = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
  const zones = useMemo(() => tabZones(entries, byId), [entries, byId]);
  const strip = variant === 'strip';

  // What the last paint showed: which tabs (so a new one grows in, though not on the bar's first
  // paint), where each sat and how wide (so a closed one collapses from there).
  const shown = useRef<{ ids: Set<string>; places: Map<string, Place> } | undefined>(undefined);
  const [leaving, setLeaving] = useState<(Place & { key: string })[]>([]);
  const visible = new Set([...zones.pinned, ...zones.normal].map((entry) => entry.sessionId));
  // A temporary tab handed to another conversation changes in place, rather than collapsing beside
  // a new one growing in, also when the conversation it now shows sits in the other zone (a pinned
  // one handed to an unpinned one would otherwise empty the pinned zone, ghost and all, for a frame
  // before the new tab grows in). Holds both conversations.
  const swapped = new Set<string>();
  if (shown.current) {
    const next = zones.pinned.find((entry) => entry.preview) ?? zones.normal.find((entry) => entry.preview);
    for (const [id, place] of shown.current.places) {
      if (!place.preview || visible.has(id)) continue;
      if (next && !shown.current.ids.has(next.sessionId)) { swapped.add(id); swapped.add(next.sessionId); }
    }
  }
  useLayoutEffect(() => {
    const previous = shown.current;
    if (previous && !reducedMotion()) {
      const gone = [...previous.places].filter(([id]) => !visible.has(id) && !swapped.has(id)).map(([id, place]) => ({ key: `${id}:${Date.now()}`, ...place }));
      if (gone.length) {
        setLeaving((current) => [...current, ...gone]);
      }
    }
    const places = new Map<string, Place>();
    for (const zone of ['pins', 'tabs'] as const) {
      const list = zone === 'pins' ? zones.pinned : zones.normal;
      list.forEach((entry, index) => {
        const session = byId.get(entry.sessionId);
        const node = barRef.current?.querySelector<HTMLElement>(`[data-zone="${zone}"] [data-tab-id="${CSS.escape(entry.sessionId)}"]`);
        if (session) places.set(entry.sessionId, { session, zone, index, width: node?.offsetWidth ?? 0, preview: entry.preview });
      });
    }
    shown.current = { ids: visible, places };
  });

  // Tabs from the project most tabs are from carry no project name; the others do.
  const rootOf = useCallback((session: Session) => projects.find((item) => item.id === session.projectId)?.worktree?.originProjectId ?? session.projectId, [projects]);
  const primary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of [...zones.pinned, ...zones.normal]) {
      const session = byId.get(entry.sessionId);
      if (session) counts.set(rootOf(session), (counts.get(rootOf(session)) ?? 0) + 1);
    }
    let best = '';
    for (const [project, count] of counts) if (count > (counts.get(best) ?? 0)) best = project;
    return counts.size > 1 ? best : undefined;
  }, [zones, byId, rootOf]);
  const projectName = useCallback((session: Session) => {
    if (primary === undefined || rootOf(session) === primary) return undefined;
    const project = projects.find((item) => item.id === session.projectId);
    const origin = project?.worktree && projects.find((item) => item.id === project.worktree?.originProjectId);
    return (origin || project)?.name;
  }, [primary, rootOf, projects]);

  const [normalOverflow, setNormalOverflow] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  // The current tab scrolls into view, by the zone's own scroll alone.
  const lastActive = useRef('');
  useLayoutEffect(() => {
    const node = barRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    const zone = node?.closest<HTMLElement>('[data-zone]');
    if (!node || !zone) return;
    const smooth = lastActive.current !== '' && lastActive.current !== activeId;
    lastActive.current = activeId;
    const box = zone.getBoundingClientRect();
    const tab = node.getBoundingClientRect();
    const left = tab.left - box.left - FADE;
    const right = tab.right - box.right + FADE;
    if (left < 0) zone.scrollBy({ left, behavior: smooth ? 'smooth' : 'instant' });
    else if (right > 0) zone.scrollBy({ left: right, behavior: smooth ? 'smooth' : 'instant' });
  }, [activeId, entries]);

  // Hover card: after a pause on a tab, until the pointer leaves, a menu opens, or a drag starts.
  const [card, setCard] = useState<{ id: string; rect: DOMRect } | undefined>();
  const cardTimer = useRef<number | undefined>(undefined);
  const hideCard = useCallback(() => { window.clearTimeout(cardTimer.current); setCard(undefined); }, []);
  useEffect(() => () => window.clearTimeout(cardTimer.current), []);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; open: boolean } | undefined>();
  const menuOpen = menu?.open ?? false;
  const onHover = useCallback((node: HTMLElement | undefined, id: string) => {
    hideCard();
    if (!node || menuOpen) return;
    cardTimer.current = window.setTimeout(() => setCard({ id, rect: node.getBoundingClientRect() }), HOVER_CARD_MS);
  }, [hideCard, menuOpen]);
  const onMenu = useCallback((event: MouseEvent, id: string) => {
    event.preventDefault();
    hideCard();
    setMenu({ id, x: event.clientX, y: event.clientY, open: true });
  }, [hideCard]);

  const reorderNormal = useCallback((order: string[]) => store.reorderNormal(order), [store]);
  const reorderPinned = useCallback((order: string[]) => store.reorderPinned(order), [store]);

  // One tab stop: the current tab, or the first when the home or a page is showing.
  const stopId = zones.pinned.concat(zones.normal).find((entry) => entry.sessionId === activeId)?.sessionId ?? zones.pinned[0]?.sessionId ?? zones.normal[0]?.sessionId;
  // Arrows and Home/End move focus in the order the tabs show; Delete closes and hands focus to a neighbour.
  const onTabKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    const node = event.target as HTMLElement;
    if (node.getAttribute('role') !== 'tab' || !node.dataset.tabId) return;
    const nodes = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"][data-tab-id]')];
    const at = nodes.indexOf(node);
    const to = event.key === 'ArrowRight' ? (at + 1) % nodes.length
      : event.key === 'ArrowLeft' ? (at - 1 + nodes.length) % nodes.length
        : event.key === 'Home' ? 0
          : event.key === 'End' ? nodes.length - 1
            : -1;
    if (to >= 0) { event.preventDefault(); nodes[to]?.focus(); return; }
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    event.preventDefault();
    (nodes[at + 1] ?? nodes[at - 1])?.focus();
    store.close(node.dataset.tabId);
  };

  const render = (entry: TabEntry, pinned: boolean) => {
    const session = byId.get(entry.sessionId);
    if (!session) return null;
    const enter = Boolean(shown.current && !shown.current.ids.has(session.id) && !swapped.has(session.id));
    return <Tab key={session.id} session={session} preview={entry.preview} pinned={pinned} active={session.id === activeId} stop={session.id === stopId} variant={variant} enter={enter} onMenu={onMenu} onHover={onHover} />;
  };
  const withLeaving = (nodes: ReactNode[], zone: 'pins' | 'tabs') => {
    for (const item of leaving.filter((ghost) => ghost.zone === zone).sort((a, b) => a.index - b.index)) {
      nodes.splice(Math.min(item.index, nodes.length), 0, <LeavingTab key={item.key} session={item.session} width={item.width} variant={variant} onGone={() => setLeaving((current) => current.filter((ghost) => ghost !== item))} />);
    }
    return nodes;
  };
  const normal = withLeaving(zones.normal.map((entry) => render(entry, false)), 'tabs');

  const menuSession = menu ? byId.get(menu.id) : undefined;
  const menuEntry = menu ? entries.find((entry) => entry.sessionId === menu.id) : undefined;
  const othersToClose = menu ? zones.normal.filter((entry) => entry.sessionId !== menu.id).length : 0;
  const rightToClose = menu ? (() => {
    const order = [...zones.pinned, ...zones.normal];
    const at = order.findIndex((entry) => entry.sessionId === menu.id);
    return order.slice(at + 1).filter((entry) => zones.normal.includes(entry)).length;
  })() : 0;
  const all = [...zones.pinned, ...zones.normal].map((entry) => byId.get(entry.sessionId)).filter((session): session is Session => Boolean(session));
  const buttonShift = strip ? 'mb-1 self-end' : 'self-center';

  return (
    <div className={cn('flex shrink-0 gap-1', strip ? 'relative z-10 mt-2 h-9 items-end pr-2 pl-3' : 'h-[52px] items-center px-3', sidebarCollapsed && 'pl-2')}>
      {sidebarCollapsed && (
        <ExpandSidebarButton className={cn(strip && 'mb-1')} onClick={onExpandSidebar} />
      )}
      <div ref={barRef} onKeyDown={onTabKeys} className="flex min-w-0 flex-1 items-center gap-0.5 self-stretch">
        {zones.pinned.length > 0 && (
          <Zone name="pins" variant={variant} onReorder={reorderPinned} onDragBegin={hideCard} className="max-w-[45%] flex-none">
            {withLeaving(zones.pinned.map((entry) => render(entry, true)), 'pins')}
          </Zone>
        )}
        {zones.pinned.length > 0 && normal.length > 0 && <i aria-hidden className="mx-1.5 h-4 w-px shrink-0 self-center bg-line-strong" />}
        <Zone name="tabs" variant={variant} onReorder={reorderNormal} onOverflow={setNormalOverflow} onDragBegin={hideCard} className="shrink">
          {normal}
        </Zone>
        <Tip label={t`新会话`} kbd={newHint}>
          <Button size="icon-sm" variant="quiet" className={cn('shrink-0', buttonShift)} aria-label={t`新会话`} onClick={onNewSession}><IconPlus /></Button>
        </Tip>
        {normalOverflow && (
          <DropdownMenu>
            <Tip label={t`全部标签`}>
              <DropdownMenuTrigger asChild>
                <Button size="icon-sm" variant="quiet" className={cn('shrink-0', buttonShift)} aria-label={t`全部标签`}><IconChevronDown /></Button>
              </DropdownMenuTrigger>
            </Tip>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuRadioGroup value={activeId} onValueChange={(id) => store.activate(id)}>
                {all.map((session) => {
                  const name = projectName(session);
                  return (
                    <DropdownMenuRadioItem key={session.id} value={session.id}>
                      <span className="grid size-4 shrink-0 place-items-center"><TabLead session={session} /></span>
                      <span className="min-w-0 flex-1 truncate">{session.title}</span>
                      <ServerTag objectId={session.id} className="max-w-20 shrink-0 truncate text-2xs text-fg-4" />
                      {name && <span className="max-w-24 shrink-0 truncate text-xs text-fg-4">{name}</span>}
                    </DropdownMenuRadioItem>
                  );
                })}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <div ref={actionsRef} className={cn('flex shrink-0 items-center', strip && 'mb-1 self-end')} />

      {menu && (
        <DropdownMenu open={menu.open} onOpenChange={(open) => setMenu((current) => current && { ...current, open })}>
          <DropdownMenuTrigger asChild>
            <span aria-hidden className="pointer-events-none fixed size-0" style={{ left: menu.x, top: menu.y }} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={0} className="w-52">
            {menuEntry?.preview && <DropdownMenuItem onSelect={() => store.keep(menu.id)}><Trans>加入标签栏</Trans></DropdownMenuItem>}
            {menuSession && (
              <DropdownMenuItem onSelect={() => handlers.sessionAction(menuSession, 'pin')}>
                {menuSession.pinnedAt ? <><IconPinOff /><Trans>取消置顶</Trans></> : <><IconPin /><Trans>置顶会话</Trans></>}
              </DropdownMenuItem>
            )}
            {menuSession && <DropdownMenuItem onSelect={() => handlers.sessionAction(menuSession, 'rename')}><IconPencilLine /><Trans>重命名</Trans></DropdownMenuItem>}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => store.close(menu.id)}><Trans>关闭</Trans><span className="ml-auto pl-4 text-xs text-fg-4">{closeHint}</span></DropdownMenuItem>
            <DropdownMenuItem disabled={othersToClose === 0} onSelect={() => store.closeOthers(menu.id)}><Trans>关闭其他标签</Trans></DropdownMenuItem>
            <DropdownMenuItem disabled={rightToClose === 0} onSelect={() => store.closeRight(menu.id)}><Trans>关闭右侧标签</Trans></DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {card && byId.get(card.id) && !menuOpen && <TabCard session={byId.get(card.id)!} anchor={card.rect} />}
    </div>
  );
});
