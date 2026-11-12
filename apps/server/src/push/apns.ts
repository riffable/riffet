import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { connect, type ClientHttp2Session } from 'node:http2';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { PushKeyStatus } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { atomicWritePrivateFile, readPrivateSettingsFile } from '../settings/private-file.js';

/** Where a push goes: the device's APNs environment and the hex token (device, push-to-start or activity). */
export interface ApnsTarget { environment: 'production' | 'sandbox'; token: string }
export interface ApnsMessage {
  /** The app's bundle id; a Live Activity push goes to `<topic>.push-type.liveactivity`. */
  topic: string;
  pushType: 'alert' | 'liveactivity';
  priority: 5 | 10;
  collapseId?: string;
  /** Unix seconds after which APNs stops trying to deliver. */
  expiration?: number;
  payload: Record<string, unknown>;
}
export interface ApnsResponse { status: number; reason?: string }
/** One HTTP/2 request to APNs. Throws when the request never got an answer (network, TLS, timeout). */
export type ApnsTransport = (request: { environment: ApnsTarget['environment']; token: string; headers: Record<string, string>; body: string }) => Promise<ApnsResponse>;
/** `gone`: APNs says the token no longer reaches an app; the caller forgets it. */
export type ApnsOutcome = { ok: true } | { ok: false; gone: boolean; reason: string };

interface StoredKey { keyId: string; teamId: string; key: string }

/** APNs refreshes a provider token at most every 20 minutes and accepts one up to an hour old. */
const JWT_REUSE_S = 50 * 60;
const REQUEST_TIMEOUT_MS = 15_000;
/** Payloads past this are refused by APNs. */
export const APNS_MAX_PAYLOAD = 4096;
const GONE_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'ExpiredToken']);
/** Reasons that mean the key or its team id is wrong, not this one push. */
const KEY_REASONS = new Set(['InvalidProviderToken', 'MissingProviderToken', 'BadCertificateEnvironment', 'BadCertificate']);

/**
 * The owner's APNs auth key and the provider connection (docs/DEVICES.md §3「后台推送」). The key is kept in
 * `<stateDir>/apns-key.json` with mode 0600 and never leaves this class: no route returns it and nothing logs it.
 * Pushes go straight to Apple; without a key nothing is sent.
 */
export class ApnsClient {
  private readonly path: string;
  private key?: StoredKey & { object: KeyObject };
  private keyError?: string;
  private jwt?: { token: string; issuedAt: number };
  /** Set when APNs refused a token signed with the current key. */
  private rejected?: string;
  private readonly transport: ApnsTransport;
  private readonly closeTransport: () => void;
  private readonly retryDelaysMs: readonly number[];

  constructor(options: { stateDir: string; transport?: ApnsTransport; retryDelaysMs?: readonly number[] }) {
    this.path = join(options.stateDir, 'apns-key.json');
    this.retryDelaysMs = options.retryDelaysMs ?? [1_000, 4_000];
    if (options.transport) { this.transport = options.transport; this.closeTransport = () => undefined; }
    else { const http2 = http2Transport(); this.transport = http2.send; this.closeTransport = http2.close; }
    this.load();
  }

  private load(): void {
    this.key = undefined; this.keyError = undefined; this.jwt = undefined; this.rejected = undefined;
    let raw: string | undefined;
    try { raw = readPrivateSettingsFile(this.path, 16 * 1024); }
    catch { this.keyError = 'The stored key file is unreadable or not private'; return; }
    if (raw === undefined) return;
    try { const stored = parseKey(JSON.parse(raw)); this.key = { ...stored, object: privateKey(stored.key) }; }
    catch { this.keyError = 'The stored key is not a valid APNs auth key'; }
  }

  configured(): boolean { return Boolean(this.key); }

