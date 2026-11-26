import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ASSISTANT_BUDGET, DEFAULT_AGENT_MEMBER_ID, WORK_ITEM_STATUSES, type AssistantDelegation, type AssistantDelegationTrigger, type WorkItemEvent } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import type { Store } from '../store.js';

/*
 * Delegations (docs/ASSISTANT.md §7.3): what the owner handed the 助理 to follow over time. The server checks each
 * one's trigger itself and starts a background run when it fires: a time, a release, a page change, a task status or an event a plugin emits.
 */

const DEFAULT_EVERY_MINUTES = 60;
const MAX_EVERY_MINUTES = 7 * 24 * 60;
const MAX_DAYS = 366;
const DEFAULT_DAYS = 92;
const TICK_MS = 60_000;
const FETCH_TIMEOUT_MS = 20_000;
/** What a run is shown of a changed page. */
const PAYLOAD_CHARS = 12_000;

export interface DelegationFire { delegation: AssistantDelegation; reason: string; payload: string; cursor: string; key: string }
type TaskStatusTrigger = Extract<AssistantDelegationTrigger, { kind: 'task-status' }>;
type TaskStatusEvent = Extract<WorkItemEvent, { kind: 'status' }>;
const pluginEventKey = (delegationId: string) => `delegation-event:${delegationId}:`;

export interface AssistantDelegationsDeps {
  store: Store;
  /** The next time [cron] fires after [after] in [timeZone]; undefined when it never does. Throws on a bad expression. */
  nextCron(cron: string, after: Date, timeZone: string): Date | undefined;
  timeZone(): string;
  /** Starts the run for a trigger that fired; the key makes the same change start one run. */
  fire(fire: DelegationFire): void;
  taskStatuses: {
    baseline(reference: string | number): { workItemId: string; taskNumber: number; cursor: string };
    events(workItemId: string, cursor: string, limit: number): TaskStatusEvent[] | undefined;
    subscribe(listener: (workItemId: string) => void): () => void;
  };
  /** Plugin events (`host.assistant.emit`): which topics an enabled plugin declares, and how many runs of a delegation are still queued or going. */
  pluginEvents?: { declared(topic: string): boolean; backlog(delegationId: string): number };
  /** Current lifecycle state of a delegation's owning member: paused skips polling/events; deleted ends open delegations. */
  memberState?(memberId: string): 'active' | 'paused' | 'deleted';
  /** A delegation that ended on its date, for the main conversation to mention. */
  expired(delegation: AssistantDelegation): void;
  fetch?: typeof fetch;
  /** Listeners of the list (clients refresh the 助理 page). */
  changed?(): void;
}

interface Row { delegation: AssistantDelegation; nextCheckAt: number }
const taskStatusKey = (delegationId: string) => `delegation-task-status:${delegationId}:`;

export class AssistantDelegations {
  private readonly db: DatabaseSync;
  private timer?: NodeJS.Timeout;
  private readonly checking = new Set<string>();

