import { describe, expect, it } from 'vitest';
import {
  decodeClientBinaryFrame,
  encodeOutputFrame,
  encodePingFrame,
  encodeSnapshotFrame,
} from '../../../../server/src/terminal/wire.js';
import { decodeServerBinaryFrame, encodeInputFrame, encodePongFrame } from './wire';

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

describe('web terminal protocol=4 binary wire contract', () => {
  it('round-trips output, raw/deflate snapshot, input, and ping/pong with server wire', () => {
    const out = encodeOutputFrame(42, 'stream-1', 'hello 世界 🚀\r\n');
    expect(decodeServerBinaryFrame(toArrayBuffer(out))).toEqual({
      type: 'output',
      sequence: 42,
      streamId: 'stream-1',
      data: 'hello 世界 🚀\r\n',
    });

    const smallSnap = encodeSnapshotFrame(7, 120, 40, 'stream-1', '\x1bcsmall');
    expect(decodeServerBinaryFrame(toArrayBuffer(smallSnap))).toEqual({
      type: 'snapshot',
      sequence: 7,
      cols: 120,
      rows: 40,
      streamId: 'stream-1',
      data: '\x1bcsmall',
    });

    const bigPayload = '\x1bc' + 'line of terminal scrollback 中文测试\r\n'.repeat(300);
    const compressedSnap = encodeSnapshotFrame(8, 132, 48, 'stream-2', bigPayload);
    expect(compressedSnap[0]).toBe(0x03);
    expect(decodeServerBinaryFrame(toArrayBuffer(compressedSnap))).toEqual({
      type: 'snapshot',
      sequence: 8,
      cols: 132,
      rows: 48,
      streamId: 'stream-2',
      data: bigPayload,
    });

    const ping = encodePingFrame(1_732_000_000_123);
    expect(decodeServerBinaryFrame(toArrayBuffer(ping))).toEqual({
      type: 'ping',
      timestamp: 1_732_000_000_123,
    });

    const pong = encodePongFrame(1_732_000_000_123);
    expect(decodeClientBinaryFrame(Buffer.from(pong))).toEqual({
      type: 'pong',
      timestamp: 1_732_000_000_123,
    });

    const input = encodeInputFrame('web-client-1', 19, 'ls -la\r');
    expect(decodeClientBinaryFrame(Buffer.from(input))).toEqual({
      type: 'input',
      clientId: 'web-client-1',
      epoch: 19,
      data: 'ls -la\r',
    });
  });

  it('rejects truncated or corrupted compressed frames without throwing', () => {
    expect(decodeServerBinaryFrame(new ArrayBuffer(0))).toBeUndefined();
    const corrupt = new Uint8Array([0x03, 0, 0, 0, 1, 0, 80, 0, 24, 1, 0x61, 0xff, 0xff, 0xff]);
    expect(decodeServerBinaryFrame(corrupt.buffer)).toBeUndefined();
  });
});
