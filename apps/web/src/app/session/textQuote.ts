import type { MarkQuote } from '@contracts';

/**
 * Highlights (片段收藏) are W3C TextQuoteSelectors over a message's rendered plain text — the
 * `textContent` of its Markdown body — so neither the stored text nor the DOM is ever changed to
 * mark one. Offsets are only hints; the quote and its context are what find it again.
 */

/** Characters of context kept on each side of a quote. */
export const QUOTE_CONTEXT = 32;

/** Offset of the boundary point ([container], [offset]) within [root]'s text. */
export function textOffset(root: Node, container: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(container, offset);
  return range.toString().length;
}

/** The quote for [start, end) of [text], with leading and trailing whitespace left out. */
export function quoteAt(text: string, start: number, end: number): MarkQuote | undefined {
  while (start < end && /\s/.test(text[start]!)) start += 1;
  while (end > start && /\s/.test(text[end - 1]!)) end -= 1;
  if (end <= start) return undefined;
  return { exact: text.slice(start, end), prefix: text.slice(Math.max(0, start - QUOTE_CONTEXT), start), suffix: text.slice(end, end + QUOTE_CONTEXT), start, end };
}

/** How many characters [a] and [b] share at their ends ([fromEnd]) or starts. */
function shared(a: string, b: string, fromEnd: boolean): number {
  let count = 0;
  const limit = Math.min(a.length, b.length);
  while (count < limit && (fromEnd ? a[a.length - 1 - count] === b[b.length - 1 - count] : a[count] === b[count])) count += 1;
  return count;
}

/** The occurrence of [exact] in [text] whose surroundings best match the quote's. */
function bestMatch(text: string, exact: string, prefix: string, suffix: string, hint: number | undefined): number | undefined {
  if (!exact) return undefined;
  let best: number | undefined;
  let bestScore = -Infinity;
  for (let at = text.indexOf(exact); at >= 0; at = text.indexOf(exact, at + 1)) {
    const context = shared(text.slice(Math.max(0, at - prefix.length), at), prefix, true) + shared(text.slice(at + exact.length, at + exact.length + suffix.length), suffix, false);
    // Context decides; the stored offset only breaks a tie.
    const score = context * 1_000_000 - (hint === undefined ? 0 : Math.abs(at - hint));
    if (score > bestScore) { bestScore = score; best = at; }
  }
  return best;
}

/** [text] with every run of whitespace collapsed to one space, and where each character came from. */
function collapse(text: string): { value: string; origin: number[] } {
  let value = '';
  const origin: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (/\s/.test(text[index]!)) {
      if (value.endsWith(' ')) continue;
      value += ' ';
    } else value += text[index];
    origin.push(index);
  }
  return { value, origin };
}

/**
 * Where [quote] is in [text] now: the exact text, disambiguated by its context, or failing that the
 * same text with whitespace collapsed on both sides (two renderers rarely agree on line breaks).
 */
export function findQuote(text: string, quote: MarkQuote): { start: number; end: number } | undefined {
  const at = bestMatch(text, quote.exact, quote.prefix, quote.suffix, quote.start);
  if (at !== undefined) return { start: at, end: at + quote.exact.length };
  const haystack = collapse(text);
  const exact = collapse(quote.exact.trim()).value;
  const found = bestMatch(haystack.value, exact, collapse(quote.prefix).value, collapse(quote.suffix).value, undefined);
  if (found === undefined) return undefined;
  return { start: haystack.origin[found]!, end: haystack.origin[found + exact.length - 1]! + 1 };
}

/** A range over [start, end) of [root]'s text, or nothing when the text is shorter than that. */
export function rangeAt(root: Node, start: number, end: number): Range | undefined {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let position = 0;
  let started = false;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const length = node.data.length;
    if (!started && start < position + length) { range.setStart(node, start - position); started = true; }
    if (started && end <= position + length) { range.setEnd(node, end - position); return range; }
    position += length;
  }
  return undefined;
}
