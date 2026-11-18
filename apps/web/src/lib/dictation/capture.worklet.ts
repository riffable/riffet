/**
 * Runs on the audio thread (docs/VOICE.md §7): averages the microphone down to 16 kHz mono PCM16 and posts one 100 ms frame at
 * a time, with its loudness, to the page. Averaging each output sample's span of input is the low-pass that keeps speech
 * frequencies and drops what 16 kHz cannot carry; recognizers need nothing finer.
 */

declare const sampleRate: number;
declare function registerProcessor(name: string, processor: new () => unknown): void;
declare class AudioWorkletProcessor { readonly port: MessagePort; }

const TARGET_RATE = 16_000;
const FRAME_SAMPLES = TARGET_RATE / 10;

class DictationCapture extends AudioWorkletProcessor {
  private readonly step = sampleRate / TARGET_RATE;
  private frame = new Int16Array(FRAME_SAMPLES);
  private filled = 0;
  /** Input samples summed toward the next output sample, and how much of the span they cover. */
  private sum = 0;
  private span = 0;
  private squares = 0;

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0];
    const first = channels?.[0];
    if (!first) return true;
    for (let i = 0; i < first.length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] ?? 0;
      this.sum += value / channels.length;
      this.span += 1;
      if (this.span < this.step) continue;
      const sample = Math.max(-1, Math.min(1, this.sum / this.span));
      this.sum = 0; this.span -= this.step;
      this.frame[this.filled++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      this.squares += sample * sample;
      if (this.filled === FRAME_SAMPLES) {
        const level = Math.sqrt(this.squares / FRAME_SAMPLES);
        this.port.postMessage({ pcm: this.frame.buffer, level }, [this.frame.buffer]);
        this.frame = new Int16Array(FRAME_SAMPLES);
        this.filled = 0; this.squares = 0;
      }
    }
    return true;
  }
}

registerProcessor('riffet-dictation-capture', DictationCapture);
