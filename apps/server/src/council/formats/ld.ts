import type { CouncilDiscussion, CouncilPhase } from '../../../../../packages/contracts/src/index.js';
import { closingRoundOf, LANGUAGE_RULE, latestDirective, SEAT_RULE, speak, spoken, type FormatSpec, type SpeechPrompt, type Step } from './shared.js';

/**
 * One-on-one Lincoln-Douglas debate. Pro carries the burden of proof, con holds presumption. Within a
 * round they speak in turn — pro first, except in the closing round, where con speaks first and pro
 * has the last word. Each speech ends with questions the other side answers first thing next time;
 * the judge keeps a ledger after every round and gives a verdict after the closing.
 */

type Side = 'pro' | 'con';
const SIDE_NAME: Record<Side, string> = { pro: 'PRO (affirmative)', con: 'CON (negative)' };

const SPEECH_WORDS = 600;
const CLOSING_WORDS = 450;

function phaseOf(d: CouncilDiscussion, round: number): CouncilPhase {
  if (round >= closingRoundOf(d)) return 'closing';
  return round === 1 ? 'opening' : 'rebuttal';
}

function phaseRules(phase: CouncilPhase, side: Side): string {
  if (phase === 'opening' && side === 'pro') {
    return 'This is your opening. State your thesis in one sentence, then build your case: two or three contentions, each with its warrant. End with your cross-examination: a line that is exactly `---`, then one or two sharp questions to CON as a numbered list, each answerable in one sentence, and nothing after them.';
  }
  if (phase === 'opening') {
    return 'This is your opening. First answer PRO\'s questions directly — yes or no, a number, or an explicit trade-off; the judge records evasion. Then build your own case and rebut PRO\'s. End with your cross-examination: a line that is exactly `---`, then one or two sharp questions to PRO as a numbered list, each answerable in one sentence, and nothing after them.';
  }
  if (phase === 'rebuttal') {
    return 'This is a rebuttal. First answer the questions your opponent\'s last speech put to you, directly. Then attack their strongest point and rebuild yours where it was hit; do not restate earlier speeches. End with your cross-examination: a line that is exactly `---`, then one or two sharp questions as a numbered list, each answerable in one sentence, and nothing after them. No softball questions.';
  }
  return side === 'con'
    ? 'This is your closing; PRO speaks after you. No new arguments and no new questions. If PRO\'s last speech asked you something, answer it first. Then crystallize: name the two issues that decide the debate and why they fall to CON.'
    : 'This is your closing and the last word of the debate. No new arguments and no new questions. Answer what CON\'s last speech asked you, then crystallize: name the two issues that decide the debate and why they fall to PRO.';
}

function debaterTask(d: CouncilDiscussion, side: Side, phase: CouncilPhase, round: number): SpeechPrompt {
  const ledger = latestDirective(d, 'ledger', 'ledger');
  const dodged = ledger?.crossExam.filter(q => q.asker !== side && q.answered !== 'direct') ?? [];
  return {
    task: [
      dodged.length ? `Questions to you the judge still counts as unanswered:\n${dodged.map(q => `- ${q.question}`).join('\n')}\n` : '',
      phaseRules(phase, side),
      `At most ${phase === 'closing' ? CLOSING_WORDS : SPEECH_WORDS} words.`,
      `Round ${round}. Give your ${phase} speech as ${side.toUpperCase()}.`,
    ].filter(Boolean).join('\n'),
  };
}

const LEDGER_SHAPE = '{"sides":{"pro":{"claim":"top claim now","reinforced":"what got stronger this round, or null","broken":"the weakness the other side exposed, or null"},"con":{…same…}},"crossExam":[{"asker":"pro|con","question":"…","answered":"direct|dodged|pending"}],"intensity":"clashing|stalling","action":"continue|closing"}';

const LEDGER_RULES = [
  'crossExam lists every question whose answer was due or given this round and every question still waiting; "pending" means the asked side has not spoken since. Quote each question as its asker wrote it. Mark "dodged" only for a real evasion.',
  '"action" is "closing" when another rebuttal would add nothing; "intensity" is "stalling" when the round repeated itself.',
].join('\n');

const ledgerTask = (round: number): SpeechPrompt => ({
  task: `Write your notes on round ${round} for the reader, at most 250 words: where the clash is, what each side reinforced, which weakness was exposed, which question was dodged.`,
  record: `${LEDGER_SHAPE}\n${LEDGER_RULES}`,
});

const VERDICT: SpeechPrompt = {
  task: [
    'The debate is over. Write the closing verdict for the reader, steel-manning both sides rather than only naming a winner. Use these parts:',
    '1. The strongest case for PRO.',
    '2. The strongest case for CON.',
    '3. Cross-examination: which questions landed and which were dodged.',
    '4. Your ruling within this debate. "Too close to call; the difference is the difficulty of the stances" is an honest option.',
    '5. What the reader should take away.',
    'At most 600 words.',
  ].join('\n'),
};

export const ld: FormatSpec = {
  brief(d, seat) {
    const resolution = `Resolution: ${d.topic}`;
    if (seat.role === 'judge') {
      return [
        'You judge a one-on-one debate between two AI models. After every round you write notes for the reader; after the closing, the verdict.',
        'Judge only what was said. Discount how much easier one stance is to argue than the other. A side drifting toward the other\'s position is collapse, not progress.',
        SEAT_RULE, LANGUAGE_RULE, '', resolution,
      ].join('\n');
    }
    const side = seat.role === 'pro' ? 'pro' : 'con';
    return [
      `You are debating one-on-one against another AI model in a Lincoln-Douglas style debate; a third model judges. You argue ${SIDE_NAME[side]} throughout.`,
      'PRO carries the burden of proof; CON holds presumption, so a tie goes to CON.',
      'Argue your side fully. You do not need to be balanced: conceding the resolution or switching sides forfeits the debate.',
      'Your strength comes from choosing and framing real considerations; never misrepresent what your opponent said.',
      SEAT_RULE, LANGUAGE_RULE, '', resolution,
    ].join('\n');
  },
  plan(d): Step {
    const round = d.round;
    const phase = phaseOf(d, round);
    const order: Side[] = phase === 'closing' ? ['con', 'pro'] : ['pro', 'con'];
    for (const side of order) {
      if (!spoken(d, round, phase, side)) return speak({ seatId: side, round, phase, prompt: debaterTask(d, side, phase, round) });
    }
    if (phase === 'closing') {
      return spoken(d, round, 'conclusion') ? { kind: 'done' } : speak({ seatId: 'judge', round, phase: 'conclusion', prompt: VERDICT });
    }
    if (!spoken(d, round, 'ledger')) return speak({ seatId: 'judge', round, phase: 'ledger', prompt: ledgerTask(round) });
    return { kind: 'round-end' };
  },
  autoAdvance(d) {
    const ledgers = d.speeches.filter(s => s.phase === 'ledger' && s.directive?.kind === 'ledger').map(s => s.directive!);
    const last = ledgers.at(-1);
    const stalled = ledgers.length >= 2 && ledgers.slice(-2).every(l => l.kind === 'ledger' && l.intensity === 'stalling');
    if ((last?.kind === 'ledger' && last.action === 'closing') || stalled) d.closingRound = Math.min(d.round + 1, d.maxRounds);
  },
  conclude(d) {
    d.closingRound = Math.min(d.round + 1, d.maxRounds);
  },
};
