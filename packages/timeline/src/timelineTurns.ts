import type { NativeWorkbenchEvent, Run } from '../../contracts/src/index.js';
import { isUnreceivedSteer, nativeSourceIds, timelineItemTime, type TimelineItem } from './model.js';

/**
 * Resolves the conversation turn for each displayed row. Most events carry a run id;
 * Native transcript rows can omit it, so rows without one inherit the most recently resolved turn.
 * Keeping this alongside the projection prevents a process disclosure from accidentally
 * combining tool work from adjacent turns.
 */
function providerTurnId(item: TimelineItem): string | undefined {
  return (item.event as Partial<NativeWorkbenchEvent>).nativeTurnId ?? (item.kind === 'user' ? item.run?.native?.nativeTurnId : undefined);
}

export function timelineTurnKeys(timeline: TimelineItem[]): string[] {
  const ownerByTurn = new Map<string, string>();
  const providerKey = (item: TimelineItem) => {
    const turn = providerTurnId(item);
    return turn ? `${item.event.sessionId}:${turn}` : undefined;
  };
  for (const item of timeline) {
    if (item.kind !== 'user' || !item.run?.native) continue;
    const key = providerKey(item);
    const owner = item.run.native.ownerRunId ?? (item.run.native.intent !== 'steer' ? item.run.id : undefined);
    if (key && owner) ownerByTurn.set(key, owner);
  }
  // A steer is its own Run, and the CLI can stamp that Run's id on the output it causes. Such an id
  // resolves to the turn its prompt row joined, not to a turn of its own.
  const turnByRun = new Map<string, string>();
  for (const item of timeline) {
    if (item.kind !== 'user' || !item.run?.native) continue;
    const provider = providerKey(item);
    const owner = item.run.native.ownerRunId ?? (provider ? ownerByTurn.get(provider) : undefined);
    if (owner || provider) turnByRun.set(item.run.id, owner ? `run:${owner}` : `native:${provider}`);
  }
  // A Native user receipt is the exact join between the app's Run id and the CLI's turn id.
  // Keep that alias for the rest of the turn so CLI assistant/tool events group with the
  // receipted user row. Text and timestamps are deliberately not used as identity signals.
  const nativeRunByCliTurn = new Map<string, string>();
  const ambiguousCliTurns = new Set<string>();
  for (const item of timeline) {
    if (item.kind !== 'user' || !item.run?.native?.nativeMessageId || !item.event.runId
      || !nativeSourceIds(item.event).includes(item.run.native.nativeMessageId)) continue;
    const cliTurnId = item.event.runId;
    const existingRunId = nativeRunByCliTurn.get(cliTurnId);
    if (existingRunId && existingRunId !== item.run.id) {
      nativeRunByCliTurn.delete(cliTurnId);
      ambiguousCliTurns.add(cliTurnId);
    } else if (!ambiguousCliTurns.has(cliTurnId)) {
      nativeRunByCliTurn.set(cliTurnId, item.run.id);
    }
  }

  let currentTurn = 'turn:orphan';
  let anonymousTurn = 0;
  return timeline.map((item) => {
    if (item.turn) return currentTurn = item.turn;
    // An activity belongs to no turn of its own: it sits in whichever turn it happened in.
    if (item.kind === 'activity') return currentTurn;
    const provider = providerKey(item);
    const owner = (item.kind === 'user' ? item.run?.native?.ownerRunId : undefined) ?? (provider ? ownerByTurn.get(provider) : undefined);
    if (provider || owner) {
      currentTurn = owner ? `run:${owner}` : `native:${provider}`;
      return currentTurn;
    }
    const joined = (item.kind === 'user' && item.run ? turnByRun.get(item.run.id) : undefined)
      ?? (item.event.runId ? turnByRun.get(item.event.runId) : undefined);
    if (joined) {
      currentTurn = joined;
      return currentTurn;
    }
    if (item.kind === 'user') {
      const runId = item.run?.id ?? item.event.runId;
      currentTurn = runId ? `run:${runId}` : `turn:${++anonymousTurn}`;
      return currentTurn;
    }
    if (item.event.runId) {
      const runId = ambiguousCliTurns.has(item.event.runId)
        ? item.event.runId
        : nativeRunByCliTurn.get(item.event.runId) ?? item.event.runId;
      currentTurn = `run:${runId}`;
      return currentTurn;
    }
    return currentTurn;
  });
}

