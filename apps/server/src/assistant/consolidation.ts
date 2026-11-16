import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ASSISTANT_BUDGET } from '../../../../packages/contracts/src/index.js';
import type { Store } from '../store.js';

/*
 * Memory consolidation (docs/ASSISTANT.md §7.4): each night, and before the main conversation is summarized, a
 * background run reads what was said since the last one and puts what is worth keeping into the memory files.
 */

/** The hour of the night it runs, in the owner's time zone. */
const NIGHT_HOUR = 4;
const TICK_MS = 5 * 60_000;
/** Up to where the last consolidation read the main conversation (an ISO time). */
const CURSOR_KEY = 'assistant-consolidated-through';
/** A summary right after a consolidation adds nothing to it. */
const COMPACT_GAP_MS = 30 * 60_000;
const MESSAGE_CHARS = 2_000;

export interface ConsolidationDeps {
  store: Store;
  cwd(): string;
  mainSessionId(): string | undefined;
  timeZone(): string;
  /** The setting; on unless switched off. Off, history is still kept alive, but nothing is read. */
  enabled(): boolean;
  /** Queues the run; false when [key] was used already, and nothing new starts. */
  enqueue(key: string, brief: Record<string, string | number>): boolean;
  /** Whether a run under [key] exists. */
  has(key: string): boolean;
  /**
   * Marks the main conversation's CLI history as in use. Other conversations' CLIs clean old histories out of the
   * config directory they share by their own period (docs/ASSISTANT.md §4); one touched each night is never old.
   */
  keepAlive?(sessionId: string): Promise<void>;
}

export class Consolidation {
  private timer?: NodeJS.Timeout;
  private lastCompactAt = 0;
  private keptOn?: string;

  constructor(private readonly deps: ConsolidationDeps) {}

  start(): () => void {
    this.timer = setInterval(() => { try { this.nightly(); } catch (error) { console.warn('[riffet] memory consolidation failed', error); } }, TICK_MS);
    this.timer.unref?.();
    return () => { if (this.timer) clearInterval(this.timer); };
  }

  /** Once a night, after the hour, when the main conversation said anything since the last one. */
  nightly(now = new Date()): void {
    const { date, hour } = localParts(now, this.deps.timeZone());
    if (hour < NIGHT_HOUR) return;
    const main = this.deps.mainSessionId();
    if (main && this.keptOn !== date && this.deps.keepAlive) {
      this.keptOn = date;
      void this.deps.keepAlive(main).catch(error => console.warn('[riffet] could not keep the assistant\'s history', error instanceof Error ? error.message : error));
    }
    if (this.deps.has(`consolidate:${date}`)) return;
    this.consolidate(`consolidate:${date}`, '每晚整理');
  }

  /** The main conversation is about to be summarized: what it holds is read once more before the details go. */
  compacting(sessionId: string): void {
    if (sessionId !== this.deps.mainSessionId() || Date.now() - this.lastCompactAt < COMPACT_GAP_MS) return;
    this.lastCompactAt = Date.now();
    this.consolidate(`consolidate:compact:${new Date().toISOString().slice(0, 16)}`, '主对话即将压缩');
  }

  private consolidate(key: string, note: string): void {
    const sessionId = this.deps.mainSessionId();
    if (!sessionId || !this.deps.enabled()) return;
    const since = this.deps.store.getSetting<string | undefined>(CURSOR_KEY, undefined);
    const messages = this.deps.store.indexedMessages(sessionId).filter(message => message.kind !== 'tool' && (!since || message.at > since));
    if (!messages.length) return;
    // The newest are kept when it is too much: older ones were there for an earlier night.
    const rendered = messages.map(message => `[${message.at.slice(0, 16).replace('T', ' ')}] ${message.kind === 'user' ? '用户' : '助理'}：${clip(message.text.trim().replace(/<\/?riffet-context>/g, ''), MESSAGE_CHARS)}`);
    let total = 0, first = rendered.length;
    while (first > 0 && total + rendered[first - 1]!.length <= ASSISTANT_BUDGET.consolidationChars) total += rendered[--first]!.length + 2;
    if (first === rendered.length) first = rendered.length - 1;
    const through = messages.at(-1)!.at;
    const cwd = this.deps.cwd();
    const queued = this.deps.enqueue(key, {
      since: messages[first]!.at.slice(0, 16).replace('T', ' '),
      until: through.slice(0, 16).replace('T', ' '),
      note: first > 0 ? `${note}；更早的 ${first} 条超出篇幅，没有带上` : note,
      messages: rendered.slice(first).join('\n\n'),
      userChars: size(join(cwd, 'USER.md')).chars,
      indexLines: size(join(cwd, 'memory', 'MEMORY.md')).lines,
    });
    // Read through here: the next one starts after it, whether or not this one finds anything to keep.
    if (queued) this.deps.store.setSetting(CURSOR_KEY, through);
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
