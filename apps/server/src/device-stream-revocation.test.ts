import {describe,it,expect,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest,type IncomingMessage} from 'node:http';
import {createApp} from './app.js';
import {createPairingCode} from './pairing.js';

const TOKEN='device-stream-test-master-token-with-more-than-24-characters';
const host={host:'127.0.0.1:4337'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check:()=>boolean) {
  const deadline=Date.now()+2000;
  while(!check()&&Date.now()<deadline)await tick();
  expect(check()).toBe(true);
}

describe.each(['cookie','bearer'] as const)('live device revocation (%s)',kind=>{
  it('immediately closes every SSE route and terminal socket, drops queued input, and leaves other clients connected',async()=>{
    const stateDir=await mkdtemp(join(tmpdir(),'riffet-revoke-stream-'));
    const {app,auth,store,terminal,nativeBackends}=await createApp({stateDir,token:TOKEN,cliPath:'/nonexistent/cursor-agent'});
    const responses:IncomingMessage[]=[];
    const sockets:Array<Awaited<ReturnType<typeof app.injectWS>>>=[];
    let finishClaim:(()=>void)|undefined;
    try {
      const browser=await app.inject({method:'POST',url:'/api/auth/login',headers:host,payload:{code:createPairingCode().code}});
      const native=kind==='bearer'?auth.issueDevice('Revoked iPhone'):undefined;
      const deviceId=native?.device.id??browser.json().device.id;
      const credential:Record<string,string>=native?{authorization:`Bearer ${native.token}`}:{cookie:String(browser.headers['set-cookie']).split(';')[0]!};
      const headers={...host,...credential};
      const other=auth.issueDevice('Other device');
      const master=await app.inject({method:'POST',url:'/api/auth/login',headers:host,payload:{token:TOKEN}});
      const masterHeaders={...host,cookie:String(master.headers['set-cookie']).split(';')[0]!};
      const project=store.createProject(stateDir,'Revocation test');
      const session=store.createSession({projectId:project.id,kind:'native',backendId:'cursor'});
      const terminalInfo=store.saveTerminal({id:'revocation-terminal',projectId:project.id,kind:'shell',title:'No process',state:'exited',persistent:false,epoch:0,cols:80,rows:24,createdAt:new Date().toISOString()});
      const unsubscribe=vi.fn();
      vi.spyOn(nativeBackends,'watchControl').mockReturnValue({status:()=>({phase:'offline'}),context:()=>undefined,close:unsubscribe});
      const claim=vi.spyOn(terminal,'claim').mockImplementation(()=>new Promise(resolve=>{finishClaim=()=>resolve({...terminalInfo,epoch:1});}));
      const input=vi.spyOn(terminal,'input');
      vi.spyOn(terminal,'release').mockResolvedValue(terminalInfo);
      await app.listen({host:'127.0.0.1',port:0});
      const port=(app.server.address() as {port:number}).port;
      const open=async(path:string,requestHeaders:Record<string,string>)=>{
        const response=await new Promise<IncomingMessage>((resolve,reject)=>{
          const req=httpRequest({host:'127.0.0.1',port,path,headers:requestHeaders},resolve);
          req.on('error',reject);req.end();
        });
        // Revocation destroys the socket: aborted/error/close are the expected termination.
        response.on('error',()=>undefined);response.resume();responses.push(response);
        expect(response.statusCode).toBe(200);
        return response;
      };
      const streams:IncomingMessage[]=[];
      for(const path of ['/api/lists/stream','/api/stats/stream',`/api/sessions/${session.id}/stream`,`/api/v3/sessions/${session.id}/sync`])streams.push(await open(path,headers));
      const masterStream=await open('/api/lists/stream',masterHeaders);
      const otherStream=await open('/api/lists/stream',{...host,authorization:`Bearer ${other.token}`});
      const socket=await app.injectWS('/api/terminals/revocation-terminal/ws',{headers});sockets.push(socket);
      const listsSocket=await app.injectWS('/api/lists/stream',{headers});sockets.push(listsSocket);
      const masterListsSocket=await app.injectWS('/api/lists/stream',{headers:masterHeaders});sockets.push(masterListsSocket);
      const masterSocket=await app.injectWS('/api/terminals/revocation-terminal/ws',{headers:masterHeaders});sockets.push(masterSocket);
      const otherSocket=await app.injectWS('/api/terminals/revocation-terminal/ws',{headers:{...host,authorization:`Bearer ${other.token}`}});sockets.push(otherSocket);
      socket.send(JSON.stringify({type:'claim',clientId:'revoked-client'}));
      await until(()=>claim.mock.calls.length===1);
      socket.send(JSON.stringify({type:'input',clientId:'revoked-client',epoch:1,data:'must never reach terminal'}));
      await tick();
      expect(auth.revokeDevice(deviceId)).toBe(true);
      finishClaim?.();
      await until(()=>streams.every(response=>response.destroyed)&&socket.readyState===3&&listsSocket.readyState===3);
      expect(input).not.toHaveBeenCalled();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(masterStream.destroyed).toBe(false);
      expect(otherStream.destroyed).toBe(false);
      expect(masterListsSocket.readyState).toBe(1);
      expect(masterSocket.readyState).toBe(1);
      expect(otherSocket.readyState).toBe(1);
      expect((await app.inject({url:'/api/bootstrap',headers})).statusCode).toBe(401);
    } finally {
      finishClaim?.();
      for(const socket of sockets)socket.terminate();
      for(const response of responses)response.destroy();
      await app.close();vi.restoreAllMocks();await rm(stateDir,{recursive:true,force:true});
    }
  });
});
