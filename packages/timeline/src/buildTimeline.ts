import { samePromptText, type NativeJob, type NativeWorkbenchEvent, type ReasoningChannel, type Run, type TaskNotificationResult, type TaskNotificationStatus, type UserAttachment, type WorkbenchEvent } from '../../contracts/src/index.js';
import { chunkText, messageAttachments, nativeSourceIds, timelineItemTime, type TimelineItem } from './model.js';
import { activityOf, messagePhase, type ProjectedEvent } from './projectEvents.js';
import { isRecord, records, str, taskReportDetail } from './values.js';
import { describeFailure } from './failures.js';

function imageSource(event: WorkbenchEvent): string | undefined {
  const content = event.data.content;
  if (!isRecord(content) || content.type !== 'image') return undefined;
  const data = str(content.data);
  const mimeType = str(content.mimeType);
  return data && mimeType?.startsWith('image/') ? `data:${mimeType};base64,${data}` : undefined;
}

function sameAttachments(left: UserAttachment[], right: UserAttachment[]): boolean {
  return left.length === right.length && left.every((attachment, index) => {
    const other = right[index]!;
    return attachment.name === other.name && attachment.id === other.id && attachment.path === other.path
      && attachment.type === other.type && attachment.mimeType === other.mimeType && attachment.size === other.size
      && attachment.width === other.width && attachment.height === other.height;
  });
}

function sameTimelineItem(left: TimelineItem | undefined, right: TimelineItem): left is TimelineItem {
  if (!left || left.kind !== right.kind || left.key !== right.key || left.event !== right.event) return false;
  if (left.kind === 'user' && right.kind === 'user') return left.text === right.text && left.run === right.run && sameAttachments(left.attachments, right.attachments);
  if (left.kind === 'assistant' && right.kind === 'assistant') return left.text === right.text && left.phase === right.phase;
  if (left.kind === 'thought' && right.kind === 'thought') return left.text === right.text && left.channel === right.channel;
  if (left.kind === 'tool' && right.kind === 'tool') return left.job === right.job;
  if (left.kind === 'plan' && right.kind === 'plan') return true;
  if (left.kind === 'image' && right.kind === 'image') return left.src === right.src;
  if (left.kind === 'status' && right.kind === 'status') return left.text === right.text && left.detail === right.detail && left.tone === right.tone;
  if (left.kind === 'activity' && right.kind === 'activity') return left.event === right.event;
  if (left.kind === 'task_notification' && right.kind === 'task_notification') return left.status === right.status && left.title === right.title && left.command === right.command && left.detail === right.detail;
  return false;
}

/**
 * Find the app run a CLI receipt belongs to when the two cannot be joined by message id.
 *
 * A submission whose outcome was never confirmed keeps no `nativeMessageId`, so the receipt the CLI
 * did write can only be recognised by its prompt. Without this join the same message is projected
 * twice — once from the CLI store and once from the local run — and the delivery recovery controls
 * ("已核对，解除等待") end up stranded on the duplicate.
 *
 * Prompts are matched with `samePromptText` (see `@contracts`), because the CLI's stored copy can
 * differ from what was sent by a few mangled characters. Only a run the CLI could already have
 * recorded qualifies — a queued or preparing run has not been delivered — and only the latest
 * dispatch that precedes the receipt, so a repeated prompt consumes one run each.
 */
function unconfirmedNativeRun({ runs, nativeChatId }: TimelineContext, stored: string, event: ProjectedEvent, echoed: Set<string>): Run | undefined {
  const receiptAt = Date.parse(event.createdAt);
  const samePrompt = (sent: string) => samePromptText(sent, stored);
  let receiptUploadIds: string[] | undefined;
  let match: Run | undefined;
  let matchAt = Number.NEGATIVE_INFINITY;
  for (const run of runs) {
    const native = run.native;
    if (!native || native.intent === 'steer' || native.nativeMessageId || echoed.has(run.id)) continue;
    const chat = runChatId(native);
    if (nativeChatId && chat && chat !== nativeChatId) continue;
    if (native.delivery === 'queued' || native.delivery === 'preparing') continue;
    if (!samePrompt(native.renderedText ?? run.prompt)) continue;
    const dispatchedAt = native.timings?.dispatchAt ?? Date.parse(run.createdAt);
    if (!Number.isFinite(dispatchedAt)) continue;
    // The stored receipt's stamp is coarse — observed up to a minute *before* the dispatch it
    // belongs to — so the window is generous on both sides while still refusing an old submission.
    if (Number.isFinite(receiptAt) && (receiptAt < dispatchedAt - 120_000 || receiptAt > dispatchedAt + 600_000)) continue;
    // CLI paths, labels and data URLs cannot identify an upload. A Riffet upload id on the receipt can rule out a same-text send.
    receiptUploadIds ??= messageAttachments(event).flatMap(({ id }) => id && /^[a-f0-9-]{36}$/i.test(id) ? [id] : []);
    if (receiptUploadIds.some(id => !native.input.attachmentIds.includes(id))) continue;
    if (dispatchedAt > matchAt) { matchAt = dispatchedAt; match = run; }
  }
  return match;
}