export interface TimelineTurnAnalysis {
  turnKeys: string[];
  activeTurns: Set<string>;
  lastIndexByTurn: Map<string, number>;
}

/** "已核对" dismisses an uncertain send; it does not cancel the CLI. A receipt proves it arrived. */
function hasAcknowledgedReceipt(item: TimelineItem): boolean {
  if (item.kind !== 'user' || item.run?.state !== 'cancelled') return false;
  const native = item.run.native;
  return native?.stage === 'acknowledged' && native.delivery === 'cancelled'
    && Boolean(native.nativeMessageId && nativeSourceIds(item.event).includes(native.nativeMessageId));
}

function isPendingUser(item: TimelineItem): boolean {
  return item.kind === 'user' && !hasAcknowledgedReceipt(item) && (item.run?.state === 'cancelled'
    || item.run?.native?.delivery === 'queued'
    || item.run?.native?.delivery === 'preparing'
    || item.run?.native?.delivery === 'cancelled'
    || (item.run?.state === 'queued' && !item.run.native));
}

function isDispatchedUserRun(run: Run | undefined): boolean {
  if (!run) return false;
  const delivery = run.native?.delivery;
  if (delivery === 'queued' || delivery === 'preparing' || delivery === 'cancelled' || delivery === 'failed' || delivery === 'uncertain') return false;
  return run.state === 'running' || (run.state === 'queued' && (delivery === 'dispatching' || delivery === 'input_sent' || delivery === 'observed'));
}

/** A completed Run can still have native output committed after its completion was observed. */
function outputFollowsCompletedRun(item: TimelineItem, run: Run): boolean {
  if (run.state !== 'completed') return false;
  const nativeCompletion = run.native?.timings?.completedAt;
  const completedAt = typeof nativeCompletion === 'number' && Number.isFinite(nativeCompletion)
    ? nativeCompletion
    : Date.parse(run.updatedAt);
  const outputAt = Date.parse(timelineItemTime(item));
  return Number.isFinite(completedAt) && Number.isFinite(outputAt) && outputAt > completedAt;
}

/**
 * The Run a timeline turn key stands for, when it was derived from one. Turn keys are either
 * `run:<runId>` for a turn that could be tied back to a workbench run, or a provider-local turn id
 * when it could not — and only the first kind has a run to hang measured output speed on.
 */
export function runIdFromTurnKey(turnKey: string): string | undefined {
  return turnKey.startsWith('run:') ? turnKey.slice(4) : undefined;
}

