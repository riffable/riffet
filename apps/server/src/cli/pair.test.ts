import { describe, expect, it, vi } from 'vitest';
import { localServerUrl, publicOrigin, requestCliPairing } from './pair.js';

const record={host:'0.0.0.0',port:4337,instanceId:'test'};
const pairing={code:'2345ABCD',expiresAt:Date.now()+300_000,hosts:['Mac.local','192.168.1.2','10.0.0.2'],port:4337,scheme:'http'};
function api(body: unknown=pairing) {
  return vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({csrfToken:'csrf'}),{headers:{'set-cookie':'cw_session=secret-cookie; HttpOnly; Path=/'}}))
    .mockResolvedValueOnce(new Response(JSON.stringify(body)));
}
describe('explicit CLI pairing',()=>{
  it('authenticates locally and exposes only a temporary code, never the master token or session cookie',async()=>{
    const fetcher=api();
    const result=await requestCliPairing(record,'master-secret',fetcher);
    expect(fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:4337/api/auth/login');
    expect(fetcher.mock.calls[0][1]?.body).toBe('{"token":"master-secret"}');
    expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({cookie:'cw_session=secret-cookie','x-csrf-token':'csrf'});
    expect(result.urls).toEqual(['http://192.168.1.2:4337','http://10.0.0.2:4337','http://Mac.local:4337']);
    expect(result.code).toBe('2345ABCD');
    expect(JSON.parse(result.qrPayload)).toMatchObject({v:1,host:'192.168.1.2',port:4337,scheme:'http',code:result.code});
    expect(JSON.stringify(result)).not.toMatch(/master-secret|secret-cookie|csrf/);
  });
  it('honours the new server-selected host instead of choosing a different QR target',async()=>{
    const result=await requestCliPairing(record,'master',api({...pairing,host:'Mac.local'}));
    expect(result.urls[0]).toBe('http://Mac.local:4337');
    expect(JSON.parse(result.qrPayload).host).toBe('Mac.local');
  });
  it('puts the --url address in the QR, also for a loopback listener behind a tunnel or front door',async()=>{
    const result=await requestCliPairing({...record,host:'127.0.0.1'},'master',api(),{url:publicOrigin('https://riffet.example.test')});
    expect(result.urls).toEqual(['https://riffet.example.test']);
    expect(JSON.parse(result.qrPayload)).toMatchObject({scheme:'https',host:'riffet.example.test',port:443,code:'2345ABCD'});
    expect(()=>publicOrigin('https://riffet.example.test/app')).toThrow('--url');
  });
  it.each(['127.0.0.1','127.1.2.3','localhost','::1','[::1]','::ffff:127.0.0.1'])('rejects loopback %s before issuing a code',async host=>{
    const fetcher=api();
    await expect(requestCliPairing({...record,host},'master',fetcher)).rejects.toThrow('only listens on this computer');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not advertise other interfaces for a specific-interface listener',async()=>{
    const result=await requestCliPairing({...record,host:'10.0.0.2'},'master',api());
    expect(result.urls).toEqual(['http://10.0.0.2:4337']);
  });
  it('fails clearly when no LAN host exists instead of encoding a wildcard or loopback',async()=>{
    await expect(requestCliPairing(record,'master',api({...pairing,hosts:['0.0.0.0','::','127.0.0.1']}))).rejects.toThrow('no network address');
  });
  it('does not leak an authentication error body',async()=>{
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response('master-secret',{status:401}));
    await expect(requestCliPairing(record,'master-secret',fetcher)).rejects.toThrow('HTTP 401');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid and expired codes',async()=>{
    await expect(requestCliPairing(record,'master',api({...pairing,expiresAt:0}))).rejects.toThrow('invalid or expired');
  });
  it('formats IPv6 URLs correctly',()=>{
    expect(localServerUrl({...record,host:'2001:db8::1'})).toBe('http://[2001:db8::1]:4337');
  });
});
