import type { NativeActivity, NativeStatus, Session } from '../../../../../packages/contracts/src/index.js';
import { activityId, isLiveActivity } from '../../journal/activity.js';
import type { NativeBackendHost, NativeControlMessage } from '../types.js';
import { ClaudeStepMetering } from './metering.js';
import { ClaudeTranscript, type ClaudeTranscriptLifecycle } from './history.js';
import { ClaudeTranscriptChanges, ClaudeTranscriptSource } from './transcript-source.js';
import { reduce, type ClaudeSessionState, type ClaudeSignal, type Transition } from './session-state.js';
import { TranscriptAdoption } from './title-adoption.js';
import { ClaudeSends } from './sends.js';

/** What the group takes from `ClaudeSessionRuntime`: values read on demand and callbacks, never the runtime itself. */
export interface ClaudeTranscriptReadsDeps {
  adoption: TranscriptAdoption;
  changes: ClaudeTranscriptChanges | undefined;
  host: NativeBackendHost;
  metering: ClaudeStepMetering;
  nativeSessionId: string;
  sends: ClaudeSends;
  transcript: ClaudeTranscript;
  disposed(): boolean;
  session(): Session;
  state(): ClaudeSessionState;
  status(): NativeStatus;
  applyLifecycle(lifecycle: ClaudeTranscriptLifecycle): Promise<void>;
  dispatchSignal(signal: ClaudeSignal, status?: Omit<NativeStatus, 'phase'>): Transition;
  emit(message: NativeControlMessage): void;
  noteActivity(): void;
  setStatus(requested: Omit<NativeStatus, 'phase'>): void;
}

/** Reading what the CLI wrote: one read at a time, its rows taken into the state, the title and the activities that follow from them. */
export class ClaudeTranscriptReads {
  private transcriptTask?: Promise<void>;
  /** The read queued behind the one in flight, shared by everyone who asked meanwhile. */
  private transcriptFollow?: Promise<void>;
  /** What the conversation was last named from (see `readTranscript`). */
  private titleInputs?: string;
  journalTurn?: { turnId: string; promptId?: string };

  constructor(private readonly deps: ClaudeTranscriptReadsDeps) {}

  /** The background agents the transcript's metadata still shows as working. */
  private syncBackground(): void {
    const agents = this.deps.transcript.backgroundAgents();
    const key = (list: Array<{ toolUseId: string }>) => list.map(agent => agent.toolUseId).sort().join('\n');
    const next = reduce(this.deps.state(), { type: 'background', agents }).state.background;
    if (key(next) === key(this.deps.state().background)) return;
    this.deps.dispatchSignal({ type: 'background', agents });
  }

  /** Adds a state of an activity that the rows do not show to the status summary. */
  publishActivity(activity: NativeActivity, options: { restored?: boolean } = {}): void {
    this.deps.transcript.injectActivity(activity, options);
    this.deps.setStatus(this.deps.status());
  }

  /**
   * A compaction the CLI is starting (its PreCompact hook). Rows it wrote before (a bare `/compact` up to 2.1.302) are
   * read first so the hook joins that compaction; since 2.1.322 there are none until its boundary. `promptId` is the
   * prompt the CLI is answering: an automatic compaction on one whose row is not on disk yet waits for that row.
   */
  async compactionHooked(trigger: 'manual' | 'auto', deliveryId: string, promptId: string | undefined): Promise<void> {
    await this.refreshTranscript().catch(() => undefined);
    if (this.deps.disposed()) return;
    const id = activityId('claude', `compaction:${deliveryId}`);
    const at = new Date().toISOString();
    if (trigger === 'manual') this.deps.sends.compactionStarted();
    this.deps.transcript.compactionHooked(id, trigger, at, promptId);
    await this.deps.host.transcript?.withSource(this.deps.session().id, (source, w) =>
      source instanceof ClaudeTranscriptSource ? source.compactionHooked(w, id, trigger, at, promptId) : undefined).catch(() => undefined);
    this.deps.dispatchSignal({ type: 'compact_start', origin: trigger === 'manual' ? 'human' : 'other' });
  }

  settleCompactions(status: 'failed' | 'stopped'): void {
    for (const activity of this.deps.transcript.activities()) {
      if (activity.kind === 'compaction' && isLiveActivity(activity)) this.publishActivity({ ...activity, status });
    }
  }

  /** A CLI that is gone took its background tasks and any compaction in progress with it. */
  abandonActivities(): void {
    for (const activity of this.deps.transcript.activities()) {
      if (isLiveActivity(activity)) this.publishActivity({ ...activity, status: 'unknown' });
    }
  }

