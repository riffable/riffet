import type { SpeechRecognizer, SpeechSession } from '@riffet/plugin-api';
import { DICTATION_BUDGET, DICTATION_SAMPLE_RATE, type DictationClientMessage, type DictationServerMessage } from '../../../../packages/contracts/src/index.js';
import { DictationError } from './errors.js';

/** The recognizer `voiceInput.recognizer` names, checked ready; `signal` aborts when the plugin that gave it is turned off. */
export interface ResolvedRecognizer { recognizer: SpeechRecognizer; streaming: boolean; signal?: AbortSignal }

export interface DictationSocket {
  send(text: string): void;
  close(code: number, reason: string): void;
  readonly bufferedAmount: number;
}

export interface DictationConnectionOptions {
  /** Throws `DictationError` when dictation cannot start. */
  resolve(): Promise<ResolvedRecognizer>;
  language(): string | undefined;
}

const MAX_SAMPLES = DICTATION_BUDGET.maxDurationMs / 1000 * DICTATION_SAMPLE_RATE;
/** Past this much unsent data a partial is skipped: the next one replaces it, and `final` always goes. */
const PARTIAL_SOCKET_LIMIT = 256 * 1024;

/**
 * One dictation over one socket (docs/VOICE.md §4): `start`, audio frames, then `finish` or `cancel`. Audio that arrives while
 * the recognizer opens (a local model loading) is held and handed over once it is open, within the same duration cap.
 */
export class DictationConnection {
  private state: 'waiting' | 'opening' | 'open' | 'finishing' | 'done' = 'waiting';
  private readonly controller = new AbortController();
  private session?: SpeechSession;
  private pending: Int16Array[] = [];
  private samples = 0;
  private finishRequested = false;
  private idleTimer?: NodeJS.Timeout;
  private releaseSignal?: () => void;

  constructor(private readonly socket: DictationSocket, private readonly options: DictationConnectionOptions) {}

  message(data: Buffer, binary: boolean): void {
    if (this.state === 'done') return;
    if (binary) { this.audio(data); return; }
    let message: DictationClientMessage;
    try { message = JSON.parse(data.toString('utf8')) as DictationClientMessage; } catch { this.fail(new DictationError('DICTATION_PROTOCOL', 'Messages must be JSON', false)); return; }
    if (message?.type === 'start' && this.state === 'waiting') void this.start();
    else if (message?.type === 'finish' && (this.state === 'opening' || this.state === 'open')) {
      if (this.state === 'open') void this.finish(); else this.finishRequested = true;
    // The client reaching the duration cap finishes too, after the server already has.
    } else if (message?.type === 'finish' && this.state === 'finishing') return;
    else if (message?.type === 'cancel') this.end(1000, 'Cancelled');
    else this.fail(new DictationError('DICTATION_PROTOCOL', `Unexpected message ${String((message as { type?: unknown })?.type)}`, false));
  }

  /** The socket closed: whatever the recognizer holds for this dictation is released. */
  closed(): void {
    this.state = 'done';
    this.dispose();
  }

  private async start(): Promise<void> {
    this.state = 'opening';
    this.touch();
    try {
      const resolved = await this.options.resolve();
      if (this.state !== 'opening') return;
      if (resolved.signal) {
        const off = () => this.fail(new DictationError('RECOGNIZER_UNAVAILABLE', 'The recognizer was turned off', false));
        resolved.signal.addEventListener('abort', off, { once: true });
        this.releaseSignal = () => resolved.signal?.removeEventListener('abort', off);
      }
      const signal = resolved.signal ? AbortSignal.any([this.controller.signal, resolved.signal]) : this.controller.signal;
      const session = await resolved.recognizer.open({
        language: this.options.language(), signal,
        onPartial: segments => {
          if (this.state !== 'open' && this.state !== 'finishing') return;
          if (this.socket.bufferedAmount > PARTIAL_SOCKET_LIMIT) return;
          this.send({ type: 'partial', segments: segments.map(segment => ({ text: String(segment.text), final: Boolean(segment.final) })) });
        },
      });
      if (this.state !== 'opening') return;
      this.session = session;
      this.state = 'open';
      this.send({ type: 'ready', streaming: resolved.streaming });
      for (const pcm of this.pending) session.append(pcm);
      this.pending = [];
      if (this.finishRequested || this.samples >= MAX_SAMPLES) await this.finish();
    } catch (error) {
      this.fail(error, 'RECOGNIZER_FAILED', false);
    }
  }

