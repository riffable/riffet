import type { CouncilDiscussion } from '../../../../../packages/contracts/src/index.js';
import { seatsOf } from './shared.js';

/** Adjacent character pairs in the debaters' completed answers. A pair never spans two speakers. */
function statementPairs(discussion: CouncilDiscussion, round: number): Set<string> {
  const pairs = new Set<string>();
  for (const speech of discussion.speeches) {
    if (speech.round !== round || speech.phase !== 'statement' || speech.status !== 'done') continue;
    const text = speech.text.replace(/\s+/g, '');
    for (let i = 1; i < text.length; i++) pairs.add(text.slice(i - 1, i + 1));
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
