import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ASSISTANT_BUDGET, assistantChoice, type AppSettings, type AssistantJob, type AssistantRunUsage, type NativeBackendCatalogEntry, type Project, type Session, type SessionOrigin } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { assistantRunBrief } from '../prompts/index.js';
import type { Store } from '../store.js';

/*
 * The 助理's background runs (docs/ASSISTANT.md §7.1): short conversations in its project that do one piece of
 * work while the owner is away and end with `run_report`. What a run found and where it goes are written together,
 * so a restart can at most repeat a push, never a run or a note.
 */

export type RunOutcome = 'silent' | 'tell' | 'ask';
type RunState = 'queued' | 'running' | 'done' | 'failed';

export interface AssistantRun {
  id: string;
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

export interface AssistantRunsDeps {
  store: Store;
  settings(): AppSettings;
  backends(): Promise<NativeBackendCatalogEntry[]>;
  project(): Project;
  /** Opens the run's conversation; the same ids return the one an earlier try made. */
  start(body: { projectId: string; backendId: string; backendProfileId?: string; model?: string; approval: string; title: string }, text: string, origin: SessionOrigin, ids: { sessionId: string; commandId: string }): Promise<Session>;
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
        id INTEGER PRIMARY KEY, run_id TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL, offered_at INTEGER);`);
  }

  // ---- Records ---------------------------------------------------------------------------------

  private write(run: AssistantRun): void {
    this.db.prepare('INSERT INTO assistant_runs(id,key,state,session_id,created_at,json) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET key=excluded.key,state=excluded.state,session_id=excluded.session_id,json=excluded.json')
      .run(run.id, run.key, run.state, run.sessionId ?? null, Date.parse(run.createdAt), JSON.stringify(run));
  }
  private parse(row: unknown): AssistantRun | undefined { return row ? JSON.parse((row as { json: string }).json) as AssistantRun : undefined; }
  get(id: string): AssistantRun | undefined { return this.parse(this.db.prepare('SELECT json FROM assistant_runs WHERE id=?').get(id)); }
  private byKey(key: string): AssistantRun | undefined { return this.parse(this.db.prepare('SELECT json FROM assistant_runs WHERE key=?').get(key)); }
  bySession(sessionId: string): AssistantRun | undefined { return this.parse(this.db.prepare('SELECT json FROM assistant_runs WHERE session_id=?').get(sessionId)); }
  private inState(state: RunState): AssistantRun[] { return this.db.prepare('SELECT json FROM assistant_runs WHERE state=? ORDER BY created_at').all(state).map(row => this.parse(row)!); }
  /** The latest runs, newest first. */
  recent(limit = 20): AssistantRun[] { return this.db.prepare('SELECT json FROM assistant_runs ORDER BY created_at DESC LIMIT ?').all(limit).map(row => this.parse(row)!); }

  /** Whether [session] is one of these runs: it is not the main conversation, and nothing is pushed for it. */
  static isRun(session: Pick<Session, 'origin'>): boolean { return session.origin?.kind === 'assistant'; }

  // ---- Starting --------------------------------------------------------------------------------

  /**
   * Queues a run unless one already has [key]. A failed one is tried again after an hour; anything else under
   * the key means this piece of work is done or under way. Returns the run, new or not.
   */
  enqueue(job: AssistantJob, key: string, brief: Record<string, string | number>, subject?: string): AssistantRun {
    const existing = this.byKey(key);
    if (existing && !(existing.state === 'failed' && Date.now() - Date.parse(existing.endedAt ?? existing.createdAt) > RETRY_AFTER_MS)) return existing;
    const run: AssistantRun = { id: existing?.id ?? randomUUID(), job, key, state: 'queued', brief, ...(subject ? { subject } : {}), createdAt: new Date().toISOString() };
    // A retry keeps the id but not the old conversation: it starts a new one.
    this.write(run);
    void this.pump();
    return run;
  }

  /** Whether a run was ever queued under [key]. */
  has(key: string): boolean { return Boolean(this.byKey(key)); }

  /** Whether a run of [job] about [subject] is waiting or going. */
  pending(job: AssistantJob, subject: string): boolean {
    return [...this.inState('queued'), ...this.inState('running')].some(run => run.job === job && run.subject === subject);
  }

  /** Starts queued runs while there is room, and while the last 24 hours have not used up the owner's limit. */
  async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.inState('running').length < ASSISTANT_BUDGET.concurrentRuns) {
        const next = this.inState('queued')[0];
        if (!next) break;
        if (this.deps.wanted && !this.deps.wanted(next)) { this.write({ ...next, state: 'done', outcome: 'silent', error: 'No longer needed', endedAt: new Date().toISOString() }); continue; }
        if (this.startedSince(Date.now() - DAY_MS) >= this.limit()) break;
        await this.launch(next);
      }
    } finally { this.pumping = false; }
  }

  private limit(): number { return this.deps.settings().assistant?.dailyRuns ?? ASSISTANT_BUDGET.dailyRuns; }

  private startedSince(at: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM assistant_runs WHERE json_extract(json,'$.startedAt') >= ?").get(new Date(at).toISOString()) as { n: number }).n;
  }

  /** What the background runs cost lately, for the settings page. Tokens are what their conversations reported. */
  usage(): AssistantRunUsage {
    const since = new Date(Date.now() - USAGE_DAYS * DAY_MS).toISOString();
    // Per run, through the steps index on the session: the runs are a few hundred at most, the steps are everyone's.
    const rows = this.db.prepare(`SELECT job, COUNT(*) AS runs, COALESCE(SUM(tokens),0) AS tokens FROM (
        SELECT json_extract(r.json,'$.job') AS job, (SELECT SUM(COALESCE(u.input_tokens,0)+COALESCE(u.cache_read_tokens,0)+COALESCE(u.cache_write_tokens,0)+COALESCE(u.output_tokens,0))
          FROM usage_steps u WHERE u.session_id = r.session_id AND u.suppressed_by IS NULL) AS tokens
        FROM assistant_runs r WHERE json_extract(r.json,'$.startedAt') >= ?) GROUP BY job`).all(since) as Array<{ job: AssistantJob; runs: number; tokens: number }>;
    return { days: USAGE_DAYS, jobs: rows, started: this.startedSince(Date.now() - DAY_MS), limit: this.limit(), waiting: this.inState('queued').length };
  }

  private async launch(run: AssistantRun): Promise<void> {
    const ids = { sessionId: run.sessionId ?? `assistant-run-${run.id}-${randomUUID().slice(0, 8)}`, commandId: `assistant-run-${run.id}` };
    // The conversation's id is written first, so a restart during the launch finds the same one.
    this.write({ ...run, state: 'running', sessionId: ids.sessionId, startedAt: run.startedAt ?? new Date().toISOString() });
    try {
      const choice = assistantChoice(this.deps.settings().assistant, await this.deps.backends());
      if (!choice) throw new AppError('ASSISTANT_UNAVAILABLE', 'No agent can run the 助理');
      const project = this.deps.project();
      await this.deps.start(
        { projectId: project.id, backendId: choice.backendId, ...(choice.profileId ? { backendProfileId: choice.profileId } : {}), ...(choice.model ? { model: choice.model } : {}), approval: RUN_APPROVAL, title: TITLES[run.job] },
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
  report(sessionId: string, outcome: RunOutcome, text: string | undefined, mainSessionId: string | undefined): AssistantRun {
    const run = this.bySession(sessionId);
    if (!run) throw new AppError('NOT_A_RUN', 'run_report is for the 助理\'s background runs');
    if (run.outcome) return run;
    if (outcome !== 'silent' && !text?.trim()) throw new AppError('INVALID_ARGUMENT', 'text is required unless the outcome is silent');
    const clean = text?.trim().slice(0, 2000);
    const reported: AssistantRun = { ...run, outcome, ...(clean ? { text: clean } : {}), ...(outcome === 'ask' ? { pushed: false } : {}) };
    this.deps.store.transaction(() => {
      this.write(reported);
      if (outcome === 'silent' || !clean) return;
      if (outcome === 'ask' && run.job === 'supervise' && run.subject) { this.deps.markStuck(run.subject, clean); return; }
      this.addPending(run.id, clean);
      if (outcome === 'ask' && mainSessionId) this.deps.notice(mainSessionId, clean);
    });
    if (outcome === 'ask') void this.deliverPush(reported, mainSessionId);
    return reported;
  }

  private async deliverPush(run: AssistantRun, mainSessionId: string | undefined): Promise<void> {
    let pushed = true;
    if (mainSessionId && run.text) { try { pushed = await this.deps.push(mainSessionId, run.text, `assistant-run-${run.id}`); } catch { pushed = false; } }
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
    return runs.length > 0 && this.deps.store.listUnfinishedNativeRuns(session.id).length === 0 && runs.every(run => ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.state));
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
    const main = this.mainSession();
    for (const run of this.db.prepare("SELECT json FROM assistant_runs WHERE json LIKE '%\"pushed\":false%'").all().map(row => this.parse(row)!)) {
      if (run.outcome === 'ask' && run.pushed === false) await this.deliverPush(run, main);
    }
    void this.pump();
  }

  /** Set by `app.ts`: the main conversation, for notices and pushes. */
  mainSession: () => string | undefined = () => undefined;

  /** Keeps the newest finished records; the rest go with their conversations. */
  private async prune(): Promise<void> {
    const old = this.db.prepare("SELECT json FROM assistant_runs WHERE state IN ('done','failed') ORDER BY created_at DESC LIMIT -1 OFFSET ?").all(ASSISTANT_BUDGET.keptRuns).map(row => this.parse(row)!);
    for (const run of old) {
      if (run.sessionId) { try { await this.deps.remove(run.sessionId); } catch { continue; } }
      this.db.prepare('DELETE FROM assistant_runs WHERE id=?').run(run.id);
    }
  }

  // ---- Pending notes for the main conversation (§7.1) ------------------------------------------

  /** A note the main conversation is told at the owner's next message. Past the budget the oldest goes. */
  addPending(runId: string | undefined, text: string): void {
    this.db.prepare('INSERT INTO assistant_pending(run_id,text,created_at) VALUES(?,?,?)').run(runId ?? null, text, Date.now());
    this.db.prepare('DELETE FROM assistant_pending WHERE id NOT IN (SELECT id FROM assistant_pending ORDER BY id DESC LIMIT ?)').run(ASSISTANT_BUDGET.pendingNotices);
  }

  /** The notes not yet carried by a turn that ended well, oldest first; they are marked as offered. */
  offerPending(): Array<{ text: string; at: number }> {
    const rows = this.db.prepare('SELECT id, text, created_at AS at FROM assistant_pending ORDER BY id').all() as Array<{ id: number; text: string; at: number }>;
    if (rows.length) this.db.prepare('UPDATE assistant_pending SET offered_at=? WHERE offered_at IS NULL').run(Date.now());
    return rows.map(({ text, at }) => ({ text, at }));
  }

  /** The turn that carried the offered notes ended: well, and they are gone; otherwise the next message carries them again. */
  settlePending(delivered: boolean): void {
    if (delivered) this.db.prepare('DELETE FROM assistant_pending WHERE offered_at IS NOT NULL').run();
    else this.db.prepare('UPDATE assistant_pending SET offered_at=NULL').run();
  }
}
