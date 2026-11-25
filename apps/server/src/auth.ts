import { randomBytes, createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { networkInterfaces, hostname } from 'node:os';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { AppError } from './errors.js';
import { mdnsNames } from './mdns-name.js';
import { linkOfRequest } from './links/socket.js';
import { SESSION_COOKIE_BUDGET, type DevicePushRegistration, type DeviceReport } from '../../../packages/contracts/src/index.js';
import { secureTransport, trustedNetworks } from './access/transport.js';

/**
 * A request a proxy relayed: a reverse proxy, an SSH-less front door or `tailscale serve` reaches a
 * loopback binding too, so the peer address alone does not mean the request came from this machine.
 */
export const proxiedRequest = (headers?: import('node:http').IncomingHttpHeaders): boolean =>
  // `x-riffet-link` is set by the server itself on requests that came through a link (`app.ts`); a client sending it
  // only makes its own request count as remote.
  Boolean(headers && (headers['x-forwarded-for'] || headers.forwarded || headers['x-real-ip'] || headers['tailscale-user-login'] || headers['x-riffet-link']));
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1']);

/** Sent from this machine itself: a loopback peer, not relayed by a proxy, and addressed by a loopback name. */
export function localRequest(request: Pick<FastifyRequest, 'ip' | 'headers'>): boolean {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip) || proxiedRequest(request.headers)) return false;
  const hostHeader = request.headers.host;
  if (!hostHeader) return false;
  let host: URL;
  try { host = new URL(`http://${hostHeader}`); } catch { return false; }
  return LOOPBACK_NAMES.has(normalizeHost(host.hostname));
}

/**
 * A paired native client or browser. `hash` never leaves the server. The device's own report
 * (`PUT /api/devices/me`, docs/DEVICES.md §3) fills in the rest; a browser never sends one.
 */
export interface DeviceRecord extends Partial<DeviceReport> {
  id: string; name: string; hash: string; createdAt: string; lastSeenAt?: string;
  /** The `X-Riffet-Features` the device sent with its last report: what its lists show, so what may be pushed to it. */
  features?: string[];
}
export type PublicDevice = Omit<DeviceRecord, 'hash' | 'installationId' | 'push' | 'features'>;
export interface IssuedDevice { device: PublicDevice; token: string }
/** What a file-site token reads: files below `root`, through the project's read scope. */
/** What a file-site token reads: files below `root` through the project's read scope, or only `only` there. */
export interface FileSiteScope { projectId: string; root: string; only?: string }
/** The route a previewed page's own links and assets go through, authorized by the token in its path. */
/** The token is the first path segment: it outgrows the router's limit on named parameters. */
export const FILE_SITE_ROUTE = '/api/file-sites/*';
/** A preview left open over a working day keeps following its links; reopening it mints a fresh token. */
const FILE_SITE_TTL_MS = 12 * 3600_000;
/**
 * Cookie callers keep their CSRF obligations; a paired device proves itself with a bearer token; a linked server is
 * the one whose pinned certificate opened the tunnel the connection came through (docs/SERVER-LINKS.md §4).
 */
export type AuthKind = 'cookie' | 'device' | 'link';
export interface AuthContext { kind: AuthKind; cookie?: string; deviceId?: string; linkServerId?: string }

const DEVICE_TOKEN = /^wkn_([0-9a-f]{16})_(.+)$/;
const SESSION_COOKIE = 'cw_session';
const SECURE_SESSION_COOKIE = '__Host-cw_session';
/** Persisting every request would rewrite the file on each poll; the timestamp is in-memory between flushes. */
const DEVICE_FLUSH_MS = 60_000;
/** How long the interface address list is reused. */
const HOSTS_CACHE_MS = 5_000;

