import type { NativeInteraction, NativeInteractionResponse, NativeInteractionResult } from '@contracts';
import {
  interactionSelection, sanitizeNativeOtherText, snapshotNativeInteractionDraft,
  type NativeInteractionDraft, type NativeInteractionSubmission,
} from './nativeInteractionDraft';

/*
 * A port of the answer card's state machine, `apps/mobile/client/.../ui/interaction/InteractionCard.kt`,
 * which Android and both Apple apps run. Both are held to the same scenarios
 * (`apps/mobile/client/fixtures/interaction-card/scenarios.json`); a change to one is a change to both.
 *
 * The CLI redraws its dialog constantly, and every redraw is a new revision. One that lands while an
 * answer is out (`posting`) or inconclusive (`unknown`, `uncertain`) waits: the card keeps showing what
 * was answered, so the same-request retry stays possible, until the answer settles or the reader syncs.
 * Applying a revision starts the draft over from the CLI's own state, and says so only when that lost
 * something the reader changed and never got through.
 */

type Phase = NativeInteractionSubmission['phase'];

/** `draft_stale`: a newer question replaced input the reader never got through. `unconfirmed`: check the current choice. */
export type InteractionNotice = 'draft_stale' | 'unconfirmed';

/** A failure with nothing to retry; `message` is the server's or the transport's, shown as is when present. */
export interface InteractionError { kind: 'submit' | 'sync'; message?: string }

export interface InteractionCardState {
  /** The live interaction, as the server last sent it. */
  interaction: NativeInteraction;
  /** The revision the draft was taken from. */
  appliedRevision: string;
  draft: NativeInteractionDraft;
  /** The reader changed the draft since it was taken from a revision or sent. */
  edited: boolean;
  submission?: NativeInteractionSubmission;
  notice?: InteractionNotice;
  error?: InteractionError;
  syncing: boolean;
  /** The reader synced since the last answer went out: the next revision applies even while that answer is inconclusive. */
  synced: boolean;
}

const FROZEN: ReadonlySet<Phase> = new Set(['posting', 'unknown', 'uncertain']);

/** Showing what was answered rather than the live interaction. */
export const cardFrozen = (state: InteractionCardState): boolean => state.submission !== undefined && FROZEN.has(state.submission.phase);
export const cardShown = (state: InteractionCardState): NativeInteraction => cardFrozen(state) ? state.submission!.interaction : state.interaction;
export const cardDraft = (state: InteractionCardState): NativeInteractionDraft => cardFrozen(state) ? state.submission!.draft : state.draft;
/** The controls are off. A refused (`stale`) answer is not busy: the reader may pick again and resubmit. */
export const cardBusy = (state: InteractionCardState): boolean => state.syncing || cardFrozen(state) || state.submission?.phase === 'success';
export const cardCanRetry = (state: InteractionCardState): boolean => state.submission?.phase === 'unknown' && !state.syncing;
export const cardCanSync = (state: InteractionCardState): boolean => ['unknown', 'stale', 'uncertain'].includes(state.submission?.phase ?? '');
/** The draft to keep across a remount; nothing when the reader has not changed it. */
export const cardStoredDraft = (state: InteractionCardState): NativeInteractionDraft | undefined =>
  state.edited && state.draft.revision === state.interaction.revision ? state.draft : undefined;

/** Free text the CLI holds in a multi-select cannot be cleared, per the server. */
export const otherTextLocked = (interaction: NativeInteraction): boolean => interaction.multiple === true && interaction.otherSelected === true;

/**
 * The card as it mounts, from what was stored for this interaction. An answer still `posting` when the
 * card went away belongs to a request the new card cannot await, so it comes back `unknown` and is
 * retried as the same request. A stored draft is always one the reader changed.
 */
