import { DICTATION_BUDGET, DICTATION_ROUTE, type DictationClientMessage, type DictationSegment, type DictationServerMessage } from '@contracts';

export interface DictationProblem { code: string; message: string; retryable: boolean }

export interface DictationStreamEvents {
  ready(streaming: boolean): void;
  partial(segments: DictationSegment[]): void;
  final(text: string): void;
  error(problem: DictationProblem): void;
}

/** Frames held while the socket opens, at most a whole recording. */
const MAX_QUEUED_FRAMES = DICTATION_BUDGET.maxDurationMs / 100;

/**
 * One dictation's socket (docs/VOICE.md §4): `start` once it opens, the audio as binary frames, then `finish` or `cancel`. Each
 * event fires at most once per outcome; after `final` or `error` the stream is spent.
 */
export class DictationStream {
  private readonly socket: WebSocket;
  private queue: ArrayBuffer[] = [];
  private finishing = false;
  private settled = false;

  constructor(private readonly events: DictationStreamEvents) {
    const url = new URL(DICTATION_ROUTE, window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    this.socket = new WebSocket(url);
    this.socket.binaryType = 'arraybuffer';
    this.socket.onopen = () => {
      this.send({ type: 'start' });
      for (const frame of this.queue) this.socket.send(frame);
      this.queue = [];
      if (this.finishing) this.send({ type: 'finish' });
    };
    this.socket.onmessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data !== 'string') return;
      let message: DictationServerMessage;
      try { message = JSON.parse(event.data) as DictationServerMessage; } catch { return; }
      if (message.type === 'ready') this.events.ready(message.streaming);
      else if (message.type === 'partial') this.events.partial(message.segments);
      else if (message.type === 'final') this.settle(() => this.events.final(message.text));
      else if (message.type === 'error') this.settle(() => this.events.error({ code: message.code, message: message.message, retryable: message.retryable }));
    };
    this.socket.onclose = (event) => {
      // Closed before an answer: the connection dropped, or the server refused it (1013: too many at once).
      this.settle(() => this.events.error({ code: event.code === 1013 ? 'DICTATION_BUSY' : 'DICTATION_DISCONNECTED', message: event.reason || 'The connection closed', retryable: true }));
    };
  }

  push(pcm: ArrayBuffer): void {
    if (this.settled || this.finishing) return;
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(pcm);
    else if (this.socket.readyState === WebSocket.CONNECTING && this.queue.length < MAX_QUEUED_FRAMES) this.queue.push(pcm);
  }

  finish(): void {
    if (this.settled || this.finishing) return;
    this.finishing = true;
    if (this.socket.readyState === WebSocket.OPEN) this.send({ type: 'finish' });
  }

  /** Ends the dictation without an answer: no event fires after this. */
  cancel(): void {
    if (this.settled) return;
    this.settled = true;
    if (this.socket.readyState === WebSocket.OPEN) this.send({ type: 'cancel' });
    this.socket.close(1000);
  }

  private settle(report: () => void): void {
    if (this.settled) return;
    this.settled = true;
    report();
    if (this.socket.readyState <= WebSocket.OPEN) this.socket.close(1000);
  }

  private send(message: DictationClientMessage): void { this.socket.send(JSON.stringify(message)); }
}

/** Segments as one text: words of Latin script are spaced, CJK runs are not. */
export function joinTranscript(parts: readonly string[]): string {
  let text = '';
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    text += text && needsSpace(text, part) ? ` ${part}` : part;
  }
  return text;
}

/** Between two texts that meet at Latin letters or digits, or where a Latin sentence or clause has ended. */
export function needsSpace(before: string, after: string): boolean {
  return /[A-Za-z0-9][,.!?;:]?$/.test(before) && /^[A-Za-z0-9]/.test(after);
}
