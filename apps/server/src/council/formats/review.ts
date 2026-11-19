import type { CouncilDiscussion, CouncilReviewTask } from '../../../../../packages/contracts/src/index.js';
import { LANGUAGE_RULE, SEAT_RULE, seatsOf, speak, spoken, type FormatSpec, type SpeechPrompt, type Step } from './shared.js';

/**
 * Review: each reviewer reads the document from its own angle and proposes paragraph edits
 * (round 1); the reader accepts some; the editor merges the accepted ones into a revised document.
 */

export const REVIEW_TASKS: readonly CouncilReviewTask[] = ['correct', 'augment', 'diagnose', 'restructure'];

const FOCUS: Record<CouncilReviewTask, string> = {
  correct: 'errors: wrong facts, contradictions in the reasoning, missed edge cases, statements that cannot work as written',
  augment: 'omissions: unstated premises, missing branches or states, failure handling, permissions',
  diagnose: 'risks: security, performance, compatibility, hidden assumptions, information the reader would need',
  restructure: 'structure: order, context that should come first, sections mixing different concerns',
};

const DOCUMENT_LANGUAGE = LANGUAGE_RULE.replace('the topic is', 'the document is');

function numbered(d: CouncilDiscussion): string {
  return `${d.document?.title ? `Document: ${d.document.title}\n\n` : ''}${(d.document?.paragraphs ?? []).map(p => `[${p.id}] ${p.text}`).join('\n\n')}`;
}

const EDITS_SHAPE = '{"edits":[{"para":"P3","title":"short title","before":"the exact text in that paragraph to replace (its last sentence when inserting after it)","after":"the replacement text"}]}';

const REVIEW: SpeechPrompt = {
  task: 'Write a short review for the reader, at most 200 words: what matters most from your angle.',
  record: `${EDITS_SHAPE}\nPropose one to four edits, most important first. "before" must be copied exactly from the paragraph.`,
};

function mergeTask(d: CouncilDiscussion): SpeechPrompt {
  const accepted = new Set(d.accepted ?? []);
  const edits = d.speeches.flatMap(s => s.directive?.kind === 'edits' ? s.directive.edits : []).filter(e => accepted.has(e.id));
  return {
    task: [
      'The reader accepted these edits:',
      edits.map(e => `- [${e.para}] ${e.title}\n  replace: ${e.before || '(insert after the paragraph)'}\n  with: ${e.after}`).join('\n'),
      '',
      'Apply them to the document and output the full revised document in Markdown, and nothing else. Leave everything the edits do not touch as it was. Drop the paragraph tags.',
    ].join('\n'),
  };
}

export const review: FormatSpec = {
  brief(d, seat) {
    const lead = seat.role === 'editor'
      ? 'You are the editor of a document other AI models review. When the reader has accepted some of their edits, you merge those into a revised document.'
      : `You review a document from one angle only — ${FOCUS[seat.task ?? 'correct']}. Paragraphs are tagged [P1], [P2] and so on.`;
    return [lead, SEAT_RULE, DOCUMENT_LANGUAGE, '', numbered(d)].join('\n');
  },
  // Reviews are independent, and the editor works from the accepted edits alone.
  hears: () => false,
  plan(d): Step {
    if (d.round === 1) {
      const missing = seatsOf(d, 'reviewer').filter(s => !spoken(d, 1, 'review', s.id));
      if (missing.length) return speak(...missing.map(s => ({ seatId: s.id, round: 1, phase: 'review' as const, prompt: REVIEW })));
      return { kind: 'round-end' };
    }
    if (spoken(d, 2, 'conclusion') || !(d.accepted ?? []).length) return { kind: 'done' };
    return speak({ seatId: seatsOf(d, 'editor')[0]!.id, round: 2, phase: 'conclusion', prompt: mergeTask(d) });
  },
  autoAdvance(d) {
    if (d.accepted?.length) return;
    d.accepted = d.speeches.flatMap(s => s.directive?.kind === 'edits' ? s.directive.edits.map(e => e.id) : []);
  },
  conclude() {},
};
