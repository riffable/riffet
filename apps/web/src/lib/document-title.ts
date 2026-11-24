import { useEffect, useSyncExternalStore } from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { isRunningSession, type Session, type SessionState } from '@contracts';

export const APP_TITLE = 'Riffet';

export function documentTitle({ title, state, unread = 0 }: { title?: string; state?: SessionState; unread?: number }): string {
  const name = title?.trim();
  let text = APP_TITLE;
  if (name && state === 'waiting') text = i18n._(msg`⏸ 待确认 · ${name} — ${APP_TITLE}`);
  else if (name && state && isRunningSession({ state })) text = `● ${name} — ${APP_TITLE}`;
  else if (name) text = `${name} — ${APP_TITLE}`;
  return unread > 0 ? `(${unread}) ${text}` : text;
}

function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
}
const documentHidden = () => document.visibilityState === 'hidden';

/** Show the sidebar's unread count while the browser tab is in the background. */
export function useDocumentTitle(session: Session | undefined, unread: number, fallback?: string): void {
  const hidden = useSyncExternalStore(subscribeVisibility, documentHidden, () => false);
  const title = documentTitle({ title: session?.title ?? fallback, state: session?.state, unread: hidden ? unread : 0 });
  useEffect(() => { document.title = title; }, [title]);
  useEffect(() => () => { document.title = APP_TITLE; }, []);
}
