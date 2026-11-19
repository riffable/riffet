import type { CouncilDiscussion } from '../../../../../packages/contracts/src/index.js';
import { LANGUAGE_RULE, latestDirective, SEAT_RULE, seatsOf, speak, speaker, spoken, type FormatSpec, type SpeechPrompt, type Step } from './shared.js';

/**
 * Prism: the participants answer independently (round 1), the observer probes where they really
 * disagree, each answers the probe aimed at it (round 2), the observer concludes. The differences
 * between models are used for collision, not for dividing the work.
 */

const EXPLORE: SpeechPrompt = {
  task: 'Answer the question independently with your most honest judgment. Take a clear position; do not hedge across every option. You may say the question itself is flawed. At most 400 words.',
};

const PROBE_SHAPE = '{"contradictions":[{"title":"short title","seats":["p1","p2"],"question":"a question those seats cannot avoid"}],"gaps":["a constraint or risk nobody raised"]}';

const PROBE: SpeechPrompt = {
  task: 'Find the real contradictions between these answers: conflicting premises, one word used in two senses, false consensus, shared blind spots. Write a short analysis for the reader, at most 250 words.',
  record: `${PROBE_SHAPE}\nSeat ids are the bracketed ids. At most four contradictions, sharpest first.`,
};

function deepenTask(d: CouncilDiscussion, seatId: string): SpeechPrompt {
  const probe = latestDirective(d, 'probe', 'probe');
  const mine = probe?.contradictions.filter(c => c.seats.includes(seatId)) ?? [];
  const questions = mine.length ? mine : probe?.contradictions ?? [];
  return {
    task: [
      questions.length ? `${mine.length ? 'Questions aimed at you' : 'The observer\'s questions'}:\n${questions.map(c => `- ${c.title}: ${c.question}`).join('\n')}\n` : '',
      'Respond to the observer\'s probe directly. If another answer convinced you, change your position and say so plainly; if not, say what keeps you where you are. At most 350 words.',
    ].filter(Boolean).join('\n'),
  };
}

const CONCLUSION: SpeechPrompt = {
  task: [
    'Answer the reader\'s question directly, drawing on the whole exchange.',
    'If the models converged, give the answer and the conditions it holds under. If not, give a structured map of where and why they differ, and which way you lean.',
    'At most 500 words.',
  ].join('\n'),
};

export const prism: FormatSpec = {
  brief(d, seat) {
    if (seat.role === 'observer') {
      return [
        `You observe ${seatsOf(d, 'participant').length} AI models answer the same question independently. You then probe where they really disagree, read their responses, and conclude for the reader.`,
        SEAT_RULE, LANGUAGE_RULE, '', `Question: ${d.topic}`,
      ].join('\n');
    }
    return [
      `You are ${speaker(d, seat.id)}, one of several AI models answering the same question. You answer on your own first; an observer then probes where the answers disagree.`,
      SEAT_RULE, LANGUAGE_RULE, '', `Question: ${d.topic}`,
    ].join('\n');
  },
  // A participant's first answer is its own: the others' come with the probe.
  hears: (d, seat) => seat.role !== 'participant' || d.round > 1,
  plan(d): Step {
    const observer = seatsOf(d, 'observer')[0]!.id;
    const participants = seatsOf(d, 'participant');
    const conclusion = () => spoken(d, d.round, 'conclusion') ? { kind: 'done' as const } : speak({ seatId: observer, round: d.round, phase: 'conclusion', prompt: CONCLUSION });
    if (d.round === 1) {
      const missing = participants.filter(s => !spoken(d, 1, 'explore', s.id));
      if (missing.length) return speak(...missing.map(s => ({ seatId: s.id, round: 1, phase: 'explore' as const, prompt: EXPLORE })));
      if (!spoken(d, 1, 'probe')) return speak({ seatId: observer, round: 1, phase: 'probe', prompt: PROBE });
      return { kind: 'round-end' };
    }
    if (d.concluding) return conclusion();
    const missing = participants.filter(s => !spoken(d, 2, 'deepen', s.id));
    if (missing.length) return speak(...missing.map(s => ({ seatId: s.id, round: 2, phase: 'deepen' as const, prompt: deepenTask(d, s.id) })));
    return conclusion();
  },
  conclude(d) {
    d.concluding = true;
  },
};
