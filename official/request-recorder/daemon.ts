// The proxy process of one conversation. It owns only the proxy: the CLI stays directly detached from Riffet.
// It ends when the CLI is gone, when it is told to, or when nothing ever bound to it.

import { timingSafeEqual } from 'node:crypto';
import { lstat, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { createProxyHandler } from './proxy.js';
import { Recordings } from './recorder.js';
import { BIND_GRACE_MS, IDLE_EXIT_MS, LIVENESS_MS, PROTOCOL, processIdentity, writeDescriptor, type Descriptor } from './process.js';

async function main(path: string): Promise<void> {
  const directory = dirname(path);
  const [file, dir] = await Promise.all([lstat(path), lstat(directory)]);
  if (!file.isFile() || file.isSymbolicLink() || !dir.isDirectory() || dir.isSymbolicLink() || (file.mode & 0o077) || (dir.mode & 0o077) ||
      (process.getuid && (file.uid !== process.getuid() || dir.uid !== process.getuid()))) throw new Error('Invalid private recorder storage');
  const descriptor = JSON.parse(await readFile(path, 'utf8')) as Descriptor;
  if (descriptor.version !== PROTOCOL || !/^[a-f0-9]{32}$/.test(descriptor.id) || !/^[a-f0-9]{64}$/.test(descriptor.controlToken) || !/^[a-f0-9]{48}$/.test(descriptor.proxyToken)) {
    throw new Error('Invalid recorder descriptor');
  }
  const store = new Recordings(descriptor.recordDir);
  const started = Date.now();
  let count = 0;
  let lastRequest = Date.now();
  let stopped = false;
  let persistence = Promise.resolve();
  const persist = () => { persistence = persistence.catch(() => undefined).then(() => writeDescriptor(path, descriptor)); return persistence; };

  const proxy = createProxyHandler({
    upstream: new URL(descriptor.upstream), prefix: `/${descriptor.proxyToken}`, sessionId: descriptor.sessionId, store,
    paused: () => descriptor.paused, onRecorded: () => { count += 1; },
  });
  const authorized = (req: IncomingMessage) => {
    const given = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${descriptor.controlToken}`);
    return given.length === expected.length && timingSafeEqual(given, expected) && req.headers['x-riffet-recorder-boot'] === descriptor.bootId;
  };
  const send = (res: ServerResponse, code: number) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ version: descriptor.version, id: descriptor.id, bootId: descriptor.bootId, sessionId: descriptor.sessionId,
      fingerprint: descriptor.fingerprint, status: { paused: descriptor.paused, count }, nativeAddress: descriptor.native?.address }));
  };
  const server = createServer((req, res) => {
    if (!req.url?.startsWith('/__control/')) { lastRequest = Date.now(); proxy(req, res); return; }
    if (req.method !== 'POST' || !authorized(req)) { res.writeHead(401).end(); return; }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; if (body.length > 4096) req.destroy(); });
    req.on('end', () => void (async () => {
      try {
        const input = body ? JSON.parse(body) as Record<string, unknown> : {};
        const method = req.url!.slice('/__control/'.length);
        if (method === 'pause' && typeof input.paused === 'boolean') { descriptor.paused = input.paused; await persist(); }
        else if (method === 'bind' && typeof input.address === 'string') {
          const pid = typeof input.pid === 'number' ? input.pid : undefined;
          const identity = pid ? await processIdentity(pid) : undefined;
          descriptor.native = { address: input.address, ...(pid ? { pid, ...(identity ? { identity } : {}) } : {}),
            ...(typeof input.nativeSessionId === 'string' ? { nativeSessionId: input.nativeSessionId } : {}) };
          await persist();
        } else if (method === 'stop') { send(res, 200); void shutdown(); return; }
        else if (method !== 'status') { res.writeHead(404).end(); return; }
        send(res, 200);
      } catch { res.writeHead(400).end(); }
    })());
  });

  const check = setInterval(() => void (async () => {
    const native = descriptor.native;
    if (!native) { if (Date.now() - started > BIND_GRACE_MS) await shutdown(); return; }
    if (native.pid) {
      // Unknown this time (`ps` failed) is not gone; an identity not read at bind is taken from the first answer.
      const identity = await processIdentity(native.pid);
      if (identity === null || (identity && native.identity && identity !== native.identity)) await shutdown();
      else if (identity && !native.identity) { native.identity = identity; await persist(); }
    } else if (Date.now() - lastRequest > IDLE_EXIT_MS) await shutdown();
  })(), LIVENESS_MS);
  async function shutdown(): Promise<void> {
    if (stopped) return;
    stopped = true;
    clearInterval(check);
    server.close();
    server.closeIdleConnections();
    // A response still streaming gets a moment; then the daemon goes regardless.
    setTimeout(() => process.exit(0), 2_000).unref();
    await rm(directory, { recursive: true, force: true });
    server.once('close', () => process.exit(0));
    server.closeIdleConnections();
  }
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Recorder did not bind a port');
  descriptor.port = address.port;
  descriptor.daemonPid = process.pid;
  await persist();
}

main(process.argv[2] ?? '').catch(() => process.exit(1));
