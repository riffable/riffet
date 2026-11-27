import http from 'node:http';
import http2 from 'node:http2';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import WebSocket, { createWebSocketStream } from 'ws';
import type { LinkAuditEntry, LinkInfo, LinkInviteResult, LinkJoinRequest, LinkSelfInfo, LinkState, LinkTransportId, LinkUpdateRequest, ProtocolInfo, ServerInfo, ServerPlatform } from '../../../../packages/contracts/src/index.js';
import { LINK_BUDGET } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { linkVerificationCode, loadLinkIdentity, sameFingerprint, type LinkIdentity } from './identity.js';
import { decodeInvite, encodeInvite, inviteProof, newInviteSecret, proofMatches, type LinkInvite } from './invite.js';
import { LINK_SOCKET, LINK_WEB_SOCKET } from './socket.js';
import { PinMismatchError, boundedWrites, plain, secure } from './tunnel.js';
import { sshTransport } from './ssh.js';
import { LinkWebPorts } from './web-ports.js';

/**
 * Links between this server and others (docs/SERVER-LINKS.md). Each link is a pinned pair of certificates and two
 * tunnels, both dialed by whichever side can reach the other: on the `primary` tunnel the dialer is the HTTP/2 client,
 * on the `reverse` one the acceptor is. Each side sends its requests on the session where it is the client and serves
 * the other side's on the session where it is the server, so the roles at the HTTP/2 layer never depend on who dialed.
 *
 * A forwarded connection is one CONNECT stream carrying plain HTTP/1.1. The serving side hands it to its ordinary
 * HTTP server marked with `LINK_SOCKET`; `app.ts` then applies `policy.ts` and the inbound switch to it. A stream for
 * `WEB_AUTHORITY` is a browser's connection relayed from a loopback port on the other machine (`web-ports.ts`); it is
 * marked with `LINK_WEB_SOCKET` instead and signs in like any remote browser.
 */

export interface StoredLink {
  serverId: string;
  /** The name last reported by the peer itself. */
  name: string;
  /** Optional local display name set on this server; overrides `name` without being overwritten on reconnect. */
  customName?: string;
  /** Short local alias unique on this server (`^[a-z0-9][a-z0-9._-]{0,31}$`). */
  alias?: string;
  /** Optional local one-line note describing what this peer is used for. */
  note?: string;
  platform?: ServerPlatform;
  transport: LinkTransportId;
  /** `direct`: the acceptor's address. `ssh`: the destination. Empty on the accepting side. */
  address: string;
  remoteCommand?: string;
  dialer: boolean;
  peerFingerprint: string;
  inbound: boolean;
  outbound: boolean;
  createdAt: string;
  lastConnectedAt?: string;
  removedByPeer?: true;
  version?: string;
  protocol?: ProtocolInfo;
  /** The loopback port this side last relayed the peer's web app on, kept so the page's origin survives a restart. */
  webPort?: number;
}

/** The CONNECT authority of a browser's relayed connection. A peer without `link-web-v1` would treat it as the link's own. */
const WEB_AUTHORITY = 'riffet.web:80';

interface Hello { serverId: string; name: string; inbound: boolean; version: string; protocol: ProtocolInfo; platform?: ServerPlatform }
interface PendingInvite { inviteId: string; key: string; inbound: boolean; expiresAt: number }
interface StoredSelf { name?: string }

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/** Normalises any server name into a valid short alias seed. */
export function slugifyAlias(seed: string): string {
  const cleaned = seed.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|[-._]+$/g, '');
  return (cleaned || 'server').slice(0, LINK_BUDGET.aliasChars);
}

interface Live {
  /** Where this side sends its requests. */
  client?: http2.ClientHttp2Session;
  /** Where this side serves the peer's requests. */
  served: Set<http2.ServerHttp2Session>;
  /** Forwarded connections the peer has open here; closed when inbound is switched off. */
  streams: Set<Duplex>;
  /** Transports this side opened, to tear down with the link. */
  transports: Set<Duplex>;
  connecting: boolean;
  retry?: NodeJS.Timeout;
  backoffMs: number;
  lastError?: string;
  pinger?: NodeJS.Timeout;
  missedPings: number;
  /** Bumped whenever the tunnels are torn down, so a dial that was awaiting something can tell it is stale. */
  epoch: number;
}

export interface LinkServiceOptions {
  stateDir: string;
  serverId: string;
  name: () => string;
  version: string;
  protocol: ProtocolInfo;
  /** The server forwarded connections are handed to. */
  httpServer: () => http.Server;
  /** The `riffet` command the SSH transport runs on the other machine when none was given. */
  remoteCommand?: string;
  log?: (message: string) => void;
  /** What a peer did, or what went wrong with one, that belongs in the security record (docs/TRANSPORT-SECURITY.md §7). */
  onSecurityEvent?: (event: { kind: 'link-added' | 'link-removed' | 'link-mismatch'; serverId: string; name: string; detail?: string }) => void;
}

type Listener = () => void;

export class LinkService {
  readonly identity: LinkIdentity;
  private readonly webPorts: LinkWebPorts;
  private records = new Map<string, StoredLink>();
  private readonly live = new Map<string, Live>();
  private readonly invites = new Map<string, PendingInvite>();
  private readonly audits = new Map<string, LinkAuditEntry[]>();
  private readonly listeners = new Set<Listener>();
  private readonly revokers = new Set<(serverId: string) => void>();
  private readonly path: string;
  private readonly selfPath: string;
  private readonly auditPath: string;
  private customSelfName?: string;
  private auditTimer?: NodeJS.Timeout;
  private closed = false;
  /** Tunnels accepted but not yet tied to a link (`LINK_BUDGET.pendingTunnels`). */
  private pendingTunnels = 0;