export class Auth {
  readonly token: string;
  readonly tokenRequired: boolean;
  /** Networks the operator says are already encrypted (`--trust-network`). */
  private readonly trusted: import('node:net').BlockList | undefined;
  private readonly staticHosts: Set<string>;
  private readonly signingKey: string;
  private readonly devicesPath: string;
  private devices: DeviceRecord[];
  /** Live streams by credential: `device:<id>` for a paired device (bearer or its cookie), `cookie:<nonce>` for a signed-in cookie. */
  private readonly revocations=new Map<string,Set<()=>void>>();
  private devicesFlushedAt = 0;
  private readonly revokedListeners=new Set<(id:string)=>void>();
  private readonly sessionsPath: string;
  /** Raised to end every outstanding master-token cookie at once; a cookie carries the epoch it was issued under. */
  private sessionEpoch = 0;
  /** Cookies ended by a logout, kept until they would have expired anyway. */
  private revokedSessions: Record<string, number> = {};
  private hostsCache?: { at: number; hosts: ReadonlySet<string> };
  constructor(stateDir: string, options: {token?:string;host?:string;allowedHosts?:string[];auth?:boolean;trustedNetworks?:string[]} = {}) {
    this.trusted=trustedNetworks(options.trustedNetworks);
    mkdirSync(stateDir,{recursive:true,mode:0o700});
    const path=join(stateDir,'access-token');
    let saved: string|undefined;
    try { saved=readFileSync(path,'utf8').trim(); } catch {}
    this.token=options.token ?? saved ?? randomBytes(32).toString('base64url');
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(normalizeHost(options.host ?? '127.0.0.1'));
    this.tokenRequired=options.auth!==false;
    if(!this.tokenRequired&&!loopback)throw new AppError('LOCAL_ACCESS_ONLY','Token-free access must bind to 127.0.0.1, localhost or ::1');
    if (!this.token.length || (!loopback && this.token.length<24)) throw new AppError('WEAK_TOKEN','LAN access requires an access token with at least 24 characters');
    if (this.token!==saved) writeFileSync(path,this.token+'\n',{mode:0o600});
    const secretPath=join(stateDir,'cookie-secret');
    let secret: string;
    try { secret=readFileSync(secretPath,'utf8').trim(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;
      secret=randomBytes(32).toString('base64url');
      writeFileSync(secretPath,secret+'\n',{mode:0o600,flag:'wx'});
    }
    if (secret.length<40) throw new AppError('INVALID_COOKIE_SECRET','Workbench cookie secret is invalid');
    // Cookie signatures stay unpredictable with a short local password; rotation invalidates old sessions.
    this.signingKey=createHmac('sha256',secret).update('access-token:'+this.token).digest('base64url');
    this.staticHosts=new Set(['localhost','127.0.0.1','::1',hostname(),...options.allowedHosts??[]].map(normalizeHost));
    if (options.host && !['0.0.0.0','::'].includes(options.host)) this.staticHosts.add(normalizeHost(options.host));
    this.devicesPath=join(stateDir,'devices.json');
    this.devices=readDevices(this.devicesPath);
    this.sessionsPath=join(stateDir,'sessions.json');
    ({epoch:this.sessionEpoch,revoked:this.revokedSessions}=readSessions(this.sessionsPath));
  }
  /**
   * The `Host` values this machine answers to, evaluated on every check.
   *
   * Interface addresses are re-read rather than captured at construction. DHCP, VPN and Wi-Fi
   * changes move a laptop's addresses out from under a long-running daemon, so a snapshot taken at
   * startup keeps accepting the address the machine had when it booted while rejecting the one it
   * has now — a phone paired on the office network then stops connecting at home. The mDNS name
   * covers the same ground for callers that reach this host by name; it is memoized because
   * resolving it spawns a process.
   */
  get allowedHosts(): ReadonlySet<string> {
    // Every API request asks; the interface table only needs to be as fresh as a network change is rare.
    const current=Date.now();
    if(this.hostsCache&&current-this.hostsCache.at<HOSTS_CACHE_MS)return this.hostsCache.hosts;
    const addresses=Object.values(networkInterfaces()).flatMap(items=>(items??[]).map(item=>item.address));
    const hosts=new Set([...this.staticHosts,...addresses,...mdnsNames()].map(normalizeHost));
    this.hostsCache={at:current,hosts};
    return hosts;
  }
  checkOrigin(request: FastifyRequest) {
    // A tunneled connection is not a browser's: no Host to check, and the tunnel's TLS authenticated it.
    if (linkOfRequest(request.raw)) return;
    // Absolute-form targets (`GET http://host/api/x`) are proxy syntax; the router would still
    // map them onto API routes, so only origin-form paths reach any handler.
    if (!(request.raw?.url ?? request.url ?? '/').startsWith('/')) throw new AppError('INVALID_REQUEST_TARGET','Request target must be an absolute path',400);
    const hostHeader=request.headers.host;
    if (!hostHeader) throw new AppError('INVALID_HOST','Host header is required',403);
    let host: URL;
    try { host=new URL(`http://${hostHeader}`); } catch { throw new AppError('INVALID_HOST','Invalid Host header',403); }
    if (!this.allowedHosts.has(normalizeHost(host.hostname))) throw new AppError('INVALID_HOST','This hostname is not allowed',403);
    // A previewed page runs in an opaque origin, so its links, assets and fetches arrive cross-site
    // with `Origin: null`. Its route only reads, behind the token in its path.
    const fileSite=request.routeOptions?.url===FILE_SITE_ROUTE&&['GET','HEAD'].includes(request.method);
    const origin=request.headers.origin;
    if (origin && !(fileSite && origin==='null')) {
      let url: URL; try { url=new URL(origin); } catch { throw new AppError('INVALID_ORIGIN','Invalid Origin',403); }
      if (!['http:','https:'].includes(url.protocol) || url.host.toLowerCase()!==host.host.toLowerCase()) throw new AppError('INVALID_ORIGIN','Cross-origin access is not allowed',403);
    }
    if (request.headers['sec-fetch-site']==='cross-site' && !fileSite) {
      // Following a link from another site is a normal way to open the workbench. Only allow
      // top-level document navigation; API calls, embedded pages and mutations stay blocked.
      const documentNavigation=['GET','HEAD'].includes(request.method)
        && request.headers['sec-fetch-mode']==='navigate'
        && request.headers['sec-fetch-dest']==='document'
        && !isApiRequest(request);
      if(!documentNavigation)throw new AppError('INVALID_ORIGIN','Cross-site access is not allowed',403);
    }
    // Token-free access is for this machine only. A proxy on the same machine connects from
    // loopback, so a forwarded request or one addressed to a non-loopback name is refused as well.
    if(!this.tokenRequired&&!localRequest(request))throw new AppError('LOCAL_ACCESS_ONLY','Token-free access only accepts local connections',403);
  }
  private sign(value: string) { return createHmac('sha256',this.signingKey).update(value).digest('base64url'); }
  verifyToken(value: unknown): boolean { return typeof value==='string' && equal(value,this.token); }
  cookie(request: FastifyRequest): string | undefined {
    return this.cookieSession(request)?.cookie;
  }
  private cookieSession(request: FastifyRequest): {cookie:string;nonce:string;exp:number;deviceId?:string} | undefined {
    // Over HTTPS the cookie is `__Host-` prefixed, so nothing served over HTTP or from a subdomain can set or replace it.
    const cookies=request.headers.cookie?.split(';').map(c=>c.trim())??[];
    const raw=cookies.find(c=>c.startsWith(`${SECURE_SESSION_COOKIE}=`))?.slice(SECURE_SESSION_COOKIE.length+1)??cookies.find(c=>c.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length+1);
    if (!raw) return;
    const split=raw.lastIndexOf('.'); if (split<0) return;
    const payload=raw.slice(0,split),signature=raw.slice(split+1);
    if (!equal(signature,this.sign(payload))) return;
    let deviceId:string|undefined;
    let nonce:string;
    let exp:number;
    try {
      const body=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
      if (typeof body.exp!=='number' || body.exp<Date.now() || typeof body.nonce!=='string') return;
      // Cookies issued before epochs existed count as epoch 0.
      if ((body.ep??0)!==this.sessionEpoch || this.revokedSessions[body.nonce]!==undefined) return;
      nonce=body.nonce;
      exp=body.exp;
      // Older master-token cookies have no device id. Paired browsers remain individually revocable.
      if (body.deviceId!==undefined) {
        if (typeof body.deviceId!=='string') return;
        const device=this.devices.find(candidate=>candidate.id===body.deviceId);
        if (!device) return;
        deviceId=device.id;
        this.touchDevice(device);
      }
    } catch { return; }
    return {cookie:raw,nonce,exp,...(deviceId?{deviceId}:{})};
  }
  csrf(cookie: string) { return this.sign('csrf:'+cookie); }
  isAuthenticated(request: FastifyRequest) { return Boolean(this.cookie(request)) || Boolean(this.bearer(request)); }

  /** A preview cookie grants only the matched draft's file reads; it is never a login session. */
  sharePreview(request: FastifyRequest): boolean {
    if (!['GET', 'HEAD'].includes(request.method) || request.routeOptions?.url !== '/api/shares/drafts/:id/files/*') return false;
    const draftId = (request.params as { id?: string } | undefined)?.id;
    if (!draftId || !/^[a-f0-9]{32}$/.test(draftId)) return false;
    const raw = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('wkn_share_preview='))?.slice('wkn_share_preview='.length);
    if (!raw) return false;
    const split = raw.lastIndexOf('.');
    if (split < 0) return false;
    const payload = raw.slice(0, split);
    if (!equal(raw.slice(split + 1), this.sign('share-preview:' + payload))) return false;
    try {
      const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (body.draftId !== draftId || typeof body.exp !== 'number' || body.exp <= Date.now() || typeof body.deviceId !== 'string') return false;
      const device = this.devices.find(candidate => candidate.id === body.deviceId);
      if (!device) return false;
      this.touchDevice(device);
      return true;
    } catch { return false; }
  }
  issueSharePreview(reply: FastifyReply, request: FastifyRequest, draftId: string, draftExpiresAt: number): void {
    // Only an explicit paired-device bearer on the initial native document may mint this scope.
    const device = this.bearer(request);
    if (!device || request.headers['x-riffet-share-preview'] !== '1' || !['GET', 'HEAD'].includes(request.method)
      || request.routeOptions?.url !== '/api/shares/drafts/:id/files/*'
      || (request.params as { id?: string; '*'?: string }).id !== draftId
      || (request.params as { '*'?: string })['*'] !== 'index.html') return;
    const issuedAt = Date.now();
    const seconds = Math.floor(Math.min(600_000, draftExpiresAt - issuedAt) / 1000);
    if (seconds <= 0) return;
    const payload = Buffer.from(JSON.stringify({ draftId, deviceId: device.id, exp: issuedAt + seconds * 1000 })).toString('base64url');
    // A proxy that strips a deployment prefix can report it; it only narrows browser delivery.
    const forwarded = request.headers['x-forwarded-prefix'];
    const prefix = typeof forwarded === 'string' && /^\/(?:[a-zA-Z0-9_~%.-]+\/?)*$/.test(forwarded) ? forwarded.replace(/\/$/, '') : '';
    const path = `${prefix}/api/shares/drafts/${draftId}/files/`;
    const secure = request.protocol === 'https' || request.headers.origin?.startsWith('https://') || request.headers['x-forwarded-proto'] === 'https';
    reply.header('Set-Cookie', `wkn_share_preview=${payload}.${this.sign('share-preview:' + payload)}; HttpOnly; SameSite=Strict; Path=${path}; Max-Age=${seconds}${secure ? '; Secure' : ''}`);
  }

