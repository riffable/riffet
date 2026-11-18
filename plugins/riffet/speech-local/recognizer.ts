// The recognizer the core calls (docs/VOICE.md §3) and the one worker process behind it (§5).
//
// Process ownership (docs/guide/performance.md): the plugin owns the worker. It starts on the first `open()`, serves every
// dictation at once, exits after `DICTATION_BUDGET.workerIdleMs` without one, and is killed when the plugin turns off or the
// engine or a model is removed. If it dies, the open dictations fail and the server carries on.

import { spawn, type ChildProcess } from 'node:child_process';
import { DICTATION_BUDGET } from '@contracts';
import type { PluginHost, SpeechRecognizer, SpeechRecognizerStatus, SpeechSegment, SpeechSession, SpeechSessionOptions } from '@riffet/plugin-api';
import type { Installer } from './install.js';
import { MODELS, type ModelId } from './pins.js';
import { WORKER_SOURCE } from './worker.js';

const SAMPLE_RATE = 16_000;
const CJK = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

/** One space between Latin words, none beside CJK text. */
export function joinSegments(segments: readonly SpeechSegment[]): string {
  let text = '';
  for (const segment of segments) {
    const part = segment.text.trim();
    if (!part) continue;
    if (text && !CJK.test(text.slice(-1)) && !CJK.test(part[0]!)) text += ' ';
    text += part;
  }
  return text;
}

interface Pending {
  readonly onPartial: (segments: SpeechSegment[]) => void;
  samples: number;
  waiter?: { resolve(text: string): void; reject(error: Error): void };
  failure?: Error;
}

type WorkerMessage =
  | { t: 'partial' | 'final'; id: number; segments: SpeechSegment[] }
  | { t: 'error'; id: number; message: string };

export class LocalRecognizer implements SpeechRecognizer {
  private child?: ChildProcess;
  private stderr = '';
  private idleTimer?: ReturnType<typeof setTimeout>;
  /** The worker being started: two dictations opening at once share it rather than start two. */
  private spawning?: Promise<ChildProcess>;
  /** The models changed while the worker was busy: it restarts as soon as its last dictation ends. */
  private stale = false;
  private nextId = 1;
  private readonly sessions = new Map<number, Pending>();

  constructor(private readonly host: PluginHost, private readonly installer: Installer) {}

  async status(): Promise<SpeechRecognizerStatus> {
    if (!await this.installer.engineInstalled()) return { ready: false, reason: 'Local speech recognition: the engine is not installed' };
    const installed = await this.installedModels();
    if (installed.length === 0) return { ready: false, reason: 'Local speech recognition: no model is downloaded' };
    return { ready: true, streaming: installed.includes('zipformer') };
  }

  async open(options: SpeechSessionOptions): Promise<SpeechSession> {
    const status = await this.status();
    if (!status.ready) throw this.host.error('SPEECH_NOT_READY', status.reason, 409);
    const child = await this.worker();
    const id = this.nextId++;
    const pending: Pending = { onPartial: options.onPartial, samples: 0 };
    this.sessions.set(id, pending);
    clearTimeout(this.idleTimer);
    child.send({ t: 'open', id, language: options.language });

    const release = () => {
      this.sessions.delete(id);
      this.scheduleIdle();
    };
    const abort = () => {
      if (!this.sessions.has(id)) return;
      this.child?.send({ t: 'abort', id });
      release();
      fail(pending, new Error('aborted'));
    };
    if (options.signal.aborted) abort();
    else options.signal.addEventListener('abort', abort, { once: true });

    const limit = (DICTATION_BUDGET.maxDurationMs / 1000) * SAMPLE_RATE;
    return {
      append: (pcm) => {
        if (!this.sessions.has(id) || pending.samples >= limit) return;
        pending.samples += pcm.length;
        // A view onto a larger buffer would copy all of it across the channel.
        this.child?.send({ t: 'audio', id, pcm: pcm.byteLength === pcm.buffer.byteLength ? pcm : pcm.slice() });
      },
      finish: () => new Promise<string>((resolve, reject) => {
        if (pending.failure) return reject(pending.failure);
        if (!this.sessions.has(id)) return reject(new Error('aborted'));
        pending.waiter = { resolve: (text) => { options.signal.removeEventListener('abort', abort); resolve(text); }, reject };
        this.child?.send({ t: 'finish', id });
      }),
    };
  }

