import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { agyRecord, type AgyRecord } from './protocol.js';
import type { PreparedAgySession } from './config.js';
import type { StandingGuardPolicy } from './standing.js';

const MAX_JSON = 4 * 1024 * 1024;
async function info(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}
/** Reject linked owned descendants; macOS's system aliases are outside plugin-owned state. */
async function safeDirectory(path: string, create: boolean): Promise<void> {
  if (!isAbsolute(path)) throw new Error('Antigravity bridge path must be absolute');
  const parent = dirname(path);
  if (parent !== path) await safeDirectory(parent, create);
  const current = await info(path);
  if (current?.isSymbolicLink()) {
    if (process.platform === 'darwin' && ['/tmp', '/var', '/etc'].includes(path) && (await realpath(path)) === `/private${path}`) return;
    throw new Error('Antigravity bridge directory is linked');
  }
  if (current && !current.isDirectory()) throw new Error('Antigravity bridge directory is invalid');
  if (!current) {
    if (!create) throw new Error('Antigravity bridge directory is unavailable');
    await mkdir(path, { mode: 0o700 });
  }
}
async function safeFile(path: string, createParents: boolean): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('Antigravity bridge file path is invalid');
  await safeDirectory(dirname(path), createParents);
  const current = await info(path);
  if (current && !current.isFile()) throw new Error('Antigravity bridge file is not regular');
}
export async function readJson(path: string): Promise<AgyRecord | undefined> {
  try {
    await safeFile(path, false);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_JSON) return;
      const raw = Buffer.alloc(Math.min(MAX_JSON + 1, stat.size + 1));
      let length = 0;
      while (length < raw.length) {
        const read = await handle.read(raw, length, raw.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length !== stat.size || length > MAX_JSON) return;
      const value: unknown = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(raw.subarray(0, length)));
      return agyRecord(value) ? value : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}
