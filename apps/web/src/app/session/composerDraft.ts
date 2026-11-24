import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { isNativeBackendId, type Attachment } from '@contracts';
import { restoreContext, sameContextReference, isFileReference, type NativeSessionCreateInput, type PromptContextReference } from '@/lib/api';
import { mentionsDeletedSession } from '@/lib/session-deletion';
import type { PendingUpload } from './composerAttachmentIntake';

/**
 * What a draft keeps in `sessionStorage`: the text, the attachments as the server recorded them, and
 * the file references — with the project they name paths in, since a draft can follow the reader to
 * another project (the new-session draft does) and references do not travel.
 * `keys` holds each attachment's duplicate-check key by id, so the same file dropped again after a reload is still recognized.
 */
export interface StoredDraft {
  text: string;
  attachments: Attachment[];
  references: PromptContextReference[];
  projectId?: string;
  keys?: Record<string, string>;
  pendingUploads?: PendingUpload[];
}

const isAttachment = (value: unknown): value is Attachment => {
  const item = value as Partial<Attachment> | null;
  return typeof item?.id === 'string' && typeof item.name === 'string' && typeof item.mimeType === 'string' && typeof item.path === 'string' && typeof item.size === 'number';
};

const isReference = (value: unknown): value is PromptContextReference => {
  const item = value as Partial<PromptContextReference> | null;
  if (item?.kind === 'agent') return typeof item.backendId === 'string' && isNativeBackendId(item.backendId) && (item.backendProfileId === undefined || typeof item.backendProfileId === 'string') && (item.label === undefined || typeof item.label === 'string');
  return item?.kind === 'session' ? typeof item.sessionId === 'string' && Boolean(item.sessionId) && (item.fromRunId === undefined || typeof item.fromRunId === 'string' && Boolean(item.fromRunId)) && (item.title === undefined || typeof item.title === 'string') && (item.backendId === undefined || isNativeBackendId(item.backendId)) : typeof item?.path === 'string' && (item.line === undefined || typeof item.line === 'number');
};

export const recoveredCreationEvent = 'riffet:acknowledge-creation-draft';

export function creationDraftRemainder(draft: StoredDraft, body: NativeSessionCreateInput): StoredDraft {
  const submittedIds = new Set(body.initialMessage.attachments?.map(({ id }) => id) ?? []);
  const submittedReferences = restoreContext(body.initialMessage);
  return {
    ...draft,
    text: draft.text.trim() === body.initialMessage.text.trim() ? '' : draft.text,
    attachments: draft.attachments.filter(({ id }) => !submittedIds.has(id)),
    references: body.backendId !== 'chat'
      ? draft.references.filter(reference => (isFileReference(reference) && draft.projectId !== body.projectId) || !submittedReferences.some(item => sameContextReference(item, reference)))
      : draft.references,
    ...(draft.keys ? { keys: Object.fromEntries(Object.entries(draft.keys).filter(([id]) => !submittedIds.has(id))) } : {}),
  };
}

/** Synchronize the mounted composer before navigating, then acknowledge its persisted sent text. */
export function acknowledgeRecoveredCreationDraft(body: NativeSessionCreateInput): boolean {
  const detail = { body, handled: false, saved: true };
  window.dispatchEvent(new CustomEvent(recoveredCreationEvent, { detail }));
  if (detail.handled) return detail.saved;
  if (!detail.saved) return false;
  const key = 'riffet.draft.new:home';
  try { sessionStorage.getItem(key); } catch { return false; }
  const draft = readDraft(key);
  return writeDraft(key, creationDraftRemainder(draft, body));
}

/** Never throws: storage can be unavailable (private browsing, a policy), and a draft is best effort. */
export function readDraft(key: string): StoredDraft {
  const empty: StoredDraft = { text: '', attachments: [], references: [] };
  let raw: string | null = null;
  try { raw = key ? sessionStorage.getItem(key) : null; } catch { return empty; }
  if (!raw) return key === 'riffet.draft.new:home' ? mergeQuickChatDraft(empty) : empty;
  try {
    const value = JSON.parse(raw) as Partial<StoredDraft> | null;
    if (value && typeof value.text === 'string' && Array.isArray(value.attachments) && Array.isArray(value.references)) {
      const draft: StoredDraft = {
        text: value.text,
        attachments: value.attachments.filter(isAttachment),
        references: value.references.filter(isReference),
        ...(Array.isArray(value.pendingUploads) ? { pendingUploads: value.pendingUploads.filter(item => typeof item.key === 'string' && typeof item.name === 'string').map(item => ({ ...item, error: i18n._(msg`请重新选择文件`) })) } : {}),
        ...(typeof value.projectId === 'string' ? { projectId: value.projectId } : {}),
        ...(value.keys && typeof value.keys === 'object' ? { keys: Object.fromEntries(Object.entries(value.keys).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) } : {}),
      };
      return key === 'riffet.draft.new:home' ? mergeQuickChatDraft(draft) : draft;
    }
  } catch { /* the bare text drafts were stored as before attachments and references were kept */ }
  const draft = { ...empty, text: raw };
  return key === 'riffet.draft.new:home' ? mergeQuickChatDraft(draft) : draft;
}

/** Retire the old separate chat draft only after both drafts are safely stored together. */
function mergeQuickChatDraft(task: StoredDraft): StoredDraft {
  const legacyKey = 'riffet.draft.quick-chat:home';
  const chat = readDraft(legacyKey);
  if (!chat.text && !chat.attachments.length) return task;
  const merged: StoredDraft = {
    ...task,
    text: [task.text, chat.text !== task.text ? chat.text : ''].filter(Boolean).join('\n\n'),
    attachments: [...task.attachments, ...chat.attachments.filter((item) => !task.attachments.some((other) => other.id === item.id))],
    keys: { ...chat.keys, ...task.keys },
  };
  if (writeDraft('riffet.draft.new:home', merged)) {
    try { sessionStorage.removeItem(legacyKey); } catch { /* Keep the old copy until storage is writable again. */ }
  }
  return merged;
}

/** Whether the write went through; an empty draft removes its key. */
export function writeDraft(key: string, draft: StoredDraft): boolean {
  // A conversation deleted meanwhile must not get its draft back from a pending flush.
  if (mentionsDeletedSession(key)) return true;
  try {
    if (draft.text || draft.attachments.length || draft.references.length || draft.pendingUploads?.length) sessionStorage.setItem(key, JSON.stringify(draft));
    else sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** Keys whose failed write was already reported: a full storage fails every 400ms of typing. */
// perf-rules: allow bounded to active session draft keys and cleared on successful write or cap
export const unsavedDrafts = new Set<string>();

export function markDraftUnsaved(key: string, saved: boolean) {
  if (saved) {
    unsavedDrafts.delete(key);
    return;
  }
  if (unsavedDrafts.size >= 64 && !unsavedDrafts.has(key)) unsavedDrafts.clear();
  unsavedDrafts.add(key);
}

/** Voice mode is this browser's: a phone that switched to it stays there, the desktop is never asked. */
const VOICE_MODE_KEY = 'riffet.composer.voice-mode';
export function readVoiceMode(): boolean {
  try { return window.localStorage.getItem(VOICE_MODE_KEY) === '1'; } catch { return false; }
}
export function writeVoiceMode(on: boolean) {
  try { if (on) window.localStorage.setItem(VOICE_MODE_KEY, '1'); else window.localStorage.removeItem(VOICE_MODE_KEY); } catch { /* Storage may be unavailable. */ }
}
