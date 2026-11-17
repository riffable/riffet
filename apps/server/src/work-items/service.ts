import { randomUUID } from 'node:crypto';
import {
  WORK_ITEM_LIMITS, WORK_ITEM_STATUSES,
  type NativeBackendId, type WorkItem, type WorkItemAssignee, type WorkItemCreate, type WorkItemEvent, type WorkItemPatch, type WorkItemQuestion,
  type WorkItemStatus, type WorkItemSubmission,
} from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { taskPart, type BriefLanguage } from '../prompts/index.js';
import type { Store } from '../store.js';
import { AttentionLog } from './attention.js';
import { collectEvidence } from './evidence.js';
import { WorkItemStore } from './store.js';

const invalid = (message: string) => new AppError('INVALID_WORK_ITEM', message);
const notFound = () => new AppError('WORK_ITEM_NOT_FOUND', 'This task does not exist', 404);
const now = () => new Date().toISOString();
/** Pushes in a row supervision may make before the task goes to the owner (docs/TASK-BOARD.md §3). */
const SUPERVISION_PUSHES = 2;
/** Turns the server sends on someone's behalf: wake-ups, follow-ups, supervision and the 助理's background runs. */
export const isSystemCommand = (commandId: string) => /^(?:wakeup-|follow-up-|supervise-|assistant-run-)/.test(commandId);

function title(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw invalid('title must not be empty');
  const text = value.trim();
  if (text.length > WORK_ITEM_LIMITS.title) throw invalid(`title must be at most ${WORK_ITEM_LIMITS.title} characters`);
  return text;
}
function description(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > WORK_ITEM_LIMITS.description) throw invalid(`description must be at most ${WORK_ITEM_LIMITS.description} characters`);
  return value;
}
function labels(value: unknown): string[] {
  if (!Array.isArray(value)) throw invalid('labels must be a list');
  const result: string[] = [];
  for (const label of value) {
    if (typeof label !== 'string' || !label.trim() || label.trim().length > WORK_ITEM_LIMITS.label) throw invalid(`each label must be 1 to ${WORK_ITEM_LIMITS.label} characters`);
    if (!result.includes(label.trim())) result.push(label.trim());
  }
  if (result.length > WORK_ITEM_LIMITS.labels) throw invalid(`at most ${WORK_ITEM_LIMITS.labels} labels`);
  return result;
}
function lines(value: unknown, name: string, count: number, chars: number): string[] {
  if (!Array.isArray(value)) throw invalid(`${name} must be a list`);
  const result = value.map(line => {
    if (typeof line !== 'string' || !line.trim() || line.trim().length > chars) throw invalid(`each of ${name} must be 1 to ${chars} characters`);
    return line.trim();
  });
  if (result.length > count) throw invalid(`at most ${count} ${name}`);
  return result;
}
const criteriaOf = (value: unknown) => lines(value, 'criteria', WORK_ITEM_LIMITS.criteria, WORK_ITEM_LIMITS.criterion);
function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid(`${name} must be 1 to ${max} characters`);
  return value.trim();
}
function status(value: unknown, allowed: readonly WorkItemStatus[] = WORK_ITEM_STATUSES): WorkItemStatus {
  if (typeof value !== 'string' || !allowed.includes(value as WorkItemStatus)) throw invalid(`status must be one of ${allowed.join(', ')}`);
  return value as WorkItemStatus;
}
function assignee(value: unknown): WorkItemAssignee {
  const item = value as { kind?: unknown; backendId?: unknown; profileId?: unknown; model?: unknown } | null;
  if (item?.kind === 'owner') return { kind: 'owner' };
  if (item?.kind === 'agent' && typeof item.backendId === 'string' && item.backendId && item.backendId.length <= 100) {
    const pick = (key: 'profileId' | 'model') => {
      const given = item[key];
      if (given === undefined || given === null) return {};
      if (typeof given !== 'string' || !given || given.length > 200 || /[\0\r\n]/.test(given)) throw invalid(`assignee.${key} must be 1 to 200 characters`);
      return { [key]: given };
    };
    return { kind: 'agent', backendId: item.backendId as NativeBackendId, ...pick('profileId'), ...pick('model') };
  }
  throw invalid('assignee must be the owner or an agent with a backendId');
}
function clientId(value: unknown, name = 'id'): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value || value.length > 100) throw invalid(`${name} must be a string of 1 to 100 characters`);
  return value;
}

