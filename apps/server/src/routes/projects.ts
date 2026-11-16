import type { FastifyInstance } from 'fastify';
import { stat, realpath, readdir } from 'node:fs/promises';
import { resolve, join, basename, sep, posix, relative } from 'node:path';
import { homedir } from 'node:os';
import type { FolderFavorite } from '../../../../packages/contracts/src/index.js';
import { AppError, requireString } from '../errors.js';
import type { StoredFolderFavorite } from '../store.js';
import { revisionedList, tags } from './params.js';
import type { RouteDeps } from './deps.js';
import { withoutQuickChats } from '../chat/quick-chat.js';
import { clientSupportsFeature, requireProjectVisibleToClient, visibleProjectItemsForClient, visibleProjectsForClient } from '../native/client-features.js';
import { assertTaskWorkspaceAvailable } from '../task-workspaces/identity.js';

/** The canonical directory an absolute or `~`-relative host path names. */
async function hostDirectory(raw: string): Promise<string> {
  const expanded=raw==='~'||raw.startsWith('~/')?join(homedir(),raw.slice(raw==='~'?1:2)):raw;
  if(!expanded.startsWith('/'))throw new AppError('INVALID_PATH','Absolute path required');
  let real:string; try{real=await realpath(expanded);}catch{throw new AppError('INVALID_PATH','Directory not found');}
  if(!(await stat(real).catch(()=>undefined))?.isDirectory())throw new AppError('INVALID_PATH','Not a directory');
  return real;
}
/** A folder inside a project, as a canonical `/`-separated path relative to its root; symlinks are resolved and may not lead out. */
async function projectDirectory(cwd: string, raw: string): Promise<string> {
  const normal=posix.normalize(raw);
  if(raw.startsWith('/')||raw.includes('\0')||normal==='.'||normal==='./'||normal==='..'||normal.startsWith('../'))throw new AppError('INVALID_PATH','Choose a folder inside the project');
  let root:string,real:string;
  try{root=await realpath(cwd);real=await realpath(join(root,normal));}catch{throw new AppError('INVALID_PATH','Directory not found');}
  if(!real.startsWith(root.endsWith(sep)?root:root+sep))throw new AppError('INVALID_PATH','Choose a folder inside the project');
  if(!(await stat(real).catch(()=>undefined))?.isDirectory())throw new AppError('INVALID_PATH','Not a directory');
  return relative(root,real).split(sep).join('/');
}
const favoriteLabel=(value:unknown)=>{
  if(value===undefined||value===null)return undefined;
  if(typeof value!=='string')throw new AppError('INVALID_INPUT','label must be a string');
  return value.trim().slice(0,80)||undefined;
};
const favoriteScope=(value:unknown)=>value===undefined||value===''?undefined:requireString(value,'projectId',200);

