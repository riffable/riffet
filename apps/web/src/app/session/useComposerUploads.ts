import { useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { Attachment } from '@contracts';
import { api, HttpError } from '@/lib/api';
import { errorMessage } from '@/lib/utils';
import { attachmentMimeType, planIntake, type CandidateFile, type PendingUpload } from './composerAttachmentIntake';
import { readUploadData, uploadName } from './image-upload';

/**
 * Manages draft attachments and their in-flight uploads, retries, deduplication keys,
 * and cancellation across draft key switches and unmounts.
 */
export function useComposerUploads({
  projectId,
  initialAttachments,
  initialPendingUploads,
  disabled,
  attachmentsAllowed,
  draftGenerationRef,
  fileInputRef,
  onError,
  refocusDraft,
}: {
  projectId: string;
  initialAttachments: () => Attachment[];
  initialPendingUploads: () => PendingUpload[];
  disabled?: boolean;
  attachmentsAllowed?: boolean;
  draftGenerationRef: MutableRefObject<number>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onError: (message: string) => void;
  refocusDraft: () => void;
}) {
  const { t } = useLingui();
  const [attachments, setAttachments] = useState<Attachment[]>(initialAttachments);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>(initialPendingUploads);
  const attachmentsRef = useRef(attachments);
  const pendingUploadsRef = useRef(pendingUploads);
  const uploadFilesRef = useRef(new Map<string, File>());
  const activeUploadKeysRef = useRef(new Set<string>());
  const reselectUploadKeyRef = useRef<string | undefined>(undefined);
  /**
   * Dedupe key per accepted attachment id. Draft attachments are plain `Attachment` records, which
   * carry no `lastModified`, so the key `validateIntake`/`newCandidates` work with is the one the
   * `File` produced — kept here rather than on the record so nothing downstream has to know about it.
   */
  const attachmentKeysRef = useRef(new Map<string, string>());
  const pendingAttachmentKeysRef = useRef(new Set<string>());
  const uploadControllersRef = useRef(new Map<string, AbortController>());

  useEffect(() => () => {
    for (const controller of uploadControllersRef.current.values()) controller.abort();
  }, []);

  const updatePendingUploads = (update: (current: PendingUpload[]) => PendingUpload[]) => {
    pendingUploadsRef.current = update(pendingUploadsRef.current);
    setPendingUploads(pendingUploadsRef.current);
  };

  const updateAttachments = (next: Attachment[] | ((current: Attachment[]) => Attachment[])) => {
    const value = typeof next === 'function' ? next(attachmentsRef.current) : next;
    const ids = new Set(value.map((item) => item.id));
    for (const id of attachmentKeysRef.current.keys()) {
      if (!ids.has(id)) attachmentKeysRef.current.delete(id);
    }
    attachmentsRef.current = value;
    setAttachments(value);
  };

  const uploadFile = async (key: string, original: File, generation = draftGenerationRef.current) => {
    if (activeUploadKeysRef.current.has(key)) return;
    activeUploadKeysRef.current.add(key);
    const controller = new AbortController();
    uploadControllersRef.current.set(key, controller);
    updatePendingUploads(current => current.map(item => item.key === key ? { ...item, error: undefined } : item));
    try {
      const mimeType = attachmentMimeType(original);
      const file = mimeType === original.type ? original : new File([original], original.name, { type: mimeType, lastModified: original.lastModified });
      const data = await readUploadData(file);
      const attachment = await api.upload(projectId, {
        name: uploadName(file, data.mimeType), mimeType: data.mimeType, dataBase64: data.dataBase64,
        ...(data.width && data.height ? { width: data.width, height: data.height } : {}),
      }, controller.signal);
      if (controller.signal.aborted) return;
      if (generation !== draftGenerationRef.current) return;
      attachmentKeysRef.current.set(attachment.id, key);
      updateAttachments(current => [...current, attachment]);
      updatePendingUploads(current => current.filter(item => item.key !== key));
      uploadFilesRef.current.delete(key);
    } catch (error) {
      if (generation === draftGenerationRef.current && !controller.signal.aborted) {
        updatePendingUploads(current => current.map(item => item.key === key ? { ...item, error: errorMessage(error, t`上传失败`) } : item));
      }
    } finally {
      if (uploadControllersRef.current.get(key) === controller) uploadControllersRef.current.delete(key);
      if (generation === draftGenerationRef.current) {
        pendingAttachmentKeysRef.current.delete(key);
        activeUploadKeysRef.current.delete(key);
      }
    }
  };

  /**
   * The one intake path for every source: the picker, a paste, the card's drop and the window's.
   *
   * The decisions — refuse the batch, drop duplicates, or upload these files — belong to
   * `planIntake`, which is pure and tested; this function holds the side effects: reading, uploading
   * and appending to the draft. A refused batch is refused whole, before a single byte is read, so
   * the user learns now instead of after 19 files have uploaded and the server rejects the message.
   */
  const ingestFiles = async (list: FileList | File[] | null, replaceKey?: string) => {
    if (disabled || attachmentsAllowed === false) return;
    const items = list ? Array.from(list) : [];
    if (!items.length) return;
    const candidates: CandidateFile[] = items.map((file) => ({ name: file.name, size: file.size, type: file.type, lastModified: file.lastModified }));
    const pending = pendingAttachmentKeysRef.current;
    const generation = draftGenerationRef.current;
    const plan = planIntake(candidates, attachmentsRef.current.length + pendingUploadsRef.current.filter(upload => upload.key !== replaceKey).length, new Set([...attachmentKeysRef.current.values(), ...pending]));
    if (plan.kind === 'rejected') { onError(plan.reason); return; }
    if (plan.kind === 'empty') return;
    if (replaceKey) { uploadFilesRef.current.delete(replaceKey); pending.delete(replaceKey); }
    // Reserve the whole batch before the first await, including its dedupe keys.
    for (const entry of plan.entries) pending.add(entry.key);
    updatePendingUploads(current => [...current.filter(upload => upload.key !== replaceKey), ...plan.entries.map(entry => {
      const file = items[entry.index]!;
      uploadFilesRef.current.set(entry.key, file);
      return { key: entry.key, name: file.name, size: file.size, image: attachmentMimeType(file).startsWith('image/') };
    })]);
    // Each file settles independently. A failed neighbour never discards an uploaded attachment.
    for (const entry of plan.entries) {
      if (generation !== draftGenerationRef.current) return;
      await uploadFile(entry.key, items[entry.index]!, generation);
    }
  };

  const retryUpload = async (key: string) => {
    const file = uploadFilesRef.current.get(key);
    if (file) { await uploadFile(key, file); return; }
    const upload = pendingUploadsRef.current.find(item => item.key === key);
    if (upload?.attachmentId) {
      const generation = draftGenerationRef.current;
      if (activeUploadKeysRef.current.has(key)) return;
      activeUploadKeysRef.current.add(key);
      try {
        const attachment = await api.attachmentMetadata(upload.attachmentId, projectId);
        if (generation !== draftGenerationRef.current || !pendingUploadsRef.current.some(item => item.key === key)) return;
        updateAttachments(current => current.some(item => item.id === attachment.id) ? current : [...current, attachment]);
        updatePendingUploads(current => current.filter(item => item.key !== key));
        return;
      } catch (error) {
        if (generation !== draftGenerationRef.current) return;
        if (!(error instanceof HttpError && error.status === 404)) {
          updatePendingUploads(current => current.map(item => item.key === key ? { ...item, error: errorMessage(error, t`无法读取附件`) } : item));
          return;
        }
      } finally { activeUploadKeysRef.current.delete(key); }
    }
    // Browser reloads retain metadata, but cannot promise access to the original local file.
    reselectUploadKeyRef.current = key;
    fileInputRef.current?.click();
  };

  const removeUpload = (key: string) => {
    uploadControllersRef.current.get(key)?.abort();
    uploadControllersRef.current.delete(key);
    uploadFilesRef.current.delete(key);
    pendingAttachmentKeysRef.current.delete(key);
    updatePendingUploads(current => current.filter(item => item.key !== key));
  };

  /** Drop one draft attachment, and the key that identified it, together. */
  const removeAttachment = (id: string) => {
    attachmentKeysRef.current.delete(id);
    updateAttachments((current) => current.filter((item) => item.id !== id));
    refocusDraft();
  };

  const resetForDraft = (nextAttachments: Attachment[], nextPendingUploads: PendingUpload[], keys?: Record<string, string>) => {
    pendingAttachmentKeysRef.current = new Set();
    uploadFilesRef.current.clear();
    activeUploadKeysRef.current.clear();
    updatePendingUploads(() => nextPendingUploads);
    updateAttachments(nextAttachments);
    if (keys) {
      for (const item of nextAttachments) {
        if (keys[item.id]) attachmentKeysRef.current.set(item.id, keys[item.id]!);
      }
    }
  };

  return {
    attachments,
    attachmentsRef,
    pendingUploads,
    pendingUploadsRef,
    attachmentKeysRef,
    reselectUploadKeyRef,
    uploading: pendingUploads.length > 0,
    updateAttachments,
    updatePendingUploads,
    ingestFiles,
    retryUpload,
    removeUpload,
    removeAttachment,
    resetForDraft,
  };
}