/** The conversations side, given by `app.ts`: sending and opening are orchestration's. */
export interface WorkItemMessenger {
  /** Sends a message into a conversation; a retried `commandId` sends nothing new. */
  send(sessionId: string, text: string, commandId: string): void;
  /** Opens a conversation with [text]; [attach] runs in the write that creates it. Returns its id. */
  /** `title` names the conversation after the task, rather than after the brief's first line. */
  open(target: { projectId: string; backendId: NativeBackendId; backendProfileId?: string; model?: string; title: string }, text: string, attach: (sessionId: string) => void): Promise<string>;
}

const COMPOSER_DROPPED_KEY = 'work-items:composer-dropped';
/** When composer conversations stopped opening tasks by themselves. */
const COMPOSER_CUTOFF = '2026-11-16';

const languageOf = (texts: readonly string[]): BriefLanguage => texts.some(value => /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(value)) ? 'zh' : 'en';

export interface SessionTaskSource {
  id: string;
  title: string;
  backendId?: string;
  backendProfileId?: string;
  model?: string;
  projectId?: string;
}

/**
 * Work items (docs/TASK-BOARD.md §4): validation, numbering, activity records and the link to
 * conversations (`Session.workItemId`). Every write is one transaction and moves the work items revision.
 */
export class WorkItemService {
  private readonly items: WorkItemStore;

  private readonly attention: AttentionLog;
  readonly close: () => void;

  constructor(private readonly store: Store, private readonly messenger?: () => WorkItemMessenger) {
    this.items = new WorkItemStore(store.db);
    this.attention = new AttentionLog(store);
    this.close = this.attention.start();
  }

  /** The north star over [from, to) in `timeZone` (docs/TASK-BOARD.md §1). */
  northStar(from: number, to: number, timeZone: string) { return this.attention.report(from, to, timeZone); }

  list(): WorkItem[] { return this.items.all(); }
  get(id: string): WorkItem { return this.items.get(id) ?? (() => { throw notFound(); })(); }
  events(id: string): WorkItemEvent[] { this.get(id); return this.items.events(id); }

  private write<T>(fn: () => T): T {
    return this.store.transaction(() => { const result = fn(); this.store.workItemsChanged(); return result; });
  }
  private record(workItemId: string, body: Record<string, unknown>, id: string = randomUUID()): WorkItemEvent {
    const event = { id, workItemId, at: now(), ...body } as unknown as WorkItemEvent;
    this.items.addEvent(event);
    return event;
  }
  private requireProject(projectId: unknown): string {
    if (typeof projectId !== 'string' || !projectId) throw invalid('projectId must be a string');
    this.store.getProject(projectId);
    return projectId;
  }
  /** `parentId` must name an existing top-level item other than `id`, and `id` must not have children of its own. */
  private requireParent(parentId: unknown, id: string): string {
    if (typeof parentId !== 'string' || !parentId) throw invalid('parentId must be a string');
    if (parentId === id) throw invalid('A task cannot be its own parent');
    const parent = this.items.get(parentId);
    if (!parent) throw new AppError('INVALID_WORK_ITEM', 'The parent task does not exist', 400);
    if (parent.parentId) throw invalid('A parent task cannot itself have a parent');
    if (this.items.hasChildren(id)) throw invalid('A task with sub-tasks cannot become a sub-task');
    return parentId;
  }

  create(input: WorkItemCreate, extra: { source?: WorkItem['source']; titleSessionId?: string; originSessionId?: string } = {}): WorkItem {
    if (!input || typeof input !== 'object') throw invalid('A task is required');
    const id = clientId(input.id) ?? randomUUID();
    const initial = input.status === undefined ? 'todo' : status(input.status, ['todo', 'doing']);
    return this.write(() => {
      const existing = this.items.get(id);
      if (existing) return existing;
      const stamp = now();
      const text = description(input.description);
      const criteria = input.criteria === undefined ? [] : criteriaOf(input.criteria);
      const item: WorkItem = {
        id,
        number: this.items.nextNumber(),
        title: title(input.title),
        ...(text ? { description: text } : {}),
        ...(criteria.length ? { criteria } : {}),
        status: initial,
        assignee: input.assignee === undefined ? { kind: 'owner' } : assignee(input.assignee),
        ...(input.projectId !== undefined ? { projectId: this.requireProject(input.projectId) } : {}),
        ...(input.parentId !== undefined ? { parentId: this.requireParent(input.parentId, id) } : {}),
        labels: input.labels === undefined ? [] : labels(input.labels),
        ...(extra.titleSessionId ? { titleSessionId: extra.titleSessionId } : {}),
        source: extra.source ?? 'board',
        statusAt: stamp, createdAt: stamp, updatedAt: stamp,
      };
      this.items.insert(item, extra.originSessionId);
      this.record(id, { kind: 'created', source: item.source });
      return item;
    });
  }

