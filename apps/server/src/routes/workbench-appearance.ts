import type { FastifyInstance } from 'fastify';
import { WORKBENCH_APPEARANCE_BUDGET as budget } from '../../../../packages/contracts/src/budgets.js';
import { localRequest, type Auth } from '../auth.js';
import { AppError } from '../errors.js';
import type { WorkbenchAppearance } from '../riffet-mcp/workbench-appearance.js';

interface WorkbenchAppearanceRoutes {
  auth: Auth;
  workbenchAppearance: WorkbenchAppearance;
  documentProofs: { consume(value: unknown): boolean; issue(): string };
}

export function registerWorkbenchAppearanceRoutes(app: FastifyInstance, { auth, workbenchAppearance, documentProofs }: WorkbenchAppearanceRoutes): void {
  let open = 0;
  app.get('/api/workbench/appearance', {
    websocket: true,
    preValidation: async request => {
      // The global request hook has already checked Origin against the request host.
      const owner = auth.authenticate(request);
      const origin = request.headers.origin;
      // Workbench document proofs depend on the browser enforcing the workbench's opener policy.
      if (!origin || owner.kind !== 'cookie' || (!origin.startsWith('https://') && !localRequest(request))) {
        throw new AppError('WORKBENCH_UNAVAILABLE', 'Open the Riffet Web workbench to use this connection', 403);
      }
    },
  }, (socket, request) => {
    if (open >= budget.connections) { socket.close(1013); return; }
    const cookie = auth.cookie(request);
    if (!cookie) { socket.close(1008); return; }
    open++;
    const authorized = () => socket.readyState === 1 && auth.cookie(request) === cookie;
    let connectionId: string | undefined;
    let awaitingPong = false;
    const terminate = () => {
      if (connectionId) workbenchAppearance.disconnect(connectionId);
      socket.terminate();
    };
    const handshake = setTimeout(terminate, budget.proofMs);
    const heartbeat = setInterval(() => {
      if (!authorized() || awaitingPong) { terminate(); return; }
      awaitingPong = true;
      socket.ping();
    }, budget.pingMs);
    handshake.unref();
    heartbeat.unref();
    const unwatch = auth.onRevoke(request, terminate);
    socket.once('close', () => {
      open--;
      unwatch();
      clearInterval(heartbeat);
      clearTimeout(handshake);
      if (connectionId) workbenchAppearance.disconnect(connectionId);
    });
    socket.on('pong', () => { awaitingPong = false; });
    socket.on('error', terminate);
    socket.on('message', (raw, binary) => {
      if (!authorized() || binary) { terminate(); return; }
      const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (bytes.length > budget.receiptBytes) { terminate(); return; }
      let message: unknown;
      try { message = JSON.parse(bytes.toString('utf8')); } catch { terminate(); return; }
      if (connectionId) { workbenchAppearance.receive(connectionId, message); return; }
      const proof = message && typeof message === 'object' && 'documentProof' in message ? message.documentProof : undefined;
      try {
        if (!documentProofs.consume(proof)) { socket.close(1008); return; }
        connectionId = workbenchAppearance.connect({
          cookie, origin: request.headers.origin!, authorized, terminate,
          send: command => socket.send(JSON.stringify(command)),
        });
        clearTimeout(handshake);
        socket.send(JSON.stringify({ connectionId, nextDocumentProof: documentProofs.issue() }));
      } catch { terminate(); }
    });
  });
  app.addHook('preClose', async () => { workbenchAppearance.close(); });
}
