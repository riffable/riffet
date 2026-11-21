import type { MetricsWindow, NativeStreamMessage, NativeWorkbenchEvent, RunMetrics } from '@contracts';
import { estimateTokens, isPlausibleSpeed, measuredWindow, rememberTracker, RunMetricsTracker, type StatsSink } from '@riffet/plugin-api/kit';
import { cursorPromptAlias, type CursorLiveStep } from './live.js';

const noopStats: StatsSink = {
  recordUsage() {},
  observeEvents() {},
};

/** Text-shaped events whose characters are part of what the model produced. */
const TEXT_EVENT_TYPES = new Set(['agent_message_chunk', 'agent_thought_chunk']);
const MAX_LIVE_STEPS = 64;
const MAX_TURN_LIVE_STEPS = 8;

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

function textsOverlap(left: string, right: string): boolean {
  const a = left.trim();
  const b = right.trim();
  if (!a || !b) return false;
  return a.includes(b.slice(0, 64)) || b.includes(a.slice(0, 64));
}

interface LiveStepMeasurement {
  startedAt: number;
  endedAt: number;
  window: MetricsWindow;
  text: string;
}

interface LiveStepRecord {
  readonly step: string;
  stepId: string;
  turnKey: string;
  text: string;
  /** Prefix length already present when an already-running CLI was first observed without tap timestamps. */
  readonly baselineChars: number;
  readonly firstSeenAt: number;
  lastSeenAt: number;
  firstDeltaAt?: number;
  lastDeltaAt?: number;
  sealed: boolean;
  settled?: boolean;
  measured?: LiveStepMeasurement;
  claimedBy?: string;
}

interface CursorDraft {
  position: string;
  stepId: string;
  text: string;
  startedAt?: number;
  endedAt: number;
  liveStep?: LiveStepRecord;
  emitted?: boolean;
}

interface CursorTurn {
  /** Identity of the CLI's user message for this turn, which is how a run is found again. */
  userNativeId?: string;
  /** The CLI's request id for the turn; runs store `request:<id>` as `nativeMessageId`. */
  userTurnId?: string;
  /** The alias that resolved `runId`, preferred for `nativeMessageId` attribution. */
  matchedUserMessageId?: string;
  /** When the most recently observed live record of this turn landed (absent for historical replays). */
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
  draft?: CursorDraft;
  /** The workbench run this turn belongs to, resolved once the receipt has been recognised. */
  runId?: string;
  /** Blob key to the text length already published, so a re-read does not republish. */
  readonly published: Map<string, number>;
  /** Unclaimed streaming steps observed from `CursorLive` for this turn. */
  readonly liveSteps: LiveStepRecord[];
}

/**
 * Speed measurements for Cursor conversations.
 *
 * When `CursorLive` (`live-tap.cjs`) is active, streaming text and reasoning deltas provide a
 * real-time `stream` window (excluding TTFT and tool execution wait) before the CLI writes a
 * checkpoint to SQLite. When the tap is unavailable or a step consists purely of tool calls,
 * committed store records and in-flight `pending` drafts provide an `observed` window between
 * consecutive real-time commits (skipping historical replays whose timestamps are only the
 * prompt's minute-precise time).
 *
 * Because those observation times exist only while the conversation is being watched, every
 * measurement is handed to `persist` for storage on the run.
 */
export class CursorTranscriptMeter {
  private readonly turns = new Map<string, CursorTurn>();
  private readonly trackers = new Map<string, RunMetricsTracker>();
  private readonly turnByRequestId = new Map<string, string>();
  private readonly liveByStep = new Map<string, LiveStepRecord>();

  constructor(
    private readonly emit: (message: Extract<NativeStreamMessage, { type: 'metrics' }>) => void,
    private readonly persist: (runId: string, metrics: RunMetrics) => void,
    /** Resolves the workbench run that a CLI user message belongs to, when it is known. */
    private readonly runForUserMessage: (nativeMessageId: string) => string | undefined,
    /** When the workbench actually typed a run's prompt into the CLI, when it did. */
    private readonly promptSentAt: (runId: string) => number | undefined = () => undefined,
    private readonly stats: StatsSink = noopStats,
    private readonly sessionId = '',
    private readonly nativeSessionId: () => string | undefined = () => undefined,
  ) {}

