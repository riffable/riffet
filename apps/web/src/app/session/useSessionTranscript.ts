import { useMemo, useRef } from 'react';
import type { Run, SessionGoal } from '@contracts';
import type { TimelineItem } from './model';
import { todoPlanForDock } from './ComposerDock';
import { inQueue, messagePlace, sendPhase } from './delivery';
import { showsRunningCompaction } from './Activities';
import { sameMap, sameSet, useStable } from './stable';
import type { SubagentBrief } from './SessionWorkActions';
import { toolView } from './toolView';
import { isRecord, str } from '@/lib/utils';
import { isUnreceivedSteer, withoutLinkedActivities } from '../../../../../packages/timeline/src/model';
import { activeTurnState, analyzeTimelineTurns, type ActiveTurnState } from './timelineTurns';
import type { useSessionSync } from './useSessionSync';

const noKeys: ReadonlySet<string> = new Set();
const sameGoal = (a: SessionGoal | undefined, b: SessionGoal | undefined) => a === b || Boolean(a && b && a.objective === b.objective && a.status === b.status && a.reason === b.reason && a.tokensUsed === b.tokensUsed && a.tokenBudget === b.tokenBudget);
const sameBriefs = (a: ReadonlyMap<string, SubagentBrief>, b: ReadonlyMap<string, SubagentBrief>) => sameMap(a, b, (x, y) => x.title === y.title && x.detail === y.detail);

/** One tool call's parse, kept per event: a row's event is replaced whenever the row changes. */
interface ToolDigest { brief: readonly [string, SubagentBrief] | null }

/**
 * Everything the composer dock and the side column read off the timeline, in one walk: the
 * current todo list and what each Task call asked for. Each tool row is parsed
 * once (through [digestOf]'s cache), so a streamed frame re-walks pointers, not JSON.
 *
 * The todo list is the newest plan; once it is finished and a later turn has started it has done
 * its job — the DeepSeek Harness behaviour is to drop the list at turn start.
 */
function digestTimeline(timeline: readonly TimelineItem[], digestOf: (event: TimelineItem['event']) => ToolDigest) {
  let planIndex = -1;
  let lastUserIndex = -1;
  const briefs = new Map<string, SubagentBrief>();
  for (let index = 0; index < timeline.length; index += 1) {
    const item = timeline[index]!;
    if (item.kind === 'user' && !isUnreceivedSteer(item)) lastUserIndex = index;
    else if (item.kind === 'plan') planIndex = index;
    if (item.kind !== 'tool') continue;
    const { brief } = digestOf(item.event);
    if (brief) briefs.set(brief[0], brief[1]);
  }
  const plan = planIndex < 0 ? undefined : timeline[planIndex] as Extract<TimelineItem, { kind: 'plan' }>;
  return {
    todos: plan ? todoPlanForDock(plan.entries, lastUserIndex > planIndex) : undefined,
    briefs,
  };
}

/**
 * What a session's transcript shows, and what lives beside it instead: queued messages and the todo
 * list go to the composer dock, and the working line waits where the running turn's footer will be.
 * The session page and the transcript replay (`replay/`) both read it here, so the replay measures
 * the same transcript the reader gets.
 */