async function writeBytes(path: string, bytes: string): Promise<void> {
  if (Buffer.byteLength(bytes) > MAX_JSON) throw new Error('Antigravity bridge file exceeds its limit');
  await safeFile(path, true);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    await safeFile(path, false);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeBytes(path, JSON.stringify(value) + '\n');
}
/** The per-session agy plugin loaded through `--add-dir`; agy names its MCP servers `<plugin>_<server>`. */
export const BRIDGE_PLUGIN = 'riffet-antigravity';
export const bridgePluginDir = (paths: Pick<PreparedAgySession, 'bridgeDir'>) => join(paths.bridgeDir, '.agents', 'plugins', BRIDGE_PLUGIN);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/** The bridge records only identity/status, never prompts, tool arguments or model credentials. It grants no permissions. */
export async function prepareBridge(paths: PreparedAgySession, nonce: string, standingGuard?: StandingGuardPolicy): Promise<void> {
  if (!/^[a-f0-9]{48}$/.test(nonce)) throw new Error('Invalid Antigravity bridge launch identity');
  const bridgeState = join(paths.root, 'bridge');
  await safeDirectory(bridgeState, true);
  await chmod(bridgeState, 0o700);
  const guardPath = join(bridgeState, 'standing-guard.json');
  if (standingGuard) await writeJson(guardPath, standingGuard);
  else await rm(guardPath, { force: true });
  const script = join(bridgeState, 'capture.cjs');
  const settings = await readJson(paths.settingsPath);
  if (!settings) throw new Error('Antigravity launch settings are unavailable');
  const previous = agyRecord(settings.statusLine) ? settings.statusLine : {};
  const ownCommand = typeof previous.command === 'string' && previous.command.includes(script);
  const stored = ownCommand ? await readJson(join(bridgeState, 'statusline.json')) : undefined;
  const original = stored?.original ?? previous;
  await writeJson(join(bridgeState, 'statusline.json'), { original });
  await writeBytes(
    script,
    `const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=${JSON.stringify(await realpath(bridgeState))},nonce=${JSON.stringify(
      nonce,
    )},limit=4194304,idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const kind=process.argv[2];let size=0,chunks=[],child,output=0,done=false;
const defaultOut=kind==='status'?'':kind==='pretool'?'{"decision":"allow"}':'{}';
const timer=setTimeout(()=>finish(),4500);
function finish(out){if(done)return;done=true;if(child)try{process.kill(-child.pid,'SIGKILL')}catch{try{child.kill('SIGKILL')}catch{}}clearTimeout(timer);process.stdout.end(typeof out==='string'?out:defaultOut,()=>process.exit(0))}
function record(v){return v&&typeof v==='object'&&!Array.isArray(v)}
function str(v,max=8192){return typeof v==='string'&&Buffer.byteLength(v)<=max&&!v.includes('\\0')?v:undefined}
function pick(v,keys){return record(v)?Object.fromEntries(keys.filter(k=>typeof v[k]==='number'&&Number.isFinite(v[k])).map(k=>[k,v[k]])):undefined}
function safe(file){for(let dir=path.dirname(file);;dir=path.dirname(dir)){const stat=fs.lstatSync(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error();if(path.dirname(dir)===dir)break}try{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error()}catch(e){if(e.code!=='ENOENT')throw e}}
function read(file){safe(file);const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>limit)throw Error();const raw=Buffer.alloc(stat.size+1);let n=0;while(n<raw.length){const got=fs.readSync(fd,raw,n,raw.length-n,null);if(!got)break;n+=got}if(n!==stat.size)throw Error();const value=JSON.parse(raw.subarray(0,n).toString());if(!record(value))throw Error();return value}finally{fs.closeSync(fd)}}
function write(file,payload){safe(file);const tmp=file+'.'+process.pid+'.'+require('node:crypto').randomUUID()+'.tmp';try{fs.writeFileSync(tmp,JSON.stringify({at:Date.now(),nonce,payload})+'\\n',{mode:384,flag:'wx'});safe(file);fs.renameSync(tmp,file)}finally{try{fs.unlinkSync(tmp)}catch{}}}
const WRITE_TOOLS=new Set(['write_to_file','replace_file_content','multi_replace_file_content','edit_file','write_file','delete_file','create_file','move_file','rename_file','write','edit','strreplace','multiedit','delete']);
const SHELL_TOOLS=new Set(['run_command','send_command_input','run_shell_command','execute_command','shell','bash','terminal']);
const PATH_KEYS=['TargetFile','target_file','AbsolutePath','absolute_path','FilePath','file_path','path','Path','destination','DestinationPath','dest','target','file','source','SourcePath','source_path','from','old_path','oldPath'];
function canon(p){const abs=path.resolve(p);const tail=[];let cur=abs;for(;;){try{const r=fs.realpathSync(cur);return tail.length?path.join(r,...tail.reverse()):r}catch{const par=path.dirname(cur);if(par===cur)return abs;tail.push(path.basename(cur));cur=par}}}
function norm(p){const folder=p.endsWith(path.sep+'**')?p.slice(0,-3):undefined;return folder?canon(folder)+path.sep+'**':canon(p)}
function protects(fp,policy){const abs=path.isAbsolute(fp)?fp:path.resolve(policy.cwd||'.',fp);const cand=norm(abs);const list=Array.isArray(policy.protectedFiles)?policy.protectedFiles:[];return list.map(norm).some(e=>e.endsWith(path.sep+'**')?cand.startsWith(e.slice(0,-2))||cand===e.slice(0,-3):cand===e)}
function evalPretool(p){const toolName=String(p.tool_name||p.toolName||(record(p.tool)&&p.tool.name)||'').trim();const lower=toolName.toLowerCase();
let policy;try{policy=read(path.join(root,'standing-guard.json'))}catch{if(WRITE_TOOLS.has(toolName)||WRITE_TOOLS.has(lower)||SHELL_TOOLS.has(toolName)||SHELL_TOOLS.has(lower))return {decision:'deny',reason:'Standing guardrail policy could not be read.'};return {decision:'allow'}}
let input=record(p.tool_input)?p.tool_input:record(p.toolInput)?p.toolInput:record(p.input)?p.input:record(p.arguments)?p.arguments:undefined;
if(!input&&typeof p.tool_input==='string'){try{const parsed=JSON.parse(p.tool_input);if(record(parsed))input=parsed}catch{}}
if(WRITE_TOOLS.has(toolName)||WRITE_TOOLS.has(lower)){for(const k of PATH_KEYS){const v=input&&input[k];if(typeof v==='string'&&v.length>0&&protects(v,policy))return {decision:'deny',reason:'This file is protected and read-only for this team member.'}}}
if(policy.isBackgroundRun&&(SHELL_TOOLS.has(toolName)||SHELL_TOOLS.has(lower)))return {decision:'deny',reason:toolName+' is blocked during autonomous background runs.'};
return {decision:'allow'}}
process.stdin.on('data',x=>{size+=x.length;if(size>limit)return finish();chunks.push(x)});
process.stdin.on('end',()=>{let raw,p;try{raw=Buffer.concat(chunks);chunks=[];p=JSON.parse(raw.toString());if(!record(p))return finish();const payload={};
if(kind==='status'){
for(const k of ['conversation_id','agent_state','cycle_mode','approval','tool_permission','toolPermission','model_id','model_name']){const v=str(p[k]);if(v!==undefined)payload[k]=v}
for(const k of ['pending_input_count','task_count','token_count','input_token_count','output_token_count'])if(Number.isSafeInteger(p[k])&&p[k]>=0)payload[k]=p[k];
if(typeof p.tool_confirmation_pending==='boolean')payload.tool_confirmation_pending=p.tool_confirmation_pending;
if(record(p.model))payload.model=Object.fromEntries(['id','display_name','effort'].flatMap(k=>str(p.model[k],1024)!==undefined?[[k,p.model[k]]]:[]));
if(record(p.context_window)){payload.context_window=pick(p.context_window,['total_input_tokens','total_output_tokens','context_window_size','used_percentage','remaining_percentage']);const usage=pick(p.context_window.current_usage,['input_tokens','output_tokens','cache_creation_input_tokens','cache_read_input_tokens']);if(usage)payload.context_window.current_usage=usage}
if(record(p.sandbox)&&typeof p.sandbox.enabled==='boolean')payload.sandbox={enabled:p.sandbox.enabled};
if(Array.isArray(p.subagents)&&p.subagents.length<=256)payload.subagents=p.subagents.filter(record).map(v=>Object.fromEntries(['name','model','state','status','conversation_id','conversationId'].flatMap(k=>str(v[k],1024)!==undefined?[[k,v[k]]]:[])));
write(path.join(root,'status.json'),payload);
}else if(kind==='hook'){
if(!idPattern.test(p.conversationId||''))return finish();for(const k of ['conversationId','parentConversationId','rootConversationId','cwd','artifactDirectoryPath','hookEventName']){const v=str(p[k]);if(v!==undefined)payload[k]=v}
if(Array.isArray(p.workspacePaths)&&p.workspacePaths.length<=128&&p.workspacePaths.every(v=>str(v)!==undefined))payload.workspacePaths=p.workspacePaths;
write(path.join(root,p.conversationId+'.json'),payload);return finish();
}else if(kind==='pretool'){
return finish(JSON.stringify(evalPretool(p)));
}else return finish();
}catch{return finish()}
try{const conf=read(path.join(root,'statusline.json')).original;const command=record(conf)&&conf.enabled!==false?str(conf.command,65536):undefined;if(!command)return finish();
child=cp.spawn('/bin/sh',['-c',command.replace(/^~/,require('node:os').homedir())],{detached:true,stdio:['pipe','pipe','ignore']});child.stdin.on('error',()=>{});child.stdin.end(raw);child.stdout.on('data',x=>{output+=x.length;if(output>limit)return finish();if(!process.stdout.write(x))child.stdout.pause()});process.stdout.on('drain',()=>child?.stdout.resume());child.on('error',()=>finish());child.on('close',()=>finish());
}catch{finish()}});
process.stdin.on('error',()=>finish());
`,
  );
  const command = (kind: string) => `${quote(process.execPath)} ${quote(script)} ${kind}`;
  settings.statusLine = {
    type: 'command',
    command: command('status'),
    ...(typeof original.padding === 'number' ? { padding: original.padding } : {}),
    stack_with_default:
      original.enabled === false || typeof original.command !== 'string' || !original.command || original.stack_with_default === true,
  };
  await writeJson(paths.settingsPath, settings);
  const plugin = bridgePluginDir(paths);
  await safeDirectory(plugin, true);
  await chmod(plugin, 0o700);
  await writeJson(join(plugin, 'plugin.json'), { name: BRIDGE_PLUGIN, version: '0.1.0' });
  const hooks: Record<string, unknown> = Object.fromEntries(
    ['SessionStart', 'PreInvocation', 'PostInvocation', 'Stop'].map(event => [event, [{ type: 'command', command: command('hook') }]]),
  );
  if (standingGuard) {
    hooks.PreToolUse = [{ matcher: '*', hooks: [{ type: 'command', command: command('pretool') }] }];
  }
  await writeJson(join(plugin, 'hooks.json'), { [BRIDGE_PLUGIN]: hooks });
}
