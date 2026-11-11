import type { RunMetrics } from '@contracts';
import { nativeEventIds, type TimelineItem } from './model';
import { withoutLinkedActivities } from '../../../../../packages/timeline/src/model';
import { analyzeTimelineTurns, runIdFromTurnKey } from './timelineTurns';
import { laneTurnOf } from '@/sync/rows';

type TaskNotice = Extract<TimelineItem, { kind: 'task_notification' }>;
/** Key prefix of a lane turn's first process block. */
const TURN_BLOCK = 'turn-process:';

// Single-line rows pack tightly; tool runs sit closer to the prose around them than two prose
// blocks do. Folded raw thinking is a one-liner and packs with the tool rows around it. This is
// also the sole source of spacing inside a turn (the container no longer adds its own gap on top
// of these margins).
const processKinds = new Set<TimelineItem['kind']>(['thought', 'tool', 'plan', 'image', 'status']);

function backgroundTask(item: TimelineItem): boolean {
  return item.kind === 'activity' && item.activity.kind === 'background_task';
}

function processActivity(item: TimelineItem): boolean {
  return item.kind === 'activity' && (item.activity.kind === 'background_task' || item.activity.kind === 'compaction');
}

function compact(item: TimelineItem | undefined): boolean {
  return item?.kind === 'tool' || item?.kind === 'activity' || (item?.kind === 'thought' && item.channel === 'thinking');
}

/**
 * The row gap, as semantic classes rather than Tailwind margins, so that 会话间距 (the density
 * preference) can scale all of them from one place. `timeline-gap-tight` is zero on touch, which is
 * why that rule lives in CSS rather than in the hover variant it used to carry.
 */
function gap(previous: TimelineItem | undefined, item: TimelineItem): string {
  if (!previous) return '';
  if (item.kind === 'user') return 'timeline-gap-turn';
  if (previous.kind === 'user') return 'timeline-gap-answer';
  if (compact(item) && compact(previous)) return 'timeline-gap-tight';
  if (item.kind === 'tool' || previous.kind === 'tool') return 'timeline-gap-tool';
  return 'timeline-gap-block';
}

/**
 * One rendered row of the transcript, as data: everything it shows is decided here, so a row whose
 * fields compare equal renders the same and keeps its object from one frame to the next.
 */
export type TranscriptRow =
  /**
   * A message. `settled` and `metrics` only apply to an answer: its footer and its speed. `runId`
   * is the settled answer's own turn, when that turn is one Riffet sent and can fork or rewind.
   */
  | { type: 'item'; key: string; item: TimelineItem; gap: string; settled: boolean; footer: TurnFooter; metrics: RunMetrics | undefined; runId: string | undefined }
  /** Reasoning and structured work folded into one disclosure; `interrupted` also preserves output before steering. */
  | { type: 'process'; key: string; items: TimelineItem[]; gaps: string[]; spaced: boolean; running: boolean; settled: boolean; footer: TurnFooter; endsTurn: boolean; followedByAnswer: boolean; interrupted: boolean; answerText: string | undefined; runId: string | undefined }
  /** The notices that woke a turn. */
  | { type: 'trigger'; key: string; notices: TaskNotice[]; gap: string };

/**
 * A turn's footer (its time and actions) and the row that carries it, as the turn goes from running
 * to settled. The row that would carry it holds its place while the turn runs (`held`) and fills it
 * when the turn settles (`shown`), so settling never changes the transcript's height; every other
 * row has none. A row stops holding only because a later row took over the turn's end, which is
 * the transcript growing anyway.
 */
export type TurnFooter = 'none' | 'held' | 'shown';

/**
 * The row holding the running turn's footer, where the working line goes. An inline activity after
 * it (such as compaction) leaves the working line at the end until more output takes over. Background
 * tasks are independent of foreground progress and leave its footer in place.
 */
export function heldFooterRow(rows: readonly TranscriptRow[]): string | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.type !== 'trigger' && row.footer === 'held') return row.key;
    if (row.type === 'item' && row.item.kind === 'activity' && !backgroundTask(row.item)) return undefined;
  }
  return undefined;
}

