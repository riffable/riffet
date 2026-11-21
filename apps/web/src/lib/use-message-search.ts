import { useEffect, useMemo, useState } from 'react';
import { LINK_BUDGET } from '@contracts';
import { apiFor, type MessageSearchHit } from './api';

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
  /** True until every server searched answered the current query and conversation scope once. */
  stale: boolean;
}

/**
 * Conversation search, kept out of the sidebar so the list rendering stays about lists.
 *
 * The server indexes conversations in small background batches, so one answer can be incomplete; a
 * result that still has conversations pending asks again until it does not. That is what makes the
 * first search return immediately without lying about what it has not looked at yet.
 *
 * Without a conversation scope it searches the entry server and each of `linked` (docs/SERVER-LINKS.md §5);
 * each server's answer lands on its own, so a slow or unreachable one holds back no other. A scoped search
 * reaches the conversation's server through its id.
 */
export function useMessageSearch(query: string, sessionId?: string, linked: readonly string[] = []): MessageSearchState {
  const needle = query.trim();
  const targets = sessionId ? '' : linked.join('\n');
  const [state, setState] = useState<{ query: string; sessionId?: string; targets: string; answers: Record<string, { hits: MessageSearchHit[]; pending: number }> }>({ query: '', targets: '', answers: {} });

  useEffect(() => {
    if (!needle) { setState({ query: '', targets: '', answers: {} }); return; }
    let active = true;
    const controller = new AbortController();
    const timers = new Set<number>();
    /** `hits` undefined keeps what `server` already answered (a follow-up ask that failed). */
    const answer = (server: string, hits: MessageSearchHit[] | undefined, pending: number) => setState((current) => {
      const kept = current.query === needle && current.sessionId === sessionId && current.targets === targets ? current.answers : {};
      return { query: needle, ...(sessionId ? { sessionId } : {}), targets, answers: { ...kept, [server]: { hits: hits ?? kept[server]?.hits ?? [], pending } } };
    });
    const ask = (server: string, refills: number) => {
      // A linked server that does not answer in time counts as answered with nothing (multi-server.md §3.4).
      const signal = server ? AbortSignal.any([controller.signal, AbortSignal.timeout(LINK_BUDGET.searchWaitMs)]) : controller.signal;
      void apiFor(server || undefined).searchMessages(needle, signal, sessionId).then((result) => {
        if (!active) return;
        answer(server, result.hits, result.pending);
        if (result.pending > 0 && refills < MAX_REFILLS) {
          const timer = window.setTimeout(() => { timers.delete(timer); ask(server, refills + 1); }, REFILL_MS);
          timers.add(timer);
        }
      }).catch(() => {
        // A failed search empties that server's part rather than leaving another query's hits under it.
        if (active) answer(server, undefined, 0);
      });
    };
    const servers = ['', ...(targets ? targets.split('\n') : [])];
    const start = window.setTimeout(() => { timers.delete(start); for (const server of servers) ask(server, 0); }, DEBOUNCE_MS);
    timers.add(start);
    return () => { active = false; controller.abort(); for (const timer of timers) window.clearTimeout(timer); };
  }, [needle, sessionId, targets]);

  const current = state.query === needle && state.sessionId === sessionId && state.targets === targets;
  const hits = useMemo(() => {
    const answers = current ? Object.values(state.answers) : [];
    return answers.length === 1 ? answers[0]!.hits : answers.flatMap((item) => item.hits).sort((left, right) => right.at.localeCompare(left.at));
  }, [current, state]);
  const answered = current ? Object.keys(state.answers).length : 0;
  return {
    hits,
    pending: current ? Object.values(state.answers).reduce((sum, item) => sum + item.pending, 0) : 0,
    // Searching until every server answered once.
    stale: Boolean(needle) && answered < (targets ? targets.split('\n').length + 1 : 1),
  };
}
