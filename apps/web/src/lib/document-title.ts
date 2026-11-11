import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { Session, SessionState } from '@contracts';

export const APP_TITLE = 'Riffet';

const workingStates = new Set<SessionState>(['starting', 'running', 'cancelling']);
const settledStates = new Set<SessionState>(['idle', 'failed', 'interrupted']);

/**
 * Whether a conversation wants the reader back: it is waiting for a confirmation, or it stopped
 * working (finished or failed) since `before` was taken — the moment the tab was hidden.
 */
export function needsAttention(session: Session, before: SessionState | undefined): boolean {
  if (session.archivedAt) return false;
  if (session.state === 'waiting') return true;
  return before !== undefined && workingStates.has(before) && settledStates.has(session.state);
}

export function documentTitle({ title, state, attention = 0 }: { title?: string; state?: SessionState; attention?: number }): string {
  const name = title?.trim();
  let text = APP_TITLE;
  if (name && state === 'waiting') text = i18n._(msg`⏸ 待确认 · ${name} — ${APP_TITLE}`);
  else if (name && state && workingStates.has(state)) text = `● ${name} — ${APP_TITLE}`;
  else if (name) text = `${name} — ${APP_TITLE}`;
  return attention > 0 ? `(${attention}) ${text}` : text;
}

function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
}
const documentHidden = () => document.visibilityState === 'hidden';

/**
 * Mirrors the open conversation into the tab title, and while the tab is hidden prefixes how many
 * conversations need the reader, so a glance at the tab strip says whether to come back.
 */
export function useDocumentTitle(session: Session | undefined, sessions: readonly Session[], fallback?: string): void {
  const hidden = useSyncExternalStore(subscribeVisibility, documentHidden, () => false);
  const [hiddenBaseline, setHiddenBaseline] = useState<Map<string, SessionState>>();
  useEffect(() => {
    // Only the transition matters: later list updates while hidden must not move the baseline.
    setHiddenBaseline(hidden ? new Map(sessions.map((item) => [item.id, item.state])) : undefined);
  }, [hidden]);
  const attention = useMemo(
    () => (hiddenBaseline ? sessions.filter((item) => needsAttention(item, hiddenBaseline.get(item.id))).length : 0),
    [sessions, hiddenBaseline],
  );
  const title = documentTitle({ title: session?.title ?? fallback, state: session?.state, attention });
  useEffect(() => { document.title = title; }, [title]);
  useEffect(() => () => { document.title = APP_TITLE; }, []);
}
