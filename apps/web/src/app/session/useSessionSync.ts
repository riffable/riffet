import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { t } from '@lingui/core/macro';
import type { NativeActivity, NativeInteraction, NativeInteractionResponse, NativeInteractionResult, NativeStatus, LaneFind, Run, Session, SyncLane, TimelineRow, TurnOutlineV3 } from '@contracts';
import { api, listNativeSendRequests, removeNativeSendRequest } from '@/lib/api';
import { createStore, useStore } from '@/lib/store';
import { confirmSessionGone } from '@/lib/session-deletion';
import { browserCache, browserTransport, documentVisibility } from '@/sync/browser';
import type { SyncCache } from '@/sync/cache';
import type { ControlFrame, LaneOutline, LaneSync } from '@/sync/lane';
import type { SyncTransport } from '@/sync/protocol';
import { timelineItems, withLocalOutbox } from '@/sync/rows';
import { SessionSync, type SessionSyncState } from '@/sync/session';
import type { TimelineItem } from './model';
import type { Turn } from './TurnRail';
import { awaitsServerRow, isLocalCopy, keepsInlineReceipt, mergeRun, settleLocalCopies, snapshotWithLocalOutbox } from './nativeOutbox';
import { useNativeRunCommands } from './nativeRunCommands';
import { absorbRunMetrics, blankNativeSession, createNativeSessionStore, recordRunMetrics, updateRuns, type NativeSessionLatest, type NativeSessionTracking } from './nativeSessionStore';
import { NativeJobStore, SubagentStore } from './subagents';
import { timelineTurnKeys } from './timelineTurns';
import { TurnCompletionNotifications } from './turnCompletionNotifications';
import type { EarlierLoad } from './useEarlierHistory';

interface Options {
  onSessionChanged: (session: Session) => void;
  onError: (message: string) => void;
  notificationsEnabled: boolean;
  initialRun?: Run;
  /** Where the frames come from and where the window is kept; the transcript replay passes its own, the page the browser's. */
  source?: { transport: SyncTransport; cache?: SyncCache };
}

/** Paging, jumping and the server's own row texts: what a conversation view reads of the sync engine beyond its rows and runs. */
export interface SyncExtras {
  /** The rows were moved away from the conversation's end (paged up past the window, or jumped); more load on the way down. */
  hasMoreLater: boolean;
  loadingLater: boolean;
  loadLater: () => Promise<EarlierLoad>;
  /** Which end of the rows the reader is nearer to: the end a full window keeps. */
  readerAtEnd: (atEnd: boolean) => void;
  /** Back to the newest rows. */
  jumpToLatest: (signal?: AbortSignal) => Promise<boolean>;
  /** Replaces the rows around an outline turn, returning its loaded prompt row key. */
  loadTurn: (key: string, signal?: AbortSignal) => Promise<string | false>;
  /** Fetches the whole of a row the server sent cut to a preview. */
  expandRow: (key: string) => Promise<boolean>;
  /** 会话内查找 over the whole main lane; undefined when only the held rows can be counted. */
  findInLane: (query: string, signal?: AbortSignal) => Promise<LaneFind | undefined>;
  /** Replaces the rows with those around [pos], for a find hit the rows do not hold. */
  loadPlace: (pos: number, signal?: AbortSignal) => Promise<boolean>;
  /** Background tasks still running, as the server's control frames report them. */
  activities: NativeActivity[];
}

/** What the transcript reads of the engine, published at most once per frame. */
interface SyncView { rows: readonly TimelineRow[]; resetVersion: number; hasAfter: boolean; loadingAfter: boolean; activities: NativeActivity[]; outline: LaneOutline; generation?: string }
const blankView = (): SyncView => ({ rows: [], resetVersion: 0, hasAfter: false, loadingAfter: false, activities: [], outline: { turnCount: 0, turns: [] } });

/** Where an outline turn the rows do not hold stands in the turn list, until its rows are loaded. */
const OUTLINE_TURN = 'outline-turn:';

/**
 * The conversation's user prompts for the rail and outline, in order, under
 * its prompt row's key once that row is loaded, and the loaded turns the outline has not caught up with
 * (a send the server has not echoed yet) after them.
 */
