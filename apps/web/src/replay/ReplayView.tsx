import { useMemo } from 'react';
import type { Session } from '@contracts';
import { WorkingIndicator } from '@/app/session/Timeline';
import { TranscriptView } from '@/app/session/TranscriptView';
import { useSessionSync } from '@/app/session/useSessionSync';
import { useSessionTranscript } from '@/app/session/useSessionTranscript';
import type { SyncTransport } from '@/sync/protocol';

const noop = () => {};

/**
 * The session page's transcript, fed by a recording instead of the server: the same sync engine, the
 * same placement rules (`useSessionTranscript`) and the same `TranscriptView`. Only the composer, the
 * header and the side column are left out; nothing here sends anything anywhere.
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
      />
    </div>
  );
}