  constructor(private readonly options: LinkServiceOptions) {
    this.path = join(options.stateDir, 'links.json');
    this.selfPath = join(options.stateDir, 'link-self.json');
    this.auditPath = join(options.stateDir, 'link-audit.json');
    const savedSelf = readJson<StoredSelf>(this.selfPath, {});
    if (typeof savedSelf?.name === 'string' && savedSelf.name.trim()) {
      this.customSelfName = savedSelf.name.trim().slice(0, LINK_BUDGET.nameChars);
    }
    this.identity = loadLinkIdentity(options.stateDir, this.selfName());
    let needsSave = false;
    for (const record of readJson<StoredLink[]>(this.path, [])) {
      if (!record?.serverId) continue;
      if (!record.alias || !ALIAS_PATTERN.test(record.alias)) {
        record.alias = this.uniqueAlias(record.customName || record.name, record.serverId);
        needsSave = true;
      }
      this.records.set(record.serverId, record);
    }
    if (needsSave) this.save();
    for (const [serverId, entries] of Object.entries(readJson<Record<string, LinkAuditEntry[]>>(this.auditPath, {}))) {
      if (Array.isArray(entries)) this.audits.set(serverId, entries.slice(-LINK_BUDGET.auditEntries));
    }
    this.webPorts = new LinkWebPorts({
      open: serverId => this.openWeb(serverId),
      onListening: (serverId, port) => {
        const record = this.records.get(serverId);
        if (record && record.webPort !== port) { record.webPort = port; this.save(); }
        this.changed();
      },
      ...(options.log ? { log: options.log } : {}),
    });
  }

  private defaultName(): string {
    return this.options.name().trim().slice(0, LINK_BUDGET.nameChars) || 'Riffet';
  }

  selfName(): string {
    return this.customSelfName || this.defaultName();
  }

  private selfPlatform(): ServerPlatform {
    return { os: process.platform, arch: process.arch };
  }

  selfInfo(): LinkSelfInfo {
    return { serverId: this.options.serverId, name: this.selfName(), defaultName: this.defaultName(), platform: this.selfPlatform() };
  }

  setSelfName(raw: string): LinkSelfInfo {
    const trimmed = raw.trim().slice(0, LINK_BUDGET.nameChars);
    const next = trimmed || undefined;
    if (next !== this.customSelfName) {
      this.customSelfName = next;
      writeJson(this.selfPath, next ? { name: next } : {});
      const announced = this.selfName();
      for (const [serverId, live] of this.live) {
        const record = this.records.get(serverId);
        if (!record || record.removedByPeer) continue;
        if (live.client && !live.client.destroyed) void control(live.client, '/_link/state', { name: announced }).catch(() => undefined);
      }
      this.changed();
    }
    return this.selfInfo();
  }

  /** Dials every link this side dials. Called once the HTTP server is ready to take forwarded connections. */
  start() {
    for (const record of this.records.values()) if (record.dialer && !record.removedByPeer) void this.dial(record.serverId);
    this.syncWebPorts();
  }

  onChange(listener: Listener): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  /** Streams authenticated by a link (`auth.onRevoke`) close through this when the link ends or loses inbound. */
  onRevoke(listener: (serverId: string) => void): () => void { this.revokers.add(listener); return () => { this.revokers.delete(listener); }; }