function turnList(outline: readonly TurnOutlineV3[], rows: readonly TimelineRow[], loaded: Turn[]): Turn[] {
  if (!outline.length) return loaded;
  const promptOf = new Map<string, string>();
  for (const row of rows) if (row.kind === 'user' && !promptOf.has(row.turn)) promptOf.set(row.turn, row.key);
  const byKey = new Map(loaded.map((turn) => [turn.key, turn]));
  // Older servers have no explicit user marker; a loaded prompt or a nonempty preview still
  // identifies a user turn. Output-only / task-resume turns do not belong in prompt navigation.
  const listed = outline.filter((turn) => turn.hasUserMessage ?? (promptOf.has(turn.turn) || Boolean(turn.preview?.trim()) || turn.hasAttachments === true)).map((turn) => {
    const key = promptOf.get(turn.turn);
    const preview = turn.preview?.trim() || (turn.hasAttachments ? t`附件` : '');
    const refs = [...new Set([turn.turnId, ...(turn.runId ? [turn.runId] : []), ...(key ? byKey.get(key)?.refs ?? [] : [])])];
    return { key: key ?? `${OUTLINE_TURN}${turn.turn}`, text: (key && byKey.get(key)?.text) || preview, at: (key && byKey.get(key)?.at) || turn.at, refs };
  });
  const seen = new Set(listed.map((turn) => turn.key));
  return [...listed, ...loaded.filter((turn) => !seen.has(turn.key))];
}
type HistoryLoad = NonNullable<NativeStatus['history']>;

/** A disconnected stream cannot vouch for live action targets or fresh rate samples. */
function withoutLive(status: NativeStatus): NativeStatus {
  const { outputRate: _outputRate, activeTurn: _activeTurn, runtimeControl: _runtimeControl, ...rest } = status;
  return rest;
}

/** v3 sends the interaction on its own; the views read it from the status, as before. */
function statusWith(status: NativeStatus, interaction: NativeInteraction | null): NativeStatus {
  const { interaction: _interaction, ...rest } = status;
  return interaction ? { ...rest, interaction } : rest;
}

const liveTasks = (activities: readonly NativeActivity[]) => activities.filter((activity) => activity.kind === 'background_task' && (activity.status === 'running' || activity.status === 'stopping'));
const sameActivities = (a: readonly NativeActivity[], b: readonly NativeActivity[]) => a.length === b.length && a.every((activity, index) => activity === b[index]);

/** The tool's summaries, whether seen in a loaded window or accepted outside it by the live lane. */
function writeToolSummaries(rows: readonly TimelineRow[], subagents: SubagentStore, jobs: NativeJobStore, consumed: Map<string, number>): void {
  for (const row of rows) {
    if (row.kind !== 'tool' || (!row.job && !row.subagent)) continue;
    // A page can know more than the live stream has reached. Keep that watermark even after its
    // row leaves the window, so a delayed live row or older hydration cannot undo its summary.
    if ((consumed.get(row.key) ?? -1) > row.seq) continue;
    consumed.set(row.key, row.seq);
    if (row.job && jobs.get(row.job.toolCallId) !== row.job) jobs.set(row.job);
    const summary = row.subagent;
    if (!summary) continue;
    const toolCallId = typeof row.event.data.toolCallId === 'string' ? row.event.data.toolCallId : summary.lane.slice('sub:'.length);
    const canonical = subagents.canonical(toolCallId, summary.agentId);
    const summaryKey = `sub:${canonical}`;
    const held = subagents.get(toolCallId);
    // A newer claim under an old alias can name a different agent. Its transcript and descriptive
    // metadata start afresh; only an unidentified entry or this same agent may supply history.
    const previous = !held?.agentId || held.agentId === summary.agentId ? held : undefined;
    // A resumed/repaired child can have several tool rows. Their canonical entry shares one
    // watermark; an older alias may join it, but must not move its current lane or execution state.
    if ((consumed.get(summaryKey) ?? -1) > row.seq) {
      const current = subagents.get(canonical);
      if (current && previous !== current) subagents.set(toolCallId, current);
      continue;
    }
    consumed.set(summaryKey, row.seq);
    if (previous?.agentId === summary.agentId && previous.running === summary.running && previous.title === summary.title && previous.model === summary.model && previous.subagentType === summary.subagentType && previous.lane === summary.lane && previous.status === summary.status && previous.activeTurnId === summary.turnId && previous.startedAt === summary.startedAt && previous.endedAt === summary.endedAt) continue;
    subagents.set(toolCallId, {
      ...previous, events: previous?.events ?? [], agentId: summary.agentId, running: summary.running, lane: summary.lane, status: summary.status, activeTurnId: summary.turnId, startedAt: summary.startedAt, endedAt: summary.endedAt,
      ...(summary.title ? { title: summary.title } : {}), ...(summary.model ? { model: summary.model } : {}), ...(summary.subagentType ? { subagentType: summary.subagentType } : {}),
    });
  }
}

