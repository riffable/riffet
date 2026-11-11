import type { NativeInteraction, NativeInteractionResponse } from '@contracts';

export interface NativeInteractionDraft {
  revision: string;
  selectedIds: string[];
  otherText: string;
}

/**
 * An answer that was sent but is not confirmed yet.
 *
 * Persist the frozen request with the draft so reopening the conversation can retry an
 * inconclusive result with the same `requestId`, rather than sending a second, fresh answer.
 */
export interface NativeInteractionSubmission {
  phase: 'posting' | 'unknown' | 'uncertain' | 'stale' | 'success';
  interaction: NativeInteraction;
  request: NativeInteractionResponse;
  draft: NativeInteractionDraft;
  message?: string;
}

/**
 * Every phase is kept. A `posting` one belongs to a promise a remount cannot await; the card's state
 * machine brings it back `unknown` (`restoreInteractionCard`), retried as the same request.
 */
const PHASES: ReadonlySet<NativeInteractionSubmission['phase']> = new Set(['posting', 'unknown', 'uncertain', 'stale', 'success']);

export function serializeNativeInteractionSubmission(submission: NativeInteractionSubmission): string {
  return JSON.stringify(submission);
}

/** Parses a stored submission, ignoring anything that is not a shape the card can render. */
export function restoreNativeInteractionSubmission(serialized: string | null): NativeInteractionSubmission | undefined {
  if (!serialized) return undefined;
  try {
    const saved = JSON.parse(serialized) as Partial<NativeInteractionSubmission>;
    if (typeof saved.phase !== 'string' || !PHASES.has(saved.phase)) return undefined;
    const { interaction, request, draft } = saved;
    if (!interaction || typeof interaction.id !== 'string' || typeof interaction.revision !== 'string'
      || !Array.isArray(interaction.options) || !Array.isArray(interaction.actions)) return undefined;
    if (!request || typeof request.requestId !== 'string' || typeof request.interactionId !== 'string'
      || typeof request.revision !== 'string' || typeof request.action !== 'string') return undefined;
    if (!draft || typeof draft.revision !== 'string' || !Array.isArray(draft.selectedIds) || typeof draft.otherText !== 'string') return undefined;
    return {
      phase: saved.phase as NativeInteractionSubmission['phase'],
      interaction,
      request,
      draft: { revision: draft.revision, selectedIds: draft.selectedIds.filter((id): id is string => typeof id === 'string'), otherText: draft.otherText },
      ...(typeof saved.message === 'string' ? { message: saved.message } : {}),
    };
  } catch {
    return undefined;
  }
}

export function snapshotNativeInteractionDraft(interaction: NativeInteraction): NativeInteractionDraft {
  const selectedIds = interaction.options.filter((option) => option.selected).map((option) => option.id);
  const otherSelected = interaction.otherSelected === true;
  return {
    revision: interaction.revision,
    selectedIds: interaction.multiple ? selectedIds : otherSelected ? [] : selectedIds.slice(0, 1),
    otherText: otherSelected ? interaction.otherValue ?? '' : '',
  };
}

/** Parses a stored draft; which revision it fits and which of its options still exist is the card's to decide. */
export function parseNativeInteractionDraft(serialized: string | null): NativeInteractionDraft | undefined {
  if (!serialized) return undefined;
  try {
    const saved = JSON.parse(serialized) as Partial<NativeInteractionDraft>;
    if (typeof saved.revision !== 'string') return undefined;
    return {
      revision: saved.revision,
      selectedIds: Array.isArray(saved.selectedIds) ? saved.selectedIds.filter((id): id is string => typeof id === 'string') : [],
      otherText: typeof saved.otherText === 'string' ? saved.otherText : '',
    };
  } catch {
    return undefined;
  }
}

export function sanitizeNativeOtherText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 2000);
}

/** The two actions that carry a selection; every other action is a plain keystroke. */
const SELECTING_ACTIONS = new Set(['answer', 'submit']);

/**
 * Whether this interaction selects before submitting. Protocol questions do, and so does the plan
 * review DSH sends — `options: [Approve, Keep planning]` with one `submit` action and no `answer` —
 * whose answer has to name the chosen option or the CLI receives an empty selection and the model's
 * blocked `exit_plan_mode` never returns. A question with no options at all still selects: its
 * answer is the free-text field.
 *
 * Lifted terminal dialogs are deliberately *not* selecting: their rows are pressed directly as
 * `option:*` actions, which is what moves the CLI's own focus and key.
 */
export function interactionSelectsOptions(interaction: Pick<NativeInteraction, 'options' | 'actions'> & { allowOther?: boolean }): boolean {
  const hasSomethingToAnswer = interaction.options.length > 0 || interaction.allowOther === true;
  return hasSomethingToAnswer && interaction.actions.some((action) => SELECTING_ACTIONS.has(action.id));
}

/**
 * The selection an action carries, or nothing for actions that only press a key. `otherText` belongs
 * to the interaction's own free-text field, which only a question has.
 */
export function interactionSelection(
  interaction: Pick<NativeInteraction, 'options' | 'actions'> & { allowOther?: boolean },
  action: string,
  draft: NativeInteractionDraft,
): { selectedIds?: string[]; otherText?: string } {
  if (!interactionSelectsOptions(interaction) || !SELECTING_ACTIONS.has(action)) return {};
  return {
    ...(draft.selectedIds.length ? { selectedIds: [...draft.selectedIds] } : {}),
    ...(interaction.allowOther && draft.otherText.trim() ? { otherText: draft.otherText } : {}),
  };
}
