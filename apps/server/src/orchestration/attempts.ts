import { createHash, randomUUID } from 'node:crypto';
import type { AttemptCleanup, AttemptComparison, AttemptGroup, LaunchTarget, MergeResult, NativeRunInput } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { resolveNativeSessionInput } from '../native/session-input.js';
import {
  GROUPS, MAX_ATTEMPTS, MAX_GROUPS_KEPT, launchTarget, now,
  type OrchestrationDeps, type OrchestrationHost, type StoredAttemptGroup,
} from './shared.js';

export class AttemptManager {
  constructor(
    private readonly deps: OrchestrationDeps,
    private readonly host: OrchestrationHost,
  ) {}

  private read<T>(key: string): Record<string, T> {
    return Object.assign(Object.create(null) as Record<string, T>, this.deps.store.getSetting<Record<string, T>>(key, {}));
  }

  private write<T>(key: string, value: Record<string, T>): void {
    this.deps.store.setSetting(key, value);
  }

  /**
   * One prompt, several backends, each in a worktree cut from the same commit. Every target is
   * resolved before anything is created, so a bad choice fails the request instead of leaving some
   * worktrees behind. Uncommitted changes in the project are not part of the base and are reported;
   * a directory outside Git starts from a snapshot of what is on disk instead.
   */
  async createAttempts(projectId: string, input: { prompt: string; targets: LaunchTarget[]; base?: string; requestId?: string; runInput?: NativeRunInput }): Promise<{ group: AttemptGroup; warnings: string[] }> {
    return this.host.withOperation(`attempts:${input.requestId ?? randomUUID()}`, async () => {
      const { store, git } = this.deps;
      const origin = store.getProject(projectId);
      if (!Array.isArray(input.targets) || input.targets.length < 2 || input.targets.length > MAX_ATTEMPTS) throw new AppError('INVALID_ATTEMPTS', `Choose between 2 and ${MAX_ATTEMPTS} backends`);
      const groups = this.read<StoredAttemptGroup>(GROUPS);
      const requestFingerprint = createHash('sha256').update(JSON.stringify({ projectId, prompt: input.prompt, base: input.base ?? 'HEAD', targets: input.targets.map(launchTarget), attachments: input.runInput?.attachmentIds ?? [], context: input.runInput?.context ?? [] })).digest('hex');
      const repeated = input.requestId ? Object.values(groups).find(group => group.requestId === input.requestId) : undefined;
      if (repeated) {
        if (repeated.requestFingerprint !== requestFingerprint) throw new AppError('REQUEST_ID_CONFLICT', 'This requestId was already used for different attempts', 409);
        if (repeated.attempts.length === input.targets.length) return { group: repeated, warnings: repeated.warnings ?? [] };
      }
      const resolved = await Promise.all(input.targets.map(target => resolveNativeSessionInput(this.deps, { ...target, projectId: origin.id })));
      const start = repeated ? undefined : await git.worktreeBase(origin, input.base ?? 'HEAD');
      const base = repeated?.base ?? start?.commit;
      if (!base) throw new AppError('INVALID_BASE', 'The project has no commit to start attempts from', 422);
      const warnings = repeated?.warnings ?? (start?.uncommitted ? ['项目有未提交的改动，它们不在并行尝试的起点里。'] : []);
      const group: StoredAttemptGroup = repeated ?? { id: randomUUID(), projectId: origin.id, prompt: input.prompt, base, createdAt: now(), attempts: [], requestFingerprint, warnings, ...(input.requestId ? { requestId: input.requestId } : {}), ...(input.runInput ? { runInput: input.runInput } : {}) };
      this.write(GROUPS, this.prune({ ...this.read(GROUPS), [group.id]: group }));
      for (let index = group.attempts.length; index < input.targets.length; index++) {
        const target = input.targets[index];
        const project = await this.host.worktreeProject(origin, base, target.backendId, true);
        const { session } = this.host.launch({ ...resolved[index], projectId: project.id, title: `${input.prompt.split('\n')[0].slice(0, 60)} · ${target.backendId ?? 'default'}` }, input.runInput ?? input.prompt, { kind: 'attempt', groupId: group.id });
        group.attempts.push({ sessionId: session.id, projectId: project.id, branch: project.worktree!.branch, target });
        // Written after every attempt so a failure part way still leaves the started ones findable.
        this.write(GROUPS, this.prune({ ...this.read(GROUPS), [group.id]: group }));
      }
      return { group, warnings };
    });
  }

