import { lazy, type ComponentType } from 'react';
import type { ProjectRecord, PromptContextReference } from '@/lib/api';
import { useUi } from '../state/stores';

/** A preview request pushed in from elsewhere in the app (e.g. a tool row's file chip). */
export interface PreviewTarget { path: string; line?: number; token: number }

/** What the side panel hands the body of one of the app's own views. */
export interface SidebarBodyProps {
  project: ProjectRecord;
  sessionId?: string | undefined;
  previewTarget?: PreviewTarget | undefined;
  /** This is the view the panel shows now. */
  shown: boolean;
  /** The panel spans the conversation area, with room for an IDE's two columns. */
  wide?: boolean | undefined;
  /** Where the view may place its own controls in the panel's header; `null` until the header is mounted. */
  headerSlot: HTMLElement | null;
  /** Makes this the shown view, for a request (a file preview) that needs it. */
  show: () => void;
  onReference: (reference: PromptContextReference) => void;
  onError: (message: string) => void;
  onClose: () => void;
  onOpenWorktree?: ((path: string) => void) | undefined;
  onWorktreeMerged?: ((result: { originProjectId: string; removedWorktree: boolean }) => void) | undefined;
}

const FilesPanel = lazy(() => import('./FilesPanel').then((module) => ({ default: module.FilesPanel })));
const GitPanel = lazy(() => import('./GitPanel').then((module) => ({ default: module.GitPanel })));

function ChangesBody({ project, sessionId, onError, onOpenWorktree, onWorktreeMerged }: SidebarBodyProps) {
  const panelOpen = useUi((state) => state.panelOpen);
  return <GitPanel key={project.id} project={project} sessionId={sessionId} active={panelOpen} onError={onError} onOpenWorktree={onOpenWorktree} onMerged={onWorktreeMerged} />;
}

/**
 * The bodies of the app's own sidebar views, by view id. A view in the catalog that is not here is
 * a plugin's, which the panel draws through its renderer, so a new view needs no change to the panel.
 * `keepAlive` bodies stay mounted once shown, drawing nothing while another view shows.
 */
export const hostSidebarBodies: Readonly<Record<string, { Body: ComponentType<SidebarBodyProps>; keepAlive?: boolean }>> = {
  files: { Body: FilesPanel, keepAlive: true },
  changes: { Body: ChangesBody },
};
