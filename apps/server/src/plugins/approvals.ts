import type { DatabaseSync } from 'node:sqlite';
import { PLUGIN_APPROVAL_BUDGET, type LocalizedText, type PluginApproval, type PluginApprovalRequest, type PluginApprovalResult } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';

const TONES: ReadonlySet<string> = new Set(['primary', 'danger', 'neutral']);
/** `setTimeout` cannot wait longer than this; a later expiry is re-armed when the timer fires. */
const MAX_TIMER_MS = 2 ** 31 - 1;

interface Row { plugin_id: string; id: string; created_at: number; expires_at: number | null; json: string }

export interface PluginApprovalsDeps {
  db: DatabaseSync;
  /** The display name of an installed plugin; undefined when it is not installed any more. */
  pluginName(pluginId: string): string | undefined;
  /** Runs the plugin's `approvals.decide`, turning the plugin on first when it is lazy. Throws when it cannot. */
  decide(pluginId: string, id: string, actionId: string): Promise<{ message?: LocalizedText } | void>;
  /** A request that was not already open: where the phone push hangs. A failure is the callee's to handle. */
  opened?(approval: PluginApproval): void;
  now?: () => number;
}

/**
 * What plugins ask the owner to approve (`host.approvals`, docs/TASK-BOARD.md §7): the inbox's 要你回答 gets one more
 * source. Kept in the workbench database so an open approval survives a restart; no foreign keys, the service clears
 * what a plugin leaves behind. An expired one is dropped when read and by a timer, so clients hear of it.
 */
