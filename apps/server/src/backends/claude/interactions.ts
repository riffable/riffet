import { createHash } from 'node:crypto';
import type { NativeInteraction, NativeInteractionResponse, NativeInteractionResult, NativeStatus, Project, Session } from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import type { NativeBackendHost } from '../types.js';
import type { WorkspaceObserver } from '../shared/workspace-observer.js';
import type { ClaudeTranscript } from './history.js';
import { isClaudeScreenInteraction } from './screen-dialog.js';
import type { ClaudeSessionState, ClaudeSignal } from './session-state.js';
import { string, asRecord, pause } from './launch.js';

const MAX_INTERACTION_TEXT = 4000;
const ACK_TIMEOUT_MS = 4000;
/** How long a response already handed to Claude may stay unconfirmed before the card gives up on it. */
const CONFIRMATION_TIMEOUT_MS = 10 * 60_000;
/** How long a card waits for the rows of its own tool call, and how often the transcript is read meanwhile. */
const CARD_TAIL_GRACE_MS = 1_500;
const CARD_TAIL_POLL_MS = 40;

interface ClaudeQuestion {
  question: string;
  header?: string;
  options: Array<{ id: string; label: string; description?: string }>;
  multiSelect: boolean;
}
export interface PendingInteraction {
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

function stableJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    const object = asRecord(item);
    if (!object) return item;
    return Object.fromEntries(Object.keys(object).sort().map(key => [key, sort(object[key])]));
  };
  return JSON.stringify(sort(value));
}

function safeToolText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.slice(0, MAX_INTERACTION_TEXT);
  if (value === undefined) return undefined;
  try { return JSON.stringify(value).slice(0, MAX_INTERACTION_TEXT); } catch { return '[unavailable]'; }
}

/** What the group takes from `ClaudeSessionRuntime`: values read on demand and callbacks, never the runtime itself. */
export interface ClaudeInteractionsDeps {
  host: NativeBackendHost;
  project: Project;
  observer?: WorkspaceObserver;
  session(): Session;
  status(): NativeStatus;
  mainTurn(): ClaudeSessionState['mainTurn'];
  isDisposed(): boolean;
  transcript(): ClaudeTranscript;
  setStatus(status: Omit<NativeStatus, 'phase'>): void;
  dispatchSignal(signal: ClaudeSignal, status?: Omit<NativeStatus, 'phase'>): void;
  refreshTranscript(): Promise<void>;
  refreshScreenState(): Promise<void>;
  /** The screen group's note that an AskUserQuestion call still awaits its PermissionRequest hook. */
  clearQuestionHookDue(toolUseId: string): void;
  /** Answering a dialog the CLI drew itself belongs to the screen group. */
  respondScreenDialog(response: NativeInteractionResponse, fingerprint: string): Promise<NativeInteractionResult>;
}

/** Open requests the CLI raised through hooks, and everything that answers, confirms or cancels them. */
export class ClaudeInteractions {
  private readonly pending = new Map<string, PendingInteraction>();
  private readonly permissionToolUses = new Map<string, string>();
  private readonly recentToolUses = new Map<string, string>();
  /** Tool calls by what they ask, as their PreToolUse hook announced them: ahead of the transcript row that holds them. */
  private readonly announcedToolUses = new Map<string, string>();

  constructor(private readonly deps: ClaudeInteractionsDeps) {}

  /** Whether any request is open. */
  hasPending(): boolean { return this.pending.size > 0; }

  /** Whether a request is open whose answer has not been handed to Claude Code yet. */
  hasUndelivered(): boolean { return [...this.pending.values()].some(item => !item.candidate); }

  /** Whether a request whose answer was handed to Claude Code is open under this interaction id. */
  hasDelivered(interactionId: string): boolean { return [...this.pending.values()].some(item => item.candidate && item.interaction.id === interactionId); }

  /** Whether a request is open under this interaction id. */
  has(interactionId: string): boolean { return [...this.pending.values()].some(pending => pending.interaction.id === interactionId); }

  /** The open requests whose answer was handed to Claude Code and not yet confirmed. */
  delivered(): PendingInteraction[] { return [...this.pending.values()].filter(item => item.candidate); }

  /** A PreToolUse hook announced a call: it is found again by what it asks, ahead of the transcript row that holds it. */
  announceToolUse(toolName: string, toolInput: Record<string, unknown>, toolUseId: string): void {
    this.announcedToolUses.set(this.toolFingerprint(toolName, toolInput), toolUseId);
    while (this.announcedToolUses.size > 256) this.announcedToolUses.delete(this.announcedToolUses.keys().next().value!);
  }