/**
 * The chat a run was dispatched into. `cursorSessionId` is the deprecated Cursor-only mirror and is
 * never written for Claude, Codex or any other backend, so comparing against it alone leaves every
 * non-Cursor run unpaired — its receipt and its own record then render as two copies of the turn.
 */
function runChatId(native: NonNullable<Run['native']>): string | undefined {
  return native.nativeSessionId ?? native.cursorSessionId;
}

/**
 * The row key of a user turn, keyed by `commandId` rather than `run.id`.
 *
 * The two sides disagree about the id of the same submission: the client's optimistic run uses the
 * command id as its own id, and the server replaces it with a UUID when the submission is accepted.
 * Keying the row by `run.id` therefore changes the key the moment the CLI picks the message up, and
 * a key change remounts the bubble — replaying its entrance animation under the reader — which is
 * the flash a sent message shows when processing starts. The command id is the one identity both
 * sides keep for the whole submission.
 */
function userRowKey(run: Run, fallback: string): string {
  return `user:${run.commandId || run.id}`;
}

/** What a timeline build derives from the runs before it reads a single event. */
interface TimelineContext {
  runs: Run[];
  jobs: Map<string, NativeJob> | undefined;
  nativeChatId: string | undefined;
  runById: Map<string, Run>;
  nativeRunByMessageId: Map<string, Run>;
  fileReferenceRuns: Map<string, Run>;
}

function timelineContext(runs: Run[], jobs: Map<string, NativeJob> | undefined, nativeChatId: string | undefined): TimelineContext {
  const fileReferenceRuns = new Map<string, Run>();
  for (const run of runs) {
    if (!run.prompt || run.native) continue;
    if (!fileReferenceRuns.has(run.prompt)) fileReferenceRuns.set(run.prompt, run);
  }
  return {
    runs, jobs, nativeChatId, fileReferenceRuns,
    runById: new Map(runs.map((run) => [run.id, run])),
    nativeRunByMessageId: new Map(runs.flatMap((run) => run.native?.nativeMessageId
      && (!nativeChatId || runChatId(run.native) === nativeChatId) ? [[run.native.nativeMessageId, run] as const] : [])),
  };
}

/**
 * The run ids and prompts the events have consumed so far. Every insertion is logged with the index
 * of the event that made it, so a build can rewind to any event. The compaction receipt is decided
 * after every event row and logged as `afterEvents`, so any rewind drops it and placement decides again.
 */
interface TimelinePass {
  seenRunIds: Set<string>;
  echoedRuns: Set<string>;
  echoedPrompts: Set<string>;
  turnFailures: Set<string>;
  log: Array<readonly [index: number, set: Set<string>, value: string]>;
}

const timelinePass = (): TimelinePass => ({ seenRunIds: new Set(), echoedRuns: new Set(), echoedPrompts: new Set(), turnFailures: new Set(), log: [] });

/**
 * What rows built before the first of `events` have already consumed, for a build that folds only the
 * tail of a transcript (the server's open turn, see `apps/server/src/timeline`). Seeded values are not
 * logged, so no rewind gives them back.
 */
export interface TimelineSeed { seenRunIds?: Iterable<string>; echoedRuns?: Iterable<string>; echoedPrompts?: Iterable<string> }

function seededPass(seed: TimelineSeed | undefined): TimelinePass {
  const pass = timelinePass();
  for (const id of seed?.seenRunIds ?? []) pass.seenRunIds.add(id);
  for (const id of seed?.echoedRuns ?? []) pass.echoedRuns.add(id);
  for (const prompt of seed?.echoedPrompts ?? []) pass.echoedPrompts.add(prompt);
  return pass;
}

const afterEvents = Number.MAX_SAFE_INTEGER;

function claim(pass: TimelinePass, set: Set<string>, value: string, index: number): void {
  if (set.has(value)) return;
  set.add(value);
  pass.log.push([index, set, value]);
}

/** The row a previous build made under a key, offered for reuse when nothing about it changed. */
type PreviousRow = (key: string) => TimelineItem | undefined;

/** A run row's event is made up on every build, so it is matched by the run it stands for instead. */
function sameRunRow(left: TimelineItem | undefined, right: Extract<TimelineItem, { kind: 'user' }>): left is TimelineItem {
  return left?.kind === 'user' && left.key === right.key && left.run === right.run && left.text === right.text
    && sameAttachments(left.attachments, right.attachments)
    && left.event.projectionKey === right.event.projectionKey && left.event.sequence === right.event.sequence
    && left.event.runId === right.event.runId
    && (left.event as Partial<NativeWorkbenchEvent>).nativeId === (right.event as Partial<NativeWorkbenchEvent>).nativeId;
}

