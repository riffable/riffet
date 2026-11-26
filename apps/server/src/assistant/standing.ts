import type { AgentMember, Project, Session } from '../../../../packages/contracts/src/index.js';
import type { NativeStandingHost, StandingLaunch } from '../backends/types.js';
import { AppError } from '../errors.js';
import type { Store } from '../store.js';
import { commitAssistantHome, type AssistantHome } from './home.js';
import type { AgentTeamService } from './team.js';

/*
 * Standing conversations for team members (docs/TEAM.md): isolated directories, memory commits,
 * and `/new` topic resets.
 */

/** The CLI summarizes at this size rather than at the model's full window: every wake-up after the cache expires rereads all of it. */
const COMPACT_AT_TOKENS = 200_000;
const COMMIT_DELAY_MS = 5_000;
/** Clients show this name in their own language (`project-family.ts` on the web). */
export const MAIN_CONVERSATION_TITLE = '个人助理';
/** The command that starts a new topic in the main conversation. */
export const NEW_TOPIC = '/new';

export interface AssistantStandingDeps {
  store: Store;
  home(): AssistantHome;
  /** Team service (docs/TEAM.md): resolves per-member isolated directories when present. */
  team?: () => AgentTeamService | undefined;
  /** The main conversation is about to be summarized (§7.4). */
  compacting?(sessionId: string): void;
}

/** What a background run may do without asking: it never stops on a prompt, so the rest is refused (§7.1). */
const RUN_ALLOWED = ['Read', 'Glob', 'Grep', 'Edit(/**)', 'Write(/**)', 'WebFetch', 'WebSearch'];

export class AssistantStanding implements NativeStandingHost {
  private readonly commitTimers = new Map<string, NodeJS.Timeout>();

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

  /** Commits the member directory shortly after a turn ends: its edits to its own memory become history. */
  watch(): () => void {
    const stop = this.deps.store.onSessionState((session: Session, from: Session['state']) => {
      // A stopped turn leaves through `cancelling`; what it wrote before the stop is history too.
      if ((from !== 'running' && from !== 'cancelling') || session.state === 'running' || session.state === 'cancelling') return;
      const resolved = this.resolve(session.id);
      if (!resolved) return;
      const { project, member } = resolved;
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
