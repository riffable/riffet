import type { FastifyInstance } from 'fastify';
import { ASSISTANT_BUDGET } from '../../../../packages/contracts/src/index.js';
import type { AssistantDelegation, AssistantFile, AssistantPack, AssistantRunUsage, AssistantInstructions, AssistantMemory, SessionWorkItemRequest, WorkItemAnswer, WorkItemBrief, WorkItemCreate, WorkItemList, WorkItemPatch, WorkItemRework } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { projectVisibleToClient, requireSessionVisibleToClient } from '../native/client-features.js';
import { createReadStream, constants, openSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { assistantFilePath, forgetAssistantMemory, listAssistantFiles, readAssistantMemory } from '../assistant/home.js';
import { addAssistantPack, listAssistantPacks, removeAssistantPack } from '../assistant/packs.js';
import { assistantInstructionsFile, assistantProject } from '../work-items/index.js';
import { revisionedList } from './params.js';
import type { RouteDeps } from './deps.js';

/** Tasks (docs/TASK-BOARD.md). The list is served under the work items revision; `/api/lists/stream` carries it as `workItems`. */
export function registerWorkItemRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const {store,workItems}=deps;
  const endLinkedDelegation = (delegationId: string | undefined) => {
    if (!delegationId) return;
    try { deps.assistantDelegations?.()?.end(delegationId, 'owner'); } catch { /* absent, already ended, or starting */ }
  };
  app.get('/api/work-items',async(request,reply)=>revisionedList<WorkItemList>(request,reply,store.workItemsRevision,()=>{
    const projects=new Map(store.listProjects().map(project=>[project.id,project]));
    return {items:workItems.list().filter(item=>{const project=item.projectId?projects.get(item.projectId):undefined;return !project||projectVisibleToClient(request.headers,project);})};
  }));
  app.post<{Body:WorkItemCreate}>('/api/work-items',async(request)=>workItems.create(request.body));
  app.patch<{Params:{id:string};Body:WorkItemPatch}>('/api/work-items/:id',async(request)=>{
    const before=workItems.get(request.params.id);
    const updated=workItems.patch(request.params.id,request.body);
    if(before.watch?.delegationId&&before.watch.delegationId!==updated.watch?.delegationId)endLinkedDelegation(before.watch.delegationId);
    return updated;
  });
  app.delete<{Params:{id:string}}>('/api/work-items/:id',async(request,reply)=>{
    const before=workItems.get(request.params.id);
    workItems.delete(request.params.id);
    endLinkedDelegation(before.watch?.delegationId);
    reply.code(204);
  });
  app.get<{Params:{id:string}}>('/api/work-items/:id/events',async(request)=>workItems.events(request.params.id));
  app.post<{Params:{id:string};Body:{text?:unknown;id?:unknown}}>('/api/work-items/:id/comments',async(request)=>workItems.addComment(request.params.id,request.body?.text,request.body?.id));
  app.get<{Querystring:{from?:string;to?:string;tz?:string}}>('/api/work-items/north-star',async(request)=>{
    const to=Date.parse(request.query.to??'')||Date.now();
    const from=Date.parse(request.query.from??'')||to-14*86_400_000;
    if(from>=to)throw new AppError('INVALID_RANGE','from must be before to');
    return workItems.northStar(from,to,typeof request.query.tz==='string'&&request.query.tz.length<=64?request.query.tz:'UTC');
  });
  app.get<{Params:{id:string}}>('/api/work-items/:id/brief',async(request):Promise<WorkItemBrief>=>({text:workItems.brief(request.params.id)}));
  app.post<{Params:{id:string;questionId:string};Body:Partial<WorkItemAnswer>}>('/api/work-items/:id/questions/:questionId/answer',async(request)=>workItems.answer(request.params.id,request.params.questionId,request.body?.text,request.body?.commandId));
  /** 开始 done by the server, as the 助理 does it; the board starts a task from the client (docs/TASK-BOARD.md §5). */
  app.post<{Params:{id:string}}>('/api/work-items/:id/start',async(request)=>workItems.start(request.params.id));
  // The 助理's AGENTS.md; a new conversation reads it, one already running keeps what it read.
  app.get('/api/assistant/instructions',async():Promise<AssistantInstructions>=>assistantInstructionsFile(store,deps.stateDir));
  app.put<{Body:{text?:unknown}}>('/api/assistant/instructions',async(request):Promise<AssistantInstructions>=>{
    const text=request.body?.text;
    if(text!==null&&typeof text!=='string')throw new AppError('INVALID_ARGUMENT','text must be text or null');
    return assistantInstructionsFile(store,deps.stateDir,text);
  });
  // What the 助理 remembers, read-only: the owner changes it by telling the 助理 (docs/ASSISTANT.md §3.2).
  app.get('/api/assistant/memory',async():Promise<AssistantMemory>=>readAssistantMemory(assistantProject(store,deps.stateDir).cwd));
  // The owner forgets one topic; anything else they tell the 助理.
  app.delete<{Params:{name:string}}>('/api/assistant/memory/:name',async(request,reply)=>{
    try{await forgetAssistantMemory(assistantProject(store,deps.stateDir).cwd,request.params.name);}
    catch(error){if((error as {code?:string}).code==='MEMORY_NOT_FOUND')throw new AppError('MEMORY_NOT_FOUND','No such memory',404);throw error;}
    reply.code(204);
  });
  // What the 助理 made for the owner: read-only, and only inside its files folder.
  // Capability packs (docs/ASSISTANT.md §8.2): the main conversation's CLI picks a change up when it next rests.
  const assistantCwd=()=>assistantProject(store,deps.stateDir).cwd;
  app.get('/api/assistant/packs',async():Promise<{packs:AssistantPack[]}>=>({packs:listAssistantPacks(assistantCwd())}));
  app.put<{Params:{id:string}}>('/api/assistant/packs/:id',async(request):Promise<{packs:AssistantPack[]}>=>{const packs=await addAssistantPack(assistantCwd(),request.params.id);deps.restartAssistant?.();return {packs};});
  app.delete<{Params:{id:string}}>('/api/assistant/packs/:id',async(request):Promise<{packs:AssistantPack[]}>=>{const packs=await removeAssistantPack(assistantCwd(),request.params.id);deps.restartAssistant?.();return {packs};});
  app.get('/api/assistant/files',async():Promise<{files:AssistantFile[]}>=>({files:listAssistantFiles(assistantProject(store,deps.stateDir).cwd)}));
  app.get<{Querystring:{path?:string}}>('/api/assistant/file',async(request,reply)=>{
    const path=typeof request.query.path==='string'?request.query.path:'';
    const file=path&&path.length<=1024?assistantFilePath(assistantProject(store,deps.stateDir).cwd,path):undefined;
    if(!file)throw new AppError('FILE_NOT_FOUND','No such file',404);
    const size=(await stat(file)).size;
    if(size>ASSISTANT_BUDGET.servedFileBytes)throw new AppError('FILE_TOO_LARGE','This file is too large to download here',413);
    const name=basename(file);
    reply.header('Content-Type','application/octet-stream').header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(name)}`).header('X-Content-Type-Options','nosniff').header('Cache-Control','no-store');
    // A link put in its place after the listing is not followed.
    return reply.send(createReadStream(file,{fd:openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW)}));
  });
  // What the 助理 follows over time (docs/ASSISTANT.md §7.3): the owner reads and ends them; the 助理 makes them.
  const delegations=()=>deps.assistantDelegations?.()??(()=>{throw new AppError('SERVICE_STARTING','The workbench is starting',503);})();
  app.get('/api/assistant/runs/usage',async():Promise<AssistantRunUsage>=>(deps.assistantRuns?.()??(()=>{throw new AppError('SERVICE_STARTING','The workbench is starting',503);})()).usage());
  app.get('/api/assistant/delegations',async():Promise<{delegations:AssistantDelegation[]}>=>({delegations:delegations().list()}));
  app.post<{Params:{id:string}}>('/api/assistant/delegations/:id/end',async(request):Promise<AssistantDelegation>=>{
    const ended=delegations().end(request.params.id,'owner');
    for(const item of workItems.list()){
      if(item.watch?.delegationId===ended.id){
        const {delegationId:_id,...rest}=item.watch;
        workItems.patch(item.id,{watch:Object.keys(rest).length?rest:null});
      }
    }
    return ended;
  });
  app.post<{Params:{id:string};Body:{goal?:unknown;attention?:unknown;trigger?:unknown;until?:unknown;note?:unknown}}>('/api/work-items/:id/watch-delegation',async(request)=>{
    const item=workItems.get(request.params.id);
    const body=request.body??{};
    const attention=typeof body.attention==='string'&&body.attention.trim()?body.attention.trim():item.watch?.note??item.title;
    const goal=typeof body.goal==='string'&&body.goal.trim()?body.goal.trim():`#${item.number} ${item.title}`;
    const delegation=delegations().create({goal,attention,trigger:body.trigger,...(body.until!==undefined?{until:body.until}:{})});
    const prevDelegation=item.watch?.delegationId;
    const note=typeof body.note==='string'&&body.note.trim()?body.note.trim():item.watch?.note??attention;
    const updated=workItems.patch(item.id,{
      status:'watching',
      watch:{...(item.watch?.until?{until:item.watch.until}:{}),note,delegationId:delegation.id},
    });
    if(prevDelegation&&prevDelegation!==delegation.id)endLinkedDelegation(prevDelegation);
    return {item:updated,delegation};
  });
  app.post<{Params:{id:string};Body:Partial<WorkItemRework>}>('/api/work-items/:id/rework',async(request)=>workItems.rework(request.params.id,request.body?.text,request.body?.commandId));
  app.post<{Params:{id:string};Body:SessionWorkItemRequest}>('/api/sessions/:id/work-item',async(request)=>{
    const session=store.getSession(request.params.id);
    requireSessionVisibleToClient(request.headers,session,id=>store.getProject(id));
    const project=store.listProjects().find(item=>item.id===session.projectId);
    if(project?.system==='quick-chat'||session.backendId==='chat')throw new AppError('WORK_ITEM_UNSUPPORTED','A quick chat cannot belong to a task',409);
    if(project?.system==='assistant')throw new AppError('WORK_ITEM_UNSUPPORTED','The assistant\'s conversations cannot belong to a task',409);
    const target=request.body?.workItemId;
    if(target!==null&&(typeof target!=='string'||!target||target.length>100))throw new AppError('INVALID_WORK_ITEM','workItemId must be a task id, "new" or null');
    return store.transaction(()=>{
      const workItem=target==='new'?workItems.createFromSession(session,project&&!project.system?project.id:undefined):workItems.attachSession(session.id,target??undefined);
      return {session:store.getSession(session.id),...(workItem?{workItem}:{})};
    });
  });
}
