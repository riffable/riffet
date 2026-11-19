import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';
import { AppError, requireString } from '../errors.js';
import { isLoopbackHost } from '../connection-addresses.js';
import { proxiedRequest } from '../auth.js';
import { DEFAULT_DSH_CONFIG_DIR } from '../compat.js';
import path from 'node:path';
import { previewImageData, readFileBounded } from '../workspace/index.js';
import { MAX_VISUALIZATION_BYTES, renderVisualization, VISUALIZATION_CSP } from '../visualization.js';
import { contentDisposition } from '../workspace/download.js';
import { renderFilePreview } from '../previews/index.js';
import { MAX_PREVIEW_FILE_BYTES } from '../previews/formats.js';
import type { PreviewQuery } from '../previews/document.js';
import { EMPTY_INDEX_MARKER, extractIndexable, likePattern, normalizeQuery, snippet } from '../search/messages.js';
import { mergeMessageHits } from '../search/merge.js';
import { sequence, pageSize } from './params.js';
import type { RouteDeps } from './deps.js';
import { sendsQuickChat } from '../chat/quick-chat.js';
import { backendVisibleToClient, clientSupportsFeature, hiddenBackendIds, hidesPluginAgents } from '../native/client-features.js';

export function registerWorkspaceRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const {store,settings,workspace,nativeBackends,allowOutsideRead}=deps;
  const localFileActions = (request: FastifyRequest) => isLoopbackHost(request.ip) && !proxiedRequest(request.headers);
  let backfill:Promise<void>|undefined;
  app.get<{Params:{id:string};Querystring:{path?:string;limit?:string;offset?:string;cursor?:string}}>('/api/projects/:id/files',async(request)=>workspace.files(store.getProject(request.params.id),{path:request.query.path,limit:pageSize(request.query.limit),offset:sequence(request.query.offset),cursor:request.query.cursor}));
  app.get<{Params:{id:string};Querystring:{q?:string;limit?:string;offset?:string}}>('/api/projects/:id/find',async(request)=>workspace.find(store.getProject(request.params.id),{q:request.query.q??'',limit:pageSize(request.query.limit),offset:sequence(request.query.offset)}));
  /** Aborted when the client goes away before the answer, so its ripgrep scans stop with it. */
  const untilGone = (reply: FastifyReply) => { const controller = new AbortController(); reply.raw.once('close', () => { if (!reply.raw.writableFinished) controller.abort(); }); return controller.signal; };
  app.get<{Params:{id:string};Querystring:{q?:string;limit?:string;offset?:string}}>('/api/projects/:id/search',async(request,reply)=>workspace.search(store.getProject(request.params.id),{q:requireString(request.query.q,'q',500),limit:pageSize(request.query.limit),offset:sequence(request.query.offset)},untilGone(reply)));
  app.get<{Params:{id:string};Querystring:{path?:string;line?:string;column?:string;word?:string}}>('/api/projects/:id/code/definition',async(request,reply)=>workspace.definition(store.getProject(request.params.id),{path:requireString(request.query.path,'path',8192),line:Number(request.query.line),column:Number(request.query.column),word:requireString(request.query.word,'word',200)},untilGone(reply)));
  app.get<{Params:{id:string};Querystring:{path?:string;word?:string;scope?:string}}>('/api/projects/:id/code/references',async(request,reply)=>workspace.references(store.getProject(request.params.id),{path:requireString(request.query.path,'path',8192),word:requireString(request.query.word,'word',200),scope:request.query.scope==='module'?'module':'project'},untilGone(reply)));
  /**
   * Conversation search across every project.
   *
   * Questions come from the persisted runs, so they cover the whole history for every provider
   * without reading one. Answers and tool calls come from `message_index`, filled whenever a
   * transcript passes through this server. Nothing here reads a provider on its own: see
   * `NativeBackendService.indexableTranscript`.
   */
  app.get<{Querystring:{q?:string;limit?:string;sessionId?:string}}>('/api/search/messages',async(request)=>{
    const query=normalizeQuery(request.query.q);
    if(!query)return{query:'',hits:[],pending:0};
    const quickChats=sendsQuickChat(request);
    const limit=request.query.limit===undefined?50:pageSize(request.query.limit);
    const sessionId=request.query.sessionId===undefined?undefined:requireString(request.query.sessionId,'sessionId',512);
    const pattern=likePattern(query);
    // A client without quick chat or pi support must not see those conversations. Hiding them after
    // each source's LIMIT would let recent chats crowd older matches out of the result entirely.
    const hidden=hiddenBackendIds(request.headers);
    const excludeTaskWorkspaces=!clientSupportsFeature(request.headers,'projectless-tasks');
    const excludedBackendIds=[...(quickChats?[]:['chat']),...hidden];
    const hits=mergeMessageHits([store.searchPrompts(pattern,limit,sessionId,excludedBackendIds,excludeTaskWorkspaces,hidesPluginAgents(request.headers)),store.searchIndexedMessages(pattern,limit,sessionId,excludedBackendIds,excludeTaskWorkspaces,hidesPluginAgents(request.headers))],limit)
      // The 助理's background runs quote other conversations in their briefs, and a discussion's seats quote each other:
      // they are that work, not the owner's history.
      .filter(hit=>{try{const kind=store.getSession(hit.sessionId).origin?.kind;return kind!=='assistant'&&kind!=='council';}catch{return true;}})
      .map(hit=>({sessionId:hit.sessionId,projectId:hit.projectId,sessionTitle:hit.sessionTitle,archived:hit.archived,backendId:hit.backendId,messageId:hit.messageId,kind:hit.kind,at:hit.at,snippet:snippet(hit.text,query),...(hit.runId?{runId:hit.runId}:{})}));
    const backendIds=nativeBackends.readOnlyTranscriptBackendIds().filter(backendId=>(quickChats||backendId!=='chat')&&backendVisibleToClient(request.headers,backendId));
    const pending=store.countSessionsMissingMessages(backendIds,sessionId,excludeTaskWorkspaces);
    // One pass at a time: a search typed key by key must not start a reader per keystroke.
    if(pending&&!backfill){
      // Background work: the caller gets what is ready and asks again while anything is missing,
      // so a long backlog never makes the search box wait.
      backfill=(async()=>{
        for(const session of store.sessionsMissingMessages(backendIds,SEARCH_BACKFILL_BATCH,sessionId,excludeTaskWorkspaces)){
          try{
            const rows=extractIndexable(session.id,await nativeBackends.indexableTranscript(session.id));
            // A conversation that read back empty still gets a row, so it stops being "missing" and
            // every later search does not read it again. A read that fails stays missing, so it is
            // retried — that is the difference between "nothing there" and "could not look".
            store.indexMessages(rows.length?rows:[{sessionId:session.id,messageId:EMPTY_INDEX_MARKER,kind:'tool',text:'',at:new Date().toISOString()}]);
          }
          catch{/* a conversation that cannot be read now is retried by a later search */}
        }
      })().catch(()=>undefined).finally(()=>{backfill=undefined;});
    }
    return{query,hits,pending};
  });
  app.get<{Params:{id:string};Querystring:{path:string}}>('/api/projects/:id/file',async(request)=>workspace.preview(store.getProject(request.params.id),requireString(request.query.path,'path',8192),{allowOutside:allowOutsideRead(request.headers)}));
  app.get<{Params:{id:string};Querystring:{path:string}}>('/api/projects/:id/file/image',async(request,reply)=>{
    const harnessImageHomes=nativeBackends.catalog.profileSettings('dsh').profiles.map(profile=>profile.configDir?.trim()?path.resolve(profile.configDir.trim()):DEFAULT_DSH_CONFIG_DIR);
    const {mimeType,data}=await workspace.readPreviewImage(store.getProject(request.params.id),requireString(request.query.path,'path',8192),{allowOutside:allowOutsideRead(request.headers),harnessImageHomes});
    reply.header('Content-Type',mimeType).header('Content-Disposition','inline').header('X-Content-Type-Options','nosniff');
    // SVG is inert as an image, but a direct document navigation must remain isolated too.
    if(mimeType==='image/svg+xml')reply.header('Content-Security-Policy',"sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'");
    return reply.send(data);
  });
  app.get<{Params:{id:string};Querystring:{path:string;download?:string;render?:string} & PreviewQuery}>('/api/projects/:id/file/raw',async(request,reply)=>{
    const file=await workspace.rawFile(store.getProject(request.params.id),requireString(request.query.path,'path',8192),{allowOutside:allowOutsideRead(request.headers)});
    if(request.query.render==='preview'&&request.query.download!=='1'){
      const data=await readFileBounded(file.path,MAX_PREVIEW_FILE_BYTES);
      const page=await renderFilePreview(data,file.name,request.query,async source=>{
        if(/^attachment:[a-f0-9-]{36}$/i.test(source))return previewImageData((await workspace.readAttachment(source.slice('attachment:'.length))).data);
        const relative=decodeURIComponent(source.split(/[?#]/,1)[0]!);
        return workspace.readPreviewImage(store.getProject(request.params.id),path.resolve(path.dirname(file.path),relative),{allowOutside:allowOutsideRead(request.headers)});
      });
      return reply.type('text/html; charset=utf-8').header('Content-Security-Policy',page.csp)
        .header('Referrer-Policy','no-referrer').header('X-Content-Type-Options','nosniff').header('Cache-Control','no-store').send(page.html);
    }
    if(request.query.render==='visualize'&&request.query.download!=='1'){
      if(!file.contentType.startsWith('text/html'))throw new AppError('INVALID_VISUALIZATION','A visualization preview must be an HTML file',415,undefined,{ subject: 'file' });
      const source=(await readFileBounded(file.path,MAX_VISUALIZATION_BYTES)).toString('utf8');
      return reply.type('text/html; charset=utf-8').header('Content-Security-Policy',VISUALIZATION_CSP)
        .header('Referrer-Policy','no-referrer').header('X-Content-Type-Options','nosniff').header('Cache-Control','no-store')
        .send(await renderVisualization(source,file.name,request.query.scheme));
    }
    const attachment=request.query.download==='1'||!file.inline;
    reply.header('Content-Type',file.contentType).header('Content-Length',String(file.size)).header('Last-Modified',file.mtime.toUTCString())
      .header('Cache-Control','private, no-cache').header('X-Content-Type-Options','nosniff')
      .header('Content-Disposition',contentDisposition(attachment?'attachment':'inline',file.name));
    // An opened file runs in an opaque origin, away from the app's session. Chrome will not render
    // a PDF in a sandbox, and its viewer is isolated already.
    if(!file.contentType.startsWith('application/pdf'))reply.header('Content-Security-Policy','sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads');
    return reply.send(createReadStream(file.path));
  });
  app.get<{Params:{id:string};Querystring:{path?:string;check?:string}}>('/api/projects/:id/archive',async(request,reply)=>{
    const archive=await workspace.archive(store.getProject(request.params.id),request.query.path??'');
    if(request.query.check==='1')return {name:archive.name,files:archive.files,bytes:archive.bytes};
    reply.header('Content-Type','application/zip').header('Cache-Control','no-store').header('Content-Disposition',contentDisposition('attachment',archive.name));
    return reply.send(archive.stream());
  });
  app.post<{Params:{id:string};Body:{path:string;line?:number}}>('/api/projects/:id/open',async(request)=>workspace.openInEditor(store.getProject(request.params.id),requireString(request.body?.path,'path',8192),request.body.line,settings.getSettings().editorCommand,{allowOutside:allowOutsideRead(request.headers)}));
  app.get<{Params:{id:string}}>('/api/projects/:id/reveal',async(request)=>{
    store.getProject(request.params.id);
    return {supported:process.platform==='darwin'&&localFileActions(request)};
  });
  app.post<{Params:{id:string};Body:{path:string}}>('/api/projects/:id/reveal',async(request)=>{
    if(!localFileActions(request))throw new AppError('LOCAL_ACCESS_ONLY','Finder actions only accept direct local connections',403);
    return workspace.revealInFinder(store.getProject(request.params.id),requireString(request.body?.path,'path',8192),{allowOutside:allowOutsideRead(request.headers)});
  });
  app.post<{Params:{id:string};Body:{name:string;mimeType:string;dataBase64:string;width?:number;height?:number}}>('/api/projects/:id/attachments',async(request)=>workspace.upload(store.getProject(request.params.id),request.body));
  app.post<{Body:{name:string;mimeType:string;dataBase64:string;width?:number;height?:number}}>('/api/attachments',async(request)=>workspace.upload(undefined,request.body));
  app.get<{Params:{id:string}}>('/api/attachments/:id/metadata',async(request)=>workspace.readAttachmentMetadata(request.params.id));
  app.get<{Params:{id:string};Querystring:{render?:string} & PreviewQuery}>('/api/attachments/:id',async(request,reply)=>{
    const {attachment,data}=await workspace.readAttachment(request.params.id);
    if(request.query.render==='preview'){
      const page=await renderFilePreview(data,attachment.name,request.query,async source=>{
        if(!/^attachment:[a-f0-9-]{36}$/i.test(source))throw new AppError('INVALID_PATH','Attachment image references require an attachment id',400);
        return previewImageData((await workspace.readAttachment(source.slice('attachment:'.length))).data);
      });
      return reply.type('text/html; charset=utf-8').header('Content-Security-Policy',page.csp)
        .header('Referrer-Policy','no-referrer').header('X-Content-Type-Options','nosniff').header('Cache-Control','no-store').send(page.html);
    }
    const inlineImage=/^image\/(?:png|jpeg|gif|webp|avif|bmp)$/i.test(attachment.mimeType);
    reply.header('Content-Type',attachment.mimeType).header('Content-Length',String(data.length)).header('X-Content-Type-Options','nosniff')
      .header('Content-Disposition',`${inlineImage?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`);
    return reply.send(data);
  });
}
/** Conversations read to fill the search index in one request, so a search stays responsive. */
const SEARCH_BACKFILL_BATCH = 6;