const conversationTypes = new Set(['native_input_receipt', 'user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan', 'task_notification']);

/** Codex and TRAE CLI id a receipt `<chat>:<turn>:user` and the turn's output under the same `<chat>:<turn>:`. */
function receiptTurnPrefix(run: Run): string | undefined {
  const native = run.native;
  if (!native || native.delivery === 'queued' || native.delivery === 'preparing') return undefined;
  const chat = runChatId(native);
  const id = native.nativeMessageId;
  if (!chat || !id?.startsWith(`${chat}:`) || !id.endsWith(':user')) return undefined;
  const turn = id.slice(chat.length + 1).split(':', 1)[0];
  return turn ? `${chat}:${turn}:` : undefined;
}

/** The output row a run's receipt belongs right before, if identity alone can say. */
type ReceiptLocator = (run: Run) => TimelineItem | undefined;

/**
 * Finds the output of a run whose receipt is not in the window, without comparing prompt text or
 * timestamps. A paged window can hold several turns' output and none of their prompts; filing each
 * prompt before its own output keeps an earlier answer from being read as the reply to a later one.
 *
 * Output stamped with the run's own id wins, because one turn can hold several steer submissions.
 * Otherwise the turn's id prefix decides, unless two runs claim the same turn. Rows are indexed on
 * first use, by object: rows filed later are all user rows, which only shift positions.
 */
/** A turn's own output, which a prompt is placed before; status and activity rows are reports about a turn, not its output. */
const isTurnOutput = (row: TimelineItem) => row.kind !== 'user' && row.kind !== 'status' && row.kind !== 'activity';

function receiptLocator(rows: TimelineItem[], runs: Run[], nativeChatId: string | undefined): ReceiptLocator {
  let byRun: Map<string, TimelineItem> | undefined;
  let claims: Map<string, number> | undefined;
  let chats: Set<string> | undefined;
  let byPrefix: Map<string, TimelineItem> | undefined;
  return (run) => {
    const native = run.native;
    if (!native || native.delivery === 'queued' || native.delivery === 'preparing') return undefined;
    if (!native.nativeMessageId?.trim() && native.delivery !== 'observed') return undefined;
    const chat = runChatId(native);
    if (nativeChatId && chat && chat !== nativeChatId) return undefined;
    if (!byRun) {
      byRun = new Map();
      for (const row of rows) if (isTurnOutput(row) && row.event.runId && !byRun.has(row.event.runId)) byRun.set(row.event.runId, row);
    }
    const own = byRun.get(run.id);
    if (own) return own;
    const prefix = receiptTurnPrefix(run);
    if (!prefix) return undefined;
    if (!claims || !chats) {
      claims = new Map();
      chats = new Set();
      for (const other of runs) {
        const claimed = receiptTurnPrefix(other);
        if (!claimed) continue;
        claims.set(claimed, (claims.get(claimed) ?? 0) + 1);
        chats.add(runChatId(other.native!)!);
      }
    }
    if (claims.get(prefix)! > 1) return undefined;
    if (!byPrefix) {
      byPrefix = new Map();
      for (const row of rows) {
        if (!isTurnOutput(row)) continue;
        for (const id of nativeSourceIds(row.event)) {
          for (const owner of chats) {
            const end = id.startsWith(`${owner}:`) ? id.indexOf(':', owner.length + 1) : -1;
            if (end > 0 && !byPrefix.has(id.slice(0, end + 1))) byPrefix.set(id.slice(0, end + 1), row);
          }
        }
      }
    }
    return byPrefix.get(prefix);
  };
}

/**
 * CLI compaction can replace the user turn with injected context while retaining its
 * assistant/tool tail. Restore only the current chat's latest receipted turn before that
 * orphan tail; unconfirmed and queued prompts still belong after the transcript. A paged
 * window can omit every prompt as well: when any receipt can find its own output, those exact
 * identities place the prompts and this heuristic stays out.
 */
