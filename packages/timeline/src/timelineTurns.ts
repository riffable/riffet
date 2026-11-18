import type { NativeWorkbenchEvent, Run } from '../../contracts/src/index.js';
import { nativeSourceIds, timelineItemTime, type TimelineItem } from './model.js';

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
  return item.kind === 'user' && !hasAcknowledgedReceipt(item) && (item.run?.state === 'queued'
    || item.run?.state === 'cancelled'
    || item.run?.native?.delivery === 'queued'
    || item.run?.native?.delivery === 'preparing'
    || item.run?.native?.delivery === 'cancelled');
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
    // An activity sits in a turn without ending it: a compaction note after the answer must not make
    // the answer look like it is followed by more work.
    if (item.kind !== 'activity') lastIndexByTurn.set(turnKey, index);
    if (item.kind === 'user' && item.run?.state === 'running'
      && item.run.native?.delivery !== 'queued'
      && item.run.native?.delivery !== 'preparing'
      && item.run.native?.delivery !== 'cancelled') activeTurns.add(turnKey);
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
  const latestUserIndex = timeline.findLastIndex((item) => item.kind === 'user');
  const latestSentUserIndex = timeline.findLastIndex((item) => item.kind === 'user' && !isPendingUser(item));
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
    if (latestUser?.kind === 'user' && !latestUserIsPending) {
      if (!latestUser.run) {
        activeTurns.add(turnKeys[latestUserIndex]!);
      } else if (latestOutputIndex > latestUserIndex
        && turnKeys[latestOutputIndex] === turnKeys[latestUserIndex]
        && (hasAcknowledgedReceipt(latestUser)
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