export function useSessionTranscript(native: ReturnType<typeof useSessionSync>, { working, busy, compacting, root, goal: sessionGoal, activeSince }: { working: boolean; busy: boolean; compacting: boolean; root?: string; goal?: SessionGoal; activeSince?: string }) {
  const timeline = native.timeline;
  // `NativeTimelineModel` patches job rows in place, so the version counters below are what signal
  // a change to these derived snapshots. Each snapshot that has an identity of its own is held
  // stable while its contents are, so a streamed frame invalidates only what it actually changed.
  const { timelineVersion, turnsVersion } = native;
  /** Runs waiting their turn; they live in the composer dock, not the transcript (`control.inbox`; `messagePlace` only for a server without one). */
  // The first run of a created session is already in the transcript: it was sent directly, not
  // queued behind a previous turn, so it must not also appear in the dock.
  const inlineCommandId = native.inlineRun?.commandId;
  const queue = native.status.queue;
  const control = native.control;
  const queuedRuns = useMemo(() => {
    if (control) {
      const byId = new Map(native.runs.map((run) => [run.id, run]));
      const byCommand = new Map<string, Run>();
      for (const run of native.runs) {
        const prior = byCommand.get(run.commandId);
        // A server receipt outranks this tab's copy when both still share a command id.
        if (!prior || prior.native?.fingerprint === 'client-pending') byCommand.set(run.commandId, run);
      }
      const inInbox = new Set<string>();
      for (const entry of control.inbox) {
        inInbox.add(entry.id);
        inInbox.add(entry.commandId);
      }
      const queued: Run[] = [];
      const added = new Set<string>();
      for (const entry of control.inbox) {
        if (entry.placement !== 'queued') continue;
        const run = byId.get(entry.id) ?? byCommand.get(entry.commandId);
        if (!run || added.has(run.id) || run.commandId === inlineCommandId) continue;
        added.add(run.id);
        queued.push(run);
      }
      // A send this tab drew before the server listed it, and only while a turn or a hold would queue it.
      if (control.activeTurn !== null || control.held) {
        for (const run of native.runs) {
          const details = run.native;
          if (added.has(run.id) || run.commandId === inlineCommandId || inInbox.has(run.id) || inInbox.has(run.commandId)) continue;
          if (!details || details.fingerprint !== 'client-pending' || details.stage !== 'http_pending' || details.intent === 'steer') continue;
          added.add(run.id);
          queued.push(run);
        }
      }
      return queued;
    }
    // Fallback for a server that sends no control snapshot.
    // The run the server starts next when nothing runs: the oldest one it holds. None while an
    // earlier send is still on its way into the CLI: the session is about to work, and the rest wait.
    const starting = native.runs.some((run) => sendPhase(run) === 'starting' || (run.native?.delivery === 'input_sent' && (run.state === 'queued' || run.state === 'running')));
    const next = starting ? undefined : native.runs.reduce<Run | undefined>((first, run) => inQueue(run) && (!first || run.createdAt < first.createdAt) ? run : first, undefined);
    return native.runs.filter((run) => messagePlace(run, working, run === next, queue) === 'dock' && run.commandId !== inlineCommandId);
  }, [control, native.runs, working, inlineCommandId, queue]);
  const queuedKeys = useStable(useMemo(() => {
    if (!queuedRuns.length) return noKeys;
    const ids = new Set(queuedRuns.map((run) => run.id));
    return new Set(timeline.flatMap((item) => item.kind === 'user' && item.run && ids.has(item.run.id) ? [item.key] : []));
  }, [timeline, timelineVersion, queuedRuns]), sameSet);
  /**
   * The dock above the composer owns the todo list (and the goal), and the side column also lists
   * what each Task call asked for (the CLI documents `description` as the subagent's user-facing
   * title, so children are named by what they are doing instead of by their type name). The list and
   * the briefs come from one walk of the timeline; each is held stable while its contents are.
   */
  const toolDigests = useRef<{ root?: string; byEvent: WeakMap<object, ToolDigest> }>({ byEvent: new WeakMap() });
  const digest = useMemo(() => {
    if (toolDigests.current.root !== root) toolDigests.current = { root, byEvent: new WeakMap() };
    const cache = toolDigests.current.byEvent;
    return digestTimeline(timeline, (event) => {
      let entry = cache.get(event);
      if (!entry) {
        const view = toolView(event, root);
        const input = isRecord(view.rawInput) ? view.rawInput : undefined;
        const title = str(input?.description)?.trim();
        const detail = str(input?.prompt)?.trim();
        entry = { brief: title ? [view.id, { title, ...(detail ? { detail } : {}) }] : null };
        cache.set(event, entry);
      }
      return entry;
    });
  }, [timeline, timelineVersion, root]);
  const todoEntries = digest.todos;
  /** The server keeps the goal on the session; held stable so a session frame that did not change it re-renders nothing. */
  const goal = useStable(sessionGoal, sameGoal);
  const subagentBriefs = useStable(digest.briefs, sameBriefs);
  // A queued message is waiting for its turn, and a plan is a live checklist rather than a message,
  // so both are shown once — in the dock above the composer — exactly like the CLI's own inbox.
  // Keeping them out of the transcript also keeps the turn rail and the message timeline agreeing
  // on what has actually been sent.
  const visibleTimeline = useMemo(() => (queuedKeys.size || todoEntries
    ? timeline.filter((item) => (!todoEntries || item.kind !== 'plan') && !queuedKeys.has(item.key))
    : timeline), [timeline, timelineVersion, queuedKeys, todoEntries]);
  const visibleTurns = useMemo(() => (queuedKeys.size ? native.turns.filter((turn) => !queuedKeys.has(turn.key)) : native.turns), [native.turns, turnsVersion, queuedKeys]);
  // Shown for the whole of a running turn, thinking included: the turn header that also says so
  // scrolls away, and an opened thought row has no shimmer, so this line is the one sign that stays
  // in view. A compaction row in the transcript already counts its own time; the line stands down for it.
  const latestVisibleUser = visibleTimeline.findLast((item): item is Extract<TimelineItem, { kind: 'user' }> => item.kind === 'user');
  const latestVisibleUserRun = latestVisibleUser?.run;
  const sendingTurn = !working && (control
    ? control.inbox.some((entry) => entry.placement === 'sending' && entry.kind === 'message'
      && (entry.status === 'queued' || entry.status === 'preparing' || entry.status === 'sending'))
    : Boolean(latestVisibleUserRun?.native
      && latestVisibleUserRun.native.intent !== 'steer'
      && !latestVisibleUserRun.native.queueReleasedAt
      && latestVisibleUserRun.state === 'queued'
      && ['queued', 'preparing', 'dispatching', 'input_sent'].includes(latestVisibleUserRun.native.delivery)
      && !latestVisibleUserRun.native.nativeMessageId
      && !latestVisibleUserRun.native.timings?.observedAt
      && !latestVisibleUserRun.native.timings?.providerAcceptedAt));
  const resumingTurn = sendingTurn && latestVisibleUserRun?.native?.delivery === 'preparing' && latestVisibleUserRun.native.stage === 'resuming';
  const showWorking = (busy || sendingTurn) && !(compacting && showsRunningCompaction(visibleTimeline));
  /**
   * The active turn's presence in `visibleTimeline` and its start time, derived from the same
   * `analyzeTimelineTurns` analysis that owns `TurnProcess` and `heldFooter`. When every visible
   * turn is settled and a new autonomous turn is starting before its first row lands, we never
   * borrow the settled turn's start time or attribute the session's previous rolling speed to it.
   */
  const activeTurnId = native.status.activeTurnId;
  const activeTurn = useMemo<ActiveTurnState>(() => {
    if (!showWorking || sendingTurn) return { inTimeline: false, startedAt: undefined };
    const items = withoutLinkedActivities(visibleTimeline);
    return activeTurnState(items, analyzeTimelineTurns(items, working, activeTurnId), activeSince);
  }, [showWorking, sendingTurn, visibleTimeline, timelineVersion, working, activeTurnId, activeSince]);
  return { queuedRuns, todoEntries, goal, subagentBriefs, visibleTimeline, visibleTurns, showWorking, sendingTurn, resumingTurn, workingSince: activeTurn.startedAt, workingInTimeline: activeTurn.inTimeline };
}
