import { constants } from 'node:fs';
import { access, mkdir, realpath, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { NativeRunInput, NativeSessionInput, Project, Run, Session } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { requestedNativeSessionId } from '../session-identity.js';
import type { SettingsService } from '../settings/index.js';
import type { Store } from '../store.js';
import { isSecretPath } from '../workspace/scope.js';
import { matchesTaskWorkspaceIdentity as matches, writeTaskWorkspaceIdentity, type TaskWorkspaceIdentity } from './identity.js';
export { TASK_WORKSPACE_MARKER, assertTaskWorkspaceAvailable } from './identity.js';

interface Reservation {
  digest: string; commandId: string; project: Project; input: NativeSessionInput;
  identity: TaskWorkspaceIdentity; root: string; date: string; stem: string; suffixLength: number;
  state: 'reserved' | 'ready';
}
export type TaskWorkspaceResult = { project: Project; session: Session; run: Run };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
/** Sort object keys so JSON transport order does not change a creation receipt. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
export const taskWorkspaceRequestDigest = (request: unknown): string => digest(JSON.stringify(stable(request)));
function taskName(text: string): string {
  const line = text.split(/\r?\n/).find(item => item.trim()) ?? '';
  return [...line.normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')].slice(0, 24).join('').replace(/-+$/g, '') || 'task';
}
function calendarDate(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export class TaskWorkspaceService {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(private readonly options: { store: Store; settings: SettingsService; stateDir: string; defaultRoot?: string; deniedRoots?: () => readonly string[]; now?: () => Date }) {}
  private root(): { path: string; source: 'custom' | 'default' } {
    const custom = this.options.settings.getSettings().taskWorkspaceRoot;
    return { path: custom || this.options.defaultRoot || join(homedir(), ...(process.platform === 'darwin' ? ['Documents', 'Riffet'] : ['Riffet'])), source: custom ? 'custom' : 'default' };
  }
  /** Resolve through existing parents without creating anything; checks the actual filesystem boundary. */
  private async canonicalRoot(raw: string): Promise<string> {
    if (!isAbsolute(raw) || raw.length > 8192 || /[\0\r\n]/.test(raw)) throw new AppError('INVALID_TASK_WORKSPACE_ROOT', 'Choose an absolute task workspace directory');
    const target = resolve(raw);
    let parent = target;
    while (true) {
      try {
        const actual = await realpath(parent);
        if (!(await stat(actual)).isDirectory()) throw new AppError('INVALID_TASK_WORKSPACE_ROOT', 'The task workspace location must be a directory');
        const canonical = resolve(actual, target.slice(parent.length).replace(/^\/+/, ''));
        const state = await realpath(this.options.stateDir).catch(() => resolve(this.options.stateDir));
        const denied = await Promise.all([state, ...['.codex', '.claude', '.cursor', '.factory', '.pi/agent', '.config/cursor', '.gemini'].map(name => join(homedir(), name)), ...(this.options.deniedRoots?.() ?? [])].map(async directory => {
          const target = resolve(directory);
          let parent = target;
          while (true) {
            try { return resolve(await realpath(parent), target.slice(parent.length).replace(/^\/+/, '')); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(parent) === parent) throw error;
              parent = dirname(parent);
            }
          }
        }));
        if (await isSecretPath(canonical, denied, false)) throw new AppError('INVALID_TASK_WORKSPACE_ROOT', 'Task files cannot be stored with application state or credentials');
        await access(actual, constants.W_OK | constants.X_OK);
        return canonical;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          if (error instanceof AppError) throw error;
          throw new AppError('INVALID_TASK_WORKSPACE_ROOT', 'The task workspace location is not writable');
        }
        const next = dirname(parent);
        if (next === parent) throw new AppError('INVALID_TASK_WORKSPACE_ROOT', 'The task workspace location is unavailable');
        parent = next;
      }
    }
  }
  async location(): Promise<{ path: string; source: 'custom' | 'default'; available: boolean; error?: string }> {
    const root = this.root();
    try { return { ...root, path: await this.canonicalRoot(root.path), available: true }; }
    catch (error) { return { ...root, available: false, error: error instanceof AppError ? error.code : 'INVALID_TASK_WORKSPACE_ROOT' }; }
  }
  async validateRoot(raw: unknown): Promise<string | undefined> {
    if (raw === null || raw === '') return undefined;
    if (typeof raw !== 'string') throw new AppError('INVALID_TASK_WORKSPACE_ROOT', 'Choose an absolute task workspace directory');
    const root = await this.canonicalRoot(raw);
    try {
      await mkdir(root, { recursive: true });
      if (await realpath(root) !== root) throw new AppError('INVALID_TASK_WORKSPACE_ROOT', 'The task workspace location changed while saving');
      await access(root, constants.W_OK | constants.X_OK);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('INVALID_TASK_WORKSPACE_ROOT', 'The task workspace location is not writable');
    }
    return root;
  }
  async create(request: { clientSessionId: string; commandId: string; requestDigest: string; text: string }, resolveInput: (project: Project) => Promise<NativeSessionInput>, readInput: () => Promise<NativeRunInput>, validateReservedInput: (input: NativeSessionInput) => Promise<void> = async () => undefined, accept?: (project: Project, sessionInput: NativeSessionInput, input: NativeRunInput) => TaskWorkspaceResult): Promise<TaskWorkspaceResult> {
    const previous = this.pending.get(request.clientSessionId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.createReserved(request, resolveInput, readInput, validateReservedInput, accept));
    this.pending.set(request.clientSessionId, operation);
    try { return await operation; }
    finally { if (this.pending.get(request.clientSessionId) === operation) this.pending.delete(request.clientSessionId); }
  }
  private async createReserved(request: { clientSessionId: string; commandId: string; requestDigest: string; text: string }, resolveInput: (project: Project) => Promise<NativeSessionInput>, readInput: () => Promise<NativeRunInput>, validateReservedInput: (input: NativeSessionInput) => Promise<void>, accept?: (project: Project, sessionInput: NativeSessionInput, input: NativeRunInput) => TaskWorkspaceResult): Promise<TaskWorkspaceResult> {
    const { store } = this.options;
    const key = `task-workspace-creation:${request.clientSessionId}`;
    let reservation = store.getSetting<Reservation | undefined>(key, undefined);
    if (reservation && reservation.digest !== request.requestDigest) throw new AppError('SESSION_ID_CONFLICT', 'This creation ID belongs to another request', 409);
    const accepted = (): TaskWorkspaceResult | undefined => {
      let session: Session;
      try { session = store.getSession(request.clientSessionId); } catch (error) {
        if (error instanceof AppError && error.code === 'SESSION_NOT_FOUND') return undefined;
        throw error;
      }
      if (!reservation || session.projectId !== reservation.project.id) throw new AppError('SESSION_ID_CONFLICT', 'This creation ID belongs to another request', 409);
      const run = store.findRunByCommand(session.id, reservation.commandId);
      if (!run) throw new AppError('TASK_WORKSPACE_CONFLICT', 'The accepted task receipt is incomplete', 409);
      return { session, run, project: store.getProject(session.projectId) };
    };
    const replay = accepted();
    if (replay) return replay;
    // Attachment checks precede allocation, but accepted retries above do not depend on live files.
    const input = await readInput();
    reservation = store.getSetting<Reservation | undefined>(key, undefined);
    if (reservation && reservation.digest !== request.requestDigest) throw new AppError('SESSION_ID_CONFLICT', 'This creation ID belongs to another request', 409);
    const validatedReplay = accepted();
    if (validatedReplay) return validatedReplay;
    if (reservation) await validateReservedInput(reservation.input);
    if (!reservation) {
      const now = (this.options.now ?? (() => new Date()))();
      const root = await this.canonicalRoot(this.root().path), date = calendarDate(now), stem = taskName(request.text), stamp = now.toISOString();
      const identity: TaskWorkspaceIdentity = { version: 1, projectId: randomUUID(), creationId: request.clientSessionId };
      const project: Project = { id: identity.projectId, cwd: join(root, date, `${stem}-${digest(request.clientSessionId).slice(0, 8)}`), name: stem, system: 'task-workspace', createdAt: stamp, updatedAt: stamp };
      const resolved = await resolveInput(project);
      if (resolved.backendId === 'chat' || resolved.resumePicker || requestedNativeSessionId(resolved)) throw new AppError('INVALID_SUBMISSION', 'A projectless task must start a new agent conversation');
      reservation = { digest: request.requestDigest, commandId: request.commandId, project, input: resolved, identity, root, date, stem, suffixLength: 8, state: 'reserved' };
      store.transaction(() => {
        const existing = store.getSetting<Reservation | undefined>(key, undefined);
        if (existing) {
          if (existing.digest !== request.requestDigest) throw new AppError('SESSION_ID_CONFLICT', 'This creation ID belongs to another request', 409);
          reservation = existing;
        } else store.setSetting(key, reservation);
      });
    }
    // Another service may have accepted and promoted the task during provider validation.
    const concurrentReplay = accepted();
    if (concurrentReplay) return concurrentReplay;
    await this.allocate(key, reservation);
    const allocatedReplay = accepted();
    if (allocatedReplay) return allocatedReplay;
    return accept ? accept(reservation.project, reservation.input, input) : store.createTaskWorkspaceSubmission(reservation.project, request.clientSessionId, reservation.input, reservation.commandId, input);
  }
  private async allocate(key: string, reservation: Reservation): Promise<void> {
    if (reservation.state === 'ready') {
      if (!await matches(reservation.project.cwd, reservation.identity)) throw new AppError('TASK_WORKSPACE_CONFLICT', 'The reserved task directory is missing or belongs to another task', 409);
      return;
    }
    try {
      // Previously selected roots are pinned; symlink replacement must not redirect a retry.
      if (await this.canonicalRoot(reservation.root) !== reservation.root) throw new AppError('TASK_WORKSPACE_CONFLICT', 'The reserved task location changed', 409);
      await mkdir(join(reservation.root, reservation.date), { recursive: true });
      if (await realpath(join(reservation.root, reservation.date)) !== join(reservation.root, reservation.date)) throw new AppError('TASK_WORKSPACE_CONFLICT', 'The task date directory changed', 409);
      while (true) {
        const cwd = reservation.project.cwd;
        try {
          await mkdir(cwd, { mode: 0o700 });
          writeTaskWorkspaceIdentity(cwd, reservation.identity);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          if (!await matches(cwd, reservation.identity)) {
            // Never remove an unclaimed directory; extend the persisted candidate before trying again.
            if (reservation.suffixLength >= 64) throw new AppError('TASK_WORKSPACE_CONFLICT', 'The task directory identity is already occupied', 409);
            reservation.suffixLength += 4;
            reservation.project.cwd = join(reservation.root, reservation.date, `${reservation.stem}-${digest(reservation.identity.creationId).slice(0, reservation.suffixLength)}`);
            this.saveReservation(key, reservation, cwd);
            continue;
          }
        }
        if (!await matches(cwd, reservation.identity)) throw new AppError('TASK_WORKSPACE_CONFLICT', 'The task directory changed during allocation', 409);
        reservation.state = 'ready';
        this.saveReservation(key, reservation, cwd);
        return;
      }
    } catch (error) {
      if (error instanceof AppError && error.code === 'TASK_WORKSPACE_CONFLICT') {
        const current = this.options.store.getSetting<Reservation | undefined>(key, undefined);
        if (current?.digest === reservation.digest
          && (current.project.cwd !== reservation.project.cwd || current.state !== reservation.state)) {
          Object.assign(reservation, current);
          return this.allocate(key, reservation);
        }
      }
      if (error instanceof AppError) throw error;
      throw new AppError('TASK_WORKSPACE_UNAVAILABLE', 'The task directory could not be created', 409);
    }
  }
  /** Another daemon must not change a persisted candidate after it has become ready. */
  private saveReservation(key: string, next: Reservation, expectedCwd: string): void {
    const {store}=this.options;
    store.transaction(()=>{
      const current=store.getSetting<Reservation|undefined>(key,undefined);
      if(!current||current.digest!==next.digest||current.project.cwd!==expectedCwd||(current.state==='ready'&&current.project.cwd!==next.project.cwd))throw new AppError('TASK_WORKSPACE_CONFLICT','The task directory reservation changed during allocation',409);
      store.setSetting(key,next);
    });
  }
}
