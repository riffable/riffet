import { statSync } from 'node:fs';
import type { NativeInteraction, NativeStatus, NativeStopRequest, NativeTurnTarget, NativeWorkbenchEvent, Session } from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import { materializeNativeInput } from '../attachments.js';
import type { NativeBackendHost, NativeBackendSendRequest } from '../types.js';
import { claudeComposer, claudeComposerHoldsPrompt, claudeComposerVisible, claudeFooterFocused, claudeScreenBusy, claudeTasksEntryFocused, claudeTasksEntryShown, claudeViewsSubagent } from '../../adapters/cli/claude-code.js';
import type { TerminalInteractionControl } from '../../terminal/service.js';
import { ClaudeTranscript } from './history.js';
import { claudePromptKey } from './rows.js';
import { claudeScreenInteraction } from './screen-dialog.js';
import { parseDialog } from '../../agent-host/interaction-screen.js';
import { type ClaudeSessionState, type Transition } from './session-state.js';
import { string, backendId, asRecord, pause } from './launch.js';
import { ComposerDriver, FOOTER_KEY_MS, checkSendInterrupt, type PendingSend } from './composer.js';
import { READY_GATE_MS } from './ready-gate.js';

export const RECEIPT_TIMEOUT_MS = 90_000;

/**
 * An unconfirmed prompt is not a failed one: Claude may be busy (a long compaction, a queue ahead of it)
 * and write the row long after the wait ended. The transcript is read again at these delays after the
 * wait gave up, and a row that turns up then still confirms the run; the prompt is never pasted again.
 */
const LATE_RECEIPT_RECHECK_MS = [30_000, 120_000];

export const MAX_REMEMBERED_PROMPTS = 200;

const MAX_RECENT_SENDS = 8;

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

/** How long a send waits for a launch to finish starting before it is refused and queued again. */
const STARTING_SEND_WAIT_MS = READY_GATE_MS + 5_000;

interface ActiveWebTurn { commandId: string; runId: string; promptId?: string; }

/** Claude trims a command's arguments, so a rewrite is matched with its whitespace collapsed. */
export function rewriteKey(prompt: string): string {
  return prompt.trim().replace(/\s+/g, ' ');
}

/**
 * A turn the CLI opened for itself — a finished subagent or background task reporting back — is not
 * something a person typed, so it can never be the message that was just sent.
 */
