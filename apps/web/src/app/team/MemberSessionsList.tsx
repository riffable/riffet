import { useMemo } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { DEFAULT_AGENT_MEMBER_ID, type AgentMember, type Session } from '@contracts';
import { IconChevronRight, IconSquareTerminal } from '@/components/icons';
import { StatusDot } from '@/components/ui/controls';
import { sessionBackend, useBackendLabel } from '@/lib/backends';
import { sessionActivityAt, sortSessionsByActivity } from '@/lib/session-order';
import { relativeTime } from '@/lib/utils';

interface Props {
  member: AgentMember;
  sessions: readonly Session[];
  onSelectSession: (session: Session) => void;
}

/**
 * Past conversations executed by this team member, shown below the member's home composer
 * (especially useful for `fresh` mode roles like QA or packaging that start a new session per run).
 */
export function MemberSessionsList({ member, sessions, onSelectSession }: Props) {
  const label = useBackendLabel();
  const { t } = useLingui();
  const rows = useMemo(() => {
    const owned = sessions.filter((session) => !session.archivedAt && (
      session.agentMemberId === member.id
      || (member.id === DEFAULT_AGENT_MEMBER_ID && session.projectId === member.projectId && !session.agentMemberId)
    ));
    return sortSessionsByActivity(owned).slice(0, 12);
  }, [member.id, member.projectId, sessions]);

  if (!rows.length) return null;
  return (
    <section className="mt-6 md:mt-8">
      <h2 className="mb-1 px-2 text-xs font-medium text-fg-3">
        {member.sessionMode === 'fresh' ? <Trans>历史执行记录</Trans> : <Trans>最近对话</Trans>}
      </h2>
      <div className="flex flex-col">
        {rows.map((session) => (
          <button
            key={session.id}
            type="button"
            onClick={() => onSelectSession(session)}
            className="group/recent flex h-10 items-center gap-3 rounded-lg px-2 text-left text-sm hover:bg-hover"
          >
            {session.kind === 'native'
              ? <IconSquareTerminal className="size-4 shrink-0 text-fg-4" />
              : <StatusDot className="mx-[5px]" tone={session.state === 'running' ? 'accent' : session.state === 'waiting' ? 'warning' : 'idle'} />}
            <span className="min-w-0 flex-1 truncate text-fg">{session.title || t`未命名对话`}</span>
            <span className="shrink-0 text-xs text-fg-3">{label(sessionBackend(session))}</span>
            <span className="shrink-0 text-xs text-fg-3">{relativeTime(sessionActivityAt(session))}</span>
            <IconChevronRight className="size-4 shrink-0 text-fg-4 opacity-0 transition-opacity group-hover/recent:opacity-100" />
          </button>
        ))}
      </div>
    </section>
  );
}