  async respond(response: NativeInteractionResponse): Promise<NativeInteractionResult> {
    if (typeof response.requestId !== 'string' || !response.requestId || response.requestId.length > 200 || /[\0\r\n]/.test(response.requestId)) {
      throw new AppError('INVALID_INTERACTION_REQUEST_ID', 'Interaction request id is invalid');
    }
    const fingerprint = createHash('sha256').update(stableJson(response)).digest('hex');
    const previous = this.deps.host.getInteractionReceipt(this.deps.session().id, response.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint || previous.interactionId !== response.interactionId || previous.revision !== response.revision) {
        throw new AppError('NATIVE_INTERACTION_REQUEST_CONFLICT', 'This interaction retry id was already used for a different answer', 409);
      }
      return previous.result;
    }
    if (isClaudeScreenInteraction({ id: response.interactionId })) return this.deps.respondScreenDialog(response, fingerprint);
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
      this.deps.setStatus({ ...this.deps.status(), interaction: pending.interaction });
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
      this.deps.setStatus({ ...this.deps.status(), interaction: pending.interaction });
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
    if (this.deps.status().interaction?.id === pending.interaction.id) {
      this.deps.setStatus({ ...this.deps.status(), interaction: pending.interaction });
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

  saveResponse(response: NativeInteractionResponse, fingerprint: string, result: NativeInteractionResult): void {
    this.deps.host.saveInteractionReceipt(this.deps.session().id, response.requestId, {
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

  async awaitPermission(payload: Record<string, unknown>, deliveryId: string, signal: AbortSignal): Promise<Record<string, unknown>> {
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

  async awaitQuestion(payload: Record<string, unknown>, deliveryId: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    const toolInput = asRecord(payload.tool_input) ?? {};
    const toolUseId = string(payload.tool_use_id) ?? this.announcedToolUses.get(this.toolFingerprint('AskUserQuestion', toolInput));
    if (toolUseId) this.deps.clearQuestionHookDue(toolUseId);
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
        if (this.deps.isDisposed() || this.pending.get(input.nativeRequestId) !== pending) return;
        this.deps.dispatchSignal({ type: 'attention', requestId: input.nativeRequestId, mainThread: pending.mainThread !== false }, { ...this.deps.status(), interaction: pending.interaction });
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
      await this.deps.refreshTranscript().catch(() => undefined);
      // Without a readable transcript there is nothing to wait for.
      if (this.deps.isDisposed() || Date.now() >= deadline || this.deps.transcript().state !== 'ok') return;
      if (toolUseId && this.deps.transcript().hasToolCall(toolUseId)) return;
      await pause(CARD_TAIL_POLL_MS);
    }
  }

  onToolResult(toolUseId: string, failed: boolean): void {
    // A dialog the CLI drew itself ends when the CLI got its answer, wherever that was typed: the
    // transcript says so before the next screen poll would.
    if (isClaudeScreenInteraction(this.deps.status().interaction)) void this.deps.refreshScreenState().catch(() => undefined);
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
  async observeDecision(payload: Record<string, unknown>, decision: Record<string, unknown>): Promise<void> {
    if (!this.deps.observer || payload.tool_name !== 'Bash') return;
    const input = asRecord(payload.tool_input) ?? {};
    const toolId = string(payload.tool_use_id) ?? this.announcedToolUses.get(this.toolFingerprint('Bash', input));
    const behavior = string(asRecord(asRecord(decision.hookSpecificOutput)?.decision)?.behavior);
    if (!toolId || !behavior) return;
    if (behavior === 'deny') this.deps.observer.discard(toolId);
    else if (behavior === 'allow' && input.run_in_background !== true) await this.deps.observer.begin(toolId, string(payload.cwd) ?? this.deps.project.cwd, string(input.command));
  }

  private toolFingerprint(toolName: string, toolInput: Record<string, unknown>): string {
    return createHash('sha256').update(`${toolName}\0${stableJson(toolInput)}`).digest('hex');
  }

  onToolUse(toolUseId: string, toolName: string, toolInput: Record<string, unknown>): void {
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

  confirmHookInteraction(event: 'PostToolUse' | 'PostToolUseFailure' | 'PermissionDenied', payload: Record<string, unknown>): void {
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

  confirmProviderInteraction(pending: PendingInteraction, message: string, status: 'completed' | 'uncertain' = 'completed'): void {
    if (!pending.candidate || pending.providerResult) return;
    const result: NativeInteractionResult = { status, message };
    pending.providerResult = result;
    const saved = this.deps.host.getInteractionReceipt(this.deps.session().id, pending.candidate.webRequestId);
    if (saved) this.deps.host.saveInteractionReceipt(this.deps.session().id, pending.candidate.webRequestId, { ...saved, result });
    for (const resolve of pending.confirmationWaiters) resolve(result);
    pending.confirmationWaiters.clear();
    const displayed = this.deps.status().interaction?.id === pending.interaction.id;
    this.removePendingInteraction(pending, true);
    if (displayed && status === 'uncertain') this.deps.setStatus({ ...this.deps.status(), interaction: undefined, notice: message, noticeLevel: 'warning' });
  }

  /**
   * Closes every open request. A request nobody answered is let go (`{}`: the CLI asks in its own dialog), because the
   * CLI outlives this runtime; only a stop that interrupted the turn refuses it, as the reader's own decision, and with
   * `interrupt` so the refusal itself ends the turn rather than letting Claude carry on without that tool.
   */
  cancelPending(reason: string, answer: 'release' | 'deny' = 'release'): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.candidate) {
        this.confirmProviderInteraction(pending, reason, 'uncertain');
        this.removePendingInteraction(pending, false);
        continue;
      }
      pending.resolveHook(answer === 'deny' ? { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: reason, interrupt: true } } } : {});
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
    const { interaction: _interaction, ...status } = this.deps.status();
    const next = { ...status, ...(returnToBusy ? { notice: undefined, noticeLevel: undefined } : {}), ...(remaining ? { interaction: remaining.interaction } : {}) };
    if (this.deps.status().interaction?.id === pending.interaction.id || this.deps.mainTurn().kind === 'attention') {
      this.deps.dispatchSignal({ type: 'attention', ...(remaining ? { requestId: remaining.nativeRequestId, mainThread: remaining.mainThread !== false } : {}) }, this.deps.status().interaction?.id === pending.interaction.id ? next : this.deps.status());
    }
  }
}