function compactedTurn(events: ProjectedEvent[], context: TimelineContext, pass: TimelinePass, previous: PreviousRow, locate: ReceiptLocator): TimelineItem | undefined {
  const { runs, nativeChatId } = context;
  const firstConversationEvent = events.find((event) => conversationTypes.has(event.type));
  const compactedRun = nativeChatId && firstConversationEvent && !firstConversationEvent.runId
    && !events.some((event) => event.type === 'user_message_chunk')
    && !runs.some((run) => locate(run))
    ? runs.findLast((run) => run.native?.intent !== 'steer' && ['running', 'completed'].includes(run.state) && run.native?.delivery === 'observed'
      && run.native.nativeMessageId && runChatId(run.native) === nativeChatId)
    : undefined;
  if (!compactedRun || !firstConversationEvent) return undefined;
  const event = {
    sequence: Math.max(0, firstConversationEvent.sequence - 1), sessionId: compactedRun.sessionId,
    runId: compactedRun.id, type: 'user_message_chunk', data: {}, createdAt: compactedRun.createdAt,
    projectionKey: `receipt:${compactedRun.id}`, sourceEvents: [],
  } satisfies ProjectedEvent;
  const attachments = compactedRun.native!.input.attachmentIds.map((id) => ({ id, name: id }));
  const item = { kind: 'user', key: userRowKey(compactedRun, `user:${compactedRun.id}`), text: compactedRun.prompt, event, attachments, run: compactedRun } satisfies TimelineItem;
  const prior = previous(item.key);
  claim(pass, pass.echoedRuns, compactedRun.id, afterEvents);
  claim(pass, pass.seenRunIds, compactedRun.id, afterEvents);
  return sameRunRow(prior, item) ? prior : item;
}

