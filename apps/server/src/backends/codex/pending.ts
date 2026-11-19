import type {
  NativeInteraction, NativeInteractionResponse, NativeInteractionResult, NativeStatus, NativeStreamMessage,
} from '../../../../../packages/contracts/src/index.js';
import { NO_SERVER_RESPONSE, type JsonRpcServerRequest } from '../shared/codex-app-server.js';
import { AppError } from '../../errors.js';
import type { NativeBackendHost, NativeBackendProfileConfig, NativeInteractionReceipt } from '../types.js';
import type { CodexConnection } from './connection.js';
import type { CodexFlavor } from './flavors.js';
import {
  makePendingInteraction, commandApprovalDecision, questionInteraction, answerValues, elicitationContent, interactionFingerprint, asyncQuestionsOf, asyncQuestionInteraction,
  asyncAnswerText, modeChangeInteraction, asyncQuestionReply, isAsyncQuestionInteraction, type CodexAsyncQuestion,
} from './interactions.js';
import { CodexQuestionHistory } from './question-history.js';
import { safeProviderError } from './errors.js';
import { ANSWER_CONFIRM_MS } from './runtime-limits.js';
import type { CodexPendingInteraction, RpcItem, RpcQuestion } from './types.js';
import { requestIdString, str, asArray, asRecord } from './util.js';

/** What `CodexInteractions` needs from the runtime that owns it. */
export interface CodexInteractionsContext {
  readonly host: NativeBackendHost;
  readonly profile: NativeBackendProfileConfig;
  readonly flavor: CodexFlavor;
  session(): { id: string };
  threadId(): string | undefined;
  activeTurnId(): string | undefined;
  status(): NativeStatus;
  modeObservation(): number;
  emit(message: NativeStreamMessage): void;
  /** Interrupts a turn of this thread or of a child's, as an answer of "cancel" does. */
  interrupt(turnId: string | undefined, threadId: string | undefined): Promise<void>;
  /** The id a request carries in this runtime's tables: a child thread's request ids are scoped by its thread. */
  scopedRequestId(threadId: string | undefined, id: string): string;
  /** Recomputes the published status after the interactions changed. */
  refreshStatus(): void;
  /** A request is waiting: the link is live, and a notice that held until now no longer does. */
  requestRaised(): void;
  /** A request ended; `notice` says why when the reader should be told. */
  requestSettled(notice?: string): void;
  /** The thread's own tables take over a native mode change (`runtime.ts#adoptMode`) or read the settings back. */
  adoptMode(mode: string | undefined): void;
  reconcileMode(threadId: string): void;
  latestPlanText(turnId: string | undefined, threadId: string | undefined): string | undefined;
  /** Writes the answered question into the thread's log. */
  projectAnswered(item: RpcItem, turnId: string): void;
  /** Tells the journal's reader about a question, including a child's, which its own question tracker needs. */
  forwardQuestion(method: string, params: Record<string, unknown>): void;
  /** Writes the question a turn asked into the log, ahead of its answer. */
  projectQuestion(item: RpcItem, turnId: string): void;
  requestWaitStarted(turnId: string, requestId: string): void;
  requestWaitEnded(turnId: string, requestId: string): void;
}

/**
 * What the app-server is waiting on the reader for: approvals, questions, MCP elicitations, the
 * questions a turn asked without blocking, and TRAE's mode-change requests. Also the answer to
 * each, with the receipt that makes a retried answer idempotent.
 *
 * It owns the blocking requests by id, the one the card shows, the async questions and the
 * ones already seen, the answers in flight, the question history, and the mode-change bookkeeping.
 *
 * It does not own the status: after a change it asks the runtime to recompute it (`refreshStatus`),
 * and the runtime reads `interaction` and `current` to derive the phase. It does not own the
 * connection or the turn either: an answer goes out on the connection, and an interrupt goes through the runtime.
 */