/** The rows from one prompt (or one batch of notices) up to the next, keyed by the first row. */
export interface TranscriptTurn { key: string; rows: TranscriptRow[] }

/**
 * What a planned result remembers about how it was built, so the next plan can resume instead of
 * starting over. Kept beside the result, not in it, because the turn objects stay plain data.
 */
interface Plan {
  timeline: readonly TimelineItem[];
  turnKeys: readonly string[];
  /** Per turn: the timeline index of its first item, and the `lastTurnKey` the scan held just before it. */
  starts: number[];
  keyBefore: string[];
  /** Per turn: the distinct session turn keys its items belong to, and the derived state they were built with. */
  keys: string[][];
  contexts: unknown[][];
}
const plans = new WeakMap<readonly TranscriptTurn[], Plan>();

function sameRow(left: TranscriptRow | undefined, right: TranscriptRow): left is TranscriptRow {
  if (!left || left.type !== right.type || left.key !== right.key) return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  for (const name in b) {
    const x = a[name];
    const y = b[name];
    if (x === y) continue;
    if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length || x.some((value, index) => value !== y[index])) return false;
  }
  return true;
}

/**
 * Plans the transcript's rows and groups them into turns, handing back the previous call's row and
 * turn objects wherever nothing changed. A streamed frame therefore changes only the open turn's
 * object, which is what lets the memoized turn components skip every other one.
 *
 * It also rebuilds only from where the timeline changed. Timeline items are reused by identity from
 * one frame to the next, so the first index whose item or turn key differs marks where the work
 * starts; turns before the turn that holds it are kept as they were, provided the state derived for
 * them (running, settled, metrics…) is unchanged. The cheap whole-timeline scans stay, since those
 * derivations can reach back from later items; it is the per-row planning that no longer repeats.
 *
 * Fold reasoning, intermediate progress prose and structured work into one disclosure per turn.
 * An explicit final answer stays outside the disclosure even if later work follows it. Older
 * transports without a phase retain the positional rule within each user-input segment.
 */
