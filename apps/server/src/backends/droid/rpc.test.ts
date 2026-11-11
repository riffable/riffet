import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { DROID_NO_REPLY, DroidRpcClient } from './rpc.js';

function frame(value: Record<string, unknown>): string {
  return `${JSON.stringify({ jsonrpc: '2.0', factoryApiVersion: '1.0.0', ...value })}\n`;
}

describe('DroidRpcClient', () => {
  it('writes no response for a request settled with DROID_NO_REPLY', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    input.on('data', (chunk: Buffer) => written.push(chunk.toString()));
    const onRequest = vi.fn(async (method: string) => method === 'droid.ask_user' ? DROID_NO_REPLY : { selectedOption: 'proceed_once' });
    new DroidRpcClient(input, output, { onNotification: () => undefined, onRequest });
    output.write(frame({ type: 'request', id: 'a', method: 'droid.ask_user', params: {} }));
    output.write(frame({ type: 'request', id: 'b', method: 'droid.request_permission', params: {} }));
    await vi.waitFor(() => expect(written).toHaveLength(1));
    expect(JSON.parse(written[0]!)).toMatchObject({ type: 'response', id: 'b', result: { selectedOption: 'proceed_once' } });
  });

  it('closes on an oversized line that arrives in one chunk', async () => {
    const output = new PassThrough();
    const onClose = vi.fn();
    const client = new DroidRpcClient(new PassThrough(), output, { onNotification: () => undefined, onRequest: async () => undefined, onClose });
    const pending = client.request('droid.list_tools', {}, { timeoutMs: 5_000 });
    output.write(Buffer.concat([Buffer.alloc(64 * 1024 * 1024 + 1, 0x20), Buffer.from('\n')]));
    await expect(pending).rejects.toThrow('larger than the limit');
    expect(client.isClosed).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