  list(): LinkInfo[] {
    return [...this.records.values()].map(record => this.info(record)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  servers(): ServerInfo[] {
    const selfName = this.selfName();
    const self: ServerInfo = {
      id: this.options.serverId, name: selfName, alias: slugifyAlias(selfName), platform: this.selfPlatform(),
      self: true, online: true, version: this.options.version, protocol: this.options.protocol, compatible: true, inbound: true, outbound: true,
    };
    return [self, ...[...this.records.values()].filter(record => !record.removedByPeer).map(record => {
      const info = this.info(record);
      return {
        id: record.serverId, name: info.name, alias: info.alias,
        ...(info.note ? { note: info.note } : {}), ...(info.platform ? { platform: info.platform } : {}),
        online: info.state === 'online',
        ...(record.version ? { version: record.version } : {}), ...(record.protocol ? { protocol: record.protocol } : {}),
        compatible: record.protocol?.version === this.options.protocol.version,
        inbound: record.inbound, outbound: record.outbound,
        ...(record.lastConnectedAt ? { lastConnectedAt: record.lastConnectedAt } : {}),
      } satisfies ServerInfo;
    })];
  }

  audit(serverId: string): LinkAuditEntry[] {
    if (!this.records.has(serverId)) throw new AppError('LINK_NOT_FOUND', 'No such linked server', 404);
    return [...(this.audits.get(serverId) ?? [])].reverse();
  }

  /** Records one thing the peer did here (a write, or a stream it opened). */
  record(serverId: string, entry: LinkAuditEntry) {
    if (!this.records.has(serverId)) return;
    const entries = this.audits.get(serverId) ?? [];
    entries.push(entry);
    if (entries.length > LINK_BUDGET.auditEntries) entries.splice(0, entries.length - LINK_BUDGET.auditEntries);
    this.audits.set(serverId, entries);
    clearTimeout(this.auditTimer);
    this.auditTimer = setTimeout(() => this.saveAudit(), 2000);
    this.auditTimer.unref();
  }

  /** Whether a request that came through `serverId`'s link may be answered at all. */
  admits(serverId: string): boolean {
    const record = this.records.get(serverId);
    return !!record && !record.removedByPeer && record.inbound;
  }

  createInvite(input: { url?: string; inbound: boolean }): LinkInviteResult {
    const { inviteId, key } = newInviteSecret();
    const expiresAt = Date.now() + LINK_BUDGET.inviteTtlMs;
    this.pruneInvites();
    while (this.invites.size >= LINK_BUDGET.pendingInvites) this.invites.delete(this.invites.keys().next().value!);
    this.invites.set(inviteId, { inviteId, key, inbound: input.inbound, expiresAt });
    const url = input.url ? normalUrl(input.url) : '';
    const invite: LinkInvite = { url, serverId: this.options.serverId, name: this.selfName(), fingerprint: this.identity.fingerprint, inviteId, key, expiresAt };
    return { link: encodeInvite(invite), expiresAt };
  }

  /** Joins the server that made `request.link`, dials it, and keeps the link. */
  async join(request: LinkJoinRequest): Promise<LinkInfo> {
    const invite = decodeInvite(request.link);
    if (invite.serverId === this.options.serverId) throw new AppError('LINK_SELF', 'This link string was made on this server', 400);
    const existing = this.records.get(invite.serverId);
    if (existing && !existing.removedByPeer) throw new AppError('LINK_EXISTS', `Already linked with ${this.displayName(existing)}`, 409, undefined, { name: this.displayName(existing) });
    const transport: LinkTransportId = request.transport ?? 'direct';
    if (transport === 'direct' && !invite.url) throw new AppError('LINK_ADDRESS_REQUIRED', 'The link string has no address to dial; join over SSH instead', 400);
    if (transport === 'ssh' && !request.sshHost?.trim()) throw new AppError('LINK_ADDRESS_REQUIRED', 'Give the SSH destination of the other server', 400);
    const draft: StoredLink = {
      serverId: invite.serverId, name: invite.name.slice(0, LINK_BUDGET.nameChars),
      alias: this.uniqueAlias(invite.name, invite.serverId),
      transport,
      address: transport === 'ssh' ? request.sshHost!.trim() : invite.url,
      ...(transport === 'ssh' && request.remoteCommand?.trim() ? { remoteCommand: request.remoteCommand.trim() } : {}),
      dialer: true, peerFingerprint: invite.fingerprint, inbound: request.inbound, outbound: false, createdAt: new Date().toISOString(),
    };
    const { stream, socket } = await this.openTunnel(draft, 'primary', invite.inviteId);
    const session = this.clientSession(socket);
    let accepted = false;
    try {
      const reply = await control<Hello>(session, '/_link/join', {
        inviteId: invite.inviteId,
        proof: inviteProof(invite.key, invite.inviteId, invite.fingerprint, this.identity.fingerprint),
        ...this.hello(draft),
      });
      accepted = true;
      if (reply.serverId !== invite.serverId) throw new AppError('LINK_MISMATCH', 'The other server answered with a different identity', 502);
      const peerName = reply.name.slice(0, LINK_BUDGET.nameChars);
      Object.assign(draft, {
        name: peerName, alias: this.uniqueAlias(peerName, draft.serverId), outbound: reply.inbound, version: reply.version, protocol: reply.protocol,
        ...(reply.platform ? { platform: reply.platform } : {}), lastConnectedAt: new Date().toISOString(),
      });
      // Saved only once both tunnels are up, so a join that fails leaves no link behind on this side.
      this.records.set(draft.serverId, draft);
      const live = this.liveOf(draft.serverId);
      live.transports.add(stream);
      this.attachClient(draft.serverId, session);
      await this.openReverse(draft, live.epoch);
      this.save();
      this.changed();
      return this.info(draft);
    } catch (error) {
      // The other side kept the link once it accepted the join; ending it there as well lets the user simply retry.
      if (accepted && !session.destroyed) await control(session, '/_link/remove', {}).catch(() => undefined);
      if (this.records.get(draft.serverId) === draft) this.records.delete(draft.serverId);
      this.teardown(draft.serverId);
      session.destroy(); stream.destroy();
      this.changed();
      throw error;
    }
  }

  update(serverId: string, change: LinkUpdateRequest): LinkInfo {
    const record = this.require(serverId);
    let dirty = false;
    if (change.inbound !== undefined && change.inbound !== record.inbound) {
      record.inbound = change.inbound;
      dirty = true;
      if (!record.inbound) this.closeInbound(serverId);
      const client = this.live.get(serverId)?.client;
      if (client && !client.destroyed) void control(client, '/_link/state', { inbound: record.inbound }).catch(() => undefined);
    }
    if (change.name !== undefined) {
      const trimmed = change.name.trim().slice(0, LINK_BUDGET.nameChars);
      const next = trimmed && trimmed !== record.name ? trimmed : undefined;
      if (next !== record.customName) { record.customName = next; dirty = true; }
    }
    if (change.alias !== undefined) {
      const next = change.alias.trim().toLowerCase();
      if (!ALIAS_PATTERN.test(next)) {
        throw new AppError('INVALID_LINK_ALIAS', 'Alias may only contain lowercase letters, digits, and . _ -, starting with a letter or digit', 400);
      }
      if (this.aliasTaken(next, serverId)) {
        throw new AppError('LINK_ALIAS_TAKEN', `Alias ${next} is already used by another linked server`, 409, undefined, { alias: next });
      }
      if (next !== record.alias) { record.alias = next; dirty = true; }
    }
    if (change.note !== undefined) {
      const next = change.note.trim().slice(0, LINK_BUDGET.noteChars) || undefined;
      if (next !== record.note) { record.note = next; dirty = true; }
    }
    if (dirty) { this.save(); this.changed(); }
    return this.info(record);
  }

  /** Ends the link on both sides: the peer is told when it can be reached, and refuses this server's tunnels after. */
  async remove(serverId: string): Promise<void> {
    const record = this.require(serverId);
    const client = this.live.get(serverId)?.client;
    if (client && !client.destroyed && !record.removedByPeer) await control(client, '/_link/remove', {}).catch(() => undefined);
    this.records.delete(serverId);
    this.audits.delete(serverId);
    this.save(); this.saveAudit();
    this.teardown(serverId);
    this.changed();
  }

  /** A connection to the peer's HTTP server through the tunnel, for forwarding one request or WebSocket. */
  open(serverId: string): Duplex {
    const record = this.records.get(serverId);
    if (!record || record.removedByPeer) throw new AppError('LINK_NOT_FOUND', 'No such linked server', 404);
    const label = this.displayName(record);
    if (!record.outbound) throw new AppError('LINK_NOT_ALLOWED', `${label} does not allow this server to operate it`, 403, undefined, { name: label });
    const client = this.live.get(serverId)?.client;
    if (!client || client.destroyed || client.closed) throw new AppError('LINK_OFFLINE', `${label} is offline`, 503, undefined, { name: label });
    return plain(client.request({ ':method': 'CONNECT', ':authority': 'riffet.link:80' }) as unknown as Duplex);
  }

  /** A browser's connection to the peer's own web app through the tunnel (`web-ports.ts`). */
  private openWeb(serverId: string): Duplex {
    const record = this.records.get(serverId);
    if (!record || !relaysWeb(record)) throw new AppError('LINK_NOT_ALLOWED', 'This link does not relay the other server\'s web app', 403);
    const client = this.live.get(serverId)?.client;
    if (!client || client.destroyed || client.closed) throw new AppError('LINK_OFFLINE', `${this.displayName(record)} is offline`, 503);
    return plain(client.request({ ':method': 'CONNECT', ':authority': WEB_AUTHORITY }) as unknown as Duplex);
  }

  /** Sends one internal JSON HTTP request to a linked server over its tunnel (e.g. Riffet MCP `remote_*` tools). */
  async requestJson<T>(serverId: string, method: 'GET' | 'POST', path: string, body?: unknown, options?: { signal?: AbortSignal; timeoutMs?: number; origin?: string }): Promise<T> {
    const tunnel = this.open(serverId);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const timeoutMs = options?.timeoutMs ?? LINK_BUDGET.controlMs;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const done = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options?.signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(value as T);
      };
      const req = http.request({
        host: 'riffet.link',
        port: 80,
        method,
        path,
        createConnection: () => tunnel as unknown as import('node:net').Socket,
        headers: {
          host: 'riffet.link',
          accept: 'application/json',
          ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
          ...(options?.origin ? { 'x-riffet-link-origin': options.origin } : {}),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        const cap = LINK_BUDGET.execOutputBytes * 2 + 65_536;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes <= cap) chunks.push(chunk);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown;
          try { parsed = text ? JSON.parse(text) : {}; }
          catch { done(new AppError('LINK_FAILED', `Linked server returned invalid JSON (HTTP ${res.statusCode ?? 502})`, 502)); return; }
          const status = res.statusCode ?? 502;
          if (status < 200 || status >= 300) {
            const errBody = (parsed as { error?: { code?: string; message?: string } })?.error;
            done(new AppError(errBody?.code || 'LINK_FAILED', errBody?.message || `Linked server answered HTTP ${status}`, status));
            return;
          }
          done(undefined, parsed as T);
        });
        res.on('error', (error) => done(new AppError('LINK_FAILED', error.message, 502)));
      });
      const onAbort = () => { req.destroy(); tunnel.destroy(); done(new AppError('ABORTED', 'Remote request cancelled', 499)); };
      if (options?.signal?.aborted) { onAbort(); return; }
      options?.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => { req.destroy(); tunnel.destroy(); done(new AppError('LINK_FAILED', 'Remote request timed out', 504)); }, timeoutMs);
      timer.unref();
      req.on('error', (error) => done(new AppError('LINK_FAILED', error.message, 502)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** `GET /api/links/tunnel`: a tunnel the other side dialed. The TLS certificate says which link it belongs to. */
  async accept(socket: WebSocket, query: { role?: string; join?: string }) {
    // The endpoint is public, so what an unpaired caller can hold open is capped and given a deadline.
    if (this.closed || this.pendingTunnels >= LINK_BUDGET.pendingTunnels) { socket.terminate(); return; }
    this.pendingTunnels++;
    let pending = true;
    const settle = () => { if (pending) { pending = false; this.pendingTunnels--; } };
    const stream = boundedWrites(createWebSocketStream(socket));
    stream.once('close', settle);
    let secured;
    try { secured = await secure(stream, this.identity, 'server'); }
    catch { stream.destroy(); settle(); return; }
    const record = this.byFingerprint(secured.fingerprint);
    if (query.role === 'reverse') {
      if (!record) { secured.socket.destroy(); return; }
      settle();
      this.liveOf(record.serverId).transports.add(stream);
      this.attachClient(record.serverId, this.clientSession(secured.socket));
      this.changed();
      return;
    }
    // The primary tunnel: this side serves. A certificate nobody here paired with may only complete a join, and only
    // with an invite this side still holds.
    this.pruneInvites();
    const pendingJoin = query.join && this.invites.has(query.join) ? query.join : undefined;
    if (!record && !pendingJoin) { this.serveUnknown(secured.socket); return; }
    if (record) {
      settle();
      // The dialer opens a primary tunnel only after dropping its old ones; whatever is left here is stale.
      this.teardownTunnels(record.serverId);
      this.liveOf(record.serverId).transports.add(stream);
    }
    this.serve(secured.socket, secured.fingerprint, record?.serverId, pendingJoin, settle);
  }

  close() {
    this.closed = true;
    this.webPorts.closeAll();
    clearTimeout(this.auditTimer);
    this.saveAudit();
    for (const serverId of [...this.live.keys()]) this.teardown(serverId);
  }

  // Internals.

  private displayName(record: StoredLink): string {
    return record.customName || record.name;
  }

  private aliasTaken(alias: string, excludeServerId?: string): boolean {
    for (const record of this.records.values()) {
      if (record.removedByPeer || record.serverId === excludeServerId) continue;
      if (record.alias?.toLowerCase() === alias.toLowerCase()) return true;
    }
    return false;
  }

  private uniqueAlias(seed: string, excludeServerId?: string): string {
    const base = slugifyAlias(seed);
    if (!this.aliasTaken(base, excludeServerId)) return base;
    for (let n = 2; n < 1000; n++) {
      const suffix = `-${n}`;
      const candidate = `${base.slice(0, LINK_BUDGET.aliasChars - suffix.length)}${suffix}`;
      if (!this.aliasTaken(candidate, excludeServerId)) return candidate;
    }
    return `${base.slice(0, LINK_BUDGET.aliasChars - 7)}-${(excludeServerId ?? 'x').slice(0, 6)}`;
  }

  private info(record: StoredLink): LinkInfo {
    const live = this.live.get(record.serverId);
    const up = !!live?.client && !live.client.destroyed && live.served.size > 0;
    const state: LinkState = record.removedByPeer ? 'removed' : up ? 'online' : live?.connecting || (live?.client || live?.served.size) ? 'connecting' : 'offline';
    const name = this.displayName(record);
    const alias = record.alias || this.uniqueAlias(name, record.serverId);
    const webPort = relaysWeb(record) ? this.webPorts.port(record.serverId) : undefined;
    return {
      serverId: record.serverId, name,
      ...(record.customName && record.customName !== record.name ? { peerName: record.name } : {}),
      alias,
      ...(record.note ? { note: record.note } : {}),
      ...(record.platform ? { platform: record.platform } : {}),
      transport: record.transport, address: record.address, dialer: record.dialer,
      inbound: record.inbound, outbound: record.outbound, state,
      ...(record.version ? { version: record.version } : {}), ...(record.protocol ? { protocol: record.protocol } : {}),
      ...(record.transport === 'direct' && record.dialer && record.address ? { webUrl: record.address } : {}),
      ...(webPort ? { localWebUrl: `http://${webHost(alias, record.serverId)}:${webPort}/` } : {}),
      verificationCode: linkVerificationCode(this.identity.fingerprint, record.peerFingerprint),
      createdAt: record.createdAt, ...(record.lastConnectedAt ? { lastConnectedAt: record.lastConnectedAt } : {}),
      ...(live?.lastError && state !== 'online' ? { lastError: live.lastError } : {}),
    };
  }

  private hello(record: Pick<StoredLink, 'inbound'>): Hello {
    return { serverId: this.options.serverId, name: this.selfName(), inbound: record.inbound, version: this.options.version, protocol: this.options.protocol, platform: this.selfPlatform() };
  }

  private async dial(serverId: string) {
    const record = this.records.get(serverId);
    if (!record || record.removedByPeer || this.closed) return;
    const live = this.liveOf(serverId);
    if (live.connecting) return;
    if (live.client && !live.client.destroyed && live.served.size) return;
    live.connecting = true;
    clearTimeout(live.retry);
    this.changed();
    this.teardownTunnels(serverId);
    const epoch = live.epoch;
    // False once the link was removed, the service closed, or the tunnels dropped while this attempt awaited a step.
    const current = () => !this.closed && this.records.get(serverId) === record && this.live.get(serverId) === live && live.epoch === epoch;
    try {
      const { stream, socket } = await this.openTunnel(record, 'primary');
      if (!current()) { socket.destroy(); stream.destroy(); throw new Error(STALE); }
      live.transports.add(stream);
      const session = this.clientSession(socket);
      let reply: Hello;
      try { reply = await control<Hello>(session, '/_link/hello', this.hello(record)); }
      catch (error) {
        session.destroy();
        if (error instanceof AppError && error.code === 'LINK_REMOVED' && current()) {
          record.removedByPeer = true;
          this.save();
          this.options.onSecurityEvent?.({ kind: 'link-removed', serverId, name: this.displayName(record) });
          this.teardown(serverId);
          return;
        }
        throw error;
      }
      if (!current()) { session.destroy(); throw new Error(STALE); }
      if (reply.serverId !== record.serverId) { session.destroy(); throw new Error('The other server answered with a different identity'); }
      Object.assign(record, {
        name: reply.name.slice(0, LINK_BUDGET.nameChars), outbound: reply.inbound, version: reply.version, protocol: reply.protocol,
        ...(reply.platform ? { platform: reply.platform } : {}), lastConnectedAt: new Date().toISOString(),
      });
      this.save();
      this.attachClient(serverId, session);
      await this.openReverse(record, epoch);
      live.backoffMs = 0;
      delete live.lastError;
    } catch (error) {
      if (error instanceof PinMismatchError) this.options.onSecurityEvent?.({ kind: 'link-mismatch', serverId, name: this.displayName(record) });
      if (current()) {
        live.lastError = error instanceof Error ? error.message : String(error);
        this.options.log?.(`[riffet] link ${record.name}: ${live.lastError}`);
        this.teardownTunnels(serverId);
      }
      // A retry that came due while this attempt was still connecting returned at once, so this one always reschedules.
      if (this.records.get(serverId) === record) this.scheduleDial(serverId);
    } finally {
      live.connecting = false;
      this.changed();
    }
  }

  private scheduleDial(serverId: string) {
    const record = this.records.get(serverId);
    if (!record?.dialer || record.removedByPeer || this.closed) return;
    const live = this.liveOf(serverId);
    live.backoffMs = Math.min(LINK_BUDGET.reconnectMaxMs, Math.max(LINK_BUDGET.reconnectMinMs, live.backoffMs * 2));
    clearTimeout(live.retry);
    live.retry = setTimeout(() => { void this.dial(serverId); }, live.backoffMs);
    live.retry.unref();
  }

  /** The dialing side opens the tunnel on which it serves the other side's requests. */
  private async openReverse(record: StoredLink, epoch: number) {
    const { stream, socket } = await this.openTunnel(record, 'reverse');
    const live = this.live.get(record.serverId);
    if (this.closed || !live || live.epoch !== epoch || this.records.get(record.serverId) !== record) {
      socket.destroy(); stream.destroy();
      throw new Error(STALE);
    }
    live.transports.add(stream);
    this.serve(socket, record.peerFingerprint, record.serverId);
  }

  private async openTunnel(record: StoredLink, role: 'primary' | 'reverse', join?: string): Promise<{ stream: Duplex; socket: import('node:tls').TLSSocket }> {
    const stream = record.transport === 'ssh'
      ? sshTransport({ host: record.address, remoteCommand: record.remoteCommand ?? this.options.remoteCommand ?? 'riffet', role, ...(join ? { join } : {}) })
      : await websocketTransport(record.address, role, join);
    try {
      const { socket } = await secure(stream, this.identity, 'client', record.peerFingerprint);
      return { stream, socket };
    } catch (error) {
      stream.destroy();
      throw error;
    }
  }

  private clientSession(socket: import('node:tls').TLSSocket): http2.ClientHttp2Session {
    const session = http2.connect('http://riffet.link', { maxSessionMemory: LINK_BUDGET.sessionMemoryMb, createConnection: () => plain(socket) as never });
    // From the first moment: a peer's GOAWAY with an error code would otherwise be an uncaught exception.
    session.on('error', () => undefined);
    return session;
  }

  private attachClient(serverId: string, session: http2.ClientHttp2Session) {
    const live = this.liveOf(serverId);
    if (live.client && live.client !== session) live.client.destroy();
    live.client = session;
    live.missedPings = 0;
    const lost = () => {
      if (live.client !== session) return;
      delete live.client;
      clearInterval(live.pinger);
      this.dropTunnels(serverId);
    };
    session.once('close', lost);
    session.once('error', lost);
    session.once('goaway', lost);
    clearInterval(live.pinger);
    // Node calls back an unanswered ping only once ten are outstanding, so each interval checks for the answer itself.
    let awaiting = false;
    live.pinger = setInterval(() => {
      if (session.destroyed) return;
      if (awaiting) { if (++live.missedPings >= LINK_BUDGET.missedPings) session.destroy(); return; }
      awaiting = true;
      try { session.ping(error => { awaiting = false; if (!error) live.missedPings = 0; }); }
      catch { session.destroy(); }
    }, LINK_BUDGET.pingMs);
    live.pinger.unref();
  }

  /** Serves the peer's requests on a tunnel where this side is the HTTP/2 server. */
  private serve(socket: import('node:tls').TLSSocket, fingerprint: string, serverId: string | undefined, pendingJoin?: string, onLinked?: () => void) {
    let linkId = serverId;
    // Before a join completes, the caller has proved nothing: one stream at a time, and a deadline.
    const server = http2.createServer({ maxSessionMemory: LINK_BUDGET.sessionMemoryMb, settings: { maxConcurrentStreams: linkId ? LINK_BUDGET.maxStreams : 1 } });
    server.on('sessionError', () => undefined);
    if (!linkId) setTimeout(() => { if (!linkId) socket.destroy(); }, LINK_BUDGET.handshakeMs).unref();
    server.on('session', session => {
      session.on('error', () => undefined);
      if (linkId) this.addServed(linkId, session);
      session.once('close', () => {
        if (!linkId) return;
        // A link is up only with both tunnels, so losing this one drops the other too (`dropTunnels`).
        if (this.live.get(linkId)?.served.delete(session)) this.dropTunnels(linkId);
        else this.changed();
      });
    });
    server.on('stream', (stream, headers) => {
      // A stream the peer resets would otherwise raise an uncaught `ERR_HTTP2_STREAM_ERROR`.
      stream.on('error', () => undefined);
      if (stream.destroyed) return;
      const method = headers[':method'];
      if (method === 'CONNECT') {
        if (!linkId || !this.admits(linkId)) { stream.respond({ ':status': 403 }); stream.end(); return; }
        stream.respond({ ':status': 200 });
        const connection = plain(stream as unknown as Duplex) as Duplex & { [LINK_SOCKET]?: string; [LINK_WEB_SOCKET]?: string };
        // A browser on the peer's machine: no link identity, or it would skip this server's sign-in.
        if (headers[':authority'] === WEB_AUTHORITY) connection[LINK_WEB_SOCKET] = linkId;
        else connection[LINK_SOCKET] = linkId;
        const live = this.liveOf(linkId);
        live.streams.add(connection);
        connection.once('close', () => live.streams.delete(connection));
        this.options.httpServer().emit('connection', connection);
        return;
      }
      void readBody(stream).then(async body => {
        const path = String(headers[':path'] ?? '');
        if (path === '/_link/join') {
          const joined = this.completeJoin(fingerprint, pendingJoin, body);
          linkId = joined.serverId;
          onLinked?.();
          const session = stream.session as http2.ServerHttp2Session | undefined;
          if (session) { session.settings({ maxConcurrentStreams: LINK_BUDGET.maxStreams }); this.addServed(linkId, session); }
          this.liveOf(linkId).transports.add(socket);
          return joined.reply;
        }
        if (!linkId) throw new AppError('LINK_REMOVED', 'This server is no longer linked with yours', 410);
        return this.handleControl(linkId, path, body);
      }).then(reply => {
        if (stream.destroyed) return;
        stream.respond({ ':status': 200, 'content-type': 'application/json' });
        stream.end(JSON.stringify(reply ?? {}));
      }, error => {
        const status = error instanceof AppError ? error.statusCode : 500;
        const code = error instanceof AppError ? error.code : 'LINK_CONTROL_FAILED';
        if (!stream.destroyed) { stream.respond({ ':status': status, 'content-type': 'application/json' }); stream.end(JSON.stringify({ error: { code, message: error instanceof Error ? error.message : String(error) } })); }
      });
    });
    server.emit('connection', plain(socket));
  }

  /** A certificate nobody here paired with: answer only that the link is gone, so its dialer stops retrying. */
  private serveUnknown(socket: import('node:tls').TLSSocket) {
    const server = http2.createServer({ settings: { maxConcurrentStreams: 1 } });
    server.on('sessionError', () => undefined);
    server.on('session', session => { session.on('error', () => undefined); });
    server.on('stream', stream => {
      stream.on('error', () => undefined);
      if (stream.destroyed) return;
      stream.respond({ ':status': 410, 'content-type': 'application/json' });
      stream.end(JSON.stringify({ error: { code: 'LINK_REMOVED', message: 'This server is no longer linked with yours' } }));
      setTimeout(() => stream.session?.destroy(), 100).unref();
    });
    server.emit('connection', plain(socket));
    setTimeout(() => socket.destroy(), LINK_BUDGET.handshakeMs).unref();
  }

  private addServed(serverId: string, session: http2.ServerHttp2Session) {
    const live = this.liveOf(serverId);
    if (live.served.has(session)) return;
    live.served.add(session);
    this.changed();
  }

  private completeJoin(fingerprint: string, inviteId: string | undefined, body: Record<string, unknown>): { serverId: string; reply: Hello } {
    this.pruneInvites();
    const invite = inviteId ? this.invites.get(inviteId) : undefined;
    if (!invite || body.inviteId !== inviteId) throw new AppError('LINK_EXPIRED', 'The link string has expired or was already used; make a new one', 410);
    if (!proofMatches(inviteProof(invite.key, invite.inviteId, this.identity.fingerprint, fingerprint), body.proof)) {
      throw new AppError('LINK_PROOF_INVALID', 'The link string does not match', 403);
    }
    const hello = parseHello(body);
    if (hello.serverId === this.options.serverId) throw new AppError('LINK_SELF', 'A server cannot link with itself', 400);
    // The joiner names its own id, so it may not take over another link's id or reuse a certificate pinned to one.
    const previous = this.records.get(hello.serverId);
    if (previous && !previous.removedByPeer) throw new AppError('LINK_EXISTS', `Already linked with ${this.displayName(previous)}`, 409, undefined, { name: this.displayName(previous) });
    if (this.byFingerprint(fingerprint)) throw new AppError('LINK_MISMATCH', 'This certificate is already linked under another server', 403);
    this.invites.delete(invite.inviteId);
    const record: StoredLink = {
      serverId: hello.serverId, name: hello.name,
      alias: this.uniqueAlias(hello.name, hello.serverId),
      ...(hello.platform ? { platform: hello.platform } : {}),
      transport: 'direct', address: '', dialer: false, peerFingerprint: fingerprint,
      inbound: invite.inbound, outbound: hello.inbound, createdAt: new Date().toISOString(), lastConnectedAt: new Date().toISOString(),
      version: hello.version, protocol: hello.protocol,
    };
    if (previous) { this.teardown(hello.serverId); this.audits.delete(hello.serverId); }
    this.records.set(record.serverId, record);
    this.save();
    this.changed();
    this.options.onSecurityEvent?.({ kind: 'link-added', serverId: record.serverId, name: record.name, detail: record.inbound ? 'inbound' : 'no-inbound' });
    return { serverId: record.serverId, reply: this.hello(record) };
  }

  private handleControl(serverId: string, path: string, body: Record<string, unknown>): unknown {
    const record = this.records.get(serverId);
    if (!record || record.removedByPeer) throw new AppError('LINK_REMOVED', 'This server is no longer linked with yours', 410);
    if (path === '/_link/hello') {
      const hello = parseHello(body);
      if (hello.serverId !== serverId) throw new AppError('LINK_MISMATCH', 'Identity does not match the paired certificate', 403);
      Object.assign(record, {
        name: hello.name, outbound: hello.inbound, version: hello.version, protocol: hello.protocol,
        ...(hello.platform ? { platform: hello.platform } : {}), lastConnectedAt: new Date().toISOString(),
      });
      this.save();
      this.changed();
      return this.hello(record);
    }
    if (path === '/_link/state') {
      let dirty = false;
      if (typeof body.inbound === 'boolean' && body.inbound !== record.outbound) { record.outbound = body.inbound; dirty = true; }
      if (typeof body.name === 'string' && body.name.trim()) {
        const nextName = body.name.trim().slice(0, LINK_BUDGET.nameChars);
        if (nextName !== record.name) { record.name = nextName; dirty = true; }
      }
      if (dirty) { this.save(); this.changed(); }
      return {};
    }
    if (path === '/_link/remove') {
      record.removedByPeer = true;
      record.outbound = false;
      this.save();
      this.options.onSecurityEvent?.({ kind: 'link-removed', serverId, name: this.displayName(record) });
      setImmediate(() => { this.teardown(serverId); this.changed(); });
      return {};
    }
    throw new AppError('LINK_CONTROL_UNKNOWN', 'Unknown link control request', 404);
  }

  private closeInbound(serverId: string) {
    const live = this.live.get(serverId);
    for (const stream of live?.streams ?? []) stream.destroy();
    for (const revoke of this.revokers) revoke(serverId);
  }

  /** A link is up only with both tunnels: losing either drops both, and the dialing side dials again. */
  private dropTunnels(serverId: string) {
    if (!this.live.has(serverId)) return;
    this.teardownTunnels(serverId);
    this.changed();
    this.scheduleDial(serverId);
  }

  private teardownTunnels(serverId: string) {
    const live = this.live.get(serverId);
    if (!live) return;
    live.epoch++;
    clearInterval(live.pinger);
    live.client?.destroy();
    delete live.client;
    for (const session of live.served) session.destroy();
    live.served.clear();
    for (const stream of live.streams) stream.destroy();
    live.streams.clear();
    for (const transport of live.transports) transport.destroy();
    live.transports.clear();
  }

  private teardown(serverId: string) {
    const live = this.live.get(serverId);
    if (live) clearTimeout(live.retry);
    this.teardownTunnels(serverId);
    this.live.delete(serverId);
    for (const revoke of this.revokers) revoke(serverId);
  }

  private liveOf(serverId: string): Live {
    let live = this.live.get(serverId);
    if (!live) { live = { served: new Set(), streams: new Set(), transports: new Set(), connecting: false, backoffMs: 0, missedPings: 0, epoch: 0 }; this.live.set(serverId, live); }
    return live;
  }

  /** The live link pinned to this certificate; one the peer ended does not count, so the two can link again. */
  private byFingerprint(fingerprint: string): StoredLink | undefined {
    for (const record of this.records.values()) if (!record.removedByPeer && sameFingerprint(record.peerFingerprint, fingerprint)) return record;
    return undefined;
  }

  private require(serverId: string): StoredLink {
    const record = this.records.get(serverId);
    if (!record) throw new AppError('LINK_NOT_FOUND', 'No such linked server', 404);
    return record;
  }

  private pruneInvites() {
    const now = Date.now();
    for (const [id, invite] of this.invites) if (invite.expiresAt <= now) this.invites.delete(id);
  }

  private changed() {
    this.syncWebPorts();
    for (const listener of this.listeners) listener();
  }

  /** A loopback port for each link that may operate a peer able to tell a relayed browser from the link itself. */
  private syncWebPorts() {
    if (this.closed) return;
    const wanted = new Map<string, number | undefined>();
    for (const record of this.records.values()) if (relaysWeb(record)) wanted.set(record.serverId, record.webPort);
    this.webPorts.sync(wanted);
  }

  private save() { writeJson(this.path, [...this.records.values()]); }
  private saveAudit() { writeJson(this.auditPath, Object.fromEntries(this.audits)); }
}

function relaysWeb(record: StoredLink): boolean {
  return !record.removedByPeer && record.outbound && !!record.protocol?.features?.includes('link-web-v1');
}

/**
 * One loopback host name per peer. Cookies ignore the port, so on a shared name the peer's sign-in would replace this
 * server's (and another peer's); `*.localhost` keeps each apart and still counts as a secure context.
 */
function webHost(alias: string, serverId: string): string {
  const label = alias.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  // An alias with dots or underscores could fold onto another one's label, so it is told apart by the server id.
  return `${label === alias ? label : `${label || 'server'}-${serverId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase()}`}.localhost`;
}

/** Thrown by a dial that found the link changed under it; it is not the link's error. */
const STALE = 'The link changed while its tunnel was opening';

/** `direct`: a WebSocket to the other server's `/api/links/tunnel`. */
async function websocketTransport(address: string, role: 'primary' | 'reverse', join?: string): Promise<Duplex> {
  const url = new URL('/api/links/tunnel', address);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('role', role);
  if (join) url.searchParams.set('join', join);
  const socket = new WebSocket(url, { handshakeTimeout: LINK_BUDGET.handshakeMs, maxPayload: LINK_BUDGET.tunnelMessageBytes });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
    socket.once('unexpected-response', (_request, response) => reject(new Error(`The other server refused the tunnel (HTTP ${response.statusCode})`)));
  });
  return boundedWrites(createWebSocketStream(socket));
}

