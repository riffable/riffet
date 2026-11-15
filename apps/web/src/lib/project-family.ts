import type { Session } from '@contracts';
import type { ProjectRecord } from './api';
import { sessionActivityAt } from './session-order';

/** The workbench's own project: quick chats live here, but it is never a directory to pick or list. */
export const isQuickChatProject = (project?: Pick<ProjectRecord, 'system'>): boolean => project?.system === 'quick-chat';

/** Where the 助理's conversations live (docs/TASK-BOARD.md §5): a project of the workbench's own, like quick chat's. */
export const isAssistantProject = (project?: Pick<ProjectRecord, 'system'>): boolean => project?.system === 'assistant';

/** Everything a project picker, directory list or project group may show. */
export const regularProjects = (projects: readonly ProjectRecord[]): ProjectRecord[] => projects.filter((project) => !project.system);

/** Directory recency includes local visits and conversation activity, never metadata edits or pins. */
export function sortProjectsByRecentUse(projects: readonly ProjectRecord[], sessions: readonly Session[], visits: Readonly<Record<string, number>>): ProjectRecord[] {
  const activity = new Map(projects.map((project) => [project.id, Math.max(visits[project.id] ?? 0, Date.parse(project.createdAt) || 0)]));
  for (const session of sessions) {
    const previous = activity.get(session.projectId);
    if (previous !== undefined) activity.set(session.projectId, Math.max(previous, Date.parse(sessionActivityAt(session)) || 0));
  }
  return [...projects].sort((a, b) => activity.get(b.id)! - activity.get(a.id)!);
}

/** Keep each checkout's execution identity while listing its conversations under the original project. */
export function sidebarProjectMap(projects: readonly ProjectRecord[], showArchived: boolean, projectlessName = '', assistantName = ''): Map<string, ProjectRecord> {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const result = new Map<string, ProjectRecord>();
  const managed = projects.find((project) => project.system === 'task-workspace' && (showArchived || !project.archivedAt));
  const projectless = managed && { ...managed, id: 'riffet:projectless', name: projectlessName, cwd: '', archivedAt: undefined };
  for (const project of projects) {
    if (project.system === 'quick-chat') continue;
    // Its stored name is the server's; the reader sees it in their own language.
    if (project.system === 'assistant') { result.set(project.id, assistantName ? { ...project, name: assistantName } : project); continue; }
    if (project.system === 'task-workspace') {
      if (projectless && (showArchived || !project.archivedAt)) result.set(project.id, projectless);
      continue;
    }
    let current = project;
    const visited = new Set<string>();
    let hidden = false;
    while (true) {
      if (!showArchived && current.archivedAt) { hidden = true; break; }
      visited.add(current.id);
      const origin = current.worktree && byId.get(current.worktree.originProjectId);
      if (!origin) break;
      // Malformed peer data must not make the checkout inaccessible or loop forever.
      if (visited.has(origin.id)) { current = project; break; }
      current = origin;
    }
    if (!hidden) result.set(project.id, current);
  }
  return result;
}
