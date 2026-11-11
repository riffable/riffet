import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { PiRpcError, PiRpcTransport } from './transport.js';

/** stdin that holds each write until the test releases it, like a full pipe. */
class BackpressureInput extends Writable {
  readonly chunks: string[] = [];
  private readonly callbacks: Array<(error?: Error | null) => void> = [];

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk.toString('utf8'));
    this.callbacks.push(callback);
  }

  release(): void {
    this.callbacks.shift()?.();
  }
}

function transportFor(input: Writable, events: Record<string, unknown>[] = []) {
  const output = new PassThrough();
  const transport = new PiRpcTransport(input, output, {
    onEvent: frame => events.push(frame),
  });
  return { transport, output, events };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('pi RPC JSONL transport', () => {
  it('keeps Unicode line separators inside strings and accepts a CR before LF', async () => {
    const input = new BackpressureInput();
    const { transport, output, events } = transportFor(input);
    try {
      const text = `a\u2028b\u2029c🙂`;
      output.write(`${JSON.stringify({ type: 'message_update', text })}\r\n`);
      output.write('not json\n');
      expect(events).toEqual([{ type: 'message_update', text }]);
    } finally {
      transport.close();
    }
  });

  it('reports a refusal whose error is a plain string', async () => {
    const input = new BackpressureInput();
    const { transport, output } = transportFor(input);
    try {
      const request = transport.request({ type: 'prompt' }, { id: 'x', timeoutMs: 5_000 });
      await tick();
      output.write(`${JSON.stringify({ id: 'x', type: 'response', command: 'prompt', success: false, error: 'provider refused the prompt' })}\n`);
      await expect(request).rejects.toMatchObject({ name: 'PiRpcError', message: 'provider refused the prompt', command: 'prompt' });
    } finally {
      transport.close();
    }
  });

  it('drops a queued frame that timed out before it was written', async () => {
    const input = new BackpressureInput();
    const { transport } = transportFor(input);
    try {
      // The first write holds the pipe; the second is still queued when its timer fires.
      const first = transport.request({ type: 'first' }, { id: 'first', timeoutMs: 10_000 });
      void first.catch(() => undefined);
      const second = transport.request({ type: 'second' }, { id: 'second', timeoutMs: 10 });
      await expect(second).rejects.toMatchObject({ name: 'PiRpcError' });
      input.release();
      await tick();
      expect(input.chunks).toHaveLength(1);
      expect(input.chunks[0]).toContain('"first"');
      expect(input.chunks[0]).not.toContain('"second"');
    } finally {
      transport.close();
    }
  });

  it('rejects every pending write when it closes', async () => {
    const input = new BackpressureInput();
    const { transport } = transportFor(input);
    const writing = transport.send({ type: 'extension_ui_response', id: 'one' });
    await tick();
    const queued = transport.send({ type: 'extension_ui_response', id: 'two' });
    const pendingRequest = transport.request({ type: 'prompt' }, { id: 'pending', timeoutMs: 10_000 });
    transport.close(new PiRpcError('closed for the test'));
    await expect(writing).rejects.toMatchObject({ message: 'closed for the test' });
    await expect(queued).rejects.toMatchObject({ message: 'closed for the test' });
    await expect(pendingRequest).rejects.toMatchObject({ message: 'closed for the test' });
    expect(transport.isClosed).toBe(true);
  });
});
