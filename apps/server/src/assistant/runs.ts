import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ASSISTANT_BUDGET, DEFAULT_AGENT_MEMBER_ID, TEAM_BUDGET, assistantChoice, type AppSettings, type AssistantChoice, type AssistantJob, type AssistantRunUsage, type NativeBackendCatalogEntry, type Project, type Session, type SessionOrigin } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { assistantRunBrief } from '../prompts/index.js';
import type { Store } from '../store.js';

/*
 * The team members' background runs (docs/ASSISTANT.md §7.1, docs/TEAM.md): short conversations in a member's
 * project that do one piece of work while the owner is away and end with `run_report`. What a run found and
 * where it goes are written together, so a restart can at most repeat a push, never a run or a note.
 */

export type RunOutcome = 'silent' | 'tell' | 'ask';
type RunState = 'queued' | 'running' | 'done' | 'failed';

export interface AssistantRun {
  id: string;
  /** Owning team member id (`default` when omitted on legacy records). */
  memberId?: string;
  job: AssistantJob;
  /** One run per key: the same stop of a task, change of a delegation or night's consolidation starts nothing new. */
  key: string;
  state: RunState;
  /** The task (`supervise`) or delegation (`delegation`) it is about. */
  subject?: string;
  /** The brief's values; the text is rendered at launch. */
  brief: Record<string, string | number>;
  sessionId?: string;
  outcome?: RunOutcome;
  text?: string;
  /** An `ask` that reached a device, or found none to reach. */
  pushed?: boolean;
  error?: string;
  createdAt: string;
  /** When its conversation was opened: what the daily limit counts. */
  startedAt?: string;
  endedAt?: string;
}

export interface AssistantRunMemberTarget {
  memberId: string;
  project: Project;
  choice: AssistantChoice | undefined;
  mainSessionId?: string;
  dailyRuns: number;
}

export interface AssistantRunsDeps {
  store: Store;
  settings(): AppSettings;
  backends(): Promise<NativeBackendCatalogEntry[]>;
  project(): Project;
  /** Resolves per-member execution context (project, backend/model, main session, daily budget). */
  resolveMember?(memberId: string, backends: readonly NativeBackendCatalogEntry[]): AssistantRunMemberTarget | undefined;
  /** Resolves the current standing conversation of [memberId] for notices, pushes and pending notes. */
  mainSessionOf?(memberId: string): string | undefined;
  /** Daily background run budget for [memberId]. */
  dailyLimit?(memberId: string): number;
  /** Opens the run's conversation; the same ids return the one an earlier try made. */
  start(body: { projectId: string; agentMemberId?: string; backendId: string; backendProfileId?: string; model?: string; approval: string; title: string }, text: string, origin: SessionOrigin, ids: { sessionId: string; commandId: string }): Promise<Session>;
  archive(sessionId: string): Promise<void> | void;
  remove(sessionId: string): Promise<void> | void;
  /** In the report's write: the supervised task goes to the inbox's 推不动. */
  markStuck(workItemId: string, note: string): void;
  /** In the report's write: a notice in the main conversation's list, which clients show. */
  notice(sessionId: string, body: string): void;
  /** After the write: an alert on the owner's phone; true when a device took it or none could. */
  push(sessionId: string, body: string, key: string): Promise<boolean>;
  /** Asked as a queued run's turn comes: false when its switch went off or what it was for has moved on, and it ends unstarted. */
  wanted?(run: AssistantRun): boolean;
}

const ACTIVE: ReadonlySet<Session['state']> = new Set(['starting', 'running', 'cancelling']);
/** A run that failed may be tried again under the same key after this long. */
const RETRY_AFTER_MS = 60 * 60_000;
/** A run still going after this long is stopped: nobody is waiting on it, and it must not hold a slot forever. */
const RUN_LIMIT_MS = 30 * 60_000;
/** Background runs never stop to ask: a tool that would need a permission is refused instead. */
const RUN_APPROVAL = 'dontAsk';
const STARTUP_SWEEP_MS = 10_000;
const DAY_MS = 24 * 60 * 60_000;
/** The window `usage` reports. */
const USAGE_DAYS = 7;
const TITLES: Record<AssistantJob, string> = { supervise: '跟进', consolidate: '记忆整理', delegation: '委托' };

