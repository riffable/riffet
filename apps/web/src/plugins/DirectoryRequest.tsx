import { useLingui } from '@lingui/react/macro';
import { api, apiFor } from '@/lib/api';
import { hostInfo } from '@/lib/platform';
import { createStore, useStore } from '@/lib/store';
import { toast } from '@/lib/toast';
import { errorMessage } from '@/lib/utils';
import { DirectoryPicker } from '../app/DirectoryPicker';
import type { WorkbenchStores } from '../app/state/stores';

interface Request { server?: string; initialPath?: string; resolve(picked: { path: string; server: string | undefined } | undefined): void }
const store = createStore<{ current?: Request }>({});

/** The app's folder browser, as a promise: resolves with the folder chosen, or `undefined` when it is closed. */
function browse(options: { server?: string; initialPath?: string }): Promise<{ path: string; server: string | undefined } | undefined> {
  store.get().current?.resolve(undefined);
  return new Promise((resolve) => store.set({ current: { ...options, resolve } }));
}

/**
 * `SessionService.openDirectory`: chooses a folder as New Session's "choose another directory" does (the native
 * chooser on the entry server's own screen, else the in-app browser, which can browse a linked server), then
 * registers it as a project, or finds the project it already is. Resolves to the project's id.
 */
export async function openDirectory(lists: WorkbenchStores['lists'], options: { server?: string; initialPath?: string; prompt: string; failed: string }): Promise<string | undefined> {
  let picked: { path: string; server: string | undefined } | undefined;
  if (!options.server && hostInfo().local) {
    try {
      const native = await api.pickDirectory({ prompt: options.prompt, ...(options.initialPath ? { defaultPath: options.initialPath } : {}) });
      if (native.cancelled) return undefined;
      if (native.path) picked = { path: native.path, server: undefined };
    } catch { /* No chooser this host can drive: the in-app browser below. */ }
  }
  picked ??= await browse({ ...(options.server ? { server: options.server } : {}), ...(options.initialPath ? { initialPath: options.initialPath } : {}) });
  if (!picked) return undefined;
  try {
    let project = await apiFor(picked.server).createProject({ cwd: picked.path });
    if (project.archivedAt) project = await apiFor(picked.server).updateProject(project.id, { archived: false });
    lists.upsertProject(project, picked.server);
    return project.id;
  } catch (error) {
    toast.error(errorMessage(error, options.failed));
    return undefined;
  }
}

/** Draws the folder browser `openDirectory` asked for; mounted once in the workbench. */
export function PluginDirectoryHost() {
  const { t } = useLingui();
  const request = useStore(store, (state) => state.current);
  const settle = (picked?: { path: string; server: string | undefined }) => {
    const current = store.get().current;
    if (!current) return;
    store.set({ current: undefined });
    current.resolve(picked);
  };
  return (
    <DirectoryPicker
      open={Boolean(request)}
      onOpenChange={(open) => { if (!open) settle(); }}
      {...(request?.initialPath ? { initialPath: request.initialPath } : {})}
      {...(request?.server ? { server: request.server } : {})}
      chooseServer
      onPick={(path, server) => settle({ path, server })}
      onError={(message) => toast.error(message || t`无法打开目录`)}
    />
  );
}
