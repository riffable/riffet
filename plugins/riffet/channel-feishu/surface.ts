/*
 * One turn on Feishu: a native process message (cot.ts) plus an answer card that is edited as the
 * answer grows. The card is rewritten whole (PATCH), which Feishu limits to roughly 60 edits per
 * two minutes for the app, so edits are paced by size and time and degrade instead of failing:
 * tables to code blocks, then one markdown element, then a stable prefix plus the latest text.
 * The final render is split into several cards when the limits need it.
 */
import { randomUUID } from 'node:crypto';
import type { ChannelAddress, ChannelContext, ReplyAnchor, SurfaceState, TurnSurface, TurnView } from '@riffet/plugin-api';
import { finalCards, placeholderCard, turnCard, CARD_SAFE_BYTES, type AnswerMode, type Card } from './cards.js';
import { CotRun, type CotOutcome, type CotRunState } from './cot.js';
import { FeishuApiError, type FeishuApi } from './openapi.js';

export interface SurfaceDeps {
  api: FeishuApi;
  log: ChannelContext['log'];
  budget?: PatchBudget;
}

// ── Pacing ──

const WINDOW_MS = 120_000;
const GLOBAL_BUDGET = 60;
const GLOBAL_WARN = 40;
const CHAT_BUDGET = 45;
const BASE_INTERVAL_MS = 500;
const MAX_INTERVAL_MS = 3000;
const TRAILING_MS = 300;
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 10_000;
const MAX_STREAM_FAILURES = 5;

/** Edit counts of the whole process in the last two minutes, per chat and overall. */
export class PatchBudget {
  private entries: Array<{ at: number; chat: string }> = [];
  private backoffUntil = 0;
  private backoff = BACKOFF_START_MS;

  private prune(now: number): void { this.entries = this.entries.filter(entry => now - entry.at < WINDOW_MS); }

  record(chat: string, now = Date.now()): void { this.prune(now); this.entries.push({ at: now, chat }); }

  /** Minimum spacing for the next edit: grows from 500 ms to 3 s as the budget is used up. */
  interval(chat: string, now = Date.now()): number {
    this.prune(now);
    const global = Math.min(Math.max(this.entries.length - GLOBAL_WARN, 0) / (GLOBAL_BUDGET - GLOBAL_WARN), 1);
    const own = this.entries.filter(entry => entry.chat === chat).length;
    const chatWarn = CHAT_BUDGET * (GLOBAL_WARN / GLOBAL_BUDGET);
    const perChat = this.entries.length >= GLOBAL_WARN / 2 ? Math.min(Math.max(own - chatWarn, 0) / (CHAT_BUDGET - chatWarn), 1) : 0;
    return Math.round(BASE_INTERVAL_MS + Math.max(global, perChat) * (MAX_INTERVAL_MS - BASE_INTERVAL_MS));
  }

  /** How long until an edit is allowed: the backoff after a rate limit, or the window freeing a slot. */
  wait(chat: string, now = Date.now()): number {
    this.prune(now);
    let until = this.backoffUntil;
    const own = this.entries.filter(entry => entry.chat === chat);
    if (this.entries.length >= GLOBAL_BUDGET) until = Math.max(until, this.entries[0]!.at + WINDOW_MS);
    if (own.length >= CHAT_BUDGET) until = Math.max(until, own[0]!.at + WINDOW_MS);
    return Math.max(until - now, 0);
  }

  rateLimited(now = Date.now()): number {
    const delay = this.backoff;
    this.backoffUntil = now + delay;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    return delay;
  }

  succeeded(): void { this.backoff = BACKOFF_START_MS; }
}

const sharedBudget = new PatchBudget();

/** Characters to accumulate before an edit pays off; longer answers edit in bigger steps. */
export const charThreshold = (length: number): number => length >= 8000 ? 128 : length >= 2000 ? 64 : 15;

// ── Degrading ──

const NEXT_MODE: Record<AnswerMode, AnswerMode | undefined> = { native: 'code-tables', 'code-tables': 'single', single: 'window', window: undefined };

