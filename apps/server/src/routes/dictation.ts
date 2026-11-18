import type { FastifyInstance } from 'fastify';
import { DICTATION_BUDGET, DICTATION_ROUTE, REMOTE_SPEECH_RECOGNIZER } from '../../../../packages/contracts/src/index.js';
import { DictationConnection, type ResolvedRecognizer } from '../dictation/connection.js';
import { DictationError } from '../dictation/errors.js';
import { remoteRecognizer } from '../dictation/remote.js';
import type { RouteDeps } from './deps.js';

/**
 * 语音输入 (docs/VOICE.md §4). The user is checked by the API hook; a revoked login closes the socket. Dictation belongs to no
 * conversation. The recognizer is the one 语音输入 settings name at the moment a dictation starts.
 */
export function registerDictationRoutes(app: FastifyInstance, { auth, settings, plugins }: RouteDeps): void {
  const remote = remoteRecognizer(() => settings.remoteSpeech());
  let open = 0;
  const resolve = async (): Promise<ResolvedRecognizer> => {
    const id = settings.getSettings().voiceInput?.recognizer;
    if (!id) throw new DictationError('DICTATION_OFF', 'Voice input is off', false);
    let owned: { recognizer: ResolvedRecognizer['recognizer']; signal?: AbortSignal } | undefined;
    if (id === REMOTE_SPEECH_RECOGNIZER) owned = { recognizer: remote };
    else {
      owned = plugins.speechRecognizer(id);
      if (!owned) throw new DictationError('RECOGNIZER_UNAVAILABLE', plugins.declaresSpeechRecognizer(id) ? `${id} is turned off` : `${id} is not installed`, false);
    }
    const status = await owned.recognizer.status();
    if (!status.ready) throw new DictationError('RECOGNIZER_NOT_READY', status.reason, false);
    return { ...owned, streaming: status.streaming };
  };
  app.get(DICTATION_ROUTE, { websocket: true }, (socket, request) => {
    if (open >= DICTATION_BUDGET.maxConnectionsPerUser) { socket.close(1013, 'Too many dictations at once'); return; }
    open++;
    const connection = new DictationConnection({
      send: text => { if (socket.readyState === 1) socket.send(text); },
      close: (code, reason) => socket.close(code, reason),
      get bufferedAmount() { return socket.bufferedAmount; },
    }, { resolve, language: () => settings.getSettings().voiceInput?.language });
    const unwatch = auth.onRevoke(request, () => socket.terminate());
    socket.once('close', () => { open--; unwatch(); connection.closed(); });
    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[], binary: boolean) => {
      connection.message(Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw), binary);
    });
  });
}
