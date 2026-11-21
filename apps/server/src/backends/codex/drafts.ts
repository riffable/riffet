import type { NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';

/** Streamed text goes out in small batches; a frame per delta would be one every few milliseconds. */
const FLUSH_MS = 50;

/** Only these provider phases distinguish progress prose from the final answer. */
export function messagePhase(value: unknown): 'commentary' | 'final_answer' | undefined {
  return value === 'commentary' || value === 'final_answer' ? value : undefined;
}

/**
 * How the clients show a reasoning item: a summary as narration prose, raw reasoning folded into
 * the thinking row. The summary slot alone does not settle it: a Responses gateway in front of
 * another model (DeepSeek) relays that model's raw chain of thought as `summary_text`. An OpenAI
 * summary opens each part with a bold heading — the one the CLI shows as its status — so only
 * text that does reads as narration.
 */
export function reasoningChannel(summary: string | undefined): 'narration' | 'thinking' {
  return summary?.trimStart().startsWith('**') ? 'narration' : 'thinking';
}

interface Draft {
  turnId: string;
  type: 'agent_message_chunk' | 'agent_thought_chunk';
  /** The committed item's event id, which inherits the draft's sequence. */
  finalId: string;
  /** Shared by the draft's chunks: the browser joins `<n>:<message>:<chunk>` ids into one message. */
  chunkPrefix: string;
  channel?: 'summary' | 'raw';
  phase?: 'commentary' | 'final_answer';
  part?: number;
  text: string;
  sent: number;
  sentPhase?: 'commentary' | 'final_answer';
  chunks: number;
  sequence?: number;
  historySeeded?: boolean;
}

export interface CodexDraftOptions {
  /** Optional metadata-only timing probe. Never receives conversation text. */
  timing?(sample: { atMs: number; deltas: number; characters: number; arrivalSpanMs: number; flushDelayMs: number; timerLateMs: number; events: number }): void;
  nextSequence(): number;
  /** Gives the committed event this sequence, so the item stays where its stream began. */
  reserveSequence(nativeId: string, sequence: number): void;
  /**
   * Writes a chunk to the session journal under the id its committed item will have, and returns
   * the chunk's number. With it, numbers come from the log (and the committed item inherits the
   * first chunk's place by being a later version of the same entity); without it `nextSequence` does.
   */
  persist?(finalId: string, event: NativeWorkbenchEvent): number;
  eventContext(turnId: string): { sessionId: string; runId?: string; createdAt: string };
  send(events: NativeWorkbenchEvent[]): void;
}

/**
 * Text Codex is still streaming for a message or reasoning item.
 *
 * The app-server streams deltas long before `item/completed` commits an item, and the attached TUI
 * prints them as they come. Each item's text is sent as joinable chunks and shown as one message;
 * a reset carries it as a single row, and the committed item replaces it with a reset of its own.
 */
export class CodexDraftStream {
  private readonly drafts = new Map<string, Draft>();
  private timer: NodeJS.Timeout | undefined;
  private timingBatch: { first: number; last: number; deltas: number; characters: number } | undefined;

  constructor(private readonly options: CodexDraftOptions) {}

  /** Folds one delta notification into its item's draft. */
  note(method: string, params: Record<string, unknown>, threadId: string, seed?: { text: string; sequence: number; phase?: unknown }): string | undefined {
    const itemId = typeof params.itemId === 'string' && params.itemId ? params.itemId : undefined;
    const turnId = typeof params.turnId === 'string' && params.turnId ? params.turnId : undefined;
    const delta = params.delta;
    if (!itemId || !turnId || typeof delta !== 'string' || (!delta && !messagePhase(params.phase))) return;
    const reasoning = method !== 'item/agentMessage/delta';
    const channel = method === 'item/reasoning/summaryTextDelta' ? 'summary' : method === 'item/reasoning/textDelta' ? 'raw' : undefined;
    const index = reasoning ? (channel === 'summary' ? params.summaryIndex : params.contentIndex) : undefined;
    const part = typeof index === 'number' && Number.isSafeInteger(index) ? index : undefined;
    let draft = this.drafts.get(itemId);
    if (!draft) {
      const base = `${threadId}:${turnId}:${itemId}`;
      const kind = reasoning ? 'thinking' : 'assistant';
      draft = {
        turnId, type: reasoning ? 'agent_thought_chunk' : 'agent_message_chunk',
        finalId: `${base}:${kind}`, chunkPrefix: `0:${base}:${kind}-draft`,
        ...(channel ? { channel } : {}), text: seed?.text ?? '', sent: seed?.text.length ?? 0, chunks: 0,
        ...(seed ? { sequence: seed.sequence, historySeeded: true } : {}),
      };
      this.drafts.set(itemId, draft);
    }
    // Raw reasoning and its summary describe the same thought; the committed item shows both, the
    // draft only the channel that streamed first.
    if (draft.channel !== channel) return;
    if (!reasoning) draft.phase = messagePhase(params.phase) ?? draft.phase ?? messagePhase(seed?.phase);
    // Summary parts are separate paragraphs in the committed item too.
    if (part !== undefined && draft.part !== undefined && part !== draft.part && draft.text) draft.text += '\n\n';
    if (part !== undefined) draft.part = part;
    draft.text += delta;
    if (this.options.timing) {
      const now = performance.now();
      const batch = this.timingBatch ??= { first: now, last: now, deltas: 0, characters: 0 };
      batch.last = now;
      batch.deltas += 1;
      batch.characters += delta.length;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), FLUSH_MS);
      this.timer.unref();
    }
    return draft.finalId;
  }

  /** Sends every draft's unsent text now. */
  flush(): void {
    const timing = this.timingBatch;
    this.timingBatch = undefined;
    const flushAt = timing ? performance.now() : 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const events: NativeWorkbenchEvent[] = [];
    for (const draft of this.drafts.values()) {
      if (draft.sent >= draft.text.length && (draft.sequence === undefined || draft.sentPhase === draft.phase)) continue;
      const text = draft.text.slice(draft.sent);
      let sequence: number;
      let event: NativeWorkbenchEvent;
      if (this.options.persist) {
        event = this.event(draft, draft.chunks++, text, 0);
        sequence = this.options.persist(draft.finalId, event);
        event = { ...event, sequence };
      } else {
        sequence = this.options.nextSequence();
        event = this.event(draft, draft.chunks++, text, sequence);
      }
      if (draft.sequence === undefined) {
        draft.sequence = sequence;
        this.options.reserveSequence(draft.finalId, sequence);
      }
      events.push(event);
      draft.sent = draft.text.length;
      draft.sentPhase = draft.phase;
    }
    if (events.length) this.options.send(events);
    if (timing && this.options.timing) {
      this.options.timing({ atMs: flushAt, deltas: timing.deltas, characters: timing.characters,
        arrivalSpanMs: timing.last - timing.first, flushDelayMs: flushAt - timing.first,
        timerLateMs: Math.max(0, flushAt - timing.first - FLUSH_MS), events: events.length });
    }
  }

  /** One row per streaming item with all of its text so far, for a reset. */
  snapshot(): NativeWorkbenchEvent[] {
    this.flush();
    return [...this.drafts.values()].flatMap(draft => draft.sequence === undefined ? [] : [this.event(draft, 0, draft.text, draft.sequence)]);
  }

  phase(itemId: string, nativeId: string): 'commentary' | 'final_answer' | undefined {
    const draft = this.drafts.get(itemId);
    return draft?.finalId === nativeId ? draft.phase : undefined;
  }

  /** Text held when a history request started, used to separate later deltas from its prefix. */
  texts(): Map<string, string> {
    return new Map([...this.drafts.values()].map(draft => [draft.finalId, draft.text]));
  }

  /** A running history row is a prefix, not proof that this item's stream has committed. */
  adoptPartial(nativeId: string, text: string, previousText: string | undefined, sequence?: number, phase?: unknown): boolean {
    const draft = [...this.drafts.values()].find(candidate => candidate.finalId === nativeId);
    if (!draft) return false;
    if (sequence !== undefined) draft.sequence = sequence;
    if (draft.type === 'agent_message_chunk') draft.phase = messagePhase(phase) ?? draft.phase;
    if (!draft.text.startsWith(text)) {
      // Without a known history baseline the notifications may be only a tail. Preserve it:
      // suffix overlap cannot distinguish a duplicate notification from legitimate repetition.
      const tail = draft.historySeeded && previousText !== undefined ? draft.text.slice(previousText.length) : draft.text;
      draft.text = text + tail;
      // The enclosing authoritative reset carries the complete row; do not resend its old tail
      // as fresh chunks before that reset. Subsequent deltas still append normally.
      draft.sent = draft.text.length;
    }
    draft.historySeeded = true;
    return true;
  }

  /** Forgets the draft an item's committed copy replaces; true when one had been shown. */
  settle(itemId: string): boolean {
    const draft = this.drafts.get(itemId);
    if (!draft) return false;
    this.drafts.delete(itemId);
    return draft.sequence !== undefined;
  }

  /** Forgets drafts whose committed event a transcript read already holds. */
  settleCommitted(isCommitted: (nativeId: string) => boolean): void {
    for (const [itemId, draft] of this.drafts) if (isCommitted(draft.finalId)) this.drafts.delete(itemId);
  }

  /** Cold recovery seeded older history ahead of these not-yet-published drafts. */
  resequence(sequenceFor?: (nativeId: string) => number | undefined): void {
    for (const draft of this.drafts.values()) {
      draft.sequence = sequenceFor?.(draft.finalId);
      draft.sent = 0;
      draft.chunks = 0;
    }
  }

  /** Forgets a finished turn's drafts, including items it never committed. */
  dropTurn(turnId: string): void {
    for (const [itemId, draft] of this.drafts) if (draft.turnId === turnId) this.drafts.delete(itemId);
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.timingBatch = undefined;
    this.drafts.clear();
  }

  private event(draft: Draft, chunk: number, text: string, sequence: number): NativeWorkbenchEvent {
    const { sessionId, runId, createdAt } = this.options.eventContext(draft.turnId);
    return {
      sequence, sessionId, nativeTurnId: draft.turnId, ...(runId ? { runId } : {}), type: draft.type,
      // The same split the committed item makes.
      data: { sessionUpdate: draft.type, ...(draft.phase ? { phase: draft.phase } : {}), ...(draft.channel ? { channel: reasoningChannel(draft.channel === 'summary' ? draft.text : undefined) } : {}), content: { type: 'text', text } },
      createdAt, nativeId: `${draft.chunkPrefix}:${chunk}`,
    };
  }
}
