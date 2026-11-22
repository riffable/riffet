import { useCallback, useRef } from 'react';
import { useLingui } from '@lingui/react/macro';
import { api, apiFor, type Bootstrap, type ProjectRecord } from '@/lib/api';
import { serverOfObject } from '@/lib/server-routing';
import { promptDialog } from '@/lib/dialogs';
import { toast } from '@/lib/toast';
import { hostInfo } from '@/lib/platform';
import { errorMessage } from '@/lib/utils';
import type { EntityAction } from './Sidebar';
import { useStores } from './state/stores';
import { clearContext, parseTags } from './use-session-actions';

/** Adding, editing and archiving projects, and moving between directories and worktrees. */
export function useProjectActions({ project, loadBootstrap, selectProject }: {
  project: ProjectRecord | undefined;
  loadBootstrap: () => Promise<Bootstrap>;
  selectProject: (next: ProjectRecord) => void;
}) {
  const { t } = useLingui();
  const { lists, nav, ui } = useStores();
  const worktreePending = useRef(false);

  const projectAction = async (target: ProjectRecord, action: EntityAction) => {
    try {
      if (action === 'rename') {
        const name = await promptDialog({ title: t`重命名项目`, initial: target.name, confirmLabel: t`保存`, multiline: true });
        if (!name?.trim() || name.trim() === target.name) return;
        lists.replaceProject(await api.updateProject(target.id, { name: name.trim() }));
      } else if (action === 'tags') {
        const value = await promptDialog({ title: t`项目标签`, description: t`多个标签用逗号分隔`, initial: (target.tags ?? []).join(', '), confirmLabel: t`保存` });
        if (value === null) return;
        lists.replaceProject(await api.updateProject(target.id, { tags: parseTags(value) }));
      } else {
        // Archiving is reversible, so it asks nothing up front and offers 撤销 afterwards instead.
        const archiving = !target.archivedAt;
        const wasSelected = nav.get().projectId === target.id;
        if (archiving && wasSelected && !(await nav.navigate(() => {}))) return;
        const updated = await api.updateProject(target.id, { archived: archiving });
        lists.replaceProject(updated);
        if (archiving && wasSelected) await nav.navigate(() => {
          nav.set({ projectId: lists.get().projects.find((item) => item.id !== target.id && !item.archivedAt)?.id ?? '', sessionId: '' });
        });
        if (archiving) toast.success(t`项目已归档`, { action: { label: t`撤销`, onClick: () => void projectAction(updated, 'archive').then(() => { if (wasSelected) selectProject(updated); }) } });
      }
    } catch (error) { toast.error(errorMessage(error, t({ message: '操作失败', context: 'workbench-action-failed' }))); }
  };

  /**
   * A project made on a linked server goes into its list at once: reloading waits only for the entry's lists, so
   * the linked server's would land later and the project would be selected before any list held it.
   */
  const addProject = async (input: { cwd: string; name?: string }, server?: string) => {
    try {
      const created = await apiFor(server).createProject(input);
      if (server) lists.upsertProject(created, server);
      await loadBootstrap();
      if (!(await nav.navigate(() => {
        clearContext(ui);
        nav.rememberTaskProject(created.system === 'task-workspace' ? null : created.id);
        nav.set({ projectId: created.id, sessionId: '' });
        ui.set({ addProjectOpen: false });
      }))) return false;
      return true;
    } catch (error) { toast.error(errorMessage(error, t`无法添加项目`)); return false; }
  };

  /**
   * Lands on a project's empty composer after the lists were reloaded. The composer itself shows
   * where it landed; the message is only for a move that is easy to miss (into a worktree).
   */
  const landOn = useCallback((target: ProjectRecord, message?: string) => async () => {
    if (!(await nav.navigate(() => {
      clearContext(ui);
      nav.rememberTaskProject(target.system === 'task-workspace' ? null : target.id);
      nav.set({ projectId: target.id, sessionId: '' });
    }))) return;
    if (message) toast.success(message);
  }, [nav, ui]);

  /**
   * Bind a directory that has no project yet and land on its empty composer, so "New Session" can
   * start anywhere on the machine. The server canonicalizes the path and returns the existing
   * project when the directory is already registered, which keeps this idempotent.
   */
  const startSessionInDirectory = useCallback(async (path: string, server?: string) => {
    try {
      let target = await apiFor(server).createProject({ cwd: path });
      if (target.archivedAt) target = await apiFor(server).updateProject(target.id, { archived: false });
      if (server) lists.upsertProject(target, server);
      await loadBootstrap();
      await landOn(target)();
    } catch (error) { toast.error(errorMessage(error, t`无法使用该目录开始会话`)); }
  }, [lists, loadBootstrap, landOn, t]);

  /** Names a new checkout before creating it; leaving the name empty asks the server to generate it. */
  const startIsolatedDirectory = useCallback(async () => {
    if (!project || worktreePending.current || ui.get().creatingWorktree) return;
    const originProjectId = project.id;
    worktreePending.current = true;
    try {
      const value = await promptDialog({ title: t`新建 Worktree`, label: t`名称`, placeholder: t`留空自动生成`, confirmLabel: t`创建` });
      if (value === null) return;
      const name = value.trim();
      ui.set({ creatingWorktree: true });
      const target = await api.createWorktreeProject(originProjectId, name ? { name } : {});
      lists.upsertProject(target, serverOfObject(originProjectId));
      await loadBootstrap();
      await landOn(target, t`已切换到 ${target.worktree?.branch ?? target.name}`)();
    } catch (error) { toast.error(errorMessage(error, t({ message: '无法创建 Worktree', context: 'workbench-worktree-create-failed' }))); }
    finally { worktreePending.current = false; ui.set({ creatingWorktree: false }); }
  }, [project, lists, ui, loadBootstrap, landOn, t]);

  /** Adopts a worktree that already exists, so a conversation can run in it. */
  const openWorktreeProject = useCallback(async (path: string) => {
    if (!project) return;
    try {
      const target = await api.createWorktreeProject(project.id, { path });
      lists.upsertProject(target, serverOfObject(project.id));
      await loadBootstrap();
      await landOn(target, t`已切换到 ${target.worktree?.branch ?? target.name}`)();
    } catch (error) { toast.error(errorMessage(error, t`无法打开该 Worktree`)); }
  }, [project, lists, loadBootstrap, landOn, t]);

  /** A removed worktree archives its project, so the origin is where the work now lives. */
  const onWorktreeMerged = useCallback(({ originProjectId, removedWorktree }: { originProjectId: string; removedWorktree: boolean }) => {
    if (!removedWorktree) return;
    void loadBootstrap().then(() => nav.navigate(() => {
      ui.set({ previewTarget: undefined });
      nav.set({ projectId: originProjectId, sessionId: '', attemptsGroupId: '' });
    })).catch((error) => toast.error(errorMessage(error, t`无法刷新项目列表`)));
  }, [loadBootstrap, nav, ui, t]);

  /**
   * New Session's "choose another directory": prefer the host's native folder chooser (the only way
   * to get a real absolute path on that machine), and fall back to the in-app browser when the host
   * cannot drive one — the same two-step the "add project" dialog uses. The chooser opens on the
   * server's screen, so a reader on another machine goes straight to the in-app browser.
   */
  const chooseSessionDirectory = useCallback(async (targetServer?: string) => {
    ui.setMobileSidebar(false);
    const server = targetServer !== undefined ? (targetServer || undefined) : serverOfObject(project?.id);
    // The chooser can only open on the entry server's screen; a linked server always browses in the app.
    if (!hostInfo().local || server) { ui.set({ sessionDirectoryOpen: true, sessionDirectoryServer: server ?? '' }); return; }
    try {
      const picked = await api.pickDirectory({ prompt: t`选择新会话的目录` });
      if (picked.cancelled) return;
      if (picked.path) { await startSessionInDirectory(picked.path); return; }
    } catch (error) {
      // Hosts with no chooser we can drive land here, and so does a real server fault. Keep the
      // breadcrumb: the in-app browser is about to cover that failure up, and if the browse call
      // fails too the user only sees the second error.
      console.warn('native directory picker unavailable; falling back to the in-app browser', error);
    }
    ui.set({ sessionDirectoryOpen: true, sessionDirectoryServer: '' });
  }, [project?.id, ui, startSessionInDirectory, t]);

  const openInEditor = useCallback((path: string, line?: number) => {
    if (!project?.id) return;
    void api.openInEditor(project.id, path, line).catch((error) => toast.error(errorMessage(error, t({ message: '无法在编辑器中打开', context: 'workbench-open-in-editor-failed' }))));
  }, [project?.id, t]);

  return { projectAction, addProject, startSessionInDirectory, startIsolatedDirectory, openWorktreeProject, onWorktreeMerged, chooseSessionDirectory, openInEditor };
}
