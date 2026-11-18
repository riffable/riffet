import { clientSupportsFeature, requireProjectVisibleToClient } from '../native/client-features.js';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { API, type MarkListQuery } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { MAX_ASSET_BYTES, MarkStore } from '../marks.js';
import { pageSize, revisionedList } from './params.js';
import type { RouteDeps } from './deps.js';

/**
 * Saved replies (收藏). The list is served under the marks revision like the session list is under
 * the list revision; `/api/lists/stream` carries it as `marks`, so a client re-reads on a change.
 */
export function registerMarkRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const {store,nativeBackends,stateDir}=deps;
  const marks=new MarkStore(store,join(stateDir,'marks'));
  const visibleMark = (headers: import('node:http').IncomingHttpHeaders, id: string) => {
    const mark=marks.get(id);
    // Orphaned marks remain readable after a normal project is removed.
    const project=store.listProjects().find(item=>item.id===mark.projectId);
    if(project)requireProjectVisibleToClient(headers,project);
    return mark;
  };
  const removableMark = (headers: import('node:http').IncomingHttpHeaders, id: string) => {
    try { visibleMark(headers,id); }
    catch(error) { if(!(error instanceof AppError)||error.code!=='MARK_NOT_FOUND')throw error; }
  };
  app.get<{Querystring:{[K in keyof MarkListQuery]?:string}}>(API.marks,async(request,reply)=>
    revisionedList(request,reply,store.marksRevision,()=>marks.list(request.query,request.query.limit===undefined?50:pageSize(request.query.limit),!clientSupportsFeature(request.headers,'projectless-tasks'))));
  app.get(`${API.marks}/facets`,async(request,reply)=>
    revisionedList(request,reply,store.marksRevision,()=>marks.facets(!clientSupportsFeature(request.headers,'projectless-tasks'))));
  // A saved image arrives inline, base64: room for the largest one plus its JSON.
  app.post<{Body:unknown}>(API.marks,{bodyLimit:Math.ceil(MAX_ASSET_BYTES*4/3)+64*1024},async(request)=>marks.create(request.body));
  /** A saved image's kept copy. A mark's image never changes, so it caches for good. */
  app.get<{Params:{id:string}}>(`${API.marks}/:id/asset`,async(request,reply)=>{
    const mark=visibleMark(request.headers,request.params.id),file=marks.assetFile(mark.id);
    if(!mark.asset?.stored||!file||!existsSync(file))throw new AppError('MARK_ASSET_NOT_FOUND','This saved image is not kept',404);
    reply.header('cache-control','private, max-age=31536000, immutable').header('x-content-type-options','nosniff').type(mark.asset.mimeType??'application/octet-stream');
    return reply.send(createReadStream(file));
  });
  app.post<{Body:{ids?:unknown}}>(`${API.marks}/delete`,async(request)=>{
    const ids=request.body?.ids;
    if(!Array.isArray(ids)||ids.length>500||ids.some(id=>typeof id!=='string'||!id||id.length>100))throw new AppError('INVALID_MARK_IDS','ids must list at most 500 saved replies');
    for (const id of ids as string[]) removableMark(request.headers,id);
    return {deleted:marks.remove(ids as string[])};
  });
  app.patch<{Params:{id:string};Body:unknown}>(`${API.marks}/:id`,async(request)=>{visibleMark(request.headers,request.params.id);return marks.update(request.params.id,request.body);});
  app.delete<{Params:{id:string}}>(`${API.marks}/:id`,async(request,reply)=>{removableMark(request.headers,request.params.id);marks.remove([request.params.id]);reply.code(204);});
  app.get<{Params:{id:string}}>(`${API.marks}/:id/prompt`,async(request)=>{visibleMark(request.headers,request.params.id);return marks.prompt(request.params.id);});
  // Only a pure read of a provider's stored transcript: locating a mark must never start an agent.
  app.get<{Params:{id:string}}>(`${API.marks}/:id/locate`,async(request)=>{visibleMark(request.headers,request.params.id);return marks.locate(request.params.id,sessionId=>nativeBackends.indexableTranscript(sessionId));});
}
