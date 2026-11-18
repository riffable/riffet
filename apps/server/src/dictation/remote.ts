import type { SpeechRecognizer, SpeechSession } from '@riffet/plugin-api';
import { DICTATION_BUDGET, DICTATION_SAMPLE_RATE } from '../../../../packages/contracts/src/index.js';
import { endpoint, modelRequest } from '../auxiliary/gateway.js';
import { DictationError } from './errors.js';

export interface RemoteSpeechConfig { baseUrl?: string; model?: string; apiKey?: string }

/** Samples a recording may hold: the rest of the audio past `DICTATION_BUDGET.maxDurationMs` is not kept. */
const MAX_SAMPLES = DICTATION_BUDGET.maxDurationMs / 1000 * DICTATION_SAMPLE_RATE;

/**
 * An OpenAI-format `/v1/audio/transcriptions` service (docs/VOICE.md §3): the audio is kept until `finish` and sent as one
 * WAV file, so nothing is shown while the user speaks. `config` is read on each dictation, so a saved change applies to the next.
 */
export function remoteRecognizer(config: () => RemoteSpeechConfig, fetchImpl: typeof fetch = fetch): SpeechRecognizer {
  return {
    status() {
      const { baseUrl, model } = config();
      return baseUrl && model ? { ready: true, streaming: false } : { ready: false, reason: 'Set the transcription service address and model in 语音输入 settings' };
    },
    open({ language, signal }): SpeechSession {
      const { baseUrl, model, apiKey } = config();
      if (!baseUrl || !model) throw new DictationError('RECOGNIZER_NOT_READY', 'The transcription service is not set up', false);
      const chunks: Int16Array[] = [];
      let samples = 0;
      return {
        append(pcm) {
          if (samples >= MAX_SAMPLES) return;
          const kept = pcm.length > MAX_SAMPLES - samples ? pcm.slice(0, MAX_SAMPLES - samples) : pcm;
          chunks.push(kept); samples += kept.length;
        },
        async finish() {
          if (!samples) return '';
          const form = new FormData();
          form.append('file', new Blob([wav(chunks, samples)], { type: 'audio/wav' }), 'dictation.wav');
          form.append('model', model);
          form.append('response_format', 'json');
          if (language) form.append('language', language);
          chunks.length = 0;
          const timeout = AbortSignal.timeout(DICTATION_BUDGET.remoteTimeoutMs);
          let response: Response;
          try {
            response = await modelRequest(endpoint(baseUrl, 'audio/transcriptions'), {
              method: 'POST', body: form, headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.any([signal, timeout]),
            }, fetchImpl);
          } catch (error) {
            if (signal.aborted) throw error;
            const message = timeout.aborted ? 'The transcription service did not answer in time' : `The transcription service could not be reached: ${(error as Error).message}`;
            throw new DictationError('TRANSCRIPTION_FAILED', message, true);
          }
          const body = await response.text();
          if (!response.ok) {
            const reason = errorText(body) ?? `HTTP ${response.status}`;
            throw new DictationError('TRANSCRIPTION_FAILED', `The transcription service refused the audio: ${reason}`, response.status === 429 || response.status >= 500);
          }
          let text: unknown;
          try { text = (JSON.parse(body) as { text?: unknown }).text; } catch { text = undefined; }
          if (typeof text !== 'string') throw new DictationError('TRANSCRIPTION_FAILED', 'The transcription service answered without text', false);
          return text.trim();
        },
      };
    },
  };
}

/** The service's own reason, from an OpenAI-style `{ error: { message } }` or a short plain body. */
function errorText(body: string): string | undefined {
  try {
    const value = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const message = typeof value.error === 'string' ? value.error : value.error?.message ?? value.message;
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 300);
  } catch { /* not JSON */ }
  const text = body.trim();
  return text && text.length <= 300 ? text : undefined;
}

/** 16 kHz mono PCM16 as a WAV file. */
function wav(chunks: Int16Array[], samples: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const ascii = (at: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, DICTATION_SAMPLE_RATE, true); view.setUint32(28, DICTATION_SAMPLE_RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, samples * 2, true);
  let at = 44;
  for (const chunk of chunks) for (const sample of chunk) { view.setInt16(at, sample, true); at += 2; }
  return buffer;
}
