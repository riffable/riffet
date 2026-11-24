import { useMemo } from 'react';
import type { ProjectViewInfo, ProjectViewProps } from '@riffet/plugin-web';
import { useStore } from '@/lib/store';
import { useProjectTypes } from '@/lib/tasks';
import { useViewPrefs } from '../app/session/viewPrefs';
import { useHasGit } from '../app/state/gitStatusStore';
import { useStores } from '../app/state/stores';
import { matches, type ViewEntry } from './catalog';
import { PluginView } from './PluginView';
import { ProjectFileOpener } from './projectFileOpener';
import { useViewCatalog } from './registry';
import { viewIcon } from './viewIcons';

const NO_CAPABILITIES: ReadonlySet<string> = new Set();
const GIT_CAPABILITIES: ReadonlySet<string> = new Set(['git']);

/**
 * The side panel's plugin views of a project, for a page with no conversation: per-project views only (one that
 * belongs to a conversation has none here), judged by the same facts as the side panel (`useSidebarViews`) with
 * `hasSession` false, without the ones the reader hid there, nor the asking plugin's own.
 */
function useProjectViews(projectId: string | undefined, self: string | undefined): ViewEntry[] {
  const { lists } = useStores();
  const project = useStore(lists, (state) => state.projects.find((item) => item.id === projectId));
  const catalog = useViewCatalog();
  const hasGit = useHasGit(project);
  const projectTypes = useProjectTypes(project?.id);
  const hidden = useViewPrefs((state) => state.sidebarHidden);
  return useMemo(() => (project ? catalog.filter((view) => view.location === 'sidebar' && view.pluginId && view.pluginId !== self && view.instances === 'per-project' && !hidden.includes(view.id)
    && matches(view.when, { hasProject: true, hasSession: false, projectSystem: project.system, capabilities: hasGit ? GIT_CAPABILITIES : NO_CAPABILITIES, projectTypes })) : []),
  [catalog, project, self, hidden, hasGit, projectTypes]);
}

const NO_VIEWS: readonly ProjectViewInfo[] = [];

/** `PluginHost.useProjectViews` for the plugin `self`: a hook, one function per plugin so it holds across renders. */
const hooks = new Map<string, (projectId: string | undefined) => readonly ProjectViewInfo[]>();
export function projectViewsHook(self: string | undefined): (projectId: string | undefined) => readonly ProjectViewInfo[] {
  const key = self ?? '';
  let hook = hooks.get(key);
  if (!hook) {
    hook = function useProjectViewInfos(projectId: string | undefined) {
      const views = useProjectViews(projectId, self);
      return useMemo(() => (views.length ? views.map((view) => ({ id: view.id, title: view.title, icon: viewIcon(view) })) : NO_VIEWS), [views]);
    };
    hooks.set(key, hook);
  }
  return hook;
}

/** `UiKit.ProjectView`: one of those views drawn in the asking page, its file links handed to `onOpenFile`. */
export function PluginProjectView({ projectId, viewId, visible = true, onOpenFile }: ProjectViewProps) {
  const catalog = useViewCatalog();
  const entry = catalog.find((view) => view.id === viewId && view.location === 'sidebar');
  if (!entry) return null;
  return (
    <ProjectFileOpener.Provider value={onOpenFile}>
      <PluginView entry={entry} projectId={projectId} visible={visible} />
    </ProjectFileOpener.Provider>
  );
}