  status(): PushKeyStatus {
    if (!this.key) return this.keyError ? { configured: false, status: 'invalid', detail: this.keyError } : { configured: false };
    return { configured: true, keyId: this.key.keyId, teamId: this.key.teamId, status: this.rejected ? 'invalid' : 'ok', ...(this.rejected ? { detail: this.rejected } : {}) };
  }

  /** `PUT /api/settings/push`: checked to be an ES256 key before it is written. */
  save(input: unknown): PushKeyStatus {
    const stored = parseKey(input);
    privateKey(stored.key);
    atomicWritePrivateFile(this.path, JSON.stringify(stored));
    this.load();
    return this.status();
  }

  remove(): PushKeyStatus {
    try { unlinkSync(this.path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AppError('SETTINGS_WRITE_FAILED', 'The push key could not be removed'); }
    this.load();
    return this.status();
  }

  close(): void { this.closeTransport(); }

  private providerToken(): string {
    const key = this.key!;
    const now = Math.floor(Date.now() / 1000);
    if (this.jwt && now - this.jwt.issuedAt < JWT_REUSE_S) return this.jwt.token;
    const head = Buffer.from(JSON.stringify({ alg: 'ES256', kid: key.keyId })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: key.teamId, iat: now })).toString('base64url');
    const signature = sign('sha256', Buffer.from(`${head}.${claims}`), { key: key.object, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    this.jwt = { token: `${head}.${claims}.${signature}`, issuedAt: now };
    return this.jwt.token;
  }

  /**
   * Sends one push. Network failures, 429 and 5xx are retried after 1 s and 4 s; an expired provider token
   * is minted again once. Never throws.
   */
  async send(target: ApnsTarget, message: ApnsMessage): Promise<ApnsOutcome> {
    if (!this.key) return { ok: false, gone: false, reason: 'NoKey' };
    const body = fitPayload(message.payload);
    let refreshed = false;
    for (let attempt = 0; ; attempt += 1) {
      const key: (StoredKey & { object: KeyObject }) | undefined = this.key;
      if (!key) return { ok: false, gone: false, reason: 'NoKey' };
      const headers: Record<string, string> = {
        authorization: `bearer ${this.providerToken()}`,
        'apns-topic': message.pushType === 'liveactivity' ? `${message.topic}.push-type.liveactivity` : message.topic,
        'apns-push-type': message.pushType,
        'apns-priority': String(message.priority),
        ...(message.collapseId ? { 'apns-collapse-id': message.collapseId } : {}),
        ...(message.expiration !== undefined ? { 'apns-expiration': String(message.expiration) } : {}),
      };
      let response: ApnsResponse | undefined;
      let failure = 'NetworkError';
      try { response = await this.transport({ environment: target.environment, token: target.token, headers, body }); }
      catch (error) { failure = error instanceof Error && error.message ? `NetworkError: ${error.message.slice(0, 200)}` : 'NetworkError'; }
      if (response && response.status >= 200 && response.status < 300) return { ok: true };
      const reason = response ? response.reason ?? `HTTP ${response.status}` : failure;
      if (response?.status === 410 || (response && GONE_REASONS.has(reason))) return { ok: false, gone: true, reason };
      if (response?.status === 403 && reason === 'ExpiredProviderToken' && !refreshed) { refreshed = true; this.jwt = undefined; attempt -= 1; continue; }
      if (response && KEY_REASONS.has(reason) && this.key === key) this.rejected = reason;
      const retryable = !response || response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= this.retryDelaysMs.length) return { ok: false, gone: false, reason };
      await new Promise(resolve => setTimeout(resolve, this.retryDelaysMs[attempt]).unref());
    }
  }
}

