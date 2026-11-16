/**
 * One list out of the stored runs' questions and the indexed messages: a question is both a run and,
 * once its transcript passed through, an indexed message. Keyed by conversation and text so the
 * reader sees one row, and the first source's copy wins (the run's, which holds the whole prompt
 * rather than one window of it). Newest first.
 */
export function mergeMessageHits<T extends { sessionId: string; text: string; at: string }>(sources: readonly (readonly T[])[], limit: number): T[] {
  const seen = new Set<string>();
  return sources.flat()
    .filter(hit => { const key = `${hit.sessionId}\u0000${hit.text}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .sort((left, right) => right.at.localeCompare(left.at))
    .slice(0, limit);
}
