import { useCallback } from 'react';
import { useLingui } from '@lingui/react/macro';
import { api, HttpError } from '@/lib/api';
import { confirmDialog, promptDialog } from '@/lib/dialogs';
import { textOf } from '@/lib/errors';
import { toast } from '@/lib/toast';
import { errorMessage } from '@/lib/utils';
import { editorSessions } from './editorSessions';
import { fileDrafts } from './fileDrafts';

const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
const nameOf = (path: string) => path.split('/').at(-1) ?? path;
const parentOf = (path: string) => path.split('/').slice(0, -1).join('/');

/**
 * Creating, renaming and deleting entries of the files view (`apps/server/src/workspace/write.ts`).
 * A deletion happens at once and is undone from its toast; one too large to keep for undo asks first
 * and is then permanent. A rename carries an unsaved edit of the file along with it.
 */
export function useFileOperations({ projectId, onChanged, onCreated, onMoved, onRemoved }: {
  projectId: string;
  /** The listing is stale. */
  onChanged: () => void;
  onCreated: (path: string, kind: 'file' | 'directory') => void;
  onMoved: (from: string, to: string) => void;
  onRemoved: (path: string) => void;
}) {
  const { t } = useLingui();
  const failed = useCallback((error: unknown, fallback: string) => {
    const translated = error instanceof HttpError && error.code ? textOf({ code: error.code, ...(error.params ? { params: error.params } : {}) }, error.message) : undefined;
    toast.error(translated ?? errorMessage(error, fallback));
  }, []);

  const create = useCallback(async (kind: 'file' | 'directory', folder: string) => {
    const name = (await promptDialog({ title: kind === 'file' ? t`新建文件` : t`新建文件夹`, confirmLabel: t`新建` }))?.trim();
    if (!name) return;
    const path = join(folder, name.replace(/^\/+|\/+$/g, ''));
    try { await api.createFile(projectId, path, kind); }
    catch (error) { failed(error, t`无法新建`); return; }
    onChanged();
    onCreated(path, kind);
  }, [projectId, t, failed, onChanged, onCreated]);

  const rename = useCallback(async (from: string) => {
    const name = (await promptDialog({ title: t`重命名`, initial: nameOf(from), confirmLabel: t`重命名` }))?.trim();
    if (!name || name === nameOf(from)) return;
    const to = join(parentOf(from), name.replace(/^\/+|\/+$/g, ''));
    try { await api.moveFile(projectId, from, to); }
    catch (error) { failed(error, t`无法重命名`); return; }
    fileDrafts.move(projectId, from, to);
    editorSessions.move(projectId, from, to);
    onChanged();
    onMoved(from, to);
  }, [projectId, t, failed, onChanged, onMoved]);

  const remove = useCallback(async (path: string) => {
    // The undo brings back the file as it is on disk, not edits that were never saved.
    if (fileDrafts.heldUnder(projectId, path)) {
      const name = nameOf(path);
      if (!await confirmDialog({ title: t`删除「${name}」？`, description: t`未保存的修改会丢失，撤销删除也不会恢复它们。`, confirmLabel: t`删除`, destructive: true })) return;
    }
    let restoreId: string | undefined;
    try { restoreId = (await api.deleteFile(projectId, path)).restoreId; }
    catch (error) {
      if (!(error instanceof HttpError && error.code === 'DELETE_UNRECOVERABLE')) { failed(error, t`无法删除`); return; }
      const name = nameOf(path);
      if (!await confirmDialog({ title: t`永久删除「${name}」？`, description: t`它太大，删除后无法撤销。`, confirmLabel: t`永久删除`, destructive: true })) return;
      try { await api.deleteFile(projectId, path, true); }
      catch (again) { failed(again, t`无法删除`); return; }
    }
    // An unsaved edit of a deleted file goes with it; the undo brings back the file as it was on disk.
    fileDrafts.dropUnder(projectId, path);
    editorSessions.dropUnder(projectId, path);
    onChanged();
    onRemoved(path);
    if (!restoreId) return;
    const id = restoreId;
    toast.success(t`已删除「${nameOf(path)}」`, { action: { label: t`撤销`, onClick: () => {
      void api.restoreFile(projectId, id).then(() => onChanged(), (error) => failed(error, t`无法撤销删除`));
    } } });
  }, [projectId, t, failed, onChanged, onRemoved]);

  return { create, rename, remove };
}
