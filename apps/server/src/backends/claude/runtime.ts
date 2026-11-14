import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { NativeActivity, NativeContext, NativeInteraction, NativeInteractionResponse, NativeInteractionResult, NativeStatus, NativeStopRequest, NativeTurnTarget, NativeWorkbenchEvent, Project, Run, Session, TerminalInfo } from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import { activityId, isLiveActivity, withActivity, type ActivityLedger } from '../../journal/activity.js';
import { stoppable } from './activity.js';
import { DeferredSteerInputs } from '../shared/deferred-steer.js';
import { DORMANT_POLL_MS, DormancyClock } from '../shared/dormancy.js';
import { ensureClaudeWorkspaceTrust } from '../shared/cli-trust.js';
import { materializeNativeInput } from '../attachments.js';
import { cliVersionStatus, type CliVersionRange } from '../shared/cli-version.js';
import type { NativeBackendHost, NativeBackendProfileConfig, NativeBackendSendRequest, NativeControlMessage } from '../types.js';
import { CLAUDE_CODE_BUSY_PATTERN, claudeAgentRows, claudeComposer, claudeComposerHoldsPrompt, claudeComposerText, claudeComposerVisible, claudeFooterFocused, claudeTasksEntryFocused, claudeTasksEntryShown, claudeViewsSubagent } from '../../adapters/cli/claude-code.js';
import type { TerminalInteractionControl } from '../../terminal/service.js';
import { ClaudeHookBridge } from './hook-bridge.js';
import { waitFor } from '../shared/wait-for.js';
import { ClaudeStepMetering } from './metering.js';
import { CLAUDE_TURN_FAILED, ClaudeTranscript, claudeFailureText, claudePromptKey, findClaudeTranscript, stripPastedContent, type ClaudeTranscriptLifecycle } from './history.js';
import { ClaudeTranscriptChanges, ClaudeTranscriptSource } from './transcript-source.js';
import type { TurnEndStatus } from '../../journal/ingest.js';
import { claudeNativeContext } from './context.js';
import { claudeScreenInteraction, isClaudeScreenInteraction, parseClaudeScreenDialog } from './screen-dialog.js';
import { parseDialog } from '../../agent-host/interaction-screen.js';
import { activeTurnOf, initialState, phaseOf, reduce, replay, type ClaudeProcess, type ClaudeSessionState, type ClaudeSignal, type ClaudeTurnOrigin, type Transition } from './session-state.js';
import { string, executableOf, runHelp, backendId, CLAUDE_CLI_VERSIONS, CLAUDE_PERMISSIONS, asRecord, configDirOf, profileEnv, pause, screenDialogEndorsed, inspectSavedTerminal, permissionArgs, claudeAvailability } from './launch.js';
import { ComposerDriver, FOOTER_KEY_MS, checkSendInterrupt, type PendingSend, type ScreenAnswer } from './composer.js';
import { ClaudeHookOverlay } from './hook-overlay.js';
import { TranscriptAdoption } from './title-adoption.js';
import { LaunchCrashGuard } from './launch-guard.js';
import { READY_GATE_MS, ReadyGate } from './ready-gate.js';
import { normalizeClaudeModel, declaredLongContext, selectedModel, modelArgs, validateModelSelection } from './models.js';
import type { WorkspaceObserver } from '../shared/workspace-observer.js';

const MAX_INTERACTION_TEXT = 4000;
const ACK_TIMEOUT_MS = 4000;
const RECEIPT_TIMEOUT_MS = 90_000;
/**
 * An unconfirmed prompt is not a failed one: Claude may be busy (a long compaction, a queue ahead of it)
 * and write the row long after the wait ended. The transcript is read again at these delays after the
 * wait gave up, and a row that turns up then still confirms the run; the prompt is never pasted again.
 */
const LATE_RECEIPT_RECHECK_MS = [30_000, 120_000];
export { QUICK_EXIT_MS, QUICK_EXIT_LIMIT } from './launch-guard.js';
const MAX_REMEMBERED_PROMPTS = 200;
const MAX_RECENT_SENDS = 8;
/** Rows a notice form's cursor may cross to reach its Continue row; the auto-mode setup form has four. */
const CONFIRM_ROW_STEPS = 12;

/**
 * How long `awaitReceipt` keeps reading the composer for a paste that had not shown when its window ran out (several
 * image paths take seconds to be drawn), and how often. Enter is pressed only once the box holds our prompt. The wait
 * holds the terminal, so it is the ordinary receipt window rather than longer; past it the run is left to the late checks.
 */
const SUBMIT_LATE_WATCH_MS = RECEIPT_TIMEOUT_MS;
const SUBMIT_LATE_POLL_MS = 500;
/**
 * How long a paste may go unconfirmed before the composer is read again. Claude's own hooks land in
 * about 200 ms when the CLI takes the write, so this is already a wide margin for a slow transcript.
 */
const SUBMIT_RECHECK_MS = 2_000;
/** How many extra Enters one paste may cost while the composer keeps holding the prompt. */
const SUBMIT_RESEND_LIMIT = 3;
/** How long a response already handed to Claude may stay unconfirmed before the card gives up on it. */
const CONFIRMATION_TIMEOUT_MS = 10 * 60_000;
/** Transcript and screen polls while somebody watches the session or a turn is open. */
const TRANSCRIPT_POLL_MS = 300;
/** How long a card waits for the rows of its own tool call, and how often the transcript is read meanwhile. */
const CARD_TAIL_GRACE_MS = 1_500;
const CARD_TAIL_POLL_MS = 40;
const SCREEN_POLL_MS = 750;
/**
 * How long a picked model, effort, Fast or permission setting stands before an idle CLI is relaunched
 * for it. Each relaunch is a stop and a `--resume`, so adjusting three settings in a row is one.
 */
export const CLAUDE_CONFIG_SETTLE_MS = 1_200;
/**
 * Claude Code draws its own dialog beside a held hook and closes it once the hook answers. A dialog still
 * (or again) on screen this long after an answer was delivered is the CLI asking again (see `refreshScreenState`).
 */
const REPROMPT_SETTLE_MS = 2_000;
/**
 * How long after a question's PreToolUse its screen dialog waits for the PermissionRequest hook (2.1.302: 1–1.7 s
 * apart) before it is taken as a question no hook will bring, and lifted from the screen.
 */
const QUESTION_HOOK_GRACE_MS = 5_000;
/** How long a stop waits for the CLI to write the record that confirms it (turn end, agents killed, input removed). */
const STOP_CONFIRM_MS = 20_000;
/** Give Ctrl-C a chance to redraw before confirming a recordless stop against two native idle frames. */
const INTERRUPT_RESTORE_AFTER_MS = 750;
/** How long a stop waits for a freshly pasted message to show whether it was submitted, queued or left in the box. */
const SEND_OUTCOME_WAIT_MS = 2_500;
/**
 * How long the screen has to keep showing no background work (no footer tasks entry, no agent rows, no spinner)
 * before the background work the records still count is dropped, and the fewest reads that make that span.
 */
const BACKGROUND_SCREEN_SETTLE_MS = 5_000;
const BACKGROUND_SCREEN_MIN_READS = 2;
/** A send whose Enter is older than this and still has no outcome is no longer waited for by a stop (it stays under `stopRequested`). */
const SEND_OUTCOME_FRESH_MS = 30_000;
/** How long a prompt that started after a stop is given to show it runs before that stop is reported as not done. */
const LATE_STOP_WAIT_MS = 15_000;
/**
 * Screen convergence reads the footer's tasks entry and agent rows, which were captured from this version on; older
 * versions the adapter supports may draw them differently, and a misread there would drop live work.
 */
const SCREEN_CONVERGENCE_VERSIONS: CliVersionRange = { minimum: '2.1.302', testedThrough: CLAUDE_CLI_VERSIONS.testedThrough };
/**
 * A turn that is neither ended nor showing any sign of life — no transcript growth, no hook — for this long
 * is reported with a notice. The state is not changed: only a record or a hook ends a turn.
 */
const TURN_SILENCE_MS = 30 * 60_000;
const TURN_SILENCE_NOTICE = 'Claude Code has shown no activity; check the terminal.';
/** How long a send waits for a launch to finish starting before it is refused and queued again. */
const STARTING_SEND_WAIT_MS = READY_GATE_MS + 5_000;
const STARTUP_FAILED_MESSAGE = 'Claude Code startup timed out; check the terminal.';

interface ActiveWebTurn { commandId: string; runId: string; promptId?: string; }
interface ClaudeQuestion {
  question: string;
  header?: string;
  options: Array<{ id: string; label: string; description?: string }>;
  multiSelect: boolean;
}
interface PendingInteraction {
  kind: 'permission' | 'question';
  nativeRequestId: string;
  toolUseId?: string;
  questionAnswersMatched?: boolean;
  /** Raised by the main agent (false: by a child agent, which can ask while the main agent is idle). */
  mainThread?: boolean;
  toolName: string;
  toolInput: Record<string, unknown>;
  interaction: NativeInteraction;
  questions?: ClaudeQuestion[];
  questionIndex: number;
  revision: number;
  answers: Record<string, string>;
  /** The answer handed to the hook; `deliveredAt` is when the hook was released with it. */
  candidate?: { output: Record<string, unknown>; webRequestId: string; deliveredAt: number };
  providerResult?: NativeInteractionResult;
  confirmationWaiters: Set<(result: NativeInteractionResult) => void>;
  candidateCleanup?: NodeJS.Timeout;
  resolveHook: (output: Record<string, unknown>) => void;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
  terminalSettled?: boolean;
}

/** The tool input a staged answer hands back to Claude Code (`decision.updatedInput` of its PermissionRequest output). */
function candidateInput(pending: PendingInteraction): Record<string, unknown> | undefined {
  return asRecord(asRecord(asRecord(pending.candidate?.output.hookSpecificOutput)?.decision)?.updatedInput);
}

/** An answer to Claude Code's own question dialog: typed text for its free-text row, or the index of one option. */