export function restoreInteractionCard(interaction: NativeInteraction, savedDraft?: NativeInteractionDraft, savedSubmission?: NativeInteractionSubmission): InteractionCardState {
  const kept = savedSubmission && savedSubmission.interaction.id === interaction.id && savedSubmission.interaction.revision === interaction.revision
    ? savedSubmission.phase === 'posting' ? { ...savedSubmission, phase: 'unknown' as const } : savedSubmission
    : undefined;
  const base: InteractionCardState = {
    interaction, appliedRevision: interaction.revision, draft: snapshotNativeInteractionDraft(interaction), edited: false, syncing: false, synced: false,
    ...(kept ? { submission: kept } : {}),
  };
  if (!savedDraft) return base;
  if (savedDraft.revision !== interaction.revision) return { ...base, notice: 'draft_stale' };
  return { ...base, draft: validDraft(interaction, savedDraft), edited: true };
}

function validDraft(interaction: NativeInteraction, saved: NativeInteractionDraft): NativeInteractionDraft {
  const ids = new Set(interaction.options.map((option) => option.id));
  const selected = saved.selectedIds.filter((id) => ids.has(id));
  const otherText = sanitizeNativeOtherText(saved.otherText);
  return { revision: interaction.revision, selectedIds: interaction.multiple ? selected : otherText ? [] : selected.slice(0, 1), otherText };
}

/** The server sent the interaction again (a redraw, the next question of the same request). */
export function interactionChanged(state: InteractionCardState, next: NativeInteraction): InteractionCardState {
  return settle({ ...state, interaction: next });
}

function settle(state: InteractionCardState): InteractionCardState {
  if (state.interaction.revision === state.appliedRevision || (cardFrozen(state) && !state.synced)) return state;
  const phase = state.submission?.phase;
  const notice: InteractionNotice | undefined = phase === 'success' ? undefined
    : state.synced && (phase === 'unknown' || phase === 'uncertain') ? 'unconfirmed'
      : phase !== undefined || state.edited ? 'draft_stale' : undefined;
  const { submission: _submission, notice: _notice, error: _error, ...rest } = state;
  return {
    ...rest, appliedRevision: state.interaction.revision, draft: snapshotNativeInteractionDraft(state.interaction), edited: false, synced: false,
    ...(notice ? { notice } : {}),
  };
}

function edit(state: InteractionCardState, draft: NativeInteractionDraft): InteractionCardState {
  const { notice: _notice, ...rest } = state;
  return { ...rest, draft, edited: true };
}

/** A press on an option: toggles it in a multi-select, else selects it alone and drops the free text. */
export function selectOption(state: InteractionCardState, optionId: string): InteractionCardState {
  if (cardBusy(state)) return state;
  const current = cardDraft(state);
  return edit(state, cardShown(state).multiple
    ? { ...current, selectedIds: current.selectedIds.includes(optionId) ? current.selectedIds.filter((id) => id !== optionId) : [...current.selectedIds, optionId] }
    : { ...current, selectedIds: [optionId], otherText: '' });
}

/** Typing in the free-text field. Text replaces a single-select's choice; a locked field cannot be cleared. */
export function changeOtherText(state: InteractionCardState, value: string): InteractionCardState {
  if (cardBusy(state)) return state;
  const current = cardDraft(state);
  const shown = cardShown(state);
  const otherText = sanitizeNativeOtherText(value);
  if (otherTextLocked(shown) && current.otherText && !otherText) return state;
  return edit(state, { ...current, otherText, selectedIds: shown.multiple || !otherText ? current.selectedIds : [] });
}

/** The request an action sends with the current draft. Free text goes only to an interaction that takes it. */
export function interactionRequest(interaction: NativeInteraction, draft: NativeInteractionDraft, action: string, requestId: string): NativeInteractionResponse {
  return { interactionId: interaction.id, revision: interaction.revision, requestId, action, ...interactionSelection(interaction, action, draft) };
}

/** Sending `action`; `undefined` while the controls are off. The caller posts `submission.request`. */
export function submitInteraction(state: InteractionCardState, action: string, requestId: string): InteractionCardState | undefined {
  if (cardBusy(state)) return undefined;
  const shown = cardShown(state);
  const draft = cardDraft(state);
  const { notice: _notice, error: _error, ...rest } = state;
  return { ...rest, synced: false, submission: { phase: 'posting', interaction: shown, request: interactionRequest(shown, draft, action, requestId), draft } };
}