  /**
   * Reads what the CLI has written since the last read. A caller that arrives while a read is under way gets one that
   * *starts after* the call: the read in flight may have begun before the row the caller is waiting for was on disk
   * (a Stop hook is posted before the last answer is flushed). `follow: false` is for the poll, which will be back soon enough.
   */
  async refreshTranscript(follow = true): Promise<void> {
    if (this.deps.disposed()) return;
    if (this.transcriptTask) {
      if (!follow) return await this.transcriptTask;
      if (!this.transcriptFollow) {
        const running = this.transcriptTask;
        const next = (async () => {
          await running.catch(() => undefined);
          this.transcriptFollow = undefined;
          await this.refreshTranscript(false);
        })();
        this.transcriptFollow = next;
      }
      return await this.transcriptFollow;
    }
    const task = this.readTranscript();
    this.transcriptTask = task;
    try { await task; }
    finally { if (this.transcriptTask === task) this.transcriptTask = undefined; }
  }

  private async readTranscript(): Promise<void> {
    const previousTranscriptState = this.deps.status().transcript;
    const sessionId = this.deps.nativeSessionId;
    const result = await this.deps.transcript.refresh();
    if (this.deps.disposed() || sessionId !== this.deps.nativeSessionId) return;
    if (result.reset || result.events.length) this.deps.noteActivity();
    if (!result.reset && result.events.length) {
      for (const event of result.events) {
        const commandId = typeof event.data.commandId === 'string' ? event.data.commandId : undefined;
        if (commandId) this.deps.sends.settleReceipt(commandId, event);
      }
    }
    // The records decide the turn. They follow the events they describe, so a Run is seen to start
    // before it is seen to end, and they are applied before anything below looks at the phase or wakes
    // the journal reader, so clients receive the busy status before or with the turn's output rows.
    await this.deps.applyLifecycle(result.lifecycle);
    if (result.reset || result.events.length || result.subagents.length) this.deps.changes?.emit(this.deps.session().id);
    if ((result.reset || result.events.length || result.lifecycle.replay) && this.deps.host.transcript) {
      this.journalTurn = await this.deps.host.transcript.withSource(this.deps.session().id, (source, w) => source instanceof ClaudeTranscriptSource ? source.activeTurn(w) : undefined);
      this.deps.setStatus(this.deps.status());
    }
    this.syncBackground();
    // A tail response stays `live` until a later row supersedes it. Once the turn is over, that
    // tail is settled too: the session is idle or the CLI is gone.
    this.deps.metering.publish(result.steps, this.deps.status().phase === 'idle' || this.deps.status().phase === 'offline');
    // A resumed conversation is first named from the human message its transcript replays, then
    // upgraded once Claude Code's own model has written a title into the transcript (see
    // `session-title.ts`; both patches are idempotent).
    // Keep the complete first prompt for language matching. The title stand-in is capped, and a
    // truncated English-only prefix can otherwise make an English provider title look compatible
    // with a Chinese conversation.
    // Both read the session from the store, so they run when the rows moved or what they name from did.
    const humanMessage = this.deps.transcript.firstHumanMessage();
    const titleInputs = `${humanMessage ?? ''}\u0000${this.deps.transcript.title ?? ''}\u0000${this.deps.transcript.titleRenamed}`;
    if (result.reset || result.events.length || titleInputs !== this.titleInputs) {
      this.titleInputs = titleInputs;
      if (humanMessage) this.deps.adoption.nameFromMessage(humanMessage);
      if (this.deps.transcript.title) this.deps.adoption.adoptTranscriptTitle(this.deps.transcript.title, humanMessage, this.deps.transcript.titleRenamed);
    }
    this.deps.adoption.adoptTranscriptGoal(this.deps.transcript.goal);
    for (const frame of result.subagents) if (frame.running !== undefined) this.deps.emit({ type: 'subagent', toolCallId: frame.toolCallId, agentId: frame.agentId, running: frame.running });
    if (this.deps.transcript.state !== previousTranscriptState) this.deps.setStatus({ ...this.deps.status(), transcript: this.deps.transcript.state });
    // Activities change with the rows (and with what the files add to them): the summary on the status follows.
    else if (result.reset || result.events.length) this.deps.setStatus(this.deps.status());
    // Tasks a CLI that is no longer running left in its transcript never report an end.
    if (this.deps.state().process === 'exited') this.abandonActivities();
  }
}
