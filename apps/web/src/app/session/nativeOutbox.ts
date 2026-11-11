import type { Run, Session } from '@contracts';
import { HttpError, listNativeSendRequests, removeNativeSendRequest, type NativeMessageInput, type NativeSendOutboxEntry } from '@/lib/api';
import { sendPhase } from './delivery';
import { updateRuns, type NativeSessionStore, type NativeSessionTracking } from './nativeSessionStore';

/*
 * The send outbox seen as runs. A send is saved before its POST goes out; until the server answers,
 * this tab shows a local copy of it, and these rules decide when that copy is replaced, dropped or
 * reported as unknown.
 */

export function optimisticRun(session: Session, body: NativeMessageInput, at: string, uncertain: boolean, entry?: NativeSendOutboxEntry): Run {
  return {
    id: body.commandId,
    sessionId: session.id,
    commandId: body.commandId,
    prompt: body.text,
    state: entry?.invalidReason ? 'failed' : uncertain ? 'interrupted' : 'queued',
    ...(entry?.invalidReason ? { error: entry.invalidReason } : {}),
    createdAt: at,
    updatedAt: at,
    native: {
      ...(entry?.steerTarget || entry?.version !== undefined || entry?.sourceRunId !== undefined ? { intent: 'steer' as const, nativeSessionId: entry.steerTarget?.nativeSessionId, nativeTurnId: entry.steerTarget?.turnId, ownerRunId: entry.ownerRunId, ...(entry.sourceRunId ? { sourceRunId: entry.sourceRunId } : {}) } : {}),
      input: {
        text: body.text,
        attachmentIds: body.attachments?.map(({ id }) => id) ?? [],
        context: body.context?.map(({ path, line }) => ({ path, ...(line ===undefined ? {} : { line }) })) ?? [],
        ...(body.references ? { references: body.references } : {}),
      },
      config: { ...(session.model ? { model: session.model } : {}), mode: session.mode, ...(session.approval ? { approval: session.approval } : {}) },
      fingerprint: 'client-pending',
      delivery: entry?.invalidReason ? 'failed' : uncertain ? 'uncertain' : 'queued',
      attempt: 0,
      stage: entry?.invalidReason ? 'outbox_failure' : uncertain ? 'http_unknown' : 'http_pending',
      configRevision: body.expectedConfigRevision ?? session.configRevision ?? 0,
    },
  };
}

/** How long a local copy may wait for the server to claim it before it is reported as unknown. */
const UNCLAIMED_GRACE_MS = 20_000;

/** A copy this tab made before the server answered; the server's own run replaces it by command id. */
export function isLocalCopy(run: Run): boolean {
  return run.native?.fingerprint === 'client-pending' && run.native.intent !== 'steer' && (run.native.delivery === 'queued' || run.native.delivery === 'uncertain' || run.native.stage === 'outbox_failure');
}

/**
 * A send the server has accepted but not yet handed to the CLI. The server's pending row for it
 * (`user:<commandId>`) comes over the stream a moment after the POST's answer replaces the local
 * copy; until it lands, the tab keeps drawing the row it drew while it waited, so the message does
 * not blink out of the transcript in between. The server's row takes its place by key.
 */
export function awaitsServerRow(run: Run): boolean {
  if (run.native?.intent === 'steer') return false;
  const phase = sendPhase(run);
  return phase === 'queued' || phase === 'starting';
}

