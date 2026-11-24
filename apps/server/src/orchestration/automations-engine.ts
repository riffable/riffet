import { randomUUID } from 'node:crypto';
import type {
  Automation,
  AutomationRun,
  AutomationTrigger,
  CapturedSessionReference,
  LaunchTarget,
  NativeRunInput,
  Project,
  RiffetWakeup,
  Run,
  Session,
  SessionOrigin,
} from '../../../../packages/contracts/src/index.js';
import { AppError, requireString } from '../errors.js';
import { resolveNativeSessionInput } from '../native/session-input.js';
import { AutomationStore } from './automation-store.js';
import { latestDue, nameFromPrompt, nextTime, parseTriggers, renderPrompt, serverTimeZone } from './automation.js';
import { nextCronTime, parseCron } from './cron.js';
import {
  FOLLOW_UP_RETENTION_MS, LATEST_CATCH_UP_MS, LEGACY_SCHEDULES, LEGACY_TEMPLATES, LEGACY_WAKEUPS,
  MAX_AUTOMATIONS, MAX_AUTOMATIONS_PER_AGENT_SESSION, MAX_FOLLOW_UPS, MAX_PENDING_FOLLOW_UPS_PER_SESSION,
  MAX_WAKEUP_AHEAD_MS, MIN_AGENT_CRON_GAP_MS, ON_TIME_MS, SCHEDULER_INTERVAL_MS, SKIP_CATCH_UP_MS,
  launchTarget, now, snapshotsKey, wakeupMessage,
  type FireOptions, type FrozenInput, type Ids, type OrchestrationDeps, type OrchestrationHost,
} from './shared.js';

export class AutomationEngine {
  private readonly timer: NodeJS.Timeout;
  private ticking?: Promise<void>;
  private readonly firing = new Map<string, Promise<AutomationRun>>();
  private readonly automationStore: AutomationStore;
  private readonly startTimer: NodeJS.Timeout;
  private followUpTimer?: NodeJS.Timeout;

  constructor(
    private readonly deps: OrchestrationDeps,
    private readonly host: OrchestrationHost,
  ) {
    this.automationStore = new AutomationStore(deps.store.db);
    this.migrateLegacyAutomations();
    const tick = () => { void this.tick().catch(error => console.error('[orchestration] schedule tick failed:', error)); };
    this.timer = setInterval(tick, deps.schedulerIntervalMs ?? SCHEDULER_INTERVAL_MS);
    this.timer.unref();
    // What came due while the server was off runs now, not at the first interval.
    this.startTimer = setTimeout(tick, 0);
    this.startTimer.unref();
    this.armFollowUps();
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    clearTimeout(this.startTimer);
    if (this.followUpTimer) clearTimeout(this.followUpTimer);
    await Promise.allSettled([this.ticking, ...this.firing.values()].filter(task => task !== undefined));
  }

  automations(): Automation[] {
    return this.automationStore.all().sort((a, b) => a.name.localeCompare(b.name) || a.createdAt.localeCompare(b.createdAt));
  }

  automation(id: string): Automation {
    const item = this.automationStore.get(id);
    if (!item) throw new AppError('AUTOMATION_NOT_FOUND', 'Automation does not exist', 404);
    return item;
  }

  /** The newest runs of one automation, or of all of them. */
  runs(automationId?: string, limit = 50, visibleIds?: readonly string[]): AutomationRun[] {
    if (automationId !== undefined) { this.automation(automationId); return this.automationStore.runs(automationId); }
    return this.automationStore.allRuns(Math.min(Math.max(Math.trunc(limit) || 50, 1), 500), visibleIds ?? this.automationStore.all().map(item => item.id));
  }

