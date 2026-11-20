import { useCallback, useEffect, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { FILE_BUDGET, type FilePreview } from '@contracts';
import { api, HttpError } from '@/lib/api';
import { confirmDialog } from '@/lib/dialogs';
import { textOf } from '@/lib/errors';
import { toast } from '@/lib/toast';
import { errorMessage } from '@/lib/utils';
import { useGitStatus, watchGitStatus } from '../state/gitStatusStore';
import { fileDrafts, useDraft } from './fileDrafts';

/** Read again this long after the working tree last changed, so a burst of writes reads once. */
const SETTLE_MS = 300;

/**
 * Editing the open file of the files view (docs/guide/workspace.md「编辑与文件操作」). The edit is
 * kept as a draft until it is saved or discarded; the save names the version the edit started from,
 * and the server refuses it when the file has changed since. The file is read again whenever the
 * working tree changes (the Git status stream) or the page comes back into view: one without a draft
 * simply follows the disk, one with a draft is in conflict until the reader keeps one side.
 */
export function useFileEditing({ projectId, preview, onPreview, writable, watching }: {
  projectId: string;
  preview: FilePreview | undefined;
  /** The file as read again, or as just saved. */
  onPreview: (preview: FilePreview) => void;
  /** The server writes files and this one is editable text. */
  writable: boolean;
  /** The view shows this file, so changes on disk matter now. */
  watching: boolean;
}) {
  const { t } = useLingui();
  const path = preview?.path;
  const draft = useDraft(projectId, path);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [comparing, setComparing] = useState(false);
  const conflict = Boolean(draft && preview && draft.base !== preview.hash);

  /** A file just created opens for editing. */
  const startOnOpen = useRef<string | undefined>(undefined);
  // Another file, or the same one again: back to editing only where an edit is kept.
  useEffect(() => {
    setEditing(path !== undefined && (Boolean(fileDrafts.get(projectId, path)) || startOnOpen.current === path));
    if (path !== undefined && startOnOpen.current === path) startOnOpen.current = undefined;
    setComparing(false);
  }, [projectId, path]);
  useEffect(() => { if (!conflict) setComparing(false); }, [conflict]);

  const latest = useRef({ preview, saving, onPreview });
  latest.current = { preview, saving, onPreview };
  const refresh = useCallback(async () => {
    const shown = latest.current.preview;
    if (!shown || latest.current.saving || shown.binary) return;
    try {
      const fresh = await api.preview(projectId, shown.path);
      const now = latest.current.preview;
      if (now?.path === fresh.path && now.hash !== fresh.hash && !latest.current.saving) latest.current.onPreview(fresh);
    } catch { /* gone or unreadable: the next open says so */ }
  }, [projectId]);

  const status = useGitStatus(watching ? projectId : undefined);
  useEffect(() => (watching ? watchGitStatus(projectId) : undefined), [watching, projectId]);
  useEffect(() => {
    if (!watching || !status) return;
    const timer = window.setTimeout(() => void refresh(), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [watching, status, refresh]);
  useEffect(() => {
    if (!watching) return;
    const back = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => { window.removeEventListener('focus', back); document.removeEventListener('visibilitychange', back); };
  }, [watching, refresh]);

  const change = useCallback((text: string) => {
    const shown = latest.current.preview;
    if (!shown) return;
    const kept = fileDrafts.get(projectId, shown.path);
    // Typed back to what is on disk: nothing left to save.
    if ((kept?.base ?? shown.hash) === shown.hash && text === shown.content) fileDrafts.drop(projectId, shown.path);
    else if (!fileDrafts.set(projectId, shown.path, { base: kept?.base ?? shown.hash, text })) {
      toast.error(t`最多同时保留 ${FILE_BUDGET.draftsKept} 个未保存的文件，先保存或放弃其中一些`);
      return;
    }
  }, [projectId, t]);

  /** Resolves true when [file] has nothing unsaved, or the reader chose to lose it. */
  const discard = useCallback(async (file: string) => {
    if (!fileDrafts.get(projectId, file)) return true;
    const confirmed = await confirmDialog({ title: t`放弃未保存的修改？`, confirmLabel: t`放弃修改`, destructive: true });
    if (confirmed) fileDrafts.drop(projectId, file);
    return confirmed;
  }, [projectId, t]);

  /** Writes the draft. In conflict it is written over the version now on disk, which the reader has been shown. */
  const save = useCallback(async () => {
    const shown = latest.current.preview;
    const kept = shown && fileDrafts.get(projectId, shown.path);
    if (!shown || !kept || latest.current.saving) return;
    setSaving(true);
    latest.current.saving = true;
    try {
      const version = await api.saveFile(projectId, shown.path, kept.text, shown.hash);
      // Typed on while it was saving: what was saved is the new base, the rest stays a draft.
      const now = fileDrafts.get(projectId, shown.path);
      if (now && now.text !== kept.text) fileDrafts.set(projectId, shown.path, { base: version.hash, text: now.text });
      else fileDrafts.drop(projectId, shown.path);
      latest.current.onPreview({ ...shown, content: kept.text, hash: version.hash, size: version.size, truncated: false });
    } catch (error) {
      if (error instanceof HttpError && error.code === 'FILE_CHANGED') {
        // Changed on disk meanwhile: show what is there now; the draft stays, in conflict with it.
        try { latest.current.onPreview(await api.preview(projectId, shown.path)); }
        catch (read) { toast.error(errorMessage(read, t`无法读取文件`)); }
      } else {
        const translated = error instanceof HttpError && error.code ? textOf({ code: error.code, ...(error.params ? { params: error.params } : {}) }, error.message) : undefined;
        toast.error(translated ?? errorMessage(error, t`无法保存文件`));
      }
    } finally {
      latest.current.saving = false;
      setSaving(false);
    }
  }, [projectId, t]);

  return {
    /** Shown: the draft while one is kept, else the file. */
    text: draft?.text ?? preview?.content,
    editable: writable && Boolean(preview?.editable),
    editing: editing && writable && Boolean(preview?.editable),
    dirty: Boolean(draft),
    saving,
    conflict,
    /** The disk's text to show the draft against, while comparing. */
    original: conflict && comparing ? preview?.content : undefined,
    comparing,
    setComparing,
    start: () => setEditing(true),
    /** Opens [file] for editing once it is the file shown. */
    startOnOpen: (file: string) => { startOnOpen.current = file; },
    /** Leaves editing; an unsaved edit is discarded, after asking. */
    stop: async () => { if (path !== undefined && await discard(path)) setEditing(false); },
    /** Escape: leaves editing when nothing is unsaved. */
    escape: () => { if (!draft) setEditing(false); },
    change,
    save,
    discard,
    /** In conflict: drop the draft and take the version on disk. */
    takeDisk: async () => { if (path !== undefined) await discard(path); },
  };
}
