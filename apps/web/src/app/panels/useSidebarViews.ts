import { useMemo } from 'react';
import type { ProjectRecord } from '@/lib/api';
import { useProjectTypes } from '@/lib/tasks';
import { matches, type ViewEntry } from '@/plugins/catalog';
import { useViewCatalog } from '@/plugins/registry';
import { orderViews, useViewPrefs } from '../session/viewPrefs';
import { useHasGit } from '../state/gitStatusStore';

const NO_CAPABILITIES: ReadonlySet<string> = new Set();
const GIT_CAPABILITIES: ReadonlySet<string> = new Set(['git']);

/** The side panel's views offered for this project and session now, in the reader's order and without the ones they turned off. */
export function useSidebarViews(project: ProjectRecord | undefined, sessionId: string | undefined): ViewEntry[] {
  const catalog = useViewCatalog();
  const hasGit = useHasGit(project);
  const projectTypes = useProjectTypes(project?.id);
  const hasSession = Boolean(sessionId);
  const hasProject = Boolean(project);
  const order = useViewPrefs((state) => state.sidebarOrder);
  const hidden = useViewPrefs((state) => state.sidebarHidden);
  return useMemo(() => {
    // The 个人助理's directory is not a project to browse: its git history is its memory, not changes to review,
    // and the file routes refuse it (it lives in the state directory). Its memory has its own reader (docs/ASSISTANT.md §3.2).
    const own = project?.system === 'assistant';
    const capabilities = hasGit && !own ? GIT_CAPABILITIES : NO_CAPABILITIES;
    const offered = catalog.filter((view) => view.location === 'sidebar' && !hidden.includes(view.id) && !(own && view.id === 'files') && matches(view.when, { hasProject, hasSession, capabilities, projectTypes }));
    return orderViews(offered, order);
  }, [catalog, order, hidden, hasProject, hasSession, hasGit, projectTypes, project?.system]);
}

/**
 * The view the panel shows for the stored choice `tab`: that one if it is offered, else the first
 * that is. The stored choice is kept, so the view comes back when it is offered again. The panel,
 * the header, the session info and the palette all read this, so they agree on what is shown.
 */
export function shownView(views: readonly ViewEntry[], tab: string): ViewEntry | undefined {
  return views.find((view) => view.id === tab) ?? views[0];
}
