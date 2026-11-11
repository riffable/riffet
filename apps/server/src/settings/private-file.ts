import { randomUUID } from 'node:crypto';
import { closeSync, chmodSync, constants as fsConstants, fstatSync, fsyncSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { AppError } from '../errors.js';

/** Files that hold credentials: one owner, mode 0600, read without following links, written whole and atomically. */
export function readPrivateSettingsFile(filePath:string,maxBytes=128*1024):string|undefined {
  let fd:number|undefined;
  try {
    fd=openSync(filePath,fsConstants.O_RDONLY|(fsConstants.O_NOFOLLOW??0)|(fsConstants.O_NONBLOCK??0));
    const info=fstatSync(fd);
    if(!info.isFile()||info.size>maxBytes||(process.getuid&&info.uid!==process.getuid())||(info.mode&0o077)!==0)throw new Error('invalid private settings file');
    const chunks:Buffer[]=[];let total=0;const part=Buffer.alloc(8192);
    while(true){const count=readSync(fd,part,0,part.length,null);if(!count)break;total+=count;if(total>maxBytes)throw new Error('private settings file grew beyond limit');chunks.push(Buffer.from(part.subarray(0,count)));}
    return Buffer.concat(chunks).toString('utf8');
  } catch(error) {
    if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;
    throw new AppError('CURSOR_CLI_SETTINGS_CORRUPT','Private Cursor CLI settings are unavailable or invalid',500);
  } finally {if(fd!==undefined)try{closeSync(fd);}catch{/* close after read */}}
}

export function atomicWritePrivateFile(target:string,contents:string):void {
  const temp=`${target}.${randomUUID()}.tmp`;
  let fd:number|undefined;
  try {
    fd=openSync(temp,'wx',0o600);
    writeFileSync(fd,contents);
    fsyncSync(fd);
    closeSync(fd);fd=undefined;
    chmodSync(temp,0o600);
  } catch {
    if(fd!==undefined)try{closeSync(fd);}catch{/* close after failed write */}
    try{unlinkSync(temp);}catch{/* temp may not exist */}
    throw new AppError('SETTINGS_WRITE_FAILED','Workbench settings could not be saved');
  }
  try{renameSync(temp,target);}
  catch{try{unlinkSync(temp);}catch{/* temp may not exist */}throw new AppError('SETTINGS_WRITE_FAILED','Workbench settings could not be saved');}
}

export function validateApiKey(value:unknown,key='cursorCli.apiKey'):string {
  if(typeof value!=='string'||!value||value.length>64*1024||/[\r\n\0]|\s/.test(value))throw new AppError('INVALID_SETTINGS',`${key} must be a non-empty single-line key`);
  return value;
}
