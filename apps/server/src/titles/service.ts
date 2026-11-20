import type { AuxiliaryModelRef, Run, Session } from '../../../../packages/contracts/src/index.js';
import { auxiliaryEndpoint, type GatewayProfiles } from '../auxiliary/models.js';
import type { CompletionMetrics } from '../auxiliary/gateway.js';
import type { AuxiliaryCallRecorder } from '../auxiliary/telemetry.js';
import { generatedTitlePatch, isPlaceholderTitle, isPromptTitle, TITLE_FROM_AGENT, TITLE_FROM_GENERATED, TITLE_FROM_PROMPT, TITLE_FROM_PROVIDER, titleFromMessage } from '../session-title.js';
import type { Store } from '../store.js';
import { requestTitle, type TitleRequest } from './request.js';

/**
 * How long a start/finished first turn waits before the workbench writes a title itself.
 *
 * Zero: a configured title model names a conversation as soon as its first turn starts running,
 * without waiting for the agent to finish.
 */
const DEFAULT_DELAY_MS = 0;

export interface TitleServiceOptions {
  store: Store;
  /** The configured title model, read on every use so a settings change applies at once. */
  titleModel(): AuxiliaryModelRef | undefined;
  gatewayProfiles: GatewayProfiles;
  /** Whether a 会话标题规则 shows something else in place of the title, so writing one is a call nobody sees. */
  replacedByRule?(session: Session): boolean;
  /** Called after the workbench names a conversation, so a provider that keeps names can follow. */
  onTitled?(session: Session): void;
  delayMs?: number;
  /** How long after startup the backfill pass runs; zero disables it. */
  backfillDelayMs?: number;
  request?: (request: TitleRequest) => Promise<string>;
  record?: AuxiliaryCallRecorder;
}

/**
 * A reader's rename and the title model's answer are final. A CLI's own name and its first-message
 * fallback are still replaceable, including old rows that mistakenly marked that fallback as generated.
 */
function replaceable(session: Pick<Session, 'title' | 'titleSource'>, firstPrompt?: string): boolean {
  if (session.titleSource === TITLE_FROM_PROMPT || session.titleSource === TITLE_FROM_PROVIDER || session.titleSource === TITLE_FROM_AGENT) return true;
  if (session.titleSource === TITLE_FROM_GENERATED) return isPromptTitle(session.title, firstPrompt);
  return session.titleSource === undefined
    && (isPlaceholderTitle(session.title) || (firstPrompt !== undefined && session.title === titleFromMessage(firstPrompt)));
}

/**
 * How long after startup the backfill pass runs. Late enough that opening a conversation, which is
 * what the reader is doing in the first seconds, is never behind a queue of title requests.
 */
const DEFAULT_BACKFILL_DELAY_MS = 20_000;

/**
 * The workbench's own title writer. When the reader configured a title model, its titles take
 * precedence over every CLI's own: Cursor names a conversation in two or three generic words, DSH's
 * is a clipped summary, some CLIs name Chinese conversations in English, and Claude Code does not
 * always write one.
 *
 * It runs once per conversation and only while the conversation still carries its first-message
 * stand-in or a CLI's name — so a rename simply makes it a no-op.
 * Two paths reach it: a first turn completing now, and one backfill pass at startup for the
 * conversations whose first turn finished before a title model was ever configured.
 */
export class TitleService {
  private readonly attempted = new Set<string>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly unsubscribe: () => void;
  private readonly abortController = new AbortController();
  private closed = false;

  constructor(private readonly options: TitleServiceOptions) {
    this.unsubscribe = options.store.onRunChanged(run => this.onRun(run));
  }

