import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ASSISTANT_BUDGET, DEFAULT_AGENT_MEMBER_ID } from '../../../../packages/contracts/src/index.js';
import type { Store } from '../store.js';

/*
 * Memory consolidation (docs/ASSISTANT.md §7.4, docs/TEAM.md): each night, and before a continuous member's
 * main conversation is summarized, a background run reads what was said since the last one and puts what is
 * worth keeping into that member's memory files.
 */

/** The hour of the night it runs, in the owner's time zone. */
const NIGHT_HOUR = 4;
const TICK_MS = 5 * 60_000;
/** Up to where the last consolidation read the default member's main conversation (an ISO time). */
const CURSOR_KEY = 'assistant-consolidated-through';
/** A summary right after a consolidation adds nothing to it. */
const COMPACT_GAP_MS = 30 * 60_000;
const MESSAGE_CHARS = 2_000;

export interface ConsolidationTarget {
  memberId: string;
  cwd: string;
  /** Optional path to the effective USER.md profile (shared read-only profile for team members). */
  userFile?: string;
  mainSessionId: string;
  enabled: boolean;
}

export interface ConsolidationDeps {
  store: Store;
  /** All active continuous members eligible for keep-alive and/or consolidation. */
  targets?(): ConsolidationTarget[];
  /** Legacy single-assistant fallback when `targets` is omitted. */
  cwd?(): string;
  mainSessionId?(): string | undefined;
  timeZone(): string;
  /** Legacy setting fallback; on unless switched off. */
  enabled?(): boolean;
  /** Queues the run for [memberId]; false when [key] was used already, and nothing new starts. */
  enqueue(key: string, brief: Record<string, string | number>, memberId: string): boolean;
  /** Whether a run under [key] exists. */
  has(key: string): boolean;
  /**
   * Marks a main conversation's CLI history as in use. Other conversations' CLIs clean old histories out of the
   * config directory they share by their own period (docs/ASSISTANT.md §4); one touched each night is never old.
   */
  keepAlive?(sessionId: string): Promise<void>;
}

export class Consolidation {
  private timer?: NodeJS.Timeout;
  private readonly lastCompactAt = new Map<string, number>();
  private readonly keptOn = new Map<string, string>();

  constructor(private readonly deps: ConsolidationDeps) {}

  start(): () => void {
    this.timer = setInterval(() => { try { this.nightly(); } catch (error) { console.warn('[riffet] memory consolidation failed', error); } }, TICK_MS);
    this.timer.unref?.();
    return () => { if (this.timer) clearInterval(this.timer); };
  }

  private resolveTargets(): ConsolidationTarget[] {
    if (this.deps.targets) return this.deps.targets();
    const main = this.deps.mainSessionId?.();
    if (!main || !this.deps.cwd) return [];
    return [{
      memberId: DEFAULT_AGENT_MEMBER_ID,
      cwd: this.deps.cwd(),
      mainSessionId: main,
      enabled: this.deps.enabled ? this.deps.enabled() : true,
    }];
  }

  private cursorKey(memberId: string): string {
    return memberId === DEFAULT_AGENT_MEMBER_ID ? CURSOR_KEY : `member-consolidated-through:${memberId}`;
  }

  private nightlyKey(memberId: string, date: string): string {
    return memberId === DEFAULT_AGENT_MEMBER_ID ? `consolidate:${date}` : `consolidate:${memberId}:${date}`;
  }

  private compactKey(memberId: string, stamp: string): string {
    return memberId === DEFAULT_AGENT_MEMBER_ID ? `consolidate:compact:${stamp}` : `consolidate:${memberId}:compact:${stamp}`;
  }

  /** Once a night, after the hour, for every active continuous member whose main conversation said anything since the last one. */
  nightly(now = new Date()): void {
    const { date, hour } = localParts(now, this.deps.timeZone());
    if (hour < NIGHT_HOUR) return;
    const targets = this.resolveTargets();
    const activeIds = new Set(targets.map(target => target.memberId));
    for (const id of this.keptOn.keys()) { if (!activeIds.has(id)) this.keptOn.delete(id); }
    for (const id of this.lastCompactAt.keys()) { if (!activeIds.has(id)) this.lastCompactAt.delete(id); }
    for (const target of targets) {
      if (this.keptOn.get(target.memberId) !== date && this.deps.keepAlive) {
        this.keptOn.set(target.memberId, date);
        void this.deps.keepAlive(target.mainSessionId).catch(error => console.warn('[riffet] could not keep member history alive', target.memberId, error instanceof Error ? error.message : error));
      }
      const key = this.nightlyKey(target.memberId, date);
      if (this.deps.has(key)) continue;
      this.consolidate(target, key, '每晚整理');
    }
  }

  /** A member's main conversation is about to be summarized: what it holds is read once more before the details go. */
  compacting(sessionId: string): void {
    const target = this.resolveTargets().find(item => item.mainSessionId === sessionId);
    if (!target) return;
    const prev = this.lastCompactAt.get(target.memberId) ?? 0;
    if (Date.now() - prev < COMPACT_GAP_MS) return;
    this.lastCompactAt.set(target.memberId, Date.now());
    this.consolidate(target, this.compactKey(target.memberId, new Date().toISOString().slice(0, 16)), '主对话即将压缩');
  }

  private consolidate(target: ConsolidationTarget, key: string, note: string): void {
    if (!target.enabled) return;
    const cursorKey = this.cursorKey(target.memberId);
    const since = this.deps.store.getSetting<string | undefined>(cursorKey, undefined);
    const messages = this.deps.store.indexedMessages(target.mainSessionId).filter(message => message.kind !== 'tool' && (!since || message.at > since));
    if (!messages.length) return;
    // The newest are kept when it is too much: older ones were there for an earlier night.
    const rendered = messages.map(message => `[${message.at.slice(0, 16).replace('T', ' ')}] ${message.kind === 'user' ? '用户' : '你'}：${clip(message.text.trim().replace(/<\/?riffet-context>/g, ''), MESSAGE_CHARS)}`);
    let total = 0, first = rendered.length;
    while (first > 0 && total + rendered[first - 1]!.length <= ASSISTANT_BUDGET.consolidationChars) total += rendered[--first]!.length + 2;
    if (first === rendered.length) first = rendered.length - 1;
    const through = messages.at(-1)!.at;
    const queued = this.deps.enqueue(key, {
      since: messages[first]!.at.slice(0, 16).replace('T', ' '),
      until: through.slice(0, 16).replace('T', ' '),
      note: first > 0 ? `${note}；更早的 ${first} 条超出篇幅，没有带上` : note,
      messages: rendered.slice(first).join('\n\n'),
      userChars: size(target.userFile ?? join(target.cwd, 'USER.md')).chars,
      indexLines: size(join(target.cwd, 'memory', 'MEMORY.md')).lines,
    }, target.memberId);
    // Read through here: the next one starts after it, whether or not this one finds anything to keep.
    if (queued) this.deps.store.setSetting(cursorKey, through);
  }
}

function size(path: string): { chars: number; lines: number } {
  try { const text = readFileSync(path, 'utf8'); return { chars: text.length, lines: text.split('\n').filter(line => line.trim()).length }; } catch { return { chars: 0, lines: 0 }; }
}

function localParts(at: Date, timeZone: string): { date: string; hour: number } {
  let zone = timeZone;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch { zone = Intl.DateTimeFormat().resolvedOptions().timeZone; }
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const value = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return { date: `${value('year')}-${value('month')}-${value('day')}`, hour: Number(value('hour')) };
}

function clip(text: string, limit: number): string { return text.length > limit ? `${text.slice(0, limit)} […]` : text; }
