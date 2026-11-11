import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SyncFrame, TimelineRow } from '../../../../packages/contracts/src/sync.js';
import { SyncConnection, type SyncConnectionOptions } from './connection.js';

/* The backlog limits of a sync stream (docs/SYNC-V3.md, 预算): a reader that takes nothing is let go. */

const KB = 1024, MB = 1024 * KB;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

/** A stream to a client that never reads what it is sent. */
async function stalled(options: SyncConnectionOptions) {
  let connection: SyncConnection | undefined;
  const server = createServer((_request, response) => { connection = new SyncConnection(response, options); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let closed = false;
  const request = httpRequest({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: '/' }, response => {
    response.pause();
    response.on('close', () => { closed = true; });
  });
  request.on('error', () => { closed = true; });
  request.end();
  cleanups.push(() => { request.destroy(); server.closeAllConnections(); server.close(); });
  await vi.waitFor(() => expect(connection).toBeDefined());
  return { connection: connection!, get closed() { return closed; } };
}

/** A rows frame of about `bytes` that gzip could not shrink. */
const rows = (seq: number, bytes: number): Extract<SyncFrame, { type: 'rows' }> =>
  ({ type: 'rows', generation: 'g', from: seq, to: seq, upserts: [{ key: `row:${seq}`, text: randomBytes(bytes * 3 / 4).toString('base64') } as unknown as TimelineRow] });

describe('sync stream backlog', () => {
  it('ends the stream at once when what it holds passes the ceiling', async () => {
    const stream = await stalled({ gzip: false, maxBacklog: 2 * MB });
    for (let seq = 1; seq <= 20 && !stream.connection.ended; seq += 1) stream.connection.rows(rows(seq, 200 * KB));
    expect(stream.connection.ended).toBe(true);
    await vi.waitFor(() => expect(stream.closed).toBe(true));
  });

  it('ends the stream of a reader still over the slow limit a heartbeat later', async () => {
    const stream = await stalled({ gzip: false, slowBacklog: 2 * MB, pingMs: 50 });
    for (let seq = 1; seq <= 80; seq += 1) stream.connection.rows(rows(seq, 200 * KB));
    expect(stream.connection.ended).toBe(false);
    await vi.waitFor(() => expect(stream.connection.ended).toBe(true), { timeout: 3_000, interval: 10 });
  });
});
