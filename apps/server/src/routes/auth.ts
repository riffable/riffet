import type { FastifyInstance, FastifyRequest } from 'fastify';
import { hostname } from 'node:os';
import { isIP } from 'node:net';
import QRCode from 'qrcode';
import { connectionAddresses } from '../connection-addresses.js';
import { AppError } from '../errors.js';
import { requireDeviceName } from '../auth.js';
import { createPairingCode, redeemPairingCode } from '../pairing.js';
import { PROTOCOL_INFO } from '../../../../packages/contracts/src/index.js';
import { withoutQuickChats } from '../chat/quick-chat.js';
import { visibleProjectsForClient, visibleProjectItemsForClient, visibleSessionsForClient } from '../native/client-features.js';
import type { RouteDeps } from './deps.js';

export function registerAuthRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const {store,auth,terminal,effectiveSettings}=deps;
  /**
   * Who a request is from, for rate limits. A proxy on this machine (tailscale serve, nginx) makes
   * every caller look like loopback, so one bad actor would lock everyone out; its own
   * `X-Forwarded-For` hop is the address it saw. Only a loopback peer is believed: anyone else
   * could write the header themselves.
   */
  const clientKey=(request:FastifyRequest)=>{
    if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.ip))return request.ip;
    const forwarded=String(request.headers['x-forwarded-for']??'').split(',').at(-1)?.trim();
    return forwarded&&isIP(forwarded)?forwarded:request.ip;
  };
  const attempts=new Map<string,{count:number;at:number}>();
  const pairAttempts=new Map<string,{count:number;at:number}>();
  /** Counts one attempt per address per minute; stale entries are dropped so the map stays bounded. */
  const countAttempt=(map:Map<string,{count:number;at:number}>,key:string)=>{
    const current=Date.now();
    if(map.size>=1024)for(const [address,item] of map)if(current-item.at>=60_000)map.delete(address);
    const entry=map.get(key),fresh=entry&&current-entry.at<60_000;
    const count=fresh?entry.count+1:1;
    // A full table of fresh entries evicts its oldest rather than stop counting new addresses.
    if(!entry&&map.size>=4096)map.delete(map.keys().next().value!);
    map.set(key,{count,at:fresh?entry.at:current});
    return count;
  };
  // Unauthenticated routes parse their body before any check runs; they only ever carry a token or a code.
  const PUBLIC_BODY_LIMIT=4096;
  // Both redemption channels share a budget and the same one-use code store.
  const pairDevice=(request:FastifyRequest,code:unknown,name:unknown)=>{
    const key=clientKey(request);
    if (countAttempt(pairAttempts,key)>10) throw new AppError('PAIRING_RATE_LIMIT','Too many pairing attempts; retry in one minute',429);
    const label=requireDeviceName(name);
    if (!redeemPairingCode(code)) throw new AppError('INVALID_PAIRING_CODE','The pairing code is incorrect or has expired',401);
    pairAttempts.delete(key);
    return auth.issueDevice(label);
  };
  app.get('/api/auth/status',async(request,reply)=>{
    try { if(auth.authenticate(request).kind==='device')return {authenticated:true,tokenRequired:auth.tokenRequired,kind:'device'}; } catch {}
    const cookie=auth.cookie(request);
    if(!auth.tokenRequired&&!cookie)return {authenticated:true,tokenRequired:false,csrfToken:auth.login(reply,request)};
    return {authenticated:Boolean(cookie),tokenRequired:auth.tokenRequired,csrfToken:cookie?auth.csrf(cookie):undefined};
  });
  app.post<{Body:{token?:unknown;code?:unknown;name?:unknown}}>('/api/auth/login',{bodyLimit:PUBLIC_BODY_LIMIT},async(request,reply)=>{
    if (request.body&&Object.hasOwn(request.body,'code')) {
      const {device}=pairDevice(request,request.body.code,request.body.name??'Web 浏览器');
      // The browser receives only an HttpOnly cookie, never a bearer credential.
      return {authenticated:true,tokenRequired:auth.tokenRequired,device,csrfToken:auth.login(reply,request,device.id)};
    }
    if(!auth.tokenRequired)return {authenticated:true,tokenRequired:false,csrfToken:auth.login(reply,request)};
    const key=clientKey(request);
    if (countAttempt(attempts,key)>10) throw new AppError('LOGIN_RATE_LIMIT','Too many login attempts; retry in one minute',429);
    if (!auth.verifyToken(request.body?.token)) throw new AppError('INVALID_TOKEN','Access token is incorrect',401);
    attempts.delete(key); return {authenticated:true,tokenRequired:true,csrfToken:auth.login(reply,request)};
  });
  app.post('/api/auth/logout',async(request,reply)=>{auth.require(request,true);auth.logout(reply,request);return {authenticated:false};});
  // Ends every browser session at once, for a cookie that may have leaked; the caller signs in again.
  app.post('/api/auth/revoke-sessions',async(request)=>{
    // A device bearer must not be able to sign out every browser; only a signed-in cookie may.
    if(auth.authenticate(request,true).kind!=='cookie')throw new AppError('COOKIE_SESSION_REQUIRED','Sign in from a browser session to revoke all sessions',403);
    auth.revokeAllSessions();return {ok:true};
  });
  app.post<{Body:{name?:string}}>('/api/pairing/code',async(request)=>{
    auth.authenticate(request,true);
    const listener=app.server.address();
    const connection=connectionAddresses({bindHost:typeof listener==='object'&&listener?listener.address:'127.0.0.1',
      port:typeof listener==='object'&&listener?listener.port:0,scheme:pairingScheme(request),authority:request.headers.host,allowedHosts:auth.allowedHosts});
    const pairing=createPairingCode();
    // `hosts` lists every address on this listener, `host` first: a network can isolate one interface
    // (wireless clients from each other) while another is reachable, and the phone tries them all.
    const payload=JSON.stringify({v:1,scheme:connection.scheme,host:connection.host,...(connection.hosts.length>1?{hosts:connection.hosts}:{}),port:connection.port,code:pairing.code,name:request.body?.name?.trim()||hostname()});
    // Only the short-lived code travels in the QR; the master access token is never handed out here.
    // `payload` is the exact string `qr` encodes, so a native client can draw its own QR instead of parsing the SVG.
    return {code:pairing.code,expiresAt:pairing.expiresAt,qr:await QRCode.toString(payload,{type:'svg'}),payload,...connection};
  });
  app.post<{Body:{code:unknown;name:unknown}}>('/api/devices/pair',{bodyLimit:PUBLIC_BODY_LIMIT},async(request)=>{
    return pairDevice(request,request.body?.code,request.body?.name);
  });
  // A phone whose server changed address asks each candidate this before sending it the token (docs/MOBILE.md「Mac 换地址」).
  app.post<{Body:{device?:unknown;nonce?:unknown}}>('/api/devices/prove',{bodyLimit:PUBLIC_BODY_LIMIT},async(request)=>{
    const {device,nonce}=request.body??{};
    if(typeof device!=='string'||typeof nonce!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(nonce))throw new AppError('INVALID_DEVICE_PROOF','device and a 16–128 character nonce are required',400);
    const proof=auth.proveDevice(device,nonce);
    if(!proof)throw new AppError('DEVICE_NOT_FOUND','No such paired device',404);
    return {proof};
  });
  // `currentId` is the caller's own record (a paired browser or phone), so a list can say which one removing would sign out.
  app.get('/api/devices',async(request)=>{const {deviceId}=auth.authenticate(request);return {devices:deps.devices.list(),...(deviceId?{currentId:deviceId}:{})};});
  app.delete<{Params:{id:string}}>('/api/devices/:id',async(request)=>{
    if(!auth.revokeDevice(request.params.id))throw new AppError('DEVICE_NOT_FOUND','No such paired device',404);
    return {ok:true};
  });
  app.get('/api/bootstrap',async(request)=>{
    const context=auth.authenticate(request);
    return {projects:visibleProjectsForClient(request.headers,withoutQuickChats(store.listProjects(),request)),sessions:visibleSessionsForClient(request.headers,withoutQuickChats(store.listSessions(),request),id=>store.getProject(id)),terminals:visibleProjectItemsForClient(request.headers,terminal.listSnapshot(),id=>store.getProject(id)),revisions:{sessions:store.listRevision,terminals:store.terminalsRevision,projects:store.projectRevision},settings:effectiveSettings(request.headers),owner:deps.owner.get(),protocol:PROTOCOL_INFO,csrfToken:context.kind==='cookie'&&context.cookie?auth.csrf(context.cookie):''};
  });
}
/**
 * The scheme a phone must dial. Normally plain HTTP, because the server itself has no TLS: the
 * recommended remote topology puts a TLS-terminating front door (`tailscale serve`, a reverse
 * proxy) in front of it, and that front door is the only party that knows the phone will speak
 * HTTPS. It reports itself with `X-Forwarded-Proto`.
 *
 * Honouring that header is safe here without Fastify's `trustProxy`: every `/api/` request has
 * already passed `checkOrigin`, so reaching this handler means the `Host` was one the operator
 * allowed. A forged header could at worst make a QR advertise a scheme this server does not serve,
 * which fails to connect rather than exposing anything.
 */
function pairingScheme(request: FastifyRequest): 'http' | 'https' {
  if (request.protocol==='https') return 'https';
  const forwarded=String(request.headers['x-forwarded-proto']??'').split(',')[0]?.trim().toLowerCase();
  return forwarded==='https'?'https':'http';
}