function degradeFor(mode: AnswerMode, error: FeishuApiError): AnswerMode | undefined {
  if (error.isCardTableLimit()) return mode === 'native' ? 'code-tables' : NEXT_MODE[mode];
  if (error.isCardElementLimit()) return mode === 'window' ? undefined : mode === 'single' ? 'window' : 'single';
  if (error.isCardBuildFailure() || error.isInvalidImageKey()) return NEXT_MODE[mode];
  return undefined;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// ── Where messages go ──

const isMessageId = (id: string | undefined): id is string => typeof id === 'string' && id.startsWith('om_');

/** The message a reply attaches to: an anchor or thread key only counts when it is a real message id. */
export function replyTarget(address: ChannelAddress, anchor?: ReplyAnchor): string | undefined {
  return isMessageId(anchor?.messageId) ? anchor.messageId : isMessageId(address.threadKey) ? address.threadKey : undefined;
}

/** Replies always open or continue a thread; a withdrawn anchor falls back to a plain chat message. */
export async function deliverCard(api: FeishuApi, chatId: string, target: string | undefined, card: Card, uuid: string = randomUUID()): Promise<string> {
  if (!target || !isMessageId(target)) return api.sendCard(chatId, card, uuid);
  try {
    return await api.replyCard(target, card, true, uuid);
  } catch (error) {
    if (error instanceof FeishuApiError && error.code === 230011) return api.sendCard(chatId, card, uuid);
    throw error;
  }
}

/** Sends one card, degrading the answer or swapping in the placeholder as the platform demands. */
export async function sendDegrading<T>(
  state: { mode: AnswerMode },
  build: (mode: AnswerMode) => Card,
  placeholder: () => Card,
  send: (card: Card) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await send(build(state.mode));
    } catch (error) {
      if (!(error instanceof FeishuApiError)) throw error;
      if (error.isModeration()) return send(placeholder());
      const next = degradeFor(state.mode, error);
      if (!next || attempt >= 6) throw error;
      state.mode = next;
    }
  }
}

// ── Persisted state ──

interface SurfaceData {
  v: 1;
  sessionId: string;
  runId: string;
  chatId: string;
  target?: string;
  messageId?: string;
  extra?: string[];
  mode: AnswerMode;
  sentLength: number;
  cot?: CotRunState;
  done?: boolean;
}

const renderKey = (view: TurnView): string => `${view.status}\u0000${view.answer}`;

const OUTCOME: Record<TurnView['status'], CotOutcome> = {
  completed: 'done', failed: 'failed', cancelled: 'interrupted', interrupted: 'interrupted', queued: 'interrupted', running: 'interrupted', waiting: 'interrupted',
};

class FeishuTurnSurface implements TurnSurface {
  private view: TurnView;
  private mode: AnswerMode;
  private messageId?: string;
  private extra: string[] = [];
  private sentLength = 0;
  /** What the card on screen shows (status + answer); a patch is due whenever the view differs. */
  private renderedKey?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private working?: Promise<void>;
  private lastPatchAt = 0;
  private failures = 0;
  private done = false;
  private finishing = false;

  constructor(
    private readonly deps: SurfaceDeps,
    private readonly chatId: string,
    private readonly target: string | undefined,
    private readonly cot: CotRun | undefined,
    view: TurnView,
    resumed?: SurfaceData,
  ) {
    this.view = view;
    this.mode = resumed?.mode ?? 'native';
    this.messageId = resumed?.messageId;
    this.extra = resumed?.extra ?? [];
    this.sentLength = resumed?.sentLength ?? 0;
    this.done = resumed?.done ?? false;
  }

  private get budget(): PatchBudget { return this.deps.budget ?? sharedBudget; }

  state(): SurfaceState {
    const data: SurfaceData = {
      v: 1, sessionId: this.view.sessionId, runId: this.view.runId, chatId: this.chatId,
      ...(this.target ? { target: this.target } : {}),
      ...(this.messageId ? { messageId: this.messageId } : {}),
      ...(this.extra.length ? { extra: this.extra } : {}),
      mode: this.mode, sentLength: this.sentLength,
      ...(this.cot ? { cot: this.cot.state() } : {}),
      ...(this.done ? { done: true } : {}),
    };
    return { kind: 'feishu', data: data as unknown as Record<string, unknown> };
  }

