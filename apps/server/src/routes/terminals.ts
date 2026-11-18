import { requireBackendVisibleToClient, visibleProjectItemsForClient } from '../native/client-features.js';
import { LEGACY_DEFAULT_BACKEND_ID } from '../session-identity.js';
import { isNativeBackendId } from '../backends/registry.js';
import type { FastifyInstance } from 'fastify';
import { AppError, requireString } from '../errors.js';
import type { TerminalClientMessage } from '../../../../packages/contracts/src/index.js';
import { revisionedList } from './params.js';
import type { RouteDeps } from './deps.js';
import { readTerminalAppearance, resolveTerminalAppearance, sameTerminalAppearance } from '../terminal/appearance.js';
import { registerTerminalAttachmentRoutes } from './terminal-attachments.js';

/** A protocol 3 socket may hold this much unsent data before it is closed: a few seeds and the output between them. */
const TERMINAL_SOCKET_BUFFER_LIMIT=32*1024*1024;

export function registerTerminalRoutes(app: FastifyInstance, deps: RouteDeps): void {
  registerTerminalAttachmentRoutes(app, deps);
  const {store,auth,terminal,nativeBackends,dispatch}=deps;
  app.get('/api/terminals',async(request,reply)=>revisionedList(request,reply,store.terminalsRevision,()=>visibleProjectItemsForClient(request.headers,terminal.listSnapshot(),id=>store.getProject(id))));
  app.get<{Params:{id:string}}>('/api/terminals/:id',async(request)=>{
    const info=await terminal.get(request.params.id);
    if('warmup' in info)throw new AppError('TERMINAL_NOT_FOUND','Terminal not found',404);
    return info;
  });
  app.post<{Body:{projectId:string;sessionId?:string;kind?:'shell'|'cursor'|'login';title?:string;args?:string[];backendId?:string}}>('/api/terminals',async(request)=>{
    const body=request.body,project=store.getProject(requireString(body?.projectId,'projectId',100));
    if(body.sessionId&&store.getSession(body.sessionId).projectId!==project.id)throw new AppError('INVALID_TERMINAL','Conversation belongs to another project');
    if(body.kind==='cursor')throw new AppError('CURSOR_SESSION_REQUIRED','Start native Cursor through a native conversation so workspace ownership and recovery are tracked',400);
    if(body.kind!==undefined&&!['shell','login'].includes(body.kind))throw new AppError('INVALID_TERMINAL_KIND','Choose a shell or login terminal');
    const appearance=readTerminalAppearance(request.headers);
    // Only named fields reach the terminal service: a launch specification is never taken from a request.
    if(body.kind==='login'){
      // Clients that predate several backends send no backend: the login they mean is the first one's.
      const backendId=body.backendId===undefined?LEGACY_DEFAULT_BACKEND_ID:isNativeBackendId(body.backendId)?body.backendId:(()=>{throw new AppError('INVALID_BACKEND','Choose a supported native backend');})();
      requireBackendVisibleToClient(request.headers,backendId);
      const launchSpec=await nativeBackends.admin.loginLaunchSpec(backendId,project);
      return terminal.create(project,{kind:'login',...(body.sessionId?{sessionId:body.sessionId}:{}),title:body.title??launchSpec.title,appearance,launchSpec});
    }
    return terminal.create(project,{kind:body.kind,...(body.sessionId?{sessionId:body.sessionId}:{}),...(body.title!==undefined?{title:body.title}:{}),...(body.args!==undefined?{args:body.args}:{}),appearance});
  });
  // A viewer's theme. It becomes the conversation's colours for later launches and is applied to
  // the running pane now: recoloured in place, or by relaunching a CLI that probes colours once.
  app.post<{Params:{id:string};Body:{foreground?:unknown;background?:unknown}}>('/api/terminals/:id/appearance',async(request)=>{
    const appearance=resolveTerminalAppearance({foreground:request.body?.foreground as string,background:request.body?.background as string})!;
    const current=await terminal.get(request.params.id);
    if('warmup' in current)throw new AppError('TERMINAL_NOT_FOUND','Terminal not found',404);
    if(current.state==='exited'||sameTerminalAppearance(current.appearance,appearance))return current;
    if(current.sessionId){
      const session=store.getSession(current.sessionId);
      const updated=sameTerminalAppearance(session.terminalAppearance,appearance)?session:store.updateSession(session.id,{terminalAppearance:appearance});
      if(updated.terminalId===current.id&&await nativeBackends.relaunchForAppearance(updated)){
        return terminal.get(store.getSession(session.id).terminalId??current.id);
      }
    }
    return terminal.setAppearance(current.id,appearance);
  });
  app.post<{Params:{id:string};Body:{clientId:string;takeover?:boolean}}>('/api/terminals/:id/claim',async(request)=>terminal.claim(request.params.id,requireString(request.body?.clientId,'clientId',200),Boolean(request.body.takeover)));
  app.get<{Params:{id:string};Querystring:{known?:string;mode?:string}}>('/api/terminals/:id/history',async(request)=>terminal.history(request.params.id,typeof request.query.known==='string'?request.query.known:undefined,request.query.mode==='tail'));
  app.get<{Params:{id:string}}>('/api/terminals/:id/diagnostics',async(request)=>terminal.gridDiagnostics(request.params.id));
  app.post<{Params:{id:string}}>('/api/terminals/:id/interrupt',async(request)=>{await terminal.interrupt(request.params.id);return terminal.get(request.params.id);});
  app.delete<{Params:{id:string}}>('/api/terminals/:id',async(request)=>{
    const current=await terminal.get(request.params.id);
    if(current.sessionId&&current.kind==='native'){
      const activeRuns=store.listUnfinishedNativeRuns(current.sessionId).some(run=>!['queued','preparing'].includes(run.native!.delivery));
      if(activeRuns)await dispatch.interrupt(current.sessionId);
      await nativeBackends.dispose(current.sessionId);
    }
    await terminal.stop(request.params.id);return terminal.get(request.params.id);
  });
  app.get<{Params:{id:string};Querystring:{protocol?:string}}>('/api/terminals/:id/ws',{websocket:true},(socket,request)=>{
    const id=request.params.id;store.getTerminal(id);let clientId:string|undefined,epoch:number|undefined,closed=false;
    const unwatch=auth.onRevoke(request,()=>{closed=true;socket.terminate();});
    socket.once('close',unwatch);
    let chain=Promise.resolve();
    const protocol=Number(request.query.protocol)||1;
    const unsubscribe=terminal.subscribe(id,event=>{
      if(socket.readyState!==1)return;
      // Protocol 3 sheds a viewer that stops reading by reseeding it (see TerminalService.subscribe);
      // this is only the bound on what a stalled socket may hold, since each reseed queues a snapshot.
      if(socket.bufferedAmount>(protocol>=3?TERMINAL_SOCKET_BUFFER_LIMIT:4*1024*1024)){socket.close(1013,'Terminal output exceeded this connection buffer; reconnect to restore the screen');return;}
      // Older clients only understand output frames. New clients opt into explicit replacement
      // boundaries and geometry; the pane bytes are compatible with legacy viewers.
      const message = protocol>=2 ? event
        : event.type === 'snapshot' ? { type: 'output', data: event.data, sequence: event.sequence }
        : event.type === 'exit' ? { ...event, exitCode: event.exitCode ?? -1 } : event;
      socket.send(JSON.stringify(message));
    },{protocol});
    socket.on('message',raw=>{
      // Acks only settle a counter. Behind a long claim/paste/resize they would arrive late and make a
      // client that keeps up look as if it had stopped reading, so they skip the chain.
      let parsed:TerminalClientMessage|undefined;
      try{parsed=JSON.parse(raw.toString()) as TerminalClientMessage;}catch{/* Reported from the chain, in order. */}
      if(parsed?.type==='ack'){if(!closed&&Number.isFinite(parsed.chars))unsubscribe.ack(parsed.chars);return;}
      chain=chain.then(async()=>{
        if(closed)return;
        // Messages already queued before revocation must not acquire control or write input.
        auth.authenticate(request);
        const message=parsed??JSON.parse(raw.toString()) as TerminalClientMessage;
        if(message.type==='claim'){
          const info=await terminal.claim(id,requireString(message.clientId,'clientId',200),Boolean(message.takeover));clientId=message.clientId;epoch=info.epoch;
          if(closed)await terminal.release(id,clientId,epoch).catch(()=>undefined);
        }
        else if(message.type==='input'){
          if(message.clientId!==clientId||message.epoch!==epoch)throw new AppError('TERMINAL_LEASE_REQUIRED','Claim terminal control before sending input',409);
          if(typeof message.data!=='string'||message.data.length>128*1024)throw new AppError('INPUT_TOO_LARGE','Paste at most 128 KiB at once');await terminal.input(id,message.clientId,message.epoch,message.data);
        }
        else if(message.type==='paste'){
          if(message.clientId!==clientId||message.epoch!==epoch)throw new AppError('TERMINAL_LEASE_REQUIRED','Claim terminal control before pasting',409);
          if(typeof message.data!=='string')throw new AppError('INVALID_TERMINAL_INPUT','Paste text must be a string');
          // paste-buffer turns each LF into a CR and leaves CR alone, so CRLF would press Enter twice.
          await terminal.pasteAttachmentsWithLease(id,message.clientId,message.epoch,message.data.replace(/\r\n?/g,'\n'));
        }
        else if(message.type==='resize'){
          if(message.clientId!==clientId||message.epoch!==epoch)throw new AppError('TERMINAL_LEASE_REQUIRED','Claim terminal control before resizing',409);
          await terminal.resize(id,message.clientId,message.epoch,message.cols,message.rows);
        }
        else if(message.type==='release'){await terminal.release(id,message.clientId,message.epoch);clientId=undefined;epoch=undefined;}
        else throw new AppError('INVALID_MESSAGE','Unknown terminal message');
      }).catch(error=>{const e=error as AppError;if(socket.readyState===1)socket.send(JSON.stringify({type:'error',code:e.code??'TERMINAL_ERROR',message:e.message}));});
    });
    socket.on('close',()=>{closed=true;unsubscribe();if(clientId&&epoch!==undefined)void terminal.release(id,clientId,epoch).catch(()=>undefined);});
  });
}
