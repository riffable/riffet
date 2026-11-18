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
    if (item.kind === 'user') lastUserIndex = index;
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
export function useSessionTranscript(native: ReturnType<typeof useSessionSync>, { working, busy, compacting, root, goal: sessionGoal }: { working: boolean; busy: boolean; compacting: boolean; root?: string; goal?: SessionGoal }) {
  const timeline = native.timeline;
  // `NativeTimelineModel` patches job rows in place, so the version counters below are what signal
  // a change to these derived snapshots. Each snapshot that has an identity of its own is held
  // stable while its contents are, so a streamed frame invalidates only what it actually changed.
  const { timelineVersion, turnsVersion } = native;
  /** Runs waiting their turn; they live in the composer dock, not the transcript (see `messagePlace`). */
  // The first run of a created session is already in the transcript: it was sent directly, not
  // queued behind a previous turn, so it must not also appear in the dock.
  const inlineCommandId = native.inlineRun?.commandId;
  const queue = native.status.queue;
  const queuedRuns = useMemo(() => {
    // The run the server starts next when nothing runs: the oldest one it holds. None while an
    // earlier send is still on its way into the CLI: the session is about to work, and the rest wait.
    const starting = native.runs.some((run) => sendPhase(run) === 'starting' || (run.native?.delivery === 'input_sent' && (run.state === 'queued' || run.state === 'running')));
    const next = starting ? undefined : native.runs.reduce<Run | undefined>((first, run) => inQueue(run) && (!first || run.createdAt < first.createdAt) ? run : first, undefined);
    return native.runs.filter((run) => messagePlace(run, working, run === next, queue) === 'dock' && run.commandId !== inlineCommandId);
  }, [native.runs, working, inlineCommandId, queue]);
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
  const showWorking = busy && !(compacting && showsRunningCompaction(visibleTimeline));
  /**
   * When the turn being worked on was prompted, so the indicator can count from it. A turn a hidden
   * prompt opened (a peer's message, a scheduled wake-up) has no prompt row: it counts from its first
   * row, never from an earlier turn's prompt.
   */
  const workingSince = useMemo(() => {
    if (!showWorking) return undefined;
    const turn = visibleTimeline.findLast(item => item.kind !== 'activity')?.turn;
    let start: TimelineItem | undefined;
    for (let index = visibleTimeline.length - 1; index >= 0; index -= 1) {
      const item = visibleTimeline[index]!;
      if (turn && item.turn && item.turn !== turn && item.kind !== 'activity') break;
      if (item.kind === 'activity') continue;
      start = item;
      if (item.kind === 'user' || item.kind === 'task_notification') break;
    }
    if (!start || (!turn && start.kind !== 'user' && start.kind !== 'task_notification')) return undefined;
    const at = Date.parse(start.event.createdAt);
    return Number.isFinite(at) ? at : undefined;
  }, [showWorking, visibleTimeline, timelineVersion]);
  return { queuedRuns, todoEntries, goal, subagentBriefs, visibleTimeline, visibleTurns, showWorking, workingSince };
}
