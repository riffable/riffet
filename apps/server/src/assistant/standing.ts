import { DEFAULT_AGENT_MEMBER_ID, type AgentMember, type Project, type Session } from '../../../../packages/contracts/src/index.js';
import type { NativeStandingHost, StandingLaunch, StandingMoment } from '../backends/types.js';
import { AppError } from '../errors.js';
import { assistantContextPart } from '../prompts/index.js';
import type { Store } from '../store.js';
import { commitAssistantHome, type AssistantHome } from './home.js';
import type { AgentTeamService } from './team.js';

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
  /** Team service (docs/TEAM.md): resolves per-member isolated directories when present. */
  team?: () => AgentTeamService | undefined;
  /** The owner's time zone as their client reported it; the server's when unset. */
  timeZone(): string | undefined;
  /** What background runs left for a member's main conversation (§7.1): offered at a message, settled when its turn ends. */
  pending?: { offer(memberId: string): Array<{ text: string; at: number }>; settle(delivered: boolean, memberId: string): void };
  nativeSettingProof?(runId: string): string | undefined;
  workbenchProof?(runId: string): string | undefined;
  /** The main conversation is about to be summarized (§7.4). */
  compacting?(sessionId: string): void;
}

/** What a background run may do without asking: it never stops on a prompt, so the rest is refused (§7.1). */
const RUN_ALLOWED = ['Read', 'Glob', 'Grep', 'Edit(/**)', 'Write(/**)', 'WebFetch', 'WebSearch'];

export class AssistantStanding implements NativeStandingHost {
  private readonly commitTimers = new Map<string, NodeJS.Timeout>();
  /** When each conversation's previous message was read, while this server has been up. */
  private readonly lastMessageAt = new Map<string, number>();

  constructor(private readonly deps: AssistantStandingDeps) {}

  private resolve(sessionId: string): { project: Project; session: Session; member?: AgentMember } | undefined {
    try {
      const session = this.deps.store.getSession(sessionId);
      const project = this.deps.store.getProject(session.projectId);
      const member = this.deps.team?.()?.resolveFor(project, session);
      if (member) return { project, session, member };
      return project.system === 'assistant' ? { project, session } : undefined;
    } catch { return undefined; }
  }

  launch(project: Project, session?: Pick<Session, 'origin' | 'agentMemberId'>): StandingLaunch | undefined {
    const team = this.deps.team?.();
    const member = team?.resolveFor(project, session);
    if (member && team) {
      const home = team.memberHome(member);
      return {
        systemPromptFile: home.systemPromptFile, memoryDir: home.memoryDir, mcpConfigFiles: home.mcpConfigFiles(), pluginDirs: [home.pluginDir, ...home.packDirs()], protectedFiles: home.protectedFiles, compactAtTokens: COMPACT_AT_TOKENS,
        instructionFiles: home.instructionFiles, skillsDir: home.skillsDir,
        ...(session?.origin?.kind === 'assistant' ? { allow: RUN_ALLOWED } : {}),
      };
    }
    if (project.system !== 'assistant') return undefined;
    const home = this.deps.home();
    return {
      systemPromptFile: home.systemPromptFile, memoryDir: home.memoryDir, mcpConfigFiles: home.mcpConfigFiles(), pluginDirs: [home.pluginDir, ...home.packDirs()], protectedFiles: home.protectedFiles, compactAtTokens: COMPACT_AT_TOKENS,
      instructionFiles: home.instructionFiles, skillsDir: home.skillsDir,
      ...(session?.origin?.kind === 'assistant' ? { allow: RUN_ALLOWED } : {}),
    };
  }

  /** The main conversation's CLI is about to summarize it. */
  compacting(sessionId: string): void {
    if (!this.isRun(sessionId)) this.deps.compacting?.(sessionId);
  }

  /**
   * `/new` in the main conversation is a new topic (docs/ASSISTANT.md §5.5): the model's context starts over, the
   * conversation goes on, and the memory files are what carries over.
   */
  newTopic(sessionId: string, text: string): boolean {
    if (text.trim() !== NEW_TOPIC) return false;
    const resolved = this.resolve(sessionId);
    return Boolean(resolved && this.isMain(sessionId, resolved.project, resolved.member));
  }

  private isRun(sessionId: string): boolean {
    try {
      const kind = this.deps.store.getSession(sessionId).origin?.kind;
      return kind === 'assistant' || kind === 'call';
    } catch { return false; }
  }
  private isMain(sessionId: string, project: Project, member?: AgentMember): boolean {
    if (member) return member.sessionMode === 'continuous' && (member.mainSessionId === sessionId || (member.scope.kind !== 'project' && project.mainSessionId === sessionId));
    return project.mainSessionId === sessionId;
  }

