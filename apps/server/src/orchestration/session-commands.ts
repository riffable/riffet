import { createHash } from 'node:crypto';
import type { Session, TextParams } from '../../../../packages/contracts/src/index.js';
import { AppError, sessionInTerminal } from '../errors.js';
import { redactConfigDocument, redactSensitiveText } from '../settings/config-documents.js';
import type { Store } from '../store.js';

interface SubmissionRejection { fingerprint: string; code: string; message: string; status: number; params?: TextParams }
interface PendingSubmission { fingerprint: string; promise: Promise<unknown> }

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function submissionFingerprint(identity: unknown): string {
  return digest(JSON.stringify(identity, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : value) ?? 'undefined');
}

/** Persist neither credentials nor user input that an error happened to quote. */
function rejectedSubmission(fingerprint: string, identity: unknown, error: AppError): SubmissionRejection {
  const inputStrings = new Set<string>();
  const collect = (value: unknown) => {
    if (typeof value === 'string' && value) inputStrings.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(identity);
  const safe = (value: string) => {
    if ([...inputStrings].some(input => value.includes(input))) return '[REDACTED]';
    return redactSensitiveText(value).slice(0, 1000);
  };
  const params = error.params ? JSON.parse(redactConfigDocument(JSON.stringify(error.params))) as TextParams : undefined;
  return { fingerprint, code: error.code, message: safe(error.message), status: error.statusCode,
    ...(params ? { params: Object.fromEntries(Object.entries(params).map(([key, value]) => [key, typeof value === 'string' ? safe(value) : value])) } : {}) };
}

/**
 * Whether a conversation may take a new command right now, and the short-lived states that say
 * no: being archived or deleted, or having its model or mode switched. Every path that accepts a message —
 * the composer's routes and the orchestration service — asks here, so they refuse alike.
 *
 * States are counted, not flagged: two overlapping archive requests (or two queued setting
 * changes) keep the fence up until the last one finishes.
 */
export class SessionCommands {
  private readonly archiving = new Map<string, number>();
  private readonly configuring = new Map<string, number>();
  private readonly deleting = new Map<string, number>();
  private readonly submissions = new WeakMap<Store, Map<string, PendingSubmission>>();

  /** Coalesces admission/preflight too, before the normal Run idempotency record exists. */
  submit<T>(store: Store, sessionId: string, commandId: string, identity: unknown, action: () => Promise<T>, options?: { recovering?: boolean }): Promise<T> {
    try {
      // A Run is authoritative; its own accepted-input fingerprint and idempotency path apply.
      if (store.findRunByCommand(sessionId, commandId)) return Promise.resolve().then(action);
      const key = digest(JSON.stringify([sessionId, commandId]));
      const fingerprint = submissionFingerprint(identity);
      let pending = this.submissions.get(store);
      if (!pending) { pending = new Map(); this.submissions.set(store, pending); }
      const current = pending.get(key);
      const conflict = () => new AppError('COMMAND_ID_CONFLICT', 'This commandId was already used for a different submission', 409);
      if (current) return current.fingerprint === fingerprint ? current.promise as Promise<T> : Promise.reject(conflict());
      const receiptKey = `native-command-rejection:${key}`;
      const rejection = store.getSetting<SubmissionRejection | undefined>(receiptKey, undefined);
      if (rejection) return Promise.reject(rejection.fingerprint === fingerprint
        ? new AppError(rejection.code, rejection.message, rejection.status, undefined, rejection.params) : conflict());
      const promise = Promise.resolve().then(action).catch((error: unknown) => {
        // A pending stop already owns its command. A rejected recovery attempt cannot reject the original.
        if (!options?.recovering && error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 408
          && !/UNCONFIRMED|UNKNOWN|TIMEOUT|NETWORK|UNREACHABLE/i.test(error.code)) {
          // If durable storage fails, propagate that failure rather than an unsafe definitive 4xx.
          store.transaction(() => {
            if (!store.findRunByCommand(sessionId, commandId)) store.setSetting(receiptKey, rejectedSubmission(fingerprint, identity, error));
          });
        }
        throw error;
      }).finally(() => { if (pending.get(key)?.promise === promise) pending.delete(key); });
      pending.set(key, { fingerprint, promise });
      return promise;
    } catch (error) { return Promise.reject(error); }
  }

  /** `action` only words the refusal: a steer is guidance for the running turn, not a new message. */
  admit(session: Session, action: 'send' | 'steer' = 'send'): void {
    if (session.archivedAt) throw new AppError('ARCHIVED_SESSION', action === 'send' ? 'Restore this conversation before running it' : 'This conversation is archived', 409);
    if (this.isArchiving(session.id)) throw new AppError('ARCHIVED_SESSION', 'Conversation is being archived', 409);
    if (this.isDeleting(session.id)) throw new AppError('SESSION_DELETING', 'Conversation is being deleted', 409);
    if (session.terminalHold) throw sessionInTerminal();
    if (this.isConfiguring(session.id)) throw new AppError('CONFIGURATION_CHANGING', action === 'steer' ? 'The model is switching; steer after it finishes' : 'The model is switching; send after it finishes', 409, undefined, { action });
  }

  isArchiving(sessionId: string): boolean { return (this.archiving.get(sessionId) ?? 0) > 0; }
  isConfiguring(sessionId: string): boolean { return (this.configuring.get(sessionId) ?? 0) > 0; }
  isDeleting(sessionId: string): boolean { return (this.deleting.get(sessionId) ?? 0) > 0; }

  /** Raises the archive fence; the returned release is idempotent. */
  beginArchive(sessionId: string): () => void { return hold(this.archiving, sessionId); }
  beginConfigure(sessionId: string): () => void { return hold(this.configuring, sessionId); }
  beginDelete(sessionId: string): () => void { return hold(this.deleting, sessionId); }
}

function hold(counts: Map<string, number>, sessionId: string): () => void {
  counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (counts.get(sessionId) ?? 1) - 1;
    if (left > 0) counts.set(sessionId, left); else counts.delete(sessionId);
  };
}
