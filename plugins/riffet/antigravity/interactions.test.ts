import { describe, it, expect } from 'vitest';
import { answerOf, answered, interactionOf } from './interactions.js';
import type { AgySnapshot } from './protocol.js';
const cid = '00000000-0000-4000-8000-000000000001';
const tid = '00000000-0000-4000-8000-000000000002';
const snapshot = (): AgySnapshot => ({
  conversationId: cid,
  trajectoryId: tid,
  executors: [],
  steps: [
    {
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: { executionId: 'execution' },
      requestedInteraction: { permission: { resource: { action: 'command', target: 'printf test' } } },
    },
  ],
});
describe('Antigravity interaction target and native receipt', () => {
  it('distinguishes actual deny (proto3 omitted false) from a conflicting allow, and refuses a reused step on another execution', () => {
    const s = snapshot(),
      target = interactionOf(s)!;
    const deny = answerOf(target, { interactionId: target.view.id, revision: target.view.revision, requestId: 'request', action: 'deny' });
    expect(answered(s, target, deny)).toBeUndefined();
    s.steps[0]!.completedInteractions = [{ request: target.request, response: { trajectoryId: tid, permission: {} } }];
    expect(answered(s, target, deny)).toBe('same');
    expect(answered(s, target, { permission: { allow: true } })).toBe('different');
    // The step asks again: a new request, which the earlier answer does not settle.
    const again = interactionOf(s)!;
    expect(again.view.requestId).not.toBe(target.view.requestId);
    expect(answered(s, again, deny)).toBeUndefined();
    s.steps[0]!.metadata.executionId = 'next-execution';
    expect(answered(s, target, deny)).toBeUndefined();
    expect(() => answerOf(target, { interactionId: target.view.id, revision: 'old', requestId: 'request', action: 'allow' })).toThrow();
  });
  it('uses native option ids and withholds unsupported grouped questions', () => {
    const s = snapshot();
    s.steps[0]!.requestedInteraction = { askQuestion: { questions: [{ question: 'Color?', options: [{ id: '2', text: 'Blue' }] }] } };
    const target = interactionOf(s)!;
    expect(
      answerOf(target, {
        interactionId: target.view.id,
        revision: target.view.revision,
        requestId: 'request',
        action: 'submit',
        selectedIds: ['2'],
      }).askQuestion.responses,
    ).toEqual([{ question: 'Color?', selectedOptionIds: ['2'] }]);
    s.steps[0]!.requestedInteraction.askQuestion.questions.push({ question: 'Again', options: [] });
    expect(interactionOf(s)).toBeUndefined();
  });
});