function historyLoad(state: SessionSyncState): HistoryLoad {
  if (state.connection === 'outdated') return { state: 'error', message: t`服务器版本过旧` };
  // The server's own error: the stream ended for good, or it goes on while the transcript cannot be read.
  if (state.connection === 'failed' || state.error) return { state: 'error', ...(state.error?.message ? { message: state.error.message } : {}) };
  const history = state.status.history;
  if (history?.state === 'error' || history?.state === 'loading') return history;
  // Cached rows remain readable, but only this connection's confirmed, caught-up read can recover
  // an earlier failure. `loaded` alone also holds while reconnecting or loading fresh history.
  return state.connection === 'open' && state.synced && !state.catchingUp ? { state: 'ready' } : { state: 'loading' };
}

/** One call per animation frame, or per 250ms while hidden, however often it is asked for. */
function coalesced(run: () => void): { schedule: () => void; flush: () => void; cancel: () => void } {
  let frame: number | undefined;
  let timer: number | undefined;
  const cancel = () => {
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
    frame = timer = undefined;
  };
  const flush = () => { cancel(); run(); };
  const schedule = () => {
    if (frame !== undefined || timer !== undefined) return;
    if (document.visibilityState === 'visible') frame = window.requestAnimationFrame(flush);
    else timer = window.setTimeout(flush, 250);
  };
  return { schedule, flush, cancel };
}

function turnsOf(timeline: readonly TimelineItem[]): Turn[] {
  const keys = timelineTurnKeys(timeline as TimelineItem[]);
  const seen = new Set<string>();
  return timeline.flatMap((item, index) => {
    if (item.kind !== 'user' || seen.has(keys[index]!)) return [];
    seen.add(keys[index]!);
    const event = item.event as typeof item.event & { nativeTurnId?: string };
    const refs = [event.nativeTurnId, item.run?.id ?? event.runId].filter((ref): ref is string => Boolean(ref));
    return [{ key: item.key, text: item.text.trim() || (item.attachments.length ? t`附件` : ''), at: item.event.createdAt, refs }];
  });
}

/**
 * One conversation over sync v3 (docs/SYNC-V3.md), filled by `SessionSync`. The rows are the server's, adapted to the transcript's
 * items; status, runs, context and metrics come only from control frames. Sending, steering and
 * interactions are the same requests as before (`nativeRunCommands.ts`).
 */
