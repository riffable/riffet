import { beforeEach,describe,it,expect,vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';import { tmpdir } from 'node:os';import { join } from 'node:path';
import type {FastifyRequest,FastifyReply} from 'fastify';import {Auth} from './auth.js';
// Interface addresses decide which `Host` values are accepted, so tests drive them directly. The
// rest of `node:os` stays real: the temp directory and the host name are not under test here.
const os=vi.hoisted(()=>({networkInterfaces:vi.fn()}));
vi.mock('node:os',async importOriginal=>({...await importOriginal<typeof import('node:os')>(),networkInterfaces:os.networkInterfaces}));
beforeEach(()=>{os.networkInterfaces.mockReturnValue({lo0:[{address:'127.0.0.1',internal:true}]});});
describe('local authentication',()=>{
  it.each(['GET','HEAD'])('allows %s document navigation from an external link while keeping host and local access checks',method=>{
    const dir=mkdtempSync(join(tmpdir(),'riffet-auth-navigation-'));
    try {
      const auth=new Auth(dir,{auth:false,host:'127.0.0.1'});
      const request={method,url:'/?from=chat',ip:'127.0.0.1',headers:{
        host:'127.0.0.1:4337','sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document','sec-fetch-user':'?1',
      }} as unknown as FastifyRequest;
      expect(()=>auth.checkOrigin(request)).not.toThrow();
      expect(()=>auth.checkOrigin({...request,headers:{...request.headers,host:'foreign.example'}} as FastifyRequest)).toThrow('hostname');
      expect(()=>auth.checkOrigin({...request,headers:{...request.headers,origin:'https://foreign.example'}} as FastifyRequest)).toThrow('Cross-origin');
      expect(()=>auth.checkOrigin({...request,ip:'192.168.1.5'} as FastifyRequest)).toThrow('local connections');
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  it.each([
    ['GET','/api/bootstrap','navigate','document'],
    ['GET','/api/auth/status','navigate','document'],
    ['GET','/','cors','empty'],
    ['GET','/','navigate','iframe'],
    ['POST','/','navigate','document'],
  ])('rejects cross-site %s %s with mode=%s and destination=%s',(method,url,mode,destination)=>{
    const dir=mkdtempSync(join(tmpdir(),'riffet-auth-cross-site-'));
    try {
      const auth=new Auth(dir,{auth:false,host:'127.0.0.1'});
      const request={method,url,ip:'127.0.0.1',headers:{
        host:'127.0.0.1:4337','sec-fetch-site':'cross-site','sec-fetch-mode':mode,'sec-fetch-dest':destination,
      }} as unknown as FastifyRequest;
      expect(()=>auth.checkOrigin(request)).toThrow('Cross-site');
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  it('rejects cross-site requests and validates signed cookies with CSRF',()=>{
    const dir=mkdtempSync(join(tmpdir(),'riffet-auth-'));const auth=new Auth(dir,{token:'test-access-token-with-more-than-24-characters'});
    const request={headers:{host:'localhost:4317',origin:'http://localhost:4317'},protocol:'http'} as FastifyRequest;let cookie='';
    const reply={header:(_name:string,value:string)=>{cookie=value;return reply;}} as unknown as FastifyReply;
    auth.checkOrigin(request);const csrf=auth.login(reply,request);request.headers.cookie=cookie.split(';')[0];request.headers['x-csrf-token']=csrf;
    expect(auth.require(request,true)).toBeTruthy();request.headers['x-csrf-token']='bad';expect(()=>auth.require(request,true)).toThrow();
    request.headers.origin='https://foreign.example';expect(()=>auth.checkOrigin(request)).toThrow();request.headers.origin=undefined;request.headers.cookie+='tampered';expect(auth.isAuthenticated(request)).toBe(false);rmSync(dir,{recursive:true,force:true});
  });
  it('allows a local password while keeping cookie signatures private and invalidating rotated logins',()=>{
    const dir=mkdtempSync(join(tmpdir(),'riffet-auth-local-'));
    try {
      const auth=new Auth(dir,{token:'hzger',host:'127.0.0.1'});
      const request={headers:{host:'127.0.0.1:4337'},protocol:'http'} as FastifyRequest;
      let cookie='';
      const reply={header:(_name:string,value:string)=>{cookie=value;return reply;}} as unknown as FastifyReply;
      auth.login(reply,request);
      request.headers.cookie=cookie.split(';')[0];
      expect(new Auth(dir,{host:'127.0.0.1'}).isAuthenticated(request)).toBe(true);
      const payload=request.headers.cookie.slice('cw_session='.length).split('.')[0];
      request.headers.cookie='cw_session='+payload+'.'+createHmac('sha256','hzger').update(payload).digest('base64url');
      expect(auth.isAuthenticated(request)).toBe(false);
      request.headers.cookie=cookie.split(';')[0];
      expect(new Auth(dir,{token:'changed-local-password',host:'127.0.0.1'}).isAuthenticated(request)).toBe(false);
      expect(()=>new Auth(dir,{token:'hzger',host:'0.0.0.0'})).toThrow('at least 24');
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
  it('ends a cookie on logout and every cookie on revoke-all, across restarts',()=>{
    const dir=mkdtempSync(join(tmpdir(),'riffet-auth-revoke-'));
    try {
      const auth=new Auth(dir,{token:'hzger',host:'127.0.0.1'});
      const issue=()=>{
        let value='';
        const reply={header:(_name:string,header:string)=>{value=header;return reply;}} as unknown as FastifyReply;
        auth.login(reply,{headers:{host:'127.0.0.1:4337'},protocol:'http'} as FastifyRequest);
        return {headers:{cookie:value.split(';')[0]}} as unknown as FastifyRequest;
      };
      const first=issue(),second=issue();
      auth.logout({header:()=>undefined} as unknown as FastifyReply,first);
      expect(auth.isAuthenticated(first)).toBe(false);
      expect(auth.isAuthenticated(second)).toBe(true);
      expect(new Auth(dir,{host:'127.0.0.1'}).isAuthenticated(first)).toBe(false);
      auth.revokeAllSessions();
      expect(auth.isAuthenticated(second)).toBe(false);
      expect(new Auth(dir,{host:'127.0.0.1'}).isAuthenticated(second)).toBe(false);
      expect(auth.isAuthenticated(issue())).toBe(true);
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
  it('keeps paired browser cookies on the CSRF channel and invalidates them after device revocation',()=>{
    const dir=mkdtempSync(join(tmpdir(),'riffet-auth-browser-'));
    try {
      const auth=new Auth(dir,{token:'test-access-token-with-more-than-24-characters'});
      const {device}=auth.issueDevice('Web · Mac');
      const request={headers:{host:'127.0.0.1:4337'},protocol:'http'} as FastifyRequest;
      let cookie='';
      const reply={header:(_name:string,value:string)=>{cookie=value;return reply;}} as unknown as FastifyReply;
      const csrf=auth.login(reply,request,device.id);
      request.headers.cookie=cookie.split(';')[0];
      expect(auth.authenticate(request)).toMatchObject({kind:'cookie',deviceId:device.id});
      expect(()=>auth.authenticate(request,true)).toThrow('Refresh the page');
      request.headers['x-csrf-token']=csrf;
      expect(auth.authenticate(request,true).kind).toBe('cookie');
      expect(new Auth(dir).isAuthenticated(request)).toBe(true);
      expect(auth.listDevices()[0]?.lastSeenAt).toBeDefined();
      auth.revokeDevice(device.id);
      expect(auth.cookie(request)).toBeUndefined();
      expect(()=>auth.authenticate(request)).toThrow('Sign in');
      expect(new Auth(dir).isAuthenticated(request)).toBe(false);
      expect(()=>auth.login(reply,request,device.id)).toThrow('No such paired device');
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  it('notifies only live subscriptions for the revoked device and preserves legacy master sessions',()=>{
    const dir=mkdtempSync(join(tmpdir(),'riffet-auth-revocations-'));
    try {
      const auth=new Auth(dir);
      const first=auth.issueDevice('First'),second=auth.issueDevice('Second');
      const request=(token:string)=>({headers:{authorization:`Bearer ${token}`}} as FastifyRequest);
      const closed=vi.fn(),removed=vi.fn(),unrelated=vi.fn(),masterClosed=vi.fn();
      const unwatch=auth.onRevoke(request(first.token),removed);
      unwatch();unwatch();
      const stop=auth.onRevoke(request(first.token),closed);
      auth.onRevoke(request(second.token),unrelated);
      let cookie='';
      const reply={header:(_name:string,value:string)=>{cookie=value;return reply;}} as unknown as FastifyReply;
      const master={headers:{},protocol:'http'} as FastifyRequest;
      auth.login(reply,master);master.headers.cookie=cookie.split(';')[0];
      auth.onRevoke(master,masterClosed);
      auth.revokeDevice(first.device.id);
      stop();stop();
      expect(closed).toHaveBeenCalledTimes(1);
      expect(removed).not.toHaveBeenCalled();
      expect(unrelated).not.toHaveBeenCalled();
      expect(masterClosed).not.toHaveBeenCalled();
      expect(auth.authenticate(master).kind).toBe('cookie');
      expect(()=>auth.onRevoke(request(first.token),vi.fn())).toThrow('Sign in');
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  it('closes live streams of master-token cookies on logout and revoke-all, but not bearer streams',()=>{
    const dir=mkdtempSync(join(tmpdir(),'riffet-auth-cookie-streams-'));
    try {
      const auth=new Auth(dir,{token:'hzger',host:'127.0.0.1'});
      const issue=()=>{
        let value='';
        const reply={header:(_name:string,header:string)=>{value=header;return reply;}} as unknown as FastifyReply;
        auth.login(reply,{headers:{host:'127.0.0.1:4337'},protocol:'http'} as FastifyRequest);
        return {headers:{cookie:value.split(';')[0]}} as unknown as FastifyRequest;
      };
      const device=auth.issueDevice('Phone');
      const [first,second]=[issue(),issue()];
      const firstClosed=vi.fn(),secondClosed=vi.fn(),bearerClosed=vi.fn();
      auth.onRevoke(first,firstClosed);
      auth.onRevoke(second,secondClosed);
      auth.onRevoke({headers:{authorization:`Bearer ${device.token}`}} as FastifyRequest,bearerClosed);
      auth.logout({header:()=>undefined} as unknown as FastifyReply,first);
      expect(firstClosed).toHaveBeenCalledTimes(1);
      expect(secondClosed).not.toHaveBeenCalled();
      auth.revokeAllSessions();
      expect(secondClosed).toHaveBeenCalledTimes(1);
      expect(bearerClosed).not.toHaveBeenCalled();
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  it('restricts token-free mode to loopback binding and local same-origin requests',()=>{
    const dir=mkdtempSync(join(tmpdir(),'riffet-auth-free-'));
    try {
      const auth=new Auth(dir,{auth:false,host:'127.0.0.1'});
      expect(auth.tokenRequired).toBe(false);
      const request={ip:'127.0.0.1',headers:{host:'127.0.0.1:4337',origin:'http://127.0.0.1:4337'}} as FastifyRequest;
      expect(()=>auth.checkOrigin(request)).not.toThrow();
      expect(()=>auth.checkOrigin({...request,ip:'192.168.1.5'})).toThrow('local connections');
      // A reverse proxy on this machine connects from loopback; neither its forwarding header nor a public name passes.
      expect(()=>auth.checkOrigin({...request,headers:{...request.headers,'x-forwarded-for':'203.0.113.7'}})).toThrow('local connections');
      const free=new Auth(dir,{auth:false,host:'127.0.0.1',allowedHosts:['riffet.example.test']});
      expect(()=>free.checkOrigin({ip:'127.0.0.1',headers:{host:'riffet.example.test'}} as FastifyRequest)).toThrow('local connections');
      request.headers.origin='https://foreign.example';expect(()=>auth.checkOrigin(request)).toThrow('Cross-origin');
      expect(()=>new Auth(dir,{auth:false,host:'0.0.0.0'})).toThrow('must bind');
      expect(()=>new Auth(dir,{auth:false,host:'192.168.1.10'})).toThrow('must bind');
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  it('accepts the address the machine holds now rather than the one it held at startup',()=>{
    const dir=mkdtempSync(join(tmpdir(),'riffet-auth-network-'));
    try {
      os.networkInterfaces.mockReturnValue({en0:[{address:'10.0.0.5',internal:false}]});
      const auth=new Auth(dir,{token:'test-access-token-with-more-than-24-characters',host:'0.0.0.0'});
      const reach=(host:string)=>({method:'GET',url:'/',ip:'192.168.1.30',headers:{host}} as unknown as FastifyRequest);
      expect(()=>auth.checkOrigin(reach('10.0.0.5:4337'))).not.toThrow();
      // Same daemon, new network: the office address is gone, so the home address has to answer.
      // The address list is reused briefly, so the change is noticed once that has passed.
      os.networkInterfaces.mockReturnValue({en0:[{address:'192.168.1.249',internal:false}]});
      vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.now()+60_000);
      expect(()=>auth.checkOrigin(reach('192.168.1.249:4337'))).not.toThrow();
      expect(()=>auth.checkOrigin(reach('10.0.0.5:4337'))).toThrow('hostname');
    } finally {vi.useRealTimers();rmSync(dir,{recursive:true,force:true});}
  });
});


it('scopes native preview cookies to one draft, read methods, expiry and a live paired device', () => {
  const dir = mkdtempSync(join(tmpdir(), 'riffet-auth-share-preview-'));
  try {
    const auth = new Auth(dir);
    const { device, token } = auth.issueDevice('Mac');
    const draftId = 'a'.repeat(32);
    const request = { method: 'GET', protocol: 'https', url: `/api/shares/drafts/${draftId}/files/index.html`,
      routeOptions: { url: '/api/shares/drafts/:id/files/*' }, params: { id: draftId, '*': 'index.html' },
      headers: { authorization: `Bearer ${token}`, 'x-riffet-share-preview': '1', 'x-forwarded-prefix': '/riffet' } } as unknown as FastifyRequest;
    let cookie = '';
    const reply = { header: (_: string, value: string) => { cookie = value; return reply; } } as unknown as FastifyReply;
    const expiresAt = Date.now() + 60_000;
    auth.issueSharePreview(reply, request, draftId, expiresAt);
    expect(cookie).toContain(`Path=/riffet/api/shares/drafts/${draftId}/files/`);
    expect(cookie).toContain('HttpOnly; SameSite=Strict;');
    expect(cookie).toContain('; Secure');
    const scoped = { ...request, headers: { cookie: cookie.split(';')[0] }, params: { id: draftId, '*': 'data/session.json' } } as unknown as FastifyRequest;
    expect(auth.sharePreview(scoped)).toBe(true);
    expect(auth.sharePreview({ ...scoped, headers: { cookie: `${scoped.headers.cookie}tampered` } } as FastifyRequest)).toBe(false);
    expect(auth.isAuthenticated(scoped)).toBe(false);
    expect(() => auth.authenticate(scoped)).toThrow('Sign in');
    expect(auth.sharePreview({ ...scoped, method: 'HEAD' } as FastifyRequest)).toBe(true);
    expect(auth.sharePreview({ ...scoped, method: 'POST' } as FastifyRequest)).toBe(false);
    expect(auth.sharePreview({ ...scoped, params: { id: 'b'.repeat(32), '*': 'index.html' } } as FastifyRequest)).toBe(false);
    expect(auth.sharePreview({ ...scoped, routeOptions: { url: '/api/settings' } } as FastifyRequest)).toBe(false);
    const date = vi.spyOn(Date, 'now').mockReturnValue(expiresAt + 1);
    try { expect(auth.sharePreview(scoped)).toBe(false); } finally { date.mockRestore(); }
    auth.revokeDevice(device.id);
    expect(auth.sharePreview(scoped)).toBe(false);
    cookie = '';
    auth.issueSharePreview(reply, request, draftId, expiresAt);
    expect(cookie).toBe('');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