export function transcriptTurns(timeline: TimelineItem[], running: boolean, metricsByRun: Map<string, RunMetrics> | undefined, previous?: readonly TranscriptTurn[], activeTurnId?: string): TranscriptTurn[] {
  timeline = withoutLinkedActivities(timeline);
  const { turnKeys, activeTurns, lastIndexByTurn } = analyzeTimelineTurns(timeline, running, activeTurnId);
  const finalAnswerIndexByTurn = new Map<string, number>();
  const interruptedTurns = new Set<string>();
  const lastSteerIndexByTurn = new Map<string, number>();
  const nativeMetricsByTurn = new Map<string, RunMetrics>();
  // A steer joins its owner's turn, so only the prompt that opened the turn names it.
  const sentRunByTurn = new Map<string, string>();
  for (let index = 0; index < timeline.length; index += 1) {
    const item = timeline[index]!;
    if (item.kind === 'assistant' && item.phase === 'final_answer') finalAnswerIndexByTurn.set(turnKeys[index]!, index);
    if (metricsByRun?.size && (item.kind === 'user' || item.kind === 'task_notification')) {
      const source = [item.event, ...item.event.sourceEvents];
      const metrics = source.flatMap(nativeEventIds).map(id => metricsByRun?.get(`native:${id}`)).find(Boolean);
      if (metrics) nativeMetricsByTurn.set(turnKeys[index]!, metrics);
    }
    if (item.kind === 'user' && item.run?.native && item.run.native.intent !== 'steer') sentRunByTurn.set(turnKeys[index]!, item.run.id);
    if (item.kind === 'user' && item.run?.native?.intent === 'steer') lastSteerIndexByTurn.set(turnKeys[index]!, index);
    if (item.kind === 'user' && item.run?.native?.intent !== 'steer' && (item.run?.state === 'interrupted'
      || (item.run?.state === 'cancelled' && item.run.native?.stage !== 'acknowledged'))) interruptedTurns.add(turnKeys[index]!);
  }
  // Steering shares a turn with the previous input. Later work must not collect prose that was
  // already displayed before the steering message into a newly folded process.
  const assistantBeforeProcess = new Array<boolean>(timeline.length).fill(false);
  const laterProcessTurns = new Set<string>();
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index]!;
    if (item.kind === 'user') laterProcessTurns.clear();
    else if (processKinds.has(item.kind) || (item.kind === 'assistant' && item.phase === 'commentary')) laterProcessTurns.add(turnKeys[index]!);
    else if (item.kind === 'assistant') assistantBeforeProcess[index] = laterProcessTurns.has(turnKeys[index]!);
  }
  const isProcessItem = (item: TimelineItem, index: number): boolean => {
    if (processKinds.has(item.kind)) return true;
    if (item.kind !== 'assistant') return false;
    if (item.phase) return item.phase === 'commentary';
    return assistantBeforeProcess[index]!;
  };
  // Compaction and background tasks stay with the work around them without creating a second
  // process block. Neither is evidence of more model output: an activity after an answer must
  // leave that answer outside the disclosure.
  const processItems = timeline.map((item, index) => isProcessItem(item, index));
  for (let index = timeline.length - 2; index >= 0; index -= 1) {
    if (processActivity(timeline[index]!) && turnKeys[index] === turnKeys[index + 1] && processItems[index + 1]) processItems[index] = true;
  }
  const metricsForTurn = (turnKey: string | undefined) => {
    if (!turnKey || !metricsByRun?.size) return undefined;
    const runId = runIdFromTurnKey(turnKey);
    return (runId ? metricsByRun.get(runId) : undefined) ?? nativeMetricsByTurn.get(turnKey);
  };
  // Only the attributed active turn is streaming; unrelated session activity must not
  // reopen an answer whose last output predates its persisted completion.
  const latestOutputIndex = timeline.findLastIndex((item) => item.kind !== 'user' && item.kind !== 'activity');
  const latestOutputTurn = turnKeys[latestOutputIndex];
  const processingTurn = running && latestOutputTurn && activeTurns.has(latestOutputTurn) ? latestOutputTurn : undefined;
  const lastTurnEnd = (index: number) => lastIndexByTurn.get(turnKeys[index]!) === index;
  /** Everything a turn key's rows are derived from beyond the items themselves. */
  const contextOf = (key: string): unknown[] => [
    activeTurns.has(key), key === processingTurn, lastIndexByTurn.get(key),
    finalAnswerIndexByTurn.get(key), interruptedTurns.has(key), lastSteerIndexByTurn.get(key), sentRunByTurn.get(key), metricsForTurn(key),
  ];

  // Where to resume: the turn holding the item before the first one that differs. The item before,
  // not the item itself, because a changed first item may now join the turn ahead of it.
  const prior = previous ? plans.get(previous) : undefined;
  let resume = 0;
  if (previous && prior) {
    let dirty = 0;
    const limit = Math.min(timeline.length, prior.timeline.length);
    while (dirty < limit && timeline[dirty] === prior.timeline[dirty] && turnKeys[dirty] === prior.turnKeys[dirty]) dirty += 1;
    const at = Math.max(dirty - 1, 0);
    let low = 0;
    let high = prior.starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (prior.starts[middle]! <= at) low = middle;
      else high = middle - 1;
    }
    resume = Math.min(low, previous.length - 1);
    for (let turn = 0; turn < resume; turn += 1) {
      const held = prior.contexts[turn]!;
      const now = prior.keys[turn]!.flatMap(contextOf);
      if (now.length !== held.length || now.some((value, index) => value !== held[index])) { resume = turn; break; }
    }
    if (resume < 0) resume = 0;
  }
  const startIndex = resume > 0 ? prior!.starts[resume]! : 0;

  const grouped: TranscriptRow[][] = [];
  // Lane turns whose first block is already placed, the kept turns' included, so no key repeats.
  const turnBlocks = new Set<string>();
  if (previous && resume > 0) {
    for (const turn of previous.slice(0, resume)) for (const row of turn.rows) if (row.type === 'process' && row.key.startsWith(TURN_BLOCK)) turnBlocks.add(row.key.slice(TURN_BLOCK.length));
  }
  const starts: number[] = [];
  const keyBefore: string[] = [];
  let rows: TranscriptRow[] = [];
  let previousItem: TimelineItem | undefined = startIndex > 0 ? timeline[startIndex - 1] : undefined;
  // A turn starts at a prompt, or at the first of a batch of notices the CLI woke a turn with.
  // Callers pass the first item's turn key along with it, rather than this looking it up in a map
  // of the whole timeline rebuilt on every streamed frame.
  let rowTurnKey: string | undefined;
  const add = (row: TranscriptRow, first: TimelineItem, firstTurn: string | undefined, last: TimelineItem, at: number, before: string) => {
    // Native continuation can start a turn without a prompt; the server's identity is the boundary.
    if (rows.length && firstTurn !== rowTurnKey) {
      grouped.push(rows);
      rows = [];
    }
    if (!rows.length) { starts.push(at); keyBefore.push(before); }
    rows.push(row);
    rowTurnKey = firstTurn;
    previousItem = last;
  };

  let group: TimelineItem[] = [];
  let groupTurnKey: string | undefined;
  let groupLastIndex = -1;
  let groupStart = 0;
  let groupKeyBefore = '';
  const flushGroup = () => {
    if (!group.length) return;
    const items = group;
    group = [];
    const turnKey = groupTurnKey;
    groupTurnKey = undefined;
    const groupRunning = Boolean(turnKey && activeTurns.has(turnKey));
    const groupEndsTurn = Boolean(turnKey && lastIndexByTurn.get(turnKey) === groupLastIndex);
    // The final prose is outside this process's items. Its arrival closes the trailing tool run
    // just like narration inside the process, even before the turn's completion arrives.
    const answerIndex = turnKey ? finalAnswerIndexByTurn.get(turnKey) ?? lastIndexByTurn.get(turnKey) : undefined;
    const followedByAnswer = answerIndex !== undefined && answerIndex > groupLastIndex
      && timeline[answerIndex]?.kind === 'assistant' && !processItems[answerIndex];
    // The block carries the footer only when the turn ends on it without an answer.
    const carries = groupEndsTurn && !finalAnswerIndexByTurn.has(turnKey!);
    const settled = carries && !groupRunning && turnKey !== processingTurn;
    // A turn that stopped on a tool, as an interrupted one does, has no answer row to carry the
    // copy action, so its footer copies the turn's latest prose — what that row would have copied.
    let answerText: string | undefined;
    for (let index = groupLastIndex; settled && index >= 0 && turnKeys[index] === turnKey; index -= 1) {
      const candidate = timeline[index]!;
      if (candidate.kind === 'assistant') { answerText = candidate.text; break; }
    }
    const first = items[0]!;
    // The first block of a lane turn is keyed by the turn rather than by its first item: older rows of
    // the same turn paging in above would otherwise remount the whole block, open tools and all.
    const laneTurn = laneTurnOf(first);
    const key = laneTurn !== undefined && !turnBlocks.has(laneTurn) ? `${TURN_BLOCK}${laneTurn}` : `process:${first.key}`;
    if (laneTurn !== undefined) turnBlocks.add(laneTurn);
    add({
      type: 'process', key, items, gaps: items.map((item, index) => gap(items[index - 1], item)),
      spaced: Boolean(previousItem), running: groupRunning, settled, footer: !carries ? 'none' : settled ? 'shown' : 'held', endsTurn: groupEndsTurn, followedByAnswer,
      interrupted: Boolean(turnKey && (interruptedTurns.has(turnKey) || groupLastIndex < (lastSteerIndexByTurn.get(turnKey) ?? -1))),
      answerText, runId: settled && turnKey ? sentRunByTurn.get(turnKey) : undefined,
    }, first, turnKey, items[items.length - 1]!, groupStart, groupKeyBefore);
  };

  let lastTurnKey = startIndex > 0 ? prior!.keyBefore[resume]! : '';
  for (let index = startIndex; index < timeline.length; index += 1) {
    const item = timeline[index]!;
    const turnKey = turnKeys[index]!;
    const before = lastTurnKey;
    const rowStart = index;
    // A turn the CLI woke with "task finished" notices (it injects them as user messages) gets one
    // trigger row naming the source, the way DeepSeek Harness presents a non-human turn trigger,
    // instead of reading as if the user had sent those notices.
    if (item.kind === 'task_notification' && turnKey !== lastTurnKey) {
      // The CLI gives each injected notice its own turn id, so the batch is recognised by being
      // consecutive rather than by sharing a turn: they woke the same reply.
      const notices: TaskNotice[] = [];
      while (index < timeline.length && timeline[index]!.kind === 'task_notification') {
        notices.push(timeline[index] as TaskNotice);
        index += 1;
      }
      index -= 1;
      flushGroup();
      add({ type: 'trigger', key: `trigger:${notices[0]!.key}`, notices, gap: gap(previousItem, notices[0]!) }, notices[0]!, turnKey, notices.at(-1)!, rowStart, before);
      lastTurnKey = turnKey;
      continue;
    }
    // Compaction and task updates remain in the same disclosure as the surrounding work.
    // They do not move its last output index or make a settled process start running again.
    const inProcess = processItems[index] || (processActivity(item) && group.length > 0 && groupTurnKey === turnKey);
    if (inProcess && group.length && groupTurnKey !== turnKey) flushGroup();
    if (inProcess) {
      if (!group.length) { groupTurnKey = turnKey; groupStart = index; groupKeyBefore = before; }
      group.push(item);
      if (item.kind !== 'activity') groupLastIndex = index;
      lastTurnKey = turnKey;
      continue;
    }
    flushGroup();
    lastTurnKey = turnKey;
    const finalAnswer = finalAnswerIndexByTurn.get(turnKey);
    // The turn's answer, or what would be it if the turn ended now.
    const carries = item.kind === 'assistant' && (finalAnswer === undefined ? lastTurnEnd(index) : finalAnswer === index);
    const settled = carries && !activeTurns.has(turnKey) && turnKey !== processingTurn;
    add({ type: 'item', key: item.key, item, gap: gap(previousItem, item), settled, footer: !carries ? 'none' : settled ? 'shown' : 'held', metrics: settled ? metricsForTurn(turnKey) : undefined, runId: settled ? sentRunByTurn.get(turnKey) : undefined }, item, turnKey, item, rowStart, before);
  }
  flushGroup();
  if (rows.length) grouped.push(rows);

  // Rebuilt turns still hand back an earlier object wherever their rows came out the same.
  const previousByKey = new Map(previous?.slice(resume).map((turn) => [turn.key, turn]));
  const result: TranscriptTurn[] = previous && resume > 0 ? previous.slice(0, resume) : [];
  for (const next of grouped) {
    const key = next[0]!.key;
    const old = previousByKey.get(key);
    let same = old?.rows.length === next.length;
    for (let index = 0; index < next.length; index += 1) {
      const oldRow = old?.rows[index];
      if (sameRow(oldRow, next[index]!)) next[index] = oldRow;
      else same = false;
    }
    result.push(same && old ? old : { key, rows: next });
  }

  const nextPlan: Plan = {
    timeline, turnKeys,
    starts: prior && resume > 0 ? [...prior.starts.slice(0, resume), ...starts] : starts,
    keyBefore: prior && resume > 0 ? [...prior.keyBefore.slice(0, resume), ...keyBefore] : keyBefore,
    keys: prior && resume > 0 ? prior.keys.slice(0, resume) : [],
    contexts: prior && resume > 0 ? prior.contexts.slice(0, resume) : [],
  };
  for (let turn = nextPlan.keys.length; turn < nextPlan.starts.length; turn += 1) {
    const end = nextPlan.starts[turn + 1] ?? timeline.length;
    const keys = new Set<string>();
    for (let index = nextPlan.starts[turn]!; index < end; index += 1) keys.add(turnKeys[index]!);
    const list = [...keys];
    nextPlan.keys.push(list);
    nextPlan.contexts.push(list.flatMap(contextOf));
  }
  // Nothing moved: hand back the very array, so anything keyed on it stays put too.
  const unchanged = previous && result.length === previous.length && result.every((turn, index) => turn === previous[index]);
  if (unchanged) {
    plans.set(previous, nextPlan);
    return previous as TranscriptTurn[];
  }
  plans.set(result, nextPlan);
  return result;
}