  private prune(groups: Record<string, AttemptGroup>): Record<string, AttemptGroup> {
    const kept = Object.values(groups).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MAX_GROUPS_KEPT);
    return Object.fromEntries(kept.map(group => [group.id, group]));
  }

  attemptGroups(projectId?: string): AttemptGroup[] {
    return Object.values(this.read<AttemptGroup>(GROUPS)).filter(group => !projectId || group.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  attemptGroup(id: string): AttemptGroup {
    const group = this.read<AttemptGroup>(GROUPS)[id];
    if (!group) throw new AppError('ATTEMPT_GROUP_NOT_FOUND', 'Attempt group does not exist', 404);
    return group;
  }

  /** Each attempt's state and what it changed against the shared base, read fresh from its worktree. */
  async compareAttempts(id: string): Promise<{ group: AttemptGroup; attempts: AttemptComparison[] }> {
    const { store, git } = this.deps;
    const group = this.attemptGroup(id);
    const attempts = await Promise.all(group.attempts.map(async (attempt): Promise<AttemptComparison> => {
      const row: AttemptComparison = { ...attempt };
      try { const session = store.getSession(attempt.sessionId); row.state = session.state; row.title = session.displayTitle ?? session.title; } catch { /* a deleted conversation still shows its branch */ }
      try { row.comparison = await git.compare(store.getProject(attempt.projectId), group.base); }
      catch (error) { row.error = error instanceof Error ? error.message : String(error); }
      return row;
    }));
    return { group, attempts };
  }

  /** Adds one more attempt to a group that has not been adopted yet, from the group's own base and prompt. */
  async addAttempt(id: string, target: LaunchTarget): Promise<{ group: AttemptGroup }> {
    return this.host.withOperation(`attempts-group:${id}`, async () => {
      const { store } = this.deps;
      const group = this.attemptGroup(id);
      if (group.adopted) throw new AppError('ATTEMPT_GROUP_ADOPTED', 'This attempt group already has an adopted result', 409);
      if (group.attempts.filter(item => !item.discardedAt).length >= MAX_ATTEMPTS) throw new AppError('INVALID_ATTEMPTS', `Keep at most ${MAX_ATTEMPTS} attempts in one group`, 409);
      const origin = store.getProject(group.projectId);
      const resolved = await resolveNativeSessionInput(this.deps, { ...target, projectId: origin.id });
      const project = await this.host.worktreeProject(origin, group.base, target.backendId, true);
      // Added and retried attempts run the group's original input, attachments and file references included.
      const runInput = this.read<StoredAttemptGroup>(GROUPS)[id]?.runInput;
      const { session } = this.host.launch({ ...resolved, projectId: project.id, title: `${group.prompt.split('\n')[0].slice(0, 60)} · ${target.backendId ?? 'default'}` }, runInput ?? group.prompt, { kind: 'attempt', groupId: group.id });
      const next: AttemptGroup = { ...group, attempts: [...group.attempts, { sessionId: session.id, projectId: project.id, branch: project.worktree!.branch, target }] };
      this.write(GROUPS, { ...this.read(GROUPS), [id]: next });
      return { group: next };
    });
  }

  /**
   * Archives one attempt's conversation and marks it discarded. Its worktree is removed only when
   * Git can do so without losing uncommitted work; otherwise the project stays findable and the
   * caller is told why.
   */
  async discardAttempt(id: string, sessionId: string, options: { removeWorktree?: boolean } = {}): Promise<{ group: AttemptGroup; warnings: string[] }> {
    return this.host.withOperation(`attempts-group:${id}`, async () => {
      const group = this.attemptGroup(id);
      const attempt = group.attempts.find(item => item.sessionId === sessionId);
      if (!attempt) throw new AppError('ATTEMPT_NOT_FOUND', 'This conversation is not part of the attempt group', 404);
      if (group.adopted?.sessionId === sessionId) throw new AppError('ATTEMPT_ADOPTED', 'The adopted attempt cannot be discarded', 409);
      if (!attempt.discardedAt && this.host.busy(sessionId)) throw new AppError('SESSION_BUSY', 'Stop this attempt before discarding it', 409);
      const warnings = await this.archiveAttempt(group, attempt, options.removeWorktree === true);
      const next: AttemptGroup = { ...group, attempts: group.attempts.map(item => item.sessionId === sessionId ? { ...item, discardedAt: item.discardedAt ?? now() } : item) };
      this.write(GROUPS, { ...this.read(GROUPS), [id]: next });
      return { group: next, warnings };
    });
  }

  /** Archives an attempt's conversation; with [remove], also removes its worktree when that loses nothing. Returns warnings. */
  private async archiveAttempt(group: AttemptGroup, attempt: AttemptGroup['attempts'][number], remove: boolean): Promise<string[]> {
    const { store, git } = this.deps;
    const warnings: string[] = [];
    try {
      const session = store.getSession(attempt.sessionId);
      if (!session.archivedAt) store.updateSession(session.id, { archivedAt: now(), state: 'archived' });
    } catch { /* a deleted conversation has nothing to archive */ }
    if (remove) {
      try {
        const worktree = store.getProject(attempt.projectId);
        await git.removeWorktree(store.getProject(group.projectId), worktree.cwd, { shadow: true });
        store.updateProject(worktree.id, { archivedAt: now() });
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    }
    return warnings;
  }

  /** Merges the chosen attempt into the project the group started from, then applies [cleanup] to the others. */
  async adoptAttempt(id: string, sessionId: string, options: { strategy?: 'merge' | 'squash'; message?: string; commitPending?: string; removeWorktree?: boolean; cleanup?: AttemptCleanup }): Promise<{ group: AttemptGroup; merge: MergeResult; warnings: string[] }> {
    return this.host.withOperation(`attempts-group:${id}`, async () => {
      const { store, git } = this.deps;
      const group = this.attemptGroup(id);
      const attempt = group.attempts.find(item => item.sessionId === sessionId);
      if (!attempt) throw new AppError('ATTEMPT_NOT_FOUND', 'This conversation is not part of the attempt group', 404);
      if (group.adopted) throw new AppError('ATTEMPT_GROUP_ADOPTED', 'This attempt group already has an adopted result', 409);
      if (attempt.discardedAt) throw new AppError('ATTEMPT_DISCARDED', 'This attempt was discarded', 409);
      if (this.host.busy(sessionId)) throw new AppError('SESSION_BUSY', 'Wait for this attempt to finish before merging it', 409);
      const { cleanup, ...mergeOptions } = options;
      // Only the merge itself needs the two workspaces it writes to; reserving the siblings too
      // would make adopting impossible while one of them is still running.
      const releaseWorkspace = this.deps.dispatch.reserveWorkspace([group.projectId, attempt.projectId]);
      let merge: MergeResult;
      try {
        const worktree = store.getProject(attempt.projectId);
        merge = await git.mergeWorktree(store.getProject(group.projectId), worktree, { ...mergeOptions, shadow: true, message: options.message ?? `${group.prompt.split('\n')[0].slice(0, 72)} (${attempt.target.backendId ?? 'attempt'})` });
        if (merge.removedWorktree) store.updateProject(worktree.id, { archivedAt: now() });
        const adopted: AttemptGroup = { ...group, adopted: { sessionId, at: now(), ...(merge.head ? { head: merge.head } : {}) } };
        this.write(GROUPS, { ...this.read(GROUPS), [id]: adopted });
      } finally { releaseWorkspace(); }
      const warnings: string[] = [];
      if (cleanup && cleanup !== 'keep') {
        for (const other of group.attempts) {
          if (other.sessionId === sessionId || other.discardedAt) continue;
          try { if (this.host.busy(other.sessionId)) await this.deps.dispatch.interrupt(other.sessionId); } catch { /* archiving below still applies */ }
          warnings.push(...await this.archiveAttempt(group, other, cleanup === 'remove'));
          const marked: AttemptGroup = { ...this.attemptGroup(id), attempts: this.attemptGroup(id).attempts.map(item => item.sessionId === other.sessionId ? { ...item, discardedAt: item.discardedAt ?? now() } : item) };
          this.write(GROUPS, { ...this.read(GROUPS), [id]: marked });
        }
      }
      return { group: this.attemptGroup(id), merge, warnings };
    });
  }
}