/** The row one projected event contributes, if any. `index` is its position, for the pass log. */
function eventRow(event: ProjectedEvent, index: number, context: TimelineContext, pass: TimelinePass, previous: PreviousRow): TimelineItem | undefined {
  const { runs, jobs, runById, nativeRunByMessageId, fileReferenceRuns } = context;
  const reuse = (item: TimelineItem): TimelineItem => {
    const prior = previous(item.key);
    return sameTimelineItem(prior, item) ? prior : item;
  };
  const key = event.projectionKey;
  const image = imageSource(event);
  if (image) return reuse({ kind: 'image', key, src: image, event });
  switch (event.type) {
    case 'native_input_receipt':
    case 'user_message_chunk': {
      const text = chunkText(event);
      const marker = text.indexOf('File reference:');
      const sourceIds = nativeSourceIds(event);
      const nativeRun = sourceIds.map((id) => nativeRunByMessageId.get(id)).find((run): run is Run => Boolean(run));
      // Native records carry a CLI message id when the submission was confirmed. Never pair a
      // *confirmed* record to an app run by text or reused runId: repeated prompts are valid and
      // must retain distinct identity. An unconfirmed submission has no id to pair on, so the
      // receipt falls back to `unconfirmedNativeRun` above, which keeps it a single message.
      const commandRun = runs.find(run => run.native && run.commandId === event.data.commandId
        && (run.native.intent !== 'steer' || run.native.nativeTurnId === (event as Partial<NativeWorkbenchEvent>).nativeTurnId));
      const run = event.type === 'native_input_receipt' ? commandRun ?? nativeRun : nativeRun ?? commandRun ?? (sourceIds.length ? undefined : event.runId ? runById.get(event.runId) : marker >= 0
        ? fileReferenceRuns.get(text.slice(0, marker).trimEnd())
        : undefined) ?? unconfirmedNativeRun(context, marker >= 0 ? text.slice(0, marker).trimEnd() : text, event, pass.echoedRuns);
      // A queue receipt names a command, not an execution. Its source run id cannot claim a
      // different submission when its command identity did not resolve.
      const runKey = run?.id ?? (event.type !== 'native_input_receipt' ? event.runId : undefined);
      // The first row of a run owns that run's stable key; a later row of the same run is a
      // distinct stored record and keeps its own projection key.
      const turnKey = runKey && !pass.seenRunIds.has(runKey) ? (run ? userRowKey(run, key) : `user:${runKey}`) : key;
      if (runKey) claim(pass, pass.seenRunIds, runKey, index);
      const itemText = run?.prompt ?? text;
      const attachments = messageAttachments(event, run?.native?.input.attachmentIds);
      if (!text.trim() && !attachments.length) return undefined;
      const item = reuse({ kind: 'user', key: turnKey, text: itemText, event, attachments, ...(run ? { run } : {}) });
      if (runKey) claim(pass, pass.echoedRuns, runKey, index);
      if (!run?.native) claim(pass, pass.echoedPrompts, itemText, index);
      return item;
    }
    case 'agent_message_chunk': {
      const text = chunkText(event);
      const phase = messagePhase(event);
      return text.trim() ? reuse({ kind: 'assistant', key, text, ...(phase ? { phase } : {}), event }) : undefined;
    }
    case 'agent_thought_chunk': {
      const text = chunkText(event);
      if (!text.trim()) return undefined;
      const channel: ReasoningChannel = event.data.channel === 'thinking' ? 'thinking' : 'narration';
      return reuse({ kind: 'thought', key, text, channel, event });
    }
    case 'tool_call':
    case 'tool_call_update': {
      // Suppress calls the mapper explicitly marks as internal (for example AwaitShell), but
      // keep a visible Shell call when only its backgrounded result is hidden. Job state also
      // travels on its own stream; task notifications remain separate visible timeline items.
      const call = event.sourceEvents.find((source) => source.type === 'tool_call');
      if ((call ?? event).data.hidden === true) return undefined;
      if (!call && !str(event.data.title) && !str(event.data.toolName) && !str(event.data.name)) return undefined;
      // A background shell job is one row with its own live state, not a tool call plus a wait.
      const job = typeof event.data.toolCallId === 'string' ? jobs?.get(event.data.toolCallId) : undefined;
      return reuse({ kind: 'tool', key, event, ...(job ? { job } : {}) });
    }
    case 'plan': {
      const rawEntries = isRecord(event.data.plan) ? event.data.plan.entries : event.data.entries;
      const entries = records(rawEntries);
      // An explicit empty snapshot clears the dock; dropping it resurrects the previous list.
      return Array.isArray(rawEntries) && (rawEntries.length === 0 || entries.length > 0) ? reuse({ kind: 'plan', key, entries, event }) : undefined;
    }
    case 'run_failed': {
      // A Codex turn settles every submitted command, including steers, with its own outcome.
      // Keep those outcomes for run settlement while showing their shared turn error once.
      const turnId = (event as Partial<NativeWorkbenchEvent>).nativeTurnId;
      if (turnId) {
        const failure = JSON.stringify([event.sessionId, turnId, str(event.data.error)]);
        if (pass.turnFailures.has(failure)) return undefined;
        claim(pass, pass.turnFailures, failure, index);
      }
      const { message, detail } = describeFailure(str(event.data.error) ?? '任务失败');
      return reuse({ kind: 'status', key, tone: 'danger', text: message, ...(detail ? { detail } : {}), event });
    }
    case 'run_cancelled':
      // A reason that only repeats the word ("已停止 · 已停止") adds nothing.
      return reuse({ kind: 'status', key, tone: 'muted', text: str(event.data.reason) && str(event.data.reason) !== '已停止' ? `已停止 · ${str(event.data.reason)}` : '已停止', event });
    case 'run_interrupted':
      return reuse({ kind: 'status', key, tone: 'muted', text: str(event.data.reason) ? `已中断 · ${str(event.data.reason)}` : '已中断', event });
    case 'task_notification': {
      const taskId = str(event.data.taskId);
      const detail = taskReportDetail(event.data.detail, taskId);
      const statusValue = str(event.data.status);
      const status: TaskNotificationStatus = statusValue === 'running' || statusValue === 'completed' || statusValue === 'failed' || statusValue === 'cancelled'
        ? statusValue
        : 'unknown';
      const jobResultData = isRecord(event.data.jobResult) ? event.data.jobResult : undefined;
      const jobResultId = str(jobResultData?.id);
      const jobResultStatus = str(jobResultData?.status);
      const jobResult = jobResultData && jobResultId && (jobResultStatus === 'running' || jobResultStatus === 'succeeded' || jobResultStatus === 'failed')
        ? {
            id: jobResultId,
            status: jobResultStatus,
            ...(typeof jobResultData.exitCode === 'number' && Number.isFinite(jobResultData.exitCode) ? { exitCode: jobResultData.exitCode } : {}),
            ...(typeof jobResultData.runningMs === 'number' && Number.isFinite(jobResultData.runningMs) ? { runningMs: jobResultData.runningMs } : {}),
          } satisfies TaskNotificationResult
        : undefined;
      return reuse({
        kind: 'task_notification', key, status,
        taskKind: str(event.data.kind) ?? 'task',
        title: str(event.data.title) ?? '后台任务',
        ...(taskId ? { taskId } : {}),
        ...(str(event.data.sourceStatus) ? { sourceStatus: str(event.data.sourceStatus)! } : {}),
        ...(str(event.data.command) ? { command: str(event.data.command)! } : {}),
        ...(detail ? { detail } : {}),
        ...(jobResult ? { jobResult } : {}),
        // A subagent notice names the tool call that spawned it, so the row can open that
        // subagent's own transcript exactly like its tool row does.
        ...(str(event.data.subagentToolCallId) ? { subagentToolCallId: str(event.data.subagentToolCallId)! } : {}),
        ...(typeof event.data.tokens === 'number' && Number.isFinite(event.data.tokens) ? { tokens: event.data.tokens } : {}),
        ...(typeof event.data.durationMs === 'number' && Number.isFinite(event.data.durationMs) ? { durationMs: event.data.durationMs } : {}),
        event,
      });
    }
    case 'activity': {
      const activity = activityOf(event);
      return activity ? reuse({ kind: 'activity', key, activity, event }) : undefined;
    }
    default:
      return undefined;
  }
}

type UserItem = Extract<TimelineItem, { kind: 'user' }>;
const inputReceiptRows = new WeakMap<UserItem, { receipt: UserItem; item: UserItem }>();

