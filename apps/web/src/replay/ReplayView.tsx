import { useMemo } from 'react';
import type { Session } from '@contracts';
import { WorkingIndicator } from '@/app/session/Timeline';
import { TranscriptView } from '@/app/session/TranscriptView';
import { useSessionSync } from '@/app/session/useSessionSync';
import { useSessionTranscript } from '@/app/session/useSessionTranscript';
import { FeedbackNotice } from '@/components/ui/feedback-notice';
import type { SyncTransport } from '@/sync/protocol';

const noop = () => {};

/**
 * The session page's transcript, fed by a recording instead of the server: the same sync engine, the
 * same placement rules (`useSessionTranscript`), the same `TranscriptView`, a header-height top bar
 * (so `scroller.getBoundingClientRect().top > 0` matches the real Workbench), and the same trailing
 * empty `FeedbackNotice` child `NativeSession` mounts. Nothing here sends anything anywhere.
 */
export function ReplayView({ session, transport }: { session: Session; transport: SyncTransport }) {
  const source = useMemo(() => ({ transport }), [transport]);
  const native = useSessionSync(session, { onSessionChanged: noop, onError: noop, notificationsEnabled: false, source });
  const phase = native.status.phase;
  const busy = phase === 'busy';
  const working = busy || phase === 'attention';
  const compacting = Boolean(native.status.activity?.compacting);
  const view = useSessionTranscript(native, { working, busy, compacting, activeSince: session.activeSince });
  return (
    <div className="flex h-dvh min-h-0 flex-col bg-bg">
      {/* Mirrors the real Workbench header height so scroller bounds.top > 0 during replay checks. */}
      <div aria-hidden className="h-12 shrink-0 border-b border-line" />
      <TranscriptView
        sessionId={session.id}
        timeline={view.visibleTimeline}
        timelineVersion={native.timelineVersion}
        pendingConfirmationCount={native.status.interaction ? 1 : 0}
        metricsByRun={native.metricsByRun}
        resetVersion={native.resetVersion}
        turns={view.visibleTurns}
        turnsVersion={native.turnsVersion}
        loaded={native.loaded}
        historyLoad={native.historyLoad}
        running={working}
        activeTurnId={native.status.activeTurnId}
        turnStatusByTurn={native.turnStatusByTurn}
        onOpenPath={noop}
        hasMoreHistory={Boolean(native.history?.hasMore)}
        historyContextIncomplete={native.history?.contextIncomplete}
        historyStale={native.historyStale}
        loadingEarlier={native.loadingHistory}
        onLoadEarlier={native.loadOlder}
        hasMoreLater={native.hasMoreLater}
        loadingLater={native.loadingLater}
        onLoadLater={native.loadLater}
        onReaderEnd={native.readerAtEnd}
        onJumpToLatest={native.jumpToLatest}
        onLoadTurn={native.loadTurn}
        onExpandRow={native.expandRow}
        progress={view.showWorking ? <WorkingIndicator startedAt={view.workingSince} outputRate={view.workingInTimeline ? native.status.outputRate : undefined} connected={native.connected} /> : undefined}
      >
        {/* Mirrors NativeSession's trailing empty:hidden FeedbackNotice child. */}
        <FeedbackNotice scope={session.id} tone="warning" className="mt-5" message={false} />
      </TranscriptView>
    </div>
  );
}
