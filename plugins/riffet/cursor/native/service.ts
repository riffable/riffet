import { readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApprovalMode, NativeInteractionResponse, NativeStatus, NativeStopRequest, NativeTurnTarget, NativeWorkbenchEvent, Session } from '@contracts';
import { AppError, KeyedTurnTrackers, firstMessageTitlePatch, nativeTitlePatch, type StatsSink } from '@riffet/plugin-api/kit';
import { type AgentProjectView, type AgentSessionView, type AgentTerminalControl, type AgentTurnStatus } from '@riffet/plugin-api/experimental/agent';
import { cursorAgentAdapter, CURSOR_AGENT_READY_PATTERN, cursorComposerHoldsPrompt, cursorPromptBar, cursorPromptBarEmpty } from '../cli-adapter.js';
import { approvalArgs, cursorLaunchSpec, runCursor, type CursorLaunchProfile } from '../cli-driver.js';
import type { CursorPort } from '../host-port.js';
import { strictInputHandle } from './strict-input-handle.js';
import { ChatReader, workspaceChatsDir, writeChatApproval, type ChatMeta } from './chat-store.js';
import { readJobLog } from './job-log.js';
import { cursorLoginPrompt, parseScreen, turnControls } from './screen.js';
import { normalizeNativeModelSelection } from './model-catalog.js';
import { MODEL_ID, parseModelList, describeModelListFailure } from './model-list.js';
import { Transcript, visible } from './transcript.js';
import type { CursorLive } from './live.js';
import {
  Watch, SCAN_INTERVAL_MS, LEFT_WATCH_MS, PASSIVE_POLL_MS, SUBAGENT_POLL_MS, SUBAGENT_IDLE_MS, OPEN_STORES_GRACE_MS, subagentWorking,
  STATE_SWEEP_MS, transcriptWorking, subviewPhase, stateForPhase, JOB_LOG_MS, jobPayload, latestTranscriptActivity, type Listener, type SubagentWatch,
  type ParentTranscriptBatch, type JobWatch, type WatchMessage,
} from './watch.js';
import { tryExec, openPaths, CHAT_STORE, workingChat } from './open-stores.js';
import { approvalFromFooter, adoptableApproval, configureGate, configureRefusal } from './configure-gate.js';

export { parseModelList, describeModelListFailure } from './model-list.js';
export { Transcript } from './transcript.js';
export { subagentWorking, transcriptWorking, subviewPhase } from './watch.js';
export { workingChat } from './open-stores.js';
export { approvalFromFooter, adoptableApproval, configureGate, type ConfigureVerdict } from './configure-gate.js';

export interface NativeServiceOptions {
  configDir: string;
  cliPath: string;
  profile?: CursorLaunchProfile;
  pollMs?: number;
  /** Ledger for settled usage and transcript events; the port's by default. */
  stats?: StatsSink;
  /** Where the CLIs it restarts write the step they stream (`live.ts`). */
  live?: CursorLive;
  /** Resolves the chat-store config directory for a project (standing conversations use an isolated dir). */
  configDirFor?(project: AgentProjectView): string;
  /** Extra profile, CLI args, and env for restarts (hooks, Riffet tools, standing isolation). */
  restartLaunch?(session: AgentSessionView, project: AgentProjectView): Promise<{ profile?: CursorLaunchProfile; args?: string[]; env?: Record<string, string>; paneEnv?: Record<string, string> } | undefined>;
}

/** The phase of each watched conversation goes through its tracker; the pane and transcript are its evidence. */
const cursorTurns = new KeyedTurnTrackers<object>();

export interface SettledCursorTurn {
  nativeSessionId: string;
  turnId?: string;
  rootId: string;
  error?: string;
}

/** Provider hooks supply identities; screen parsing continues to own the coarse UI phase. */
export interface NativeTurnObserver {
  activeTurn(session: AgentSessionView): NativeStatus['activeTurn'];
  /** A request reached the agent stream or became the current turn in the committed store. */
  requestStarted?(sessionId: string, chatId: string, turnId: string, fromStore: boolean): void;
  /** A provider outcome for this exact turn also allows a checkpoint ending on an incomplete step. */
  recordedOutcome?(sessionId: string, target: NativeTurnTarget): AgentTurnStatus | undefined;
  /** Events just read from the conversation's chat store, where a steer the CLI took leaves its context. */
  transcript?(session: AgentSessionView, events: NativeWorkbenchEvent[]): void;
  offline(session: AgentSessionView): void;
  /**
   * The same store and the normal CLI prompt have settled. The guard is checked again after the
   * journal reads the last messages, since the CLI can start another turn in the meantime.
   */
  answered?(session: AgentSessionView, answer: SettledCursorTurn, stillIdle: () => boolean): void;
  /**
   * The CLI is busy and no hook has named its turn. Some gateways never send `beforeSubmitPrompt`, so
   * without this the turn stays unnamed — and cannot be steered — until its first tool call.
   */
  unnamedBusy?(session: AgentSessionView): void;
}

/**
 * How long the prompt bar is polled for a written prompt before Enter is pressed regardless. The bar
 * takes the write within a frame when idle, but right after a cold `--resume` cursor-agent can block
 * its event loop for ~1–1.5 s while hydrating context; waiting long enough prevents Enter from
 * coalescing behind `\x1b[201~` in the same stdin chunk.
 */
const CURSOR_SUBMIT_VISIBLE_MS = 3_000;
/** How long `clearComposerInput` waits for a Ctrl+U/Ctrl+K edit key to visibly take effect on a non-empty bar. */
const CURSOR_CLEAR_WAIT_MS = 1_500;
/** Shorter settle bound for Ctrl+K when Ctrl+U left the bar unchanged (cursor at col 0 or unknown placeholder). */
const CURSOR_CLEAR_SETTLE_MS = 300;
/**
 * A pane with no prompt bar and no known dialog is usually a redraw, a resize or a notice that is
 * about to go. It keeps its last phase; past the first window the status says the screen is not
 * read, and only past the second does the session ask for the terminal.
 */
const UNRECOGNIZED_PANE_NOTICE_POLLS = 4;
/**
 * How long an answered store and an idle pane must both stay quiet before the turn counts as over.
 * Matches the window in which a late store write still belongs to the turn the pane last showed.
 */
const ANSWERED_SETTLE_MS = 3_000;
const UNRECOGNIZED_PANE_ATTENTION_POLLS = 16;
const UNRECOGNIZED_PANE_NOTICE = '暂时无法识别 CLI 终端画面，正在等待它恢复；如长时间无变化，请打开终端查看。';
/**
 * How long a CLI may boot without drawing its footer before the session asks for the terminal.
 * Behind a remote gateway a healthy cursor-agent takes 20–30 s to its first prompt, so a shorter
 * window flagged ordinary starts as stuck. The login screen is recognized on sight instead.
 */
const CURSOR_BOOT_STALL_MS = 60_000;

/** The bottom of a pane, enough to tell which dialog it was, for the server log. */
function paneTail(screen: string): string {
  return screen.split('\n').map(line => line.trimEnd().slice(0, 200)).filter(Boolean).slice(-16).map(line => `  | ${line}`).join('\n');
}
/** Poll spacing while waiting for the written prompt to appear in the bar. */
const CURSOR_SUBMIT_POLL_MS = 60;
/**
 * How long after an Enter the bar is read again. A taken prompt restores the placeholder within
 * 50 ms, so this leaves room for a slow frame without stalling a send that worked.
 */
const CURSOR_SUBMIT_RECHECK_MS = 200;
/**
 * After the first recheck the bar is read this often, for at most `CURSOR_SUBMIT_RECEIPT_MS`, while it holds the prompt.
 * Ends when the bar lets go of it (the CLI took it; the transcript echo is the dispatcher's receipt) or the window does.
 */
const CURSOR_SUBMIT_RECEIPT_RECHECK_MS = 2_000;
const CURSOR_SUBMIT_RECEIPT_MS = 12_000;
/** A write the bar never showed before the first Enter is watched closer and shorter: it either shows up soon or was taken. */
const CURSOR_SUBMIT_UNSEEN_RECHECK_MS = 500;
const CURSOR_SUBMIT_UNSEEN_MS = 3_000;
/** How many extra Enters one written prompt may cost while the bar keeps holding it. */
const CURSOR_SUBMIT_RESEND_LIMIT = 3;
/**
 * How long a stop may take to confirm. It covers the moment after a submit in which Ctrl+C cannot
 * act yet (a second or more until `ctrl+c to stop` shows), plus one repeated press.
 */
const CURSOR_INTERRUPT_TIMEOUT_MS = 15_000;
/** "Press Ctrl+C again to exit" stays up for about two seconds (2026.10.01); a press inside it quits. */
const CURSOR_EXIT_WINDOW_MS = 3_000;
/** Where `deliver` is about to write: the pane, and the chat the prompt continues. */
export interface DeliveryTarget { terminalId: string; epoch: number; chatId?: string }

/** What a watch announces after the session record changed; the host's own listeners read the record again. */
const sessionMessage = (session: AgentSessionView): WatchMessage => ({ type: 'session', session: session as Session });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === 'string' ? value : undefined);

/**
 * Hybrid native conversations. The real CLI keeps running in tmux (so every command, dialog and
 * subagent works exactly as in a terminal) while this service follows its chat store and
 * screen to give the browser a structured transcript, context usage and a coarse status.
 */
export class NativeService {
  private readonly watches = new Map<string, Watch>();
  /**
   * Live-step id abandoned by a confirmed stop. An idle pane must not treat that unsealed stream as
   * still working; a later step id is a new turn and is not ignored.
   */
  private readonly stoppedLiveSteps = new Map<string, string>();
  /** Each chat store's last-read metadata, keyed by path and valid while the store's files are unchanged. */
  private readonly chatMetas = new Map<string, { stamp: string; meta: ChatMeta }>();
  private readonly workspaceChatScans = new Map<string, { expiresAt: number; promise: Promise<Array<{ id: string; mtime: number; meta: ChatMeta }>> }>();
  private readonly pollMs: number;
  private readonly sweepTimer: NodeJS.Timeout;
  private sweeping = false;
  private modelResources = new Map<string, { models?: Array<{ value: string; name: string }>; error?: string; expiresAt: number; request?: Promise<Array<{ value: string; name: string }>> }>();
  /** Conversations with a deferred switch already queued for their next idle moment. */
  private readonly pendingConfigApplies = new Set<string>();
  /** Conversations currently mid-restart (`stop` + `launch`), so concurrent poll ticks stand down. */
  private readonly restartingSessions = new Set<string>();
  /** Terminals launched by `restart()` for a config switch that have not yet reached their idle prompt. */
  private readonly configBootTerminals = new Map<string, string>();
  private readonly stats: StatsSink;
  private readonly stopLiveMetrics?: () => void;
  private turnObserver?: NativeTurnObserver;

  constructor(private readonly port: CursorPort, private readonly options: NativeServiceOptions) {
    this.stats = options.stats ?? port.stats;
    this.pollMs = options.pollMs ?? 700;
    this.sweepTimer = setInterval(() => { void this.sweep(); }, STATE_SWEEP_MS);
    this.sweepTimer.unref();
    this.stopLiveMetrics = options.live?.watch?.(chatId => this.observeLiveMetrics(chatId));
  }

  private observeLiveMetrics(chatId: string, only?: Watch): void {
    const step = this.options.live?.read(chatId);
    if (!step) return;
    const targets = only ? [only] : [...this.watches.values()];
    for (const watch of targets) {
      if (watch.closed) continue;
      let watchChatId = watch.chat?.chatId;
      if (!watchChatId) {
        try { watchChatId = this.port.getSession(watch.sessionId).nativeSessionId; } catch { continue; }
      }
      if (watchChatId !== chatId) continue;
      this.turnObserver?.requestStarted?.(watch.sessionId, chatId, step.turn, false);
      watch.metrics.observeLiveStep(step);
    }
  }

  useTurnObserver(observer: NativeTurnObserver): void { this.turnObserver = observer; }

  sessionForChat(chatId: string): AgentSessionView | undefined {
    return this.port.listSessions().find(session => session.nativeSessionId === chatId);
  }

  /** Where the chat store being followed for this conversation leaves a turn (`Transcript.turnState`); `undefined` while no store of that chat is read. */
  turnState(sessionId: string, target: NativeTurnTarget): 'open' | 'answered' | 'superseded' | undefined {
    const chat = this.watches.get(sessionId)?.chat;
    return chat && chat.chatId === target.nativeSessionId && chat.status === 'ok' ? chat.turnState(target.turnId) : undefined;
  }

