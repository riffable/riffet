import type { Session, WorkItem } from '../../../../packages/contracts/src/index.js';
import type { Store } from '../store.js';
import { isSystemCommand, type WorkItemService } from './service.js';

/*
 * 跟进's trigger (docs/TASK-BOARD.md §3, docs/ASSISTANT.md §7.2): a task's conversation stopped, the owner is away,
 * and nothing is already on its way. What to do about it is the background run's; this only decides when to start one
 * and hands it what it needs to know.
 */

const ACTIVE: ReadonlySet<Session['state']> = new Set(['starting', 'running', 'cancelling']);
const STOPPED: ReadonlySet<Session['state']> = new Set(['idle', 'failed', 'interrupted']);
/** Changes of one task this close together are one look. */
const SETTLE_MS = 30_000;
/** The owner wrote somewhere this recently: they are here, and supervision stays out of the way. */
const PRESENT_MS = 10 * 60_000;
/** Of the stopped conversation, what the brief quotes. */
const QUOTED_MESSAGES = 8;
/**
 * After a start, stops this recent are looked at again: the wait before a look lives in memory, and a restart during
 * it loses the stop. Older ones are left alone, so turning 跟进 on does not start a run for every task that ever stopped.
 */
const RESTART_LOOKBACK_MS = 60 * 60_000;
const STARTUP_LOOK_MS = 15_000;
const QUOTED_CHARS = 1_500;

export interface SupervisionDeps {
  store: Store;
  workItems: WorkItemService;
  /** The setting (docs/ASSISTANT.md §7.2); off unless switched on. */
  enabled(): boolean;
  /** Queues the run; a key already used starts nothing. */
  enqueue(key: string, brief: Record<string, string | number>, workItemId: string): void;
  /** A supervision run for this task is waiting or going. */
  pending(workItemId: string): boolean;
  /** Its latest submission is being checked by the 核验 Agent (docs/TASK-BOARD.md §6.1); the check's end looks again. */
  verifying?(workItemId: string): boolean;
  agentLabel(backendId: string | undefined): string;
}

