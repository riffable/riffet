import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { TERMINAL_BUDGET, TERMINAL_WIRE_FRAME } from '../../../../packages/contracts/src/index.js';

const { OUTPUT, SNAPSHOT_RAW, SNAPSHOT_DEFLATE, INPUT, PING, PONG } = TERMINAL_WIRE_FRAME;

export type DecodedClientBinaryFrame =
  | { type: 'input'; clientId: string; epoch: number; data: string }
  | { type: 'ping'; timestamp: number }
  | { type: 'pong'; timestamp: number };

export type DecodedServerBinaryFrame =
  | { type: 'output'; sequence: number; streamId: string; data: string }
  | { type: 'snapshot'; sequence: number; cols: number; rows: number; streamId: string; data: string; compressed: boolean }
  | { type: 'ping'; timestamp: number }
  | { type: 'pong'; timestamp: number };

/**
 * Protocol 4 binary `output` frame:
 * `[0x01][seq:u32be][streamIdLen:u8][streamId:utf8][payload:utf8]`
 */
export function encodeOutputFrame(sequence: number, streamId: string, data: string): Buffer {
  const idBuf = Buffer.from(streamId, 'utf8');
  const idLen = Math.min(idBuf.length, 255);
  const payload = Buffer.from(data, 'utf8');
  const frame = Buffer.allocUnsafe(6 + idLen + payload.length);
  frame[0] = OUTPUT;
  frame.writeUInt32BE(sequence >>> 0, 1);
  frame[5] = idLen;
  idBuf.copy(frame, 6, 0, idLen);
  payload.copy(frame, 6 + idLen);
  return frame;
}

/**
 * Protocol 4 binary `snapshot` frame:
 * `[0x02|0x03][seq:u32be][cols:u16be][rows:u16be][streamIdLen:u8][streamId:utf8][payload:utf8|deflate-raw]`
 * Large snapshots are compressed with raw deflate when that reduces wire size.
 */
export function encodeSnapshotFrame(sequence: number, cols: number, rows: number, streamId: string, data: string): Buffer {
  const idBuf = Buffer.from(streamId, 'utf8');
  const idLen = Math.min(idBuf.length, 255);
  const raw = Buffer.from(data, 'utf8');
  let type: number = SNAPSHOT_RAW;
  let payload = raw;
  if (raw.length >= TERMINAL_BUDGET.compressMinBytes) {
    const deflated = deflateRawSync(raw, { level: 3 });
    if (deflated.length < raw.length) {
      type = SNAPSHOT_DEFLATE;
      payload = deflated;
    }
  }
  const frame = Buffer.allocUnsafe(10 + idLen + payload.length);
  frame[0] = type;
  frame.writeUInt32BE(sequence >>> 0, 1);
  frame.writeUInt16BE(Math.min(Math.max(cols, 0), 0xffff), 5);
  frame.writeUInt16BE(Math.min(Math.max(rows, 0), 0xffff), 7);
  frame[9] = idLen;
  idBuf.copy(frame, 10, 0, idLen);
  payload.copy(frame, 10 + idLen);
  return frame;
}

/** Protocol 4 binary `input` frame: `[0x04][epoch:u32be][clientIdLen:u8][clientId:utf8][payload:utf8]` */
export function encodeInputFrame(clientId: string, epoch: number, data: string): Buffer {
  const idBuf = Buffer.from(clientId, 'utf8');
  const idLen = Math.min(idBuf.length, 255);
  const payload = Buffer.from(data, 'utf8');
  const frame = Buffer.allocUnsafe(6 + idLen + payload.length);
  frame[0] = INPUT;
  frame.writeUInt32BE(epoch >>> 0, 1);
  frame[5] = idLen;
  idBuf.copy(frame, 6, 0, idLen);
  payload.copy(frame, 6 + idLen);
  return frame;
}

export function encodePingFrame(timestamp = Date.now()): Buffer {
  return encodeHeartbeatFrame(PING, timestamp);
}

export function encodePongFrame(timestamp: number): Buffer {
  return encodeHeartbeatFrame(PONG, timestamp);
}

function encodeHeartbeatFrame(type: number, timestamp: number): Buffer {
  const frame = Buffer.allocUnsafe(9);
  frame[0] = type;
  frame.writeBigUInt64BE(BigInt(Math.max(0, Math.trunc(timestamp))), 1);
  return frame;
}

export function decodeClientBinaryFrame(raw: Buffer): DecodedClientBinaryFrame | undefined {
  if (raw.length < 1) return undefined;
  const type = raw[0]!;
  if (type === INPUT) {
    if (raw.length < 6) return undefined;
    const epoch = raw.readUInt32BE(1);
    const idLen = raw[5]!;
    if (raw.length < 6 + idLen) return undefined;
    const clientId = raw.toString('utf8', 6, 6 + idLen);
    const data = raw.toString('utf8', 6 + idLen);
    return { type: 'input', clientId, epoch, data };
  }
  if (type === PING || type === PONG) {
    if (raw.length < 9) return undefined;
    const timestamp = Number(raw.readBigUInt64BE(1));
    return { type: type === PING ? 'ping' : 'pong', timestamp };
  }
  return undefined;
}

export function decodeServerBinaryFrame(raw: Buffer): DecodedServerBinaryFrame | undefined {
  if (raw.length < 1) return undefined;
  const type = raw[0]!;
  if (type === OUTPUT) {
    if (raw.length < 6) return undefined;
    const sequence = raw.readUInt32BE(1);
    const idLen = raw[5]!;
    if (raw.length < 6 + idLen) return undefined;
    const streamId = raw.toString('utf8', 6, 6 + idLen);
    const data = raw.toString('utf8', 6 + idLen);
    return { type: 'output', sequence, streamId, data };
  }
  if (type === SNAPSHOT_RAW || type === SNAPSHOT_DEFLATE) {
    if (raw.length < 10) return undefined;
    const sequence = raw.readUInt32BE(1);
    const cols = raw.readUInt16BE(5);
    const rows = raw.readUInt16BE(7);
    const idLen = raw[9]!;
    if (raw.length < 10 + idLen) return undefined;
    const streamId = raw.toString('utf8', 10, 10 + idLen);
    const payload = raw.subarray(10 + idLen);
    const data = type === SNAPSHOT_DEFLATE ? inflateRawSync(payload).toString('utf8') : payload.toString('utf8');
    return { type: 'snapshot', sequence, cols, rows, streamId, data, compressed: type === SNAPSHOT_DEFLATE };
  }
  if (type === PING || type === PONG) {
    if (raw.length < 9) return undefined;
    const timestamp = Number(raw.readBigUInt64BE(1));
    return { type: type === PING ? 'ping' : 'pong', timestamp };
  }
  return undefined;
}
