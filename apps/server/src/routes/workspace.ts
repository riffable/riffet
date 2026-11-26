import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';
import { AppError, requireString } from '../errors.js';
import { isLoopbackHost } from '../connection-addresses.js';
import { FILE_SITE_ROUTE, proxiedRequest } from '../auth.js';
import { codexGeneratedImageHomes, defaultDshConfigDir } from '../compat.js';
import path from 'node:path';
import { CODE_INDEX_BUDGET } from '../../../../packages/contracts/src/budgets.js';
import { previewImageData, readFileBounded } from '../workspace/index.js';
import { MAX_VISUALIZATION_BYTES, renderVisualization, VISUALIZATION_CSP } from '../visualization.js';
import { contentDisposition } from '../workspace/download.js';
import { mediaPreviewPage, renderFilePreview } from '../previews/index.js';
import { MAX_PREVIEW_FILE_BYTES, previewKind } from '../previews/formats.js';
import type { PreviewQuery } from '../previews/document.js';
import { EMPTY_INDEX_MARKER, extractIndexable, likePattern, normalizeQuery, snippet } from '../search/messages.js';
import { mergeMessageHits } from '../search/merge.js';
import { sequence, pageSize } from './params.js';
import type { RouteDeps } from './deps.js';
import { sendsQuickChat } from '../chat/quick-chat.js';
import { backendVisibleToClient, clientSupportsFeature, hiddenBackendIds, hidesPluginAgents } from '../native/client-features.js';

