/**
 * Compare the prompt this app sent with the copy the CLI stored.
 *
 * Text delivered through the terminal can reach the CLI as one or two U+FFFD replacement characters,
 * so the stored copy both loses the original character and gains code units. An exact comparison
 * therefore refuses to recognise a message the CLI clearly received: the run stays `uncertain`, its
 * delivery fence never lifts, and every later message waits in the queue.
 *
 * The comparison walks both texts in order with a small skip budget, spent on whichever side is
 * currently longer, so a mangled character realigns the rest of the text. The budget is a
 * percentage of the shorter text, which keeps a genuinely different prompt from matching.
 *
 * Whitespace is compared by position, not by kind or count: the TUI expands a pasted tab to the
 * next tab stop, so a crash report or a table can store hundreds more characters than were sent.
 *
 * Both sides of the app must use this one rule: the web transcript joins a store receipt to its run
 * with it, and the server binds the run to the receipt with it. Divergence reintroduces the bug.
 */
export function samePromptText(sentText: string, storedText: string): boolean {
  const sent = collapseWhitespace(sentText);
  const stored = collapseWhitespace(storedText);
  const longest = Math.max(sent.length, stored.length);
  if (!longest) return true;
  if (Math.abs(sent.length - stored.length) > Math.max(4, longest * 0.01)) return false;
  // An empty side would satisfy the loop below without comparing anything.
  if (!sent || !stored) return sent === stored;
  // One mangled character costs two units of budget (a replacement pair, plus the extra code unit
  // it may add). The observed rate is a few per thousand characters, so ~1% of the shorter text
  // covers real mangling while a short prompt still needs to agree almost character for character;
  // the cap keeps a very long prompt from tolerating a wholesale rewrite.
  let budget = Math.min(32, Math.max(3, Math.ceil(Math.min(sent.length, stored.length) * 0.01)));
  let surplus = stored.length - sent.length;
  let index = 0;
  let other = 0;
  while (index < sent.length && other < stored.length) {
    if (sent[index] === stored[other]) { index += 1; other += 1; continue; }
    if (budget === 0) return false;
    budget -= 1;
    // A mangled character is a replacement pair, and the replacement may also be one code unit
    // longer or shorter on one side.
    index += 1;
    other += 1;
    if (surplus > 0) { other += 1; surplus -= 1; }
    else if (surplus < 0) { index += 1; surplus += 1; }
  }
  return true;
}

const collapseWhitespace = (text: string) => text.replace(/[ \t\n\r\f\v]+/g, ' ').replace(/^ | $/g, '');
