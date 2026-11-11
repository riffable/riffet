import { constants, lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { Project } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';

export const TASK_WORKSPACE_MARKER = '.riffet-workspace.json';
export interface TaskWorkspaceIdentity { version: 1; projectId: string; creationId: string }

async function readIdentity(cwd: string): Promise<TaskWorkspaceIdentity | undefined> {
  try {
    const path = join(cwd, TASK_WORKSPACE_MARKER);
    // A replaced FIFO must not block startup or file access while waiting for a writer.
    const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {
      const info=await file.stat();
      if(!info.isFile()||info.size>2048)return undefined;
      const bytes=Buffer.alloc(2049);
      const {bytesRead}=await file.read(bytes,0,bytes.length,0);
      if(bytesRead>2048)return undefined;
      const value: unknown = JSON.parse(bytes.subarray(0,bytesRead).toString('utf8'));
      if (!value || typeof value !== 'object') return undefined;
      const identity = value as TaskWorkspaceIdentity;
      return identity.version === 1 && typeof identity.projectId === 'string' && typeof identity.creationId === 'string' ? identity : undefined;
    }finally{await file.close();}
  } catch { return undefined; }
}

export async function matchesTaskWorkspaceIdentity(cwd: string, identity: TaskWorkspaceIdentity): Promise<boolean> {
  try {
    if (await realpath(cwd) !== cwd || !(await lstat(cwd)).isDirectory()) return false;
    const marker = await readIdentity(cwd);
    return marker?.projectId === identity.projectId && marker.creationId === identity.creationId;
  } catch { return false; }
}

/** Keep the path check and exclusive metadata write in one event-loop turn. */
export function writeTaskWorkspaceIdentity(cwd: string, identity: TaskWorkspaceIdentity): void {
  if (realpathSync(cwd) !== cwd || !lstatSync(cwd).isDirectory()) throw new AppError('TASK_WORKSPACE_CONFLICT', 'The task directory changed before writing its identity', 409);
  writeFileSync(join(cwd, TASK_WORKSPACE_MARKER), JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
}

/** A managed task can never resume in a newly created or replaced empty directory. */
export async function assertTaskWorkspaceAvailable(project: Project): Promise<void> {
  if (project.system !== 'task-workspace') return;
  const identity = await readIdentity(project.cwd);
  if (!identity || identity.projectId !== project.id || !await matchesTaskWorkspaceIdentity(project.cwd, identity)) throw new AppError('TASK_WORKSPACE_UNAVAILABLE', 'Restore the task directory to its original location before retrying', 409);
}
