import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { Trans } from '@lingui/react/macro';
import type { Session } from '@contracts';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Spinner } from '@/components/ui/controls';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import type { MessageSearchHit, ProjectRecord } from '@/lib/api';
import { isQuickChatProject, regularProjects } from '@/lib/project-family';
import { AddProjectDialog } from './AddProjectDialog';
import { CommandPalette, type PaletteAction, type PaletteScope } from './CommandPalette';
import { DirectoryPicker } from './DirectoryPicker';
import { ImportSessionDialog } from './ImportSessionDialog';
import { SessionDeletionDialog } from './SessionDeletion';
import { whenIdle } from './session/useEarlierHistory';
import { SETTINGS_DIALOG_CLASS } from './settings/settingsSections';
import { useLists, useNav, useSettings, useStores, useUi } from './state/stores';
type SettingsDialogType = typeof import('./settings/SettingsDialog').SettingsDialog;
/** Set once the chunk has loaded, so a later first open renders it directly instead of suspending for a tick. */
let loadedSettingsDialog: SettingsDialogType | undefined;
const loadSettingsDialog = () => import('./settings/SettingsDialog').then((module) => {
  loadedSettingsDialog = module.SettingsDialog;
  return module;
});
const LazySettingsDialog = lazy(() => loadSettingsDialog().then((module) => ({ default: module.SettingsDialog })));

/** Stands in while the settings chunk loads, and tells the dialog it has already made its entrance. */
function SettingsLoading({ frame, onShown }: { frame: (children: ReactNode) => ReactNode; onShown: () => void }) {
  useLayoutEffect(onShown, [onShown]);
  return frame(<div className="grid h-full place-items-center"><Spinner /></div>);
}

/**
 * Dialogs opened from anywhere (add project, command palette, directory browser, settings). Each
 * reads its own open state, so opening one re-renders this and nothing else.
 */
