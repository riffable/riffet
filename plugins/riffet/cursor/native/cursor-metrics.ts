import type { NativeStreamMessage, NativeWorkbenchEvent, RunMetrics } from '@contracts';
import { estimateTokens, runTracker, type RunMetricsTracker, type StatsSink } from '@riffet/plugin-api';

const noopStats: StatsSink = {
  recordUsage() {},
  observeEvents() {},
};

/** Text-shaped events whose characters are part of what the model produced. */
const TEXT_EVENT_TYPES = new Set(['agent_message_chunk', 'agent_thought_chunk']);

/** `"12:ab34:0"` and `"12:ab34:1"` are two parts of the same committed message. */
function blobKey(nativeId: string): string {
  const cut = nativeId.lastIndexOf(':');
  return cut < 0 ? nativeId : nativeId.slice(0, cut);
}

function contentText(event: NativeWorkbenchEvent): string | undefined {
  const content = event.data.content;
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const text = (content as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return typeof event.data.text === 'string' ? event.data.text : undefined;
}

interface CursorTurn {
  /** Identity of the CLI's user message for this turn, which is how a run is found again. */
  userNativeId?: string;
  /** When the most recently committed record of this turn was written. */
  lastRecordAt?: number;
  /** The most recent record is the user's prompt, whose own timestamp is only minute-precise. */
  lastRecordIsPrompt?: boolean;
  blobKey?: string;
  blobStartAt?: number;
  /** The current response started right after the prompt, so `blobStartAt` cannot be trusted. */
  blobStartsAtPrompt?: boolean;
  /** The current response called a tool, so the CLI committed it only after the tool had run. */
  blobCallsTool?: boolean;
  text: string;
  toolText: string;
  /** Pre-tool observation of the uncommitted step from the root's `pending` field. */
  draft?: { position: string; stepId: string; text: string; startedAt: number; endedAt: number };
  /** The workbench run this turn belongs to, resolved once the receipt has been recognised. */
  runId?: string;
  /** Blob key to the text length already published, so a re-read does not republish. */
  readonly published: Map<string, number>;
}

/**
 * Speed measurements for Cursor conversations.
 *
 * The CLI's store keeps no usage counters and no timestamps of its own, so the only observable
 * quantity is *when* the workbench first saw each committed record — which is why these numbers
 * are estimates and why the window is reported as `observed` rather than `stream`. Records are
 * written whole, one per model response, so the response time is the distance between consecutive
 * commits and the polling lag cancels out of the subtraction.
 *
 * That holds only for a response that called no tool. The CLI commits a tool-calling response
 * together with its results, after the tools have run, so its window would include a build or a
 * test run and read as a model producing a handful of tokens per second. Such responses are left
 * unmeasured. So is a response that follows the prompt, unless the run says when the prompt was
 * really sent: the prompt record carries the minute-precise time quoted in the prompt itself.
 *
 * Because those observation times exist only while the conversation is being watched, every
 * measurement is handed to `persist` for storage on the run.
 */
export class CursorTranscriptMeter {
  private readonly turns = new Map<string, CursorTurn>();
  private readonly trackers = new Map<string, RunMetricsTracker>();

  constructor(
    private readonly emit: (message: Extract<NativeStreamMessage, { type: 'metrics' }>) => void,
    private readonly persist: (runId: string, metrics: RunMetrics) => void,
    /** Resolves the workbench run that a CLI user message belongs to, when it is known. */
    private readonly runForUserMessage: (nativeMessageId: string) => string | undefined,
    /** When the workbench actually typed a run's prompt into the CLI, when it did. */
    private readonly promptSentAt: (runId: string) => number | undefined = () => undefined,
    private readonly stats: StatsSink = noopStats,
    private readonly sessionId = '',
  ) {}

  /** A new chat root means the previous turn identities are meaningless. */
  reset(): void {
    this.turns.clear();
    this.trackers.clear();
  }

  /** Fold one batch of newly committed transcript events into the measurements. */
  observe(events: NativeWorkbenchEvent[]): void {
    const touched = new Set<string>();
    for (const event of events) {
      const turnKey = event.runId;
      if (!turnKey || event.nativeId.startsWith('subagent:')) continue;
      const at = Date.parse(event.createdAt);
      if (!Number.isFinite(at)) continue;
      const key = blobKey(event.nativeId);
      const turn = this.turnFor(turnKey);
      touched.add(turnKey);
      if (event.type === 'user_message_chunk' || event.type === 'task_notification') {
        turn.userNativeId = event.nativeId;
        turn.lastRecordAt = at;
        turn.lastRecordIsPrompt = true;
        turn.blobKey = key;
        turn.blobStartAt = at;
        turn.blobStartsAtPrompt = false;
        turn.blobCallsTool = false;
        turn.text = '';
        turn.toolText = '';
        turn.draft = undefined;
        continue;
      }
      if (key !== turn.blobKey) {
        this.publish(turnKey, turn);
        turn.blobKey = key;
        // The response began when the previous record landed: the user turn, or the tool result
        // whose output the model was reading.
        turn.blobStartAt = turn.lastRecordAt ?? at;
        turn.blobStartsAtPrompt = turn.lastRecordIsPrompt === true;
        turn.blobCallsTool = false;
        turn.text = '';
        turn.toolText = '';
      }
      turn.lastRecordAt = at;
      turn.lastRecordIsPrompt = false;
      if (event.type === 'tool_call') {
        turn.blobCallsTool = true;
        turn.toolText += JSON.stringify(event.data.rawInput ?? {});
      }
      if (TEXT_EVENT_TYPES.has(event.type)) turn.text += contentText(event) ?? '';
    }
    // A record is committed whole, so the batch's own blob is already complete; it would
    // otherwise sit unpublished until the next record arrived.
    for (const turnKey of touched) this.publish(turnKey, this.turns.get(turnKey)!);
  }

  /**
   * Observe the CLI's in-flight `pending` step before its tools finish.
   *
   * Cursor writes the assistant step into field 4 of the root blob while its tool calls run, and
   * only commits the message blob once those calls return. Measuring the draft when it appears
   * captures the model's generation window without the tool execution wait that follows.
   */
  observeDraft(draft: NativeWorkbenchEvent[], now = Date.now()): void {
    const first = draft[0];
    const turnKey = first?.runId;
    if (!first || !turnKey || first.nativeId.startsWith('subagent:')) return;
    const position = first.nativeId.split(':')[0];
    if (!position) return;
    const turn = this.turnFor(turnKey);
    if (turn.runId === undefined && turn.userNativeId) turn.runId = this.runForUserMessage(turn.userNativeId);
    const startedAt = turn.draft?.position === position
      ? turn.draft.startedAt
      : turn.lastRecordIsPrompt
        ? (turn.runId === undefined ? undefined : this.promptSentAt(turn.runId))
        : turn.lastRecordAt;
    if (startedAt === undefined || !(now > startedAt)) return;
    let text = '';
    for (const event of draft) {
      if (TEXT_EVENT_TYPES.has(event.type)) text += contentText(event) ?? '';
      else if (event.type === 'tool_call') text += JSON.stringify(event.data.rawInput ?? {});
    }
    if (!text.trim() || (turn.draft?.position === position && turn.draft.text === text)) return;
    const stepId = `${position}:draft`;
    turn.draft = { position, stepId, text, startedAt, endedAt: now };
    this.metricsFor(turnKey, turn.runId).update({
      stepId,
      text,
      startedAt,
      endedAt: now,
      window: 'observed',
      live: true,
    }, true);
  }

  private turnFor(turnKey: string): CursorTurn {
    const existing = this.turns.get(turnKey);
    if (existing) return existing;
    const turn: CursorTurn = { text: '', toolText: '', published: new Map() };
    this.turns.set(turnKey, turn);
    return turn;
  }

  private publish(turnKey: string, turn: CursorTurn): void {
    const key = turn.blobKey;
    if (!key) return;
    const position = key.split(':')[0];
    if (turn.draft && turn.draft.position === position) {
      const draft = turn.draft;
      turn.draft = undefined;
      const fullText = (turn.text + turn.toolText).trim() ? turn.text + turn.toolText : draft.text;
      if (!fullText.trim() || turn.published.get(key) === fullText.length) return;
      if (turn.runId === undefined && turn.userNativeId) turn.runId = this.runForUserMessage(turn.userNativeId);
      turn.published.set(key, fullText.length);
      if (draft.endedAt > draft.startedAt) {
        this.recordEstimated(turn, key, draft.startedAt, draft.endedAt, fullText);
      }
      this.metricsFor(turnKey, turn.runId).update({
        stepId: draft.stepId,
        text: fullText,
        startedAt: draft.startedAt,
        endedAt: draft.endedAt,
        window: 'observed',
        live: false,
      }, true);
      return;
    }
    if (!turn.text.trim() || turn.blobCallsTool) return;
    const endedAt = turn.lastRecordAt;
    if (turn.blobStartAt === undefined || endedAt === undefined) return;
    if (turn.published.get(key) === turn.text.length) return;
    if (turn.runId === undefined && turn.userNativeId) turn.runId = this.runForUserMessage(turn.userNativeId);
    const startedAt = turn.blobStartsAtPrompt ? (turn.runId === undefined ? undefined : this.promptSentAt(turn.runId)) : turn.blobStartAt;
    if (startedAt === undefined) return;
    turn.published.set(key, turn.text.length);
    if (endedAt > startedAt) this.recordEstimated(turn, key, startedAt, endedAt, turn.text);
    const tracker = this.metricsFor(turnKey, turn.runId);
    tracker.update({
      stepId: key,
      text: turn.text,
      startedAt,
      endedAt,
      window: 'observed',
      live: false,
    }, true);
  }

  /**
   * A committed Cursor record has no provider usage. `stepId` is the blob key: `nativeId` with the
   * trailing `:<part>` removed, the same cut a chat-store backfill can make.
   */
  private recordEstimated(turn: CursorTurn, stepId: string, startedAt: number, endedAt: number, text = turn.text): void {
    try {
      this.stats.recordUsage(this.sessionId, turn.runId, {
        stepId,
        ...(turn.userNativeId ? { nativeMessageId: turn.userNativeId } : {}),
        startedAt,
        endedAt,
        outputTokens: Math.max(0, Math.round(estimateTokens(text))),
        tokenSource: 'estimated',
        window: 'observed',
      });
    } catch { /* statistics must never affect the stream */ }
  }

  private metricsFor(turnKey: string, runId: string | undefined): RunMetricsTracker {
    return runTracker(this.trackers, turnKey, { runId, nativeMessageId: () => this.turns.get(turnKey)?.userNativeId }, {
      emit: message => this.emit(message), save: (id, run) => this.persist(id, run),
    });
  }
}