/** A queue acknowledgement and its exact later human record are one input, at the human record's place. */
function reconcileInputReceipts(items: TimelineItem[]): TimelineItem[] {
  const commandRun = (item: TimelineItem): string | undefined => item.kind === 'user' && item.run?.native
    && typeof item.event.data.commandId === 'string' && item.event.data.commandId === item.run.commandId
    && item.event.sessionId === item.run.sessionId ? item.run.id : undefined;
  const receipts = new Map<string, UserItem>();
  const humans = new Map<string, UserItem>();
  for (const item of items) {
    const run = commandRun(item);
    if (!run || item.kind !== 'user') continue;
    if (item.event.type === 'native_input_receipt') receipts.set(run, item);
    if (item.event.type === 'user_message_chunk' && !humans.has(run)) humans.set(run, item);
  }
  if (![...receipts.keys()].some(run => humans.has(run))) return items;
  return items.flatMap(item => {
    const run = commandRun(item);
    const receipt = run ? receipts.get(run) : undefined;
    const human = run ? humans.get(run) : undefined;
    if (!receipt || !human) return [item];
    if (item.kind === 'user' && item.event.type === 'native_input_receipt') return [];
    if (item !== human) return [item];
    const held = inputReceiptRows.get(human);
    if (held?.receipt === receipt) return [held.item];
    // Keep both exact native identities so Run receipts, marks and search anchors still resolve.
    // Text, attachments, native turn and chronological position belong to the real human record.
    const joined: UserItem = {
      ...human, key: userRowKey(human.run!, human.key),
      event: { ...human.event, sourceEvents: [...receipt.event.sourceEvents, ...human.event.sourceEvents] },
    };
    inputReceiptRows.set(human, { receipt, item: joined });
    return [joined];
  });
}

/**
 * Claude 2.1.322 writes a `/compact` after the compaction it ran (boundary, summary, then the command), stamped with when it
 * was typed. Typed before the compaction began, it goes before it, where earlier versions wrote it.
 */
function commandsBeforeCompaction(items: TimelineItem[]): void {
  for (let index = 1; index < items.length; index += 1) {
    const command = items[index]!;
    const compaction = items[index - 1]!;
    if (command.kind !== 'user' || compaction.kind !== 'activity' || compaction.activity.kind !== 'compaction' || compaction.activity.compaction?.trigger !== 'manual') continue;
    if (!/^\/compact(?:\s|$)/.test(command.text.trim())) continue;
    const typed = Date.parse(command.event.createdAt);
    const began = Date.parse(compaction.activity.startedAt ?? '');
    if (!(typed <= began)) continue;
    items[index - 1] = command;
    items[index] = compaction;
  }
}

/** The newest manual compaction, if it came after `since`; an automatic one belongs to the turn that triggered it, not to a `/compact`. */
function manualCompactionSince(items: readonly TimelineItem[], since: number): TimelineItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind !== 'activity' || item.activity.kind !== 'compaction') continue;
    return item.activity.compaction?.trigger === 'manual' && Date.parse(timelineItemTime(item)) >= since ? item : undefined;
  }
  return undefined;
}

/**
 * Files the compaction receipt and the runs no event row stands for into `items` — the event rows,
 * which it extends in place and returns.
 */
