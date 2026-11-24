import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { Attachment } from '@contracts';
import { api, HttpError, isAgentReference, isFileReference, mergeRestoredReferences, sameContextReference, type NativeSessionCreateInput, type PromptContextReference } from '@/lib/api';
import { mentionRanges, referenceLabel } from './agentMentions';
import type { PendingUpload } from './composerAttachmentIntake';
import { creationDraftRemainder, markDraftUnsaved, readDraft, recoveredCreationEvent, unsavedDrafts, writeDraft, type StoredDraft } from './composerDraft';
import { joinQuotes, splitQuotes } from './quotes';

export function useComposerDraftSync(options: {
  storageKey: string;
  projectId: string;
  referenceProjectId: string;
  persistReferences: boolean;
  text: string;
  quotes: string[];
  textRef: MutableRefObject<string>;
  quotesRef: MutableRefObject<string[]>;
  textRevisionRef: MutableRefObject<number>;
  draftGenerationRef: MutableRefObject<number>;
  references: PromptContextReference[];
  referencesRef: MutableRefObject<PromptContextReference[]>;
  referencesRevisionRef: MutableRefObject<number>;
  attachments: Attachment[];
  attachmentsRef: MutableRefObject<Attachment[]>;
  pendingUploads: PendingUpload[];
  pendingUploadsRef: MutableRefObject<PendingUpload[]>;
  attachmentKeysRef: MutableRefObject<Map<string, string>>;
  updateText: (next: string) => void;
  updateQuotes: (next: string[]) => void;
  updateReferences: (next: PromptContextReference[]) => void;
  updateAttachments: (updater: Attachment[] | ((current: Attachment[]) => Attachment[])) => void;
  updatePendingUploads: (updater: (current: PendingUpload[]) => PendingUpload[]) => void;
  resetForDraft: (attachments: Attachment[], pending: PendingUpload[], keys?: Record<string, string>) => void;
  resetTrigger: () => void;
  setScheduledAt: Dispatch<SetStateAction<Date | null>>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  restoreDraft?: { text: string; attachments: Attachment[]; context?: PromptContextReference[]; missingAttachments?: PendingUpload[]; scheduledAt?: Date; onPersisted?: () => void; nonce: number };
  quote?: { text: string; nonce: number };
  onDraftChange?: (hasContent: boolean) => void;
  onOpenReferenceSession?: (id: string) => void;
  onError: (message: string) => void;
}) {
  const { t } = useLingui();
  const { storageKey, projectId, referenceProjectId, persistReferences, text, quotes, textRef, quotesRef, draftGenerationRef, references, referencesRef, referencesRevisionRef, attachments, attachmentsRef, pendingUploads, pendingUploadsRef, attachmentKeysRef, updateText, updateQuotes, updateReferences, updateAttachments, updatePendingUploads, resetForDraft, resetTrigger, setScheduledAt, textareaRef, restoreDraft, quote, onDraftChange, onOpenReferenceSession, onError } = options;

  const [, refreshDraftPersistence] = useState(0);
  const draftAtRisk = unsavedDrafts.has(storageKey) && Boolean(text || quotes.length || attachments.length || (persistReferences && references.length));

  /*
   * A draft key brings its whole draft back: text, attachments and references.
   *
   * The attachments are shown at once and checked against the server behind them; one it no longer
   * has (cleaned up, another machine's) leaves the draft, and the reader is told. The references
   * return through the host, which clears its list when the conversation changes — in the same
   * update that changes this key, so this effect runs after that clear, not before it.
   *
   * A project change alone takes nothing: attachments are server-wide records
   * (`/api/attachments/:id`), usable from any project, and the text is the reader's.
   */
  useEffect(() => {
    draftGenerationRef.current += 1;
    const generation = draftGenerationRef.current;
    const stored = readDraft(storageKey);
    resetForDraft(stored.attachments, stored.pendingUploads ?? [], stored.keys);
    const storedText = splitQuotes(stored.text);
    updateText(storedText.body);
    updateQuotes(storedText.quotes);
    resetTrigger();
    setScheduledAt(null);
    const current = referencesRef.current;
    const restored = persistReferences
      ? stored.references.filter(item => !isFileReference(item) || stored.projectId === referenceProjectId).filter((item) => !current.some((other) => sameContextReference(other, item)))
      : [];
    if (restored.length) updateReferences([...current, ...restored]);
    if (!stored.attachments.length) return;
    void Promise.all(stored.attachments.map((item) => api.attachmentMetadata(item.id, stored.projectId ?? projectId).then(
      (fresh) => [item.id, fresh] as const,
      // Only "not found" means unusable; a server that is merely unreachable keeps the draft as it is.
      (error: unknown) => [item.id, error instanceof HttpError && error.status === 404 ? null : item] as const,
    ))).then((checked) => {
      if (generation !== draftGenerationRef.current) return;
      const verdict = new Map<string, Attachment | null>(checked);
      const gone = checked.filter(([, value]) => !value).length;
      if (!gone) return;
      updatePendingUploads(current => [...current, ...attachmentsRef.current.filter(item => verdict.get(item.id) === null).map(item => ({ key: `missing:${item.id}`, name: item.name, size: item.size, image: item.mimeType.startsWith('image/'), attachmentId: item.id, error: t`请重新选择文件` }))]);
      updateAttachments(items => items.filter(item => verdict.get(item.id) !== null));
    });
  }, [storageKey]);

  const referenceScope = useRef(referenceProjectId);
  useLayoutEffect(() => {
    if (referenceScope.current !== referenceProjectId) {
      referenceScope.current = referenceProjectId;
      if (referencesRef.current.some(isFileReference)) updateReferences(referencesRef.current.filter(item => !isFileReference(item)));
      return;
    }
    if (referencesRef.current === references) return;
    referencesRef.current = references;
    referencesRevisionRef.current += 1;
  }, [referenceProjectId, references]);

  /*
   * The draft is mirrored to sessionStorage on a short debounce rather than per keystroke: a
   * synchronous storage write on every key is measurable on a long draft. Whatever is still pending
   * is written when the key changes, on unmount, and when the page is hidden, so nothing typed is
   * lost to a session switch, a reload or a backgrounded tab. A failed write leaves a local warning
   * until storage accepts the draft again, without repeating a toast on every pause in typing.
   */
  const pendingDraftRef = useRef<{ key: string; draft: StoredDraft } | null>(null);
  const draftTimerRef = useRef<number | undefined>(undefined);
  const saveDraft = useRef((key: string, draft: StoredDraft) => {
    const wasUnsaved = unsavedDrafts.has(key);
    const saved = writeDraft(key, draft);
    markDraftUnsaved(key, saved);
    if (wasUnsaved !== !saved) refreshDraftPersistence((revision) => revision + 1);
  }).current;
  const flushDraft = useRef(() => {
    window.clearTimeout(draftTimerRef.current);
    const pending = pendingDraftRef.current;
    pendingDraftRef.current = null;
    if (pending) saveDraft(pending.key, pending.draft);
  }).current;
  /** The draft as it stands, read from the refs the updaters keep current ahead of the next render. */
  const currentDraft = (): StoredDraft => ({
    text: joinQuotes(quotesRef.current, textRef.current), attachments: attachmentsRef.current, references: persistReferences ? referencesRef.current : [], projectId: referenceScope.current,
    ...(pendingUploadsRef.current.length ? { pendingUploads: pendingUploadsRef.current } : {}),
    keys: Object.fromEntries(attachmentsRef.current.flatMap((item) => { const key = attachmentKeysRef.current.get(item.id); return key ? [[item.id, key]] : []; })),
  });
  useEffect(() => {
    if (!storageKey) return;
    pendingDraftRef.current = { key: storageKey, draft: currentDraft() };
    window.clearTimeout(draftTimerRef.current);
    draftTimerRef.current = window.setTimeout(flushDraft, 400);
  }, [storageKey, text, quotes, attachments, references, pendingUploads, referenceProjectId, flushDraft]);
  // Cleanups run before the next commit's effects, so the old key is written before the reset reads the new one.
  useEffect(() => flushDraft, [storageKey, flushDraft]);
  useEffect(() => {
    const onHidden = () => { if (document.visibilityState === 'hidden') flushDraft(); };
    window.addEventListener('pagehide', flushDraft);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('pagehide', flushDraft);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, [flushDraft]);

  // Before paint: whatever handed the draft back (a queue row) leaves in the same frame it lands.
  useLayoutEffect(() => {
    if (!restoreDraft) return;
    const current = textRef.current;
    const restored = splitQuotes(restoreDraft.text);
    const nextText = current.trim() ? `${restored.body}\n${current}` : restored.body;
    updateText(nextText);
    if (restored.quotes.length) updateQuotes([...restored.quotes, ...quotesRef.current]);
    updateAttachments((existing) => [...restoreDraft.attachments.filter((item) => !existing.some((other) => other.id === item.id)), ...existing]);
    // An Agent an older message mentioned beside its text has no mark to show here; it is not restored unseen.
    const context = restoreDraft.context?.filter(item => !isAgentReference(item) || mentionRanges(nextText, [referenceLabel(item)]).length > 0);
    if (context?.length) updateReferences(mergeRestoredReferences(referencesRef.current, context));
    if (restoreDraft.missingAttachments) updatePendingUploads(current => [...current, ...restoreDraft.missingAttachments!.filter(item => !current.some(other => other.key === item.key))]);
    if (restoreDraft.scheduledAt && restoreDraft.scheduledAt.getTime() > Date.now()) {
      setScheduledAt((existing) => (existing && existing.getTime() > Date.now() ? existing : restoreDraft.scheduledAt!));
    }
    if (storageKey) {
      saveDraft(storageKey, currentDraft());
      if (!unsavedDrafts.has(storageKey)) restoreDraft.onPersisted?.();
    }
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [restoreDraft]);

  useEffect(() => {
    if (!quote) return;
    updateQuotes([...quotesRef.current, quote.text]);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [quote]);

  useEffect(() => {
    onDraftChange?.(Boolean(text.trim() || quotes.length || attachments.length));
  }, [attachments.length, onDraftChange, quotes.length, text]);

  useEffect(() => {
    if (storageKey !== 'riffet.draft.new:home') return;
    const acknowledge = (event: Event) => {
      const detail = (event as CustomEvent<{ body: NativeSessionCreateInput; handled: boolean; saved: boolean }>).detail;
      if (detail.handled) return;
      detail.handled = true;
      const remaining = creationDraftRemainder(currentDraft(), detail.body);
      if (remaining.text !== textRef.current) updateText(remaining.text);
      updateAttachments(remaining.attachments);
      if (remaining.references !== referencesRef.current) updateReferences(remaining.references);
      pendingDraftRef.current = null;
      window.clearTimeout(draftTimerRef.current);
      detail.saved = writeDraft(storageKey, currentDraft());
    };
    window.addEventListener(recoveredCreationEvent, acknowledge);
    return () => window.removeEventListener(recoveredCreationEvent, acknowledge);
  }, [storageKey]);

  const openReferenceSession = (id: string) => {
    if (storageKey) {
      pendingDraftRef.current = { key: storageKey, draft: currentDraft() };
      flushDraft();
      if (unsavedDrafts.has(storageKey)) { onError(t`草稿无法保存到浏览器，刷新后会丢失`); return; }
    }
    onOpenReferenceSession?.(id);
  };

  return {
    draftAtRisk,
    pendingDraftRef,
    draftTimerRef,
    saveDraft,
    currentDraft,
    openReferenceSession,
  };
}