  private audio(data: Buffer): void {
    if (this.state !== 'opening' && this.state !== 'open') return;
    if (data.byteLength > DICTATION_BUDGET.frameBytes || data.byteLength % 2) { this.fail(new DictationError('DICTATION_PROTOCOL', `Audio frames are PCM16 of at most ${DICTATION_BUDGET.frameBytes} bytes`, false)); return; }
    if (this.samples >= MAX_SAMPLES) return;
    // A copy on its own buffer: the socket's may be pooled, and an Int16Array needs even alignment.
    const pcm = new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    this.samples += pcm.length;
    this.touch();
    if (!this.session) this.pending.push(pcm);
    // A recognizer is a plugin's code: what it throws ends this dictation, not the server.
    else try { this.session.append(pcm); } catch (error) { this.fail(error, 'RECOGNIZER_FAILED', false); return; }
    // The longest recording: finished as if the user had stopped, so nothing said so far is lost.
    if (this.samples >= MAX_SAMPLES) {
      if (this.state === 'open') void this.finish(); else this.finishRequested = true;
    }
  }

  private async finish(): Promise<void> {
    if (this.state !== 'open' || !this.session) return;
    this.state = 'finishing';
    clearTimeout(this.idleTimer);
    try {
      // A recognizer that never answers fails the dictation rather than holding the client's spinner.
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DictationError('TRANSCRIPTION_FAILED', 'Transcription took too long', true)), DICTATION_BUDGET.finishTimeoutMs);
      });
      const text = await Promise.race([this.session.finish(), timeout]).finally(() => clearTimeout(timer));
      if (this.state !== 'finishing') return;
      this.send({ type: 'final', text: typeof text === 'string' ? text.trim() : '' });
      this.end(1000, 'Done');
    } catch (error) {
      this.fail(error, 'TRANSCRIPTION_FAILED', true);
    }
  }

  /** No audio for `idleTimeoutMs`: a client that went away without closing is finished like one that stopped. */
  private touch(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.state === 'open') void this.finish();
      else if (this.state === 'opening') this.finishRequested = true;
    }, DICTATION_BUDGET.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private fail(error: unknown, code = 'DICTATION_FAILED', retryable = false): void {
    if (this.state === 'done') return;
    const known = error instanceof DictationError ? error : undefined;
    const statusCode = (error as { statusCode?: unknown } | undefined)?.statusCode;
    // A plugin's own refusal (`host.error`, below 500) is shown as it said it.
    const pluginCode = !known && typeof (error as { code?: unknown })?.code === 'string' && typeof statusCode === 'number' && statusCode < 500 ? (error as { code: string }).code : undefined;
    const message = error instanceof Error ? error.message : String(error);
    this.send({ type: 'error', code: known?.code ?? pluginCode ?? code, message: message.slice(0, 500), retryable: known?.retryable ?? retryable });
    this.end(1000, 'Failed');
  }

  private send(message: DictationServerMessage): void { try { this.socket.send(JSON.stringify(message)); } catch { /* the socket is closing */ } }

  private end(code: number, reason: string): void {
    if (this.state === 'done') return;
    this.state = 'done';
    this.dispose();
    try { this.socket.close(code, reason); } catch { /* already closed */ }
  }

  private dispose(): void {
    clearTimeout(this.idleTimer);
    this.controller.abort();
    this.releaseSignal?.();
    this.releaseSignal = undefined;
    this.pending = [];
    this.session = undefined;
  }
}
