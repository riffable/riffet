import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SECURITY_AUDIT_BUDGET, type SecurityActor, type SecurityEvent, type SecurityEventKind } from '../../../../packages/contracts/src/index.js';

/**
 * The security record (docs/TRANSPORT-SECURITY.md §7): one JSON line per event in `security-audit.jsonl`, appended and
 * never edited. Past `compactAt` lines the file is rewritten to its newest `entries`, which are also all it keeps in
 * memory. Nothing here reads the conversations; it records who was let in and what was refused.
 */
export class SecurityAudit {
  private readonly path: string;
  private events: SecurityEvent[];
  private lines: number;
  private readonly recent = new Map<string, number>();
  private readonly listeners = new Set<(event: SecurityEvent) => void>();

  constructor(stateDir: string) {
    this.path = join(stateDir, 'security-audit.jsonl');
    let text = '';
    try { text = readFileSync(this.path, 'utf8'); } catch { /* no record yet */ }
    const rows = text.split('\n').filter(Boolean);
    this.lines = rows.length;
    this.events = rows.slice(-SECURITY_AUDIT_BUDGET.entries).flatMap(row => {
      try { const event = JSON.parse(row) as SecurityEvent; return event && typeof event.kind === 'string' ? [event] : []; } catch { return []; }
    });
  }

  record(kind: SecurityEventKind, actor: SecurityActor, fields: { subject?: string; subjectId?: string; detail?: string } = {}): SecurityEvent {
    const cut = (value: string | undefined) => value === undefined ? undefined : value.length > SECURITY_AUDIT_BUDGET.detailChars ? `${value.slice(0, SECURITY_AUDIT_BUDGET.detailChars - 1)}…` : value;
    const event: SecurityEvent = {
      id: randomUUID(), at: new Date().toISOString(), kind, actor,
      ...(fields.subject ? { subject: cut(fields.subject) } : {}),
      ...(fields.subjectId ? { subjectId: fields.subjectId } : {}),
      ...(fields.detail ? { detail: cut(fields.detail) } : {}),
    };
    this.events.push(event);
    if (this.events.length > SECURITY_AUDIT_BUDGET.entries) this.events.splice(0, this.events.length - SECURITY_AUDIT_BUDGET.entries);
    this.append(event);
    for (const listener of this.listeners) { try { listener(event); } catch { /* a listener's failure is its own */ } }
    return event;
  }

  /** Records [kind] unless the same [key] was recorded within `repeatWindowMs`: a client retrying what it may not do. */
  recordOnce(key: string, kind: SecurityEventKind, actor: SecurityActor, fields: { subject?: string; subjectId?: string; detail?: string } = {}): void {
    const now = Date.now(), last = this.recent.get(key);
    if (last !== undefined && now - last < SECURITY_AUDIT_BUDGET.repeatWindowMs) return;
    this.recent.delete(key);
    this.recent.set(key, now);
    while (this.recent.size > SECURITY_AUDIT_BUDGET.repeatKeys) this.recent.delete(this.recent.keys().next().value!);
    this.record(kind, actor, fields);
  }

  /** Newest first; [before] is an event id, for the next page. */
  list(options: { before?: string; limit?: number } = {}): SecurityEvent[] {
    const limit = Math.max(1, Math.min(options.limit ?? SECURITY_AUDIT_BUDGET.pageEntries, SECURITY_AUDIT_BUDGET.pageEntries));
    let end = this.events.length;
    if (options.before) { const index = this.events.findIndex(event => event.id === options.before); if (index >= 0) end = index; }
    return this.events.slice(Math.max(0, end - limit), end).reverse();
  }

  subscribe(listener: (event: SecurityEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private append(event: SecurityEvent) {
    try {
      if (this.lines + 1 >= SECURITY_AUDIT_BUDGET.compactAt) {
        const temporary = `${this.path}.${process.pid}.tmp`;
        writeFileSync(temporary, this.events.map(entry => `${JSON.stringify(entry)}\n`).join(''), { mode: 0o600 });
        renameSync(temporary, this.path);
        this.lines = this.events.length;
        return;
      }
      appendFileSync(this.path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
      if (this.lines === 0) chmodSync(this.path, 0o600);
      this.lines += 1;
    } catch {
      // A full disk must not stop the request that caused the event; the entry stays in memory.
    }
  }
}
