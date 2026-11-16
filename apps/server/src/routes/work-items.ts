import type { FastifyInstance } from 'fastify';
import type { AssistantInstructions, AssistantMemory, SessionWorkItemRequest, WorkItemAnswer, WorkItemBrief, WorkItemCreate, WorkItemList, WorkItemPatch, WorkItemRework } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { projectVisibleToClient, requireSessionVisibleToClient } from '../native/client-features.js';
import { readAssistantMemory } from '../assistant/home.js';
import { assistantInstructionsFile, assistantProject } from '../work-items/index.js';
import { revisionedList } from './params.js';
import type { RouteDeps } from './deps.js';

/** Tasks (docs/TASK-BOARD.md). The list is served under the work items revision; `/api/lists/stream` carries it as `workItems`. */
export function registerWorkItemRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const {store,workItems}=deps;
  app.get('/api/work-items',async(request,reply)=>revisionedList<WorkItemList>(request,reply,store.workItemsRevision,()=>{
    const projects=new Map(store.listProjects().map(project=>[project.id,project]));
    return {items:workItems.list().filter(item=>{const project=item.projectId?projects.get(item.projectId):undefined;return !project||projectVisibleToClient(request.headers,project);})};
  }));
  app.post<{Body:WorkItemCreate}>('/api/work-items',async(request)=>workItems.create(request.body));
  app.patch<{Params:{id:string};Body:WorkItemPatch}>('/api/work-items/:id',async(request)=>workItems.patch(request.params.id,request.body));
  app.delete<{Params:{id:string}}>('/api/work-items/:id',async(request,reply)=>{workItems.delete(request.params.id);reply.code(204);});
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
