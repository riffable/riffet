import { hostname } from 'node:os';
import { isIP } from 'node:net';
import { toString as qrToString } from 'qrcode';

export interface PairingDaemon { host: string; port: number; instanceId: string }
export interface CliPairing {
  localUrl: string;
  urls: string[];
  code: string;
  expiresAt: number;
  qrPayload: string;
}
export function loopbackHost(value: string): boolean {
  const host=value.trim().replace(/^\[|\]$/g,'').replace(/\.$/,'').toLowerCase();
  return host==='localhost'||host==='::1'||host==='::ffff:127.0.0.1'||/^127(?:\.\d{1,3}){3}$/.test(host);
}
function url(host: string,port: number,scheme='http'): string {
  return `${scheme}://${host.includes(':')?`[${host}]`:host}:${port}`;
}
/** `--url`: the origin clients reach this server by (a VPN name, an SSH tunnel, an HTTPS front door). */
export function publicOrigin(value: string): URL {
  let parsed: URL;
  try { parsed=new URL(/^https?:\/\//i.test(value)?value:`http://${value}`); } catch { throw new Error(`--url is not an address: ${value}`); }
  if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash)throw new Error('--url takes only a scheme, host and port, e.g. https://riffet.example.com');
  return parsed;
}
export function localServerUrl(record: PairingDaemon): string {
  return url(['0.0.0.0','::'].includes(record.host)?'127.0.0.1':record.host,record.port);
}
/** Authenticate locally, then issue exactly one short-lived code. The master token is never returned. */
export async function requestCliPairing(record: PairingDaemon,token: string,fetcher: typeof fetch=fetch,options: {url?: URL}={}): Promise<CliPairing> {
  // A tunnel or front door reaches a loopback listener, so a named address lifts the LAN requirement.
  if(loopbackHost(record.host)&&!options.url)throw new Error('This server only listens on loopback. To allow LAN clients, run `riffet restart --host 0.0.0.0 --auth`, then `riffet pair`; behind a tunnel or proxy, pass its address with --url.');
  const localUrl=localServerUrl(record);
  const login=await fetcher(`${localUrl}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token}),signal:AbortSignal.timeout(3000)});
  if(!login.ok)throw new Error(`Could not authenticate with the running server (HTTP ${login.status}); check the selected --state-dir.`);
  const {csrfToken}=await login.json() as {csrfToken?:unknown};
  const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).find(value=>value.startsWith('cw_session='));
  if(typeof csrfToken!=='string'||!cookie)throw new Error('The running server did not return a pairing authentication session.');
  const response=await fetcher(`${localUrl}/api/pairing/code`,{method:'POST',headers:{'content-type':'application/json',cookie,'x-csrf-token':csrfToken},body:'{}',signal:AbortSignal.timeout(3000)});
  if(!response.ok)throw new Error(`Could not issue a pairing code (HTTP ${response.status}); update the running server or retry.`);
  const body=await response.json() as {code?:unknown;expiresAt?:unknown;hosts?:unknown;host?:unknown;port?:unknown;scheme?:unknown};
  if(typeof body.code!=='string'||!body.code||typeof body.expiresAt!=='number'||body.expiresAt<=Date.now())throw new Error('The running server returned an invalid or expired pairing code.');
  if(options.url){
    const scheme=options.url.protocol==='https:'?'https':'http';
    const host=options.url.hostname.replace(/^\[|\]$/g,'');
    const port=options.url.port?Number(options.url.port):scheme==='https'?443:80;
    return {localUrl,urls:[options.url.origin],code:body.code,expiresAt:body.expiresAt,qrPayload:JSON.stringify({v:1,scheme,host,port,code:body.code,name:hostname()})};
  }
  const wildcard=['0.0.0.0','::'].includes(record.host);
  const hosts=Array.isArray(body.hosts)?body.hosts.filter((host):host is string=>typeof host==='string'&&Boolean(host)&&!loopbackHost(host)&&!['0.0.0.0','::'].includes(host)):[];
  // A listener bound to one interface cannot serve the other interfaces returned by older servers.
  const candidates=[...new Set(wildcard?hosts:hosts.filter(host=>host.toLowerCase()===record.host.toLowerCase()))];
  if(!wildcard&&!candidates.length)candidates.push(record.host);
  // Prefer a literal LAN address, which works even if a client cannot resolve the Mac's mDNS name.
  if(typeof body.host==='string'&&candidates.includes(body.host)){
    candidates.splice(candidates.indexOf(body.host),1);candidates.unshift(body.host);
  }else candidates.sort((left,right)=>Number(isIP(right)===4)-Number(isIP(left)===4));
  if(!candidates.length)throw new Error('No LAN address is available. Connect this Mac to a network, then run `riffet pair` again.');
  const scheme=body.scheme==='https'?'https':'http';
  const port=typeof body.port==='number'&&Number.isInteger(body.port)&&body.port>0&&body.port<=65535?body.port:record.port;
  const urls=candidates.map(host=>url(host,port,scheme));
  const qrPayload=JSON.stringify({v:1,scheme,host:candidates[0],port,code:body.code,name:hostname()});
  return {localUrl,urls,code:body.code,expiresAt:body.expiresAt,qrPayload};
}
export async function formatCliPairing(pairing: CliPairing): Promise<string> {
  return [
    `Local Web / Mac app: ${pairing.localUrl}`,
    'Other devices:',...pairing.urls.map(value=>`  ${value}`),
    `Pairing code: ${pairing.code}`,
    `One use · expires in 5 minutes (${new Date(pairing.expiresAt).toISOString()})`,
    'Scan this QR with Riffet, or enter an address above and this code in a browser or app.',
    await qrToString(pairing.qrPayload,{type:'terminal',small:true}),
    'This code grants access to your workbench. Share it only with a device you trust.',
  ].join('\n');
}
