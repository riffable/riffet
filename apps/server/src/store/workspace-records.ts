import { randomUUID } from 'node:crypto';
import type {
  CapturedSessionReference, NativeContext, NativeInteractionResult,
  NativeRunInput, NativeSessionInput, Project, Run, Session,
} from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import {
  interactionReceiptKey, now, retainedReceipts,
  type StorePort, type StoredFolderFavorite,
} from './shared.js';

export function createProject(port: StorePort, cwd: string, name: string, worktree?: Project['worktree']): Project {
  const existing = port.listProjects().find(project => project.cwd === cwd);
  if (existing) {
    if (!worktree || existing.worktree) return existing;
    if (originChain(port, worktree.originProjectId).includes(existing.id)) throw new AppError('PROJECT_ORIGIN_CYCLE', 'This project is an origin of that worktree; linking it back would form a loop', 409);
    return updateProject(port, existing.id, { worktree });
  }
  const project: Project = { id: randomUUID(), cwd, name, ...(worktree ? { worktree } : {}), createdAt: now(), updatedAt: now() };
  port.sql('INSERT INTO projects(id,json) VALUES(?,?)').run(project.id, JSON.stringify(project));
  port.projectsChanged();
  return project;
}

export function createTaskWorkspaceSubmission(port: StorePort, project: Project, clientSessionId: string, sessionInput: NativeSessionInput, commandId: string, input: NativeRunInput, contextSnapshots?: CapturedSessionReference[]): { project: Project; session: Session; run: Run } {
  return port.transaction(() => {
    if (project.system !== 'task-workspace' || sessionInput.projectId !== project.id) throw new AppError('TASK_WORKSPACE_CONFLICT', 'The reserved task and session must share a managed project identity', 409);
    const existing = port.get<Project>('projects', project.id);
    if (existing && (existing.cwd !== project.cwd || existing.system !== 'task-workspace')) throw new AppError('TASK_WORKSPACE_CONFLICT', 'The reserved project identity has another directory or classification', 409);
    if (!existing) {
      if (port.listProjects().some(item => item.cwd === project.cwd)) throw new AppError('TASK_WORKSPACE_CONFLICT', 'The reserved directory already belongs to another project', 409);
      port.sql('INSERT INTO projects(id,json) VALUES(?,?)').run(project.id, JSON.stringify(project));
      port.projectsChanged();
    }
    const result = port.createNativeSubmission(clientSessionId, sessionInput, commandId, input, contextSnapshots);
    return { project: port.getProject(project.id), ...result };
  });
}

export function promoteTaskWorkspace(port: StorePort, id: string, name: string): Project {
  return port.transaction(() => {
    const project = port.getProject(id);
    const key = `task-workspace-promotion:${id}`;
    const receipt = port.getSetting<{ name: string } | undefined>(key, undefined);
    if (receipt) {
      if (receipt.name !== name) throw new AppError('PROJECT_PROMOTION_CONFLICT', 'This task was already saved with another name', 409);
      return project;
    }
    if (project.system !== 'task-workspace') throw new AppError('INVALID_PROJECT_PROMOTION', 'Only a task workspace can be saved as a project', 409);
    const updated = updateProject(port, id, { name, system: undefined });
    port.marksChanged();
    port.setSetting(key, { name });
    return updated;
  });
}

export function updateProject(port: StorePort, id: string, patch: Partial<Project>): Project {
  return port.transaction(() => {
    const current = port.getProject(id), item = { ...current, ...patch, id, updatedAt: now() };
    port.replace('projects', id, item);
    port.projectsChanged(current.system === item.system ? undefined : id);
    if (current.name !== item.name || current.cwd !== item.cwd || current.system !== item.system) port.refreshDisplayTitles();
    return item;
  });
}

