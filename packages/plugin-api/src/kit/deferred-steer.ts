import { createHash, randomBytes } from 'node:crypto';
import { type NativeBackendId, type NativeRunConfig, type NativeTurnTarget, type NativeWorkbenchEvent, type Run } from '@riffet/contracts';
import { AppError } from './errors.js';

const MAX_CONTEXT = 8_000;
const OPEN = '<riffet-steer v="1" data="';
const CLOSE = '</riffet-steer>';
const CARRIER = /<riffet-steer v="1" data="([A-Za-z0-9_-]{1,4096})">\n([\s\S]*?)\n<\/riffet-steer>/g;
type Outcome = { type: 'run_completed' | 'run_failed' | 'run_cancelled'; error?: string; reason?: string };
/** The binding a steer commits with its dispatch fence; the core's `NativeDispatchBinding` fits it. */
export interface SteerBinding {
  backendId?: NativeBackendId;
  nativeSessionId?: string;
  nativeTurnId?: string;
  ownerRunId?: string;
  terminalId?: string;
  terminalEpoch?: number;
  baselineSequence?: number;
  renderedText?: string;
  nativeInputBoundary?: string;
  slashCommand?: boolean;
  resolvedConfig?: NativeRunConfig;
}
/** What a deferred steer reads of a send request (the core's `NativeBackendSendRequest` fits it). */
export interface SteerRequest {
  runId: string;
  commandId: string;
  target: NativeTurnTarget;
  commitDispatchFence(binding?: SteerBinding): unknown;
}
/** What it needs of the host (the core's `NativeBackendHost` fits it). */
export interface SteerHost {
  getSession(sessionId: string): { nativeSessionId?: string };
  emitEvent(sessionId: string, event: NativeWorkbenchEvent): void;
  findRunsByNativeTurn?(sessionId: string, nativeSessionId: string, turnId: string): Run[];
}
export interface SteerContext {
  backendId: NativeBackendId;
  sessionId: string;
  target: NativeTurnTarget;
  commandId: string;
  text: string;
  carrier: string;
}