  /**
   * Creates or edits an automation. A body with `followUp` creates a user's follow-up (send later);
   * its `by` is never taken from the request. An agent's follow-up is made by `scheduleWakeup`.
   */
  saveAutomation(id: string | undefined, body: Record<string, unknown>, creator: { createdBySessionId?: string } = {}, frozen?: FrozenInput): Automation {
    if (this.host.isClosed()) throw new AppError('SERVICE_CLOSED', 'The workbench is shutting down', 503);
    const current = id ? this.automation(id) : undefined;
    if (body.followUp !== undefined) {
      if (current) throw new AppError('INVALID_INPUT', 'followUp cannot be changed');
      const raw = (body.followUp && typeof body.followUp === 'object' ? body.followUp : {}) as Record<string, unknown>;
      if (raw.by !== undefined && raw.by !== 'user') throw new AppError('INVALID_INPUT', 'by is set by the server');
      const triggers = parseTriggers(body.triggers);
      if (triggers.length !== 1 || triggers[0]!.kind !== 'once') throw new AppError('INVALID_INPUT', 'A follow-up has exactly one once trigger');
      return this.insertFollowUp(requireString(raw.sessionId, 'sessionId', 100), 'user', { prompt: requireString(body.prompt, 'prompt', 100_000), triggers, ...(frozen ? { frozen } : {}), ...(body.id !== undefined ? { id: requireString(body.id, 'id', 100) } : {}) });
    }
    if (current?.followUp) {
      const keys = Object.keys(body).filter(key => body[key] !== undefined);
      if (current.followUp.by !== 'user' || !this.isPending(current) || keys.length !== 1 || keys[0] !== 'triggers') {
        throw new AppError('FOLLOW_UP_READONLY', 'A follow-up cannot be edited; cancel or delete it', 409);
      }
      const session = this.deps.store.getSession(current.followUp.sessionId);
      if (session.archivedAt || session.handedOffTo) throw new AppError('SESSION_NOT_ACTIVE', 'This conversation is archived or was handed off', 409);
      const parsed = parseTriggers(body.triggers);
      if (parsed.length !== 1 || parsed[0]!.kind !== 'once') throw new AppError('INVALID_INPUT', 'A follow-up has exactly one once trigger');
      const at = Date.now();
      const due = Date.parse(parsed[0]!.at);
      if (!Number.isFinite(due) || due < at - 60_000) throw new AppError('INVALID_WAKEUP_TIME', 'Choose a time from now on');
      const triggers: AutomationTrigger[] = [{ kind: 'once', at: new Date(Math.max(due, at)).toISOString() }];
      const next: Automation = { ...current, triggers, nextRunAt: (triggers[0] as { at: string }).at, updatedAt: now() };
      this.automationStore.put(next);
      this.armFollowUps();
      return next;
    }
    if (!current && this.automationStore.count('other') >= MAX_AUTOMATIONS) throw new AppError('TOO_MANY_AUTOMATIONS', `Keep at most ${MAX_AUTOMATIONS} automations`, 409);
    for (const key of ['isolate', 'enabled'] as const) if (body[key] !== undefined && typeof body[key] !== 'boolean') throw new AppError('INVALID_INPUT', `${key} must be a boolean`);
    const prompt = body.prompt === undefined && current ? current.prompt : requireString(body.prompt, 'prompt', 100_000);
    const name = body.name === undefined && current ? current.name : requireString(body.name, 'name', 100).trim();
    const target = body.target === undefined && current ? launchTarget(current) : launchTarget(body.target);
    let projectId = current?.projectId;
    if (body.projectId !== undefined) projectId = body.projectId === null || body.projectId === '' ? undefined : requireString(body.projectId, 'projectId', 100);
    if (projectId && projectId !== current?.projectId) this.deps.store.getProject(projectId);
    const triggers = body.triggers === undefined ? current?.triggers ?? [] : parseTriggers(body.triggers);
    if (triggers.length && !projectId) throw new AppError('INVALID_INPUT', 'Choose a project for an automation that runs by itself');
    const delivery = body.delivery === undefined ? current?.delivery ?? 'new' : body.delivery;
    if (delivery !== 'new' && delivery !== 'same') throw new AppError('INVALID_INPUT', 'delivery must be new or same');
    const catchUp = body.catchUp === undefined ? current?.catchUp ?? 'latest' : body.catchUp;
    if (catchUp !== 'latest' && catchUp !== 'skip') throw new AppError('INVALID_INPUT', 'catchUp must be latest or skip');
    const enabled = (body.enabled as boolean | undefined) ?? current?.enabled ?? true;
    const stamp = new Date();
    let next: string | undefined;
    if (enabled && triggers.length) {
      next = nextTime(triggers, stamp, new Date(stamp.getTime() - 60_000))?.toISOString();
      // A finished one-time automation stays finished when edited, however the client re-encodes its time;
      // only one that had a next time must still have one.
      if (!next && !(current && !current.nextRunAt && current.enabled === enabled)) throw new AppError('INVALID_TRIGGER', 'The triggers have no upcoming time');
    }
    const { nextRunAt: _next, ...kept } = current ?? ({} as Partial<Automation>);
    const item: Automation = {
      ...kept, id: current?.id ?? randomUUID(), name, prompt, ...target,
      ...(projectId ? { projectId } : {}), ...((body.isolate ?? current?.isolate) ? { isolate: true } : {}),
      triggers, delivery, catchUp, enabled,
      ...(creator.createdBySessionId ? { createdBySessionId: creator.createdBySessionId } : {}),
      ...(next ? { nextRunAt: next } : {}),
      createdAt: current?.createdAt ?? stamp.toISOString(), updatedAt: stamp.toISOString(),
    };
    if (!projectId) delete item.projectId;
    if (!item.isolate) delete item.isolate;
    // Another project must not keep sending into the old project's conversation.
    if (current && current.projectId !== projectId) delete item.lastSessionId;
    this.automationStore.put(item);
    return item;
  }

  /** Removes the record and lets go of the session references it froze, unless a run took them over or another follow-up holds the same ones. */
  private removeAutomation(id: string): void {
    const item = this.automationStore.get(id);
    const frozen = this.deps.store.getSetting<CapturedSessionReference[]>(snapshotsKey(id), []);
    this.automationStore.remove(id);
    this.deps.store.deleteSetting(snapshotsKey(id));
    if (!item?.followUp || !frozen.length) return;
    const recipient = item.followUp.sessionId, db = this.deps.store.db;
    const heldByRun = db.prepare("SELECT 1 AS one FROM runs r, json_each(r.json,'$.native.contextSnapshots') c WHERE r.session_id=? AND json_extract(c.value,'$.snapshotRef')=? LIMIT 1");
    const heldByOther = db.prepare("SELECT 1 AS one FROM settings s, json_each(s.json) c WHERE s.key LIKE 'automation-snapshots:%' AND json_extract(c.value,'$.snapshotRef')=? LIMIT 1");
    const free = frozen.map(ref => ref.snapshotRef).filter(ref => !heldByRun.get(recipient, ref) && !heldByOther.get(ref));
    if (free.length) this.deps.store.journal.releaseSessionBlobs(recipient, free);
  }