  context(sessionId: string, moment: StandingMoment, runId?: string): string | undefined {
    const resolved = this.resolve(sessionId);
    if (!resolved) return undefined;
    const { project, member } = resolved;
    const now = new Date();
    const lines = [assistantContextPart('now', { time: clock(now, this.deps.timeZone()) })];
    // A background run is one short piece of work: the time is all it needs to be told.
    if (this.isRun(sessionId)) return `<riffet-context>\n${lines.join('\n')}\n</riffet-context>`;
    const isMain = this.isMain(sessionId, project, member);
    const isAdminMain = isMain && (!member || member.capabilities.workbenchAdmin);
    if (moment === 'prompt') {
      const proof = runId && isAdminMain ? this.deps.workbenchProof?.(runId) : undefined;
      if (proof) lines.push(assistantContextPart('workbench', { proof }));
      const nativeProof = runId && isAdminMain ? this.deps.nativeSettingProof?.(runId) : undefined;
      if (nativeProof) lines.push(assistantContextPart('paired', { proof: nativeProof }));
      const gap = this.sinceLastMessage(sessionId, now);
      if (gap !== undefined && gap >= GAP_WORTH_SAYING_MS) lines.push(assistantContextPart('gap', { span: span(gap) }));
      const memberId = member?.id ?? DEFAULT_AGENT_MEMBER_ID;
      const notes = isMain ? this.deps.pending?.offer(memberId) ?? [] : [];
      if (notes.length) {
        const zone = this.deps.timeZone();
        // Each note was written by a background run; a note that quotes the wrapper must not close it.
        lines.push('', assistantContextPart('pending'), '', ...notes.map(note => `- [${stamp(new Date(note.at), zone)}] ${note.text.replace(/<\/?riffet-context>/g, '')}`));
      }
    } else if (moment === 'compact') {
      lines.push(assistantContextPart('compact'));
    } else {
      const carried = this.carried(sessionId);
      if (carried) lines.push('', assistantContextPart('carried', { turns: carried }));
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
    const rendered = messages.map(message => `[${stamp(new Date(message.at), zone)}] ${message.kind === 'user' ? '用户' : '你'}：${clip(message.text.trim().replace(/<\/?riffet-context>/g, ''), CARRIED_MESSAGE_CHARS)}`);
    // The newest turns matter most: drop from the oldest end until it fits.
    while (rendered.length > 1 && rendered.join('\n\n').length > CARRIED_CHARS) rendered.shift();
    return rendered.join('\n\n');
  }

  /** Commits the member directory shortly after a turn ends: its edits to its own memory become history. */
  watch(): () => void {
    const stop = this.deps.store.onSessionState((session: Session, from: Session['state']) => {
      // A stopped turn leaves through `cancelling`; what it wrote before the stop is history too.
      if ((from !== 'running' && from !== 'cancelling') || session.state === 'running' || session.state === 'cancelling') return;
      const resolved = this.resolve(session.id);
      if (!resolved) return;
      const { project, member } = resolved;
      // The turn that carried the background runs' notes ended: they reached the owner only if it ended well.
      if (this.isMain(session.id, project, member)) {
        this.deps.pending?.settle(from === 'running' && session.state === 'idle', member?.id ?? DEFAULT_AGENT_MEMBER_ID);
      }
      const dir = member && this.deps.team?.() ? this.deps.team()!.memberDir(member.id) : project.cwd;
      const prev = this.commitTimers.get(dir);
      if (prev) clearTimeout(prev);
      const timer = setTimeout(() => {
        this.commitTimers.delete(dir);
        void commitAssistantHome(dir);
      }, COMMIT_DELAY_MS);
      timer.unref?.();
      this.commitTimers.set(dir, timer);
    });
    return () => {
      stop();
      for (const timer of this.commitTimers.values()) clearTimeout(timer);
      this.commitTimers.clear();
    };
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

export function zoneOf(timeZone: string | undefined): string {
  if (timeZone) { try { new Intl.DateTimeFormat('en-US', { timeZone }); return timeZone; } catch { /* the server's */ } }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** `2026-11-16 星期一 14:05（Asia/Shanghai，UTC+08:00）`. */
export function clock(at: Date, timeZone?: string): string {
  const zone = zoneOf(timeZone);
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(at).find(item => item.type === 'timeZoneName')?.value.replace('GMT', 'UTC') ?? 'UTC';
  const [day, time] = stamp(at, zone).split(' ');
  const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone: zone, weekday: 'long' }).format(at);
  return `${day} ${weekday} ${time}（${zone}，${offset === 'UTC' ? 'UTC+00:00' : offset}）`;
}

/** `2026-11-16 14:05` in `timeZone`. */
function stamp(at: Date, timeZone?: string): string {
  if (!Number.isFinite(at.getTime())) return '时间未知';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zoneOf(timeZone), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const value = (type: string) => parts.find(item => item.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}`;
}

/** `45 分钟`, `3 小时 12 分钟`, `2 天 4 小时`. */
export function span(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分钟` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} 天 ${hours % 24} 小时` : `${days} 天`;
}

function clip(text: string, limit: number): string { return text.length > limit ? `${text.slice(0, limit)} […]` : text; }
