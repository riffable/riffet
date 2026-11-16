import type { Project, Session } from '../../../../packages/contracts/src/index.js';
import type { NativeStandingHost, StandingLaunch, StandingMoment } from '../backends/types.js';
import { AppError } from '../errors.js';
import type { Store } from '../store.js';
import { commitAssistantHome, type AssistantHome } from './home.js';

/*
 * The 助理 as a standing conversation (docs/ASSISTANT.md §3–§5): one conversation that lasts, over CLI sessions
 * that do not. What carries it across a summary or a new CLI session is on Riffet's side: the directory's files,
 * the conversation's own record, and what the model is told at each of those moments.
 */

/** The CLI summarizes at this size rather than at the model's full window: every wake-up after the cache expires rereads all of it. */
const COMPACT_AT_TOKENS = 200_000;
/** A gap shorter than this is the same sitting and goes unmentioned. */
const GAP_WORTH_SAYING_MS = 30 * 60_000;
/** What a new CLI session is handed of the turns before it. */
const CARRIED_MESSAGES = 16;
const CARRIED_MESSAGE_CHARS = 1_200;
const CARRIED_CHARS = 9_000;
const COMMIT_DELAY_MS = 5_000;
/** A message accepted this recently is the one being read, not the one before it. */
const THIS_MESSAGE_MS = 10_000;
/** Clients show this name in their own language (`project-family.ts` on the web). */
export const MAIN_CONVERSATION_TITLE = '个人助理';
/** The command that starts a new topic in the main conversation. */
export const NEW_TOPIC = '/new';

export interface AssistantStandingDeps {
  store: Store;
  home(): AssistantHome;
  /** The owner's time zone as their client reported it; the server's when unset. */
  timeZone(): string | undefined;
  /** What background runs left for the main conversation (§7.1): offered at a message, settled when its turn ends. */
  pending?: { offer(): Array<{ text: string; at: number }>; settle(delivered: boolean): void };
  /** The main conversation is about to be summarized (§7.4). */
  compacting?(sessionId: string): void;
}

/** What a background run may do without asking: it never stops on a prompt, so the rest is refused (§7.1). */
const RUN_ALLOWED = ['Read', 'Glob', 'Grep', 'Edit(/**)', 'Write(/**)', 'WebFetch', 'WebSearch'];

export class AssistantStanding implements NativeStandingHost {
  private commitTimer?: NodeJS.Timeout;
  /** When each conversation's previous message was read, while this server has been up. */
  private readonly lastMessageAt = new Map<string, number>();

  constructor(private readonly deps: AssistantStandingDeps) {}

  private project(sessionId: string): Project | undefined {
    try {
      const project = this.deps.store.getProject(this.deps.store.getSession(sessionId).projectId);
      return project.system === 'assistant' ? project : undefined;
    } catch { return undefined; }
  }

  launch(project: Project, session?: Pick<Session, 'origin'>): StandingLaunch | undefined {
    if (project.system !== 'assistant') return undefined;
    const home = this.deps.home();
    return {
      systemPromptFile: home.systemPromptFile, memoryDir: home.memoryDir, mcpConfigFiles: home.mcpConfigFiles(), pluginDirs: [home.pluginDir, ...home.packDirs()], protectedFiles: home.protectedFiles, compactAtTokens: COMPACT_AT_TOKENS,
      ...(session?.origin?.kind === 'assistant' ? { allow: RUN_ALLOWED } : {}),
    };
  }

  /** The main conversation's CLI is about to summarize it. */
  compacting(sessionId: string): void {
    if (!this.isRun(sessionId)) this.deps.compacting?.(sessionId);
  }

  /**
   * `/new` in the main conversation is a new topic (docs/ASSISTANT.md §5.5): the CLI clears its context, the
   * conversation goes on, and the memory files are what carries over.
   */
  rewrite(sessionId: string, text: string): string | undefined {
    if (text.trim() !== NEW_TOPIC) return undefined;
    const project = this.project(sessionId);
    return project && this.isMain(sessionId, project) ? '/clear' : undefined;
  }

