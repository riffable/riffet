import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve, relative, sep, dirname } from 'node:path';
import { AppError } from './errors.js';
import { externalBlobPath, type BlobCodec } from './journal/blob-store.js';
import type { Store } from './store.js';
import { detectTailscale } from '../../../packages/plugin-api/src/kit/machine.js';

interface BackupManifest { format: 'riffet-backup-v1'; createdAt: string; files: Array<{path:string;sha256:string;size:number}>; }
/** State a backup captures (`derived.db` is omitted because it is a rebuildable cache; `blobs/` is copied from the journal snapshot). */
const included = ['access-token','cookie-secret','settings.json','cursor-cli.json','native-backend-profiles.json','themes.json','devices.json','owner.json','owner','apns-key.json','server-id','attachments','checkpoints','config-backups','marks'];
/** Directories older backups may carry; accepted on restore, never written by a new backup. */
const legacyIncluded = new Set(['space-assets']);
/** What a restore may copy: the databases plus the state a backup writes, and legacy dead state it ignores. */
const allowedTopLevel = new Set(['workbench.db', 'journal.db', 'blobs', ...included, ...legacyIncluded]);
/**
 * Paired-device, owner and push state arrived after backups shipped; old backups omit it and must still restore.
 * The push key is restored 0600 like every file; `server-id` keeps the id devices match pushes by.
 */
const optionalIncluded = new Set(['devices.json','owner.json','apns-key.json','server-id']);

/** Streaming SHA-256 + size for large database/blob files so backups never load gigabytes into V8 memory. */
async function digestFile(filePath: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  await new Promise<void>((resolveDone, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buf.length;
      hash.update(buf);
    });
    stream.once('error', reject);
    stream.once('end', resolveDone);
  });
  return { sha256: hash.digest('hex'), size };
}

export { detectTailscale };

/** Immutable attachments/blobs/checkpoints and online SQLite snapshots of L0 + L1; no running processes or L2 cache. */
export async function createBackup(store:Store, stateDir:string) {
  const destination=join(stateDir,'backups',`workbench-${Date.now()}-${randomUUID().slice(0,8)}`);
  const staging=destination+'.tmp';
  await mkdir(staging,{recursive:true,mode:0o700});
  const manifest:BackupManifest={format:'riffet-backup-v1',createdAt:new Date().toISOString(),files:[]};
  const recordStaged=async(target:string)=>{
    const { sha256, size } = await digestFile(target);
    manifest.files.push({path:relative(staging,target).split(sep).join('/'),sha256,size});
  };
  const capture=async(source:string,target:string,topName:string):Promise<void>=>{
    const info=await lstat(source).catch(()=>undefined);if(!info)return;
    if(info.isSymbolicLink())throw new AppError('UNSAFE_BACKUP_FILE','Workbench state contains a symbolic link',409);
    if(info.isDirectory()){
      await mkdir(target,{recursive:true,mode:0o700});
      for(const name of await readdir(source).catch(()=>[] as string[])){
        // Skip checkpoint dedup cache and transient staging/temp files.
        if(topName==='checkpoints'&&(name==='.objects'||name.endsWith('.linktmp')))continue;
        if(name.endsWith('.tmp'))continue;
        await capture(join(source,name),join(target,name),topName);
      }
      return;
    }
    if(!info.isFile())return;
    try{
      await copyFile(source,target);
      await chmod(target,0o600);
    }catch(error){
      // Transient file vanished during live backup; skip rather than aborting.
      if((error as NodeJS.ErrnoException).code==='ENOENT')return;
      throw error;
    }
    await recordStaged(target);
  };
  try {
    const controlTarget=join(staging,'workbench.db');
    await store.backup(controlTarget);
    await recordStaged(controlTarget);

    const journalTarget=join(staging,'journal.db');
    await store.backupJournal(journalTarget);
    await recordStaged(journalTarget);

    // Copy exactly the Tier-2 external blobs referenced by the snapshotted `journal.db` (streaming, no `.tmp` race).
    const blobsDir=join(stateDir,'blobs');
    if(await stat(blobsDir).then(info=>info.isDirectory(),()=>false)){
      const snap=new DatabaseSync(journalTarget,{readOnly:true});
      let refs:Array<{hash:string;codec:string|null}>=[];
      try{
        const hasBlobs=snap.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='blobs'").get();
        if(hasBlobs)refs=snap.prepare('SELECT hash, codec FROM blobs WHERE external=1').all() as Array<{hash:string;codec:string|null}>;
      }finally{snap.close();}
      for(const ref of refs){
        const codec:BlobCodec=ref.codec==='zstd'?'zstd':'raw';
        const src=externalBlobPath(blobsDir,ref.hash,codec);
        const dst=externalBlobPath(join(staging,'blobs'),ref.hash,codec);
        const srcInfo=await lstat(src).catch(()=>undefined);
        if(!srcInfo||!srcInfo.isFile())continue;
        await mkdir(dirname(dst),{recursive:true,mode:0o700});
        await copyFile(src,dst);
        await chmod(dst,0o600);
        await recordStaged(dst);
      }
    }

    for(const name of included)await capture(join(stateDir,name),join(staging,name),name);
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
      const { sha256, size } = await digestFile(input);
      if(size!==file.size||sha256!==file.sha256)throw new AppError('BACKUP_CORRUPTED',`Backup checksum does not match: ${file.path}`);
      await mkdir(dirname(output),{recursive:true,mode:0o700});await copyFile(input,output);await chmod(output,0o600);restored++;
    }
    await rmdir(destination).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='ENOENT')throw error;});await rename(staging,destination);
    return {path:destination,files:restored};
  }catch(error){await rm(staging,{recursive:true,force:true});throw error;}
}