  /** Ends the worker now and fails what it was doing. */
  stop(reason = 'Local speech recognition stopped'): void {
    clearTimeout(this.idleTimer);
    this.stale = false;
    const child = this.child;
    this.child = undefined;
    child?.removeAllListeners();
    child?.on('error', () => undefined);
    child?.kill();
    this.failAll(this.host.error('SPEECH_STOPPED', reason, 409));
  }

  /** After a download finished: an idle worker restarts with the new set; a busy one keeps its own until its last dictation ends. */
  refresh(): void {
    if (this.sessions.size === 0) this.stop('Local speech recognition changed');
    else this.stale = true;
  }

  private async installedModels(): Promise<ModelId[]> {
    const installed: ModelId[] = [];
    for (const pin of MODELS) if (await this.installer.modelInstalled(pin.id)) installed.push(pin.id);
    return installed;
  }

  private worker(): Promise<ChildProcess> {
    if (this.child) return Promise.resolve(this.child);
    return this.spawning ??= this.spawn().finally(() => { this.spawning = undefined; });
  }

  private async spawn(): Promise<ChildProcess> {
    const models = await this.installedModels();
    const dir = (id: ModelId) => (models.includes(id) ? this.installer.modelDir(MODELS.find(pin => pin.id === id)!) : undefined);
    this.stderr = '';
    const child = spawn(process.execPath, ['-e', WORKER_SOURCE], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced' });
    child.stderr?.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-2_000); });
    child.on('message', (message: WorkerMessage) => this.onMessage(message));
    child.on('error', error => this.crashed(child, error.message));
    child.on('exit', (code, signal) => this.crashed(child, `exited with ${signal ?? code}`));
    child.send({
      t: 'init', engine: this.installer.engineDir(), zipformer: dir('zipformer'), sensevoice: dir('sensevoice'),
      maxSamples: (DICTATION_BUDGET.maxDurationMs / 1000) * SAMPLE_RATE,
    });
    this.child = child;
    return child;
  }

  private crashed(child: ChildProcess, what: string): void {
    if (this.child !== child) return;
    this.child = undefined;
    clearTimeout(this.idleTimer);
    this.host.logger?.warn(`speech worker ${what}: ${this.stderr.trim()}`);
    this.failAll(this.host.error('SPEECH_WORKER_FAILED', 'Local speech recognition stopped unexpectedly', 500));
  }

  private failAll(error: Error): void {
    for (const pending of this.sessions.values()) fail(pending, error);
    this.sessions.clear();
  }

  private onMessage(message: WorkerMessage): void {
    const pending = this.sessions.get(message.id);
    if (!pending) return;
    if (message.t === 'partial') return pending.onPartial(message.segments);
    this.sessions.delete(message.id);
    this.scheduleIdle();
    if (message.t === 'final') pending.waiter?.resolve(joinSegments(message.segments));
    else if (message.t === 'error') {
      this.host.logger?.warn(`speech worker: ${message.message}`);
      fail(pending, this.host.error('SPEECH_FAILED', 'Local speech recognition failed', 500));
    }
  }

  private scheduleIdle(): void {
    if (this.sessions.size > 0 || !this.child) return;
    if (this.stale) return this.stop('Local speech recognition changed');
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop('Local speech recognition is idle'), DICTATION_BUDGET.workerIdleMs);
    this.idleTimer.unref();
  }
}

function fail(pending: Pending, error: Error): void {
  pending.failure = error;
  pending.waiter?.reject(error);
}
