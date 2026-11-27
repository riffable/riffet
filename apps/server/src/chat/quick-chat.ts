import { mkdirSync } from 'node:fs';
import type { FastifyRequest } from 'fastify';
import { CLIENT_FEATURES_HEADER, SETTING_DEFAULTS, type AppSettings, type Project, type Session } from '../../../../packages/contracts/src/index.js';
import type { Store } from '../store.js';
import { chatProjectCwd } from '../backends/chat/index.js';

/*
 * The parts of quick chat that are not the driver (docs/QUICK-CHAT.md): the project every quick chat
 * lives in, who is shown them, and the sweep that archives the ones nobody kept.
 */

export const QUICK_CHAT_FEATURE = 'quick-chat';
const SWEEP_MS = 60 * 60_000;
const FIRST_SWEEP_MS = 3 * 60_000;
const DAY_MS = 86_400_000;
/**
 * Chats seen pinned or holding a mark (`'kept'`), and when one that was stopped being so (a time):
 * letting go of a chat restarts its days from the first sweep that notices, never from before it.
 */
const KEPT_KEY = 'quick-chat-kept-v2';

/** The project that holds every quick chat, made on first use. Its directory exists and stays empty. */
export function quickChatProject(store: Store, stateDir: string): Project {
  const existing = store.listProjects().find(project => project.system === 'quick-chat');
  if (existing) return existing;
  const cwd = chatProjectCwd(stateDir);
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const project = store.createProject(cwd, '模型对话');
  return project.system === 'quick-chat' ? project : store.updateProject(project.id, { system: 'quick-chat' });
}

/** Whether the request's client named the feature; a client that did not cannot read quick chats. */
export function sendsQuickChat(request: Pick<FastifyRequest, 'headers'>): boolean {
  const header = request.headers[CLIENT_FEATURES_HEADER];
  const value = Array.isArray(header) ? header.join(',') : header ?? '';
  return value.split(',').some(item => item.trim() === QUICK_CHAT_FEATURE);
}

/** What a client that never asked for quick chats is shown of a list: everything else. */
export function withoutQuickChats<T extends Pick<Session, 'backendId'> | Project>(items: readonly T[], request: Pick<FastifyRequest, 'headers'>): T[] {
  if (sendsQuickChat(request)) return [...items];
  return items.filter(item => 'cwd' in item ? item.system !== 'quick-chat' : item.backendId !== 'chat');
}

/**
 * Archives quick chats that went `retentionDays` without a message. A pinned chat and a chat
 * holding a mark are kept; so is one with a turn in flight. Archiving hides, it deletes nothing.
 */
export class QuickChatSweeper {
  private timer?: NodeJS.Timeout;
  private pass?: Promise<string[]>;

  constructor(private readonly deps: {
    store: Store;
    settings(): Pick<AppSettings, 'quickChat'>;
    /** Archives the way a reader's own archive does, so a running answer is stopped first. */
    archive(sessionId: string): Promise<unknown>;
    log(message: string, fields: Record<string, unknown>): void;
  }) {}

  start(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = setInterval(() => void this.run(), SWEEP_MS);
      this.timer.unref();
      void this.run();
    }, FIRST_SWEEP_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearTimeout(this.timer); clearInterval(this.timer); this.timer = undefined;
    await this.pass?.catch(() => undefined);
  }

  private run(): Promise<string[]> {
    this.pass ??= this.sweep().finally(() => { this.pass = undefined; });
    return this.pass;
  }

  /** The chats due now; archived one at a time. */
  async sweep(now = Date.now()): Promise<string[]> {
    const { store } = this.deps;
    const marked = store.sessionsWithMarks();
    const chats = store.listSessions().filter(session => session.backendId === 'chat' && session.origin?.kind !== 'discussion' && session.origin?.kind !== 'council' && !session.archivedAt);
    const previous = store.getSetting<Record<string, number | 'kept'>>(KEPT_KEY, {});
    const kept: Record<string, number | 'kept'> = {};
    for (const session of chats) {
      const before = previous[session.id];
      if (session.pinnedAt || marked.has(session.id)) kept[session.id] = 'kept';
      else if (before === 'kept') kept[session.id] = now;
      else if (before !== undefined) kept[session.id] = before;
    }
    store.setSetting(KEPT_KEY, kept);
    const days = this.deps.settings().quickChat?.retentionDays ?? SETTING_DEFAULTS.quickChat.retentionDays;
    if (days <= 0) return [];
    const cutoff = now - days * DAY_MS;
    const due = chats.filter(session => kept[session.id] !== 'kept' && !['starting', 'running', 'waiting', 'cancelling'].includes(session.state)
      && Math.max(Date.parse(session.lastActivityAt ?? session.createdAt), (kept[session.id] as number | undefined) ?? 0) < cutoff);
    const archived: string[] = [];
    for (const session of due) {
      try { await this.deps.archive(session.id); archived.push(session.id); }
      catch (error) { this.deps.log('quick chat archive failed', { sessionId: session.id, error: error instanceof Error ? error.message : String(error) }); }
    }
    return archived;
  }
}
