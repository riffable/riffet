// The recognition worker's script. It is a string, not a file, so the server's single bundle needs no side file and the
// plugin spawns `node -e` with it; it runs outside the server (docs/VOICE.md §5) and loads sherpa-onnx from the engine
// directory the plugin gives it in `init`. Messages arrive over the IPC channel in order:
//   init   { engine, zipformer?, sensevoice?, maxSamples }   once, first
//   open   { id, language? } · audio { id, pcm: Int16Array } · finish { id } · abort { id }
// and leave as partial { id, segments }, final { id, segments } or error { id, message }.
// Keep this free of backticks and template placeholders: it is a template literal itself.

export const WORKER_SOURCE = String.raw`
'use strict';
const path = require('node:path');
const { createRequire } = require('node:module');

const RATE = 16000;
const PRE_ROLL = Math.round(RATE * 0.3);
const POST_ROLL = Math.round(RATE * 0.2);
// A sentence the detector cuts is at most 20 s; keep the audio it may be cut from.
const HISTORY = RATE * 25;
const KEEP_AHEAD = Math.round(RATE * 0.8);
const LANGUAGES = ['zh', 'en', 'ja', 'ko', 'yue'];
const state = { config: null, sherpa: null, online: null, offline: {}, sessions: new Map() };

function send(message) { if (process.connected) process.send(message); }

function load() {
  if (state.sherpa) return state.sherpa;
  const engine = state.config.engine;
  state.sherpa = createRequire(path.join(engine, 'noop.js'))('sherpa-onnx-node');
  return state.sherpa;
}

function zipformer() {
  if (state.online) return state.online;
  const dir = state.config.zipformer;
  state.online = new (load().OnlineRecognizer)({
    featConfig: { sampleRate: RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: path.join(dir, 'encoder.int8.onnx'), decoder: path.join(dir, 'decoder.onnx'), joiner: path.join(dir, 'joiner.int8.onnx') },
      tokens: path.join(dir, 'tokens.txt'), numThreads: 2, provider: 'cpu', debug: 0,
    },
    decodingMethod: 'greedy_search',
    enableEndpoint: 1, rule1MinTrailingSilence: 2.4, rule2MinTrailingSilence: 1.2, rule3MinUtteranceLength: 20,
  });
  return state.online;
}

function sensevoice(language) {
  if (state.offline[language]) return state.offline[language];
  const dir = state.config.sensevoice;
  state.offline[language] = new (load().OfflineRecognizer)({
    featConfig: { sampleRate: RATE, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: path.join(dir, 'model.int8.onnx'), language: language, useInverseTextNormalization: 1 },
      tokens: path.join(dir, 'tokens.txt'), numThreads: 2, provider: 'cpu', debug: 0,
    },
  });
  return state.offline[language];
}

function decodeSentence(language, samples) {
  const recognizer = sensevoice(language);
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: RATE, samples: samples });
  recognizer.decode(stream);
  return recognizer.getResult(stream).text.trim();
}

function languageOf(hint) {
  const primary = String(hint || '').toLowerCase().split('-')[0];
  return LANGUAGES.indexOf(primary) >= 0 ? primary : 'auto';
}

// The bilingual model spells English in capitals.
function zipText(text) { return text.trim().toLowerCase(); }

function toFloat(pcm) {
  const samples = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
  return samples;
}

function join(chunks) {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const all = new Float32Array(length);
  let at = 0;
  for (const chunk of chunks) { all.set(chunk, at); at += chunk.length; }
  return all;
}

function open(id, hint) {
  const config = state.config;
  const session = {
    id: id, language: languageOf(hint), samples: 0, segments: [], current: '', sent: '', pending: [],
    stream: null, vad: null, history: new Float32Array(0), historyStart: 0, rescore: Boolean(config.zipformer && config.sensevoice),
  };
  if (config.zipformer) session.stream = zipformer().createStream();
  else {
    sensevoice(session.language);
    session.vad = new (load().Vad)({
      sileroVad: { model: path.join(config.engine, 'silero_vad.onnx'), threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, windowSize: 512, maxSpeechDuration: 20 },
      sampleRate: RATE, numThreads: 1, debug: false,
    }, 30);
  }
  state.sessions.set(id, session);
}

function emit(session, kind) {
  const segments = session.segments.slice();
  if (session.current) segments.push({ text: session.current, final: false });
  const key = JSON.stringify(segments);
  if (kind === 'final') return send({ t: 'final', id: session.id, segments: session.segments });
  if (key !== session.sent) { session.sent = key; send({ t: 'partial', id: session.id, segments: segments }); }
}

// The streaming model writes no punctuation. Alone, it gets a comma where a pause ended a sentence and a full stop where the
// recording did: marks that follow pauses, not meaning, but break the run.
function pause(text) {
  if (/\p{P}$/u.test(text)) return text;
  return text + (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u.test(text) ? '\uFF0C' : ',');
}

function close(session) {
  const last = session.segments[session.segments.length - 1];
  if (last) last.text = last.text.replace(/\uFF0C$/, '\u3002').replace(/,$/, '.');
}

function settle(session, text) {
  let result = text;
  if (session.rescore) {
    const audio = join(session.pending);
    if (audio.length > 0) result = decodeSentence(session.language, audio) || pause(text);
  } else result = pause(text);
  session.pending = [];
  if (result) session.segments.push({ text: result, final: true });
}

function pumpStreaming(session) {
  const recognizer = zipformer();
  while (recognizer.isReady(session.stream)) recognizer.decode(session.stream);
  const text = zipText(recognizer.getResult(session.stream).text);
  if (recognizer.isEndpoint(session.stream)) {
    if (text) settle(session, text);
    session.pending = [];
    recognizer.reset(session.stream);
    session.current = '';
  } else {
    session.current = text;
    // Silence before the sentence only confuses the second pass; keep a little ahead of the first word.
    if (!text) trimPending(session);
  }
}

function remember(session, samples) {
  const all = new Float32Array(session.history.length + samples.length);
  all.set(session.history);
  all.set(samples, session.history.length);
  const drop = Math.max(0, all.length - HISTORY);
  session.history = drop > 0 ? all.subarray(drop) : all;
  session.historyStart += drop;
}

function trimPending(session) {
  let length = 0;
  for (const chunk of session.pending) length += chunk.length;
  while (session.pending.length > 1 && length - session.pending[0].length >= KEEP_AHEAD) length -= session.pending.shift().length;
}

function drain(session) {
  const vad = session.vad;
  while (!vad.isEmpty()) {
    const front = vad.front(false);
    vad.pop();
    // The detector starts a sentence a little late and ends it early; hand the recognizer the audio around it.
    const end = session.historyStart + session.history.length;
    const from = Math.max(session.historyStart, front.start - PRE_ROLL);
    const to = Math.min(end, front.start + front.samples.length + POST_ROLL);
    const text = decodeSentence(session.language, session.history.subarray(from - session.historyStart, to - session.historyStart));
    if (text) session.segments.push({ text: text, final: true });
  }
}

function append(session, pcm) {
  const room = state.config.maxSamples - session.samples;
  if (room <= 0) return;
  const frame = pcm.length > room ? pcm.subarray(0, room) : pcm;
  session.samples += frame.length;
  const samples = toFloat(frame);
  if (session.stream) {
    session.stream.acceptWaveform({ sampleRate: RATE, samples: samples });
    if (session.rescore) session.pending.push(samples);
    pumpStreaming(session);
  } else {
    remember(session, samples);
    session.vad.acceptWaveform(samples);
    drain(session);
  }
  emit(session, 'partial');
}

function finish(session) {
  if (session.stream) {
    const recognizer = zipformer();
    session.stream.acceptWaveform({ sampleRate: RATE, samples: new Float32Array(Math.round(RATE * 0.66)) });
    session.stream.inputFinished();
    while (recognizer.isReady(session.stream)) recognizer.decode(session.stream);
    const text = zipText(recognizer.getResult(session.stream).text);
    if (text) settle(session, text);
    if (!session.rescore) close(session);
  } else {
    session.vad.flush();
    drain(session);
  }
  session.current = '';
  emit(session, 'final');
}

process.on('message', function (message) {
  const session = state.sessions.get(message.id);
  try {
    if (message.t === 'init') { state.config = message; return; }
    if (message.t === 'open') return open(message.id, message.language);
    if (message.t === 'abort') { state.sessions.delete(message.id); return; }
    if (!session) return;
    if (message.t === 'audio') append(session, message.pcm);
    else if (message.t === 'finish') { state.sessions.delete(message.id); finish(session); }
  } catch (error) {
    state.sessions.delete(message.id);
    send({ t: 'error', id: message.id, message: String((error && error.message) || error) });
  }
});
process.on('disconnect', function () { process.exit(0); });
`;
