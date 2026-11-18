import workletUrl from './capture.worklet.ts?worker&url';

/** Why the microphone could not be opened; the composer words each one. */
export type CaptureProblem = 'insecure' | 'unsupported' | 'denied' | 'no-microphone' | 'failed';
export class CaptureError extends Error {
  constructor(readonly problem: CaptureProblem, message: string) { super(message); this.name = 'CaptureError'; }
}

export interface Capture { stop(): void }

/**
 * Opens the microphone and delivers 100 ms frames of 16 kHz mono PCM16 with their loudness (0–1 RMS). Call from the tap that
 * starts dictation: iOS Safari only lets an AudioContext run when it is created or resumed in a user gesture.
 */
export async function startCapture(onFrame: (pcm: ArrayBuffer, level: number) => void): Promise<Capture> {
  if (!window.isSecureContext) throw new CaptureError('insecure', 'The microphone needs HTTPS');
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined') throw new CaptureError('unsupported', 'This browser cannot record audio');
  const context = new AudioContext();
  // Resumed before the first await, while the tap still counts as a gesture.
  const resumed = context.resume();
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (error) {
    void context.close();
    const name = (error as DOMException)?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new CaptureError('denied', 'Microphone access was denied');
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new CaptureError('no-microphone', 'No microphone was found');
    throw new CaptureError('failed', (error as Error)?.message ?? 'The microphone could not be opened');
  }
  try {
    await resumed;
    await context.audioWorklet.addModule(workletUrl);
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, 'riffet-dictation-capture', { numberOfInputs: 1, numberOfOutputs: 1 });
    // Into a muted gain to the destination: Safari only runs a node that something downstream pulls.
    const mute = context.createGain();
    mute.gain.value = 0;
    node.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => onFrame(event.data.pcm, event.data.level);
    source.connect(node).connect(mute).connect(context.destination);
    let stopped = false;
    return {
      stop() {
        if (stopped) return;
        stopped = true;
        node.port.onmessage = null;
        source.disconnect();
        node.disconnect();
        mute.disconnect();
        for (const track of stream.getTracks()) track.stop();
        void context.close();
      },
    };
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    void context.close();
    throw new CaptureError('failed', (error as Error)?.message ?? 'The microphone could not be opened');
  }
}