  patch(id: string, patch: WorkItemPatch): WorkItem {
    if (!patch || typeof patch !== 'object') throw invalid('A change is required');
    return this.write(() => {
      const current = this.get(id);
      const next: WorkItem = { ...current };
      if (patch.title !== undefined) { next.title = title(patch.title); delete next.titleSessionId; }
      if (patch.description !== undefined) { const text = description(patch.description); if (text) next.description = text; else delete next.description; }
      if (patch.criteria !== undefined) { const criteria = criteriaOf(patch.criteria); if (criteria.length) next.criteria = criteria; else delete next.criteria; }
      if (patch.assignee !== undefined) next.assignee = assignee(patch.assignee);
      if (patch.projectId !== undefined) { if (patch.projectId === null) delete next.projectId; else next.projectId = this.requireProject(patch.projectId); }
      if (patch.parentId !== undefined) { if (patch.parentId === null) delete next.parentId; else next.parentId = this.requireParent(patch.parentId, id); }
      if (patch.labels !== undefined) next.labels = labels(patch.labels);
      const stamp = now();
      if (patch.status !== undefined && status(patch.status) !== current.status) this.changeStatus(next, patch.status, stamp);
      next.updatedAt = stamp;
      delete next.stuck;
      this.items.update(next);
      return next;
    });
  }

  private changeStatus(item: WorkItem, to: WorkItemStatus, stamp: string): void {
    this.record(item.id, { kind: 'status', from: item.status, to });
    item.status = to;
    item.statusAt = stamp;
    // Done is the owner's last word on it: its conversations are no longer waiting on anyone.
    if (to === 'done') this.attention.settle(this.sessionsOf(item.id), Date.parse(stamp));
  }

  delete(id: string): void {
    this.write(() => {
      this.get(id);
      const stamp = now();
      for (const child of this.items.children(id)) { const { parentId: _parent, ...rest } = child; this.items.update({ ...rest, updatedAt: stamp }); }
      for (const row of this.store.db.prepare("SELECT id FROM sessions WHERE json_extract(json,'$.workItemId')=?").all(id) as { id: string }[]) {
        this.store.updateSession(row.id, { workItemId: undefined });
      }
      this.items.remove(id);
    });
  }

  addComment(id: string, text: unknown, eventId?: unknown): WorkItemEvent {
    const commentId = clientId(eventId);
    if (typeof text !== 'string' || !text.trim() || text.length > WORK_ITEM_LIMITS.comment) throw invalid(`text must be 1 to ${WORK_ITEM_LIMITS.comment} characters`);
    return this.write(() => {
      this.get(id);
      const existing = commentId && this.items.event(commentId);
      if (existing) {
        if (existing.workItemId !== id || existing.kind !== 'comment') throw new AppError('COMMENT_ID_CONFLICT', 'This comment id belongs to another request', 409);
        return existing;
      }
      return this.record(id, { kind: 'comment', text: text.trim() }, commentId);
    });
  }

  private readonly starting = new Set<string>();

  /**
   * 开始 from the server, for the 助理 (docs/TASK-BOARD.md §5): the item's first conversation, on its
   * agent with the owner's defaults, opened with the brief. An item that already has a conversation
   * is refused; another one is the owner's call (再开一个会话).
   */
  async start(id: string): Promise<{ item: WorkItem; sessionId: string }> {
    const item = this.get(id);
    if (item.assignee.kind !== 'agent') throw new AppError('WORK_ITEM_NO_AGENT', 'This task is assigned to the owner', 409);
    if (!item.projectId) throw new AppError('WORK_ITEM_NO_PROJECT', 'Choose a project for this task first', 409);
    if (item.status === 'done') throw new AppError('WORK_ITEM_DONE', 'This task is done', 409);
    if (this.starting.has(id) || this.sessionsOf(id).length) throw new AppError('WORK_ITEM_STARTED', 'This task already has a conversation', 409);
    if (!this.messenger) throw new AppError('SERVICE_STARTING', 'The workbench is starting', 503);
    this.starting.add(id);
    try {
      const sessionId = await this.messenger().open({ projectId: item.projectId, backendId: item.assignee.backendId, ...(item.assignee.profileId ? { backendProfileId: item.assignee.profileId } : {}), ...(item.assignee.model ? { model: item.assignee.model } : {}), title: item.title }, this.brief(id), session => { this.attachSession(session, id); });
      return { item: this.get(id), sessionId };
    } finally { this.starting.delete(id); }
  }