  /**
   * A read capability for one previewed page's folder. The page runs in an opaque origin, which
   * carries no session cookie, so its own links and assets present this in their path instead. It
   * lasts as long as the credential that minted it, at most `FILE_SITE_TTL_MS` rounded up to the hour.
   */
  issueFileSite(request: FastifyRequest, scope: FileSiteScope): string {
    const context=this.authenticate(request);
    const session=context.kind==='cookie'?this.cookieSession(request):undefined;
    const nonce=session?.nonce;
    // Expiry rounded to the hour: reopening the page within it gets the same URLs, so the browser cache holds.
    // Never past the minting cookie: its revocation record is dropped once the cookie would have expired.
    const exp=Math.min(Math.ceil((Date.now()+FILE_SITE_TTL_MS)/3600_000)*3600_000,session?.exp??Infinity);
    const body={p:scope.projectId,r:scope.root,...(scope.only?{o:scope.only}:{}),exp,...(context.deviceId?{d:context.deviceId}:{}),...(nonce?{n:nonce,ep:this.sessionEpoch}:{})};
    const payload=Buffer.from(JSON.stringify(body)).toString('base64url');
    return `${payload}.${this.sign('file-site:'+payload)}`;
  }
  fileSite(token: string): FileSiteScope | undefined {
    const split=token.lastIndexOf('.');
    if (split<0) return;
    const payload=token.slice(0,split);
    if (!equal(token.slice(split+1),this.sign('file-site:'+payload))) return;
    try {
      const body=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
      if (typeof body.p!=='string'||typeof body.r!=='string'||typeof body.exp!=='number'||body.exp<=Date.now()) return;
      if (body.d!==undefined&&!this.devices.some(device=>device.id===body.d)) return;
      if (body.n!==undefined&&(body.ep!==this.sessionEpoch||this.revokedSessions[body.n]!==undefined)) return;
      if (body.d===undefined&&body.n===undefined) return;
      if (body.o!==undefined&&typeof body.o!=='string') return;
      return {projectId:body.p,root:body.r,...(body.o?{only:body.o}:{})};
    } catch { return; }
  }