  /** A new chat root means the previous turn identities are meaningless. */
  reset(): void {
    this.turns.clear();
    this.trackers.clear();
    this.turnByRequestId.clear();
    this.liveByStep.clear();
  }

  /** Fold one batch of committed transcript events into the measurements. */
  observe(events: NativeWorkbenchEvent[], options?: { historical?: boolean }): void {
    const historical = options?.historical === true;
    const touched = new Set<string>();
    for (const event of events) {
      const turnKey = event.runId;
      if (!turnKey || event.nativeId.startsWith('subagent:')) continue;
      const at = Date.parse(event.createdAt);
      if (!historical && !Number.isFinite(at)) continue;
      const key = blobKey(event.nativeId);
      const adopted = (event.type === 'user_message_chunk' || event.type === 'task_notification') && event.nativeTurnId
        ? this.adoptLiveTurn(event.nativeTurnId, turnKey)
        : undefined;
      const turn = adopted ?? this.turnFor(turnKey);
      touched.add(turnKey);
      if (event.type === 'user_message_chunk' || event.type === 'task_notification') {
        turn.userNativeId = event.nativeId;
        if (event.nativeTurnId) turn.userTurnId = event.nativeTurnId;
        // Historical replays only carry minute-precise prompt times; never use them as a live anchor.
        turn.lastRecordAt = historical ? undefined : at;
        turn.lastRecordIsPrompt = true;
        turn.blobKey = key;
        turn.blobStartAt = historical ? undefined : at;
        turn.blobStartsAtPrompt = false;
        turn.blobCallsTool = false;
        turn.text = '';
        turn.toolText = '';
        turn.draft = undefined;
        // Pre-warm asynchronous run lookups as soon as the prompt is seen so the first reply can
        // resolve both `runId` and `promptSentAt`.
        this.resolveRunId(turn);
        continue;
      }
      if (historical) {
        turn.blobKey = key;
        turn.lastRecordAt = undefined;
        turn.lastRecordIsPrompt = false;
        turn.blobStartAt = undefined;
        turn.blobStartsAtPrompt = false;
        turn.blobCallsTool = false;
        turn.text = '';
        turn.toolText = '';
        turn.published.set(key, -1);
        continue;
      }
      if (key !== turn.blobKey) {
        this.publish(turnKey, turn);
        turn.blobKey = key;
        // The response began when the previous record landed: the user turn, or the tool result
        // whose output the model was reading.
        turn.blobStartAt = turn.lastRecordAt;
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
    if (historical) return;
    // A record is committed whole, so the batch's own blob is already complete; it would
    // otherwise sit unpublished until the next record arrived.
    for (const turnKey of touched) this.publish(turnKey, this.turns.get(turnKey)!);
  }

  /**
   * Observe a live streaming snapshot written by `live-tap.cjs` before the store commits it.
   *
   * New CLI launches include exact `firstDeltaAt` / `lastDeltaAt` epoch timestamps (`stream`
   * window, excluding TTFT). Already-running CLIs launched without those fields are timed from
   * incremental delta arrivals after the first observed prefix so live speed works immediately
   * after a server restart without attributing stale prefixes to zero duration.
   */
  observeLiveStep(step: CursorLiveStep, now = Date.now()): void {
    const requestId = step.turn;
    if (!requestId) return;
    const turnKey = this.turnByRequestId.get(requestId) ?? cursorPromptAlias(requestId);
    const turn = this.turnFor(turnKey);
    turn.userTurnId ??= requestId;
    this.rememberTurnForRequest(requestId, turnKey);
    this.resolveRunId(turn);

    const text = step.parts.map(part => part.text).join('');
    if (!text.trim()) return;

    let record = this.liveByStep.get(step.step);
    if (!record) {
      // A step that is already sealed on first sight finished before we began watching; never
      // fabricate a live burst for a stale snapshot left on disk across a server restart.
      if (step.sealed) return;
      const hasTapTimes = step.firstDeltaAt !== undefined && step.lastDeltaAt !== undefined;
      const inheritedDraft = turn.draft?.emitted && !turn.draft.liveStep && textsOverlap(turn.draft.text, text)
        ? turn.draft
        : undefined;
      record = {
        step: step.step,
        stepId: inheritedDraft?.stepId ?? `live:${step.step}`,
        turnKey,
        text,
        baselineChars: hasTapTimes ? 0 : text.length,
        firstSeenAt: now,
        lastSeenAt: now,
        ...(step.firstDeltaAt !== undefined ? { firstDeltaAt: step.firstDeltaAt } : {}),
        ...(step.lastDeltaAt !== undefined ? { lastDeltaAt: step.lastDeltaAt } : {}),
        sealed: false,
        ...(inheritedDraft ? { claimedBy: inheritedDraft.position } : {}),
      };
      if (inheritedDraft) inheritedDraft.liveStep = record;
      this.liveByStep.set(step.step, record);
      while (this.liveByStep.size > MAX_LIVE_STEPS) this.liveByStep.delete(this.liveByStep.keys().next().value!);
      turn.liveSteps.push(record);
      while (turn.liveSteps.length > MAX_TURN_LIVE_STEPS) turn.liveSteps.shift();
    } else {
      // Once SQLite has already settled this step, a delayed live-tap flush must not re-emit it.
      if (record.settled) return;
      const unchanged = record.text === text && record.sealed === step.sealed && record.lastDeltaAt === step.lastDeltaAt;
      if (unchanged) return;
      record.turnKey = turnKey;
      record.text = text;
      record.sealed = step.sealed;
      record.lastSeenAt = now;
      if (step.firstDeltaAt !== undefined && record.firstDeltaAt === undefined) record.firstDeltaAt = step.firstDeltaAt;
      if (step.lastDeltaAt !== undefined) record.lastDeltaAt = step.lastDeltaAt;
    }

    const measurement = this.measureLiveRecord(record, turn, now);
    if (!measurement) return;
    record.measured = measurement;
    this.metricsFor(turnKey, turn).update({
      stepId: record.stepId,
      text: measurement.text,
      startedAt: measurement.startedAt,
      endedAt: measurement.endedAt,
      window: measurement.window,
      live: !record.sealed,
    }, record.sealed);
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
    this.resolveRunId(turn);
    let textOnly = '';
    let text = '';
    let hasToolCall = false;
    for (const event of draft) {
      if (TEXT_EVENT_TYPES.has(event.type)) {
        const chunk = contentText(event) ?? '';
        textOnly += chunk;
        text += chunk;
      } else if (event.type === 'tool_call') {
        hasToolCall = true;
        text += JSON.stringify(event.data.rawInput ?? {});
      }
    }
    if (!text.trim()) return;
    const liveStep = turn.draft?.position === position
      ? turn.draft.liveStep
      : this.claimLiveStep(turn, position, textOnly);
    const startedAt = turn.draft?.position === position
      ? turn.draft.startedAt
      : turn.lastRecordIsPrompt
        ? (turn.runId === undefined ? undefined : this.promptSentAt(turn.runId))
        : turn.lastRecordAt;
    const validObserved = startedAt !== undefined && now > startedAt;
    if (!validObserved && !liveStep?.measured) return;
    if (turn.draft?.position === position && turn.draft.text === text) return;
    const stepId = turn.draft?.position === position && turn.draft.emitted
      ? turn.draft.stepId
      : (liveStep?.stepId ?? `${position}:draft`);
    const alreadyEmitted = turn.draft?.position === position ? turn.draft.emitted : undefined;
    turn.draft = {
      position,
      stepId,
      text,
      ...(validObserved ? { startedAt } : {}),
      endedAt: validObserved ? now : liveStep!.measured!.endedAt,
      ...(liveStep ? { liveStep } : {}),
      ...(alreadyEmitted ? { emitted: true } : {}),
    };
    // When `live-tap` is already streaming this step, avoid overwriting its tighter `stream`
    // measurement with a wider `observed` window (or duplicating live frames).
    if (liveStep?.measured && !hasToolCall) return;
    if (liveStep?.measured && !validObserved) return;
    if (!validObserved) return;
    turn.draft.emitted = true;
    this.metricsFor(turnKey, turn).update({
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
    const turn: CursorTurn = { text: '', toolText: '', published: new Map(), liveSteps: [] };
    this.turns.set(turnKey, turn);
    return turn;
  }

  private rememberTurnForRequest(requestId: string, turnKey: string): void {
    this.turnByRequestId.set(requestId, turnKey);
    while (this.turnByRequestId.size > MAX_LIVE_STEPS) this.turnByRequestId.delete(this.turnByRequestId.keys().next().value!);
  }

  private adoptLiveTurn(requestId: string, turnKey: string): CursorTurn | undefined {
    const previousKey = this.turnByRequestId.get(requestId);
    this.rememberTurnForRequest(requestId, turnKey);
    if (!previousKey || previousKey === turnKey) return undefined;
    const prior = this.turns.get(previousKey);
    if (!prior) return undefined;
    // Re-key the existing turn object so any tracker already created for it keeps reading live
    // `runId` and `nativeMessageId` updates without recreating the step map.
    for (const step of prior.liveSteps) step.turnKey = turnKey;
    this.turns.set(turnKey, prior);
    this.turns.delete(previousKey);
    const priorTracker = this.trackers.get(previousKey);
    if (priorTracker && !this.trackers.has(turnKey)) {
      this.trackers.set(turnKey, priorTracker);
      this.trackers.delete(previousKey);
    }
    return prior;
  }

  private resolveRunId(turn: CursorTurn): string | undefined {
    if (turn.runId !== undefined) return turn.runId;
    const candidates: string[] = [];
    if (turn.userTurnId) candidates.push(cursorPromptAlias(turn.userTurnId));
    if (turn.userNativeId && !candidates.includes(turn.userNativeId)) candidates.push(turn.userNativeId);
    for (const id of candidates) {
      const found = this.runForUserMessage(id);
      if (found) {
        turn.runId = found;
        turn.matchedUserMessageId = id;
        return found;
      }
    }
    return undefined;
  }

  private turnNativeMessageId(turn: CursorTurn | undefined): string | undefined {
    if (!turn) return undefined;
    return turn.matchedUserMessageId ?? (turn.userTurnId ? cursorPromptAlias(turn.userTurnId) : turn.userNativeId);
  }

  private measureLiveRecord(record: LiveStepRecord, turn: CursorTurn, now: number): LiveStepMeasurement | undefined {
    if (record.firstDeltaAt !== undefined && record.lastDeltaAt !== undefined) {
      const tokens = estimateTokens(record.text);
      const fallbackStart = record.sealed
        ? (turn.lastRecordIsPrompt ? (turn.runId === undefined ? undefined : this.promptSentAt(turn.runId)) : turn.lastRecordAt)
        : undefined;
      const range = measuredWindow({
        streamStart: record.firstDeltaAt,
        streamEnd: record.lastDeltaAt,
        ...(fallbackStart !== undefined && fallbackStart < record.lastDeltaAt ? { fallbackStart } : {}),
        outputTokens: tokens,
        now,
      });
      if (!range || !(range.endedAt > range.startedAt)) return undefined;
      if (!isPlausibleSpeed(tokens, range.endedAt - range.startedAt)) return undefined;
      return { startedAt: range.startedAt, endedAt: range.endedAt, window: range.window, text: record.text };
    }
    // Compatibility path for already-running CLIs launched before `firstDeltaAt`/`lastDeltaAt`.
    const deltaText = record.baselineChars > 0 ? record.text.slice(record.baselineChars) : record.text;
    if (!deltaText.trim()) return undefined;
    const spanMs = now - record.firstSeenAt;
    if (!(spanMs > 0)) return undefined;
    const tokens = estimateTokens(deltaText);
    if (!isPlausibleSpeed(tokens, spanMs)) return undefined;
    return { startedAt: record.firstSeenAt, endedAt: now, window: 'stream', text: deltaText };
  }

  private claimLiveStep(turn: CursorTurn, position: string, expectedText: string): LiveStepRecord | undefined {
    const already = turn.liveSteps.find(step => step.claimedBy === position);
    if (already) return already;
    const trimmed = expectedText.trim();
    if (!trimmed) return undefined;
    const matched = turn.liveSteps.find(step => !step.claimedBy && textsOverlap(trimmed, step.text));
    if (!matched) return undefined;
    matched.claimedBy = position;
    return matched;
  }

  private publish(turnKey: string, turn: CursorTurn): void {
    const key = turn.blobKey;
    if (!key) return;
    const position = key.split(':')[0] ?? '';
    this.resolveRunId(turn);
    if (turn.draft && turn.draft.position === position) {
      const draft = turn.draft;
      turn.draft = undefined;
      const liveStep = draft.liveStep ?? this.claimLiveStep(turn, position, turn.text);
      if (liveStep) liveStep.settled = true;
      const fullText = (turn.text + turn.toolText).trim() ? turn.text + turn.toolText : draft.text;
      if (!fullText.trim() || turn.published.get(key) === fullText.length) return;
      turn.published.set(key, fullText.length);
      const targetStepId = draft.emitted ? draft.stepId : (liveStep?.stepId ?? draft.stepId);
      if (!turn.blobCallsTool && liveStep?.measured) {
        const m = liveStep.measured;
        const settledText = liveStep.baselineChars > 0 ? m.text : fullText;
        this.recordEstimated(turn, key, m.startedAt, m.endedAt, settledText, m.window);
        this.metricsFor(turnKey, turn).update({
          stepId: targetStepId,
          text: settledText,
          startedAt: m.startedAt,
          endedAt: m.endedAt,
          window: m.window,
          live: false,
        }, true);
        return;
      }
      if (draft.startedAt !== undefined && draft.endedAt > draft.startedAt) {
        this.recordEstimated(turn, key, draft.startedAt, draft.endedAt, fullText, 'observed');
        this.metricsFor(turnKey, turn).update({
          stepId: targetStepId,
          text: fullText,
          startedAt: draft.startedAt,
          endedAt: draft.endedAt,
          window: 'observed',
          live: false,
        }, true);
        return;
      }
      if (liveStep?.measured) {
        const m = liveStep.measured;
        this.recordEstimated(turn, key, m.startedAt, m.endedAt, m.text, m.window);
        this.metricsFor(turnKey, turn).update({
          stepId: targetStepId,
          text: m.text,
          startedAt: m.startedAt,
          endedAt: m.endedAt,
          window: m.window,
          live: false,
        }, true);
      }
      return;
    }

    const liveStep = turn.text.trim() ? this.claimLiveStep(turn, position, turn.text) : undefined;
    if (liveStep) liveStep.settled = true;
    if (liveStep?.measured) {
      const m = liveStep.measured;
      const settledText = liveStep.baselineChars > 0 || turn.blobCallsTool
        ? m.text
        : (turn.text.trim() ? turn.text : m.text);
      if (!settledText.trim() || turn.published.get(key) === settledText.length) return;
      turn.published.set(key, settledText.length);
      this.recordEstimated(turn, key, m.startedAt, m.endedAt, settledText, m.window);
      this.metricsFor(turnKey, turn).update({
        stepId: liveStep.stepId,
        text: settledText,
        startedAt: m.startedAt,
        endedAt: m.endedAt,
        window: m.window,
        live: false,
      }, true);
      return;
    }

    if (!turn.text.trim() || turn.blobCallsTool) return;
    const endedAt = turn.lastRecordAt;
    if (endedAt === undefined) return;
    if (turn.published.get(key) === turn.text.length) return;
    const startedAt = turn.blobStartsAtPrompt ? (turn.runId === undefined ? undefined : this.promptSentAt(turn.runId)) : turn.blobStartAt;
    if (startedAt === undefined || !(endedAt > startedAt)) return;
    turn.published.set(key, turn.text.length);
    this.recordEstimated(turn, key, startedAt, endedAt, turn.text, 'observed');
    this.metricsFor(turnKey, turn).update({
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
  private recordEstimated(turn: CursorTurn, stepId: string, startedAt: number, endedAt: number, text = turn.text, window: MetricsWindow = 'observed'): void {
    try {
      const nativeMessageId = this.turnNativeMessageId(turn);
      this.stats.recordUsage(this.sessionId, turn.runId, {
        stepId,
        ...(nativeMessageId ? { nativeMessageId } : {}),
        ...(this.nativeSessionId() ? { nativeSessionId: this.nativeSessionId() } : {}),
        startedAt,
        endedAt,
        outputTokens: Math.max(0, Math.round(estimateTokens(text))),
        tokenSource: 'estimated',
        window,
      });
    } catch { /* statistics must never affect the stream */ }
  }

  private metricsFor(turnKey: string, turn: CursorTurn): RunMetricsTracker {
    const existing = this.trackers.get(turnKey);
    if (existing) return existing;
    const tracker = new RunMetricsTracker((step, run) => {
      const runId = turn.runId;
      const nativeMessageId = this.turnNativeMessageId(turn);
      this.emit({ type: 'metrics', metrics: step, run, ...(runId ? { runId } : {}), ...(nativeMessageId ? { nativeMessageId } : {}) });
      if (runId) this.persist(runId, run);
    });
    return rememberTracker(this.trackers, turnKey, tracker);
  }
}
