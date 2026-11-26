import { useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { RiffetNotice } from '@contracts';
import { Button } from '@/components/ui/button';
import { EmptyState, Segmented, Spinner, StatusDot } from '@/components/ui/controls';
import { SearchField } from '@/components/ui/search-field';
import { Tip } from '@/components/ui/tooltip';
import { IconCheck, IconInbox, IconMessageSquareText, IconShieldCheck, IconTrash2 } from '@/components/icons';
import { relativeTime } from '@/lib/i18n/format';
import { cn } from '@/lib/utils';
import { PageScaffold } from '../PageScaffold';
import { Markdown } from '../session/Markdown';
import { useApprovals, useStores } from '../state/stores';
import { SectionHeading } from './parts';
import { ApprovalRow } from './ApprovalRow';

type FilterMode = 'unread' | 'all';

interface InboxPageProps {
  sidebarCollapsed: boolean;
  onClose: () => void;
  onOpenSidebar: () => void;
  onExpandSidebar: () => void;
  onOpenSession: (sessionId: string) => void;
}

/**
 * Riffet Inbox (`/inbox`): a dedicated high-signal message & approval hub for items explicitly
 * directed to the owner — actionable plugin approvals (`host.approvals`) and explicit
 * messages sent by team members / agents (`notify_user`) or wake-ups.
 *
 * Work-item board transitions stay on `/tasks` under 待处理 and never flood the Inbox.
 */
export function InboxPage({
  sidebarCollapsed, onClose, onOpenSidebar, onExpandSidebar, onOpenSession,
}: InboxPageProps) {
  const { t } = useLingui();
  const { approvals: inboxStore } = useStores();
  const allApprovals = useApprovals((state) => state.approvals);
  const allNotices = useApprovals((state) => state.notices);
  const loaded = useApprovals((state) => state.loaded);
  const [filter, setFilter] = useState<FilterMode>('unread');
  const [query, setQuery] = useState('');

  useEffect(() => {
    void inboxStore.reload();
  }, [inboxStore]);

  const needle = query.trim().toLowerCase();
  const unreadNoticeCount = useMemo(() => allNotices.filter((item) => !item.readAt).length, [allNotices]);
  const unreadTotal = allApprovals.length + unreadNoticeCount;

  const approvals = useMemo(
    () => allApprovals.filter((approval) => !needle || `${approval.title}\n${approval.body}\n${approval.pluginName}`.toLowerCase().includes(needle)),
    [allApprovals, needle],
  );
  const notices = useMemo(
    () => allNotices.filter((notice) => {
      if (filter === 'unread' && notice.readAt) return false;
      if (!needle) return true;
      return `${notice.title ?? ''}\n${notice.body}\n${notice.senderName ?? ''}`.toLowerCase().includes(needle);
    }),
    [allNotices, filter, needle],
  );

  const shownCount = approvals.length + notices.length;
  const hasAny = allApprovals.length > 0 || allNotices.length > 0;

  return (
    <PageScaffold
      title={t`收件箱`}
      meta={unreadTotal > 0 ? <span className="text-xs tabular-nums text-fg-4">{unreadTotal}</span> : undefined}
      column="document"
      sidebarCollapsed={sidebarCollapsed}
      onClose={onClose}
      onOpenSidebar={onOpenSidebar}
      onExpandSidebar={onExpandSidebar}
      actions={unreadNoticeCount > 0 ? (
        <Button size="sm" variant="quiet" onClick={() => void inboxStore.markAllNoticesRead()}>
          <IconCheck />
          <Trans>全部标为已读</Trans>
        </Button>
      ) : undefined}
    >
      <div className="flex flex-col gap-5 pb-12">
        {(hasAny || query) && (
          <div className="flex flex-wrap items-center gap-2">
            <SearchField value={query} onChange={setQuery} aria-label={t`筛选收件箱`} placeholder={t`筛选收件箱`} className="w-full sm:w-64" />
            <Segmented
              className="sm:ml-auto"
              ariaLabel={t`筛选`}
              value={filter}
              onChange={(next) => setFilter(next as FilterMode)}
              options={[
                { value: 'unread', label: unreadTotal > 0 ? t`未处理 (${unreadTotal})` : t`未处理` },
                { value: 'all', label: t`全部` },
              ]}
            />
          </div>
        )}

        {!loaded && (
          <div className="flex justify-center py-12"><Spinner /></div>
        )}

        {loaded && shownCount === 0 && (
          <EmptyState
            icon={<IconInbox />}
            title={needle ? t`没有匹配的条目` : filter === 'unread' && hasAny ? t`没有未处理的条目` : t`收件箱为空`}
            description={needle ? undefined : filter === 'unread' && hasAny ? t`切换到「全部」可查看历史消息` : t`插件待确认操作，以及团队成员主动发给你的重要消息会出现在这里`}
          />
        )}

        {approvals.length > 0 && (
          <section className="flex flex-col gap-2">
            <SectionHeading icon={<IconShieldCheck />} count={approvals.length}><Trans>待你确认</Trans></SectionHeading>
            <div className="flex flex-col divide-y divide-line rounded-xl p-1 shadow-[inset_0_0_0_1px_var(--line)]">
              {approvals.map((approval) => (
                <ApprovalRow key={`${approval.pluginId}/${approval.id}`} approval={approval} onOpenSession={onOpenSession} />
              ))}
            </div>
          </section>
        )}

        {notices.length > 0 && (
          <section className="flex flex-col gap-2">
            <SectionHeading icon={<IconInbox />} count={notices.length}><Trans>重要消息</Trans></SectionHeading>
            <div className="flex flex-col divide-y divide-line rounded-xl p-1 shadow-[inset_0_0_0_1px_var(--line)]">
              {notices.map((notice) => (
                <NoticeRow
                  key={notice.id}
                  notice={notice}
                  onOpenSession={onOpenSession}
                  onMarkRead={() => void inboxStore.markNoticeRead(notice.id)}
                  onDelete={() => void inboxStore.deleteNotice(notice.id)}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </PageScaffold>
  );
}

function NoticeRow({
  notice, onOpenSession, onMarkRead, onDelete,
}: {
  notice: RiffetNotice;
  onOpenSession: (sessionId: string) => void;
  onMarkRead: () => void;
  onDelete: () => void;
}) {
  const { t } = useLingui();
  const unread = !notice.readAt;
  const sender = notice.senderName || (notice.source === 'wakeup' ? t`定时提醒` : t`成员消息`);
  const title = notice.title?.trim();

  const openSource = () => {
    if (unread) onMarkRead();
    if (notice.sessionId) onOpenSession(notice.sessionId);
  };

  return (
    <div className={cn('flex flex-col gap-1.5 rounded-lg px-2.5 py-2.5 text-sm text-fg', !unread && 'opacity-75')}>
      <div className="flex min-h-5 min-w-0 items-center gap-2">
        <span className="grid size-4 shrink-0 place-items-center">
          {unread ? <StatusDot tone="accent" label={t`未读`} /> : <IconMessageSquareText className="size-3.5 text-fg-4" />}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{title || sender}</span>
        {title && <span className="hidden max-w-40 shrink-0 truncate text-xs text-fg-4 sm:inline">{sender}</span>}
        <span className="shrink-0 whitespace-nowrap text-2xs tabular-nums text-fg-4">{relativeTime(notice.createdAt)}</span>
      </div>
      <div className="flex min-w-0 flex-col gap-2 pl-6">
        <Markdown className="text-sm text-fg-2 select-text" text={notice.body} />
        <div className="flex flex-wrap items-center gap-1.5">
          {notice.sessionId && (
            <Button size="xs" variant="secondary" onClick={openSource}>
              <IconMessageSquareText />
              <Trans>打开会话</Trans>
            </Button>
          )}
          {unread && (
            <Button size="xs" variant="quiet" onClick={onMarkRead}>
              <IconCheck />
              <Trans>标为已读</Trans>
            </Button>
          )}
          <Tip label={t`删除`}>
            <Button size="icon-xs" variant="quiet" aria-label={t`删除`} onClick={onDelete}>
              <IconTrash2 />
            </Button>
          </Tip>
        </div>
      </div>
    </div>
  );
}
