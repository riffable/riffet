import type { CouncilDiscussion } from '../../../../../packages/contracts/src/index.js';
import {
  LANGUAGE_RULE, latestDirective, SEAT_RULE, seatsOf, speak, speaker, spoken, wordLimit,
  type FormatSpec, type SpeechPrompt, type Step,
} from './shared.js';

/**
 * Free debate among several models. Each round all speak at once, unaware of each other's current
 * speech; then the moderator sums up and records who challenged whom, which next round's prompts
 * put to the challenged. It ends on the moderator's call (in `auto`), the round limit or the reader.
 */

function statementTask(d: CouncilDiscussion, seatId: string, round: number): SpeechPrompt {
  const moderation = latestDirective(d, 'summary', 'moderation');
  const challenges = moderation?.challenges.filter(c => c.to === seatId) ?? [];
  return {
    task: [
      challenges.length ? `You were challenged directly:\n${challenges.map(c => `- ${speaker(d, c.from)}: ${c.point}`).join('\n')}\n` : '',
      moderation?.unanswered ? `The moderator noticed a question everyone avoided: ${moderation.unanswered}\n` : '',
      round === 1 ? 'Round 1: give your opening position and your reasons.' : `Round ${round}: give your statement. Open with a one-sentence claim, do not repeat what you said before, and answer any challenge head-on.`,
      `At most ${wordLimit(1800, seatsOf(d, 'debater').length)} words.`,
    ].filter(Boolean).join('\n'),
  };
}

const MODERATION_SHAPE = '{"positions":[{"seatId":"s1","stance":"one line"}],"challenges":[{"from":"s1","to":"s2","point":"what s1 pressed on s2"}],"unanswered":"a question every participant avoided, or null","convergence":"divergent|partial|converging|consensus","action":"continue|conclude"}';

const summaryTask = (round: number): SpeechPrompt => ({
  task: `Sum up round ${round} for the reader in at most 300 words: each position in one line, the sharpest clash, what moved since last round. You may end with one pointed question to a specific participant, starting "I notice".`,
  record: `${MODERATION_SHAPE}\nSeat ids are the bracketed ids. "action" is "conclude" when the positions have converged or the round added little that was new.`,
});

const CONCLUSION: SpeechPrompt = {
  task: [
    'The discussion is over. Write the conclusion for the reader and answer the topic directly.',
    'If the participants converged, state the answer and the conditions it holds under. If not, map the divergence: each camp, its premise, and what evidence would settle it. End with what the reader should do next.',
    'At most 500 words.',
  ].join('\n'),
};

export const roundtable: FormatSpec = {
  brief(d, seat) {
    const debaters = seatsOf(d, 'debater');
    if (seat.role === 'moderator') {
      return [
        `You moderate a roundtable debate among ${debaters.length} AI models: ${debaters.map(s => speaker(d, s.id)).join(', ')}. After each round you sum it up for the reader; at the end you write the conclusion.`,
        SEAT_RULE, LANGUAGE_RULE, '', `Topic: ${d.topic}`,
      ].join('\n');
    }
    return [
      `You are one of ${debaters.length} AI models in a roundtable debate. You are different models with different training; those differences are the point, so do not converge out of politeness. You may question the framing of the topic itself.`,
      `You are ${speaker(d, seat.id)}. The others: ${debaters.filter(s => s.id !== seat.id).map(s => speaker(d, s.id)).join(', ')}. A moderator sums up each round.`,
      SEAT_RULE, LANGUAGE_RULE, '', `Topic: ${d.topic}`,
    ].join('\n');
  },
  plan(d): Step {
    const round = d.round;
    const moderator = seatsOf(d, 'moderator')[0]!.id;
    const conclusion = () => spoken(d, round, 'conclusion') ? { kind: 'done' as const } : speak({ seatId: moderator, round, phase: 'conclusion', prompt: CONCLUSION });
    if (d.concluding) return conclusion();
    const missing = seatsOf(d, 'debater').filter(s => !spoken(d, round, 'statement', s.id));
    if (missing.length) return speak(...missing.map(s => ({ seatId: s.id, round, phase: 'statement' as const, prompt: statementTask(d, s.id, round) })));
    if (!spoken(d, round, 'summary')) return speak({ seatId: moderator, round, phase: 'summary', prompt: summaryTask(round) });
    if (round >= d.maxRounds) return conclusion();
    return { kind: 'round-end' };
  },
  autoAdvance(d) {
    const moderation = spoken(d, d.round, 'summary')?.directive;
    if (moderation?.kind === 'moderation' && (moderation.action === 'conclude' || moderation.convergence === 'consensus')) d.concluding = true;
  },
  conclude(d) {
    d.concluding = true;
  },
};