  /** Reconcile reads at a stop key even if file-watch notifications have not been delivered yet. */
  refreshTurnIdentity(session: AgentSessionView, expectedStop?: NativeStopRequest): void {
    const chatId = session.nativeSessionId;
    if (!chatId || !this.turnObserver?.requestStarted) return;
    const watch = this.watches.get(session.id);
    if (watch?.chat?.chatId === chatId) {
      const project = this.port.getProject(session.projectId);
      this.refreshParentTranscript(watch, session, workspaceChatsDir(this.configDirFor(project), project.cwd));
      const turn = watch.chat.turnId();
      if (turn) this.turnObserver.requestStarted(session.id, chatId, turn, true);
    }
    const step = this.options.live?.read(chatId);
    if (!step) return;
    this.turnObserver.requestStarted(session.id, chatId, step.turn, false);
    if (!expectedStop?.turnId || !step.prompt || step.turn === expectedStop.turnId || step.run === expectedStop.turnId) return;
    // The tap can see a different user request before either its hook or first checkpoint.
    // An older request can remain on disk; ignore it once its own end or successor is known.
    const streamed = { nativeSessionId: chatId, turnId: step.turn };
    if (!this.turnObserver.recordedOutcome?.(session.id, streamed) && this.turnState(session.id, streamed) !== 'superseded') {
      throw new AppError('NATIVE_STOP_TARGET_CHANGED', 'Could not confirm the original Cursor request before stopping', 409);
    }
  }

  private hasOpenTurn(sessionId: string): boolean {
    const active = this.turnObserver?.activeTurn(this.port.getSession(sessionId));
    if (!active) return false;
    const state = this.turnState(sessionId, active);
    return state === undefined || state === 'open';
  }

  /** Hook lifecycle changes must reach clients even while the tool writes no transcript. */
  notifyTurnChanged(sessionId: string): void {
    const watch = this.watches.get(sessionId);
    if (!watch || watch.closed) return;
    const activeTurn = this.turnObserver?.activeTurn(this.port.getSession(sessionId));
    const { activeTurn: _previous, ...status } = watch.status;
    const next = { ...status, ...(activeTurn ? { activeTurn } : {}) };
    if (JSON.stringify(next) !== JSON.stringify(watch.status)) {
      watch.status = next;
      watch.emit({ type: 'status', status: watch.status });
    }
    if (!activeTurn && watch.status.phase === 'busy') void this.tick(watch);
  }

  /** The live tap saw the CLI send a prompt to the agent server; announce `busy` immediately. */
  notePromptReceived(sessionId: string): void {
    this.configBootTerminals.delete(sessionId);
    const watch = this.watches.get(sessionId);
    if (!watch || watch.closed) return;
    watch.paneBusyAt = Date.now();
    if (watch.status.phase === 'busy' || watch.status.phase === 'attention') return;
    let session: AgentSessionView;
    try { session = this.port.getSession(sessionId); } catch { return; }
    const activeTurn = this.turnObserver?.activeTurn(session);
    const next: NativeStatus = {
      ...watch.status,
      phase: cursorTurns.report(watch, 'busy', 'transcript'),
      ...(activeTurn ? { activeTurn } : {}),
      ...(watch.transcript ? { transcript: watch.transcript } : {}),
    };
    if (JSON.stringify(next) !== JSON.stringify(watch.status)) {
      watch.status = next;
      watch.emit({ type: 'status', status: next });
    }
    this.followState(watch, session, next.phase);
  }

  subscribe(sessionId: string, listener: Listener): () => void {
    this.port.getSession(sessionId);
    const existed = this.watches.has(sessionId);
    const watch = this.ensureWatch(sessionId);
    watch.lastAccessAt = Date.now();
    watch.passiveUntil = 0;
    if (watch.idleTimer) { clearTimeout(watch.idleTimer); watch.idleTimer = undefined; }
    if (existed) {
      listener({ type: 'context', ...(watch.context ? { context: watch.context } : {}) });
      listener({ type: 'status', status: watch.status });
      for (const item of watch.subagents.values()) listener({ type: 'subagent', toolCallId: item.toolCallId, agentId: item.transcript.chatId, ...(item.subagentType ? { subagentType: item.subagentType } : {}), events: [], running: this.subagentRunning(watch, item) });
      for (const job of watch.jobs.values()) listener({ type: 'job', job: jobPayload(job) });
    }
    watch.listeners.add(listener);
    // A watch that was passive polled slowly; catch up now rather than at its next slow tick.
    if (existed) void this.tick(watch);
    const target = watch;
    return () => {
      target.listeners.delete(listener);
      // Switching conversations closes the stream; keep the decoded transcript briefly so coming
      // back is answered from memory instead of re-reading and re-mapping the CLI store.
      if (!target.listeners.size && this.watches.get(sessionId) === target) this.keepPassiveWatch(target, LEFT_WATCH_MS);
    };
  }

  private ensureWatch(sessionId: string, passive = false): Watch {
    let watch = this.watches.get(sessionId);
    if (!watch) {
      watch = new Watch(sessionId, this.stats);
      const created = watch;
      created.onSaveMetrics = (runId, metrics) => {
        try { this.port.saveRunMetrics(runId, metrics); } catch { /* a pruned run must not stop the transcript observer */ }
      };
      // The host's run lookups are asynchronous and these are read inside the transcript decoder: the port
      // answers from what an earlier ask found, and the decoder asks again with its next batch.
      created.onResolveRun = nativeMessageId => this.port.runIdForMessage(sessionId, nativeMessageId);
      created.onPromptSentAt = runId => this.port.inputSentAt(runId);
      watch.timer = setInterval(() => {
        if (!created.listeners.size && created.passiveUntil > 0 && Date.now() - created.lastTickAt < PASSIVE_POLL_MS) return;
        void this.tick(created);
      }, this.pollMs);
      watch.timer.unref();
      this.watches.set(sessionId, watch);
      void this.tick(watch);
    }
    if (passive && !watch.listeners.size) this.keepPassiveWatch(watch);
    return watch;
  }

  private keepPassiveWatch(watch: Watch, ms = 30_000): void {
    if (watch.listeners.size) return;
    watch.lastAccessAt = Date.now();
    const until = Math.max(watch.passiveUntil, Date.now() + ms);
    watch.passiveUntil = until;
    if (watch.idleTimer) clearTimeout(watch.idleTimer);
    watch.idleTimer = setTimeout(() => this.disposeWatch(watch), until - Date.now());
    watch.idleTimer.unref();
    const passive = [...this.watches.values()].filter((item) => !item.listeners.size && item.passiveUntil > 0).sort((a, b) => a.lastAccessAt - b.lastAccessAt);
    while (passive.length > 8) this.disposeWatch(passive.shift()!);
  }

  private disposeWatch(watch: Watch): void {
    if (watch.listeners.size || this.watches.get(watch.sessionId) !== watch) return;
    watch.close();
    this.watches.delete(watch.sessionId);
  }

  status(sessionId: string): NativeStatus {
    return this.watches.get(sessionId)?.status ?? { phase: 'offline' };
  }

  /** Passive read-only refresh of a session watch (creating a short-lived passive watch if absent) before recovery checks. */
  async refreshStatus(sessionId: string): Promise<void> {
    const watch = this.ensureWatch(sessionId, true);
    if (watch.closed) return;
    if (watch.ticking) await watch.tickPromise;
    else await this.tick(watch);
  }

  interaction(session: AgentSessionView) { return this.port.dialogs.current(session.id); }

  async respondInteraction(session: AgentSessionView, response: NativeInteractionResponse) {
    // Cursor's plan dialog is its agent/plan switch: answering "Yes, build …" is what leaves plan
    // mode, so the stored mode has to follow or the next relaunch would start planning again. Only
    // Cursor keeps plan in `mode`; Claude's plan is a permission the CLI reports back on its own.
    const leavesPlan = session.mode === 'plan' ? await this.approvesPlan(session, response) : false;
    const result = await this.port.dialogs.respond(session.id, response);
    if (leavesPlan && result.status !== 'uncertain') {
      this.port.updateSession(session.id, { mode: 'agent' });
      this.port.sessionChanged(session.id);
    }
    const watch = this.watches.get(session.id);
    if (watch && !watch.closed) await this.updateStatus(watch, this.port.getSession(session.id));
    return result;
  }

  /**
   * Whether this answer approves the plan rather than sending it back. The labels are the CLI's own
   * and `parsePlan` only lifts the dialog when they are exactly these, so the match stays honest.
   */
  private async approvesPlan(session: AgentSessionView, response: NativeInteractionResponse): Promise<boolean> {
    if (!response.action.startsWith('option:')) return false;
    const interaction = await this.port.dialogs.current(session.id).catch(() => null);
    if (interaction?.kind !== 'plan') return false;
    const optionId = response.action.slice('option:'.length);
    const label = interaction.options.find(option => option.id === optionId)?.label ?? '';
    return /^(?:\d+\.\s*)?Yes, build (?:locally|in cloud)$/.test(label);
  }

  /** The pane a prompt is written into, and the chat it continues as the watch has just read it. */
  private async deliveryTarget(sessionId: string, info: { id: string; epoch: number }): Promise<DeliveryTarget> {
    this.configBootTerminals.delete(sessionId);
    const watch = this.ensureWatch(sessionId);
    await this.tick(watch);
    return { terminalId: info.id, epoch: info.epoch, ...(watch.chat ? { chatId: watch.chat.chatId } : {}) };
  }

  /** Recheck and write under the existing terminal transaction; the callback commits the write fence, and is awaited before the write (`host.commitDispatchFence` is asynchronous). */
  async deliver(session: AgentSessionView, text: string, beforeWrite: (info: DeliveryTarget) => void | Promise<void>): Promise<void> {
    if (!session.terminalId) throw new AppError('TERMINAL_NOT_RUNNING', 'The CLI has not started', 409);
    await this.waitForPrompt(session.id, session.terminalId);
    await this.port.terminals.interact(session.terminalId, async (raw) => {
      // Submit path: writes that are silently rejected must throw, never resolve as success.
      const control = strictInputHandle(raw);
      const initial = await control.screen();
      if (this.port.findTerminal(session.terminalId!)?.ownerId && (!initial || parseScreen(initial).subview || !cursorPromptBarEmpty(initial))) {
        throw new AppError('CLI_BUSY', 'The terminal owner is editing the prompt', 409);
      }
      const screen = await this.leaveSubview(control, initial);
      const info = await this.port.terminals.get(session.terminalId!);
      const interaction = await this.port.dialogs.current(session.id);
      if (interaction) throw new AppError('CLI_INTERACTION_REQUIRED', 'Finish the current selection first', 409);
      if (!screen || parseScreen(screen).phase !== 'idle' || turnControls(screen).followUps || this.hasOpenTurn(session.id)) {
        throw new AppError('CLI_BUSY', 'The CLI is not idle yet; the message stays queued', 409);
      }
      await this.clearComposerInput(control, screen);
      await beforeWrite(await this.deliveryTarget(session.id, info));
      // Write, then submit: `paste(text, true)` presses Enter 80 ms after the bytes, and a press that
      // arrives before the CLI has taken the write goes nowhere. The prompt bar is the arbiter.
      await control.paste(text, false);
      await this.submitPaste(control, text);
    });
  }