export function registerWorkspaceRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const {store,settings,workspace,nativeBackends,allowOutsideRead,auth}=deps;
  const localFileActions = (request: FastifyRequest) => isLoopbackHost(request.ip) && !proxiedRequest(request.headers);
  let backfill:Promise<void>|undefined;
  app.get<{Params:{id:string};Querystring:{path?:string;limit?:string;offset?:string;cursor?:string}}>('/api/projects/:id/files',async(request)=>workspace.files(store.getProject(request.params.id),{path:request.query.path,limit:pageSize(request.query.limit),offset:sequence(request.query.offset),cursor:request.query.cursor}));
  app.get<{Params:{id:string};Querystring:{q?:string;limit?:string;offset?:string}}>('/api/projects/:id/find',async(request)=>workspace.find(store.getProject(request.params.id),{q:request.query.q??'',limit:pageSize(request.query.limit),offset:sequence(request.query.offset)}));
  /** Aborted when the client goes away before the answer, so its ripgrep scans stop with it. */
  const untilGone = (reply: FastifyReply) => { const controller = new AbortController(); reply.raw.once('close', () => { if (!reply.raw.writableFinished) controller.abort(); }); return controller.signal; };
  // Bare hits by default; `detail=1` answers `SearchResults` (`more`, `incomplete`) for clients that must tell "no more" from "stopped".
  const flag=(value?:string)=>value==='1'||value==='true';
  app.get<{Params:{id:string};Querystring:{q?:string;limit?:string;offset?:string;path?:string;case?:string;word?:string;regex?:string;include?:string;exclude?:string;detail?:string}}>('/api/projects/:id/search',async(request,reply)=>{
    const {query}=request;
    const result=await workspace.search(store.getProject(request.params.id),{q:requireString(query.q,'q',500),limit:pageSize(query.limit),offset:sequence(query.offset),...(query.path?{path:requireString(query.path,'path',8192)}:{}),caseSensitive:flag(query.case),word:flag(query.word),regex:flag(query.regex),include:query.include?.slice(0,2000),exclude:query.exclude?.slice(0,2000)},untilGone(reply));
    return flag(query.detail)?result:result.hits;
  });
  app.get<{Params:{id:string};Querystring:{path?:string;line?:string;column?:string;word?:string}}>('/api/projects/:id/code/definition',async(request,reply)=>workspace.definition(store.getProject(request.params.id),{path:requireString(request.query.path,'path',8192),line:Number(request.query.line),column:Number(request.query.column),word:requireString(request.query.word,'word',200)},untilGone(reply)));
  app.get<{Params:{id:string};Querystring:{q?:string;types?:string;limit?:string}}>('/api/projects/:id/code/symbols',async(request)=>workspace.symbolSearch(store.getProject(request.params.id),request.query.q===undefined?'':requireString(request.query.q,'q',200),{types:request.query.types==='1'||request.query.types==='true',limit:Math.min(CODE_INDEX_BUDGET.maxSearchResults,Math.max(1,Math.floor(Number(request.query.limit))||CODE_INDEX_BUDGET.searchResults))}));
  app.get<{Params:{id:string};Querystring:{path?:string}}>('/api/projects/:id/code/outline',async(request)=>workspace.outline(store.getProject(request.params.id),requireString(request.query.path,'path',8192)));
  app.get<{Params:{id:string}}>('/api/projects/:id/code/index',async(request)=>workspace.codeIndexStatus(store.getProject(request.params.id)));
  app.post<{Params:{id:string}}>('/api/projects/:id/code/index',async(request)=>workspace.rebuildCodeIndex(store.getProject(request.params.id)));
  app.post<{Params:{id:string};Body:{lease?:unknown;watching?:unknown}}>('/api/projects/:id/code/index/watch',async(request)=>workspace.watchCodeIndex(store.getProject(request.params.id),requireString(request.body?.lease,'lease',64),request.body?.watching!==false));
  app.get<{Params:{id:string}}>('/api/projects/:id/code/modules',async(request)=>workspace.codeModules(store.getProject(request.params.id)));
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
    const harnessImageHomes=nativeBackends.catalog.profileSettings('dsh').profiles.map(profile=>profile.configDir?.trim()?path.resolve(profile.configDir.trim()):defaultDshConfigDir());
    const generatedImageHomes=codexGeneratedImageHomes(nativeBackends.catalog.profileSettings('codex')?.profiles??[]);
    const {mimeType,data}=await workspace.readPreviewImage(store.getProject(request.params.id),requireString(request.query.path,'path',8192),{allowOutside:allowOutsideRead(request.headers),harnessImageHomes,generatedImageHomes});
    reply.header('Content-Type',mimeType).header('Content-Disposition','inline').header('X-Content-Type-Options','nosniff');
    // SVG is inert as an image, but a direct document navigation must remain isolated too.
    if(mimeType==='image/svg+xml')reply.header('Content-Security-Policy',"sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'");
    return reply.send(data);
  });
  app.get<{Params:{id:string};Querystring:{path:string;download?:string;render?:string;page?:string} & PreviewQuery}>('/api/projects/:id/file/raw',async(request,reply)=>{
    const file=await workspace.rawFile(store.getProject(request.params.id),requireString(request.query.path,'path',8192),{allowOutside:allowOutsideRead(request.headers)});
    if(request.query.render==='preview'&&request.query.download!=='1'&&previewKind(file.name)==='media'){
      // Streamed through a file-site address: the player runs in an opaque origin without the session cookie.
      const token=auth.issueFileSite(request,{projectId:request.params.id,root:path.dirname(file.path),only:file.name});
      const page=mediaPreviewPage(file.name,`../../../file-sites/${token}/${encodeURIComponent(file.name)}`,request.query);
      return reply.type('text/html; charset=utf-8').header('Content-Security-Policy',page.csp)
        .header('Referrer-Policy','no-referrer').header('X-Content-Type-Options','nosniff').header('Cache-Control','no-store').send(page.html);
    }
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
    if(request.query.render==='site'&&request.query.download!=='1'){
      if(!file.contentType.startsWith('text/html'))throw new AppError('INVALID_SITE','A page preview must be an HTML file',415,undefined,{ subject: 'file' });
      // `page` reopens another page of the same site, so the root stays the folder of the file first opened.
      const page=request.query.page===undefined?file.name:requireString(request.query.page,'page',8192);
      if(page.includes('\0')||page.split('/').some(part=>!part||part==='.'||part==='..'))throw new AppError('INVALID_PATH','page must be a path inside the page\'s folder');
      const token=auth.issueFileSite(request,{projectId:request.params.id,...await workspace.siteScope(store.getProject(request.params.id),file.path)});
      // Relative to `/api/projects/:id/file/raw`, so a deployment prefix carries over.
      return reply.redirect(`../../../file-sites/${token}/${page.split('/').map(encodeURIComponent).join('/')}`,302);
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
    if(!file.contentType.startsWith('application/pdf'))reply.header('Content-Security-Policy',`sandbox ${FILE_SITE_SANDBOX}`);
    return sendFile(request,reply,file);
  });
  // A previewed page and the files its links name. Visibility was checked when the token was minted
  // under `/api/projects/:id`; the page's requests cannot carry the client's feature declaration.
  app.get<{Params:{'*':string}}>(FILE_SITE_ROUTE,async(request,reply)=>{
    const split=request.params['*'].indexOf('/');
    const relative=split>0?request.params['*'].slice(split+1):request.params['*'];
    // Opaque-origin fetches and module scripts are CORS requests; they carry no credentials.
    reply.header('Access-Control-Allow-Origin','*').header('Content-Security-Policy',`sandbox ${FILE_SITE_SANDBOX}; frame-ancestors 'self'`);
    try{
      const scope=split>0?auth.fileSite(request.params['*'].slice(0,split)):undefined;
      if(!scope)throw new AppError('UNAUTHENTICATED','This preview has expired; reopen the file',401);
      const file=await workspace.siteFile(store.getProject(scope.projectId),scope.root,relative,{allowOutside:allowOutsideRead(request.headers),only:scope.only});
      // Revalidated rather than refetched: a page's shared assets come back on every link followed.
      const etag=`W/"${file.size.toString(36)}-${Math.floor(file.mtime.getTime()).toString(36)}"`;
      reply.header('Cache-Control','private, no-cache').header('ETag',etag).header('Last-Modified',file.mtime.toUTCString());
      if(request.headers['if-none-match']===etag)return reply.code(304).send();
      reply.header('Content-Type',file.contentType).header('Content-Disposition',contentDisposition(file.inline?'inline':'attachment',file.name));
      if(file.contentType.startsWith('text/html')&&file.size<=MAX_PREVIEW_FILE_BYTES)
        return reply.send(reportsLocation((await readFileBounded(file.path,MAX_PREVIEW_FILE_BYTES)).toString('utf8')));
      return sendFile(request,reply,file);
    }catch(error){
      // A link followed inside the preview gets a page rather than a JSON envelope; an expired one
      // tells the panel, which opens the same page again under a fresh token.
      const page=['document','iframe'].includes(String(request.headers['sec-fetch-dest']));
      if(!page||!(error instanceof AppError))throw error;
      return reply.code(error.statusCode).type('text/html; charset=utf-8').send(sitePageError(error.statusCode,relative));
    }
  });
  app.get<{Params:{id:string};Querystring:{path?:string;check?:string}}>('/api/projects/:id/archive',async(request,reply)=>{
    const archive=await workspace.archive(store.getProject(request.params.id),request.query.path??'');
    if(request.query.check==='1')return {name:archive.name,files:archive.files,bytes:archive.bytes};
    reply.header('Content-Type','application/zip').header('Cache-Control','no-store').header('Content-Disposition',contentDisposition('attachment',archive.name));
    return reply.send(archive.stream());
  });
  app.post<{Params:{id:string};Body:{path:string;line?:number}}>('/api/projects/:id/open',async(request)=>workspace.openInEditor(store.getProject(request.params.id),requireString(request.body?.path,'path',8192),request.body.line,settings.getSettings().editorCommand,{allowOutside:allowOutsideRead(request.headers)}));
  // Changes to project files (`workspace/write.ts`); a save names the version it was edited from.
  app.put<{Params:{id:string};Body:{path:string;content:string;expectedHash:string}}>('/api/projects/:id/file',async(request)=>workspace.writes.save(store.getProject(request.params.id),{path:requireString(request.body?.path,'path',8192),content:request.body.content,expectedHash:requireString(request.body.expectedHash,'expectedHash',128)}));
  app.post<{Params:{id:string};Body:{path:string;kind:'file'|'directory'}}>('/api/projects/:id/file/create',async(request)=>workspace.writes.create(store.getProject(request.params.id),{path:requireString(request.body?.path,'path',8192),kind:request.body.kind}));
  app.post<{Params:{id:string};Body:{from:string;to:string}}>('/api/projects/:id/file/move',async(request)=>workspace.writes.move(store.getProject(request.params.id),{from:requireString(request.body?.from,'from',8192),to:requireString(request.body.to,'to',8192)}));
  app.post<{Params:{id:string};Body:{path:string;permanent?:boolean}}>('/api/projects/:id/file/delete',async(request)=>workspace.writes.remove(store.getProject(request.params.id),{path:requireString(request.body?.path,'path',8192),permanent:request.body.permanent===true}));
  app.post<{Params:{id:string};Body:{restoreId:string}}>('/api/projects/:id/file/restore',async(request)=>workspace.writes.restore(store.getProject(request.params.id),requireString(request.body?.restoreId,'restoreId',64)));
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
/**
 * The file's bytes, or the one range a player or viewer asks for (RFC 9110 §14). AVPlayer will not
 * play a file it cannot seek, and a browser's player only seeks within what it has downloaded unless
 * the server answers ranges. Several ranges in one request are answered with the whole file, which
 * the RFC allows; no client here asks for them.
 */
function sendFile(request: FastifyRequest, reply: FastifyReply, file: { path: string; size: number; mtime: Date }) {
  reply.header('Accept-Ranges','bytes');
  const range=byteRange(request.headers.range,file.size);
  // `If-Range` names the version the client holds; a file changed since gets the whole new file. Only a
  // strong validator matches (§13.1.5): a weak ETag never does.
  const ifRange=request.headers['if-range'];
  const etag=reply.getHeader('etag');
  const current=ifRange===undefined||ifRange===file.mtime.toUTCString()||(typeof etag==='string'&&!etag.startsWith('W/')&&ifRange===etag);
  if(range==='unsatisfiable'&&current)return reply.code(416).header('Content-Range',`bytes */${file.size}`).send();
  // Bounded at the size sent in `Content-Length`: a file still being written must not run past it.
  if(!range||range==='unsatisfiable'||!current)return reply.header('Content-Length',String(file.size)).send(file.size?createReadStream(file.path,{start:0,end:file.size-1}):'');
  return reply.code(206).header('Content-Range',`bytes ${range.start}-${range.end}/${file.size}`).header('Content-Length',String(range.end-range.start+1))
    .send(createReadStream(file.path,{start:range.start,end:range.end}));
}
/** A single `bytes=` range resolved against the size; anything else is ignored and the whole file sent. */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | undefined {
  const match=/^bytes=(\d*)-(\d*)$/.exec(header?.trim()??'');
  if(!match||(!match[1]&&!match[2]))return undefined;
  if(!match[1]){
    const suffix=Number(match[2]);
    if(!suffix||!size)return 'unsatisfiable';
    return {start:Math.max(0,size-suffix),end:size-1};
  }
  const start=Number(match[1]);
  if(start>=size)return 'unsatisfiable';
  const end=match[2]?Math.min(Number(match[2]),size-1):size-1;
  return end<start?undefined:{start,end};
}
/** What an opened or previewed file may do: run in an opaque origin, away from the app's session. */
const FILE_SITE_SANDBOX='allow-scripts allow-popups allow-forms allow-modals allow-downloads';
/**
 * Tells the embedding panel which page the preview now shows. The script goes inside `<head>` (or
 * after the doctype), so it never switches the page into quirks mode and runs before a page CSP.
 */
function reportsLocation(html: string, status = 200): string {
  const script=`<script>try{if(parent!==window)parent.postMessage({type:"riffet-file-site",path:location.pathname,status:${status}},"*")}catch(e){}</script>`;
  const anchor=/<head(?:\s[^>]*)?>/i.exec(html)??/<html(?:\s[^>]*)?>/i.exec(html)??/<!doctype[^>]*>/i.exec(html);
  if(!anchor)return script+html;
  const at=anchor.index+anchor[0].length;
  return html.slice(0,at)+script+html.slice(at);
}
/** The status and the path asked for, in place of the page; the panel header already names the folder. */
function sitePageError(status: number, relative: string): string {
  const escaped=relative.replace(/[&<>"]/g,character=>`&#${character.charCodeAt(0)};`);
  return reportsLocation(`<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;color:GrayText}</style></head><body>${status} · ${escaped}</body></html>`,status);
}
/** Conversations read to fill the search index in one request, so a search stays responsive. */
const SEARCH_BACKFILL_BATCH = 6;