export function mergeRun(current: Run[], incoming: Run): Run[] {
  const index = current.findIndex((run) => run.id === incoming.id || run.commandId === incoming.commandId);
  if (index < 0) return [...current, incoming].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const existing = current[index]!;
  const existingAt = Date.parse(existing.updatedAt);
  const incomingAt = Date.parse(incoming.updatedAt);
  const existingLocal = existing.native?.fingerprint === 'client-pending';
  const incomingLocal = incoming.native?.fingerprint === 'client-pending';
  // Server receipts outrank local placeholders regardless of the client's clock. A lost POST
  // response must also never downgrade a receipt that already arrived on the stream.
  const latest = existingLocal !== incomingLocal ? existingLocal ? incoming : existing
    : Number.isFinite(existingAt) && Number.isFinite(incomingAt) && existingAt > incomingAt ? existing : incoming;
  const next = current.slice();
  next[index] = latest;
  // An optimistic copy and the server's run can disagree on createdAt; keep the list in order.
  return latest.createdAt === existing.createdAt ? next : next.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function settleQueuedSource(runs: Run[], sourceRunId?: string): Run[] {
  return sourceRunId ? runs.map(run => run.id === sourceRunId && run.native?.delivery === 'queued'
    ? { ...run, state: 'cancelled', native: { ...run.native, delivery: 'cancelled', stage: 'steer_replaced' } } : run) : runs;
}

/**
 * A created session's first run arrives as a server receipt, not a local copy, so the outbox row
 * rules do not see it on their own. It stays a stand-in until the server's own `user:` row replaces
 * it or the run settles; a failed send stays longer so its error remains readable.
 */
export function keepsInlineReceipt(run: Run): boolean {
  return (['queued', 'running', 'failed'] as readonly string[]).includes(run.state)
    || (['queued', 'preparing', 'dispatching', 'input_sent', 'uncertain'] as readonly string[]).includes(run.native?.delivery ?? '');
}

export function snapshotWithLocalOutbox(session: Session, snapshot: Run[], seed?: Run): Run[] {
  const byId = new Map(snapshot.map((run) => [run.id, run]));
  const commands = new Set(snapshot.map((run) => run.commandId));
  const seedActive = seed && keepsInlineReceipt(seed);
  if (seed && seedActive && seed.sessionId === session.id && !commands.has(seed.commandId)) byId.set(seed.id, seed);
  for (const entry of listNativeSendRequests(session.id)) {
    if (commands.has(entry.body.commandId)) {
      removeNativeSendRequest(session.id, entry.body.commandId);
      continue;
    }
    byId.set(entry.body.commandId, optimisticRun(session, entry.body, entry.createdAt, true, entry));
  }
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function isUncertainRequest(error: unknown): boolean {
  return !(error instanceof HttpError) || error.status === 0 || error.status >= 500
    // Interrupt-and-send can await the original stop before there is a Run to return. This 409
    // does not reject the message: its original command and stop target still own the submission.
    || error.code === 'NATIVE_STOP_UNCONFIRMED';
}

/**
 * Local copies are a stand-in for the server's answer, not a second source of truth: the server's own
 * row (`user:<commandId>`) or Run replaces one by command id. A copy the server has neither claimed nor
 * rejected within the grace period is reported as unknown instead of sending forever. Runs at once
 * and then while an unclaimed copy remains; the returned function stops it.
 */
export function settleLocalCopies(store: NativeSessionStore, tracking: NativeSessionTracking): () => void {
  let timer: number | undefined;
  const settle = () => {
    const current = store.get().runs;
    const now = Date.now();
    const stale = (run: Run) => run.native?.stage === 'http_pending' && run.native.delivery === 'queued' && !tracking.sendInFlight
      && now - Date.parse(run.createdAt) > UNCLAIMED_GRACE_MS;
    if (current.some(stale)) {
      // An unknown send keeps its outbox entry: the original request is still the way to settle it.
      updateRuns(store, tracking, (list) => list.map((run) => stale(run)
        ? { ...run, state: 'interrupted' as const, updatedAt: new Date(now).toISOString(), native: { ...run.native!, delivery: 'uncertain' as const, stage: 'http_unknown' } } : run));
    }
    if (store.get().runs.some((run) => run.native?.stage === 'http_pending' && isLocalCopy(run))) timer = window.setTimeout(settle, 1_000 + UNCLAIMED_GRACE_MS / 4);
  };
  settle();
  return () => window.clearTimeout(timer);
}