/** Sending an inconclusive answer again, as the same request; `undefined` when there is none. */
export function retryInteraction(state: InteractionCardState): InteractionCardState | undefined {
  if (!cardCanRetry(state)) return undefined;
  const { error: _error, ...rest } = state;
  const { message: _message, ...submission } = state.submission!;
  return { ...rest, synced: false, submission: { ...submission, phase: 'posting' } };
}

const answering = (state: InteractionCardState, requestId: string) =>
  state.submission?.phase === 'posting' && state.submission.request.requestId === requestId;

/** The server answered request `requestId`. */
export function interactionResponded(state: InteractionCardState, requestId: string, status: NativeInteractionResult['status'], message?: string): InteractionCardState {
  if (!answering(state, requestId)) return state;
  const taken = status !== 'uncertain';
  const { message: _message, ...submission } = state.submission!;
  return settle({
    ...state, edited: state.edited && !taken,
    submission: { ...submission, phase: taken ? 'success' : 'uncertain', ...(message ? { message } : {}) },
  });
}

/**
 * Request `requestId` failed with HTTP `status`, or with no response at all (`undefined`). A refusal of
 * the revision (409) is `stale`; a result that may have landed (no response, 5xx) is `unknown` and retried
 * as the same request; anything else was refused outright and leaves the draft to fix.
 */
export function interactionFailed(state: InteractionCardState, requestId: string, status: number | undefined, message?: string): InteractionCardState {
  if (!answering(state, requestId)) return state;
  const { message: _message, ...submission } = state.submission!;
  if (status === 409) return settle({ ...state, submission: { ...submission, phase: 'stale' } });
  if (status === undefined || status === 0 || status >= 500) return settle({ ...state, submission: { ...submission, phase: 'unknown' } });
  const { submission: _submission, ...rest } = state;
  return settle({ ...rest, error: { kind: 'submit', ...(message ? { message } : {}) } });
}

export function interactionSyncStarted(state: InteractionCardState): InteractionCardState {
  const { error: _error, ...rest } = state;
  return { ...rest, syncing: true };
}

export function interactionSyncFailed(state: InteractionCardState, message?: string): InteractionCardState {
  return { ...state, syncing: false, error: { kind: 'sync', ...(message ? { message } : {}) } };
}

/**
 * The reader's sync returned `fresh`, the server's interaction now (`null`: it is gone). When it is still
 * the question a refused answer was sent to, that answer is dropped and the reader asked to check the
 * choice. A terminal's visible dialog can also reset an uncertain answer; an unchanged protocol request
 * cannot confirm resolution and must keep it frozen. An `unknown` one keeps its same-request retry.
 * The draft is never touched here: a newer revision applies as any other, including one that waited.
 */
export function interactionSynced(state: InteractionCardState, fresh: NativeInteraction | null): InteractionCardState {
  const base: InteractionCardState = { ...state, syncing: false, synced: true };
  const sent = state.submission;
  if (!fresh) {
    if (sent?.phase !== 'stale') return base;
    const { submission: _submission, ...rest } = base;
    return rest;
  }
  const sameQuestion = sent !== undefined && fresh.id === sent.request.interactionId && fresh.revision === sent.request.revision;
  if (sameQuestion && sent.phase === 'uncertain' && (fresh.transport === 'protocol' || sent.interaction.transport === 'protocol')) {
    // The candidate may already have been sent. Seeing the pending request again is not a resolution
    // and must not permit a second side effect with a new requestId, now or on a later redraw.
    return { ...base, synced: false };
  }
  if (sameQuestion && (sent.phase === 'stale' || sent.phase === 'uncertain')) {
    const { submission: _submission, ...rest } = base;
    return settle({ ...rest, notice: 'unconfirmed' });
  }
  return settle(base);
}
