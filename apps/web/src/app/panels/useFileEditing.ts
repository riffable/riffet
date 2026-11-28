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
/** The editor keeps `\n` whatever the file uses; the server writes the file's own line endings back. */
const lines = (text: string) => text.replace(/\r\n?/g, '\n');

/**
 * Editing the open file of the files view (docs/guide/workspace.md「编辑与文件操作」). The edit is
 * kept as a draft until it is saved or discarded; the save names the version the edit started from,
 * and the server refuses it when the file has changed since. The file is read again whenever the
 * working tree changes (the Git status stream) or the page comes back into view: one without a draft
 * simply follows the disk, one with a draft is in conflict until the reader keeps one side.
 */
export function useFileEditing({ projectId, preview, onPreview, writable, watching, defaultEditing = false, onSaved }: {
  projectId: string;
  preview: FilePreview | undefined;
  /** The file as read again, or as just saved. */
  onPreview: (preview: FilePreview) => void;
  /** The server writes files and this one is editable text. */
  writable: boolean;
  /** The view shows this file, so changes on disk matter now. */
  watching: boolean;
  /** Start directly in editing mode whenever a writable file opens (used by Code Studio on desktop). */
  defaultEditing?: boolean;
  /** Called after a save succeeds (single save or Save All). */
  onSaved?: (path: string) => void;
}) {
  const { t } = useLingui();
  const path = preview?.path;
  const draft = useDraft(projectId, path);
  const [editing, setEditing] = useState(defaultEditing);
  /** The file being written, if any; another file can be edited and refreshed meanwhile. */
  const [savingPath, setSavingPath] = useState<string>();
  const [comparing, setComparing] = useState(false);
  const conflict = Boolean(draft && preview && draft.base !== preview.hash);

  /** Whether [file] may be edited now: it holds an edit already, or another can still be kept. */
  const roomFor = useCallback((file: string) => {
    if (fileDrafts.get(projectId, file) || !fileDrafts.full()) return true;
    toast.error(t`最多同时保留 ${FILE_BUDGET.draftsKept} 个未保存的文件，先保存或放弃其中一些`);
    return false;
  }, [projectId, t]);
  /** A file just created opens for editing. */
  const startOnOpen = useRef<string | undefined>(undefined);
  // Another file, or the same one again: back to editing when defaultEditing is on, or where an edit is kept.
  useEffect(() => {
    const opened = path !== undefined && startOnOpen.current === path;
    setEditing(path !== undefined && (defaultEditing || Boolean(fileDrafts.get(projectId, path)) || (opened && roomFor(path))));
    if (opened) startOnOpen.current = undefined;
    setComparing(false);
  }, [projectId, path, defaultEditing, roomFor]);
  useEffect(() => { if (!conflict) setComparing(false); }, [conflict]);

  const latest = useRef({ preview, onPreview, onSaved });
  latest.current = { preview, onPreview, onSaved };
  /** The file a save is writing now: refreshes of it wait, and it is not saved twice at once. */
  const writing = useRef<string | undefined>(undefined);
  /** Bumped by every save, so a read that started before one never lands after it. */
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const shown = latest.current.preview;
    if (!shown || writing.current === shown.path || shown.binary) return;
    const started = generation.current;
    try {
      const fresh = await api.preview(projectId, shown.path);
      const now = latest.current.preview;
      if (generation.current === started && writing.current !== fresh.path && now?.path === fresh.path && now.hash !== fresh.hash) latest.current.onPreview(fresh);
    } catch { /* gone or unreadable: the next open says so */ }
  }, [projectId]);

  // Keep preview hash aligned when another pane or Save All saves this file.
  useEffect(() => fileDrafts.onSaved(({ projectId: savedProject, version, content }) => {
    if (savedProject !== projectId) return;
    const shown = latest.current.preview;
    if (!shown || shown.path !== version.path) return;
    generation.current += 1;
    latest.current.onPreview({ ...shown, content, hash: version.hash, size: version.size, truncated: false });
    latest.current.onSaved?.(version.path);
  }), [projectId]);

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
    if ((kept?.base ?? shown.hash) === shown.hash && text === lines(shown.content)) {
      fileDrafts.drop(projectId, shown.path);
      return;
    }
    if (!kept && !roomFor(shown.path)) return;
    fileDrafts.set(projectId, shown.path, { base: kept?.base ?? shown.hash, text });
  }, [projectId, roomFor]);

  /** Resolves true when [file] has nothing unsaved, or the reader chose to lose it. */
  const discard = useCallback(async (file: string) => {
    if (!fileDrafts.get(projectId, file)) return true;
    const confirmed = await confirmDialog({ title: t`放弃未保存的修改？`, confirmLabel: t`放弃修改`, destructive: true });
    if (confirmed) fileDrafts.drop(projectId, file);
    return confirmed;
  }, [projectId, t]);

  /**
   * Writes the draft. In conflict only [over] writes it, over the version now on disk the reader has been shown
   * (the 覆盖保存 button); ⌘S then does nothing, so a change that arrived a moment ago is not overwritten unseen.
   */
  const save = useCallback(async (over = false) => {
    const shown = latest.current.preview;
    const kept = shown && fileDrafts.get(projectId, shown.path);
    if (!shown || !kept || writing.current === shown.path) return;
    if (kept.base !== shown.hash && !over) return;
    writing.current = shown.path;
    generation.current += 1;
    setSavingPath(shown.path);
    try {
      const version = await api.saveFile(projectId, shown.path, kept.text, shown.hash);
      // Typed on while it was saving: what was saved is the new base, the rest stays a draft.
      const now = fileDrafts.get(projectId, shown.path);
      if (now && now.text !== kept.text) fileDrafts.set(projectId, shown.path, { base: version.hash, text: now.text });
      else fileDrafts.drop(projectId, shown.path);
      fileDrafts.notifySaved(projectId, version, kept.text);
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
      generation.current += 1;
      writing.current = undefined;
      setSavingPath(undefined);
    }
  }, [projectId, t]);

  return {
    /** Shown: the draft while one is kept, else the file. */
    text: draft?.text ?? preview?.content,
    editable: writable && Boolean(preview?.editable),
    editing: editing && writable && Boolean(preview?.editable),
    dirty: Boolean(draft),
    saving: savingPath !== undefined && savingPath === path,
    conflict,
    /** The disk's text to show the draft against, while comparing. */
    original: conflict && comparing ? preview?.content : undefined,
    comparing,
    setComparing,
    start: () => { if (path !== undefined && roomFor(path)) setEditing(true); },
    /** Opens [file] for editing once it is the file shown. */
    startOnOpen: (file: string) => { startOnOpen.current = file; },
    /** Leaves editing; an unsaved edit is discarded, after asking. */
    stop: async () => { if (path !== undefined && await discard(path)) setEditing(false); },
    /** Escape: leaves editing when nothing is unsaved (unless defaultEditing keeps it open). */
    escape: () => { if (!draft && !defaultEditing) setEditing(false); },
    change,
    save,
    discard,
    /** In conflict or on explicit revert: drop the draft and take the version on disk. */
    takeDisk: async () => { if (path !== undefined) await discard(path); },
  };
}
