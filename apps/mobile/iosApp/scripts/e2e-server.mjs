#!/usr/bin/env node
/** Loopback fixture for App-hosted Keychain and preview-isolation checks. */
import http from 'node:http';

const port = Number(process.env.RIFFET_E2E_PORT || 19471);
const token = 'riffet-native-e2e-device-token';
const createdAt = new Date().toISOString();
const project = { id: 'project-e2e', name: 'E2E Workspace', cwd: '/tmp/riffet-e2e-project', createdAt, updatedAt: createdAt };
const settings = { defaultBackendId: 'cursor', defaultMode: 'agent' };
const streams = new Set();
let requests = [];

function json(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

function failure(res, code, message, status) {
  json(res, { error: { code, message } }, status);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    let input = {};
    if (req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      input = raw ? JSON.parse(raw) : {};
    }
    if (path === '/__test/reset' && req.method === 'POST') {
      for (const stream of streams) stream.end();
      requests = [];
      return json(res, { ok: true });
    }
    if (path === '/__test/state') return json(res, { requests });

    const authenticated = req.headers.authorization === `Bearer ${token}`;
    requests.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), body: input, authenticated });
    if (path === '/api/devices/pair' && req.method === 'POST') {
      if (input.code !== '123456') return failure(res, 'INVALID_PAIRING_CODE', 'Invalid fixture pairing code', 400);
      return json(res, { device: { id: 'device-e2e', name: input.name, createdAt }, token });
    }
    if (!authenticated) return failure(res, 'UNAUTHENTICATED', 'A fixture device credential is required', 401);
    if (path === '/api/bootstrap') return json(res, { projects: [project], sessions: [], terminals: [], settings });
    if (path === '/api/auth/status') return json(res, { authenticated: true });
    if (path === '/api/settings') return json(res, settings);
    if (path === '/api/projects') return json(res, [project]);
    if (['/api/sessions', '/api/terminals', '/api/backends'].includes(path)) return json(res, []);
    if (path === '/api/lists/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': ready\n\n');
      streams.add(res);
      const timer = setInterval(() => res.write(': ping\n\n'), 3000);
      res.on('close', () => { clearInterval(timer); streams.delete(res); });
      return;
    }
    failure(res, 'FIXTURE_ROUTE_NOT_IMPLEMENTED', `${req.method} ${path}`, 404);
  } catch (error) {
    failure(res, 'FIXTURE_CONTRACT_ERROR', error.message, 500);
  }
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Riffet core fixture listening at http://127.0.0.1:${server.address().port}\n`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  for (const stream of streams) stream.end();
  server.close();
  server.closeAllConnections();
});