function placeRunRows(items: TimelineItem[], events: ProjectedEvent[], context: TimelineContext, pass: TimelinePass, previous: PreviousRow, placed?: Map<string, TimelineItem>): TimelineItem[] {
  items = reconcileInputReceipts(items);
  commandsBeforeCompaction(items);
  const locate = receiptLocator(items, context.runs, context.nativeChatId);
  const compacted = compactedTurn(events, context, pass, previous, locate);
  if (compacted) {
    items.unshift(compacted);
    placed?.set(compacted.key, compacted);
  }
  for (const run of context.runs) {
    let receipt: TimelineItem | undefined;
    if (run.native) {
      if (pass.echoedRuns.has(run.id)) continue;
      // A pre-dispatch cancellation has no user-visible CLI message to reconcile. Keep a real
      // echoed message above, and keep in-flight stops (state='interrupted') visible as well.
      if (run.state === 'cancelled') continue;
      const activeDelivery = ['queued', 'preparing', 'dispatching', 'input_sent', 'uncertain'].includes(run.native.delivery);
      // Earlier confirmed turns were removed by compaction as well. Their receipts are not
      // fresh prompts and must not be appended after the restored latest turn's answer.
      if (compacted && !activeDelivery && run.native.nativeMessageId) continue;
      receipt = locate(run);
      const oldestVisibleAt = events[0]?.createdAt ? Date.parse(events[0].createdAt) : Number.NEGATIVE_INFINITY;
      const runAt = Date.parse(run.createdAt);
      if (!receipt && !activeDelivery && run.native.fingerprint !== 'client-pending' && !(Number.isFinite(runAt) && runAt >= oldestVisibleAt)) continue;
    } else if (run.state !== 'running' || pass.echoedRuns.has(run.id) || pass.echoedPrompts.has(run.prompt)) continue;
    // Standing in for a receipt, the row takes the CLI turn id its output carries, so the turn is
    // joined exactly as if the receipt itself were in the window.
    const event: ProjectedEvent & Partial<Pick<NativeWorkbenchEvent, 'nativeId'>> = {
      sequence: Number.MAX_SAFE_INTEGER, sessionId: run.sessionId, runId: receipt?.event.runId ?? run.id, type: 'user_message_chunk', data: {}, createdAt: run.createdAt,
      ...(receipt && run.native?.nativeMessageId ? { nativeId: run.native.nativeMessageId } : {}),
      projectionKey: `pending:${run.id}`, sourceEvents: [],
    };
    const attachments = run.native?.input.attachmentIds.map((id) => ({ id, name: id })) ?? [];
    const item = { kind: 'user', key: userRowKey(run, `user:${run.id}`), text: run.prompt, event, attachments, run } satisfies TimelineItem;
    const prior = previous(item.key);
    const resolved = sameRunRow(prior, item) ? prior : item;
    placed?.set(resolved.key, resolved);
    // A run still in flight belongs at the end: it is the newest intent even when the store has
    // already written later rows for the turn it waits behind. A run the CLI has received — and a
    // finished run the store never echoed, such as a slash command (`/summarize`) the CLI answers
    // only in its own pane — happened at its own time, so it is filed there instead of jumping after
    // every later answer, and right before its own output when that can be found. Its time is when
    // it was sent, not when it was typed: a message queued behind a turn would otherwise be filed
    // above that turn's whole answer until the store echoes it.
    const native = run.native;
    const received = Boolean(native && native.delivery !== 'queued' && native.delivery !== 'preparing'
      && (native.nativeMessageId || native.delivery === 'observed'));
    const pending = !received && (run.state === 'queued' || run.state === 'running');
    // A `/compact` the CLI writes no row for until the compaction ends: the compaction it started is
    // already in the transcript (its hook), and is the only output the command has. The command goes before it.
    const compaction = pending && /^\/compact(?:\s|$)/.test(run.prompt.trim()) ? manualCompactionSince(items, Date.parse(run.createdAt)) : undefined;
    if (receipt) items.splice(items.indexOf(receipt), 0, resolved);
    else if (compaction) items.splice(items.indexOf(compaction), 0, resolved);
    else if (pending && native?.intent !== 'steer') items.push(resolved);
    else if (pending && native?.intent === 'steer' && (native.delivery === 'queued' || native.delivery === 'preparing')) {
      const end = targetTurnEndIndex(items, native);
      items.splice(end >= 0 ? end + 1 : chronologicalIndex(items, Date.parse(run.createdAt)), 0, resolved);
    }
    else items.splice(chronologicalIndex(items, native?.timings?.dispatchAt ?? Date.parse(run.createdAt)), 0, resolved);
  }
  return items;
}

export function buildTimeline(events: ProjectedEvent[], runs: Run[], jobs?: Map<string, NativeJob>, previousItems?: TimelineItem[], nativeChatId?: string): TimelineItem[] {
  const previousByKey = previousItems ? new Map(previousItems.map((item) => [item.key, item])) : undefined;
  const previous: PreviousRow = (key) => previousByKey?.get(key);
  const context = timelineContext(runs, jobs, nativeChatId);
  const pass = timelinePass();
  const items: TimelineItem[] = [];
  events.forEach((event, index) => {
    const row = eventRow(event, index, context, pass, previous);
    if (row) items.push(row);
  });
  return placeRunRows(items, events, context, pass, previous);
}

/**
 * `buildTimeline` that resumes instead of starting over.
 *
 * It keeps the event rows (before run rows are filed among them) and the pass state logged per
 * event, so a change that leaves the first N projected events untouched — a streamed append, a
 * growing draft, a tool card updated in the open turn — rewinds to the first changed event and
 * replays only from there. Different runs, jobs or chat take the full build. The compaction receipt
 * and run rows depend on every event row, so they are filed again after each build either way. Both
 * paths run the same per-event code over the same state, so a resumed build is the full build; the
 * parity fixtures (`pnpm gen:timeline-fixtures`, `TimelineFixtureParityTest`) hold `buildTimeline`
 * to the Kotlin port.
 */
export class IncrementalTimeline {
  items: TimelineItem[] = [];
  private context: TimelineContext | undefined;
  /** A copy: the projection is updated in place, so the caller's array cannot say what changed. */
  private events: ProjectedEvent[] = [];
  private rows: TimelineItem[] = [];
  /** `rows.length` before each event's row, so a rewind knows where to cut. */
  private rowStart: number[] = [];
  private pass: TimelinePass;
  private runRows = new Map<string, TimelineItem>();

  constructor(private readonly seed?: TimelineSeed) {
    this.pass = seededPass(seed);
  }

