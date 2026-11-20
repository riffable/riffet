import { useEffect, useRef } from 'react';

/**
 * Quotes for a conversation's composer from outside its transcript: a passage selected in a file's
 * rendered preview, in the side panel. The composer takes them as it takes a transcript quote
 * (`quotes.ts`), so the Agent reads the passage itself, not only where it came from.
 */
const listeners = new Map<string, Set<(text: string) => void>>();

/** False when no composer of [sessionId] is on screen to take it. */
export function quoteIntoComposer(sessionId: string, text: string): boolean {
  const current = listeners.get(sessionId);
  if (!current?.size) return false;
  for (const listener of current) listener(text);
  return true;
}

/** Takes the quotes sent to [sessionId] while mounted. */
export function useComposerQuotes(sessionId: string | undefined, onQuote: (text: string) => void): void {
  const latest = useRef(onQuote);
  latest.current = onQuote;
  useEffect(() => {
    if (!sessionId) return;
    const listener = (text: string) => latest.current(text);
    let set = listeners.get(sessionId);
    if (!set) { set = new Set(); listeners.set(sessionId, set); }
    set.add(listener);
    return () => { set.delete(listener); if (!set.size) listeners.delete(sessionId); };
  }, [sessionId]);
}
