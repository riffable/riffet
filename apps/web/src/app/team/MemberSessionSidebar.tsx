import { useMemo } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconBot, IconPanelLeft, IconSquarePen } from '@/components/icons';
import type { AgentMember, Session } from '@contracts';
import { AgentLogo } from '@/components/AgentLogo';
import { OwnerAvatar } from '@/components/OwnerAvatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tip } from '@/components/ui/tooltip';
import { sessionBackend } from '@/lib/backends';
import { sortSessionsByActivity } from '@/lib/session-order';
import { cn, relativeTime } from '@/lib/utils';
import { SessionIndicator } from '../Sidebar';
import { MemberAvatar } from './MemberAvatar';

interface MemberSessionSidebarProps {
  member: AgentMember;
  sessions: readonly Session[];
  allSessions: readonly Session[];
  teamMembers: readonly AgentMember[];
  owner: { name?: string; avatar?: { url: string } } | undefined;
  activeSessionId: string;
  onSelectSession: (session: Session) => void;
  onNewSession: () => void;
  onCollapse?: () => void;
  mobile?: boolean;
}

function SessionListBody({
  member,
  sessions,
  allSessions,
  teamMembers,
  owner,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onCollapse,
  mobile = false,
}: MemberSessionSidebarProps) {
  const { t } = useLingui();
  const sessionById = useMemo(() => new Map(allSessions.map((item) => [item.id, item])), [allSessions]);
  const memberById = useMemo(() => new Map(teamMembers.map((item) => [item.id, item])), [teamMembers]);

  const { mainSession, otherSessions } = useMemo(() => {
    const ordered = sortSessionsByActivity(sessions);
    if (member.sessionMode !== 'continuous') {
      return { mainSession: undefined, otherSessions: ordered };
    }
    const main = (member.mainSessionId ? ordered.find((item) => item.id === member.mainSessionId) : undefined)
      ?? ordered.find((item) => item.origin?.kind !== 'call');
    const rest = main ? ordered.filter((item) => item.id !== main.id) : ordered;
    return { mainSession: main, otherSessions: rest };
  }, [member.sessionMode, member.mainSessionId, sessions]);

  const renderRow = (item: Session, options?: { main?: boolean }) => {
    const selected = item.id === activeSessionId;
    const isCall = item.origin?.kind === 'call';
    const callerSession = isCall && item.origin?.kind === 'call' && item.origin.sessionId ? sessionById.get(item.origin.sessionId) : undefined;
    const callerMember = callerSession
      ? (callerSession.agentMemberId
        ? memberById.get(callerSession.agentMemberId)
        : teamMembers.find((entry) => entry.scope.kind !== 'project' && entry.projectId === callerSession.projectId))
      : undefined;
    const callerName = callerMember
      ? callerMember.name
      : callerSession
        ? (callerSession.displayTitle ?? callerSession.title)
        : t`外部调用`;
    const title = options?.main ? t`主对话` : (item.displayTitle ?? item.title) || t`未命名会话`;
    const time = relativeTime(item.lastActivityAt ?? item.updatedAt);
    const subtitle = isCall ? `${callerName} · ${time}` : time;

    const avatar = isCall
      ? callerMember
        ? <MemberAvatar member={callerMember} size={16} className="shrink-0" />
        : (
          <span className="grid size-4 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
            {callerSession ? <AgentLogo backend={sessionBackend(callerSession)} size={11} /> : <IconBot className="size-2.5" />}
          </span>
        )
      : <OwnerAvatar owner={owner} size={16} className="shrink-0" />;

    return (
      <button
        key={item.id}
        type="button"
        aria-current={selected ? 'page' : undefined}
        onClick={() => onSelectSession(item)}
        className={cn(
          'flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus',
          selected ? 'bg-active text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg',
        )}
      >
        <span className="mt-0.5 shrink-0">{avatar}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className={cn('min-w-0 flex-1 truncate text-sm leading-5', selected && 'font-medium')}>{title}</span>
            <span className="inline-flex shrink-0"><SessionIndicator session={item} mobile={mobile} selected={selected} /></span>
          </span>
          <span className="block truncate text-2xs leading-4 text-fg-3">{subtitle}</span>
        </span>
      </button>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!mobile && (
        <div className="flex h-[52px] shrink-0 items-center gap-1 px-3">
          <span className="min-w-0 flex-1 truncate px-1 text-xs font-medium text-fg-3"><Trans>对话</Trans></span>
          {member.sessionMode === 'fresh' && (
            <Tip label={t`新对话`}>
              <Button size="icon-sm" variant="quiet" aria-label={t`新对话`} className="size-7" onClick={onNewSession}>
                <IconSquarePen />
              </Button>
            </Tip>
          )}
          {onCollapse && (
            <Tip label={t`收起会话列表`}>
              <Button size="icon-sm" variant="quiet" aria-label={t`收起会话列表`} className="size-7" onClick={onCollapse}>
                <IconPanelLeft />
              </Button>
            </Tip>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {member.sessionMode === 'fresh' && (
          <button
            type="button"
            aria-current={!activeSessionId ? 'page' : undefined}
            onClick={onNewSession}
            className={cn(
              'mb-1.5 flex w-full items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus',
              mobile ? 'h-11' : 'h-9',
              !activeSessionId ? 'bg-active font-medium text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg',
            )}
          >
            <IconSquarePen className="size-4 shrink-0 text-fg-3" />
            <span className="min-w-0 flex-1 truncate"><Trans>新对话</Trans></span>
          </button>
        )}

        {mainSession && (
          <div className="flex flex-col gap-0.5">
            {renderRow(mainSession, { main: true })}
          </div>
        )}

        {otherSessions.length > 0 && (
          <div className={cn('flex flex-col gap-0.5', mainSession && 'mt-3')}>
            {mainSession && (
              <div className="px-2 pb-1 text-2xs font-medium text-fg-4">
                <Trans>来信与调用</Trans>
              </div>
            )}
            {otherSessions.map((item) => renderRow(item))}
          </div>
        )}

        {!mainSession && !otherSessions.length && (
          <div className="px-2 py-4 text-xs text-fg-4">
            <Trans>暂无历史对话</Trans>
          </div>
        )}
      </div>
    </div>
  );
}

/** In-page conversation list for a team member: matches content surface (`patterns.md` §1.4) with a quiet hairline divider. */
export function MemberSessionSidebar(props: MemberSessionSidebarProps) {
  return (
    <aside aria-label={props.member.name} className="flex h-full w-56 shrink-0 flex-col edge-r">
      <SessionListBody {...props} />
    </aside>
  );
}

/** Mobile sheet version of the member conversation list. */
export function MemberSessionSheet({
  open,
  onOpenChange,
  ...rest
}: MemberSessionSidebarProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent mobileSheet className="p-0">
        <DialogHeader className="flex-row items-center gap-2 edge-b px-4 py-3">
          <MemberAvatar member={rest.member} size={22} className="shrink-0" />
          <DialogTitle className="min-w-0 flex-1 truncate text-base">{rest.member.name}</DialogTitle>
        </DialogHeader>
        <div className="flex max-h-[65dvh] min-h-48 flex-col overflow-hidden">
          <SessionListBody
            {...rest}
            mobile
            onSelectSession={(session) => { rest.onSelectSession(session); onOpenChange(false); }}
            onNewSession={() => { rest.onNewSession(); onOpenChange(false); }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