  constructor(private readonly deps: AssistantDelegationsDeps) {
    this.db = deps.store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS assistant_delegations (
        id TEXT PRIMARY KEY, state TEXT NOT NULL, next_check_at INTEGER NOT NULL, created_at INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS assistant_delegations_due ON assistant_delegations(state, next_check_at);`);
  }

  private write(delegation: AssistantDelegation, nextCheckAt: number): void {
    this.db.prepare('INSERT INTO assistant_delegations(id,state,next_check_at,created_at,json) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,next_check_at=excluded.next_check_at,json=excluded.json')
      .run(delegation.id, delegation.state, nextCheckAt, Date.parse(delegation.createdAt), JSON.stringify(delegation));
    this.deps.changed?.();
  }
  private row(raw: unknown): Row | undefined {
    if (!raw) return undefined;
    const { json, next_check_at } = raw as { json: string; next_check_at: number };
    const parsed = JSON.parse(json) as AssistantDelegation;
    return { delegation: { memberId: DEFAULT_AGENT_MEMBER_ID, ...parsed }, nextCheckAt: next_check_at };
  }

  private ownerOf(delegation: Pick<AssistantDelegation, 'memberId'>): string {
    return delegation.memberId || DEFAULT_AGENT_MEMBER_ID;
  }

  get(id: string): AssistantDelegation {
    const found = this.row(this.db.prepare('SELECT json, next_check_at FROM assistant_delegations WHERE id=?').get(id));
    if (!found) throw new AppError('DELEGATION_NOT_FOUND', 'No delegation has this id', 404);
    return found.delegation;
  }

  /** Open ones first, then those ended in the last 30 days, newest first. Optionally scoped to one member. */
  list(memberId?: string): AssistantDelegation[] {
    const since = Date.now() - 30 * 86_400_000;
    return this.db.prepare('SELECT json, next_check_at FROM assistant_delegations ORDER BY created_at DESC').all()
      .map(raw => this.row(raw)!.delegation)
      .filter(item => (!memberId || this.ownerOf(item) === memberId) && (item.state === 'active' || Date.parse(item.updatedAt) >= since))
      .sort((a, b) => Number(b.state === 'active') - Number(a.state === 'active'));
  }

  create(input: Record<string, unknown>, memberId = DEFAULT_AGENT_MEMBER_ID): AssistantDelegation {
    const owner = memberId || DEFAULT_AGENT_MEMBER_ID;
    const openCount = this.db.prepare("SELECT json, next_check_at FROM assistant_delegations WHERE state='active'").all()
      .map(raw => this.row(raw)!.delegation)
      .filter(item => this.ownerOf(item) === owner).length;
    if (openCount >= ASSISTANT_BUDGET.delegations) throw new AppError('TOO_MANY_DELEGATIONS', `At most ${ASSISTANT_BUDGET.delegations} delegations can be open; end one first`, 409);
    const now = new Date();
    const trigger = this.trigger(input.trigger);
    const delegation: AssistantDelegation = {
      id: randomUUID(),
      memberId: owner,
      goal: text(input.goal, 'goal', 4000, true)!,
      attention: text(input.attention, 'attention', 4000, true)!,
      ...trigger,
      until: until(input.until, now),
      state: 'active',
      createdAt: now.toISOString(), updatedAt: now.toISOString(),
    };
    this.write(delegation, this.firstCheck(delegation, now));
    return delegation;
  }

  update(id: string, input: Record<string, unknown>, memberId?: string): AssistantDelegation {
    const current = this.get(id);
    if (memberId && this.ownerOf(current) !== memberId) throw new AppError('DELEGATION_NOT_FOUND', 'No delegation has this id', 404);
    if (current.state !== 'active') throw new AppError('DELEGATION_ENDED', 'This delegation has ended; create a new one', 409);
    const now = new Date();
    const next: AssistantDelegation = {
      ...current,
      ...(input.goal !== undefined ? { goal: text(input.goal, 'goal', 4000, true)! } : {}),
      ...(input.attention !== undefined ? { attention: text(input.attention, 'attention', 4000, true)! } : {}),
      ...(input.until !== undefined ? { until: until(input.until, now) } : {}),
      updatedAt: now.toISOString(),
    };
    const trigger = input.trigger !== undefined ? this.trigger(input.trigger) : undefined;
    // A new source has nothing handled yet.
    if (trigger) { delete next.cursor; Object.assign(next, trigger); }
    const due = this.nextCheck(id) ?? this.firstCheck(next, now);
    this.write(next, trigger ? this.firstCheck(next, now) : next.trigger.kind === 'task-status' ? Math.min(due, Date.parse(next.until)) : next.trigger.kind === 'plugin-event' ? Date.parse(next.until) : due);
    return next;
  }

  end(id: string, by: NonNullable<AssistantDelegation['endedReason']>, memberId?: string): AssistantDelegation {
    const current = this.get(id);
    if (memberId && this.ownerOf(current) !== memberId) throw new AppError('DELEGATION_NOT_FOUND', 'No delegation has this id', 404);
    if (current.state !== 'active') return current;
    const ended: AssistantDelegation = { ...current, state: 'ended', endedReason: by, updatedAt: new Date().toISOString() };
    this.write(ended, 0);
    return ended;
  }

  /** Ends every open delegation owned by [memberId] (e.g. when that member is deleted). */
  endForMember(memberId: string, by: NonNullable<AssistantDelegation['endedReason']> = 'owner'): number {
    let count = 0;
    for (const item of this.list(memberId)) {
      if (item.state === 'active') {
        this.end(item.id, by);
        count += 1;
      }
    }
    return count;
  }

  private memberAllows(delegation: AssistantDelegation): boolean {
    const state = this.deps.memberState?.(this.ownerOf(delegation)) ?? 'active';
    if (state === 'deleted') {
      this.end(delegation.id, 'owner');
      return false;
    }
    return state === 'active';
  }

  /** A task transition recorded before the deadline still counts if recovery reaches it afterward. */
  wantsRun(id: string, key: string): boolean {
    const delegation = this.get(id);
    return delegation.state === 'active' || (delegation.endedReason === 'expired' && key.startsWith(taskStatusKey(id)));
  }

  private nextCheck(id: string): number | undefined {
    return (this.db.prepare('SELECT next_check_at FROM assistant_delegations WHERE id=?').get(id) as { next_check_at: number } | undefined)?.next_check_at;
  }

  private trigger(raw: unknown): { trigger: AssistantDelegationTrigger; cursor?: string } {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('trigger must be an object');
    const value = raw as Record<string, unknown>;
    const every = () => {
      if (value.everyMinutes === undefined) return {};
      const minutes = value.everyMinutes;
      if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < ASSISTANT_BUDGET.watchMinMinutes || minutes > MAX_EVERY_MINUTES) throw invalid(`everyMinutes must be a whole number from ${ASSISTANT_BUDGET.watchMinMinutes} to ${MAX_EVERY_MINUTES}`);
      return { everyMinutes: minutes };
    };
    if (value.kind === 'schedule') {
      const cron = text(value.cron, 'cron', 100, true)!;
      const timeZone = value.timeZone === undefined ? undefined : text(value.timeZone, 'timeZone', 64, true);
      try { this.deps.nextCron(cron, new Date(), timeZone ?? this.deps.timeZone()); } catch { throw invalid('cron must be five fields, like "0 9 * * 5"'); }
      return { trigger: { kind: 'schedule', cron, ...(timeZone ? { timeZone } : {}) } };
    }
    if (value.kind === 'github-release') {
      const repo = text(value.repo, 'repo', 200, true)!.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw invalid('repo must be owner/name');
      return { trigger: { kind: 'github-release', repo, ...every() } };
    }
    if (value.kind === 'page') {
      const url = text(value.url, 'url', 2000, true)!;
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw invalid('url must be an http or https address'); }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw invalid('url must be an http or https address');
      return { trigger: { kind: 'page', url: parsed.toString(), ...every() } };
    }
    if (value.kind === 'task-status') {
      const reference = value.task;
      const task = typeof reference === 'number' && Number.isSafeInteger(reference) && reference > 0 ? reference : text(reference, 'task', 100, true)!;
      const status = WORK_ITEM_STATUSES.find(candidate => candidate === value.status);
      if (!status) throw invalid(`status must be one of ${WORK_ITEM_STATUSES.join(', ')}`);
      const { cursor, ...subject } = this.deps.taskStatuses.baseline(task);
      return { trigger: { kind: 'task-status', status, ...subject }, cursor };
    }
    if (value.kind === 'plugin-event') {
      const topic = text(value.topic, 'topic', 128, true)!;
      if (!this.deps.pluginEvents?.declared(topic)) throw invalid('topic must be declared by an enabled plugin; read workbench.assistant_events for the topics');
      return { trigger: { kind: 'plugin-event', topic } };
    }
    throw invalid('trigger.kind must be schedule, github-release, page, task-status or plugin-event');
  }

  private firstCheck(delegation: AssistantDelegation, now: Date): number {
    if (delegation.trigger.kind === 'task-status' || delegation.trigger.kind === 'plugin-event') return Date.parse(delegation.until);
    // A watch looks once at the start, to learn where the source is; that look fires nothing.
    return delegation.trigger.kind === 'schedule' ? this.cronAfter(delegation, now) : now.getTime();
  }
  private cronAfter(delegation: AssistantDelegation, after: Date): number {
    if (delegation.trigger.kind !== 'schedule') return after.getTime();
    try { return this.deps.nextCron(delegation.trigger.cron, after, delegation.trigger.timeZone ?? this.deps.timeZone())?.getTime() ?? Number.MAX_SAFE_INTEGER; } catch { return Number.MAX_SAFE_INTEGER; }
  }

  // ---- Checking --------------------------------------------------------------------------------

  start(): () => void {
    const unwatch = this.deps.taskStatuses.subscribe(workItemId => this.taskChanged(workItemId));
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref?.();
    const first = setImmediate(() => { void this.tick(new Date(), true); });
    return () => { clearImmediate(first); unwatch(); if (this.timer) clearInterval(this.timer); };
  }

  async tick(now = new Date(), recoverTasks = false): Promise<void> {
    const due = this.db.prepare(`SELECT json, next_check_at FROM assistant_delegations WHERE state='active'
      AND (next_check_at<=? OR (? AND json_extract(json,'$.trigger.kind')='task-status'))
      ORDER BY json_extract(json,'$.trigger.kind')='task-status' DESC`).all(now.getTime(), Number(recoverTasks)).map(raw => this.row(raw)!);
    for (const { delegation } of due) {
      if (this.checking.has(delegation.id)) continue;
      this.checking.add(delegation.id);
      try {
        const current = this.get(delegation.id);
        if (current.state === 'active') await this.check(current, now);
      } catch (error) {
        this.checkFailed(delegation.id, error, now);
      } finally { this.checking.delete(delegation.id); }
    }
  }

  private taskChanged(workItemId: string): void {
    const now = new Date();
    const watches = this.db.prepare(`SELECT json, next_check_at FROM assistant_delegations WHERE state='active'
      AND json_extract(json,'$.trigger.kind')='task-status' AND json_extract(json,'$.trigger.workItemId')=?`).all(workItemId);
    for (const row of watches) {
      const { delegation } = this.row(row)!;
      if (delegation.trigger.kind !== 'task-status' || !this.memberAllows(delegation)) continue;
      try { this.checkTaskStatus(delegation, delegation.trigger, now); } catch (error) { this.checkFailed(delegation.id, error, now); }
    }
  }

  /**
   * A plugin emitted [topic] (`host.assistant.emit`). Every open delegation subscribed to it queues one run with the payload
   * in its brief, once per event key; the cursor records the last key. Nothing is kept for a delegation that is not there yet
   * or for a server that is down: the next event is the next chance.
   */
  pluginEvent(topic: string, payload: unknown, key?: string): { delegations: number } {
    if (key !== undefined && (typeof key !== 'string' || !key || key.length > ASSISTANT_BUDGET.pluginEventKeyChars || /[\u0000-\u001f]/.test(key))) throw invalid(`key must be text of 1 to ${ASSISTANT_BUDGET.pluginEventKeyChars} characters`);
    const body = payload === undefined ? '' : JSON.stringify(payload);
    if (body === undefined) throw invalid('payload must be JSON');
    if (Buffer.byteLength(body) > ASSISTANT_BUDGET.pluginEventBytes) throw new AppError('PAYLOAD_TOO_LARGE', `The event payload is over ${ASSISTANT_BUDGET.pluginEventBytes} bytes`, 413);
    const eventKey = key ?? createHash('sha256').update(topic).update('\0').update(body).digest('hex').slice(0, 32);
    const now = new Date();
    let queued = 0;
    const subscribed = this.db.prepare(`SELECT json, next_check_at FROM assistant_delegations WHERE state='active'
      AND json_extract(json,'$.trigger.kind')='plugin-event' AND json_extract(json,'$.trigger.topic')=?`).all(topic);
    for (const row of subscribed) {
      const { delegation } = this.row(row)!;
      if (!this.memberAllows(delegation)) continue;
      if (Date.parse(delegation.until) <= now.getTime() || delegation.cursor === eventKey) continue;
      if (this.deps.pluginEvents && this.deps.pluginEvents.backlog(delegation.id) >= ASSISTANT_BUDGET.pluginEventBacklog) {
        console.warn('[riffet] delegation has too many runs waiting; plugin event dropped', delegation.id, topic);
        continue;
      }
      this.deps.store.transaction(() => {
        this.deps.fire({ delegation, reason: `插件事件 ${topic}。`, payload: JSON.stringify({ topic, key: eventKey, ...(payload !== undefined ? { payload } : {}) }), cursor: eventKey, key: pluginEventKey(delegation.id) + eventKey });
        this.write({ ...delegation, cursor: eventKey, lastCheckedAt: now.toISOString(), lastRunAt: now.toISOString() }, Date.parse(delegation.until));
      });
      queued += 1;
    }
    return { delegations: queued };
  }

  private checkFailed(id: string, error: unknown, now: Date): void {
    // A task awaiting replay is due again even when its deadline is still far away.
    this.db.prepare(`UPDATE assistant_delegations SET next_check_at=? WHERE id=? AND state='active'
      AND json_extract(json,'$.trigger.kind')='task-status'`).run(now.getTime(), id);
    console.warn('[riffet] delegation check failed', id, error instanceof Error ? error.message : error);
  }

  private checkTaskStatus(delegation: AssistantDelegation, trigger: TaskStatusTrigger, now: Date): void {
    const events = delegation.cursor && this.deps.taskStatuses.events(trigger.workItemId, delegation.cursor, ASSISTANT_BUDGET.taskStatusEvents);
    if (!events) { this.end(delegation.id, 'task-deleted'); return; }
    const deadline = Date.parse(delegation.until);
    const more = events.length === ASSISTANT_BUDGET.taskStatusEvents;
    const expired = !more && deadline <= now.getTime();
    const matches = events.filter(event => event.to === trigger.status && Date.parse(event.at) < deadline);
    if (!expired && !events.length && this.nextCheck(delegation.id) === deadline) return;
    const progress = {
      ...delegation,
      cursor: events.at(-1)?.id ?? delegation.cursor,
      lastCheckedAt: now.toISOString(),
      ...(matches.length ? { lastRunAt: now.toISOString() } : {}),
    };
    this.deps.store.transaction(() => {
      for (const event of matches) {
        this.deps.fire({
          delegation,
          reason: `任务 #${trigger.taskNumber} 进入 ${trigger.status}。`,
          payload: JSON.stringify({ task: trigger.taskNumber, ...event }),
          cursor: event.id,
          key: taskStatusKey(delegation.id) + event.id,
        });
      }
      if (expired) {
        const ended = { ...progress, state: 'ended', endedReason: 'expired', updatedAt: now.toISOString() } as const;
        this.write(ended, 0);
        this.deps.expired(ended);
      } else this.write(progress, more ? now.getTime() : deadline);
    });
  }

  private async check(delegation: AssistantDelegation, now: Date): Promise<void> {
    if (!this.memberAllows(delegation)) return;
    const trigger = delegation.trigger;
    if (trigger.kind === 'task-status') {
      this.checkTaskStatus(delegation, trigger, now);
      return;
    }
    if (Date.parse(delegation.until) <= now.getTime()) {
      const ended = this.end(delegation.id, 'expired');
      this.deps.expired(ended);
      return;
    }
    // Nothing to look at: the plugin brings the event (`pluginEvent`); the row only waits for the deadline.
    if (trigger.kind === 'plugin-event') return;
    if (trigger.kind === 'schedule') {
      // The slot is moved on before the run starts, so a restart does not run it twice; the key does the rest.
      const slot = new Date(this.nextCheck(delegation.id) ?? now.getTime());
      this.write({ ...delegation, lastCheckedAt: now.toISOString(), lastRunAt: now.toISOString() }, this.cronAfter(delegation, now));
      this.deps.fire({ delegation, reason: `到了约定的时间（${slot.toISOString()}）。`, payload: '', cursor: slot.toISOString(), key: `delegation:${delegation.id}:${slot.toISOString()}` });
      return;
    }
    const next = now.getTime() + (trigger.everyMinutes ?? DEFAULT_EVERY_MINUTES) * 60_000;
    const currentSource = () => {
      const current = this.get(delegation.id);
      if (current.state !== 'active' || current.updatedAt !== delegation.updatedAt || JSON.stringify(current.trigger) !== JSON.stringify(trigger)) return undefined;
      return current;
    };
    let seen: { cursor: string; reason: string; payload: string } | undefined;
    try { seen = trigger.kind === 'github-release' ? await this.latestRelease(trigger.repo) : await this.page(trigger.url); } catch (error) {
      // A failed fetch may only reschedule the watch that requested it.
      const current = currentSource();
      if (!current) return;
      this.write({ ...current, lastCheckedAt: now.toISOString() }, next);
      throw error;
    }
    const current = currentSource();
    if (!current) return;
    if (!seen) { this.write({ ...current, lastCheckedAt: now.toISOString() }, next); return; }
    if (current.cursor === undefined) {
      // The first look learns where the source stands: what was there before the delegation is not news.
      this.write({ ...current, cursor: seen.cursor, lastCheckedAt: now.toISOString() }, next);
      return;
    }
    if (seen.cursor === current.cursor) { this.write({ ...current, lastCheckedAt: now.toISOString() }, next); return; }
    // Handled once it fires: the run is keyed by the change, and the next look compares with it.
    this.write({ ...current, cursor: seen.cursor, lastCheckedAt: now.toISOString(), lastRunAt: now.toISOString() }, next);
    this.deps.fire({ delegation: current, reason: seen.reason, payload: seen.payload, cursor: seen.cursor, key: `delegation:${current.id}:${seen.cursor}` });
  }

  private async download(url: string, accept: string): Promise<{ status: number; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await (this.deps.fetch ?? fetch)(url, { headers: { accept, 'user-agent': 'Riffet' }, signal: controller.signal, redirect: 'follow' });
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > ASSISTANT_BUDGET.watchFetchBytes) { chunks.push(value.subarray(0, value.byteLength - (size - ASSISTANT_BUDGET.watchFetchBytes))); await reader.cancel(); break; }
        chunks.push(value);
      }
      return { status: response.status, text: Buffer.concat(chunks).toString('utf8') };
    } finally { clearTimeout(timer); }
  }

  private async latestRelease(repo: string): Promise<{ cursor: string; reason: string; payload: string } | undefined> {
    const { status, text: body } = await this.download(`https://api.github.com/repos/${repo}/releases/latest`, 'application/vnd.github+json');
    if (status === 404) return undefined;
    if (status !== 200) throw new Error(`GitHub answered ${status}`);
    const release = JSON.parse(body) as { tag_name?: string; name?: string; html_url?: string; published_at?: string; body?: string };
    if (!release.tag_name) return undefined;
    return {
      cursor: release.tag_name,
      reason: `${repo} 发布了 ${release.tag_name}。`,
      payload: [`发布：${release.name || release.tag_name}`, release.published_at ? `时间：${release.published_at}` : '', release.html_url ? `地址：${release.html_url}` : '', '', '发布说明：', clip(release.body ?? '（无）', PAYLOAD_CHARS)].join('\n'),
    };
  }

  private async page(url: string): Promise<{ cursor: string; reason: string; payload: string } | undefined> {
    const { status, text: body } = await this.download(url, 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5');
    if (status < 200 || status >= 300) throw new Error(`${url} answered ${status}`);
    const content = readable(body);
    if (!content) return undefined;
    return { cursor: createHash('sha256').update(content).digest('hex').slice(0, 32), reason: `${url} 的内容变了。`, payload: `页面现在的文字（截取）：\n\n${clip(content, PAYLOAD_CHARS)}` };
  }
}

const invalid = (message: string) => new AppError('INVALID_ARGUMENT', message);
function text(value: unknown, key: string, max: number, required: boolean): string | undefined {
  if (value === undefined || value === null || value === '') { if (required) throw invalid(`${key} is required`); return undefined; }
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw invalid(`${key} must be text of at most ${max} characters`);
  const trimmed = value.trim();
  if (!trimmed && required) throw invalid(`${key} is required`);
  return trimmed;
}
function until(value: unknown, now: Date): string {
  if (value === undefined || value === null || value === '') return new Date(now.getTime() + DEFAULT_DAYS * 86_400_000).toISOString();
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(at) || at <= now.getTime()) throw invalid('until must be a future ISO time');
  if (at > now.getTime() + MAX_DAYS * 86_400_000) throw invalid('until is at most a year ahead');
  return new Date(at).toISOString();
}
function clip(value: string, limit: number): string { return value.length > limit ? `${value.slice(0, limit)} […]` : value; }
/** A page's text without its markup, scripts and runs of whitespace: what changes when its content does. */
function readable(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}