export class Supervision {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: SupervisionDeps) {}

  start(): () => void {
    const off = this.deps.store.onSessionState((session, from) => {
      const id = session.workItemId;
      if (!id || session.kind !== 'native' || this.inSystemProject(session)) return;
      if (ACTIVE.has(session.state)) {
        // It moved again: nothing to look at, and it is no longer stuck.
        this.cancel(id);
        setImmediate(() => { try { this.deps.workItems.clearStuck(id); } catch { /* a removed task */ } });
        return;
      }
      if (STOPPED.has(session.state) && (ACTIVE.has(from) || from === 'waiting')) this.schedule(id, SETTLE_MS);
    });
    const first = setTimeout(() => { try { this.lookAgain(); } catch (error) { console.warn('[riffet] supervision sweep failed', error instanceof Error ? error.message : error); } }, STARTUP_LOOK_MS);
    first.unref?.();
    return () => { off(); clearTimeout(first); for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); };
  }

  /** The open tasks whose conversation stopped shortly before this start; the run key keeps a stop already handled from starting again. */
  private lookAgain(): void {
    if (!this.deps.enabled()) return;
    const since = Date.now() - RESTART_LOOKBACK_MS;
    for (const item of this.deps.workItems.list()) {
      if (item.status === 'done' || item.status === 'cancelled' || item.status === 'watching' || this.timers.has(item.id)) continue;
      const sessionId = this.deps.workItems.latestSession(item.id);
      if (!sessionId) continue;
      let session: Session;
      try { session = this.deps.store.getSession(sessionId); } catch { continue; }
      if (STOPPED.has(session.state) && !this.inSystemProject(session) && Date.parse(session.updatedAt) >= since) this.schedule(item.id, SETTLE_MS);
    }
  }

  /** Whether a queued run for this task, made for the stop in [key], still has something to look at. */
  wanted(id: string, key: string): boolean {
    if (!this.deps.enabled()) return false;
    let item: WorkItem;
    try { item = this.deps.workItems.get(id); } catch { return false; }
    if (item.status === 'done' || item.status === 'cancelled' || item.status === 'watching') return false;
    const sessionId = this.deps.workItems.latestSession(id);
    if (!sessionId) return false;
    try {
      const session = this.deps.store.getSession(sessionId);
      return STOPPED.has(session.state) && key === this.key(id, session);
    } catch { return false; }
  }

  private key(id: string, session: Session): string { return `supervise:${id}:${this.deps.store.listRuns(session.id).at(-1)?.id ?? session.updatedAt}`; }

  private inSystemProject(session: Session): boolean {
    try { return Boolean(this.deps.store.getProject(session.projectId).system); } catch { return true; }
  }

  /** A check of the task's submission ended: look at it once things settle, as after a stop. */
  checked(id: string): void { if (this.deps.enabled()) this.schedule(id, 1_000); }

  private cancel(id: string): void { const timer = this.timers.get(id); if (timer) clearTimeout(timer); this.timers.delete(id); }

  private schedule(id: string, delay: number): void {
    this.cancel(id);
    const timer = setTimeout(() => { this.timers.delete(id); try { this.look(id); } catch (error) { console.warn('[riffet] supervision failed', id, error instanceof Error ? error.message : error); } }, delay);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  /** When the owner last wrote a message themselves, in any conversation; wake-ups and the server's own turns do not count. */
  private ownerWroteAt(): number | undefined {
    const rows = this.deps.store.db.prepare("SELECT command_id AS commandId, json_extract(json,'$.createdAt') AS at FROM runs ORDER BY rowid DESC LIMIT 200").all() as Array<{ commandId: string; at: string }>;
    const typed = rows.find(row => !isSystemCommand(row.commandId));
    return typed ? Date.parse(typed.at) : undefined;
  }

  private look(id: string): void {
    if (!this.deps.enabled()) return;
    let item: WorkItem;
    try { item = this.deps.workItems.get(id); } catch { return; }
    // Closed, parked in watching, already waiting on the owner (a question, 推不动), or already being looked at.
    if (item.status === 'done' || item.status === 'cancelled' || item.status === 'watching' || item.questions?.length || item.stuck || this.deps.pending(id)) return;
    if (item.status === 'review' && this.deps.verifying?.(id)) return;
    const sessionId = this.deps.workItems.latestSession(id);
    if (!sessionId) return;
    const session = this.deps.store.getSession(sessionId);
    if (session.archivedAt || !STOPPED.has(session.state)) return;
    const wrote = this.ownerWroteAt();
    if (wrote !== undefined && Date.now() - wrote < PRESENT_MS) { this.schedule(id, PRESENT_MS - (Date.now() - wrote) + 1_000); return; }
    this.deps.enqueue(this.key(id, session), this.brief(item, session), id);
  }

  private brief(item: WorkItem, session: Session): Record<string, string | number> {
    const messages = this.deps.store.indexedMessages(session.id).slice(-QUOTED_MESSAGES)
      .map(message => `[${message.at.slice(0, 16).replace('T', ' ')}] ${message.kind === 'user' ? '收到' : '回复'}：${clip(message.text.trim(), QUOTED_CHARS)}`).join('\n\n');
    const submission = item.submission;
    return {
      number: item.number,
      title: item.title,
      status: { todo: '待办', doing: '进行中', watching: '观测中', review: '待验收', done: '完成', cancelled: '无需关注' }[item.status],
      criteria: item.criteria?.length ? item.criteria.map((line, index) => `${index + 1}. ${line}`).join('\n') : '（没有写验收标准）',
      // The check rides in `submission`: a brief queued before checks existed has no other variable for it.
      submission: submission ? `${submission.at.slice(0, 16).replace('T', ' ')}：${clip(submission.summary, 2_000)}（逐条说明和证据用 task_get 看）\n\n核验（另一个 Agent 读过仓库后的结论）：${verificationNote(item)}` : '（还没有交付）',
      sessionId: session.id,
      agent: this.deps.agentLabel(session.backendId),
      state: { idle: '停下', failed: '出错', interrupted: '被中断' }[session.state as 'idle' | 'failed' | 'interrupted'] ?? session.state,
      stopNote: session.state === 'failed' && session.error ? `错误：${clip(session.error, 500)}` : '',
      messages: messages || '（没有消息）',
    };
  }
}

function clip(text: string, limit: number): string { return text.length > limit ? `${text.slice(0, limit)} […]` : text; }

function verificationNote(item: WorkItem): string {
  const check = item.verification;
  if (!check || check.submittedAt !== item.submission?.at) return '（没有核验）';
  if (check.state === 'failed') return '（核验没有完成）';
  if (check.state === 'running') return '（核验还在进行）';
  return `${{ pass: '通过', fail: '不通过', unclear: '无法判断' }[check.verdict ?? 'unclear']}。\n${clip(check.text ?? '', 3_000)}`;
}