function parseKey(input: unknown): StoredKey {
  const body = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const id = (value: unknown, name: string) => {
    if (typeof value !== 'string' || !/^[A-Z0-9]{10}$/.test(value.trim())) throw new AppError('INVALID_PUSH_KEY', `${name} must be the 10-character id from the Apple Developer account`);
    return value.trim();
  };
  const keyId = id(body.keyId, 'keyId'), teamId = id(body.teamId, 'teamId');
  if (typeof body.key !== 'string' || body.key.length > 8 * 1024 || !body.key.includes('-----BEGIN PRIVATE KEY-----')) throw new AppError('INVALID_PUSH_KEY', 'key must be the text of the .p8 file');
  return { keyId, teamId, key: body.key.trim() };
}

function privateKey(pem: string): KeyObject {
  let key: KeyObject;
  try { key = createPrivateKey({ key: pem, format: 'pem' }); }
  catch { throw new AppError('INVALID_PUSH_KEY', 'key is not a readable .p8 file'); }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new AppError('INVALID_PUSH_KEY', 'key must be an APNs auth key (P-256)');
  return key;
}

/**
 * Shrinks `aps.alert.body` (then the title) until the payload fits APNs' 4 KB. Live Activity payloads carry
 * only counts and always fit.
 */
export function fitPayload(payload: Record<string, unknown>): string {
  let body = JSON.stringify(payload);
  const alert = (payload.aps as { alert?: Record<string, unknown> } | undefined)?.alert;
  for (const field of ['body', 'subtitle', 'title'] as const) {
    if (Buffer.byteLength(body) <= APNS_MAX_PAYLOAD) break;
    if (!alert || typeof alert[field] !== 'string') continue;
    const text = [...(alert[field] as string)];
    // The longest prefix that fits, by binary search over code points.
    let low = 0, high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      alert[field] = `${text.slice(0, mid).join('')}…`;
      if (Buffer.byteLength(JSON.stringify(payload)) <= APNS_MAX_PAYLOAD) low = mid; else high = mid - 1;
    }
    alert[field] = low ? `${text.slice(0, low).join('')}…` : '';
    body = JSON.stringify(payload);
  }
  return body;
}

/** HTTP/2 to Apple, one connection per environment, reused across pushes as APNs asks. */
function http2Transport(): { send: ApnsTransport; close: () => void } {
  const sessions = new Map<string, ClientHttp2Session>();
  const session = (origin: string): ClientHttp2Session => {
    const open = sessions.get(origin);
    if (open && !open.closed && !open.destroyed) return open;
    const created = connect(origin);
    const forget = () => { if (sessions.get(origin) === created) sessions.delete(origin); };
    created.on('error', forget); created.on('close', forget); created.on('goaway', forget);
    // An idle connection is closed after a while; the next push opens another.
    created.setTimeout(30 * 60_000, () => created.close());
    created.unref();
    sessions.set(origin, created);
    return created;
  };
  const send: ApnsTransport = ({ environment, token, headers, body }) => new Promise((resolve, reject) => {
    const origin = environment === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
    let stream: ReturnType<ClientHttp2Session['request']>;
    let connection: ClientHttp2Session;
    try {
      connection = session(origin);
      stream = connection.request({ ':method': 'POST', ':path': `/3/device/${token}`, 'content-type': 'application/json', ...headers });
    } catch (error) { reject(error); return; }
    // A request that times out or fails below HTTP leaves a connection that may be half dead: the retry opens a new one.
    const drop = () => { if (sessions.get(origin) === connection) sessions.delete(origin); connection.destroy(); };
    let status = 0; const chunks: Buffer[] = [];
    stream.setTimeout(REQUEST_TIMEOUT_MS, () => { stream.close(); drop(); reject(new Error('timeout')); });
    stream.on('response', head => { status = Number(head[':status']); });
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', error => { drop(); reject(error); });
    stream.on('end', () => {
      let reason: string | undefined;
      try { reason = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { reason?: string }).reason; } catch { /* a 200 has no body */ }
      resolve({ status, ...(reason ? { reason } : {}) });
    });
    stream.end(body);
  });
  return { send, close: () => { for (const open of sessions.values()) open.close(); sessions.clear(); } };
}
