import { randomUUID } from 'node:crypto';
import { DEVICE_CAPABILITIES, DEVICE_PLATFORMS, type DeviceCall, type DeviceCallReceipt, type DeviceCapability, type DeviceFile, type DeviceInfo, type DeviceLease, type DevicePlatform, type DevicePushRegistration, type DevicePushRoute, type DeviceReport, type Session, type RiffetWakeup } from '../../../../packages/contracts/src/index.js';
import { DeviceCallOutcomeSchema, DevicePushRegistrationSchema } from '../../../../packages/contracts/src/schema/devices.js';
import type { Auth, PublicDevice } from '../auth.js';
import { AppError, parseInput } from '../errors.js';
import type { Store } from '../store.js';
import type { WorkspaceService } from '../workspace/index.js';
import { DeviceAuditLog } from './audit.js';

/** One JSON map in the settings table: a handful of calls, written by one process. */
const CALLS = 'riffet-mcp:device-calls';
/** Settled calls are kept this long, so a late or repeated answer still gets its receipt. */
const SETTLED_RETENTION_MS = 24 * 60 * 60_000;
const MAX_SETTLED = 500;
const MAX_FILES_PER_CALL = 10;
const PING_MS = 15_000;

/** A call as the server keeps it. `deviceId` and the bookkeeping never reach the device. */
export interface StoredDeviceCall extends DeviceCall {
  deviceId: string;
  status: 'pending' | 'answered' | 'expired' | 'cancelled';
  /** First time the call was written to one of the device's streams. */
  deliveredAt?: string;
  /** Attachments uploaded for this call; only these may appear in its result. */
  fileIds?: string[];
  receipt?: DeviceCallReceipt;
  settledAt?: string;
  /** Why the server ended a call nobody answered. */
  error?: { code: string; message: string };
}

type Writer = (event: string, data: unknown) => void;

export interface DeviceChannelDeps {
  store: Store;
  auth: Auth;
  workspace: WorkspaceService;
  /** Every conversation's pending wake-ups; read lazily, the scheduler is built later. */
  pendingWakeups: () => RiffetWakeup[];
}

const deviceCall = ({ callId, sessionId, capability, args, deadline, createdAt }: StoredDeviceCall): DeviceCall => ({ callId, sessionId, capability, args, deadline, createdAt });

/** The devices a conversation's snapshot names (`device:<id>`), in its order. */
export function deviceGroupIds(session: Pick<Session, 'toolGroups'>): string[] {
  return (session.toolGroups ?? []).filter(group => group.startsWith('device:')).map(group => group.slice('device:'.length));
}

/**
 * The device channel (docs/DEVICES.md §3): who is connected, the persisted call queue and the
 * leases derived from pending wake-ups. A call is written to the settings table before it is sent,
 * so it outlives a restart until its deadline. Live appearance changes stay with their original
 * connection. The device's answer is accepted once per `callId`.
 */
export class DeviceChannel {
  private readonly streams = new Map<string, Set<Writer>>();
  private readonly listeners = new Set<() => void>();
  private readonly waiters = new Map<string, Set<(call: StoredDeviceCall) => void>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly appearanceWriters = new Map<string, { deviceId: string; writer: Writer }>();
  private readonly offRevoked: () => void;
  /** What conversations did on device screens; written by the MCP service, read by the session route. */
  readonly audit: DeviceAuditLog;
  /** How a device is reached in the background (docs/DEVICES.md §3「后台推送」); the push service sets it once it exists. */
  pushRoute: (deviceId: string, platform?: DevicePlatform) => DevicePushRoute | undefined = () => undefined;

