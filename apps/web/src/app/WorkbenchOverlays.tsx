import { useEffect, useState } from 'react';
import type { Session } from '@contracts';
import type { MessageSearchHit, ProjectRecord } from '@/lib/api';
import { isQuickChatProject, regularProjects } from '@/lib/project-family';
import { serverOfObject } from '@/lib/server-routing';
import { AddProjectDialog } from './AddProjectDialog';
import { CommandPalette, type PaletteAction, type PaletteScope } from './CommandPalette';
import { DirectoryPicker } from './DirectoryPicker';
import { ImportSessionDialog } from './ImportSessionDialog';
import { SessionDeletionDialog } from './SessionDeletion';
import { whenIdle } from './session/useEarlierHistory';
import { useLists, useNav, useStores, useUi } from './state/stores';
import { PluginDirectoryHost } from '../plugins/DirectoryRequest';

/**
 * Dialogs opened from anywhere (add project, command palette, directory browser). Each reads its
 * own open state, so opening one re-renders this and nothing else.
 */
export function WorkbenchOverlays({ addProject, paletteActions, startSessionInDirectory, onSelectSession, onSelectProject, onOpenMessage, onImported, onError }: {
  addProject: (input: { cwd: string; name?: string }, server?: string) => Promise<boolean>;
  paletteActions: () => PaletteAction[];
  startSessionInDirectory: (path: string, server?: string) => Promise<void>;
  onSelectSession: (session: Session) => void;
  onSelectProject: (project: ProjectRecord) => void;
  onOpenMessage: (hit: MessageSearchHit) => void;
  onImported: (session: Session) => Promise<void>;
  onError: (message: string) => void;
}) {
  const { ui } = useStores();
  const addProjectOpen = useUi((state) => state.addProjectOpen);
  const paletteOpen = useUi((state) => state.paletteOpen);
  const searchOpen = useUi((state) => state.searchOpen);
  const importSession = useUi((state) => state.importSession);
  const directoryOpen = useUi((state) => state.sessionDirectoryOpen);
  const directoryServer = useUi((state) => state.sessionDirectoryServer);
  const projects = useLists((state) => state.projects);
  const sessions = useLists((state) => state.sessions);
  const projectId = useNav((state) => state.projectId);
  const sessionId = useNav((state) => state.sessionId);
  const project = projects.find((item) => item.id === projectId);
  const quickChat = isQuickChatProject(project);
  /** What followed `>` in the search box; cleared once the palette closes, so ⌘⇧P opens empty. */
  const [paletteQuery, setPaletteQuery] = useState('');
  useEffect(() => { if (!paletteOpen) setPaletteQuery(''); }, [paletteOpen]);
  /** ⌘K and ⇧⌘P open one palette in two scopes; a closing palette keeps the scope it was showing. */
  const [lastScope, setLastScope] = useState<PaletteScope>('search');
  const scope: PaletteScope = paletteOpen ? 'commands' : searchOpen ? 'search' : lastScope;
  useEffect(() => { if (paletteOpen || searchOpen) setLastScope(paletteOpen ? 'commands' : 'search'); }, [paletteOpen, searchOpen]);
  // Fetched while the page is idle, so opening settings rarely waits on its chunk.
  useEffect(() => whenIdle(() => void import('./settings/SettingsPage')), []);

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
        onOpenChange={(open) => ui.set({ sessionDirectoryOpen: open, ...(!open ? { sessionDirectoryServer: undefined } : {}) })}
        initialPath={(() => {
          if (quickChat) return undefined;
          const target = directoryServer !== undefined ? directoryServer : (serverOfObject(project?.id) ?? '');
          return target === (serverOfObject(project?.id) ?? '') ? project?.cwd : undefined;
        })()}
        server={directoryServer !== undefined ? (directoryServer || undefined) : (quickChat ? undefined : serverOfObject(project?.id))}
        chooseServer
        onPick={(path, server) => void startSessionInDirectory(path, server)}
        onError={onError}
      />
      <PluginDirectoryHost />
    </>
  );
}
