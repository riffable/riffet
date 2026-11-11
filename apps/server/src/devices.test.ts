import { describe,it,expect,vi } from 'vitest';
import { createHash,createHmac } from 'node:crypto';
import QRCode from 'qrcode';
import { mkdtempSync,readFileSync,rmSync,statSync } from 'node:fs';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyRequest } from 'fastify';
import { Auth } from './auth.js';
import { createPairingCode } from './pairing.js';
import { createApp } from './app.js';
import { request as httpRequest } from 'node:http';
import type { AdbRunner } from './riffet-mcp/adb.js';

const TOKEN='test-access-token-with-more-than-24-characters';
function makeAuth() { const dir=mkdtempSync(join(tmpdir(),'riffet-devices-')); return {dir,auth:new Auth(dir,{token:TOKEN})}; }
function bearer(token?:string,csrf?:string) {
  return {headers:{...(token?{authorization:`Bearer ${token}`}:{}),...(csrf?{'x-csrf-token':csrf}:{})}} as unknown as FastifyRequest;
}

describe('paired device credentials',()=>{
  it('authenticates a bearer token without CSRF and never discloses a hash',()=>{
    const {dir,auth}=makeAuth();
    try {
      const issued=auth.issueDevice('iPhone');
      expect(issued.token).toMatch(/^wkn_[0-9a-f]{16}_.+$/);
      expect(issued.device).not.toHaveProperty('hash');
      expect(auth.authenticate(bearer(issued.token))).toEqual({kind:'device',deviceId:issued.device.id});
      // A device proves itself with the token, so even a mutating call owes no CSRF header.
      expect(()=>auth.authenticate(bearer(issued.token),true)).not.toThrow();
      const listed=auth.listDevices();
      expect(listed).toHaveLength(1);
      expect(Object.keys(listed[0]!)).not.toContain('hash');
      expect(JSON.stringify(listed)).not.toContain(issued.token);
      expect(statSync(join(dir,'devices.json')).mode & 0o777).toBe(0o600);
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
  it('rejects a tampered token and an unknown device id',()=>{
    const {dir,auth}=makeAuth();
    try {
      const issued=auth.issueDevice('iPad');
      const tampered=issued.token.slice(0,-1)+(issued.token.endsWith('A')?'B':'A');
      expect(()=>auth.authenticate(bearer(tampered))).toThrow();
      expect(()=>auth.authenticate(bearer(`wkn_${'0'.repeat(16)}_${'a'.repeat(43)}`))).toThrow();
      expect(auth.authenticate(bearer(issued.token)).kind).toBe('device');
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
  it('stops accepting a token once its device is revoked',()=>{
    const {dir,auth}=makeAuth();
    try {
      const issued=auth.issueDevice('Pixel');
      expect(auth.revokeDevice(issued.device.id)).toBe(true);
      expect(auth.revokeDevice(issued.device.id)).toBe(false);
      expect(()=>auth.authenticate(bearer(issued.token))).toThrow();
      expect(auth.listDevices()).toHaveLength(0);
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
});

describe('device pairing over HTTP',()=>{
  const host={host:'127.0.0.1:4317'};
  const FRONT_DOOR_TOKEN='front-door-test-master-token-with-more-than-24-characters';
  async function boot(allowedHosts?:string[]) {
    const stateDir=await mkdtemp(join(tmpdir(),'riffet-pair-app-'));
    // Token-free mode refuses any proxied request, so a front door needs a signed-in session.
    const {app}=await createApp({stateDir,...(allowedHosts?{token:FRONT_DOOR_TOKEN}:{auth:false}),allowedHosts,cliPath:'/nonexistent/cursor-agent'});
    const status=allowedHosts
      ?await app.inject({method:'POST',url:'/api/auth/login',headers:host,payload:{token:FRONT_DOOR_TOKEN}})
      :await app.inject({method:'GET',url:'/api/auth/status',headers:host});
    const cookie=String(status.headers['set-cookie']).split(';')[0]!;
    const session={...host,cookie,'x-csrf-token':(status.json() as {csrfToken:string}).csrfToken};
    return {app,session,stateDir,cleanup:async()=>{await app.close();await rm(stateDir,{recursive:true,force:true});}};
  }
  it('mints a pairing code whose QR carries the code and never the master token',async()=>{
    const {app,session,stateDir,cleanup}=await boot();
    const qr=vi.spyOn(QRCode,'toString');
    try {
      await app.listen({host:'127.0.0.1',port:0});
      const response=await app.inject({method:'POST',url:'/api/pairing/code',headers:session,payload:{name:'Desk'}});
      expect(response.statusCode).toBe(200);
      const body=response.json() as {code:string;expiresAt:number;qr:string;payload:string;host:string;hosts:string[];port:number;localOnly:boolean;baseUrl:string};
      expect(body.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);
      expect(body.expiresAt).toBeGreaterThan(Date.now());
      expect(body.qr).toContain('<svg');
      expect(body.hosts).toEqual(['127.0.0.1']);
      expect(body.host).toBe(body.hosts[0]);
      expect(body.localOnly).toBe(true);
      expect(body.port).toBe((app.server.address() as {port:number}).port);
      expect(body.baseUrl).toBe(`http://127.0.0.1:${body.port}`);
      expect(JSON.parse(String(qr.mock.calls[0]?.[0]))).toMatchObject({v:1,host:body.host,port:body.port,scheme:'http',code:body.code});
      expect(body.payload).toBe(String(qr.mock.calls[0]?.[0]));
      // A device token is what pairing hands out; the master access token must never leave this route.
      const master=readFileSync(join(stateDir,'access-token'),'utf8').trim();
      expect(master.length).toBeGreaterThan(20);
      expect(body).not.toHaveProperty('token');
      expect(response.body).not.toContain(master);
      expect(body.qr).not.toContain(master);
      // The QR is only useful while the code is alive, and the code is single-use.
      expect((await app.inject({method:'POST',url:'/api/devices/pair',headers:host,payload:{code:body.code,name:'Desk Phone'}})).statusCode).toBe(200);
      expect((await app.inject({method:'POST',url:'/api/devices/pair',headers:host,payload:{code:body.code,name:'Replay'}})).statusCode).toBe(401);
    } finally { qr.mockRestore();await cleanup(); }
  });
  it('keeps an allowlisted TLS front door authority and rejects an unallowed host',async()=>{
    const {app,session,cleanup}=await boot(['riffet.example.test']);
    try {
      const headers={...session,host:'riffet.example.test','x-forwarded-proto':'https','x-forwarded-host':'attacker.invalid'};
      const response=await app.inject({method:'POST',url:'/api/pairing/code',headers,payload:{}});
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({host:'riffet.example.test',hosts:['riffet.example.test'],port:443,scheme:'https',baseUrl:'https://riffet.example.test:443',localOnly:false});
      expect(response.body).not.toContain('attacker.invalid');
      const denied=await app.inject({method:'POST',url:'/api/pairing/code',headers:{...headers,host:'attacker.invalid'},payload:{}});
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe('INVALID_HOST');
    } finally { await cleanup(); }
  });
  it('pairs without a session, lists devices, and revokes them',async()=>{
    const {app,cleanup}=await boot();
    try {
      const pairing=createPairingCode();
      const paired=await app.inject({method:'POST',url:'/api/devices/pair',headers:host,payload:{code:` ${pairing.code.toLowerCase()} `,name:'My Phone'}});
      expect(paired.statusCode).toBe(200);
      const {device,token}=paired.json() as {device:{id:string;name:string};token:string};
      expect(device).toMatchObject({name:'My Phone'});
      expect(device).not.toHaveProperty('hash');
      expect(token).toMatch(/^wkn_/);
      // The code is single-use even though pairing succeeded.
      expect((await app.inject({method:'POST',url:'/api/devices/pair',headers:host,payload:{code:pairing.code,name:'Again'}})).statusCode).toBe(401);

      const auth={...host,authorization:`Bearer ${token}`};
      expect((await app.inject({method:'GET',url:'/api/devices',headers:{} })).statusCode).toBe(401);
      const listed=await app.inject({method:'GET',url:'/api/devices',headers:auth});
      expect(listed.statusCode).toBe(200);
      expect(JSON.stringify(listed.json())).not.toContain('hash');
      expect((listed.json() as {devices:unknown[]}).devices).toHaveLength(1);
      expect((await app.inject({method:'GET',url:'/api/bootstrap',headers:auth})).json()).toMatchObject({csrfToken:''});
      expect((await app.inject({method:'GET',url:'/api/auth/status',headers:auth})).json()).toEqual({authenticated:true,tokenRequired:false,kind:'device'});
      // A phone that lost this server's address checks a candidate without sending the token: only the record's holder can answer.
      const nonce='n'.repeat(24);
      const proved=await app.inject({method:'POST',url:'/api/devices/prove',headers:host,payload:{device:device.id,nonce}});
      expect(proved.statusCode).toBe(200);
      const key=createHash('sha256').update(token).digest('base64url');
      expect(proved.json()).toEqual({proof:createHmac('sha256',key).update(nonce).digest('base64url')});
      expect((await app.inject({method:'POST',url:'/api/devices/prove',headers:host,payload:{device:'unknown',nonce}})).statusCode).toBe(404);

      expect((await app.inject({method:'DELETE',url:`/api/devices/${device.id}`,headers:auth})).json()).toEqual({ok:true});
      expect((await app.inject({method:'GET',url:'/api/devices',headers:auth})).statusCode).toBe(401);
      expect((await app.inject({method:'DELETE',url:`/api/devices/${device.id}`,headers:auth})).statusCode).toBe(401);
    } finally { await cleanup(); }
  });
  it('throttles failed pairing attempts by client address',async()=>{
    const {app,cleanup}=await boot();
    try {
      const pairing=createPairingCode();
      for(let attempt=0;attempt<10;attempt++)
        expect((await app.inject({method:'POST',url:'/api/devices/pair',headers:host,payload:{code:'AAAAAAAA',name:'Throttled'}})).statusCode).toBe(401);
      const limited=await app.inject({method:'POST',url:'/api/devices/pair',headers:host,payload:{code:pairing.code,name:'Throttled'}});
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error.code).toBe('PAIRING_RATE_LIMIT');
    } finally { await cleanup(); }
  });
  it('lets only a cookie session revoke all sessions, not a device bearer',async()=>{
    const {app,cleanup}=await boot();
    try {
      const issued=(await app.inject({method:'POST',url:'/api/devices/pair',headers:host,payload:{code:createPairingCode().code,name:'Phone'}})).json() as {token:string};
      const refused=await app.inject({method:'POST',url:'/api/auth/revoke-sessions',headers:{...host,authorization:`Bearer ${issued.token}`},payload:{}});
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe('COOKIE_SESSION_REQUIRED');
    } finally { await cleanup(); }
  });
  it('keeps every other /api path authenticated, including a shaped traversal path',async()=>{
    const {app,cleanup}=await boot();
    try {
      expect((await app.inject({method:'GET',url:'/api/auth/../devices',headers:host})).statusCode).not.toBe(200);
      expect((await app.inject({method:'GET',url:'/api/devices',headers:host})).statusCode).toBe(401);
      expect((await app.inject({method:'POST',url:'/api/auth/logout',headers:host,payload:{}})).statusCode).toBe(401);
    } finally { await cleanup(); }
  });
});

describe('device channel',()=>{
  const MASTER='device-channel-test-master-token-with-more-than-24-characters';
  const REPORT={platform:'android',appVersion:'1.0',capabilities:['clipboard.read','notify','future.capability'],allowControl:true};
  type Event={event:string;data:any};
  async function bootChannel(stateDir?:string,adbRunner?:AdbRunner) {
    const dir=stateDir??await mkdtemp(join(tmpdir(),'riffet-device-channel-'));
    const booted=await createApp({stateDir:dir,token:MASTER,cliPath:'/nonexistent/cursor-agent',adbRunner});
    await booted.dispatch.close();
    await booted.app.listen({host:'127.0.0.1',port:0});
    const port=(booted.app.server.address() as {port:number}).port;
    const headers=(token:string)=>({host:`127.0.0.1:${port}`,authorization:`Bearer ${token}`});
    const opened:Array<{close:()=>void}>=[];
    /** A device's stream, collecting its events. */
    const stream=async(token:string)=>{
      const events:Event[]=[];
      const response=await new Promise<import('node:http').IncomingMessage>((resolve,reject)=>{
        const req=httpRequest({host:'127.0.0.1',port,path:'/api/devices/me/stream',headers:headers(token)},resolve);req.on('error',reject);req.end();
      });
      let buffer='';
      response.setEncoding('utf8');
      response.on('data',(chunk:string)=>{
        buffer+=chunk;
        let split:number;
        while((split=buffer.indexOf('\n\n'))>=0){
          const block=buffer.slice(0,split);buffer=buffer.slice(split+2);
          const event=/^event: (.+)$/m.exec(block)?.[1],data=/^data: (.+)$/m.exec(block)?.[1];
          if(event&&data)events.push({event,data:JSON.parse(data)});
        }
      });
      response.on('error',()=>undefined);
      const handle={status:response.statusCode,events,close:()=>response.destroy()};
      opened.push(handle);
      return handle;
    };
    const mcp=(sessionId:string)=>{
      const spec=booted.riffetMcp.server(sessionId)!;
      const token=(JSON.parse(readFileSync(spec.args[spec.args.indexOf('--credential')+1]!,'utf8')) as {credential:string}).credential;
      return (method:string,params?:unknown)=>booted.app.inject({method:'POST',url:'/api/riffet-mcp',headers:headers(token),payload:{method,params}}).then(response=>response.json().result);
    };
    const close=async()=>{for(const item of opened)item.close();await booted.app.close();};
    return {...booted,dir,port,headers,stream,mcp,close};
  }
  const until=async(check:()=>boolean,ms=3000)=>{const deadline=Date.now()+ms;while(!check()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));expect(check()).toBe(true);};

  // A device answers only its own calls, once; a call made while it was away waits for it, even across a restart.
  it('isolates devices, replays queued calls on reconnect and after a restart, and keeps the first answer',async()=>{
    let booted=await bootChannel();
    try {
      const a=booted.auth.issueDevice('Phone A'),b=booted.auth.issueDevice('Phone B');
      for(const device of [a,b]){
        const reported=await booted.app.inject({method:'PUT',url:'/api/devices/me',headers:booted.headers(device.token),payload:REPORT});
        expect(reported.json()).toMatchObject({id:device.device.id,platform:'android',capabilities:['clipboard.read','notify'],allowControl:true,online:false});
      }
      // Pairing the same installation again retires the earlier record; records without an id stay.
      const old=booted.auth.issueDevice('Old install'),fresh=booted.auth.issueDevice('New install');
      for(const device of [old,fresh])await booted.app.inject({method:'PUT',url:'/api/devices/me',headers:booted.headers(device.token),payload:{...REPORT,installationId:'install-1'}});
      expect(booted.auth.device(old.device.id)).toBeUndefined();
      expect([a,b,fresh].map(item=>booted.auth.device(item.device.id)?.id)).toEqual([a.device.id,b.device.id,fresh.device.id]);
      // A browser cookie is no device: it can neither report nor listen.
      const login=await booted.app.inject({method:'POST',url:'/api/auth/login',headers:{host:`127.0.0.1:${booted.port}`},payload:{token:MASTER}});
      const cookie={host:`127.0.0.1:${booted.port}`,cookie:String(login.headers['set-cookie']).split(';')[0]!,'x-csrf-token':login.json().csrfToken};
      expect((await booted.app.inject({method:'PUT',url:'/api/devices/me',headers:cookie,payload:REPORT})).statusCode).toBe(403);
      expect((await booted.app.inject({method:'GET',url:'/api/devices/me/stream',headers:cookie})).statusCode).toBe(403);

      const project=booted.store.createProject(booted.dir,'devices');
      const session=booted.store.createSession({projectId:project.id,kind:'native',toolGroups:[`device:${a.device.id}`]});
      const rpc=booted.mcp(session.id);
      const listed=(await rpc('tools/list')).tools as Array<{name:string;inputSchema:{properties:{device:{enum:string[]}}}}>;
      expect(listed.map(tool=>tool.name)).toContain('device_clipboard_read');
      expect(listed.find(tool=>tool.name==='device_clipboard_read')!.inputSchema.properties.device.enum).toEqual([a.device.id]);
      // Not this conversation's device.
      expect((await rpc('tools/call',{name:'device_notify',arguments:{device:b.device.id,body:'hi'}})).content[0].text).toContain('DEVICE_NOT_ALLOWED');

      // Connected once, then gone: the call waits for the reconnect.
      const first=await booted.stream(a.token);
      await until(()=>booted.devices.online(a.device.id));
      first.close();
      await until(()=>!booted.devices.online(a.device.id));
      const pending=rpc('tools/call',{name:'device_clipboard_read',arguments:{timeoutSeconds:20}});
      await until(()=>Object.values(booted.store.getSetting<Record<string,{status:string}>>('riffet-mcp:device-calls',{})).some(call=>call.status==='pending'));
      const other=await booted.stream(b.token);
      const again=await booted.stream(a.token);
      await until(()=>again.events.some(item=>item.event==='call'));
      const call=again.events.find(item=>item.event==='call')!.data as {callId:string;capability:string;sessionId:string};
      expect(call).toMatchObject({capability:'clipboard.read',sessionId:session.id});
      expect(other.events.some(item=>item.event==='call')).toBe(false);
      const answer=(token:string,payload:unknown)=>booted.app.inject({method:'POST',url:`/api/devices/me/calls/${call.callId}/result`,headers:booted.headers(token),payload:payload as object});
      expect((await answer(b.token,{ok:true,result:{text:'stolen'}})).statusCode).toBe(404);
      const receipt=await answer(a.token,{ok:true,result:{text:'copied text'}});
      expect(receipt.statusCode).toBe(200);
      // A retried answer, even a different one, gets the first receipt.
      expect((await answer(a.token,{ok:true,result:{text:'second'}})).json()).toEqual(receipt.json());
      const result=await pending;
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({result:{text:'copied text'}});
      expect(((await booted.app.inject({method:'GET',url:'/api/devices',headers:cookie})).json() as {devices:Array<{id:string;online:boolean}>}).devices)
        .toEqual(expect.arrayContaining([expect.objectContaining({id:a.device.id,online:true}),expect.objectContaining({id:b.device.id,online:true})]));

      // Queued while the server is down: the call is on disk and reaches the device after the restart.
      again.close();
      void booted.devices.call({sessionId:session.id,deviceId:a.device.id,capability:'notify',args:{body:'later'},timeoutMs:60_000});
      const stateDir=booted.dir;
      await booted.close();
      booted=await bootChannel(stateDir);
      const restarted=await booted.stream(a.token);
      await until(()=>restarted.events.some(item=>item.event==='call'&&item.data.capability==='notify'));
    } finally { await booted.close();await rm(booted.dir,{recursive:true,force:true}); }
  });

  // The adb shortcut picks the phone by its installation file, never by model, and runs only the two fixed grants.
  it('matches the adb entry by installation id, runs the two grants against it and reports a refused grant',async()=>{
    const calls:string[][]=[];
    let refuse=false;
    const runner:AdbRunner=async(_adb,args)=>{
      calls.push(args);
      if(args[0]==='devices')return{ok:true,output:'List of devices attached\nAAA\tdevice model:Pixel\nBBB\tdevice model:Pixel\n'};
      if(args[3]==='cat')return{ok:true,output:args[1]==='BBB'?'install-mine\n':'install-other'};
      if(args[3]==='pm')return refuse?{ok:false,output:"Exception occurred while executing 'grant':\njava.lang.SecurityException: GRANT_RUNTIME_PERMISSIONS\n  at x"}:{ok:true,output:''};
      return{ok:false,output:'Unknown operation string: ACCESS_RESTRICTED_SETTINGS'};
    };
    const booted=await bootChannel(undefined,runner);
    try {
      const phone=booted.auth.issueDevice('Phone');
      await booted.app.inject({method:'PUT',url:'/api/devices/me',headers:booted.headers(phone.token),payload:{...REPORT,installationId:'install-mine'}});
      const pkg='io.github.riffetai.android';
      expect((await booted.app.inject({method:'GET',url:`/api/devices/me/adb?package=${pkg}`,headers:booted.headers(phone.token)})).json()).toEqual({state:'ready'});
      calls.length=0;
      const granted=await booted.app.inject({method:'POST',url:'/api/devices/me/adb/grant',headers:booted.headers(phone.token),payload:{packageName:pkg}});
      expect(granted.json()).toEqual({restrictedSettings:'unsupported'});
      expect(calls.filter(args=>args[0]==='-s'&&args[3]!=='cat')).toEqual([
        ['-s','BBB','shell','pm','grant',pkg,'android.permission.WRITE_SECURE_SETTINGS'],
        ['-s','BBB','shell','appops','set',pkg,'ACCESS_RESTRICTED_SETTINGS','allow'],
      ]);
      // Only the Riffet app can be granted anything, whatever package the caller names.
      calls.length=0;
      expect((await booted.app.inject({method:'POST',url:'/api/devices/me/adb/grant',headers:booted.headers(phone.token),payload:{packageName:'com.evil'}})).json().error.code).toBe('INVALID_PACKAGE_NAME');
      expect(calls).toEqual([]);
      refuse=true;
      const denied=await booted.app.inject({method:'POST',url:'/api/devices/me/adb/grant',headers:booted.headers(phone.token),payload:{packageName:pkg}});
      expect(denied.statusCode).toBe(409);
      expect(denied.json().error).toMatchObject({code:'ADB_GRANT_FAILED',message:'java.lang.SecurityException: GRANT_RUNTIME_PERMISSIONS'});
      const login=await booted.app.inject({method:'POST',url:'/api/auth/login',headers:{host:`127.0.0.1:${booted.port}`},payload:{token:MASTER}});
      const cookie={host:`127.0.0.1:${booted.port}`,cookie:String(login.headers['set-cookie']).split(';')[0]!,'x-csrf-token':login.json().csrfToken};
      const refused=await booted.app.inject({method:'GET',url:`/api/devices/me/adb?package=${pkg}`,headers:cookie});
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe('DEVICE_TOKEN_REQUIRED');
    } finally { await booted.close();await rm(booted.dir,{recursive:true,force:true}); }
  });

  // A device that never comes back must not hold the agent past its deadline, and must not receive the stale call later.
  it('ends a call at its deadline: DEVICE_UNREACHABLE when never delivered, DEVICE_TIMEOUT when delivered',async()=>{
    const booted=await bootChannel();
    try {
      const phone=booted.auth.issueDevice('Phone');
      await booted.app.inject({method:'PUT',url:'/api/devices/me',headers:booted.headers(phone.token),payload:REPORT});
      const project=booted.store.createProject(booted.dir,'deadline');
      const rpc=booted.mcp(booted.store.createSession({projectId:project.id,kind:'native',toolGroups:['riffet.core',`device:${phone.device.id}`]}).id);
      const offline=await rpc('tools/call',{name:'device_clipboard_read',arguments:{timeoutSeconds:1}});
      expect(offline.isError).toBe(true);
      expect(offline.content[0].text).toContain('DEVICE_UNREACHABLE');
      const online=await booted.stream(phone.token);
      await until(()=>booted.devices.online(phone.device.id));
      await new Promise(resolve=>setTimeout(resolve,50));
      expect(online.events.some(item=>item.event==='call')).toBe(false);
      const silent=await rpc('tools/call',{name:'device_notify',arguments:{body:'hello',timeoutSeconds:1}});
      expect(silent.content[0].text).toContain('DEVICE_TIMEOUT');
      const delivered=online.events.find(item=>item.event==='call')!.data as {callId:string};
      await until(()=>online.events.some(item=>item.event==='cancel'&&item.data.callId===delivered.callId));
      expect((await booted.app.inject({method:'POST',url:`/api/devices/me/calls/${delivered.callId}/result`,headers:booted.headers(phone.token),payload:{ok:true,result:{}}})).statusCode).toBe(409);
    } finally { await booted.close();await rm(booted.dir,{recursive:true,force:true}); }
  });

  // A wake-up in a conversation that uses a device asks that device to be awake for it, and stops asking once it is gone.
  it('leases a device for a wake-up and withdraws the lease when the wake-up is cancelled',async()=>{
    const booted=await bootChannel();
    try {
      const phone=booted.auth.issueDevice('Phone');
      const project=booted.store.createProject(booted.dir,'lease');
      const session=booted.store.createSession({projectId:project.id,kind:'native',toolGroups:['riffet.core',`device:${phone.device.id}`]});
      const plain=booted.store.createSession({projectId:project.id,kind:'native',toolGroups:['riffet.core']});
      const early=booted.orchestration.scheduleWakeup(session.id,{dueAt:new Date(Date.now()+10*60_000),note:'open the app\nthen more'});
      booted.orchestration.scheduleWakeup(plain.id,{dueAt:new Date(Date.now()+10*60_000),note:'no device'});
      const online=await booted.stream(phone.token);
      // Replayed on connect, only for conversations that use this device.
      await until(()=>online.events.some(item=>item.event==='lease'));
      expect(online.events.filter(item=>item.event==='lease').map(item=>item.data)).toEqual([{id:early.id,sessionId:session.id,at:early.dueAt,reason:'open the app'}]);
      const later=booted.orchestration.scheduleWakeup(session.id,{dueAt:new Date(Date.now()+20*60_000),note:'second'});
      await until(()=>online.events.some(item=>item.event==='lease'&&item.data.id===later.id));
      booted.orchestration.cancelWakeup(later.id,session.id);
      await until(()=>online.events.some(item=>item.event==='lease-cancel'&&item.data.id===later.id));
      expect(booted.devices.leases(phone.device.id).map(lease=>lease.id)).toEqual([early.id]);
    } finally { await booted.close();await rm(booted.dir,{recursive:true,force:true}); }
  });
});
