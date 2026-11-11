import type { NativeInteraction } from '@contracts';
import { describe,expect,it } from 'vitest';
import { interactionSelection,interactionSelectsOptions,restoreNativeInteractionSubmission,serializeNativeInteractionSubmission } from './nativeInteractionDraft';

function interaction(input: Partial<NativeInteraction>): NativeInteraction {
  return {
    id: 'i1', revision: '1', transport: 'protocol', requestId: 'r1', kind: 'question',
    title: 'Question', options: [], actions: [], ...input,
  } as NativeInteraction;
}

/** The plan review DSH sends when the model calls `exit_plan_mode`. */
const planReview = interaction({
  kind: 'plan',
  title: 'Plan review',
  message: 'Approve this plan and leave plan mode?\n\n## Plan',
  options: [
    { id: 'option:0', label: 'Approve', selected: false },
    { id: 'option:1', label: 'Keep planning', selected: false },
  ],
  actions: [{ id: 'submit', label: 'Submit', tone: 'primary' }, { id: 'cancel', label: 'Cancel', tone: 'danger' }],
});

describe('interaction option selection', () => {

  it('sends the chosen option with a plan review submit, which is what approves it', () => {
    const draft = { revision: '1', selectedIds: ['option:0'], otherText: '' };
    expect(interactionSelection(planReview, 'submit', draft)).toEqual({ selectedIds: ['option:0'] });
    // Cancel carries nothing: it is the reader backing out, not an answer.
    expect(interactionSelection(planReview, 'cancel', draft)).toEqual({});
    // An empty selection must stay empty rather than defaulting to the first row.
    expect(interactionSelection(planReview, 'submit', { revision: '1', selectedIds: [], otherText: '' })).toEqual({});
  });

  it('answers a protocol question that has only a text field', () => {
    // DSH's question with no options: `submit` plus the free-text field is the whole answer.
    const freeText = interaction({
      kind: 'question', allowOther: true, options: [],
      actions: [{ id: 'submit', label: 'Submit', tone: 'primary' }, { id: 'cancel', label: 'Cancel' }],
    });
    expect(interactionSelectsOptions(freeText)).toBe(true);
    expect(interactionSelection(freeText, 'submit', { revision: '1', selectedIds: [], otherText: '换 main 分支' })).toEqual({ otherText: '换 main 分支' });
    // An empty answer stays empty: the server rejects it, the card disables the button instead.
    expect(interactionSelection(freeText, 'submit', { revision: '1', selectedIds: [], otherText: '  ' })).toEqual({});
    expect(interactionSelection(freeText, 'cancel', { revision: '1', selectedIds: [], otherText: '换 main 分支' })).toEqual({});
  });
});

/**
 * An unconfirmed answer survives reopening the conversation, keeping retries on the same request
 * rather than sending a second, fresh answer to a live dialog.
 */
describe('unconfirmed submission persistence', () => {
  const submission = (phase: 'posting' | 'unknown' | 'uncertain' | 'stale' | 'success') => ({
    phase,
    interaction: planReview,
    request: { interactionId: 'i1', revision: '1', requestId: 'req-1', action: 'submit', selectedIds: ['option:0'] },
    draft: { revision: '1', selectedIds: ['option:0'], otherText: '顺带改个名' },
    message: '结果未确认；重试会使用相同请求。',
  });

  it('round-trips an inconclusive answer with its request id and draft', () => {
    const restored = restoreNativeInteractionSubmission(serializeNativeInteractionSubmission(submission('unknown')));
    expect(restored).toEqual(submission('unknown'));
    expect(restored?.request.requestId).toBe('req-1');
    expect(restored?.draft.otherText).toBe('顺带改个名');
  });

  it('ignores storage that is not a shape the card can render', () => {
    expect(restoreNativeInteractionSubmission(null)).toBeUndefined();
    expect(restoreNativeInteractionSubmission('not json')).toBeUndefined();
    expect(restoreNativeInteractionSubmission(JSON.stringify({ ...submission('unknown'), phase: 'waiting' }))).toBeUndefined();
    expect(restoreNativeInteractionSubmission(JSON.stringify({ ...submission('unknown'), request: { requestId: 'req-1' } }))).toBeUndefined();
    expect(restoreNativeInteractionSubmission(JSON.stringify({ ...submission('unknown'), interaction: { id: 'i1' } }))).toBeUndefined();
    expect(restoreNativeInteractionSubmission(JSON.stringify({ ...submission('unknown'), draft: { revision: '1' } }))).toBeUndefined();
  });
});
