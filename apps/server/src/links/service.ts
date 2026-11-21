import http from 'node:http';
import http2 from 'node:http2';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import WebSocket, { createWebSocketStream } from 'ws';
import type { LinkAuditEntry, LinkInfo, LinkInviteResult, LinkJoinRequest, LinkState, LinkTransportId, ProtocolInfo, ServerInfo } from '../../../../packages/contracts/src/index.js';
import { LINK_BUDGET } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { loadLinkIdentity, sameFingerprint, type LinkIdentity } from './identity.js';
import { decodeInvite, encodeInvite, inviteProof, newInviteSecret, proofMatches, type LinkInvite } from './invite.js';
import { LINK_SOCKET } from './socket.js';
import { boundedWrites, plain, secure } from './tunnel.js';
import { sshTransport } from './ssh.js';

/**
 * Links between this server and others (docs/SERVER-LINKS.md). Each link is a pinned pair of certificates and two
 * tunnels, both dialed by whichever side can reach the other: on the `primary` tunnel the dialer is the HTTP/2 client,
 * on the `reverse` one the acceptor is. Each side sends its requests on the session where it is the client and serves
 * the other side's on the session where it is the server, so the roles at the HTTP/2 layer never depend on who dialed.
 *
 * A forwarded connection is one CONNECT stream carrying plain HTTP/1.1. The serving side hands it to its ordinary
 * HTTP server marked with `LINK_SOCKET`; `app.ts` then applies `policy.ts` and the inbound switch to it.
 */

export interface StoredLink {
  serverId: string;
  name: string;
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
}

interface Hello { serverId: string; name: string; inbound: boolean; version: string; protocol: ProtocolInfo }
interface PendingInvite { inviteId: string; key: string; inbound: boolean; expiresAt: number }

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
}

type Listener = () => void;

export class LinkService {
  readonly identity: LinkIdentity;
  private records = new Map<string, StoredLink>();
  private readonly live = new Map<string, Live>();
  private readonly invites = new Map<string, PendingInvite>();
  private readonly audits = new Map<string, LinkAuditEntry[]>();
  private readonly listeners = new Set<Listener>();
  private readonly revokers = new Set<(serverId: string) => void>();
  private readonly path: string;
  private readonly auditPath: string;
  private auditTimer?: NodeJS.Timeout;
  private closed = false;
  /** Tunnels accepted but not yet tied to a link (`LINK_BUDGET.pendingTunnels`). */
  private pendingTunnels = 0;

  constructor(private readonly options: LinkServiceOptions) {
    this.identity = loadLinkIdentity(options.stateDir, options.name());
    this.path = join(options.stateDir, 'links.json');
    this.auditPath = join(options.stateDir, 'link-audit.json');
    for (const record of readJson<StoredLink[]>(this.path, [])) if (record?.serverId) this.records.set(record.serverId, record);
    for (const [serverId, entries] of Object.entries(readJson<Record<string, LinkAuditEntry[]>>(this.auditPath, {}))) {
      if (Array.isArray(entries)) this.audits.set(serverId, entries.slice(-LINK_BUDGET.auditEntries));
    }
  }

  /** Dials every link this side dials. Called once the HTTP server is ready to take forwarded connections. */
  start() {
    for (const record of this.records.values()) if (record.dialer && !record.removedByPeer) void this.dial(record.serverId);
  }

  onChange(listener: Listener): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  /** Streams authenticated by a link (`auth.onRevoke`) close through this when the link ends or loses inbound. */
  onRevoke(listener: (serverId: string) => void): () => void { this.revokers.add(listener); return () => { this.revokers.delete(listener); }; }