  update(view: TurnView): void {
    if (this.finishing || this.done) return;
    this.view = view;
    try { this.cot?.sync(view.steps); } catch (error) { this.deps.log.warn('feishu process sync failed', { error: String(error) }); }
    this.schedule();
  }

  /** The card is created with the first answer text (or at once for a turn started elsewhere). */
  async start(): Promise<void> {
    if (this.view.source === 'other-client') await this.runExclusive(() => this.createCard());
    this.update(this.view);
  }

  private schedule(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.working || this.finishing || this.failures >= MAX_STREAM_FAILURES) return;
    const length = this.view.answer.length;
    if (!this.messageId) {
      if (!this.view.answer.trim() && this.view.source !== 'other-client') return;
      this.timer = setTimeout(() => void this.runExclusive(() => this.createCard()), 0);
      return;
    }
    if (renderKey(this.view) === this.renderedKey) return;
    const grown = length - this.sentLength;
    const now = Date.now();
    const wait = Math.max(this.lastPatchAt + this.budget.interval(this.chatId, now) - now, this.budget.wait(this.chatId, now), 0);
    // Growth under the threshold waits for the stream to pause; over it, only the interval holds it back.
    // Any other change (status, a rewritten or emptied answer) goes out at the next interval.
    const delay = grown > 0 && this.view.answer.trim() && grown < charThreshold(length) ? Math.max(wait, TRAILING_MS) : wait;
    this.timer = setTimeout(() => void this.runExclusive(() => this.patch()), delay);
  }

  /** One request in flight; changes that arrive meanwhile are picked up by the next schedule. */
  private runExclusive(work: () => Promise<void>): Promise<void> {
    if (this.working) return this.working;
    this.working = work().catch(error => { this.deps.log.warn('feishu card update failed', { error: String(error) }); this.failures += 1; })
      .finally(() => { this.working = undefined; this.schedule(); });
    return this.working;
  }

  private streamingCard(view: TurnView): Card {
    let card = turnCard(view, this.mode);
    if (this.mode !== 'window' && Buffer.byteLength(JSON.stringify(card), 'utf8') > CARD_SAFE_BYTES) {
      this.mode = 'window';
      card = turnCard(view, 'window');
    }
    return card;
  }

  private async createCard(): Promise<void> {
    if (this.messageId) return;
    const view = this.view;
    const state = { mode: this.mode };
    try {
      this.messageId = await sendDegrading(state, mode => { this.mode = mode; return this.streamingCard(view); }, () => placeholderCard(view), card => deliverCard(this.deps.api, this.chatId, this.target, card));
      this.sentLength = view.answer.length;
      this.renderedKey = renderKey(view);
      this.failures = 0;
    } finally {
      this.mode = state.mode;
    }
  }

  private async patch(): Promise<void> {
    const messageId = this.messageId;
    const view = this.view;
    if (!messageId) return;
    const state = { mode: this.mode };
    try {
      this.budget.record(this.chatId);
      this.lastPatchAt = Date.now();
      await sendDegrading(state, mode => { this.mode = mode; return this.streamingCard(view); }, () => placeholderCard(view), card => this.deps.api.patchCard(messageId, card));
      this.sentLength = view.answer.length;
      this.renderedKey = renderKey(view);
      this.failures = 0;
      this.budget.succeeded();
    } catch (error) {
      if (error instanceof FeishuApiError && error.isRateLimit()) {
        this.budget.rateLimited();
        return;
      }
      throw error;
    } finally {
      this.mode = state.mode;
    }
  }

  async finish(view: TurnView): Promise<void> {
    if (this.finishing) return;
    this.finishing = true;
    this.view = view;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    await this.working?.catch(() => undefined);
    // Final tool results, trailing thoughts and tools still open go out before the run ends.
    try { this.cot?.sync(view.steps, true); } catch (error) { this.deps.log.warn('feishu process sync failed', { error: String(error) }); }
    const closing = this.cot?.finish(OUTCOME[view.status], view.error).catch(error => this.deps.log.warn('feishu process close failed', { error: String(error) }));
    try {
      await this.renderFinal(view);
    } catch (error) {
      this.deps.log.warn('feishu final card failed', { error: String(error) });
    }
    await closing;
    this.done = true;
  }

  private async withRateLimitRetry<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        const transient = error instanceof FeishuApiError && error.isTransient();
        if (!transient || attempt >= 5) throw error;
        await sleep(error.isRateLimit() ? this.budget.rateLimited() : 1000 * (attempt + 1));
      }
    }
  }

  /** One logical send: the same idempotency key on every retry, so a timed-out POST cannot double up. */
  private sendOnce(card: Card): Promise<string> {
    const uuid = randomUUID();
    return this.withRateLimitRetry(() => deliverCard(this.deps.api, this.chatId, this.target, card, uuid));
  }

  private async renderFinal(view: TurnView): Promise<void> {
    const state = { mode: this.mode };
    let cards: Card[] = [];
    const build = (mode: AnswerMode): Card => {
      this.mode = mode;
      cards = finalCards(view, mode);
      return cards[0]!;
    };
    const first = this.messageId;
    const sendFirst = (card: Card): Promise<string> => first
      ? this.withRateLimitRetry(() => this.deps.api.patchCard(first, card)).then(() => first)
      : this.sendOnce(card);
    let placeholder = false;
    const firstId = await sendDegrading(state, build, () => { placeholder = true; return placeholderCard(view); }, sendFirst);
    this.messageId = firstId;
    this.sentLength = view.answer.length;
    // The first card is the original message; the rest follow it as replies. A placeholder has no rest.
    for (const card of placeholder ? [] : cards.slice(1)) {
      try {
        this.extra.push(await this.sendOnce(card));
      } catch (error) {
        this.deps.log.warn('feishu continuation card failed', { error: String(error) });
        break;
      }
    }
  }
}

