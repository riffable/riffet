import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
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
const CHECKPOINT_BLOB_RE = /^blob-[0-9a-f]{64}$/;

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

/** Whether a backup-relative path points to an immutable content-addressed or write-once file safe to hard-link across backups. */
function isImmutableBackupPath(relPath: string): boolean {
  if (relPath.startsWith('blobs/')) return true;
  if (relPath.startsWith('attachments/')) return true;
  if (relPath.startsWith('checkpoints/')) {
    const base = relPath.slice(relPath.lastIndexOf('/') + 1);
    return CHECKPOINT_BLOB_RE.test(base);
  }
  return false;
}

/** Loads immutable file entries (including expected SHA-256) from the newest completed backup for verified hard-link reuse. */
async function loadPreviousImmutableIndex(backupsDir: string): Promise<Map<string, { file: string; size: number; sha256: string }>> {
  const index = new Map<string, { file: string; size: number; sha256: string }>();
  const names = (await readdir(backupsDir).catch(() => [] as string[]))
    .filter(name => name.startsWith('workbench-') && !name.endsWith('.tmp'))
    .sort()
    .reverse();
  for (const name of names.slice(0, 3)) {
    const dir = join(backupsDir, name);
    let manifest: BackupManifest;
    try {
      manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as BackupManifest;
    } catch { continue; }
    if (manifest.format !== 'riffet-backup-v1' || !Array.isArray(manifest.files)) continue;
    for (const entry of manifest.files) {
      if (typeof entry.path !== 'string' || typeof entry.size !== 'number' || typeof entry.sha256 !== 'string' || !isImmutableBackupPath(entry.path)) continue;
      if (index.has(entry.path)) continue;
      index.set(entry.path, { file: join(dir, entry.path), size: entry.size, sha256: entry.sha256 });
    }
    break;
  }
  return index;
}

export { detectTailscale };

/**
 * Immutable attachments/blobs/checkpoints and online SQLite snapshots of L0 + L1; no running processes or L2 cache.
 * Holds a journal blob-GC fence across the snapshot + Tier-2 blob copy window so background maintenance
 * cannot unlink any blob referenced by the snapshotted `journal.db`, and deduplicates immutable content
 * via hard links both within a backup (checkpoints) and against the previous completed backup (verifying
 * SHA-256 after linking and falling back to a fresh copy from `stateDir` if a prior backup file is corrupt).
 */