/** Derives ordering and running state once so a long transcript is scanned only a few times. */
export function analyzeTimelineTurns(timeline: TimelineItem[], sessionRunning: boolean, activeTurnId?: string): TimelineTurnAnalysis {
  const turnKeys = timelineTurnKeys(timeline);
  const activeTurns = new Set<string>();
  const lastIndexByTurn = new Map<string, number>();
  timeline.forEach((item, index) => {
    const turnKey = turnKeys[index]!;
    // An activity or unreceived steer sits in a turn without ending it: neither should make
    // an answer or running process block look followed by a completed segment.
    if (item.kind !== 'activity' && !isUnreceivedSteer(item)) lastIndexByTurn.set(turnKey, index);
    if (item.kind === 'user' && !isUnreceivedSteer(item) && isDispatchedUserRun(item.run)) activeTurns.add(turnKey);
  });
  if (!sessionRunning) {
    activeTurns.clear();
    return { turnKeys, activeTurns, lastIndexByTurn };
  }
  // A provider can wake a completed turn without another prompt or newer timestamps. Its live
  // identity is authoritative even before new output arrives; other completed turns stay settled.
  if (activeTurnId) {
    activeTurns.clear();
    // Match the folded/native turn before source run ids: a resumed native turn can retain the
    // stopped Run's id on every event while the server files it under a different turn.
    const nativeIndex = timeline.findLastIndex(item => item.turn === activeTurnId
      || item.turn === `native:${item.event.sessionId}:${activeTurnId}`
      || ((!item.turn || item.turn.startsWith('run:')) && providerTurnId(item) === activeTurnId));
    const index = nativeIndex >= 0 ? nativeIndex : timeline.findLastIndex(item =>
      item.turn === `run:${activeTurnId}`
      || (!item.turn && (item.event.runId === activeTurnId
        || (item.kind === 'user' && (item.run?.id === activeTurnId || item.run?.native?.ownerRunId === activeTurnId)))));
    if (sessionRunning) activeTurns.add(index >= 0 ? turnKeys[index]! : `run:${activeTurnId}`);
    return { turnKeys, activeTurns, lastIndexByTurn };
  }
  const latestUserIndex = timeline.findLastIndex((item) => item.kind === 'user' && !isUnreceivedSteer(item));
  const latestSentUserIndex = timeline.findLastIndex((item) => item.kind === 'user' && !isPendingUser(item) && !isUnreceivedSteer(item));
  const latestNotificationIndex = timeline.findLastIndex((item) => item.kind === 'task_notification');
  const latestOutputIndex = timeline.findLastIndex((item) => item.kind !== 'user' && item.kind !== 'activity');
  // A folded tail can begin a provider turn without a user prompt. Its server identity keeps
  // native continuation separate from the stopped Run whose id survives in source events.
  if (sessionRunning && latestOutputIndex > latestUserIndex && latestOutputIndex >= 0
    && timeline[latestOutputIndex]!.turn?.startsWith('native:')
    && turnKeys[latestOutputIndex] !== turnKeys[latestUserIndex]) {
    activeTurns.clear();
    activeTurns.add(turnKeys[latestOutputIndex]!);
    return { turnKeys, activeTurns, lastIndexByTurn };
  }
  if (latestNotificationIndex > latestSentUserIndex) {
    // A CLI task notification starts its own native turn. It supersedes stale app Run state
    // from the human turn that launched it; while the session is still busy, only the new turn
    // owns the current processing disclosure and footer state.
    activeTurns.clear();
    if (sessionRunning) activeTurns.add(turnKeys[latestNotificationIndex]!);
  }
  if (sessionRunning && activeTurns.size === 0) {
    const latestUser = latestUserIndex >= 0 ? timeline[latestUserIndex] : undefined;
    const latestUserIsPending = Boolean(latestUser && isPendingUser(latestUser));
    // A native echo may precede the run-list refresh, so it has a real user row but no Run yet.
    // "已核对" only dismisses delivery uncertainty; its exact native receipt can still be live.
    // A completed Run needs stronger evidence: same-turn output newer than its completion.
    // Neither rule lets an unsent prompt or an unrelated old turn inherit session activity.
    if (latestUser?.kind === 'user' && (!latestUserIsPending || (latestOutputIndex > latestUserIndex && turnKeys[latestOutputIndex] === turnKeys[latestUserIndex] && latestUser.run?.state === 'queued' && latestUser.run.native?.delivery !== 'cancelled' && latestUser.run.native?.delivery !== 'failed'))) {
      if (!latestUser.run) {
        activeTurns.add(turnKeys[latestUserIndex]!);
      } else if (latestOutputIndex > latestUserIndex
        && turnKeys[latestOutputIndex] === turnKeys[latestUserIndex]
        && (latestUser.run.state === 'queued'
          || hasAcknowledgedReceipt(latestUser)
          || outputFollowsCompletedRun(timeline[latestOutputIndex]!, latestUser.run))) {
        activeTurns.add(turnKeys[latestOutputIndex]!);
      }
    } else if (latestUserIndex < 0 && latestOutputIndex >= 0) {
      // A paged native/subagent tail can omit its prompt entirely. The live flag still belongs
      // to its latest visible turn; missing history must not turn Working into Processed.
      activeTurns.add(turnKeys[latestOutputIndex]!);
    }
  }
  return { turnKeys, activeTurns, lastIndexByTurn };
}

