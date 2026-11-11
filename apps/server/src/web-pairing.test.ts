import { describe,it,expect } from 'vitest';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { createApp } from './app.js';
import { createPairingCode } from './pairing.js';

const TOKEN='test-web-access-token-with-more-than-24-characters';
const host={host:'127.0.0.1:4337'};
async function boot() {
  const stateDir=await mkdtemp(join(tmpdir(),'riffet-web-pair-'));
  const server=await createApp({stateDir,token:TOKEN,cliPath:'/nonexistent/cursor-agent'});
  return {...server,cleanup:async()=>{await server.app.close();await rm(stateDir,{recursive:true,force:true});}};
}

describe('browser pairing login',()=>{
  it('exchanges a code for a revocable HttpOnly cookie, preserving CSRF and master login compatibility',async()=>{
    const {app,cleanup}=await boot();
    try {
      const code=createPairingCode().code;
      const login=await app.inject({method:'POST',url:'/api/auth/login',headers:host,payload:{code:` ${code.toLowerCase()} `,name:'Web · Mac'}});
      expect(login.statusCode).toBe(200);
      const body=login.json();
      expect(body).toMatchObject({authenticated:true,tokenRequired:true,device:{name:'Web · Mac'}});
      expect(body).not.toHaveProperty('token');
      expect(body.device).not.toHaveProperty('hash');
      expect(login.body).not.toContain('wkn_');
      const rawCookie=String(login.headers['set-cookie']);
      expect(rawCookie).toContain('HttpOnly; SameSite=Strict; Path=/');
      const cookie=rawCookie.split(';')[0]!;
      const browser={...host,cookie};
      expect((await app.inject({url:'/api/auth/status',headers:browser})).json()).toMatchObject({authenticated:true,csrfToken:body.csrfToken});
      const devices=await app.inject({url:'/api/devices',headers:browser});
      expect(devices.json().devices).toHaveLength(1);
      expect((await app.inject({method:'POST',url:'/api/pairing/code',headers:browser,payload:{}})).statusCode).toBe(403);
      expect((await app.inject({method:'POST',url:'/api/pairing/code',headers:{...browser,'x-csrf-token':body.csrfToken},payload:{}})).statusCode).toBe(200);
      expect((await app.inject({method:'POST',url:'/api/auth/login',headers:host,payload:{code}})).statusCode).toBe(401);
      expect((await app.inject({method:'POST',url:'/api/devices/pair',headers:host,payload:{code,name:'Replay'}})).statusCode).toBe(401);

      const master=await app.inject({method:'POST',url:'/api/auth/login',headers:host,payload:{token:TOKEN}});
      expect(master.statusCode).toBe(200);
      const masterCookie=String(master.headers['set-cookie']).split(';')[0]!;
      const revoked=await app.inject({method:'DELETE',url:`/api/devices/${body.device.id}`,headers:{...host,cookie:masterCookie,'x-csrf-token':master.json().csrfToken}});
      expect(revoked.statusCode).toBe(200);
      expect((await app.inject({url:'/api/bootstrap',headers:browser})).statusCode).toBe(401);
      expect((await app.inject({url:'/api/auth/status',headers:browser})).json()).toMatchObject({authenticated:false});
      expect((await app.inject({url:'/api/bootstrap',headers:{...host,cookie:masterCookie}})).statusCode).toBe(200);
    } finally {await cleanup();}
  });
  it('rejects expired codes, preserves a valid code on invalid names, and cannot reuse native redemption',async()=>{
    const {app,cleanup}=await boot();
    try {
      const expired=createPairingCode(-1).code;
      expect((await app.inject({method:'POST',url:'/api/auth/login',headers:host,payload:{code:expired}})).statusCode).toBe(401);
      const code=createPairingCode().code;
      expect((await app.inject({method:'POST',url:'/api/auth/login',headers:host,payload:{code,name:' '.repeat(2)}})).statusCode).toBe(400);
      expect((await app.inject({method:'POST',url:'/api/devices/pair',headers:host,payload:{code,name:'iPhone'}})).statusCode).toBe(200);
      expect((await app.inject({method:'POST',url:'/api/auth/login',headers:host,payload:{code}})).statusCode).toBe(401);
    } finally {await cleanup();}
  });
  it('shares the failed-code rate limit across browser and native redemption',async()=>{
    const {app,cleanup}=await boot();
    try {
      for(let attempt=0;attempt<10;attempt++) {
        const url=attempt%2===0?'/api/auth/login':'/api/devices/pair';
        expect((await app.inject({method:'POST',url,headers:host,payload:{code:'BADCODE',name:'Web'}})).statusCode).toBe(401);
      }
      const denied=await app.inject({method:'POST',url:'/api/auth/login',headers:host,payload:{code:createPairingCode().code}});
      expect(denied.statusCode).toBe(429);
      expect(denied.json().error.code).toBe('PAIRING_RATE_LIMIT');
      expect((await app.inject({method:'POST',url:'/api/auth/login',headers:host,payload:{token:TOKEN}})).statusCode).toBe(200);
    } finally {await cleanup();}
  });
  it('accepts the paired cookie for EventSource and WebSocket handshakes and rejects both after revocation',async()=>{
    const {app,auth,store,cleanup}=await boot();
    let stream:IncomingMessage|undefined;
    let socket:Awaited<ReturnType<typeof app.injectWS>>|undefined;
    try {
      const login=await app.inject({method:'POST',url:'/api/auth/login',headers:host,payload:{code:createPairingCode().code}});
      const cookie=String(login.headers['set-cookie']).split(';')[0]!;
      const deviceId=login.json().device.id as string;
      await app.listen({host:'127.0.0.1',port:0});
      const port=(app.server.address() as {port:number}).port;
      stream=await new Promise<IncomingMessage>((resolve,reject)=>{
        const req=httpRequest({host:'127.0.0.1',port,path:'/api/lists/stream',headers:{...host,cookie}},resolve);
        req.on('error',reject);req.end();
      });
      expect(stream.statusCode).toBe(200);
      expect(stream.headers['content-type']).toBe('text/event-stream');
      store.saveTerminal({id:'browser-cookie-terminal',projectId:store.createProject(tmpdir(),'Test').id,kind:'shell',title:'Test',state:'exited',persistent:false,epoch:0,cols:80,rows:24,createdAt:new Date().toISOString()});
      socket=await app.injectWS('/api/terminals/browser-cookie-terminal/ws',{headers:{...host,cookie}});
      expect(socket.readyState).toBe(1);
      socket.close();socket=undefined;
      stream.destroy();stream=undefined;
      auth.revokeDevice(deviceId);
      expect((await app.inject({url:'/api/lists/stream',headers:{...host,cookie}})).statusCode).toBe(401);
      await expect(app.injectWS('/api/terminals/browser-cookie-terminal/ws',{headers:{...host,cookie}})).rejects.toThrow('401');
    } finally {socket?.terminate();stream?.destroy();await cleanup();}
  });
});