function parseData(state: SurfaceState): SurfaceData | undefined {
  const data = state.data as Partial<SurfaceData>;
  return state.kind === 'feishu' && data.v === 1 && typeof data.chatId === 'string' && typeof data.runId === 'string' && typeof data.sessionId === 'string' ? data as SurfaceData : undefined;
}

export async function openTurnSurface(deps: SurfaceDeps, address: ChannelAddress, view: TurnView, anchor?: ReplyAnchor): Promise<TurnSurface> {
  const target = replyTarget(address, anchor);
  // No process surface when the COT cannot be created: the turn still gets its answer card.
  const cot = view.card.process ? await CotRun.open(deps.api, { chatId: address.chatId, ...(target ? { originMessageId: target } : {}) }, view.runId, view.sessionId) : undefined;
  if (view.card.process && !cot) deps.log.warn('feishu process message unavailable for this turn', { chatId: address.chatId });
  const surface = new FeishuTurnSurface(deps, address.chatId, target, cot, view);
  await surface.start();
  return surface;
}

export async function resumeTurnSurface(deps: SurfaceDeps, address: ChannelAddress, state: SurfaceState): Promise<TurnSurface | undefined> {
  const data = parseData(state);
  if (!data) return undefined;
  const cot = data.cot ? CotRun.resume(deps.api, data.cot) : undefined;
  const view: TurnView = {
    sessionId: data.sessionId, runId: data.runId, title: '', status: 'running', source: 'channel', steps: [], answer: '', footer: {},
    card: { header: true, process: true, stopButton: true, footer: { model: true, changes: true, context: true, elapsed: true } },
  };
  return new FeishuTurnSurface(deps, address.chatId, data.target, cot, view, data);
}

/** Ends what a surface that cannot be taken over left on the platform: its process message. */
export async function closeOrphanedSurface(deps: SurfaceDeps, state: SurfaceState): Promise<void> {
  const data = parseData(state);
  const cot = data?.cot ? CotRun.resume(deps.api, data.cot) : undefined;
  await cot?.finish('failed', '已中断').catch(() => undefined);
}
