import { useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { Session } from '@contracts';
import { IconEye } from '@/components/icons';
import { Tip } from '@/components/ui/tooltip';
import { api, type ProjectRecord } from '@/lib/api';
import { sessionActivityAt, sortSessionsByActivity } from '@/lib/session-order';
import { useLocale } from '@/lib/i18n';
import { MOBILE_LAYOUT_QUERY, useMediaQuery } from '@/lib/use-media-query';
import { cn, relativeTime } from '@/lib/utils';
import { SessionRow, timeBucket, type SessionAction } from './Sidebar';
import { useMarks } from './state/stores';

export function QuickChatHistory({ project, sessions, onSelectSession, onSessionAction }: {
  project: ProjectRecord;
  sessions: Session[];
  onSelectSession: (session: Session) => void;
  onSessionAction: (session: Session, action: SessionAction) => void;
}) {
  const { t } = useLingui();
  const mobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  // `timeBucket` reads the active catalog directly, so the groups must rebuild on a switch.
  const locale = useLocale();
  const [showArchived, setShowArchived] = useState(false);
  const marksRevision = useMarks((state) => state.revision);
  const [markedSessionIds, setMarkedSessionIds] = useState<ReadonlySet<string>>(() => new Set());
  // A quick chat that has a saved reply keeps a bookmark beside its title in the recent list.
  useEffect(() => {
    const controller = new AbortController();
    void api.marks({ projectId: project.id, limit: 200 }, undefined, controller.signal).then((result) => {
      if (result.unchanged) return;
      setMarkedSessionIds(new Set(result.data.marks.map((mark) => mark.sessionId)));
    }).catch(() => undefined);
    return () => controller.abort();
  }, [project.id, marksRevision]);
  const hasChats = useMemo(() => sessions.some((session) => session.projectId === project.id && session.origin?.kind !== 'discussion'), [sessions, project.id]);
  const chats = useMemo(() => sessions.filter((session) => session.projectId === project.id && session.origin?.kind !== 'discussion' && (showArchived || !session.archivedAt)), [sessions, project.id, showArchived]);
  const recent = useMemo(() => {
    const now = new Date();
    const buckets: { label: string; items: Session[] }[] = [];
    for (const session of sortSessionsByActivity(chats)) {
      const label = timeBucket(session, now);
      const bucket = buckets.at(-1);
      if (bucket?.label === label) bucket.items.push(session); else buckets.push({ label, items: [session] });
    }
    return buckets;
  }, [chats, locale]);

  return hasChats ? (
    <section className="mt-8 md:mt-10">
      <div className="group/section flex h-7 items-center px-2">
        <h2 className="text-xs font-medium text-fg-3"><Trans>最近会话</Trans></h2>
        <Tip label={t`显示已归档`}>
          <button
            type="button"
            aria-label={t`显示已归档`}
            aria-pressed={showArchived}
            onClick={() => setShowArchived((value) => !value)}
            className={cn('ml-auto grid size-6 place-items-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg', showArchived && 'bg-active text-fg')}
          >
            <IconEye className="size-3.5" />
          </button>
        </Tip>
      </div>
      {recent.map((bucket) => (
        <div key={bucket.label} className="flex flex-col gap-px">
          <div className="flex h-7 items-end px-2 pb-1 text-2xs font-medium text-fg-3">{bucket.label}</div>
          {bucket.items.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              selected={false}
              mobile={mobile}
              projectName={undefined}
              time={relativeTime(sessionActivityAt(session))}
              marked={markedSessionIds.has(session.id)}
              hideTags
              onSelect={onSelectSession}
              onAction={onSessionAction}
            />
          ))}
        </div>
      ))}
    </section>
  ) : null;
}
