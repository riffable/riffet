import { hostname } from 'node:os';
import { isIP } from 'node:net';
import { toString as qrToString } from 'qrcode';
import { CliError, MARK, columns, err, out, printJson, printLines, width } from './ui.js';
import { accessToken, requireActive, stateDir } from './context.js';

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
  try { parsed=new URL(/^https?:\/\//i.test(value)?value:`http://${value}`); } catch { throw new CliError(`--url is not an address: ${value}`); }
  if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash)throw new CliError('--url takes only a scheme, host and port, such as https://riffet.example.com');
  return parsed;
}
export function localServerUrl(record: PairingDaemon): string {
  return url(['0.0.0.0','::'].includes(record.host)?'127.0.0.1':record.host,record.port);
}
/** Authenticate locally, then issue exactly one short-lived code. The master token is never returned. */
export async function requestCliPairing(record: PairingDaemon,token: string,fetcher: typeof fetch=fetch,options: {url?: URL}={}): Promise<CliPairing> {
  // A tunnel or front door reaches a loopback listener, so a named address lifts the LAN requirement.
  if(loopbackHost(record.host)&&!options.url)throw new CliError('Riffet only listens on this computer, so other devices cannot reach it',['riffet restart --host 0.0.0.0','Behind a tunnel or proxy: `riffet pair --url <address>`']);
  const localUrl=localServerUrl(record);
  const login=await fetcher(`${localUrl}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token}),signal:AbortSignal.timeout(3000)});
  if(!login.ok)throw new CliError(`The running server refused the access token (HTTP ${login.status})`,['Check that --state-dir points at the directory this server uses']);
  const {csrfToken}=await login.json() as {csrfToken?:unknown};
  const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).find(value=>value.startsWith('cw_session='));
  if(typeof csrfToken!=='string'||!cookie)throw new CliError('The running server did not return a login session');
  const response=await fetcher(`${localUrl}/api/pairing/code`,{method:'POST',headers:{'content-type':'application/json',cookie,'x-csrf-token':csrfToken},body:'{}',signal:AbortSignal.timeout(3000)});
  if(!response.ok)throw new CliError(`Could not issue a pairing code (HTTP ${response.status})`,['riffet restart']);
  const body=await response.json() as {code?:unknown;expiresAt?:unknown;hosts?:unknown;host?:unknown;port?:unknown;scheme?:unknown};
  if(typeof body.code!=='string'||!body.code||typeof body.expiresAt!=='number'||body.expiresAt<=Date.now())throw new CliError('The running server returned an invalid or expired pairing code');
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
  if(!candidates.length)throw new CliError('This computer has no network address other devices can reach',['Connect to a network, then `riffet pair` again']);
  const scheme=body.scheme==='https'?'https':'http';
  const port=typeof body.port==='number'&&Number.isInteger(body.port)&&body.port>0&&body.port<=65535?body.port:record.port;
  const urls=candidates.map(host=>url(host,port,scheme));
  const qrPayload=JSON.stringify({v:1,scheme,host:candidates[0],...(candidates.length>1?{hosts:candidates}:{}),port,code:body.code,name:hostname()});
  return {localUrl,urls,code:body.code,expiresAt:body.expiresAt,qrPayload};
}
/** The QR code with the addresses and the code beside it; the QR keeps its own light background, so phones read it on dark terminals too. */
export async function formatCliPairing(pairing: CliPairing): Promise<string[]> {
  const qr = (await qrToString(pairing.qrPayload, { type: 'terminal', small: true })).replace(/\n+$/, '').split('\n');
  const info = columns([
    ...pairing.urls.map((url, index) => [index ? '' : out.dim('Address'), out.url(url)]),
    [out.dim('Code'), out.bold(out.accent(pairing.code))],
    [out.dim('This computer'), out.url(pairing.localUrl)],
  ], { gap: 3 });
  const block = [out.bold('Scan with Riffet, or open an address and enter the code'), '', ...info];
  const top = Math.max(0, Math.floor((qr.length - block.length) / 2));
  const qrWidth = Math.max(...qr.map(width));
  return Array.from({ length: Math.max(qr.length, top + block.length) }, (_, row) => {
    const left = qr[row] ?? ' '.repeat(qrWidth);
    const right = block[row - top];
    return `  ${left}${right ? '   ' + right : ''}`.trimEnd();
  });
}

const remaining = (expiresAt: number) => {
  const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/** `riffet pair`. In a terminal the expiry counts down until the code lapses or Ctrl+C. */
export async function pair(options: { stateDir: string; json?: boolean; url?: string }): Promise<void> {
  const dir = stateDir(options.stateDir);
  const url = options.url ? publicOrigin(options.url) : undefined;
  const record = await requireActive(dir);
  const pairing = await requestCliPairing(record, accessToken(dir), fetch, { url });
  if (options.json) { printJson(pairing); return; }
  if (!process.stdout.isTTY) {
    printLines([...pairing.urls.map(value => `address ${value}`), `code ${pairing.code}`, `expires ${new Date(pairing.expiresAt).toISOString()}`]);
    return;
  }
  printLines(['', ...await formatCliPairing(pairing), '']);
  const status = () => `  ${err.dim('Expires in')} ${err.bold(remaining(pairing.expiresAt))} ${err.dim('· one use · share only with a device you trust')}`;
  process.stderr.write(status());
  await new Promise<void>(done => {
    const close = () => { clearInterval(timer); process.off('SIGINT', interrupt); process.stderr.write('\n'); done(); };
    const interrupt = () => close();
    const timer = setInterval(() => {
      if (Date.now() >= pairing.expiresAt) {
        process.stderr.write(`\r\x1b[2K  ${err.warn(MARK.warn)} ${err.dim('Expired')}  ${err.dim(MARK.arrow)} ${err.cmd('riffet pair')}`);
        close();
        return;
      }
      process.stderr.write('\r\x1b[2K' + status());
    }, 1000);
    process.once('SIGINT', interrupt);
  });
}