/** Parse only our bounded carrier. A marker alone is never receipt evidence: the persisted fence must match too. */
export function parseSteerContexts(text: string): SteerContext[] {
  if (!text.includes(OPEN)) return [];
  const results: SteerContext[] = [];
  for (const match of text.matchAll(CARRIER)) {
    if (match[0].length > MAX_CONTEXT) continue;
    try {
      const value = JSON.parse(Buffer.from(match[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
      const target = value.target as Partial<NativeTurnTarget> | undefined;
      // Any well-formed id: each backend's own transcript source keeps only the contexts carrying its own.
      if (typeof value.backendId !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(value.backendId) || typeof value.sessionId !== 'string'
        || typeof value.commandId !== 'string' || typeof value.nonce !== 'string' || value.nonce.length !== 32
        || typeof target?.nativeSessionId !== 'string' || typeof target.turnId !== 'string') continue;
      results.push({ backendId: value.backendId as NativeBackendId, sessionId: value.sessionId, commandId: value.commandId,
        target: { nativeSessionId: target.nativeSessionId, turnId: target.turnId }, text: match[2]!, carrier: match[0] });
    } catch { /* Foreign or truncated context cannot confirm an input. */ }
  }
  return results;
}

const sameTarget = (a: NativeTurnTarget | undefined, b: NativeTurnTarget) => a?.nativeSessionId === b.nativeSessionId && a.turnId === b.turnId;
const targetKey = (target: NativeTurnTarget) => JSON.stringify([target.nativeSessionId, target.turnId]);
const sourceId = (source: string, commandId: string) => `steer:${createHash('sha256').update(source).update('\0').update(commandId).digest('hex')}`;

/** Pending hooks hold no session lock and do not enter the provider's next-turn inbox. */
export class DeferredSteerInputs {
  private readonly pending = new Map<string, { request: SteerRequest; carrier: string; binding?: SteerBinding }>();
  private readonly outcomes = new Map<string, Outcome>();

  constructor(private readonly host: SteerHost, private readonly options: {
    backendId: NativeBackendId; sessionId: string; currentTarget: () => NativeTurnTarget | undefined;
  }) {}

  enqueue(request: SteerRequest, renderedText: string, binding?: SteerBinding): { deferred: true } {
    if (!sameTarget(this.options.currentTarget(), request.target)) throw new AppError('STEER_TARGET_CHANGED', 'The target turn ended or changed; the steer message was not sent', 409);
    if (!renderedText.trim() || renderedText.trimStart().startsWith('/') || renderedText.includes(OPEN) || renderedText.includes(CLOSE)) {
      throw new AppError('STEER_REJECTED', 'Steering needs plain text and cannot run slash commands', 409);
    }
    const metadata = Buffer.from(JSON.stringify({ backendId: this.options.backendId, sessionId: this.options.sessionId,
      target: request.target, commandId: request.commandId, nonce: randomBytes(24).toString('base64url') })).toString('base64url');
    const carrier = `${OPEN}${metadata}">\n${renderedText}\n${CLOSE}`;
    if (carrier.length > MAX_CONTEXT) throw new AppError('STEER_REJECTED', 'The steer message is too long; shorten it and try again', 409);
    // Retrying an already accepted HTTP command must not enqueue another copy.
    if (!this.pending.has(request.commandId)) this.pending.set(request.commandId, { request, carrier, binding });
    return { deferred: true };
  }

  /** Synchronous within the caller's short session lock, immediately before writing the hook response. */
  claim(target: NativeTurnTarget, binding?: SteerBinding): string | undefined {
    if (!sameTarget(this.options.currentTarget(), target) || this.host.getSession(this.options.sessionId).nativeSessionId !== target.nativeSessionId) {
      this.reject('当前任务已结束或改变，引导尚未发送', target);
      return undefined;
    }
    const contexts: string[] = [];
    let length = 0;
    for (const [commandId, pending] of this.pending) {
      if (!sameTarget(pending.request.target, target)) continue;
      if (length + pending.carrier.length + (contexts.length ? 2 : 0) > MAX_CONTEXT) break;
      this.pending.delete(commandId);
      try {
        pending.request.commitDispatchFence({ ...pending.binding, ...binding, backendId: this.options.backendId,
          nativeSessionId: target.nativeSessionId, nativeTurnId: target.turnId, renderedText: pending.carrier });
        contexts.push(pending.carrier);
        length += pending.carrier.length + (contexts.length > 1 ? 2 : 0);
        this.emit(pending.request, 'native_input_submitted', { commandId });
      } catch {
        this.emit(pending.request, 'native_input_rejected', { commandId, beforeWrite: true, reason: '当前任务或消息状态已改变，引导尚未发送' });
      }
    }
    return contexts.length ? contexts.join('\n\n') : undefined;
  }

  /**
   * `claim` for a fence that settles asynchronously (a plugin's `host.commitDispatchFence`): the same
   * rules, each input removed from the inbox before its fence is awaited, so a second hook cannot take it.
   */
  async claimAsync(target: NativeTurnTarget, binding?: SteerBinding): Promise<string | undefined> {
    if (!sameTarget(this.options.currentTarget(), target) || this.host.getSession(this.options.sessionId).nativeSessionId !== target.nativeSessionId) {
      this.reject('当前任务已结束或改变，引导尚未发送', target);
      return undefined;
    }
    const contexts: string[] = [];
    let length = 0;
    for (const [commandId, pending] of [...this.pending]) {
      if (!sameTarget(pending.request.target, target) || !this.pending.has(commandId)) continue;
      if (length + pending.carrier.length + (contexts.length ? 2 : 0) > MAX_CONTEXT) break;
      this.pending.delete(commandId);
      try {
        await pending.request.commitDispatchFence({ ...pending.binding, ...binding, backendId: this.options.backendId,
          nativeSessionId: target.nativeSessionId, nativeTurnId: target.turnId, renderedText: pending.carrier });
        contexts.push(pending.carrier);
        length += pending.carrier.length + (contexts.length > 1 ? 2 : 0);
        this.emit(pending.request, 'native_input_submitted', { commandId });
      } catch {
        this.emit(pending.request, 'native_input_rejected', { commandId, beforeWrite: true, reason: '当前任务或消息状态已改变，引导尚未发送' });
      }
    }
    return contexts.length ? contexts.join('\n\n') : undefined;
  }

  reject(reason: string, target?: NativeTurnTarget): void {
    for (const [commandId, { request }] of this.pending) {
      if (target && !sameTarget(request.target, target)) continue;
      this.pending.delete(commandId);
      this.emit(request, 'native_input_rejected', { commandId, beforeWrite: true, reason });
    }
  }

  /** Called only with actual persisted tool-result / hook-additional-context content and its native identity. */
  receiptEvents(text: string, sourceNativeId: string, createdAt: string): NativeWorkbenchEvent[] {
    const events: NativeWorkbenchEvent[] = [];
    for (const context of parseSteerContexts(text)) {
      if (context.backendId !== this.options.backendId || context.sessionId !== this.options.sessionId) continue;
      const runs = this.runs(context.target);
      const run = runs.find(candidate => candidate.commandId === context.commandId
        && candidate.native?.intent === 'steer' && candidate.native.renderedText === context.carrier
        && !['steer_missed', 'steer_rejected', 'acknowledged', 'cancelled'].includes(candidate.native.stage ?? ''));
      if (!run?.native) continue;
      const nativeId = sourceId(sourceNativeId, context.commandId);
      events.push({ sequence: 0, sessionId: this.options.sessionId, runId: run.id, nativeTurnId: context.target.turnId,
        type: 'native_input_receipt', nativeId, createdAt,
        // The row lands in whatever turn its transcript groups it into, which need not be the turn the
        // steer named (an answered question reopens a turn under a key of its own): the target says.
        data: { commandId: context.commandId, content: { type: 'text', text: run.native.input.text }, receiptKind: 'hook_context', sourceNativeId, targetTurnId: context.target.turnId } });
      // Recovery cannot rely on an in-memory Stop/receipt ordering cache. An explicitly settled
      // execution owner is durable evidence; `interrupted + uncertain` is deliberately excluded.
      const owner = runs.find(candidate => candidate.native?.intent !== 'steer'
        && (!run.native?.ownerRunId || candidate.id === run.native.ownerRunId));
      const outcome = this.outcomes.get(targetKey(context.target)) ?? this.persistedOutcome(owner);
      if (outcome) events.push(this.terminal(run, context.target, outcome, createdAt));
    }
    return events;
  }

  finish(target: NativeTurnTarget, outcome: Outcome): void {
    this.reject('当前任务已结束，引导尚未发送', target);
    this.outcomes.set(targetKey(target), outcome);
    if (this.outcomes.size > 128) this.outcomes.delete(this.outcomes.keys().next().value!);
    for (const run of this.runs(target)) {
      if (run.native?.intent !== 'steer' || !run.native.nativeMessageId
        || ['steer_missed', 'steer_rejected', 'acknowledged', 'cancelled'].includes(run.native.stage ?? '')) continue;
      this.host.emitEvent(this.options.sessionId, this.terminal(run, target, outcome, new Date().toISOString()));
    }
  }

  private runs(target: NativeTurnTarget): Run[] {
    return this.host.findRunsByNativeTurn?.(this.options.sessionId, target.nativeSessionId, target.turnId) ?? [];
  }

  private persistedOutcome(owner: Run | undefined): Outcome | undefined {
    if (!owner?.native?.nativeMessageId) return undefined;
    if (owner.state === 'completed' && owner.native.delivery === 'observed') return { type: 'run_completed' };
    if (owner.state === 'failed' && owner.native.delivery === 'failed') return { type: 'run_failed', ...(owner.error ? { error: owner.error } : {}) };
    // `turn_outcome_unknown` closed the owner without knowing how its turn ended: that is no outcome to replay.
    if (owner.state === 'interrupted' && owner.native.delivery === 'cancelled' && owner.native.stage !== 'turn_outcome_unknown') return { type: 'run_cancelled', ...(owner.error ? { reason: owner.error } : {}) };
    return undefined;
  }

  private emit(request: SteerRequest, type: string, data: Record<string, unknown>): void {
    this.host.emitEvent(this.options.sessionId, { sequence: 0, sessionId: this.options.sessionId, runId: request.runId,
      nativeTurnId: request.target.turnId, type, data, createdAt: new Date().toISOString(), nativeId: `${type}:${request.commandId}` });
  }

  private terminal(run: Run, target: NativeTurnTarget, outcome: Outcome, createdAt: string): NativeWorkbenchEvent {
    return { sequence: 0, sessionId: this.options.sessionId, runId: run.id, nativeTurnId: target.turnId,
      type: outcome.type, createdAt, nativeId: `${outcome.type}:steer:${run.commandId}`,
      data: { commandId: run.commandId, nativeMessageId: run.native?.nativeMessageId, ...(outcome.error ? { error: outcome.error } : {}), ...(outcome.reason ? { reason: outcome.reason } : {}) } };
  }
}