export function originChain(port: StorePort, projectId: string): string[] {
  const chain: string[] = [];
  const start = port.get<Project>('projects', projectId);
  if (!start) throw new AppError('PROJECT_NOT_FOUND', 'Project does not exist', 404);
  let current: Project = start;
  while (current.worktree) {
    const origin: string = current.worktree.originProjectId;
    if (origin === projectId || chain.includes(origin)) throw new AppError('PROJECT_ORIGIN_INVALID', 'This project\'s worktree origins form a loop', 409, { projectId, chain: [projectId, ...chain, origin] });
    const next: Project | undefined = port.get<Project>('projects', origin);
    if (!next) throw new AppError('PROJECT_ORIGIN_INVALID', 'This project\'s worktree origin no longer exists', 409, { projectId, chain: [projectId, ...chain], missing: origin });
    chain.push(origin);
    current = next;
  }
  return chain;
}

export function deleteProject(port: StorePort, id: string): void {
  port.getProject(id);
  if (port.listSessions().some(s => s.projectId === id)) throw new AppError('PROJECT_HAS_SESSIONS', 'This project has conversations. Archive the project to retain its history.', 409);
  if (port.listProjects().some(project => project.worktree?.originProjectId === id)) throw new AppError('PROJECT_HAS_WORKTREES', 'Other projects are worktrees of this one. Archive the project to retain them.', 409);
  port.transaction(() => {
    port.sql('DELETE FROM folder_favorites WHERE project_id=?').run(id);
    port.sql('DELETE FROM projects WHERE id=?').run(id);
    port.projectsChanged();
    port.favoritesChanged();
  });
}

export function listFolderFavorites(port: StorePort, projectId?: string): StoredFolderFavorite[] {
  return (port.sql(`SELECT json FROM folder_favorites WHERE project_id=? ORDER BY json_extract(json,'$.sort'), json_extract(json,'$.createdAt')`).all(projectId ?? '') as { json: string }[]).map(row => JSON.parse(row.json) as StoredFolderFavorite);
}

export function getFolderFavorite(port: StorePort, id: string): StoredFolderFavorite {
  const item = port.get<StoredFolderFavorite>('folder_favorites', id);
  if (!item) throw new AppError('FOLDER_FAVORITE_NOT_FOUND', 'Favorite does not exist', 404);
  return item;
}

export function createFolderFavorite(port: StorePort, path: string, projectId?: string, label?: string): StoredFolderFavorite {
  return port.transaction(() => {
    if (projectId) port.getProject(projectId);
    const existing = port.sql('SELECT json FROM folder_favorites WHERE project_id=? AND path=?').get(projectId ?? '', path) as { json: string } | undefined;
    if (existing) return JSON.parse(existing.json) as StoredFolderFavorite;
    const { top } = port.sql(`SELECT MAX(json_extract(json,'$.sort')) AS top FROM folder_favorites WHERE project_id=?`).get(projectId ?? '') as { top: number | null };
    const item: StoredFolderFavorite = { id: randomUUID(), path, ...(label ? { label } : {}), ...(projectId ? { projectId } : {}), sort: (top ?? -1) + 1, createdAt: now() };
    port.sql('INSERT INTO folder_favorites(id,project_id,path,json) VALUES(?,?,?,?)').run(item.id, projectId ?? '', path, JSON.stringify(item));
    port.favoritesChanged();
    return item;
  });
}

export function updateFolderFavorite(port: StorePort, id: string, patch: Partial<Pick<StoredFolderFavorite, 'label' | 'lastUsedAt'>>): StoredFolderFavorite {
  const item = { ...getFolderFavorite(port, id), ...patch, id };
  port.replace('folder_favorites', id, item);
  port.favoritesChanged();
  return JSON.parse(JSON.stringify(item)) as StoredFolderFavorite;
}

export function reorderFolderFavorites(port: StorePort, ids: string[], projectId?: string): StoredFolderFavorite[] {
  return port.transaction(() => {
    if (projectId) port.getProject(projectId);
    const current = new Map(listFolderFavorites(port, projectId).map(item => [item.id, item]));
    if (ids.length !== current.size || new Set(ids).size !== ids.length || ids.some(id => !current.has(id))) throw new AppError('INVALID_FAVORITE_ORDER', 'List every favorite of this scope exactly once');
    ids.forEach((id, sort) => port.replace('folder_favorites', id, { ...current.get(id)!, sort }));
    port.favoritesChanged();
    return listFolderFavorites(port, projectId);
  });
}

export function deleteFolderFavorite(port: StorePort, id: string): void {
  getFolderFavorite(port, id);
  port.sql('DELETE FROM folder_favorites WHERE id=?').run(id);
  port.favoritesChanged();
}