  /** The follow-up an earlier request with this client id made, when this one says the same; another content under the id is a conflict. */
  existingFollowUp(id: string, body: Record<string, unknown>, input: NativeRunInput): Automation | undefined {
    const existing = this.automationStore.get(id);
    if (!existing) return undefined;
    const triggers = parseTriggers(body.triggers), raw = (body.followUp && typeof body.followUp === 'object' ? body.followUp : {}) as Record<string, unknown>;
    const held = existing.input ?? { attachmentIds: [], context: [] };
    const sameInput = JSON.stringify({ a: input.attachmentIds, c: input.context, r: input.references ?? [] }) === JSON.stringify({ a: held.attachmentIds, c: held.context, r: held.references ?? [] });
    const at = triggers[0]?.kind === 'once' ? Date.parse(triggers[0].at) : NaN, was = existing.triggers[0]?.kind === 'once' ? Date.parse(existing.triggers[0].at) : NaN;
    if (existing.followUp?.by !== 'user' || existing.followUp.sessionId !== raw.sessionId || existing.prompt !== input.text || !sameInput || triggers.length !== 1 || !(at <= was)) throw new AppError('AUTOMATION_ID_CONFLICT', 'This id was already used for another follow-up', 409);
    return existing;
  }

  deleteAutomation(id: string): void {
    const item = this.automation(id);
    // Deleting an agent's follow-up cancels it: the record stays for `list_wakeups` until it ages out.
    if (item.followUp?.by === 'agent') { if (this.isPending(item)) this.cancelWakeup(id); return; }
    if (item.followUp && !this.isPending(item)) throw new AppError('FOLLOW_UP_SETTLED', 'This follow-up has already run or was cancelled', 409);
    this.deps.store.transaction(() => this.removeAutomation(id));
    if (item.followUp) this.armFollowUps();
  }

  /** Runs one now, under the skip-while-busy rule of its timer; the next timed run is unchanged. */
  fire(id: string, options: FireOptions = {}): Promise<AutomationRun> {
    if (this.host.isClosed()) return Promise.reject(new AppError('SERVICE_CLOSED', 'The workbench is shutting down', 503));
    const pending = this.firing.get(id);
    if (pending) return pending;
    const task = this.execute(id, options).finally(() => { if (this.firing.get(id) === task) this.firing.delete(id); });
    this.firing.set(id, task);
    return task;
  }

  /** Records the run and the automation's summary together; a run of a deleted automation is not kept. */
  private settle(automation: Automation, run: Omit<AutomationRun, 'id'> & { id?: string }): AutomationRun {
    const record: AutomationRun = { ...run, id: run.id ?? randomUUID() };
    if (record.error) record.error = record.error.slice(0, 500);
    this.deps.store.transaction(() => {
      const current = this.automationStore.get(automation.id);
      if (!current) return;
      this.automationStore.addRun(record);
      const next: Automation = { ...current, lastRunAt: record.at, lastResult: record.result };
      if (record.result === 'failed' && record.error) next.lastError = record.error; else delete next.lastError;
      // A launch that finished after the project was changed must not restore a conversation of the old one.
      if (record.sessionId && current.projectId === automation.projectId) next.lastSessionId = record.sessionId;
      this.automationStore.put(next);
    });
    return record;
  }

  private sessionBusy(sessionId: string): boolean { try { return this.host.busy(sessionId); } catch { return false; } }