function screenAnswer(question: NativeInteraction, response: NativeInteractionResponse): ScreenAnswer {
  const text = (response.otherText ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  const choice = response.selectedIds?.length === 1 ? question.options.findIndex(option => option.id === response.selectedIds![0]) : -1;
  if (!text && choice < 0) throw new AppError('INVALID_NATIVE_INTERACTION', 'Choose one option or enter an answer for this Claude Code question');
  return { text, choice };
}

/** The file an edit tool's call writes, from its hook payload. */
function editedPath(payload: Record<string, unknown>): string | undefined {
  if (!['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(string(payload.tool_name) ?? '')) return undefined;
  const input = asRecord(payload.tool_input);
  return string(input?.file_path) ?? string(input?.notebook_path);
}

function stableJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    const object = asRecord(item);
    if (!object) return item;
    return Object.fromEntries(Object.keys(object).sort().map(key => [key, sort(object[key])]));
  };
  return JSON.stringify(sort(value));
}

/** Claude trims a command's arguments, so a rewrite is matched with its whitespace collapsed. */
export function rewriteKey(prompt: string): string {
  return prompt.trim().replace(/\s+/g, ' ');
}

/**
 * Say out loud that the workbench answered Claude Code's trust gate, or that it could not. The
 * answer changes what runs in this directory without further review, so it is never silent.
 */
function trustNotice(result: { path: string; changed: boolean; error?: string }, cwd: string): string {
  if (result.error) return `已跳过 Claude Code 信任状态写入（${result.error}）；若启动后出现信任对话框，请在该会话的终端中确认。`;
  return `已把 ${cwd} 记入 Claude Code 的受信任目录（${result.path}），启动时不再询问。`;
}

/** A prompt as the CLI echoes it back: without the paste wrapper newer versions add, and trimmed. */
function shellPrompt(value: string): string { return stripPastedContent(value).replace(/\r\n/g, '\n').trim(); }

/**
 * A turn the CLI opened for itself — a finished subagent or background task reporting back — is not
 * something a person typed, so it can never be the message that was just sent.
 */
function isSyntheticPrompt(prompt: string | undefined, payload: Record<string, unknown>): boolean {
  const origin = string(asRecord(payload.origin)?.kind);
  if (origin !== undefined && origin !== 'human') return true;
  return prompt !== undefined && /^\s*<task-notification\b/i.test(prompt);
}

/** Who opened the turn, as the hook payload names it; a prompt that names nobody was typed. */
function originOf(payload: Record<string, unknown>): ClaudeTurnOrigin {
  const kind = string(asRecord(payload.origin)?.kind);
  return kind === undefined || kind === 'human' ? 'human' : kind === 'task-notification' ? 'task-notification' : kind === 'peer' ? 'peer' : 'other';
}

/**
 * Whether what the CLI says it was given could be what was sent: the same text, or the sent text
 * inside a wrapper or a rewrite (or the reverse, a shortened echo). Only an unrelated prompt is refused.
 */
function promptConsistent(hook: string | undefined, sent: Pick<PendingSend, 'text' | 'echo'>): boolean {
  const seen = hook === undefined ? '' : claudePromptKey(hook);
  if (!seen) return true;
  return [sent.text, sent.echo].some(expected => {
    const want = claudePromptKey(expected);
    return !want || seen === want || seen.includes(want) || want.includes(seen);
  });
}

function safeToolText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.slice(0, MAX_INTERACTION_TEXT);
  if (value === undefined) return undefined;
  try { return JSON.stringify(value).slice(0, MAX_INTERACTION_TEXT); } catch { return '[unavailable]'; }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export class ClaudeSessionRuntime {
  readonly nativeSessionId: string;
  readonly transcript: ClaudeTranscript;
  readonly listeners = new Set<(message: NativeControlMessage) => void>();
  /** Listeners of the service itself rather than of a client: they do not make the conversation worth polling closely. */
  /**
   * The conversation's state. Transcript rows and the participating hooks are the only inputs
   * (`session-state.ts` owns the transitions); `status.phase` is read off it and never inferred from the
   * screen. Only `dispatchSignal` and `replay` change it.
   */
  private state: ClaudeSessionState = initialState();
  private current: NativeStatus = { phase: 'offline', transcript: 'unavailable' };
  get status(): NativeStatus { return this.current; }
  terminalId?: string;
  started = false;
  private monitorStarted = false;
  private pollTimer?: NodeJS.Timeout;
  private terminalPollTimer?: NodeJS.Timeout;
  private pollDormant?: boolean;
  /** Both polls slow to `DORMANT_POLL_MS` once idle and unwatched; a new subscriber or a hook brings them back at once. */
  private readonly dormancy = new DormancyClock();
  private terminalStatusTask?: Promise<void>;
  private screenDialogTask?: Promise<void>;
  /** A dialog the CLI drew itself is on screen. It blocks the CLI, so the phase says so; it is not turn state. */
  private screenAttention = false;
  private unsubscribeTerminal?: () => void;
  private observedTerminalId?: string;
  /** Counts launches, so a terminal inspection begun before one is not taken as news of the process it started. */
  private launches = 0;
  private readonly readyGate = new ReadyGate({
    phase: () => this.status.phase,
    process: () => this.state.process,
    isDisposed: () => this.disposed,
    onFail: () => { this.setStatus({ ...this.status, notice: STARTUP_FAILED_MESSAGE, noticeLevel: 'error', connection: { state: 'failed', message: STARTUP_FAILED_MESSAGE } }); },
    onOpen: () => { this.dispatchSignal({ type: 'process', process: 'alive' }, { ...this.status, notice: undefined, noticeLevel: undefined }); },
  });
  /** The window and occupancy the CLI last stated to its status line, if it stated one. */
  private context?: NativeContext;
  private pendingSend?: PendingSend;
  /** A send whose receipt wait ran out, kept until its last re-check so a late transcript row still claims it. */
  private lateSend?: PendingSend;
  /** Sends the CLI holds in its own input queue: not a turn yet, but no longer in the composer. */
  private readonly queuedSends: PendingSend[] = [];
  /**
   * The last few messages this process typed. When the CLI is interrupted before it has answered, it puts
   * the message back into its input box; seeing one of these there is how a stale message is told from a draft.
   */
  private readonly recentSends: PendingSend[] = [];
  /** Commands whose Run already got its terminal event, so a second cause for the same end says nothing. */
  private readonly closedCommands = new Set<string>();
  private readonly lateTimers = new Set<NodeJS.Timeout>();
  /** Said once, with the next launch: why it starts a conversation of its own. */
  private launchNotice?: string;
  /** Prompt ids the hook has announced: a send claims the first one it has not seen. */
  private readonly seenPromptIds = new Set<string>();
  /**
   * The run each transcript row was claimed for, so re-mapping the file tags it the same way every time.
   * Not capped: every re-mapping asks again for every row, and a row that fell out would lose its run
   * and reset the transcript for every reader. One entry per claimed send.
   */
  private readonly claimedRows = new Map<string, string>();
  private readonly launchGuard: LaunchCrashGuard;
  private readonly adoption: TranscriptAdoption;
  private readonly overlay: ClaudeHookOverlay;
  private readonly composer: ComposerDriver;
  /** The profile the running CLI was launched with; `profile` can already name the one it moves to next. */
  private launchedProfileId?: string;
  private terminalExitNotice?: { terminalId: string; message: string };
  private activeWebTurn?: ActiveWebTurn;
  private nativeTurn?: NativeTurnTarget & { ownerRunId?: string };
  private readonly steerTools = new Set<string>();
  private readonly steering: DeferredSteerInputs;
  private readonly pending = new Map<string, PendingInteraction>();
  private readonly permissionToolUses = new Map<string, string>();
  private readonly recentToolUses = new Map<string, string>();
  /** Tool calls by what they ask, as their PreToolUse hook announced them: ahead of the transcript row that holds them. */
  private readonly announcedToolUses = new Map<string, string>();
  /** AskUserQuestion calls announced by PreToolUse whose PermissionRequest has not arrived yet, with when they were announced. */
  private readonly questionHooksDue = new Map<string, number>();
  private readonly statusWaiters = new Set<() => void>();
  private transcriptTask?: Promise<void>;
  /** The read queued behind the one in flight, shared by everyone who asked meanwhile. */
  private transcriptFollow?: Promise<void>;
  /** This process pressed Ctrl-C on the main turn: whatever ends it is the interruption. */
  private interrupting = false;
  /** Since when consecutive screen reads show no background work while the records still count some. */
  private backgroundScreen?: { since: number; reads: number };
  /** Hooks can prove execution before the CLI flushes its assistant/tool rows. */
  private outputPromptId?: string;
  /** A request to stop the conversation's background tasks that is still waiting for the CLI to report. */
  private stopping?: Promise<void>;
  /** Counts the turns that have started, so a stop can tell "my turn ended" from "another began". */
  private turnSeq = 0;
  /** Last sign of life from the CLI (a hook, transcript growth), for the long-silence notice. */
  private lastActivityAt = Date.now();
  private silenceNoticed = false;
  private stagedConfig?: Pick<Session, 'model' | 'approval'>;
  private disposed = false;
  private terminalExited = false;
  /** When the CLI was first found gone since it last ran (see `exitedAt`). */
  private exitSeen?: string;
  private configuring = false;
  /** A picked setting is not applied before this moment (`deferConfig`). */
  private configSettlesAt = 0;
  private settleTimer?: ReturnType<typeof setTimeout>;
  private startTask?: Promise<TerminalInfo | undefined>;
  private session: Session;
  private readonly metering: ClaudeStepMetering;
  /** What the conversation was last named from (see `readTranscript`). */
  private titleInputs?: string;
  private journalTurn?: { turnId: string; promptId?: string };

  constructor(private readonly host: NativeBackendHost, session: Session, private readonly project: Project, private profile: NativeBackendProfileConfig, private readonly resumeRequested: boolean, private readonly bridge: ClaudeHookBridge, launchNotice?: string, private readonly changes?: ClaudeTranscriptChanges, private readonly observer?: WorkspaceObserver) {
    this.session = session;
    this.launchGuard = new LaunchCrashGuard({
      host,
      session: () => this.session,
      isDisposed: () => this.disposed,
      isTerminalExited: () => this.terminalExited,
    });
    this.adoption = new TranscriptAdoption({
      host,
      session: () => this.session,
      transcriptState: () => this.transcript.state,
      emit: message => this.emit(message),
    });
    this.composer = new ComposerDriver({
      terminal: host.terminal,
      sessionId: () => this.session.id,
      assertExpectedStop: (stop, terminalId, allowEnded) => this.assertExpectedStop(stop, terminalId, allowEnded),
    });
    // A saved terminal with no change waiting runs what the record says, on this profile.
    if (session.terminalId && !session.configPending) this.launchedProfileId = profile.id;
    this.metering = new ClaudeStepMetering(host, session.id, message => this.emit(message));
    this.launchNotice = launchNotice;
    this.nativeSessionId = session.nativeSessionId ?? randomUUID();
    this.overlay = new ClaudeHookOverlay({
      host,
      bridge,
      nativeSessionId: this.nativeSessionId,
      project,
      profile: () => this.profile,
      session: () => this.session,
      isDisposed: () => this.disposed,
      onHook: (payload, deliveryId, signal) => this.handleHook(payload, deliveryId, signal),
    });
    this.terminalId = session.terminalId;
    this.steering = new DeferredSteerInputs(host, { backendId, sessionId: session.id, currentTarget: () => this.steerTarget() });
    if (this.terminalId) {
      this.state = initialState('starting');
      this.current = { phase: 'starting', transcript: 'unavailable' };
    }
    this.transcript = new ClaudeTranscript({ ...session, nativeSessionId: this.nativeSessionId }, this.nativeSessionId, {
      precedingConfigDir: configDirOf(profile),
      additionalContext: (text, nativeId, createdAt) => this.steering.receiptEvents(text, nativeId, createdAt),
      commandForUserMessage: message => this.commandForUserMessage(message),
      promptText: prompt => this.rewrites.get(rewriteKey(prompt)),
      putBlob: text => this.host.journal?.putSessionBlob(this.session.id, Buffer.from(text)),
      observedChanges: toolUseId => this.observer?.changes(this.session.id, toolUseId),
      onToolUse: (id, name, input) => this.onToolUse(id, name, input),
      onToolResult: (toolUseId, failed) => this.onToolResult(toolUseId, failed),
      // Transcript `model` is a display name ("Sonnet 4.5"), not the alias or id `--model` accepts, so
      // it may only be shown. Following it into the record would leave the next launch with a value
      // Claude Code cannot resolve — the opposite of what reading the CLI's own state is for.
      onModel: model => { this.setStatus({ ...this.status, model }); },
    });
  }

  async setStartRequested(): Promise<void> { await this.start(); }

  /**
   * Whether Claude Code is really running for this session.
   *
   * `started` only means *this process* launched or took over the TUI. After a workbench restart the
   * session still carries its `terminalId` and the CLI behind it is alive, while the runtime was rebuilt
   * by `subscribe` and started nothing — so a caller that trusted `started` alone treated a running
   * CLI as absent.
   */
  isLive(): boolean { return this.started || (this.terminalId !== undefined && !this.terminalExited); }

  /**
   * Marks a configuration change as in flight, so a hook read stops following the CLI's own mode.
   *
   * Per-runtime, not per-session as in DSH: one Claude runtime already is one session.
   */
  setConfiguring(configuring: boolean): void { this.configuring = configuring; }

  /**
   * Follow the permission mode Claude Code reports for its own TUI.
   *
   * The mode can be changed inside the CLI (Shift+Tab, `/permissions`), and every hook then carries
   * the mode the TUI is really in. Adopting it is what keeps a later *partial* `configure` — which
   * merges the record (`{...session, ...patch}` → `stagedConfig`) — from pinning the CLI back to a
   * mode the user has already left.
   *
   * Only a label `--permission-mode` accepts is adopted. An unknown one is either a mode from a
   * newer CLI or a non-mode label, and writing it into the record would make the next launch fail
   * on an argument this build cannot validate (`permissionArgs`).
   *
   * @param reported - `permission_mode` from the hook payload, verbatim and untrusted.
   * @returns the approval to publish in the status.
   */
  private adoptApproval(reported: unknown): string | undefined {
    const session = this.host.getSession(this.session.id);
    const recorded = session.approval;
    // The CLI still reports the mode being replaced while our own change is in flight; publishing
    // that would flicker the picker back, and writing it would undo the user's request.
    if (this.configuring || session.configPending) return this.status.approval ?? recorded;
    const permission = string(reported);
    if (!permission || permission === recorded) return recorded;
    if (!CLAUDE_PERMISSIONS.some(item => item.id === permission)) return recorded;
    // The meaning moved, so the record's revision has to move with it: a client holding the old
    // settings finds out before it submits rather than after (the store compares its expectation).
    // A message already waiting in the queue is delivered under the mode in effect when it starts.
    const updated = this.host.bumpConfig(session.id, { approval: permission });
    this.session = { ...this.session, approval: permission, configRevision: updated.configRevision ?? this.session.configRevision };
    this.emit({ type: 'session', session: updated });
    return permission;
  }

  /** Polling the transcript, so each settled response reaches the ledger without a backfill read. */
  get recordsUsage(): boolean { return this.monitorStarted && !this.disposed; }

  async monitor(): Promise<void> {
    if (this.monitorStarted || this.disposed) return;
    this.monitorStarted = true;
    // A CLI that outlived a restart keeps posting hooks; its conversation has to be routable before
    // anything else about it is known. Cold monitoring works from the transcript when this fails.
    if (this.terminalId) await this.overlay.registerHooks().catch(() => undefined);
    const configDir = configDirOf(this.profile);
    const file = await findClaudeTranscript(configDir, this.nativeSessionId);
    if (file) await this.transcript.setFile(file);
    this.schedulePolling();
    await this.refreshTranscript();
    await this.refreshTerminalStatus();
  }

  /**
   * Poll at full rate only while it can matter to somebody: a listener is attached, or a turn,
   * submission or dialog is open, or was within the last half minute. Past that an idle session is
   * polled every few seconds — enough to pick up a turn Claude starts on its own — and back at full
   * rate as soon as either changes.
   */
  private schedulePolling(): void {
    if (this.disposed || !this.monitorStarted) return;
    const quiet = this.state.mainTurn.kind === 'idle' && this.state.background.length === 0 && this.state.cliQueue.length === 0;
    const dormant = this.dormancy.dormant(this.listeners.size > 0 || !quiet || !!this.activeWebTurn || !!this.nativeTurn || !!this.pendingSend || this.queuedSends.length > 0 || this.pending.size > 0);
    const changed = dormant !== this.pollDormant;
    const waking = this.pollDormant === true && !dormant;
    this.pollDormant = dormant;
    if (!changed && this.pollTimer) return;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.terminalPollTimer) clearInterval(this.terminalPollTimer);
    this.pollTimer = setInterval(() => { void this.refreshTranscript(false); }, dormant ? DORMANT_POLL_MS : TRANSCRIPT_POLL_MS);
    this.pollTimer.unref?.();
    this.terminalPollTimer = setInterval(() => {
      void this.refreshTerminalStatus();
      // An idle conversation nobody watches shows nothing new on its screen; a turn, a hook or a client wakes it.
      if (!this.pollDormant) void this.refreshScreenState();
      void this.applyPendingConfig();
      this.checkSilence();
      this.schedulePolling();
    }, dormant ? DORMANT_POLL_MS : SCREEN_POLL_MS);
    this.terminalPollTimer.unref?.();
    // Whatever happened while polls were sparse is read now rather than at the next tick.
    if (waking) { void this.refreshTranscript(); void this.refreshScreenState(); }
  }

  /** A recorded switch survives old hooks and is applied only once nothing is running. */
  private async applyPendingConfig(): Promise<void> {
    if (this.disposed || this.configuring || this.startTask || Date.now() < this.configSettlesAt || !this.idleForRelaunch()
      || !this.host.getSession(this.session.id).configPending) return;
    this.configuring = true;
    try {
      await this.host.withSessionLock(this.session.id, async () => {
        const current = this.host.getSession(this.session.id);
        if (this.disposed || current.archivedAt || !current.configPending || !this.idleForRelaunch()) return;
        const opened = this.started ? await this.reconfigure(current) : await this.start();
        if (this.disposed) return;
        // A pick that landed while this relaunch ran is still waiting for one of its own.
        const pending = !this.launchedMatches(this.host.getSession(current.id));
        const updated = this.host.updateSession(current.id, {
          configPending: pending, ...(opened.terminalId ? { terminalId: opened.terminalId } : {}),
        });
        this.emit({ type: 'session', session: updated });
        if (pending) this.deferConfig();
      });
    } catch (error) {
      if (!(error instanceof AppError) || !['CLI_BUSY', 'CLI_INTERACTION_REQUIRED'].includes(error.code)) {
        this.setStatus({ ...this.status, notice: error instanceof Error ? error.message : 'Claude settings could not be applied.', noticeLevel: 'error' });
      }
    } finally { this.configuring = false; }
  }

  /** Whether a dialog the screen shows is one this CLI is known to wait on (see `screenDialogEndorsed`). */
  endorsesDialog(dialog: NativeInteraction): boolean {
    const now = Date.now();
    for (const [toolUseId, at] of this.questionHooksDue) if (now - at >= QUESTION_HOOK_GRACE_MS) this.questionHooksDue.delete(toolUseId);
    return screenDialogEndorsed(dialog, {
      held: this.pending.size > 0, turnOpen: this.state.mainTurn.kind !== 'idle', open: this.transcript.openToolUses(), questionHookDue: this.questionHooksDue.size > 0,
    });
  }

  /**
   * A hook held open for a person owns the screen, over the dialog the CLI draws for the same request.
   * One whose answer was delivered no longer does: the CLI may ask again in its own dialog.
   */
  private screenHeld(): boolean {
    const shown = this.status.interaction;
    const pending = [...this.pending.values()];
    return pending.some(item => !item.candidate)
      || (shown?.transport === 'protocol' && !pending.some(item => item.candidate && item.interaction.id === shown.id));
  }

  /**
   * The CLI's version when its screens were never captured (newer than `CLAUDE_CLI_VERSIONS.testedThrough`, or
   * unreadable). Walking a screen over several keys (the footer's agent list, the background task list) is left
   * to the reader on such a version: one misread step there presses keys into a surface nobody checked.
   */
  private async untestedVersion(): Promise<string | undefined> {
    const probe = await runHelp(executableOf(this.profile)).catch(() => undefined);
    return cliVersionStatus(CLAUDE_CLI_VERSIONS, probe?.parsed) === 'supported' ? undefined : probe?.parsed.text ?? 'of an unknown version';
  }

  /** The CLI draws its footer the way screen convergence reads it (`SCREEN_CONVERGENCE_VERSIONS`). */
  private async screenConvergenceSupported(): Promise<boolean> {
    const probe = await runHelp(executableOf(this.profile)).catch(() => undefined);
    return cliVersionStatus(SCREEN_CONVERGENCE_VERSIONS, probe?.parsed) === 'supported';
  }

  /** Nothing is running, waiting or queued: relaunching the CLI would end nothing. */
  private quiet(): boolean {
    return this.state.mainTurn.kind === 'idle' && this.state.background.length === 0 && this.state.cliQueue.length === 0;
  }

  /** Passive safety check: neither acquiring an observer nor reading the composer submits input. */
  async canReleaseInput(run: Run): Promise<boolean> {
    await this.refreshTerminalStatus(true);
    await this.refreshTranscript();
    if (!this.host.transcript) return false;
    await this.host.transcript.drain(this.session.id);
    const open = await this.host.transcript.withSource(this.session.id, (source, writer) =>
      source instanceof ClaudeTranscriptSource && (writer.scratch ?? writer).cursor !== null ? source.activeTurn(writer) !== undefined : true);
    if (open !== false) return false;
    const current = this.host.getSession(this.session.id);
    const terminalId = this.terminalId;
    const binding = run.native;
    if (this.disposed || this.terminalExited || !terminalId || !binding
      || current.nativeSessionId !== this.nativeSessionId || binding.nativeSessionId !== this.nativeSessionId
      || current.terminalId !== terminalId || binding.terminalId !== terminalId
      || this.transcript.state !== 'ok' || !this.idleForRelaunch() || this.pending.size > 0 || this.pendingSend || this.interrupting || this.stopping
      || this.transcript.activities().some(isLiveActivity)) return false;
    const terminal = await this.host.terminal.get(terminalId).catch(() => undefined);
    if (!terminal || terminal.kind !== 'native' || terminal.sessionId !== current.id || terminal.projectId !== current.projectId
      || terminal.state === 'exited' || (binding.terminalEpoch !== undefined && terminal.epoch !== binding.terminalEpoch)) return false;
    const screen = await this.host.terminal.screen(terminalId).catch(() => undefined);
    if (!screen || CLAUDE_CODE_BUSY_PATTERN.test(screen) || claudeViewsSubagent(screen) || claudeFooterFocused(screen) || claudeTasksEntryShown(screen)
      || !claudeComposerVisible(screen) || claudeComposerText(screen) !== '') return false;
    const checked = await this.host.terminal.get(terminalId).catch(() => undefined);
    if (!checked || checked.epoch !== terminal.epoch || checked.state === 'exited' || checked.kind !== 'native'
      || checked.sessionId !== current.id || checked.projectId !== current.projectId) return false;
    const latest = this.host.getSession(this.session.id);
    return !this.disposed && !this.terminalExited && this.idleForRelaunch() && !this.pendingSend && this.pending.size === 0
      && latest.terminalId === terminalId && latest.nativeSessionId === this.nativeSessionId;
  }

  private idleForRelaunch(): boolean {
    return this.state.process === 'alive' && !this.screenAttention && this.quiet();
  }

  /** Cold monitoring only observes the saved PTY. It never launches or writes to Claude. */
  private async refreshTerminalStatus(force = false): Promise<void> {
    if (this.disposed || (this.started && !force)) return;
    if (this.terminalStatusTask) return await this.terminalStatusTask;
    const task = (async () => {
      const session = this.host.getSession(this.session.id);
      if (!session.terminalId) {
        if (this.startTask) this.dispatchSignal({ type: 'process', process: 'starting' });
        else this.dispatchSignal({ type: 'process', process: 'exited' }, { ...this.status, notice: undefined, noticeLevel: undefined });
        return;
      }
      const observedSession = this.terminalId && (this.started || this.startTask)
        ? { ...session, terminalId: this.terminalId }
        : session;
      const sessionId = this.nativeSessionId;
      const launches = this.launches;
      const inspected = await inspectSavedTerminal(this.host, observedSession, dialog => this.endorsesDialog(dialog));
      // A launch begun meanwhile, or still under way, speaks for the process: the terminal inspected may be the one it
      // replaces, and its exit must not mark the new CLI gone.
      if (this.disposed || sessionId !== this.nativeSessionId || launches !== this.launches
        || (this.startTask && inspected.process === 'exited')
        || this.host.getSession(this.session.id).terminalId !== session.terminalId) return;
      if (inspected.terminal) {
        this.terminalId = inspected.terminal.id;
        if (inspected.terminal.kind === 'native' && inspected.terminal.sessionId === this.session.id && inspected.terminal.state !== 'exited') {
          this.terminalExited = false;
          if (this.observedTerminalId !== inspected.terminal.id) this.attachTerminal(inspected.terminal.id);
        }
      }
      if (inspected.process === 'exited' && inspected.terminal?.state === 'exited') {
        this.terminalExited = true;
        this.started = false;
      }
      // The inspection is the authority on whether anything still needs saying, so its notice wins
      // even when it has none. A warning from a previous inspection must clear when it recovers.
      // Likewise a screen dialog that has gone must not linger, but a hook-held request still stands —
      // and outranks the dialog the CLI draws for that same request, which it alone can answer (see `refreshScreenState`).
      const held = this.pending.size > 0 || this.status.interaction?.transport === 'protocol';
      const keepInteraction = held || (this.status.interaction !== undefined && !isClaudeScreenInteraction(this.status.interaction));
      this.screenAttention = !held && (inspected.interaction !== undefined || inspected.observed === true);
      const interaction = held ? this.status.interaction : inspected.interaction ?? (keepInteraction ? this.status.interaction : undefined);
      if (inspected.process === 'alive') this.terminalExitNotice = undefined;
      const exitNotice = inspected.process === 'exited' && inspected.terminal?.id === this.terminalExitNotice?.terminalId
        ? this.terminalExitNotice?.message : undefined;
      const status: NativeStatus = { ...this.status, notice: inspected.notice ?? exitNotice, noticeLevel: inspected.notice ? 'warning' : exitNotice ? 'error' : undefined, interaction, model: this.status.model ?? this.session.model };
      if (inspected.process === 'unknown') {
        // Neither proof of life nor of exit: the transcript's state stands, with a notice.
        if (this.state.process === 'starting') this.dispatchSignal({ type: 'process', process: 'alive' }, status);
        else this.setStatus(status);
        return;
      }
      if (inspected.process === 'exited') { this.dispatchSignal({ type: 'process', process: 'exited' }, status); return; }
      this.dispatchSignal({ type: 'process', process: 'alive' }, status);
    })();
    this.terminalStatusTask = task;
    try { await task; }
    finally { if (this.terminalStatusTask === task) this.terminalStatusTask = undefined; }
  }

  /**
   * The screen speaks only for what no record or hook can: a dialog the CLI drew itself (a notice, a
   * question it asks in the terminal), and whether a launch has drawn its input box yet. It never
   * decides whether a turn is running — that is the transcript's and the hooks'.
   */
  private async refreshScreenState(): Promise<void> {
    if (this.disposed || !this.terminalId || this.screenDialogTask || this.state.process === 'exited') return;
    if (this.screenHeld()) return;
    const terminalId = this.terminalId;
    const sessionId = this.nativeSessionId;
    const current = () => !this.disposed && !this.terminalExited && terminalId === this.terminalId
      && sessionId === this.nativeSessionId && !this.screenHeld();
    const task = (async () => {
      const terminal = await this.host.terminal.get(terminalId).catch(() => undefined);
      if (!terminal || terminal.state === 'exited' || !current()) return;
      const screen = await this.host.terminal.screen(terminalId).catch(() => undefined);
      if (!current() || screen === undefined) return;
      void this.convergeBackground(screen).catch(() => undefined);
      const drawn = claudeScreenInteraction(screen, terminal);
      // A dialog the shared terminal observer lifts and answers (see `claudeScreenInteraction`): the
      // session waits on it, and the card comes from the observer alone.
      const shape = drawn ? undefined : parseDialog(screen, terminal);
      const delivered = [...this.pending.values()].filter(item => item.candidate);
      if ((drawn || shape) && delivered.length) {
        // The dialog drawn while the hook was held may take a moment to close; past that it is the CLI asking
        // again, which the delivered answer can no longer settle and only the screen can answer.
        if (delivered.some(item => Date.now() - item.candidate!.deliveredAt < REPROMPT_SETTLE_MS)) return;
        for (const item of delivered) this.confirmProviderInteraction(item, 'Claude Code asked again in its terminal dialog.', 'uncertain');
      }
      const interaction = drawn && this.endorsesDialog(drawn) ? drawn : undefined;
      const observed = shape !== undefined && this.endorsesDialog(shape.interaction);
      if (interaction || observed) {
        this.screenAttention = true;
        this.setStatus({ ...this.status, interaction: interaction ?? (isClaudeScreenInteraction(this.status.interaction) ? undefined : this.status.interaction) });
        return;
      }
      const cleared = this.screenAttention;
      this.screenAttention = false;
      // A launched Claude whose SessionStart hook never came (it is lost, late, or of a source we did
      // not expect) would sit on `starting` for good: `send()` refuses it, and the cold-terminal
      // refresh stops once the launch is done. A drawn input box ends the wait.
      if (this.state.process === 'starting' && this.started && claudeComposerVisible(screen)) {
        this.dispatchSignal({ type: 'process', process: 'alive' }, { ...this.status, notice: undefined, noticeLevel: undefined, interaction: undefined });
        return;
      }
      if (cleared) this.setStatus({ ...this.status, interaction: isClaudeScreenInteraction(this.status.interaction) ? undefined : this.status.interaction });
    })();
    this.screenDialogTask = task;
    try { await task; }
    finally { if (this.screenDialogTask === task) this.screenDialogTask = undefined; }
  }

  /**
   * State convergence with the screen (docs/DELIVERY.md, 状态收敛): what the records imply is held against what an idle
   * CLI draws, and a claim of pending work the screen has contradicted for `BACKGROUND_SCREEN_SETTLE_MS` of consecutive
   * reads is dropped. Only claims that hold the conversation busy are converged; the screen never makes it busy.
   *
   *   background  derived from the records alone, so one whose end they never show would hold the conversation for
   *               good. The footer draws a tasks entry for shells and monitors and a list of rows for agents
   *               (captured on 2.1.302 and 2.1.322); with neither drawn, those entries are over. Workflows are not
   *               drawn there by any capture, so they are left to the records.
   *   cliQueue    the CLI's own queue, kept from `queue-operation` rows. A `dequeue` row does not name what it took,
   *               and the CLI does not take strictly in order, so one wrong guess leaves an entry that is never
   *               removed. An idle CLI runs whatever it holds at once, so an idle main turn with a queue is not a state.
   */
  private async convergeBackground(screen: string): Promise<void> {
    const entries = this.state.background.filter(task => task.kind !== 'workflow');
    const queued = this.state.cliQueue.length;
    // A screen showing an agent's view or with the footer focused draws the footer differently; it proves nothing.
    const idleScreen = claudeComposerVisible(screen) && !CLAUDE_CODE_BUSY_PATTERN.test(screen) && !claudeViewsSubagent(screen) && !claudeFooterFocused(screen);
    const showsBackground = claudeTasksEntryShown(screen) || claudeAgentRows(screen).length > 0;
    const background = !showsBackground ? entries : [];
    // Nothing of the conversation is in motion: what the screen showed can be held against the records.
    const settled = () => this.state.process === 'alive' && this.state.mainTurn.kind === 'idle' && !this.pendingSend
      && this.queuedSends.length === 0 && this.pending.size === 0 && this.status.interaction === undefined && !this.screenAttention && !this.interrupting && !this.stopping;
    if ((!background.length && !queued) || !idleScreen || !settled()) {
      this.backgroundScreen = undefined;
      return;
    }
    const now = Date.now();
    const seen = this.backgroundScreen ??= { since: now, reads: 0 };
    seen.reads += 1;
    if (seen.reads < BACKGROUND_SCREEN_MIN_READS || now - seen.since < BACKGROUND_SCREEN_SETTLE_MS) return;
    this.backgroundScreen = undefined;
    if (!await this.screenConvergenceSupported()) return;
    // The version probe can take a while: a stop, a dialog or a send that began meanwhile makes the screen read stale.
    if (!settled() || this.terminalExited) return;
    if (this.state.cliQueue.length) {
      console.warn('[claude] cli queue converged from screen', { sessionId: this.session.id, entries: this.state.cliQueue.map(entry => entry.kind) });
      this.dispatchSignal({ type: 'queue', operation: 'clear' });
    }
    const current = this.state.background.filter(task => background.some(entry => entry.toolUseId === task.toolUseId));
    if (!current.length) return;
    console.warn('[claude] background converged from screen', { sessionId: this.session.id, tasks: current.map(task => `${task.kind ?? 'agent'}:${task.toolUseId}`) });
    for (const task of current) {
      this.dispatchSignal({ type: 'background_done', toolUseId: task.toolUseId });
      for (const activity of this.transcript.activities()) {
        if (isLiveActivity(activity) && (activity.toolCallId === task.toolUseId || activity.id === `claude:${task.agentId ?? task.taskId}`)) this.publishActivity({ ...activity, status: 'unknown' });
      }
    }
  }

  subscribe(listener: (message: NativeControlMessage) => void): () => void {
    this.listeners.add(listener);
    this.schedulePolling();
    queueMicrotask(() => {
      if (!this.listeners.has(listener)) return;
      if (this.context) this.safeCall(listener, { type: 'context', context: this.context });
      this.safeCall(listener, { type: 'status', status: this.status });
    });
    return () => this.unsubscribe(listener);
  }

  unsubscribe(listener: (message: NativeControlMessage) => void): void {
    this.listeners.delete(listener);
    this.schedulePolling();
  }

  private safeCall(listener: (message: NativeControlMessage) => void, message: NativeControlMessage): void {
    try { listener(message); } catch { /* A disconnected stream does not stop the CLI watcher. */ }
  }

  private emit(message: NativeControlMessage): void {
    for (const listener of this.listeners) this.safeCall(listener, message);
  }

  /** `NativeStatus.phase`: the process and the main turn, plus a dialog that blocks the CLI itself. */
  private phase(): NativeStatus['phase'] {
    const phase = phaseOf(this.state);
    return this.screenAttention && phase !== 'offline' ? 'attention' : phase;
  }

  /**
   * The live turn as clients group the transcript: the app Run that owns it, the prompt id every row of a
   * turn the CLI opened on its own carries as `nativeTurnId` (a peer's hand-back, a prompt typed in the
   * terminal), or for a task report's turn, whose rows carry no `nativeTurnId`, the `runId` they do carry.
   * Without it a client has to guess the turn from the latest visible prompt — and a turn opened by a hidden
   * row has none, so its rows read as finished while the CLI is still working.
   */
  private activeTurnId(phase: NativeStatus['phase']): string | undefined {
    if (phase !== 'busy' && phase !== 'attention') return undefined;
    const promptId = activeTurnOf(this.state.mainTurn)?.promptId;
    if (!promptId) return undefined;
    if (this.journalTurn?.promptId === promptId && this.journalTurn.turnId !== promptId) return this.journalTurn.turnId;
    if (this.nativeTurn?.turnId === promptId && this.nativeTurn.ownerRunId) return this.nativeTurn.ownerRunId;
    return this.transcript.rowTurnOf(promptId) ?? promptId;
  }

  /** Publish everything but the phase, which always comes from the state. */
  private setStatus(requested: Omit<NativeStatus, 'phase'>): void {
    const phase = this.phase();
    if (phase !== 'starting') this.readyGate.clear();
    // The launch failure is only true while the launch has not recovered.
    const { activeTurn: _oldTarget, activeTurnId: _oldTurnId, phase: _ignored, connection, notice: requestedNotice, noticeLevel: requestedLevel, interaction: requestedInteraction, ...withoutInteraction } = requested as NativeStatus;
    // A card the CLI raised through a hook lives exactly as long as the request behind it: a status built before the request
    // went away must not bring it back.
    const interaction = requestedInteraction?.transport === 'protocol' && ![...this.pending.values()].some(pending => pending.interaction.id === requestedInteraction.id) ? undefined : requestedInteraction;
    const rest = { ...withoutInteraction, ...(interaction ? { interaction } : {}) };
    // The long-silence notice is withdrawn as soon as the CLI shows life or the turn ends.
    const notice = requestedNotice === TURN_SILENCE_NOTICE && !this.silenceNoticed ? undefined : requestedNotice;
    const activeTurnId = this.activeTurnId(phase);
    // Background work and compaction in progress, independent of the main turn. A CLI that has exited has none: its tasks died with it.
    const status: NativeStatus = withActivity({ ...rest, ...(notice !== undefined ? { notice, noticeLevel: requestedLevel } : {}), ...(activeTurnId ? { activeTurnId } : {}), phase, transcript: this.transcript.state,
      ...(connection && !(phase !== 'starting' && connection.state === 'failed') ? { connection } : {}), ...(this.nativeTurn && (phase === 'busy' || phase === 'attention') ? { activeTurn: this.nativeTurn } : {}) },
    this.state.process === 'exited' ? [] : this.transcript.activities(), { upgradePhase: false });
    if (JSON.stringify(this.status) === JSON.stringify(status)) return;
    this.current = status;
    this.emit({ type: 'status', status });
    this.schedulePolling();
  }

  /**
   * Feed one signal to the state, carry out what the transition means, and publish. `status` is what
   * to publish alongside; the phase in it is always the state's.
   */
  private dispatchSignal(signal: ClaudeSignal, status?: Omit<NativeStatus, 'phase'>): Transition {
    const transition = reduce(this.state, signal);
    this.state = transition.state;
    if (transition.ended) this.onTurnEnded(transition.ended);
    if (transition.started) this.onTurnStarted(transition.started);
    if (transition.queue) this.onQueue(transition.queue);
    if (signal.type === 'process') this.onProcess(signal.process);
    if (signal.type === 'compact_boundary' || signal.type === 'agents_killed') this.noteActivity();
    // The boundary completes the compaction its hook started; one a remap of the file lost track of is completed with it.
    if (signal.type === 'compact_boundary') {
      for (const activity of this.transcript.activities()) if (activity.kind === 'compaction' && isLiveActivity(activity)) this.publishActivity({ ...activity, status: 'completed' });
    }
    // The callbacks above publish on their own (a turn that ends clears the card it left open): the status that goes out
    // is the one they left, not the one from before them.
    this.setStatus(status ?? this.status);
    for (const wake of [...this.statusWaiters]) wake();
    return transition;
  }

  /**
   * Take a transcript read into the state. A first read (or a rewritten file) is the whole conversation:
   * the state is re-derived from it without carrying out any of the transitions along the way — they
   * are history. What is still open at its end is what the CLI is doing now.
   */
  private async applyLifecycle(lifecycle: ClaudeTranscriptLifecycle): Promise<void> {
    if (lifecycle.replay) {
      const previous = this.state;
      let state = replay(this.state, lifecycle.signals);
      const turn = activeTurnOf(state.mainTurn);
      if (turn?.promptId && this.terminalId && this.host.transcript) {
        const promptId = turn.promptId;
        const closed = await this.host.transcript.withSource(this.session.id, (source, w) => source instanceof ClaudeTranscriptSource && source.closedPrompt(w, promptId));
        // A stop before the first answer need not write anything to JSONL. Its journal cursor is durable;
        // old versions could, however, confirm without inspecting the terminal, so verify its native idle
        // surface too. A busy CLI or another prompt is never hidden by an old cancellation.
        const idle = closed && await this.stopIdleScreen(this.terminalId);
        // Hooks may have advanced the state while the journal/terminal was read.
        if (this.state !== previous) state = replay(this.state, lifecycle.signals);
        if (idle && activeTurnOf(state.mainTurn)?.promptId === promptId) state = reduce(state, { type: 'turn_end', source: 'hook', reason: 'interrupted', promptId }).state;
      }
      this.state = state;
      if (this.nativeTurn && this.nativeTurn.turnId !== activeTurnOf(state.mainTurn)?.promptId) {
        this.nativeTurn = undefined;
        this.steerTools.clear();
      }
      this.setStatus(this.status);
      for (const wake of [...this.statusWaiters]) wake();
      return;
    }
    for (const signal of lifecycle.signals) this.dispatchSignal(signal);
  }

  /** The background agents the transcript's metadata still shows as working. */
  private syncBackground(): void {
    const agents = this.transcript.backgroundAgents();
    const key = (list: Array<{ toolUseId: string }>) => list.map(agent => agent.toolUseId).sort().join('\n');
    const next = reduce(this.state, { type: 'background', agents }).state.background;
    if (key(next) === key(this.state.background)) return;
    this.dispatchSignal({ type: 'background', agents });
  }

  private onTurnStarted(started: NonNullable<Transition['started']>): void {
    this.noteActivity();
    this.outputPromptId = undefined;
    this.turnSeq += 1;
    // Guidance is claimed at a hook boundary, so only a turn a hook announced can be steered.
    if (started.source === 'hook' && started.promptId && this.state.process !== 'exited') {
      this.nativeTurn = { nativeSessionId: this.nativeSessionId, turnId: started.promptId, ...(this.activeWebTurn ? { ownerRunId: this.activeWebTurn.runId } : {}) };
    } else if (started.source === 'transcript' && started.promptId && !this.nativeTurn && this.state.process !== 'exited') {
      // A cold start replays the transcript, so a turn that was already running is announced by its
      // own rows, not by the hook that opened it. The status still has to name that turn: a Run the
      // restart left unconfirmed is resumed only by activity of this exact session and turn.
      this.nativeTurn = { nativeSessionId: this.nativeSessionId, turnId: started.promptId };
    }
    // A row that opened the turn after the CLI took it off its own queue names the send it belongs to.
    if (started.source === 'transcript' && started.uuid) {
      const commandId = this.claimedRows.get(started.uuid);
      const send = commandId ? this.claimables().find(item => item.commandId === commandId) : undefined;
      if (send && !(this.host.transcript && send.queued)) {
        send.promptSeen = true;
        if (started.promptId) send.promptId = started.promptId;
        this.bindWebTurn(send, started.promptId);
      }
    }
  }

  /** Whatever ended the turn closes everything that hung on it, now, without asking the screen. */
  private onTurnEnded(ended: NonNullable<Transition['ended']>): void {
    this.noteActivity();
    // A compaction that ends any way but its boundary did not finish; the rows may say so later, the hook says so now.
    if (ended.compact && (ended.reason === 'stop_failure' || ended.reason === 'interrupted')) this.settleCompactions(ended.reason === 'interrupted' ? 'stopped' : 'failed');
    const target = this.nativeTurn;
    this.nativeTurn = undefined;
    this.steerTools.clear();
    if (this.pending.size) this.cancelPending('Claude returned to its prompt without confirming the submitted response.');
    const outcome = ended.reason === 'stop_failure' ? 'run_failed' : ended.reason === 'interrupted' || this.interrupting ? 'run_cancelled' : ended.reason === 'exit' ? 'run_failed' : 'run_completed';
    const reason = ended.reason === 'interrupted' || this.interrupting ? 'Claude confirmed that the turn was interrupted.'
      : ended.reason === 'exit' ? 'Claude hook connection was lost.' : undefined;
    this.steering.reject(ended.reason === 'exit' ? 'Claude hook connection was lost.' : 'Claude finished before receiving further guidance.', target);
    const error = ended.reason === 'stop_failure' ? ended.error ?? CLAUDE_TURN_FAILED : undefined;
    if (target) this.steering.finish(target, { type: outcome, ...(reason ? { reason } : {}), ...(error ? { error } : {}) });
    const web = this.activeWebTurn;
    this.activeWebTurn = undefined;
    if (web && ended.reason !== 'exit') {
      // An end the transcript records (an answer's duration row, the API error a failure writes, the next prompt) settles
      // the Run through the journal's turn mark.
      const marked = !this.interrupting && (ended.reason === 'stop' || ended.reason === 'duration' || ended.reason === 'superseded' || ended.reason === 'stop_failure');
      this.emitRunTerminal(outcome, web, error, reason, marked);
    }
  }

  private onProcess(process: ClaudeProcess): void {
    if (process === 'exited') {
      this.cancelPending('Claude Code terminal exited before confirming the response.');
      this.queuedSends.length = 0;
      this.abandonActivities();
      if (!this.exitSeen) {
        this.exitSeen = new Date().toISOString();
        this.host.transcript?.wake(this.session.id);
      }
    } else this.exitSeen = undefined;
    if (process === 'starting') this.screenAttention = false;
  }

  /**
   * Since when the CLI is known to be gone, while it is. The journal's reader ends the turn and the activities it left
   * open as of then, once it has read what is on disk (`ClaudeTranscriptSource`), however much later that read comes.
   */
  get exitedAt(): string | undefined { return this.exitSeen; }

  /** A turn the CLI ends without writing so: persist its end after reading what is on disk (G6). */
  private async endJournalTurn(status: TurnEndStatus, promptId: string): Promise<void> {
    const at = new Date().toISOString();
    if (!this.host.transcript) return;
    const closed = await this.host.transcript.withSource(this.session.id, async (source, w) => {
      if (!(source instanceof ClaudeTranscriptSource)) return false;
      await source.endTurn(w, status, at, promptId);
      return source.closedPrompt(w, promptId);
    });
    if (!closed) throw new AppError('NATIVE_INTERRUPT_UNCONFIRMED', 'Claude stopped, but its turn end could not be persisted', 409);
  }

  /** Adds a state of an activity that the rows do not show to the status summary. */
  private publishActivity(activity: NativeActivity, options: { restored?: boolean } = {}): void {
    this.transcript.injectActivity(activity, options);
    this.setStatus(this.status);
  }

  /**
   * A compaction the CLI is starting (its PreCompact hook). Rows it wrote before (a bare `/compact` up to 2.1.302) are
   * read first so the hook joins that compaction; since 2.1.322 there are none until its boundary.
   */
  private async compactionHooked(trigger: 'manual' | 'auto', deliveryId: string): Promise<void> {
    await this.refreshTranscript().catch(() => undefined);
    if (this.disposed) return;
    const id = activityId('claude', `compaction:${deliveryId}`);
    const at = new Date().toISOString();
    // The `/compact` being sent is running: its rows only come at the boundary, long after the receipt window.
    const send = this.pendingSend;
    if (trigger === 'manual' && send?.compact && send.fenced && !send.receiptSettled) {
      send.compactionStarted = true;
      send.receiptWake?.();
    }
    this.transcript.compactionHooked(id, trigger, at);
    await this.host.transcript?.withSource(this.session.id, (source, w) =>
      source instanceof ClaudeTranscriptSource ? source.compactionHooked(w, id, trigger, at) : undefined).catch(() => undefined);
    this.dispatchSignal({ type: 'compact_start', origin: trigger === 'manual' ? 'human' : 'other' });
  }

  private settleCompactions(status: 'failed' | 'stopped'): void {
    for (const activity of this.transcript.activities()) {
      if (activity.kind === 'compaction' && isLiveActivity(activity)) this.publishActivity({ ...activity, status });
    }
  }

  /** A CLI that is gone took its background tasks and any compaction in progress with it. */
  private abandonActivities(): void {
    for (const activity of this.transcript.activities()) {
      if (isLiveActivity(activity)) this.publishActivity({ ...activity, status: 'unknown' });
    }
  }

  /** The CLI's own input queue moved: the sends waiting in it are delivered, still waiting, or taken back. */
  private onQueue(change: NonNullable<Transition['queue']>): void {
    this.noteActivity();
    if (change.operation === 'enqueue' && change.entry?.kind === 'input') {
      const send = this.claimables().find(item => item.fenced && !item.promptSeen && !item.queued && !item.command
        && (change.text === undefined || promptConsistent(change.text, item)));
      if (send) {
        send.queued = true;
        if (this.host.transcript && send.claimedRow) {
          if (this.claimedRows.get(send.claimedRow) === send.commandId) this.claimedRows.delete(send.claimedRow);
          send.claimedRow = undefined;
        }
        if (!this.queuedSends.includes(send)) this.queuedSends.push(send);
        send.receiptWake?.();
      }
      return;
    }
    if (change.operation === 'remove' && change.entry?.kind === 'input') {
      // The journal follows every native queue item, including terminal-owned inputs. This
      // in-memory text match cannot decide an outcome or remove its precise association.
      if (this.host.transcript) return;
      const text = change.text ?? change.entry.text;
      const send = this.queuedSends.find(item => text === undefined || promptConsistent(text, item));
      if (!send) return;
      this.unqueue(send);
      // Taken into the running turn, or handed to an agent: delivered. Anything else took it back.
      if (change.reason === 'absorbed_mid_turn' || change.reason === 'delivered_to_agent') {
        this.emitRunTerminal('run_completed', { commandId: send.commandId, runId: send.runId });
      } else {
        this.emitRunTerminal('run_cancelled', { commandId: send.commandId, runId: send.runId }, undefined, `Claude Code removed the message from its input queue${change.reason ? ` (${change.reason})` : ''}.`);
      }
    }
  }

  private unqueue(send: PendingSend): void {
    const index = this.queuedSends.indexOf(send);
    if (index >= 0) this.queuedSends.splice(index, 1);
  }

  /** Release only the queue input the journal matched; replaying the same receipt is harmless. */
  releaseQueuedInput(commandId: string): void {
    const send = this.queuedSends.find(send => send.commandId === commandId);
    if (send) this.unqueue(send);
  }

  /** The sends that may still be matched to a prompt, oldest first. */
  private claimables(): PendingSend[] {
    return [...new Set([this.pendingSend, this.lateSend, ...this.queuedSends].filter((send): send is PendingSend => send !== undefined))];
  }

  /** The send's turn is the one in flight: its end is the Run's end. */
  private bindWebTurn(send: PendingSend, promptId: string | undefined): void {
    if (this.host.transcript && send.queued) return;
    this.unqueue(send);
    if (send.command) return;
    if (send.stopRequested) {
      send.stopRequested = false;
      if (promptId) void this.stopLateTurn(promptId);
    }
    this.activeWebTurn = { commandId: send.commandId, runId: send.runId, ...(promptId ? { promptId } : {}) };
    if (this.nativeTurn && (!promptId || this.nativeTurn.turnId === promptId)) this.nativeTurn = { ...this.nativeTurn, ownerRunId: send.runId };
  }

  /**
   * A stop that came while this prompt's outcome was unknown, and the prompt has since started (docs/DELIVERY.md §3,
   * rule 3). Only that exact turn is stopped, under the session lock like any other stop, so it neither races the
   * user's own stop nor reaches a later turn, background work or the input box. It waits for the turn to show it runs:
   * at the prompt hook the screen can still look idle, which a stop reads as a turn the CLI dropped.
   */
  private async stopLateTurn(promptId: string): Promise<void> {
    const own = () => activeTurnOf(this.state.mainTurn)?.promptId === promptId;
    const shown = await waitFor(async () => {
      if (!own()) return 'over';
      if (this.outputPromptId === promptId || this.transcript.hasTurnOutput(promptId)) return 'running';
      const screen = this.terminalId ? await this.host.terminal.screen(this.terminalId).catch(() => undefined) : undefined;
      return screen !== undefined && CLAUDE_CODE_BUSY_PATTERN.test(screen) ? 'running' : undefined;
    }, { timeoutMs: LATE_STOP_WAIT_MS, intervalMs: 250, wake: notify => { this.statusWaiters.add(notify); return () => { this.statusWaiters.delete(notify); }; } });
    if (shown === 'over') return;
    const failed = (reason: string) => {
      console.warn('[claude] stop of a prompt that started after the stop failed', { sessionId: this.session.id, promptId, reason });
      this.setStatus({ ...this.status, notice: 'A message started after Stop was pressed and could not be stopped; check the terminal.', noticeLevel: 'error' });
    };
    if (shown !== 'running') return failed('the turn showed no sign of running');
    try {
      await this.host.withSessionLock(this.session.id, async () => {
        const terminalId = this.terminalId;
        if (!terminalId || !own()) return;
        await this.stopMainTurn(terminalId, { requestId: `late-stop:${promptId}`, nativeSessionId: this.nativeSessionId, turnId: promptId, terminalId });
      });
    } catch (error) { failed(error instanceof Error ? error.message : String(error)); }
  }

  /** Any sign of life from the CLI: the long-silence notice is withdrawn. */
  private noteActivity(): void {
    this.lastActivityAt = Date.now();
    // Any sign of life (a hook, a transcript row) ends dormancy now rather than at the next slow tick.
    if (this.pollDormant) { this.dormancy.watched(this.lastActivityAt); this.schedulePolling(); }
    if (!this.silenceNoticed) return;
    this.silenceNoticed = false;
    this.setStatus(this.status);
  }

  /** A turn that neither ends nor shows life for a very long time is said out loud; its state is left alone. */
  private checkSilence(): void {
    const turn = activeTurnOf(this.state.mainTurn);
    if (!turn || this.pending.size > 0 || this.silenceNoticed || Date.now() - this.lastActivityAt < TURN_SILENCE_MS) return;
    this.silenceNoticed = true;
    this.setStatus({ ...this.status, notice: TURN_SILENCE_NOTICE, noticeLevel: 'warning' });
  }

  /**
   * Reads what the CLI has written since the last read. A caller that arrives while a read is under way gets one that
   * *starts after* the call: the read in flight may have begun before the row the caller is waiting for was on disk
   * (a Stop hook is posted before the last answer is flushed). `follow: false` is for the poll, which will be back soon enough.
   */
  private async refreshTranscript(follow = true): Promise<void> {
    if (this.disposed) return;
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
    const previousTranscriptState = this.status.transcript;
    const sessionId = this.nativeSessionId;
    const result = await this.transcript.refresh();
    if (this.disposed || sessionId !== this.nativeSessionId) return;
    if (result.reset || result.events.length || result.subagents.length) this.changes?.emit(this.session.id);
    if (result.reset || result.events.length) this.noteActivity();
    if (!result.reset && result.events.length) {
      for (const event of result.events) {
        const commandId = typeof event.data.commandId === 'string' ? event.data.commandId : undefined;
        if (commandId && this.pendingSend?.commandId === commandId && !this.pendingSend.receiptSettled) {
          this.pendingSend.receiptSettled = true;
          this.pendingSend.resolveReceipt(event);
        }
      }
    }
    // The records decide the turn. They follow the events they describe, so a Run is seen to start
    // before it is seen to end, and they are applied before anything below looks at the phase.
    await this.applyLifecycle(result.lifecycle);
    if ((result.reset || result.events.length || result.lifecycle.replay) && this.host.transcript) {
      this.journalTurn = await this.host.transcript.withSource(this.session.id, (source, w) => source instanceof ClaudeTranscriptSource ? source.activeTurn(w) : undefined);
      this.setStatus(this.status);
    }
    this.syncBackground();
    // A tail response stays `live` until a later row supersedes it. Once the turn is over, that
    // tail is settled too: the session is idle or the CLI is gone.
    this.metering.publish(result.steps, this.status.phase === 'idle' || this.status.phase === 'offline');
    // A resumed conversation is first named from the human message its transcript replays, then
    // upgraded once Claude Code's own model has written a title into the transcript (see
    // `session-title.ts`; both patches are idempotent).
    // Keep the complete first prompt for language matching. The title stand-in is capped, and a
    // truncated English-only prefix can otherwise make an English provider title look compatible
    // with a Chinese conversation.
    // Both read the session from the store, so they run when the rows moved or what they name from did.
    const humanMessage = this.transcript.firstHumanMessage();
    const titleInputs = `${humanMessage ?? ''}\u0000${this.transcript.title ?? ''}`;
    if (result.reset || result.events.length || titleInputs !== this.titleInputs) {
      this.titleInputs = titleInputs;
      if (humanMessage) this.adoption.nameFromMessage(humanMessage);
      if (this.transcript.title) this.adoption.adoptTranscriptTitle(this.transcript.title, humanMessage);
    }
    this.adoption.adoptTranscriptGoal(this.transcript.goal);
    for (const frame of result.subagents) if (frame.running !== undefined) this.emit({ type: 'subagent', toolCallId: frame.toolCallId, agentId: frame.agentId, running: frame.running });
    if (this.transcript.state !== previousTranscriptState) this.setStatus({ ...this.status, transcript: this.transcript.state });
    // Activities change with the rows (and with what the files add to them): the summary on the status follows.
    else if (result.reset || result.events.length) this.setStatus(this.status);
    // Tasks a CLI that is no longer running left in its transcript never report an end.
    if (this.state.process === 'exited') this.abandonActivities();
  }

  /**
   * The prompts this runtime moved behind a skill, by what Claude stores for them, so the
   * transcript shows the user's text rather than the rewrite. Kept only for this runtime's life: a
   * later process reading the same transcript shows the rewrite, which is what Claude received.
   * Not capped, for the reason `claimedRows` is not: each re-mapping asks again for every row.
   */
  readonly rewrites = new Map<string, string>();

  private rememberRewrite(delivered: string, original: string): void {
    this.rewrites.set(rewriteKey(delivered), original);
  }

  /**
   * The run a transcript user row belongs to. A send claimed by its first new `prompt_id` is matched
   * by that id; the text only decides when a row has no id, or when no hook has claimed the send. A row, once matched, keeps its run on every re-mapping of the file.
   */
  commandForUserMessage(message: { uuid: string; promptId?: string; text: string }): string | undefined {
    const known = this.claimedRows.get(message.uuid);
    if (known && this.host.transcript && this.recentSends.some(send => send.queued && send.commandId === known)) {
      this.claimedRows.delete(message.uuid);
      return undefined;
    }
    if (known) return known;
    for (const pending of this.claimables()) {
      if (this.host.transcript && pending.queued) continue;
      if (pending.baselineUserIds.has(message.uuid) || pending.claimedRow) continue;
      if (pending.promptSeen) {
        if (pending.promptId && message.promptId && pending.promptId !== message.promptId) continue;
        if (!message.promptId && claudePromptKey(message.text) !== claudePromptKey(pending.echo)) continue;
      } else {
        // No hook claimed this send (it is lost, late, or showed something else): only a row that no hook
        // has seen and that reads as the sent text can be it.
        if (message.promptId && this.seenPromptIds.has(message.promptId)) continue;
        if (claudePromptKey(message.text) !== claudePromptKey(pending.echo)) continue;
      }
      pending.claimedRow = message.uuid;
      this.claimedRows.set(message.uuid, pending.commandId);
      return pending.commandId;
    }
    return undefined;
  }

  async start(): Promise<{ nativeSessionId: string; terminalId?: string }> {
    if (this.disposed) throw new AppError('CLAUDE_RUNTIME_DISPOSED', 'Claude runtime has been closed', 503);
    if (this.started && this.terminalId) {
      const current = this.host.getSession(this.session.id);
      if (selectedModel(current, this.profile) !== selectedModel(this.session, this.profile) || current.approval !== this.session.approval
        || this.launchedProfileId !== this.profile.id) {
        this.setConfiguring(true);
        try { return await this.reconfigure(current); }
        finally { this.setConfiguring(false); }
      }
      return { nativeSessionId: this.nativeSessionId, terminalId: this.terminalId };
    }
    if (this.startTask) {
      const terminal = await this.startTask;
      return { nativeSessionId: this.nativeSessionId, ...(terminal ? { terminalId: terminal.id } : {}) };
    }
    this.startTask = this.startTui();
    try {
      const terminal = await this.startTask;
      this.started = Boolean(terminal);
      if (terminal) this.terminalId = terminal.id;
      return { nativeSessionId: this.nativeSessionId, ...(terminal ? { terminalId: terminal.id } : {}) };
    } finally { this.startTask = undefined; }
  }

  private async startTui(): Promise<TerminalInfo | undefined> {
    const persisted = this.host.getSession(this.session.id);
    const current = this.stagedConfig ? { ...persisted, ...this.stagedConfig } : persisted;
    const model = selectedModel(current, this.profile);
    await validateModelSelection(this.profile, model);
    const availability = await claudeAvailability(this.profile);
    if (!availability.available) throw new AppError('CLAUDE_UNAVAILABLE', availability.reason ?? 'Claude Code is unavailable', 503);
    const adopted = await this.adoptExistingTerminal();
    if (adopted) return adopted;
    await this.overlay.ensureHookServer(model);
    const configDir = configDirOf(this.profile);
    // The workspace-trust dialog appears before any session exists, so no hook can answer it. Claude
    // Code persists the answer per project; recording it here is what keeps the launch in the web
    // UI. Only the profile's own `configDir` is passed: `configDirOf` defaults it to `~/.claude`,
    // which would move the global config to `~/.claude/.claude.json` — a path Claude never reads.
    const trust = ensureClaudeWorkspaceTrust({ configHome: string(this.profile.config.configDir), cwd: this.project.cwd });
    const oldTranscript = await findClaudeTranscript(configDir, this.nativeSessionId);
    if (this.resumeRequested && !oldTranscript) throw new AppError('CLAUDE_SESSION_NOT_FOUND', 'The saved Claude session could not be found in this profile', 404);
    if (oldTranscript) {
      await this.transcript.setFile(oldTranscript);
      // What the old CLI left behind is history: it is read before the launch, which then starts turn-free.
      await this.refreshTranscript();
    }
    const args = [
      ...(oldTranscript ? ['--resume', this.nativeSessionId] : ['--session-id', this.nativeSessionId]),
      // Riffet's own MCP server for this launch only; the reader's MCP configuration still loads beside it.
      ...(this.overlay.mcpConfigFile ? ['--mcp-config', this.overlay.mcpConfigFile] : []),
      '--settings', this.overlay.overlayFile!,
      ...modelArgs(model, await declaredLongContext(this.profile, model)),
      ...permissionArgs(current.approval ?? string(this.profile.config.approval)),
    ];
    const launchNotice = this.launchNotice;
    this.launchNotice = undefined;
    // The hooks find the server through the descriptor. The endpoint's token would let anything the CLI runs speak as any
    // conversation, so it is put in the environment only where there is no descriptor to read.
    const env = {
      ...profileEnv(this.profile),
      ...(this.bridge.descriptorPath ? {} : { RIFFET_CLAUDE_HOOK_URL: this.overlay.hookUrl!, RIFFET_CLAUDE_HOOK_TOKEN: this.overlay.hookToken! }),
    };
    this.session = current;
    // From here the terminal being replaced no longer speaks for the process: its exit, reported late, would mark the
    // new CLI gone. The launched terminal is observed once it exists (`attachTerminal`).
    this.launches += 1;
    this.unsubscribeTerminal?.();
    this.unsubscribeTerminal = undefined;
    this.observedTerminalId = undefined;
    this.dispatchSignal({ type: 'process', process: 'starting' }, {
      transcript: this.transcript.state,
      model: selectedModel(current, this.profile), approval: current.approval,
      ...(launchNotice || (trust && (trust.changed || trust.error)) ? { notice: [launchNotice, trust && (trust.changed || trust.error) ? trustNotice(trust, this.project.cwd) : undefined].filter(Boolean).join(' '), noticeLevel: trust?.error ? 'error' : launchNotice ? 'warning' : 'info' } : {}),
    });
    const terminal = await this.host.launchPty(current, this.project, {
      command: executableOf(this.profile), args, env, cwd: this.project.cwd,
      title: 'Claude Agent',
    });
    this.terminalId = terminal.id;
    this.launchedProfileId = this.profile.id;
    this.launchGuard.begin(terminal.id);
    this.attachTerminal(terminal.id);
    if (this.state.process === 'starting') this.readyGate.arm();
    if (this.host.getSession(current.id).configPending) this.host.updateSession(current.id, { configPending: false });
    return terminal;
  }

  /**
   * A CLI that outlived the server is taken over, never restarted: its hooks reach whichever server
   * is up (the descriptor), and what it is doing is read back from its transcript. The one exception
   * is a recorded model or permission change, which only a new launch can apply, and only while
   * nothing is running that a relaunch would end.
   */
  private async adoptExistingTerminal(): Promise<TerminalInfo | undefined> {
    const session = this.host.getSession(this.session.id);
    if (!session.terminalId) return undefined;
    const terminal = await this.host.terminal.get(session.terminalId).catch(() => undefined);
    if (!terminal || terminal.kind !== 'native' || terminal.sessionId !== session.id || terminal.state === 'exited') return undefined;
    await this.overlay.registerHooks();
    await this.refreshTranscript();
    if (session.configPending) {
      if (!this.quiet()) throw new AppError('CLI_BUSY', 'Claude Code is still active in the existing terminal. Stop or finish that turn before applying the new settings.', 409);
      await this.host.terminal.stop(terminal.id);
      this.terminalId = undefined;
      return undefined;
    }
    this.terminalId = terminal.id;
    this.launchedProfileId = this.profile.id;
    this.terminalExited = false;
    this.attachTerminal(terminal.id);
    this.dispatchSignal({ type: 'process', process: 'alive' }, { ...this.status, notice: undefined, noticeLevel: undefined });
    return terminal;
  }

  private attachTerminal(terminalId: string): void {
    this.unsubscribeTerminal?.();
    this.terminalExited = false;
    this.observedTerminalId = terminalId;
    this.terminalExitNotice = undefined;
    let exitHandled = false;
    const exited = () => {
      if (exitHandled) return;
      exitHandled = true;
      this.terminalExited = true;
      this.started = false;
      const crashNotice = this.launchGuard.noteLaunchExit(terminalId);
      this.terminalExitNotice = crashNotice ? { terminalId, message: crashNotice } : undefined;
      this.dispatchSignal({ type: 'process', process: 'exited' }, { notice: crashNotice, noticeLevel: 'error' });
    };
    this.unsubscribeTerminal = this.host.terminal.observe(terminalId, observation => {
      if (observation.type === 'exit' || (observation.type === 'state' && observation.terminal.state === 'exited')) exited();
    });
  }

  private steerTarget(): NativeTurnTarget | undefined {
    const current = this.host.getSession(this.session.id);
    return this.started && !this.disposed && !this.terminalExited && !this.interrupting
      && this.overlay.registered && current.terminalId === this.terminalId
      && current.nativeSessionId === this.nativeSessionId
      && (this.status.phase === 'busy' || this.status.phase === 'attention') ? this.nativeTurn : undefined;
  }

  steer(request: NativeBackendSendRequest & { target: NativeTurnTarget }, renderedText: string): { deferred: true } {
    return this.steering.enqueue(request, renderedText, { terminalId: this.terminalId, ...(this.nativeTurn?.ownerRunId ? { ownerRunId: this.nativeTurn.ownerRunId } : {}) });
  }

  private finishSteering(type: 'run_completed' | 'run_failed' | 'run_cancelled', reason?: string): void {
    const target = this.nativeTurn;
    if (target) this.steering.finish(target, { type, ...(reason ? { reason } : {}) });
    this.nativeTurn = undefined;
    this.steerTools.clear();
  }

  /** Release the receipt/terminal wait so the serialized native stop can acquire its turn. No PTY write. */
  requestInterrupt(): void {
    const pending = this.pendingSend;
    if (!pending) return;
    pending.interruptRequested = true;
    pending.receiptWake?.();
  }

  /**
   * `deliverText` replaces what is typed into the CLI while the run keeps the user's own text.
   * `command` is the adapter's verdict on whether the CLI answers this in its own pane; a skill,
   * leading or moved to the front, runs as a turn this runtime tracks. Without a verdict a leading
   * `/` decides.
   */
  async send(request: NativeBackendSendRequest, options: { deliverText?: string; command?: boolean } = {}): Promise<void> {
    const terminalId = this.terminalId;
    if (!terminalId || !this.started) throw new AppError('TERMINAL_NOT_RUNNING', 'Claude Code is not running', 409);
    // Whether the main agent is free is the state's to say (background agents do not occupy it), so a
    // message sent while only background work runs is written straight away.
    // A CLI that is still drawing its first screen is a few seconds from its input box. Waiting for it
    // here delivers the first message as soon as it can take it; refusing would send the run back to the
    // queue for another round of preparation. One that is not ready in time is refused as before.
    if (this.state.process === 'starting') {
      const process = () => this.state.process;
      await this.waitUntil(() => this.disposed || process() !== 'starting', STARTING_SEND_WAIT_MS);
      if (this.disposed || this.terminalId !== terminalId || process() !== 'alive') throw new AppError('CLI_BUSY', 'Claude Code is still starting', 409);
    }
    if (this.status.phase === 'attention') throw new AppError('CLI_INTERACTION_REQUIRED', 'Resolve the pending Claude interaction before sending another message', 409);
    if (this.state.mainTurn.kind !== 'idle') throw new AppError('CLI_BUSY', 'Claude Code is working on another turn', 409);
    const { deliverText } = options;
    const { text } = await materializeNativeInput(this.host, deliverText === undefined ? request.input : { ...request.input, text: deliverText });
    // `/compact` is a turn: it runs for a while, ends with its own record, and is the Run's to wait for.
    const compact = /^\/compact(?:\s|$)/.test(request.input.text.trim());
    const isSlashCommand = !compact && (options.command ?? request.input.text.trimStart().startsWith('/'));
    // A rewrite is `/name ` in front of the user's text, so what follows the first space is theirs.
    const echo = deliverText === undefined ? text : text.slice(text.indexOf(' ') + 1);
    if (deliverText !== undefined) this.rememberRewrite(text, echo);
    const baselineSequence = this.transcript.lastSequence();
    const baselineUserIds = this.transcript.userMessageIds();
    let resolveReceipt!: (event: NativeWorkbenchEvent) => void;
    let rejectReceipt!: (error: Error) => void;
    const receipt = new Promise<NativeWorkbenchEvent>((resolvePromise, rejectPromise) => { resolveReceipt = resolvePromise; rejectReceipt = rejectPromise; });
    // Pre-write guards can fail before the receipt is awaited; attach a sink immediately so a
    // safely requeued CLI_BUSY/TERMINAL_INTERACTION_BUSY does not become an unhandled rejection.
    void receipt.catch(() => undefined);
    const pending: PendingSend = {
      commandId: request.commandId, runId: request.runId, text, command: isSlashCommand, compact, baselineUserIds, echo,
      promptSeen: false, fenced: false, resolveReceipt, rejectReceipt, receipt, receiptSettled: false,
    };
    this.pendingSend = pending;
    this.recentSends.push(pending);
    if (this.recentSends.length > MAX_RECENT_SENDS) this.recentSends.shift();
    this.schedulePolling();
    const expectedModel = request.config.model ?? this.session.model;
    try {
      // Read before the terminal is held: a first probe spawns the CLI twice.
      const untested = await this.untestedVersion();
      await this.host.terminal.withInteraction(terminalId, async control => {
        let screen = await control.screen();
        const info = await this.host.terminal.get(terminalId);
        // A menu can appear between polls while leaving the input box drawn. Refuse before the
        // dispatch fence so the message stays queued and no paste or Enter answers the menu.
        const dialog = screen === undefined ? undefined
          : claudeScreenInteraction(screen, info) ?? parseDialog(screen, info)?.interaction;
        if (dialog && this.endorsesDialog(dialog)) throw new AppError('CLI_INTERACTION_REQUIRED', 'Resolve the pending Claude interaction before sending another message', 409);
        // The box has to be there to type into; whether a turn runs is not read from it.
        if (!claudeComposerVisible(screen)) throw new AppError('CLI_BUSY', 'Claude Code is not at its input prompt', 409);
        // A reader who opened a background agent's view leaves the composer talking to that agent; the
        // message is the main agent's, so the composer is taken back first.
        if (screen !== undefined && (claudeViewsSubagent(screen) || claudeFooterFocused(screen))) {
          if (untested) throw new AppError('CLI_BUSY', `Claude Code ${untested} is showing a background agent; switch its terminal back to the main agent`, 409);
          screen = await this.composer.focusMainComposer(control, screen);
        }
        // A focus on the footer's tasks entry is drawn only as styling; with it, the paste is dropped and Enter opens the entry.
        if (screen !== undefined && claudeTasksEntryShown(screen) && claudeTasksEntryFocused(await control.screen({ styled: true }) ?? '')) {
          if (untested) throw new AppError('CLI_BUSY', `Claude Code ${untested} has its background tasks entry focused; give its input box the keyboard`, 409);
          await control.keys(['Up']);
          await pause(FOOTER_KEY_MS);
          if (claudeTasksEntryFocused(await control.screen({ styled: true }) ?? '')) throw new AppError('CLI_BUSY', 'Claude Code kept the keyboard on its background tasks entry', 409);
          screen = await control.screen();
        }
        // A message of ours that an interruption put back is still in the box, and Enter would submit it
        // together with this one. It was cancelled; take it out first.
        if (screen !== undefined && this.recentSends.some(earlier => earlier !== pending && claudeComposerHoldsPrompt(screen!, earlier.text))) {
          const stale = (current: string) => this.recentSends.some(earlier => earlier !== pending && claudeComposerHoldsPrompt(current, earlier.text));
          screen = await this.composer.wipeComposer(control, stale);
          if (screen === undefined || stale(screen)) {
            throw new AppError('CLI_BUSY', 'Claude Code’s input box still holds an earlier message', 409);
          }
        }
        // What the composer held before this write, so the poll below can tell "my paste is in" from
        // "something was already sitting there".
        const composerBefore = screen === undefined ? undefined : claudeComposer(screen);
        let inputFile: ReturnType<typeof statSync> | undefined;
        if (this.transcript.path) {
          try { inputFile = statSync(this.transcript.path); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        const terminal = await this.host.terminal.get(terminalId);
        request.commitDispatchFence({
          backendId, nativeSessionId: this.nativeSessionId, terminalId, terminalEpoch: terminal.epoch,
          baselineSequence, renderedText: text, slashCommand: isSlashCommand,
          nativeInputBoundary: JSON.stringify({ type: 'claude-transcript', nativeSessionId: this.nativeSessionId,
            offset: inputFile?.size ?? 0, ...(inputFile ? { inode: inputFile.ino } : {}) }),
          resolvedConfig: { model: expectedModel, mode: request.config.mode, approval: request.config.approval },
        });
        pending.fenced = true;
        await control.paste(text, false);
        const pressed = await this.composer.submitPaste(control, text, composerBefore, !untested, pending);
        if (!isSlashCommand) await this.awaitReceipt(pending, control, text, pressed ? undefined : { before: composerBefore });
      });
    } catch (error) {
      if (!pending.receiptSettled) pending.rejectReceipt(error instanceof Error ? error : new Error(String(error)));
      if (pending.fenced && !pending.command) this.confirmLater(pending);
      throw error;
    } finally {
      if (this.pendingSend === pending) this.pendingSend = undefined;
      this.schedulePolling();
    }
  }

  /**
   * Wait for the transcript to confirm the prompt, pressing Enter again while the composer keeps it.
   *
   * This is the second line of defence behind `submitPaste`. `TerminalService` still writes through
   * `paste-buffer`, and a press can still be lost — a TUI repainting under a turn that streams
   * several background agents into the pane, a terminal with its input queue backed up. The composer
   * is the authority on whether the write landed either way: a prompt Claude has taken — running, or
   * queued behind the turn in flight — leaves the box empty, so a box that still shows the paste is
   * one that never submitted. Press Enter again rather than wait out a receipt that cannot come.
   * After `SUBMIT_RESEND_LIMIT` presses the CLI is left alone: it is refusing the write for a reason
   * this process cannot see, and the timeout reports that honestly.
   */
  private async awaitReceipt(pending: PendingSend, control: TerminalInteractionControl, text: string, unpressed?: { before: string | undefined }): Promise<void> {
    // With no Enter pressed yet (the paste had not shown), the first press is the send itself, not a resend, and the
    // box is watched for it at a short cadence and for longer; the receipt window starts when that press is made.
    let deadline = Date.now() + (unpressed ? SUBMIT_LATE_WATCH_MS : RECEIPT_TIMEOUT_MS);
    let resends = unpressed ? -1 : 0;
    const woken = new Promise<true>(resolve => { pending.receiptWake = () => resolve(true); });
    try {
      // The CLI holding the text in its own queue is a receipt too: it will turn it into a prompt when
      // it is free, and the row that does is claimed through `queuedSends`. So is a `/compact` whose hook fired.
      while (!pending.receiptSettled && !pending.queued && !pending.compactionStarted) {
        checkSendInterrupt(pending);
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error('Claude transcript did not confirm this prompt');
        }
        const confirmed = await Promise.race([
          pending.receipt.then(() => true),
          woken,
          new Promise<false>(resolve => {
            const timer = setTimeout(() => resolve(false), Math.min(unpressed ? SUBMIT_LATE_POLL_MS : SUBMIT_RECHECK_MS, remaining));
            timer.unref?.();
          }),
        ]);
        checkSendInterrupt(pending);
        if (confirmed || pending.receiptSettled || pending.queued) return;
        if (resends >= SUBMIT_RESEND_LIMIT) continue;
        // A screen that cannot be read is not proof of a stuck composer; leave the write alone.
        const screen = await control.screen().catch(() => undefined);
        checkSendInterrupt(pending);
        if (screen === undefined || !claudeComposerHoldsPrompt(screen, text)) continue;
        // Before the first press the box must also differ from what it held before the paste: an old draft's placeholder is not ours.
        if (unpressed && claudeComposer(screen) === unpressed.before) continue;
        // A menu can be drawn over a box that still shows the paste; Enter would answer it. `send()` refuses the same before pasting.
        const info = this.terminalId ? await this.host.terminal.get(this.terminalId).catch(() => undefined) : undefined;
        const dialog = info ? claudeScreenInteraction(screen, info) ?? parseDialog(screen, info)?.interaction : undefined;
        if (!info || (dialog && this.endorsesDialog(dialog))) continue;
        checkSendInterrupt(pending);
        resends += 1;
        pending.submittedAt = Date.now();
        await control.keys(['Enter']);
        if (unpressed) {
          console.warn('[claude] paste shown late; Enter pressed by the receipt wait', { sessionId: this.session.id });
          unpressed = undefined;
          deadline = Date.now() + RECEIPT_TIMEOUT_MS;
        }
      }
    } finally { pending.receiptWake = undefined; }
  }

  /**
   * The wait for the transcript ran out, which says nothing about whether Claude took the prompt.
   * The dispatcher leaves the run `uncertain` (never resent); this keeps the send claimable and reads
   * the transcript again after each delay in `LATE_RECEIPT_RECHECK_MS`. A row that turns up is tagged
   * with the run and confirms it through the ordinary stream; the last check lets the send go.
   */
  private confirmLater(pending: PendingSend): void {
    this.lateSend = pending;
    LATE_RECEIPT_RECHECK_MS.forEach((delay, index) => {
      const timer = setTimeout(() => {
        this.lateTimers.delete(timer);
        void this.confirmNow(pending).finally(() => { if (index === LATE_RECEIPT_RECHECK_MS.length - 1 && this.lateSend === pending) this.lateSend = undefined; });
      }, delay);
      timer.unref?.();
      this.lateTimers.add(timer);
    });
  }

  private async confirmNow(pending: PendingSend): Promise<void> {
    try {
      if (this.disposed || this.lateSend !== pending || pending.claimedRow) return;
      await this.refreshTranscript();
      // A row written before this check was mapped without the run; map the file again so it is
      // tagged (the tag changes the stream, which is announced as one reset).
      if (!pending.claimedRow && [...this.transcript.userMessageIds()].some(id => !pending.baselineUserIds.has(id))) {
        this.transcript.rescan();
        await this.refreshTranscript();
      }
    } catch { /* the next check, or the dispatcher's own, settles it */ }
  }

  /**
   * Stop what is running, and answer only when a record says it stopped.
   *
   *   main turn running   Ctrl-C; confirmed by the record that ends the turn (interruption marker, Stop).
   *   main idle, agents   Ctrl-C; confirmed by `agents_killed` (or every agent's metadata saying so).
   *   nothing running     nothing to press: a message this process left in the input box is cleared.
   *
   * A Ctrl-C is never sent to a CLI with nothing to stop — a second one quits it. Afterwards the input
   * box is cleared of any message of ours still in it, which also covers `clearPrompt` (a stop that a
   * replacement message follows): the replacement must not be submitted together with the old text.
   */
  async interrupt(options: { clearPrompt?: boolean; expectedStop?: NativeStopRequest } = {}): Promise<void> {
    await this.refreshTerminalStatus(true);
    await this.refreshTranscript();
    const terminalId = this.terminalId;
    if (this.terminalExited) return;
    if (!terminalId) {
      if (this.state.process === 'exited' && !this.session.nativeSessionId) return;
      throw new AppError('NATIVE_INTERRUPT_UNCONFIRMED', 'Claude Code terminal could not be located to confirm the interrupt', 409);
    }
    if (this.state.process === 'exited') {
      throw new AppError('NATIVE_INTERRUPT_UNCONFIRMED', 'Claude Code terminal state could not be confirmed', 409);
    }
    const current = this.host.getSession(this.session.id);
    const terminal = await this.host.terminal.get(terminalId).catch(() => undefined);
    if (!terminal || current.terminalId !== terminalId || terminal.kind !== 'native'
      || terminal.sessionId !== current.id || terminal.projectId !== current.projectId) {
      throw new AppError('NATIVE_INTERRUPT_UNCONFIRMED', 'Claude Code terminal binding could not be verified', 409);
    }
    if (terminal.state === 'exited') return;
    const expectedStop = options.expectedStop ? { ...options.expectedStop, terminalId: options.expectedStop.terminalId ?? terminalId,
      terminalEpoch: options.expectedStop.terminalEpoch ?? terminal.epoch } : undefined;
    if (expectedStop) await this.assertExpectedStop(expectedStop, terminalId);
    // A message pasted a moment ago may not have shown its outcome yet (submitted, queued or still in the
    // box). Give that a short while to appear before deciding what there is to stop.
    // Only a send whose Enter was pressed can still turn into a prompt; one a stop preempted before that never will.
    const unsettled = () => this.claimables().filter(send => send.fenced && !send.promptSeen && !send.queued && !send.command
      && !this.closedCommands.has(send.commandId) && send.submittedAt !== undefined && Date.now() - send.submittedAt < SEND_OUTCOME_FRESH_MS);
    await this.waitUntil(() => unsettled().length === 0, SEND_OUTCOME_WAIT_MS);
    // Still no outcome: the prompt may yet start, after this stop has returned. The intent stays with the send, and
    // `bindWebTurn` stops the turn it becomes.
    for (const send of unsettled()) send.stopRequested = true;
    if (expectedStop) await this.assertExpectedStop(expectedStop, terminalId);
    if (activeTurnOf(this.state.mainTurn)) {
      await this.stopMainTurn(terminalId, expectedStop);
    } else if (this.state.background.length > 0) {
      await this.stopBackground(terminalId, expectedStop);
    }
    // Whatever of ours the stop left in the input box is cancelled with it, and taken out.
    if (expectedStop) await this.assertExpectedStop(expectedStop, terminalId, true);
    await this.clearOwnInput(terminalId, false, expectedStop);
  }

  /** Recheck immediately before native writes; PTY input has no atomic turn-addressed protocol. */
  private async assertExpectedStop(stop: NativeStopRequest, terminalId: string, allowEnded = false): Promise<void> {
    const terminal = await this.host.terminal.get(terminalId).catch(() => undefined);
    const current = this.host.getSession(this.session.id);
    const turn = activeTurnOf(this.state.mainTurn);
    // The client can only name the turn the status published (`activeTurn`), which a cold-attached or
    // hook-without-prompt turn leaves unnamed; checking the internal prompt id here refused every stop of it.
    const turnId = turn ? this.nativeTurn?.turnId : undefined;
    if (!terminal || terminal.state !== 'running' || terminal.kind !== 'native' || terminal.sessionId !== current.id
      || terminal.projectId !== current.projectId || current.terminalId !== terminalId || this.terminalId !== terminalId
      || current.nativeSessionId !== stop.nativeSessionId || this.nativeSessionId !== stop.nativeSessionId
      || (stop.terminalId !== undefined && stop.terminalId !== terminalId)
      || (stop.terminalEpoch !== undefined && stop.terminalEpoch !== terminal.epoch)
      || (turnId !== stop.turnId && !(allowEnded && !turn))) {
      throw new AppError('NATIVE_STOP_TARGET_CHANGED', 'The original Claude task changed; no further stop keys were sent', 409);
    }
  }

  private async stopMainTurn(terminalId: string, expectedStop?: NativeStopRequest): Promise<void> {
    if (expectedStop) await this.assertExpectedStop(expectedStop, terminalId);
    this.cancelPending('Claude was interrupted before the web interaction completed.', 'deny');
    this.interrupting = true;
    const target = this.nativeTurn;
    this.nativeTurn = undefined;
    this.steerTools.clear();
    this.steering.reject('Claude was interrupted before receiving further guidance.');
    this.setStatus(this.status);
    let failure: unknown;
    try {
      // After a server restart the JSONL can still name a turn the CLI silently dropped. Do not
      // press Ctrl-C into its already-idle prompt: on Claude that asks the process to exit.
      const promptId = activeTurnOf(this.state.mainTurn)?.promptId;
      const hasOutput = () => Boolean(promptId && this.outputPromptId === promptId) || this.transcript.hasTurnOutput(promptId);
      let alreadyIdle = !hasOutput() && await this.stopIdleScreen(terminalId);
      if (expectedStop) await this.assertExpectedStop(expectedStop, terminalId);
      if (!alreadyIdle) {
        if (expectedStop) await this.assertExpectedStop(expectedStop, terminalId);
        await this.host.terminal.sendKeys(terminalId, ['C-c']);
      }
      let pressedAt = Date.now();
      const pressedTurn = this.turnSeq;
      let idleSince: number | undefined;
      let idleActivity: number | undefined;
      let journaled = false;
      // The turn we stopped is over when nothing runs, or when the CLI has moved on to another turn.
      const over = () => this.state.mainTurn.kind === 'idle' || this.turnSeq !== pressedTurn || this.terminalExited;
      // A recordless stop is confirmed only by stable native idle frames, with no hook/transcript
      // progress between them. A composer alone is insufficient: it remains drawn while Claude works.
      const dropped = async () => {
        if (over() || hasOutput() || (!alreadyIdle && Date.now() - pressedAt < INTERRUPT_RESTORE_AFTER_MS)) return false;
        if (!await this.stopIdleScreen(terminalId)) {
          idleSince = undefined;
          if (alreadyIdle && !over()) {
            alreadyIdle = false;
            if (expectedStop) await this.assertExpectedStop(expectedStop, terminalId);
            await this.host.terminal.sendKeys(terminalId, ['C-c']);
            pressedAt = Date.now();
          }
          return false;
        }
        if (idleSince === undefined || idleActivity !== this.lastActivityAt) {
          idleSince = Date.now();
          idleActivity = this.lastActivityAt;
          return false;
        }
        if (Date.now() - idleSince < 200 || Date.now() - this.lastActivityAt < INTERRUPT_RESTORE_AFTER_MS) return false;
        try {
          if (expectedStop) await this.assertExpectedStop(expectedStop, terminalId, true);
          await this.clearOwnInput(terminalId, true, expectedStop);
        } catch (error) { failure = error; return false; }
        if (idleActivity !== this.lastActivityAt) { idleSince = undefined; return false; }
        if (!over()) {
          try { if (promptId) await this.endJournalTurn('cancelled', promptId); }
          catch (error) { failure = error; return false; }
          journaled = true;
          if (!over()) this.dispatchSignal({ type: 'turn_end', source: 'hook', reason: 'interrupted', ...(promptId ? { promptId } : {}) });
        }
        return true;
      };
      const stopped = await this.waitUntil(over, STOP_CONFIRM_MS, dropped);
      if (!stopped) throw failure ?? new AppError('NATIVE_INTERRUPT_UNCONFIRMED', 'Claude Code did not confirm that the current turn stopped', 409);
      // A Stop hook may have ended the in-memory turn without leaving an end row either.
      if (!journaled && promptId && !this.terminalExited && this.turnSeq === pressedTurn) await this.endJournalTurn('cancelled', promptId);
      if (target) this.steering.finish(target, { type: 'run_cancelled', reason: 'Claude confirmed that the turn was interrupted.' });
    } finally { this.interrupting = false; }
  }

  /** Used only for an explicitly stopped/persistently ended turn, never to infer ordinary live turn state. */
  private async stopIdleScreen(terminalId: string): Promise<boolean> {
    if (this.pending.size || this.screenAttention) return false;
    const session = this.host.getSession(this.session.id);
    const terminal = await this.host.terminal.get(terminalId).catch(() => undefined);
    if (!terminal || terminal.state !== 'running' || terminal.kind !== 'native' || terminal.sessionId !== session.id
      || terminal.projectId !== session.projectId || session.terminalId !== terminalId) return false;
    const screen = await this.host.terminal.screen(terminalId).catch(() => undefined);
    return screen !== undefined && claudeComposer(screen) !== undefined && !CLAUDE_CODE_BUSY_PATTERN.test(screen)
      && !claudeScreenInteraction(screen, terminal) && !parseDialog(screen, terminal);
  }

  /**
   * Stops every background task of the conversation: agents with Ctrl-C (the CLI answers with
   * `agents_killed`), shells, monitors and workflows through its "Background" list, the only place
   * Claude Code 2.1.x stops those (Ctrl-C and its stop-all chord leave them running) — on a version
   * whose list was captured; on any other, those are left to the terminal. Each stop is proved by the
   * CLI's own report in the transcript; nothing here assumes one.
   */
  private async stopBackground(terminalId: string, expectedStop?: NativeStopRequest): Promise<void> {
    if (expectedStop) await this.assertExpectedStop(expectedStop, terminalId);
    const isAgent = (task: ClaudeSessionState['background'][number]) => task.kind === undefined || task.kind === 'agent';
    const shells = this.state.background.some(task => !isAgent(task));
    const untested = shells ? await this.untestedVersion() : undefined;
    if (shells && !untested) {
      await this.composer.stopBackgroundTasks(terminalId, expectedStop);
      await this.refreshTranscript();
    }
    // Pressing Ctrl-C with no agent left would ask the CLI to quit, so it is pressed only for one that is still there.
    if (this.state.background.some(isAgent)) {
      if (expectedStop) await this.assertExpectedStop(expectedStop, terminalId);
      await this.host.terminal.sendKeys(terminalId, ['C-c']);
    }
    // On an untested version only the agents are stopped from here; the shells and monitors are left to the terminal.
    const stopped = await this.waitUntil(() => this.terminalExited || !this.state.background.some(task => !untested || isAgent(task)), STOP_CONFIRM_MS);
    if (!stopped) throw new AppError('NATIVE_INTERRUPT_UNCONFIRMED', 'Claude Code did not confirm that the background tasks stopped', 409);
    if (untested && !this.terminalExited && this.state.background.length) {
      throw new AppError('NATIVE_INTERRUPT_UNCONFIRMED', `Claude Code ${untested} background shells and monitors have to be stopped in its terminal`, 409);
    }
  }

  /**
   * A request to stop a background task. Claude Code can only stop all of them at once, so every task
   * of the conversation goes `stopping`; each becomes `stopped` when the CLI reports it, and one the CLI
   * did not report goes back to running.
   */
  async stopActivity(activityId: string): Promise<NativeActivity> {
    await this.refreshTerminalStatus(true);
    await this.refreshTranscript();
    const known = this.transcript.activities();
    const target = known.find(activity => activity.id === activityId);
    if (!target) throw new AppError('ACTIVITY_NOT_FOUND', 'This activity is not known to the conversation', 404);
    if (!target.stop) throw new AppError('ACTIVITY_NOT_STOPPABLE', 'This activity cannot be stopped from here', 409);
    if (!isLiveActivity(target)) throw new AppError('ACTIVITY_ENDED', 'This activity has already ended', 409);
    if (this.stopping) { await this.stopping.catch(() => undefined); return this.transcript.activities().find(activity => activity.id === activityId) ?? target; }
    const terminalId = this.terminalId;
    if (!terminalId || this.terminalExited || this.state.process === 'exited') {
      throw new AppError('NATIVE_INTERRUPT_UNCONFIRMED', 'Claude Code terminal could not be located to confirm the stop', 409);
    }
    const current = this.host.getSession(this.session.id);
    const terminal = await this.host.terminal.get(terminalId).catch(() => undefined);
    if (!terminal || current.terminalId !== terminalId || terminal.kind !== 'native' || terminal.sessionId !== current.id
      || terminal.projectId !== current.projectId || terminal.state === 'exited') {
      throw new AppError('NATIVE_INTERRUPT_UNCONFIRMED', 'Claude Code terminal binding could not be verified', 409);
    }
    const doomed = known.filter(stoppable);
    for (const activity of doomed) if (activity.status !== 'stopping') this.publishActivity({ ...activity, status: 'stopping' });
    const journaled = await this.journalStops(doomed.map(activity => activity.id));
    const task = (async () => { await this.stopBackground(terminalId); })();
    this.stopping = task;
    let failure: unknown;
    try { await task; }
    catch (error) { failure = error; }
    finally { if (this.stopping === task) this.stopping = undefined; }
    await this.refreshTranscript();
    // Whatever the CLI did not report as stopped is still running.
    const kept: string[] = [];
    for (const activity of this.transcript.activities()) {
      if (doomed.some(item => item.id === activity.id) && activity.status === 'stopping') {
        this.publishActivity({ ...activity, status: 'running' }, { restored: true });
        kept.push(activity.id);
      }
    }
    await journaled(kept);
    if (failure) throw failure;
    return this.transcript.activities().find(activity => activity.id === activityId) ?? target;
  }

  /**
   * A stop as the journal's ledger of the conversation's activities records it (G10), which is where clients read them:
   * `stopping` now; each becomes `stopped` there once the transcript's report of it is read. Returns how to put back
   * to running the ones the CLI did not stop.
   */
  private async journalStops(ids: readonly string[]): Promise<(kept: readonly string[]) => Promise<void>> {
    const onLedger = <T>(task: (ledger: ActivityLedger) => T) => this.host.transcript?.withSource(this.session.id, (source, w) => source instanceof ClaudeTranscriptSource ? task((w.scratch ?? w).activities) : undefined).catch(() => undefined);
    const tokens = await onLedger(ledger => {
      const held = new Map<string, number>();
      for (const id of ids) {
        // One the journal has not read yet, or has seen end, has no `stopping` to show.
        try { const { token } = ledger.beginStop(id); if (token !== undefined) held.set(id, token); } catch { /* see above */ }
      }
      return held;
    });
    return async kept => {
      const undo = kept.filter(id => tokens?.has(id));
      if (undo.length) await onLedger(ledger => { for (const id of undo) ledger.stopFailed(id, tokens!.get(id)); });
    };
  }

  /**
   * Take back text this process put in the CLI's input box and the CLI did not turn into a prompt — typed
   * and not submitted, or put back by an interruption. Only a box that shows one of our own recent messages
   * is touched (a draft the reader typed is theirs), and the clear is confirmed against the box, never
   * assumed. The Runs those messages belonged to are cancelled with that evidence.
   *
   * `boxRequired`: the caller takes an empty box as proof that the CLI dropped a message, so a box that
   * cannot be read is no proof of anything.
   */
  private async clearOwnInput(terminalId: string, boxRequired = false, expectedStop?: NativeStopRequest): Promise<void> {
    if (!this.recentSends.length && !boxRequired) return;
    const cleared = await this.composer.interact(terminalId, async control => {
      const screen = await control.screen();
      if (boxRequired && (screen === undefined || claudeComposer(screen) === undefined || CLAUDE_CODE_BUSY_PATTERN.test(screen))) {
        throw new AppError('NATIVE_INTERRUPT_UNCONFIRMED', 'Claude Code input box could not be read', 409);
      }
      if (screen === undefined) return [];
      const held = this.recentSends.filter(send => claudeComposerHoldsPrompt(screen, send.text));
      if (!held.length) return [];
      const after = await this.composer.wipeComposer(control, current => held.some(send => claudeComposerHoldsPrompt(current, send.text)),
        expectedStop ? () => this.assertExpectedStop(expectedStop, terminalId, true) : undefined);
      if (after === undefined || held.some(send => claudeComposerHoldsPrompt(after, send.text))) {
        throw new AppError('NATIVE_INTERRUPT_UNCONFIRMED', 'Claude Code did not clear its input box', 409);
      }
      return held;
    });
    for (const send of cleared) {
      this.unqueue(send);
      if (this.lateSend === send) this.lateSend = undefined;
      if (!send.promptSeen) this.emitRunTerminal('run_cancelled', { commandId: send.commandId, runId: send.runId }, undefined, 'The message was cleared from the Claude Code input box before it was submitted.');
    }
  }

  /**
   * Waits for `done`, re-reading the transcript so a record written now is seen now. The condition is read once
   * more after the window and the window gives back time the event loop lost (`waitFor`).
   */
  private async waitUntil(done: () => boolean, timeoutMs: number, probe?: () => Promise<boolean>): Promise<boolean> {
    if (done()) return true;
    const reached = await waitFor(async () => {
      await this.refreshTranscript().catch(() => undefined);
      await probe?.().catch(() => undefined);
      return done() ? true : undefined;
    }, { timeoutMs, intervalMs: 250, wake: notify => { this.statusWaiters.add(notify); return () => { this.statusWaiters.delete(notify); }; } });
    return reached === true;
  }

  async respond(response: NativeInteractionResponse): Promise<NativeInteractionResult> {
    if (typeof response.requestId !== 'string' || !response.requestId || response.requestId.length > 200 || /[\0\r\n]/.test(response.requestId)) {
      throw new AppError('INVALID_INTERACTION_REQUEST_ID', 'Interaction request id is invalid');
    }
    const fingerprint = createHash('sha256').update(stableJson(response)).digest('hex');
    const previous = this.host.getInteractionReceipt(this.session.id, response.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint || previous.interactionId !== response.interactionId || previous.revision !== response.revision) {
        throw new AppError('NATIVE_INTERACTION_REQUEST_CONFLICT', 'This interaction retry id was already used for a different answer', 409);
      }
      return previous.result;
    }
    if (isClaudeScreenInteraction({ id: response.interactionId })) return this.respondScreenDialog(response, fingerprint);
    const pending = [...this.pending.values()].find(item => item.interaction.id === response.interactionId);
    if (!pending) return { status: 'uncertain', message: 'Claude no longer has this request open. Sync the interaction state.' };
    if (!pending.interaction.requestId || pending.interaction.id !== response.interactionId || pending.interaction.revision !== response.revision) {
      throw new AppError('NATIVE_INTERACTION_STALE', 'Claude’s interaction changed. Sync the current request before answering.', 409);
    }
    if (pending.candidate) {
      return { status: 'uncertain', message: 'The response is waiting for Claude to confirm the native interaction.' };
    }
    if (pending.terminalSettled) return { status: 'uncertain', message: 'Claude already resolved this native interaction. Sync the current request.' };
    if (pending.kind === 'question') return this.respondQuestion(pending, response);
    const behavior = response.action === 'allow' ? 'allow' : response.action === 'deny' ? 'deny' : undefined;
    if (!behavior) throw new AppError('INVALID_NATIVE_INTERACTION', 'Choose allow or deny for this Claude permission request');
    const reason = response.otherText?.slice(0, 1000);
    // An allow that carries `updatedInput` is checked again against the CLI's own rules, even unchanged, and a
    // safety check no rule may allow (`rm -rf $(…)`) then draws the dialog again; a bare allow is taken as given.
    // ExitPlanMode alone needs the input: it requires a person's answer, and a bare allow of it is ignored.
    const input = behavior === 'allow' && pending.toolName === 'ExitPlanMode' ? { updatedInput: pending.toolInput } : {};
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior, ...input, ...(reason ? { message: reason } : {}) },
      },
    };
    this.stageCandidate(pending, response, fingerprint, output, 'Claude is still confirming the permission decision.');
    return this.waitForProviderConfirmation(pending, ACK_TIMEOUT_MS);
  }

  /**
   * 延长 is kept for older clients only: a request that waits on a person has no deadline any more, so
   * this changes nothing and returns the request as it stands.
   */
  extendInteraction(interactionId: string): NativeInteraction {
    const pending = [...this.pending.values()].find(item => item.interaction.id === interactionId);
    if (!pending || pending.candidate || pending.terminalSettled) throw new AppError('NATIVE_INTERACTION_GONE', 'Claude no longer has this request open. Sync the interaction state.', 409);
    return pending.interaction;
  }

  /**
   * Answers a dialog Claude Code drew itself: a notice is passed with the key its footer names; its own
   * question is answered by moving the cursor to the chosen row (or the free-text row, which is typed
   * into) and pressing Enter.
   */
  private async respondScreenDialog(response: NativeInteractionResponse, fingerprint: string): Promise<NativeInteractionResult> {
    const answering = response.action === 'answer';
    if (!answering && response.action !== 'continue' && response.action !== 'cancel') throw new AppError('INVALID_NATIVE_INTERACTION', 'Continue or cancel this Claude Code notice');
    const terminalId = this.terminalId;
    if (!terminalId || this.terminalExited) throw new AppError('TERMINAL_NOT_RUNNING', 'Claude Code is not running', 409);
    const result = await this.host.terminal.withInteraction(terminalId, async control => {
      const terminal = await this.host.terminal.get(terminalId);
      const current = claudeScreenInteraction(await control.screen() ?? '', terminal);
      if (current?.id !== response.interactionId || current.revision !== response.revision) {
        throw new AppError('NATIVE_INTERACTION_STALE', 'Claude Code’s notice changed. Sync the current request before answering.', 409);
      }
      if (this.pending.size || this.status.interaction?.transport === 'protocol') {
        throw new AppError('NATIVE_INTERACTION_STALE', 'Claude is waiting on a protocol interaction. Sync the current request.', 409);
      }
      if (!current.actions.some(action => action.id === response.action)) {
        throw new AppError('INVALID_NATIVE_INTERACTION', 'This Claude Code dialog must be answered in the terminal');
      }
      const answer = answering ? screenAnswer(current, response) : undefined;
      const previous = this.host.getInteractionReceipt(this.session.id, response.requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint || previous.interactionId !== response.interactionId || previous.revision !== response.revision) {
          throw new AppError('NATIVE_INTERACTION_REQUEST_CONFLICT', 'This interaction retry id was already used for a different answer', 409);
        }
        return previous.result;
      }
      // A form's Enter acts on its focused row (a toggle flips), so Continue is pressed on its own row. Moving
      // the cursor answers nothing; the fence below is still written before the one key that does.
      let pressed = current;
      if (!answer && response.action === 'continue') {
        let screen = await control.screen() ?? '';
        for (let step = 0; step < CONFIRM_ROW_STEPS; step++) {
          const row = parseClaudeScreenDialog(screen)?.confirmRow;
          if (row === undefined || row === 'focused') break;
          await control.keys([row === 'below' ? 'Down' : 'Up']);
          await pause(FOOTER_KEY_MS);
          screen = await control.screen() ?? '';
        }
        const row = parseClaudeScreenDialog(screen)?.confirmRow;
        const moved = claudeScreenInteraction(screen, terminal);
        if ((row !== undefined && row !== 'focused') || !moved) {
          throw new AppError('NATIVE_INTERACTION_STALE', 'Claude Code’s Continue row could not be focused. Sync the current request or open the terminal.', 409);
        }
        pressed = moved;
      }
      // The terminal write can succeed before its acknowledgement or the following read fails.
      // Persist the fence first so retrying this request can never press the key twice.
      this.saveResponse(response, fingerprint, { status: 'uncertain', message: 'Claude Code has not yet confirmed the notice response.' });
      try {
        if (answer) {
          const failure = await this.composer.answerScreenQuestion(control, answer);
          if (failure) return { status: 'uncertain', message: failure } satisfies NativeInteractionResult;
        } else await control.keys([response.action === 'continue' ? 'Enter' : 'Escape']);
        for (let attempt = 0; attempt < 50; attempt++) {
          await new Promise(resolvePause => setTimeout(resolvePause, 60));
          const screen = await control.screen();
          if (screen === undefined) continue;
          const next = claudeScreenInteraction(screen, terminal);
          if (next?.id === pressed.id) continue;
          if (next) {
            this.screenAttention = true;
            this.setStatus({ ...this.status, interaction: next });
            return { status: 'advanced', interaction: next } satisfies NativeInteractionResult;
          }
          this.screenAttention = false;
          if (isClaudeScreenInteraction(this.status.interaction)) this.setStatus({ ...this.status, interaction: undefined });
          return { status: 'completed' } satisfies NativeInteractionResult;
        }
        return { status: 'uncertain', message: 'Claude Code has not closed the notice yet. Sync the state or open the terminal.' } satisfies NativeInteractionResult;
      } catch {
        return { status: 'uncertain', message: 'Claude Code’s notice response could not be confirmed. Sync the state or open the terminal; it will not be sent again.' } satisfies NativeInteractionResult;
      }
    });
    this.saveResponse(response, fingerprint, result);
    return result;
  }

  private async respondQuestion(pending: PendingInteraction, response: NativeInteractionResponse): Promise<NativeInteractionResult> {
    const questions = pending.questions ?? [];
    const current = questions[pending.questionIndex];
    if (!current) throw new AppError('NATIVE_INTERACTION_STALE', 'Claude’s question is no longer available', 409);
    if (response.action === 'previous') {
      if (pending.questionIndex === 0) throw new AppError('INVALID_NATIVE_INTERACTION', 'There is no previous Claude question');
      pending.questionIndex = Math.max(0, pending.questionIndex - 1);
      pending.revision += 1;
      pending.interaction = this.questionInteraction(pending);
      const result: NativeInteractionResult = { status: 'advanced', interaction: pending.interaction };
      this.saveResponse(response, createHash('sha256').update(stableJson(response)).digest('hex'), result);
      this.setStatus({ ...this.status, interaction: pending.interaction });
      return result;
    }
    if (response.action !== 'answer' && response.action !== 'skip') throw new AppError('INVALID_NATIVE_INTERACTION', 'Choose an answer for Claude’s question');
    const labels = response.action === 'skip' ? [] : (response.selectedIds ?? []).map(id => current.options.find(option => option.id === id)?.label).filter((label): label is string => Boolean(label));
    const other = response.action === 'skip' ? '' : (response.otherText ?? '').slice(0, 2000).trim();
    const answer = [...labels, ...(other ? [other] : [])].join(', ');
    if (response.action === 'answer' && !answer) throw new AppError('INVALID_NATIVE_INTERACTION', 'Select an option or enter an answer');
    if (answer) pending.answers[current.question] = answer;
    if (pending.questionIndex + 1 < questions.length) {
      pending.questionIndex += 1;
      pending.revision += 1;
      pending.interaction = this.questionInteraction(pending);
      const result: NativeInteractionResult = { status: 'advanced', interaction: pending.interaction };
      this.saveResponse(response, createHash('sha256').update(stableJson(response)).digest('hex'), result);
      this.setStatus({ ...this.status, interaction: pending.interaction });
      return result;
    }
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedInput: { ...pending.toolInput, questions: pending.toolInput.questions, answers: pending.answers } },
      },
    };
    this.stageCandidate(pending, response, createHash('sha256').update(stableJson(response)).digest('hex'), output, 'Claude is still confirming the answers.');
    return this.waitForProviderConfirmation(pending, ACK_TIMEOUT_MS);
  }

  private stageCandidate(pending: PendingInteraction, response: NativeInteractionResponse, fingerprint: string, output: Record<string, unknown>, message: string): void {
    pending.candidate = { output, webRequestId: response.requestId, deliveredAt: Date.now() };
    this.saveResponse(response, fingerprint, { status: 'uncertain', message });
    pending.resolveHook(output);
    pending.candidateCleanup = setTimeout(() => {
      if (!pending.providerResult && this.pending.get(pending.nativeRequestId) === pending) {
        this.confirmProviderInteraction(pending, 'Claude did not confirm this response. Open the terminal to check its state; the response will not be sent again.', 'uncertain');
      }
    }, CONFIRMATION_TIMEOUT_MS);
    pending.candidateCleanup.unref?.();
    // Delivery is not acknowledgement. Keep the card's identity and actions for posting/uncertain;
    // the candidate guard, not a browser-local lock, prevents any second execution after a sync.
    // The card says it is still being confirmed; a timeout above is what raises a notice.
    if (this.status.interaction?.id === pending.interaction.id) {
      this.setStatus({ ...this.status, interaction: pending.interaction });
    }
  }

  private waitForProviderConfirmation(pending: PendingInteraction, timeoutMs: number): Promise<NativeInteractionResult> {
    if (pending.providerResult) return Promise.resolve(pending.providerResult);
    return new Promise(resolve => {
      let settled = false;
      const finish = (result: NativeInteractionResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.confirmationWaiters.delete(onConfirmed);
        resolve(result);
      };
      const onConfirmed = (result: NativeInteractionResult) => finish(result);
      const timer = setTimeout(() => finish({ status: 'uncertain', message: 'Claude has not yet confirmed the native interaction.' }), timeoutMs);
      timer.unref?.();
      pending.confirmationWaiters.add(onConfirmed);
      if (pending.providerResult) onConfirmed(pending.providerResult);
    });
  }

  private saveResponse(response: NativeInteractionResponse, fingerprint: string, result: NativeInteractionResult): void {
    this.host.saveInteractionReceipt(this.session.id, response.requestId, {
      fingerprint, interactionId: response.interactionId, revision: response.revision,
      result, createdAt: new Date().toISOString(),
    });
  }

  private questionInteraction(pending: PendingInteraction): NativeInteraction {
    const questions = pending.questions ?? [];
    const current = questions[pending.questionIndex]!;
    return {
      id: `claude-question:${pending.nativeRequestId}`, revision: String(pending.revision),
      transport: 'protocol', requestId: pending.nativeRequestId,
      request: { toolName: pending.toolName, questions: pending.toolInput.questions },
      kind: 'question', title: current.header ?? `Question ${pending.questionIndex + 1}`,
      message: current.question,
      options: current.options.map(option => ({ id: option.id, label: option.label, selected: false })),
      multiple: current.multiSelect, allowOther: true,
      questionIndex: pending.questionIndex + 1, questionCount: questions.length,
      actions: [
        ...(pending.questionIndex > 0 ? [{ id: 'previous', label: 'Previous' }] : []),
        { id: 'answer', label: pending.questionIndex + 1 === questions.length ? 'Submit' : 'Continue', tone: 'primary' },
        { id: 'skip', label: 'Skip' },
      ],
    };
  }

  /**
   * Publish the window and occupancy the CLI stated to its status line.
   *
   * `context_window_size` is Claude Code's own effective window — its model table, the `[1m]`
   * opt-in, account entitlements, a gateway override — so both numbers are provider-declared and
   * never guessed from the model name; a frame without a usable window is dropped rather than
   * filled in. Frames repeat while a turn streams, so only a real move is broadcast.
   */
  private noteStatusLine(payload: Record<string, unknown>): void {
    if (string(payload.session_id) !== this.nativeSessionId) return;
    const next = claudeNativeContext(payload);
    if (!next) return;
    if (this.context && this.context.used === next.used && this.context.size === next.size) return;
    this.context = next;
    this.emit({ type: 'context', context: next });
  }

  private async handleHook(payload: Record<string, unknown>, deliveryId: string, signal: AbortSignal): Promise<Record<string, unknown> | void> {
    if (this.disposed) return {};
    const event = string(payload.hook_event_name);
    // A status line frame is not a hook and carries no event name; it is the one place the CLI
    // states the context window (see `context.ts` and `statusline-cli.mjs`).
    if (!event) {
      this.noteStatusLine(payload);
      return {};
    }
    if (string(payload.session_id) !== this.nativeSessionId) return {};
    // Any hook may come just before rows the CLI is about to write; the journal's reader looks then too.
    this.changes?.emit(this.session.id);
    this.noteActivity();
    // Any hook but the session's own start is the CLI at work — a prompt, a tool, a stop — so it is up.
    // (`SessionStart` only opens the launch's gate, which waits for the input box.)
    if (this.state.process === 'starting' && event !== 'SessionStart') this.dispatchSignal({ type: 'process', process: 'alive' });
    // A CLI held to be gone that still reports work says otherwise: the terminal is looked at again rather than believed
    // either way, since a hook can also arrive late from one that has just exited.
    else if (this.state.process === 'exited' && event !== 'SessionEnd') void this.refreshTerminalStatus(true);
    if (event === 'SessionStart') {
      const hookSessionId = string(payload.session_id);
      const transcriptPath = string(payload.transcript_path);
      const root = join(configDirOf(this.profile), 'projects');
      if (hookSessionId === this.nativeSessionId && transcriptPath && basename(transcriptPath) === `${this.nativeSessionId}.jsonl` && isInside(root, transcriptPath)) {
        // The path is derived from the CLI's working directory. After a worktree switch
        // (EnterWorktree / ExitWorktree) it names the other directory's project folder, where
        // nothing is written: the conversation stays in the file it started in. A path with no file
        // yields to the session's existing transcript; a new session's file may not exist yet.
        const reported = await stat(transcriptPath).then(info => info.isFile(), () => false);
        const file = reported ? transcriptPath : (await findClaudeTranscript(configDirOf(this.profile), this.nativeSessionId)) ?? transcriptPath;
        if (this.disposed) return {};
        await this.transcript.setFile(file);
        if (this.disposed) return {};
        this.session = { ...this.session, nativeSessionId: this.nativeSessionId };
        const fields = { model: this.session.model ?? string(this.profile.config.defaultModel), approval: this.adoptApproval(payload.permission_mode) };
        // A session start never says anything about the turn: Claude Code starts one inside a running
        // turn too (it compacts its own context and continues, or restarts on resume), and a server that
        // took over a CLI sees it as often as a launch does. It only says the CLI is up. For our own
        // launch that is not yet a prompt to type into: the gate (see `READY_GATE_MS`), not the hook,
        // ends `starting`.
        this.setStatus({ ...this.status, ...fields });
        if (this.state.process === 'starting') this.readyGate.open();
        await this.refreshTranscript();
        if (this.readyGate.opened) {
          // The composer is read now, after the gate opened, rather than at the next poll.
          while (this.screenDialogTask) await this.screenDialogTask.catch(() => undefined);
          await this.refreshScreenState();
        }
      }
      return {};
    }
    const mainThread = payload.agent_id === undefined;
    if (!mainThread && ['UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd'].includes(event)) return {};
    const hookPromptId = string(payload.prompt_id);
    if (event === 'PreCompact') {
      if (mainThread) await this.compactionHooked(payload.trigger === 'auto' ? 'auto' : 'manual', deliveryId);
      return {};
    }
    if (event === 'UserPromptSubmit') {
      const prompt = string(payload.prompt);
      const promptId = hookPromptId;
      const claimant = this.claimingSend(prompt, promptId, payload);
      const text = prompt === undefined ? '' : shellPrompt(prompt);
      // The transcript can announce the turn before its delayed hook names the Riffet input.
      // Ignore duplicate hooks only after giving that input a chance to claim its existing row.
      if (promptId && this.nativeTurn?.turnId === promptId && !claimant) return {};
      if (promptId) {
        this.seenPromptIds.add(promptId);
        if (this.seenPromptIds.size > MAX_REMEMBERED_PROMPTS) this.seenPromptIds.delete(this.seenPromptIds.values().next().value!);
      }
      this.dispatchSignal({
        type: 'prompt', source: 'hook', ...(promptId ? { promptId } : {}), origin: originOf(payload),
        ...(/^\/compact(?:\s|$)/.test(text) ? { compact: true } : {}), ...(text.startsWith('/') ? { slash: true } : {}),
      }, { ...this.status, approval: this.adoptApproval(payload.permission_mode) });
      if (claimant) {
        // A send given up on earlier may already have its row in the stream, mapped without the run.
        if (claimant === this.lateSend) setTimeout(() => void this.confirmNow(claimant), 0).unref?.();
        claimant.promptSeen = true;
        claimant.promptId = promptId;
        this.bindWebTurn(claimant, promptId);
        this.setStatus(this.status);
      }
      return {};
    }
    // A delayed hook from a previous prompt must never mutate or consume the new target.
    const matchesTurn = mainThread && this.nativeTurn !== undefined && hookPromptId === this.nativeTurn.turnId;
    if (this.nativeTurn && hookPromptId !== undefined && !matchesTurn && ['Stop', 'StopFailure'].includes(event)) return {};
    if (event === 'Stop' || event === 'StopFailure') {
      // The hook can land before the poll has read the rows that close the turn (the final answer), so those
      // are delivered first: the Run's end must not reach a client ahead of the answer it ends.
      await this.refreshTranscript().catch(() => undefined);
      if (this.disposed) return {};
      // Our Stop hook is one of several the CLI runs side by side; the turn is over once the slowest returns and
      // none sent the model on, which the transcript's Stop summary says. A turn the transcript has not shown (or
      // cannot) would never see that summary taken as its own, so the hook ends it.
      if (event === 'Stop' && this.transcript.state === 'ok' && activeTurnOf(this.state.mainTurn)?.transcriptSeen) return {};
      this.dispatchSignal({
        type: 'turn_end', source: 'hook', reason: event === 'Stop' ? 'stop' : 'stop_failure', ...(hookPromptId ? { promptId: hookPromptId } : {}),
        ...(event === 'StopFailure' ? { error: claudeFailureText(string(payload.last_assistant_message)) } : {}),
      });
      return {};
    }
    if (event === 'SessionEnd') {
      const { ended } = this.dispatchSignal({ type: 'turn_end', source: 'hook', reason: 'session_end' }, { ...this.status, interaction: undefined });
      // The session ends under a turn the CLI writes no end for; one it never named is ended by the exit that follows.
      if (ended?.promptId) await this.endJournalTurn('interrupted', ended.promptId);
      return {};
    }
    // A tool hook of a prompt nobody announced proves a turn this process missed the start of. A prompt
    // that already ended is remembered, so a late hook of it opens nothing.
    if (mainThread && hookPromptId && !activeTurnOf(this.state.mainTurn) && ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure'].includes(event)) {
      this.dispatchSignal({ type: 'prompt', source: 'hook', promptId: hookPromptId, origin: 'other' });
    }
    if (mainThread && hookPromptId === activeTurnOf(this.state.mainTurn)?.promptId
      && ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure'].includes(event)) this.outputPromptId = hookPromptId;
    if (event === 'PostToolUse' || event === 'PostToolUseFailure' || event === 'PermissionDenied') {
      // Taken before the hook returns: Claude Code writes the call's result row after its PostToolUse hooks, and the
      // transcript mapping appends what was recorded here to that row.
      const observedId = string(payload.tool_use_id);
      // A file an edit tool changed is that tool's to report, not a command's that ran beside it.
      const edited = event === 'PostToolUse' ? editedPath(payload) : undefined;
      if (edited) this.observer?.noteEdit(edited);
      if (observedId && event === 'PermissionDenied') this.observer?.discard(observedId);
      else if (observedId && this.observer) {
        const diffs = await this.observer.end(observedId);
        if (diffs?.length) this.observer.record(this.session.id, observedId, diffs);
      }
      this.confirmHookInteraction(event, payload);
      if (matchesTurn && event === 'PostToolUseFailure' && payload.is_interrupt === true) {
        this.finishSteering('run_cancelled', 'Claude interrupted the running tool.');
        this.setStatus({ ...this.status });
        return {};
      }
      const target = matchesTurn ? this.steerTarget() : undefined;
      const toolId = string(payload.tool_use_id);
      if (target && toolId && (event === 'PostToolUse' || (event === 'PostToolUseFailure' && payload.is_interrupt !== true)) && this.steerTools.delete(toolId)) {
        const context = await this.host.withSessionLock(this.session.id, () => signal.aborted ? undefined : this.steering.claim(target, { terminalId: this.terminalId }));
        if (context) return { hookSpecificOutput: { hookEventName: event, additionalContext: context } };
      }
      return {};
    }
    if (event === 'PermissionRequest') {
      // A question is answered here, not in its PreToolUse hook: Claude Code writes the assistant rows in
      // front of a tool call (the text, the thinking, the call itself) only once every PreToolUse hook has
      // returned, so a hook held open for a person keeps all of them off the transcript for as long as the
      // person takes. By this hook the rows are down, and the dialog the CLI draws meanwhile is not lifted
      // while the card is up (see `refreshScreenState`).
      if (payload.tool_name === 'AskUserQuestion') return await this.awaitQuestion(payload, deliveryId, signal);
      const decision = await this.awaitPermission(payload, deliveryId, signal);
      await this.observeDecision(payload, decision);
      return decision;
    }
    if (event === 'PreToolUse') {
      const toolId = string(payload.tool_use_id);
      if (matchesTurn && this.steerTarget() && toolId) this.steerTools.add(toolId);
      // The permission hook that follows does not name the call, so it is found again by what it asks.
      const toolName = string(payload.tool_name);
      if (toolId && toolName) {
        if (toolName === 'AskUserQuestion') this.questionHooksDue.set(toolId, Date.now());
        this.announcedToolUses.set(this.toolFingerprint(toolName, asRecord(payload.tool_input) ?? {}), toolId);
        while (this.announcedToolUses.size > 256) this.announcedToolUses.delete(this.announcedToolUses.keys().next().value!);
      }
      // Noted before the edit as well: a command in another conversation that ends before this PostToolUse leaves the file alone.
      const editing = editedPath(payload);
      if (editing) this.observer?.noteEdit(editing);
      // A shell command reports no edits; what it changed is seen around it, a subagent's as well as the main thread's.
      // One left running in the background outlives its call, so it is not observed.
      if (toolId && toolName === 'Bash' && asRecord(payload.tool_input)?.run_in_background !== true) {
        await this.observer?.begin(toolId, string(payload.cwd) ?? this.project.cwd, string(asRecord(payload.tool_input)?.command));
      }
    }
    return {};
  }

  /**
   * The send a prompt hook belongs to. Once the write fence is committed, the first prompt the CLI
   * submits under an id it has not used is the message just pasted, whatever the hook shows of it:
   * a wrapper or a rewrite must not leave the run unconfirmed. The text is only a sanity check, and
   * a prompt that reads as something else entirely (a person typing into the pane at the same
   * moment) is left unclaimed. Turns the CLI opens for itself never count. Without a `prompt_id` the
   * text alone has to match. Sends the CLI holds in its own queue are claimed in the order they entered it.
   */
  private claimingSend(prompt: string | undefined, promptId: string | undefined, payload: Record<string, unknown>): PendingSend | undefined {
    if (isSyntheticPrompt(prompt, payload)) return undefined;
    for (const send of this.claimables()) {
      if (this.host.transcript && send.queued) continue;
      if (send.promptSeen || !send.fenced) continue;
      if (promptId !== undefined) {
        if (this.seenPromptIds.has(promptId)) return undefined;
        if (promptConsistent(prompt, send)) return send;
        console.warn('[riffet] claude: the first prompt after dispatch does not read as the message sent; left unclaimed', { session: this.session.id, promptId, commandId: send.commandId });
        return undefined;
      }
      if (prompt !== undefined && claudePromptKey(prompt) === claudePromptKey(send.text)) return send;
    }
    return undefined;
  }

  private async awaitPermission(payload: Record<string, unknown>, deliveryId: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    const toolName = string(payload.tool_name) ?? 'Claude tool';
    const toolInput = asRecord(payload.tool_input) ?? {};
    const requestId = string(payload.tool_use_id) ?? deliveryId;
    const plan = toolName === 'ExitPlanMode';
    const preview = plan
      ? (string(toolInput.plan)?.trim() || 'Claude did not provide readable plan content. Open the terminal to review the plan before deciding.')
      : safeToolText(toolInput.command ?? toolInput.file_path ?? toolInput.path ?? toolInput.url ?? toolInput);
    const recentToolUse = string(payload.tool_use_id) ?? this.announcedToolUses.get(this.toolFingerprint(toolName, toolInput)) ?? this.recentToolUses.get(this.toolFingerprint(toolName, toolInput));
    const interaction: NativeInteraction = {
      id: `claude-permission:${requestId}`, revision: '1', transport: 'protocol', requestId,
      request: { toolName, toolInput, permissionSuggestions: payload.permission_suggestions },
      kind: plan ? 'plan' : 'permission', title: plan ? 'Review Claude’s plan' : `${toolName} needs permission`, ...(preview ? { message: preview } : {}),
      options: [], actions: [
        { id: 'allow', label: 'Allow', tone: 'primary' },
        { id: 'deny', label: 'Deny', tone: 'danger' },
      ],
    };
    return await this.createPending({
      kind: 'permission', nativeRequestId: requestId,
      ...(recentToolUse ? { toolUseId: recentToolUse } : {}),
      toolName, toolInput, interaction, abortSignal: signal, mainThread: payload.agent_id === undefined,
    });
  }

  private async awaitQuestion(payload: Record<string, unknown>, deliveryId: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    const toolInput = asRecord(payload.tool_input) ?? {};
    const toolUseId = string(payload.tool_use_id) ?? this.announcedToolUses.get(this.toolFingerprint('AskUserQuestion', toolInput));
    if (toolUseId) this.questionHooksDue.delete(toolUseId);
    // Not a shape this card can show: the dialog Claude Code draws is lifted from the screen instead.
    if (!toolUseId) return {};
    const rawQuestions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
    const questions: ClaudeQuestion[] = rawQuestions.flatMap((raw, qIndex) => {
      const item = asRecord(raw);
      if (!item || typeof item.question !== 'string') return [];
      const options = Array.isArray(item.options) ? item.options.flatMap((option, optionIndex) => {
        const entry = asRecord(option);
        if (!entry || typeof entry.label !== 'string') return [];
        return [{ id: `q${qIndex}-o${optionIndex}`, label: entry.label, ...(typeof entry.description === 'string' ? { description: entry.description } : {}) }];
      }) : [];
      return [{ question: item.question.slice(0, MAX_INTERACTION_TEXT), ...(typeof item.header === 'string' ? { header: item.header.slice(0, 80) } : {}), options, multiSelect: item.multiSelect === true }];
    });
    if (!questions.length || questions.length > 4) return {};
    const pending = await this.createPending({
      kind: 'question', nativeRequestId: toolUseId, toolUseId,
      toolName: 'AskUserQuestion', toolInput, questions, abortSignal: signal, mainThread: payload.agent_id === undefined,
    });
    return pending;
  }

  private createPending(input: Omit<PendingInteraction, 'interaction' | 'questionIndex' | 'revision' | 'answers' | 'resolveHook' | 'confirmationWaiters'> & { interaction?: NativeInteraction }): Promise<Record<string, unknown>> {
    return new Promise(resolve => {
      let settled = false;
      const resolveHook = (output: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        input.abortSignal?.removeEventListener('abort', abortListener);
        resolve(output);
      };
      // The hook command went away (Claude killed it, the CLI exited, the connection broke): the CLI is
      // no longer asking through the hook, so the card is gone. A native dialog, if it draws one, is
      // picked up from the screen.
      const abortListener = () => {
        const pending = this.pending.get(input.nativeRequestId);
        if (pending) this.removePendingInteraction(pending, false);
        resolveHook({});
      };
      input.abortSignal?.addEventListener('abort', abortListener, { once: true });
      const interaction: NativeInteraction = input.interaction ?? {
        id: `claude-question:${input.nativeRequestId}`, revision: '1', transport: 'protocol' as const,
        requestId: input.nativeRequestId, kind: 'question' as const,
        title: 'Question', options: [], actions: [],
      };
      const pending: PendingInteraction = {
        ...input, interaction, questionIndex: 0, revision: 1, answers: {}, resolveHook,
        abortSignal: input.abortSignal, abortListener, confirmationWaiters: new Set(),
      };
      if (!input.interaction && input.kind === 'question') pending.interaction = this.questionInteraction(pending);
      this.pending.set(input.nativeRequestId, pending);
      if (input.toolUseId) this.permissionToolUses.set(input.toolUseId, input.nativeRequestId);
      // The card is the last thing to reach a client: the text, the thinking and the earlier tool results in
      // front of it are read from the transcript and delivered first. Claude Code writes the rows of the
      // call a moment after its hooks run, so the tail is awaited until the call itself is in it.
      void this.settleTranscriptTail(input.toolUseId).then(() => {
        if (this.disposed || this.pending.get(input.nativeRequestId) !== pending) return;
        this.dispatchSignal({ type: 'attention', requestId: input.nativeRequestId, mainThread: pending.mainThread !== false }, { ...this.status, interaction: pending.interaction });
      });
    });
  }

  /**
   * Read the transcript to its end, and again until the row of tool call `toolUseId` is in it or
   * `CARD_TAIL_GRACE_MS` has passed. Never throws; a transcript that cannot be read costs the grace.
   */
  private async settleTranscriptTail(toolUseId?: string): Promise<void> {
    const deadline = Date.now() + CARD_TAIL_GRACE_MS;
    for (;;) {
      await this.refreshTranscript().catch(() => undefined);
      // Without a readable transcript there is nothing to wait for.
      if (this.disposed || Date.now() >= deadline || this.transcript.state !== 'ok') return;
      if (toolUseId && this.transcript.hasToolCall(toolUseId)) return;
      await pause(CARD_TAIL_POLL_MS);
    }
  }

  private onToolResult(toolUseId: string, failed: boolean): void {
    // A dialog the CLI drew itself ends when the CLI got its answer, wherever that was typed: the
    // transcript says so before the next screen poll would.
    if (isClaudeScreenInteraction(this.status.interaction)) void this.refreshScreenState().catch(() => undefined);
    const requestId = this.permissionToolUses.get(toolUseId) ?? toolUseId;
    const pending = this.pending.get(requestId);
    if (!pending) return;
    pending.terminalSettled = true;
    if (pending.candidate) {
      if (pending.kind === 'question' && !pending.questionAnswersMatched) return;
      this.confirmProviderInteraction(pending, failed ? 'Claude received the interaction; the tool then failed.' : 'Claude confirmed the native interaction.');
    } else {
      // The native TUI won the race. Return no decision from the hook and invalidate the web card.
      pending.resolveHook({});
      this.removePendingInteraction(pending, false);
    }
  }

  /**
   * A command's window opens at its PreToolUse, which comes before the person decides. Refused here, the command never
   * runs and the window goes; allowed, it starts over now, so what changed while the person was deciding is not the
   * command's. A request left to the CLI's own dialog keeps the window it has.
   */
  private async observeDecision(payload: Record<string, unknown>, decision: Record<string, unknown>): Promise<void> {
    if (!this.observer || payload.tool_name !== 'Bash') return;
    const input = asRecord(payload.tool_input) ?? {};
    const toolId = string(payload.tool_use_id) ?? this.announcedToolUses.get(this.toolFingerprint('Bash', input));
    const behavior = string(asRecord(asRecord(decision.hookSpecificOutput)?.decision)?.behavior);
    if (!toolId || !behavior) return;
    if (behavior === 'deny') this.observer.discard(toolId);
    else if (behavior === 'allow' && input.run_in_background !== true) await this.observer.begin(toolId, string(payload.cwd) ?? this.project.cwd, string(input.command));
  }

  private toolFingerprint(toolName: string, toolInput: Record<string, unknown>): string {
    return createHash('sha256').update(`${toolName}\0${stableJson(toolInput)}`).digest('hex');
  }

  private onToolUse(toolUseId: string, toolName: string, toolInput: Record<string, unknown>): void {
    const fingerprint = this.toolFingerprint(toolName, toolInput);
    this.recentToolUses.set(fingerprint, toolUseId);
    while (this.recentToolUses.size > 256) this.recentToolUses.delete(this.recentToolUses.keys().next().value!);
    const pending = [...this.pending.values()].find(item => item.kind === 'permission' && !item.toolUseId
      && item.toolName === toolName && stableJson(item.toolInput) === stableJson(toolInput));
    if (pending) {
      pending.toolUseId = toolUseId;
      this.permissionToolUses.set(toolUseId, pending.nativeRequestId);
    }
    const question = [...this.pending.values()].find(item => item.kind === 'question' && item.candidate && item.toolUseId === toolUseId);
    if (question) {
      const expected = candidateInput(question)?.answers;
      if (expected && stableJson(expected) === stableJson(toolInput.answers)) question.questionAnswersMatched = true;
    }
  }

  private confirmHookInteraction(event: 'PostToolUse' | 'PostToolUseFailure' | 'PermissionDenied', payload: Record<string, unknown>): void {
    const toolUseId = string(payload.tool_use_id) ?? string(payload.toolUseId);
    const mappedRequestId = toolUseId ? this.permissionToolUses.get(toolUseId) ?? toolUseId : undefined;
    let pending = mappedRequestId ? this.pending.get(mappedRequestId) : undefined;
    const toolName = string(payload.tool_name);
    const toolInput = asRecord(payload.tool_input);
    if (!pending && toolName && toolInput) {
      const matches = [...this.pending.values()].filter(item => {
        const expectedInput = item.kind === 'question' && item.candidate ? candidateInput(item) : item.toolInput;
        return (!toolUseId || !item.toolUseId) && item.toolName === toolName && stableJson(expectedInput) === stableJson(toolInput);
      });
      if (matches.length === 1) pending = matches[0];
    }
    if (!pending || (toolName && toolName !== pending.toolName)) return;
    if (pending.kind === 'permission' && toolInput && stableJson(toolInput) !== stableJson(pending.toolInput)) return;
    if (toolUseId) {
      pending.toolUseId = toolUseId;
      this.permissionToolUses.set(toolUseId, pending.nativeRequestId);
    }
    if (event === 'PermissionDenied') {
      const decision = asRecord(asRecord(pending.candidate?.output.hookSpecificOutput)?.decision);
      if (decision?.behavior === 'deny') this.confirmProviderInteraction(pending, 'Claude confirmed the denial.');
      else if (pending.candidate) this.confirmProviderInteraction(pending, 'Claude denied the tool despite the submitted response. Open the terminal to review the denial.', 'uncertain');
      else {
        pending.resolveHook({});
        this.removePendingInteraction(pending, false);
      }
      return;
    }
    if (!pending.candidate) {
      pending.resolveHook({});
      this.removePendingInteraction(pending, false);
      return;
    }
    if (pending.kind === 'question') {
      const expected = candidateInput(pending)?.answers;
      const actual = asRecord(payload.tool_input)?.answers;
      if (!expected || stableJson(expected) !== stableJson(actual)) return;
      pending.questionAnswersMatched = true;
    }
    if (event === 'PostToolUseFailure' || payload.tool_response !== undefined) {
      if (pending.kind !== 'question' || pending.questionAnswersMatched) {
        this.confirmProviderInteraction(pending, event === 'PostToolUseFailure' ? 'Claude received the interaction; the tool then failed.' : 'Claude confirmed the native interaction.');
      }
    }
  }

  private confirmProviderInteraction(pending: PendingInteraction, message: string, status: 'completed' | 'uncertain' = 'completed'): void {
    if (!pending.candidate || pending.providerResult) return;
    const result: NativeInteractionResult = { status, message };
    pending.providerResult = result;
    const saved = this.host.getInteractionReceipt(this.session.id, pending.candidate.webRequestId);
    if (saved) this.host.saveInteractionReceipt(this.session.id, pending.candidate.webRequestId, { ...saved, result });
    for (const resolve of pending.confirmationWaiters) resolve(result);
    pending.confirmationWaiters.clear();
    const displayed = this.status.interaction?.id === pending.interaction.id;
    this.removePendingInteraction(pending, true);
    if (displayed && status === 'uncertain') this.setStatus({ ...this.status, interaction: undefined, notice: message, noticeLevel: 'warning' });
  }

  /**
   * Closes every open request. A request nobody answered is let go (`{}`: the CLI asks in its own dialog), because the
   * CLI outlives this runtime; only a stop that interrupted the turn refuses it, as the reader's own decision.
   */
  private cancelPending(reason: string, answer: 'release' | 'deny' = 'release'): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.candidate) {
        this.confirmProviderInteraction(pending, reason, 'uncertain');
        this.removePendingInteraction(pending, false);
        continue;
      }
      pending.resolveHook(answer === 'deny' ? { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: reason } } } : {});
      this.removePendingInteraction(pending, false);
    }
  }

  private removePendingInteraction(pending: PendingInteraction, returnToBusy: boolean): void {
    if (pending.candidateCleanup) clearTimeout(pending.candidateCleanup);
    pending.abortSignal?.removeEventListener('abort', pending.abortListener!);
    if (this.pending.get(pending.nativeRequestId) === pending) this.pending.delete(pending.nativeRequestId);
    if (pending.toolUseId && this.permissionToolUses.get(pending.toolUseId) === pending.nativeRequestId) this.permissionToolUses.delete(pending.toolUseId);
    // The turn goes back to running once nothing waits on a person; another request still open is shown instead.
    const remaining = [...this.pending.values()][0];
    const { interaction: _interaction, ...status } = this.status;
    const next = { ...status, ...(returnToBusy ? { notice: undefined, noticeLevel: undefined } : {}), ...(remaining ? { interaction: remaining.interaction } : {}) };
    if (this.status.interaction?.id === pending.interaction.id || this.state.mainTurn.kind === 'attention') {
      this.dispatchSignal({ type: 'attention', ...(remaining ? { requestId: remaining.nativeRequestId, mainThread: remaining.mainThread !== false } : {}) }, this.status.interaction?.id === pending.interaction.id ? next : this.status);
    }
  }

  /**
   * `marked`: the transcript records the turn's end, and the journal's mark of it settles the Run (sync v3). Any other
   * outcome (a failure only a hook reported, a turn stopped from here, a send taken back) also goes to the dispatcher on
   * the control path, as the same event.
   */
  private emitRunTerminal(type: 'run_completed' | 'run_failed' | 'run_cancelled', turn: ActiveWebTurn, error?: string, reason?: string, marked = false): void {
    // One end per Run: the first cause stands.
    if (this.closedCommands.has(turn.commandId)) return;
    this.closedCommands.add(turn.commandId);
    if (this.closedCommands.size > MAX_REMEMBERED_PROMPTS) this.closedCommands.delete(this.closedCommands.values().next().value!);
    // The journal ends a turn the transcript recorded; one it did not (`marked` false) reaches the run here.
    if (marked) return;
    this.host.emitEvent(this.session.id, {
      sequence: 0, sessionId: this.session.id,
      nativeId: `claude:${this.nativeSessionId}:run:${turn.commandId}:${type}`,
      runId: turn.runId, ...(turn.promptId ? { nativeTurnId: turn.promptId } : {}), createdAt: new Date().toISOString(), type,
      data: { commandId: turn.commandId, ...(error ? { error } : {}), ...(reason ? { reason } : {}) },
    });
  }

  get profileId(): string { return this.profile.id; }

  /** Whether the running CLI was launched with `next`'s model, permission mode and profile. */
  launchedMatches(next: Session, profile: NativeBackendProfileConfig = this.profile): boolean {
    const approval = (value: Session) => value.approval ?? string(profile.config.approval) ?? 'default';
    return profile.id === this.launchedProfileId
      && normalizeClaudeModel(selectedModel(next, profile) ?? '') === normalizeClaudeModel(selectedModel(this.session, profile) ?? '')
      && approval(next) === approval(this.session);
  }

  /** Applies the recorded change once nothing new has been picked for `CLAUDE_CONFIG_SETTLE_MS`. */
  deferConfig(): void {
    this.configSettlesAt = Date.now() + CLAUDE_CONFIG_SETTLE_MS;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => { this.settleTimer = undefined; void this.applyPendingConfig(); }, CLAUDE_CONFIG_SETTLE_MS);
    this.settleTimer.unref?.();
  }

  /** The profile the next launch uses; a CLI already running keeps its own until it is relaunched. */
  useProfile(profile: NativeBackendProfileConfig): void { this.profile = profile; }

  async reconfigure(next: Session, profile: NativeBackendProfileConfig = this.profile): Promise<{ nativeSessionId: string; terminalId?: string }> {
    if (this.disposed) throw new AppError('CLAUDE_RUNTIME_DISPOSED', 'Claude runtime has been closed', 503);
    // A repeated selection is harmless even while work runs. Compare the applied launch settings,
    // not just the record: the latter can already contain a switch waiting for this turn to end.
    if (this.started && !this.terminalExited && this.terminalId && this.launchedMatches(next, profile)) {
      return { nativeSessionId: this.nativeSessionId, terminalId: this.terminalId };
    }
    if (this.status.phase === 'attention' || this.status.phase === 'starting' || !this.quiet()) {
      throw new AppError(this.status.phase === 'attention' ? 'CLI_INTERACTION_REQUIRED' : 'CLI_BUSY', 'Claude Code must finish its turn and background work before changing its model or permission mode', 409);
    }
    await validateModelSelection(profile, selectedModel(next, profile));
    this.profile = profile;
    if (this.terminalId) {
      const terminalId = this.terminalId;
      this.unsubscribeTerminal?.();
      this.unsubscribeTerminal = undefined;
      this.observedTerminalId = undefined;
      await this.host.terminal.stop(terminalId);
      this.started = false;
      this.terminalId = undefined;
    }
    this.stagedConfig = { model: next.model, approval: next.approval };
    this.session = { ...next, nativeSessionId: this.nativeSessionId };
    try {
      const opened = await this.start();
      return opened;
    } finally { this.stagedConfig = undefined; }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    // Closing this observer (including a service restart) does not stop the persistent CLI.
    // Receipted inputs keep their result open for the next observer; only unwritten input is rejected.
    this.steering.reject('Claude hook connection was closed.');
    this.disposed = true;
    this.cancelPending('Claude runtime was closed.');
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.terminalPollTimer) clearInterval(this.terminalPollTimer);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.unsubscribeTerminal?.();
    this.unsubscribeTerminal = undefined;
    this.observedTerminalId = undefined;
    for (const timer of this.lateTimers) clearTimeout(timer);
    this.lateTimers.clear();
    this.launchGuard.dispose();
    this.listeners.clear();
    const overlayDisposed = this.overlay.dispose();
    this.readyGate.clear();
    await overlayDisposed;
  }
}