  /**
   * Press Enter once the prompt bar shows the write, and again while it keeps showing it.
   *
   * cursor-agent fills the bar within a frame — measured at +0 ms against 2026.09.28, unlike Claude
   * Code, which collapses a multi-line paste a few hundred milliseconds later — so the wait below is
   * only for a slow repaint. The press still cannot be assumed to have landed: it is written to a
   * tmux pane, and a CLI that is mid-repaint or still reading the paste can drop it, after which the
   * message sits in the bar and the run waits for a transcript echo that never comes. The bar says
   * which happened: a prompt the CLI took leaves it (placeholder back within 50 ms), a prompt it
   * never took stays there. `CURSOR_SUBMIT_RESEND_LIMIT` bounds the presses; past that the CLI is
   * left alone and the dispatcher's own confirmation decides the run.
   */
  private async submitPaste(control: AgentTerminalControl, text: string): Promise<void> {
    const shown = await this.waitForComposerText(control, text);
    await control.keys(['Enter']);
    if (!text) return;
    // The bar stays the arbiter for a bounded window: a paste that renders late, or a screen read that fails once, must not
    // end the send with the prompt sitting in the bar. Enter is pressed again only while the bar shows our own prompt. An
    // empty bar means the CLI took the prompt only once the bar was seen holding it; before that it may not have drawn it yet.
    const deadline = Date.now() + (shown ? CURSOR_SUBMIT_RECEIPT_MS : CURSOR_SUBMIT_UNSEEN_MS);
    let presses = 0, wait = CURSOR_SUBMIT_RECHECK_MS;
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, wait));
      wait = shown ? CURSOR_SUBMIT_RECEIPT_RECHECK_MS : CURSOR_SUBMIT_UNSEEN_RECHECK_MS;
      // A read that starts at or after the deadline is the final probe, however late the loop got here.
      const final = Date.now() >= deadline;
      const screen = await control.screen().catch(() => undefined);
      if (screen !== undefined) {
        if (cursorComposerHoldsPrompt(screen, text)) {
          // Past the last press the CLI is left alone, and the terminal with it; the dispatcher's confirmation decides.
          if (presses >= CURSOR_SUBMIT_RESEND_LIMIT) return;
          presses += 1;
          await control.keys(['Enter']);
        } else if (shown || presses > 0) return;
      }
      if (final) return;
    }
  }

  /** Whether the prompt bar showed the write, waited for with a final read after the deadline; a bar that never shows it is pressed anyway. */
  private async waitForComposerText(control: AgentTerminalControl, text: string): Promise<boolean> {
    if (!text) return true;
    const deadline = Date.now() + CURSOR_SUBMIT_VISIBLE_MS;
    for (;;) {
      const final = Date.now() >= deadline;
      const screen = await control.screen().catch(() => undefined);
      if (screen !== undefined && cursorComposerHoldsPrompt(screen, text)) return true;
      if (final) return false;
      await new Promise(resolve => setTimeout(resolve, CURSOR_SUBMIT_POLL_MS));
    }
  }

  /** Back out of the TUI's subagent view, where typing reaches no prompt bar; returns the screen after. */
  private async leaveSubview(control: AgentTerminalControl, screen: string | undefined): Promise<string | undefined> {
    if (screen === undefined || !parseScreen(screen).subview) return screen;
    await control.keys(['Escape']);
    const deadline = Date.now() + CURSOR_SUBMIT_VISIBLE_MS;
    let current = screen;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, CURSOR_SUBMIT_POLL_MS));
      current = await control.screen().catch(() => undefined) ?? current;
      if (!parseScreen(current).subview) return current;
    }
    return current;
  }

  /**
   * The web composer owns a complete prompt, never a suffix of a restored CLI draft.
   *
   * When the prompt bar already shows cursor-agent's empty placeholder, send no editing keys at all:
   * cursor-agent's Ctrl+U handler matches `e.startsWith("\u0015")` and returns early, discarding any
   * trailing bytes in the same stdin chunk. During a brief event-loop stall (such as ~1–1.5 s right
   * after cold `--resume`), an unnecessary `C-u` sits unread in the PTY buffer and coalesces with the
   * subsequent bracketed paste, silently dropping the entire prompt.
   *
   * When a draft is present (or the placeholder is unrecognized), send `C-u` then `C-k` as separate
   * writes and poll for the bar to repaint between them (bounded, never failing closed with
   * `CLI_INPUT_NOT_EMPTY`) so `\x15` is consumed before the paste is written.
   */
  private async clearComposerInput(control: AgentTerminalControl, initial: string, beforeWrite?: () => void | Promise<void>): Promise<void> {
    if (!initial || parseScreen(initial).phase !== 'idle') throw new AppError('CLI_BUSY', 'The CLI input is not ready yet', 409);
    if (cursorPromptBarEmpty(initial)) return;
    await beforeWrite?.();
    await control.keys(['C-u']);
    const afterCu = await this.waitForClearStep(control, initial, CURSOR_CLEAR_WAIT_MS);
    if (afterCu && parseScreen(afterCu).phase !== 'idle') throw new AppError('CLI_BUSY', 'The CLI input is not ready yet', 409);
    await beforeWrite?.();
    await control.keys(['C-k']);
    const ckTimeout = afterCu === undefined || cursorPromptBarEmpty(afterCu)
      ? CURSOR_SUBMIT_POLL_MS
      : cursorPromptBar(afterCu) !== cursorPromptBar(initial)
        ? CURSOR_CLEAR_WAIT_MS
        : CURSOR_CLEAR_SETTLE_MS;
    const after = await this.waitForClearStep(control, afterCu ?? initial, ckTimeout);
    if (!after || parseScreen(after).phase !== 'idle') throw new AppError('CLI_BUSY', 'The CLI input is not ready yet', 409);
  }

  /** Wait up to `timeoutMs` for an editing key to change or empty the prompt bar (or leave idle). */
  private async waitForClearStep(control: AgentTerminalControl, before: string, timeoutMs: number): Promise<string | undefined> {
    const beforeBar = cursorPromptBar(before);
    const deadline = Date.now() + timeoutMs;
    let current: string | undefined;
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, CURSOR_SUBMIT_POLL_MS));
      current = await control.screen().catch(() => undefined);
      if (current !== undefined && (parseScreen(current).phase !== 'idle' || cursorPromptBarEmpty(current) || cursorPromptBar(current) !== beforeBar)) {
        return current;
      }
      if (Date.now() >= deadline) return current;
    }
  }

  /**
   * Confirm a stop against the live pane; never send Ctrl+C to an idle CLI.
   *
   * A Ctrl+C is pressed only while the prompt bar says `ctrl+c to stop`. Right after a submit the
   * spinner is up but the hint is not, and a Ctrl+C then cancels nothing: it only arms "Press
   * Ctrl+C again to exit", during which a second one quits the CLI. So the stop waits for the hint,
   * and a press that did not take is repeated once, after the exit window has closed.
   */
  async interrupt(session: AgentSessionView, options: { clearPrompt?: boolean; expectedStop?: NativeStopRequest; beforeWrite?: (allowEnded?: boolean) => void | Promise<void> } = {}): Promise<void> {
    if (!session.terminalId) return;
    const id = session.terminalId;
    const guard = options.beforeWrite && ((allowEnded?: boolean) => {
      this.refreshTurnIdentity(this.port.getSession(session.id), options.expectedStop);
      return options.beforeWrite!(allowEnded);
    });
    // A late poll extends the deadline, and the pane is read once more after it. A bare
    // `while (Date.now() < deadline)` drops the stop that landed while the loop was stalled.
    let deadline = Date.now() + CURSOR_INTERRUPT_TIMEOUT_MS;
    let stallUsed = 0;
    const pause = async (ms: number) => {
      const sleptFrom = Date.now();
      await new Promise<void>(resolve => setTimeout(resolve, ms));
      const late = Date.now() - sleptFrom - ms;
      if (late > 0 && stallUsed < CURSOR_INTERRUPT_TIMEOUT_MS) {
        const moved = Math.min(late, CURSOR_INTERRUPT_TIMEOUT_MS - stallUsed);
        stallUsed += moved;
        deadline += moved;
      }
    };
    let sentInterrupt = false, dismissed = false, idleSamples = 0, clearingPrompt = false, confirmed = false;
    let presses = 0, pressedAt = 0;
    const retryable = new Set(['TERMINAL_INTERACTION_BUSY', 'TERMINAL_INTERACTION_STALE', 'TERMINAL_DETACHED']);
    for (;;) {
      const initial = await this.port.terminals.get(id);
      if (initial.state === 'exited') { confirmed = true; break; }
      if (Date.now() >= deadline) break;
      try {
        await this.port.terminals.interact(id, async control => {
          for (;;) {
            // The read after a sleep that crossed the deadline is the final probe: it can confirm
            // idle, and it does not press another key.
            const overdue = Date.now() >= deadline;
            const screen = await control.screen();
            const parsed = screen ? parseScreen(screen) : undefined;
            if (parsed?.subview && !overdue) {
              await guard?.();
              await this.leaveSubview(control, screen);
              continue;
            }
            if (parsed?.phase === 'idle' && !turnControls(screen!).followUps) {
              // The first idle frame can precede a generation's spinner. After a stop key, wait for two idle frames.
              const stopped = sentInterrupt || !this.hasOpenTurn(session.id);
              if (stopped && ((!sentInterrupt && !dismissed) || ++idleSamples >= 2)) {
                if (options.clearPrompt) {
                  // Clearing mutates the CLI's draft. If the lease changes during that operation,
                  // leave it for a deliberate retry instead of risking new browser text.
                  clearingPrompt = true;
                  await guard?.(true);
                  await this.clearComposerInput(control, screen!, () => guard?.(true));
                }
                return;
              }
            } else if (!overdue) {
              idleSamples = 0;
              const controls = parsed?.phase === 'busy' ? turnControls(screen!) : undefined;
              if (controls?.stoppable && (presses === 0 || (presses < 2 && Date.now() - pressedAt >= CURSOR_EXIT_WINDOW_MS))) {
                // Count the press before awaiting the key: a stale post-write lease error must not
                // turn into an extra Ctrl+C that could land inside the exit window.
                sentInterrupt = true;
                presses += 1;
                pressedAt = Date.now();
                await guard?.();
                await control.keys(['C-c']);
              } else if (screen && parsed?.phase === 'attention' && !dismissed && await this.port.dialogs.current(session.id)) {
                dismissed = true;
                await guard?.();
                await control.keys(['Escape']);
              }
            } else {
              idleSamples = 0;
            }
            if (overdue) throw new AppError('CLI_INTERRUPT_TIMEOUT', 'Could not confirm that the turn stopped; try again shortly', 409);
            await pause(150);
          }
        });
        confirmed = true;
        break;
      } catch (error) {
        // A target guard refusal remains authoritative even if a replacement process exited.
        if (error instanceof AppError && error.code === 'NATIVE_STOP_TARGET_CHANGED') throw error;
        // A browser claim/release may change the control epoch during an observation. Retry only
        // before draft cleanup; a sent Ctrl+C is remembered and never repeated across leases.
        const latest = await this.port.terminals.get(id).catch(() => undefined);
        if (latest?.id === id && latest.state === 'exited') { confirmed = true; break; }
        const code = error instanceof AppError ? error.code : '';
        if (clearingPrompt || !retryable.has(code)) throw error;
        idleSamples = 0;
        if (Date.now() + 80 >= deadline) break;
        await pause(80);
      }
    }
    if (!confirmed) {
      const latest = await this.port.terminals.get(id).catch(() => undefined);
      if (latest?.id === id && latest.state === 'exited') confirmed = true;
    }
    if (!confirmed) throw new AppError('CLI_INTERRUPT_TIMEOUT', 'Could not confirm that the turn stopped; try again shortly', 409);
    const current = this.port.getSession(session.id);
    const liveStep = current.nativeSessionId ? this.options.live?.read(current.nativeSessionId) : undefined;
    if (liveStep) this.stoppedLiveSteps.set(session.id, liveStep.step);
    const watch = this.watches.get(session.id);
    // Keeps a store write from the aborted turn from satisfying `transcriptWorking`
    // (`lastActivityAt > paneBusyAt + TRANSCRIPT_SETTLE_MS`). The unsealed live step is remembered
    // above so that same idle pane is not reported busy.
    if (watch) watch.paneBusyAt = Date.now();
    if (watch && !watch.closed) await this.updateStatus(watch, current);
  }

  /** Native variants constrain capabilities advertised by the shared parameterized catalog. */
  private modelResourceKey(project: Pick<AgentProjectView, 'cwd'>): string {
    return JSON.stringify([this.options.profile?.identityKey??this.options.cliPath, this.options.configDir, project.cwd]);
  }

  /** Why the latest model list for this project came back empty, if it did. */
  modelListError(project: Pick<AgentProjectView, 'cwd'>): string | undefined {
    return this.modelResources?.get(this.modelResourceKey(project))?.error;
  }

  /**
   * A list the same launcher and data directory read in another directory. `--list-models` takes
   * seconds and a projectless task is a new directory every time; a first launch there uses this
   * one while its own list is read behind it.
   */
  private siblingModels(key: string): Array<{ value: string; name: string }> | undefined {
    // Keys are JSON arrays whose last item is the directory: the same launcher is the same prefix.
    const launcher = this.modelResourceKey({ cwd: '' }).slice(0, -3);
    let best: { models: Array<{ value: string; name: string }>; expiresAt: number } | undefined;
    for (const [other, resource] of this.modelResources ?? []) {
      if (other === key || !other.startsWith(launcher) || !resource.models?.length) continue;
      if (!best || resource.expiresAt > best.expiresAt) best = { models: resource.models, expiresAt: resource.expiresAt };
    }
    return best?.models;
  }

  async models(project: Pick<AgentProjectView, 'cwd'>): Promise<Array<{ value: string; name: string }>> {
    const key = this.modelResourceKey(project);
    this.modelResources ??= new Map();
    let resource = this.modelResources.get(key);
    const stale = resource?.models?.length ? resource.models : resource ? undefined : this.siblingModels(key);
    if (resource?.request) return stale ?? resource.request;
    if (resource && resource.expiresAt > Date.now()) return resource.models ?? [];
    // `--list-models` takes seconds; an expired list is still served while it refreshes behind.
    resource ??= { expiresAt: 0 };
    this.modelResources.set(key, resource);
    const current = resource;
    const request = (async () => {
      const timeoutMs = 20_000;
      const result = await runCursor(this.options.profile??this.options.cliPath, ['--list-models'], { cwd: project.cwd, timeoutMs, maxOutputBytes: 512 * 1024 }).catch(() => undefined);
      const listed = result?.code === 0 && result.stdout ? parseModelList(result.stdout) : [];
      const models = listed.length ? listed : current.models ?? [];
      current.models = models;
      current.error = listed.length ? undefined : describeModelListFailure(result, this.options.profile?.executable ?? this.options.cliPath, timeoutMs);
      current.expiresAt = Date.now() + (listed.length ? 10 * 60_000 : 3000);
      return models;
    })().finally(() => { current.request = undefined; });
    current.request = request;
    return stale ?? request;
  }

  async prepareModel(model: string | undefined, project: Pick<AgentProjectView, 'cwd'>): Promise<string | undefined> {
    if (!model) return undefined;
    if (!MODEL_ID.test(model)) throw new AppError('INVALID_MODEL', 'Model id is invalid');
    return normalizeNativeModelSelection(model, await this.models(project));
  }

  async validateModel(model: string | undefined, project: Pick<AgentProjectView, 'cwd'>): Promise<void> {
    await this.prepareModel(model, project);
  }

  /**
   * Switch the CLI's model without opening its terminal picker.
   */
  async setModel(session: AgentSessionView, model: string): Promise<AgentSessionView> {
    return this.configure(session, { model });
  }

  /** Switch the CLI's approval mode (`--force` / `--auto-review`) the same way as the model. */
  async setApproval(session: AgentSessionView, approval: ApprovalMode): Promise<AgentSessionView> {
    return this.configure(session, { approval });
  }

  async setMode(session: AgentSessionView, mode: string): Promise<AgentSessionView> {
    return this.configure(session, { mode });
  }

  /** Apply the selected Cursor settings together so a running TUI is restarted only once. */
  async configure(session: AgentSessionView, patch: { model?: string; mode?: string; approval?: string }): Promise<AgentSessionView> {
    if (session.archivedAt) throw new AppError('ARCHIVED_SESSION', 'Restore this conversation before switching', 409);
    if (patch.model !== undefined && !MODEL_ID.test(patch.model)) throw new AppError('INVALID_MODEL', 'Model id is invalid');
    if (patch.mode !== undefined && !['agent', 'plan', 'ask'].includes(patch.mode)) throw new AppError('INVALID_MODE', 'Choose a supported Cursor mode');
    if (patch.approval !== undefined) approvalArgs(patch.approval);
    const preparedModel = patch.model === undefined ? undefined : await this.prepareModel(patch.model, this.port.getProject(session.projectId));
    if (patch.model !== undefined && !preparedModel) throw new AppError('INVALID_MODEL', 'Model id is invalid');
    const normalizedPatch = { ...patch, ...(preparedModel !== undefined ? { model: preparedModel } : {}) };
    if (!session.terminalId || (await this.port.terminals.get(session.terminalId)).state === 'exited') {
      return this.port.updateSession(session.id, { ...normalizedPatch, error: undefined, state: 'idle' });
    }
    // A turn in flight keeps the settings it started with: changing them means relaunching the CLI,
    // which would kill that turn. So the switch is recorded and applied at the first idle moment —
    // the same promise a not-yet-started CLI already gets from the branch above, and what the user
    // asked for when they changed the picker mid-turn. `configPending` is what carries that promise
    // across a workbench restart, when the CLI is still running behind its persistent terminal.
    if (await this.mustDeferConfig(session)) {
      return this.port.updateSession(session.id, { ...normalizedPatch, configPending: true, error: undefined });
    }
    try {
      return await this.restart(session, normalizedPatch);
    } catch (error) {
      // The pane can start a turn between the check above and the relaunch. Deferring is still the
      // right answer — the settings are recorded and the next idle moment applies them — so a switch
      // asked for at the wrong millisecond is queued rather than refused.
      if (error instanceof AppError && (error.code === 'CLI_BUSY' || error.code === 'CLI_NEEDS_ATTENTION')) {
        return this.port.updateSession(session.id, { ...normalizedPatch, configPending: true, error: undefined });
      }
      throw error;
    }
  }

  /**
   * Whether a switch has to wait for the CLI to be free.
   *
   * Two things must hold before the CLI can be relaunched: nothing of ours may be on its way to it (a
   * run that left the queue owns the pane until it is confirmed), and the pane itself must be idle.
   * `offline` is not evidence of idleness — nothing has read it — so the screen answers instead.
   */
  private async mustDeferConfig(session: AgentSessionView): Promise<boolean> {
    if ((await this.port.unfinishedRuns(session.id)).some(run => (run.delivery ?? 'queued') !== 'queued')) return true;
    const phase = this.status(session.id).phase;
    const screenPhase = phase === 'offline' && session.terminalId ? await this.screenPhase(session.terminalId) : undefined;
    const verdict = configureGate({ phase, screenPhase });
    if (verdict === 'starting' && session.terminalId && this.configBootTerminals.get(session.id) === session.terminalId) {
      return false;
    }
    if (verdict !== 'proceed') this.configBootTerminals.delete(session.id);
    return verdict !== 'proceed';
  }

  /**
   * Applies a switch that had to wait, the moment the CLI is free again.
   *
   * Called from the two places that already read a pane: a watched conversation's tick and the sweep
   * over conversations nobody subscribes to. Applying it off the tick rather than inside it keeps the
   * restart — which drops the watch's chat, transcript and busied state — out of the middle of a pass
   * that is still using them.
   */
  private schedulePendingConfig(session: AgentSessionView): void {
    if (!session.configPending || this.pendingConfigApplies.has(session.id)) return;
    this.pendingConfigApplies.add(session.id);
    setTimeout(() => {
      this.pendingConfigApplies.delete(session.id);
      void this.applyPendingConfig(session.id).catch(() => undefined);
    }, 0);
  }

  /**
   * Relaunches the CLI with the recorded settings, once nothing is running and the pane is idle.
   * Runs under the same session lock as start/send/configure; everything is re-read once it is held.
   */
  private async applyPendingConfig(sessionId: string): Promise<void> {
    const pending = (session: AgentSessionView) => Boolean(session.configPending) && !session.archivedAt && Boolean(session.terminalId);
    if (!pending(this.port.getSession(sessionId))) return;
    await this.port.withSessionLock(sessionId, async () => {
      const session = this.port.getSession(sessionId);
      if (!pending(session) || await this.mustDeferConfig(session)) return;
      await this.restart(session, {});
    }, { detached: true });
  }

  /**
   * The phase the pane itself shows, for the moments when no watch has read it yet.
   *
   * A footer-less pane is reported as `starting` rather than as the parser's `attention`: the footer
   * is absent precisely while the CLI boots or the resume picker is up, and both are "not ready to be
   * restarted" rather than "a dialog is waiting for you".
   */
  private async screenPhase(terminalId: string): Promise<NativeStatus['phase'] | undefined> {
    const screen = await this.port.terminals.screen(terminalId).catch(() => undefined);
    if (screen === undefined) return undefined;
    const parsed = parseScreen(screen);
    return parsed.footer ? parsed.phase : 'starting';
  }

  /**
   * Restarts the CLI with different launch flags, resuming the same chat.
   *
   * Neither the model nor the approval mode has a protocol-level setter: `/model` is a TUI picker,
   * `/run-everything` its own toggle, and writing the CLI's private config would be a private-state
   * write. The supported lever is the launch flag, which means restarting the terminal — only safe
   * while the CLI is idle, since otherwise the restart would drop the turn in flight.
   */
  private async restart(session: AgentSessionView, patch: { model?: string; mode?: string; approval?: string }): Promise<AgentSessionView> {
    if (session.archivedAt) throw new AppError('ARCHIVED_SESSION', 'Restore this conversation before switching', 409);
    if (!session.terminalId) throw new AppError('TERMINAL_NOT_RUNNING', 'Open the Cursor terminal before switching', 409);
    const phase = this.status(session.id).phase;
    // `offline` means nothing has read this pane, not that it is free; ask the screen before deciding.
    const screenPhase = phase === 'offline' ? await this.screenPhase(session.terminalId) : undefined;
    const verdict = configureGate({ phase, screenPhase });
    const isConfigBoot = verdict === 'starting' && this.configBootTerminals.get(session.id) === session.terminalId;
    if (!isConfigBoot && verdict !== 'proceed') {
      this.configBootTerminals.delete(session.id);
      throw configureRefusal(verdict);
    }
    const project = this.port.getProject(session.projectId);
    const model = patch.model === undefined ? session.model : await this.prepareModel(patch.model, project);
    const modelPatch = model !== undefined && (patch.model !== undefined || model !== session.model) ? { model } : {};
    const normalizedPatch = { ...patch, ...modelPatch };
    const next = { ...session, ...normalizedPatch };
    this.restartingSessions.add(session.id);
    try {
      await this.port.terminals.stop(session.terminalId);
      const extras = await this.options.restartLaunch?.(next, project).catch(() => undefined);
      const launchProfile = extras?.profile ?? this.options.profile ?? this.options.cliPath;
      const effectiveConfigDir = extras?.profile?.configDir ?? this.configDirFor(project);
      writeChatApproval(effectiveConfigDir, project.cwd, session.nativeSessionId, next.approval);
      // A restart has to say everything again: the mode and the approval mode are launch flags, and
      // dropping them would silently move the conversation back to the plain agent/allowlist default.
      // The argv comes from the adapter that owns it, so the launch flags cannot drift between the
      // first start and every switch after it. `resumePicker` is false because this conversation is
      // already bound: the picker rule that keeps `--model` off a *new* picker launch would here drop
      // the very model the user just asked for.
      const info = await this.port.terminals.launch(session.id, {
        ...cursorLaunchSpec(launchProfile, [
          ...(session.nativeSessionId ? ['--resume', session.nativeSessionId] : []),
          ...extras?.args ?? [],
          ...cursorAgentAdapter.buildArgs({
            resumePicker: false,
            hasStoredSession: Boolean(session.nativeSessionId),
            mode: next.mode,
            approval: next.approval,
            model: next.model,
          }),
        ], extras?.env ?? {}, project.cwd, { paneEnv: { ...this.options.live?.launchEnv(), ...extras?.paneEnv } }),
        kind: 'cursor',
        reuseLive: true,
      });
      this.configBootTerminals.set(session.id, info.id);
      // The pane restarted, so drop pane-level state from the old process and re-read on the next tick;
      // keep `watch.chat` when resuming the same chatId so the SQLite history is not re-parsed from scratch.
      const watch = this.watches.get(session.id);
      if (watch) {
        if (watch.chat && watch.chat.chatId !== session.nativeSessionId) {
          watch.chat.close();
          watch.chat = undefined;
          watch.transcript = undefined;
        }
        for (const item of watch.subagents.values()) item.transcript.close();
        watch.subagents.clear();
        watch.jobs.clear();
        watch.notice = undefined;
        watch.booted = undefined;
        watch.unrecognized = undefined;
      }
      return this.port.updateSession(session.id, { terminalId: info.id, state: 'running', ...normalizedPatch, configPending: false });
    } finally {
      this.restartingSessions.delete(session.id);
    }
  }

  /**
   * A freshly started CLI needs a few seconds before its prompt bar accepts input, and text
   * pasted into a dialog would answer the dialog instead. The write lease checks whether the prompt is idle.
   */
  private async waitForPrompt(sessionId: string, terminalId: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let wake: (() => void) | undefined;
    const unsubscribe = this.port.terminals.observe(terminalId, () => wake?.());
    try { for (;;) {
      // Terminal processes can exit between polls. Do not leave a sender waiting for the full
      // startup timeout after the pane has already reported that its CLI process is gone.
      const info = await this.port.terminals.get(terminalId);
      if (info.state === 'exited') throw new AppError('TERMINAL_NOT_RUNNING', 'The CLI exited; reopen the conversation', 409);
      const screen = await this.port.terminals.screen(terminalId);
      const interaction = await this.port.dialogs.current(sessionId);
      if (interaction) throw new AppError('CLI_INTERACTION_REQUIRED', 'Finish the current selection in the interaction card before sending; the message was not sent', 409, { interaction });
      const parsed = screen === undefined ? undefined : parseScreen(screen);
      // The subagent view is left by whoever writes, under the interaction lease.
      if (parsed && (parsed.phase === 'idle' || parsed.phase === 'busy' || parsed.subview)) return;
      if (Date.now() > deadline) throw new AppError('CLI_NEEDS_ATTENTION', 'The CLI is not ready, or the screen is not a recognized web interaction; check the conversation status or the terminal. The message was not sent', 409);
      await new Promise<void>((done) => {
        const timer = setTimeout(finish, 300);
        function finish() { clearTimeout(timer); wake = undefined; done(); }
        wake = finish;
      });
    } } finally { unsubscribe?.(); }
  }

  closeAll(): void {
    clearInterval(this.sweepTimer);
    this.stopLiveMetrics?.();
    for (const watch of this.watches.values()) watch.close();
    this.watches.clear();
    this.stoppedLiveSteps.clear();
    this.restartingSessions.clear();
    this.configBootTerminals.clear();
    this.workspaceChatScans.clear();
    this.chatMetas.clear();
  }

  /**
   * Keeps the state of conversations nobody is watching fresh.
   *
   * Watching stops when a conversation is closed, but its CLI carries on: one that finishes its
   * turn while another conversation is open would keep looking busy, so the sidebar would spin
   * forever. The CLI's own footer is read once it has been painted. Before marking an idle parent
   * finished, start a passive transcript watch so background subagents are accounted for too.
   */
  private async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      for (const session of this.port.listSessions()) {
        if (session.archivedAt || this.watches.has(session.id)) continue;
        if (!['running', 'starting', 'waiting'].includes(session.state)) continue;
        const info = session.terminalId ? this.port.findTerminal(session.terminalId) : undefined;
        if (!info || info.kind !== 'cursor' || info.state === 'exited') {
          this.configBootTerminals.delete(session.id);
          continue;
        }
        const screen = await this.port.terminals.screen(info.id);
        if (screen === undefined) continue;
        const { footer, subview, ...parsed } = parseScreen(screen);
        const configBoot = this.configBootTerminals.get(session.id) === info.id;
        if (subview) {
          if (configBoot) this.configBootTerminals.delete(session.id);
          const state = stateForPhase(subviewPhase({ working: subview.working, previous: session.state === 'running' ? 'busy' : 'offline' }));
          if (state && state !== session.state) this.port.updateSession(session.id, { state });
          continue;
        }
        if (!footer) continue;
        if (configBoot) {
          if (parsed.phase !== 'idle' || !CURSOR_AGENT_READY_PATTERN.test(screen)) continue;
          this.configBootTerminals.delete(session.id);
        }
        const state = stateForPhase(parsed.phase);
        if (state === 'idle' && session.nativeSessionId) this.ensureWatch(session.id, true);
        else if (state && state !== session.state) this.port.updateSession(session.id, { state });
        // Nobody subscribes to this conversation, so this pane is the only witness to a mode the user
        // changed in the CLI — and the next `restart` re-applies what the record says, which would
        // silently undo it. Follow it here for the same reason a watched conversation follows its
        // footer, counter included (see `followApproval`).
        const approval = adoptableApproval(footer, parsed.permission);
        const current = this.port.getSession(session.id);
        if (!current.configPending && current.approval !== 'dontAsk' && approval && approval !== current.approval) {
          this.port.bumpConfig(session.id, { approval });
        }
        // Nobody subscribes to this conversation, so this sweep is the only thing that will notice
        // its CLI going idle — a switch deferred mid-turn has to be applied from here.
        this.schedulePendingConfig(this.port.getSession(session.id));
      }
    } catch {
      /* Best-effort: the next sweep retries. */
    } finally {
      this.sweeping = false;
    }
  }

  private configDirFor(project: AgentProjectView): string {
    return this.options.configDirFor?.(project) ?? this.options.configDir;
  }

  private async tick(watch: Watch): Promise<void> {
    if (watch.closed) return;
    if (watch.ticking) {
      let session: AgentSessionView;
      try { session = this.port.getSession(watch.sessionId); }
      catch { await watch.tickPromise; return; }
      if (watch.chat?.chatId === session.nativeSessionId) {
        const project = this.port.getProject(session.projectId);
        this.refreshParentTranscript(watch, session, workspaceChatsDir(this.configDirFor(project), project.cwd));
        return;
      }
      // A chat switch still belongs to the in-flight maintenance pass. Coalesce callers on one
      // promise instead of accumulating one resolver per polling interval.
      await watch.tickPromise;
      return;
    }
    watch.ticking = true;
    watch.lastTickAt = Date.now();
    watch.tickPromise = new Promise<void>((resolve) => { watch.resolveTick = resolve; });
    try {
      let session: AgentSessionView;
      try { session = this.port.getSession(watch.sessionId); }
      catch { watch.emit({ type: 'status', status: { phase: 'offline' } }); return; }
      const project = this.port.getProject(session.projectId);
      const dir = workspaceChatsDir(this.configDirFor(project), project.cwd);
      const followChat = async (chatId: string | undefined) => {
        if (watch.closed) return;
        if (chatId === watch.chat?.chatId) return;
        const hadChat = Boolean(watch.chat);
        watch.chat?.close();
        this.clearDerivedState(watch);
        watch.chat = chatId ? new Transcript(chatId, join(dir, chatId, 'store.db'), session.id) : undefined;
        watch.context = undefined;
        if (hadChat || !chatId) {
          watch.emit({ type: 'reset', ...(chatId ? { chatId } : {}), events: [] });
          watch.emit({ type: 'context' });
        }
      };

      // The session's known chat can be decoded immediately. Process and workspace discovery is
      // only needed afterward to notice /clear, /resume or a newly opened chat.
      await followChat(session.nativeSessionId);
      if (watch.closed) return;
      if (watch.chat) await this.refreshChat(watch, session, dir);
      if (watch.closed) return;
      if (Date.now() - watch.lastScan >= SCAN_INTERVAL_MS) {
        watch.lastScan = Date.now();
        session = await this.scan(watch, session, dir);
        if (watch.closed) return;
        if (session.nativeSessionId !== watch.chat?.chatId) {
          await followChat(session.nativeSessionId);
          if (watch.closed) return;
          if (watch.chat) await this.refreshChat(watch, session, dir);
          if (watch.closed) return;
        }
        await this.adoptOpenSubagents(watch, session, dir);
        if (watch.closed) return;
      }
      // Let the already known transcript reach the browser before terminal capture and process
      // discovery can add latency to first paint.
      await this.updateStatus(watch, session);
      // Reconcile the tracked background tasks against the fresh pane status, including first load.
      await this.followJobs(watch, []);
      if (watch.closed) return;
      if (!watch.primed) {
        // First tick: subscribers must learn the state even when nothing has changed yet.
        watch.primed = true;
        watch.emit({ type: 'status', status: watch.status });
      }
    } catch {
      /* Polling is best-effort; the next tick retries. */
    } finally {
      watch.ticking = false;
      const resolve = watch.resolveTick;
      watch.resolveTick = undefined;
      watch.tickPromise = undefined;
      resolve?.();
    }
  }

  private async updateStatus(watch: Watch, session: AgentSessionView): Promise<void> {
    if (this.restartingSessions.has(session.id)) return;
    let status: NativeStatus = { phase: cursorTurns.report(watch, 'offline', 'screen') };
    let startupNotice: string | undefined;
    let startupNoticeLevel: NativeStatus['noticeLevel'] = 'warning';
    let idlePane: { terminalId: string; error?: string; outcomeKnown: boolean } | undefined;
    // What this tick actually saw, as opposed to the cached values `status` may fall back to.
    let observedApproval: ApprovalMode | undefined;
    if (session.terminalId && !session.archivedAt) {
      const info = this.port.findTerminal(session.terminalId);
      if (info && info.state !== 'exited') {
        if (watch.booting?.terminalId !== info.id) watch.booting = { terminalId: info.id, since: Date.now() };
        const chat = watch.chat;
        const root = chat?.rootId;
        const screenTurn = chat?.turnId() ?? root;
        const screen = await this.port.terminals.screen(info.id);
        const shown = screen === undefined ? undefined : await this.port.dialogs.current(session.id);
        if (watch.closed || this.restartingSessions.has(session.id)) return;
        const current = this.port.getSession(session.id);
        if (current.archivedAt || current.terminalId !== info.id || current.nativeSessionId !== session.nativeSessionId) {
          watch.idleTurn = undefined;
          return;
        }
        session = current;
        let stalled = Date.now() - watch.booting.since >= CURSOR_BOOT_STALL_MS;
        if (screen !== undefined) {
          const { footer, subview, error: cliError, ...parsed } = parseScreen(screen);
          const interaction = shown
            ?? (this.port.dialogs.isResponding(info.id) ? watch.status.interaction : undefined);
          const configBoot = this.configBootTerminals.get(session.id) === info.id;
          const readyFooter = configBoot
            ? (footer && parsed.phase === 'idle' && CURSOR_AGENT_READY_PATTERN.test(screen))
            : (footer && (parsed.phase !== 'attention' || watch.booted === info.id));
          if (readyFooter || subview || interaction || stalled) {
            if (readyFooter || subview) watch.booted = info.id;
            if (configBoot) this.configBootTerminals.delete(session.id);
          }
          // The resume picker is shown instead of the footer on purpose; everything else footer-less is boot.
          const booting = !readyFooter && !subview && watch.booted !== info.id && !(session.resumePicker && !session.nativeSessionId);
          const login = booting && cursorLoginPrompt(screen);
          if (login) {
            stalled = true;
            if (configBoot) this.configBootTerminals.delete(session.id);
          }
          const effectiveFooter = configBoot && !readyFooter ? false : footer;
          const effectiveParsedPhase = configBoot && booting && parsed.phase === 'busy' ? 'attention' : parsed.phase;
          if (effectiveParsedPhase === 'busy' || subview?.working) watch.paneBusyAt = Date.now();
          if (cliError !== watch.cliError?.text) watch.cliError = cliError
            ? { text: cliError, paneBusyAt: watch.paneBusyAt, chatId: chat?.chatId, turn: screenTurn } : undefined;
          const error = watch.cliError;
          const currentError = error?.paneBusyAt === watch.paneBusyAt && error.chatId === watch.chat?.chatId
            && error.turn === (watch.chat?.turnId() ?? watch.chat?.rootId) ? error.text : undefined;
          const turnId = watch.chat?.turnId();
          const nativeSessionId = session.nativeSessionId;
          const outcomeKnown = Boolean(effectiveParsedPhase === 'idle' && turnId && nativeSessionId && watch.chat?.chatId === nativeSessionId
            && this.turnObserver?.recordedOutcome?.(session.id, { nativeSessionId, turnId }));
          const liveStep = nativeSessionId ? this.options.live?.read(nativeSessionId) : undefined;
          // A stop already confirmed this pane idle. The step file it left unsealed is not a hidden turn.
          const stoppedLiveStep = this.stoppedLiveSteps.get(session.id);
          const ignoreStopped = effectiveParsedPhase === 'idle' && stoppedLiveStep !== undefined && liveStep?.step === stoppedLiveStep;
          const liveStreaming = Boolean(liveStep && !ignoreStopped && ((!liveStep.sealed && liveStep.parts.length > 0)
            || (booting && !configBoot && liveStep.step.endsWith(':0') && Boolean(liveStep.prompt))));
          const hiddenTurn = !configBoot && (effectiveParsedPhase === 'idle' || booting) && !currentError && !outcomeKnown
            && (liveStreaming || (watch.chat !== undefined
              && transcriptWorking({ awaitingReply: watch.chat.awaitingReply(), lastActivityAt: watch.chat.lastActivityAt, paneBusyAt: watch.paneBusyAt })));
          let phase: NativeStatus['phase'] = interaction ? 'attention'
            : subview ? subviewPhase({ working: subview.working, previous: watch.status.phase, ...(watch.chat ? { transcript: { awaitingReply: watch.chat.awaitingReply(), lastActivityAt: watch.chat.lastActivityAt } } : {}) })
            : effectiveParsedPhase === 'busy' || hiddenTurn ? 'busy' : booting && !stalled ? 'starting' : effectiveParsedPhase;
          if (phase !== 'attention' || interaction || booting) watch.unrecognized = undefined;
          else {
            watch.unrecognized ??= { since: Date.now(), logged: false };
            const unread = Date.now() - watch.unrecognized.since;
            // Counted in polls (about 3 s and 11 s at the default 700 ms), so each window spans frames.
            if (unread < UNRECOGNIZED_PANE_ATTENTION_POLLS * this.pollMs) {
              phase = watch.status.phase === 'busy' ? 'busy' : watch.status.phase === 'idle' ? 'idle' : 'starting';
              // Still waiting, not yet a problem: the attention phase after the longer window is.
              if (unread >= UNRECOGNIZED_PANE_NOTICE_POLLS * this.pollMs) { startupNotice = UNRECOGNIZED_PANE_NOTICE; startupNoticeLevel = 'info'; }
            } else if (!watch.unrecognized.logged) {
              watch.unrecognized.logged = true;
              console.warn(`[riffet] ${session.id}: Cursor pane shows no prompt bar and no known dialog; its last lines:\n${paneTail(screen)}`);
            }
          }
          if (login && !interaction) startupNotice = 'Cursor CLI 需要登录，请在终端中完成登录。登录后会自动恢复。';
          else if (booting && stalled && !interaction) startupNotice = 'CLI 尚未出现可输入的提示栏，请查看终端中的登录、提示或错误。就绪后会自动恢复。';
          else if (currentError && phase === 'idle') {
            startupNotice = `Cursor CLI 报错，上一轮已中断：${currentError}。发送「继续」可以让它接着做。`;
            startupNoticeLevel = 'error';
          }
          // A painted footer is the whole truth about the model and the approval mode; while the CLI
          // is booting or a dialog covers it, the last known values are kept instead of blinking out.
          const model = (effectiveFooter ? parsed.model : undefined) ?? watch.status.model;
          const permission = effectiveFooter ? parsed.permission : watch.status.permission;
          const approval = effectiveFooter ? approvalFromFooter(parsed.permission) : watch.status.approval;
          observedApproval = adoptableApproval(effectiveFooter, parsed.permission);
          status = {
            ...parsed, phase: cursorTurns.report(watch, phase, interaction ? 'screen' : hiddenTurn ? 'transcript' : 'screen'),
            ...(interaction ? { interaction } : {}),
            ...(model ? { model } : {}),
            ...(permission ? { permission } : {}),
            ...(approval ? { approval } : {}),
          };
          if (effectiveFooter && !subview && effectiveParsedPhase === 'idle' && status.phase === 'idle'
            && watch.chat === chat && chat?.rootId === root) idlePane = { terminalId: info.id, error: currentError, outcomeKnown };
        } else if (this.port.dialogs.isResponding(info.id) && watch.status.interaction) {
          status = { ...watch.status, phase: cursorTurns.report(watch, 'attention', 'screen') };
        } else {
          if (stalled) this.configBootTerminals.delete(session.id);
          status = { phase: cursorTurns.report(watch, stalled ? 'attention' : 'starting', 'screen') };
          if (stalled) startupNotice = '暂时无法读取 CLI 终端画面，请打开终端检查连接状态。';
        }
      } else {
        this.configBootTerminals.delete(session.id);
      }
    } else {
      this.configBootTerminals.delete(session.id);
    }
    if (status.phase === 'offline') {
      startupNotice = this.port.getSession(session.id).error;
      startupNoticeLevel = 'error';
      this.turnObserver?.offline(session);
    }
    const activeTurn = status.phase !== 'offline' ? this.turnObserver?.activeTurn(session) : undefined;
    if (!activeTurn && status.phase === 'busy') this.turnObserver?.unnamedBusy?.(session);
    this.observeSettledTurn(watch, session, idlePane, activeTurn?.turnId);
    const next: NativeStatus = {
      ...status,
      ...(activeTurn ? { activeTurn } : {}),
      ...(watch.transcript ? { transcript: watch.transcript } : {}),
      ...(startupNotice || watch.notice ? { notice: startupNotice ?? watch.notice, noticeLevel: startupNotice ? startupNoticeLevel : 'warning' } : {}),
    };
    if (JSON.stringify(next) !== JSON.stringify(watch.status)) {
      watch.status = next;
      watch.emit({ type: 'status', status: next });
    }
    this.followState(watch, session, next.phase);
    // `next.approval` can be the cached fallback kept for the UI; only this tick's own footer counts.
    if (observedApproval) this.followApproval(watch, session, observedApproval);
    // The tick knows the phase, which is exactly what a deferred switch waits for.
    this.schedulePendingConfig(session);
  }

  private observeSettledTurn(watch: Watch, session: AgentSessionView,
    idlePane: { terminalId: string; error?: string; outcomeKnown: boolean } | undefined, activeTurnId: string | undefined): void {
    const answered = this.turnObserver?.answered;
    if (!answered) return;
    const chat = watch.chat;
    const rootId = chat?.rootId;
    const turnId = chat?.turnId();
    if (!idlePane || !chat || chat.status !== 'ok' || !rootId || !chat.events.length || chat.chatId !== session.nativeSessionId
      || session.state === 'cancelling' || (turnId && activeTurnId && turnId !== activeTurnId)) {
      watch.idleTurn = undefined;
      return;
    }
    const { terminalId, error, outcomeKnown } = idlePane;
    const canSettle = () => Boolean(error || outcomeKnown || chat.answered());
    if (!canSettle()) {
      watch.idleTurn = undefined;
      return;
    }
    const nativeSessionId = chat.chatId;
    const idle = watch.idleTurn;
    if (!idle || idle.nativeSessionId !== nativeSessionId || idle.terminalId !== terminalId || idle.rootId !== rootId
      || idle.activeTurnId !== activeTurnId || idle.error !== error) {
      watch.idleTurn = { nativeSessionId, terminalId, rootId, activeTurnId, error, since: Date.now() };
      return;
    }
    if (Date.now() - Math.max(idle.since, watch.paneBusyAt, chat.lastActivityAt) < ANSWERED_SETTLE_MS) return;
    const { paneBusyAt } = watch;
    const { lastActivityAt } = chat;
    answered(session, { nativeSessionId, rootId, turnId, error }, () => {
      if (watch.closed || watch.idleTurn !== idle || watch.chat !== chat || chat.status !== 'ok'
        || chat.rootId !== rootId || chat.turnId() !== turnId || paneBusyAt !== watch.paneBusyAt
        || lastActivityAt !== chat.lastActivityAt || !canSettle()) return false;
      const current = this.port.getSession(session.id);
      const terminal = this.port.findTerminal(terminalId);
      return !current.archivedAt && current.state !== 'cancelling'
        && current.nativeSessionId === nativeSessionId && current.terminalId === terminalId
        && terminal !== undefined && terminal.state !== 'exited';
    });
  }

  /**
   * Keeps the stored approval mode in step with the CLI's footer.
   *
   * `/run-everything` and `/auto-review` can be toggled inside the terminal, and a later model or
   * approval switch has to re-apply what is actually in force — not what was chosen at creation.
   * The argument is deliberately not optional: only an approval this tick read off the footer may be
   * persisted, never a cached fallback.
   */
  private followApproval(watch: Watch, session: AgentSessionView, approval: ApprovalMode): void {
    const current = this.port.getSession(session.id);
    if (current.archivedAt || current.configPending || current.approval === 'dontAsk' || current.approval === approval) return;
    // The mode moved on the CLI's side, which is a change of meaning like any other: the counter has
    // to move with it, so a client holding the old settings is told before it submits rather than
    // after. A message already waiting in the queue is delivered under the mode in effect when it
    // starts, so this is what makes one rule hold for a watched conversation, a swept one and every
    // backend's own adoption path.
    watch.emit(sessionMessage(this.port.bumpConfig(session.id, { approval })));
  }

  /**
   * A native conversation's state follows what the CLI is doing, not whether its process exists.
   *
   * The terminal service marks a native session `running` for as long as the CLI is attached, so a
   * CLI that finished its turn and sits at its prompt left the sidebar spinning forever. The
   * screen already says which it is. Background subagents can outlive that main turn, so the
   * session stays running until their stores settle too; the main agent's phase stays independent.
   */
  private followState(watch: Watch, session: AgentSessionView, phase: NativeStatus['phase']): void {
    // An absent terminal is the terminal service's business: it already writes `idle` on exit and
    // owns `failed`/`interrupted`, so a phase we could not read must not overwrite those.
    const current = this.port.getSession(session.id);
    if (current.archivedAt) return;
    const subagentsRunning = watch.openStoresKnown ? watch.openSubagentCalls.length > 0
      : [...watch.subagents.values()].some(item => this.subagentRunning(watch, item));
    const state = stateForPhase(phase, subagentsRunning);
    if (!state || current.state === state) return;
    watch.emit(sessionMessage(this.port.updateSession(session.id, { state })));
  }

  private refreshParentTranscript(watch: Watch, session: AgentSessionView, dir: string): ParentTranscriptBatch | undefined {
    const chat = watch.chat;
    if (!chat || chat.chatId !== session.nativeSessionId || watch.closed) return undefined;
    const change = chat.refresh();
    watch.transcript = chat.status;
    const batch: ParentTranscriptBatch = { chatId: chat.chatId, generation: chat.generation, events: change?.events ?? [] };
    if (!change) return batch;
    const turn = chat.turnId();
    if (turn) this.turnObserver?.requestStarted?.(session.id, chat.chatId, turn, true);

    // A store or draft with an unanswered prompt proves a turn is running even before the next
    // terminal screen capture finishes; announce `busy` before waking the transcript reader.
    if ((change.reset || change.events.length || (change.draftChanged && chat.draft.length))
      && (watch.status.phase === 'offline' || watch.status.phase === 'starting')
      && (chat.awaitingReply() || (change.draftChanged && chat.draft.length > 0))
      && session.terminalId && !session.archivedAt
      && this.configBootTerminals.get(session.id) !== session.terminalId) {
      const info = this.port.findTerminal(session.terminalId);
      if (info && info.state !== 'exited') {
        const activeTurn = this.turnObserver?.activeTurn(session);
        const next: NativeStatus = {
          ...watch.status,
          phase: cursorTurns.report(watch, 'busy', 'transcript'),
          ...(activeTurn ? { activeTurn } : {}),
          ...(watch.transcript ? { transcript: watch.transcript } : {}),
        };
        if (JSON.stringify(next) !== JSON.stringify(watch.status)) {
          watch.status = next;
          watch.emit({ type: 'status', status: next });
        }
        this.followState(watch, session, next.phase);
      }
    }

    if (change.reset) {
      // Subagents belong to the conversation, not to one reading of its transcript: their stores and
      // the tool calls naming them outlive a rewind or a re-read from the tail, and dropping them
      // here would hide working subagents until the next scan re-maps them. Jobs are rebuilt from
      // the re-read events, as the client rebuilds its own on this reset.
      watch.jobs.clear();
      watch.metrics.reset();
      watch.emit({ type: 'reset', chatId: chat.chatId, events: visible(chat.events) });
    } else if (change.events.length) {
      watch.emit({ type: 'append', events: visible(change.events) });
    } else if (change.draftChanged && chat.draft.length) {
      // The step the model is still in is in the store before it commits, so the journal's reader is
      // told to read it now: the conversation shows the answer forming instead of nothing until the
      // CLI commits the message.
      watch.emit({ type: 'draft' });
    }
    this.turnObserver?.transcript?.(session, change.events);
    // Measured over the unfiltered batch: the hidden bookkeeping this drops for display still
    // corresponds to model output that the provider billed for.
    watch.metrics.observe(change.events, { historical: change.reset });
    if (change.reset) this.observeLiveMetrics(chat.chatId, watch);
    if (change.draftChanged && chat.draft.length) watch.metrics.observeDraft(chat.draft);
    if (JSON.stringify(change.context) !== JSON.stringify(watch.context)) {
      watch.context = change.context;
      watch.emit({ type: 'context', ...(change.context ? { context: change.context } : {}) });
    }
    // A transcript that arrives later (a resumed session) names the conversation from its first
    // message before the CLI's chat name is weighed against it: the name is model-written and
    // replaces the message once, unless it is in another language — Cursor names Chinese
    // conversations in English (see `session-title.ts`).
    const humanMessage = this.port.firstUserMessage(session.id);
    if (humanMessage) {
      const patch = firstMessageTitlePatch(this.port.getSession(session.id), humanMessage);
      if (patch) {
        const updated = this.port.updateSession(session.id, patch);
        watch.emit(sessionMessage(updated));
      }
    }
    const name = change.meta.name?.trim();
    if (name) {
      const patch = nativeTitlePatch(this.port.getSession(session.id), name, humanMessage);
      if (patch) {
        const updated = this.port.updateSession(session.id, patch);
        watch.emit(sessionMessage(updated));
      }
    }
    // Register child readers before any maintenance await so a later child poll cannot miss this
    // parent tool event if the transcript advances again in the meantime.
    this.discoverSubagents(watch, change.events, dir, session.id);
    // Parent-derived job markers/results are committed exactly once here, before child or log
    // maintenance can yield and another fast-path refresh can consume a later root.
    this.recordJobEvents(watch, change.events);
    this.emitJobUpdates(watch, batch);
    // Baselines and late historical blobs may catch up on messages written while detached. Their
    // persisted CLI timestamps are safe; only new appends are mapped with a current seenAt.
    const activityAt = latestTranscriptActivity(change.events);
    if (activityAt) {
      const updated = this.port.updateSessionActivity(session.id, activityAt);
      if (updated) watch.emit(sessionMessage(updated));
    }
    return batch;
  }

  private parentBatchCurrent(watch: Watch, batch: ParentTranscriptBatch): boolean {
    return !watch.closed && watch.chat?.chatId === batch.chatId && watch.chat.generation === batch.generation;
  }

  private async refreshChat(watch: Watch, session: AgentSessionView, dir: string): Promise<void> {
    const batch = this.refreshParentTranscript(watch, session, dir);
    if (!batch || !this.parentBatchCurrent(watch, batch)) return;
    const derivedEvents: NativeWorkbenchEvent[] = [];
    const activityEvents: NativeWorkbenchEvent[] = [];
    for (const item of [...watch.subagents.values()]) {
      let update: ReturnType<Transcript['refresh']>;
      if (!item.lastCheckedAt || Date.now() - item.lastCheckedAt >= SUBAGENT_POLL_MS) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (!this.parentBatchCurrent(watch, batch)) return;
        item.lastCheckedAt = Date.now();
        item.closed = false;
        update = item.transcript.refresh();
      }
      if (update) {
        item.lastChangeAt = Date.now();
        item.closed = false;
        this.rememberSubagent(watch, item);
      }
      // Whether it is still working is what its own store says, not what the launching tool call
      // said: a backgrounded Task answers immediately and carries on.
      const running = this.subagentRunning(watch, item);
      if (running !== item.running) {
        item.running = running;
        watch.emit({ type: 'subagent', toolCallId: item.toolCallId, agentId: item.transcript.chatId, ...(item.subagentType ? { subagentType: item.subagentType } : {}), events: [], running });
      }
      // Quiet stores still receive periodic root checks in case a long-running shell writes later.
      // Drop the reader after a minute, while keeping its bounded event cache and generation.
      if (Date.now() - item.lastChangeAt > SUBAGENT_IDLE_MS) {
        if (!item.closed) item.transcript.releaseReader();
        item.closed = true;
        continue;
      }
      if (!update) continue;
      derivedEvents.push(...update.events);
      activityEvents.push(...update.events);
      this.discoverSubagents(watch, update.events, dir, session.id);
      if (update.reset || update.events.length) watch.emit({ type: 'subagent', toolCallId: item.toolCallId, agentId: item.transcript.chatId, ...(item.subagentType ? { subagentType: item.subagentType } : {}), events: visible(update.events) });
    }
    const activityAt = latestTranscriptActivity(activityEvents);
    if (activityAt) {
      const updated = this.port.updateSessionActivity(session.id, activityAt);
      if (updated) watch.emit(sessionMessage(updated));
    }
    if (this.parentBatchCurrent(watch, batch)) await this.followJobs(watch, derivedEvents, batch);
  }

  /** Following another conversation invalidates every association derived from the old one. */
  private clearDerivedState(watch: Watch): void {
    watch.idleTurn = undefined;
    for (const item of watch.subagents.values()) item.transcript.close();
    watch.subagents.clear();
    watch.jobs.clear();
    watch.subagentByToolCallId.clear();
    watch.agentCalls.clear();
    watch.subagentDescriptors.clear();
  }

  private subagentRunning(watch: Watch, item: SubagentWatch): boolean {
    return subagentWorking(item.toolCallId, item.lastChangeAt, watch.openStoresKnown ? watch.openSubagentCalls : undefined);
  }

  private rememberSubagent(watch: Watch, item: SubagentWatch): void {
    watch.subagentDescriptors.delete(item.toolCallId);
    watch.subagentDescriptors.set(item.toolCallId, {
      toolCallId: item.toolCallId,
      agentId: item.transcript.chatId,
      ...(item.subagentType ? { subagentType: item.subagentType } : {}),
      lastUsedAt: Date.now(),
    });
    while (watch.subagentDescriptors.size > 512) watch.subagentDescriptors.delete(watch.subagentDescriptors.keys().next().value!);
  }

  private rehydrateSubagent(watch: Watch, toolCallId: string, session: AgentSessionView, dir: string): SubagentWatch | undefined {
    const descriptor = watch.subagentDescriptors.get(toolCallId);
    let agentId: string;
    let subagentType: string | undefined;
    if (descriptor) {
      agentId = descriptor.agentId;
      subagentType = descriptor.subagentType;
      descriptor.lastUsedAt = Date.now();
      watch.subagentDescriptors.delete(toolCallId);
      watch.subagentDescriptors.set(toolCallId, descriptor);
    } else {
      const mappedId = watch.subagentByToolCallId.get(toolCallId);
      const meta = mappedId ? watch.metas.get(mappedId) : undefined;
      const info = meta?.subagentInfo;
      const rootId = session.nativeSessionId ?? watch.chat?.chatId;
      const parentIds = new Set([
        rootId,
        ...[...watch.subagents.values()].map((item) => item.transcript.chatId),
        ...[...watch.subagentDescriptors.values()].map((item) => item.agentId),
      ].filter((id): id is string => Boolean(id)));
      const related = info?.toolCallId === toolCallId && (
        Boolean(info.parentAgentId && parentIds.has(info.parentAgentId)) ||
        Boolean(info.rootParentAgentId && parentIds.has(info.rootParentAgentId))
      );
      if (!mappedId || !related || !info) return undefined;
      agentId = mappedId;
      subagentType = watch.agentCalls.get(toolCallId);
    }
    if (!/^[0-9a-f-]{36}$/i.test(agentId) || !this.makeSubagentRoom(watch)) return undefined;
    const transcript = new Transcript(agentId, join(dir, agentId, 'store.db'), session.id);
    const item: SubagentWatch = { toolCallId, ...(subagentType ? { subagentType } : {}), transcript, lastChangeAt: Date.now() };
    watch.subagents.set(toolCallId, item);
    this.rememberSubagent(watch, item);
    return item;
  }

  /**
   * Follows the subagents the CLI is working in before the parent transcript names them. Cursor
   * records a Task call's agent id only with its result, which a foreground Task returns when the
   * subagent is done; until then the open store is the only sign the subagent exists.
   */
  private async adoptOpenSubagents(watch: Watch, session: AgentSessionView, dir: string): Promise<void> {
    const events: NativeWorkbenchEvent[] = [];
    for (const toolCallId of watch.openSubagentCalls) {
      if (watch.subagents.has(toolCallId)) continue;
      const item = this.rehydrateSubagent(watch, toolCallId, session, dir);
      if (!item) continue;
      item.closed = false;
      item.lastCheckedAt = Date.now();
      const update = item.transcript.refresh();
      if (update) {
        item.lastChangeAt = Date.now();
        this.rememberSubagent(watch, item);
        // What it did before being adopted, like any later batch, may have started nested
        // subagents or background shells.
        events.push(...update.events);
        this.discoverSubagents(watch, update.events, dir, session.id);
      }
      item.running = this.subagentRunning(watch, item);
      watch.emit({ type: 'subagent', toolCallId, agentId: item.transcript.chatId, ...(item.subagentType ? { subagentType: item.subagentType } : {}), events: visible(update?.events ?? []), running: item.running });
    }
    if (events.length) await this.followJobs(watch, events);
  }

  private makeSubagentRoom(watch: Watch): boolean {
    if (watch.subagents.size < 32) return true;
    const candidates = [...watch.subagents.values()].sort((a, b) => {
      const aIdle = a.closed || !this.subagentRunning(watch, a);
      const bIdle = b.closed || !this.subagentRunning(watch, b);
      if (aIdle !== bIdle) return aIdle ? -1 : 1;
      return a.lastChangeAt - b.lastChangeAt;
    });
    const oldest = candidates[0];
    if (!oldest) return false;
    this.rememberSubagent(watch, oldest);
    oldest.transcript.close();
    watch.subagents.delete(oldest.toolCallId);
    return true;
  }

  /** Discover child stores only from newly mapped events; old transcript history is not rescanned. */
  private discoverSubagents(watch: Watch, events: NativeWorkbenchEvent[], dir: string, sessionId: string): string[] {
    const created: string[] = [];
    for (const event of events) {
      if (event.type !== 'tool_call' || event.data.kind !== 'agent') continue;
      const toolCallId = String(event.data.toolCallId ?? '');
      if (!toolCallId) continue;
      const subagent = event.data.subagent as { type?: string } | undefined;
      watch.agentCalls.set(toolCallId, subagent?.type);
      while (watch.agentCalls.size > 2048) watch.agentCalls.delete(watch.agentCalls.keys().next().value!);
      // A subagent adopted from its open store was followed before this call reached the transcript.
      const adopted = watch.subagents.get(toolCallId);
      if (adopted && !adopted.subagentType && subagent?.type) adopted.subagentType = subagent.type;
    }
    for (const event of events) {
      if (event.type !== 'tool_call_update') continue;
      const toolCallId = String(event.data.toolCallId ?? '');
      const result = isRecord(event.data.subagentResult) ? event.data.subagentResult : undefined;
      const agentId = str(result?.agentId) ?? watch.subagentByToolCallId.get(toolCallId);
      if (!toolCallId || !agentId || watch.subagents.has(toolCallId)) continue;
      if (!/^[0-9a-f-]{36}$/i.test(agentId)) continue;
      if (!this.makeSubagentRoom(watch)) continue;
      const subagentType = watch.agentCalls.get(toolCallId);
      watch.subagents.set(toolCallId, { toolCallId, ...(subagentType ? { subagentType } : {}), transcript: new Transcript(agentId, join(dir, agentId, 'store.db'), sessionId), lastChangeAt: Date.now() });
      created.push(toolCallId);
    }
    return created;
  }

  /**
   * Follows the background shell jobs of this conversation.
   *
   * Only an explicit `job` marker starts a background row: it comes from a non-blocking Shell call or
   * a CLI result that carries a shell id, background reason, or trusted log path. Ordinary Shell
   * results also have `jobResult` fields for their transcript row, but must not be promoted here.
   * A background job's own log is re-read about once a second until it reports an exit. Jobs started
   * inside a subagent are followed too, so their row is just as live wherever it is rendered.
   */
  private async followJobs(watch: Watch, events: NativeWorkbenchEvent[], batch?: ParentTranscriptBatch): Promise<void> {
    if (batch && !this.parentBatchCurrent(watch, batch)) return;
    this.recordJobEvents(watch, events);
    await this.refreshJobLogs(watch, batch);
    this.emitJobUpdates(watch, batch);
  }

  /** Apply canonical parent/child tool updates before any job-log I/O can yield. */
  private recordJobEvents(watch: Watch, events: NativeWorkbenchEvent[]): void {
    const byShellId = new Map<string, JobWatch>();
    for (const job of watch.jobs.values()) if (job.id) byShellId.set(job.id, job);
    let shellCalls: Map<string, NativeWorkbenchEvent> | undefined;
    const findShellCall = (toolCallId: string) => {
      if (!shellCalls) {
        shellCalls = new Map();
        const remember = (items: NativeWorkbenchEvent[]) => {
          for (const item of items) {
            if (item.type === 'tool_call' && item.data.toolName === 'Shell' && typeof item.data.toolCallId === 'string') {
              shellCalls!.set(item.data.toolCallId, item);
            }
          }
        };
        remember(watch.chat?.events ?? []);
        for (const item of watch.subagents.values()) remember(item.transcript.events);
        remember(events);
      }
      return shellCalls.get(toolCallId);
    };
    for (const event of events) {
      const data = event.data;
      const start = isRecord(data.job) ? data.job : undefined;
      const toolCallId = str(data.toolCallId);
      if (start && toolCallId) {
        const job = watch.jobs.get(toolCallId) ?? { toolCallId, title: '', command: '', status: 'running' as const, readAt: 0 };
        const call = event.type === 'tool_call' ? event : findShellCall(toolCallId);
        const input = isRecord(call?.data.rawInput) ? call.data.rawInput : undefined;
        if (!job.startedAt) job.startedAt = call?.createdAt || event.createdAt || undefined;
        job.title = str(start.title) ?? (job.title || str(call?.data.title) || '');
        job.command = str(start.command) ?? (job.command || str(input?.command) || '');
        job.id = str(start.id) ?? job.id;
        job.outputPath = str(start.outputPath) ?? job.outputPath;
        if (start.status === 'succeeded' || start.status === 'failed') job.status = start.status;
        watch.jobs.set(toolCallId, job);
        if (job.id) byShellId.set(job.id, job);
      }
      const result = isRecord(data.jobResult) ? data.jobResult : undefined;
      if (!result) continue;
      const job = (result.id ? byShellId.get(String(result.id)) : undefined) ?? (toolCallId ? watch.jobs.get(toolCallId) : undefined);
      if (!job) continue;
      if (str(result.id)) { job.id = str(result.id); byShellId.set(job.id!, job); }
      job.outputPath = str(result.outputPath) ?? job.outputPath;
      job.matched = str(result.matched) ?? job.matched;
      if (typeof result.runningMs === 'number') job.runningMs = result.runningMs;
      if (typeof result.exitCode === 'number') job.exitCode = result.exitCode;
      if (Array.isArray(data.content)) {
        const output = data.content.flatMap((part) => {
          if (!isRecord(part)) return [];
          const content = isRecord(part.content) ? part.content : part;
          return typeof content.text === 'string' ? [content.text] : [];
        }).join('\n');
        if (output) { job.output = output.slice(-64 * 1024); job.truncated = output.length > 64 * 1024; }
      }
      if (result.status === 'succeeded' || result.status === 'failed' || result.status === 'running') job.status = result.status;
    }
    while (watch.jobs.size > 512) {
      const settled = [...watch.jobs.values()].find((job) => job.status !== 'running');
      if (!settled) break;
      watch.jobs.delete(settled.toolCallId);
    }
  }

  /** Log reads are maintenance: transcript-derived job state is already registered synchronously. */
  private async refreshJobLogs(watch: Watch, batch?: ParentTranscriptBatch): Promise<void> {
    for (const job of watch.jobs.values()) {
      if (batch && !this.parentBatchCurrent(watch, batch)) return;
      if (!job.outputPath) continue;
      const live = job.status === 'running';
      // Read a running job about once a second so its row looks live, and a finished one once more:
      // the CLI writes the exit block after the output, and a job the agent awaited is already
      // finished by the time its log is first seen.
      if (!live && job.finalRead) continue;
      if (live && job.readAt > 0 && Date.now() - job.readAt < JOB_LOG_MS) continue;
      job.readAt = Date.now();
      if (!live) job.finalRead = true;
      const log = await this.readJobLog(job.outputPath);
      if (watch.closed || (batch && !this.parentBatchCurrent(watch, batch))) return;
      if (watch.jobs.get(job.toolCallId) !== job) continue;
      if (!log) continue;
      // A transcript result can settle the job while a log snapshot is being read. Discard that
      // entire stale snapshot; the next maintenance pass will read the final log without blocking
      // parent transcript delivery in the meantime.
      if (live && job.status !== 'running') continue;
      if (log.title) job.title = log.title;
      if (log.command) job.command = job.command || log.command;
      // While it is running the log is the authority on whether it still is; once the transcript
      // has said it finished, that wins. A canonical result can arrive while this read is pending,
      // so inspect the current status rather than the value captured before awaiting the log.
      if (job.status === 'running' && log.status) job.status = log.status;
      if (log.runningMs) job.runningMs = log.runningMs;
      if (log.exitCode !== undefined) job.exitCode = log.exitCode;
      if (log.output !== undefined) { job.output = log.output; job.truncated = log.truncated; }
    }
  }

  /** Narrow seam for keeping asynchronous log reads deterministic in race regression tests. */
  private readJobLog(path: string) {
    return readJobLog(path);
  }

  private emitJobUpdates(watch: Watch, batch?: ParentTranscriptBatch): void {
    if (batch && !this.parentBatchCurrent(watch, batch)) return;
    for (const job of watch.jobs.values()) {
      const payload = jobPayload(job);
      const signature = JSON.stringify(payload);
      if (signature === job.signature) continue;
      job.signature = signature;
      watch.emit({ type: 'job', job: payload });
    }
  }

  /**
   * Learns which chats exist in this workspace and keeps the conversation on the one its CLI is
   * working in — including after `/clear`, `/resume`, `/fork` or the resume picker.
   */
  private async scan(watch: Watch, session: AgentSessionView, dir: string): Promise<AgentSessionView> {
    let entries: Array<{ id: string; mtime: number; meta: ChatMeta }>;
    try { entries = await this.workspaceChats(dir); } catch { return session; }
    const topLevel: Array<{ id: string; mtime: number }> = [];
    for (const { id, mtime, meta } of entries) {
      watch.metas.delete(id);
      watch.metas.set(id, meta);
      if (meta.subagentInfo?.toolCallId) watch.subagentByToolCallId.set(meta.subagentInfo.toolCallId, id);
      if (meta.subagentInfo) continue;
      topLevel.push({ id, mtime });
    }
    while (watch.metas.size > 512) watch.metas.delete(watch.metas.keys().next().value!);
    while (watch.subagentByToolCallId.size > 256) watch.subagentByToolCallId.delete(watch.subagentByToolCallId.keys().next().value!);
    const terminalState = session.terminalId ? this.port.findTerminal(session.terminalId)?.state : undefined;
    const running = terminalState !== undefined && terminalState !== 'exited';
    if (!running) {
      watch.openSubagentCalls = [];
      watch.openStoresKnown = false;
      return session;
    }

    // Chats are bucketed per workspace, not per terminal, so mtime cannot say which terminal a chat
    // belongs to. The CLI itself can, because it keeps the store of the chat it is working in open
    // (SQLite WAL) — so panes are attributed exactly and two conversations in one project never
    // interfere. Subagent chats are excluded: the CLI may hold one of those open at the same time.
    // The previous answer stays in force while this one is read: history requests and subscribers
    // judge subagents meanwhile, and an empty list would read as "every subagent finished".
    const open = await this.openChats(dir, session.terminalId!);
    // A CLI that is up holds at least its own conversation open; nothing open means no answer —
    // usually one failed `lsof`, which must not flip working subagents to the quiet-time guess.
    if (open.length) {
      watch.openStoresKnown = true;
      watch.openStoresAt = Date.now();
      watch.openSubagentCalls = open.flatMap((id) => {
        const toolCallId = watch.metas.get(id)?.subagentInfo?.toolCallId;
        return toolCallId ? [toolCallId] : [];
      });
    } else if (Date.now() - watch.openStoresAt >= OPEN_STORES_GRACE_MS) {
      watch.openStoresKnown = false;
      watch.openSubagentCalls = [];
    }
    const working = workingChat(open, topLevel);
    const currentChatId = session.nativeSessionId;
    if (working) {
      watch.notice = undefined;
      if (working.id === currentChatId) return session;
      return this.recordCursorChat(watch, session, working.id);
    }

    // No process-level answer (a CLI that keeps nothing open, or a host without `/proc`/`lsof`):
    // fall back to the newest chat, which is only safe while a single conversation is live here.
    const current = topLevel.find((item) => item.id === currentChatId);
    const latest = topLevel.reduce<{ id: string; mtime: number } | undefined>((best, item) => (!best || item.mtime > best.mtime ? item : best), undefined);
    if (!latest) return session;
    if (latest.id === currentChatId) return session;
    if (latest.mtime <= watch.startedAt || latest.mtime <= (current?.mtime ?? 0)) return session;
    if (this.sharedWorkspace(session)) {
      watch.notice = '无法确认这条新对话属于哪个终端，已暂停自动跟随';
      return session;
    }
    watch.notice = undefined;
    return this.recordCursorChat(watch, session, latest.id);
  }

  /**
   * Records the chat this terminal's CLI is working in. The port throws `NATIVE_SESSION_ID_IN_USE` when
   * another live conversation owns the chat, as the store did; a refusal only the host can see (an archived
   * owner with a run in flight) shows in the record returned, which keeps the old chat.
   */
  private recordCursorChat(watch: Watch, session: AgentSessionView, chatId: string): AgentSessionView {
    const updated = this.port.setNativeSessionId(session.id, chatId);
    if (updated.nativeSessionId === chatId) watch.emit(sessionMessage(updated));
    return updated;
  }

  /** Directory enumeration and metadata reads are shared by sessions in the same workspace. */
  private async workspaceChats(dir: string): Promise<Array<{ id: string; mtime: number; meta: ChatMeta }>> {
    const cached = this.workspaceChatScans.get(dir);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;
    const promise = (async () => {
      const entries = await readdir(dir);
      const chats = await Promise.all(entries.filter((id) => /^[0-9a-f-]{36}$/i.test(id)).map(async (id) => {
        const path = join(dir, id, 'store.db');
        const [info, wal] = await Promise.all([stat(path).catch(() => undefined), stat(`${path}-wal`).catch(() => undefined)]);
        if (!info) return undefined;
        // A chat's metadata only changes when the CLI commits to its store (the database or its WAL),
        // so an untouched store is not reopened: a workspace holds dozens of them, scanned every tick.
        const stamp = `${info.mtimeMs}:${info.size}:${wal?.mtimeMs ?? 0}:${wal?.size ?? 0}`;
        const cached = this.chatMetas.get(path);
        if (cached?.stamp === stamp) return { id, mtime: info.mtimeMs, meta: cached.meta };
        const reader = new ChatReader(path);
        try {
          const meta = reader.meta();
          if (!meta) return undefined;
          this.chatMetas.delete(path);
          this.chatMetas.set(path, { stamp, meta });
          while (this.chatMetas.size > 1024) this.chatMetas.delete(this.chatMetas.keys().next().value!);
          return { id, mtime: info.mtimeMs, meta };
        } finally { reader.close(); }
      }));
      return chats.filter((item): item is { id: string; mtime: number; meta: ChatMeta } => Boolean(item));
    })();
    this.workspaceChatScans.set(dir, { expiresAt: Date.now() + SCAN_INTERVAL_MS, promise });
    while (this.workspaceChatScans.size > 32) this.workspaceChatScans.delete(this.workspaceChatScans.keys().next().value!);
    try { return await promise; }
    catch (error) { if (this.workspaceChatScans.get(dir)?.promise === promise) this.workspaceChatScans.delete(dir); throw error; }
  }

  /**
   * The chats this terminal's CLI has open, asked of the process itself.
   *
   * `shell:` launchers start through a shell function, so the pane process is a shell and the CLI
   * is its child; both are asked in one pass. Costs about 50ms and is only used when a
   * conversation is being followed at all.
   */
  private async openChats(dir: string, terminalId: string, readPaths = openPaths): Promise<string[]> {
    const pane = await this.port.terminals.panePid(terminalId);
    if (!pane) return [];
    const children = (await tryExec('pgrep', ['-P', String(pane)]))?.split('\n').flatMap((line) => (Number(line.trim()) > 0 ? [Number(line.trim())] : [])) ?? [];
    const canonicalDir = await realpath(dir).catch(() => undefined);
    const canonicalRoots = new Map<string, Promise<string | undefined>>();
    const chats = new Set<string>();
    for (const pid of [pane, ...children]) {
      for (const path of await readPaths(pid)) {
        const match = CHAT_STORE.exec(path);
        if (!match) continue;
        const root = match[1]!;
        let canonicalRoot = canonicalRoots.get(root);
        if (!canonicalRoot) {
          canonicalRoot = realpath(root).catch(() => undefined);
          canonicalRoots.set(root, canonicalRoot);
        }
        const resolvedRoot = await canonicalRoot;
        if (canonicalDir && resolvedRoot ? resolvedRoot === canonicalDir : root === dir) chats.add(match[2]!);
      }
    }
    return [...chats];
  }

  /** Whether another live native conversation shares this session's workspace chat bucket. */
  private sharedWorkspace(session: AgentSessionView): boolean {
    return this.port.listSessions().some((other) => {
      if (other.id === session.id || other.archivedAt || other.projectId !== session.projectId) return false;
      if (!other.terminalId) return false;
      const item = this.port.findTerminal(other.terminalId);
      return !!item && item.kind === 'cursor' && item.state !== 'exited';
    });
  }
}