  private isRun(sessionId: string): boolean {
    try { return this.deps.store.getSession(sessionId).origin?.kind === 'assistant'; } catch { return false; }
  }
  private isMain(sessionId: string, project: Project): boolean { return project.mainSessionId === sessionId; }

  context(sessionId: string, moment: StandingMoment): string | undefined {
    const project = this.project(sessionId);
    if (!project) return undefined;
    const now = new Date();
    const lines = [`Now: ${clock(now, this.deps.timeZone())}.`];
    // A background run is one short piece of work: the time is all it needs to be told.
    if (this.isRun(sessionId)) return `<riffet-context>\n${lines.join('\n')}\n</riffet-context>`;
    if (moment === 'prompt') {
      const gap = this.sinceLastMessage(sessionId, now);
      if (gap !== undefined && gap >= GAP_WORTH_SAYING_MS) lines.push(`The previous message in this conversation was ${span(gap)} ago. State you looked up before then may have changed.`);
      const notes = this.isMain(sessionId, project) ? this.deps.pending?.offer() ?? [] : [];
      if (notes.length) {
        const zone = this.deps.timeZone();
        // Each note was written by a background run; a note that quotes the wrapper must not close it.
        lines.push('', 'While the owner was away, your background runs left these for them, oldest first. Bring them up briefly before answering, unless the owner\'s message already covers them:', '', ...notes.map(note => `- [${stamp(new Date(note.at), zone)}] ${note.text.replace(/<\/?riffet-context>/g, '')}`));
      }
    } else if (moment === 'compact') {
      lines.push('The conversation above was just summarized. A detail the summary lost can be found with history_search (session "self").');
    } else {
      const carried = this.carried(sessionId);
      if (carried) lines.push('', 'This CLI session is new, but the conversation is not: its earlier turns are no longer in your context. The most recent of them, oldest first:', '', carried, '', 'Your memory files hold what you saved; anything older is found with history_search (session "self").');
    }
    return `<riffet-context>\n${lines.join('\n')}\n</riffet-context>`;
  }

  /**
   * Milliseconds since the message before the one being read; undefined on the first. Messages are counted as the
   * CLI reads them (a wake-up and a queued message are messages too), which a server restart forgets: then the
   * newest accepted message that is not this one stands in, told apart by being more than a moment old.
   */
  private sinceLastMessage(sessionId: string, now: Date): number | undefined {
    const remembered = this.lastMessageAt.get(sessionId);
    this.lastMessageAt.set(sessionId, now.getTime());
    if (remembered !== undefined) return now.getTime() - remembered;
    const earlier = this.deps.store.listRuns(sessionId).map(run => Date.parse(run.createdAt)).filter(at => Number.isFinite(at) && now.getTime() - at > THIS_MESSAGE_MS);
    return earlier.length ? now.getTime() - Math.max(...earlier) : undefined;
  }

  /** The last turns of the conversation as the record holds them, for a CLI session that starts without them. */
  private carried(sessionId: string): string | undefined {
    const messages = this.deps.store.indexedMessages(sessionId).slice(-CARRIED_MESSAGES);
    if (!messages.length) return undefined;
    const zone = this.deps.timeZone();
    // A turn that quotes the wrapper must not close it.
    const rendered = messages.map(message => `[${stamp(new Date(message.at), zone)}] ${message.kind === 'user' ? 'Owner' : 'You'}: ${clip(message.text.trim().replace(/<\/?riffet-context>/g, ''), CARRIED_MESSAGE_CHARS)}`);
    // The newest turns matter most: drop from the oldest end until it fits.
    while (rendered.length > 1 && rendered.join('\n\n').length > CARRIED_CHARS) rendered.shift();
    return rendered.join('\n\n');
  }

