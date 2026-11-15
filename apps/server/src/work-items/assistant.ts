import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { AssistantInstructions, NativeBackendId, Project, WorkItem } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { assistantInstructions } from '../prompts/index.js';
import type { Store } from '../store.js';
import type { WorkItemService } from './service.js';

/*
 * The 助理's side of the board (docs/TASK-BOARD.md §5): the project its conversations live in, and
 * what its Riffet tools do. It plans and starts tasks and reads the board; it never does their work.
 */

/**
 * The 助理's instructions live in its project's `AGENTS.md`, which every CLI but Claude Code reads;
 * `CLAUDE.md` imports it, so the owner edits one file.
 */
const INSTRUCTIONS = 'AGENTS.md';
const CLAUDE_FILE = 'CLAUDE.md';
const CLAUDE_IMPORT = `@${INSTRUCTIONS}\n`;
/** The hash of the text Riffet last wrote: a file still holding it was never edited, so it follows Riffet's updates. */
const WRITTEN_KEY = 'assistant-instructions-written';
/** Done tasks older than this are left out of `task_list`. */
const RECENT_DONE_MS = 3 * 86_400_000;
const LISTED = 50;
const INSTRUCTIONS_LIMIT = 64_000;

const builtIn = () => `${assistantInstructions()}\n`;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const readText = (path: string): string | undefined => { try { return readFileSync(path, 'utf8'); } catch { return undefined; } };

/**
 * The project that holds the 助理's conversations, made on first use. Its directory holds the
 * instructions: Riffet's own text until the owner edits it, kept up to date with the server's version.
 */
export function assistantProject(store: Store, stateDir: string): Project {
  const cwd = join(stateDir, 'assistant');
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const path = join(cwd, INSTRUCTIONS);
  const current = readText(path);
  // With no record yet the file is one an older server rewrote on every start, never the owner's.
  const written = store.getSetting<string | undefined>(WRITTEN_KEY, undefined);
  if (current === undefined || (current !== builtIn() && (written === undefined || digest(current) === written))) writeInstructions(store, cwd, builtIn());
  // An older server wrote the whole text here; anything else is the owner's.
  const claude = readText(join(cwd, CLAUDE_FILE));
  if (claude === undefined || claude === current) writeFileSync(join(cwd, CLAUDE_FILE), CLAUDE_IMPORT, { mode: 0o600 });
  const existing = store.listProjects().find(project => project.system === 'assistant');
  if (existing) return existing;
  const project = store.createProject(cwd, '助理');
  return project.system === 'assistant' ? project : store.updateProject(project.id, { system: 'assistant' });
}

function writeInstructions(store: Store, cwd: string, text: string): void {
  writeFileSync(join(cwd, INSTRUCTIONS), text, { mode: 0o600 });
  if (text === builtIn()) store.setSetting(WRITTEN_KEY, digest(text));
}

/** What the 助理 starts each conversation with; `null` restores Riffet's own text. */
export function assistantInstructionsFile(store: Store, stateDir: string, text?: string | null): AssistantInstructions {
  const cwd = assistantProject(store, stateDir).cwd;
  if (text !== undefined) {
    if (text !== null && (typeof text !== 'string' || text.length > INSTRUCTIONS_LIMIT || text.includes('\0'))) throw new AppError('INVALID_ARGUMENT', `Instructions are text of at most ${INSTRUCTIONS_LIMIT} characters`);
    const next = text === null || !text.trim() ? builtIn() : `${text.trimEnd()}\n`;
    writeInstructions(store, cwd, next);
  }
  const current = readText(join(cwd, INSTRUCTIONS)) ?? '';
  return { text: current, custom: current !== builtIn() };
}

