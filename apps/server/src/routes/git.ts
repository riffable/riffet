import type { FastifyInstance, FastifyReply } from 'fastify';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError, requireString } from '../errors.js';
import { generatedBranch } from '../git/index.js';
import { isWithin } from '../workspace/scope.js';
import { paths } from './params.js';
import type { RouteDeps } from './deps.js';
import type { GitLineChange } from '../../../../packages/contracts/src/index.js';

export function registerGitRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const {store,git}=deps;
  const untilGone=(reply:FastifyReply)=>{const controller=new AbortController();reply.raw.once('close',()=>{if(!reply.raw.writableFinished)controller.abort();});return controller.signal;};
  app.get<{Params:{id:string}}>('/api/projects/:id/git/head',async(request)=>git.head(store.getProject(request.params.id)));
  /** A file as `rev` (`HEAD` or a hash) has it; `missing` when that commit lacks it. */
  app.get<{Params:{id:string};Querystring:{path?:string;rev?:string}}>('/api/projects/:id/git/file',async(request,reply)=>git.fileAtRev(store.getProject(request.params.id),requireString(request.query.path,'path',8192),request.query.rev||'HEAD',untilGone(reply)));
  /** Blame of lines `start..end` of the working-tree file; the range is cut to the budget (see `GIT_READ_BUDGET`). */
  app.get<{Params:{id:string};Querystring:{path?:string;start?:string;end?:string}}>('/api/projects/:id/git/blame',async(request,reply)=>git.blame(store.getProject(request.params.id),requireString(request.query.path,'path',8192),Number(request.query.start),Number(request.query.end),untilGone(reply)));
  /** `fresh=true` reads again even when the project is being followed and nothing is known to have changed. */
  app.get<{Params:{id:string};Querystring:{fresh?:string}}>('/api/projects/:id/git/status',async(request)=>git.status(store.getProject(request.params.id),request.query.fresh==='true'));
  /**
   * The project's status now and each time it changes, as `status` events carrying the whole status.
   * While any client holds this stream open the project's files are watched (see `followStatus`).
   */
  app.get<{Params:{id:string}}>('/api/projects/:id/git/stream',async(request,reply)=>{
    const project=store.getProject(request.params.id);
    const unwatch=deps.auth.onRevoke(request,()=>reply.raw.destroy());
    reply.raw.once('close',unwatch);
    reply.hijack(); deps.streams.add(reply.raw);
    reply.raw.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
    reply.raw.write(': connected\n\n');
    const open=()=>!reply.raw.destroyed&&!reply.raw.writableEnded;
    const heartbeat=setInterval(()=>{if(open())reply.raw.write(': heartbeat\n\n');},15_000);
    let unfollow:(()=>void)|undefined;
    reply.raw.on('close',()=>{clearInterval(heartbeat);unfollow?.();deps.streams.delete(reply.raw);});
    try{
      const stop=await git.followStatus(project,status=>{if(open())reply.raw.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`);});
      if(open())unfollow=stop;else stop();
    }catch(error){
      // Not a repository: the client is told once and reads status the ordinary way if it wants the reason.
      // Any other failure just ends the stream, and the client dials again.
      if(open()&&error instanceof AppError&&error.code==='NOT_A_GIT_REPOSITORY')reply.raw.write(`event: unavailable\ndata: ${JSON.stringify({code:error.code})}\n\n`);
      if(open())reply.raw.end();
    }
  });
  /** `base` compares the working tree with `checkpoint:<id>` or a commit instead of the index. */
  app.get<{Params:{id:string};Querystring:{path:string;staged?:string;base?:string;commit?:string;from?:string}}>('/api/projects/:id/git/diff',async(request)=>{
    const {path:file,staged,base,commit,from}=request.query;
    return git.diff(store.getProject(request.params.id),file,{staged:staged==='true',...(base?{base}:{}),...(commit?{commit}:{}),...(from?{from}:{})});
  });
  /** History, newest first: `all=true` walks every branch and tag, `skip` pages back. */
  app.get<{Params:{id:string};Querystring:{all?:string;skip?:string;limit?:string}}>('/api/projects/:id/git/log',async(request)=>git.log(store.getProject(request.params.id),{all:request.query.all==='true',skip:Number(request.query.skip)||0,...(request.query.limit?{limit:Number(request.query.limit)||undefined}:{})}));
  app.get<{Params:{id:string;commit:string}}>('/api/projects/:id/git/commits/:commit',async(request)=>git.commitDetail(store.getProject(request.params.id),request.params.commit));
  /** `q` narrows the remote branches listed. */
  app.get<{Params:{id:string};Querystring:{q?:string}}>('/api/projects/:id/git/refs',async(request)=>git.refs(store.getProject(request.params.id),request.query.q?{query:request.query.q.slice(0,200)}:{}));
  app.post<{Params:{id:string}}>('/api/projects/:id/git/fetch',async(request)=>git.fetch(store.getProject(request.params.id)));
  /** Both rewrite the checkout's files, so neither runs under a turn that is editing them. */
  app.post<{Params:{id:string};Body:{branch?:string;create?:boolean;base?:string;remote?:string}}>('/api/projects/:id/git/switch',async(request)=>{
    const project=store.getProject(request.params.id),body=request.body??{};
    const release=deps.dispatch.reserveWorkspace([project.id]);
    try{return await git.switchBranch(project,{...(body.branch!==undefined?{branch:body.branch}:{}),create:body.create===true,...(body.base!==undefined?{base:requireString(body.base,'base',255)}:{}),...(body.remote!==undefined?{remote:body.remote}:{})});}
    finally{release();}
  });
  app.post<{Params:{id:string}}>('/api/projects/:id/git/pull',async(request)=>{
    const project=store.getProject(request.params.id);
    const release=deps.dispatch.reserveWorkspace([project.id]);
    try{return await git.pull(project);}
    finally{release();}
  });
  /** What the branch changed since it left the main line, or since `base`. */
  app.get<{Params:{id:string};Querystring:{base?:string}}>('/api/projects/:id/git/compare',async(request)=>git.compare(store.getProject(request.params.id),request.query.base||undefined));
  app.post<{Params:{id:string};Body:{paths:string[];permanent?:boolean}}>('/api/projects/:id/git/discard',async(request)=>git.discard(store.getProject(request.params.id),paths(request.body?.paths),{permanent:request.body?.permanent===true}));
  app.post<{Params:{id:string};Body:{path:string;action:'stage'|'unstage'|'discard';changes:GitLineChange[];version:string;base?:string}}>('/api/projects/:id/git/lines',async(request)=>{
    const body=request.body??{} as never;
    return git.applyLines(store.getProject(request.params.id),{path:requireString(body.path,'path',8192),action:body.action,changes:body.changes,version:requireString(body.version,'version',64),...(body.base!==undefined?{base:requireString(body.base,'base',255)}:{})});
  });
  app.post<{Params:{id:string};Body:{paths:string[]}}>('/api/projects/:id/git/stage',async(request)=>git.stage(store.getProject(request.params.id),paths(request.body?.paths)));
  app.post<{Params:{id:string};Body:{paths:string[]}}>('/api/projects/:id/git/unstage',async(request)=>git.unstage(store.getProject(request.params.id),paths(request.body?.paths)));
  app.post<{Params:{id:string};Body:{message:string}}>('/api/projects/:id/git/commit',async(request)=>git.commit(store.getProject(request.params.id),requireString(request.body?.message,'message',10_000)));
  app.get<{Params:{id:string}}>('/api/projects/:id/checkpoints',async(request)=>git.checkpoints(store.getProject(request.params.id)));
  app.post<{Params:{id:string};Body:{sessionId?:string;title?:string}}>('/api/projects/:id/checkpoints',async(request)=>git.createCheckpoint(store.getProject(request.params.id),request.body??{}));
  app.get<{Params:{id:string;checkpointId:string}}>('/api/projects/:id/checkpoints/:checkpointId/changes',async(request)=>git.checkpointChanges(store.getProject(request.params.id),request.params.checkpointId));
  app.post<{Params:{id:string;checkpointId:string};Body:{expectedChanges:unknown}}>('/api/projects/:id/checkpoints/:checkpointId/restore',async(request)=>{
    const project=store.getProject(request.params.id);
    // Undoing a discard puts back the few files it took, each checked against its fingerprint, so it does not have to wait for a running turn.
    const partial=(await git.checkpoints(project)).some(item=>item.id===request.params.checkpointId&&item.partial);
    const release=partial?()=>{}:deps.dispatch.reserveWorkspace([project.id]);
    try{return await git.restoreCheckpoint(project,request.params.checkpointId,request.body?.expectedChanges as never);}
    finally{release();}
  });
  app.get<{Params:{id:string}}>('/api/projects/:id/worktrees',async(request)=>{
    const records=await git.worktrees(store.getProject(request.params.id));
    const canonical=async(value:string)=>realpath(value).catch(()=>path.resolve(value));
    const managedRoot=await canonical(path.join(git.stateDir,'worktrees'));
    // Git remains the source of truth; project records only add provenance and stable creation times.
    const projects=new Map(await Promise.all(store.listProjects().map(async project=>[await canonical(project.cwd),project] as const)));
    const enriched=await Promise.all(records.map(async item=>{
      const directory=await canonical(item.path),project=projects.get(directory);
      const managed=!!project||isWithin(managedRoot,directory);
      const info=managed&&!project?await stat(directory).catch(()=>undefined):undefined;
      const createdAt=project?.createdAt??(info&&info.birthtimeMs>0?info.birthtime.toISOString():undefined);
      return {...item,managed,...(createdAt?{createdAt}:{})};
    }));
    return enriched.sort((a,b)=>Number(!!b.current)-Number(!!a.current)
      ||Number(b.managed)-Number(a.managed)
      ||(a.managed&&b.managed?(b.createdAt??'').localeCompare(a.createdAt??''):0)
      ||(a.branch??a.path).localeCompare(b.branch??b.path)
      ||a.path.localeCompare(b.path));
  });
  app.post<{Params:{id:string};Body:{branch:string;path?:string;base?:string}}>('/api/projects/:id/worktrees',async(request)=>{
    const project=store.getProject(request.params.id),created=await git.createWorktree(project,request.body);
    // Reuse project list notifications for worktrees that do not yet have a project of their own.
    store.updateProject(project.id,{});
    return created;
  });
  app.delete<{Params:{id:string};Body:{path:string}}>('/api/projects/:id/worktrees',async(request)=>{
    const project=store.getProject(request.params.id);
    await git.removeWorktree(project,requireString(request.body?.path,'path',8192));
    store.updateProject(project.id,{});
  });
  app.get<{Params:{id:string}}>('/api/projects/:id/git/branch',async(request)=>git.branchInfo(store.getProject(request.params.id)));
  app.post<{Params:{id:string};Body:{remote?:string}}>('/api/projects/:id/git/push',async(request)=>git.push(store.getProject(request.params.id),request.body?.remote===undefined?{}:{remote:requireString(request.body.remote,'remote',200)}));
  app.get<{Params:{id:string}}>('/api/projects/:id/git/pull-request',async(request)=>git.pullRequest(store.getProject(request.params.id)));
  app.post<{Params:{id:string};Body:{title?:string;body?:string;base?:string;draft?:boolean;remote?:string}}>('/api/projects/:id/git/pull-request',async(request)=>{
    const body=request.body??{};
    return git.createPullRequest(store.getProject(request.params.id),{
      ...(body.title!==undefined?{title:requireString(body.title,'title',300)}:{}),...(typeof body.body==='string'?{body:body.body}:{}),
      ...(body.base!==undefined?{base:requireString(body.base,'base',255)}:{}),draft:body.draft===true,
      ...(body.remote!==undefined?{remote:requireString(body.remote,'remote',200)}:{}),
    });
  });
  /** Brings a worktree project's branch back into the branch its origin project has checked out. */
  app.post<{Params:{id:string};Body:{strategy?:'merge'|'squash';message?:string;commitPending?:string;removeWorktree?:boolean}}>('/api/projects/:id/worktree/merge',async(request)=>{
    const worktree=store.getProject(request.params.id),body=request.body??{};
    if(!worktree.worktree)throw new AppError('NOT_A_WORKTREE_PROJECT','This project is not a worktree of another project',409);
    const release=deps.dispatch.reserveWorkspace([worktree.id,worktree.worktree.originProjectId]);
    try{
      const result=await git.mergeWorktree(store.getProject(worktree.worktree.originProjectId),worktree,{
        ...(body.strategy!==undefined?{strategy:body.strategy}:{}),...(body.message!==undefined?{message:requireString(body.message,'message',5_000)}:{}),
        ...(body.commitPending!==undefined?{commitPending:requireString(body.commitPending,'commitPending',5_000)}:{}),removeWorktree:body.removeWorktree===true,
      });
      // Its directory is gone, so the project is archived rather than left pointing at nothing.
      if(result.removedWorktree)store.updateProject(worktree.id,{archivedAt:new Date().toISOString()});
      return result;
    }finally{release();}
  });
  /**
   * Gives a worktree a project of its own, which is what lets a conversation run in it: sessions
   * take their directory from their project. A `path` adopts a worktree that already exists;
   * without one a fresh worktree is cut first.
   */
  app.post<{Params:{id:string};Body:{path?:string;branch?:string;base?:string;name?:string}}>('/api/projects/:id/worktree-projects',async(request)=>{
    const origin=store.getProject(request.params.id),body=request.body??{};
    const namingOrigin=body.path||body.branch?origin:store.getProject(store.originChain(origin.id).at(-1)??origin.id);
    const target=body.path
      ? requireString(body.path,'path',8192)
      : (await git.createWorktree(origin,{branch:body.branch?requireString(body.branch,'branch',255):generatedBranch(namingOrigin.name,{name:body.name}),...(body.base?{base:requireString(body.base,'base',255)}:{})})).path;
    // Only a worktree git itself reports for this repository may become a project; an arbitrary
    // path would otherwise gain the project's file and command surface. git reports a worktree's
    // real path while a client may hand over a symlinked one — macOS reaches the temporary directory
    // through both `/var` and `/private/var` — so both sides are canonicalized before comparing.
    // Comparing unresolved paths refused legitimate worktrees and skipped the guard below entirely.
    const canonical=async(value:string)=>{try{return await realpath(value);}catch{return undefined;}};
    const targetPath=await canonical(target);
    const worktrees=await git.worktrees(origin);
    const canonicalPaths=await Promise.all(worktrees.map(item=>canonical(item.path)));
    const matched=targetPath===undefined?-1:canonicalPaths.indexOf(targetPath);
    if(matched<0)throw new AppError('WORKTREE_NOT_FOUND','Path is not a worktree of this project',404);
    const registered=worktrees[matched]!;
    if(targetPath===await canonical(origin.cwd))throw new AppError('INVALID_WORKTREE_PATH','This is the project itself, not a worktree');
    const cwd=await realpath(registered.path);
    const branch=registered.branch??registered.head.slice(0,8);
    // Generated branches are namespaced, and the namespace often repeats the project's own name.
    const suffix=branch.startsWith(`${origin.name}/`)?branch.slice(origin.name.length+1):branch;
    return store.createProject(cwd,`${origin.name} · ${suffix}`,{originProjectId:origin.id,branch});
  });
}
