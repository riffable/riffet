import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Collapse } from '@/components/ui/collapse';
import { Spinner } from '@/components/ui/controls';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { ResizeHandle } from '@/components/ui/resize-handle';
import type { TerminalInfo } from '@contracts';
import type { ProjectRecord } from '@/lib/api';
import type { PromptContextReference } from '@/lib/api';
import { isShellTerminal } from '@/lib/backends';
import { cn } from '@/lib/utils';
import { useLists, useNav, useStores, useUi } from './state/stores';
import { PANEL_DEFAULT, PANEL_MAX, PANEL_MIN, paintPaneWidth, panelDockMinWidth } from './state/uiStore';
const ContextPanel = lazy(() => import('./panels/ContextPanel').then((module) => ({ default: module.ContextPanel })));
const TerminalDock = lazy(() => import('./terminal/TerminalDock').then((module) => ({ default: module.TerminalDock })));

export const loadingPanel = <div className="flex min-h-0 flex-1 items-center justify-center p-5"><Spinner /></div>;

/**
 * The right-hand context panel: docked beside the conversation on wide screens, a sheet elsewhere.
 * It owns its mount/animation state and reads the panel state itself, so opening, resizing or
 * switching tabs re-renders this, not the workbench.
 */
export function PanelHost({ project, sessionId, desktop, wide, pageOpen, belowTabStrip = false, onReference, onOpenWorktree, onWorktreeMerged, onError }: {
  project?: ProjectRecord;
  sessionId?: string;
  desktop: boolean;
  wide: boolean;
  pageOpen: boolean;
  /** The 独立一行 tab strip spans the top of the window, so the panel starts below it, level with the conversation. */
  belowTabStrip?: boolean;
  onReference: (reference: PromptContextReference) => void;
  onOpenWorktree: (path: string) => void;
  onWorktreeMerged: (info: { originProjectId: string; removedWorktree: boolean }) => void;
  onError: (message: string) => void;
}) {
  const { t } = useLingui();
  const { ui } = useStores();
  const panelOpen = useUi((state) => state.panelOpen);
  const panelWidth = useUi((state) => state.panelWidth);
  const panelTab = useUi((state) => state.panelTab);
  const previewTarget = useUi((state) => state.previewTarget);
  const fullscreen = useUi((state) => state.panelFullscreen);
  const dockOpen = useUi((state) => state.dockOpen);
  const sidebarCollapsed = useUi((state) => state.sidebarCollapsed);
  const projectId = useNav((state) => state.projectId);
  const selectedSessionId = useNav((state) => state.sessionId);
  /** Mounted lazily on first open, then kept so it can animate closed. */
  const [mounted, setMounted] = useState(false);
  /** Starts the panel's slide after its first layout, including the initial mount. */
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { if (panelOpen) setMounted(true); }, [panelOpen]);
  useEffect(() => {
    if (!panelOpen) { setExpanded(false); return; }
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => setExpanded(true)); });
    return () => cancelAnimationFrame(frame);
  }, [panelOpen]);
  // Fullscreen covers the conversation and its terminal dock, so anything that asks for those back
  // (another conversation, the stats page, the dock itself) or closes the panel ends it.
  useEffect(() => { if (!panelOpen || dockOpen || pageOpen) ui.set({ panelFullscreen: false }); }, [panelOpen, dockOpen, pageOpen, ui]);
  useEffect(() => { ui.set({ panelFullscreen: false }); }, [projectId, selectedSessionId, ui]);

  // Phones already show the panel over the whole screen, so fullscreen is a desktop affordance.
  const maximized = fullscreen && desktop;
  const panel = (current: ProjectRecord) => (
    <ErrorBoundary resetKey={`${current.id}:${panelTab}`}><Suspense fallback={loadingPanel}><ContextPanel
      project={current} sessionId={sessionId} previewTarget={previewTarget} tab={panelTab} onTabChange={(tab) => ui.set({ panelTab: tab })} onReference={onReference} onError={onError}
      onClose={() => ui.setPanelOpen(false)} onOpenWorktree={onOpenWorktree} onWorktreeMerged={onWorktreeMerged}
      {...(desktop ? { fullscreen: maximized, onToggleFullscreen: () => ui.set((state) => ({ panelFullscreen: !state.panelFullscreen })) } : {})}
    /></Suspense></ErrorBoundary>
  );
  return (
    <>
      {/* Wide layout reserves room once and slides the panel; narrow layout uses an overlay. */}
      {wide && project && mounted && !pageOpen && (
        <>
          {/* Settle the reading column in one layout pass: animating this width repeatedly
              invalidates transcript measurements and crosses the session overview breakpoint.
              The reservation stays fixed while the panel goes fullscreen. */}
          <div className={cn('relative shrink-0', panelOpen ? 'w-[calc(var(--panel-w)+8px)]' : 'w-0')}>
            {panelOpen && !maximized && (
              // In the gap before the panel, overlapping each side a little.
              <ResizeHandle
                axis="x"
                grow={-1}
                value={panelWidth}
                min={PANEL_MIN}
                // Wider than this and the window could no longer dock the panel beside the conversation.
                max={() => Math.min(PANEL_MAX, window.innerWidth - panelDockMinWidth(ui.get().sidebarCollapsed ? undefined : ui.get().sidebarWidth, 0))}
                label={t`调整面板宽度`}
                onPreview={(width) => paintPaneWidth('panel', width)}
                onChange={(width) => ui.set({ panelWidth: width })}
                onReset={() => ui.set({ panelWidth: PANEL_DEFAULT })}
                className={cn('absolute bottom-2 -left-2.5 w-3', belowTabStrip ? 'top-0' : 'top-2')}
              />
            )}
          </div>
          <aside
            className={cn(
              'absolute bottom-2 right-2 z-(--z-panel) overflow-hidden rounded-xl transition-[translate,width] duration-[var(--duration-slow)] ease-out-soft [[data-resizing]_&]:transition-none',
              belowTabStrip ? 'top-11' : 'top-2',
              !maximized ? 'w-(--panel-w)' : sidebarCollapsed ? 'w-[calc(100%-16px)]' : 'w-[calc(100%-var(--sidebar-w)-8px)]',
              expanded ? 'translate-x-0' : 'translate-x-[calc(100%+8px)]',
            )}
            aria-hidden={!panelOpen || undefined}
            inert={!panelOpen}
          >
            {/* Keep the panel's contents at their docked width throughout the slide. */}
            <div className="absolute inset-y-0 left-0 flex w-full min-w-(--panel-w) bg-bg">
              {panel(project)}
            </div>
          </aside>
        </>
      )}
      {!wide && project && !pageOpen && (
        <Dialog open={panelOpen} onOpenChange={ui.setPanelOpen}>
          <DialogContent mobileFullscreen hideClose aria-describedby={undefined} className={cn('left-auto right-0 top-0 h-dvh max-h-dvh max-w-none translate-x-0 translate-y-0 rounded-none p-0 transition-[width] duration-[var(--duration-slow)] ease-out-soft', !maximized ? 'w-[min(400px,92vw)]' : sidebarCollapsed ? 'w-screen' : 'w-[calc(100vw-var(--sidebar-w))]')}>
            <DialogTitle className="sr-only"><Trans>变更与文件</Trans></DialogTitle>
            {panel(project)}
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

/**
 * The shell-terminal dock: a resizable strip under the conversation on desktop, a full-screen sheet
 * on phones. It reads its own state, so dragging its height does not re-render the workbench.
 */
export function DockHost({ mode, show, onCreate, onChanged, onClose, onError }: {
  mode: 'desktop' | 'mobile';
  /** A project is open and no full-page view covers the dock. */
  show: boolean;
  onCreate: () => void;
  onChanged: (terminal: TerminalInfo) => void;
  onClose: (terminal: TerminalInfo) => void;
  onError: (message: string) => void;
}) {
  const { ui } = useStores();
  const open = useUi((state) => state.dockOpen);
  const height = useUi((state) => state.dockHeight);
  const selectedId = useUi((state) => state.selectedTerminalId);
  const projectId = useNav((state) => state.projectId);
  const terminals = useLists((state) => state.terminals);
  const shell = useMemo(() => terminals.filter((terminal) => !terminal.sessionId && isShellTerminal(terminal) && terminal.projectId === projectId), [terminals, projectId]);
  if (!show) return null;
  const dock = (fullscreen: boolean) => (
    // The fallback already stands at the dock's height, so the first open grows once instead of
    // opening to a spinner's height and then jumping when the chunk lands.
    <ErrorBoundary resetKey={selectedId ?? ''}><Suspense fallback={fullscreen ? loadingPanel : <div className="flex shrink-0 items-center justify-center edge-t bg-bg" style={{ height }}><Spinner /></div>}><TerminalDock
      {...(fullscreen ? { fullscreen: true } : {})}
      terminals={shell}
      selectedId={selectedId}
      height={height}
      onHeightChange={(dockHeight) => ui.set({ dockHeight })}
      onSelect={(id) => ui.set({ selectedTerminalId: id })}
      onCreate={onCreate}
      onHide={() => ui.setDockOpen(false)}
      onChanged={onChanged}
      onClose={onClose}
      onError={onError}
    /></Suspense></ErrorBoundary>
  );
  if (mode === 'desktop') return <Collapse open={open} className="shrink-0 duration-[var(--duration-slow)]">{dock(false)}</Collapse>;
  return (
    <Dialog open={open} onOpenChange={ui.setDockOpen}>
      <DialogContent mobileFullscreen hideClose aria-describedby={undefined} className="p-0">
        <DialogTitle className="sr-only"><Trans>Shell 终端</Trans></DialogTitle>
        {dock(true)}
      </DialogContent>
    </Dialog>
  );
}
