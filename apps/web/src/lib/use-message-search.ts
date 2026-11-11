import { useEffect, useState } from 'react';
import { api, type MessageSearchHit } from './api';

const DEBOUNCE_MS = 200;
/** While conversations are still unindexed, ask again this often; each answer indexes a few more. */
const REFILL_MS = 600;
/**
 * A ceiling on those follow-up asks. The server records a conversation it has read and found empty,
 * so the count should reach zero; this only stops a persistent condition from turning the search box
 * into a polling loop.
 */
const MAX_REFILLS = 20;

export interface MessageSearchState {
  /** Hits for the current query; empty until the first answer for it arrives. */
  hits: MessageSearchHit[];
  /** Conversations the server has not indexed yet. Above zero, more results may still arrive. */
  pending: number;
  /** True until the current query and conversation scope receive their first answer. */
  stale: boolean;
}

/**
 * Conversation search, kept out of the sidebar so the list rendering stays about lists.
 *
 * The server indexes conversations in small background batches, so one answer can be incomplete; a
 * result that still has conversations pending asks again until it does not. That is what makes the
 * first search return immediately without lying about what it has not looked at yet.
 */
export function useMessageSearch(query: string, sessionId?: string): MessageSearchState {
  const needle = query.trim();
  const [state, setState] = useState<{ query: string; sessionId?: string; hits: MessageSearchHit[]; pending: number }>({ query: '', hits: [], pending: 0 });

  useEffect(() => {
    if (!needle) { setState({ query: '', hits: [], pending: 0 }); return; }
    let active = true;
    const controller = new AbortController();
    let timer: number | undefined;
    let refills = 0;
    const ask = () => {
      void api.searchMessages(needle, controller.signal, sessionId).then((result) => {
        if (!active) return;
        setState({ query: needle, sessionId, hits: result.hits, pending: result.pending });
        if (result.pending > 0 && refills < MAX_REFILLS) { refills += 1; timer = window.setTimeout(ask, REFILL_MS); }
      }).catch(() => {
        // A failed search empties the section rather than leaving another query's hits under it.
        if (active) setState({ query: needle, sessionId, hits: [], pending: 0 });
      });
    };
    timer = window.setTimeout(ask, DEBOUNCE_MS);
    return () => { active = false; controller.abort(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [needle, sessionId]);

  const current = state.query === needle && state.sessionId === sessionId;
  return {
    hits: current ? state.hits : [],
    pending: current ? state.pending : 0,
    stale: Boolean(needle) && !current,
  };
}