export interface ActiveTurnState {
  /** Whether the currently running turn already has a non-activity row in `timeline`. */
  inTimeline: boolean;
  /** Epoch ms when the running turn started, or undefined when no honest start is known. */
  startedAt: number | undefined;
}

/**
 * Resolves the running turn's presence and start time from the same `analyzeTimelineTurns` result
 * that decides `TurnProcess` and `heldFooter`:
 * - When an active turn already has non-activity rows in `timeline`, its start is its first
 *   non-activity row (so steering mid-turn keeps counting from the opening prompt, and an orphan
 *   turn still requires an explicit prompt or wake-up notice).
 * - When every visible turn is already settled (for instance, a background task woke a new turn
 *   whose first row has not landed yet), never borrow a settled turn's start time; use
 *   `activeSince` only when it is not earlier than the last settled turn's end.
 */
export function activeTurnState(
  timeline: readonly TimelineItem[],
  analysis: TimelineTurnAnalysis,
  activeSince?: string,
): ActiveTurnState {
  let activeTurnKey: string | undefined;
  let activeEnd = -1;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index]!;
    if (item.kind === 'activity' || isUnreceivedSteer(item)) continue;
    const key = analysis.turnKeys[index]!;
    if (analysis.activeTurns.has(key)) {
      activeTurnKey = key;
      activeEnd = index;
      break;
    }
  }
  if (activeTurnKey !== undefined) {
    let start: TimelineItem | undefined;
    for (let index = activeEnd; index >= 0; index -= 1) {
      const item = timeline[index]!;
      if (item.kind === 'activity' || isUnreceivedSteer(item)) continue;
      if (analysis.turnKeys[index] !== activeTurnKey) {
        if (activeTurnKey === 'turn:orphan') break;
        continue;
      }
      start = item;
    }
    if (!start || (activeTurnKey === 'turn:orphan' && start.kind !== 'user' && start.kind !== 'task_notification')) {
      return { inTimeline: true, startedAt: undefined };
    }
    const at = Date.parse(start.event.createdAt);
    return { inTimeline: true, startedAt: Number.isFinite(at) ? at : undefined };
  }
  const since = activeSince ? Date.parse(activeSince) : NaN;
  if (!Number.isFinite(since)) return { inTimeline: false, startedAt: undefined };
  let lastIndex = -1;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index]!.kind !== 'activity') { lastIndex = index; break; }
  }
  if (lastIndex >= 0) {
    const lastSettled = timeline[lastIndex]!;
    const lastTurnKey = analysis.turnKeys[lastIndex]!;
    let settledAt = Date.parse(timelineItemTime(lastSettled));
    for (let index = lastIndex; index >= 0; index -= 1) {
      if (analysis.turnKeys[index] !== lastTurnKey) continue;
      const item = timeline[index]!;
      if (item.kind !== 'user' || !item.run) continue;
      const completed = item.run.native?.timings?.completedAt;
      const runEnd = typeof completed === 'number' && Number.isFinite(completed)
        ? completed
        : Date.parse(item.run.updatedAt);
      if (Number.isFinite(runEnd) && (!Number.isFinite(settledAt) || runEnd > settledAt)) settledAt = runEnd;
    }
    if (Number.isFinite(settledAt) && since < settledAt) return { inTimeline: false, startedAt: undefined };
  }
  return { inTimeline: false, startedAt: since };
}
