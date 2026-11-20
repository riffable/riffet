import { stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { NativeContext, NativeStatus, NativeTurnTarget, Project, Session } from '../../../../../packages/contracts/src/index.js';
import { DeferredSteerInputs } from '../shared/deferred-steer.js';
import type { NativeBackendHost, NativeControlMessage, StandingMoment } from '../types.js';
import { ClaudeTranscript, findClaudeTranscript } from './history.js';
import { claudeFailureText, stripPastedContent } from './rows.js';
import { ClaudeTranscriptChanges } from './transcript-source.js';
import { claudeNativeContext } from './context.js';
import { activeTurnOf, type ClaudeSessionState, type ClaudeSignal, type ClaudeTurnOrigin, type Transition } from './session-state.js';
import { string, asRecord, configDirOf } from './launch.js';
import { ClaudeInteractions } from './interactions.js';
import { ReadyGate } from './ready-gate.js';
import type { WorkspaceObserver } from '../shared/workspace-observer.js';
import { ClaudeSends } from './sends.js';
import { ClaudeStops } from './stops.js';
import { ClaudeTerminalBinding } from './binding.js';
import { ClaudeTranscriptReads } from './transcript-reads.js';
import { ClaudeScreenWatch } from './screen-watch.js';

/** The file an edit tool's call writes, from its hook payload. */
function editedPath(payload: Record<string, unknown>): string | undefined {
  if (!['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(string(payload.tool_name) ?? '')) return undefined;
  const input = asRecord(payload.tool_input);
  return string(input?.file_path) ?? string(input?.notebook_path);
}

/** A prompt as the CLI echoes it back: without the paste wrapper newer versions add, and trimmed. */
function shellPrompt(value: string): string { return stripPastedContent(value).replace(/\r\n/g, '\n').trim(); }

/** Who opened the turn, as the hook payload names it; a prompt that names nobody was typed. */
function originOf(payload: Record<string, unknown>): ClaudeTurnOrigin {
  const kind = string(asRecord(payload.origin)?.kind);
  return kind === undefined || kind === 'human' ? 'human' : kind === 'task-notification' ? 'task-notification' : kind === 'peer' ? 'peer' : 'other';
}

function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** One hook as its route sees it: the payload, who posted it, and whether it belongs to the published turn. */
interface HookCall {
  event: string;
  payload: Record<string, unknown>;
  deliveryId: string;
  signal: AbortSignal;
  /** Posted by the main thread rather than by a subagent. */
  mainThread: boolean;
  promptId: string | undefined;
  matchesTurn: boolean;
}

/** What the CLI is answered with; `{}` and nothing both leave it to carry on. */
type HookReply = Record<string, unknown> | void;

/** What the group takes from `ClaudeSessionRuntime`: values read on demand and callbacks, never the runtime itself. */
export interface ClaudeHookRoutesDeps {
  binding: ClaudeTerminalBinding;
  changes: ClaudeTranscriptChanges | undefined;
  host: NativeBackendHost;
  interactions: ClaudeInteractions;
  nativeSessionId: string;
  observer: WorkspaceObserver | undefined;
  project: Project;
  reads: ClaudeTranscriptReads;
  readyGate: ReadyGate;
  sends: ClaudeSends;
  steerTools: Set<string>;
  steering: DeferredSteerInputs;
  stops: ClaudeStops;
  transcript: ClaudeTranscript;
  watch: ClaudeScreenWatch;
  disposed(): boolean;
  nativeTurn(): NativeTurnTarget & { ownerRunId?: string } | undefined;
  session(): Session;
  state(): ClaudeSessionState;
  status(): NativeStatus;
  dispatchSignal(signal: ClaudeSignal, status?: Omit<NativeStatus, 'phase'>): Transition;
  emit(message: NativeControlMessage): void;
  finishSteering(type: 'run_completed' | 'run_failed' | 'run_cancelled', reason?: string): void;
  markTurnOutput(promptId: string | undefined): void;
  noteActivity(): void;
  setSession(session: Session): void;
  setStatus(requested: Omit<NativeStatus, 'phase'>): void;
  steerTarget(): NativeTurnTarget | undefined;
}

/** What each hook the CLI posts means for the conversation: the signal it sends to the state, and what the CLI is answered with. */
export class ClaudeHookRoutes {
  /**
   * The id `/clear` moved the CLI to. This observer belongs to the id it was made for, so the backend replaces it
   * with one for the new id (the same CLI, taken over as after a restart) before the next message.
   */
  clearedTo?: string;
  /** The window and occupancy the CLI last stated to its status line, if it stated one. */
  context?: NativeContext;
  /** Which method answers which hook. An event not listed changes nothing and is answered with `{}`. */
  private readonly routes = new Map<string, (hook: HookCall) => Promise<HookReply> | HookReply>([
    ['SessionStart', hook => this.onSessionStart(hook)],
    ['PreCompact', hook => this.onPreCompact(hook)],
    ['UserPromptSubmit', hook => this.onUserPromptSubmit(hook)],
    ['Stop', hook => this.onStop(hook)],
    ['StopFailure', hook => this.onStop(hook)],
    ['SessionEnd', () => this.onSessionEnd()],
    ['PreToolUse', hook => this.onPreToolUse(hook)],
    ['PermissionRequest', hook => this.onPermissionRequest(hook)],
    ['PostToolUse', hook => this.onToolSettled(hook)],
    ['PostToolUseFailure', hook => this.onToolSettled(hook)],
    ['PermissionDenied', hook => this.onToolSettled(hook)],
  ]);

  constructor(private readonly deps: ClaudeHookRoutesDeps) {}

  /**
   * Publish the window and occupancy the CLI stated to its status line.
   *
   * `context_window_size` is Claude Code's own effective window — its model table, the `[1m]`
   * opt-in, account entitlements, a gateway override — so both numbers are provider-declared and
   * never guessed from the model name; a frame without a usable window is dropped rather than
   * filled in. Frames repeat while a turn streams, so only a real move is broadcast.
   */
  private noteStatusLine(payload: Record<string, unknown>): void {
    if (string(payload.session_id) !== this.deps.nativeSessionId) return;
    const next = claudeNativeContext(payload);
    if (!next) return;
    if (
      this.context
      && this.context.used === next.used
      && this.context.size === next.size
      && Boolean(this.context.breakdownEstimated) === Boolean(next.breakdownEstimated)
      && JSON.stringify(this.context.breakdown) === JSON.stringify(next.breakdown)
    ) return;
    this.context = next;
    this.deps.emit({ type: 'context', context: next });
  }

  /** What a hook of a standing conversation answers with: context for the model, shown to no one. */
  private standingReply(event: 'SessionStart' | 'UserPromptSubmit', moment: StandingMoment | undefined, runId?: string): Record<string, unknown> {
    if (!moment) return {};
    let context: string | undefined;
    try { context = this.deps.host.standing?.context(this.deps.session().id, moment, runId); } catch { context = undefined; }
    return context ? { hookSpecificOutput: { hookEventName: event, additionalContext: context } } : {};
  }

  /**
   * Every hook the CLI posts for this conversation, and its status line frames. What holds for all of them is done here,
   * in this order; the event's own route does the rest. `matchesTurn` is read before the route runs, because a tool
   * hook can itself open the turn it belongs to.
   */
  async handleHook(payload: Record<string, unknown>, deliveryId: string, signal: AbortSignal): Promise<HookReply> {
    if (this.deps.disposed()) return {};
    const event = string(payload.hook_event_name);
    // A status line frame is not a hook and carries no event name; it is the one place the CLI
    // states the context window (see `context.ts` and `statusline-cli.mjs`).
    if (!event) {
      this.noteStatusLine(payload);
      return {};
    }
    // `/clear` starts a new Claude session in the same CLI; its hooks carry the new id from here on.
    if (event === 'SessionStart' && string(payload.source) === 'clear' && string(payload.session_id) && string(payload.session_id) !== this.deps.nativeSessionId) {
      this.clearedTo = string(payload.session_id);
      return {};
    }
    if (string(payload.session_id) !== this.deps.nativeSessionId) return {};
    // Any hook may come just before rows the CLI is about to write; the journal's reader looks then too.
    this.deps.changes?.emit(this.deps.session().id);
    this.deps.noteActivity();
    // Any hook but the session's own start is the CLI at work — a prompt, a tool, a stop — so it is up.
    // (`SessionStart` only opens the launch's gate, which waits for the input box.)
    if (this.deps.state().process === 'starting' && event !== 'SessionStart') this.deps.dispatchSignal({ type: 'process', process: 'alive' });
    // A CLI held to be gone that still reports work says otherwise: the terminal is looked at again rather than believed
    // either way, since a hook can also arrive late from one that has just exited.
    else if (this.deps.state().process === 'exited' && event !== 'SessionEnd') void this.deps.binding.refreshTerminalStatus(true);
    const route = this.routes.get(event);
    const mainThread = payload.agent_id === undefined;
    if (!route || (!mainThread && ['UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd'].includes(event))) return {};
    const promptId = string(payload.prompt_id);
    // A delayed hook from a previous prompt must never mutate or consume the new target.
    const turn = this.deps.nativeTurn();
    const matchesTurn = mainThread && turn !== undefined && promptId === turn.turnId;
    return await route({ event, payload, deliveryId, signal, mainThread, promptId, matchesTurn });
  }

  private async onSessionStart({ payload }: HookCall): Promise<HookReply> {
    const hookSessionId = string(payload.session_id);
    const transcriptPath = string(payload.transcript_path);
    const root = join(configDirOf(this.deps.binding.profile), 'projects');
    if (hookSessionId === this.deps.nativeSessionId && transcriptPath && basename(transcriptPath) === `${this.deps.nativeSessionId}.jsonl` && isInside(root, transcriptPath)) {
      // The path is derived from the CLI's working directory. After a worktree switch
      // (EnterWorktree / ExitWorktree) it names the other directory's project folder, where
      // nothing is written: the conversation stays in the file it started in. A path with no file
      // yields to the session's existing transcript; a new session's file may not exist yet.
      const reported = await stat(transcriptPath).then(info => info.isFile(), () => false);
      const file = reported ? transcriptPath : (await findClaudeTranscript(configDirOf(this.deps.binding.profile), this.deps.nativeSessionId)) ?? transcriptPath;
      if (this.deps.disposed()) return {};
      await this.deps.transcript.setFile(file);
      if (this.deps.disposed()) return {};
      this.deps.setSession({ ...this.deps.session(), nativeSessionId: this.deps.nativeSessionId });
      const fields = { model: this.deps.session().model ?? string(this.deps.binding.profile.config.defaultModel), approval: this.deps.binding.adoptApproval(payload.permission_mode) };
      // A session start never says anything about the turn: Claude Code starts one inside a running
      // turn too (it compacts its own context and continues, or restarts on resume), and a server that
      // took over a CLI sees it as often as a launch does. It only says the CLI is up. For our own
      // launch that is not yet a prompt to type into: the gate (see `READY_GATE_MS`), not the hook,
      // ends `starting`.
      this.deps.setStatus({ ...this.deps.status(), ...fields });
      if (this.deps.state().process === 'starting') this.deps.readyGate.open();
      await this.deps.reads.refreshTranscript();
      if (this.deps.readyGate.opened) {
        // The composer is read now, after the gate opened, rather than at the next poll.
        while (this.deps.watch.screenDialogTask) await this.deps.watch.screenDialogTask.catch(() => undefined);
        await this.deps.watch.refreshScreenState();
      }
    }
    // A resumed or forked session still holds its history; only a new one, or one just summarized, is told what it lacks.
    const source = string(payload.source);
    return this.standingReply('SessionStart', source === 'compact' ? 'compact' : source === 'startup' ? 'start' : undefined);
  }

  private async onPreCompact({ payload, deliveryId, mainThread, promptId: hookPromptId }: HookCall): Promise<HookReply> {
    if (mainThread) {
      await this.deps.reads.compactionHooked(payload.trigger === 'auto' ? 'auto' : 'manual', deliveryId, hookPromptId);
      try { this.deps.host.standing?.compacting?.(this.deps.session().id); } catch { /* a standing host's trouble is not the turn's */ }
    }
    return {};
  }

  private onUserPromptSubmit({ payload, promptId: hookPromptId }: HookCall): HookReply {
    const prompt = string(payload.prompt);
    const promptId = hookPromptId;
    const claimant = this.deps.sends.claimingSend(prompt, promptId, payload);
    const text = prompt === undefined ? '' : shellPrompt(prompt);
    // A command is not a message to the model, so it carries no context of its own.
    const told = this.standingReply('UserPromptSubmit', text && !text.startsWith('/') ? 'prompt' : undefined, claimant?.runId);
    // The transcript can announce the turn before its delayed hook names the Riffet input.
    // Ignore duplicate hooks only after giving that input a chance to claim its existing row.
    if (promptId && this.deps.nativeTurn()?.turnId === promptId && !claimant) return told;
    if (promptId) this.deps.sends.rememberPrompt(promptId);
    this.deps.dispatchSignal({
      type: 'prompt', source: 'hook', ...(promptId ? { promptId } : {}), origin: originOf(payload),
      ...(/^\/compact(?:\s|$)/.test(text) ? { compact: true } : {}), ...(text.startsWith('/') ? { slash: true } : {}),
    }, { ...this.deps.status(), approval: this.deps.binding.adoptApproval(payload.permission_mode) });
    if (claimant) {
      this.deps.sends.promptSubmitted(claimant, promptId);
      this.deps.setStatus(this.deps.status());
    }
    return told;
  }

  private async onStop({ event, payload, promptId: hookPromptId, matchesTurn }: HookCall): Promise<HookReply> {
    if (this.deps.nativeTurn() && hookPromptId !== undefined && !matchesTurn) return {};
    // The hook can land before the poll has read the rows that close the turn (the final answer), so those
    // are delivered first: the Run's end must not reach a client ahead of the answer it ends.
    await this.deps.reads.refreshTranscript().catch(() => undefined);
    if (this.deps.disposed()) return {};
    // Our Stop hook is one of several the CLI runs side by side; the turn is over once the slowest returns and
    // none sent the model on, which the transcript's Stop summary says. A turn the transcript has not shown (or
    // cannot) would never see that summary taken as its own, so the hook ends it.
    if (event === 'Stop' && this.deps.transcript.state === 'ok' && activeTurnOf(this.deps.state().mainTurn)?.transcriptSeen) return {};
    this.deps.dispatchSignal({
      type: 'turn_end', source: 'hook', reason: event === 'Stop' ? 'stop' : 'stop_failure', ...(hookPromptId ? { promptId: hookPromptId } : {}),
      ...(event === 'StopFailure' ? { error: claudeFailureText(string(payload.last_assistant_message)) } : {}),
    });
    return {};
  }

  private async onSessionEnd(): Promise<HookReply> {
    const { ended } = this.deps.dispatchSignal({ type: 'turn_end', source: 'hook', reason: 'session_end' }, { ...this.deps.status(), interaction: undefined });
    // The session ends under a turn the CLI writes no end for; one it never named is ended by the exit that follows.
    if (ended?.promptId) await this.deps.stops.endJournalTurn('interrupted', ended.promptId);
    return {};
  }

  /**
   * A tool hook of a prompt nobody announced proves a turn this process missed the start of. A prompt
   * that already ended is remembered, so a late hook of it opens nothing.
   */
  private noteToolHook({ event, mainThread, promptId: hookPromptId }: HookCall): void {
    if (mainThread && hookPromptId && !activeTurnOf(this.deps.state().mainTurn) && ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure'].includes(event)) {
      this.deps.dispatchSignal({ type: 'prompt', source: 'hook', promptId: hookPromptId, origin: 'other' });
    }
    if (mainThread && hookPromptId === activeTurnOf(this.deps.state().mainTurn)?.promptId
      && ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure'].includes(event)) this.deps.markTurnOutput(hookPromptId);
  }

  private async onToolSettled(hook: HookCall): Promise<HookReply> {
    const { event, payload, signal, matchesTurn } = hook;
    if (event !== 'PostToolUse' && event !== 'PostToolUseFailure' && event !== 'PermissionDenied') return {};
    this.noteToolHook(hook);
    // Taken before the hook returns: Claude Code writes the call's result row after its PostToolUse hooks, and the
    // transcript mapping appends what was recorded here to that row.
    const observedId = string(payload.tool_use_id);
    // A file an edit tool changed is that tool's to report, not a command's that ran beside it.
    const edited = event === 'PostToolUse' ? editedPath(payload) : undefined;
    if (edited) this.deps.observer?.noteEdit(edited);
    if (observedId && event === 'PermissionDenied') this.deps.observer?.discard(observedId);
    else if (observedId && this.deps.observer) {
      const diffs = await this.deps.observer.end(observedId);
      if (diffs?.length) this.deps.observer.record(this.deps.session().id, observedId, diffs);
    }
    this.deps.interactions.confirmHookInteraction(event, payload);
    if (matchesTurn && event === 'PostToolUseFailure' && payload.is_interrupt === true) {
      this.deps.finishSteering('run_cancelled', 'Claude interrupted the running tool.');
      this.deps.setStatus({ ...this.deps.status() });
      return {};
    }
    const target = matchesTurn ? this.deps.steerTarget() : undefined;
    const toolId = string(payload.tool_use_id);
    if (target && toolId && (event === 'PostToolUse' || (event === 'PostToolUseFailure' && payload.is_interrupt !== true)) && this.deps.steerTools.delete(toolId)) {
      const context = await this.deps.host.withSessionLock(this.deps.session().id, () => signal.aborted ? undefined : this.deps.steering.claim(target, { terminalId: this.deps.binding.terminalId }));
      if (context) return { hookSpecificOutput: { hookEventName: event, additionalContext: context } };
    }
    return {};
  }

  private async onPermissionRequest(hook: HookCall): Promise<HookReply> {
    const { payload, deliveryId, signal } = hook;
    this.noteToolHook(hook);
    // A question is answered here, not in its PreToolUse hook: Claude Code writes the assistant rows in
    // front of a tool call (the text, the thinking, the call itself) only once every PreToolUse hook has
    // returned, so a hook held open for a person keeps all of them off the transcript for as long as the
    // person takes. By this hook the rows are down, and the dialog the CLI draws meanwhile is not lifted
    // while the card is up (see `refreshScreenState`).
    if (payload.tool_name === 'AskUserQuestion') return await this.deps.interactions.awaitQuestion(payload, deliveryId, signal);
    const decision = await this.deps.interactions.awaitPermission(payload, deliveryId, signal);
    await this.deps.interactions.observeDecision(payload, decision);
    return decision;
  }

  private async onPreToolUse(hook: HookCall): Promise<HookReply> {
    const { payload, mainThread, promptId: hookPromptId } = hook;
    this.noteToolHook(hook);
    const toolId = string(payload.tool_use_id);
    if (mainThread && hookPromptId === this.deps.nativeTurn()?.turnId && this.deps.steerTarget() && toolId) this.deps.steerTools.add(toolId);
    // The permission hook that follows does not name the call, so it is found again by what it asks.
    const toolName = string(payload.tool_name);
    if (toolId && toolName) {
      if (toolName === 'AskUserQuestion') this.deps.watch.questionAnnounced(toolId);
      this.deps.interactions.announceToolUse(toolName, asRecord(payload.tool_input) ?? {}, toolId);
    }
    // Noted before the edit as well: a command in another conversation that ends before this PostToolUse leaves the file alone.
    const editing = editedPath(payload);
    if (editing) this.deps.observer?.noteEdit(editing);
    // A shell command reports no edits; what it changed is seen around it, a subagent's as well as the main thread's.
    // One left running in the background outlives its call, so it is not observed.
    if (toolId && toolName === 'Bash' && asRecord(payload.tool_input)?.run_in_background !== true) {
      await this.deps.observer?.begin(toolId, string(payload.cwd) ?? this.deps.project.cwd, string(asRecord(payload.tool_input)?.command));
    }
    return {};
  }
}