  /** Points a conversation at an item (or, with `undefined`, away from it). A `todo` item that gains one moves to `doing`. */
  attachSession(sessionId: string, workItemId: string | undefined): WorkItem | undefined {
    return this.write(() => {
      const session = this.store.getSession(sessionId);
      const previous = session.workItemId;
      if (previous === workItemId) return workItemId ? this.get(workItemId) : undefined;
      const target = workItemId === undefined ? undefined : this.get(workItemId);
      if (previous && this.items.get(previous)) { this.record(previous, { kind: 'session', sessionId, detached: true }); this.touch(previous); }
      this.store.updateSession(sessionId, { workItemId });
      if (!target) return undefined;
      this.record(target.id, { kind: 'session', sessionId });
      const next: WorkItem = { ...target, updatedAt: now() };
      if (target.status === 'todo') this.changeStatus(next, 'doing', next.updatedAt);
      this.items.update(next);
      return next;
    });
  }
  private touch(id: string): void {
    const item = this.items.get(id);
    if (item) this.items.update({ ...item, updatedAt: now() });
  }

  // ---- What its conversations report, and the owner's replies (docs/TASK-BOARD.md §6) -------------

  /** The item a conversation works on, for its `task_*` tools. */
  private ofSession(sessionId: string): WorkItem {
    const id = this.store.getSession(sessionId).workItemId;
    const item = id ? this.items.get(id) : undefined;
    if (!item) throw new AppError('NOT_IN_TASK', 'This conversation belongs to no task');
    return item;
  }
  /**
   * A task's conversation opened before it was named after the task took the brief's first line,
   * `任务 #N：…`, as its title; the prefix goes. A title the owner gave is left as it is.
   */
  retitleBriefConversations(): void {
    const rows = this.store.db.prepare("SELECT id FROM sessions WHERE json_extract(json,'$.workItemId') IS NOT NULL AND (json_extract(json,'$.title') LIKE '任务 #%' OR json_extract(json,'$.title') LIKE 'Task #%')").all() as { id: string }[];
    for (const { id } of rows) {
      const session = this.store.getSession(id);
      const title = session.title.replace(/^(?:任务|Task) #\d+[：:]\s*/, '');
      if (session.titleSource !== 'user' && title && title !== session.title) this.store.updateSession(id, { title });
    }
  }
  private sessionsOf(id: string): string[] {
    return (this.store.db.prepare("SELECT id FROM sessions WHERE json_extract(json,'$.workItemId')=? ORDER BY json_extract(json,'$.createdAt')").all(id) as { id: string }[]).map(row => row.id);
  }

  /**
   * `task_submit`: the agent's account, with evidence the server reads from the conversations' own
   * tool events since the previous submission. Work in progress moves to `review`; a submission to
   * an item already closed is recorded and moves nothing.
   */
  submit(sessionId: string, input: Record<string, unknown>): WorkItem {
    const summary = text(input.summary, 'summary', WORK_ITEM_LIMITS.summary);
    const given = input.criteria === undefined ? [] : input.criteria;
    if (!Array.isArray(given)) throw invalid('criteria must be a list');
    return this.write(() => {
      const item = this.ofSession(sessionId);
      const wanted = item.criteria ?? [];
      if (given.length > wanted.length) throw invalid(`this task has ${wanted.length} criteria`);
      const criteria = wanted.map((criterion, index) => {
        const entry = (given[index] && typeof given[index] === 'object' ? given[index] : {}) as { met?: unknown; note?: unknown };
        if (entry.met !== undefined && typeof entry.met !== 'boolean') throw invalid('met must be true or false');
        const note = entry.note === undefined || entry.note === '' ? undefined : text(entry.note, 'note', WORK_ITEM_LIMITS.note);
        return { text: criterion, ...(typeof entry.met === 'boolean' ? { met: entry.met } : {}), ...(note ? { note } : {}) };
      });
      const session = this.store.getSession(sessionId);
      let cwd: string | undefined;
      try { cwd = this.store.getProject(session.projectId).cwd; } catch { /* a removed project leaves paths absolute */ }
      const stamp = now();
      const submission: WorkItemSubmission = {
        sessionId, at: stamp, summary, criteria,
        evidence: collectEvidence(this.store.db, this.sessionsOf(item.id), item.submission?.at ?? item.createdAt, cwd),
      };
      const next: WorkItem = { ...item, submission, updatedAt: stamp };
      this.record(item.id, { kind: 'submit', submission });
      if (item.status === 'todo' || item.status === 'doing') this.changeStatus(next, 'review', stamp);
      this.items.update(next);
      return next;
    });
  }

  /** `task_ask`: a question for the owner, kept on the item until answered. */
  ask(sessionId: string, input: Record<string, unknown>): WorkItemQuestion {
    const question = text(input.question, 'question', WORK_ITEM_LIMITS.question);
    const options = input.options === undefined ? [] : lines(input.options, 'options', WORK_ITEM_LIMITS.options, WORK_ITEM_LIMITS.option);
    return this.write(() => {
      const item = this.ofSession(sessionId);
      const asked: WorkItemQuestion = { id: randomUUID(), sessionId, text: question, ...(options.length ? { options } : {}), at: now() };
      this.record(item.id, { kind: 'question', question: asked });
      this.items.update({ ...item, questions: [...item.questions ?? [], asked], updatedAt: asked.at });
      return asked;
    });
  }

  /** The owner's answer: sent to the conversation that asked, then the question leaves the item. */
  answer(id: string, questionId: string, answer: unknown, commandId: unknown): WorkItem {
    const reply = text(answer, 'text', WORK_ITEM_LIMITS.comment);
    const command = clientId(commandId, 'commandId') ?? (() => { throw invalid('commandId is required'); })();
    const item = this.get(id);
    const question = item.questions?.find(entry => entry.id === questionId);
    if (!question) {
      if (this.items.events(id).some(event => event.kind === 'answer' && event.questionId === questionId)) return item;
      throw new AppError('QUESTION_NOT_FOUND', 'This question does not exist', 404);
    }
    this.sendTo(question.sessionId, taskPart(languageOf([question.text, reply]), 'answer', { question: question.text, answer: reply }), command);
    return this.write(() => {
      const current = this.get(id);
      const questions = (current.questions ?? []).filter(entry => entry.id !== questionId);
      this.record(id, { kind: 'answer', questionId, text: reply });
      const next: WorkItem = { ...current, updatedAt: now() };
      delete next.stuck;
      if (questions.length) next.questions = questions; else delete next.questions;
      this.items.update(next);
      return next;
    });
  }

  /**
   * Not accepted: the reasons go to the conversation that submitted (else the latest), and the item is back in
   * progress. The owner's, or the 助理's supervision (`by`), which the owner's clears from the inbox.
   */
  rework(id: string, reason: unknown, commandId: unknown, by?: 'assistant'): WorkItem {
    const why = text(reason, 'text', WORK_ITEM_LIMITS.comment);
    const command = clientId(commandId, 'commandId') ?? (() => { throw invalid('commandId is required'); })();
    const item = this.get(id);
    const sessionId = item.submission?.sessionId ?? this.sessionsOf(id).at(-1);
    if (!sessionId) throw new AppError('NO_SESSION', 'This task has no conversation to send it to', 409);
    this.sendTo(sessionId, taskPart(languageOf([item.title, why]), 'rework', { text: why }), command);
    return this.write(() => {
      const current = this.get(id);
      if (this.items.event(command)) return current;
      const next: WorkItem = { ...current, updatedAt: now() };
      if (!by) delete next.stuck;
      this.record(id, { kind: 'rework', sessionId, text: why, ...(by ? { by } : {}) }, command);
      if (current.status !== 'doing') this.changeStatus(next, 'doing', next.updatedAt);
      this.items.update(next);
      return next;
    });
  }

  // ---- The 助理's supervision (docs/TASK-BOARD.md §3, docs/ASSISTANT.md §7.2) -------------------

  /** The conversation supervision talks to: the one that submitted, else the latest. */
  latestSession(id: string): string | undefined { return this.get(id).submission?.sessionId ?? this.sessionsOf(id).at(-1); }
  /** The task's conversations, oldest first. */
  sessions(id: string): string[] { return this.sessionsOf(id); }

  /**
   * How many times in a row supervision has pushed this task (「继续」, an answer, a rework) with nothing since: no
   * delivery, no word from the owner on the task or in its conversations. Two is the most (§3).
   */
  pushesWithoutProgress(id: string): number {
    const events = this.items.events(id);
    let count = 0, since: string | undefined;
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]!;
      if (event.kind === 'nudge' || (event.kind === 'rework' && event.by === 'assistant')) { count++; since = event.at; continue; }
      if (event.kind === 'submit' || event.kind === 'answer' || (event.kind === 'rework' && !event.by) || event.kind === 'status') break;
    }
    if (!count || !since) return count;
    // The owner said something in one of its conversations after the first of those pushes.
    const placeholders = this.sessionsOf(id).map(() => '?').join(',');
    if (!placeholders) return count;
    const typed = this.store.db.prepare(`SELECT command_id AS commandId FROM runs WHERE session_id IN (${placeholders}) AND json_extract(json,'$.createdAt')>?`).all(...this.sessionsOf(id), since) as Array<{ commandId: string }>;
    return typed.some(row => !isSystemCommand(row.commandId)) ? 0 : count;
  }

  /** Supervision's 「继续」 or answer, sent once per [commandId]. Refused after two pushes without progress. */
  nudge(id: string, message: unknown, commandId: string): WorkItem {
    const body = text(message, 'text', WORK_ITEM_LIMITS.comment);
    const item = this.get(id);
    if (this.items.event(commandId)) return item;
    if (this.pushesWithoutProgress(id) >= SUPERVISION_PUSHES) throw new AppError('SUPERVISION_LIMIT', 'This task was pushed twice without progress; report it to the owner instead', 409);
    const sessionId = this.latestSession(id);
    if (!sessionId) throw new AppError('NO_SESSION', 'This task has no conversation to send it to', 409);
    this.sendTo(sessionId, body, commandId);
    return this.write(() => {
      const current = this.get(id);
      if (!this.items.event(commandId)) this.record(id, { kind: 'nudge', sessionId, text: body }, commandId);
      return current;
    });
  }

  /** Supervision's rework, refused like a nudge after two pushes without progress. */
  superviseRework(id: string, reason: unknown, commandId: string): WorkItem {
    if (!this.items.event(commandId) && this.pushesWithoutProgress(id) >= SUPERVISION_PUSHES) throw new AppError('SUPERVISION_LIMIT', 'This task was pushed twice without progress; report it to the owner instead', 409);
    return this.rework(id, reason, commandId, 'assistant');
  }

  /**
   * Supervision's word for the owner. A delivery it checked is already waiting for 验收, so the check goes on the
   * task as a comment; anything else is 推不动: the task goes to the inbox with the judgment.
   */
  markStuck(id: string, note: string): void {
    this.write(() => {
      const current = this.items.get(id);
      if (!current || current.status === 'done' || current.status === 'cancelled') return;
      if (current.status === 'review') { this.record(id, { kind: 'comment', text: note }); this.items.update({ ...current, updatedAt: now() }); return; }
      const at = now();
      this.record(id, { kind: 'stuck', note });
      this.items.update({ ...current, stuck: { note, at }, updatedAt: at });
    });
  }

  /** Its conversation moved again: the task is no longer stuck. */
  clearStuck(id: string): void {
    const current = this.items.get(id);
    if (!current?.stuck) return;
    this.write(() => {
      const latest = this.items.get(id);
      if (!latest?.stuck) return;
      const { stuck: _stuck, ...rest } = latest;
      this.items.update({ ...rest, updatedAt: now() });
    });
  }

  private sendTo(sessionId: string, message: string, commandId: string): void {
    const messenger = this.messenger?.();
    if (!messenger) throw new AppError('SERVICE_STARTING', 'The workbench is starting', 503);
    messenger.send(sessionId, message, commandId);
  }

  /**
   * The first message of a conversation that starts this item: what it is, what done means, what
   * earlier conversations delivered and were told, and how to report.
   */
  brief(id: string): string {
    const item = this.get(id);
    const events = this.items.events(id);
    const language = languageOf([item.title, item.description ?? '', ...item.criteria ?? []]);
    const parts = [taskPart(language, 'head', { number: item.number, title: item.title })];
    if (item.description?.trim()) parts.push(taskPart(language, 'description', { text: item.description.trim() }));
    if (item.criteria?.length) parts.push(taskPart(language, 'criteria', { list: item.criteria.map((line, index) => `${index + 1}. ${line}`).join('\n') }));
    const submissions = events.flatMap(event => event.kind === 'submit' ? [event.submission] : []);
    if (submissions.length) {
      parts.push(taskPart(language, 'previous', { text: submissions.slice(-3).map(entry => {
        const files = entry.evidence.files.length ? `\n${entry.evidence.files.slice(0, 30).map(file => `  - ${file}`).join('\n')}` : '';
        return `- ${entry.at.slice(0, 16).replace('T', ' ')}: ${entry.summary.length > 1500 ? `${entry.summary.slice(0, 1500)}…` : entry.summary}${files}`;
      }).join('\n') }));
    }
    const asked = new Map(events.flatMap(event => event.kind === 'question' ? [[event.question.id, event.question.text] as const] : []));
    const answers = events.flatMap(event => event.kind === 'answer' && asked.has(event.questionId) ? [`- ${asked.get(event.questionId)}\n  ${event.text}`] : []);
    if (answers.length) parts.push(taskPart(language, 'answered', { text: answers.slice(-10).join('\n') }));
    const comments = events.flatMap(event => event.kind === 'comment' ? [`- ${event.text}`] : []);
    if (comments.length) parts.push(taskPart(language, 'comments', { text: comments.slice(-10).join('\n') }));
    parts.push(taskPart(language, 'tools'));
    return parts.join('\n\n');
  }

  /** A task made from a conversation that exists already, following that conversation's title. */
  createFromSession(session: SessionTaskSource, projectId: string | undefined): WorkItem {
    return this.write(() => {
      const item = this.create({
        title: session.title.trim().slice(0, WORK_ITEM_LIMITS.title) || 'New task', status: 'doing',
        ...(session.backendId ? { assignee: { kind: 'agent', backendId: session.backendId as NativeBackendId, ...(session.backendProfileId ? { profileId: session.backendProfileId } : {}), ...(session.model ? { model: session.model } : {}) } } : {}),
        ...(projectId ? { projectId } : {}),
      }, { source: 'session', titleSessionId: session.id, originSessionId: session.id });
      this.attachSession(session.id, item.id);
      return this.get(item.id);
    });
  }

  /**
   * Before 2026-11-16 every composer conversation opened a task (docs/TASK-BOARD.md §4.3). Those go, once,
   * unless the owner or the agent did something with them: a comment, a question, an answer, a submission,
   * a rework, or a sub-task. Their conversations stay as they are, without a task. Composer tasks made since,
   * with `workItems.composerSessions` on, are the owner's choice and stay.
   */
  dropComposerItems(): void {
    if (this.store.getSetting<boolean>(COMPOSER_DROPPED_KEY, false)) return;
    this.write(() => {
      const kept = new Set(['comment', 'question', 'answer', 'submit', 'rework']);
      const stale = this.items.all().filter(item => item.source === 'composer' && item.createdAt < COMPOSER_CUTOFF
        && !this.items.hasChildren(item.id) && !this.items.events(item.id).some(event => kept.has(event.kind)));
      for (const item of stale) this.delete(item.id);
      this.store.setSetting(COMPOSER_DROPPED_KEY, true);
    });
  }

  /**
   * The task opened with the first message of a composer conversation when the owner has that on
   * (docs/TASK-BOARD.md §4.3): the one already made for `sessionId` (a retried creation), or a new one in
   * `doing` that follows the conversation's title. Called in the creation's transaction.
   */
  ensureForComposerSession(sessionId: string, input: { text: string; backendId?: string; profileId?: string; model?: string; projectId?: string }): WorkItem {
    return this.write(() => {
      const existing = this.items.byOrigin(sessionId);
      if (existing) return existing;
      const first = input.text.split('\n').map(line => line.trim()).find(Boolean) ?? '';
      return this.create({
        title: first.slice(0, 80).trim() || 'New task', status: 'doing',
        ...(input.backendId ? { assignee: { kind: 'agent', backendId: input.backendId as NativeBackendId, ...(input.profileId ? { profileId: input.profileId } : {}), ...(input.model ? { model: input.model } : {}) } } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
      }, { source: 'composer', titleSessionId: sessionId, originSessionId: sessionId });
    });
  }
}