  private async execute(id: string, options: FireOptions): Promise<AutomationRun> {
    const automation = this.automation(id);
    const cause = options.cause ?? 'manual';
    const manual = cause === 'manual';
    const commandId = options.ids?.commandId;
    // A retried manual run is the run it was: same command, same record.
    const runId = manual && commandId ? `${id}:${commandId}` : randomUUID();
    if (manual && commandId) { const done = this.automationStore.run(runId); if (done) return done; }
    const base = { id: runId, automationId: id, cause, ...(options.scheduledFor ? { scheduledFor: options.scheduledFor } : {}), at: now() };
    if (automation.followUp) throw new AppError('FOLLOW_UP_READONLY', 'A follow-up cannot be run by hand', 409);
    const skip = (reason: NonNullable<AutomationRun['reason']>) => this.settle(automation, { ...base, result: 'skipped', reason });
    const projectId = automation.projectId ?? options.projectId;
    if (!projectId) throw new AppError('INVALID_INPUT', 'Choose a project to run this in');
    let project: Project | undefined;
    // A project the caller named is theirs to get right; one the automation saved may be gone.
    if (manual && !automation.projectId) project = this.deps.store.getProject(projectId);
    else { try { project = this.deps.store.getProject(projectId); } catch { project = undefined; } }
    if (!project || project.archivedAt) return skip('project-unavailable');
    const previous = automation.lastSessionId;
    if (previous && this.sessionBusy(previous)) return skip('busy');
    try {
      const reuse = automation.delivery === 'same' && previous ? (() => { try { const session = this.deps.store.getSession(previous); return session.archivedAt || session.handedOffTo ? undefined : session; } catch { return undefined; } })() : undefined;
      if (reuse) {
        const run = this.host.send(reuse.id, renderPrompt(automation, this.deps.store.getProject(reuse.projectId)), commandId);
        return this.settle(automation, { ...base, result: 'started', sessionId: reuse.id, runId: run.id });
      }
      const created = await this.host.launchAutomation(automation, project, options.ids ?? {}, options.target);
      return this.settle(automation, { ...base, result: 'started', sessionId: created.session.id, runId: created.run.id });
    } catch (error) {
      // A person who asked gets the refusal; a timer's failure is the record.
      if (manual && error instanceof AppError) throw error;
      return this.settle(automation, { ...base, result: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }

  async launchAutomation(automation: Automation, project: Project, ids: Ids, targetOverride?: LaunchTarget): Promise<{ session: Session; run: Run }> {
    return this.host.withOperation(`launch:${ids.sessionId ?? randomUUID()}`, async () => {
      const origin: SessionOrigin = { kind: 'automation', automationId: automation.id };
      const again = this.host.relaunched(ids, origin, project.id);
      if (again) return again;
      const input = await resolveNativeSessionInput(this.deps, { ...launchTarget(automation), ...targetOverride, projectId: project.id, title: automation.name });
      const target = automation.isolate ? await this.host.worktreeProject(project, 'HEAD', 'task') : project;
      return this.host.launch({ ...input, projectId: target.id }, renderPrompt(automation, project), origin, ids);
    });
  }

  /**
   * A turn in the follow-up's conversation. An agent's carries its note framed as the wake-up it
   * asked for, with the command id `wakeup-<id>`; a user's sends the prompt as typed under
   * `follow-up-<id>`. Either way the id names the follow-up, so a retried send is the same turn.
   * It is not skipped when the conversation is busy: it queues like a typed message.
   */
  private runFollowUp(automation: Automation, base: { id: string; automationId: string; cause: AutomationRun['cause']; scheduledFor?: string; at: string }, commandId?: string): AutomationRun {
    const followUp = automation.followUp!;
    const settle = (patch: Pick<AutomationRun, 'result'> & Partial<AutomationRun>) => {
      const run = this.settle(automation, { ...base, ...patch });
      if (followUp.by === 'agent') this.announceWakeup(this.wakeupOf(this.automationStore.get(automation.id) ?? automation));
      return run;
    };
    const fail = (message: string, unavailable: boolean) => {
      const run = settle({ result: 'failed', error: message, ...(unavailable ? { reason: 'session-unavailable' as const } : {}) });
      this.noticeFollowUp(automation, `${followUp.by === 'agent' ? '唤醒' : '定时发送'}未能执行：${run.error}`);
      return run;
    };
    let session: Session;
    try { session = this.deps.store.getSession(followUp.sessionId); } catch (error) { return fail(error instanceof Error ? error.message : String(error), true); }
    if (session.archivedAt) return fail('The conversation was archived', true);
    if (session.handedOffTo) return fail('The conversation was handed off', true);
    try {
      const text = followUp.by === 'agent' ? wakeupMessage({ id: automation.id, createdAt: automation.createdAt, dueAt: base.scheduledFor ?? automation.nextRunAt ?? base.at, note: automation.prompt }) : automation.prompt;
      const input: string | NativeRunInput = followUp.by === 'user' && automation.input ? { ...automation.input, text } : text;
      const snapshots = followUp.by === 'user' && automation.input?.references?.length ? this.deps.store.getSetting<CapturedSessionReference[]>(snapshotsKey(automation.id), []) : undefined;
      const run = this.host.send(session.id, input, commandId ?? `${followUp.by === 'agent' ? 'wakeup' : 'follow-up'}-${automation.id}`, snapshots);
      return settle({ result: 'started', sessionId: session.id, runId: run.id });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), false);
    }
  }

  private noticeFollowUp(automation: Automation, body: string): void {
    const followUp = automation.followUp;
    if (!followUp) return;
    try { this.deps.notices?.add({ sessionId: followUp.sessionId, title: automation.prompt.split('\n')[0]!.slice(0, 120), body, source: 'wakeup' }); } catch { /* the run record says what happened */ }
  }

  /**
   * Due automations have their next time written before they run, so a crash mid-launch cannot
   * run the same slot twice: an automation runs at most once per slot.
   */
  tick(at = new Date()): Promise<void> {
    if (this.host.isClosed()) return Promise.resolve();
    if (this.ticking) return this.ticking;
    const task = this.tickDue(at).finally(() => { if (this.ticking === task) this.ticking = undefined; });
    this.ticking = task;
    return task;
  }

  /** Moves a due automation's next time past `at` before anything starts; undefined when another caller already took the slot. */
  private claim(id: string, at: Date): { automation: Automation; due: Date; late: number } | undefined {
    const current = this.automationStore.get(id);
    if (!current || !current.enabled || !current.nextRunAt || Date.parse(current.nextRunAt) > at.getTime()) return undefined;
    const next = nextTime(current.triggers, at)?.toISOString();
    const claimed: Automation = { ...current };
    if (next) claimed.nextRunAt = next; else delete claimed.nextRunAt;
    // A follow-up with nothing left to run is settled.
    if (current.followUp && !next) claimed.enabled = false;
    this.automationStore.put(claimed);
    // `latest` stands for the most recent time that passed, not the oldest one still unrun.
    const listed = new Date(current.nextRunAt);
    let due = listed;
    if (current.catchUp === 'latest' && !current.followUp && at.getTime() - listed.getTime() > ON_TIME_MS) { const recent = latestDue(current.triggers, at); if (recent && recent > due) due = recent; }
    return { automation: { ...claimed, nextRunAt: current.nextRunAt }, due, late: at.getTime() - listed.getTime() };
  }

  /** How late a claimed slot is: on time, a catch-up that still runs, or missed. */
  private slotKind(automation: Automation, due: Date, at: Date, late: number): 'schedule' | 'catch-up' | 'missed' {
    if (at.getTime() - due.getTime() > (automation.catchUp === 'latest' ? LATEST_CATCH_UP_MS : SKIP_CATCH_UP_MS)) return 'missed';
    return late > ON_TIME_MS ? 'catch-up' : 'schedule';
  }

  private settleMissed(automation: Automation, due: Date): void {
    const base = { automationId: automation.id, cause: 'schedule' as const, scheduledFor: due.toISOString(), at: now() };
    this.settle(automation, { ...base, result: 'missed', reason: 'offline' });
    if (automation.followUp) {
      this.noticeFollowUp(automation, `${automation.followUp.by === 'agent' ? '唤醒' : '定时发送'}已错过：到点时 Riffet 未在运行`);
      if (automation.followUp.by === 'agent') this.announceWakeup(this.wakeupOf(this.automationStore.get(automation.id) ?? automation));
    }
  }

  /** Follow-ups are sent synchronously, so the exact timer can run them without waiting for a tick. */
  private runDueFollowUps(at: Date): void {
    for (const listed of this.automationStore.due(at.toISOString())) {
      if (this.host.isClosed()) return;
      if (!listed.followUp) continue;
      const slot = this.claim(listed.id, at);
      if (!slot) continue;
      const kind = this.slotKind(slot.automation, slot.due, at, slot.late);
      if (kind === 'missed') this.settleMissed(slot.automation, slot.due);
      else this.runFollowUp(slot.automation, { id: randomUUID(), automationId: listed.id, cause: kind, scheduledFor: slot.due.toISOString(), at: now() });
    }
  }

  private async tickDue(at: Date): Promise<void> {
    this.pruneFollowUps(at.getTime());
    this.runDueFollowUps(at);
    this.armFollowUps();
    for (const listed of this.automationStore.due(at.toISOString())) {
      // Earlier launches await I/O; another request may have edited or deleted a later row.
      if (this.host.isClosed()) return;
      if (listed.followUp) continue;
      const slot = this.claim(listed.id, at);
      if (!slot) continue;
      const kind = this.slotKind(slot.automation, slot.due, at, slot.late);
      if (kind === 'missed') { this.settleMissed(slot.automation, slot.due); continue; }
      if (this.firing.has(listed.id)) {
        // A run by hand is still going: this slot is not queued behind it.
        this.settle(slot.automation, { automationId: listed.id, cause: kind, scheduledFor: slot.due.toISOString(), at: now(), result: 'skipped', reason: 'busy' });
        continue;
      }
      try { await this.fire(listed.id, { cause: kind, scheduledFor: slot.due.toISOString() }); } catch (error) { console.error('[orchestration] automation run failed:', error); }
    }
  }

  // ---- Follow-ups: wake-ups an agent asked for and messages a user sent for later (docs/DEVICES.md §2) ----

  private isPending(item: Automation): boolean { return item.enabled && item.nextRunAt !== undefined; }

  /** The wake-up an agent follow-up reads as; `cancelled` is a settled one that never ran. */
  private wakeupOf(item: Automation): RiffetWakeup {
    const pending = this.isPending(item);
    const lastResult = item.lastResult;
    const status: RiffetWakeup['status'] = pending ? 'pending' : lastResult === 'started' ? 'fired' : lastResult === 'missed' ? 'missed' : lastResult ? 'failed' : 'cancelled';
    const dueAt = item.triggers.flatMap(trigger => trigger.kind === 'once' ? [trigger.at] : []).sort()[0] ?? item.createdAt;
    const wakeup: RiffetWakeup = { id: item.id, sessionId: item.followUp!.sessionId, dueAt, note: item.prompt, createdAt: item.createdAt, status };
    if (!pending && item.lastRunAt && lastResult) wakeup.firedAt = item.lastRunAt;
    if (status === 'fired') { const runId = this.automationStore.runs(item.id)[0]?.runId; if (runId) wakeup.runId = runId; }
    const error = item.lastError ?? (status === 'missed' ? 'The workbench was not running at the scheduled time' : undefined);
    if (error) wakeup.error = error;
    return wakeup;
  }

  private agentFollowUps(sessionId?: string): Automation[] { return this.automationStore.followUps(sessionId).filter(item => item.followUp?.by === 'agent'); }

  /** The conversation's wake-ups, soonest first; settled ones stay listed for a week. */
  wakeups(sessionId: string): RiffetWakeup[] {
    return this.agentFollowUps(sessionId).map(item => this.wakeupOf(item)).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  }

  /** Every conversation's wake-ups still to fire. */
  pendingWakeups(): RiffetWakeup[] {
    return this.agentFollowUps().filter(item => this.isPending(item)).map(item => this.wakeupOf(item));
  }

  private announceWakeup(wakeup: RiffetWakeup): void {
    try { this.deps.onWakeup?.(wakeup); } catch (error) { console.error('[orchestration] wake-up listener failed:', error); }
  }

  /** A turn in this same conversation at `dueAt`, carrying `note`. */
  scheduleWakeup(sessionId: string, input: { dueAt: Date; note: string }): RiffetWakeup {
    const note = input.note.trim();
    const item = this.insertFollowUp(sessionId, 'agent', { prompt: note, triggers: [{ kind: 'once', at: input.dueAt.toISOString() }] });
    return this.wakeupOf(item);
  }

  private insertFollowUp(sessionId: string, by: 'agent' | 'user', input: { prompt: string; triggers: AutomationTrigger[]; frozen?: FrozenInput; id?: string }): Automation {
    if (this.host.isClosed()) throw new AppError('SERVICE_CLOSED', 'The workbench is shutting down', 503);
    const session = this.deps.store.getSession(sessionId);
    if (session.kind !== 'native' || session.backendId === 'chat') throw new AppError('NOT_NATIVE', by === 'agent' ? 'Only agent conversations can be woken' : 'Only agent conversations take later messages', 409);
    if (session.archivedAt || session.handedOffTo) throw new AppError('SESSION_NOT_ACTIVE', 'This conversation is archived or was handed off', 409);
    const at = Date.now();
    const triggers = input.triggers.map((trigger): AutomationTrigger => {
      const due = trigger.kind === 'once' ? Date.parse(trigger.at) : NaN;
      if (!Number.isFinite(due) || due < at - 60_000 || (by === 'agent' && due > at + MAX_WAKEUP_AHEAD_MS)) throw new AppError('INVALID_WAKEUP_TIME', by === 'agent' ? 'Choose a time from now up to 30 days ahead' : 'Choose a time from now on');
      return { kind: 'once', at: new Date(Math.max(due, at)).toISOString() };
    });
    const prompt = input.prompt.trim();
    if (!prompt || prompt.length > (by === 'agent' ? 4000 : 100_000)) throw new AppError('INVALID_WAKEUP_NOTE', by === 'agent' ? 'Give the wake-up a note of at most 4000 characters' : 'Give the message a text');
    this.pruneFollowUps(at);
    const all = this.automationStore.followUps();
    if (all.filter(item => item.followUp!.sessionId === sessionId && this.isPending(item)).length >= MAX_PENDING_FOLLOW_UPS_PER_SESSION) throw new AppError('TOO_MANY_WAKEUPS', `Keep at most ${MAX_PENDING_FOLLOW_UPS_PER_SESSION} pending follow-ups per conversation`, 409);
    if (all.length >= MAX_FOLLOW_UPS) throw new AppError('TOO_MANY_WAKEUPS', 'Too many follow-ups are scheduled', 409);
    const stamp = now();
    const item: Automation = {
      id: input.id ?? randomUUID(), name: nameFromPrompt(prompt), prompt, projectId: session.projectId, triggers,
      delivery: 'same', catchUp: 'skip', enabled: true, followUp: { sessionId, by },
      nextRunAt: triggers.map(trigger => (trigger as { at: string }).at).sort()[0]!, createdAt: stamp, updatedAt: stamp,
    };
    if (input.frozen) {
      const { attachmentIds, context, references } = input.frozen.input;
      item.input = { attachmentIds, context, ...(references?.length ? { references } : {}) };
      if (input.frozen.snapshots.length) this.deps.store.setSetting(snapshotsKey(item.id), input.frozen.snapshots);
    }
    this.automationStore.put(item);
    this.armFollowUps();
    if (by === 'agent') this.announceWakeup(this.wakeupOf(item));
    return item;
  }

  /** Cancels a pending wake-up; `sessionId` confines the request to that conversation's own. */
  cancelWakeup(id: string, sessionId?: string): RiffetWakeup {
    const current = this.automationStore.get(id);
    if (!current || current.followUp?.by !== 'agent' || (sessionId !== undefined && current.followUp.sessionId !== sessionId)) throw new AppError('WAKEUP_NOT_FOUND', 'Wake-up does not exist', 404);
    if (!this.isPending(current)) throw new AppError('WAKEUP_SETTLED', `This wake-up is already ${this.wakeupOf(current).status}`, 409);
    const { nextRunAt: _next, ...rest } = current;
    const cancelled: Automation = { ...rest, enabled: false, updatedAt: now() };
    this.automationStore.put(cancelled);
    this.armFollowUps();
    const view = this.wakeupOf(cancelled);
    this.announceWakeup(view);
    return view;
  }

  /** Settled follow-ups age out after a week. */
  private pruneFollowUps(at: number): void {
    for (const item of this.automationStore.followUps()) {
      if (!this.isPending(item) && at - Date.parse(item.lastRunAt ?? item.updatedAt) >= FOLLOW_UP_RETENTION_MS) this.deps.store.transaction(() => this.removeAutomation(item.id));
    }
  }

  /** Wakes the scheduler at the next due follow-up, so one is not up to a scheduler interval late. */
  private armFollowUps(): void {
    if (this.followUpTimer) clearTimeout(this.followUpTimer);
    this.followUpTimer = undefined;
    if (this.host.isClosed()) return;
    const next = this.automationStore.nextFollowUp();
    if (next === undefined) return;
    // Capped so a clock change or a long sleep is corrected by the next arm.
    this.followUpTimer = setTimeout(() => {
      this.followUpTimer = undefined;
      try { this.runDueFollowUps(new Date()); } catch (error) { console.error('[orchestration] follow-up failed:', error); }
      this.armFollowUps();
    }, Math.min(Math.max(Date.parse(next) - Date.now(), 0) + 50, 60 * 60_000));
    this.followUpTimer.unref();
  }

  // ---- schedule_task (Riffet MCP) -------------------------------------------------------------

  /** An automation an agent made in its conversation's project, on its conversation's backend and model. */
  scheduleTask(sessionId: string, input: { name: string; prompt: string; trigger: AutomationTrigger; delivery: 'new' | 'same' }): Automation {
    const session = this.deps.store.getSession(sessionId);
    if (session.kind !== 'native' || session.backendId === 'chat') throw new AppError('NOT_NATIVE', 'Only agent conversations can schedule tasks', 409);
    if (session.origin?.kind === 'automation') throw new AppError('NOT_ALLOWED', 'A scheduled run cannot schedule more tasks', 409);
    if (input.trigger.kind === 'cron') {
      const cron = parseCron(input.trigger.cron);
      let cursor = new Date();
      for (let index = 0; index < 8; index++) {
        const next = nextCronTime(cron, cursor, input.trigger.timeZone);
        if (!next) break;
        if (index > 0 && next.getTime() - cursor.getTime() < MIN_AGENT_CRON_GAP_MS) throw new AppError('INVALID_TRIGGER', 'A scheduled task repeats at most every 15 minutes');
        cursor = next;
      }
    }
    if (this.automationStore.count('created-by', sessionId) >= MAX_AUTOMATIONS_PER_AGENT_SESSION) throw new AppError('TOO_MANY_AUTOMATIONS', `A conversation can schedule at most ${MAX_AUTOMATIONS_PER_AGENT_SESSION} tasks`, 409);
    return this.saveAutomation(undefined, {
      name: input.name, prompt: input.prompt, projectId: session.projectId, delivery: input.delivery, triggers: [input.trigger],
      target: { backendId: session.backendId, backendProfileId: session.backendProfileId, ...(session.model ? { model: session.model } : {}), ...(session.mode ? { mode: session.mode } : {}), ...(session.approval ? { approval: session.approval } : {}) },
    }, { createdBySessionId: sessionId });
  }

  // ---- Conversations going away (session-deletion.ts) ------------------------------------------

  /** How many automations last ran in one of these conversations; they go on, and start a new one next time. Follow-ups go with the conversation and are not counted. */
  schedulesUsing(sessionIds: readonly string[]): number {
    return this.automationStore.usingSessions(sessionIds).filter(item => !item.followUp).length;
  }

  /** Conversations about to be deleted: their pending wake-ups are cancelled while they still exist, so paired devices drop the leases. */
  cancelWakeupsOf(sessionIds: readonly string[]): void {
    const ids = new Set(sessionIds);
    for (const item of this.agentFollowUps()) if (ids.has(item.followUp!.sessionId) && this.isPending(item)) this.cancelWakeup(item.id);
  }

  /** Deleted conversations (inside the deletion's transaction): their follow-ups go, and no automation names them as its last. */
  forgetSessions(sessionIds: readonly string[]): void {
    for (const id of sessionIds) {
      for (const item of this.automationStore.followUps(id)) this.removeAutomation(item.id);
      for (const item of this.automationStore.usingSessions([id])) { const { lastSessionId: _gone, ...rest } = item; this.automationStore.put(rest); }
    }
    this.armFollowUps();
  }

  // ---- Migration of the 0.6 settings keys --------------------------------------------------------

  /**
   * Templates, schedules and wake-ups used to be settings keys. One transaction turns them into
   * automations and deletes the keys, so a failure leaves the old data for the next start and a
   * finished one leaves nothing to repeat. Wake-ups keep their ids: the commands they sent
   * (`wakeup-<id>`) and the leases devices hold are named by them.
   */
  private migrateLegacyAutomations(): void {
    const { store } = this.deps;
    const keys = [LEGACY_TEMPLATES, LEGACY_SCHEDULES, LEGACY_WAKEUPS];
    if (keys.every(key => store.getSetting<unknown>(key, undefined) === undefined)) return;
    type LegacyTemplate = LaunchTarget & { id: string; name: string; prompt: string; isolate?: boolean; createdAt: string; updatedAt: string };
    type LegacySchedule = { id: string; name: string; templateId: string; projectId: string; cron: string; enabled: boolean; target: 'new' | 'same'; nextRunAt?: string; lastRunAt?: string; lastSessionId?: string; lastResult?: Automation['lastResult']; lastError?: string; createdAt: string; updatedAt: string };
    type LegacyWakeup = { id: string; sessionId: string; dueAt: string; note: string; createdAt: string; status: RiffetWakeup['status']; firedAt?: string; runId?: string; error?: string };
    try {
      store.transaction(() => {
        const templates = store.getSetting<Record<string, LegacyTemplate>>(LEGACY_TEMPLATES, {});
        const schedules = Object.values(store.getSetting<Record<string, LegacySchedule>>(LEGACY_SCHEDULES, {}));
        const wakeups = Object.values(store.getSetting<Record<string, LegacyWakeup>>(LEGACY_WAKEUPS, {}));
        const zone = serverTimeZone();
        const used = new Set<string>();
        const put = (item: Automation) => { if (!this.automationStore.get(item.id)) this.automationStore.put(item); };
        for (const schedule of schedules) {
          const template = templates[schedule.templateId];
          if (!template) { console.warn(`[orchestration] migration dropped schedule ${schedule.id}: its template ${schedule.templateId} is gone`); continue; }
          used.add(template.id);
          const triggers: AutomationTrigger[] = [{ kind: 'cron', cron: schedule.cron, timeZone: zone }];
          const next = schedule.enabled ? schedule.nextRunAt ?? nextTime(triggers, new Date())?.toISOString() : undefined;
          put({
            id: schedule.id, name: schedule.name, prompt: template.prompt, ...launchTarget(template), projectId: schedule.projectId,
            ...(template.isolate ? { isolate: true } : {}), triggers, delivery: schedule.target, catchUp: 'latest', enabled: schedule.enabled && next !== undefined,
            ...(next ? { nextRunAt: next } : {}),
            ...(schedule.lastRunAt ? { lastRunAt: schedule.lastRunAt } : {}), ...(schedule.lastResult ? { lastResult: schedule.lastResult } : {}),
            ...(schedule.lastError ? { lastError: schedule.lastError } : {}), ...(schedule.lastSessionId ? { lastSessionId: schedule.lastSessionId } : {}),
            createdAt: schedule.createdAt, updatedAt: schedule.updatedAt,
          });
        }
        for (const template of Object.values(templates)) {
          if (used.has(template.id)) continue;
          put({
            id: template.id, name: template.name, prompt: template.prompt, ...launchTarget(template), ...(template.isolate ? { isolate: true } : {}),
            triggers: [], delivery: 'new', catchUp: 'latest', enabled: true, createdAt: template.createdAt, updatedAt: template.updatedAt,
          });
        }
        for (const wakeup of wakeups) {
          let projectId: string;
          try { projectId = store.getSession(wakeup.sessionId).projectId; } catch { console.warn(`[orchestration] migration dropped wake-up ${wakeup.id}: its conversation ${wakeup.sessionId} is gone`); continue; }
          const pending = wakeup.status === 'pending';
          const item: Automation = {
            id: wakeup.id, name: nameFromPrompt(wakeup.note), prompt: wakeup.note, projectId, triggers: [{ kind: 'once', at: wakeup.dueAt }],
            delivery: 'same', catchUp: 'skip', enabled: pending, followUp: { sessionId: wakeup.sessionId, by: 'agent' },
            ...(pending ? { nextRunAt: wakeup.dueAt } : {}), createdAt: wakeup.createdAt, updatedAt: wakeup.firedAt ?? wakeup.createdAt,
          };
          const result: AutomationRun['result'] | undefined = wakeup.status === 'fired' ? 'started' : wakeup.status === 'failed' ? 'failed' : wakeup.status === 'missed' ? 'missed' : undefined;
          if (result) {
            const at = wakeup.firedAt ?? wakeup.dueAt;
            item.lastRunAt = at; item.lastResult = result;
            if (result === 'failed' && wakeup.error) item.lastError = wakeup.error;
            if (result === 'started') item.lastSessionId = wakeup.sessionId;
          }
          put(item);
          if (result) this.automationStore.addRun({
            id: randomUUID(), automationId: wakeup.id, cause: 'schedule', scheduledFor: wakeup.dueAt, at: wakeup.firedAt ?? wakeup.dueAt, result,
            ...(result === 'missed' ? { reason: 'offline' as const } : {}), ...(result === 'failed' && wakeup.error ? { error: wakeup.error } : {}),
            ...(result === 'started' ? { sessionId: wakeup.sessionId, ...(wakeup.runId ? { runId: wakeup.runId } : {}) } : {}),
          });
        }
        for (const key of keys) store.deleteSetting(key);
      });
    } catch (error) { console.error('[orchestration] migrating templates, schedules and wake-ups failed; retrying on next start:', error); }
  }
}
