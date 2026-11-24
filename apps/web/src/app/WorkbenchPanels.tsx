import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
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
import { serverOfObject } from '@/lib/server-routing';
import { cn } from '@/lib/utils';
import { FloatingPanelFrame } from './panels/FloatingPanelFrame';
import { useLists, useNav, useSettings, useStores, useUi } from './state/stores';
import type { CreateShellOptions } from './use-terminal-actions';
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
  const floatingPref = useUi((state) => state.panelFloating);
  const panelFrame = useUi((state) => state.panelFrame);
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
  // Floating is for the wide desktop layout; a narrower window shows the sheet as before.
  const floating = floatingPref && desktop && wide;
  const panel = (current: ProjectRecord) => (
    <ErrorBoundary resetKey={`${current.id}:${panelTab}`}><Suspense fallback={loadingPanel}><ContextPanel
      project={current} sessionId={sessionId} previewTarget={previewTarget} tab={panelTab} onTabChange={(tab) => ui.set({ panelTab: tab })} onReference={onReference} onError={onError}
      onClose={() => ui.setPanelOpen(false)} onOpenWorktree={onOpenWorktree} onWorktreeMerged={onWorktreeMerged}
      {...(desktop && !floating ? { fullscreen: maximized, onToggleFullscreen: () => ui.set((state) => ({ panelFullscreen: !state.panelFullscreen, panelFloating: false })) } : {})}
      {...(desktop && wide ? { floating, onToggleFloating: () => ui.set((state) => ({ panelFloating: !state.panelFloating, panelFullscreen: false })) } : {})}
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
          <div className={cn('relative shrink-0', panelOpen && !floating ? 'w-[calc(var(--panel-w)+8px)]' : 'w-0')}>
            {panelOpen && !maximized && !floating && (
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
          {floating ? (
            <FloatingPanelFrame frame={panelFrame} defaultWidth={panelWidth} shown={panelOpen && expanded} inert={!panelOpen} onCommit={(next) => ui.set({ panelFrame: next })}>
              {panel(project)}
            </FloatingPanelFrame>
          ) : (
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
            <div className={cn('absolute inset-y-0 left-0 flex w-full min-w-(--panel-w)', maximized ? 'bg-canvas' : 'bg-card')}>
              {maximized ? <div className="flex size-full bg-card">{panel(project)}</div> : panel(project)}
            </div>
          </aside>
          )}
        </>
      )}
      {!wide && project && !pageOpen && (
        <Dialog open={panelOpen} onOpenChange={ui.setPanelOpen}>
          <DialogContent mobileFullscreen hideClose aria-describedby={undefined} className={cn('left-auto right-0 top-0 h-dvh max-h-dvh max-w-none translate-x-0 translate-y-0 rounded-none bg-bg p-0 transition-[width] duration-[var(--duration-slow)] ease-out-soft', !maximized ? 'w-[min(400px,92vw)]' : sidebarCollapsed ? 'w-screen' : 'w-[calc(100vw-var(--sidebar-w))]')}>
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
  onCreate: (options?: CreateShellOptions) => Promise<TerminalInfo | undefined>;
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
  const profiles = useSettings((state) => state.terminal?.profiles);
  const localProfiles = serverOfObject(projectId) ? undefined : profiles;
  // An exited shell has nothing left to show, so its tab goes, as in an IDE.
  const shell = useMemo(() => terminals.filter((terminal) => !terminal.sessionId && isShellTerminal(terminal) && terminal.projectId === projectId && terminal.state !== 'exited'), [terminals, projectId]);
  // Opening the dock always shows a shell, so the panel is never an empty strip. Only the transition
  // acts: a dock restored open on load is left alone.
  const wasOpen = useRef(open);
  useEffect(() => {
    const opened = open && !wasOpen.current;
    wasOpen.current = open;
    if (show && opened && shell.length === 0) void onCreate();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the open transition creates
  }, [open]);
  // When the last tab goes, a shell that was live ended (closed or `exit`), so the dock hides, as an
  // IDE's does. Tabs that were never live here (left detached by a server restart and found exited on
  // reconnect) give way to a fresh shell instead, or opening the dock would show nothing.
  const lastShells = useRef({ projectId, shells: shell });
  useEffect(() => {
    const previous = lastShells.current;
    lastShells.current = { projectId, shells: shell };
    if (!show || !open || shell.length > 0 || previous.projectId !== projectId || previous.shells.length === 0) return;
    if (previous.shells.some((terminal) => terminal.state === 'running')) ui.setDockOpen(false);
    else void onCreate();
  }, [onCreate, open, projectId, shell, show, ui]);
  if (!show) return null;
  const dock = (fullscreen: boolean) => (
    // The fallback already stands at the dock's height, so the first open grows once instead of
    // opening to a spinner's height and then jumping when the chunk lands.
    <ErrorBoundary resetKey={projectId ?? ''}><Suspense fallback={fullscreen ? loadingPanel : <div className="flex shrink-0 items-center justify-center edge-t bg-bg" style={{ height }}><Spinner /></div>}><TerminalDock
      {...(fullscreen ? { fullscreen: true } : {})}
      terminals={shell}
      {...(localProfiles ? { profiles: localProfiles } : {})}
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