/** A JSON request on the link's own control path, inside the tunnel. */
function control<T>(session: http2.ClientHttp2Session, path: string, body: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const stream = session.request({ ':method': 'POST', ':path': path, 'content-type': 'application/json' });
    const timer = setTimeout(() => { stream.close(); reject(new Error('The other server did not answer in time')); }, LINK_BUDGET.controlMs);
    let status = 0;
    const chunks: Buffer[] = [];
    stream.on('response', headers => { status = Number(headers[':status'] ?? 0); });
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => {
      clearTimeout(timer);
      let parsed: { error?: { code?: string; message?: string } } & Record<string, unknown> = {};
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* reported below */ }
      if (status >= 200 && status < 300) resolve(parsed as T);
      else reject(new AppError(parsed.error?.code ?? 'LINK_CONTROL_FAILED', parsed.error?.message ?? `The other server answered ${status}`, status || 502));
    });
    stream.on('error', error => { clearTimeout(timer); reject(error); });
    stream.end(JSON.stringify(body));
  });
}

function readBody(stream: http2.ServerHttp2Stream): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > LINK_BUDGET.controlBytes) { stream.close(); reject(new AppError('LINK_CONTROL_TOO_LARGE', 'Control request too large', 413)); return; }
      chunks.push(chunk);
    });
    stream.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new AppError('LINK_CONTROL_INVALID', 'Control request is not JSON', 400)); }
    });
    stream.on('error', reject);
  });
}