type Args = Record<string, unknown>;
const invalid = (message: string) => new AppError('INVALID_ARGUMENT', message);
const optionalText = (args: Args, key: string): string | undefined => {
  const value = args[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw invalid(`${key} must be text`);
  return value;
};

/** What the 助理's tools do; `app.ts` hands it to the Riffet MCP service. */
export class AssistantBoard {
  constructor(private readonly deps: {
    store: Store;
    workItems: WorkItemService;
    /** The agent a task gets when the 助理 names none: the owner's default. */
    defaultBackend(): NativeBackendId;
  }) {}

  private projects(): Project[] {
    return this.deps.store.listProjects().filter(project => !project.system && !project.archivedAt);
  }
  private projectName(id: string | undefined): string | undefined {
    if (!id) return undefined;
    try { return this.deps.store.getProject(id).name; } catch { return undefined; }
  }

  /** A task by its number (`12`, `#12`) or id. */
  private task(value: unknown): WorkItem {
    const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim().replace(/^#/, '') : '';
    if (!raw) throw invalid('task is required: its number');
    const found = /^\d+$/.test(raw) ? this.deps.workItems.list().find(item => item.number === Number(raw)) : this.deps.workItems.list().find(item => item.id === raw);
    if (!found) throw new AppError('WORK_ITEM_NOT_FOUND', `There is no task ${raw}`, 404);
    return found;
  }

  private summary(item: WorkItem): Record<string, unknown> {
    return {
      task: item.number, title: item.title, status: item.status,
      ...(item.projectId ? { project: this.projectName(item.projectId) ?? item.projectId } : {}),
      agent: item.assignee.kind === 'agent' ? item.assignee.backendId : 'owner',
      ...(item.questions?.length ? { waitingOnOwner: item.questions.map(question => question.text) } : {}),
      updatedAt: item.updatedAt,
    };
  }

  async call(name: string, args: Args): Promise<Record<string, unknown>> {
    switch (name) {
      case 'list_projects':
        return { projects: this.projects().map(project => ({ id: project.id, name: project.name, path: project.cwd })) };
      case 'task_list': {
        const since = Date.now() - RECENT_DONE_MS;
        const items = this.deps.workItems.list()
          .filter(item => item.status !== 'done' || Date.parse(item.statusAt) >= since)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, LISTED);
        return { tasks: items.map(item => this.summary(item)) };
      }
      case 'task_get': {
        const item = this.task(args.task);
        const comments = this.deps.workItems.events(item.id).filter(event => event.kind === 'comment').slice(-5);
        return {
          ...this.summary(item),
          ...(item.description ? { description: item.description } : {}),
          ...(item.criteria?.length ? { criteria: item.criteria } : {}),
          conversations: (this.deps.store.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE json_extract(json,'$.workItemId')=?").get(item.id) as { n: number }).n,
          ...(item.submission ? { delivered: { at: item.submission.at, summary: item.submission.summary, criteria: item.submission.criteria, files: item.submission.evidence.files.length, commands: item.submission.evidence.commands.map(command => `${command.command} → ${command.result}`) } } : {}),
          ...(comments.length ? { comments: comments.map(event => (event as { text: string }).text) } : {}),
        };
      }
      case 'task_create': {
        const project = optionalText(args, 'project');
        const projectId = project ? this.projects().find(item => item.id === project || item.name === project)?.id : undefined;
        if (!projectId) throw invalid(project ? `There is no project ${project}; call list_projects` : 'project is required; call list_projects');
        const agent = optionalText(args, 'agent') ?? this.deps.defaultBackend();
        const item = this.deps.workItems.create({
          title: args.title as string,
          ...(optionalText(args, 'description') ? { description: optionalText(args, 'description')! } : {}),
          ...(args.criteria !== undefined ? { criteria: args.criteria as string[] } : {}),
          assignee: { kind: 'agent', backendId: agent as NativeBackendId }, projectId,
        }, { source: 'assistant' });
        if (args.start !== true) return { created: this.summary(item), next: 'It waits in this conversation for the owner to start it.' };
        const started = await this.deps.workItems.start(item.id);
        return { created: this.summary(started.item), started: true };
      }
      case 'task_start': {
        const started = await this.deps.workItems.start(this.task(args.task).id);
        return { started: this.summary(started.item) };
      }
      case 'task_comment': {
        const item = this.task(args.task);
        this.deps.workItems.addComment(item.id, args.text);
        return { commented: item.number };
      }
      default:
        throw new AppError('TOOL_NOT_FOUND', `Unknown tool ${name}`, 404);
    }
  }
}