export function stateCounts(port: StorePort): { sessions: Record<string, number>; terminals: Record<string, number> } {
  const count = (query: string) => Object.fromEntries((port.sql(query).all() as Array<{ state: string | null; n: number }>).map(row => [row.state ?? '', Number(row.n)]));
  return {
    sessions: count(`SELECT json_extract(json,'$.state') AS state, COUNT(*) AS n FROM sessions WHERE json_extract(json,'$.archivedAt') IS NULL GROUP BY 1`),
    terminals: count(`SELECT json_extract(json,'$.state') AS state, COUNT(*) AS n FROM terminals GROUP BY 1`),
  };
}

export function deleteTerminal(port: StorePort, id: string): void {
  port.transaction(() => {
    port.sql('DELETE FROM terminals WHERE id=?').run(id);
    port.sql('DELETE FROM settings WHERE key LIKE ?').run(`terminal-paste:${id}:%`);
    port.terminalsChanged();
  });
}

export function saveWorkbenchDocumentProof(port: StorePort, digest: string, expiresAt: number, nowMs: number, limit: number): void {
  port.transaction(() => {
    port.sql('DELETE FROM workbench_document_proofs WHERE expires_at<=?').run(nowMs);
    port.sql('INSERT INTO workbench_document_proofs(digest,expires_at) VALUES(?,?)').run(digest, expiresAt);
    port.sql('DELETE FROM workbench_document_proofs WHERE rowid IN (SELECT rowid FROM workbench_document_proofs ORDER BY rowid DESC LIMIT -1 OFFSET ?)').run(limit);
  });
}

export function takeWorkbenchDocumentProof(port: StorePort, digest: string, nowMs: number): boolean {
  const row = port.sql('DELETE FROM workbench_document_proofs WHERE digest=? RETURNING expires_at').get(digest) as { expires_at: number } | undefined;
  return row !== undefined && row.expires_at > nowMs;
}

export function getNativeContext(port: StorePort, sessionId: string, nativeSessionId: string): NativeContext | undefined {
  const saved = port.getSetting<{ nativeSessionId: string; context: NativeContext } | undefined>(`native-context:${sessionId}`, undefined);
  return saved?.nativeSessionId === nativeSessionId ? saved.context : undefined;
}

export function saveNativeContext(port: StorePort, sessionId: string, nativeSessionId: string, context: NativeContext | undefined): void {
  if (context) port.setSetting(`native-context:${sessionId}`, { nativeSessionId, context });
  else port.sql('DELETE FROM settings WHERE key=?').run(`native-context:${sessionId}`);
}

export function getNativeInteractionReceipt(port: StorePort, sessionId: string, requestId: string): { fingerprint: string; interactionId: string; revision: string; result: NativeInteractionResult; createdAt: string } | undefined {
  port.getSession(sessionId);
  const receipts = port.getSetting<Record<string, { fingerprint: string; interactionId: string; revision: string; result: NativeInteractionResult; createdAt: string }>>(`native-interactions:${sessionId}`, {});
  return receipts[interactionReceiptKey(requestId)];
}

export function saveNativeInteractionReceipt(port: StorePort, sessionId: string, requestId: string, receipt: { fingerprint: string; interactionId: string; revision: string; result: NativeInteractionResult; createdAt: string }) {
  port.getSession(sessionId);
  const receiptKey = interactionReceiptKey(requestId);
  const key = `native-interactions:${sessionId}`;
  const receipts = port.getSetting<Record<string, typeof receipt>>(key, {});
  const existing = receipts[receiptKey];
  if (existing && (existing.fingerprint !== receipt.fingerprint || existing.interactionId !== receipt.interactionId || existing.revision !== receipt.revision)) {
    throw new AppError('NATIVE_INTERACTION_REQUEST_CONFLICT', 'This interaction retry id was already used for a different answer', 409);
  }
  if (existing?.result.status === 'completed' && receipt.result.status !== 'completed') return existing;
  receipts[receiptKey] = receipt;
  port.setSetting(key, retainedReceipts(receipts, receiptKey));
  return receipt;
}