export async function createBackup(store:Store, stateDir:string) {
  const backupsDir=join(stateDir,'backups');
  const destination=join(backupsDir,`workbench-${Date.now()}-${randomUUID().slice(0,8)}`);
  const staging=destination+'.tmp';
  await mkdir(staging,{recursive:true,mode:0o700});
  const manifest:BackupManifest={format:'riffet-backup-v1',createdAt:new Date().toISOString(),files:[]};
  const previousImmutable=await loadPreviousImmutableIndex(backupsDir);
  /** Intra-backup dedup index for content-addressed `checkpoints/.../blob-<sha256>` files. */
  const stagedCheckpointBlobs=new Map<string,{file:string;size:number;sha256:string}>();
  const recordStaged=async(target:string)=>{
    const { sha256, size } = await digestFile(target);
    manifest.files.push({path:relative(staging,target).split(sep).join('/'),sha256,size});
    return { sha256, size };
  };
  const tryHardLink=async(existingPath:string,target:string,expectedSize:number):Promise<boolean>=>{
    const info=await lstat(existingPath).catch(()=>undefined);
    if(!info||!info.isFile()||info.isSymbolicLink()||info.size!==expectedSize)return false;
    try{
      await link(existingPath,target);
      return true;
    }catch{
      return false;
    }
  };
  const stageAndRecord=async(source:string,target:string,relPath:string,size:number,checkpointBlobName?:string):Promise<void>=>{
    await mkdir(dirname(target),{recursive:true,mode:0o700});
    let linkedFromPrevious: { sha256: string; size: number } | undefined;
    let linked = false;
    if(checkpointBlobName){
      const existing=stagedCheckpointBlobs.get(checkpointBlobName);
      if(existing && existing.size===size)linked=await tryHardLink(existing.file,target,size);
    }
    if(!linked&&isImmutableBackupPath(relPath)){
      const prev=previousImmutable.get(relPath);
      if(prev&&prev.size===size){
        linked=await tryHardLink(prev.file,target,size);
        if(linked)linkedFromPrevious={sha256:prev.sha256,size:prev.size};
      }
    }
    if(!linked){
      await copyFile(source,target);
      await chmod(target,0o600);
    }
    let digest=await digestFile(target);
    // If a hard-linked file from a prior backup drifted on disk, discard the link and copy fresh from live state.
    if(linkedFromPrevious&&(digest.sha256!==linkedFromPrevious.sha256||digest.size!==linkedFromPrevious.size)){
      await rm(target,{force:true});
      await copyFile(source,target);
      await chmod(target,0o600);
      digest=await digestFile(target);
    }
    manifest.files.push({path:relPath,sha256:digest.sha256,size:digest.size});
    if(checkpointBlobName&&!stagedCheckpointBlobs.has(checkpointBlobName)){
      stagedCheckpointBlobs.set(checkpointBlobName,{file:target,size:digest.size,sha256:digest.sha256});
    }
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
    const relPath=relative(staging,target).split(sep).join('/');
    const baseName=relPath.slice(relPath.lastIndexOf('/')+1);
    const checkpointBlobName=topName==='checkpoints'&&CHECKPOINT_BLOB_RE.test(baseName)?baseName:undefined;
    try{
      await stageAndRecord(source,target,relPath,info.size,checkpointBlobName);
    }catch(error){
      // Transient file vanished during live backup; skip rather than aborting.
      if((error as NodeJS.ErrnoException).code==='ENOENT')return;
      throw error;
    }
  };
  const releaseBlobGc=store.journal.holdBlobGc();
  try {
    const controlTarget=join(staging,'workbench.db');
    await store.backup(controlTarget);
    await recordStaged(controlTarget);

    const journalTarget=join(staging,'journal.db');
    await store.backupJournal(journalTarget);
    await recordStaged(journalTarget);

    // Copy exactly the Tier-2 external blobs referenced by the snapshotted `journal.db`.
    // Because the blob-GC fence was acquired before snapshotting, any missing referenced blob indicates
    // real on-disk corruption rather than a GC race and must fail the backup instead of producing a silent gap.
    const blobsDir=join(stateDir,'blobs');
    const snap=new DatabaseSync(journalTarget,{readOnly:true});
    let refs:Array<{hash:string;codec:string|null}>=[];
    try{
      const hasBlobs=snap.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='blobs'").get();
      if(hasBlobs)refs=snap.prepare('SELECT hash, codec FROM blobs WHERE external=1').all() as Array<{hash:string;codec:string|null}>;
    }finally{snap.close();}
    for(const ref of refs){
      const primaryCodec:BlobCodec=ref.codec==='raw'?'raw':'zstd';
      const altCodec:BlobCodec=primaryCodec==='raw'?'zstd':'raw';
      let chosenCodec:BlobCodec=primaryCodec;
      let src=externalBlobPath(blobsDir,ref.hash,primaryCodec);
      let srcInfo=await lstat(src).catch(()=>undefined);
      if(!srcInfo||!srcInfo.isFile()){
        const altSrc=externalBlobPath(blobsDir,ref.hash,altCodec);
        const altInfo=await lstat(altSrc).catch(()=>undefined);
        if(altInfo?.isFile()){ chosenCodec=altCodec; src=altSrc; srcInfo=altInfo; }
      }
      if(!srcInfo||!srcInfo.isFile()){
        throw new AppError('BACKUP_BLOB_MISSING',`External journal blob is missing on disk: ${ref.hash}`,500);
      }
      const dst=externalBlobPath(join(staging,'blobs'),ref.hash,chosenCodec);
      const relPath=relative(staging,dst).split(sep).join('/');
      await stageAndRecord(src,dst,relPath,srcInfo.size);
    }

    for(const name of included)await capture(join(stateDir,name),join(staging,name),name);
    await writeFile(join(staging,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
    await rename(staging,destination);return {path:destination,files:manifest.files.length,createdAt:manifest.createdAt};
  }catch(error){await rm(staging,{recursive:true,force:true});throw error;}
  finally{releaseBlobGc();}
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
