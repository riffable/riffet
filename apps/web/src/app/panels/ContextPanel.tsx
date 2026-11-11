import { Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconChevronDown, IconMaximize, IconMinimize, IconPanelRight, IconX } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { EmptyState, Spinner, UnderlineTabs } from '@/components/ui/controls';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';
import type { ProjectRecord, PromptContextReference } from '@/lib/api';
import { PluginView } from '@/plugins/PluginView';
import { watchGitStatus } from '../state/gitStatusStore';
import { useStores, useUi } from '../state/stores';
import { hostSidebarBodies, type PreviewTarget } from './sidebarViews';
import { shownView, useSidebarViews } from './useSidebarViews';

const previewFallback = <div className="flex flex-1 justify-center py-10"><Spinner /></div>;

interface Props {
  project: ProjectRecord;
  sessionId?: string;
  previewTarget?: PreviewTarget | undefined;
  /** The id of the view to show; one that is not offered now shows the first view that is, and is kept. */
  tab: string;
  onTabChange: (tab: string) => void;
  onReference: (reference: PromptContextReference) => void;
  onError: (message: string) => void;
  onClose: () => void;
  /** Opens a worktree of this project as a project of its own, so sessions can run in it. */
  onOpenWorktree?: (path: string) => void;
  onWorktreeMerged?: (result: { originProjectId: string; removedWorktree: boolean }) => void;
  /** Whether the panel currently spans the conversation area; only offered where it can. */
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
}

/**
 * The side panel's shell: a tab for each sidebar view the catalog offers for this project, the
 * panel's own buttons, and the shown view's body. It holds only view ids; what a view is, and
 * whether it is offered, comes from the registry, so adding a view changes nothing here.
 */
export function ContextPanel({ project, sessionId, previewTarget, tab, onTabChange, onReference, onError, onClose, onOpenWorktree, onWorktreeMerged, fullscreen, onToggleFullscreen }: Props) {
  const { t } = useLingui();
  const { ui } = useStores();
  useEffect(() => watchGitStatus(project.id), [project.id]);
  const panelOpen = useUi((state) => state.panelOpen);
  const views = useSidebarViews(project, sessionId);
  const current = shownView(views, tab);
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  /** Own views that keep their state once shown. */
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (current && hostSidebarBodies[current.id]?.keepAlive) setKept((previous) => previous.has(current.id) ? previous : new Set(previous).add(current.id));
  }, [current]);

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-bg" aria-label={t`项目上下文`}>
      <div className="flex h-12 shrink-0 items-stretch gap-2 edge-b px-1.5">
        {views.length > 0 && <ViewTabs value={current?.id ?? tab} onChange={onTabChange} options={views.map((view) => ({ value: view.id, label: view.title }))} />}
        <div className="ml-auto flex shrink-0 items-center pr-1.5">
          <div ref={setHeaderSlot} className="contents" />
          {onToggleFullscreen && <Tip label={fullscreen ? t`退出全屏` : t`全屏`}><Button size="icon-xs" variant="quiet" className="max-md:size-10" aria-label={fullscreen ? t`退出全屏` : t`全屏`} aria-pressed={fullscreen} onClick={onToggleFullscreen}>{fullscreen ? <IconMinimize /> : <IconMaximize />}</Button></Tip>}
          <Tip label={t`关闭`}><Button size="icon-xs" variant="quiet" className="max-md:size-10" aria-label={t`关闭面板`} onClick={onClose}><IconX /></Button></Tip>
        </div>
      </div>
      {views.length === 0 && (
        <EmptyState className="flex-1" icon={<IconPanelRight />} title={t`没有显示的视图`}>
          <Button size="sm" variant="secondary" onClick={() => ui.openSettings('views')}><Trans>视图设置</Trans></Button>
        </EmptyState>
      )}
      {views.map((view) => {
        const shown = view.id === current?.id;
        const own = hostSidebarBodies[view.id];
        if (own) {
          if (!shown && !(own.keepAlive && kept.has(view.id))) return null;
          return (
            <Suspense key={view.id} fallback={shown ? previewFallback : null}>
              <own.Body project={project} sessionId={sessionId} previewTarget={previewTarget} shown={shown} wide={Boolean(fullscreen)} headerSlot={headerSlot} show={() => onTabChange(view.id)} onReference={onReference} onError={onError} onClose={onClose} onOpenWorktree={onOpenWorktree} onWorktreeMerged={onWorktreeMerged} />
            </Suspense>
          );
        }
        return shown ? <PluginView key={view.id} entry={view} projectId={project.id} sessionId={sessionId} visible={panelOpen} /> : null;
      })}
    </aside>
  );
}

const MORE_WIDTH = 32;

/**
 * The panel's view tabs. Those the header has no room for move into a menu at the end of the row,
 * as an IDE's tool window tabs do; the shown view always keeps its tab, so the menu never hides
 * where the reader is. Widths come from an invisible copy of the row, measured as the panel resizes.
 */
function ViewTabs({ value, options, onChange }: { value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) {
  const { t } = useLingui();
  const box = useRef<HTMLDivElement>(null);
  const ruler = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(options.length);
  const labels = options.map((option) => option.label).join('\0');
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => {
      const widths = [...(ruler.current?.children ?? [])].map((child) => (child as HTMLElement).offsetWidth + 4);
      const room = element.clientWidth;
      const total = widths.reduce((sum, width) => sum + width, 0);
      if (total <= room) { setFit(widths.length); return; }
      let used = MORE_WIDTH;
      let count = 0;
      while (count < widths.length && used + widths[count]! <= room) used += widths[count++]!;
      setFit(Math.max(1, count));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [labels]);

  const active = Math.max(0, options.findIndex((option) => option.value === value));
  // The shown view takes the last place in the row when its own place is in the menu.
  const shown = options.slice(0, fit);
  if (active >= fit && shown.length) shown[shown.length - 1] = options[active]!;
  const hidden = options.filter((option) => !shown.includes(option));

  return (
    <div ref={box} className="relative flex min-w-0 flex-1 items-stretch overflow-hidden">
      <div ref={ruler} aria-hidden className="invisible absolute flex gap-1">
        {options.map((option) => <span key={option.value} className="whitespace-nowrap px-2 text-sm font-medium max-md:px-3 max-md:text-base">{option.label}</span>)}
      </div>
      <UnderlineTabs value={value} onChange={onChange} ariaLabel={t`上下文视图`} options={shown} className="shrink-0" />
      {hidden.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label={t`更多视图`} className={cn('grid w-8 shrink-0 place-items-center text-fg-3 outline-none hover:text-fg focus-visible:text-fg data-[state=open]:text-fg max-md:w-10')}><IconChevronDown className="size-3.5" /></button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-40">
            {hidden.map((option) => <DropdownMenuItem key={option.value} onSelect={() => onChange(option.value)}>{option.label}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
