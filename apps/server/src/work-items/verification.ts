import type { NativeBackendId, Session, WorkItem, WorkItemVerification } from '../../../../packages/contracts/src/index.js';
import { taskVerifyBrief } from '../prompts/index.js';
import type { Store } from '../store.js';
import type { WorkItemService } from './service.js';

/*
 * 核验 (docs/TASK-BOARD.md §6.1): when a task's conversation submits, the Agent set as 核验 checks the work read-only,
 * as a call made on behalf of that conversation. Its answer goes on the task for the owner (and for 跟进), never back
 * to the conversation that submitted.
 */

const ENDED = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const STOPPED: ReadonlySet<Session['state']> = new Set(['idle', 'failed', 'interrupted']);
const STARTUP_LOOK_MS = 15_000;
const LISTED = 40;

export interface VerifierChoice { backendId: NativeBackendId; profileId?: string; model?: string }

export interface VerificationDeps {
  store: Store;
  workItems: WorkItemService;
  /** `AppSettings.workItems.verifier`; unset, nothing is checked. */
  verifier(): VerifierChoice | undefined;
  /** Opens the read-only call on behalf of [callerSessionId] (`AgentCallService.consultFor`). */
  consult(callerSessionId: string, target: VerifierChoice, prompt: string, text: string): Promise<{ sessionId: string; runId: string }>;
  answer(sessionId: string, runId: string): Promise<string>;
  /** A check ended, or could not start: 跟进 may look at the task now. */
  checked?(workItemId: string): void;
  log?(message: string, fields: Record<string, unknown>): void;
}

/** The verdict on the first line of the answer: `结论：通过` and the like. */
export function verdictOf(answer: string): NonNullable<WorkItemVerification['verdict']> {
  const first = answer.split('\n').map(line => line.trim()).find(Boolean) ?? '';
  if (/不通过|未通过|\bfail/i.test(first)) return 'fail';
  if (/无法判断|unclear|cannot tell/i.test(first)) return 'unclear';
  if (/通过|\bpass/i.test(first)) return 'pass';
  return 'unclear';
}

export class Verification {
  /** Tasks whose check is being opened. */
  private readonly opening = new Set<string>();
  /** Tasks submitted again while their check was being opened: checked again once it is. */
  private readonly again = new Set<string>();
  /** Running checks: their conversation to the task. Rebuilt from the tasks at start. */
  private readonly running = new Map<string, string>();
  private readonly settling = new Set<string>();

  constructor(private readonly deps: VerificationDeps) {}

  start(): () => void {
    const offSubmit = this.deps.workItems.onSubmit(id => { void this.begin(id); });
    // Whichever of the run's end and the conversation's stop is written last finds both.
    const offState = this.deps.store.onSessionState(session => {
      if (session.origin?.kind !== 'call') return;
      if (STOPPED.has(session.state)) void this.settle(session.id);
      // Stopped on an approval: the owner has it, and 跟进 need not wait for it.
      const itemId = session.state === 'waiting' ? this.running.get(session.id) : undefined;
      if (itemId) setImmediate(() => this.deps.checked?.(itemId));
    });
    const offRun = this.deps.store.onRunChanged(run => { if (ENDED.has(run.state)) void this.settle(run.sessionId); });
    // Checks whose conversation ended while the server was stopped.
    for (const item of this.deps.workItems.list()) if (item.verification?.state === 'running' && item.verification.sessionId) this.running.set(item.verification.sessionId, item.id);
    const first = setTimeout(() => { for (const sessionId of [...this.running.keys()]) void this.settle(sessionId); }, STARTUP_LOOK_MS);
    first.unref?.();
    return () => { offSubmit(); offState(); offRun(); clearTimeout(first); };
  }

  /** The latest submission of [id] is being checked. */
  verifying(id: string): boolean {
    if (this.opening.has(id)) return true;
    let item: WorkItem;
    try { item = this.deps.workItems.get(id); } catch { return false; }
    const check = item.verification;
    if (check?.state !== 'running' || check.submittedAt !== item.submission?.at) return false;
    try { return !check.sessionId || this.deps.store.getSession(check.sessionId).state !== 'waiting'; } catch { return false; }
  }