  /**
   * Names the conversations that finished their first turn while no title model was configured.
   *
   * `onRunChanged` only fires for a turn completing now, so every conversation that predates the
   * setting — or the feature — keeps its first-message stand-in forever, however many models are
   * configured afterwards. One pass at startup is what makes choosing a model apply to the list the
   * reader is actually looking at, instead of only to whatever they send next.
   *
   * Newest first, because that is the end of the list anyone reads, and one at a time: this is
   * backfill, and it must never compete with the turn in front of the reader.
   */
  start(): void {
    if (this.closed) return;
    const delayMs = this.options.backfillDelayMs ?? DEFAULT_BACKFILL_DELAY_MS;
    if (delayMs <= 0) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.backfill().catch(() => undefined);
    }, delayMs);
    timer.unref?.();
    this.timers.add(timer);
  }

  /** One backfill pass; resolves to the conversations renamed. */
  async backfill(): Promise<number> {
    if (this.closed || !this.options.titleModel()) return 0;
    const { store } = this.options;
    let named = 0;
    for (const session of store.listSessions()) {
      if (this.closed || !this.options.titleModel()) break;
      if (session.kind !== 'native' || session.archivedAt || this.attempted.has(session.id)) continue;
      const runs = store.listRuns(session.id);
      // A conversation still waiting on its first answer belongs to `onRun`, which will see it.
      if (!runs.some(run => run.state === 'completed')) continue;
      const firstPrompt = store.firstUserMessage(session.id);
      if (typeof firstPrompt !== 'string' || !replaceable(session, firstPrompt) || this.options.replacedByRule?.(session)) continue;
      this.attempted.add(session.id);
      if (await this.name(session.id, firstPrompt).catch(() => { this.attempted.delete(session.id); return undefined; })) named++;
    }
    return named;
  }

  /** Writes a title for `message` with `ref` without touching any conversation; for trying a model out. */
  async preview(ref: AuxiliaryModelRef, message: string, signal?: AbortSignal): Promise<string> {
    this.assertOpen();
    return (await this.ask(ref, message, undefined, signal)).title;
  }

  close(): void {
    this.closed = true;
    this.unsubscribe();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.abortController.abort();
  }

  private onRun(run: Run): void {
    if ((run.state !== 'running' && run.state !== 'completed') || this.closed || this.attempted.has(run.sessionId) || !this.options.titleModel()) return;
    const { store } = this.options;
    let session: Session;
    try { session = store.getSession(run.sessionId); } catch { return; }
    // A discussion's seats are named by it.
    if (session.kind !== 'native' || session.archivedAt || session.origin?.kind === 'council') return;
    const runs = store.listRuns(session.id);
    if (run.state === 'completed' && !runs.some(item => item.state === 'completed')) return;
    const firstPrompt = store.firstUserMessage(session.id) ?? (!session.resumePicker ? runs[0]?.prompt : undefined);
    if (typeof firstPrompt !== 'string' || !firstPrompt.trim() || !replaceable(session, firstPrompt) || this.options.replacedByRule?.(session)) return;
    this.attempted.add(session.id);
    const delayMs = this.options.delayMs ?? DEFAULT_DELAY_MS;
    if (delayMs <= 0) {
      void this.name(session.id, firstPrompt).catch(() => { this.attempted.delete(session.id); });
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.name(session.id, firstPrompt).catch(() => { this.attempted.delete(session.id); });
    }, delayMs);
    timer.unref?.();
    this.timers.add(timer);
  }

  /** Names one conversation from its first message. Resolves to the renamed session, if it was renamed. */
  async name(sessionId: string, message: string): Promise<Session | undefined> {
    if (this.closed) return undefined;
    const ref = this.options.titleModel();
    const { store } = this.options;
    const pending = () => {
      if (this.closed) return undefined;
      const session = store.getSession(sessionId);
      return !session.archivedAt && replaceable(session, message) ? session : undefined;
    };
    if (!ref || !pending()) return undefined;
    const result = await this.ask(ref, message, store.firstIndexedText(sessionId, 'assistant'), undefined, true);
    // Re-read: the CLI may have named it, or the reader renamed or archived it, while the model was answering.
    const current = pending();
    const patch = current && generatedTitlePatch(current, result.title, message);
    if (!patch) {
      this.options.record?.({
        kind: 'title', preset: 'short', source: 'live',
        backendId: ref.backendId, profileId: ref.profileId, model: ref.model,
        transport: result.transport, protocol: result.protocol,
        ok: false, authMs: result.authMs, ttftMs: result.ttftMs, durationMs: result.durationMs,
        inputTokens: result.inputTokens ?? null, outputTokens: result.outputTokens ?? null,
        reasoningTokens: result.reasoningTokens ?? null, reasoningChars: result.reasoningChars,
        thinkingDetected: result.thinkingDetected, streaming: false,
        errorCode: current ? 'SKIPPED_RULE' : 'SKIPPED_RENAMED',
        detail: result.title,
      });
      return undefined;
    }
    this.options.record?.({
      kind: 'title', preset: 'short', source: 'live',
      backendId: ref.backendId, profileId: ref.profileId, model: ref.model,
      transport: result.transport, protocol: result.protocol,
      ok: true, authMs: result.authMs, ttftMs: result.ttftMs, durationMs: result.durationMs,
      inputTokens: result.inputTokens ?? null, outputTokens: result.outputTokens ?? null,
      reasoningTokens: result.reasoningTokens ?? null, reasoningChars: result.reasoningChars,
      thinkingDetected: result.thinkingDetected, streaming: false,
      detail: patch.title,
    });
    const session = store.updateSession(sessionId, patch);
    store.appendEvent(sessionId, 'session', { session });
    try { this.options.onTitled?.(session); } catch { /* the title is already saved */ }
    return session;
  }

  private async ask(
    ref: AuxiliaryModelRef,
    message: string,
    reply?: string,
    signal?: AbortSignal,
    deferRecord = false,
  ): Promise<{
    title: string;
    transport: 'http' | 'cli-process';
    protocol: import('../auxiliary/gateway.js').GatewayProtocol;
    authMs: number;
    ttftMs: number | null;
    durationMs: number;
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    reasoningChars: number;
    thinkingDetected: boolean;
  }> {
    this.assertOpen();
    const combinedSignal = signal ? AbortSignal.any([this.abortController.signal, signal]) : this.abortController.signal;
    const authStartedAt = Date.now();
    const { profileName: _name, ...endpoint } = await auxiliaryEndpoint(ref, this.options.gatewayProfiles, combinedSignal);
    const authMs = Math.max(0, Date.now() - authStartedAt);
    const transport: 'http' | 'cli-process' = (endpoint.executeComplete || endpoint.executeStreamChat) ? 'cli-process' : 'http';
    let metrics: CompletionMetrics | undefined;
    const startedAt = Date.now();
    try {
      const title = await (this.options.request ?? requestTitle)({
        ...endpoint,
        message,
        ...(reply ? { reply } : {}),
        signal: combinedSignal,
        onMetrics: recorded => { metrics = recorded; },
      });
      return {
        title,
        transport,
        protocol: endpoint.protocol,
        authMs,
        ttftMs: metrics?.ttftMs ?? null,
        durationMs: metrics?.durationMs ?? Math.max(0, Date.now() - startedAt),
        ...(metrics?.inputTokens !== undefined ? { inputTokens: metrics.inputTokens } : {}),
        ...(metrics?.outputTokens !== undefined ? { outputTokens: metrics.outputTokens } : {}),
        ...(metrics?.reasoningTokens !== undefined ? { reasoningTokens: metrics.reasoningTokens } : {}),
        reasoningChars: metrics?.reasoningChars ?? 0,
        thinkingDetected: metrics?.thinkingDetected ?? false,
      };
    } catch (error) {
      if (deferRecord && !combinedSignal.aborted) {
        this.options.record?.({
          kind: 'title', preset: 'short', source: 'live',
          backendId: ref.backendId, profileId: ref.profileId, model: ref.model,
          transport,
          protocol: endpoint.protocol,
          ok: false, authMs, ttftMs: metrics?.ttftMs ?? null,
          durationMs: metrics?.durationMs ?? Math.max(0, Date.now() - startedAt),
          inputTokens: metrics?.inputTokens ?? null, outputTokens: metrics?.outputTokens ?? null,
          reasoningTokens: metrics?.reasoningTokens ?? null, reasoningChars: metrics?.reasoningChars ?? 0,
          thinkingDetected: metrics?.thinkingDetected ?? false, streaming: metrics?.streaming ?? false,
          errorCode: metrics?.errorCode ?? 'ERROR',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('title service is closed');
  }
}
