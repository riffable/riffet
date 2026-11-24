import type { NativeDeliveryState, NativeStopRequest, TerminalInfo } from '../../../../packages/contracts/src/index.js';
import type { Store } from '../store.js';
import { AppError } from '../errors.js';

/** What a targeted stop was asked to end and how far it got, kept per request id so a retry replays the same stop. */
export interface StopReceipt {
  request: NativeStopRequest; operation: string; state: 'pending' | 'completed';
  runId?: string; createdAt: string; replacementFingerprint?: string;
  targets?: Array<[string, NativeDeliveryState]>; terminalId?: string; terminalEpoch?: number;
  error?: { code?: string; message: string };
}

export function readStopReceipt(store: Store, sessionId: string, stop: NativeStopRequest): StopReceipt | undefined {
  return store.getSetting<Record<string, StopReceipt>>(`native-stops:${sessionId}`, {})[JSON.stringify(stop.requestId)];
}

/** A replacement retry must keep both the stop request id and the command id. */
export function findReplacementStop(store: Store, sessionId: string, commandId: string, requestId?: string): StopReceipt | undefined {
  const receipts = store.getSetting<Record<string, StopReceipt>>(`native-stops:${sessionId}`, {});
  const byRequest = requestId ? receipts[JSON.stringify(requestId)] : undefined;
  if (byRequest?.operation === commandId && byRequest.replacementFingerprint !== undefined) return byRequest;
  return Object.values(receipts).find(receipt => receipt.operation === commandId && receipt.replacementFingerprint !== undefined) ?? byRequest;
}

export function saveStopReceipt(store: Store, sessionId: string, receipt: StopReceipt): void {
  const key = `native-stops:${sessionId}`;
  // Keep the request tombstone: eviction would turn an old retry into another Stop.
  store.setSetting(key, { ...store.getSetting<Record<string, StopReceipt>>(key, {}), [JSON.stringify(receipt.request.requestId)]: receipt });
}

export function stopFingerprint(stop: NativeStopRequest, operation: string, replacementFingerprint?: string): string {
  return JSON.stringify([operation, stop.requestId, stop.nativeSessionId, stop.turnId ?? null,
    stop.terminalId ?? null, stop.terminalEpoch ?? null, replacementFingerprint ?? null]);
}

export function assertStopBinding(store: Store, sessionId: string, stop: NativeStopRequest, receipt?: StopReceipt): void {
  const session = store.getSession(sessionId);
  const terminalId = receipt?.terminalId ?? stop.terminalId;
  const epoch = receipt?.terminalEpoch ?? stop.terminalEpoch;
  let terminal: TerminalInfo | undefined;
  if (terminalId) { try { terminal = store.getTerminal(terminalId); } catch { /* missing identity is not a stop receipt */ } }
  if ((session.nativeSessionId ?? '') !== stop.nativeSessionId
    || (terminalId !== undefined && (session.terminalId !== terminalId || !terminal || terminal.sessionId !== sessionId || terminal.projectId !== session.projectId))
    || (epoch !== undefined && terminal?.epoch !== epoch)
    || (receipt && session.terminalId && !terminalId)) {
    throw new AppError('NATIVE_STOP_TARGET_CHANGED', 'The original task changed; no stop was sent', 409);
  }
}