export class PluginApprovals {
  private readonly db: DatabaseSync;
  private readonly listeners = new Set<() => void>();
  private readonly deciding = new Set<string>();
  private revisionValue = Date.now();
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly deps: PluginApprovalsDeps) {
    this.db = deps.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS plugin_approvals (
        plugin_id TEXT NOT NULL, id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, json TEXT NOT NULL,
        PRIMARY KEY (plugin_id, id));`);
    this.arm();
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  /** Moves on with every change to what is open, so a client can tell whether its copy is current. */
  get revision(): number { return this.revisionValue; }

  /** Called after every change: a request, a withdrawal, an expiry, a decision. A listener must not throw. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.listeners.clear();
  }

  private changed(): void {
    this.revisionValue += 1;
    this.arm();
    for (const listener of [...this.listeners]) {
      try { listener(); } catch (error) { console.warn('[riffet] plugin approval listener failed:', error instanceof Error ? error.message : error); }
    }
  }

  /** One timer, at the soonest expiry. */
  private arm(): void {
    clearTimeout(this.timer);
    if (this.closed) return;
    const next = this.db.prepare('SELECT MIN(expires_at) AS at FROM plugin_approvals WHERE expires_at IS NOT NULL').get() as { at: number | null };
    if (next.at === null) return;
    this.timer = setTimeout(() => this.sweep(), Math.min(Math.max(next.at - this.now(), 0) + 5, MAX_TIMER_MS));
    this.timer.unref();
  }

  private sweep(): void {
    this.timer = undefined;
    if (this.expire()) this.changed(); else this.arm();
  }

  private expire(): boolean {
    return Number(this.db.prepare('DELETE FROM plugin_approvals WHERE expires_at IS NOT NULL AND expires_at<=?').run(this.now()).changes) > 0;
  }

  private row(pluginId: string, id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM plugin_approvals WHERE plugin_id=? AND id=?').get(pluginId, id) as Row | undefined;
  }

  private approval(row: Row): PluginApproval {
    const body = JSON.parse(row.json) as PluginApprovalRequest;
    return { ...body, pluginId: row.plugin_id, pluginName: this.deps.pluginName(row.plugin_id) ?? row.plugin_id, createdAt: new Date(row.created_at).toISOString() };
  }

  /** Every open approval, oldest first, as the inbox lists them. */
  list(): PluginApproval[] {
    if (this.expire()) this.changed();
    const rows = this.db.prepare('SELECT * FROM plugin_approvals ORDER BY created_at, plugin_id, id').all() as unknown as Row[];
    return rows.map(row => this.approval(row));
  }

  /** The plugin ids that have an approval open, for a sweep after a plugin turned off. */
  pluginIds(): string[] {
    return (this.db.prepare('SELECT DISTINCT plugin_id FROM plugin_approvals').all() as Array<{ plugin_id: string }>).map(row => row.plugin_id);
  }

  /** Opens an approval for plugin [pluginId]. An id that is already open changes nothing. Throws `AppError` for a request the limits refuse. */
  request(pluginId: string, request: PluginApprovalRequest): void {
    const checked = validate(request, this.now());
    if (this.expire()) this.changed();
    if (this.row(pluginId, checked.id)) return;
    const open = this.db.prepare('SELECT COUNT(*) AS count FROM plugin_approvals WHERE plugin_id=?').get(pluginId) as { count: number };
    if (open.count >= PLUGIN_APPROVAL_BUDGET.openPerPlugin) {
      throw new AppError('PLUGIN_APPROVAL_LIMIT', `${pluginId} already has ${PLUGIN_APPROVAL_BUDGET.openPerPlugin} approvals open; wait for the owner or withdraw one`, 429);
    }
    const createdAt = this.now();
    this.db.prepare('INSERT INTO plugin_approvals(plugin_id,id,created_at,expires_at,json) VALUES(?,?,?,?,?)')
      .run(pluginId, checked.id, createdAt, checked.expiresAt ? Date.parse(checked.expiresAt) : null, JSON.stringify(checked));
    this.changed();
    try { this.deps.opened?.(this.approval(this.row(pluginId, checked.id)!)); } catch (error) { console.warn('[riffet] plugin approval push failed:', error instanceof Error ? error.message : error); }
  }

  /** Removes an approval the plugin no longer needs answered; an unknown id is not an error. */
  withdraw(pluginId: string, id: string): void {
    if (Number(this.db.prepare('DELETE FROM plugin_approvals WHERE plugin_id=? AND id=?').run(pluginId, id).changes) > 0) this.changed();
  }

  /** Removes everything of plugin [pluginId]: it was turned off or uninstalled. */
  withdrawAll(pluginId: string): void {
    if (Number(this.db.prepare('DELETE FROM plugin_approvals WHERE plugin_id=?').run(pluginId).changes) > 0) this.changed();
  }

  /**
   * The owner chose [actionId]. The plugin does the write; its refusal passes through and the approval stays. Only a
   * decision that returned removes it, and one for an id that is gone (decided on another client, expired) is a 404.
   */
  async decide(pluginId: string, id: string, actionId: unknown): Promise<PluginApprovalResult> {
    if (typeof actionId !== 'string') throw new AppError('INVALID_APPROVAL', 'actionId must be text');
    if (this.expire()) this.changed();
    const row = this.row(pluginId, id);
    if (!row) throw new AppError('PLUGIN_APPROVAL_NOT_FOUND', 'This approval is no longer open', 404);
    if (!this.approval(row).actions.some(action => action.id === actionId)) throw new AppError('INVALID_APPROVAL', 'Unknown action', 400);
    const key = `${pluginId}\n${id}`;
    if (this.deciding.has(key)) throw new AppError('PLUGIN_APPROVAL_BUSY', 'This approval is being decided', 409);
    this.deciding.add(key);
    try {
      const result = await this.deps.decide(pluginId, id, actionId);
      // Only the approval that was decided: one the plugin withdrew and asked again under the same id meanwhile stays.
      if (Number(this.db.prepare('DELETE FROM plugin_approvals WHERE plugin_id=? AND id=? AND created_at=?').run(pluginId, id, row.created_at).changes) > 0) this.changed();
      return result && result.message ? { message: result.message } : {};
    } finally { this.deciding.delete(key); }
  }
}

function text(value: unknown, field: string, max: number, required = true): string {
  if (typeof value !== 'string' || (required && !value.trim())) throw new AppError('INVALID_APPROVAL', `${field} must be text${required ? '' : ' or empty'}`);
  if (value.length > max) throw new AppError('INVALID_APPROVAL', `${field} must be at most ${max} characters`);
  return value;
}

function validate(request: PluginApprovalRequest, now: number): PluginApprovalRequest {
  if (!request || typeof request !== 'object') throw new AppError('INVALID_APPROVAL', 'An approval request must be an object');
  const budget = PLUGIN_APPROVAL_BUDGET;
  const id = text(request.id, 'id', budget.idChars);
  const title = text(request.title, 'title', budget.titleChars);
  const body = text(request.body, 'body', budget.bodyChars, false);
  if (!Array.isArray(request.actions) || request.actions.length < 1 || request.actions.length > budget.actions) throw new AppError('INVALID_APPROVAL', `actions must hold 1 to ${budget.actions} entries`);
  const seen = new Set<string>();
  const actions = request.actions.map(action => {
    const actionId = text(action?.id, 'action id', budget.idChars);
    if (seen.has(actionId)) throw new AppError('INVALID_APPROVAL', `action id ${actionId} is repeated`);
    seen.add(actionId);
    const label = text(action.label, 'action label', budget.labelChars);
    if (action.tone !== undefined && !TONES.has(action.tone)) throw new AppError('INVALID_APPROVAL', 'action tone must be primary, danger or neutral');
    return { id: actionId, label, ...(action.tone ? { tone: action.tone } : {}) };
  });
  let expiresAt: string | undefined;
  if (request.expiresAt !== undefined) {
    const at = typeof request.expiresAt === 'string' ? Date.parse(request.expiresAt) : NaN;
    if (!Number.isFinite(at)) throw new AppError('INVALID_APPROVAL', 'expiresAt must be an ISO timestamp');
    if (at <= now) throw new AppError('INVALID_APPROVAL', 'expiresAt is already past');
    expiresAt = new Date(at).toISOString();
  }
  const sessionId = request.sessionId === undefined ? undefined : text(request.sessionId, 'sessionId', budget.idChars);
  return { id, title, body, actions, ...(expiresAt ? { expiresAt } : {}), ...(sessionId ? { sessionId } : {}) };
}
