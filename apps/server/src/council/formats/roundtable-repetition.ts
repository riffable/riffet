import type { CouncilDiscussion } from '../../../../../packages/contracts/src/index.js';
import { seatsOf } from './shared.js';

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const words = new Intl.Segmenter(undefined, { granularity: 'word' });

/**
 * Wording units of one answer: adjacent character pairs inside CJK runs, adjacent word pairs elsewhere. Character
 * pairs saturate for alphabetic text (a few hundred letters already cover most common pairs), so those use words.
 */
function addUnits(text: string, units: Set<string>): void {
  for (const run of text.match(CJK_RUN) ?? []) {
    for (let i = 1; i < run.length; i++) units.add(run.slice(i - 1, i + 1));
  }
  const tokens = [...words.segment(text.replace(CJK_RUN, ' '))].filter(s => s.isWordLike).map(s => s.segment.toLowerCase());
  for (let i = 1; i < tokens.length; i++) units.add(`${tokens[i - 1]} ${tokens[i]}`);
}

/** Wording units in the debaters' completed answers. A unit never spans two speakers. */
function statementPairs(discussion: CouncilDiscussion, round: number): Set<string> {
  const pairs = new Set<string>();
  for (const speech of discussion.speeches) {
    if (speech.round !== round || speech.phase !== 'statement' || speech.status !== 'done') continue;
    addUnits(speech.text, pairs);
  }
  return pairs;
}
/** Counts up to two consecutive rounds of repeated wording. This steers the next prompt, never a verdict. */
export function repeatedRoundCount(discussion: CouncilDiscussion, throughRound: number): number {
  if (throughRound < 2) return 0;
  // Two speakers naturally reuse more vocabulary when exploring the same point.
  const threshold = seatsOf(discussion, 'debater').length <= 2 ? 0.8 : 0.7;
  let current = statementPairs(discussion, throughRound);
  let count = 0;
  for (let round = throughRound - 1; round >= 1 && count < 2; round--) {
    const previous = statementPairs(discussion, round);
    const smallerSize = Math.min(previous.size, current.size);
    if (!smallerSize) break;
    let common = 0;
    for (const pair of current) if (previous.has(pair)) common++;
    if (common <= smallerSize * threshold) break;
    count++;
    current = previous;
  }
  return count;
}