export function WorkbenchOverlays({ addProject, paletteActions, startSessionInDirectory, onRefreshBackends, onLogout, onSelectSession, onSelectProject, onOpenMessage, onImported, onError }: {
  addProject: (input: { cwd: string; name?: string }) => Promise<boolean>;
  paletteActions: () => PaletteAction[];
  startSessionInDirectory: (path: string) => Promise<void>;
  onRefreshBackends: () => Promise<void>;
  onLogout?: (() => void) | undefined;
  onSelectSession: (session: Session) => void;
  onSelectProject: (project: ProjectRecord) => void;
  onOpenMessage: (hit: MessageSearchHit) => void;
  onImported: (session: Session) => Promise<void>;
  onError: (message: string) => void;
}) {
  const { ui, settings: settingsStore } = useStores();
  const addProjectOpen = useUi((state) => state.addProjectOpen);
  const paletteOpen = useUi((state) => state.paletteOpen);
  const searchOpen = useUi((state) => state.searchOpen);
  const importSession = useUi((state) => state.importSession);
  const directoryOpen = useUi((state) => state.sessionDirectoryOpen);
  const settingsOpen = useUi((state) => state.settingsOpen);
  const settingsMounted = useUi((state) => state.settingsMounted);
  const pendingSection = useUi((state) => state.pendingSettingsSection);
  const pendingProviderTarget = useUi((state) => state.pendingProviderTarget);
  const projects = useLists((state) => state.projects);
  const sessions = useLists((state) => state.sessions);
  const projectId = useNav((state) => state.projectId);
  const sessionId = useNav((state) => state.sessionId);
  const project = projects.find((item) => item.id === projectId);
  const quickChat = isQuickChatProject(project);
  const settings = useSettings((value) => value);
  /** What followed `>` in the search box; cleared once the palette closes, so ⌘⇧P opens empty. */
  const [paletteQuery, setPaletteQuery] = useState('');
  useEffect(() => { if (!paletteOpen) setPaletteQuery(''); }, [paletteOpen]);
  /** ⌘K and ⇧⌘P open one palette in two scopes; a closing palette keeps the scope it was showing. */
  const [lastScope, setLastScope] = useState<PaletteScope>('search');
  const scope: PaletteScope = paletteOpen ? 'commands' : searchOpen ? 'search' : lastScope;
  useEffect(() => { if (paletteOpen || searchOpen) setLastScope(paletteOpen ? 'commands' : 'search'); }, [paletteOpen, searchOpen]);
  // Fetched while the page is idle, so opening settings rarely waits on its chunk.
  useEffect(() => whenIdle(() => void loadSettingsDialog()), []);
  // Chosen once, when settings first mount: switching between the lazy wrapper and the loaded
  // component while mounted would remount the dialog and lose its state.
  const [SettingsDialog, setSettingsDialog] = useState<SettingsDialogType | typeof LazySettingsDialog>();
  if (settingsMounted && !SettingsDialog) setSettingsDialog(() => loadedSettingsDialog ?? LazySettingsDialog);
  /** The settings chunk was still loading when the dialog opened, so its frame played the entrance. */
  const [settingsEntered, setSettingsEntered] = useState(false);
  const markSettingsEntered = useCallback(() => setSettingsEntered(true), []);
  useEffect(() => { if (!settingsOpen) setSettingsEntered(false); }, [settingsOpen]);
  /** The settings dialog's frame, for its loading state and for a failure inside it; the same box as the dialog. */
  const settingsFrame = (children: ReactNode) => (
    <Dialog open={settingsOpen} onOpenChange={(open) => ui.set({ settingsOpen: open })}>
      <DialogContent size="workspace" mobileFullscreen aria-describedby={undefined} className={SETTINGS_DIALOG_CLASS}>
        <DialogTitle className="sr-only"><Trans>设置</Trans></DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  );
  return (
    <>
      <SessionDeletionDialog />
      <AddProjectDialog open={addProjectOpen} onOpenChange={(open) => ui.set({ addProjectOpen: open })} onSubmit={addProject} onError={onError} />
      <CommandPalette
        open={paletteOpen || searchOpen}
        scope={scope}
        onOpenChange={(open) => { if (!open) ui.set({ paletteOpen: false, searchOpen: false }); }}
        onScopeChange={(next, query) => {
          if (next === 'commands') { setPaletteQuery(query); ui.openPalette(); } else ui.openSearch();
        }}
        search={{ sessions, projects, ...(sessionId ? { currentSessionId: sessionId } : {}), onSelectSession, onOpenMessage }}
        sessions={sessions}
        projects={regularProjects(projects)}
        actions={paletteActions}
        initialQuery={paletteQuery}
        onSelectSession={onSelectSession}
        onSelectProject={onSelectProject}
      />
      <ImportSessionDialog
        open={Boolean(importSession)}
        onOpenChange={(open) => { if (!open) ui.set({ importSession: undefined }); }}
        project={importSession?.projectId ? projects.find((item) => item.id === importSession.projectId) : undefined}
        onImported={onImported}
        onError={onError}
      />
      <DirectoryPicker
        open={directoryOpen}
        onOpenChange={(open) => ui.set({ sessionDirectoryOpen: open })}
        initialPath={quickChat ? undefined : project?.cwd}
        onPick={(path) => void startSessionInDirectory(path)}
        onError={onError}
      />
      {settingsMounted && SettingsDialog && <ErrorBoundary resetKey={String(settingsOpen)} frame={settingsFrame}><Suspense fallback={<SettingsLoading frame={settingsFrame} onShown={markSettingsEntered} />}><SettingsDialog
        open={settingsOpen}
        framed={settingsEntered}
        onOpenChange={(open) => { ui.set({ settingsOpen: open }); if (!open) ui.clearProviderTarget(); }}
        {...(pendingSection ? { initialSection: pendingSection } : {})}
        {...(pendingProviderTarget ? { providerTarget: pendingProviderTarget } : {})}
        onProviderTargetHandled={(token) => ui.clearProviderTarget(token)}
        project={quickChat ? undefined : project}
        settings={settings}
        onRefreshBackends={onRefreshBackends}
        onSettingsChanged={settingsStore.applySaved}
        onLogout={onLogout}
        onError={onError}
      /></Suspense></ErrorBoundary>}
    </>
  );
}