  /** Mints a long-lived device credential. The plaintext token is returned exactly once. */
  issueDevice(name: string): IssuedDevice {
    const label=requireDeviceName(name);
    const id=randomBytes(8).toString('hex');
    const token=`wkn_${id}_${randomBytes(32).toString('base64url')}`;
    const device: DeviceRecord={id,name:label,hash:hashToken(token),createdAt:new Date().toISOString()};
    this.devices.push(device);
    this.flushDevices(true);
    return {device:publicDevice(device),token};
  }
  listDevices(): PublicDevice[] { return this.devices.map(publicDevice).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)); }
  /** The installation id a device reported; it stays server-side (adb matching only). */
  installationIdOf(id: string): string | undefined { return this.devices.find(candidate=>candidate.id===id)?.installationId; }
  device(id: string): PublicDevice | undefined { const device=this.devices.find(candidate=>candidate.id===id); return device&&publicDevice(device); }
  /** Lets a device that lost this server's address check a candidate before its token goes there; only a holder of the record can answer. */
  proveDevice(id: string, nonce: string): string | undefined {
    const device=this.devices.find(candidate=>candidate.id===id);
    return device&&createHmac('sha256',device.hash).update(nonce).digest('base64url');
  }
  /** The APNs registration a device reported; it stays server-side (the push service only). */
  devicePush(id: string): DevicePushRegistration | undefined { return this.devices.find(candidate=>candidate.id===id)?.push??undefined; }
  /**
   * Forgets a token APNs said is gone, only while the device still holds that same token: a newer
   * registration that arrived meanwhile stays. A gone device token ends the whole registration.
   */
  clearDevicePush(id: string, field: 'token' | 'activityStartToken' | 'activityToken', value: string): boolean {
    const device=this.devices.find(candidate=>candidate.id===id);
    const push=device?.push;
    if (!device||!push||push[field]!==value) return false;
    if (field==='token') delete device.push; else delete push[field];
    this.flushDevices(true);
    return true;
  }
  /** The client features a device reported with; it stays server-side (the push service only). */
  deviceFeatures(id: string): readonly string[] | undefined { return this.devices.find(candidate=>candidate.id===id)?.features; }
  /** Merges what the device says about itself; written at once, since calls are refused on it. */
  reportDevice(id: string, report: DeviceReport, features?: string[]): PublicDevice {
    const device=this.devices.find(candidate=>candidate.id===id);
    if (!device) throw new AppError('DEVICE_NOT_FOUND','No such paired device',404);
    const {push,...rest}=report;
    Object.assign(device,rest);
    if (features) device.features=features;
    if (push===null) delete device.push;
    else if (push) {
      device.push=push;
      // One phone's token belongs to one record: an older pairing of the same app would push twice.
      for(const other of this.devices)if(other!==device&&other.push&&other.push.token===push.token)delete other.push;
    }
    this.flushDevices(true);
    // Pairing again from the same installation leaves an older record (earlier in the list) behind; it goes the way a manual revoke does.
    if(report.installationId)for(const other of this.devices.slice(0,this.devices.indexOf(device)).filter(candidate=>candidate.installationId===report.installationId))this.revokeDevice(other.id);
    return publicDevice(device);
  }
  revokeDevice(id: string): boolean {
    const index=this.devices.findIndex(device=>device.id===id);
    if (index<0) return false;
    this.devices.splice(index,1);
    this.closeStreams(`device:${id}`);
    this.flushDevices(true);
    for(const listener of this.revokedListeners)try{listener(id);}catch{/* every listener must hear of it */}
    return true;
  }
  /** Called with a device's id after it was revoked and its streams closed. */
  onDeviceRevoked(listener:(id:string)=>void): ()=>void { this.revokedListeners.add(listener); return ()=>{this.revokedListeners.delete(listener);}; }
  /**
   * Resolves a request to an authenticated context. A device token is an explicit credential, so it
   * carries no CSRF obligation — that check exists for cookies the browser attaches on its own.
   */
  authenticate(request: FastifyRequest, mutate = false): AuthContext {
    const link=linkOfRequest(request.raw);
    if (link) return {kind:'link',linkServerId:link};
    const device=this.bearer(request);
    if (device) { this.touchDevice(device); return {kind:'device',deviceId:device.id}; }
    const session=this.cookieSession(request),cookie=session?.cookie;
    if (!cookie) throw new AppError('UNAUTHENTICATED','Sign in with the local access token',401);
    if (mutate && !equal(String(request.headers['x-csrf-token']??''),this.csrf(cookie))) throw new AppError('INVALID_CSRF','Refresh the page before retrying this operation',403);
    return {kind:'cookie',cookie,...(session?.deviceId?{deviceId:session.deviceId}:{})};
  }
  /** Long-lived streams must stop at revocation, rather than wait for their next reconnect. */
  onRevoke(request: FastifyRequest, close:()=>void): ()=>void {
    const context=this.authenticate(request);
    const keys:string[]=[];
    if(context.deviceId)keys.push(`device:${context.deviceId}`);
    if(context.linkServerId)keys.push(`link:${context.linkServerId}`);
    // A cookie ends by logout or revoke-all even when it carries no device id (master-token sessions).
    const nonce=context.kind==='cookie'?this.cookieSession(request)?.nonce:undefined;
    if(nonce)keys.push(`cookie:${nonce}`);
    for(const key of keys){
      let listeners=this.revocations.get(key);
      if(!listeners){listeners=new Set();this.revocations.set(key,listeners);}
      listeners.add(close);
    }
    return ()=>{
      for(const key of keys){
        const listeners=this.revocations.get(key);
        if(!listeners)continue;
        listeners.delete(close);
        if(!listeners.size)this.revocations.delete(key);
      }
    };
  }
  /** Closes the streams a linked server holds open here: the link ended or lost its inbound switch. */
  revokeLink(serverId: string) { this.closeStreams(`link:${serverId}`); }
  private closeStreams(key: string) {
    const listeners=this.revocations.get(key);
    this.revocations.delete(key);
    for(const close of listeners??[])try{close();}catch{/* every connection must get its revocation */}
  }
  /** Cookie-shaped compatibility wrapper. Device callers should use `authenticate`. */
  require(request: FastifyRequest, mutate = false): string { return this.authenticate(request,mutate).cookie ?? ''; }
  login(reply: FastifyReply, request: FastifyRequest, deviceId?: string): string {
    if (deviceId!==undefined&&!this.devices.some(device=>device.id===deviceId)) throw new AppError('DEVICE_NOT_FOUND','No such paired device',404);
    // A cookie that crossed the network in the clear may have been copied, so it lasts a day (docs/TRANSPORT-SECURITY.md §4).
    const maxAge=!request.raw||secureTransport(request,this.trusted)?SESSION_COOKIE_BUDGET.secureMaxAgeSeconds:SESSION_COOKIE_BUDGET.insecureMaxAgeSeconds;
    const payload=Buffer.from(JSON.stringify({nonce:randomBytes(24).toString('base64url'),exp:Date.now()+maxAge*1000,ep:this.sessionEpoch,...(deviceId?{deviceId}:{})})).toString('base64url');
    const cookie=payload+'.'+this.sign(payload);
    // Only a page served over HTTPS keeps a `Secure` cookie; `localhost` over HTTP is left as it was, since not every
    // engine keeps one there.
    const https=request.protocol==='https' || request.headers.origin?.startsWith('https://');
    reply.header('Set-Cookie',https
      ? [`${SECURE_SESSION_COOKIE}=${cookie}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`,`${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`]
      : `${SESSION_COOKIE}=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`);
    return this.csrf(cookie);
  }
  /** Ends the caller's cookie on the server too, so a copy of it stops working, not just the browser's. */
  logout(reply: FastifyReply, request?: FastifyRequest) {
    const session=request&&this.cookieSession(request);
    if(session){this.revokeNonce(session.nonce,session.cookie);this.closeStreams(`cookie:${session.nonce}`);}
    reply.header('Set-Cookie',[`${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,`${SECURE_SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`]);
  }
  /** Ends every master-token and paired-browser cookie; devices' bearer tokens are unaffected. */
  revokeAllSessions() {
    this.sessionEpoch+=1;
    this.revokedSessions={};
    this.flushSessions();
    for(const key of [...this.revocations.keys()])if(key.startsWith('cookie:'))this.closeStreams(key);
  }
  private revokeNonce(nonce: string, cookie: string) {
    const current=Date.now();
    for(const [key,exp] of Object.entries(this.revokedSessions))if(exp<current)delete this.revokedSessions[key];
    let exp=current+30*86400_000;
    try{const body=JSON.parse(Buffer.from(cookie.slice(0,cookie.lastIndexOf('.')),'base64url').toString('utf8'));if(typeof body.exp==='number')exp=body.exp;}catch{/* the default bound applies */}
    this.revokedSessions[nonce]=exp;
    this.flushSessions();
  }
  private flushSessions() {
    const staging=`${this.sessionsPath}.tmp`;
    writeFileSync(staging,JSON.stringify({epoch:this.sessionEpoch,revoked:this.revokedSessions})+'\n',{mode:0o600});
    renameSync(staging,this.sessionsPath);
  }

  private bearer(request: FastifyRequest): DeviceRecord | undefined {
    const header=request.headers.authorization;
    if (typeof header!=='string'||!header.startsWith('Bearer ')) return;
    const parsed=DEVICE_TOKEN.exec(header.slice(7).trim());
    if (!parsed) return;
    const device=this.devices.find(candidate=>candidate.id===parsed[1]);
    return device && equal(device.hash,hashToken(header.slice(7).trim())) ? device : undefined;
  }
  private touchDevice(device: DeviceRecord) {
    device.lastSeenAt=new Date().toISOString();
    this.flushDevices(false);
  }
  private flushDevices(force: boolean) {
    const now=Date.now();
    if (!force && now-this.devicesFlushedAt<DEVICE_FLUSH_MS) return;
    this.devicesFlushedAt=now;
    const staging=`${this.devicesPath}.tmp`;
    writeFileSync(staging,JSON.stringify({devices:this.devices},null,2)+'\n',{mode:0o600});
    renameSync(staging,this.devicesPath);
  }
}
/**
 * Whether a request addresses the API. The router percent-decodes before matching, so the raw
 * `request.url` is not evidence: `/%61pi/settings` reaches the `/api/settings` handler. A matched
 * route is judged by its pattern; an unmatched one by its decoded path, and an undecodable path
 * is treated as API so the guard fails closed.
 */
export function isApiRequest(request: FastifyRequest): boolean {
  const route=request.routeOptions?.url;
  if (route) return isApiPath(route);
  const path=apiRoutePath(request.url);
  return path===undefined || isApiPath(path);
}
/** The decoded pathname the router matches against, or undefined when it cannot be decoded. */
export function apiRoutePath(url: string): string | undefined {
  try { return decodeURIComponent(new URL(url,'http://localhost').pathname); } catch { return undefined; }
}
function isApiPath(path: string) { return path==='/api' || path.startsWith('/api/'); }
function hashToken(token: string) { return createHash('sha256').update(token).digest('base64url'); }
function publicDevice(device: DeviceRecord): PublicDevice {
  const {hash:_hash,installationId:_installation,push:_push,features:_features,...rest}=device;
  return rest;
}
export function requireDeviceName(name: unknown): string {
  const label=typeof name==='string'?name.trim():'';
  if (!label) throw new AppError('INVALID_DEVICE_NAME','A device name is required',400);
  if (label.length>64) throw new AppError('INVALID_DEVICE_NAME','A device name must be at most 64 characters',400);
  return label;
}
function readDevices(path: string): DeviceRecord[] {
  let raw: string;
  try { raw=readFileSync(path,'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code==='ENOENT') return []; throw error; }
  try {
    const parsed=JSON.parse(raw) as {devices?:unknown};
    if (!Array.isArray(parsed?.devices)) return [];
    return parsed.devices.filter((entry):entry is DeviceRecord=>{
      const candidate=entry as Partial<DeviceRecord>|null;
      return Boolean(candidate&&typeof candidate.id==='string'&&typeof candidate.name==='string'&&typeof candidate.hash==='string'&&typeof candidate.createdAt==='string');
    });
  } catch { return []; }
}
function readSessions(path: string): { epoch: number; revoked: Record<string, number> } {
  try {
    const parsed=JSON.parse(readFileSync(path,'utf8')) as {epoch?:unknown;revoked?:unknown};
    const revoked: Record<string, number>={};
    if(parsed.revoked&&typeof parsed.revoked==='object')for(const [nonce,exp] of Object.entries(parsed.revoked))if(typeof exp==='number'&&exp>Date.now())revoked[nonce]=exp;
    return {epoch:Number.isSafeInteger(parsed.epoch)?parsed.epoch as number:0,revoked};
  } catch { return {epoch:0,revoked:{}}; }
}
function equal(a: string,b: string) { const left=Buffer.from(a),right=Buffer.from(b); return left.length===right.length && timingSafeEqual(left,right); }
function normalizeHost(value: string) { return value.replace(/^\[|\]$/g,'').replace(/\.$/,'').toLowerCase(); }
