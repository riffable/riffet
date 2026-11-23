import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { isDoneUnseen, isRunningSession, needsYou, type Session, type SessionState } from '@contracts';

export const APP_TITLE = 'Riffet';

/** Count from the current list so a missed turn or a read on another device is reflected on sync. */
export function countAttention(sessions: readonly Session[]): number {
  let count = 0;
  for (const session of sessions) {
    const origin = session.origin?.kind;
    if (session.archivedAt || origin === 'assistant' || origin === 'council' || origin === 'discussion') continue;
    if (needsYou(session) || isDoneUnseen(session)) count++;
  }
  return count;
}

export function documentTitle({ title, state, attention = 0 }: { title?: string; state?: SessionState; attention?: number }): string {
  const name = title?.trim();
  let text = APP_TITLE;
  if (name && state === 'waiting') text = i18n._(msg`⏸ 待确认 · ${name} — ${APP_TITLE}`);
  else if (name && state && isRunningSession({ state })) text = `● ${name} — ${APP_TITLE}`;
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
  const attention = useMemo(() => hidden ? countAttention(sessions) : 0, [hidden, sessions]);
  const title = documentTitle({ title: session?.title ?? fallback, state: session?.state, attention });
  useEffect(() => { document.title = title; }, [title]);
  useEffect(() => () => { document.title = APP_TITLE; }, []);
}