function isSyntheticPrompt(prompt: string | undefined, payload: Record<string, unknown>): boolean {
  const origin = string(asRecord(payload.origin)?.kind);
  if (origin !== undefined && origin !== 'human') return true;
  return prompt !== undefined && /^\s*<task-notification\b/i.test(prompt);
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

/** What the group takes from `ClaudeSessionRuntime`: values read on demand and callbacks, never the runtime itself. */
export interface ClaudeSendsDeps {
  composer: ComposerDriver;
  host: NativeBackendHost;
  nativeSessionId: string;
  transcript: ClaudeTranscript;
  disposed(): boolean;
  session(): Session;
  started(): boolean;
  state(): ClaudeSessionState;
  status(): NativeStatus;
  terminalId(): string | undefined;
  assertExpectedStop(stop: NativeStopRequest, terminalId: string, allowEnded?: boolean, stopping?: NativeTurnTarget): Promise<void>;
  endorsesDialog(dialog: NativeInteraction): boolean;
  noteActivity(): void;
  ownPublishedTurn(promptId: string | undefined, runId: string): void;
  refreshTranscript(follow?: boolean): Promise<void>;
  schedulePolling(): void;
  stopLateTurn(promptId: string): Promise<void>;
  untestedVersion(): Promise<string | undefined>;
  waitUntil(done: () => boolean, timeoutMs: number, probe?: () => Promise<boolean>): Promise<boolean>;
}

/** Messages on their way into the CLI: the write, its receipt, the CLI's own input queue, and which transcript row belongs to which send. */
export class ClaudeSends {
  pendingSend?: PendingSend;
  /** A send whose receipt wait ran out, kept until its last re-check so a late transcript row still claims it. */
  private lateSend?: PendingSend;
  /** Sends the CLI holds in its own input queue: not a turn yet, but no longer in the composer. */
  readonly queuedSends: PendingSend[] = [];
  /**
   * The last few messages this process typed. When the CLI is interrupted before it has answered, it puts
   * the message back into its input box; seeing one of these there is how a stale message is told from a draft.
   */
  private readonly recentSends: PendingSend[] = [];
  /** Commands whose Run already got its terminal event, so a second cause for the same end says nothing. */
  readonly closedCommands = new Set<string>();
  private readonly lateTimers = new Set<NodeJS.Timeout>();
  /** Prompt ids the hook has announced: a send claims the first one it has not seen. */
  private readonly seenPromptIds = new Set<string>();
  /**
   * The run each transcript row was claimed for, so re-mapping the file tags it the same way every time.
   * Not capped: every re-mapping asks again for every row, and a row that fell out would lose its run
   * and reset the transcript for every reader. One entry per claimed send.
   */
  private readonly claimedRows = new Map<string, string>();
  activeWebTurn?: ActiveWebTurn;
  /**
   * The prompts this runtime moved behind a skill, by what Claude stores for them, so the
   * transcript shows the user's text rather than the rewrite. Kept only for this runtime's life: a
   * later process reading the same transcript shows the rewrite, which is what Claude received.
   * Not capped, for the reason `claimedRows` is not: each re-mapping asks again for every row.
   */
  readonly rewrites = new Map<string, string>();

  constructor(private readonly deps: ClaudeSendsDeps) {}

  /** The CLI's own input queue moved: the sends waiting in it are delivered, still waiting, or taken back. */
  onQueue(change: NonNullable<Transition['queue']>): void {
    this.deps.noteActivity();
    if (change.operation === 'enqueue' && change.entry?.kind === 'input') {
      const send = this.claimables().find(item => item.fenced && !item.promptSeen && !item.queued && !item.command
        && (change.text === undefined || promptConsistent(change.text, item)));
      if (send) {
        send.queued = true;
        if (this.deps.host.transcript && send.claimedRow) {
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
      if (this.deps.host.transcript) return;
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
  claimables(): PendingSend[] {
    return [...new Set([this.pendingSend, this.lateSend, ...this.queuedSends].filter((send): send is PendingSend => send !== undefined))];
  }

  /** The send's turn is the one in flight: its end is the Run's end. */
  private bindWebTurn(send: PendingSend, promptId: string | undefined): void {
    if (this.deps.host.transcript && send.queued) return;
    this.unqueue(send);
    if (send.command) return;
    if (send.stopRequested) {
      send.stopRequested = false;
      if (promptId) void this.deps.stopLateTurn(promptId);
    }
    this.activeWebTurn = { commandId: send.commandId, runId: send.runId, ...(promptId ? { promptId } : {}) };
    this.deps.ownPublishedTurn(promptId, send.runId);
  }

  private rememberRewrite(delivered: string, original: string): void {
    this.rewrites.set(rewriteKey(delivered), original);
  }

  /**
   * The run a transcript user row belongs to. A send claimed by its first new `prompt_id` is matched
   * by that id; the text only decides when a row has no id, or when no hook has claimed the send. A row, once matched, keeps its run on every re-mapping of the file.
   */
  commandForUserMessage(message: { uuid: string; promptId?: string; text: string }): string | undefined {
    const known = this.claimedRows.get(message.uuid);
    if (known && this.deps.host.transcript && this.recentSends.some(send => send.queued && send.commandId === known)) {
      this.claimedRows.delete(message.uuid);
      return undefined;
    }
    if (known) return known;
    for (const pending of this.claimables()) {
      if (this.deps.host.transcript && pending.queued) continue;
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
    const terminalId = this.deps.terminalId();
    if (!terminalId || !this.deps.started()) throw new AppError('TERMINAL_NOT_RUNNING', 'Claude Code is not running', 409);
    // Whether the main agent is free is the state's to say (background agents do not occupy it), so a
    // message sent while only background work runs is written straight away.
    // A CLI that is still drawing its first screen is a few seconds from its input box. Waiting for it
    // here delivers the first message as soon as it can take it; refusing would send the run back to the
    // queue for another round of preparation. One that is not ready in time is refused as before.
    if (this.deps.state().process === 'starting') {
      const process = () => this.deps.state().process;
      await this.deps.waitUntil(() => this.deps.disposed() || process() !== 'starting', STARTING_SEND_WAIT_MS);
      if (this.deps.disposed() || this.deps.terminalId() !== terminalId || process() !== 'alive') throw new AppError('CLI_BUSY', 'Claude Code is still starting', 409);
    }
    if (this.deps.status().phase === 'attention') throw new AppError('CLI_INTERACTION_REQUIRED', 'Resolve the pending Claude interaction before sending another message', 409);
    if (this.deps.state().mainTurn.kind !== 'idle') throw new AppError('CLI_BUSY', 'Claude Code is working on another turn', 409);
    const { deliverText } = options;
    const { text } = await materializeNativeInput(this.deps.host, deliverText === undefined ? request.input : { ...request.input, text: deliverText });
    // `/compact` is a turn: it runs for a while, ends with its own record, and is the Run's to wait for.
    const compact = /^\/compact(?:\s|$)/.test(request.input.text.trim());
    const isSlashCommand = !compact && (options.command ?? request.input.text.trimStart().startsWith('/'));
    // A rewrite is `/name ` in front of the user's text, so what follows the first space is theirs.
    const echo = deliverText === undefined ? text : text.slice(text.indexOf(' ') + 1);
    if (deliverText !== undefined) this.rememberRewrite(text, echo);
    const baselineSequence = this.deps.transcript.lastSequence();
    const baselineUserIds = this.deps.transcript.userMessageIds();
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
    this.deps.schedulePolling();
    const expectedModel = request.config.model ?? this.deps.session().model;
    try {
      // Read before the terminal is held: a first probe spawns the CLI twice.
      const untested = await this.deps.untestedVersion();
      await this.deps.host.terminal.withInteraction(terminalId, async control => {
        let screen = await control.screen();
        const info = await this.deps.host.terminal.get(terminalId);
        // A menu can appear between polls while leaving the input box drawn. Refuse before the
        // dispatch fence so the message stays queued and no paste or Enter answers the menu.
        const dialog = screen === undefined ? undefined
          : claudeScreenInteraction(screen, info) ?? parseDialog(screen, info)?.interaction;
        if (dialog && this.deps.endorsesDialog(dialog)) throw new AppError('CLI_INTERACTION_REQUIRED', 'Resolve the pending Claude interaction before sending another message', 409);
        // The box has to be there to type into; whether a turn runs is not read from it.
        if (!claudeComposerVisible(screen)) throw new AppError('CLI_BUSY', 'Claude Code is not at its input prompt', 409);
        // A reader who opened a background agent's view leaves the composer talking to that agent; the
        // message is the main agent's, so the composer is taken back first.
        if (screen !== undefined && (claudeViewsSubagent(screen) || claudeFooterFocused(screen))) {
          if (untested) throw new AppError('CLI_BUSY', `Claude Code ${untested} is showing a background agent; switch its terminal back to the main agent`, 409);
          screen = await this.deps.composer.focusMainComposer(control, screen);
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
          screen = await this.deps.composer.wipeComposer(control, stale);
          if (screen === undefined || stale(screen)) {
            throw new AppError('CLI_BUSY', 'Claude Code’s input box still holds an earlier message', 409);
          }
        }
        // What the composer held before this write, so the poll below can tell "my paste is in" from
        // "something was already sitting there".
        const composerBefore = screen === undefined ? undefined : claudeComposer(screen);
        let inputFile: ReturnType<typeof statSync> | undefined;
        if (this.deps.transcript.path) {
          try { inputFile = statSync(this.deps.transcript.path); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        const terminal = await this.deps.host.terminal.get(terminalId);
        request.commitDispatchFence({
          backendId, nativeSessionId: this.deps.nativeSessionId, terminalId, terminalEpoch: terminal.epoch,
          baselineSequence, renderedText: text, slashCommand: isSlashCommand,
          nativeInputBoundary: JSON.stringify({ type: 'claude-transcript', nativeSessionId: this.deps.nativeSessionId,
            offset: inputFile?.size ?? 0, ...(inputFile ? { inode: inputFile.ino } : {}) }),
          resolvedConfig: { model: expectedModel, mode: request.config.mode, approval: request.config.approval },
        });
        pending.fenced = true;
        await control.paste(text, false);
        const pressed = await this.deps.composer.submitPaste(control, text, composerBefore, !untested, pending);
        if (!isSlashCommand) await this.awaitReceipt(pending, control, text, pressed ? undefined : { before: composerBefore });
      });
    } catch (error) {
      if (!pending.receiptSettled) pending.rejectReceipt(error instanceof Error ? error : new Error(String(error)));
      if (pending.fenced && !pending.command) this.confirmLater(pending);
      throw error;
    } finally {
      if (this.pendingSend === pending) this.pendingSend = undefined;
      this.deps.schedulePolling();
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
        const terminalId = this.deps.terminalId();
        const info = terminalId ? await this.deps.host.terminal.get(terminalId).catch(() => undefined) : undefined;
        const dialog = info ? claudeScreenInteraction(screen, info) ?? parseDialog(screen, info)?.interaction : undefined;
        if (!info || (dialog && this.deps.endorsesDialog(dialog))) continue;
        checkSendInterrupt(pending);
        resends += 1;
        pending.submittedAt = Date.now();
        await control.keys(['Enter']);
        if (unpressed) {
          console.warn('[claude] paste shown late; Enter pressed by the receipt wait', { sessionId: this.deps.session().id });
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
      if (this.deps.disposed() || this.lateSend !== pending || pending.claimedRow) return;
      await this.deps.refreshTranscript();
      // A row written before this check was mapped without the run; map the file again so it is
      // tagged (the tag changes the stream, which is announced as one reset).
      if (!pending.claimedRow && [...this.deps.transcript.userMessageIds()].some(id => !pending.baselineUserIds.has(id))) {
        this.deps.transcript.rescan();
        await this.deps.refreshTranscript();
      }
    } catch { /* the next check, or the dispatcher's own, settles it */ }
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
  async clearOwnInput(terminalId: string, boxRequired = false, expectedStop?: NativeStopRequest): Promise<void> {
    if (!this.recentSends.length && !boxRequired) return;
    const cleared = await this.deps.composer.interact(terminalId, async control => {
      const screen = await control.screen();
      if (boxRequired && (screen === undefined || claudeComposer(screen) === undefined || claudeScreenBusy(screen))) {
        throw new AppError('NATIVE_INTERRUPT_UNCONFIRMED', 'Claude Code input box could not be read', 409);
      }
      if (screen === undefined) return [];
      const held = this.recentSends.filter(send => claudeComposerHoldsPrompt(screen, send.text));
      if (!held.length) return [];
      const after = await this.deps.composer.wipeComposer(control, current => held.some(send => claudeComposerHoldsPrompt(current, send.text)),
        expectedStop ? () => this.deps.assertExpectedStop(expectedStop, terminalId, true) : undefined);
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
   * The send a prompt hook belongs to. Once the write fence is committed, the first prompt the CLI
   * submits under an id it has not used is the message just pasted, whatever the hook shows of it:
   * a wrapper or a rewrite must not leave the run unconfirmed. The text is only a sanity check, and
   * a prompt that reads as something else entirely (a person typing into the pane at the same
   * moment) is left unclaimed. Turns the CLI opens for itself never count. Without a `prompt_id` the
   * text alone has to match. Sends the CLI holds in its own queue are claimed in the order they entered it.
   */
  claimingSend(prompt: string | undefined, promptId: string | undefined, payload: Record<string, unknown>): PendingSend | undefined {
    if (isSyntheticPrompt(prompt, payload)) return undefined;
    for (const send of this.claimables()) {
      if (this.deps.host.transcript && send.queued) continue;
      if (send.promptSeen || !send.fenced) continue;
      if (promptId !== undefined) {
        if (this.seenPromptIds.has(promptId)) return undefined;
        if (promptConsistent(prompt, send)) return send;
        console.warn('[riffet] claude: the first prompt after dispatch does not read as the message sent; left unclaimed', { session: this.deps.session().id, promptId, commandId: send.commandId });
        return undefined;
      }
      if (prompt !== undefined && claudePromptKey(prompt) === claudePromptKey(send.text)) return send;
    }
    return undefined;
  }

  /**
   * `marked`: the transcript records the turn's end, and the journal's mark of it settles the Run (sync v3). Any other
   * outcome (a failure only a hook reported, a turn stopped from here, a send taken back) also goes to the dispatcher on
   * the control path, as the same event.
   */
  emitRunTerminal(type: 'run_completed' | 'run_failed' | 'run_cancelled', turn: ActiveWebTurn, error?: string, reason?: string, marked = false): void {
    // One end per Run: the first cause stands.
    if (this.closedCommands.has(turn.commandId)) return;
    this.closedCommands.add(turn.commandId);
    if (this.closedCommands.size > MAX_REMEMBERED_PROMPTS) this.closedCommands.delete(this.closedCommands.values().next().value!);
    // The journal ends a turn the transcript recorded; one it did not (`marked` false) reaches the run here.
    if (marked) return;
    this.deps.host.emitEvent(this.deps.session().id, {
      sequence: 0, sessionId: this.deps.session().id,
      nativeId: `claude:${this.deps.nativeSessionId}:run:${turn.commandId}:${type}`,
      runId: turn.runId, ...(turn.promptId ? { nativeTurnId: turn.promptId } : {}), createdAt: new Date().toISOString(), type,
      data: { commandId: turn.commandId, ...(error ? { error } : {}), ...(reason ? { reason } : {}) },
    });
  }

  /** A row carrying the command id of the send in flight is its receipt. */
  settleReceipt(commandId: string, event: Parameters<PendingSend['resolveReceipt']>[0]): void {
    const send = this.pendingSend;
    if (send?.commandId !== commandId || send.receiptSettled) return;
    send.receiptSettled = true;
    send.resolveReceipt(event);
  }

  /** The `/compact` being sent is running: its rows only come at the boundary, long after the receipt window. */
  compactionStarted(): void {
    const send = this.pendingSend;
    if (!send?.compact || !send.fenced || send.receiptSettled) return;
    send.compactionStarted = true;
    send.receiptWake?.();
  }

  /** A prompt id the hook announced. */
  rememberPrompt(promptId: string): void {
    this.seenPromptIds.add(promptId);
    if (this.seenPromptIds.size > MAX_REMEMBERED_PROMPTS) this.seenPromptIds.delete(this.seenPromptIds.values().next().value!);
  }

  /** The hook named the prompt `send` became. */
  promptSubmitted(send: PendingSend, promptId: string | undefined): void {
    // A send given up on earlier may already have its row in the stream, mapped without the run.
    if (send === this.lateSend) setTimeout(() => void this.confirmNow(send), 0).unref?.();
    send.promptSeen = true;
    send.promptId = promptId;
    this.bindWebTurn(send, promptId);
  }

  /** A row that opened the turn after the CLI took it off its own queue names the send it belongs to. */
  rowOpenedTurn(uuid: string, promptId: string | undefined): void {
    const commandId = this.claimedRows.get(uuid);
    const send = commandId ? this.claimables().find(item => item.commandId === commandId) : undefined;
    if (send && !(this.deps.host.transcript && send.queued)) {
      send.promptSeen = true;
      if (promptId) send.promptId = promptId;
      this.bindWebTurn(send, promptId);
    }
  }

  /** Takes the web turn in progress, leaving none. */
  takeWebTurn(): ActiveWebTurn | undefined {
    const web = this.activeWebTurn;
    this.activeWebTurn = undefined;
    return web;
  }

  /** The CLI is gone, and its input queue with it. */
  dropQueued(): void { this.queuedSends.length = 0; }

  /** Cancels the re-checks of sends given up on. */
  dispose(): void {
    for (const timer of this.lateTimers) clearTimeout(timer);
    this.lateTimers.clear();
  }
}