export function useSessionSync(session: Session, { onSessionChanged, onError, notificationsEnabled, initialRun, source }: Options, chatActive = true) {
  const firstInitialRun = useRef(initialRun);
  const seedFor = (sessionId: string) => (firstInitialRun.current?.sessionId === sessionId ? firstInitialRun.current : undefined);
  const [store] = useState(() => createNativeSessionStore(snapshotWithLocalOutbox(session, [], seedFor(session.id))));
  const [view] = useState(() => createStore<SyncView>(blankView()));
  const [tracking] = useState<NativeSessionTracking>(() => ({ sessionId: session.id, runsRevision: 0, transcriptKnown: false, initialRun, sendInFlight: false }));
  const latest = useRef<NativeSessionLatest>({ onSessionChanged, onError, notificationsEnabled, title: session.title, chatActive });
  latest.current = { onSessionChanged, onError, notificationsEnabled, title: session.title, chatActive };
  const subagents = useMemo(() => new SubagentStore(), [session.id]);
  const jobs = useMemo(() => new NativeJobStore(), [session.id]);
  const engine = useRef<SessionSync | undefined>(undefined);
  const state = useStore(store, (current) => current);
  const synced = useStore(view, (current) => current);
  // Which conversation identity the open subagent panels streamed for. The child lanes have their
  // own generations, so a panel is bound to this epoch rather than compared with them; a change
  // releases the old lanes and attaches fresh ones instead of leaving the panel dead.
  const identityEpoch = useRef(0);
  const watchedPanels = useRef(new Set<{ detach: () => void; attach: () => void }>());
  const nativeSessionId = session.nativeSessionId;
  // Control frames can name a new thread before React receives its session prop. An unchanged prop
  // must not undo that identity; a genuinely changed prop is seen by live callbacks before effects.
  const nativeThread = useRef({ prop: nativeSessionId, current: nativeSessionId });
  if (nativeThread.current.prop !== nativeSessionId) nativeThread.current = { prop: nativeSessionId, current: nativeSessionId };
  const syncToolSummaries = useRef<(() => void) | undefined>(undefined);
  const { runs } = state;

  // A layout effect: a copy held in memory is published before the first paint of this conversation.
  useLayoutEffect(() => {
    const seed = seedFor(session.id);
    Object.assign(tracking, { sessionId: session.id, initialRun: seed, runsRevision: 0, transcriptKnown: false });
    store.set((current) => ({ ...blankNativeSession(snapshotWithLocalOutbox(session, [], seed)), timelineVersion: current.timelineVersion + 1, resetVersion: current.resetVersion + 1 }));
    view.set(blankView());
    let previousPhase: NativeStatus['phase'] | undefined;
    const completions = new TurnCompletionNotifications();
    let summaryGeneration: string | undefined;
    let summaryThread = nativeThread.current.current;
    let summaryRows: readonly TimelineRow[] | undefined;
    const summarySeq = new Map<string, number>();
    let blockedResetVersion: number | undefined;
    let blockedGeneration: string | undefined;
    let reattachPanels = false;

    const syncSummaryIdentity = () => {
      const generation = sync.main.generation;
      const thread = nativeThread.current.current;
      const generationChanged = summaryGeneration !== generation;
      const threadChanged = Boolean(summaryThread && summaryThread !== thread);
      if (generationChanged || threadChanged) {
        // Live callbacks and window hydration cross the same boundary synchronously: detach first,
        // then forget both stores. A later React effect must not erase the new identity's upserts.
        identityEpoch.current += 1;
        for (const panel of watchedPanels.current) panel.detach();
        summarySeq.clear();
        subagents.clear();
        jobs.clear();
        summaryRows = undefined;
        // Reset leaves the old window on screen. A thread change can also precede its reset; do not
        // seed that window again, even if unrelated live rows change it before its replacement.
        blockedResetVersion = !sync.main.resumable || threadChanged ? sync.store.get().resetVersion : undefined;
        // A page/jump can replace the old window too. Only a new generation vouches for the new
        // thread when its announcement arrived first; neither old live rows nor paging unlock it.
        // A snapshot hello publishes its generation before onControl names its thread. While that
        // snapshot is pending, the reset-version barrier suffices; its new generation is not old.
        blockedGeneration = threadChanged && !generationChanged && sync.main.resumable ? generation : undefined;
        reattachPanels = true;
      }
      summaryGeneration = generation;
      summaryThread = thread;
      // Raw upserts and window hydration must pass the same identity barrier, including when
      // another old-generation frame arrives without a second identity change.
      if (!sync.main.resumable || blockedResetVersion === sync.store.get().resetVersion || (blockedGeneration !== undefined && blockedGeneration === generation)) return false;
      blockedResetVersion = undefined;
      return true;
    };
    const attachPanels = () => {
      if (!reattachPanels) return;
      reattachPanels = false;
      for (const panel of watchedPanels.current) panel.attach();
    };
    const hydrateSummaries = () => {
      if (!syncSummaryIdentity()) return;
      const rows = sync.rows();
      if (summaryRows !== rows) {
        summaryRows = rows;
        writeToolSummaries(rows, subagents, jobs, summarySeq);
      }
      attachPanels();
    };

    const notify = (body: string) => {
      if (!latest.current.notificationsEnabled || document.visibilityState !== 'hidden' || !('Notification' in window) || Notification.permission !== 'granted') return;
      try {
        // The conversation is already the one on screen, so the click only brings the window back; `tag` keeps one conversation from stacking.
        const notification = new Notification('Riffet', { body, tag: session.id });
        notification.onclick = () => { window.focus(); };
      } catch { /* ignore */ }
    };
    const notifyAttention = (status: NativeStatus) => {
      const phase = status.phase;
      const before = previousPhase;
      previousPhase = phase;
      if (!before || before === phase || phase !== 'attention') return;
      const title = latest.current.title;
      notify(status.interaction ? t`「${title}」需要你在网页中选择` : t`「${title}」需要你在终端里操作`);
    };
    const setRuns = (list: Run[]) => {
      tracking.runsRevision += 1;
      // A created session's first run is a server receipt, not a local copy. Keep it as the inline
      // stand-in until the server's own `user:` row replaces it; `keepsInlineReceipt` drops it once
      // it settles.
      const echoed = tracking.initialRun ? list.find((run) => run.commandId === tracking.initialRun!.commandId) : undefined;
      if (echoed) tracking.initialRun = echoed;
      const next = snapshotWithLocalOutbox(session, list, tracking.initialRun);
      store.set({ runs: next });
      absorbRunMetrics(store, next);
    };
    const control = (frame: ControlFrame) => {
      if (tracking.sessionId !== session.id) return;
      if (frame.type === 'hello' || frame.type === 'session') {
        nativeThread.current.current = frame.session.nativeSessionId;
        hydrateSummaries();
      }
      completions.setThread(nativeThread.current.current);
      const completed = frame.type === 'hello'
        ? completions.hello(nativeThread.current.current, frame.outline?.turns ?? [], Date.now())
        // Identity announcements do not imply a new hello. Share the summary generation barrier
        // so a replacement's first confirmed outline baselines it without consuming old frames.
        : frame.type === 'outline' && syncSummaryIdentity()
          && completions.hello(nativeThread.current.current, frame.turns, Date.now());
      if (completed) {
        const title = latest.current.title;
        notify(t`「${title}」已完成`);
      }
      switch (frame.type) {
        case 'hello': {
          const status = statusWith(frame.status, frame.interaction ?? null);
          store.set({ status, statusKnown: true, context: frame.context });
          notifyAttention(status);
          setRuns(Array.isArray(frame.runs) ? frame.runs : []);
          break;
        }
        case 'status': {
          const status = statusWith(frame.status, sync.store.get().interaction);
          store.set({ status, statusKnown: true });
          notifyAttention(status);
          break;
        }
        case 'interaction': store.set((current) => ({ status: statusWith(current.status, frame.interaction ?? null) })); break;
        case 'runs': setRuns(frame.runs); break;
        case 'run': {
          const run = frame.run;
          if (!run || run.sessionId !== session.id) break;
          if (run.commandId && listNativeSendRequests(session.id).some((entry) => entry.body.commandId === run.commandId)) removeNativeSendRequest(session.id, run.commandId);
          if (run.commandId === tracking.initialRun?.commandId) tracking.initialRun = run;
          updateRuns(store, tracking, (current) => mergeRun(current, run));
          absorbRunMetrics(store, [run]);
          break;
        }
        case 'context': store.set({ context: frame.context }); break;
        case 'metrics': {
          // A turn typed in the CLI has no Run; its receipt names it, as `transcriptTurns` looks it up.
          const runId = frame.runId ?? (frame.nativeMessageId ? `native:${frame.nativeMessageId}` : undefined);
          if (runId && frame.run) recordRunMetrics(store, runId, frame.run);
          break;
        }
        case 'session': latest.current.onSessionChanged(frame.session); break;
      }
    };
    const sync = new SessionSync({
      sessionId: session.id, transport: source?.transport ?? browserTransport, cache: source ? source.cache : browserCache(), visibility: documentVisibility, onControl: control, onClosed: () => { void confirmSessionGone(session.id); },
      onUpserts: (rows) => {
        if (!syncSummaryIdentity()) return;
        writeToolSummaries(rows, subagents, jobs, summarySeq);
        attachPanels();
      },
    });
    engine.current = sync;

    const publish = coalesced(() => {
      const current = sync.store.get();
      const connected = current.connection === 'open';
      tracking.transcriptKnown = current.loaded;
      const load = historyLoad(current);
      store.set((previous) => ({
        connected, loaded: current.loaded, catchingUp: current.catchingUp, loadingHistory: current.loadingBefore,
        historyLoad: previous.historyLoad.state === load.state && previous.historyLoad.message === load.message ? previous.historyLoad : load,
        // Until the hello the status is a placeholder; a stream that could not be opened is news too.
        statusKnown: previous.statusKnown || ['retrying', 'failed', 'outdated'].includes(current.connection),
        history: !current.generation ? undefined
          : previous.history?.generation === current.generation && previous.history.hasMore === current.hasBefore ? previous.history
          : { generation: current.generation, hasMore: current.hasBefore },
        ...(previous.connected && !connected ? { status: withoutLive(previous.status) } : {}),
      }));
      view.set((previous) => {
        const activities = liveTasks(current.activities);
        return {
          rows: sync.rows(), resetVersion: current.resetVersion, hasAfter: current.hasAfter, loadingAfter: current.loadingAfter,
          activities: sameActivities(activities, previous.activities) ? previous.activities : activities,
          outline: current.outline, ...(current.generation ? { generation: current.generation } : {}),
        };
      });
    });
    const stopPublishing = sync.store.subscribe(() => {
      hydrateSummaries();
      publish.schedule();
    });

    // Subagent lanes: streamed while a panel shows one, each published per frame like the main lane.
    const watched = new Map<string, LaneSync>();
    const panels = watchedPanels.current;
    subagents.lanes = {
      watch: (toolCallId) => {
        // A panel streams the lane the server bound its child to, which is not always the call id
        // the child was announced under, and writes under the child's canonical id. A reset forgets
        // the aliases it resolved through, so the id found while the child was held is kept.
        let known = subagents.canonical(toolCallId);
        const canonicalId = () => {
          const current = subagents.canonical(toolCallId);
          if (subagents.get(current)) known = current;
          return known;
        };
        const laneFor = (): SyncLane => subagents.get(canonicalId())?.lane ?? `sub:${canonicalId()}`;
        let items: TimelineItem[] = [];
        let resets = 0;
        let replaced = false;
        let epoch = identityEpoch.current;
        let bound: { lane: LaneSync; name: SyncLane; agentId?: string; release: () => void } | undefined;
        const update = coalesced(() => {
          const held = bound;
          // The lane has not answered yet (or the conversation identity moved): keep what is shown.
          if (!held || !held.lane.synced || epoch !== identityEpoch.current) return;
          // The server may have bound the child to another lane since (a repaired spawn); follow
          // the store rather than let this lane's late frames overwrite what the new one streams.
          if (laneFor() !== held.name || (subagents.get(canonicalId())?.agentId || undefined) !== held.agentId) { attach(); return; }
          items = timelineItems(held.lane.window.rows(), session.id, store.get().runs, items);
          if (replaced) resets += 1;
          replaced = false;
          const id = canonicalId();
          const previous = subagents.get(id);
          // A panel on a retired call has no child to show; an empty lane must not make one.
          if (!items.length && !previous) return;
          subagents.set(id, {
            ...previous, agentId: previous?.agentId ?? '', events: items.map((item) => item.event), timeline: items,
            ...(held.lane.generation ? { history: { generation: held.lane.generation, hasMore: held.lane.window.hasBefore } } : {}),
            resetVersion: resets, synced: held.lane.synced, loadingEarlier: held.lane.loadingBefore,
          });
        });
        const detach = () => {
          update.cancel();
          const held = bound;
          bound = undefined;
          if (!held) return;
          if (watched.get(toolCallId) === held.lane) watched.delete(toolCallId);
          held.release();
        };
        const attach = () => {
          const name = laneFor();
          const agentId = subagents.get(canonicalId())?.agentId || undefined;
          if (bound?.name === name && bound.agentId === agentId) return;
          // The same lane name can be reclaimed by another agent; its old window is no more valid
          // than a retired alias. Release it and discard local row reuse before streaming the claim.
          items = [];
          replaced = false;
          detach();
          epoch = identityEpoch.current;
          const opened = sync.openLane(name, (wasReplaced) => { replaced ||= wasReplaced; update.schedule(); });
          bound = { ...opened, name, agentId };
          watched.set(toolCallId, opened.lane);
        };
        const panel = { attach, detach };
        // A child the server re-binds to another lane is followed even before that lane sends a row.
        const unwatch = subagents.subscribe(toolCallId, () => { if (bound) attach(); });
        panels.add(panel);
        attach();
        return () => {
          unwatch();
          panels.delete(panel);
          detach();
        };
      },
      loadEarlier: (toolCallId) => watched.get(toolCallId)?.pageUp() ?? watched.get(subagents.canonical(toolCallId))?.pageUp() ?? Promise.resolve('none'),
    };

    syncToolSummaries.current = hydrateSummaries;
    void sync.start();
    // `start` restores a copy held in memory synchronously; its rows must not wait for the next animation frame.
    if (sync.store.get().loaded) publish.flush();
    return () => {
      if (syncToolSummaries.current === hydrateSummaries) syncToolSummaries.current = undefined;
      stopPublishing();
      publish.cancel();
      subagents.lanes = undefined;
      // The panels of this conversation are released with its streams; nothing of them may be
      // re-attached by the next conversation's effects.
      watchedPanels.current.clear();
      sync.close();
      if (engine.current === sync) engine.current = undefined;
      if (tracking.sessionId === session.id) tracking.sessionId = '';
    };
  }, [session.id, subagents, jobs]);

  // A prop-only thread replacement crosses the same synchronous boundary as server frames. Rows
  // and generation are not effect dependencies: a delayed render cannot clear freshly accepted data.
  useEffect(() => {
    syncToolSummaries.current?.();
  }, [nativeSessionId, subagents, jobs]);

  /** Sends this tab drew a local row for. Only those keep it until the server's row lands; another device's send never gets one. */
  const ownSends = useRef(new Set<string>());
  const localRuns = useMemo(() => {
    for (const run of runs) if (isLocalCopy(run)) ownSends.current.add(run.commandId);
    // A window that has given up its tail (the reader scrolled back) shows no pending row at its foot.
    return runs.filter((run) => isLocalCopy(run) || (!synced.hasAfter && ownSends.current.has(run.commandId) && awaitsServerRow(run)));
  }, [runs, synced.hasAfter]);
  // A created session's first run arrives as a server receipt. Until the server's own `user:` row
  // lands, the receipt supplies the transcript row, so the prompt appears where it was sent instead
  // of waiting in the dock like a follow-up queued behind a turn.
  const inlineRun = useMemo(() => {
    const created = tracking.initialRun;
    if (!created) return undefined;
    const current = runs.find((run) => run.commandId === created.commandId) ?? created;
    return keepsInlineReceipt(current) ? current : undefined;
  }, [runs, tracking]);
  const outboxRuns = useMemo(() => (inlineRun && !localRuns.some((run) => run.commandId === inlineRun.commandId)
    ? [...localRuns, inlineRun]
    : localRuns), [inlineRun, localRuns]);
  const rows = useMemo(() => withLocalOutbox(synced.rows, outboxRuns), [synced.rows, outboxRuns]);
  /** The adapted rows and their turns, each with a version that moves only when it changed. */
  const derived = useRef({ timeline: [] as TimelineItem[], timelineVersion: 0, turns: [] as Turn[], turnsVersion: 0 });
  const timeline = useMemo(() => {
    const held = derived.current;
    const next = timelineItems(rows, session.id, runs, held.timeline);
    if (next !== held.timeline) {
      held.timeline = next;
      held.timelineVersion += 1;
    }
    return next;
  }, [rows, runs, session.id]);
  useMemo(() => {
    const held = derived.current;
    const turns = turnList(synced.outline.turns, rows, turnsOf(timeline));
    if (turns.length !== held.turns.length || turns.some((turn, index) => { const prior = held.turns[index]!; return turn.key !== prior.key || turn.text !== prior.text || turn.at !== prior.at || turn.refs?.join() !== prior.refs?.join(); })) {
      held.turns = turns;
      held.turnsVersion += 1;
    }
  }, [synced.outline, rows, timeline]);

  // The hello carries the newest turns; the rail and outline list them all.
  const outlineRead = useRef<string | undefined>(undefined);
  useEffect(() => {
    const { outline, generation } = synced;
    if (!generation || outline.turnCount <= outline.turns.length || outlineRead.current === generation) return;
    outlineRead.current = generation;
    void engine.current?.loadOutline();
  }, [synced]);
  const { timelineVersion, turns, turnsVersion } = derived.current;

  useEffect(() => {
    if (!localRuns.length) return;
    // The server's own row (`user:<commandId>`) or Run settles a local copy; this only reports one it never claimed.
    return settleLocalCopies(store, tracking);
  }, [localRuns, store, tracking]);

  const hasUnknownSubmission = runs.some((run) => run.native?.delivery === 'uncertain' && run.native.stage === 'http_unknown');
  // The server says whether an unconfirmed delivery still holds the conversation (a steer whose turn is over does not); an older server leaves it to the runs.
  const queue = state.status.queue;
  const hasUncertainSubmission = hasUnknownSubmission || (queue ? queue.held?.reason === 'unconfirmed' : runs.some((run) => run.native?.delivery === 'uncertain' && !run.native.queueReleasedAt));
  const retryConnection = useCallback(() => engine.current?.retry(), []);
  const loadOlder = useCallback((): Promise<EarlierLoad> => engine.current?.pageUp() ?? Promise.resolve('none'), []);
  const loadLater = useCallback((): Promise<EarlierLoad> => engine.current?.pageDown() ?? Promise.resolve('none'), []);
  const readerAtEnd = useCallback((atEnd: boolean) => engine.current?.readerAtEnd(atEnd), []);
  const jumpToLatest = useCallback(async (signal?: AbortSignal): Promise<boolean> => (await engine.current?.latest(signal)) === 'progress', []);
  const loadTurn = useCallback(async (key: string, signal?: AbortSignal): Promise<string | false> => {
    const sync = engine.current;
    const turn = key.startsWith(OUTLINE_TURN) ? key.slice(OUTLINE_TURN.length) : undefined;
    const target = turn !== undefined ? sync?.store.get().outline.turns.find((item) => item.turn === turn) : undefined;
    if (!sync || !target) return false;
    if ((await sync.jump(target.startPos, signal)) !== 'progress') return false;
    // The outline placeholder is replaced by the prompt's real key once the page arrives.
    return sync.rows().find(row => row.turn === target.turn && row.kind === 'user')?.key ?? false;
  }, []);
  const expandRow = useCallback((key: string) => engine.current?.expand(key) ?? Promise.resolve(false), []);
  const findInLane = useCallback((query: string, signal?: AbortSignal) => engine.current?.find(query, signal) ?? Promise.resolve(undefined), []);
  const loadPlace = useCallback(async (pos: number, signal?: AbortSignal) => (await engine.current?.jump(pos, signal)) === 'progress', []);
  const commands = useNativeRunCommands({ session, store, tracking, latest });

  const respondInteraction = useCallback(async (_interaction: NativeInteraction, response: NativeInteractionResponse): Promise<NativeInteractionResult> => {
    const sync = engine.current;
    if (!store.get().connected || sync?.sessionId !== session.id) throw new Error(t`连接已断开，请等待同步后再提交`);
    const observedVersion = sync.interactionVersion;
    const received = await api.nativeInteraction(session.id, response);
    if (tracking.sessionId !== session.id || engine.current !== sync) return { status: 'uncertain', message: t`会话已经切换，已忽略旧会话的交互结果。` };
    const result = received.status === 'advanced' && received.interaction?.id === response.interactionId && received.interaction.revision === response.revision
      ? { ...received, status: 'uncertain' as const, message: received.message ?? t`CLI 仍显示同一个待处理交互，请先同步当前状态。` }
      : received;
    // Never roll a live observation back to an older receipt, even under the same interaction id.
    // Completion clears only the revision actually submitted; it says nothing about the turn's phase.
    if (result.status === 'completed' || (result.status === 'advanced' && result.interaction)) {
      const applied = sync.updateInteraction(result.interaction ?? null, observedVersion, response);
      const current = sync.store.get().interaction;
      if (!applied && current?.id === response.interactionId && current.revision === response.revision) {
        // A reset/thread replacement can still leave this card visible. Do not freeze it as
        // success when its receipt was deliberately fenced out; preserve its recovery controls.
        return { status: 'uncertain', message: t`CLI 已响应，但当前交互已变化。请同步状态或查看终端，不要重复提交。` };
      }
    }
    return result;
  }, [session.id, store, tracking]);

  const syncInteraction = useCallback(async (): Promise<NativeInteraction | null> => {
    const sync = engine.current;
    if (sync?.sessionId !== session.id) return null;
    const observedVersion = sync.interactionVersion;
    const current = await api.nativeCurrentInteraction(session.id);
    if (tracking.sessionId !== session.id || engine.current !== sync) return null;
    sync.updateInteraction(current, observedVersion);
    // A superseded read must not tell the card to settle against the discarded snapshot either.
    return sync.store.get().interaction;
  }, [session.id, tracking]);

  const extras: SyncExtras = {
    hasMoreLater: synced.hasAfter, loadingLater: synced.loadingAfter, loadLater, readerAtEnd, jumpToLatest, loadTurn, expandRow, findInLane, loadPlace, activities: synced.activities,
  };
  return {
    ...state, timelineVersion, resetVersion: synced.resetVersion, store, timeline, turns, turnsVersion,
    inlineRun, hasUnknownSubmission, hasUncertainSubmission, subagents, jobs, retryConnection,
    loadOlder, ...commands, respondInteraction, syncInteraction, ...extras,
  };
}