function parseHello(body: Record<string, unknown>): Hello {
  const { serverId, name, inbound, version, protocol, platform } = body as Partial<Hello>;
  if (typeof serverId !== 'string' || !/^[0-9a-f-]{36}$/.test(serverId) || typeof name !== 'string' || typeof inbound !== 'boolean'
    || typeof version !== 'string' || typeof protocol?.version !== 'number' || !Array.isArray(protocol.features)) {
    throw new AppError('LINK_CONTROL_INVALID', 'The other server sent an invalid hello', 400);
  }
  const parsedPlatform = platform && typeof platform === 'object' && typeof platform.os === 'string' && typeof platform.arch === 'string'
    ? { os: platform.os.slice(0, 32), arch: platform.arch.slice(0, 32) }
    : undefined;
  return {
    serverId, name: name.slice(0, LINK_BUDGET.nameChars), inbound, version: version.slice(0, 64),
    protocol: { version: protocol.version, features: protocol.features.filter(item => typeof item === 'string').slice(0, 64) },
    ...(parsedPlatform ? { platform: parsedPlatform } : {}),
  };
}

function normalUrl(value: string): string {
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`); }
  catch { throw new AppError('INVALID_LINK_URL', `Not an address: ${value}`, 400); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new AppError('INVALID_LINK_URL', 'The address must start with http:// or https://', 400);
  return url.origin;
}

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error; }
}

function writeJson(path: string, value: unknown) {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