  /** Commits the directory shortly after a turn of the 助理 ends: its edits to its own files become history. */
  watch(): () => void {
    const stop = this.deps.store.onSessionState((session: Session, from: Session['state']) => {
      // A stopped turn leaves through `cancelling`; what it wrote before the stop is history too.
      if ((from !== 'running' && from !== 'cancelling') || session.state === 'running' || session.state === 'cancelling') return;
      const project = this.project(session.id);
      if (!project) return;
      // The turn that carried the background runs' notes ended: they reached the owner only if it ended well.
      if (this.isMain(session.id, project)) this.deps.pending?.settle(from === 'running' && session.state === 'idle');
      if (this.commitTimer) clearTimeout(this.commitTimer);
      this.commitTimer = setTimeout(() => { void commitAssistantHome(project.cwd); }, COMMIT_DELAY_MS);
      this.commitTimer.unref?.();
    });
    return () => { stop(); if (this.commitTimer) clearTimeout(this.commitTimer); };
  }
}

/**
 * A client opens no second conversation in the 助理's directory while its main one can still be opened: each
 * would be a conversation nobody is shown, with its own CLI history (docs/ASSISTANT.md §3). Its background runs are
 * the server's, and do not come this way.
 */
export function assertNoOtherConversation(store: Store, project: Project, sessionId: string): void {
  if (project.system !== 'assistant' || !project.mainSessionId || project.mainSessionId === sessionId) return;
  try { if (store.getSession(project.mainSessionId).archivedAt) return; } catch { return; }
  throw new AppError('ASSISTANT_CONVERSATION_EXISTS', 'The personal assistant already has its conversation; continue that one', 409);
}

/**
 * Makes `sessionId` the 助理's main conversation when it has none that can still be opened. Called for a
 * conversation a client opens in the 助理's project; conversations the server starts there never become it.
 * Returns the conversation as renamed when it became the main one.
 */
export function claimMainConversation(store: Store, project: Project, sessionId: string): Session | undefined {
  if (project.system !== 'assistant') return undefined;
  const current = project.mainSessionId;
  if (current && current !== sessionId) {
    try { if (!store.getSession(current).archivedAt) return undefined; } catch { /* deleted: the place is free */ }
  }
  if (current === sessionId) return undefined;
  store.updateProject(project.id, { mainSessionId: sessionId });
  // A conversation that lasts for months is not about its first message. Named as the owner would name it, so no
  // generated title replaces it; the owner can still rename it.
  const session = store.updateSession(sessionId, { title: MAIN_CONVERSATION_TITLE, titleSource: 'user' });
  store.appendEvent(sessionId, 'session', { session });
  return session;
}

function zoneOf(timeZone: string | undefined): string {
  if (timeZone) { try { new Intl.DateTimeFormat('en-US', { timeZone }); return timeZone; } catch { /* the server's */ } }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** `Monday 2026-11-16 14:05 (Asia/Shanghai, UTC+08:00)`. */
export function clock(at: Date, timeZone?: string): string {
  const zone = zoneOf(timeZone);
  const part = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: zone, ...options });
  const offset = part({ timeZoneName: 'longOffset' }).formatToParts(at).find(item => item.type === 'timeZoneName')?.value.replace('GMT', 'UTC') ?? 'UTC';
  return `${part({ weekday: 'long' }).format(at)} ${stamp(at, zone)} (${zone}, ${offset === 'UTC' ? 'UTC+00:00' : offset})`;
}

/** `2026-11-16 14:05` in `timeZone`. */
function stamp(at: Date, timeZone?: string): string {
  if (!Number.isFinite(at.getTime())) return 'unknown time';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zoneOf(timeZone), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const value = (type: string) => parts.find(item => item.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}`;
}

/** `45 minutes`, `3 hours 12 minutes`, `2 days 4 hours`. */
export function span(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const unit = (count: number, name: string) => `${count} ${name}${count === 1 ? '' : 's'}`;
  if (minutes < 60) return unit(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${unit(hours, 'hour')} ${unit(minutes % 60, 'minute')}` : unit(hours, 'hour');
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${unit(days, 'day')} ${unit(hours % 24, 'hour')}` : unit(days, 'day');
}

function clip(text: string, limit: number): string { return text.length > limit ? `${text.slice(0, limit)} […]` : text; }
