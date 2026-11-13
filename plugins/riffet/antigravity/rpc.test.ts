import { createServer, type RequestListener, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AgyFrameDecoder, AgyRpc } from './rpc.js';
import { agySnapshot, applyAgyUpdate, type AgySnapshot } from './protocol.js';

const cid = '11111111-1111-1111-1111-111111111111';
const tid = '22222222-2222-2222-2222-222222222222';
function frame(value: unknown, flag = 0): Buffer {
  const bytes = value === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value));
  const result = Buffer.alloc(5 + bytes.length);
  result[0] = flag;
  result.writeUInt32BE(bytes.length, 1);
  bytes.copy(result, 5);
  return result;
}
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise<void>(resolve => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
async function listen(handler: RequestListener): Promise<AgyRpc> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return new AgyRpc({ port: (server.address() as { port: number }).port, token: 'private-csrf' });
}
describe('Antigravity Connect protocol', () => {
  it('reassembles fragmented messages and recognizes both trailer shapes', () => {
    for (const trailer of [{}, undefined]) {
      const messages: unknown[] = [];
      const decoder = new AgyFrameDecoder(message => messages.push(message));
      const bytes = Buffer.concat([frame({ update: { conversationId: cid, text: '中文正文' } }), frame(trailer, 2)]);
      for (let i = 0; i < bytes.length; i++) decoder.push(bytes.subarray(i, i + 1));
      decoder.finish();
      expect(messages).toEqual([{ update: { conversationId: cid, text: '中文正文' } }]);
      expect(() => decoder.push(frame({}))).toThrow('after its trailer');
    }
  });
  it('rejects unsupported, incomplete, oversized and failed frames without exposing native secrets', () => {
    const decode = (bytes: Buffer) => {
      const decoder = new AgyFrameDecoder(() => {});
      decoder.push(bytes);
      decoder.finish();
    };
    expect(() => decode(frame({}, 1))).toThrow('encoding');
    expect(() => decode(frame({}, 4))).toThrow('encoding');
    expect(() => decode(frame({}).subarray(0, 4))).toThrow('partial');
    expect(() => decode(frame({}).subarray(0, 6))).toThrow('partial');
    expect(() => decode(frame({}))).toThrow('without a trailer');
    const huge = Buffer.alloc(5);
    huge.writeUInt32BE(256 * 1024 * 1024 + 1, 1);
    expect(() => decode(huge)).toThrow('exceeds');
    expect(() => decode(Buffer.from([0, 0, 0, 0, 1, 0xff]))).toThrow('invalid');
    try {
      decode(frame({ error: { code: 'private-provider-key', message: 'private-provider-key' } }, 2));
    } catch (error) {
      expect(String(error)).not.toContain('private-provider-key');
    }
  });
  it('uses only its configured loopback listener and authenticated service path', async () => {
    const rpc = await listen(async (req, res) => {
      expect(req.url).toBe('/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory');
      expect(req.headers['x-codeium-csrf-token']).toBe('private-csrf');
      let body = '';
      for await (const bytes of req) body += bytes;
      expect(JSON.parse(body)).toEqual({ cascadeId: cid });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ trajectory: { cascadeId: cid, trajectoryId: tid, steps: [] } }));
    });
    expect((await rpc.snapshot(cid)).trajectoryId).toBe(tid);
    expect(JSON.stringify(rpc)).not.toContain('private-csrf');
    await expect(rpc.call('../GetCascadeTrajectory', {})).rejects.toThrow('method');
  });
  it('validates framed stream identity and handles clean completion and cancellation', async () => {
    let abortSeen!: () => void;
    const aborted = new Promise<void>(resolve => {
      abortSeen = resolve;
    });
    let requests = 0;
    const rpc = await listen(async (req, res) => {
      expect(req.headers['content-type']).toBe('application/connect+json');
      const chunks: Buffer[] = [];
      for await (const bytes of req) chunks.push(Buffer.from(bytes));
      const body = Buffer.concat(chunks);
      expect(body.readUInt32BE(1)).toBe(body.length - 5);
      expect(JSON.parse(body.subarray(5).toString())).toEqual({ conversationId: cid });
      res.setHeader('Content-Type', 'application/connect+json');
      res.write(frame({ update: { conversationId: cid, trajectoryId: tid } }));
      if (++requests === 1) res.end(frame({}, 2));
      else res.once('close', abortSeen);
    });
    const updates: unknown[] = [];
    await rpc.stream(cid, update => updates.push(update), new AbortController().signal);
    expect(updates).toEqual([{ conversationId: cid, trajectoryId: tid }]);
    const controller = new AbortController();
    await expect(rpc.stream(cid, () => controller.abort(), controller.signal)).rejects.toThrow();
    await aborted;
  });
  it('rejects cross-conversation streams and redacts HTTP failure bodies', async () => {
    let requests = 0;
    const rpc = await listen((_req, res) => {
      if (++requests === 1) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'permission_denied', message: 'secret-gateway-key' }));
      } else {
        res.setHeader('Content-Type', 'application/connect+json');
        res.end(Buffer.concat([frame({ update: { conversationId: tid } }), frame({}, 2)]));
      }
    });
    await expect(rpc.call('Denied', {})).rejects.toMatchObject({
      status: 403,
      message: 'Antigravity RPC rejected the request (permission_denied)',
    });
    await expect(rpc.stream(cid, () => {}, new AbortController().signal)).rejects.toThrow('another conversation');
  });
});
describe('Antigravity trajectory updates', () => {
  const base = (): AgySnapshot => ({
    conversationId: cid,
    trajectoryId: tid,
    steps: [{ id: 'ancestor' }, { id: 'reply', plannerResponse: { response: 'a' } }],
    executors: [],
  });
  it('applies indexed patches and rewinds without renumbering ancestor source identities', () => {
    const original = base();
    const patched = applyAgyUpdate(original, {
      conversationId: cid,
      trajectoryId: tid,
      mainTrajectoryUpdate: {
        stepsUpdate: { indices: [1], steps: [{ id: 'reply', plannerResponse: { response: 'abc' } }], totalLength: 2 },
      },
    })!;
    expect(patched.steps[0]).toBe(original.steps[0]);
    expect(original.steps[1]!.plannerResponse.response).toBe('a');
    expect(patched.steps[1]!.plannerResponse.response).toBe('abc');
    expect(
      applyAgyUpdate({ ...patched, fullyIdle: true }, { conversationId: cid, trajectoryId: tid, status: 'CASCADE_RUN_STATUS_RUNNING' })!
        .fullyIdle,
    ).toBe(false);
    expect(
      applyAgyUpdate(patched, {
        conversationId: cid,
        trajectoryId: cid,
        mainTrajectoryUpdate: { stepsUpdate: { indices: [0], steps: [original.steps[0]], totalLength: 1 } },
      })!.steps,
    ).toEqual([original.steps[0]]);
    expect(() => applyAgyUpdate(patched, { conversationId: cid, trajectoryId: cid })).toThrow('baseline');
  });
  it('rejects partial baselines, duplicate indices and foreign snapshots', () => {
    const patch = {
      conversationId: cid,
      trajectoryId: tid,
      mainTrajectoryUpdate: { stepsUpdate: { indices: [1], steps: [{}], totalLength: 2 } },
    };
    expect(() => applyAgyUpdate(undefined, patch)).toThrow('baseline');
    expect(() =>
      applyAgyUpdate(base(), { ...patch, mainTrajectoryUpdate: { stepsUpdate: { indices: [1, 1], steps: [{}, {}], totalLength: 2 } } }),
    ).toThrow('index');
    expect(() => applyAgyUpdate(base(), { conversationId: tid, trajectoryId: tid })).toThrow('conversation');
    expect(() => agySnapshot({ trajectory: { cascadeId: tid, trajectoryId: tid, steps: [] } }, cid)).toThrow('conversation');
    expect(() => agySnapshot({ trajectory: { cascadeId: cid, trajectoryId: tid, steps: [] }, numTotalSteps: 1 }, cid)).toThrow(
      'incomplete',
    );
  });
});