  clear(): void {
    this.items = [];
    this.context = undefined;
    this.events = [];
    this.rows = [];
    this.rowStart = [];
    this.pass = seededPass(this.seed);
    this.runRows = new Map();
  }

  build(events: ProjectedEvent[], runs: Run[], jobs?: Map<string, NativeJob>, nativeChatId?: string): TimelineItem[] {
    const context = this.context;
    if (!context || context.runs !== runs || context.jobs !== jobs || context.nativeChatId !== nativeChatId) return this.full(events, timelineContext(runs, jobs, nativeChatId));
    const shared = Math.min(events.length, this.events.length);
    let from = 0;
    while (from < shared && events[from] === this.events[from]) from += 1;
    if (from === events.length && from === this.events.length) return this.items;
    if (from === 0) return this.full(events, context);
    return this.resume(events, from, context);
  }

  /** Puts a job on every row of its tool call, as the next full build would. */
  setJob(job: NativeJob): void {
    const matches = (item: TimelineItem): item is Extract<TimelineItem, { kind: 'tool' }> => item.kind === 'tool' && item.event.data.toolCallId === job.toolCallId && item.job !== job;
    const replaced = new Map<TimelineItem, TimelineItem>();
    this.rows.forEach((item, index) => {
      if (!matches(item)) return;
      const next = { ...item, job };
      replaced.set(item, next);
      this.rows[index] = next;
    });
    this.items.forEach((item, index) => {
      const next = replaced.get(item) ?? (matches(item) ? { ...item, job } : undefined);
      if (next) this.items[index] = next;
    });
  }

  private full(events: ProjectedEvent[], context: TimelineContext): TimelineItem[] {
    const previousByKey = new Map(this.items.map((item) => [item.key, item]));
    const previous: PreviousRow = (key) => previousByKey.get(key);
    this.context = context;
    this.pass = seededPass(this.seed);
    this.rows = [];
    this.rowStart = [];
    this.append(events, 0, context, previous);
    this.events = events.slice();
    return this.place(context, previous);
  }

  private resume(events: ProjectedEvent[], from: number, context: TimelineContext): TimelineItem[] {
    const start = this.rowStart[from] ?? this.rows.length;
    const replaced = new Map(this.rows.slice(start).map((item) => [item.key, item]));
    this.rows.length = start;
    this.rowStart.length = from;
    const log = this.pass.log;
    while (log.length && log[log.length - 1]![0] >= from) {
      const [, set, value] = log.pop()!;
      set.delete(value);
    }
    this.append(events, from, context, (key) => replaced.get(key));
    this.events.length = from;
    for (let index = from; index < events.length; index += 1) this.events.push(events[index]!);
    const runRows = this.runRows;
    return this.place(context, (key) => runRows.get(key));
  }

  private append(events: ProjectedEvent[], from: number, context: TimelineContext, previous: PreviousRow): void {
    for (let index = from; index < events.length; index += 1) {
      this.rowStart.push(this.rows.length);
      const row = eventRow(events[index]!, index, context, this.pass, previous);
      if (row) this.rows.push(row);
    }
  }

  private place(context: TimelineContext, previous: PreviousRow): TimelineItem[] {
    const placed = new Map<string, TimelineItem>();
    this.items = placeRunRows(this.rows.slice(), this.events, context, this.pass, previous, placed);
    this.runRows = placed;
    return this.items;
  }
}

/** Index of the last row belonging to a deferred steer's target turn, so a not-yet-delivered steer sits after work already emitted in that turn rather than jumping above it when timestamps skew. */
function targetTurnEndIndex(items: readonly TimelineItem[], native: NonNullable<Run['native']>): number {
  const turnId = native.nativeTurnId;
  const ownerRunId = native.ownerRunId;
  let last = -1;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const itemTurn = (item.event as Partial<NativeWorkbenchEvent>).nativeTurnId
      ?? (item.kind === 'user' ? item.run?.native?.nativeTurnId : undefined);
    const sameTurn = (turnId !== undefined && itemTurn === turnId)
      || (ownerRunId !== undefined && (item.event.runId === ownerRunId
        || (item.kind === 'user' && (item.run?.id === ownerRunId || item.run?.native?.ownerRunId === ownerRunId))));
    if (sameTurn) last = index;
  }
  return last;
}

const itemTimes = new WeakMap<TimelineItem, number>();

/** Index of the first row that is newer than `at`, or the list length when nothing is newer. */
export function chronologicalIndex(items: TimelineItem[], at: number): number {
  if (!Number.isFinite(at)) return items.length;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    let time = itemTimes.get(item);
    if (time === undefined) {
      time = Date.parse(timelineItemTime(item));
      itemTimes.set(item, time);
    }
    if (Number.isFinite(time) && time > at) return index;
  }
  return items.length;
}
