import { inflateSync } from 'fflate';
import { TERMINAL_WIRE_FRAME } from '@contracts';

const { OUTPUT, SNAPSHOT_RAW, SNAPSHOT_DEFLATE, INPUT, PING, PONG } = TERMINAL_WIRE_FRAME;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type DecodedServerBinaryFrame =
  | { type: 'output'; sequence: number; streamId: string; data: string }
  | { type: 'snapshot'; sequence: number; cols: number; rows: number; streamId: string; data: string }
  | { type: 'ping'; timestamp: number }
  | { type: 'pong'; timestamp: number };

const TWO_POW_32 = 0x1_0000_0000;

function readUint64BE(view: DataView, offset: number): number {
  return view.getUint32(offset) * TWO_POW_32 + view.getUint32(offset + 4);
}

function writeUint64BE(view: DataView, offset: number, value: number): void {
  const safe = Math.max(0, Math.trunc(value));
  const hi = Math.floor(safe / TWO_POW_32) >>> 0;
  const lo = safe >>> 0;
  view.setUint32(offset, hi);
  view.setUint32(offset + 4, lo);
}

/**
 * Decodes a protocol 4 server binary WebSocket frame (`ArrayBuffer`).
 * Uses synchronous `inflateSync` (raw DEFLATE) so compressed snapshots never reorder behind subsequent output frames.
 */
export function decodeServerBinaryFrame(buffer: ArrayBuffer): DecodedServerBinaryFrame | undefined {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 1) return undefined;
  const view = new DataView(buffer);
  const type = bytes[0]!;
  if (type === OUTPUT) {
    if (bytes.length < 6) return undefined;
    const sequence = view.getUint32(1);
    const idLen = bytes[5]!;
    if (bytes.length < 6 + idLen) return undefined;
    const streamId = decoder.decode(bytes.subarray(6, 6 + idLen));
    const data = decoder.decode(bytes.subarray(6 + idLen));
    return { type: 'output', sequence, streamId, data };
  }
  if (type === SNAPSHOT_RAW || type === SNAPSHOT_DEFLATE) {
    if (bytes.length < 10) return undefined;
    const sequence = view.getUint32(1);
    const cols = view.getUint16(5);
    const rows = view.getUint16(7);
    const idLen = bytes[9]!;
    if (bytes.length < 10 + idLen) return undefined;
    const streamId = decoder.decode(bytes.subarray(10, 10 + idLen));
    const payload = bytes.subarray(10 + idLen);
    let data: string;
    if (type === SNAPSHOT_DEFLATE) {
      try {
        data = decoder.decode(inflateSync(payload));
      } catch {
        return undefined;
      }
    } else {
      data = decoder.decode(payload);
    }
    return { type: 'snapshot', sequence, cols, rows, streamId, data };
  }
  if (type === PING || type === PONG) {
    if (bytes.length < 9) return undefined;
    return { type: type === PING ? 'ping' : 'pong', timestamp: readUint64BE(view, 1) };
  }
  return undefined;
}

/** Encodes a protocol 4 binary `input` frame: `[0x04][epoch:u32be][clientIdLen:u8][clientId:utf8][payload:utf8]`. */
export function encodeInputFrame(clientId: string, epoch: number, data: string): Uint8Array {
  const idBytes = encoder.encode(clientId);
  const idLen = Math.min(idBytes.length, 255);
  const payload = encoder.encode(data);
  const frame = new Uint8Array(6 + idLen + payload.length);
  const view = new DataView(frame.buffer);
  frame[0] = INPUT;
  view.setUint32(1, epoch >>> 0);
  frame[5] = idLen;
  frame.set(idBytes.subarray(0, idLen), 6);
  frame.set(payload, 6 + idLen);
  return frame;
}

/** Encodes a protocol 4 binary `pong` frame echoing the server's ping timestamp. */
export function encodePongFrame(timestamp: number): Uint8Array {
  const frame = new Uint8Array(9);
  const view = new DataView(frame.buffer);
  frame[0] = PONG;
  writeUint64BE(view, 1, timestamp);
  return frame;
}

/** Encodes a protocol 4 binary `ping` frame. */
export function encodePingFrame(timestamp = Date.now()): Uint8Array {
  const frame = new Uint8Array(9);
  const view = new DataView(frame.buffer);
  frame[0] = PING;
  writeUint64BE(view, 1, timestamp);
  return frame;
}