export class CodexInteractions {
  /** The blocking request the card shows; the others wait behind it in `pending`. */
  private interaction: NativeInteraction | undefined;
  private readonly pending = new Map<string, CodexPendingInteraction>();
  /** Questions the running turn asked without waiting; shown after any blocking request. */
  private asyncQuestions: CodexAsyncQuestion[] = [];
  private readonly seenAsyncItems = new Set<string>();
  private readonly sendingAsyncAnswers = new Set<string>();
  readonly questionHistory = new CodexQuestionHistory();
  private readonly modeRequests = new WeakMap<CodexPendingInteraction, { observation: number; decision?: string }>();

  constructor(private readonly ctx: CodexInteractionsContext, private readonly connection: CodexConnection) {}

  private get label(): string { return this.ctx.flavor.label; }

  /** The blocking request that holds the turn, if any. */
  get blocking(): NativeInteraction | undefined { return this.interaction; }

  /** Nothing is waiting on a reader, so a quick read of the thread has no one to serve. */
  get idle(): boolean { return this.pending.size === 0 && this.asyncQuestions.length === 0; }

  /** A blocking request from the app-server, held until a reader answers it or the provider settles it. */
  async raise(request: JsonRpcServerRequest, requestId: string, threadId: string | undefined, main: boolean): Promise<unknown> {
    const requestedTurnId = str(request.params.turnId);
    const pending = makePendingInteraction(request);
    if (!pending) throw new Error(`${this.label} request ${request.method} is not supported by the workbench.`);
    pending.interaction.requestId = requestId;
    if (main && requestedTurnId) this.ctx.requestWaitStarted(requestedTurnId, requestId);
    this.pending.set(requestId, pending);
    if (request.method === 'item/tool/requestUserInput') {
      const question = this.questionHistory.request(request.params, threadId);
      this.ctx.forwardQuestion(request.method, { ...request.params, threadId });
      if (main && requestedTurnId && question) this.ctx.projectQuestion(question, requestedTurnId);
    }
    this.interaction = pending.interaction;
    this.ctx.requestRaised();
    return await new Promise(resolve => {
      // A server request remains pending until a web answer or the shared TUI resolves it.
      // This promise is intentionally settled by respond() or the protocol's resolved notice.
      pending.resolve = resolve;
    });
  }

  /** The app-server's socket is gone: its requests can no longer be answered, so each is released unanswered. */
  abandon(): void {
    for (const pending of this.pending.values()) pending.resolve?.(NO_SERVER_RESPONSE);
    this.pending.clear();
    this.interaction = undefined;
  }

  /** The runtime ends: as `abandon`, and the async questions go too. */
  close(): void {
    this.abandon();
    this.asyncQuestions = [];
  }

  /** A new message supersedes the questions still open, as a TUI submission does. */
  supersedeAsyncQuestions(): void {
    this.asyncQuestions = [];
  }