export function registerProjectRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const {store,workspace}=deps;
  /** `exists` is stat'ed afresh on every read, in parallel; a project's favorites resolve against its root. */
  const present=(items:StoredFolderFavorite[],projectId?:string):Promise<FolderFavorite[]>=>{
    const root=projectId?store.getProject(projectId).cwd:undefined;
    return Promise.all(items.map(async item=>({...item,exists:await stat(root?join(root,item.path):item.path).then(info=>info.isDirectory(),()=>false)})));
  };
  app.get('/api/projects',async(request,reply)=>revisionedList(request,reply,store.projectRevision,()=>visibleProjectsForClient(request.headers,withoutQuickChats(store.listProjects(),request))));
  app.post<{Params:{id:string};Body:{name?:string}}>('/api/projects/:id/promote',async(request)=>{
    const name=requireString(request.body?.name,'name',200).trim();
    await assertTaskWorkspaceAvailable(store.getProject(request.params.id));
    return store.promoteTaskWorkspace(request.params.id,name);
  });
  app.post<{Body:{cwd:string;name?:string}}>('/api/projects',async(request)=>{
    const cwd=await realpath(resolve(requireString(request.body?.cwd,'cwd',8192)));
    if (!(await stat(cwd)).isDirectory()) throw new AppError('INVALID_PROJECT','Choose a directory');
    const managed=store.listProjects().find(project=>project.cwd===cwd&&project.system==='task-workspace');
    if(managed){
      if(!clientSupportsFeature(request.headers,'projectless-tasks'))throw new AppError('PROJECT_NOT_FOUND','Project does not exist',404);
      throw new AppError('SYSTEM_PROJECT','Save this task as a project before adding its directory',409);
    }
    const project=store.createProject(cwd,request.body.name?.trim()||basename(cwd));
    const favorite=store.listFolderFavorites().find(item=>item.path===cwd);
    if(favorite)store.updateFolderFavorite(favorite.id,{lastUsedAt:new Date().toISOString()});
    return project;
  });
  /** The quick-chat project belongs to the workbench: renaming, archiving or deleting it would strand every quick chat. */
  const ownProject=(id:string)=>{if(store.getProject(id).system)throw new AppError('SYSTEM_PROJECT','This project is kept by Riffet itself',409);};
  app.patch<{Params:{id:string};Body:{name?:string;tags?:string[];archived?:boolean}}>('/api/projects/:id',async(request)=>{
    ownProject(request.params.id);
    const body=request.body??{},patch: Record<string,unknown>={};
    if (body.name!==undefined) patch.name=requireString(body.name,'name',200);
    if (body.tags!==undefined) patch.tags=tags(body.tags);
    if (body.archived!==undefined) patch.archivedAt=body.archived?new Date().toISOString():undefined;
    return store.updateProject(request.params.id,patch);
  });
  app.delete<{Params:{id:string}}>('/api/projects/:id',async(request)=>{ownProject(request.params.id);store.deleteProject(request.params.id);return {ok:true};});
  app.post<{Body:{path?:string}}>('/api/browse',async(request)=>{
    const raw=typeof request.body?.path==='string'&&request.body.path.trim()?request.body.path.trim():homedir();
    const real=await hostDirectory(raw);
    const items=await readdir(real,{withFileTypes:true,encoding:'utf8'}).catch(()=>[] as Array<{name:string;isDirectory():boolean;isSymbolicLink():boolean}>);
    const favorites=new Map(store.listFolderFavorites().map(item=>[item.path,item.id]));
    // Favorites are stored canonical, so a symlinked entry is matched by its target; only resolved when there is anything to match.
    const favoriteOf=async(path:string,link:boolean)=>favorites.size?favorites.get(link?await realpath(path).catch(()=>path):path):undefined;
    const entries=(await Promise.all(items
      .filter((entry)=>entry.isDirectory()||entry.isSymbolicLink())
      .map(async(entry)=>{const favoriteId=await favoriteOf(join(real,entry.name),entry.isSymbolicLink());return {name:entry.name,kind:'directory' as const,hidden:entry.name.startsWith('.'),...(favoriteId?{favoriteId}:{})};})))
      .sort((a,b)=>a.name.localeCompare(b.name));
    const parent=real===sep?undefined:resolve(real,'..'),favoriteId=favorites.get(real);
    return {path:real,parent:parent&&parent!==real?parent:undefined,home:homedir(),entries,...(favoriteId?{favoriteId}:{})};
  });
  app.get<{Querystring:{projectId?:string}}>('/api/folder-favorites',async(request)=>{
    const projectId=favoriteScope(request.query?.projectId);
    if(projectId)requireProjectVisibleToClient(request.headers,store.getProject(projectId));
    return {favorites:await present(visibleProjectItemsForClient(request.headers,store.listFolderFavorites(projectId),id=>store.getProject(id)),projectId)};
  });
  app.post<{Body:{path?:unknown;label?:unknown;projectId?:unknown}}>('/api/folder-favorites',async(request)=>{
    const body=request.body??{},projectId=favoriteScope(body.projectId),raw=requireString(body.path,'path',8192);
    if(projectId)await assertTaskWorkspaceAvailable(store.getProject(projectId));
    const path=projectId?await projectDirectory(store.getProject(projectId).cwd,raw):await hostDirectory(raw.trim());
    return (await present([store.createFolderFavorite(path,projectId,favoriteLabel(body.label))],projectId))[0];
  });
  app.patch<{Params:{id:string};Body:{label?:unknown;used?:unknown}}>('/api/folder-favorites/:id',async(request)=>{
    const existing=store.getFolderFavorite(request.params.id);
    if(existing.projectId)requireProjectVisibleToClient(request.headers,store.getProject(existing.projectId));
    const body=request.body??{},patch:Partial<Pick<StoredFolderFavorite,'label'|'lastUsedAt'>>={};
    if(body.used!==undefined&&body.used!==true)throw new AppError('INVALID_INPUT','used must be true');
    if(body.label!==undefined)patch.label=favoriteLabel(body.label);
    if(body.used)patch.lastUsedAt=new Date().toISOString();
    const item=Object.keys(patch).length?store.updateFolderFavorite(request.params.id,patch):store.getFolderFavorite(request.params.id);
    return (await present([item],item.projectId))[0];
  });
  app.put<{Body:{ids?:unknown;projectId?:unknown}}>('/api/folder-favorites/order',async(request)=>{
    const body=request.body??{},projectId=favoriteScope(body.projectId);
    if(!Array.isArray(body.ids)||body.ids.length>1000||body.ids.some(id=>typeof id!=='string'))throw new AppError('INVALID_FAVORITE_ORDER','ids must be a list of favorite ids');
    if(projectId)requireProjectVisibleToClient(request.headers,store.getProject(projectId));
    for(const id of body.ids as string[]){
      let item:StoredFolderFavorite;
      try{item=store.getFolderFavorite(id);}catch(error){if(error instanceof AppError&&error.code==='FOLDER_FAVORITE_NOT_FOUND')continue;throw error;}
      if(item.projectId)requireProjectVisibleToClient(request.headers,store.getProject(item.projectId));
    }
    return {favorites:await present(store.reorderFolderFavorites(body.ids as string[],projectId),projectId)};
  });
  app.delete<{Params:{id:string}}>('/api/folder-favorites/:id',async(request)=>{const item=store.getFolderFavorite(request.params.id);if(item.projectId)requireProjectVisibleToClient(request.headers,store.getProject(item.projectId));store.deleteFolderFavorite(request.params.id);return {ok:true};});
  app.post<{Body:{prompt?:string;defaultPath?:string}}>('/api/pick-directory',async(request)=>{
    const body=request.body??{};
    return workspace.pickDirectory({
      ...(typeof body.prompt==='string'&&body.prompt.trim()?{prompt:body.prompt.trim().slice(0,120)}:{}),
      ...(typeof body.defaultPath==='string'&&body.defaultPath.trim()?{defaultPath:body.defaultPath.trim().slice(0,4096)}:{}),
    });
  });
}