  constructor(private readonly deps: DeviceChannelDeps) {
    this.audit = new DeviceAuditLog(deps.store);
    for (const call of Object.values(this.read())) {
      if (call.status !== 'pending') continue;
      if (call.capability === 'riffet.appearance') this.appearanceInterrupted(call.callId);
      else this.arm(call);
    }
    // Its streams are already closed; nobody can answer its calls any more.
    this.offRevoked = deps.auth.onDeviceRevoked(id => {
      for (const call of Object.values(this.read())) {
        if (call.deviceId === id && call.status === 'pending') this.settle(call.callId, { status: 'cancelled', error: { code: 'DEVICE_UNREACHABLE', message: 'The device was unpaired' } });
      }
      this.changed();
    });
  }

  /**
   * Told when the device list may read differently: a device came online or went offline, reported,
   * or was unpaired. Clients re-read `GET /api/devices`; the event carries nothing.
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** A device's push route reads differently: a push failed or succeeded again, or the key changed. */
  pushRouteChanged(): void { this.changed(); }

  private changed(): void {
    for (const listener of [...this.listeners]) { try { listener(); } catch { /* a closed stream drops itself */ } }
  }

  close(): void {
    this.offRevoked();
    for (const callId of this.appearanceWriters.keys()) this.appearanceInterrupted(callId);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  // ---- Devices -----------------------------------------------------------------------------

  online(deviceId: string): boolean { return Boolean(this.streams.get(deviceId)?.size); }

  info(device: PublicDevice): DeviceInfo {
    const push = this.pushRoute(device.id, device.platform);
    return {
      id: device.id, name: device.name, ...(device.platform ? { platform: device.platform } : {}), ...(device.appVersion ? { appVersion: device.appVersion } : {}),
      createdAt: device.createdAt, ...(device.lastSeenAt ? { lastSeenAt: device.lastSeenAt } : {}),
      online: this.online(device.id), capabilities: device.capabilities ?? [], allowControl: device.allowControl === true,
      ...(push ? { push } : {}),
    };
  }

  list(): DeviceInfo[] { return this.deps.auth.listDevices().map(device => this.info(device)); }

  /**
   * `PUT /api/devices/me`. Capability ids this server does not know are dropped, not refused. `features` is the
   * request's client features header, kept so pushes cover only what this device's lists show.
   */
  report(deviceId: string, raw: unknown, features?: string[]): DeviceInfo {
    const body = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    if (!(DEVICE_PLATFORMS as readonly unknown[]).includes(body.platform)) throw new AppError('INVALID_DEVICE_REPORT', 'platform must be android, ios or mac');
    if (typeof body.appVersion !== 'string' || body.appVersion.length > 64 || /[\0\r\n]/.test(body.appVersion)) throw new AppError('INVALID_DEVICE_REPORT', 'appVersion must be a string of at most 64 characters');
    if (!Array.isArray(body.capabilities) || body.capabilities.length > 64) throw new AppError('INVALID_DEVICE_REPORT', 'capabilities must be a list');
    if (typeof body.allowControl !== 'boolean') throw new AppError('INVALID_DEVICE_REPORT', 'allowControl must be a boolean');
    const capabilities = [...new Set(body.capabilities.filter((item): item is DeviceCapability => (DEVICE_CAPABILITIES as readonly unknown[]).includes(item)))];
    const report: DeviceReport = { platform: body.platform as DeviceReport['platform'], appVersion: body.appVersion, capabilities, allowControl: body.allowControl };
    if (body.installationId !== undefined) {
      if (typeof body.installationId !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(body.installationId)) throw new AppError('INVALID_DEVICE_REPORT', 'installationId must be at most 100 letters, digits or hyphens');
      report.installationId = body.installationId;
    }
    if (body.push !== undefined) report.push = body.push === null ? null : pushRegistration(body.push);
    const info = this.info(this.deps.auth.reportDevice(deviceId, report, features));
    if (!info.allowControl || !capabilities.includes('riffet.appearance')) {
      for (const [callId, target] of this.appearanceWriters) if (target.deviceId === deviceId) this.appearanceInterrupted(callId);
    }
    this.changed();
    return info;
  }

  /**
   * A device's stream opened: it is online from now on, and first receives every call still waiting
   * for it and every future lease. Returns the disconnect.
   */
  connect(deviceId: string, writer: Writer): () => void {
    let writers = this.streams.get(deviceId);
    const first = !writers;
    if (!writers) { writers = new Set(); this.streams.set(deviceId, writers); }
    writers.add(writer);
    if (first) this.changed();
    const now = Date.now();
    for (const call of Object.values(this.read()).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (call.deviceId !== deviceId || call.status !== 'pending' || Date.parse(call.deadline) <= now) continue;
      // An appearance change targeted the connected app at submission. Never replay it into a later foreground.
      if (call.capability !== 'riffet.appearance') this.deliver(call, [writer]);
    }
    for (const lease of this.leases(deviceId)) writer('lease', lease);
    const ping = setInterval(() => writer('ping', {}), PING_MS);
    ping.unref();
    return () => {
      clearInterval(ping);
      const current = this.streams.get(deviceId);
      current?.delete(writer);
      if (current && !current.size) { this.streams.delete(deviceId); this.changed(); }
      for (const [callId, target] of this.appearanceWriters) if (target.writer === writer) this.appearanceInterrupted(callId);
    };
  }

  private send(deviceId: string, event: string, data: unknown): void {
    for (const writer of this.streams.get(deviceId) ?? []) { try { writer(event, data); } catch { /* a broken stream closes on its own */ } }
  }

  // ---- Leases ------------------------------------------------------------------------------

  /** Future wake-ups of conversations whose snapshot names this device. */
  leases(deviceId: string): DeviceLease[] {
    const now = Date.now();
    return this.deps.pendingWakeups().filter(wakeup => Date.parse(wakeup.dueAt) > now).flatMap(wakeup => {
      const session = this.session(wakeup.sessionId);
      return session && !session.archivedAt && deviceGroupIds(session).includes(deviceId) ? [leaseOf(wakeup)] : [];
    }).sort((a, b) => a.at.localeCompare(b.at));
  }

  /** A wake-up was scheduled, or stopped being pending: tell the conversation's devices. */
  wakeupChanged(wakeup: RiffetWakeup): void {
    const session = this.session(wakeup.sessionId);
    if (!session) return;
    const live = wakeup.status === 'pending' && Date.parse(wakeup.dueAt) > Date.now();
    for (const deviceId of deviceGroupIds(session)) this.send(deviceId, live ? 'lease' : 'lease-cancel', live ? leaseOf(wakeup) : { id: wakeup.id });
  }

  private session(id: string): Session | undefined { try { return this.deps.store.getSession(id); } catch { return undefined; } }

  // ---- Calls -------------------------------------------------------------------------------

  private read(): Record<string, StoredDeviceCall> {
    return Object.assign(Object.create(null) as Record<string, StoredDeviceCall>, this.deps.store.getSetting<Record<string, StoredDeviceCall>>(CALLS, {}));
  }

  private write(all: Record<string, StoredDeviceCall>): void {
    const now = Date.now();
    const settled = Object.values(all).filter(call => call.status !== 'pending').sort((a, b) => (b.settledAt ?? '').localeCompare(a.settledAt ?? ''));
    for (const [index, call] of settled.entries()) {
      if (index >= MAX_SETTLED || now - Date.parse(call.settledAt ?? call.createdAt) > SETTLED_RETENTION_MS) delete all[call.callId];
    }
    this.deps.store.setSetting(CALLS, { ...all });
  }

  get(callId: string): StoredDeviceCall | undefined { return this.read()[callId]; }

  /**
   * Queues a call for a device and resolves once it is settled: answered, past its deadline, or
   * cancelled through `signal` (the agent's request went away). Never rejects for the device's sake.
   */
  call(input: { sessionId: string; deviceId: string; capability: DeviceCapability; args: Record<string, unknown>; timeoutMs: number; signal?: AbortSignal }): Promise<StoredDeviceCall> {
    const created = new Date();
    const call: StoredDeviceCall = {
      callId: randomUUID(), sessionId: input.sessionId, capability: input.capability, args: input.args,
      deadline: new Date(created.getTime() + input.timeoutMs).toISOString(), createdAt: created.toISOString(), deviceId: input.deviceId, status: 'pending',
    };
    const appearance = call.capability === 'riffet.appearance';
    const writer = appearance ? [...this.streams.get(call.deviceId) ?? []].at(-1) : undefined;
    if (appearance && (!writer || input.signal?.aborted)) return Promise.resolve({
      ...call, status: 'cancelled', settledAt: call.createdAt,
      error: input.signal?.aborted ? { code: 'DEVICE_CALL_CANCELLED', message: 'The call was cancelled' }
        : { code: 'DEVICE_UNREACHABLE', message: 'The Riffet device is offline' },
    });
    const settled = new Promise<StoredDeviceCall>(resolve => {
      const listeners = new Set<(call: StoredDeviceCall) => void>([resolve]);
      this.waiters.set(call.callId, listeners);
    });
    this.write({ ...this.read(), [call.callId]: call });
    this.arm(call);
    if (writer) this.appearanceWriters.set(call.callId, { deviceId: call.deviceId, writer });
    this.deliver(call, writer ? [writer] : undefined);
    if (input.signal) {
      const abort = () => this.settle(call.callId, { status: 'cancelled', error: { code: 'DEVICE_CALL_CANCELLED', message: 'The call was cancelled' } });
      if (input.signal.aborted) abort();
      else input.signal.addEventListener('abort', abort, { once: true });
      void settled.then(() => input.signal!.removeEventListener('abort', abort));
    }
    return settled;
  }

  private arm(call: StoredDeviceCall): void {
    clearTimeout(this.timers.get(call.callId));
    const timer = setTimeout(() => {
      this.timers.delete(call.callId);
      const current = this.read()[call.callId];
      if (!current || current.status !== 'pending') return;
      const seconds = Math.round((Date.parse(current.deadline) - Date.parse(current.createdAt)) / 1000);
      this.settle(call.callId, current.deliveredAt
        ? { status: 'expired', error: { code: 'DEVICE_TIMEOUT', message: `The device received the call but did not answer within ${seconds} s` } }
        : { status: 'expired', error: { code: 'DEVICE_UNREACHABLE', message: `The device did not connect within ${seconds} s` } });
    }, Math.max(0, Date.parse(call.deadline) - Date.now()));
    timer.unref();
    this.timers.set(call.callId, timer);
  }

  private appearanceInterrupted(callId: string): void {
    this.settle(callId, { status: 'cancelled', error: {
      code: 'DEVICE_RESULT_UNKNOWN', message: 'The Riffet device disconnected or became unavailable before confirming the appearance change',
    } });
  }

  private deliver(call: StoredDeviceCall, writers = [...this.streams.get(call.deviceId) ?? []]): void {
    if (!writers.length) return;
    for (const writer of writers) { try { writer('call', deviceCall(call)); } catch { /* a broken stream closes on its own */ } }
    if (call.deliveredAt) return;
    const all = this.read(), current = all[call.callId];
    if (!current || current.status !== 'pending' || current.deliveredAt) return;
    this.write({ ...all, [call.callId]: { ...current, deliveredAt: new Date().toISOString() } });
  }

  /** Ends a pending call once; read and write are synchronous, so two endings cannot both apply. */
  private settle(callId: string, patch: Pick<StoredDeviceCall, 'status'> & Partial<StoredDeviceCall>): StoredDeviceCall | undefined {
    const all = this.read(), current = all[callId];
    if (!current || current.status !== 'pending') return current;
    const next: StoredDeviceCall = { ...current, ...patch, settledAt: new Date().toISOString() };
    this.write({ ...all, [callId]: next });
    this.appearanceWriters.delete(callId);
    clearTimeout(this.timers.get(callId));
    this.timers.delete(callId);
    if (next.status !== 'answered') this.send(next.deviceId, 'cancel', { callId });
    const listeners = this.waiters.get(callId);
    this.waiters.delete(callId);
    for (const listener of listeners ?? []) listener(next);
    return next;
  }

  /** The device's own call, or 404 for anyone else's: a device cannot learn of another's calls. */
  private own(deviceId: string, callId: string): StoredDeviceCall {
    const call = this.read()[callId];
    if (!call || call.deviceId !== deviceId) throw new AppError('DEVICE_CALL_NOT_FOUND', 'No such call for this device', 404);
    return call;
  }

  /** `POST /api/devices/me/calls/:callId/result`: the first answer wins; a repeat gets its receipt. */
  answer(deviceId: string, callId: string, body: unknown): DeviceCallReceipt {
    const call = this.own(deviceId, callId);
    if (call.receipt) return call.receipt;
    if (call.status !== 'pending') throw new AppError('DEVICE_CALL_CLOSED', `This call is already ${call.status}`, 409);
    const outcome = parseInput(DeviceCallOutcomeSchema, body, 'INVALID_DEVICE_RESULT');
    if (outcome.ok && outcome.result.fileIds !== undefined) {
      const ids = outcome.result.fileIds;
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !(call.fileIds ?? []).includes(id))) throw new AppError('INVALID_DEVICE_RESULT', 'fileIds must name files uploaded for this call');
    }
    const receipt: DeviceCallReceipt = { callId, outcome, receivedAt: new Date().toISOString() };
    const settled = this.settle(callId, { status: 'answered', receipt });
    // Settled in between by the deadline: the device learns it was too late.
    if (settled?.receipt) return settled.receipt;
    throw new AppError('DEVICE_CALL_CLOSED', `This call is already ${settled?.status ?? 'gone'}`, 409);
  }

  /** `POST /api/devices/me/calls/:callId/files`: stored as an attachment, which the agent reads by path. */
  async attach(deviceId: string, callId: string, body: unknown): Promise<DeviceFile> {
    const open = () => {
      const call = this.own(deviceId, callId);
      if (call.status !== 'pending') throw new AppError('DEVICE_CALL_CLOSED', `This call is already ${call.status}`, 409);
      if ((call.fileIds ?? []).length >= MAX_FILES_PER_CALL) throw new AppError('TOO_MANY_DEVICE_FILES', `A call takes at most ${MAX_FILES_PER_CALL} files`, 409);
      return call;
    };
    open();
    const attachment = await this.deps.workspace.upload(undefined, body as Parameters<WorkspaceService['upload']>[1]);
    const call = open();
    this.write({ ...this.read(), [callId]: { ...call, fileIds: [...call.fileIds ?? [], attachment.id] } });
    return { fileId: attachment.id, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size };
  }
}

/** `DeviceReport.push`: hex tokens and a bundle id as the topic. */
function pushRegistration(raw: unknown): DevicePushRegistration {
  const push = parseInput(DevicePushRegistrationSchema, raw, 'INVALID_DEVICE_REPORT');
  for (const field of ['token', 'activityStartToken', 'activityToken'] as const) {
    const value = push[field];
    if (value !== undefined && !/^[0-9A-Fa-f]{16,400}$/.test(value)) throw new AppError('INVALID_DEVICE_REPORT', `push.${field} must be an APNs token in hex`);
  }
  if (!/^[A-Za-z0-9.-]{1,155}$/.test(push.topic)) throw new AppError('INVALID_DEVICE_REPORT', 'push.topic must be the app\'s bundle id');
  return push;
}

function leaseOf(wakeup: RiffetWakeup): DeviceLease {
  return { id: wakeup.id, sessionId: wakeup.sessionId, at: wakeup.dueAt, reason: wakeup.note.split('\n')[0]!.slice(0, 120) };
}
