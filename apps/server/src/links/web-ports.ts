import net from 'node:net';
import type { Duplex } from 'node:stream';

/**
 * Loopback ports through which a browser on this machine opens a linked server's own web app (docs/TRANSPORT-SECURITY.md
 * §3, "Mac 浏览器经本机转发访问对端"). Each accepted connection is carried byte for byte on its own stream through the
 * link's encrypted tunnel, so the page, its cookie and the access token typed into it never cross the network in plain
 * text. The peer serves it as a remote browser: sign-in, Host, Origin and CSRF checks all apply there.
 *
 * A port belongs to one link and lives while the link may operate the peer (`LinkService#syncWebPorts`); closing it
 * also ends every connection it relayed. It listens on 127.0.0.1 and ::1 alike, because `*.localhost` resolves to
 * both and a browser that tried ::1 first would otherwise reach whatever else listens there.
 */
export class LinkWebPorts {
  private readonly ports = new Map<string, Port>();

  constructor(private readonly options: {
    /** A fresh stream to the peer's web app through the tunnel; throws while the link cannot carry one. */
    open: (serverId: string) => Duplex;
    /** The port is listening, or moved to another number than the one it had before. */
    onListening: (serverId: string, port: number) => void;
    log?: (message: string) => void;
  }) {}

  /** The listening port of `serverId`, once it is up. */
  port(serverId: string): number | undefined {
    return this.ports.get(serverId)?.port;
  }

  /** Opens a port for each link in `wanted` (on its previous number when that is free) and closes the others. */
  sync(wanted: ReadonlyMap<string, number | undefined>) {
    for (const serverId of [...this.ports.keys()]) if (!wanted.has(serverId)) this.close(serverId);
    for (const [serverId, preferred] of wanted) if (!this.ports.has(serverId)) void this.listen(serverId, preferred);
  }

  closeAll() {
    for (const serverId of [...this.ports.keys()]) this.close(serverId);
  }

  private close(serverId: string) {
    const entry = this.ports.get(serverId);
    if (!entry) return;
    this.ports.delete(serverId);
    entry.closed = true;
    for (const server of entry.servers) server.close();
    for (const socket of entry.sockets) socket.destroy();
  }

  private async listen(serverId: string, preferred: number | undefined) {
    const entry: Port = { servers: [], sockets: new Set(), closed: false };
    this.ports.set(serverId, entry);
    const relay = (socket: net.Socket) => {
      socket.on('error', () => undefined);
      if (entry.closed) { socket.destroy(); return; }
      let tunnel: Duplex;
      try { tunnel = this.options.open(serverId); }
      catch { socket.destroy(); return; }
      entry.sockets.add(socket);
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        entry.sockets.delete(socket);
        socket.destroy(); tunnel.destroy();
      };
      socket.once('close', end);
      tunnel.once('close', end);
      tunnel.once('error', end);
      socket.pipe(tunnel).pipe(socket);
    };
    // The previous number keeps the page's origin, so its local storage and open tabs survive a restart.
    for (const port of preferred ? [preferred, 0, 0] : [0, 0, 0]) {
      const servers = await listenBoth(relay, port).catch(error => {
        this.options.log?.(`[riffet] link web port ${port || 'any'}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      });
      if (!servers) continue;
      if (entry.closed) { for (const server of servers) server.close(); return; }
      entry.servers = servers;
      entry.port = (servers[0]!.address() as net.AddressInfo).port;
      this.options.onListening(serverId, entry.port);
      return;
    }
    // The entry stays without a port, so the next `sync` does not try again on every link change; it is retried once
    // the link stops qualifying and qualifies again, or on restart.
  }
}

interface Port { servers: net.Server[]; port?: number; sockets: Set<net.Socket>; closed: boolean }

/** 127.0.0.1 and ::1 on one port number. ::1 may be missing (IPv6 off); taken by someone else, the number is not used. */
async function listenBoth(relay: (socket: net.Socket) => void, port: number): Promise<net.Server[]> {
  const v4 = net.createServer(relay);
  const bound = await listenOn(v4, '127.0.0.1', port);
  const v6 = net.createServer(relay);
  try {
    await listenOn(v6, '::1', bound);
    return [v4, v6];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRNOTAVAIL' || (error as NodeJS.ErrnoException).code === 'EAFNOSUPPORT') return [v4];
    v4.close();
    throw error;
  }
}

function listenOn(server: net.Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const fail = (error: Error) => { server.close(); reject(error); };
    server.once('error', fail);
    server.listen({ host, port, exclusive: true }, () => {
      server.off('error', fail);
      server.on('error', () => undefined);
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}
