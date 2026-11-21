/**
 * Compare the prompt this app sent with the copy the CLI stored.
 *
 * Text delivered through the terminal can reach the CLI as one or more U+FFFD replacement characters,
 * so the stored copy both loses the original character and gains code units. An exact comparison
 * therefore refuses to recognise a message the CLI clearly received: the run stays `uncertain`, its
 * delivery fence never lifts, and every later message waits in the queue.
 *
 * A difference is accepted only where one side shows that replacement character: the run of U+FFFD
 * stands for the characters the terminal mangled there, and everything else has to agree exactly.
 * Differing prompts without replacement characters cannot match (e.g. "继续" and "好的"). The
 * number of places where the replacement runs or original characters differ is capped at about 1%
 * of the shorter text, and a fuzzy match needs at least one shared character besides whitespace.
 *
 * Whitespace is compared by position, not by kind or count: the TUI expands a pasted tab to the
 * next tab stop, so a crash report or a table can store hundreds more characters than were sent.
 *
 * Both sides of the app must use this one rule: the web transcript joins a store receipt to its run
 * with it, and the server binds the run to the receipt with it. Divergence reintroduces the bug. The
 * phones' copy is `PromptMatch.kt`; `prompt-match.test.ts` and `PromptMatchTest.kt` hold the same cases.
 */
export function samePromptText(sentText: string, storedText: string): boolean {
  const sent = collapseWhitespace(sentText);
  const stored = collapseWhitespace(storedText);
  if (sent === stored) return true;
  if (!sent || !stored) return false;
  const longest = Math.max(sent.length, stored.length);
  if (Math.abs(sent.length - stored.length) > Math.max(4, longest * 0.01)) return false;
  const sentLastReplacement = sent.lastIndexOf(REPLACEMENT);
  const storedLastReplacement = stored.lastIndexOf(REPLACEMENT);
  if (sentLastReplacement === -1 && storedLastReplacement === -1) return false;
  // Mangling was observed at a few places per thousand characters; the floor lets a short prompt lose a
  // character or two, the cap keeps a very long one from tolerating a wholesale rewrite.
  const places = Math.min(32, Math.max(3, Math.ceil(Math.min(sent.length, stored.length) * 0.01)));
  // Positions reached so far, with the fewest mangled places used to get there and whether any character
  // agreed on the way. A run of replacement characters can stand for a varying number of characters, so
  // more than one alignment is followed; the work is bounded by `STEPS`.
  let frontier: Array<[number, number, boolean]> = [[0, 0, false]];
  let steps = 0;
  for (let used = 0; used <= places && frontier.length; used++) {
    const next: Array<[number, number, boolean]> = [];
    const seen = new Set<number>();
    const add = (i: number, j: number, agreed: boolean) => {
      const key = (i * (stored.length + 1) + j) * 2 + (agreed ? 1 : 0);
      if (seen.has(key)) return;
      seen.add(key);
      next.push([i, j, agreed]);
    };
    for (let [i, j, agreed] of frontier) {
      // With no more replacements on either side, the remaining suffixes must be the same length.
      if (i > sentLastReplacement && j > storedLastReplacement && sent.length - i !== stored.length - j) continue;
      for (;;) {
        const character = sent[i];
        if (character === undefined || character !== stored[j]) break;
        if (character === REPLACEMENT) {
          const run = runAt(sent, i);
          if (run !== runAt(stored, j)) break;
          i += run;
          j += run;
        } else {
          if (character !== ' ') agreed = true;
          i += 1;
          j += 1;
        }
      }
      if (i === sent.length && j === stored.length) { if (agreed) return true; continue; }
      if (used === places) continue;
      const inSent = sent[i] === REPLACEMENT;
      const inStored = stored[j] === REPLACEMENT;
      if (inSent && inStored) {
        if (++steps > STEPS) return false;
        add(i + runAt(sent, i), j + runAt(stored, j), agreed);
        continue;
      }
      if (!inSent && !inStored) continue;
      // Each replacement can stand for a whole Unicode character, including a surrogate pair.
      const run = inStored ? runAt(stored, j) : runAt(sent, i);
      const original = inStored ? sent : stored;
      let end = inStored ? i : j;
      for (let taken = 0; taken < run && end < original.length; taken++) {
        end += original.codePointAt(end)! > 0xffff ? 2 : 1;
        if (++steps > STEPS) return false;
        add(inStored ? end : i + run, inStored ? j + run : end, agreed);
      }
    }
    frontier = next;
  }
  return false;
}

const REPLACEMENT = '\uFFFD';
/** Alignments tried before giving up; a real receipt needs a handful. */
const STEPS = 4096;

function runAt(text: string, index: number): number {
  let end = index;
  while (text[end] === REPLACEMENT) end += 1;
  return end - index;
}

const collapseWhitespace = (text: string) => text.replace(/[ \t\n\r\f\v]+/g, ' ').replace(/^ | $/g, '');