  list(): LinkInfo[] {
    return [...this.records.values()].map(record => this.info(record)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  servers(): ServerInfo[] {
    const self: ServerInfo = { id: this.options.serverId, name: this.options.name(), self: true, online: true, version: this.options.version, protocol: this.options.protocol, compatible: true, inbound: true, outbound: true };
    return [self, ...[...this.records.values()].filter(record => !record.removedByPeer).map(record => {
      const info = this.info(record);
      return {
        id: record.serverId, name: record.name, online: info.state === 'online',
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
    const invite: LinkInvite = { url, serverId: this.options.serverId, name: this.options.name(), fingerprint: this.identity.fingerprint, inviteId, key, expiresAt };
    return { link: encodeInvite(invite), expiresAt };
  }

  /** Joins the server that made `request.link`, dials it, and keeps the link. */
  async join(request: LinkJoinRequest): Promise<LinkInfo> {
    const invite = decodeInvite(request.link);
    if (invite.serverId === this.options.serverId) throw new AppError('LINK_SELF', 'This link string was made on this server', 400);
    const existing = this.records.get(invite.serverId);
    if (existing && !existing.removedByPeer) throw new AppError('LINK_EXISTS', `Already linked with ${existing.name}`, 409, undefined, { name: existing.name });
    const transport: LinkTransportId = request.transport ?? 'direct';
    if (transport === 'direct' && !invite.url) throw new AppError('LINK_ADDRESS_REQUIRED', 'The link string has no address to dial; join over SSH instead', 400);
    if (transport === 'ssh' && !request.sshHost?.trim()) throw new AppError('LINK_ADDRESS_REQUIRED', 'Give the SSH destination of the other server', 400);
    const draft: StoredLink = {
      serverId: invite.serverId, name: invite.name.slice(0, LINK_BUDGET.nameChars), transport,
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
      Object.assign(draft, { name: reply.name.slice(0, LINK_BUDGET.nameChars), outbound: reply.inbound, version: reply.version, protocol: reply.protocol, lastConnectedAt: new Date().toISOString() });
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

  update(serverId: string, change: { inbound?: boolean }): LinkInfo {
    const record = this.require(serverId);
    if (change.inbound !== undefined && change.inbound !== record.inbound) {
      record.inbound = change.inbound;
      this.save();
      if (!record.inbound) this.closeInbound(serverId);
      const client = this.live.get(serverId)?.client;
      if (client && !client.destroyed) void control(client, '/_link/state', { inbound: record.inbound }).catch(() => undefined);
    }
    this.changed();
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
    if (!record.outbound) throw new AppError('LINK_NOT_ALLOWED', `${record.name} does not allow this server to operate it`, 403, undefined, { name: record.name });
    const client = this.live.get(serverId)?.client;
    if (!client || client.destroyed || client.closed) throw new AppError('LINK_OFFLINE', `${record.name} is offline`, 503, undefined, { name: record.name });
    return plain(client.request({ ':method': 'CONNECT', ':authority': 'riffet.link:80' }) as unknown as Duplex);
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
    clearTimeout(this.auditTimer);
    this.saveAudit();
    for (const serverId of [...this.live.keys()]) this.teardown(serverId);
  }

  // Internals.

  private info(record: StoredLink): LinkInfo {
    const live = this.live.get(record.serverId);
    const up = !!live?.client && !live.client.destroyed && live.served.size > 0;
    const state: LinkState = record.removedByPeer ? 'removed' : up ? 'online' : live?.connecting || (live?.client || live?.served.size) ? 'connecting' : 'offline';
    return {
      serverId: record.serverId, name: record.name, transport: record.transport, address: record.address, dialer: record.dialer,
      inbound: record.inbound, outbound: record.outbound, state,
      ...(record.version ? { version: record.version } : {}), ...(record.protocol ? { protocol: record.protocol } : {}),
      ...(record.transport === 'direct' && record.dialer && record.address ? { webUrl: record.address } : {}),
      createdAt: record.createdAt, ...(record.lastConnectedAt ? { lastConnectedAt: record.lastConnectedAt } : {}),
      ...(live?.lastError && state !== 'online' ? { lastError: live.lastError } : {}),
    };
  }

  private hello(record: Pick<StoredLink, 'inbound'>): Hello {
    return { serverId: this.options.serverId, name: this.options.name().slice(0, LINK_BUDGET.nameChars), inbound: record.inbound, version: this.options.version, protocol: this.options.protocol };
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
          this.teardown(serverId);
          return;
        }
        throw error;
      }
      if (!current()) { session.destroy(); throw new Error(STALE); }
      if (reply.serverId !== record.serverId) { session.destroy(); throw new Error('The other server answered with a different identity'); }
      Object.assign(record, { name: reply.name.slice(0, LINK_BUDGET.nameChars), outbound: reply.inbound, version: reply.version, protocol: reply.protocol, lastConnectedAt: new Date().toISOString() });
      this.save();
      this.attachClient(serverId, session);
      await this.openReverse(record, epoch);
      live.backoffMs = 0;
      delete live.lastError;
    } catch (error) {
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
        const connection = plain(stream as unknown as Duplex) as Duplex & { [LINK_SOCKET]?: string };
        connection[LINK_SOCKET] = linkId;
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
    if (previous && !previous.removedByPeer) throw new AppError('LINK_EXISTS', `Already linked with ${previous.name}`, 409, undefined, { name: previous.name });
    if (this.byFingerprint(fingerprint)) throw new AppError('LINK_MISMATCH', 'This certificate is already linked under another server', 403);
    this.invites.delete(invite.inviteId);
    const record: StoredLink = {
      serverId: hello.serverId, name: hello.name, transport: 'direct', address: '', dialer: false, peerFingerprint: fingerprint,
      inbound: invite.inbound, outbound: hello.inbound, createdAt: new Date().toISOString(), lastConnectedAt: new Date().toISOString(),
      version: hello.version, protocol: hello.protocol,
    };
    if (previous) { this.teardown(hello.serverId); this.audits.delete(hello.serverId); }
    this.records.set(record.serverId, record);
    this.save();
    this.changed();
    return { serverId: record.serverId, reply: this.hello(record) };
  }

  private handleControl(serverId: string, path: string, body: Record<string, unknown>): unknown {
    const record = this.records.get(serverId);
    if (!record || record.removedByPeer) throw new AppError('LINK_REMOVED', 'This server is no longer linked with yours', 410);
    if (path === '/_link/hello') {
      const hello = parseHello(body);
      if (hello.serverId !== serverId) throw new AppError('LINK_MISMATCH', 'Identity does not match the paired certificate', 403);
      Object.assign(record, { name: hello.name, outbound: hello.inbound, version: hello.version, protocol: hello.protocol, lastConnectedAt: new Date().toISOString() });
      this.save();
      this.changed();
      return this.hello(record);
    }
    if (path === '/_link/state') {
      if (typeof body.inbound === 'boolean') { record.outbound = body.inbound; this.save(); this.changed(); }
      return {};
    }
    if (path === '/_link/remove') {
      record.removedByPeer = true;
      record.outbound = false;
      this.save();
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

  private changed() { for (const listener of this.listeners) listener(); }

  private save() { writeJson(this.path, [...this.records.values()]); }
  private saveAudit() { writeJson(this.auditPath, Object.fromEntries(this.audits)); }
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
  const { serverId, name, inbound, version, protocol } = body as Partial<Hello>;
  if (typeof serverId !== 'string' || !/^[0-9a-f-]{36}$/.test(serverId) || typeof name !== 'string' || typeof inbound !== 'boolean'
    || typeof version !== 'string' || typeof protocol?.version !== 'number' || !Array.isArray(protocol.features)) {
    throw new AppError('LINK_CONTROL_INVALID', 'The other server sent an invalid hello', 400);
  }
  return { serverId, name: name.slice(0, LINK_BUDGET.nameChars), inbound, version: version.slice(0, 64), protocol: { version: protocol.version, features: protocol.features.filter(item => typeof item === 'string').slice(0, 64) } };
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
