/** Build once per query; scores keep exact titles ahead of typo-tolerant matches. */
export function createTitleMatcher(query: string): (title: string) => number | undefined {
  const phrase = normalize(query);
  const words = phrase.split(/[\s\p{Pd}_]+/u).filter(Boolean);
  const terms = words.length ? words.flatMap((word) => /^[\p{L}\p{N}]+$/u.test(word)
    ? word.replace(/[a-z0-9]+/g, ' $& ').trim().split(/\s+/)
    : [word]) : [phrase];
  return (title) => {
    const text = normalize(title);
    if (!phrase) return query.trim() ? undefined : 0;
    if (text === phrase) return 0;
    if (text.includes(phrase)) return 100;
    const missing = terms.filter((term) => !text.includes(term));
    if (!missing.length) return 200;

    const words = text.match(/[a-z0-9]+/g) ?? [];
    let edits = 0;
    for (const term of missing) {
      // Short words, numbers and Chinese stay exact: broadening them adds mostly unrelated hits.
      if (term.length < 4 || !/^[a-z0-9]+$/.test(term) || !/[a-z]/.test(term)) return undefined;
      const limit = term.length >= 8 ? 2 : 1;
      let best = limit + 1;
      for (const word of words) {
        if (!/[a-z]/.test(word) || Math.abs(word.length - term.length) > limit) continue;
        best = Math.min(best, distance(term, word, limit));
        if (best === 1) break;
      }
      if (best > limit) return undefined;
      edits += best;
    }
    return 300 + edits;
  };
}

function normalize(text: string): string {
  // Keep technical identifiers distinct: C++, C#, .git and paths carry meaningful punctuation.
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/gu, ' ').trim();
}

/** Bounded edit distance, including a neighboring pair typed in the wrong order. ASCII only. */
function distance(left: string, right: string, limit: number): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let beforePrevious = previous;
  for (let i = 1; i <= left.length; i += 1) {
    const row = [i];
    let minimum = i;
    for (let j = 1; j <= right.length; j += 1) {
      row[j] = Math.min(row[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        row[j] = Math.min(row[j]!, beforePrevious[j - 2]! + 1);
      }
      minimum = Math.min(minimum, row[j]!);
    }
    if (minimum > limit) return limit + 1;
    beforePrevious = previous;
    previous = row;
  }
  return previous[right.length]!;
}
