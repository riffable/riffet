import type { Session } from '@contracts';

/**
 * A 会话标题规则 (docs/SESSION-TITLES.md) changes how a conversation is shown, not its title: the server
 * sends what the rule makes of it as `displayTitle`. The lists store puts that in `title`, so every
 * view shows it without knowing about rules, and keeps the title it was given as `baseTitle`, which
 * is what a rename starts from and writes.
 */
type ShownSession = Session & { baseTitle?: string };

export function withShownTitle<T extends Session>(session: T): T {
  if (!session.displayTitle) return session;
  const { displayTitle, ...rest } = session;
  return { ...rest, title: displayTitle, baseTitle: session.title } as unknown as T;
}

/** The title a rename starts from. */
export function baseTitle(session: Session): string {
  return (session as ShownSession).baseTitle ?? session.title;
}

/** Whether a rule decides what [session] is shown as. */
export function titleShownByRule(session: Session): boolean {
  return (session as ShownSession).baseTitle !== undefined;
}
