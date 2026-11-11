import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { join, resolve, relative, sep, dirname } from 'node:path';
import { AppError } from './errors.js';
import type { Store } from './store.js';
import { detectTailscale } from '../../../packages/plugin-api/src/kit/machine.js';

interface BackupManifest { format: 'riffet-backup-v1'; createdAt: string; files: Array<{path:string;sha256:string;size:number}>; }
/** State a backup captures. */
const included = ['access-token','cookie-secret','settings.json','cursor-cli.json','native-backend-profiles.json','themes.json','devices.json','owner.json','owner','attachments','checkpoints','config-backups','marks'];
/** Directories older backups may carry; accepted on restore, never written by a new backup. */
const legacyIncluded = new Set(['space-assets']);
/** What a restore may copy: the database plus the state a backup writes, and legacy dead state it ignores. */
const allowedTopLevel = new Set(['workbench.db', ...included, ...legacyIncluded]);
/** Paired-device and owner state arrived after backups shipped; old backups omit it and must still restore. */
const optionalIncluded = new Set(['devices.json','owner.json']);
const digest = (data:Buffer) => createHash('sha256').update(data).digest('hex');

export { detectTailscale };

/** Immutable attachments/checkpoints and an online SQLite snapshot; no running processes or source checkout. */
export async function createBackup(store:Store, stateDir:string) {
  const destination=join(stateDir,'backups',`workbench-${Date.now()}-${randomUUID().slice(0,8)}`);
  const staging=destination+'.tmp';
  await mkdir(staging,{recursive:true,mode:0o700});
  const manifest:BackupManifest={format:'riffet-backup-v1',createdAt:new Date().toISOString(),files:[]};
  const capture=async(source:string,target:string):Promise<void>=>{
    const info=await lstat(source).catch(()=>undefined);if(!info)return;
    if(info.isSymbolicLink())throw new AppError('UNSAFE_BACKUP_FILE','Workbench state contains a symbolic link',409);
    if(info.isDirectory()){await mkdir(target,{recursive:true,mode:0o700});for(const name of await readdir(source))await capture(join(source,name),join(target,name));return;}
    if(!info.isFile())return;
    const data=await readFile(source);await writeFile(target,data,{mode:0o600});
    manifest.files.push({path:relative(staging,target).split(sep).join('/'),sha256:digest(data),size:data.length});
  };
  try {
    await store.backup(join(staging,'workbench.db'));
    const database=await readFile(join(staging,'workbench.db'));
    manifest.files.push({path:'workbench.db',sha256:digest(database),size:database.length});
    for(const name of included)await capture(join(stateDir,name),join(staging,name));
    await writeFile(join(staging,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
    await rename(staging,destination);return {path:destination,files:manifest.files.length,createdAt:manifest.createdAt};
  }catch(error){await rm(staging,{recursive:true,force:true});throw error;}
}

export async function restoreBackup(backupDir:string, destinationDir:string) {
  const source=resolve(backupDir),destination=resolve(destinationDir);
  if(source===destination||destination.startsWith(source+sep))throw new AppError('INVALID_RESTORE_PATH','Choose a separate empty destination');
  const existing=await readdir(destination).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return [];throw error;});
  if(existing.length)throw new AppError('RESTORE_NOT_EMPTY','Restore requires an empty state directory',409);
  let manifest:BackupManifest;
  try{manifest=JSON.parse(await readFile(join(source,'manifest.json'),'utf8'));}catch{throw new AppError('INVALID_BACKUP','Backup manifest cannot be read');}
  if(manifest.format!=='riffet-backup-v1'||!Array.isArray(manifest.files)||!manifest.files.some(file=>file.path==='workbench.db'))throw new AppError('INVALID_BACKUP','Backup format is invalid');
  const staging=destination+'.restore-'+randomUUID();await mkdir(staging,{recursive:true,mode:0o700});
  try{
    const seen=new Set<string>();
    let restored=0;
    for(const file of manifest.files){
      if(typeof file.path!=='string'||!file.path||file.path.includes('\\')||file.path.split('/').some(segment=>!segment||segment==='.'||segment==='..')||seen.has(file.path))throw new AppError('INVALID_BACKUP','Backup contains an invalid file path');
      seen.add(file.path);
      const topLevel=file.path.split('/')[0]!;
      const input=resolve(source,file.path);
      if(!input.startsWith(source+sep)||!allowedTopLevel.has(topLevel))throw new AppError('INVALID_BACKUP','Backup contains an unsupported file');
      // Older backups may list published space files; the feature is gone, so accept the path and
      // leave the dead data out instead of copying it for the next start to delete.
      if(legacyIncluded.has(topLevel))continue;
      const output=resolve(staging,file.path);
      if(!output.startsWith(staging+sep))throw new AppError('INVALID_BACKUP','Backup contains an unsupported file');
      // Optional state may be listed by a newer backup yet absent on disk; skip it instead of aborting.
      if(optionalIncluded.has(file.path)&&!(await lstat(input).catch(()=>null)))continue;
      // Check every path component so a modified backup cannot follow a symlink outside its folder.
      let component=source;for(const name of file.path.split('/')){component=join(component,name);if((await lstat(component)).isSymbolicLink())throw new AppError('INVALID_BACKUP','Backup contains a symbolic link');}
      const data=await readFile(input);
      if(data.length!==file.size||digest(data)!==file.sha256)throw new AppError('BACKUP_CORRUPTED',`Backup checksum does not match: ${file.path}`);
      await mkdir(dirname(output),{recursive:true,mode:0o700});await writeFile(output,data,{mode:0o600});restored++;
    }
    await rmdir(destination).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='ENOENT')throw error;});await rename(staging,destination);
    return {path:destination,files:restored};
  }catch(error){await rm(staging,{recursive:true,force:true});throw error;}
}