export class AssistantRuns {
  private readonly db: DatabaseSync;
  private pumping = false;
  private sweepTimer?: NodeJS.Timeout;
  private readonly finishing = new Set<string>();

  constructor(private readonly deps: AssistantRunsDeps) {
    this.db = deps.store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS assistant_runs (
        id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, state TEXT NOT NULL, session_id TEXT, created_at INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS assistant_runs_state ON assistant_runs(state, created_at);
      CREATE INDEX IF NOT EXISTS assistant_runs_session ON assistant_runs(session_id);
      CREATE TABLE IF NOT EXISTS assistant_pending (
        id INTEGER PRIMARY KEY, run_id TEXT, member_id TEXT NOT NULL DEFAULT 'default', text TEXT NOT NULL, created_at INTEGER NOT NULL, offered_at INTEGER);`);
    const columns = this.db.prepare('PRAGMA table_info(assistant_pending)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'member_id')) {
      this.db.exec(`ALTER TABLE assistant_pending ADD COLUMN member_id TEXT NOT NULL DEFAULT '${DEFAULT_AGENT_MEMBER_ID}'`);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS assistant_pending_member ON assistant_pending(member_id, id);');
  }

  // ---- Records ---------------------------------------------------------------------------------

  private write(run: AssistantRun): void {
    this.db.prepare('INSERT INTO assistant_runs(id,key,state,session_id,created_at,json) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET key=excluded.key,state=excluded.state,session_id=excluded.session_id,json=excluded.json')
      .run(run.id, run.key, run.state, run.sessionId ?? null, Date.parse(run.createdAt), JSON.stringify(run));
  }
  private parse(row: unknown): AssistantRun | undefined {
    if (!row) return undefined;
    const parsed = JSON.parse((row as { json: string }).json) as AssistantRun;
    return { memberId: DEFAULT_AGENT_MEMBER_ID, ...parsed };
  }
  private ownerOf(run: Pick<AssistantRun, 'memberId'>): string {
    return run.memberId || DEFAULT_AGENT_MEMBER_ID;
  }
  get(id: string): AssistantRun | undefined { return this.parse(this.db.prepare('SELECT json FROM assistant_runs WHERE id=?').get(id)); }
  private byKey(key: string): AssistantRun | undefined { return this.parse(this.db.prepare('SELECT json FROM assistant_runs WHERE key=?').get(key)); }
  bySession(sessionId: string): AssistantRun | undefined { return this.parse(this.db.prepare('SELECT json FROM assistant_runs WHERE session_id=?').get(sessionId)); }
  private inState(state: RunState): AssistantRun[] { return this.db.prepare('SELECT json FROM assistant_runs WHERE state=? ORDER BY created_at').all(state).map(row => this.parse(row)!); }
  /** The latest runs, newest first. */
  recent(limit = 20, memberId?: string): AssistantRun[] {
    if (!memberId) {
      return this.db.prepare('SELECT json FROM assistant_runs ORDER BY created_at DESC LIMIT ?').all(limit).map(row => this.parse(row)!);
    }
    return this.db.prepare("SELECT json FROM assistant_runs WHERE COALESCE(json_extract(json,'$.memberId'), ?) = ? ORDER BY created_at DESC LIMIT ?").all(DEFAULT_AGENT_MEMBER_ID, memberId, limit).map(row => this.parse(row)!);
  }

  /** Whether [session] is one of these runs: it is not the main conversation, and nothing is pushed for it. */
  static isRun(session: Pick<Session, 'origin'>): boolean { return session.origin?.kind === 'assistant'; }

  // ---- Starting --------------------------------------------------------------------------------

  /**
   * Queues a run unless one already has [key]. A failed one is tried again after an hour; anything else under
   * the key means this piece of work is done or under way. Returns the run, new or not.
   */
  enqueue(job: AssistantJob, key: string, brief: Record<string, string | number>, subject?: string, memberId = DEFAULT_AGENT_MEMBER_ID): AssistantRun {
    const existing = this.byKey(key);
    if (existing && !(existing.state === 'failed' && Date.now() - Date.parse(existing.endedAt ?? existing.createdAt) > RETRY_AFTER_MS)) return existing;
    const owner = memberId || DEFAULT_AGENT_MEMBER_ID;
    const run: AssistantRun = { id: existing?.id ?? randomUUID(), memberId: owner, job, key, state: 'queued', brief, ...(subject ? { subject } : {}), createdAt: new Date().toISOString() };
    // A retry keeps the id but not the old conversation: it starts a new one.
    this.write(run);
    this.deps.store.afterTransaction(committed => { if (committed) void this.pump(); });
    return run;
  }

  /** Whether a run was ever queued under [key]. */
  has(key: string): boolean { return Boolean(this.byKey(key)); }

  /** Whether a run of [job] about [subject] is waiting or going. */
  pending(job: AssistantJob, subject: string): boolean {
    return [...this.inState('queued'), ...this.inState('running')].some(run => run.job === job && run.subject === subject);
  }

  /** How many runs of [job] about [subject] are waiting or going. */
  pendingCount(job: AssistantJob, subject: string): number {
    return [...this.inState('queued'), ...this.inState('running')].filter(run => run.job === job && run.subject === subject).length;
  }

  /** Starts queued runs while there is global and per-member concurrency/daily-budget room. */
  async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (true) {
        const running = this.inState('running');
        if (running.length >= TEAM_BUDGET.concurrentRuns) break;
        const queued = this.inState('queued');
        if (!queued.length) break;
        const runningByMember = new Map<string, number>();
        for (const active of running) {
          if (active.outcome) continue;
          const owner = this.ownerOf(active);
          runningByMember.set(owner, (runningByMember.get(owner) ?? 0) + 1);
        }
        const since = Date.now() - DAY_MS;
        let launched = false;
        for (const next of queued) {
          if (this.deps.wanted && !this.deps.wanted(next)) {
            this.write({ ...next, state: 'done', outcome: 'silent', error: 'No longer needed', endedAt: new Date().toISOString() });
            launched = true;
            break;
          }
          const owner = this.ownerOf(next);
          if ((runningByMember.get(owner) ?? 0) >= TEAM_BUDGET.memberConcurrentRuns) continue;
          if (this.startedSince(since, owner) >= this.limit(owner)) continue;
          await this.launch(next);
          launched = true;
          break;
        }
        if (!launched) break;
      }
    } finally { this.pumping = false; }
  }

  private limit(memberId = DEFAULT_AGENT_MEMBER_ID): number {
    if (this.deps.dailyLimit) return this.deps.dailyLimit(memberId);
    return this.deps.settings().assistant?.dailyRuns ?? ASSISTANT_BUDGET.dailyRuns;
  }

  private startedSince(at: number, memberId?: string): number {
    const iso = new Date(at).toISOString();
    if (!memberId) {
      return (this.db.prepare("SELECT COUNT(*) AS n FROM assistant_runs WHERE json_extract(json,'$.startedAt') >= ?").get(iso) as { n: number }).n;
    }
    return (this.db.prepare("SELECT COUNT(*) AS n FROM assistant_runs WHERE json_extract(json,'$.startedAt') >= ? AND COALESCE(json_extract(json,'$.memberId'), ?) = ?").get(iso, DEFAULT_AGENT_MEMBER_ID, memberId) as { n: number }).n;
  }

  /** What the background runs cost lately, for the settings or member page. Tokens are what their conversations reported. */
  usage(memberId?: string): AssistantRunUsage {
    const since = new Date(Date.now() - USAGE_DAYS * DAY_MS).toISOString();
    const filter = memberId ? " AND COALESCE(json_extract(r.json,'$.memberId'), ?) = ?" : '';
    const params = memberId ? [since, DEFAULT_AGENT_MEMBER_ID, memberId] : [since];
    const rows = this.db.prepare(`SELECT job, COUNT(*) AS runs, COALESCE(SUM(tokens),0) AS tokens FROM (
        SELECT json_extract(r.json,'$.job') AS job, (SELECT SUM(COALESCE(u.input_tokens,0)+COALESCE(u.cache_read_tokens,0)+COALESCE(u.cache_write_tokens,0)+COALESCE(u.output_tokens,0))
          FROM usage_steps u WHERE u.session_id = r.session_id AND u.suppressed_by IS NULL) AS tokens
        FROM assistant_runs r WHERE json_extract(r.json,'$.startedAt') >= ?${filter}) GROUP BY job`).all(...params) as Array<{ job: AssistantJob; runs: number; tokens: number }>;
    const waiting = memberId ? this.inState('queued').filter(run => this.ownerOf(run) === memberId).length : this.inState('queued').length;
    return { days: USAGE_DAYS, jobs: rows, started: this.startedSince(Date.now() - DAY_MS, memberId), limit: this.limit(memberId), waiting };
  }

  private resolveMainSession(memberId: string, override?: string): string | undefined {
    if (override) return override;
    if (this.deps.mainSessionOf) return this.deps.mainSessionOf(memberId);
    return memberId === DEFAULT_AGENT_MEMBER_ID ? this.mainSession() : undefined;
  }

  private async launch(run: AssistantRun): Promise<void> {
    const ids = { sessionId: run.sessionId ?? `assistant-run-${run.id}-${randomUUID().slice(0, 8)}`, commandId: `assistant-run-${run.id}` };
    // The conversation's id is written first, so a restart during the launch finds the same one.
    this.write({ ...run, state: 'running', sessionId: ids.sessionId, startedAt: run.startedAt ?? new Date().toISOString() });
    try {
      const owner = this.ownerOf(run);
      const backends = await this.deps.backends();
      const target = this.deps.resolveMember?.(owner, backends);
      if (this.deps.resolveMember && !target) throw new AppError('TEAM_MEMBER_NOT_FOUND', `Team member ${owner} is unavailable`);
      const choice = target ? target.choice : assistantChoice(this.deps.settings().assistant, backends);
      if (!choice) throw new AppError('ASSISTANT_UNAVAILABLE', 'No agent can run this member');
      const project = target ? target.project : this.deps.project();
      await this.deps.start(
        { projectId: project.id, agentMemberId: owner, backendId: choice.backendId, ...(choice.profileId ? { backendProfileId: choice.profileId } : {}), ...(choice.model ? { model: choice.model } : {}), approval: RUN_APPROVAL, title: TITLES[run.job] },
        assistantRunBrief(run.job, run.brief),
        { kind: 'assistant', job: run.job, assistantRunId: run.id },
        ids,
      );
    } catch (error) {
      this.fail(run.id, error instanceof Error ? error.message : String(error));
    }
  }

  private fail(id: string, error: string): void {
    const run = this.get(id);
    if (!run || run.state === 'done' || run.state === 'failed') return;
    this.write({ ...run, state: 'failed', error: error.slice(0, 2000), endedAt: new Date().toISOString() });
  }

  // ---- Reporting -------------------------------------------------------------------------------

  /**
   * `run_report` from the run's conversation. The outcome and where it goes are one write; a second report of
   * the same run returns the first. The push, for `ask`, follows the write.
   */
  report(sessionId: string, outcome: RunOutcome, text: string | undefined, mainSessionId?: string): AssistantRun {
    const run = this.bySession(sessionId);
    if (!run) throw new AppError('NOT_A_RUN', 'run_report is for background runs');
    if (run.outcome) return run;
    if (outcome !== 'silent' && !text?.trim()) throw new AppError('INVALID_ARGUMENT', 'text is required unless the outcome is silent');
    const clean = text?.trim().slice(0, 2000);
    const owner = this.ownerOf(run);
    const targetMain = this.resolveMainSession(owner, mainSessionId);
    const reported: AssistantRun = { ...run, outcome, ...(clean ? { text: clean } : {}), ...(outcome === 'ask' ? { pushed: false } : {}) };
    this.deps.store.transaction(() => {
      this.write(reported);
      if (outcome === 'silent' || !clean) return;
      if (outcome === 'ask' && run.job === 'supervise' && run.subject) { this.deps.markStuck(run.subject, clean); return; }
      this.addPending(run.id, clean, owner);
      if ((outcome === 'ask' || outcome === 'tell') && targetMain) this.deps.notice(targetMain, clean);
    });
    if (outcome === 'ask') void this.deliverPush(reported, targetMain);
    return reported;
  }

  private async deliverPush(run: AssistantRun, mainSessionId: string | undefined): Promise<void> {
    if (!mainSessionId || !run.text) return;
    let pushed = false;
    try { pushed = await this.deps.push(mainSessionId, run.text, `assistant-run-${run.id}`); } catch { pushed = false; }
    // The server may have closed while the push was out; the next start pushes it again.
    try {
      const current = this.get(run.id);
      if (current && pushed) this.write({ ...current, pushed: true });
    } catch { /* closed */ }
  }

  // ---- Ending ----------------------------------------------------------------------------------

  /** Follows the runs' conversations: one that stops ends its run. Returns the way to stop. */
  watch(): () => void {
    const off = this.deps.store.onSessionState((session, from) => {
      if (!AssistantRuns.isRun(session) || ACTIVE.has(session.state)) return;
      if (!ACTIVE.has(from) && from !== 'waiting' && session.state !== 'waiting') return;
      // Never inside the write that made the change: ending a run archives its conversation.
      setImmediate(() => { void this.finish(session.id); });
    });
    this.sweepTimer = setInterval(() => { void this.sweep(); }, 60_000);
    this.sweepTimer.unref?.();
    // The first look waits for the rest of the server to come up: backends, pushes, the conversations' own recovery.
    const first = setTimeout(() => { void this.sweep(); }, STARTUP_SWEEP_MS);
    first.unref?.();
    return () => { off(); clearTimeout(first); if (this.sweepTimer) clearInterval(this.sweepTimer); };
  }

  private async finish(sessionId: string): Promise<void> {
    const run = this.bySession(sessionId);
    if (!run || run.state !== 'running' || this.finishing.has(run.id)) return;
    let session: Session | undefined;
    try { session = this.deps.store.getSession(sessionId); } catch { session = undefined; }
    if (session && !this.settled(session)) return;
    this.finishing.add(run.id);
    try {
      // A run that never reported has nothing to say; one that stopped on a question it may not ask, or on an
      // error, failed.
      const failed = !run.outcome && (!session || session.state === 'failed' || session.state === 'waiting');
      this.write({ ...run, state: failed ? 'failed' : 'done', ...(run.outcome ? {} : { outcome: 'silent' as const }), ...(failed ? { error: session?.error ?? (session?.state === 'waiting' ? 'Stopped on a prompt nobody answers' : 'Its conversation is gone') } : {}), endedAt: new Date().toISOString() });
      if (session && !session.archivedAt) { try { await this.deps.archive(sessionId); } catch { /* the next sweep */ } }
    } finally { this.finishing.delete(run.id); }
    await this.prune();
    void this.pump();
  }

  /**
   * The run's work is over: its turns all ended, not just the conversation's state, which passes through `idle` while
   * its CLI starts. One that stopped on a prompt nobody answers is over too.
   */
  private settled(session: Session): boolean {
    if (session.state === 'waiting') return true;
    if (ACTIVE.has(session.state)) return false;
    const runs = this.deps.store.listRuns(session.id);
    return runs.length > 0 && !this.deps.store.listUnfinishedNativeRuns(session.id).some(run => !run.native?.queueReleasedAt) && runs.every(run => ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.state));
  }

  /**
   * After a restart and once a minute: runs whose conversation stopped while nobody watched end now, an `ask`
   * whose push did not go out is pushed, and a run going far too long is ended.
   */
  async sweep(): Promise<void> {
    for (const run of this.inState('running')) {
      if (!run.sessionId) { this.fail(run.id, 'Never started'); continue; }
      let session: Session | undefined;
      try { session = this.deps.store.getSession(run.sessionId); } catch { session = undefined; }
      if (!session) {
        // Written as running before its conversation was made: the launch did not finish.
        if (Date.now() - Date.parse(run.createdAt) > 60_000) { this.write({ ...run, state: 'queued' }); }
        continue;
      }
      if (this.settled(session)) await this.finish(run.sessionId);
      else if (Date.now() - Date.parse(session.createdAt) > RUN_LIMIT_MS) {
        this.fail(run.id, 'Took too long');
        try { await this.deps.archive(run.sessionId); } catch { /* the next sweep */ }
      }
    }
    for (const run of this.db.prepare("SELECT json FROM assistant_runs WHERE json LIKE '%\"pushed\":false%'").all().map(row => this.parse(row)!)) {
      if (run.outcome !== 'ask' || run.pushed !== false) continue;
      if (Date.now() - Date.parse(run.createdAt) > USAGE_DAYS * DAY_MS) {
        this.write({ ...run, pushed: true });
        continue;
      }
      await this.deliverPush(run, this.resolveMainSession(this.ownerOf(run)));
    }
    void this.pump();
  }

  /** Set by `app.ts`: legacy fallback for the default member's main conversation. */
  mainSession: () => string | undefined = () => undefined;

  /** Keeps the newest finished records; the rest go with their conversations. */
  private async prune(): Promise<void> {
    const old = this.db.prepare("SELECT json FROM assistant_runs WHERE state IN ('done','failed') ORDER BY created_at DESC LIMIT -1 OFFSET ?").all(ASSISTANT_BUDGET.keptRuns).map(row => this.parse(row)!);
    for (const run of old) {
      if (run.sessionId) { try { await this.deps.remove(run.sessionId); } catch { continue; } }
      this.db.prepare('DELETE FROM assistant_runs WHERE id=?').run(run.id);
    }
  }

  // ---- Pending notes per member's main conversation (§7.1) -------------------------------------

  /** A note the member's main conversation is told at the owner's next message. Past the budget the oldest goes. */
  addPending(runId: string | undefined, text: string, memberId = DEFAULT_AGENT_MEMBER_ID): void {
    const owner = memberId || DEFAULT_AGENT_MEMBER_ID;
    this.db.prepare('INSERT INTO assistant_pending(run_id,member_id,text,created_at) VALUES(?,?,?,?)').run(runId ?? null, owner, text, Date.now());
    this.db.prepare('DELETE FROM assistant_pending WHERE member_id=? AND id NOT IN (SELECT id FROM assistant_pending WHERE member_id=? ORDER BY id DESC LIMIT ?)').run(owner, owner, ASSISTANT_BUDGET.pendingNotices);
  }

  /** The notes not yet carried by a turn that ended well for [memberId], oldest first; they are marked as offered. */
  offerPending(memberId = DEFAULT_AGENT_MEMBER_ID): Array<{ text: string; at: number }> {
    const owner = memberId || DEFAULT_AGENT_MEMBER_ID;
    const rows = this.db.prepare('SELECT id, text, created_at AS at FROM assistant_pending WHERE member_id=? ORDER BY id').all(owner) as Array<{ id: number; text: string; at: number }>;
    if (rows.length) this.db.prepare('UPDATE assistant_pending SET offered_at=? WHERE member_id=? AND offered_at IS NULL').run(Date.now(), owner);
    return rows.map(({ text, at }) => ({ text, at }));
  }

  /** The turn that carried the offered notes ended: well, and they are gone; otherwise the next message carries them again. */
  settlePending(delivered: boolean, memberId = DEFAULT_AGENT_MEMBER_ID): void {
    const owner = memberId || DEFAULT_AGENT_MEMBER_ID;
    if (delivered) this.db.prepare('DELETE FROM assistant_pending WHERE member_id=? AND offered_at IS NOT NULL').run(owner);
    else this.db.prepare('UPDATE assistant_pending SET offered_at=NULL WHERE member_id=?').run(owner);
  }

  /** Drops any queued pending notes for a deleted member. */
  clearPending(memberId: string): void {
    this.db.prepare('DELETE FROM assistant_pending WHERE member_id=?').run(memberId);
  }
}
