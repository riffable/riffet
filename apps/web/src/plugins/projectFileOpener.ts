import { createContext, useContext } from 'react';
import { useStores } from '../app/state/stores';

/**
 * Where the files a plugin view opens go (a build error's file and line). The side panel's file preview,
 * unless the view is drawn inside a page that reads files itself (`UiKit.ProjectView` in Code Studio).
 */
export const ProjectFileOpener = createContext<((path: string, line?: number) => void) | undefined>(undefined);

export function useOpenProjectFile(): (path: string, line?: number) => void {
  const { ui } = useStores();
  return useContext(ProjectFileOpener) ?? ui.preview;
}