  async respond(response: NativeInteractionResponse): Promise<NativeInteractionResult> {
    if (typeof response.requestId !== 'string' || !response.requestId || response.requestId.length > 200 || /[\0\r\n]/.test(response.requestId)) {
      throw new AppError('INVALID_INTERACTION_REQUEST_ID', 'Interaction request id is invalid', 400);
    }
    const fingerprint = interactionFingerprint(response);
    const previous = this.ctx.host.getInteractionReceipt(this.ctx.session().id, response.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint || previous.interactionId !== response.interactionId || previous.revision !== response.revision) {
        throw new AppError('NATIVE_INTERACTION_REQUEST_CONFLICT', 'This interaction retry id was already used for a different answer', 409);
      }
      return previous.result;
    }
    const asked = this.asyncQuestions.find(question => asyncQuestionInteraction(question, this.label).id === response.interactionId);
    if (asked) return await this.answerAsyncQuestion(asked, response, fingerprint);
    if (isAsyncQuestionInteraction({ id: response.interactionId } as NativeInteraction)) {
      return { status: 'uncertain', message: `${this.label} no longer has this question pending.` };
    }
    const current = this.interaction;
    if (!current || current.id !== response.interactionId || current.revision !== response.revision) {
      return { status: 'uncertain', message: `The ${this.label} request changed before the answer was submitted.` };
    }
    const id = current.requestId;
    if (!id) return { status: 'uncertain', message: `The ${this.label} request has no native request id.` };
    const pending = this.pending.get(id);
    if (!pending) return { status: 'uncertain', message: `${this.label} no longer has this request pending.` };
    if (!current.actions.some(action => action.id === response.action)) {
      throw new AppError('INVALID_NATIVE_INTERACTION', `The selected action is not available for this ${this.label} request`, 400);
    }
    if (pending.candidateSent) {
      // A fresh retry key is not a license to journal an invalid candidate. Validate against the
      // still-current request before writing its uncertain receipt; never submit a second choice.
      if (pending.request.method === 'item/tool/requestUserInput' && response.action !== 'cancel') {
        const question = asArray<RpcQuestion>(pending.request.params.questions)[pending.currentQuestion];
        if (!question) throw new AppError('INVALID_NATIVE_INTERACTION', `The ${this.label} question is no longer available.`, 400);
        answerValues(question, response);
      } else if (pending.request.method === 'mcpServer/elicitation/request'
        && (response.action === 'answer' || response.action === 'accept')) {
        elicitationContent(pending.request.params.requestedSchema, response);
      }
      const result = { status: 'uncertain' as const, message: `${this.label} is still resolving this answer.` };
      this.saveInteractionResponse(response, fingerprint, result);
      return result;
    }
    const method = pending.request.method;
    let result: Record<string, unknown>;
    if (method === 'item/tool/requestUserInput') {
      if (response.action === 'cancel') {
        const cancellation = { status: 'uncertain' as const, message: `The ${this.label} turn is being interrupted.` };
        this.saveInteractionResponse(response, fingerprint, cancellation);
        await this.ctx.interrupt(str(pending.request.params.turnId), str(pending.request.params.threadId));
        return cancellation;
      }
      const questions = asArray<RpcQuestion>(pending.request.params.questions);
      const question = questions[pending.currentQuestion];
      if (!question) return { status: 'uncertain', message: `The ${this.label} question is no longer available.` };
      const answer = answerValues(question, response);
      if (pending.currentQuestion + 1 < questions.length) {
        const answers = { ...pending.answers, [question.id ?? String(pending.currentQuestion)]: { answers: answer } };
        const nextIndex = pending.currentQuestion + 1;
        const nextRevision = `${pending.request.id}:${pending.revisionCounter + 1}`;
        const nextInteraction = questionInteraction(pending.request, questions[nextIndex]!, nextIndex, questions.length, nextRevision, pending.interaction.id);
        nextInteraction.requestId = id;
        const advanced = { status: 'advanced' as const, interaction: nextInteraction };
        this.saveInteractionResponse(response, fingerprint, advanced);
        pending.answers = answers;
        pending.currentQuestion += 1;
        pending.revisionCounter += 1;
        pending.interaction = nextInteraction;
        this.interaction = pending.interaction;
        this.ctx.emit({ type: 'status', status: { ...this.ctx.status(), phase: 'attention', interaction: this.interaction } });
        return advanced;
      }
      pending.answers[question.id ?? String(pending.currentQuestion)] = { answers: answer };
      result = { answers: pending.answers };
    } else if (method === 'mcpServer/elicitation/request') {
      const mode = str(pending.request.params.mode);
      if (response.action !== 'answer' && response.action !== 'accept') result = { action: response.action === 'cancel' ? 'cancel' : 'decline', content: null, _meta: null };
      else {
        if (mode === 'url') {
          const unsupported = { status: 'uncertain' as const, message: `This ${this.label} URL request cannot be answered from the current web form.` };
          this.saveInteractionResponse(response, fingerprint, unsupported);
          return unsupported;
        }
        const content = elicitationContent(pending.request.params.requestedSchema, response);
        result = { action: 'accept', content, _meta: null };
      }
    } else if (method === 'item/permissions/requestApproval') {
      const permissions = Object.fromEntries(Object.entries(asRecord(pending.request.params.permissions) ?? {}).filter(([, value]) => value != null));
      result = response.action === 'approve' || response.action === 'approveForSession'
        ? { permissions, scope: response.action === 'approveForSession' ? 'session' : 'turn' }
        : { permissions: {}, scope: 'turn' };
    } else if (method === 'item/commandExecution/requestApproval') {
      result = { decision: commandApprovalDecision(pending.request, response.action) };
    } else if (method === 'item/fileChange/requestApproval') {
      const decision = response.action === 'approveForSession' ? 'acceptForSession'
        : response.action === 'approve' ? 'accept' : response.action === 'cancel' ? 'cancel' : 'decline';
      result = { decision };
    } else if (method === 'mode/changeRequested') {
      // Answered through its own request rather than a server-request reply; resolved by `mode/changeResolved`.
      const decision = response.action === 'approve' ? 'approved' : response.action === 'cancel' ? 'cancelled' : 'rejected';
      const modeRequest = this.modeRequests.get(pending);
      if (modeRequest) {
        // Settings before the choice is actually submitted are its baseline, not a later native
        // override. A model-only update carrying the same Plan mode must not defeat approval.
        modeRequest.observation = this.ctx.modeObservation();
        modeRequest.decision = decision;
      }
      const candidate = { status: 'uncertain' as const, message: `Answer sent; ${this.label} is resolving it.` };
      this.saveInteractionResponse(response, fingerprint, candidate);
      pending.candidateResponse = { requestId: response.requestId, fingerprint };
      pending.candidateSent = true;
      try {
        await this.connection.requireTransport().request('mode/change/respond', {
          threadId: str(pending.request.params.threadId) ?? this.ctx.threadId(),
          requestId: str(pending.request.params.requestId),
          decision,
        });
      } catch (error) {
        // A resolved notification may win the race with an RPC error. Its durable receipt is
        // stronger than that error; a missing pending request is terminal, not permission denied.
        const receipt = this.candidateReceipt(pending);
        if (receipt && (receipt.result.status === 'completed' || this.pending.get(id) !== pending)) return receipt.result;
        // Only a protocol rejection proves the choice was not accepted. A timeout/disconnect
        // leaves it uncertain, so a fresh card must not send a second choice under a new key.
        const rpcCode = (error as { rpcCode?: number })?.rpcCode;
        if (typeof rpcCode === 'number') pending.candidateSent = false;
        const expired = rpcCode === -32600
          && /No pending mode change found for request_id:/i.test(error instanceof Error ? error.message : '');
        const failed = { status: 'uncertain' as const, message: expired
          ? `This ${this.label} mode request has expired; no choice was confirmed. Request a new mode change in the native terminal.`
          : safeProviderError(error, this.ctx.profile.config) };
        this.saveInteractionResponse(response, fingerprint, failed);
        if (expired) this.releaseModeChange(id, pending, failed.message);
        return failed;
      }
      return await this.confirmAnswer(pending, candidate);
    } else if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
      const decision = response.action === 'approveForSession' ? 'approved_for_session'
        : response.action === 'approve' ? 'approved'
          : response.action === 'cancel' ? 'abort' : { denied: { rejection: 'Rejected from the workbench.' } };
      result = { decision };
    } else {
      return { status: 'uncertain', message: `This ${this.label} request type is not supported by the web controls.` };
    }
    const candidate = { status: 'uncertain' as const, message: `Answer sent; ${this.label} is resolving it.` };
    this.saveInteractionResponse(response, fingerprint, candidate);
    pending.candidateResponse = { requestId: response.requestId, fingerprint };
    pending.candidateSent = true;
    const confirmed = this.confirmAnswer(pending, candidate);
    pending.resolve?.(result);
    return await confirmed;
  }

  /**
   * Like Claude's acknowledgement wait: the reply has gone out on this socket, and the provider says
   * `serverRequest/resolved` (or `mode/changeResolved`) right after it. Waiting that moment lets the
   * card close as answered instead of lingering as unconfirmed with sync controls.
   */
  private async confirmAnswer(pending: CodexPendingInteraction, candidate: NativeInteractionResult): Promise<NativeInteractionResult> {
    // A mode-change notification can arrive before its RPC reply. The durable receipt then already
    // contains the confirmation, before this waiter has had a chance to subscribe.
    const receipt = this.candidateReceipt(pending);
    if (receipt && (receipt.result.status === 'completed' || this.pending.get(pending.interaction.requestId ?? String(pending.request.id)) !== pending)) return receipt.result;
    const settled = await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), ANSWER_CONFIRM_MS);
      timer.unref();
      pending.onSettled = () => { clearTimeout(timer); resolve(true); };
    });
    pending.onSettled = undefined;
    return settled ? this.candidateReceipt(pending)?.result ?? candidate : candidate;
  }

  private candidateReceipt(pending: CodexPendingInteraction): NativeInteractionReceipt | undefined {
    const sent = pending.candidateResponse;
    const receipt = sent ? this.ctx.host.getInteractionReceipt(this.ctx.session().id, sent.requestId) : undefined;
    return receipt?.fingerprint === sent?.fingerprint ? receipt : undefined;
  }

  /** Whether a blocking request with this interaction id is waiting on this runtime's own live socket. */
  holdsInteraction(interactionId: string): boolean {
    if (!this.connection.transport?.isOnline) return false;
    for (const pending of this.pending.values()) {
      if (pending.interaction.id === interactionId) return true;
    }
    return false;
  }

  /** What the card shows: a blocking request first, then the oldest unanswered async question. */
  get current(): NativeInteraction | undefined {
    return this.interaction ?? this.asyncInteraction();
  }

  private asyncInteraction(): NativeInteraction | undefined {
    const next = this.asyncQuestions[0];
    return next ? asyncQuestionInteraction(next, this.label) : undefined;
  }

  /** A blocking request's interaction is the caller's to set; otherwise the pending async question rides along. */
  withAsyncQuestion(status: NativeStatus): NativeStatus {
    const { interaction, ...rest } = status;
    const shown = interaction && !isAsyncQuestionInteraction(interaction) ? interaction : this.asyncInteraction();
    return shown ? { ...rest, interaction: shown } : rest;
  }

  noteAsyncQuestions(item: RpcItem, turnId: string): void {
    const itemId = str(item.id);
    if (!itemId || this.seenAsyncItems.has(itemId)) return;
    const questions = asyncQuestionsOf(item as Record<string, unknown>, turnId);
    if (!questions.length) return;
    this.seenAsyncItems.add(itemId);
    if (this.seenAsyncItems.size > 256) this.seenAsyncItems.delete(this.seenAsyncItems.values().next().value!);
    this.asyncQuestions.push(...questions);
    this.ctx.refreshStatus();
  }

  dropAsyncQuestions(drop: (question: CodexAsyncQuestion) => boolean): void {
    const kept = this.asyncQuestions.filter(question => !drop(question));
    if (kept.length === this.asyncQuestions.length) return;
    this.asyncQuestions = kept;
    this.ctx.refreshStatus();
  }

  private async answerAsyncQuestion(question: CodexAsyncQuestion, response: NativeInteractionResponse, fingerprint: string): Promise<NativeInteractionResult> {
    const settle = (result: NativeInteractionResult) => { this.saveInteractionResponse(response, fingerprint, result); return result; };
    const next = (): NativeInteractionResult => {
      const interaction = this.current;
      return interaction ? { status: 'advanced', interaction } : { status: 'completed' };
    };
    if (response.action === 'skip') {
      this.dropAsyncQuestions(entry => entry.itemId === question.itemId);
      return settle(next());
    }
    if (response.action !== 'answer') throw new AppError('INVALID_NATIVE_INTERACTION', `The selected action is not available for this ${this.label} question`, 400);
    const answer = asyncAnswerText(question, response);
    if (!answer) throw new AppError('INVALID_NATIVE_INTERACTION', 'Choose an option or type an answer', 400);
    if (!this.ctx.threadId() || this.ctx.activeTurnId() !== question.turnId) {
      this.dropAsyncQuestions(entry => entry.turnId === question.turnId);
      return { status: 'uncertain', message: `The ${this.label} turn that asked this has ended; send the answer as a message.` };
    }
    if (this.sendingAsyncAnswers.has(question.questionItemId)) return { status: 'uncertain', message: `${this.label} is still receiving this answer.` };
    this.sendingAsyncAnswers.add(question.questionItemId);
    try {
      await this.connection.requireTransport().request('turn/steer', {
        threadId: this.ctx.threadId(),
        input: [{ type: 'text', text: asyncQuestionReply(question, answer), text_elements: [] }],
        expectedTurnId: question.turnId,
      });
    } catch (error) {
      return { status: 'uncertain', message: safeProviderError(error, this.ctx.profile.config) };
    } finally {
      this.sendingAsyncAnswers.delete(question.questionItemId);
    }
    this.dropAsyncQuestions(entry => entry.questionItemId === question.questionItemId);
    return settle(next());
  }

  private saveInteractionResponse(response: NativeInteractionResponse, fingerprint: string, result: NativeInteractionResult): void {
    const previous = this.ctx.host.getInteractionReceipt(this.ctx.session().id, response.requestId);
    const receipt: NativeInteractionReceipt = {
      fingerprint,
      interactionId: response.interactionId,
      revision: response.revision,
      result,
      createdAt: previous?.createdAt ?? new Date().toISOString(),
    };
    this.ctx.host.saveInteractionReceipt(this.ctx.session().id, response.requestId, receipt);
  }

  private resolveCandidateReceipt(pending: CodexPendingInteraction, result: NativeInteractionResult = { status: 'completed', message: `${this.label} resolved the native request.` }): void {
    pending.onSettled?.();
    const candidate = pending.candidateResponse;
    if (!candidate) return;
    const previous = this.ctx.host.getInteractionReceipt(this.ctx.session().id, candidate.requestId);
    if (!previous || previous.fingerprint !== candidate.fingerprint) return;
    this.ctx.host.saveInteractionReceipt(this.ctx.session().id, candidate.requestId, {
      ...previous,
      result,
    });
  }

  settleRequest(params: Record<string, unknown>): void {
    const nativeRequestId = requestIdString(params.requestId);
    if (!nativeRequestId) return;
    const threadId = str(params.threadId) ?? this.ctx.threadId();
    const requestId = this.ctx.scopedRequestId(threadId, nativeRequestId);
    const pending = this.pending.get(requestId);
    if (!pending || (str(pending.request.params.threadId) ?? this.ctx.threadId()) !== threadId) return;
    this.pending.delete(requestId);
    if (pending) this.resolveCandidateReceipt(pending);
    const turnId = pending && str(pending.request.params.turnId);
    const main = threadId === this.ctx.threadId();
    if (main && pending && turnId) {
      const answered = this.questionHistory.answered(pending);
      if (answered) {
        this.ctx.projectAnswered(answered, turnId);
      }
    }
    if (main && turnId) this.ctx.requestWaitEnded(turnId, requestId);
    if (pending) pending.resolve?.(NO_SERVER_RESPONSE);
    if (pending && this.interaction?.requestId === requestId) this.interaction = this.pending.values().next().value?.interaction;
    this.ctx.requestSettled();
  }

  clearTurnInteractions(turnId: string, threadId = this.ctx.threadId()): void {
    // Like the TUI: a finished turn no longer waits on its questions; a later message answers them.
    if (threadId === this.ctx.threadId()) this.asyncQuestions = this.asyncQuestions.filter(question => question.turnId !== turnId);
    let changed = false;
    for (const [id, pending] of this.pending) {
      if (str(pending.request.params.turnId) !== turnId
        || (str(pending.request.params.threadId) ?? this.ctx.threadId()) !== threadId) continue;
      this.pending.delete(id);
      if (pending.request.method === 'mode/changeRequested') {
        this.modeRequests.delete(pending);
        this.resolveCandidateReceipt(pending, { status: 'uncertain', message: `${this.label} turn ended without confirming the mode decision.` });
      } else this.resolveCandidateReceipt(pending);
      pending.resolve?.(NO_SERVER_RESPONSE);
      changed = true;
    }
    if (!changed) return;
    const currentId = this.interaction?.requestId;
    if (currentId && !this.pending.has(currentId)) this.interaction = this.pending.values().next().value?.interaction;
  }

  /**
   * TRAE CLI asks to switch collaboration mode with a notification, not a server request, and takes
   * the answer through `mode/change/respond`. It is still one decision for the reader, so it waits
   * in the same pending map as approvals and is settled by `mode/changeResolved`.
   */
  raiseModeChange(params: Record<string, unknown>): void {
    const requestId = str(params.requestId);
    if (!requestId) return;
    const key = this.ctx.scopedRequestId(str(params.threadId), `mode:${requestId}`);
    if (this.pending.has(key)) return;
    const targetMode = str(params.targetMode);
    const supported = this.ctx.flavor.modes.some(mode => mode.id === targetMode);
    const leavingPlan = targetMode === 'default';
    const plan = leavingPlan ? this.ctx.latestPlanText(str(params.turnId), str(params.threadId)) : undefined;
    const interaction = modeChangeInteraction(this.ctx.flavor.id, key, params, supported, leavingPlan, plan);
    const pending: CodexPendingInteraction = { request: { id: key, method: 'mode/changeRequested', params }, interaction, currentQuestion: 0, revisionCounter: 0, answers: {}, candidateSent: false };
    this.modeRequests.set(pending, { observation: this.ctx.modeObservation() });
    this.pending.set(key, pending);
    this.interaction = interaction;
    this.ctx.requestRaised();
  }

  settleModeChange(params: Record<string, unknown>): void {
    const requestId = str(params.requestId);
    if (!requestId) return;
    const key = this.ctx.scopedRequestId(str(params.threadId), `mode:${requestId}`);
    const pending = this.pending.get(key);
    if (!pending || pending.request.method !== 'mode/changeRequested') return;
    const decision = str(params.decision);
    if (str(params.threadId) !== str(pending.request.params.threadId)
      || str(params.turnId) !== str(pending.request.params.turnId)
      || str(params.targetMode) !== str(pending.request.params.targetMode)
      || !decision || !['approved', 'rejected', 'cancelled'].includes(decision)) return;
    const observed = this.modeRequests.get(pending);
    if (decision === 'approved' && str(params.threadId) === this.ctx.threadId()) {
      if (observed?.observation === this.ctx.modeObservation()) this.ctx.adoptMode(str(params.targetMode));
      else {
        // These RPCs/events have no provider revision. A settings event received after our
        // candidate may be from before or after the actual native mode application: counting
        // observations cannot tell. Read current settings instead of guessing the winner.
        const threadId = str(params.threadId);
        if (threadId) {
          this.ctx.reconcileMode(threadId);
        }
      }
    }
    if (pending.candidateResponse && observed?.decision !== decision) {
      this.resolveCandidateReceipt(pending, { status: 'uncertain', message: `${this.label} resolved this request as ${decision}; the submitted choice was not confirmed.` });
    } else this.resolveCandidateReceipt(pending);
    this.releaseModeChange(key, pending);
  }

  private releaseModeChange(key: string, pending: CodexPendingInteraction, notice?: string): void {
    if (this.pending.get(key) !== pending) return;
    this.pending.delete(key);
    this.modeRequests.delete(pending);
    if (this.interaction?.requestId === key) this.interaction = this.pending.values().next().value?.interaction;
    this.ctx.requestSettled(notice);
  }
}
