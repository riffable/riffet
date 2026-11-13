import { createHash } from 'node:crypto';
import type { NativeInteraction, NativeInteractionResponse } from '@contracts';
import { agyRecord, type AgyRecord, type AgySnapshot } from './protocol.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (agyRecord(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonical(value[key])]),
    );
  return value;
}
export const fingerprint = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
export interface AgyInteraction {
  view: NativeInteraction;
  stepIndex: number;
  trajectoryId: string;
  executionId: string;
  request: AgyRecord;
  /** Answers the step already holds; this request's answer is the first receipt after them. */
  baseline: number;
}
export function interactionOf(snapshot: AgySnapshot): AgyInteraction | undefined {
  for (const [stepIndex, step] of snapshot.steps.entries()) {
    const request = step.requestedInteraction;
    if (!agyRecord(request) || !String(step.status).endsWith('_WAITING')) continue;
    const executionId = step.metadata?.executionId;
    if (typeof executionId !== 'string') continue;
    // One step can ask more than once, so the request is the step plus the answers it already holds.
    const baseline = Array.isArray(step.completedInteractions) ? step.completedInteractions.length : 0;
    const id = `agy:${snapshot.conversationId}:${snapshot.trajectoryId}:${executionId}:${stepIndex}:${baseline}`;
    const revision = fingerprint(request);
    const base = {
      id,
      revision,
      transport: 'protocol' as const,
      requestId: id,
      request: { conversationId: snapshot.conversationId, trajectoryId: snapshot.trajectoryId, stepIndex, executionId },
    };
    let view: NativeInteraction;
    if (agyRecord(request.permission)) {
      const permission = request.permission;
      view = {
        ...base,
        kind: 'permission',
        title: typeof permission.actionDescription === 'string' ? permission.actionDescription : 'Permission',
        ...(typeof permission.resource?.target === 'string' ? { message: permission.resource.target } : {}),
        options: [],
        actions: [
          { id: 'allow', label: 'Allow once', shortLabel: 'Allow', tone: 'primary' },
          { id: 'deny', label: 'Deny', tone: 'danger' },
        ],
      };
    } else if (Array.isArray(request.askQuestion?.questions) && request.askQuestion.questions.length === 1) {
      const question = request.askQuestion.questions[0];
      // Only the natively verified single-question/single-choice shape. Other requests stay in the TUI.
      if (
        typeof question.question !== 'string' ||
        question.allowMultiple ||
        question.multiple ||
        question.isMultiSelect ||
        !Array.isArray(question.options) ||
        question.options.some((x: unknown) => !agyRecord(x) || typeof x.id !== 'string' || typeof x.text !== 'string')
      )
        continue;
      let argumentsValue: AgyRecord = {};
      try {
        argumentsValue = JSON.parse(step.metadata?.toolCall?.argumentsJson ?? '{}');
      } catch {
        continue;
      }
      if (argumentsValue.is_multi_select || argumentsValue.questions?.some((q: AgyRecord) => q.is_multi_select || q.isMultiSelect))
        continue;
      view = {
        ...base,
        kind: 'question',
        title: question.question,
        options: question.options.map((item: AgyRecord) => ({ id: item.id, label: item.text, selected: false })),
        multiple: false,
        allowOther: false,
        actions: [{ id: 'submit', label: 'Submit', tone: 'primary' }],
      };
    } else continue;
    return { view, stepIndex, trajectoryId: snapshot.trajectoryId, executionId, request, baseline };
  }
  return undefined;
}
export function answerOf(target: AgyInteraction, response: NativeInteractionResponse): AgyRecord {
  if (response.interactionId !== target.view.id || response.revision !== target.view.revision)
    throw new Error('The Antigravity interaction changed');
  const base = { trajectoryId: target.trajectoryId, stepIndex: target.stepIndex };
  if (
    target.view.kind === 'permission' &&
    ['allow', 'deny'].includes(response.action) &&
    !response.selectedIds?.length &&
    !response.otherText
  )
    return { ...base, permission: { allow: response.action === 'allow' } };
  if (
    target.view.kind === 'question' &&
    response.action === 'submit' &&
    response.selectedIds?.length === 1 &&
    !response.otherText &&
    target.view.options.some(option => option.id === response.selectedIds![0])
  ) {
    return { ...base, askQuestion: { responses: [{ question: target.view.title, selectedOptionIds: response.selectedIds }] } };
  }
  throw new Error('This Antigravity answer is unsupported');
}
/** HTTP acceptance is not a receipt. Match the actual stored answer, including proto3 false omission. */
export function answered(snapshot: AgySnapshot, target: AgyInteraction, answer: AgyRecord): 'same' | 'different' | undefined {
  if (snapshot.trajectoryId !== target.trajectoryId) return;
  const step = snapshot.steps[target.stepIndex];
  if (step?.metadata?.executionId !== target.executionId) return;
  const receipts = step.completedInteractions;
  if (!Array.isArray(receipts)) return;
  const receipt = receipts.slice(target.baseline ?? 0).find(item => fingerprint(item.request) === target.view.revision);
  if (!receipt || !agyRecord(receipt.response)) return;
  if (answer.permission) return Boolean(receipt.response.permission?.allow) === answer.permission.allow ? 'same' : 'different';
  return fingerprint(receipt.response.askQuestion) === fingerprint(answer.askQuestion) ? 'same' : 'different';
}