  private async begin(id: string): Promise<void> {
    const target = this.deps.verifier();
    if (!target) return;
    if (this.opening.has(id)) { this.again.add(id); return; }
    let item: WorkItem;
    try { item = this.deps.workItems.get(id); } catch { return; }
    const submission = item.submission;
    if (!submission || item.status !== 'review') return;
    this.opening.add(id);
    const at = new Date().toISOString();
    const base = { submittedAt: submission.at, backendId: target.backendId, ...(target.model ? { model: target.model } : {}), at };
    try {
      const { sessionId } = await this.deps.consult(submission.sessionId, target, `核验任务 #${item.number}：${item.title}`, this.brief(item));
      this.running.set(sessionId, id);
      this.deps.workItems.beginVerification(id, { ...base, sessionId, state: 'running' });
      // A turn that ended while this was being recorded.
      void this.settle(sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log?.('task check: could not start', { workItemId: id, error: message });
      this.deps.workItems.beginVerification(id, { ...base, state: 'failed', text: `没能开始核验：${message}`, endedAt: at });
      this.deps.checked?.(id);
    } finally {
      this.opening.delete(id);
      if (this.again.delete(id)) {
        let latest: WorkItem | undefined;
        try { latest = this.deps.workItems.get(id); } catch { /* removed */ }
        if (latest?.submission && latest.submission.at !== submission.at) void this.begin(id);
      }
    }
  }

  /** A called conversation stopped: when it is a running check, its first turn's answer goes on the task. */
  private async settle(sessionId: string): Promise<void> {
    if (!this.running.size) return;
    const itemId = this.running.get(sessionId);
    if (!itemId || this.settling.has(sessionId)) return;
    const run = this.deps.store.listRuns(sessionId)[0];
    if (!run || !ENDED.has(run.state)) return;
    this.settling.add(sessionId);
    try { await this.finish(itemId, sessionId, run); } finally { this.settling.delete(sessionId); }
  }

  private async finish(itemId: string, sessionId: string, run: { id: string; state: string }): Promise<void> {
    let text = '';
    try { text = await this.deps.answer(sessionId, run.id); } catch (error) { this.deps.log?.('task check: could not read the answer', { sessionId, error: error instanceof Error ? error.message : String(error) }); }
    const done = run.state === 'completed' && Boolean(text);
    this.running.delete(sessionId);
    const finished = this.deps.workItems.finishVerification(itemId, sessionId, {
      state: done ? 'done' : 'failed', ...(done ? { verdict: verdictOf(text) } : {}), ...(text ? { text } : {}),
    });
    if (finished) this.deps.checked?.(itemId);
  }

  private brief(item: WorkItem): string {
    const submission = item.submission!;
    const criteria = item.criteria ?? [];
    return taskVerifyBrief({
      number: item.number,
      title: item.title,
      description: item.description?.trim() || '（没有描述）',
      criteria: criteria.length ? criteria.map((line, index) => `${index + 1}. ${line}`).join('\n') : '（没有写验收标准：按任务描述判断）',
      summary: submission.summary,
      claims: submission.criteria.length
        ? submission.criteria.map((entry, index) => `${index + 1}. ${entry.met === true ? '达成' : entry.met === false ? '未达成' : '未说明'}${entry.note ? `：${entry.note}` : ''}`).join('\n')
        : '（没有逐条说明）',
      files: submission.evidence.files.length ? submission.evidence.files.slice(0, LISTED).map(file => `- ${file}`).join('\n') : '（没有记录到）',
      commands: submission.evidence.commands.length
        ? submission.evidence.commands.slice(-LISTED).map(command => `- ${command.command} → ${command.exitCode !== undefined ? `退出码 ${command.exitCode}` : command.result}`).join('\n')
        : '（没有记录到）',
    });
  }
}
